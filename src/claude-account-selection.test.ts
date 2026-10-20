import { describe, expect, test } from 'bun:test'
import { claudeAccountAvailability } from './claude-account-selection'
import type { UsageSnapshotUnified } from './token-source'

const quota = (extra: UsageSnapshotUnified['windows'] = []): UsageSnapshotUnified => ({ state: 'ok', fetchedAt: Date.now(), windows: [
  { kind: 'fiveHour', label: '5h', percent: 20, resetsAt: null },
  { kind: 'weekly', label: '周', percent: 30, resetsAt: null }, ...extra,
] })

describe('Claude startup quota eligibility', () => {
  test('requires total weekly quota even when an Opus-specific window is available', () => {
    const data = quota([{ kind: 'seven_day_opus', label: 'Opus', percent: 0, resetsAt: null }])
    data.windows[1]!.percent = 100
    expect(() => claudeAccountAvailability(data, 'claude-opus-5')).toThrow('周 已耗尽')
  })
  test.each(['fiveHour', 'weekly', 'seven_day_opus', 'seven_day_oauth_apps', 'modelWeekly:Opus 5'])(
    'each applicable %s limit can independently exclude an account', kind => {
      const data = quota().windows.filter(window => window.kind !== kind)
      data.push({ kind, label: kind, percent: 100, resetsAt: null })
      expect(() => claudeAccountAvailability({ state: 'ok', windows: data }, 'opus')).toThrow('已耗尽')
    })
  test('unrelated model limits do not exclude Opus; all its matching limits determine remaining quota', () => {
    expect(claudeAccountAvailability(quota([
      { kind: 'seven_day_sonnet', label: 'Sonnet', percent: 100, resetsAt: null },
      { kind: 'modelWeekly:Fable', label: 'Fable', percent: 100, resetsAt: null },
      { kind: 'modelWeekly:Opus', label: 'Opus', percent: 65, resetsAt: null },
    ]), 'claude-opus-5')).toBe(35)
  })
  test('cold, failed, missing and malformed quota never becomes a full window', () => {
    expect(() => claudeAccountAvailability(undefined, 'opus')).toThrow('MISS')
    expect(() => claudeAccountAvailability({ state: 'network', windows: [], reason: 'offline' }, 'opus')).toThrow('offline')
    expect(() => claudeAccountAvailability({ state: 'ok', windows: [] }, 'opus')).toThrow('MISS')
    for (const percent of [null, NaN, -1, 101]) {
      const data = quota(); data.windows[0]!.percent = percent
      expect(() => claudeAccountAvailability(data, 'opus')).toThrow('MISS')
    }
  })
})

function isolated(script: string): void {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
}

test('an unobserved default authenticates and warms on explicit selection, then reuses a verified busy account without I/O', () => {
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
    mock.module('./src/claude-usage', () => ({ ...usage, fetchClaudeSubscriptionUsage: async (options, binding) => {
      calls.usage++; assert.equal(binding.accountId, 'default'); options.validateAccount(info)
      return { state: 'ok', fetchedAt: Date.now(), windows: [
        { kind: 'fiveHour', label: '5h', percent: 10, resetsAt: null },
        { kind: 'weekly', label: '周', percent: 20, resetsAt: null },
      ] }
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
      assert.equal((await root.forAccount('default').readUsage()).state, 'ok')
      assert.equal(selectClaudeAccount({ model: 'opus', effort: 'high' }), 'default')
      const release = manager.acquireUse('default'), before = { ...calls }
      try { assert.equal(await enrollClaudeAccount('default'), 'default') } finally { release() }
      assert.deepEqual(calls, before)
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
    let models = [{ model: 'opus', display: 'Opus', efforts: ['high'], defaultEffort: 'high' }]
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
        { kind: 'fiveHour', label: '5h', percent: percentages[binding.accountId], resetsAt: null },
        { kind: 'weekly', label: '周', percent: percentages[binding.accountId], resetsAt: null },
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
      assert.throws(() => selectClaudeAccount({ model: 'opus', effort: 'max' }), /档位不可用/)
      assert.throws(() => selectClaudeAccount({ model: 'unknown', effort: 'high' }), /模型目录 MISS/)
      percentages.default = 40; await refreshTokenSourceUsage(root)
      assert.equal(selectClaudeAccount({ model: 'opus', effort: 'high' }), 'default')
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
