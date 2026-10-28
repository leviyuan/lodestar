import { expect, test } from 'bun:test'

function isolated(script: string): void {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
}

test('an unobserved default warms an unstarted short window and remains selectable without I/O', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    import { EventEmitter } from 'node:events'
    import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    const dir = mkdtempSync(join(tmpdir(), 'claude-first-default-'))
    delete process.env.CLAUDE_CONFIG_DIR
    const { config } = await import('./src/config'); config.claude.env = {}
    const native = await import('./src/claude-accounts')
    const manager = new native.ClaudeAccounts({ home: dir, accountsDir: join(dir, 'accounts'), stateFile: join(dir, 'state.json'), env: {} })
    mock.module('./src/claude-accounts', () => ({ ...native, claudeAccounts: manager }))
    const shared = manager.sharedConfigDir(), sentinel = join(shared, 'projects', 'keep-default-history')
    mkdirSync(join(shared, 'projects'), { recursive: true }); writeFileSync(sentinel, 'default history stays')
    let info = {}
    const calls = { auth: 0, close: 0, models: 0, usage: 0 }
    mock.module('./src/claude-agent-process', () => ({ ClaudeAgentProcess: class extends EventEmitter {
      constructor(options) { super(); this.options = options; this.alive = true; assert.equal(options.controlOnly, true) }
      async readAccountInfo() {
        calls.auth++
        const env = this.options.transformEnv({})
        assert.equal(Object.hasOwn(env, 'CLAUDE_CONFIG_DIR'), false)
        assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '')
        this.options.validateAccount(info); return info
      }
      isAlive() { return this.alive }
      async kill() { calls.close++; this.alive = false; this.emit('exit', 0, null) }
    } }))
    const modelApi = await import('./src/token-source-models')
    mock.module('./src/token-source-models', () => ({ ...modelApi, fetchNativeClaudeModels: async options => {
      calls.models++; options.validateAccount(info)
      return [{ model: 'opus', display: 'Opus', efforts: ['high'], defaultEffort: 'high' }]
    } }))
    const usage = await import('./src/claude-usage')
    const quotaNow = Date.now()
    mock.module('./src/claude-usage', () => ({ ...usage, fetchClaudeSubscriptionUsage: async (options, binding) => {
      calls.usage++; assert.equal(binding.accountId, 'default'); options.validateAccount(info)
      return usage.claudeUsageSnapshot({ subscription_type: 'max', rate_limits_available: true, rate_limits: {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 20, resets_at: new Date(quotaNow + 24 * 3600_000).toISOString() },
      } })
    } }))
    const registry = await import('./src/token-source')
    const { enrollClaudeAccount, selectClaudeAccount } = await import('./src/claude-account-selection')
    const { cachedTokenSource, disposeCachedTokenSource } = await import('./src/token-source-cache')
    const { withModelVisibility } = await import('./src/token-source-visibility')
    const factory = registry.tokenSourceFactories().find(item => item.kind === 'claude-subscription')
    const root = cachedTokenSource(() => withModelVisibility(factory.build({}), {}), {}, 'first-default', 'same')
    registry.resetTokenSourceRegistry(); registry.registerTokenSource(root)
    try {
      assert.equal(manager.get('default').state, 'ready')
      assert.equal(manager.get('default').identity, undefined)
      await assert.rejects(enrollClaudeAccount('default'), /订阅未登录/)
      assert.deepEqual(calls, { auth: 1, close: 1, models: 0, usage: 0 })
      assert.equal(manager.get('default').identity, undefined)
      info = { email: 'first-default@example.test', organization: 'test-org', apiProvider: 'firstParty', subscriptionType: 'max' }
      assert.equal(await enrollClaudeAccount('default'), 'default')
      assert.deepEqual(calls, { auth: 2, close: 2, models: 1, usage: 1 })
      assert.ok(manager.get('default').identity)
      assert.equal(root.forAccount('default').defaultModel, 'opus')
      assert.equal(root.forAccount('default').models[0].defaultEffort, 'high')
      const snapshot = await root.forAccount('default').readUsage()
      assert.equal(snapshot.state, 'ok')
      assert.equal(snapshot.windows[0].percent, 0)
      assert.equal(snapshot.windows[0].resetsAt.getTime(), snapshot.fetchedAt + 5 * 3600_000)
      assert.equal(selectClaudeAccount({ model: 'opus', effort: 'high' }), 'default')
      const release = manager.acquireUse('default'), before = { ...calls }
      try { assert.equal(await enrollClaudeAccount('default'), 'default') } finally { release() }
      assert.deepEqual(calls, before)
      assert.equal(await root.forAccount('default').readUsage(), snapshot)
      assert.equal(readFileSync(sentinel, 'utf8'), 'default history stays')
    } finally { disposeCachedTokenSource(root); rmSync(dir, { recursive: true, force: true }) }
  `)
})

test('named-only authentication keeps one visible source, account-isolated quota and cache-only startup selection', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    const native = await import('./src/claude-accounts')
    const dir = mkdtempSync(join(tmpdir(), 'claude-selection-'))
    process.env.CLAUDE_CONFIG_DIR = join(dir, '.claude')
    const manager = new native.ClaudeAccounts({ home: dir, accountsDir: join(dir, 'accounts'), stateFile: join(dir, 'state.json'), env: {} })
    mock.module('./src/claude-accounts', () => ({ ...native, claudeAccounts: manager }))
    const info = email => ({ email, apiProvider: 'firstParty', subscriptionType: 'max' })
    const namedDir = join(manager.root, 'second')
    mkdirSync(namedDir, { recursive: true })
    const named = await manager.enroll('second', async () => info('named@example.test'))
    let defaultInfo = {}
    const percentages = { default: 10, [named.id]: 40 }
    const fablePercentages = { default: 0, [named.id]: 0 }
    const quotaNow = Date.now()
    const weeklyHours = { default: 24, [named.id]: 24 }
    let models = [
      { model: 'opus', display: 'Opus', efforts: ['high'], defaultEffort: 'high' },
      { model: 'fable', display: 'Fable', efforts: ['high'], defaultEffort: 'high' },
    ]
    const calls = { models: 0, quota: 0 }
    const modelApi = await import('./src/token-source-models')
    mock.module('./src/token-source-models', () => ({ ...modelApi, fetchNativeClaudeModels: async options => {
      calls.models++
      const env = options.transformEnv({})
      options.validateAccount(env.CLAUDE_CONFIG_DIR === namedDir ? info('named@example.test') : defaultInfo)
      return structuredClone(models)
    } }))
    const usage = await import('./src/claude-usage')
    mock.module('./src/claude-usage', () => ({ ...usage, fetchClaudeSubscriptionUsage: async (options, binding) => {
      calls.quota++
      options.validateAccount(binding.accountId === 'default' ? defaultInfo : info('named@example.test'))
      return { state: 'ok', fetchedAt: Date.now(), windows: [
        { kind: 'fiveHour', label: '5h', percent: percentages[binding.accountId], resetsAt: new Date(quotaNow + 3 * 3600_000) },
        { kind: 'weekly', label: '周', percent: percentages[binding.accountId], resetsAt: new Date(quotaNow + weeklyHours[binding.accountId] * 3600_000) },
        { kind: 'modelWeekly:Fable', label: 'Fable 周', percent: fablePercentages[binding.accountId], resetsAt: new Date(quotaNow + weeklyHours[binding.accountId] * 3600_000) },
      ] }
    } }))
    const registry = await import('./src/token-source')
    await import('./src/token-source-claude')
    const { cachedTokenSource, refreshTokenSourceUsage, disposeCachedTokenSource } = await import('./src/token-source-cache')
    const { withModelVisibility } = await import('./src/token-source-visibility')
    const { selectClaudeAccount, enrollClaudeAccount } = await import('./src/claude-account-selection')
    const factory = registry.tokenSourceFactories().find(item => item.kind === 'claude-subscription')
    const root = cachedTokenSource(() => withModelVisibility(factory.build({}), {}), {}, 'claude-test', 'one')
    try {
      registry.resetTokenSourceRegistry(); registry.registerTokenSource(root)
      await root.refreshModels(); await refreshTokenSourceUsage(root)
      assert.equal(root.enabled, true)
      assert.equal(root.defaultModel, 'opus')
      assert.equal(root.forAccount('default').enabled, false)
      assert.equal(root.forAccount(named.id).enabled, true)
      assert.equal((await root.readUsage()).state, 'not_applicable')
      assert.equal(selectClaudeAccount({ model: 'opus', effort: 'high' }), named.id)
      assert.equal(selectClaudeAccount({ model: 'opus', effort: 'high', preferred: 'default' }), 'default')
      const { readAllAccountUsage } = await import('./src/account-usage')
      const all = await readAllAccountUsage()
      assert.deepEqual(all.map(item => item.label), ['Claude·默认', 'Claude·second'])
      assert.equal(all[0].usage.state, 'no_credentials')
      assert.equal(all[1].usage.windows[0].percent, 40)
      const before = { ...calls }
      for (let i=0; i<3; i++) selectClaudeAccount({ model: 'opus', effort: 'high' })
      const release = manager.acquireUse(named.id)
      try { assert.equal(await enrollClaudeAccount('second'), named.id) } finally { release() }
      assert.deepEqual(calls, before)
      defaultInfo = info('default@example.test')
      await root.refreshModels(); await refreshTokenSourceUsage(root)
      assert.equal(selectClaudeAccount({ model: 'opus', effort: 'high' }), 'default')
      percentages.default = 90; percentages[named.id] = 20; fablePercentages[named.id] = 80
      await refreshTokenSourceUsage(root)
      const beforeFableChoice = { ...calls }
      assert.equal(selectClaudeAccount({ model: 'fable', effort: 'high' }), named.id)
      assert.deepEqual(calls, beforeFableChoice)
      percentages.default = 10; percentages[named.id] = 40; fablePercentages[named.id] = 0
      await refreshTokenSourceUsage(root)
      assert.throws(() => selectClaudeAccount({ model: 'opus', effort: 'max' }), /档位不可用/)
      assert.throws(() => selectClaudeAccount({ model: 'unknown', effort: 'high' }), /模型目录 MISS/)
      percentages[named.id] = 95; weeklyHours[named.id] = 2
      await refreshTokenSourceUsage(root)
      const beforeDeadlineChoice = { ...calls }
      assert.equal(selectClaudeAccount({ model: 'opus', effort: 'high' }), 'default')
      assert.deepEqual(calls, beforeDeadlineChoice)
      percentages[named.id] = 40; weeklyHours[named.id] = 24
      percentages.default = 40; await refreshTokenSourceUsage(root)
      assert.equal(selectClaudeAccount({ model: 'opus', effort: 'high' }), 'default')
      assert.equal(selectClaudeAccount({ model: 'opus', effort: 'high', activeSessions: new Map([['default', 5]]) }), named.id)
      assert.equal(selectClaudeAccount({ model: 'opus', effort: 'high', preferred: 'default', activeSessions: new Map([['default', 100]]) }), 'default')
      percentages.default = 99; percentages[named.id] = 99
      await refreshTokenSourceUsage(root)
      const activeSessions = new Map([['default', 0], [named.id, 0]])
      const beforeSqueezing = { ...calls }
      for (let i = 0; i < 40; i++) {
        const selected = selectClaudeAccount({ model: 'opus', effort: 'high', activeSessions })
        activeSessions.set(selected, activeSessions.get(selected) + 1)
      }
      assert.deepEqual([...activeSessions.values()], [20, 20])
      assert.deepEqual(calls, beforeSqueezing)
      percentages.default = 100; percentages[named.id] = 100
      await refreshTokenSourceUsage(root)
      assert.equal(selectClaudeAccount({ model: 'opus', effort: 'high', activeSessions }), 'default')
      percentages.default = 40; percentages[named.id] = 40
      await refreshTokenSourceUsage(root)
      const old = root.forAccount('default')
      old.validateClaudeAccount(info('relogged@example.test'))
      const newIdentity = manager.get('default').identity
      assert.throws(() => old.validateClaudeAccount(info('default@example.test')), { code: 'CLAUDE_ACCOUNT_REVISION_CHANGED' })
      assert.equal(manager.get('default').identity, newIdentity)
      const fresh = root.forAccount('default')
      assert.notEqual(old, fresh)
      assert.equal((await old.readUsage()).state, 'no_credentials')
      assert.equal(fresh.modelCatalogState.status, 'idle')
      assert.deepEqual(fresh.models, [])
      assert.equal(selectClaudeAccount({ model: 'opus', effort: 'high' }), named.id)
      defaultInfo = info('relogged@example.test')
      models = [{ model: 'fable', display: 'Fable', efforts: ['high'], defaultEffort: 'high' }]
      await root.refreshModels()
      assert.equal(root.defaultModel, '')
      assert.match(root.modelCatalogState.error, /Opus/)
      assert.throws(() => selectClaudeAccount({}), /Opus 默认模型 MISS/)
    } finally { disposeCachedTokenSource(root); rmSync(dir, { recursive: true, force: true }) }
  `)
})

