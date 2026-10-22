import { describe, expect, test } from 'bun:test'
import { compareClaudeQuota, rankClaudeQuota } from './claude-quota'
import { claudeUsageSnapshot } from './claude-usage'
import type { UsageSnapshotUnified, UsageWindowUnified } from './token-source'

const NOW = 1_800_000_000_000
const after = (hours: number): Date => new Date(NOW + hours * 3_600_000)
const window = (kind: string, percent: number | null, hours: number): UsageWindowUnified => ({
  kind, label: kind, percent, resetsAt: after(hours),
})
function quota(options: { shortUsed?: number; shortHours?: number; weekUsed?: number; weekHours?: number;
  extra?: UsageWindowUnified[] } = {}): UsageSnapshotUnified {
  return { state: 'ok', fetchedAt: NOW, windows: [
    window('fiveHour', options.shortUsed ?? 20, options.shortHours ?? 3),
    window('weekly', options.weekUsed ?? 30, options.weekHours ?? 24), ...(options.extra ?? []),
  ] }
}
const rank = (snapshot: UsageSnapshotUnified | undefined, activeSessions = 0, model = 'opus') =>
  rankClaudeQuota(snapshot, model, NOW, activeSessions)

const fable = (totalUsed: number, totalHours: number, fableUsed: number, fableHours: number, activeSessions = 0) =>
  rank(quota({ weekUsed: totalUsed, weekHours: totalHours,
    extra: [window('modelWeekly:Fable', fableUsed, fableHours)] }), activeSessions, 'fable')

describe('Claude one-hour reservations across actual resets', () => {
  test.each([0, null])('an unstarted native short window with utilization %s can participate in account selection', utilization => {
    const snapshot = claudeUsageSnapshot({ subscription_type: 'max', rate_limits_available: true, rate_limits: {
      five_hour: { utilization, resets_at: null },
      seven_day: { utilization: 20, resets_at: new Date(Date.now() + 24 * 3_600_000).toISOString() },
    } })
    const now = snapshot.fetchedAt!
    const original = structuredClone(snapshot)
    const result = rankClaudeQuota(snapshot, 'opus', now)
    expect(result).toMatchObject({ state: 'ready', fits: true, fiveHourRemaining: 1, pressure: 0.1 })
    expect(result.score).toBeCloseTo(0.9 / 5)
    expect(rankClaudeQuota(snapshot, 'opus', now + 5 * 3_600_000).state).toBe('miss')
    expect(snapshot).toEqual(original)
  })

  test('a full week is ten complete short windows and its average below 0.1 does not reject a new session', () => {
    const result = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 0, weekHours: 168 }))
    expect(result).toMatchObject({ state: 'ready', fits: true, remaining: 1, hours: 168, activeSessions: 0,
      fiveHourRemaining: 1, pressure: 0.1 })
    expect(result.score).toBeCloseTo(9.9 / 168)
    expect(result.score!).toBeLessThan(0.1)
  })

  test('one percent can sustain one new session for five minutes but not two sessions', () => {
    const snapshot = quota({ shortUsed: 99, shortHours: 5 / 60, weekUsed: 0, weekHours: 168 })
    const single = rank(snapshot), shared = rank(snapshot, 1)
    expect(single).toMatchObject({ state: 'ready', fits: true, activeSessions: 0 })
    expect(single.score).toBeCloseTo(0.01 - 0.1 * 5 / 60)
    expect(single.pressure).toBeCloseTo((0.1 * 5 / 60) / 0.01)
    expect(shared).toMatchObject({ state: 'ready', fits: false, activeSessions: 1 })
    expect(shared.score).toBeCloseTo(0.01 - 0.2 * 5 / 60)
    expect(shared.pressure).toBeCloseTo((0.2 * 5 / 60) / 0.01)
    expect(compareClaudeQuota(single, shared)).toBeLessThan(0)
    const tooDistant = rank(quota({ shortUsed: 99, shortHours: 0.5 }))
    expect(tooDistant).toMatchObject({ state: 'ready', fits: false })
    expect(tooDistant.pressure).toBeCloseTo(5)
  })

  test('existing sessions and the new session are reserved exactly once, including an exact 30 percent boundary', () => {
    const snapshot = quota({ shortUsed: 70, shortHours: 2, weekUsed: 0, weekHours: 168 })
    expect(rank(snapshot, 2)).toMatchObject({ state: 'ready', fits: true, pressure: 1, score: 0 })
    expect(rank(snapshot, 3)).toMatchObject({ state: 'ready', fits: false })
    expect(rank(snapshot, 3).pressure).toBeCloseTo(4 / 3)
    expect(rank(snapshot, 3).score).toBeCloseTo(-0.05)
  })

  test('post-reset demand can require squeezing even when the current remainder is sufficient', () => {
    const snapshot = quota({ shortUsed: 80, shortHours: 0.05, weekUsed: 0, weekHours: 168 })
    const result = rank(snapshot, 10)
    expect(result).toMatchObject({ state: 'ready', fits: false })
    expect(result.pressure).toBeCloseTo(1.1 * 0.95)
    expect(result.score).toBeCloseTo(1 - 1.1 * 0.95)
  })

  test('post-reset headroom participates in ranking rather than disappearing from the forecast', () => {
    const busy = rank(quota({ shortUsed: 10, shortHours: 0.01, weekUsed: 0, weekHours: 168 }), 9)
    const quiet = rank(quota({ shortUsed: 80, shortHours: 5, weekUsed: 0, weekHours: 168 }))
    expect(busy).toMatchObject({ state: 'ready', fits: true })
    expect(busy.score).toBeCloseTo(0.01)
    expect(busy.pressure).toBeCloseTo(0.99)
    expect(quiet.score).toBeCloseTo(0.02)
    expect(compareClaudeQuota(quiet, busy)).toBeLessThan(0)
  })

  test('a reset exactly one hour away has no extra post-reset segment', () => {
    const result = rank(quota({ shortUsed: 90, shortHours: 1 }))
    expect(result).toMatchObject({ state: 'ready', fits: true, pressure: 1, score: 0 })
  })

  test('a near weekly reset never grants priority over a fitting account with more short-window headroom', () => {
    const lowShort = rank(quota({ shortUsed: 99, shortHours: 3, weekUsed: 0, weekHours: 2 }))
    const normal = rank(quota({ shortUsed: 50, shortHours: 4, weekUsed: 0, weekHours: 168 }))
    expect(lowShort).toMatchObject({ state: 'ready', fits: false })
    expect(normal.fits).toBe(true)
    expect(compareClaudeQuota(normal, lowShort)).toBeLessThan(0)
  })

  test('real reset times still favor a smaller weekly remainder when it can sustain the reservation', () => {
    const far = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 80, weekHours: 100 }))
    const near = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 90, weekHours: 6 }))
    expect(far.score).toBeCloseTo(1.9 / 100)
    expect(near.score).toBeCloseTo(0.9 / 6)
    expect(compareClaudeQuota(near, far)).toBeLessThan(0)
  })

  test('a small week balance is evaluated before and after its own reset without an infinite score', () => {
    const soon = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 99.9, weekHours: 5 / 60 }))
    const distant = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 99.9, weekHours: 24 }))
    expect(soon).toMatchObject({ state: 'ready', fits: true })
    expect(soon.score).toBeCloseTo(0.01 - 0.1 * 5 / 60)
    expect(distant).toMatchObject({ state: 'ready', fits: false })
    expect(Number.isFinite(soon.score)).toBe(true)
  })

  test('forecasting never subtracts real quota or publishes a fabricated reset allowance', () => {
    const snapshot = quota({ shortUsed: 99, shortHours: 5 / 60 })
    const original = structuredClone(snapshot)
    rank(snapshot, 0); rank(snapshot, 100); rank(snapshot, 2)
    expect(snapshot).toEqual(original)
  })
})

