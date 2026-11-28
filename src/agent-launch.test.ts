import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createAgentProcess } from './agent-launch'
import { claudeTranscriptPath } from './claude-agent-process'
import { listTokenSources, registerTokenSource, resetTokenSourceRegistry, tokenSourceFactories, type TokenSource } from './token-source'
import './token-source-openrouter'

test('Claude launches reject an unbound local-config route', () => {
  expect(() => createAgentProcess({ provider: 'claude', tokenSourceId: null,
    workDir: '/tmp', model: 'opus', effort: 'high' })).toThrow('Claude 账号来源未选择')
})

test('API Codex launch does not consult or bind a subscription account', () => {
  const script = `
    import { mock } from 'bun:test'
    import { EventEmitter } from 'node:events'
    import assert from 'node:assert/strict'
    let child, captured
    const spawn = (bin, args, options) => {
      captured = { args, options }
      child = new EventEmitter()
      child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
      child.stdin.write = () => true
      return child
    }
    mock.module('cross-spawn', () => ({ default: spawn, spawn }))
    const { registerTokenSource } = await import('./src/token-source')
    const { createAgentProcess } = await import('./src/agent-launch')
    const { codexAccountInUse } = await import('./src/codex-accounts')
    registerTokenSource({ id: 'api-test', kind: 'api-test', agent: 'codex', enabled: true,
      models: [{ model: 'kimi-k3', display: 'Kimi', efforts: ['high'], defaultEffort: 'high' }],
      defaultModel: 'kimi-k3', modelCatalogState: { status: 'ready', updatedAt: 1 },
      codexApiProvider: { id: 'packy', name: 'Packy', baseUrl: 'https://gateway.test/v1', envKey: 'TEST_PACKY_KEY' },
      spawnEnv: env => ({ ...env, TEST_PACKY_KEY: 'private-test-key' }), resolveSpawnModel: model => model })
    const { process: proc } = createAgentProcess({ provider: 'codex', tokenSourceId: 'api-test', workDir: '/repo',
      model: 'kimi-k3', effort: 'high', codexAccountId: 'nonexistent-subscription-account' })
    assert.ok(captured.args.includes('model_provider="packy"'))
    assert.ok(!captured.args.join(' ').includes('private-test-key'))
    assert.ok(!captured.args.join(' ').includes('forced_login_method'))
    assert.equal(captured.options.env.TEST_PACKY_KEY, 'private-test-key')
    assert.equal(codexAccountInUse('nonexistent-subscription-account'), false)
    child.emit('exit', 0, null); child.emit('close', 0, null)
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})

test('manual Codex launch bypasses failed catalogs and model restrictions while automatic launch still rejects them', () => {
  const script = `
    import { mock } from 'bun:test'
    import { EventEmitter } from 'node:events'
    import assert from 'node:assert/strict'
    const captured = []
    mock.module('./src/codex-process', () => ({
      CodexProcess: class extends EventEmitter { constructor(opts) { super(); captured.push(opts) } isAlive() { return false } },
      isCodexReasoningEffort: value => value === 'ultra', resolveCodexBin: () => 'unused',
      CODEX_REASONING_EFFORTS: ['ultra'],
    }))
    const { registerTokenSource } = await import('./src/token-source')
    registerTokenSource({ id: 'codex-sub', kind: 'codex-subscription', agent: 'codex', enabled: false,
      models: [], defaultModel: 'model', modelCatalogState: { status: 'failed', error: 'catalog unavailable' },
      spawnEnv: env => env, resolveSpawnModel: () => { throw new Error('must not resolve unavailable catalog') } })
    const { createAgentProcess } = await import('./src/agent-launch')
    const opts = { provider: 'codex', tokenSourceId: 'codex-sub', workDir: '/repo', model: 'uncatalogued-model', effort: 'ultra' }
    assert.throws(() => createAgentProcess(opts), /disabled/)
    createAgentProcess({ ...opts, codexManualAccount: true, codexAccountId: 'explicit-account' })
    assert.equal(captured.length, 1)
    assert.equal(captured[0].model, 'uncatalogued-model')
    assert.equal(captured[0].effort, 'ultra')
    assert.equal(captured[0].codexAccountId, 'explicit-account')
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})

