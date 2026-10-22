import { describe, expect, test } from 'bun:test'
import { claudeUsageSnapshot, claudeWeeklyUsageWindow } from './claude-usage'

const reset = '2030-01-02T03:04:05.123456+00:00'
const response = (rate_limits: unknown) => ({ subscription_type: 'max', rate_limits_available: true, rate_limits })

describe('Claude subscription usage response', () => {
  test('keeps the main windows and Fable weekly quota with percentage units, zero and ISO resets', () => {
    const snapshot = claudeUsageSnapshot(response({
      five_hour: { utilization: 12.5, resets_at: reset },
      seven_day: { utilization: 0, resets_at: null },
      model_scoped: [{ display_name: 'Fable', utilization: 4.5, resets_at: reset }],
    }))
    expect(snapshot.state).toBe('ok')
    expect(snapshot.windows).toEqual([
      { kind: 'fiveHour', label: '5h 窗口', percent: 12.5, resetsAt: new Date(reset) },
      { kind: 'weekly', label: '周额度', percent: 0, resetsAt: null },
      { kind: 'modelWeekly:Fable', label: 'Fable 周额度', percent: 4.5, resetsAt: new Date(reset) },
    ])
  })

  test.each([0, null])('an unstarted five-hour window with utilization %s has a full allowance from the fetch time', utilization => {
    const snapshot = claudeUsageSnapshot(response({
      five_hour: { utilization, resets_at: null },
      seven_day: { utilization: 20, resets_at: reset },
    }))
    expect(snapshot.windows[0]).toEqual({ kind: 'fiveHour', label: '5h 窗口', percent: 0,
      resetsAt: new Date(snapshot.fetchedAt! + 5 * 3_600_000) })
    expect(snapshot.windows[1]?.percent).toBe(20)
    expect(snapshot.windows[1]?.resetsAt).toEqual(new Date(reset))
  })

  test.each([undefined, null])('missing primary windows (%s) remain unknown even when model quota is available', five_hour => {
    const snapshot = claudeUsageSnapshot(response({
      five_hour,
      model_scoped: [{ display_name: 'Fable', utilization: 80, resets_at: reset }],
    }))
    expect(snapshot.windows.map(window => window.percent)).toEqual([null, null, 80])
    expect(snapshot.windows[1]?.kind).toBe('weekly')
    expect(snapshot.windows[1]?.resetsAt).toBeNull()
  })

  test('does not reset used, exhausted, expired or partially missing short windows to a full allowance', () => {
    for (const [utilization, resets_at] of [[10, null], [100, null], [null, reset], [0, '2020-01-01T00:00:00Z']] as const) {
      const snapshot = claudeUsageSnapshot(response({ five_hour: { utilization, resets_at } }))
      expect(snapshot.windows[0]).toEqual({ kind: 'fiveHour', label: '5h 窗口', percent: utilization,
        resetsAt: resets_at === null ? null : new Date(resets_at) })
    }
  })

  test('does not turn unavailable, failed or empty responses into applicable zero quotas', () => {
    for (const data of [null, {}, { ...response({}), subscription_type: null },
      { ...response({}), rate_limits_available: false }, response(null), response({})]) {
      expect(() => claudeUsageSnapshot(data)).toThrow(/Claude/)
    }
  })

  test('rejects malformed percentages, reset dates and model labels', () => {
    for (const utilization of [undefined, '12', NaN, Infinity, -1, 101]) {
      expect(() => claudeUsageSnapshot(response({ five_hour: { utilization, resets_at: reset } }))).toThrow('utilization')
    }
    for (const resets_at of [undefined, '', 'invalid', 123]) {
      expect(() => claudeUsageSnapshot(response({ five_hour: { utilization: 0, resets_at } }))).toThrow('resets_at')
    }
    for (const model_scoped of [{}, [null], [{ display_name: '', utilization: 0, resets_at: null }]]) {
      expect(() => claudeUsageSnapshot(response({ model_scoped }))).toThrow(/模型/)
    }
  })
})

