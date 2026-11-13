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
  extra?: UsageWindowUnified[]; weeklyOnly?: boolean } = {}): UsageSnapshotUnified {
  return { state: 'ok', fetchedAt: NOW, windows: [
    ...(options.weeklyOnly ? [] : [window('fiveHour', options.shortUsed ?? 20, options.shortHours ?? 3)]),
    window('weekly', options.weekUsed ?? 30, options.weekHours ?? 24), ...(options.extra ?? []),
  ] }
}
const rank = (snapshot: UsageSnapshotUnified | undefined, activeSessions = 0, model = 'opus') =>
  rankClaudeQuota(snapshot, model, NOW, activeSessions)

describe('Claude remaining units and per-session spacing', () => {
  test.each([0, null])('an unstarted native short window counts as a full unit', utilization => {
    const snapshot = claudeUsageSnapshot({ subscription_type: 'max', rate_limits_available: true, rate_limits: {
      five_hour: { utilization, resets_at: null },
      seven_day: { utilization: 20, resets_at: new Date(Date.now() + 24 * 3_600_000).toISOString() },
    } })
    const now = snapshot.fetchedAt!
    const original = structuredClone(snapshot)
    expect(rankClaudeQuota(snapshot, 'opus', now)).toMatchObject({
      state: 'ready', remaining: 1, score: 1, fiveHourRemaining: 1, activeSessions: 0 })
    expect(rankClaudeQuota(snapshot, 'opus', now + 5 * 3_600_000).state).toBe('miss')
    expect(snapshot).toEqual(original)
  })

  test('a full week is ten units and the tightest window is the account remainder', () => {
    const fresh = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 0, weekHours: 168 }))
    expect(fresh).toMatchObject({ state: 'ready', remaining: 1, fiveHourRemaining: 1, activeSessions: 0 })
    expect(fresh.score).toBe(1)
    expect(rank(quota({ shortUsed: 20, weekUsed: 30 }))).toMatchObject({ remaining: 0.8, score: 0.8 })
    expect(rank(quota({ shortUsed: 0, weekUsed: 95 }))).toMatchObject({ remaining: 0.5, score: 0.5 })
  })

  test('the per-session share shrinks with every active session and never forecasts time', () => {
    const snapshot = quota({ shortUsed: 60, shortHours: 0.5, weekUsed: 0, weekHours: 168 })
    expect(rank(snapshot)).toMatchObject({ state: 'ready', remaining: 0.4, score: 0.4 })
    expect(rank(snapshot, 1).score).toBeCloseTo(0.2)
    expect(rank(snapshot, 3).score).toBeCloseTo(0.1)
    // Reset distance and remaining life do not change the spacing decision.
    expect(rank(quota({ shortUsed: 60, shortHours: 4.5, weekUsed: 0, weekHours: 168 })).score).toBeCloseTo(0.4)
  })

  test('every subscription type uses the same capacity and OAuth or model buckets still constrain', () => {
    for (const kind of ['seven_day_oauth_apps', 'seven_day_opus']) {
      const result = rank(quota({ extra: [window(kind, 99.9, 24)] }))
      expect(result.state).toBe('ready')
      expect(result.remaining).toBeCloseTo(0.01)
      expect(result.score).toBeCloseTo(0.01)
    }
  })

  test('forecasting never mutates the snapshot or publishes a fabricated remainder', () => {
    const snapshot = quota({ shortUsed: 99, shortHours: 5 / 60 })
    const original = structuredClone(snapshot)
    rank(snapshot, 0); rank(snapshot, 100); rank(snapshot, 2)
    expect(snapshot).toEqual(original)
  })
})

