import { describe, expect, test } from 'bun:test'
import { cachedTokenSource, disposeCachedTokenSource, refreshTokenSourceUsage, peekTokenSourceUsage } from './token-source-cache'
import type { TokenSource, UsageSnapshotUnified } from './token-source'
import { withModelVisibility } from './token-source-visibility'
import type { TokenSourceConfig } from './config'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function fixture() {
  const state = { models: ['a', 'b'], calls: 0, usageCalls: 0, barrier: Promise.resolve(), usageBarrier: Promise.resolve(), error: '',
    usage: { state: 'ok', windows: [], kind: 'balance', balance: { remaining: 7, currency: 'USD' } } as UsageSnapshotUnified }
  const create = (cfg: TokenSourceConfig = {}): TokenSource => {
    const raw: TokenSource = {
      id: 'cache-test', kind: 'test', agent: 'claude', display: 'Test', enabled: true,
      models: [], defaultModel: '', modelCatalogState: { status: 'idle', updatedAt: null },
      async refreshModels() {
        state.calls++
        raw.models = []; raw.modelCatalogState = { status: 'loading', updatedAt: null }
        await state.barrier
        if (state.error) {
          raw.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: state.error }
          throw new Error(state.error)
        }
        raw.models = state.models.map(model => ({ model, display: model, efforts: ['high'], defaultEffort: 'high' }))
        raw.defaultModel = state.models[0]!
        raw.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
      },
      readUsage: async () => { state.usageCalls++; await state.usageBarrier; return state.usage },
      spawnEnv: env => ({ ...env, CACHED_MODELS: raw.models.map(model => model.model).join(',') }),
      resolveSpawnModel: model => model,
    }
    return withModelVisibility(raw, cfg)
  }
  return { state, create }
}