describe('Claude pressure-based sharing when every forecast is insufficient', () => {
  test('more active sessions never improve forecast headroom or reduce pressure across reset boundaries', () => {
    for (const shortUsed of [0, 90, 99]) for (const shortHours of [0.01, 0.5, 1, 5]) {
      for (const weekUsed of [0, 90, 99.9]) for (const model of ['opus', 'fable']) {
        const snapshot = quota({ shortUsed, shortHours, weekUsed, weekHours: shortHours < 1 ? 0.2 : 168,
          extra: [window('modelWeekly:Fable', 30, shortHours < 1 ? 0.3 : 24)] })
        let previous = rank(snapshot, 0, model)
        for (const count of [1, 3, 10]) {
          const current = rank(snapshot, count, model)
          expect(current.state).toBe('ready')
          expect(current.pressure!).toBeGreaterThanOrEqual(previous.pressure!)
          expect(current.score!).toBeLessThanOrEqual(previous.score!)
          if (!previous.fits) expect(current.fits).toBe(false)
          previous = current
        }
      }
    }
  })

  test('forty allocations spread equally across four equally constrained accounts', () => {
    const snapshot = quota({ shortUsed: 99, shortHours: 1, weekUsed: 0, weekHours: 168 })
    const counts = [0, 0, 0, 0]
    for (let i = 0; i < 40; i++) {
      const candidates = counts.map((count, id) => ({ ...rank(snapshot, count), id }))
      expect(candidates.every(candidate => candidate.state === 'ready' && !candidate.fits)).toBe(true)
      const selected = candidates.sort(compareClaudeQuota)[0]!
      counts[selected.id]++
    }
    expect(counts).toEqual([10, 10, 10, 10])
    expect(snapshot.windows[0]!.percent).toBe(99)
  })

  test('different residual capacities share forty allocations by capacity rather than account order', () => {
    const snapshots = [99, 97].map(shortUsed => quota({ shortUsed, shortHours: 1, weekUsed: 0, weekHours: 168 }))
    const counts = [0, 0]
    for (let i = 0; i < 40; i++) {
      const selected = snapshots.map((snapshot, id) => ({ ...rank(snapshot, counts[id]!), id })).sort(compareClaudeQuota)[0]!
      expect(selected.state).toBe('ready')
      expect(selected.fits).toBe(false)
      counts[selected.id]++
    }
    expect(counts).toEqual([10, 30])
  })

  test('fitting candidates precede squeezed ones; squeezed candidates minimize pressure before maximizing score', () => {
    const fit = rank(quota())
    const squeeze = { ...fit, fits: false, pressure: 2, score: -1, activeSessions: 5 }
    expect(compareClaudeQuota(fit, squeeze)).toBeLessThan(0)
    expect(compareClaudeQuota(squeeze, { ...squeeze, pressure: 3, score: -0.1 })).toBeLessThan(0)
    expect(compareClaudeQuota({ ...squeeze, score: -0.1 }, squeeze)).toBeLessThan(0)
    expect(compareClaudeQuota({ ...squeeze, activeSessions: 4 }, squeeze)).toBeLessThan(0)
    expect(compareClaudeQuota({ ...squeeze, fiveHourRemaining: 0.9 }, squeeze)).toBeLessThan(0)
  })

  test('fitting ties compare pressure then active sessions and exact ties keep the original order', () => {
    const base = rank(quota())
    expect(compareClaudeQuota({ ...base, score: base.score! + 1, pressure: 0.9 }, base)).toBeLessThan(0)
    expect(compareClaudeQuota({ ...base, pressure: base.pressure! / 2 }, base)).toBeLessThan(0)
    expect(compareClaudeQuota(base, { ...base, activeSessions: 1 })).toBeLessThan(0)
    expect(compareClaudeQuota(base, { ...base })).toBe(0)
    const first = { ...base, id: 'default' }, second = { ...base, id: 'second' }
    expect([first, second].sort(compareClaudeQuota)).toEqual([first, second])
  })
})

