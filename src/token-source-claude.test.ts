import { expect, test } from 'bun:test'

function isolated(script: string): void {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
}

test('unfinished Claude onboarding is excluded from catalogs and cannot start model or usage queries', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
    import { join } from 'node:path'
    import { tmpdir } from 'node:os'
    const dir = mkdtempSync(join(tmpdir(), 'claude-onboarding-gate-'))
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'native')
    const { config } = await import('./src/config'); config.claude.env = {}
    const accounts = await import('./src/claude-accounts')
    const stateFile = join(dir, 'accounts.json')
    const manager = new accounts.ClaudeAccounts({ home: dir, accountsDir: join(dir, 'accounts'), stateFile, env: process.env })
    mkdirSync(join(manager.root, 'named'), { recursive: true })
    const account = await manager.enroll('named', async () => ({ email: 'named@example.test', organization: 'test',
      subscriptionType: 'max', apiProvider: 'firstParty' }))
    mock.module('./src/claude-accounts', () => ({ ...accounts, claudeAccounts: manager }))
    const modelsModule = await import('./src/token-source-models')
    const usageModule = await import('./src/claude-usage')
    let modelReads = 0, usageReads = 0
    mock.module('./src/token-source-models', () => ({ ...modelsModule, fetchNativeClaudeModels: async () => {
      modelReads++; return [{ model: 'opus', display: 'Opus', efforts: ['high'], defaultEffort: 'high' }]
    } }))
    mock.module('./src/claude-usage', () => ({ ...usageModule, fetchClaudeSubscriptionUsage: async () => {
      usageReads++; return { state: 'ok', windows: [] }
    } }))
    const { tokenSourceFactories } = await import('./src/token-source')
    await import('./src/token-source-claude')
    const root = tokenSourceFactories().find(item => item.kind === 'claude-subscription').build({})
    const retained = root.forAccount(account.id)
    try {
      for (const phase of ['authenticating', 'syncing', 'sync_failed', 'enrolling']) {
        const state = JSON.parse(readFileSync(stateFile, 'utf8'))
        state.accounts[0].state = phase
        writeFileSync(stateFile, JSON.stringify(state))
        assert.deepEqual(root.listAccounts().map(value => value.id), ['default'])
        assert.throws(() => root.forAccount(account.id), /收录|首次同步/)
        await retained.refreshModels()
        assert.equal(retained.modelCatalogState.status, 'failed')
        await assert.rejects(retained.readUsage(), /收录|首次同步/)
        assert.equal(modelReads, 0)
        assert.equal(usageReads, 0)
      }
      // Existing default-account work remains independent of named-account warm-up.
      const native = root.forAccount('default')
      await native.refreshModels()
      assert.equal(native.modelCatalogState.status, 'ready')
      assert.equal((await native.readUsage()).state, 'ok')
      assert.equal(modelReads, 1)
      assert.equal(usageReads, 1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  `)
})

test('named Claude accounts synchronize once at model startup and never during catalog, quota or ready-account checks', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    import { EventEmitter } from 'node:events'
    import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
    import { join } from 'node:path'
    import { tmpdir } from 'node:os'
    const dir = mkdtempSync(join(tmpdir(), 'claude-startup-sync-'))
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'native')
    const { config } = await import('./src/config'); config.claude.env = {}
    const accounts = await import('./src/claude-accounts')
    const manager = new accounts.ClaudeAccounts({ home: dir, accountsDir: join(dir, 'accounts'),
      stateFile: join(dir, 'accounts.json'), env: process.env })
    const info = { email: 'named@example.test', organization: 'test', subscriptionType: 'max', apiProvider: 'firstParty' }
    mkdirSync(join(manager.root, 'named'), { recursive: true })
    const account = await manager.enroll('named', async () => info)
    const target = join(account.configDir, '.claude.json')
    const before = JSON.stringify({ mcpServers: { old: { command: 'old-server' } }, theme: 'account-preference' })
    const servers = { shared: { command: 'shared-server' } }
    writeFileSync(join(manager.sharedConfigDir(), '.claude.json'), JSON.stringify({ mcpServers: servers, theme: 'global-preference' }))
    writeFileSync(target, before)
    const beforeStat = statSync(target)
    const preparations = [], prepareShared = manager.prepareShared.bind(manager)
    manager.prepareShared = id => { preparations.push(id); return prepareShared(id) }
    mock.module('./src/claude-accounts', () => ({ ...accounts, claudeAccounts: manager }))
    class FakeProcess extends EventEmitter {
      constructor(options) {
        super(); this.options = options; this.alive = true
        assert.equal(options.prepare, undefined)
        options.transformEnv?.({})
      }
      isAlive() { return this.alive }
      async kill() { this.alive = false; this.emit('exit', { code: 0, signal: null, expected: true }) }
      async listModels() {
        await this.options.validateAccount?.(info)
        return [{ model: 'opus', displayName: 'Opus',
          supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }]
      }
      async readSubscriptionUsage() {
        await this.options.validateAccount?.(info)
        return { subscription_type: 'max', rate_limits_available: true, rate_limits: {
          five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 20, resets_at: null },
        } }
      }
    }
    mock.module('./src/claude-agent-process', () => ({ ClaudeAgentProcess: FakeProcess, assertClaudeCodeAvailable() {} }))
    const registry = await import('./src/token-source')
    await import('./src/token-source-claude')
    const { createAgentProcess } = await import('./src/agent-launch')
    const { enrollClaudeAccount } = await import('./src/claude-account-selection')
    const root = registry.tokenSourceFactories().find(item => item.kind === 'claude-subscription').build({})
    registry.resetTokenSourceRegistry(); registry.registerTokenSource(root)
    const source = root.forAccount(account.id)
    try {
      await source.refreshModels()
      assert.equal(source.modelCatalogState.status, 'ready')
      assert.equal((await source.readUsage()).state, 'ok')
      assert.equal(await enrollClaudeAccount('named'), account.id)
      assert.deepEqual(preparations, [])
      assert.equal(readFileSync(target, 'utf8'), before)
      assert.equal(statSync(target).mtimeMs, beforeStat.mtimeMs)
      assert.equal(statSync(target).ino, beforeStat.ino)
      const created = createAgentProcess({ provider: 'claude', tokenSourceId: 'claude-sub', claudeAccountId: account.id,
        workDir: dir, model: 'opus', effort: 'high' })
      try {
        assert.deepEqual(preparations, [account.id])
        assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { mcpServers: servers, theme: 'account-preference' })
        source.spawnEnv({})
        assert.deepEqual(preparations, [account.id])
      } finally { await created.process.kill() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  `)
})