describe('Token Source cache boundary', () => {
  test('Codex background reads and retries stay throttled while other sources retain their cadence', () => {
    const script = `
      import assert from 'node:assert/strict'
      import { cachedTokenSource, disposeCachedTokenSource, refreshTokenSourceUsage } from './src/token-source-cache'
      import { startBackgroundRefresh, stopBackgroundRefresh } from './src/background-refresh'
      let now = 0
      const timers = new Map()
      Date.now = () => now
      globalThis.setTimeout = (fn, delay) => {
        const handle = { unref() {} }
        timers.set(handle, { fn, at: now + delay })
        return handle
      }
      globalThis.clearTimeout = handle => timers.delete(handle)
      const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
      const advance = async milliseconds => {
        assert.ok(milliseconds >= 0, 'virtual time must not move backwards')
        const target = now + milliseconds
        for (;;) {
          const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
            .sort((a, b) => a[1].at - b[1].at)[0]
          if (!next) break
          now = next[1].at
          timers.delete(next[0]); next[1].fn(); await flush()
        }
        now = target
      }
      const scenario = async (kind, usageInterval, modelInterval, retryDelays) => {
        now = 0
        const state = { usage: 0, models: 0, usageError: undefined, modelError: undefined }
        const create = () => {
          const raw = {
            id: kind, kind, agent: kind === 'codex-subscription' ? 'codex' : 'claude',
            display: 'Test', enabled: true, models: [], defaultModel: '',
            accountRevision: () => 'stable', modelCatalogState: { status: 'idle', updatedAt: null },
            spawnEnv: env => env, resolveSpawnModel: model => model,
            async refreshModels() {
              state.models++
              if (state.modelError) throw state.modelError
              raw.models = [{ model: 'test-model', display: 'Test', efforts: ['high'], defaultEffort: 'high' }]
              raw.modelCatalogState = { status: 'ready', updatedAt: now }
            },
            async readUsage() {
              state.usage++
              if (state.usageError) throw state.usageError
              return { state: 'ok', windows: [] }
            },
          }
          return raw
        }
        const source = cachedTokenSource(create, {}, kind, 'same-settings')
        try {
          await source.readUsage()
          assert.equal(state.usage, 0)
          // Startup warms both resources immediately, before timers are enabled.
          await source.refreshModels(); await refreshTokenSourceUsage(source)
          assert.equal(now, 0)
          assert.deepEqual([state.usage, state.models], [1, 1])
          startBackgroundRefresh()
          await advance(usageInterval - 1)
          await source.readUsage(); await source.readUsage()
          assert.deepEqual([state.usage, state.models], [1, 1])
          await advance(1)
          assert.deepEqual([state.usage, state.models], [2, modelInterval === usageInterval ? 2 : 1])
          if (modelInterval > usageInterval) {
            await advance(modelInterval - now - 1)
            assert.equal(state.models, 1)
            await advance(1)
          }
          assert.equal(state.models, 2)
          assert.equal(state.usage, 1 + modelInterval / usageInterval)

          for (const [counter, errorKey, refresh, interval] of [
            ['usage', 'usageError', () => refreshTokenSourceUsage(source), usageInterval],
            ['models', 'modelError', () => source.refreshModels(), modelInterval],
          ]) {
            state[errorKey] = new Error('HTTP 503 unavailable')
            await assert.rejects(refresh(), /HTTP 503/)
            const delays = kind === 'codex-subscription' ? [interval, interval] : retryDelays
            for (const delay of delays) {
              const before = state[counter]
              await advance(delay - 1)
              await source.readUsage()
              assert.equal(state[counter], before)
              await advance(1)
              assert.equal(state[counter], before + 1)
            }
            const longerRetry = Math.max(interval * 2, 600000)
            state[errorKey].retryAfterMs = longerRetry
            await assert.rejects(refresh(), /HTTP 503/)
            const before = state[counter]
            await advance(longerRetry - 1)
            assert.equal(state[counter], before)
            await advance(1)
            assert.equal(state[counter], before + 1)
            state[errorKey] = undefined
            await refresh()
          }
        } finally {
          stopBackgroundRefresh(); disposeCachedTokenSource(source)
          assert.equal(timers.size, 0)
        }
      }
      await scenario('codex-subscription', 7200000, 7200000, [])
      await scenario('other-source', 60000, 300000, [60000, 120000, 240000, 300000])
    `
    const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
      cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
  })

  test('account catalogs and quota are fenced by each account revision, including a late default-account refresh', async () => {
    const revisions: Record<string, string> = { default: 'old', named: 'stable' }
    let barrier = Promise.resolve()
    const make = (id: string): TokenSource => {
      const bound = revisions[id]!
      const source: TokenSource = {
        id: 'account-cache-test', kind: 'claude-subscription', agent: 'claude', accountId: id,
        accountRevision: account => revisions[account]!, display: id, enabled: true,
        defaultModel: 'opus', models: [], modelCatalogState: { status: 'idle', updatedAt: null },
        spawnEnv: env => env, resolveSpawnModel: model => model,
        async refreshModels() {
          await barrier
          source.models = [{ model: bound, display: bound, efforts: ['high'], defaultEffort: 'high' }]
          source.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
        },
        async readUsage() { await barrier; return { state: 'ok', windows: [{ kind: 'weekly', label: id,
          percent: bound === 'old' ? 10 : 50, resetsAt: null }] } },
      }
      return source
    }
    const create = (): TokenSource => ({ ...make('default'), accountId: undefined, aggregateAccountCatalog: true,
      listAccounts: () => Object.keys(revisions).map(id => ({ id, name: id })), forAccount: make })
    const root = cachedTokenSource(create, {}, 'account-cache', 'same')
    const old = root.forAccount!('default'), named = root.forAccount!('named')
    const blocked = gate()
    try {
      await root.refreshModels(); await refreshTokenSourceUsage(root)
      expect(peekTokenSourceUsage(old)?.windows[0]?.percent).toBe(10)
      barrier = blocked.promise
      const pendingModels = old.refreshModels(), pendingQuota = refreshTokenSourceUsage(old)
      await Promise.resolve(); await Promise.resolve()
      revisions.default = 'new'
      const fresh = root.forAccount!('default')
      expect(fresh).not.toBe(old)
      expect(root.forAccount!('named')).toBe(named)
      expect(peekTokenSourceUsage(old)?.state).toBe('no_credentials')
      expect(fresh.models).toEqual([])
      blocked.release(); await Promise.all([pendingModels, pendingQuota])
      expect(fresh.models).toEqual([])
      expect(peekTokenSourceUsage(fresh)).toBeUndefined()
      barrier = Promise.resolve()
      await fresh.refreshModels(); await refreshTokenSourceUsage(fresh)
      expect(fresh.models[0]?.model).toBe('new')
      expect(peekTokenSourceUsage(fresh)?.windows[0]?.percent).toBe(50)
      expect((await root.readUsage()).state).toBe('not_applicable')
    } finally { blocked.release(); disposeCachedTokenSource(root) }
  })

  test('slow model and quota refreshes never clear or block the committed snapshot', async () => {
    const { create, state } = fixture()
    const source = cachedTokenSource(create, {}, 'slow', 'slow')
    const models = gate(), usage = gate()
    try {
      await source.refreshModels()
      await refreshTokenSourceUsage(source)
      state.barrier = models.promise; state.usageBarrier = usage.promise; state.models = ['new']
      const pending = source.refreshModels(), pendingUsage = refreshTokenSourceUsage(source)
      await Promise.resolve(); await Promise.resolve()
      expect(source.models.map(model => model.model)).toEqual(['a', 'b'])
      expect(source.modelCatalogState?.status).toBe('ready')
      expect(source.spawnEnv({}).CACHED_MODELS).toBe('a,b')
      expect((await source.readUsage()).balance?.remaining).toBe(7)
      expect(source.refreshModels()).toBe(pending)
      models.release(); usage.release()
      await Promise.all([pending, pendingUsage])
      expect(source.models.map(model => model.model)).toEqual(['new'])
      expect(source.spawnEnv({}).CACHED_MODELS).toBe('new')
      expect(state.calls).toBe(2)
    } finally { models.release(); usage.release(); disposeCachedTokenSource(source) }
  })

  test('a cold interactive read returns MISS without starting I/O', async () => {
    const { create, state } = fixture()
    const source = cachedTokenSource(create, {}, 'cold', 'cold')
    try {
      expect((await source.readUsage()).state).toBe('network')
      expect(state.calls).toBe(0)
      expect(state.usageCalls).toBe(0)
      expect(source.modelCatalogState?.status).toBe('idle')
    } finally { disposeCachedTokenSource(source) }
  })

  test('visibility and custom edits reproject cache immediately and credentials never inherit it', async () => {
    const { create, state } = fixture()
    const original = cachedTokenSource(create, {}, 'account-a', 'one')
    let edited: TokenSource | undefined, changed: TokenSource | undefined
    try {
      await original.refreshModels()
      const cfg = { hidden_models: 'a', custom_models: 'manual' }
      edited = cachedTokenSource(() => create(cfg), cfg, 'account-a', 'two', original)
      expect(state.calls).toBe(1)
      expect(edited.models.map(model => model.model)).toEqual(['b', 'manual'])
      expect(edited.modelSelection?.availableModels.map(model => model.model)).toEqual(['a', 'b', 'manual'])
      expect(edited.spawnEnv({}).CACHED_MODELS).toBe('b,manual')
      changed = cachedTokenSource(create, {}, 'account-b', 'three', edited)
      expect(changed.models).toEqual([])
      expect((await changed.readUsage()).state).toBe('network')
    } finally {
      for (const source of [original, edited, changed]) if (source) disposeCachedTokenSource(source)
    }
  })

  test('transient refresh failures preserve a successful cache with diagnostics; auth failures clear it', async () => {
    const { create, state } = fixture()
    const source = cachedTokenSource(create, {}, 'errors', 'errors')
    try {
      await source.refreshModels()
      await refreshTokenSourceUsage(source)
      state.error = 'HTTP 503 unavailable'
      await expect(source.refreshModels()).rejects.toThrow('HTTP 503')
      expect(source.models).toHaveLength(2)
      expect(source.modelCatalogState).toMatchObject({ status: 'ready', error: state.error })
      state.usage = { state: 'network', windows: [], reason: 'HTTP 503' }
      await expect(refreshTokenSourceUsage(source)).rejects.toThrow('HTTP 503')
      expect((await source.readUsage()).state).toBe('ok')
      state.error = 'HTTP 401 unauthorized'
      await expect(source.refreshModels()).rejects.toThrow('HTTP 401')
      expect(source.models).toEqual([])
      expect(source.modelCatalogState?.status).toBe('failed')
      state.usage = { state: 'no_credentials', windows: [] }
      await refreshTokenSourceUsage(source)
      expect((await source.readUsage()).state).toBe('no_credentials')
    } finally { disposeCachedTokenSource(source) }
  })

  test('an in-flight refresh is shared across visibility changes and cannot overwrite the new choices', async () => {
    const { create, state } = fixture()
    const original = cachedTokenSource(create, {}, 'shared-edit', 'before')
    const barrier = gate()
    let edited: TokenSource | undefined
    try {
      await original.refreshModels()
      state.barrier = barrier.promise
      const first = original.refreshModels()
      await Promise.resolve(); await Promise.resolve()
      const cfg = { hidden_models: 'a', custom_models: 'manual' }
      edited = cachedTokenSource(() => create(cfg), cfg, 'shared-edit', 'after', original)
      const second = edited.refreshModels()
      disposeCachedTokenSource(original)
      await Promise.resolve(); await Promise.resolve()
      expect(state.calls).toBe(2)
      expect(edited.models.map(model => model.model)).toEqual(['b', 'manual'])
      barrier.release()
      await Promise.all([first, second])
      expect(state.calls).toBe(2)
      expect(edited.models.map(model => model.model)).toEqual(['b', 'manual'])
    } finally { barrier.release(); disposeCachedTokenSource(original); if (edited) disposeCachedTokenSource(edited) }
  })

  test.each(['token expired', 'Claude Code 当前认证不是第一方订阅'])('authentication loss invalidates model and usage caches: %s', async reason => {
    const { create, state } = fixture()
    const source = cachedTokenSource(create, {}, `auth-${reason}`, 'original')
    try {
      await source.refreshModels()
      await refreshTokenSourceUsage(source)
      state.usage = { state: 'network', windows: [], reason }
      await expect(refreshTokenSourceUsage(source)).rejects.toThrow(reason)
      expect((await source.readUsage()).state).not.toBe('ok')
      state.error = reason
      await expect(source.refreshModels()).rejects.toThrow(reason)
      expect(source.models).toEqual([])
      expect(source.modelCatalogState?.status).toBe('failed')
      expect((await source.readUsage()).state).toBe('no_credentials')
    } finally { disposeCachedTokenSource(source) }
  })

  test('a model loader that only throws an auth error clears cached usage and retains its diagnostic', async () => {
    const { create } = fixture()
    let failure: Error | undefined
    const source = cachedTokenSource(() => {
      const raw = create()
      const refresh = raw.refreshModels
      raw.refreshModels = async () => { if (failure) throw failure; await refresh() }
      return raw
    }, {}, 'throw-only-auth', 'same-settings')
    try {
      await source.refreshModels()
      await refreshTokenSourceUsage(source)
      failure = new Error('token expired')
      await expect(source.refreshModels()).rejects.toBe(failure)
      expect(source.models).toEqual([])
      expect(source.modelCatalogState).toMatchObject({ status: 'failed', error: 'token expired' })
      expect(await source.readUsage()).toMatchObject({ state: 'no_credentials', reason: 'token expired' })
    } finally { disposeCachedTokenSource(source) }
  })

  test('a retired credential refresh cannot populate its replacement', async () => {
    const { create, state } = fixture()
    const barrier = gate()
    const original = cachedTokenSource(create, {}, 'old-credential', 'old')
    let replacement: TokenSource | undefined
    try {
      state.barrier = barrier.promise
      const pending = original.refreshModels()
      await Promise.resolve(); await Promise.resolve()
      replacement = cachedTokenSource(create, {}, 'new-credential', 'new', original)
      disposeCachedTokenSource(original)
      barrier.release(); await pending
      expect(original.models).toEqual([])
      expect(replacement.models).toEqual([])
      expect(replacement.modelCatalogState?.status).toBe('idle')
    } finally { barrier.release(); disposeCachedTokenSource(original); if (replacement) disposeCachedTokenSource(replacement) }
  })
})
