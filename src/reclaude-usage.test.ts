import { expect, test } from 'bun:test'
import { reclaudeUsageSnapshot } from './reclaude-usage'

const quota = { enabled: true, status: 'active', state: 'active', quota_usd: '80.00', used_usd: '0.00', resets_at_ms: null }

test('ReClaude reports a quota window, preserves zero usage and an unstarted reset', () => {
  const result = reclaudeUsageSnapshot(quota)
  expect(result.kind).toBe('quota')
  expect(result.balance).toBeUndefined()
  expect(result.windows).toEqual([{ kind: 'fiveHour', label: '拼车 5h 窗口', percent: 0,
    resetsAt: null, used: 0, total: 80 }])
  const reset = Date.UTC(2026, 8, 15, 15)
  expect(reclaudeUsageSnapshot({ ...quota, used_usd: '20.00', resets_at_ms: reset }).windows[0])
    .toMatchObject({ percent: 25, resetsAt: new Date(reset) })
  expect(reclaudeUsageSnapshot({ ...quota, used_usd: '81.00', status: 'depleted' }).windows[0]?.percent).toBe(101.25)
})

test('ReClaude rejects missing, disabled and malformed quota data without showing a false zero', () => {
  for (const invalid of [null, [], {}, { enabled: false, state: 'not_applicable' },
    { ...quota, status: 'unknown' }, { ...quota, quota_usd: '0.00' }, { ...quota, used_usd: undefined },
    { ...quota, used_usd: '' }, { ...quota, used_usd: '-1' }, { ...quota, quota_usd: 'NaN' },
    { ...quota, resets_at_ms: undefined }, { ...quota, resets_at_ms: '123' }, { ...quota, resets_at_ms: Infinity }]) {
    expect(() => reclaudeUsageSnapshot(invalid)).toThrow('ReClaude')
  }
})

test('personal API key queries only the selected organization and HTTP failures remain visible', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    let calls = 0
    let status = 200
    let body = ${JSON.stringify(quota)}
    let failed = false
    mock.module('./src/network', () => ({ networkFetch: async (url, options) => {
      calls++
      assert.equal(String(url), 'https://reclaude.ai/api/v1/carpool/quota?org_id=42')
      assert.equal(options.headers.Authorization, 'Bearer rck_test')
      if (failed) throw new Error('upstream unavailable')
      return new Response(JSON.stringify(body), { status })
    } }))
    const { fetchReclaudeUsage } = await import('./src/reclaude-usage')
    assert.equal((await fetchReclaudeUsage(undefined, '42')).state, 'no_credentials')
    assert.equal((await fetchReclaudeUsage('rck_test', undefined)).state, 'network')
    assert.equal((await fetchReclaudeUsage('rck_test', '1&org_id=2')).state, 'network')
    assert.equal(calls, 0)
    assert.equal((await fetchReclaudeUsage('rck_test', '42')).state, 'ok')
    for (const [code, state] of [[401, 'no_credentials'], [403, 'no_credentials'], [429, 'rate_limited'], [500, 'network']]) {
      status = code
      const result = await fetchReclaudeUsage('rck_test', '42')
      assert.equal(result.state, state)
      assert.deepEqual(result.windows, [])
      assert.match(result.reason, new RegExp('HTTP ' + code))
    }
    status = 200; body = { enabled: false }
    assert.match((await fetchReclaudeUsage('rck_test', '42')).reason, /未开放/)
    failed = true
    assert.match((await fetchReclaudeUsage('rck_test', '42')).reason, /upstream unavailable/)
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
