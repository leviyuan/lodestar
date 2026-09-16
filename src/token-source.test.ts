import { describe, expect, test } from 'bun:test'
import {
  refreshAllTokenSourceModels,
  registerTokenSource,
  resetTokenSourceRegistry,
  waitForTokenSourceModelRefresh,
  type TokenSource,
} from './token-source'
import { tokenSourceSpawnRevision } from './token-source-builtins'

function source(id: string, refresh: () => Promise<void>): TokenSource {
  return {
    id,
    kind: 'test',
    agent: 'claude',
    display: id,
    enabled: true,
    models: [],
    defaultModel: '',
    refreshModels: refresh,
    spawnEnv: env => env,
    resolveSpawnModel: model => model,
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
  }
}

describe('token source model refresh', () => {
  test('coalesces concurrent refreshes for one registry generation', async () => {
    resetTokenSourceRegistry()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    registerTokenSource(source('one', async () => { calls++; await gate }))

    const first = refreshAllTokenSourceModels()
    const second = refreshAllTokenSourceModels()
    expect(first).toBe(second)
    expect(calls).toBe(1)
    release()
    await first
  })

  test('does not reuse an in-flight refresh after registry rebuild', async () => {
    resetTokenSourceRegistry()
    let releaseOld!: () => void
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve })
    registerTokenSource(source('old', async () => { await oldGate }))
    const oldRefresh = refreshAllTokenSourceModels()

    resetTokenSourceRegistry()
    let freshCalls = 0
    registerTokenSource(source('fresh', async () => { freshCalls++ }))
    await refreshAllTokenSourceModels()
    expect(freshCalls).toBe(1)
    releaseOld()
    await oldRefresh
  })

  test('a startup waiter follows a registry rebuild without starting another refresh', async () => {
    resetTokenSourceRegistry()
    let releaseOld!: () => void
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve })
    registerTokenSource(source('old', () => oldGate))
    const oldRefresh = refreshAllTokenSourceModels()
    let ready = false
    const waiting = waitForTokenSourceModelRefresh().then(() => { ready = true })

    resetTokenSourceRegistry()
    let releaseNew!: () => void
    const newGate = new Promise<void>(resolve => { releaseNew = resolve })
    let refreshes = 0
    registerTokenSource(source('new', async () => { refreshes++; await newGate }))
    const newRefresh = refreshAllTokenSourceModels()
    try {
      releaseOld()
      await oldRefresh
      await Promise.resolve()
      expect(ready).toBe(false)
      releaseNew()
      await waiting
      expect(ready).toBe(true)
      expect(refreshes).toBe(1)
    } finally {
      releaseOld()
      releaseNew()
      await Promise.all([oldRefresh, newRefresh, waiting])
      resetTokenSourceRegistry()
    }
  })
})

describe('token source spawn revision', () => {
  test('API key changes replace model processes', () => {
    expect(tokenSourceSpawnRevision('openrouter', {
      api_key: 'key-one',
    }, null)).not.toBe(tokenSourceSpawnRevision('openrouter', {
      api_key: 'key-two',
    }, null))
  })

  test('changes for routing credentials but not catalog-only fields', () => {
    const base = tokenSourceSpawnRevision('glm-coding-plan', {
      base_url: 'https://example.test/anthropic', auth_token: 'one', models: 'A', display: 'Account A',
    }, null)
    expect(tokenSourceSpawnRevision('glm-coding-plan', {
      base_url: 'https://example.test/anthropic', auth_token: 'one', models: 'B', display: 'Renamed',
    }, null)).toBe(base)
    expect(tokenSourceSpawnRevision('glm-coding-plan', {
      base_url: 'https://example.test/anthropic', auth_token: 'two', models: 'A', display: 'Account A',
    }, null)).not.toBe(base)
  })
})