for (const status of ['idle', 'loading', 'failed', 'ready'] as const) {
  test(`launch reports ${status} catalog state without substituting a model`, () => {
    const previous = listTokenSources()
    resetTokenSourceRegistry()
    const source: TokenSource = {
      id: 'launch-test', kind: 'test', agent: 'codex', display: 'Test Codex', enabled: true,
      models: [], defaultModel: '', modelCatalogState: { status, updatedAt: null, error: 'catalog upstream unavailable' },
      refreshModels: async () => {},
      spawnEnv: env => env,
      resolveSpawnModel: model => model,
      readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    }
    registerTokenSource(source)
    try {
      const expected = status === 'failed'
        ? 'model catalog refresh failed for launch-test: catalog upstream unavailable'
        : status === 'ready'
          ? 'model is not present in token source launch-test: gpt-6-astra'
          : `model catalog is not ready for launch-test: ${status}`
      expect(() => createAgentProcess({
        provider: 'codex', workDir: '/tmp', tokenSourceId: source.id, model: 'gpt-6-astra', effort: 'ultra',
      })).toThrow(expected)
    } finally {
      resetTokenSourceRegistry()
      for (const item of previous) registerTokenSource(item)
    }
  })
}

test('the shared Claude launch passes the selected OpenRouter slug to its role environment and rejects undeclared effort', () => {
  const previous = listTokenSources()
  const source = tokenSourceFactories().find(entry => entry.kind === 'openrouter')!.build({ api_key: 'launch-test-key' })
  source.models = [{ model: 'vendor/test', display: 'Test', efforts: ['medium'], defaultEffort: 'medium' }]
  source.modelCatalogState = { status: 'ready', updatedAt: 1 }
  registerTokenSource(source)
  try {
    const opts = { provider: 'claude' as const, workDir: '/tmp', tokenSourceId: 'openrouter', model: 'vendor/test', effort: 'medium' as const }
    const created = createAgentProcess(opts)
    const env = (created.process as any).opts.transformEnv({ ANTHROPIC_AUTH_TOKEN: 'previous-key' })
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('vendor/test')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('launch-test-key')
    expect((created.process as any).opts.settingSources).toEqual(['project', 'local'])
    expect(() => createAgentProcess({ ...opts, effort: 'max' })).toThrow('model effort unavailable')
  } finally {
    resetTokenSourceRegistry()
    for (const item of previous) registerTokenSource(item)
  }
})

test('a source launcher reaches the Claude process together with the default setting sources', () => {
  const previous = listTokenSources()
  resetTokenSourceRegistry()
  const launcher = { command: '/opt/reclaude', args: ['--org', '7', 'cli'], diagnosticPrefix: 'reclaude:' }
  const source: TokenSource = {
    id: 'launcher-test', kind: 'reclaude', agent: 'claude', display: 'Launcher', enabled: true,
    models: [{ model: 'opus', display: 'Opus', efforts: ['high'], defaultEffort: 'high' }], defaultModel: 'opus',
    modelCatalogState: { status: 'ready', updatedAt: 1 }, claudeLauncher: launcher,
    refreshModels: async () => {},
    spawnEnv: env => ({ ...env, CLAUDE_CONFIG_DIR: '/rec/config' }),
    resolveSpawnModel: model => model,
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
  }
  registerTokenSource(source)
  try {
    const opts = { provider: 'claude' as const, workDir: '/tmp', tokenSourceId: source.id, model: 'opus', effort: 'high' as const }
    const created = (createAgentProcess(opts).process as any).opts
    expect(created.launcher).toBe(launcher)
    expect(created.settingSources).toEqual(['project', 'local'])
    expect(created.transformEnv({}).CLAUDE_CONFIG_DIR).toBe('/rec/config')
    // A source without a launcher starts Claude Code directly.
    delete source.claudeLauncher
    expect('launcher' in (createAgentProcess(opts).process as any).opts).toBe(false)
  } finally {
    resetTokenSourceRegistry()
    for (const item of previous) registerTokenSource(item)
  }
})