describe('Claude tasks spread by real headroom', () => {
  test('forty launches alternate across two equally loaded accounts', () => {
    const snapshot = quota({ shortUsed: 99, weekUsed: 0, weekHours: 168 })
    const counts = [0, 0]
    for (let i = 0; i < 40; i++) {
      const selected = counts.map((count, id) => ({ ...rank(snapshot, count), id })).sort(compareClaudeQuota)[0]!
      expect(selected.state).toBe('ready')
      counts[selected.id]++
    }
    expect(counts).toEqual([20, 20])
  })

  test('four equally loaded accounts share forty launches evenly', () => {
    const snapshot = quota({ shortUsed: 90, weekUsed: 0, weekHours: 168 })
    const counts = [0, 0, 0, 0]
    for (let i = 0; i < 40; i++) {
      const selected = counts.map((count, id) => ({ ...rank(snapshot, count), id })).sort(compareClaudeQuota)[0]!
      counts[selected.id]++
    }
    expect(counts).toEqual([10, 10, 10, 10])
  })

  test('different remainders receive launches in proportion to their headroom', () => {
    const snapshots = [99, 97].map(shortUsed => quota({ shortUsed, weekUsed: 0, weekHours: 168 }))
    const counts = [0, 0]
    for (let i = 0; i < 40; i++) {
      const selected = snapshots.map((snapshot, id) => ({ ...rank(snapshot, counts[id]!), id })).sort(compareClaudeQuota)[0]!
      counts[selected.id]++
    }
    expect(counts).toEqual([10, 30])
  })

  test('a roomier account wins, and ties prefer the least busy then the largest remainder', () => {
    const roomy = rank(quota({ shortUsed: 0 }))
    const tight = rank(quota({ shortUsed: 90 }))
    expect(compareClaudeQuota(roomy, tight)).toBeLessThan(0)
    const busy = { ...roomy, activeSessions: 3, score: roomy.score! / 4 }
    expect(compareClaudeQuota(roomy, busy)).toBeLessThan(0)
    const tied = { ...roomy, activeSessions: 1, score: roomy.score }
    expect(compareClaudeQuota({ ...tied, remaining: tied.remaining! - 0.1 }, tied)).toBeGreaterThan(0)
    expect(compareClaudeQuota({ ...tied, fiveHourRemaining: 0.9 }, tied)).toBeGreaterThan(0)
    expect(compareClaudeQuota(roomy, { ...roomy })).toBe(0)
    const first = { ...roomy, id: 'default' }, second = { ...roomy, id: 'second' }
    expect([second, first].sort(compareClaudeQuota)).toEqual([second, first])
  })
})

describe('accounts without a five-hour window', () => {
  test('weekly-only quota is schedulable and carries the model weekly reset', () => {
    const result = rank(quota({ weeklyOnly: true, weekUsed: 30, weekHours: 24 }))
    expect(result).toMatchObject({ state: 'ready', hasFiveHour: false, remaining: 7, score: 7,
      expiresAt: after(24).getTime() })
    expect(result.fiveHourRemaining).toBeUndefined()
  })

  test('a usable five-hour window outranks every weekly-only account', () => {
    // 5h 账号只剩很小的窗口余量，周额度几乎没动；无 5h 账号余额充足且更快到期。
    const withShort = rank(quota({ shortUsed: 99, shortHours: 1, weekUsed: 0, weekHours: 168 }))
    const weeklyOnly = rank(quota({ weeklyOnly: true, weekUsed: 0, weekHours: 2 }))
    expect(withShort.hasFiveHour).toBe(true)
    expect(compareClaudeQuota(withShort, weeklyOnly)).toBeLessThan(0)
    expect(compareClaudeQuota(weeklyOnly, withShort)).toBeGreaterThan(0)
  })

  test('weekly-only accounts spend the weekly quota that resets unused first', () => {
    const soon = rank(quota({ weeklyOnly: true, weekUsed: 80, weekHours: 8 }))
    const later = rank(quota({ weeklyOnly: true, weekUsed: 0, weekHours: 120 }))
    expect(compareClaudeQuota(soon, later)).toBeLessThan(0)
    // 到期时间相同时仍按余量份额分摊。
    const roomier = rank(quota({ weeklyOnly: true, weekUsed: 20, weekHours: 8 }))
    const tighter = rank(quota({ weeklyOnly: true, weekUsed: 80, weekHours: 8 }))
    expect(compareClaudeQuota(roomier, tighter)).toBeLessThan(0)
  })

  test('weekly-only exhaustion and missing values still exclude the account', () => {
    expect(rank(quota({ weeklyOnly: true, weekUsed: 100 })).state).toBe('exhausted')
    const noReset = quota({ weeklyOnly: true })
    noReset.windows[0]!.resetsAt = null
    expect(rank(noReset).state).toBe('miss')
  })

  test('five-hour accounts still spread by share before the window reset time', () => {
    const earlier = rank(quota({ shortUsed: 50, shortHours: 1, weekUsed: 0, weekHours: 168 }))
    const roomier = rank(quota({ shortUsed: 0, shortHours: 4.5, weekUsed: 0, weekHours: 168 }))
    // 余量份额更大的账号先接，即使它的窗口更晚重置。
    expect(compareClaudeQuota(roomier, earlier)).toBeLessThan(0)
    // 份额相同时先花更快作废的窗口。
    expect(compareClaudeQuota({ ...roomier, expiresAt: earlier.expiresAt! }, roomier)).toBeLessThan(0)
  })
})

