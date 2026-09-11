/** Native Codex fault injection: real local tool work, two quota failures, automatic thread resume.
 * All homes/config/quotas are synthetic; model requests go only to localhost. No Feishu or daemon. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentProcess } from '../src/agent-process'

const parent = join(homedir(), '.cache', 'lodestar-acceptance')
mkdirSync(parent, { recursive: true, mode: 0o700 })
const root = mkdtempSync(join(parent, 'codex-quota-'))
const home = join(root, 'native'); const cwd = join(root, 'project'); const runtime = join(root, 'runtime')
for (const path of [home, cwd, runtime]) mkdirSync(path)
const configFile = join(root, 'lodestar.toml')
writeFileSync(configFile, `[feishu]\napp_id = "local-test"\napp_secret = "local-test"\n[runtime]\nprojects_root = ${JSON.stringify(root)}\n`)
writeFileSync(join(runtime, 'package.json'), '{"private":true,"type":"module"}')
symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(runtime, 'node_modules'), 'junction')
process.env.NODE_ENV = 'test'
process.env.LODESTAR_CONFIG = configFile
process.env.LODESTAR_DATA_DIR = join(root, 'state')
process.env.CODEX_HOME = home
process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT = runtime

const { codexAccounts, processCodexAccount } = await import('../src/codex-accounts')
const { CodexAccountScheduler } = await import('../src/codex-account-scheduler')
const { CodexAccountProcess } = await import('../src/codex-account-process')
const { CodexProcess } = await import('../src/codex-process')
const { snapshotFromReadResponse } = await import('../src/usage')
const second = codexAccounts.ensure('Pro 5x'); const third = codexAccounts.ensure('Plus')
const ids = ['default', second.id, third.id]
const exhausted = new Set<string>()
const marker = join(cwd, 'exactly-once.txt')
const requests: any[] = []; const selected: string[] = []; const nativeChildren: InstanceType<typeof CodexProcess>[] = []
const now = Date.now()
const limits = (id: string) => ({ accountId: `synthetic-${id}`, ordinaryUsageAllowed: !exhausted.has(id),
  rateLimits: { limitId: 'codex', planType: id === 'default' ? 'pro' : id === second.id ? 'prolite' : 'plus',
    primary: { usedPercent: exhausted.has(id) ? 100 : 0, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 86400 }, secondary: null } })

const server = createServer(async (req, res) => {
  if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString())
  const account = String(req.headers['x-lodestar-test-account'])
  requests.push({ account, body })
  const n = requests.length
  if (n > 1 && account !== third.id) {
    exhausted.add(account)
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'usage_limit_reached', plan_type: 'pro',
      resets_at: Math.floor(now / 1000) + 86400, message: "You've hit your usage limit." } }))
    return
  }
  const item = n === 1
    ? { type: 'function_call', id: 'tool_once', call_id: 'call_once', name: 'exec_command',
      arguments: JSON.stringify({ cmd: `# desc: 本地额度验收仅追加一次标记\nprintf 'done\\n' >> '${marker}'`, workdir: cwd, yield_time_ms: 1000 }) }
    : { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'quota-recovery-complete', annotations: [] }] }
  const response = { id: `response_${n}`, object: 'response', status: 'completed', output: [item],
    usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } }
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
writeFileSync(join(home, 'config.toml'), [
  'model = "gpt-5.5"', 'model_provider = "local_test"', 'cli_auth_credentials_store = "file"',
  'sandbox_mode = "danger-full-access"', 'web_search = "disabled"',
  '[features]', 'code_mode = false', 'multi_agent = false',
  '[model_providers.local_test]', 'name = "Local quota acceptance"',
  `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
  'env_http_headers = { "X-Lodestar-Test-Account" = "LODESTAR_TEST_QUOTA_ACCOUNT" }',
  `[projects.${JSON.stringify(cwd)}]`, 'trust_level = "trusted"', '',
].join('\n'))
const scheduler = new CodexAccountScheduler({ accounts: () => codexAccounts.list(),
  usage: async id => snapshotFromReadResponse(limits(id)), identity: id => id,
  compatible: async () => null, pendingLogin: () => false, now: Date.now, stateFile: join(root, 'blocks.json') })
const osEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'SystemRoot', 'ComSpec', 'APPDATA', 'LOCALAPPDATA']
  .map(key => [key, process.env[key]]))
const proc = new CodexAccountProcess({ model: 'gpt-5.5', effort: 'high', workDir: cwd, launch: { kind: 'fresh' }, scheduler,
  create: (id, launch) => {
    assert.ok(nativeChildren.every(child => !child.isAlive()), 'two native processes overlap')
    const child = new CodexProcess({ workDir: cwd, model: 'gpt-5.5', effort: 'high', launch, codexAccountId: id,
      allowDelegation: false, transformEnv: () => ({ ...osEnv, CODEX_SQLITE_HOME: home, LODESTAR_TEST_QUOTA_ACCOUNT: id,
        HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }) })
    // Synthetic authoritative quota endpoint; the terminal usageLimitExceeded error remains native.
    child.readRateLimits = async () => limits(id)
    nativeChildren.push(child); selected.push(id)
    return { process: child, sourceRevision: id }
  },
})
let timer: ReturnType<typeof setTimeout> | undefined
let manualProcess: AgentProcess | null = null
try {
  const done = new Promise<any>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('native quota recovery timed out')), 60_000)
    proc.on('result', result => result.is_error ? reject(new Error(result.error ?? result.subtype)) : resolve(result))
    proc.on('exit', event => { if (!event.expected) reject(new Error('unexpected native exit')) })
  })
  void done.catch(() => {})
  proc.sendInitialize(); await proc.initializationPromise()
  const thread = proc.sessionId
  proc.sendUserText('Append exactly one done line to exactly-once.txt, then report success. Preserve completed work after any quota interruption.')
  await done
  assert.equal(readFileSync(marker, 'utf8'), 'done\n', 'tool was replayed or did not execute')
  assert.equal(proc.sessionId, thread)
  assert.deepEqual(selected, ids)
  assert.equal(processCodexAccount(proc), third.id)
  assert.equal(requests.length, 4)
  assert.ok(JSON.stringify(requests.at(-1).body.input).includes('call_once'), 'tool history lost across account restarts')
  assert.equal(requests.at(-1).body.input.filter((item: any) => item.type === 'function_call' && item.call_id === 'call_once').length, 1)
  console.log(JSON.stringify({ result: 'passed', accountRestarts: 2, nativeThreadPreserved: true,
    localSideEffectCount: 1, modelRequests: requests.length, endpoint: 'localhost', realCredentialsUsed: false }))
  await proc.kill()
  if (timer !== undefined) clearTimeout(timer)
  // Run through the real shared factory with a deliberately disabled/empty catalog and exhausted Plus fixture.
  exhausted.add(third.id)
  const { registerTokenSource } = await import('../src/token-source')
  registerTokenSource({ id: 'codex-sub', kind: 'codex-subscription', agent: 'codex', display: 'Manual acceptance',
    enabled: false, models: [], defaultModel: 'gpt-6-astra', modelCatalogState: { status: 'failed', error: 'synthetic catalog failure', updatedAt: Date.now() },
    refreshModels: async () => { throw new Error('manual launch must not refresh the catalog') },
    readUsage: async () => { throw new Error('manual launch must not read usage') },
    resolveSpawnModel: () => { throw new Error('manual launch must not resolve through the failed catalog') },
    spawnEnv: () => ({ ...osEnv, CODEX_SQLITE_HOME: home, LODESTAR_TEST_QUOTA_ACCOUNT: third.id,
      HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }),
  })
  const { createAgentProcess } = await import('../src/agent-launch')
  manualProcess = createAgentProcess({ provider: 'codex', tokenSourceId: 'codex-sub', codexAccountPreference: third.id,
    model: 'gpt-6-astra', effort: 'ultra', workDir: cwd, allowDelegation: false }).process
  const manualDone = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('manual native launch timed out')), 30_000)
    manualProcess!.on('result', result => result.is_error ? reject(new Error(result.error ?? result.subtype)) : resolve())
  })
  void manualDone.catch(() => {})
  manualProcess.sendInitialize(); await manualProcess.initializationPromise!()
  manualProcess.sendUserText('Reply with the verification marker. Do not use tools.')
  await manualDone
  assert.equal(processCodexAccount(manualProcess), third.id)
  assert.equal(manualProcess.codexAccountSelectionMode?.(), 'manual')
  assert.equal(requests.length, 5)
  assert.equal(requests.at(-1).body.model, 'gpt-6-astra')
  // Ultra is a native orchestration mode; the Responses wire effort is normalized by Codex.
  assert.equal(manualProcess.lastEffort, 'ultra')
  console.log(JSON.stringify({ result: 'passed', scenario: 'forced-plus-ultra', disabledCatalogBypassed: true,
    exhaustedAccountUsed: true, nativeEffort: manualProcess.lastEffort,
    wireEffort: requests.at(-1).body.reasoning.effort, modelRequests: 1, realCredentialsUsed: false }))
} finally {
  if (timer !== undefined) clearTimeout(timer)
  await proc.kill()
  await manualProcess?.kill()
  await new Promise<void>(resolve => server.close(() => resolve()))
  assert.ok(nativeChildren.every(child => !child.isAlive()), `native processes still alive; retain ${root}`)
  rmSync(root, { recursive: true, force: true })
}
