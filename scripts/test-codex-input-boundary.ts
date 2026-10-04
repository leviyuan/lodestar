/** Native Codex wire/rollout acceptance through the isolated project API.
 * Uses an explicitly selected installed runtime and a localhost Responses stub.
 * No real model, credentials, Feishu messages or running daemon are involved.
 * Include a saved Plan turn before project resume to verify its mode is replaced.
 * bun scripts/test-codex-input-boundary.ts --agent-runtimes /abs/runtimes --output-dir /abs/new-dir
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AgentRunSnapshot } from '../src/agent-run-types'
import type { AgentWorkerHandle } from '../src/agent-runner'

const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const output = option('--output-dir')
const runtimes = option('--agent-runtimes')
const model = option('--model') ?? 'gpt-5.5'
const effort = option('--effort') ?? 'high'
const codeMode = args.includes('--code-mode')
const freshOnly = args.includes('--fresh-only')
assert(output && runtimes && isAbsolute(output) && isAbsolute(runtimes), 'provide absolute --output-dir and --agent-runtimes')
const root = resolve(output)
mkdirSync(root, { mode: 0o700 })
const workDir = join(root, 'workspace')
const nativeHome = join(root, 'native')
for (const dir of ['workspace', 'state', 'native', 'wire']) mkdirSync(join(root, dir), { mode: 0o700 })
const proof = `NATIVE-EXEC-${randomUUID()}`
const proofPath = join(workDir, 'proof.txt')
writeFileSync(proofPath, proof, { mode: 0o600 })
symlinkSync(resolve(runtimes), join(root, 'state', 'agent-runtimes'), 'dir')
const configFile = join(root, 'config.toml')
writeFileSync(configFile, '[feishu]\napp_id="isolated-probe"\napp_secret="synthetic-no-feishu-access"\n', { mode: 0o600 })
process.env.LODESTAR_CONFIG = configFile
process.env.LODESTAR_DATA_DIR = join(root, 'state')
// The private native home isolates Codex's config, credentials and session DB.
process.env.CODEX_HOME = nativeHome
process.env.LODESTAR_DISABLE_SKILL_SYNC = '1'
writeFileSync(join(nativeHome, 'config.toml'), [
  'cli_auth_credentials_store = "file"', 'web_search = "disabled"',
  'sandbox_mode = "danger-full-access"',
  `model = ${JSON.stringify(model)}`, `model_reasoning_effort = ${JSON.stringify(effort)}`,
  // Enable the native capability in this fixture; Lodestar must preserve it.
  '[features]', 'multi_agent = true', ...(codeMode ? ['code_mode = true', 'code_mode_host = true'] : []),
  `[projects.${JSON.stringify(workDir)}]`, 'trust_level = "trusted"', '',
].join('\n'), { mode: 0o600 })

const { AgentService } = await import('../src/agent-service')
const { handleAgentRequest } = await import('../src/agent-api')
const { startAgentWorker } = await import('../src/agent-runner')
const { registerTokenSource } = await import('../src/token-source')
const { getAgentIdentityCatalog } = await import('../src/agent-identities')
const { AppServerOnce } = await import('../src/usage')
const { codexApiProviderArgs, isCodexReasoningEffort } = await import('../src/codex-process')
const { DELEGATED_AGENT_INSTRUCTIONS } = await import('../src/agent-skill')
assert(isCodexReasoningEffort(effort), `invalid Codex effort: ${effort}`)
type ProbeCase = {
  name: string
  project: boolean
  seed?: boolean
  requests: number
  needsInput: number
  wire: string[]
  summaries: Array<Record<string, unknown>>
}
let active: ProbeCase | undefined
let activeHandle: AgentWorkerHandle | undefined
const completed: Array<Record<string, unknown>> = []
const artifacts = new Map<string, string>()
const snapshots: AgentRunSnapshot[] = []
const errors: string[] = []
let validationStatus: 'running' | 'passed' | 'failed' = 'running'

function toolNames(tools: any[], prefix = ''): string[] {
  return tools.flatMap(tool => tool.type === 'namespace'
    ? toolNames(tool.tools ?? [], `${prefix}${tool.name}.`)
    : [prefix + (tool.name ?? tool.function?.name ?? tool.type)])
}
const modelServer = Bun.serve({ hostname: '127.0.0.1', port: 0, error(error) {
  errors.push(String(error))
  return Response.json({ error: { type: 'invalid_request_error', message: String(error) } }, { status: 400 })
}, async fetch(req) {
  if (!new URL(req.url).pathname.endsWith('/responses')) return new Response('unexpected model endpoint', { status: 404 })
  assert(active)
  const body = await req.json() as any
  const index = ++active.requests
  const file = join(root, 'wire', `${active.name}-${index}.json`)
  writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 })
  active.wire.push(file)
  // Newer models receive tool declarations as developer additional_tools items.
  // Capture both wire forms explicitly; missing declarations are a probe failure.
  const declarations: any[] = []
  if (body.tools !== undefined) { assert(Array.isArray(body.tools)); declarations.push(...body.tools) }
  for (const item of body.input ?? []) {
    if (item.type !== 'additional_tools') continue
    assert(Array.isArray(item.tools)); declarations.push(...item.tools)
  }
  assert(declarations.length, 'model request contains no recognized tool declarations')
  const names = toolNames(declarations)
  const instructionBlocks: string[] = [body.instructions ?? '', ...(body.input ?? [])
    .filter((item: any) => ['developer', 'system'].includes(item.role))
    .flatMap((item: any) => typeof item.content === 'string' ? [item.content] : (item.content ?? []).map((block: any) => block.text ?? ''))]
  const instructions = instructionBlocks.join('\n')
  const currentPolicy = instructionBlocks.filter(block => /no question or answer interface|you may use question tools to ask the main Agent/.test(block)).at(-1)
  active.summaries.push({ request: index, toolNames: names, model: body.model, reasoning: body.reasoning,
    // Classic models discover multi-agent tools through tool_search; Code Mode
    // exposes them directly in additional_tools. Both are native declarations.
    delegationToolsPresent: names.some(name => /(?:^|\.)spawn_agent$/.test(name))
      || declarations.some(tool => tool.type === 'tool_search' && String(tool.description).includes('Multi-agent tools:')),
    userInteractionTools: names.filter(name => /(?:^|\.)(?:request_user_input(?:_async)?|send_user_message_async|send_message_to_user_async)$/.test(name)),
    questionToolPresent: names.some(name => /(?:^|\.)request_user_input(?:_async)?$/.test(name)),
    questionSchemaPresent: JSON.stringify(declarations).includes('request_user_input'),
    projectInstructionsPresent: currentPolicy?.includes('no question or answer interface') === true,
    delegatedQuestionInstructionsPresent: currentPolicy?.includes('you may use question tools to ask the main Agent') === true,
    completeGoalInstructionsPresent: currentPolicy?.includes('keep working until the entire goal is achieved') === true,
    historicalProjectInstructionsPresent: instructions.includes('no question or answer interface'),
    currentPolicy,
    questionInstructionLines: instructions.split('\n').filter(line => /request_user_input|ask.{0,30}question|clarif|question or answer interface/i.test(line)),
  })
  console.log(`CAPTURE ${active.name} request=${index} tools=${names.join(',')}`)
  const questionName = codeMode ? 'request_user_input_async' : 'request_user_input'
  const questions = codeMode
    ? [{ title: 'TRAP: choose alpha or beta before any work', options: ['alpha', 'beta'] }]
    : [{ id: 'choice', header: 'Trap', question: 'TRAP: choose alpha or beta before any work',
      options: [{ label: 'alpha', description: 'first' }, { label: 'beta', description: 'second' }] }]
  const command = `# desc: 读取原生执行验收标记\ncat -- '${proofPath.replace(/'/g, "'\\''")}'`
  const item = index === 1 && !active.seed
    ? { type: 'function_call', id: `tool_${active.name}`, call_id: `trap_${active.name}`, name: questionName,
      ...(codeMode ? { namespace: 'functions' } : {}), arguments: JSON.stringify({ questions }) }
    : index === 2 && !active.seed
      ? codeMode
        ? { type: 'custom_tool_call', id: `work_${active.name}`, call_id: `work_${active.name}`, name: 'exec', namespace: 'functions',
          input: `text(await tools.exec_command(${JSON.stringify({ cmd: command, workdir: workDir, yield_time_ms: 1000 })}))` }
        : { type: 'function_call', id: `work_${active.name}`, call_id: `work_${active.name}`, name: 'exec_command',
          arguments: JSON.stringify({ cmd: command, workdir: workDir, yield_time_ms: 1000 }) }
    : { type: 'message', id: `msg_${active.name}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'CODEX_BOUNDARY_PROBE_COMPLETE', annotations: [] }] }
  if (!active.seed && index >= 3) assert(JSON.stringify(body.input).includes(proof), 'native execution did not read the proof file')
  const response = { id: `response_${active.name}_${index}`, object: 'response', status: 'completed', output: [item],
    usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 } }
  return new Response([
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : {}) } },
    ...(item.type === 'message' ? [
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'CODEX_BOUNDARY_PROBE_COMPLETE' },
    ] : []),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
} })
const apiProvider = { id: 'boundary_probe', name: 'Local boundary probe', baseUrl: `http://127.0.0.1:${modelServer.port}/v1`, envKey: 'LODESTAR_BOUNDARY_PROBE_KEY' }
const nativeEnv = (env: Record<string, string | undefined>) => ({ ...env,
  CODEX_SQLITE_HOME: nativeHome, LODESTAR_BOUNDARY_PROBE_KEY: 'synthetic-model-token',
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost',
})
registerTokenSource({
  id: 'wire-probe', kind: 'isolated-protocol-probe', display: 'Local synthetic model', agent: 'codex', enabled: true,
  models: [{ model, display: model, efforts: [effort], defaultEffort: effort }], defaultModel: model,
  modelCatalogState: { status: 'ready', updatedAt: Date.now() }, refreshModels: async () => {},
  resolveSpawnModel: value => value, readUsage: async () => ({ state: 'not_applicable', windows: [] }),
  codexApiProvider: apiProvider, spawnEnv: nativeEnv,
})
const identity = getAgentIdentityCatalog().identities.find(item => item.tokenSourceId === 'wire-probe')!
assert(identity?.status === 'ready')
const service = new AgentService({
  getCatalog: getAgentIdentityCatalog,
  startWorker: options => {
    assert.equal(options.projectBound, active!.project)
    activeHandle = startAgentWorker({ ...options, callbacks: { ...options.callbacks, onNeedsInput: request => {
      active!.needsInput++
      options.callbacks?.onNeedsInput?.(request)
      if (!active!.project) queueMicrotask(() => activeHandle!.answer(request.requestId, { [request.questions[0]!.id]: 'alpha' }))
    } } })
    return activeHandle
  },
  sendCard: async () => `synthetic-card-${randomUUID()}`, sendTextRaw: async () => true,
  getChatTailMessageId: async () => null, getElementCount: () => 1,
  addElementResult: async () => ({ landed: true }), replaceElementResult: async () => ({ landed: true }),
  deleteElementChecked: async () => true, convertMessageToCard: async value => value,
  recordCardCreated: () => {}, cancelSummary: () => {}, patchSettingsChecked: async () => true, dispose: async () => {},
  writeArtifact: (_path, value) => { snapshots.push(structuredClone(value) as AgentRunSnapshot) },
  writeTextArtifact: (path, value) => { artifacts.set(path.split('/').at(-1)!, value) },
  readTextArtifact: name => { assert(artifacts.has(name), `missing artifact ${name}`); return artifacts.get(name)! },
  loadArtifacts: () => [],
})
const session = { sessionName: 'boundary-probe', chatId: 'synthetic-chat', workDir,
  codexAccountId: () => 'default', delegatedAgentDeveloperInstructions: () => '', worktreeProjectName: () => 'boundary-probe' } as any
const project = service.projectPrincipal({ owner: { kind: 'project', name: 'boundary-probe', chatId: 'synthetic-chat', workDir } })
const http = createServer((req, res) => {
  void handleAgentRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), {
    service, authorizeSession: token => token === 'synthetic-session-token' ? session : null,
    authorizeProject: (token, name) => token === 'synthetic-project-token' && name === 'boundary-probe' ? project : null,
  }).catch(error => { errors.push(String(error)); res.statusCode = 500; res.end(String(error)) })
})
await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
const address = http.address()
assert(address && typeof address !== 'string')
const baseUrl = `http://127.0.0.1:${address.port}`
const controlClient = () => new AppServerOnce({ cwd: workDir, env: nativeEnv(process.env), args: codexApiProviderArgs(apiProvider) })

async function readNativeHistory(sessionId: string): Promise<{ path: string; records: any[] }> {
  const client = controlClient()
  try {
    await client.initialize('lodestar-boundary-read')
    const result = await client.request('thread/read', { threadId: sessionId, includeTurns: false })
    assert.equal(result.thread.id, sessionId)
    const path = result.thread.path
    assert(typeof path === 'string' && isAbsolute(path))
    return { path, records: readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  } finally { await client.close() }
}
function saveReport(): void {
  const state = JSON.parse(readFileSync(join(runtimes!, 'codex', 'current.json'), 'utf8'))
  writeFileSync(join(root, 'report.json'), JSON.stringify({ validationStatus, versions: state.versions, model, effort, codeMode, completed, errors,
    modelEndpoint: 'local synthetic responder; no real model behavior claim',
    projectNeedsInputSnapshots: snapshots.filter(run => run.owner?.kind === 'project' && run.status === 'needs_input').length,
  }, null, 2), { mode: 0o600 })
}
async function runCase(name: string, projectBound: boolean, resumeSessionId?: string): Promise<string> {
  active = { name, project: projectBound, requests: 0, needsInput: 0, wire: [], summaries: [] }
  const query = projectBound ? '?project=boundary-probe' : ''
  const headers = { authorization: `Bearer synthetic-${projectBound ? 'project' : 'session'}-token`, 'content-type': 'application/json' }
  const response = await fetch(`${baseUrl}/agents/runs${query}`, { method: 'POST', headers, body: JSON.stringify({
    description: `Codex 提问接口验收 ${name}`, identity_ids: resumeSessionId ? [] : [identity.id], session_id: resumeSessionId,
    prompt: `${name}: Before completing this task, use request_user_input to ask whether alpha or beta should be selected. Stop until an answer arrives. Do not delegate.`,
  }) })
  assert.equal(response.status, 202, await response.clone().text())
  let run = await response.json() as any
  const deadline = Date.now() + 45_000
  while (['queued', 'running', 'needs_input'].includes(run.status)) {
    if (Date.now() > deadline) throw new Error(`${name} timed out with status ${run.status}`)
    if (projectBound) assert.notEqual(run.status, 'needs_input')
    await Bun.sleep(100)
    run = await (await fetch(`${baseUrl}/agents/runs/${run.run_id}${query}`, { headers })).json()
  }
  writeFileSync(join(root, `${name}-run.json`), JSON.stringify(run, null, 2), { mode: 0o600 })
  const result = run.workers[0]
  const summary: Record<string, unknown> = { ...active, runId: run.run_id, status: run.status, sessionId: result.session_id, error: result.error }
  completed.push(summary)
  saveReport()
  assert.equal(run.status, 'completed', result.error)
  assert.equal(result.output, 'CODEX_BOUNDARY_PROBE_COMPLETE')
  const native = await readNativeHistory(result.session_id)
  const trapResult = native.records.filter(row => row.type === 'response_item' && row.payload?.type === 'function_call_output'
    && row.payload.call_id === `trap_${name}`).map(row => row.payload)
  const lastContext = native.records.filter(row => row.type === 'turn_context').at(-1)?.payload
  Object.assign(summary, { transcript: native.path, trapResult, lastContext })
  saveReport()
  assert.equal(active.needsInput, projectBound || codeMode ? 0 : 1)
  assert(active.summaries.every(item => item.questionToolPresent === !projectBound), 'unexpected native question tool visibility')
  assert(active.summaries.every(item => item.questionSchemaPresent === !projectBound), 'unexpected question schema or nested-tool instructions')
  assert(active.summaries.every(item => item.projectInstructionsPresent === projectBound), 'unexpected effective project instructions')
  if (projectBound) assert(active.summaries.every(item => item.completeGoalInstructionsPresent === true))
  assert.equal(trapResult.length, 1, 'missing native question tool result')
  if (projectBound) {
    assert(active.summaries.every(item => (item.userInteractionTools as string[]).length === 0), 'interactive user-message tool still exposed')
    assert.match(trapResult[0].output, /unsupported call: (?:functions\.)?request_user_input(?:_async)?/)
    assert.equal(lastContext?.collaboration_mode?.mode, 'default')
    assert(lastContext.collaboration_mode.settings.developer_instructions.includes('no question or answer interface'))
  }
  assert(active.summaries.every(item => item.delegationToolsPresent === true), 'native delegation tools were lost')
  if (codeMode) assert(active.summaries.every(item => (item.toolNames as string[]).includes('functions.exec')), 'Code Mode was lost')
  assert(active.wire.length >= 3 && JSON.stringify(native.records).includes(proof), 'missing native execution evidence')
  if (name === 'plan_to_session') assert.equal(lastContext?.collaboration_mode?.mode, 'plan')
  if (resumeSessionId) assert.equal(result.session_id, resumeSessionId)
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log(`PASS ${name}: project=${projectBound} needs_input=${active.needsInput} session=${result.session_id}`)
  return result.session_id
}

async function seedPlan(sessionId: string): Promise<void> {
  active = { name: 'plan_seed', project: false, seed: true, requests: 0, needsInput: 0, wire: [], summaries: [] }
  const client = controlClient()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await client.initialize('lodestar-boundary-plan-seed')
    const restored = await client.request('thread/resume', { threadId: sessionId, cwd: workDir, model, modelProvider: apiProvider.id,
      approvalPolicy: 'never', sandbox: 'danger-full-access', developerInstructions: DELEGATED_AGENT_INSTRUCTIONS,
      // Persist the former worker policy to verify that a later Lodestar launch
      // restores native delegation as well as the current interaction policy.
      config: { 'features.default_mode_request_user_input': true, 'features.multi_agent': false } })
    assert.equal(restored.thread.id, sessionId)
    const done = new Promise<any>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Plan fixture timed out')), 30_000)
      client.on('notification', (method: string, params: any) => { if (method === 'turn/completed') resolve(params.turn) })
      client.on('closed', reject)
    })
    void done.catch(() => {})
    await client.request('turn/start', { threadId: sessionId, input: [{ type: 'text', text: 'Record a Plan-mode fixture without asking a question.' }],
      collaborationMode: { mode: 'plan', settings: { model, reasoning_effort: effort, developer_instructions: null } } })
    assert.equal((await done).status, 'completed')
  } finally { if (timer) clearTimeout(timer); await client.close() }
  const native = await readNativeHistory(sessionId)
  const lastContext = native.records.filter(row => row.type === 'turn_context').at(-1)?.payload
  completed.push({ ...active, sessionId, transcript: native.path, lastContext })
  saveReport()
  assert.equal(lastContext?.collaboration_mode?.mode, 'plan', 'native Plan fixture did not persist')
  assert(active.summaries.every(item => item.questionToolPresent === true))
  console.log(`PASS plan_seed: session=${sessionId}`)
}

try {
  const fresh = await runCase('project_fresh', true)
  const control = await runCase('session_control', false)
  if (!freshOnly) {
    await runCase('project_resume', true, fresh)
    const switched = await runCase('session_to_project', true, control)
    await runCase('project_to_session', false, switched)
    await seedPlan(control)
    await runCase('plan_to_session', false, control)
    await runCase('plan_to_project', true, control)
  }
  validationStatus = 'passed'
  saveReport()
  console.log(`REPORT ${join(root, 'report.json')}`)
} catch (error) {
  validationStatus = 'failed'
  errors.push(error instanceof Error ? error.message : String(error))
  saveReport()
  throw error
} finally {
  await service.shutdown('Codex boundary probe finished')
  await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
  await modelServer.stop(true)
}