test('named onboarding retains one native process and gates queries until sync and close finish', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    import { EventEmitter } from 'node:events'
    import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    const dir = mkdtempSync(join(tmpdir(), 'claude-sync-order-'))
    const native = await import('./src/claude-accounts')
    const manager = new native.ClaudeAccounts({ home: dir, accountsDir: join(dir, 'accounts'), stateFile: join(dir, 'state.json'), env: {} })
    mkdirSync(join(manager.root, 'new'), { recursive: true })
    mock.module('./src/claude-accounts', () => ({ ...native, claudeAccounts: manager }))
    const events = []
    let info = { email: 'new@example.test', organization: 'org', apiProvider: 'firstParty', subscriptionType: 'max' }
    let warmupFailure
    let process, syncDone, closeDone, syncEntered, closeEntered
    const syncing = new Promise(resolve => { syncEntered = resolve })
    const closing = new Promise(resolve => { closeEntered = resolve })
    const syncGate = new Promise(resolve => { syncDone = resolve })
    const closeGate = new Promise(resolve => { closeDone = resolve })
    mock.module('./src/claude-agent-process', () => ({ ClaudeAgentProcess: class extends EventEmitter {
      constructor(options) { super(); this.alive = true; this.options = options; process = this; events.push('spawn') }
      async readAccountInfo() { events.push('auth'); this.options.validateAccount(info); return info }
      isAlive() { return this.alive }
      async kill() { events.push('closing'); closeEntered(); await closeGate; this.alive = false; events.push('closed'); this.emit('exit', 0, null) }
    } }))
    mock.module('./src/claude-sync-warmup', () => ({
      captureClaudeSyncWarmup: () => undefined,
      waitForClaudeSyncWarmup: async options => {
        events.push('sync'); assert.equal(options.isAlive(), true)
        assert.equal(manager.candidate(options.configDir.split('/').pop()).state, 'syncing'); syncEntered(); await syncGate
        if (warmupFailure) throw warmupFailure
        assert.equal(options.isAlive(), true); events.push('synced')
      },
    }))
    const source = { modelCatalogState: { status: 'ready' }, refreshModels: async () => {
      assert.equal(manager.find('new').state, 'ready'); assert.equal(process.alive, false); events.push('models')
    } }
    const registry = await import('./src/token-source')
    mock.module('./src/token-source', () => ({ ...registry, getTokenSourceForAccount: () => source }))
    const cache = await import('./src/token-source-cache')
    mock.module('./src/token-source-cache', () => ({ ...cache, refreshTokenSourceUsage: async () => {
      assert.equal(manager.find('new').state, 'ready'); events.push('usage')
    } }))
    const { enrollClaudeAccount, selectClaudeAccount } = await import('./src/claude-account-selection')
    const phases = []
    try {
      const enrollment = enrollClaudeAccount('new', phase => { phases.push(phase) })
      await syncing
      const id = manager.find('new').id
      assert.deepEqual(events, ['spawn', 'auth', 'sync'])
      assert.deepEqual(phases, ['authenticating', 'syncing'])
      assert.deepEqual(manager.list().map(account => account.id), ['default'])
      assert.throws(() => selectClaudeAccount({ preferred: id }), /首次同步/)
      const concurrent = enrollClaudeAccount('new')
      syncDone(); await closing
      assert.equal(manager.find('new').state, 'syncing')
      assert.throws(() => manager.acquireUse(id), /尚未完成/)
      closeDone(); assert.equal(await enrollment, id); assert.equal(await concurrent, id)
      assert.deepEqual(events, ['spawn', 'auth', 'sync', 'synced', 'closing', 'closed', 'models', 'usage'])
      assert.equal(await enrollClaudeAccount('new'), id)
      assert.equal(events.length, 8)
      mkdirSync(join(manager.root, 'failed'), { recursive: true })
      info = { ...info, email: 'failed@example.test' }
      warmupFailure = new Error('首次同步未完成：synthetic timeout')
      await assert.rejects(enrollClaudeAccount('failed'), /首次同步未完成/)
      assert.equal(manager.find('failed').state, 'sync_failed')
      assert.equal(process.alive, false)
      assert.deepEqual(events.slice(8), ['spawn', 'auth', 'sync', 'closing', 'closed'])
      await assert.rejects(enrollClaudeAccount('failed'), /秒后重试 hi failed/)
      assert.equal(events.length, 13)
    } finally { syncDone(); closeDone(); rmSync(dir, { recursive: true, force: true }) }
  `)
})
