/** Simulate Claude cleanup only inside a newly created private fixture directory.
 * Starts the selected native Claude runtime against a localhost synthetic model;
 * never reads production credentials, calls a provider, or controls the daemon.
 * bun scripts/test-claude-shared-cleanup.ts --agent-runtimes /abs/runtimes --output-dir /abs/new-dir
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const output = option('--output-dir'), runtimes = option('--agent-runtimes')
assert(output && runtimes && isAbsolute(output) && isAbsolute(runtimes), 'provide absolute --output-dir and --agent-runtimes')
const root = resolve(output)
mkdirSync(root, { mode: 0o700 }) // Must be new: never turn an existing directory into a cleanup fixture.
for (const name of ['state', 'home', 'workspace', 'wire', 'tmp']) mkdirSync(join(root, name), { mode: 0o700 })
symlinkSync(resolve(runtimes), join(root, 'state', 'agent-runtimes'), 'dir')
const configFile = join(root, 'config.toml')
writeFileSync(configFile, '[feishu]\napp_id="isolated-cleanup-probe"\napp_secret="synthetic-no-feishu-access"\n', { mode: 0o600 })
process.env.LODESTAR_CONFIG = configFile
process.env.LODESTAR_DATA_DIR = join(root, 'state')
process.env.CLAUDE_CONFIG_DIR = join(root, 'home', '.claude')
process.env.LODESTAR_DISABLE_SKILL_SYNC = '1'
const { ClaudeAccounts, CLAUDE_SHARED_DIRS } = await import('../src/claude-accounts')
const { ClaudeAgentProcess, claudeTranscriptPath } = await import('../src/claude-agent-process')
const { agentRuntimeState } = await import('../src/agent-updates')
const { registerTokenSource } = await import('../src/token-source')
const { getAgentIdentityCatalog } = await import('../src/agent-identities')

const shared = process.env.CLAUDE_CONFIG_DIR
const accountsDir = join(root, 'home', '.claude-accounts'), accountDir = join(accountsDir, 'cleanup-fixture')
mkdirSync(accountDir, { recursive: true, mode: 0o700 })
mkdirSync(shared, { mode: 0o700 })
const fixtureFiles = new Map([
  [join(accountDir, '.credentials.json'), '{"fixture":"private-named-credential"}\n'],
  [join(shared, '.credentials.json'), '{"fixture":"private-default-credential"}\n'],
  [join(shared, 'preserved-proof.txt'), `PRESERVED-${randomUUID()}\n`],
])
for (const [path, value] of fixtureFiles) writeFileSync(path, value, { mode: 0o600 })
writeFileSync(join(shared, 'settings.json'), '{"env":{}}\n', { mode: 0o600 })
const registry = new ClaudeAccounts({ home: join(root, 'home'), accountsDir,
  stateFile: join(root, 'state', 'fixture-accounts.json'), env: { CLAUDE_CONFIG_DIR: shared } })
const account = await registry.enroll('cleanup-fixture', async () => ({
  apiProvider: 'firstParty', apiKeySource: 'none', subscriptionType: 'max', email: 'synthetic-cleanup@example.invalid',
}))
const accountState = readFileSync(registry.stateFile, 'utf8')
const revision = registry.revision(account.id)
const allDirectories = readdirSync(shared).filter(name => lstatSync(join(shared, name)).isDirectory())
const model = 'GLM-5.3-Flash'
registerTokenSource({
  id: 'cleanup-local-fixture', kind: 'isolated-protocol-probe', display: 'Local synthetic cleanup model', agent: 'claude', enabled: true,
  settingSources: [], models: [{ model, display: model, efforts: ['high'], defaultEffort: 'high' }], defaultModel: model,
  modelCatalogState: { status: 'ready', updatedAt: Date.now() }, refreshModels: async () => {},
  resolveSpawnModel: value => value, readUsage: async () => ({ state: 'not_applicable', windows: [] }), spawnEnv: env => env,
})
const identity = getAgentIdentityCatalog().identities.find(item => item.tokenSourceId === 'cleanup-local-fixture')!
assert.equal(identity.status, 'ready')
const results: Array<Record<string, unknown>> = []
const report = { status: 'RUNNING', runtime: agentRuntimeState('claude'), root,
  model: { id: model, syntheticLocalhostOnly: true }, results }
const reportFile = join(root, 'report.json')
const saveReport = () => writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 })
saveReport()

type CleanupMode = 'targets' | 'links' | 'targets-and-links'
const modes: CleanupMode[] = ['targets', 'links', 'targets-and-links']
function checkPreserved(): void {
  for (const [path, value] of fixtureFiles) assert.equal(readFileSync(path, 'utf8'), value, `preserved file changed: ${path}`)
  assert.equal(readFileSync(registry.stateFile, 'utf8'), accountState, 'repair rewrote the account registry')
  assert.equal(registry.revision(account.id), revision, 'repair changed the account generation or identity')
}
function checkShared(names: readonly string[]) {
  for (const name of names) {
    assert(lstatSync(join(shared, name)).isDirectory(), `missing independent target: ${name}`)
    assert(lstatSync(join(accountDir, name)).isSymbolicLink(), `missing account link: ${name}`)
    assert.equal(realpathSync(join(accountDir, name)), realpathSync(join(shared, name)))
  }
  checkPreserved()
  return names.map(name => ({ name, target: join(shared, name), link: join(accountDir, name),
    resolvedLink: realpathSync(join(accountDir, name)) }))
}
function clean(mode: CleanupMode, names: readonly string[]) {
  checkShared(names)
  for (const name of names) {
    // All deletion paths are exact children of the two fixture roots created above.
    assert(!name.includes('/') && !name.includes('\\') && name !== '..')
    assert.equal(resolve(accountDir, readlinkSync(join(accountDir, name))), join(shared, name))
    if (mode !== 'links') rmSync(join(shared, name), { recursive: true })
    if (mode !== 'targets') rmSync(join(accountDir, name))
    if (mode !== 'links') assert.throws(() => lstatSync(join(shared, name)), { code: 'ENOENT' })
    if (mode !== 'targets') assert.throws(() => lstatSync(join(accountDir, name)), { code: 'ENOENT' })
  }
  return names.map(name => ({ name, target: join(shared, name), link: join(accountDir, name),
    targetExists: mode === 'links', linkExists: mode === 'targets',
    danglingLink: mode === 'targets', linkTarget: mode === 'targets' ? readlinkSync(join(accountDir, name)) : null }))
}
function response(body: any, content: any, reason: string): Response {
  if (!body.stream) return Response.json({ id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model,
    content: [content], stop_reason: reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 30 } })
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  return new Response([
    event('message_start', { message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }),
    event('content_block_start', { index: 0, content_block: content.type === 'text' ? { type: 'text', text: '' } : { ...content, input: {} } }),
    event('content_block_delta', { index: 0, delta: content.type === 'text'
      ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 30 } }),
    event('message_stop', {}),
  ].join(''), { headers: { 'content-type': 'text/event-stream' } })
}

try {
  for (const mode of modes) {
    for (const entry of ['env', 'acquireUse', 'prepareShared'] as const) {
      const names = entry === 'prepareShared' ? allDirectories : [...CLAUDE_SHARED_DIRS]
      const beforeRepair = clean(mode, names)
      if (entry === 'env') assert.equal(registry.env(account.id, {}).CLAUDE_CONFIG_DIR, accountDir)
      else if (entry === 'acquireUse') registry.acquireUse(account.id)()
      else registry.prepareShared(account.id)
      const afterRepair = checkShared(names)
      results.push({ mode, entry, directories: names.length, status: 'PASS', beforeRepair, afterRepair })
      console.log(JSON.stringify({ mode, entry, directories: names.length, status: 'PASS' }))
      saveReport()
    }
  }

  for (const mode of modes) {
    const beforeRepair = clean(mode, allDirectories)
    const launchEnv = registry.env(account.id, {})
    const release = registry.acquireUse(account.id)
    registry.prepareShared(account.id)
    const afterRepair = checkShared(allDirectories)
    const proof = `NATIVE-CLEANUP-${randomUUID()}`
    const nativeFiles = CLAUDE_SHARED_DIRS.map(name => join(accountDir, name, `native-${mode}.txt`))
    let requestCount = 0
    let failProbe: (error: unknown) => void = () => {}
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
      error(error) { failProbe(error); return new Response('probe failed', { status: 400 }) },
      async fetch(req) {
        const path = new URL(req.url).pathname
        if (path.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 })
        if (!path.endsWith('/messages')) return new Response('unexpected endpoint', { status: 404 })
        const body = await req.json() as any
        if (!body.tools?.length) return response(body, { type: 'text', text: 'local helper' }, 'end_turn')
        const index = requestCount++
        writeFileSync(join(root, 'wire', `${mode}-${requestCount}.json`), JSON.stringify(body, null, 2), { mode: 0o600 })
        if (index < nativeFiles.length) return response(body, { type: 'tool_use', id: `write_${index}`, name: 'Write',
          input: { file_path: nativeFiles[index], content: `${proof}\n` } }, 'tool_use')
        for (const file of nativeFiles) assert.equal(readFileSync(file, 'utf8'), `${proof}\n`, 'native Write failed')
        if (index === nativeFiles.length) return response(body, { type: 'tool_use', id: 'read_shared_proof', name: 'Read',
          input: { file_path: join(shared, 'plans', `native-${mode}.txt`) } }, 'tool_use')
        const toolResults = body.messages.flatMap((message: any) => Array.isArray(message.content)
          ? message.content.filter((block: any) => block.type === 'tool_result') : [])
        const readResult = toolResults.find((block: any) => block.tool_use_id === 'read_shared_proof')
        assert(readResult && !readResult.is_error && JSON.stringify(readResult.content).includes(proof), 'native Read did not see shared Write')
        return response(body, { type: 'text', text: 'CLEANUP_NATIVE_START_AND_SHARED_IO_PASS' }, 'end_turn')
      },
    })
    const proc = new ClaudeAgentProcess({ workDir: join(root, 'workspace'), model, effort: 'high', settingSources: [],
      profile: { tools: 'Read,Write', loadProjectMcp: false },
      transformEnv: env => ({ PATH: env.PATH, SYSTEMROOT: env.SYSTEMROOT, WINDIR: env.WINDIR, TEMP: join(root, 'tmp'),
        TMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp'), ...launchEnv,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_AUTH_TOKEN: 'synthetic-cleanup-token',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048' }),
    })
    const nativeInit: object[] = []
    const handleMessage = (proc as any).handleMessage.bind(proc)
    ;(proc as any).handleMessage = (raw: any) => {
      if (raw.type === 'system' && raw.subtype === 'init') nativeInit.push({ type: raw.type, subtype: raw.subtype,
        sessionId: raw.session_id, model: raw.model, tools: raw.tools })
      handleMessage(raw)
    }
    try {
      const result = await new Promise<any>((resolveResult, reject) => {
        const timer = setTimeout(() => finish(new Error(`native cleanup probe timed out: ${mode}, requests=${requestCount}`)), 45_000)
        const finish = (error: unknown, value?: any) => {
          clearTimeout(timer)
          proc.off('result', onResult)
          proc.off('error', onError)
          if (error) reject(error)
          else resolveResult(value)
        }
        const onResult = (value: any) => finish(null, value)
        const onError = (error: unknown) => finish(error)
        failProbe = onError
        proc.on('result', onResult)
        proc.on('error', onError)
        proc.sendUserText('Complete the isolated shared-directory write/read probe.')
      })
      assert.equal(result.is_error, false, JSON.stringify(result))
      assert.equal(requestCount, 6)
      assert(proc.sessionId, 'native session did not initialize')
      assert.equal(nativeInit.length, 1, 'native init event missing')
      await proc.kill()
      const transcript = claudeTranscriptPath(join(root, 'workspace'), proc.sessionId, { configDir: accountDir })
      assert(transcript && statSync(transcript).size > 0, 'native session did not persist into repaired projects')
      const transcriptCopy = join(root, 'wire', `${mode}-transcript.jsonl`)
      copyFileSync(transcript, transcriptCopy)
      checkShared(allDirectories)
      for (let index = 0; index < nativeFiles.length; index++) {
        assert.equal(readFileSync(nativeFiles[index]!, 'utf8'), `${proof}\n`)
        assert.equal(realpathSync(nativeFiles[index]!), join(shared, CLAUDE_SHARED_DIRS[index]!, `native-${mode}.txt`))
      }
      results.push({ mode, entry: 'native-start', status: 'PASS', requests: requestCount, nativeWrites: nativeFiles.length,
        sharedRead: true, transcript, transcriptCopy, sessionId: proc.sessionId, nativeInit, result, beforeRepair, afterRepair })
      console.log(JSON.stringify({ mode, entry: 'native-start', status: 'PASS', requests: requestCount,
        nativeWrites: nativeFiles.length, sharedRead: true, transcript, sessionId: proc.sessionId }))
    } finally {
      await proc.kill()
      release()
      server.stop(true)
      saveReport()
    }
  }
  report.status = 'PASS'
  console.log(`假清理与原生启动验证通过：${reportFile}`)
} catch (error) {
  report.status = 'FAIL'
  results.push({ status: 'FAIL', error: error instanceof Error ? error.stack : String(error) })
  throw error
} finally { saveReport() }
