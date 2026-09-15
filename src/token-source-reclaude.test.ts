import { expect, test } from 'bun:test'

function isolated(script: string): void {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
}

test('ReClaude pins SDK traffic to its local proxy and keeps the read-only key out of model authentication', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    let failure
    let requested
    const original = await import('./src/token-source-models')
    mock.module('./src/token-source-models', () => ({ ...original, fetchNativeClaudeModels: async options => {
      requested = options
      if (failure) throw failure
      return [{ model: 'sonnet', display: 'Sonnet', efforts: ['high', 'low'], defaultEffort: 'high' }]
    } }))
    const { createReclaudeSource } = await import('./src/token-source-reclaude')
    const readRuntime = () => ({ proxyUrl: 'http://127.0.0.1:34567', caFile: '/reclaude/ca.pem' })
    const source = createReclaudeSource({ auth: 'reclaude-login', api_key: 'rck_readonly', org_id: '42' }, readRuntime)
    await source.refreshModels()
    assert.equal(source.defaultModel, 'sonnet')
    assert.equal(source.modelCatalogState.status, 'ready')
    assert.deepEqual(source.models[0].efforts, ['high', 'low'])
    const env = source.spawnEnv({ ANTHROPIC_API_KEY: 'previous-key', CLAUDE_CODE_OAUTH_TOKEN: 'previous-login', HTTPS_PROXY: 'http://wrong', NO_PROXY: '*', LODESTAR_AGENT_CAPABILITY: 'retain' })
    assert.equal(env.ANTHROPIC_API_KEY, '')
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '')
    assert.equal(env.HTTPS_PROXY, readRuntime().proxyUrl)
    assert.equal(env.https_proxy, readRuntime().proxyUrl)
    assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1')
    assert.equal(env.NODE_EXTRA_CA_CERTS, '/reclaude/ca.pem')
    assert.equal(env.LODESTAR_AGENT_CAPABILITY, 'retain')
    assert.ok(!JSON.stringify(env).includes('rck_readonly'))
    assert.deepEqual(requested.settings, source.claudeSettings)
    assert.deepEqual(requested.settingSources, [])
    assert.equal(requested.tokenSourceId, 'reclaude')
    assert.equal(source.claudeSettings.forceLoginMethod, 'claudeai')
    const { registerTokenSource } = await import('./src/token-source')
    const { createAgentProcess } = await import('./src/agent-launch')
    registerTokenSource(source)
    const created = createAgentProcess({ provider: 'claude', workDir: '/tmp', tokenSourceId: 'reclaude', model: 'sonnet', effort: 'high' })
    assert.deepEqual(created.process.opts.settings, source.claudeSettings)
    assert.equal(created.process.opts.transformEnv({}).HTTPS_PROXY, readRuntime().proxyUrl)
    assert.equal(created.process.opts.tokenSourceId, 'reclaude')
    failure = new Error('catalog upstream failed')
    await source.refreshModels()
    assert.equal(source.modelCatalogState.status, 'failed')
    assert.deepEqual(source.models, [])
    assert.match(source.modelCatalogState.error, /catalog upstream failed/)
    const unavailable = createReclaudeSource({ auth: 'reclaude-login' }, () => { throw new Error('daemon stopped') })
    await unavailable.refreshModels()
    assert.match(unavailable.modelCatalogState.error, /daemon stopped/)
    assert.throws(() => unavailable.spawnEnv({}), /daemon stopped/)
    const disabled = createReclaudeSource({}, () => { throw new Error('must not read unconfigured runtime') })
    await disabled.refreshModels()
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.modelCatalogState.status, 'disabled')
  `)
})

test('ReClaude setup fixes the quota organization and replaces the native subscription entry only when enabled', () => {
  isolated(`
    import assert from 'node:assert/strict'
    const { config } = await import('./src/config')
    const registry = await import('./src/token-source')
    const { buildTokenSourcesFromConfig } = await import('./src/token-source-builtins')
    const factory = registry.tokenSourceFactories().find(f => f.kind === 'reclaude')
    assert.ok('error' in factory.setup.parseArgs(''))
    assert.ok('error' in factory.setup.parseArgs('42 not-a-personal-key'))
    const parsed = factory.setup.parseArgs('42 rck_test')
    assert.deepEqual(parsed.config, { agent: 'claude', auth: 'reclaude-login', org_id: '42', api_key: 'rck_test' })
    config.token_sources.reclaude = parsed.config
    buildTokenSourcesFromConfig()
    const sub = registry.getTokenSource('claude-sub')
    assert.equal(registry.getTokenSource('reclaude').enabled, true)
    assert.equal(registry.getTokenSource('glm').enabled, true)
    assert.equal(sub.enabled, false)
    await sub.refreshModels()
    assert.equal(sub.enabled, false)
    assert.equal(sub.modelCatalogState.status, 'disabled')
    assert.match(sub.modelCatalogState.error, /ReClaude/)
    delete config.token_sources.reclaude
    buildTokenSourcesFromConfig()
    assert.equal(registry.getTokenSource('claude-sub').enabled, true)
    assert.equal(registry.getTokenSource('reclaude').enabled, false)
  `)
})