test('native default settings cannot redirect config or keychain before the SDK query is created', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
    import { join } from 'node:path'
    import { tmpdir } from 'node:os'
    const dir = mkdtempSync(join(tmpdir(), 'claude-default-settings-'))
    delete process.env.CLAUDE_CONFIG_DIR
    const { config } = await import('./src/config'); config.claude.env = {}
    const accounts = await import('./src/claude-accounts')
    const manager = new accounts.ClaudeAccounts({ home: dir, stateFile: join(dir, 'accounts.json'), env: {} })
    mock.module('./src/claude-accounts', () => ({ ...accounts, claudeAccounts: manager }))
    const updates = await import('./src/agent-updates')
    let queries = 0
    mock.module('./src/agent-updates', () => ({ ...updates, agentPackagePath: () => '/unused-test-sdk',
      loadClaudeSdk: async () => ({ query: () => { queries++; throw new Error('query should not be reached') } }) }))
    const { tokenSourceFactories } = await import('./src/token-source')
    const { assertClaudeDefaultSettingsEnvironment } = await import('./src/token-source-claude')
    const root = manager.sharedConfigDir(); mkdirSync(root, { recursive: true })
    const path = join(root, 'settings.json')
    try {
      assertClaudeDefaultSettingsEnvironment(root)
      for (const value of ['/different/config', '', null]) {
        writeFileSync(path, JSON.stringify({ env: { CLAUDE_CONFIG_DIR: value, ANTHROPIC_API_KEY: 'must-not-leak' } }))
        const source = tokenSourceFactories().find(factory => factory.kind === 'claude-subscription').build({}).forAccount('default')
        await source.refreshModels()
        assert.equal(queries, 0)
        assert.equal(source.modelCatalogState.status, 'failed')
        assert.match(source.modelCatalogState.error, /重定向/)
        assert.doesNotMatch(source.modelCatalogState.error, /must-not-leak|different/)
      }
      writeFileSync(path, JSON.stringify({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/other' } }))
      assert.throws(() => assertClaudeDefaultSettingsEnvironment(root), /存储冲突/)
      writeFileSync(path, '{bad JSON must-not-leak')
      assert.throws(() => assertClaudeDefaultSettingsEnvironment(root), error => /格式无效/.test(error.message) && !error.message.includes('must-not-leak'))
      writeFileSync(path, JSON.stringify({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '', OTHER: 'preserved' } }))
      assertClaudeDefaultSettingsEnvironment(root)
      assert.equal(queries, 0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  `)
})

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
    let account = { email: 'default@example.test', subscriptionType: 'Claude Max', apiProvider: 'firstParty' }
    let failure = null
    let models = [{ model: 'opus', display: 'Opus', efforts: ['high', 'low'], defaultEffort: 'high' }]
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
    assert.equal(source.defaultModel, 'opus')
    assert.deepEqual(source.models[0].efforts, ['high', 'low'])
    assert.equal(source.models[0].defaultEffort, 'high')
    await (await import('./src/token-source-cache')).refreshTokenSourceUsage(source)
    assert.equal((await source.forAccount('default').readUsage()).state, 'ok')
    assert.equal((await source.readUsage()).state, 'not_applicable')

    account = {}
    await source.refreshModels()
    assert.equal(source.enabled, false)
    assert.equal(source.modelCatalogState.status, 'disabled')
    assert.match(source.modelCatalogState.error, /claude auth login/)
    assert.deepEqual(source.models, [])
    assert.deepEqual(source.modelSelection.availableModels, [])

    account = { email: 'default@example.test', subscriptionType: 'Claude Max', apiProvider: 'firstParty' }
    await source.refreshModels()
    assert.equal(source.enabled, true)
    assert.equal(source.modelCatalogState.status, 'ready')
    failure = new Error('catalog connection failed')
    await assert.rejects(source.refreshModels(), /catalog connection failed/)
    assert.equal(source.modelCatalogState.status, 'ready')
    assert.match(source.modelCatalogState.error, /catalog connection failed/)
    assert.ok(source.models.length > 0)
    assert.ok(source.modelSelection.availableModels.length > 0)
    failure = null
    models = []
    await assert.rejects(source.refreshModels(), /目录为空/)
    assert.equal(source.modelCatalogState.status, 'ready')
    assert.match(source.modelCatalogState.error, /目录为空/)

    // The retired local-config source is not registered, even with an old enabled flag.
    config.token_sources = {}
    buildTokenSourcesFromConfig()
    assert.equal(registry.getTokenSource('claude-native'), undefined)
    config.token_sources['claude-native'] = { enabled: true }
    buildTokenSourcesFromConfig()
    assert.equal(registry.getTokenSource('claude-native'), undefined)
  `)
})

test('Claude subscription remains excluded from Lodestar Agent when explicitly enabled', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    let modelQueries = 0
    let usageQueries = 0
    const nativeModels = await import('./src/token-source-models')
    const nativeUsage = await import('./src/claude-usage')
    mock.module('./src/token-source-models', () => ({ ...nativeModels,
      fetchNativeClaudeModels: async () => {
        modelQueries++
        return [{ model: 'sonnet', display: 'Sonnet', efforts: ['high'], defaultEffort: 'high' }]
      },
    }))
    mock.module('./src/claude-usage', () => ({ ...nativeUsage,
      fetchClaudeSubscriptionUsage: async () => { usageQueries++; return { state: 'ok', windows: [] } },
    }))
    const { config } = await import('./src/config')
    const registry = await import('./src/token-source')
    const { buildTokenSourcesFromConfig } = await import('./src/token-source-builtins')
    const { buildAgentSkillIdentityCatalog } = await import('./src/agent-identities')
    const { createAgentProcess } = await import('./src/agent-launch')
    config.token_sources['claude-sub'] = { enabled: false, custom_models: 'manual-model' }
    for (let rebuild = 0; rebuild < 2; rebuild++) {
      buildTokenSourcesFromConfig()
      const source = registry.getTokenSource('claude-sub')
      assert.equal(source.enabled, false)
      await source.refreshModels()
      await source.refreshModels()
      assert.equal(source.modelCatalogState.status, 'disabled')
      assert.match(source.modelCatalogState.error, /claude-sub on/)
      assert.deepEqual(source.models, [])
      assert.deepEqual(source.modelSelection.availableModels, [])
      assert.notEqual((await source.readUsage()).state, 'ok')
      const catalog = await buildAgentSkillIdentityCatalog([source])
      assert.deepEqual(catalog.identities, [])
      assert.deepEqual(catalog.sourceFailures, [])
      assert.throws(() => createAgentProcess({ provider: 'claude', workDir: '/tmp', tokenSourceId: source.id,
        model: 'sonnet', effort: 'high' }), /Claude 订阅已禁用/)
    }
    assert.equal(modelQueries, 0)
    assert.equal(usageQueries, 0)
    config.token_sources['claude-sub'].enabled = true
    buildTokenSourcesFromConfig()
    const enabled = registry.getTokenSource('claude-sub')
    await enabled.refreshModels()
    assert.equal(enabled.enabled, true)
    assert.equal(enabled.modelCatalogState.status, 'ready')
    await (await import('./src/token-source-cache')).refreshTokenSourceUsage(enabled)
    assert.equal((await buildAgentSkillIdentityCatalog([enabled])).identities.length, 0)
    assert.equal(enabled.models.length, 2)
    assert.equal(enabled.enabled, true)
    assert.equal(modelQueries, 1)
    assert.equal(usageQueries, 1)
  `)
})

test('Claude subscription quota uses authenticated native control and keeps the last data through transient failures', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    const updates = await import('./src/agent-updates')
    let quotaNow = Date.now()
    Date.now = () => quotaNow
    const queries = []
    let account = { email: 'default@example.test', subscriptionType: 'Claude Max', apiProvider: 'firstParty' }
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
    const { claudeAccounts } = await import('./src/claude-accounts')
    claudeAccounts.observeIdentity('default', account)
    const source = tokenSourceFactories().find(f => f.kind === 'claude-subscription').build({}).forAccount('default')
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

    assert.equal(await source.readUsage(), first)
    assert.equal(queries.length, 1)
    readFailure = new Error('quota transport failed')
    quotaNow += 300_000
    const failed = await source.readUsage()
    assert.equal(failed.state, 'ok')
    assert.equal(failed.windows[0].percent, 12.5)
    assert.equal(queries.at(-1).closed, true)

    closeFailure = true
    quotaNow += 300_000
    const bothFailed = await source.readUsage()
    assert.equal(bothFailed.state, 'ok')
    assert.equal(bothFailed.windows[0].percent, 12.5)
    readFailure = null
    quotaNow += 300_000
    const closeFailed = await source.readUsage()
    assert.equal(closeFailed.state, 'ok')
    assert.equal(closeFailed.windows[0].percent, 12.5)
    closeFailure = false

    methodAvailable = false
    quotaNow += 300_000
    const unsupported = await source.readUsage()
    assert.equal(unsupported.state, 'ok')
    assert.equal(unsupported.windows[0].percent, 12.5)
    assert.equal(queries.at(-1).closed, true)
    methodAvailable = true

    account = {}
    quotaNow += 300_000
    const loggedOut = await source.readUsage()
    assert.equal(loggedOut.state, 'no_credentials')
    assert.match(loggedOut.reason, /claude auth login/)
    assert.deepEqual(queries.at(-1).requests, [])
    account = { subscriptionType: 'Claude Max', apiProvider: 'vertex' }
    quotaNow += 300_000
    const wrongProvider = await source.readUsage()
    assert.equal(wrongProvider.state, 'network')
    assert.match(wrongProvider.reason, /不是第一方订阅/)
    assert.deepEqual(queries.at(-1).requests, [])

    account = { email: 'default@example.test', subscriptionType: 'Claude Max', apiProvider: 'firstParty' }
    data.rate_limits = null
    quotaNow += 300_000
    const missing = await source.readUsage()
    assert.equal(missing.state, 'network')
    assert.match(missing.reason, /未返回 rate_limits/)
    data.rate_limits = { five_hour: { utilization: 0, resets_at: null } }
    quotaNow += 300_000
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
    const translations = []
    mock.module('./src/claude-translation', () => ({ createClaudeTranslation: () => ({
      toEnglish: async (text, _signal, kind) => { translations.push({ text, kind }); return 'Translated: ' + text },
      toChinese: async text => text,
      toChineseFields: async fields => fields,
    }) }))
    const queries = []
    let account = { email: 'default@example.test', subscriptionType: 'Claude Max', apiProvider: 'firstParty' }
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
    const { claudeAccounts } = await import('./src/claude-accounts')
    claudeAccounts.observeIdentity('default', account)
    const root = factory.build({})
    const source = root.forAccount('default')
    await source.refreshModels()
    assert.equal(source.modelCatalogState.status, 'ready')
    assert.equal(queries[0].delivered.length, 0)
    assert.equal(queries[0].closed, true)
    assert.deepEqual(translations, [])
    registerTokenSource(root)
    const { config } = await import('./src/config')
    config.claude.safe_mode = { 'claude-sub': ['*'] }
    config.claude.env = {
      ANTHROPIC_API_KEY: 'wrong-key', ANTHROPIC_AUTH_TOKEN: 'wrong-token',
      ANTHROPIC_BASE_URL: 'https://wrong.test', CLAUDE_CODE_OAUTH_TOKEN: 'wrong-oauth',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'wrong-model', CLAUDE_CODE_USE_VERTEX: '1',
    }
    const launch = role => createAgentProcess({
      provider: 'claude', tokenSourceId: 'claude-sub', workDir: '/tmp', model: 'sonnet', effort: 'high',
      profile: { loadProjectMcp: false },
      hostEnv: { LODESTAR_AGENT_CAPABILITY: 'test-cap', LODESTAR_AGENT_ROLE: role },
    }).process
    for (const role of ['main', 'worker']) {
      authGate = new Promise(resolve => { releaseAuth = resolve })
      const proc = launch(role)
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
      assert.equal(record.options.disallowedTools?.includes('Agent') ?? false, false)
      releaseAuth()
      await waitFor(() => record.delivered.length === 1)
      assert.equal(record.delivered[0].message.content[0].text, 'Translated: queued task')
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
