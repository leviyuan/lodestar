import { expect, test } from 'bun:test'
import { createAgentProcess } from './agent-launch'
import { listTokenSources, registerTokenSource, resetTokenSourceRegistry, tokenSourceFactories, type TokenSource } from './token-source'
import './token-source-openrouter'

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
