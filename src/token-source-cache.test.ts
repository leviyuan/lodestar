import { describe, expect, test } from 'bun:test'
import { cachedTokenSource, disposeCachedTokenSource, refreshTokenSourceUsage } from './token-source-cache'
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