describe('Fable shared and dedicated weekly constraints', () => {
  test('native Fable quota uses five shared and ten dedicated short-window units with independent deadlines', () => {
    const snapshot = claudeUsageSnapshot({ subscription_type: 'max', rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 20, resets_at: after(3).toISOString() },
      seven_day: { utilization: 30, resets_at: after(100).toISOString() },
      model_scoped: [{ display_name: 'Fable', utilization: 80, resets_at: after(6).toISOString() }],
    } })
    expect(snapshot.windows.some(item => item.kind === 'seven_day_opus')).toBe(false)
    expect(rank(snapshot)).toMatchObject({ state: 'ready', fits: true, remaining: 0.7, hours: 100 })
    expect(rank(snapshot).score).toBeCloseTo(6.9 / 100)
    expect(rank(snapshot, 0, 'claude-fable-5')).toMatchObject({ state: 'ready', fits: true, remaining: 0.2, hours: 6 })
    expect(rank(snapshot, 0, 'claude-fable-5').score).toBeCloseTo(3.4 / 100)
  })

  test('either the half-total allowance or dedicated allowance can be the limiting week', () => {
    for (const result of [fable(80, 24, 20, 24), fable(20, 24, 90, 24)]) {
      expect(result).toMatchObject({ state: 'ready', fits: true, remaining: 0.1, hours: 24 })
      expect(result.score).toBeCloseTo(0.9 / 24)
    }
  })

  test('each Fable balance keeps its own deadline instead of pairing the smaller balance with another reset', () => {
    expect(fable(30, 100, 80, 6).score).toBeCloseTo(3.4 / 100)
    expect(fable(80, 6, 80, 100).score).toBeCloseTo(1.9 / 100)
    expect(fable(80, 100, 0, 0.2).score).toBeCloseTo(0.9 / 100)
    expect(fable(0, 0.2, 80, 100).score).toBeCloseTo(1.9 / 100)
    expect(fable(80, 100, 0, 0.2, 2).score).toBeCloseTo(0.7 / 100)
  })

  test('missing or ambiguous Fable quota is not a spare account available for squeezing', () => {
    expect(rank(quota({ weekUsed: 0 }), 0, 'fable')).toMatchObject({ state: 'miss', fits: false, score: null })
    const ambiguous = quota({ extra: [window('modelWeekly:Fable', 30, 20), window('modelWeekly:Fable 5', 40, 30)] })
    expect(rank(ambiguous, 0, 'fable')).toMatchObject({ state: 'miss', fits: false, score: null })
    expect(rank(ambiguous).state).toBe('ready')
  })

  test('Fable-specific exhaustion and reset errors do not restrict Opus', () => {
    const snapshot = quota({ extra: [{ ...window('modelWeekly:Fable', 100, 4), resetsAt: null }] })
    expect(rank(snapshot).state).toBe('ready')
    expect(rank(snapshot, 0, 'fable').state).toBe('exhausted')
  })

  test.each(['pro', 'max', 'team', 'enterprise', 'unknown-plan'])(
    'all subscription types use the same full-week capacity: %s', subscriptionType => {
      const snapshot = claudeUsageSnapshot({ subscription_type: subscriptionType, rate_limits_available: true, rate_limits: {
        five_hour: { utilization: 0, resets_at: after(3).toISOString() },
        seven_day: { utilization: 0, resets_at: after(168).toISOString() },
        model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: after(168).toISOString() }],
      } })
      expect(rank(snapshot, 0, 'fable')).toMatchObject({ state: 'ready', fits: true, remaining: 0.5, hours: 168 })
      expect(rank(snapshot, 0, 'fable').score).toBeCloseTo(4.9 / 168)
      expect(rank(snapshot).score).toBeCloseTo(9.9 / 168)
    })
})

