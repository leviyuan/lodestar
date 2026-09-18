import { describe, expect, test } from 'bun:test'
import { UsageReadCache, usageCredentialKey, usageRetryAfter, isUsageRateLimitError } from './usage-cache'

describe('shared quota freshness and cooldown', () => {
  test('coalesces concurrent callers, reuses a successful minute and refreshes at its boundary', async () => {
    let now = 0, calls = 0
    const cache = new UsageReadCache<{ state: string; value: number }>(() => now)
    const read = async () => ({ state: 'ok', value: ++calls })
    const first = cache.read('account', read)
    expect(cache.read('account', read)).toBe(first)
    const value = await first
    now = 59_999
    expect(await cache.read('account', read)).toBe(value)
    expect(calls).toBe(1)
    now = 60_000
    expect((await cache.read('account', read)).value).toBe(2)
    expect((await cache.read('other-account', read)).value).toBe(3)
  })

  test('failures replace expired data and back off for 1, 2, 4, then 5 minutes', async () => {
    let now = 0, calls = 0, state = 'ok'
    const cache = new UsageReadCache<{ state: string }>(() => now)
    const read = async () => { calls++; return { state } }
    await cache.read('account', read)
    now += 60_000
    state = 'rate_limited'
    for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      expect((await cache.read('account', read)).state).toBe('rate_limited')
      const before = calls
      now += delay - 1
      expect((await cache.read('account', read)).state).toBe('rate_limited')
      expect(calls).toBe(before)
      now++
    }
    state = 'ok'
    expect((await cache.read('account', read)).state).toBe('ok')
    now += 60_000
    state = 'network'
    await cache.read('account', read)
    const before = calls
    now += 60_000
    await cache.read('account', read)
    expect(calls).toBe(before + 1)
  })

  test('readStale keeps the last successful value through transient failures and clears it on credential loss', async () => {
    let now = 0, state = 'ok', calls = 0
    const cache = new UsageReadCache<{ state: string; value?: number }>(() => now)
    const read = async () => ({ state, ...(state === 'ok' ? { value: ++calls } : {}) })
    const first = await cache.readStale('account', read)
    now = 60_000
    state = 'network'
    expect(await cache.readStale('account', read)).toBe(first)
    expect(cache.peekSuccessful('account')).toBe(first)
    now = 120_000
    state = 'rate_limited'
    expect(await cache.readStale('account', read)).toBe(first)
    now = 240_000
    state = 'no_credentials'
    expect((await cache.readStale('account', read)).state).toBe('no_credentials')
    expect(cache.peekSuccessful('account')).toBeUndefined()
  })

  test('readStale only hides transient thrown transport errors when a successful value exists', async () => {
    let now = 0
    const cache = new UsageReadCache<{ state: string; value?: number }>(() => now)
    const first = await cache.readStale('account', async () => ({ state: 'ok', value: 1 }))
    now = 60_000
    expect(await cache.readStale('account', async () => { throw new Error('timeout') })).toBe(first)
    now = 120_000
    await expect(cache.readStale('account', async () => { throw new Error('invalid response shape') })).rejects.toThrow('invalid response shape')
  })

  test('readStale clears a successful value when the upstream reports authentication loss', async () => {
    let now = 0
    const cache = new UsageReadCache<{ state: string; reason?: string }>(() => now)
    await cache.readStale('account', async () => ({ state: 'ok' }))
    now = 60_000
    const failed = await cache.readStale('account', async () => ({ state: 'network', reason: 'HTTP 401 token expired' }))
    expect(failed).toMatchObject({ state: 'network' })
    expect(cache.peekSuccessful('account')).toBeUndefined()
  })

  test('rejected requests retain diagnostics and share the same cooldown', async () => {
    let now = 0, calls = 0
    const cache = new UsageReadCache<{ state: string }>(() => now)
    const error = new Error('upstream offline')
    const read = async () => { calls++; throw error }
    await expect(cache.read('account', read)).rejects.toBe(error)
    await expect(cache.read('account', read)).rejects.toBe(error)
    expect(calls).toBe(1)
    now = 60_000
    await expect(cache.read('account', read)).rejects.toBe(error)
    expect(calls).toBe(2)
  })

  test('account invalidation and reset snapshots prevent late reads restoring old data', async () => {
    const cache = new UsageReadCache<{ state: string; value: number }>()
    let release!: (value: { state: string; value: number }) => void
    const old = cache.read('account', () => new Promise(resolve => { release = resolve }))
    await Promise.resolve()
    cache.invalidate('account')
    cache.prime('account', { state: 'ok', value: 2 })
    release({ state: 'ok', value: 1 })
    await old
    expect((await cache.read('account', async () => { throw new Error('unexpected query') })).value).toBe(2)
  })

  test('honors Retry-After even when longer than the local backoff ceiling', async () => {
    let now = 0, calls = 0
    const cache = new UsageReadCache<{ state: string; retryAfterMs?: number }>(() => now)
    const read = async () => { calls++; return { state: 'rate_limited', retryAfterMs: 600_000 } }
    await cache.read('account', read)
    now = 599_999
    await cache.read('account', read)
    expect(calls).toBe(1)
    now++
    await cache.read('account', read)
    expect(calls).toBe(2)
    expect(usageRetryAfter(new Headers({ 'Retry-After': '120' }))).toBe(120_000)
    expect(usageRetryAfter(new Headers({ 'Retry-After': 'Thu, 01 Jan 1970 00:02:00 GMT' }), 0)).toBe(120_000)
    expect(usageRetryAfter(new Headers({ 'Retry-After': 'invalid' }))).toBeUndefined()
  })

  test('credential keys distinguish accounts without including the key itself', () => {
    const key = usageCredentialKey('glm', 'https://open.bigmodel.cn', 'private-key')
    expect(key).not.toContain('private-key')
    expect(key).not.toBe(usageCredentialKey('glm', 'https://open.bigmodel.cn', 'another-key'))
    expect(key).not.toBe(usageCredentialKey('glm', 'https://api.z.ai', 'private-key'))
  })

  test('a missing rate_limits field or quota transport error is not mislabeled as throttling', () => {
    expect(isUsageRateLimitError('HTTP 429 too many requests')).toBe(true)
    expect(isUsageRateLimitError('rate_limit_exceeded')).toBe(true)
    expect(isUsageRateLimitError('Claude 原生额度接口未返回 rate_limits 数据')).toBe(false)
    expect(isUsageRateLimitError('failed to fetch codex rate limits: timeout')).toBe(false)
  })
})
