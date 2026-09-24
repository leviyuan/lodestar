import { expect, test } from 'bun:test'

test('background refresh owns cadence, coalescing, retry backoff and shutdown', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { BackgroundRefresh, startBackgroundRefresh, stopBackgroundRefresh } from './src/background-refresh'
    let now = 1000, calls = 0, failure, barrier = Promise.resolve()
    const timers = new Map()
    Date.now = () => now
    globalThis.setTimeout = (fn, delay) => { const handle = { unref() {} }; timers.set(handle, { fn, delay }); return handle }
    globalThis.clearTimeout = handle => timers.delete(handle)
    const resource = new BackgroundRefresh('test-catalog', 300000, async () => { calls++; await barrier; if (failure) throw failure })
    assert.equal(timers.size, 0)
    await resource.refresh()
    startBackgroundRefresh()
    assert.equal([...timers.values()][0].delay, 300000)
    let release
    barrier = new Promise(resolve => { release = resolve })
    const first = resource.refresh()
    assert.equal(resource.refresh(), first)
    await Promise.resolve()
    assert.equal(calls, 2)
    assert.equal(timers.size, 0)
    release(); await first
    barrier = Promise.resolve()
    for (const expected of [60000, 120000, 240000, 300000, 300000]) {
      failure = new Error('upstream unavailable')
      await assert.rejects(resource.refresh(), /upstream unavailable/)
      assert.equal([...timers.values()][0].delay, expected)
      now += expected
    }
    failure.retryAfterMs = 600000
    await assert.rejects(resource.refresh(), /upstream unavailable/)
    assert.equal([...timers.values()][0].delay, 600000)
    failure = undefined
    await resource.refresh()
    assert.equal([...timers.values()][0].delay, 300000)
    stopBackgroundRefresh()
    assert.equal(timers.size, 0)
    resource.dispose()
    const prior = calls
    await resource.refresh()
    assert.equal(calls, prior)
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