describe('Fable shared and dedicated weekly capacities', () => {
  test('Fable keeps half a week in its own bucket', () => {
    const fresh = quota({ weeklyOnly: true, weekUsed: 0, weekHours: 100,
      extra: [window('modelWeekly:Fable', 0, 100)] })
    expect(rank(fresh, 0, 'opus')).toMatchObject({ state: 'ready', remaining: 5 })
    expect(rank(fresh, 0, 'fable')).toMatchObject({ state: 'ready', remaining: 5 })
    // 已用 Fable 2 份时只剩 3 份专属余量；其他模型仍有自己的一半。
    const used = quota({ weeklyOnly: true, weekUsed: 20, weekHours: 100,
      extra: [window('modelWeekly:Fable', 40, 100)] })
    expect(rank(used, 0, 'opus')).toMatchObject({ remaining: 5 })
    expect(rank(used, 0, 'fable')).toMatchObject({ remaining: 3 })
    expect(rank(used, 1, 'fable').score).toBeCloseTo(1.5)
  })

  test('the dedicated week can be the binding window', () => {
    const snapshot = quota({ weeklyOnly: true, weekUsed: 10, weekHours: 24,
      extra: [window('modelWeekly:Fable', 95, 24)] })
    expect(rank(snapshot, 0, 'fable')).toMatchObject({ remaining: 0.25 })
    // 距重置 24 小时已释放预留，Opus 只看总周剩余。
    expect(rank(snapshot)).toMatchObject({ remaining: 9 })
  })

  test.each(['pro', 'max', 'team', 'enterprise', 'unknown-plan'])(
    'all subscription types use the same capacities: %s', subscriptionType => {
      const snapshot = claudeUsageSnapshot({ subscription_type: subscriptionType, rate_limits_available: true, rate_limits: {
        five_hour: { utilization: 0, resets_at: after(3).toISOString() },
        seven_day: { utilization: 0, resets_at: after(168).toISOString() },
        model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: after(168).toISOString() }],
      } })
      expect(rank(snapshot, 0, 'fable')).toMatchObject({ remaining: 1, score: 1 })
      expect(rank(snapshot)).toMatchObject({ remaining: 1, score: 1 })
    })

  test('missing or ambiguous Fable quota cannot participate', () => {
    expect(rank(quota({ weekUsed: 0 }), 0, 'fable')).toMatchObject({ state: 'miss', score: null })
    const ambiguous = quota({ extra: [window('modelWeekly:Fable', 30, 20), window('modelWeekly:Fable 5', 40, 30)] })
    expect(rank(ambiguous, 0, 'fable')).toMatchObject({ state: 'miss', score: null })
    expect(rank(ambiguous).state).toBe('ready')
  })

  test('Fable-specific exhaustion and reset errors do not restrict Opus', () => {
    const snapshot = quota({ extra: [{ ...window('modelWeekly:Fable', 100, 4), resetsAt: null }] })
    expect(rank(snapshot).state).toBe('ready')
    expect(rank(snapshot, 0, 'fable').state).toBe('exhausted')
    // 专属额度已用完时没有可预留的部分，其他模型可以用掉整周剩余。
    const spent = quota({ weeklyOnly: true, weekUsed: 40, weekHours: 100,
      extra: [window('modelWeekly:Fable', 100, 100)] })
    expect(rank(spent, 0, 'opus')).toMatchObject({ state: 'ready', remaining: 6 })
  })
})

describe('Fable reserve for other models', () => {
  const weeklyOnly = (weekUsed: number, weekHours: number, fablePercent?: number) => quota({
    weeklyOnly: true, weekUsed, weekHours,
    ...(fablePercent === undefined ? {} : { extra: [window('modelWeekly:Fable', fablePercent, weekHours)] }),
  })

  test('other models keep the unused half week for Fable before the final two days', () => {
    const fresh = weeklyOnly(0, 100, 0)
    expect(rank(fresh, 0, 'opus')).toMatchObject({ state: 'ready', remaining: 5 })
    expect(rank(fresh, 0, 'fable')).toMatchObject({ state: 'ready', remaining: 5 })
    // 预留量随 Fable 已用额度减少，其他模型仍只多出自己的一半。
    const spent = weeklyOnly(20, 100, 40)
    expect(rank(spent, 0, 'opus')).toMatchObject({ remaining: 5 })
    expect(rank(spent, 0, 'fable')).toMatchObject({ remaining: 3 })
  })

  test('the last two days release the reserve instead of losing the week', () => {
    expect(rank(weeklyOnly(60, 100, 0), 0, 'opus')).toMatchObject({ state: 'exhausted',
      reason: '周额度已为 Fable 预留' })
    expect(rank(weeklyOnly(60, 48, 0), 0, 'opus')).toMatchObject({ state: 'ready', remaining: 4 })
    expect(rank(weeklyOnly(60, 47.9, 0), 0, 'opus')).toMatchObject({ state: 'ready', remaining: 4 })
  })

  test('a missing Fable bucket never fabricates a reserve', () => {
    expect(rank(weeklyOnly(60, 100), 0, 'opus')).toMatchObject({ state: 'ready', remaining: 4 })
  })

  test('an unusable Fable bucket blocks other models only while the reserve applies', () => {
    const ambiguous = quota({ weeklyOnly: true, weekUsed: 40, weekHours: 100,
      extra: [window('modelWeekly:Fable', 20, 100), window('modelWeekly:Fable 5', 20, 100)] })
    expect(rank(ambiguous, 0, 'opus')).toMatchObject({ state: 'miss', reason: 'Fable 周额度归属 MISS' })
    const late = quota({ weeklyOnly: true, weekUsed: 40, weekHours: 47,
      extra: [window('modelWeekly:Fable', 20, 47), window('modelWeekly:Fable 5', 20, 47)] })
    expect(rank(late, 0, 'opus')).toMatchObject({ state: 'ready', remaining: 6 })
    const invalid = quota({ weeklyOnly: true, weekUsed: 40, weekHours: 100,
      extra: [window('modelWeekly:Fable', null, 100)] })
    expect(rank(invalid, 0, 'opus')).toMatchObject({ state: 'miss', reason: 'Fable 周额度 MISS' })
  })

  test('the five-hour window still constrains a reserved account', () => {
    const snapshot = quota({ shortUsed: 90, weekUsed: 0, weekHours: 100,
      extra: [window('modelWeekly:Fable', 0, 100)] })
    expect(rank(snapshot, 0, 'opus')).toMatchObject({ state: 'ready', remaining: 0.1 })
  })
})

