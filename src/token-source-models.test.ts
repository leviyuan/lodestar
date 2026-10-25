import { expect, test } from 'bun:test'

test('Claude model, quota and enrollment controls retain account leases until confirmed native exit', () => {
  const script = `
    import { mock, spyOn } from 'bun:test'
    import assert from 'node:assert/strict'
    import { EventEmitter } from 'node:events'
    import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    const dir = mkdtempSync(join(tmpdir(), 'claude-control-lease-'))
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'native')
    const native = await import('./src/claude-accounts')
    const manager = new native.ClaudeAccounts({ home: dir, accountsDir: join(dir, 'accounts'), stateFile: join(dir, 'state.json'), env: process.env })
    mock.module('./src/claude-accounts', () => ({ ...native, claudeAccounts: manager }))
    const info = { email: 'named@example.test', apiProvider: 'firstParty', subscriptionType: 'max' }
    let failClose = true, failConstruct = false
    const processes = []
    class FakeProcess extends EventEmitter {
      constructor(options) {
        super()
        if (failConstruct) throw new Error('construction failed')
        this.options = options; this.alive = true; processes.push(this)
        assert.equal(options.controlOnly, true)
      }
      isAlive() { return this.alive }
      finish() { this.alive = false; this.emit('exit', 0, null) }
      async kill() { if (failClose) throw new Error('native exit unconfirmed'); this.finish() }
      async readAccountInfo() { await this.options.validateAccount?.(info); return info }
      async listModels() {
        await this.options.validateAccount?.(info)
        return [{ model: 'opus', displayName: 'Opus', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }]
      }
      async readSubscriptionUsage() {
        await this.options.validateAccount?.(info)
        return { subscription_type: 'max', rate_limits_available: true, rate_limits: {
          five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 20, resets_at: null },
        } }
      }
    }
    mock.module('./src/claude-agent-process', () => ({ ClaudeAgentProcess: FakeProcess }))
    mock.module('./src/claude-sync-warmup', () => ({
      captureClaudeSyncWarmup: async () => undefined,
      waitForClaudeSyncWarmup: async options => { assert.equal(options.isAlive(), true) },
    }))
    const { fetchNativeClaudeModels } = await import('./src/token-source-models')
    const { fetchClaudeSubscriptionUsage } = await import('./src/claude-usage')
    let leases = 0
    const acquireUse = () => { leases++; let held = true; return () => { if (held) { held = false; leases-- } } }
    await assert.rejects(fetchNativeClaudeModels({ acquireUse }), /exit unconfirmed/)
    assert.equal(leases, 1); processes.at(-1).finish(); assert.equal(leases, 0)
    const quota = await fetchClaudeSubscriptionUsage({}, { accountId: 'probe-test', revision: 'one', acquireUse })
    assert.equal(quota.state, 'network'); assert.equal(leases, 1)
    processes.at(-1).finish(); assert.equal(leases, 0)
    failConstruct = true
    await assert.rejects(fetchNativeClaudeModels({ acquireUse }), /construction failed/)
    assert.equal(leases, 0); failConstruct = false
    const registry = await import('./src/token-source')
    const { enrollClaudeAccount } = await import('./src/claude-account-selection')
    const { cachedTokenSource, disposeCachedTokenSource } = await import('./src/token-source-cache')
    const { withModelVisibility } = await import('./src/token-source-visibility')
    const factory = registry.tokenSourceFactories().find(item => item.kind === 'claude-subscription')
    const root = cachedTokenSource(() => withModelVisibility(factory.build({}), {}), {}, 'lease-test', 'same')
    registry.resetTokenSourceRegistry(); registry.registerTokenSource(root)
    const named = join(manager.root, 'named'), sentinel = join(named, 'projects', 'old-history')
    mkdirSync(join(named, 'projects'), { recursive: true }); writeFileSync(sentinel, 'must survive unsuccessful enrollment')
    let clock
    try {
      await assert.rejects(enrollClaudeAccount('named'), /exit unconfirmed/)
      assert.equal(manager.list().length, 1); assert.equal(existsSync(sentinel), true)
      const count = processes.length
      await assert.rejects(enrollClaudeAccount('named'), /正在使用|收录/)
      assert.equal(processes.length, count)
      processes.at(-1).finish()
      assert.equal(manager.find('named').state, 'sync_failed')
      await assert.rejects(enrollClaudeAccount('named'), /秒后重试/)
      clock = spyOn(Date, 'now').mockReturnValue(manager.find('named').syncFailure.retryAt + 1)
      failClose = false
      const id = await enrollClaudeAccount('named')
      assert.equal(manager.get(id).state, 'ready')
      assert.equal(existsSync(sentinel), false)
      assert.equal(root.forAccount(id).modelCatalogState.status, 'ready')
      assert.equal((await root.forAccount(id).readUsage()).state, 'ok')
      assert.ok(processes.every(process => !process.isAlive()))
      const release = manager.acquireUse(id), before = processes.length
      try { assert.equal(await enrollClaudeAccount('named'), id) } finally { release() }
      assert.equal(processes.length, before)
    } finally { clock?.mockRestore(); for (const process of processes) if (process.isAlive()) process.finish(); disposeCachedTokenSource(root); rmSync(dir, { recursive: true, force: true }) }
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})

test('Codex model discovery reads every page, retries the same account and exposes invalid responses', () => {
  // Keep the fake control process and accelerated timers out of the shared test process.
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const { requestCodexControlWithRetry } = await import('./src/usage')
    const model = { id: 'catalog-model', displayName: 'Catalog model',
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }
    let scenario, calls, clients, delays
    class FakeAppServer {
      constructor(opts) { this.accountId = opts.accountId; this.closed = 0; clients.push(this) }
      async initialize(name) { assert.equal(name, 'lodestar-models') }
      async request(method, params) {
        calls.push({ accountId: this.accountId, method, params })
        const failures = method === 'account/read' ? scenario.accountFailures : scenario.modelFailures
        const failure = failures?.shift()
        if (failure === 'pending') return new Promise(() => {})
        if (failure) throw failure
        if (method === 'account/read') {
          assert.deepEqual(params, { refreshToken: false })
          return { account: scenario.signedOut ? null : { type: 'chatgpt' } }
        }
        assert.equal(method, 'model/list')
        assert.equal(params.limit, 100)
        assert.equal(params.includeHidden, false)
        assert.ok(params.cursor === null || typeof params.cursor === 'string')
        return scenario.pages?.[params.cursor ?? 'first'] ?? scenario.response ?? { data: [model], nextCursor: null }
      }
      async close() { this.closed++ }
    }
    mock.module('./src/usage', () => ({ AppServerOnce: FakeAppServer, requestCodexControlWithRetry }))
    const { codexAccounts } = await import('./src/codex-accounts')
    codexAccounts.revision = id => id
    const { fetchCodexModels } = await import('./src/token-source-models')
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (fn, delay, ...args) => {
      if (delay === 1000 || delay === 4000) delays.push(delay)
      return originalSetTimeout(fn, [1000, 4000, 10000].includes(delay) ? 0 : delay, ...args)
    }
    function reset(next = {}) { scenario = next; calls = []; clients = []; delays = [] }
    function count(method) { return calls.filter(call => call.method === method).length }
    function assertClosed() {
      assert.equal(clients.length, 1, 'retries keep the same control connection')
      assert.equal(clients[0].accountId, 'named-account')
      assert.equal(clients[0].closed, 1)
      assert.ok(calls.every(call => call.accountId === 'named-account'))
    }
    try {
      reset({ accountFailures: [new Error('ECONNRESET')],
        modelFailures: ['pending', new Error('HTTP 503')] })
      assert.deepEqual(await fetchCodexModels('named-account'), [
        { model: 'catalog-model', display: 'Catalog model', efforts: ['high'], defaultEffort: 'high' },
      ])
      assert.equal(count('account/read'), 2); assert.equal(count('model/list'), 3)
      assert.deepEqual(delays, [1000, 1000, 4000]); assertClosed()

      reset({ pages: {
        first: { data: [{ ...model, hidden: true }], nextCursor: 'second' },
        second: { data: [model], nextCursor: 'third' },
        third: { data: [{ ...model, id: 'gpt-6-astra', displayName: 'GPT-6-Astra' }], nextCursor: null },
      } })
      assert.deepEqual((await fetchCodexModels('named-account')).map(row => row.model), ['catalog-model', 'gpt-6-astra'])
      assert.deepEqual(calls.filter(call => call.method === 'model/list').map(call => call.params.cursor), [null, 'second', 'third'])
      assert.equal(count('account/read'), 1); assertClosed()

      for (const nextCursor of [undefined, 42, {}, []]) {
        reset({ pages: {
          first: { data: [model], nextCursor: 'second' },
          second: { data: [model], nextCursor },
        } })
        await assert.rejects(fetchCodexModels('named-account'), /无效 nextCursor/)
        assert.equal(count('model/list'), 2); assertClosed()
      }

      reset({ pages: {
        first: { data: [model], nextCursor: 'second' },
        second: { data: [model], nextCursor: 'third' },
        third: { data: [model], nextCursor: 'second' },
      } })
      await assert.rejects(fetchCodexModels('named-account'), /重复 nextCursor/)
      assert.equal(count('model/list'), 3); assertClosed()

      reset({ pages: {
        first: { data: [model], nextCursor: 'second' },
        second: { nextCursor: null },
      } })
      await assert.rejects(fetchCodexModels('named-account'), /缺少 data 数组/)
      assert.equal(count('model/list'), 2); assertClosed()

      reset({ modelFailures: Array.from({ length: 3 }, () => new Error('HTTP 503 model service unavailable')) })
      await assert.rejects(fetchCodexModels('named-account'), error => {
        assert.match(error.message, /模型查询失败（已尝试 3 次）.*HTTP 503 model service unavailable/)
        assert.equal(error.cause.message, 'HTTP 503 model service unavailable')
        return true
      })
      assert.equal(count('model/list'), 3); assert.deepEqual(delays, [1000, 4000]); assertClosed()

      for (const [field, expectedModels] of [['accountFailures', 0], ['modelFailures', 1]]) {
        reset({ [field]: [new Error('HTTP 401 unauthorized')] })
        await assert.rejects(fetchCodexModels('named-account'), /HTTP 401 unauthorized/)
        assert.equal(count('account/read'), 1); assert.equal(count('model/list'), expectedModels)
        assert.deepEqual(delays, []); assertClosed()
      }

      reset({ signedOut: true })
      await assert.rejects(fetchCodexModels('named-account'), error => error.code === 'CODEX_AUTH_MISSING')
      assert.equal(count('model/list'), 0); assert.deepEqual(delays, []); assertClosed()

      for (const response of [{}, { data: [], nextCursor: null }, { data: [{ ...model, hidden: true }], nextCursor: null },
        { data: [{ ...model, supportedReasoningEfforts: [] }], nextCursor: null }]) {
        reset({ response })
        await assert.rejects(fetchCodexModels('named-account'), /缺少 data 数组|未返回可用模型/)
        assert.equal(count('model/list'), 1); assert.deepEqual(delays, []); assertClosed()
      }
    } finally { globalThis.setTimeout = originalSetTimeout }
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