test('a conversation kept in a launcher source cannot be continued from the shared store, or the reverse', () => {
  const previous = listTokenSources()
  resetTokenSourceRegistry()
  const root = mkdtempSync(join(tmpdir(), 'lodestar-launch-history-'))
  const workDir = join(root, 'project')
  const launcherDir = join(root, 'launcher-config')
  const transcript = claudeTranscriptPath(workDir, 'kept-by-launcher', { configDir: launcherDir, projectDirName: '' })
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, '{}\n')
  const make = (overrides: Partial<TokenSource>): TokenSource => ({
    id: 'shared-test', kind: 'test', agent: 'claude', display: '共享来源', enabled: true,
    models: [{ model: 'opus', display: 'Opus', efforts: ['high'], defaultEffort: 'high' }], defaultModel: 'opus',
    modelCatalogState: { status: 'ready', updatedAt: 1 },
    refreshModels: async () => {}, spawnEnv: env => env, resolveSpawnModel: model => model,
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    ...overrides,
  })
  registerTokenSource(make({}))
  registerTokenSource(make({ id: 'launcher-test', kind: 'reclaude', display: '启动器来源', claudeHistoryDir: launcherDir,
    claudeLauncher: { command: '/opt/reclaude', args: ['cli'], diagnosticPrefix: 'reclaude:' } }))
  const launch = (tokenSourceId: string, sessionId: string, kind: 'resume' | 'fork' = 'resume') => createAgentProcess({
    provider: 'claude', workDir, tokenSourceId, model: 'opus', effort: 'high',
    launch: { kind, source: { provider: 'claude', sessionId, cwd: workDir } },
  })
  try {
    // Within one store nothing changes, and an unknown id is left to the native resume.
    expect(launch('launcher-test', 'kept-by-launcher').process.provider).toBe('claude')
    expect(launch('shared-test', 'kept-in-shared-store').process.provider).toBe('claude')
    expect(createAgentProcess({ provider: 'claude', workDir, tokenSourceId: 'launcher-test', model: 'opus', effort: 'high' })
      .process.provider).toBe('claude')

    expect(() => launch('launcher-test', 'kept-in-shared-store'))
      .toThrow('该会话的记录不在 启动器来源 的会话目录中')
    for (const kind of ['resume', 'fork'] as const) {
      expect(() => launch('shared-test', 'kept-by-launcher', kind))
        .toThrow('该会话的记录保存在 启动器来源 的会话目录中')
    }
  } finally {
    resetTokenSourceRegistry()
    for (const item of previous) registerTokenSource(item)
    rmSync(root, { recursive: true, force: true })
  }
})

test('a reclaude conversation from another organization says how to switch the organization back', () => {
  const previous = listTokenSources()
  resetTokenSourceRegistry()
  const root = mkdtempSync(join(tmpdir(), 'lodestar-launch-org-'))
  const workDir = join(root, 'project')
  // reclaude binds each organization to its own directory: <data>/claude/accounts/<device>/config.
  const binding = (device: string) => join(root, 'reclaude', 'claude', 'accounts', device, 'config')
  const transcript = claudeTranscriptPath(workDir, 'from-old-org', { configDir: binding('device-old'), projectDirName: '' })
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, '{}\n')
  mkdirSync(binding('device-new'), { recursive: true })
  registerTokenSource({
    id: 'reclaude', kind: 'reclaude', agent: 'claude', display: 'reclaude', enabled: true,
    models: [{ model: 'opus', display: 'Opus', efforts: ['high'], defaultEffort: 'high' }], defaultModel: 'opus',
    modelCatalogState: { status: 'ready', updatedAt: 1 },
    refreshModels: async () => {}, spawnEnv: env => env, resolveSpawnModel: model => model,
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    claudeHistoryDir: binding('device-new'),
    claudeLauncher: { command: '/opt/reclaude', args: ['--org', '8', 'cli'], diagnosticPrefix: 'reclaude:' },
  })
  // A source reading the store other Claude sources share.
  registerTokenSource({
    id: 'shared-test', kind: 'test', agent: 'claude', display: '共享来源', enabled: true,
    models: [{ model: 'opus', display: 'Opus', efforts: ['high'], defaultEffort: 'high' }], defaultModel: 'opus',
    modelCatalogState: { status: 'ready', updatedAt: 1 },
    refreshModels: async () => {}, spawnEnv: env => env, resolveSpawnModel: model => model,
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
  })
  const resume = (sessionId: string, tokenSourceId = 'reclaude') => () => createAgentProcess({
    provider: 'claude', workDir, tokenSourceId, model: 'opus', effort: 'high',
    launch: { kind: 'resume', source: { provider: 'claude', sessionId, cwd: workDir } },
  })
  const failure = (run: () => unknown) => { try { run() } catch (error) { return (error as Error).message } return '' }
  try {
    // The source is still reclaude, so md cannot switch back; the organization has to.
    const sameSource = failure(resume('from-old-org'))
    expect(sameSource).toContain('该会话的记录保存在 reclaude 的另一个组织下')
    expect(sameSource).toContain('reclaude org use <原组织 ID>')
    expect(sameSource).toContain('[token_source.reclaude] 配置 org')
    expect(sameSource).not.toContain('md 切回')
    // From another source both steps are needed: md back to reclaude, then its old organization.
    const otherSource = failure(resume('from-old-org', 'shared-test'))
    expect(otherSource).toContain('该会话的记录保存在 reclaude 的另一个组织下')
    expect(otherSource).toContain('共享来源 无法续接')
    expect(otherSource).toContain('用 md 切回 reclaude，并在本机执行 reclaude org use <原组织 ID>')
    // A record found nowhere keeps the plain explanation, and the shared store leaves it to the native resume.
    expect(resume('recorded-nowhere')).toThrow('该会话的记录不在 reclaude 的会话目录中')
    expect(resume('recorded-nowhere', 'shared-test')().process.provider).toBe('claude')
  } finally {
    resetTokenSourceRegistry()
    for (const item of previous) registerTokenSource(item)
    rmSync(root, { recursive: true, force: true })
  }
})

