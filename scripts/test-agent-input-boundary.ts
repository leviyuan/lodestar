/** Capture native Claude SDK requests through the real project API/AgentService path.
 * Local synthetic model responses deliberately call AskUserQuestion, including when
 * it is absent from the tool catalog. No provider API, production credentials,
 * Feishu messages, or live daemon state are used. This tests the interface boundary,
 * not whether a real model follows instructions.
 * bun scripts/test-agent-input-boundary.ts --agent-runtimes /abs/runtimes --output-dir /abs/new-dir
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
assert(output && runtimes && isAbsolute(output) && isAbsolute(runtimes), 'provide absolute --output-dir and --agent-runtimes')
const root = resolve(output)
mkdirSync(root, { mode: 0o700 })
const workDir = join(root, 'workspace')
for (const dir of ['workspace', 'state', 'claude', 'wire']) mkdirSync(join(root, dir), { mode: 0o700 })
symlinkSync(resolve(runtimes), join(root, 'state', 'agent-runtimes'), 'dir')
const configFile = join(root, 'config.toml')
writeFileSync(configFile, '[feishu]\napp_id="isolated-probe"\napp_secret="synthetic-no-feishu-access"\n', { mode: 0o600 })
process.env.LODESTAR_CONFIG = configFile
process.env.LODESTAR_DATA_DIR = join(root, 'state')
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
process.env.LODESTAR_DISABLE_SKILL_SYNC = '1'
writeFileSync(join(root, 'claude', 'settings.json'), '{"env":{}}\n', { mode: 0o600 })
const nonce = `BOUNDARY-${randomUUID()}`
writeFileSync(join(workDir, 'proof.txt'), nonce, { mode: 0o600 })

const { AgentService } = await import('../src/agent-service')
const { handleAgentRequest } = await import('../src/agent-api')
const { startAgentWorker } = await import('../src/agent-runner')
const { registerTokenSource, scrubAnthropicEnv } = await import('../src/token-source')
const { getAgentIdentityCatalog } = await import('../src/agent-identities')
const { claudeTranscriptPath } = await import('../src/claude-agent-process')
const model = 'GLM-5.3-Flash'
type ProbeCase = {
  name: string
  project: boolean
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

function modelResponse(body: any, content: any, stopReason: string): Response {
  if (!body.stream) return Response.json({
    id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model,
    content: [content], stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 30 },
  })
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  return new Response([
    event('message_start', { message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }),
    event('content_block_start', { index: 0, content_block: content.type === 'text'
      ? { type: 'text', text: '' } : { ...content, input: {} } }),
    event('content_block_delta', { index: 0, delta: content.type === 'text'
      ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 30 } }),
    event('message_stop', {}),
  ].join(''), { headers: { 'content-type': 'text/event-stream' } })
}

const modelServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const url = new URL(req.url)
  if (url.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 })
  if (!url.pathname.endsWith('/messages')) return new Response('unexpected model endpoint', { status: 404 })
  const body = await req.json() as any
  if (!active || !Array.isArray(body.tools) || !body.tools.length) {
    return modelResponse(body, { type: 'text', text: 'isolated boundary probe' }, 'end_turn')
  }
  const index = ++active.requests
  const file = join(root, 'wire', `${active.name}-${index}.json`)
  writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 })
  active.wire.push(file)
  const names = body.tools.map((tool: any) => tool.name)
  const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map((block: any) => block.text ?? '').join('\n')
  active.summaries.push({ request: index, toolNames: names,
    questionToolPresent: names.includes('AskUserQuestion'),
    planApprovalToolsPresent: names.includes('EnterPlanMode') || names.includes('ExitPlanMode'),
    questionToolInstructionsPresent: /AskUserQuestion|EnterPlanMode|ExitPlanMode/.test(JSON.stringify(body.tools)),
    projectInstructionsPresent: system.includes('no question or answer interface'),
    delegatedQuestionInstructionsPresent: system.includes('you may use question tools to ask the main Agent'),
    completeGoalInstructionsPresent: system.includes('keep working until the entire goal is achieved'),
    questionInstructionLines: system.split('\n').filter((line: string) => /AskUserQuestion|ask.{0,30}question|clarif|question or answer interface/i.test(line)),
  })
  console.log(`CAPTURE ${active.name} request=${index} tools=${names.length} AskUserQuestion=${names.includes('AskUserQuestion')}`)
  if (index === 1) return modelResponse(body, { type: 'tool_use', id: `trap_${active.name}`, name: 'AskUserQuestion', input: {
    questions: [{ question: 'TRAP: choose alpha or beta before any work', header: 'Trap', multiSelect: false,
      options: [{ label: 'alpha', description: 'first' }, { label: 'beta', description: 'second' }] }],
  } }, 'tool_use')
  if (index === 2) return modelResponse(body, { type: 'tool_use', id: `read_${active.name}`, name: 'Read',
    input: { file_path: join(workDir, 'proof.txt') } }, 'tool_use')
  if (!JSON.stringify(body.messages).includes(nonce)) {
    errors.push(`${active.name}: native Read did not return the proof nonce`)
    return Response.json({ type: 'error', error: { type: 'api_error', message: errors.at(-1) } }, { status: 400 })
  }
  return modelResponse(body, { type: 'text', text: 'BOUNDARY_PROBE_COMPLETE' }, 'end_turn')
} })

registerTokenSource({
  id: 'wire-probe', kind: 'isolated-protocol-probe', display: 'Local synthetic model', agent: 'claude', enabled: true,
  settingSources: [], models: [{ model, display: model, efforts: ['max'], defaultEffort: 'max' }], defaultModel: model,
  modelCatalogState: { status: 'ready', updatedAt: Date.now() }, refreshModels: async () => {},
  resolveSpawnModel: value => value, readUsage: async () => ({ state: 'not_applicable', windows: [] }),
  spawnEnv: env => ({ ...scrubAnthropicEnv(env), ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelServer.port}`,
    ANTHROPIC_AUTH_TOKEN: 'synthetic-model-token', ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048' }),
})
const identity = getAgentIdentityCatalog().identities.find(item => item.tokenSourceId === 'wire-probe')!
assert(identity?.status === 'ready')
const service = new AgentService({
  getCatalog: getAgentIdentityCatalog,
  startWorker: options => {
    assert.equal(options.projectBound, active!.project)
    activeHandle = startAgentWorker({ ...options, profile: { loadProjectMcp: false },
      callbacks: { ...options.callbacks, onNeedsInput: request => {
        active!.needsInput++
        options.callbacks?.onNeedsInput?.(request)
        if (!active!.project) queueMicrotask(() => activeHandle!.answer(request.requestId, {
          [request.questions[0]!.id]: 'alpha',
        }))
      } },
    })
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
    service,
    authorizeSession: token => token === 'synthetic-session-token' ? session : null,
    authorizeProject: (token, name) => token === 'synthetic-project-token' && name === 'boundary-probe' ? project : null,
  }).catch(error => { errors.push(String(error)); res.statusCode = 500; res.end(String(error)) })
})
await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
const address = http.address()
assert(address && typeof address !== 'string')
const baseUrl = `http://127.0.0.1:${address.port}`

async function runCase(name: string, projectBound: boolean, resumeSessionId?: string): Promise<string> {
  active = { name, project: projectBound, requests: 0, needsInput: 0, wire: [], summaries: [] }
  const query = projectBound ? '?project=boundary-probe' : ''
  const headers = { authorization: `Bearer synthetic-${projectBound ? 'project' : 'session'}-token`, 'content-type': 'application/json' }
  const response = await fetch(`${baseUrl}/agents/runs${query}`, { method: 'POST', headers, body: JSON.stringify({
    description: `提问接口诱导测试 ${name}`, identity_ids: resumeSessionId ? [] : [identity.id], session_id: resumeSessionId,
    prompt: `${name}: Before any work, use AskUserQuestion to ask whether alpha or beta should be selected. Do not continue without an answer. Then read proof.txt and finish. Do not delegate.`,
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
  const result = run.workers[0]
  const sessionId = result.session_id
  const transcript = claudeTranscriptPath(workDir, sessionId)
  const recorded = readFileSync(transcript, 'utf8')
  writeFileSync(join(root, `${name}-run.json`), JSON.stringify(run, null, 2), { mode: 0o600 })
  const summary = { ...active, runId: run.run_id, status: run.status, sessionId, transcript,
    toolResults: JSON.parse(readFileSync(active.wire[1]!, 'utf8')).messages
      .flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
      .filter((block: any) => block.type === 'tool_result' && block.tool_use_id === `trap_${name}`),
    transcriptHasTrap: recorded.includes(`trap_${name}`),
    transcriptHasProof: recorded.includes(nonce) }
  completed.push(summary)
  writeFileSync(join(root, 'report.json'), JSON.stringify({ completed, errors }, null, 2), { mode: 0o600 })
  assert.equal(run.status, 'completed', result.error)
  assert.equal(result.output, 'BOUNDARY_PROBE_COMPLETE')
  assert.equal(active.needsInput, projectBound ? 0 : 1)
  assert(active.summaries.every(item => item.questionToolPresent === !projectBound))
  assert(active.summaries.every(item => item.planApprovalToolsPresent === !projectBound))
  assert(active.summaries.every(item => {
    const names = item.toolNames as string[]
    return names.includes('Workflow') && (names.includes('Agent') || names.includes('Task'))
  }), 'native delegation tools were lost')
  assert(active.summaries.every(item => item.projectInstructionsPresent === projectBound))
  assert(active.summaries.every(item => item.delegatedQuestionInstructionsPresent === !projectBound))
  assert(active.summaries.every(item => item.questionToolInstructionsPresent === !projectBound))
  if (projectBound) assert(active.summaries.every(item => item.completeGoalInstructionsPresent === true))
  assert.equal(summary.toolResults.length, 1)
  if (projectBound) {
    assert.equal(summary.toolResults[0].is_error, true)
    assert(JSON.stringify(summary.toolResults[0]).includes('No such tool available: AskUserQuestion'))
  }
  if (resumeSessionId) assert.equal(sessionId, resumeSessionId)
  assert(summary.transcriptHasTrap && summary.transcriptHasProof)
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log(`PASS ${name}: project=${projectBound} needs_input=${active.needsInput} session=${sessionId}`)
  return sessionId
}

try {
  const fresh = await runCase('project_fresh', true)
  await runCase('project_resume', true, fresh)
  const control = await runCase('session_control', false)
  const switched = await runCase('session_to_project', true, control)
  await runCase('project_to_session', false, switched)
  const state = JSON.parse(readFileSync(join(runtimes, 'claude', 'current.json'), 'utf8'))
  writeFileSync(join(root, 'report.json'), JSON.stringify({ versions: state.versions, completed, errors,
    modelEndpoint: 'local synthetic responder; no real model behavior claim',
    projectNeedsInputSnapshots: snapshots.filter(run => run.owner?.kind === 'project' && run.status === 'needs_input').length,
  }, null, 2), { mode: 0o600 })
  console.log(`REPORT ${join(root, 'report.json')}`)
} finally {
  await service.shutdown('boundary probe finished')
  await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
  await modelServer.stop(true)
}