test('native quota cache separates accounts and rejects late snapshots after identity changes', () => {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', `
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    const calls = []
    let release
    let barrier = Promise.resolve()
    let percent = 10
    mock.module('./src/claude-agent-process', () => ({ ClaudeAgentProcess: class {
      constructor(options) { this.options = options; assert.equal(options.controlOnly, true) }
      on() {}
      isAlive() { return false }
      async readSubscriptionUsage() {
        const captured = percent
        calls.push(this.options.tokenSourceId)
        await barrier
        return { subscription_type: 'max', rate_limits_available: true, rate_limits: {
          five_hour: { utilization: captured, resets_at: null }, seven_day: { utilization: captured, resets_at: null },
        } }
      }
      async kill() {}
    } }))
    const { fetchClaudeSubscriptionUsage, invalidateClaudeSubscriptionUsage } = await import('./src/claude-usage')
    let generation = 'one'
    const first = () => fetchClaudeSubscriptionUsage({ tokenSourceId: 'A' }, { accountId: 'A', revision: generation })
    const [a, simultaneous] = await Promise.all([first(), first()])
    assert.equal(a, simultaneous); assert.deepEqual(calls, ['A'])
    percent = 70
    const b = await fetchClaudeSubscriptionUsage({ tokenSourceId: 'B' }, { accountId: 'B', revision: 'one' })
    assert.equal(b.windows[0].percent, 70)
    assert.equal((await first()).windows[0].percent, 10)
    invalidateClaudeSubscriptionUsage('A')
    barrier = new Promise(resolve => { release = resolve })
    const pending = fetchClaudeSubscriptionUsage({ tokenSourceId: 'A-old' },
      { accountId: 'A', revision: 'one', current: () => generation === 'one' })
    for (let tick = 0; tick < 100 && !calls.includes('A-old'); tick++) await new Promise(resolve => setTimeout(resolve, 0))
    assert.ok(calls.includes('A-old'))
    generation = 'two'; invalidateClaudeSubscriptionUsage('A'); percent = 20
    barrier = Promise.resolve()
    const current = await first()
    release()
    assert.equal((await pending).state, 'no_credentials')
    assert.equal(current.windows[0].percent, 20)
    assert.equal((await first()).windows[0].percent, 20)
    assert.equal(b.windows[0].percent, 70)
  `], { cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000 })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})

describe('Claude weekly quota selection', () => {
  const snapshot = () => claudeUsageSnapshot(response({
    five_hour: { utilization: 10, resets_at: reset },
    seven_day: { utilization: 20, resets_at: reset },
    model_scoped: [{ display_name: 'Fable', utilization: 50, resets_at: reset }],
  }))

  test('uses Fable dedicated quota and the total weekly quota for Opus, default and Sonnet', () => {
    const data = snapshot()
    for (const model of ['fable', 'claude:fable', 'FABLE[1m]', 'claude-fable-5-1', 'claude:claude-fable-5-1[1m]']) {
      expect(claudeWeeklyUsageWindow(data, model)?.percent).toBe(50)
    }
    for (const model of ['opus', 'claude:opus[1m]', 'claude-opus-4-7', 'default', 'claude:default']) {
      expect(claudeWeeklyUsageWindow(data, model)).toBe(data.windows[1])
    }
    for (const model of ['sonnet', 'claude-sonnet-5', 'claude-3-5-sonnet-20241022']) {
      expect(claudeWeeklyUsageWindow(data, model)).toBe(data.windows[1])
    }
  })

  test('models without a dedicated window use total weekly quota without substring matching', () => {
    const data = snapshot()
    for (const model of ['haiku', 'claude-haiku-4-5', 'not-fable', 'fableish']) {
      expect(claudeWeeklyUsageWindow(data, model)).toBe(data.windows[1])
    }
    const totalOnly = claudeUsageSnapshot(response({ seven_day: { utilization: 20, resets_at: reset } }))
    expect(claudeWeeklyUsageWindow(totalOnly, 'fable')?.percent).toBe(20)
  })

  test('missing values in an applicable model window remain MISS; unknown models are not guessed', () => {
    const data = snapshot()
    const fable = data.windows.find(window => window.kind === 'modelWeekly:Fable')!
    fable.percent = null
    expect(claudeWeeklyUsageWindow(data, 'fable')).toBe(fable)
    fable.percent = 0
    expect(claudeWeeklyUsageWindow(data, 'fable')?.percent).toBe(0)
    for (const model of [null, '', '  ']) {
      expect(claudeWeeklyUsageWindow(data, model)).toBeNull()
    }
    expect(claudeWeeklyUsageWindow({ ...data, state: 'network' }, 'fable')).toBeNull()
    data.windows.push({ ...fable, kind: 'modelWeekly:Fable 5' })
    expect(claudeWeeklyUsageWindow(data, 'fable')).toBeNull()
  })
})

describe('legacy Claude model-specific weekly quota compatibility', () => {
  test('preserves explicitly returned legacy Opus and Sonnet windows and matches their aliases', () => {
    const data = claudeUsageSnapshot(response({
      five_hour: { utilization: 10, resets_at: reset },
      seven_day: { utilization: 20, resets_at: reset },
      seven_day_opus: { utilization: 30, resets_at: reset },
      seven_day_sonnet: { utilization: 40, resets_at: reset },
    }))
    expect(data.windows.slice(2)).toEqual([
      { kind: 'seven_day_opus', label: 'Opus 周额度', percent: 30, resetsAt: new Date(reset) },
      { kind: 'seven_day_sonnet', label: 'Sonnet 周额度', percent: 40, resetsAt: new Date(reset) },
    ])
    for (const model of ['opus', 'claude:opus[1m]', 'claude-opus-4-7', 'default', 'claude:default']) {
      expect(claudeWeeklyUsageWindow(data, model)?.percent).toBe(30)
    }
    for (const model of ['sonnet', 'claude-sonnet-5', 'claude-3-5-sonnet-20241022']) {
      expect(claudeWeeklyUsageWindow(data, model)?.percent).toBe(40)
    }
  })

  test('does not create legacy windows when the native response returns null', () => {
    const data = claudeUsageSnapshot(response({
      seven_day: { utilization: 20, resets_at: reset },
      seven_day_opus: null,
      seven_day_sonnet: null,
    }))
    expect(data.windows.map(window => window.kind)).toEqual(['fiveHour', 'weekly'])
    expect(claudeWeeklyUsageWindow(data, 'opus')).toBe(data.windows[1])
    expect(claudeWeeklyUsageWindow(data, 'sonnet')).toBe(data.windows[1])
  })
})
