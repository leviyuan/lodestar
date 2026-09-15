import { expect, test } from 'bun:test'

function isolated(script: string): void {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
}

test('Claude subscription coexists with other accounts and refreshes authoritative auth/catalog failures', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    const nativeModels = await import('./src/token-source-models')
    const nativeUsage = await import('./src/claude-usage')
    mock.module('./src/claude-usage', () => ({ ...nativeUsage,
      fetchClaudeSubscriptionUsage: async () => ({ state: 'ok', windows: [
        { kind: 'fiveHour', label: '5h 窗口', percent: 10, resetsAt: null },
      ] }),
    }))
    let account = { subscriptionType: 'Claude Max', apiProvider: 'firstParty' }
    let failure = null
    let models = [{ model: 'sonnet', display: 'Sonnet', efforts: ['high', 'low'], defaultEffort: 'high' }]
    mock.module('./src/token-source-models', () => ({ ...nativeModels,
      fetchNativeClaudeModels: async options => {
        options?.validateAccount?.(account)
        if (failure) throw failure
        return structuredClone(models)
      },
    }))
    const { config } = await import('./src/config')
    config.token_sources.openrouter = { api_key: 'test-key' }
    const registry = await import('./src/token-source')
    const { buildTokenSourcesFromConfig } = await import('./src/token-source-builtins')
    buildTokenSourcesFromConfig()
    const source = registry.getTokenSource('claude-sub')
    assert.equal(source.enabled, true)
    assert.equal(source.display, 'Claude Code 订阅')
    assert.equal(registry.getTokenSource('glm').enabled, true)
    assert.equal(registry.getTokenSource('openrouter').enabled, true)
    await source.refreshModels()
    assert.equal(source.modelCatalogState.status, 'ready')
    assert.equal(source.defaultModel, 'sonnet')
    assert.deepEqual(source.models[0].efforts, ['high', 'low'])
    assert.equal(source.models[0].defaultEffort, 'high')
    assert.equal((await source.readUsage()).state, 'ok')

    account = {}
    await source.refreshModels()
    assert.equal(source.enabled, false)
    assert.equal(source.modelCatalogState.status, 'disabled')
    assert.match(source.modelCatalogState.error, /claude auth login/)
    assert.deepEqual(source.models, [])
    assert.deepEqual(source.modelSelection.availableModels, [])

    account = { subscriptionType: 'Claude Max', apiProvider: 'firstParty' }
    await source.refreshModels()
    assert.equal(source.enabled, true)
    assert.equal(source.modelCatalogState.status, 'ready')
    failure = new Error('catalog connection failed')
    await source.refreshModels()
    assert.equal(source.modelCatalogState.status, 'failed')
    assert.match(source.modelCatalogState.error, /catalog connection failed/)
    assert.deepEqual(source.models, [])
    assert.deepEqual(source.modelSelection.availableModels, [])
    failure = null
    models = []
    await source.refreshModels()
    assert.equal(source.modelCatalogState.status, 'failed')
    assert.match(source.modelCatalogState.error, /目录为空/)

    // Independent subscription detection must not disable the legacy local-config route.
    config.token_sources = {}
    buildTokenSourcesFromConfig()
    assert.equal(registry.getTokenSource('claude-native').enabled, true)
  `)
})

test('Claude subscription quota uses authenticated native control, closes queries and surfaces failures', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    const updates = await import('./src/agent-updates')
    const queries = []
    let account = { subscriptionType: 'Claude Max', apiProvider: 'firstParty' }
    let data = { subscription_type: 'max', rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 12.5, resets_at: null },
      seven_day: { utilization: 20, resets_at: null },
    } }
    let readFailure = null
    let closeFailure = false
    let methodAvailable = true
    mock.module('./src/agent-updates', () => ({ ...updates,
      agentPackagePath: () => '/unused-test-sdk',
      loadClaudeSdk: async () => ({ query: ({ prompt, options }) => {
        let finish
        const closed = new Promise(resolve => { finish = resolve })
        const record = { options, delivered: [], authRequested: false, requests: [], closed: false }
        queries.push(record)
        record.inputDone = (async () => { for await (const input of prompt) record.delivered.push(input) })()
        return {
          async *[Symbol.asyncIterator]() { await closed },
          accountInfo: async () => { record.authRequested = true; return account },
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: methodAvailable ? async opts => {
            assert.equal(record.authRequested, true)
            record.requests.push(opts)
            if (readFailure) throw readFailure
            return structuredClone(data)
          } : undefined,
          close: () => { record.closed = true; finish(); if (closeFailure) throw new Error('close failed') },
        }
      } }),
    }))
    const { tokenSourceFactories } = await import('./src/token-source')
    await import('./src/token-source-claude')
    const { config } = await import('./src/config')
    config.claude.env = { ANTHROPIC_API_KEY: 'wrong-key', ANTHROPIC_BASE_URL: 'https://wrong.test' }
    const source = tokenSourceFactories().find(f => f.kind === 'claude-subscription').build({})
    const [first, concurrent] = await Promise.all([source.readUsage(), source.readUsage()])
    assert.equal(first, concurrent)
    assert.equal(queries.length, 1)
    assert.equal(first.state, 'ok')
    assert.equal(first.windows[0].percent, 12.5)
    assert.deepEqual(queries[0].requests, [{ skipBehaviors: true }])
    assert.equal(queries[0].options.env.ANTHROPIC_API_KEY, '')
    assert.equal(queries[0].options.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com')
    assert.equal(queries[0].options.settings.forceLoginMethod, 'claudeai')
    assert.deepEqual(queries[0].options.settingSources, ['user'])
    assert.equal(queries[0].closed, true)
    await queries[0].inputDone
    assert.deepEqual(queries[0].delivered, [])

    readFailure = new Error('quota transport failed')
    const failed = await source.readUsage()
    assert.equal(failed.state, 'network')
    assert.match(failed.reason, /quota transport failed/)
    assert.deepEqual(failed.windows, [])
    assert.equal(queries.at(-1).closed, true)

    closeFailure = true
    const bothFailed = await source.readUsage()
    assert.match(bothFailed.reason, /quota transport failed.*close failed/)
    readFailure = null
    const closeFailed = await source.readUsage()
    assert.equal(closeFailed.state, 'network')
    assert.match(closeFailed.reason, /close failed/)
    closeFailure = false

    methodAvailable = false
    const unsupported = await source.readUsage()
    assert.equal(unsupported.state, 'network')
    assert.match(unsupported.reason, /不支持原生订阅额度查询/)
    assert.equal(queries.at(-1).closed, true)
    methodAvailable = true

    account = {}
    const loggedOut = await source.readUsage()
    assert.equal(loggedOut.state, 'no_credentials')
    assert.match(loggedOut.reason, /claude auth login/)
    assert.deepEqual(queries.at(-1).requests, [])
    account = { subscriptionType: 'Claude Max', apiProvider: 'vertex' }
    const wrongProvider = await source.readUsage()
    assert.match(wrongProvider.reason, /不是第一方订阅/)
    assert.deepEqual(queries.at(-1).requests, [])

    account = { subscriptionType: 'Claude Max', apiProvider: 'firstParty' }
    data.rate_limits = null
    const missing = await source.readUsage()
    assert.equal(missing.state, 'network')
    assert.match(missing.reason, /未返回 rate_limits/)
    data.rate_limits = { five_hour: { utilization: 0, resets_at: null } }
    const recovered = await source.readUsage()
    assert.equal(recovered.state, 'ok')
    assert.equal(recovered.windows[0].percent, 0)
    assert.equal(recovered.windows[1].percent, null)
    for (const record of queries) {
      await record.inputDone
      assert.equal(record.closed, true)
      assert.deepEqual(record.delivered, [])
    }
  `)
})