/** 按 Codex 解释 `-c` 的规则还原覆盖结果:第一个 `=` 前为键,键按 `.` 切分且不识别引号;
 * 值按 TOML 值解析,解析失败时退回去掉首尾引号的字符串。 */
function codexConfigOverrides(args: string[]): Record<string, any> {
  const root: Record<string, any> = {}
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '-c') continue
    const raw = args[++index]!
    const eq = raw.indexOf('=')
    const valueText = raw.slice(eq + 1).trim()
    let value: unknown
    try {
      value = (Bun.TOML.parse(`_x_ = ${valueText}`) as { _x_: unknown })._x_
    } catch {
      value = valueText.replace(/^["']+|["']+$/g, '')
    }
    const parts = raw.slice(0, eq).trim().split('.')
    let table = root
    for (const part of parts.slice(0, -1)) {
      table = table[part] !== null && typeof table[part] === 'object' ? table[part] : (table[part] = {})
    }
    table[parts.at(-1)!] = value
  }
  return root
}

test('Codex spawn drops host identity, data paths, Feishu credentials and an inherited DSH task context', () => {
  // 含点、引号、空格、等号、制表符和 Windows 反斜杠的路径都必须原样成为 projects 的键。
  const workDirs = ['/repo', '/Users/john.doe/my.repo', '/tmp/a "quoted" dir', '/tmp/a=b.c', '/tmp/tab\there',
    'C:\\Users\\x\\proj.v2']
  const script = `
    import { mock } from 'bun:test'
    import { EventEmitter } from 'node:events'
    import assert from 'node:assert/strict'
    let child, captured
    const spawn = (bin, args, options) => {
      captured = { args, options }
      child = new EventEmitter()
      child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
      child.stdin.write = () => true
      return child
    }
    mock.module('cross-spawn', () => ({ default: spawn, spawn }))
    const { registerTokenSource } = await import('./src/token-source')
    const { createAgentProcess } = await import('./src/agent-launch')
    registerTokenSource({ id: 'env-test', kind: 'env-test', agent: 'codex', enabled: true,
      models: [{ model: 'm', display: 'M', efforts: ['high'], defaultEffort: 'high' }],
      defaultModel: 'm', modelCatalogState: { status: 'ready', updatedAt: 1 },
      spawnEnv: env => env, resolveSpawnModel: model => model })
    process.env.LODESTAR_RESTART_CONTINUE_CHAT_ID = 'oc_secret'
    process.env.LODESTAR_DATA_DIR = '/tmp/secret-data'
    process.env.LODESTAR_CONFIG = '/tmp/secret-config.toml'
    process.env.FEISHU_APP_SECRET = 'secret'
    process.env.DSH_LODESTAR_AGENT_CONTEXT = JSON.stringify({ baseUrl: 'http://127.0.0.1:9876', capability: 'old-task' })
    const launched = []
    for (const workDir of ${JSON.stringify(workDirs)}) {
      createAgentProcess({ provider: 'codex', tokenSourceId: 'env-test', workDir, model: 'm', effort: 'high' })
      assert.equal(captured.options.env.LODESTAR_AGENT_SESSION, undefined)
      assert.equal(captured.options.env.LODESTAR_RESTART_CONTINUE_CHAT_ID, undefined)
      assert.equal(captured.options.env.LODESTAR_DATA_DIR, undefined)
      assert.equal(captured.options.env.LODESTAR_CONFIG, undefined)
      assert.equal(captured.options.env.FEISHU_APP_SECRET, undefined)
      assert.equal(captured.options.env.DSH_LODESTAR_AGENT_CONTEXT, undefined)
      launched.push({ workDir, args: captured.args })
      child.emit('exit', 0, null); child.emit('close', 0, null)
    }
    process.stdout.write('\\nLAUNCHED ' + JSON.stringify(launched) + '\\n')
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  const output = result.stdout.toString()
  expect(result.exitCode, output + result.stderr.toString()).toBe(0)
  const line = output.split('\n').find(text => text.startsWith('LAUNCHED '))
  const launched = JSON.parse(line!.slice('LAUNCHED '.length)) as { workDir: string, args: string[] }[]
  expect(launched.map(item => item.workDir)).toEqual(workDirs)
  for (const { workDir, args } of launched) {
    expect(codexConfigOverrides(args).projects).toEqual({ [workDir]: { trust_level: 'trusted' } })
  }
})
