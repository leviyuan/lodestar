import { expect, test } from 'bun:test'

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