test('Claude subscription gates queued input on native authentication for main and delegated launches', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    const updates = await import('./src/agent-updates')
    const queries = []
    let account = { subscriptionType: 'Claude Max', apiProvider: 'firstParty' }
    let releaseAuth
    let authGate = Promise.resolve()
    const tick = () => new Promise(resolve => setTimeout(resolve, 0))
    const waitFor = async predicate => {
      for (let i = 0; i < 100; i++) { if (predicate()) return; await tick() }
      throw new Error('test condition timed out')
    }
    mock.module('./src/agent-updates', () => ({ ...updates,
      agentPackagePath: () => '/unused-test-sdk',
      loadClaudeSdk: async () => ({ query: ({ prompt, options }) => {
        let finish
        const closed = new Promise(resolve => { finish = resolve })
        const record = { options, delivered: [], authRequested: false, closed: false }
        queries.push(record)
        record.inputDone = (async () => { for await (const input of prompt) record.delivered.push(input) })()
        return {
          async *[Symbol.asyncIterator]() { await closed },
          accountInfo: async () => { record.authRequested = true; await authGate; return account },
          supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['high', 'low'] }],
          close: () => { record.closed = true; finish() },
          setModel: async () => {}, applyFlagSettings: async () => {},
        }
      } }),
    }))
    const { tokenSourceFactories, registerTokenSource } = await import('./src/token-source')
    const { validateClaudeSubscriptionAccount } = await import('./src/token-source-claude')
    const { createAgentProcess } = await import('./src/agent-launch')
    const factory = tokenSourceFactories().find(f => f.kind === 'claude-subscription')
    const source = factory.build({})
    await source.refreshModels()
    assert.equal(source.modelCatalogState.status, 'ready')
    assert.equal(queries[0].delivered.length, 0)
    assert.equal(queries[0].closed, true)
    registerTokenSource(source)
    const { config } = await import('./src/config')
    config.claude.env = {
      ANTHROPIC_API_KEY: 'wrong-key', ANTHROPIC_AUTH_TOKEN: 'wrong-token',
      ANTHROPIC_BASE_URL: 'https://wrong.test', CLAUDE_CODE_OAUTH_TOKEN: 'wrong-oauth',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'wrong-model', CLAUDE_CODE_USE_VERTEX: '1',
    }
    const launch = allowDelegation => createAgentProcess({
      provider: 'claude', tokenSourceId: 'claude-sub', workDir: '/tmp', model: 'sonnet', effort: 'high',
      profile: { loadProjectMcp: false }, allowDelegation,
      hostEnv: { LODESTAR_AGENT_CAPABILITY: 'test-cap' },
    }).process
    for (const allowDelegation of [true, false]) {
      authGate = new Promise(resolve => { releaseAuth = resolve })
      const proc = launch(allowDelegation)
      proc.sendUserText('queued task')
      await waitFor(() => queries.at(-1).authRequested && !queries.at(-1).closed)
      const record = queries.at(-1)
      assert.deepEqual(record.delivered, [])
      assert.deepEqual(record.options.settingSources, ['user', 'project', 'local'])
      assert.equal(record.options.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com')
      assert.equal(record.options.env.ANTHROPIC_API_KEY, '')
      assert.equal(record.options.env.CLAUDE_CODE_OAUTH_TOKEN, '')
      assert.equal(record.options.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR)
      assert.equal(record.options.env.LODESTAR_AGENT_CAPABILITY, 'test-cap')
      assert.equal(record.options.settings.env.ANTHROPIC_AUTH_TOKEN, '')
      assert.equal(record.options.settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, '')
      assert.equal(record.options.settings.apiKeyHelper, '')
      assert.equal(record.options.settings.forceLoginMethod, 'claudeai')
      assert.equal(record.options.disallowedTools?.includes('Agent') ?? false, !allowDelegation)
      releaseAuth()
      await waitFor(() => record.delivered.length === 1)
      await proc.kill()
      await record.inputDone
      assert.equal(record.closed, true)
    }

    authGate = Promise.resolve()
    for (const rejectedAccount of [
      {},
      { subscriptionType: 'Claude Max', apiProvider: 'vertex' },
      { subscriptionType: 'Claude Max', apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper' },
    ]) {
      account = rejectedAccount
      const proc = launch(true)
      const errors = []
      proc.on('error', error => errors.push(error))
      proc.sendUserText('must never reach wrong account')
      await assert.rejects(proc.listModels(), /订阅未登录|不是第一方订阅/)
      const record = queries.at(-1)
      await record.inputDone
      assert.deepEqual(record.delivered, [])
      assert.equal(record.closed, true)
      assert.equal(proc.isAlive(), false)
      assert.ok(errors.length > 0)
    }
    assert.throws(() => validateClaudeSubscriptionAccount({ apiProvider: 'firstParty' }), /订阅未登录/)
  `)
})