describe('Claude actual quota errors remain excluded', () => {
  test.each([NaN, Infinity, -Infinity])('invalid current time %s stays MISS', now => {
    expect(rankClaudeQuota(quota(), 'opus', now)).toMatchObject({ state: 'miss', fits: false, score: null })
  })
  test.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])('invalid active count %s stays MISS', count => {
    expect(rank(quota(), count)).toMatchObject({ state: 'miss', fits: false, score: null, reason: '活跃会话数 MISS' })
  })

  test('missing snapshots, failures and missing or repeated main windows cannot participate', () => {
    expect(rank(undefined).state).toBe('miss')
    expect(rank({ state: 'network', windows: [], reason: 'offline' })).toMatchObject({ state: 'miss', reason: 'offline' })
    expect(rank({ state: 'ok', windows: [] }).state).toBe('miss')
    for (const kind of ['fiveHour', 'weekly']) {
      const snapshot = quota({ extra: [window('modelWeekly:Fable', 20, 2)] })
      snapshot.windows = snapshot.windows.filter(item => item.kind !== kind)
      expect(rank(snapshot, 0, 'fable').state).toBe('miss')
    }
    expect(rank(quota({ extra: [window('weekly', 0, 100)] })).state).toBe('miss')
  })

  test.each(['fiveHour', 'weekly', 'seven_day_oauth_apps', 'modelWeekly:Fable'])(
    'genuinely exhausted %s never becomes available through predicted reset or squeezing', kind => {
      const snapshot = quota({ weekHours: 0.1,
        extra: [window('modelWeekly:Fable', 20, 0.2), window('seven_day_oauth_apps', 20, 0.3)] })
      snapshot.windows.find(item => item.kind === kind)!.percent = 100
      expect(rank(snapshot, 100, 'fable')).toMatchObject({ state: 'exhausted', fits: false, score: null })
    })

  test('OAuth and genuine Opus-specific budgets constrain forecasts even before they are exhausted', () => {
    for (const kind of ['seven_day_oauth_apps', 'seven_day_opus']) {
      const result = rank(quota({ extra: [window(kind, 99.9, 24)] }))
      expect(result).toMatchObject({ state: 'ready', fits: false })
      expect(result.pressure).toBeCloseTo(10)
      expect(result.score).toBeCloseTo(-0.09 / 24)
    }
  })

  test.each(['fiveHour', 'weekly', 'seven_day_oauth_apps', 'modelWeekly:Fable'])(
    'invalid %s percentages and reset times stay MISS rather than becoming spare quota', kind => {
      for (const percent of [null, NaN, Infinity, -1, 101]) {
        const snapshot = quota({ extra: [window('seven_day_oauth_apps', 20, 20), window('modelWeekly:Fable', 20, 30)] })
        snapshot.windows.find(item => item.kind === kind)!.percent = percent
        expect(rank(snapshot, 0, 'fable')).toMatchObject({ state: 'miss', fits: false, score: null })
      }
      for (const resetsAt of [null, new Date(NaN), new Date(0), after(-1), after(0)]) {
        const snapshot = quota({ extra: [window('seven_day_oauth_apps', 0, 20), window('modelWeekly:Fable', 0, 30)] })
        const target = snapshot.windows.find(item => item.kind === kind)!
        target.percent = 0; target.resetsAt = resetsAt
        expect(rank(snapshot, 0, 'fable')).toMatchObject({ state: 'miss', fits: false, score: null })
      }
    })
})
