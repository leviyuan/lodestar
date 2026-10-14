import { expect, test } from 'bun:test'
import { createAgentProcess } from './agent-launch'
import { config } from './config'
import { listTokenSources, registerTokenSource, resetTokenSourceRegistry, tokenSourceFactories, type TokenSource } from './token-source'
import './token-source-openrouter'

test.each([false, true])('main and delegated launches translate only explicitly enabled subscriptions (enabled=%s)', enabled => {
  const previous = listTokenSources()
  const previousSafeMode = config.claude.safe_mode
  config.claude.safe_mode = enabled ? { 'claude-sub': ['*'] } : {}
  try {
    for (const id of ['claude-sub', 'glm', 'claude-native']) {
      const source: TokenSource = {
        id, kind: id === 'claude-sub' ? 'claude-subscription' : 'test', agent: 'claude', display: id, enabled: true,
        models: [{ model: 'test-model', display: 'Test', efforts: ['high'], defaultEffort: 'high' }],
        defaultModel: 'test-model', modelCatalogState: { status: 'ready', updatedAt: 1 },
        refreshModels: async () => {}, spawnEnv: env => ({ ...env, ANTHROPIC_BASE_URL: `https://${id}.test/api/anthropic` }),
        resolveSpawnModel: model => model,
        readUsage: async () => ({ state: 'not_applicable', windows: [] }),
      }
      registerTokenSource(source)
      for (const serviceName of [undefined, 'lodestar-agent']) {
        for (const profile of [undefined, { tools: 'Read' }]) {
          const created = createAgentProcess({ provider: 'claude', tokenSourceId: id, workDir: '/tmp',
            model: 'test-model', effort: 'high', serviceName, profile })
          const options = (created.process as any).opts
          const translated = enabled && id === 'claude-sub'
          expect(Boolean(options.translation)).toBe(translated)
          expect(Boolean(options.translationContext)).toBe(translated)
          expect(created.process.translationEnabled).toBe(translated)
          expect(created.process.tokenSourceId).toBe(id)
          expect(options.model).toBe('test-model')
          expect(options.effort).toBe('high')
          expect(options.transformEnv({}).ANTHROPIC_BASE_URL).toBe(`https://${id}.test/api/anthropic`)
          expect(options.appendSystemPrompt).toBeUndefined()
        }
      }
    }
  } finally {
    config.claude.safe_mode = previousSafeMode
    resetTokenSourceRegistry()
    for (const source of previous) registerTokenSource(source)
  }
})

test('configured GLM translation persists across main and delegated fresh, resumed and forked launches', () => {
  const previous = listTokenSources()
  const previousSafeMode = config.claude.safe_mode
  config.claude.safe_mode = { 'claude-sub': ['*'], glm: ['GLM-5.3'] }
  registerTokenSource({
    id: 'glm', kind: 'test', agent: 'claude', display: 'GLM', enabled: true,
    models: ['GLM-5.3', 'GLM-5.3-Flash'].map(model => ({ model, display: model, efforts: ['max'], defaultEffort: 'max' })),
    defaultModel: 'GLM-5.3', modelCatalogState: { status: 'ready', updatedAt: 1 },
    refreshModels: async () => {}, resolveSpawnModel: model => `${model}[1m]`,
    spawnEnv: env => ({ ...env, ANTHROPIC_BASE_URL: 'https://glm.test/api/anthropic' }),
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
  })
  try {
    const source = { provider: 'claude' as const, sessionId: 'old-session', cwd: '/tmp' }
    for (const serviceName of [undefined, 'lodestar-agent']) {
      for (const launch of [
        { kind: 'fresh' as const }, { kind: 'resume' as const, source },
        { kind: 'fork' as const, source, through: { provider: 'claude' as const, kind: 'assistant-message' as const,
          id: 'checkpoint', source } },
      ]) {
        for (const model of [undefined, 'GLM-5.3', 'GLM-5.3-Flash']) {
          const created = createAgentProcess({ provider: 'claude', tokenSourceId: 'glm', workDir: '/tmp',
            model, effort: 'max', launch, serviceName }).process as any
          const translated = model !== 'GLM-5.3-Flash'
          expect(created.translationEnabled).toBe(translated)
          expect(Boolean(created.opts.translation)).toBe(translated)
          expect(Boolean(created.opts.translationContext)).toBe(translated)
          expect(created.tokenSourceId).toBe('glm')
          expect(created.opts.model).toBe(`${model ?? 'GLM-5.3'}[1m]`)
          expect(created.opts.effort).toBe('max')
          expect(created.opts.transformEnv({}).ANTHROPIC_BASE_URL).toBe('https://glm.test/api/anthropic')
          expect(created.opts.appendSystemPrompt).toBeUndefined()
          expect(created.opts.resumeSessionId).toBe(launch.kind === 'fresh' ? undefined : source.sessionId)
          expect(created.opts.forkSession).toBe(launch.kind === 'fork' ? true : undefined)
          expect(created.opts.resumeSessionAt).toBe(launch.kind === 'fork' ? 'checkpoint' : undefined)
        }
      }
    }
  } finally {
    config.claude.safe_mode = previousSafeMode
    resetTokenSourceRegistry()
    for (const source of previous) registerTokenSource(source)
  }
})

test('an explicit empty subscription safety list disables the boundary for main and delegated launches', () => {
  const previous = listTokenSources()
  const previousSafeMode = config.claude.safe_mode
  config.claude.safe_mode = { 'claude-sub': [] }
  registerTokenSource({
    id: 'claude-sub', kind: 'claude-subscription', agent: 'claude', display: 'Claude', enabled: true,
    models: [{ model: 'opus', display: 'Opus', efforts: ['high'], defaultEffort: 'high' }],
    defaultModel: 'opus', modelCatalogState: { status: 'ready', updatedAt: 1 },
    refreshModels: async () => {}, resolveSpawnModel: model => model, spawnEnv: env => env,
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
  })
  try {
    for (const serviceName of [undefined, 'lodestar-agent']) {
      const created = createAgentProcess({ provider: 'claude', tokenSourceId: 'claude-sub', workDir: '/tmp',
        effort: 'high', serviceName }).process as any
      expect(created.translationEnabled).toBe(false)
      expect(created.opts.translation).toBeUndefined()
      expect(created.opts.translationContext).toBeUndefined()
      expect(created.tokenSourceId).toBe('claude-sub')
    }
  } finally {
    config.claude.safe_mode = previousSafeMode
    resetTokenSourceRegistry()
    for (const source of previous) registerTokenSource(source)
  }
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