describe('Claude actual quota errors remain excluded', () => {
  test.each([NaN, Infinity, -Infinity])('invalid current time %s stays MISS', now => {
    expect(rankClaudeQuota(quota(), 'opus', now)).toMatchObject({ state: 'miss', score: null })
  })
  test.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])('invalid active count %s stays MISS', count => {
    expect(rank(quota(), count)).toMatchObject({ state: 'miss', score: null, reason: '活跃会话数 MISS' })
  })

  test('missing snapshots, failures and missing or repeated weekly windows cannot participate', () => {
    expect(rank(undefined).state).toBe('miss')
    expect(rank({ state: 'network', windows: [], reason: 'offline' })).toMatchObject({ state: 'miss', reason: 'offline' })
    expect(rank({ state: 'ok', windows: [] }).state).toBe('miss')
    const noWeek = quota({ extra: [window('modelWeekly:Fable', 20, 2)] })
    noWeek.windows = noWeek.windows.filter(item => item.kind !== 'weekly')
    expect(rank(noWeek, 0, 'fable').state).toBe('miss')
    expect(rank(quota({ extra: [window('weekly', 0, 100)] })).state).toBe('miss')
  })

  test.each(['fiveHour', 'weekly', 'seven_day_oauth_apps', 'modelWeekly:Fable'])(
    'genuinely exhausted %s never becomes available again', kind => {
      const snapshot = quota({ weekHours: 0.1,
        extra: [window('modelWeekly:Fable', 20, 0.2), window('seven_day_oauth_apps', 20, 0.3)] })
      snapshot.windows.find(item => item.kind === kind)!.percent = 100
      expect(rank(snapshot, 100, 'fable')).toMatchObject({ state: 'exhausted', score: null })
    })

  test('an unreadable window keeps the account MISS even when an earlier window is exhausted', () => {
    // Only accounts whose every window is known may count as clearly exhausted for the
    // all-exhausted fallback.
    const snapshot = quota({ shortUsed: 100 })
    snapshot.windows.find(item => item.kind === 'weekly')!.percent = null
    expect(rank(snapshot)).toMatchObject({ state: 'miss', score: null })
    expect(rank(quota({ shortUsed: 100 }))).toMatchObject({ state: 'exhausted', score: null })
  })

  test.each(['fiveHour', 'weekly', 'seven_day_oauth_apps', 'modelWeekly:Fable'])(
    'invalid %s percentages and reset times stay MISS rather than becoming headroom', kind => {
      for (const percent of [null, NaN, Infinity, -1, 101]) {
        const snapshot = quota({ extra: [window('seven_day_oauth_apps', 20, 20), window('modelWeekly:Fable', 20, 30)] })
        snapshot.windows.find(item => item.kind === kind)!.percent = percent
        expect(rank(snapshot, 0, 'fable')).toMatchObject({ state: 'miss', score: null })
      }
      for (const resetsAt of [null, new Date(NaN), new Date(0), after(-1), after(0)]) {
        const snapshot = quota({ extra: [window('seven_day_oauth_apps', 0, 20), window('modelWeekly:Fable', 0, 30)] })
        const target = snapshot.windows.find(item => item.kind === kind)!
        target.percent = 0; target.resetsAt = resetsAt
        expect(rank(snapshot, 0, 'fable')).toMatchObject({ state: 'miss', score: null })
      }
    })
})
