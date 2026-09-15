import { describe, expect, test } from 'bun:test'
import { claudeUsageSnapshot, claudeWeeklyUsageWindow } from './claude-usage'

const reset = '2030-01-02T03:04:05.123456+00:00'
const response = (rate_limits: unknown) => ({ subscription_type: 'max', rate_limits_available: true, rate_limits })

describe('Claude subscription usage response', () => {
  test('keeps percentage units, zero, ISO resets and model-specific windows', () => {
    const snapshot = claudeUsageSnapshot(response({
      five_hour: { utilization: 12.5, resets_at: reset },
      seven_day: { utilization: 0, resets_at: null },
      seven_day_opus: { utilization: 25, resets_at: reset },
      seven_day_sonnet: null,
      model_scoped: [{ display_name: 'Fable', utilization: 4.5, resets_at: reset }],
    }))
    expect(snapshot.state).toBe('ok')
    expect(snapshot.windows).toEqual([
      { kind: 'fiveHour', label: '5h 窗口', percent: 12.5, resetsAt: new Date(reset) },
      { kind: 'weekly', label: '周额度', percent: 0, resetsAt: null },
      { kind: 'seven_day_opus', label: 'Opus 周额度', percent: 25, resetsAt: new Date(reset) },
      { kind: 'modelWeekly:Fable', label: 'Fable 周额度', percent: 4.5, resetsAt: new Date(reset) },
    ])
  })

  test('missing primary windows remain unknown even when model quota is available', () => {
    const snapshot = claudeUsageSnapshot(response({
      five_hour: { utilization: null, resets_at: null },
      model_scoped: [{ display_name: 'Fable', utilization: 80, resets_at: reset }],
    }))
    expect(snapshot.windows.map(window => window.percent)).toEqual([null, null, 80])
    expect(snapshot.windows[1]?.kind).toBe('weekly')
    expect(snapshot.windows[1]?.resetsAt).toBeNull()
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

describe('Claude weekly quota selection', () => {
  const snapshot = () => claudeUsageSnapshot(response({
    five_hour: { utilization: 10, resets_at: reset },
    seven_day: { utilization: 20, resets_at: reset },
    seven_day_opus: { utilization: 30, resets_at: reset },
    seven_day_sonnet: { utilization: 40, resets_at: reset },
    model_scoped: [{ display_name: 'Fable', utilization: 50, resets_at: reset }],
  }))

  test('matches aliases, full IDs, old IDs and context suffixes to their model quota', () => {
    const data = snapshot()
    for (const model of ['fable', 'claude:fable', 'FABLE[1m]', 'claude-fable-5-1', 'claude:claude-fable-5-1[1m]']) {
      expect(claudeWeeklyUsageWindow(data, model)?.percent).toBe(50)
    }
    for (const model of ['opus', 'claude:opus[1m]', 'claude-opus-4-7', 'default', 'claude:default']) {
      expect(claudeWeeklyUsageWindow(data, model)?.percent).toBe(30)
    }
    for (const model of ['sonnet', 'claude-sonnet-5', 'claude-3-5-sonnet-20241022']) {
      expect(claudeWeeklyUsageWindow(data, model)?.percent).toBe(40)
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
