import { describe, expect, test } from 'bun:test'
import { compareClaudeQuota, rankClaudeQuota, type ClaudeQuotaRank } from './claude-quota'
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
/** The account startup selection launches on: the first ready rank in comparator order. */
const winner = (ranks: Record<string, ClaudeQuotaRank>): string => Object.entries(ranks)
  .filter(([, item]) => item.state === 'ready')
  .map(([id, item]) => ({ ...item, id })).sort(compareClaudeQuota)[0]!.id
/** Launches one session after another; each lands on the winner and adds an active session there. */
function launches(snapshots: Record<string, UsageSnapshotUnified>, count: number, model = 'opus'): string[] {
  const load: Record<string, number> = {}
  const order: string[] = []
  for (let i = 0; i < count; i++) {
    const id = winner(Object.fromEntries(Object.entries(snapshots)
      .map(([key, snapshot]) => [key, rank(snapshot, load[key] ?? 0, model)])))
    order.push(id)
    load[id] = (load[id] ?? 0) + 1
  }
  return order
}

describe('Claude remaining units and per-session spacing', () => {
  test.each([0, null])('an unstarted native short window counts as a full unit', utilization => {
    const snapshot = claudeUsageSnapshot({ subscription_type: 'max', rate_limits_available: true, rate_limits: {
      five_hour: { utilization, resets_at: null },
      seven_day: { utilization: 20, resets_at: new Date(Date.now() + 24 * 3_600_000).toISOString() },
    } })
    const now = snapshot.fetchedAt!
    const original = structuredClone(snapshot)
    // 一个完整 5h 窗口按每 5 小时 1 份计，即 0.2 份/小时。
    expect(rankClaudeQuota(snapshot, 'opus', now)).toMatchObject({
      state: 'ready', remaining: 1, score: 0.2, pace: 0.2, fiveHourRemaining: 1, activeSessions: 0 })
    expect(rankClaudeQuota(snapshot, 'opus', now + 5 * 3_600_000).state).toBe('miss')
    expect(snapshot).toEqual(original)
  })

  test('a full week is ten units and the tightest window is the account remainder', () => {
    const fresh = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 0, weekHours: 168 }))
    expect(fresh).toMatchObject({ state: 'ready', remaining: 1, fiveHourRemaining: 1, activeSessions: 0 })
    expect(fresh.score).toBe(0.2)
    expect(rank(quota({ shortUsed: 20, weekUsed: 30 }))).toMatchObject({ remaining: 0.8, score: 0.2 })
    // 有 5h 窗口的账号逐窗花周额度，周额度须够按节奏用一天：剩 0.5 份按 24 小时折算。
    const weekBound = rank(quota({ shortUsed: 0, weekUsed: 95 }))
    expect(weekBound.remaining).toBe(0.5)
    expect(weekBound.score).toBeCloseTo(0.5 / 24, 10)
  })

  test('the per-session pace shrinks with every active session and slows for a window spent ahead of pace', () => {
    // 半小时后重置、还剩 0.4 份：至少按 1 小时折算为 0.4 份/小时，封顶后与满窗一样计 0.2。
    const snapshot = quota({ shortUsed: 60, shortHours: 0.5, weekUsed: 0, weekHours: 168 })
    expect(rank(snapshot)).toMatchObject({ state: 'ready', remaining: 0.4, score: 0.2 })
    expect(rank(snapshot).pace).toBeCloseTo(0.4, 10)
    expect(rank(snapshot, 1).score).toBeCloseTo(0.1, 10)
    expect(rank(snapshot, 3).score).toBeCloseTo(0.05, 10)
    // 封顶前节奏是账号自己的，不随会话数变化。
    expect(rank(snapshot, 3).pace).toBeCloseTo(0.4, 10)
    // 同样 0.4 份要撑 4.5 小时，只有 0.4/4.5 份/小时。
    expect(rank(quota({ shortUsed: 60, shortHours: 4.5, weekUsed: 0, weekHours: 168 })).score).toBeCloseTo(0.4 / 4.5, 10)
  })

  test('every subscription type uses the same capacity and OAuth or model buckets still constrain', () => {
    for (const kind of ['seven_day_oauth_apps', 'seven_day_opus']) {
      const result = rank(quota({ extra: [window(kind, 99.9, 24)] }))
      expect(result.state).toBe('ready')
      expect(result.remaining).toBeCloseTo(0.01, 10)
      expect(result.score).toBeCloseTo(0.01 / 24, 10)
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

  test('a higher score wins; ties prefer the least busy, then the faster uncapped pace, then the earlier reset, then the largest remainder', () => {
    const roomy = rank(quota({ shortUsed: 0 }))
    const tight = rank(quota({ shortUsed: 90 }))
    expect(compareClaudeQuota(roomy, tight)).toBeLessThan(0)
    const busy = { ...roomy, activeSessions: 3, score: roomy.score! / 4 }
    expect(compareClaudeQuota(roomy, busy)).toBeLessThan(0)
    const tied = { ...roomy, activeSessions: 1, score: roomy.score }
    // 分数先于一切决胜项：分数略低者即使封顶前节奏更高也排后。
    expect(compareClaudeQuota({ ...tied, score: tied.score! - 0.01, pace: tied.pace! + 1 }, tied)).toBeGreaterThan(0)
    // 同分时会话少者优先，即使它封顶前节奏更低。
    expect(compareClaudeQuota({ ...tied, activeSessions: 2, pace: tied.pace! + 1 }, tied)).toBeGreaterThan(0)
    // 同分同负载时封顶前节奏高（额度更需要尽快花掉）者优先，即使它更晚到期。
    expect(compareClaudeQuota({ ...tied, pace: tied.pace! + 0.1, expiresAt: tied.expiresAt! + 1 }, tied)).toBeLessThan(0)
    // 节奏也相同时先花更快作废的窗口，即使它余量更小。
    expect(compareClaudeQuota({ ...tied, expiresAt: tied.expiresAt! - 1, remaining: tied.remaining! - 0.5 }, tied)).toBeLessThan(0)
    expect(compareClaudeQuota({ ...tied, remaining: tied.remaining! - 0.1 }, tied)).toBeGreaterThan(0)
    // 5h 余量不单独参与排序：其余都相同时保持输入顺序。
    expect(compareClaudeQuota({ ...tied, fiveHourRemaining: 0.9 }, tied)).toBe(0)
    expect(compareClaudeQuota(roomy, { ...roomy })).toBe(0)
    const first = { ...roomy, id: 'default' }, second = { ...roomy, id: 'second' }
    expect([second, first].sort(compareClaudeQuota)).toEqual([second, first])
    // 真实快照：两者每会话都是 0.1，空闲的那个优先，即使另一个的周额度快作废。
    const busyExpiring = rank(quota({ weeklyOnly: true, weekUsed: 0, weekHours: 10 }), 1)
    const idleFar = rank(quota({ weeklyOnly: true, weekUsed: 0, weekHours: 100 }))
    expect(busyExpiring.score).toBe(idleFar.score)
    expect(busyExpiring.pace!).toBeGreaterThan(idleFar.pace!)
    expect(winner({ busyExpiring, idleFar })).toBe('idleFar')
  })
})

describe('accounts without a five-hour window', () => {
  test('weekly-only quota is schedulable and carries the model weekly reset', () => {
    const result = rank(quota({ weeklyOnly: true, weekUsed: 30, weekHours: 24 }))
    expect(result).toMatchObject({ state: 'ready', hasFiveHour: false, remaining: 7, score: 0.2,
      expiresAt: after(24).getTime() })
    // 周额度可随时花，按到周重置为止的节奏计（7 份撑 24 小时）；每次启动最多按满窗的 0.2 计。
    expect(result.pace).toBeCloseTo(7 / 24, 10)
    expect(result.fiveHourRemaining).toBeUndefined()
  })

  test('a five-hour window no longer outranks weekly-only accounts by itself; pace decides', () => {
    // 5h 账号只剩 1% 窗口、1 小时后重置；无 5h 账号整周未用且 2 小时后作废（封顶为满窗）。旧规则仍让 5h 账号整组优先。
    const withShort = rank(quota({ shortUsed: 99, shortHours: 1, weekUsed: 0, weekHours: 168 }))
    const weeklyOnly = rank(quota({ weeklyOnly: true, weekUsed: 0, weekHours: 2 }))
    expect(withShort.hasFiveHour).toBe(true)
    expect(withShort.score).toBeCloseTo(0.01, 10)
    expect(weeklyOnly).toMatchObject({ score: 0.2, pace: 5 })
    expect(compareClaudeQuota(weeklyOnly, withShort)).toBeLessThan(0)
    expect(compareClaudeQuota(withShort, weeklyOnly)).toBeGreaterThan(0)
    // 跟得上节奏的 5h 窗口（0.2 份/小时）仍高于离重置还远的整周（10/168 份/小时）。
    const keepsPace = rank(quota({ shortUsed: 0, weekUsed: 0, weekHours: 168 }))
    const farWeek = rank(quota({ weeklyOnly: true, weekUsed: 0, weekHours: 168 }))
    expect(compareClaudeQuota(keepsPace, farWeek)).toBeLessThan(0)
  })

  test('weekly-only accounts are paced to their weekly reset, not ordered by reset time alone', () => {
    // 快作废且余量不少的周额度节奏高：2 份撑 8 小时（0.25，封顶为 0.2），高于 10 份撑 120 小时。
    const soon = rank(quota({ weeklyOnly: true, weekUsed: 80, weekHours: 8 }))
    const later = rank(quota({ weeklyOnly: true, weekUsed: 0, weekHours: 120 }))
    expect(soon).toMatchObject({ score: 0.2, pace: 0.25 })
    expect(later.score).toBeCloseTo(10 / 120, 10)
    expect(compareClaudeQuota(soon, later)).toBeLessThan(0)
    // 先重置但几乎用光的周额度不再优先：0.1 份撑 8 小时。
    const nearlySpent = rank(quota({ weeklyOnly: true, weekUsed: 99, weekHours: 8 }))
    expect(nearlySpent.expiresAt!).toBeLessThan(later.expiresAt!)
    expect(compareClaudeQuota(later, nearlySpent)).toBeLessThan(0)
    // 到期时间相同时余量大的节奏高；两者都封顶为 0.2 时由封顶前节奏决胜。
    const roomier = rank(quota({ weeklyOnly: true, weekUsed: 20, weekHours: 8 }))
    const tighter = rank(quota({ weeklyOnly: true, weekUsed: 80, weekHours: 8 }))
    expect(roomier.score).toBe(tighter.score)
    expect(compareClaudeQuota(roomier, tighter)).toBeLessThan(0)
  })

  test('weekly-only exhaustion and missing values still exclude the account', () => {
    expect(rank(quota({ weeklyOnly: true, weekUsed: 100 })).state).toBe('exhausted')
    const noReset = quota({ weeklyOnly: true })
    noReset.windows[0]!.resetsAt = null
    expect(rank(noReset).state).toBe('miss')
  })

  test('five-hour windows that keep pace tie on score; the faster uncapped pace goes first, then the earlier reset', () => {
    // 1 小时后重置的半个窗口与 4.5 小时后重置的整窗都跟得上每 5 小时 1 份的节奏。
    const earlier = rank(quota({ shortUsed: 50, shortHours: 1, weekUsed: 0, weekHours: 168 }))
    const roomier = rank(quota({ shortUsed: 0, shortHours: 4.5, weekUsed: 0, weekHours: 168 }))
    expect(earlier.score).toBe(0.2)
    expect(roomier.score).toBe(0.2)
    // 封顶前 earlier 受周额度约束为 10/24，roomier 为 1/4.5；旧规则按余量份额先给 roomier。
    expect(earlier.pace).toBeCloseTo(10 / 24, 10)
    expect(roomier.pace).toBeCloseTo(1 / 4.5, 10)
    expect(compareClaudeQuota(earlier, roomier)).toBeLessThan(0)
    expect(compareClaudeQuota(roomier, earlier)).toBeGreaterThan(0)
    // 节奏也相同时先花更快作废的窗口。
    expect(compareClaudeQuota({ ...roomier, expiresAt: earlier.expiresAt! }, roomier)).toBeLessThan(0)
  })
})

describe('one pace score replaces the absolute group order', () => {
  test('a nearly spent five-hour window loses to a roomy weekly-only account', () => {
    // 5h 窗口只剩 3%、4 小时后重置：0.03/4 份/小时；无 5h 账号剩 9 份、120 小时后重置：9/120。
    const fiveHour = rank(quota({ shortUsed: 97, shortHours: 4, weekUsed: 30, weekHours: 120 }))
    const weeklyOnly = rank(quota({ weeklyOnly: true, weekUsed: 10, weekHours: 120 }))
    expect(fiveHour.score).toBeCloseTo(0.0075, 10)
    expect(fiveHour.pace).toBeCloseTo(0.0075, 10)
    expect(weeklyOnly.score).toBeCloseTo(0.075, 10)
    expect(weeklyOnly.pace).toBeCloseTo(0.075, 10)
    expect(winner({ fiveHour, weeklyOnly })).toBe('weeklyOnly')
  })

  test('weekly-only accounts are not ordered by reset time alone: room and load count', () => {
    const fresh = rank(quota({ weeklyOnly: true, weekUsed: 0, weekHours: 146 }))
    // 早 2 小时重置，但只剩 5% 且已有 6 个活跃会话。
    const spentAndBusy = rank(quota({ weeklyOnly: true, weekUsed: 95, weekHours: 144 }), 6)
    expect(spentAndBusy.expiresAt!).toBeLessThan(fresh.expiresAt!)
    expect(spentAndBusy.pace).toBeCloseTo(0.5 / 144, 10)
    expect(spentAndBusy.score).toBeCloseTo(0.5 / 144 / 7, 10)
    expect(fresh.score).toBeCloseTo(10 / 146, 10)
    expect(winner({ spentAndBusy, fresh })).toBe('fresh')
    // 余量少或负载高单独都足以让先重置的账号让位；两者都相同时先重置的节奏更高。
    expect(winner({ spent: rank(quota({ weeklyOnly: true, weekUsed: 95, weekHours: 144 })), fresh })).toBe('fresh')
    expect(winner({ busy: rank(quota({ weeklyOnly: true, weekUsed: 0, weekHours: 144 }), 6), fresh })).toBe('fresh')
    expect(winner({ idle: rank(quota({ weeklyOnly: true, weekUsed: 0, weekHours: 144 })), fresh })).toBe('idle')
  })

  test('a five-hour window resetting soon counts as a full window and beats a slower one', () => {
    // 9 分钟后整窗重置、剩 50%：至少按 1 小时折算仍有 0.5，封顶为满窗 0.2；封顶前受周额度 7/24 约束。
    // 4.5 小时后才重置、剩 60%：0.6/4.5。
    const resetsSoon = rank(quota({ shortUsed: 50, shortHours: 0.15, weekUsed: 30, weekHours: 120 }))
    const resetsLate = rank(quota({ shortUsed: 40, shortHours: 4.5, weekUsed: 30, weekHours: 120 }))
    expect(resetsSoon.score).toBe(0.2)
    expect(resetsSoon.score).toBe(rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 30, weekHours: 120 })).score)
    expect(resetsSoon.pace).toBeCloseTo(7 / 24, 10)
    expect(resetsLate.score).toBeCloseTo(0.6 / 4.5, 10)
    expect(winner({ resetsLate, resetsSoon })).toBe('resetsSoon')
  })

  test('a weekly-only week about to expire with plenty left ties a fresh five-hour account and wins on pace', () => {
    // 剩 5 份、10 小时后作废：0.5 份/小时，封顶后与满窗 5h 账号同为 0.2，封顶前节奏更高者先花。
    const expiring = rank(quota({ weeklyOnly: true, weekUsed: 50, weekHours: 10 }))
    const fiveHour = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 0, weekHours: 160 }))
    expect(expiring).toMatchObject({ score: 0.2, pace: 0.5 })
    expect(fiveHour).toMatchObject({ score: 0.2, pace: 0.2 })
    expect(winner({ fiveHour, expiring })).toBe('expiring')
  })

  test('a five-hour account whose week is nearly spent yields to a fresh weekly-only account', () => {
    // 周额度只剩 0.2 份，须够按节奏用一天：按 24 小时折算为 0.2/24，低于整周未用账号的 10/160。
    const weekSpent = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 98, weekHours: 100 }))
    const weeklyOnly = rank(quota({ weeklyOnly: true, weekUsed: 0, weekHours: 160 }))
    expect(weekSpent.score).toBeCloseTo(0.2 / 24, 10)
    expect(weeklyOnly.score).toBeCloseTo(0.0625, 10)
    expect(winner({ weekSpent, weeklyOnly })).toBe('weeklyOnly')
  })

  test('nine launches alternate between two five-hour accounts until a far weekly-only week paces higher', () => {
    // 两个 5h 账号同为 0.2 份/小时，同分同负载时封顶前节奏更高的 5h-A（1/4.9）先接；
    // 各有 3 个会话后每会话 0.05 低于 weekly-C 的 0.0625，第 7 次才落到 weekly-C。
    expect(launches({
      '5h-A': quota({ shortUsed: 0, shortHours: 4.9, weekUsed: 20, weekHours: 100 }),
      '5h-B': quota({ shortUsed: 0, shortHours: 5, weekUsed: 20, weekHours: 100 }),
      'weekly-C': quota({ weeklyOnly: true, weekUsed: 0, weekHours: 160 }),
    }, 9)).toEqual(['5h-A', '5h-B', '5h-A', '5h-B', '5h-A', '5h-B', 'weekly-C', '5h-A', '5h-B'])
  })
})

describe('one full window per five hours caps every launch', () => {
  test('a weekly-only week about to reset rotates with fresh five-hour accounts instead of absorbing launches', () => {
    // W 剩 5 份、2 小时后重置：封顶为 0.2 并凭封顶前节奏先接，此后与两个全新 5h 账号轮流；不封顶时 W 连吃 12 个。
    const fresh = quota({ shortUsed: 0, shortHours: 5, weekUsed: 20, weekHours: 100 })
    expect(launches({ W: quota({ weeklyOnly: true, weekUsed: 50, weekHours: 2 }), F1: fresh, F2: fresh,
      WO: quota({ weeklyOnly: true, weekUsed: 0, weekHours: 160 }) }, 16))
      .toEqual(['W', 'F1', 'F2', 'W', 'F1', 'F2', 'W', 'F1', 'F2', 'WO', 'W', 'F1', 'F2', 'W', 'F1', 'F2'])
  })

  test('an expiring weekly-only account takes at most one launch before a fresh five-hour account gets one', () => {
    const fresh = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 20, weekHours: 100 }))
    const taken = ([[0, 48], [0, 24], [0, 10], [0, 5], [0, 1], [50, 10], [50, 2], [90, 1], [95, 0.25], [99, 0.05]] as const)
      .map(([weekUsed, weekHours]) => {
        const expiring = quota({ weeklyOnly: true, weekUsed, weekHours })
        let sessions = 0
        while (sessions < 100 && winner({ expiring: rank(expiring, sessions), fresh }) === 'expiring') sessions++
        return sessions
      })
    // 只剩 0.1 份、3 分钟后重置的周额度按 1 小时折算为 0.1，连第一个会话也让给满窗。
    expect(taken).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0])
  })
})

describe('bursts and a five-hour account\'s week', () => {
  test('every window is paced over at least an hour, and a five-hour account\'s week over at most a day', () => {
    // 5h 窗口剩 0.05 份、15 分钟后重置：按 1 小时折算为 0.05，而不是 0.2。
    expect(rank(quota({ shortUsed: 95, shortHours: 0.25, weekUsed: 20, weekHours: 100 })).pace).toBeCloseTo(0.05, 10)
    // 无 5h 账号剩 0.5 份、15 分钟后重置：0.5 而不是 2。
    expect(rank(quota({ weeklyOnly: true, weekUsed: 95, weekHours: 0.25 })).pace).toBeCloseTo(0.5, 10)
    // 5h 账号的周额度：30 分钟后重置剩 0.1 份按 1 小时；150 小时后重置剩 1 份按 24 小时。
    expect(rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 99, weekHours: 0.5 })).pace).toBeCloseTo(0.1, 10)
    expect(rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 90, weekHours: 150 })).pace).toBeCloseTo(1 / 24, 10)
    // 无 5h 账号的周额度按到重置为止的全部时长：1 份撑 150 小时。
    expect(rank(quota({ weeklyOnly: true, weekUsed: 90, weekHours: 150 })).pace).toBeCloseTo(1 / 150, 10)
  })

  test('a nearly spent window resetting within the hour loses to a fresh window', () => {
    const fresh = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 20, weekHours: 100 }))
    // 剩 0.05 份 15 分钟后重置、剩 0.1 份 30 分钟后重置：不再当作满窗，否则几分钟内就会撞墙。
    for (const [shortUsed, shortHours, score] of [[95, 0.25, 0.05], [90, 0.5, 0.1]] as const) {
      const resetsSoon = rank(quota({ shortUsed, shortHours, weekUsed: 20, weekHours: 100 }))
      expect(resetsSoon.score).toBeCloseTo(score, 10)
      expect(winner({ resetsSoon, fresh })).toBe('fresh')
    }
    // 剩 0.2 份、1 小时后重置正好跟上满窗节奏：同分同节奏时先花先到期的窗口。
    const onPace = rank(quota({ shortUsed: 80, shortHours: 1, weekUsed: 20, weekHours: 100 }))
    expect(onPace).toMatchObject({ score: 0.2, pace: 0.2 })
    expect(winner({ fresh, onPace })).toBe('onPace')
  })

  test('a five-hour account whose week will not last a day loses to a fresh account in every weekly bucket', () => {
    const fresh = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 0, weekHours: 150 }))
    expect(fresh.score).toBe(0.2)
    // 总周、Opus 专属周、OAuth 周各只剩 1 份、150 小时后重置：按 24 小时折算为 1/24，不再与全新账号同分。
    for (const nearlySpent of [
      rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 90, weekHours: 150 })),
      rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 10, weekHours: 150, extra: [window('seven_day_opus', 90, 150)] })),
      rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 10, weekHours: 150, extra: [window('seven_day_oauth_apps', 90, 150)] })),
    ]) {
      expect(nearlySpent.score).toBeCloseTo(1 / 24, 10)
      expect(winner({ nearlySpent, fresh })).toBe('fresh')
    }
    // Fable 启动：专属周只有 5 份，已用 80% 即只剩 1 份。
    const fableSpent = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 40, weekHours: 150,
      extra: [window('modelWeekly:Fable', 80, 150)] }), 0, 'fable')
    const fableFresh = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 0, weekHours: 150,
      extra: [window('modelWeekly:Fable', 0, 150)] }), 0, 'fable')
    expect(fableSpent.score).toBeCloseTo(1 / 24, 10)
    expect(winner({ fableSpent, fableFresh })).toBe('fableFresh')
  })

  test('a five-hour account whose week will not last a day shares launches with a fresh weekly-only account', () => {
    // 1.1 份周额度撑 150 小时：按 24 小时折算为 1.1/24，低于整周未用的无 5h 账号 10/160；只看 5 小时时 6 个会话全落在 A。
    expect(launches({ A: quota({ shortUsed: 0, shortHours: 5, weekUsed: 89, weekHours: 150 }),
      WO: quota({ weeklyOnly: true, weekUsed: 0, weekHours: 160 }) }, 6)).toEqual(['WO', 'A', 'WO', 'A', 'WO', 'WO'])
  })
})

describe('Fable shared and dedicated weekly capacities', () => {
  test('Fable keeps half a week in its own bucket', () => {
    const fresh = quota({ weeklyOnly: true, weekUsed: 0, weekHours: 100,
      extra: [window('modelWeekly:Fable', 0, 100)] })
    // 其他模型：自己的一半 5 份，加上 Fable 未用那一半的 1/4（1.25 份）。
    expect(rank(fresh, 0, 'opus')).toMatchObject({ state: 'ready', remaining: 6.25 })
    expect(rank(fresh, 0, 'fable')).toMatchObject({ state: 'ready', remaining: 5 })
    // 已用 Fable 2 份时只剩 3 份专属余量；其他模型仍有自己的 5 份，外加剩余 3 份预留的 1/4。
    const used = quota({ weeklyOnly: true, weekUsed: 20, weekHours: 100,
      extra: [window('modelWeekly:Fable', 40, 100)] })
    expect(rank(used, 0, 'opus')).toMatchObject({ remaining: 5.75 })
    expect(rank(used, 0, 'fable')).toMatchObject({ remaining: 3 })
    // 3 份专属余量撑到 100 小时后的重置，由 2 个会话分摊。
    expect(rank(used, 1, 'fable').score).toBeCloseTo(3 / 100 / 2, 10)
  })

  test('the dedicated week can be the binding window', () => {
    const snapshot = quota({ weeklyOnly: true, weekUsed: 10, weekHours: 24,
      extra: [window('modelWeekly:Fable', 95, 24)] })
    expect(rank(snapshot, 0, 'fable')).toMatchObject({ remaining: 0.25 })
    // 距重置 24 小时已释放预留，Opus 只看总周剩余。
    expect(rank(snapshot)).toMatchObject({ remaining: 9 })
  })

  test('Fable is paced by its own bucket, over at most a day on a five-hour account', () => {
    // Fable 专属周剩 3 份、100 小时后重置：按 24 小时折算为 0.125，低于 5h 窗口与总周。
    const snapshot = quota({ shortUsed: 10, shortHours: 4, weekUsed: 30, weekHours: 100,
      extra: [window('modelWeekly:Fable', 40, 100)] })
    const result = rank(snapshot, 0, 'fable')
    expect(result).toMatchObject({ state: 'ready', remaining: 0.9 })
    expect(result.score).toBeCloseTo(3 / 24, 10)
    expect(result.pace).toBeCloseTo(3 / 24, 10)
  })

  test.each(['pro', 'max', 'team', 'enterprise', 'unknown-plan'])(
    'all subscription types use the same capacities: %s', subscriptionType => {
      const snapshot = claudeUsageSnapshot({ subscription_type: subscriptionType, rate_limits_available: true, rate_limits: {
        five_hour: { utilization: 0, resets_at: after(3).toISOString() },
        seven_day: { utilization: 0, resets_at: after(168).toISOString() },
        model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: after(168).toISOString() }],
      } })
      expect(rank(snapshot, 0, 'fable')).toMatchObject({ remaining: 1, score: 0.2 })
      expect(rank(snapshot)).toMatchObject({ remaining: 1, score: 0.2 })
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
  const onlyReserveLeft = () => quota({ shortUsed: 0, shortHours: 5, weekUsed: 50, weekHours: 100,
    extra: [window('modelWeekly:Fable', 0, 100)] })

  test('other models count Fable\'s unused half week at a quarter before the final two days', () => {
    const fresh = weeklyOnly(0, 100, 0)
    // 自己的 5 份全额，Fable 未用的 5 份按 1/4。
    expect(rank(fresh, 0, 'opus')).toMatchObject({ state: 'ready', remaining: 6.25 })
    expect(rank(fresh, 0, 'opus').score).toBeCloseTo(6.25 / 100, 10)
    expect(rank(fresh, 0, 'fable')).toMatchObject({ state: 'ready', remaining: 5 })
    // 预留量随 Fable 已用额度减少：Fable 已用 40% 时预留 3 份，其他模型 5 + 3/4。
    const spent = weeklyOnly(20, 100, 40)
    expect(rank(spent, 0, 'opus')).toMatchObject({ remaining: 5.75 })
    expect(rank(spent, 0, 'fable')).toMatchObject({ remaining: 3 })
  })

  test('a week left with only Fable\'s reserve stays ready at a quarter of its value until the last two days release it', () => {
    // 预留生效时周额度只剩留给 Fable 的那 4 份：不判耗尽，按 1/4 计为 1 份、100 小时。
    const onlyReserve = rank(weeklyOnly(60, 100, 0), 0, 'opus')
    expect(onlyReserve).toMatchObject({ state: 'ready', remaining: 1 })
    expect(onlyReserve.score).toBeCloseTo(1 / 100, 10)
    expect(onlyReserve).not.toHaveProperty('reserved')
    // 距周重置 2 天内释放预留，4 份全额计入。
    expect(rank(weeklyOnly(60, 48, 0), 0, 'opus')).toMatchObject({ state: 'ready', remaining: 4 })
    expect(rank(weeklyOnly(60, 47.9, 0), 0, 'opus')).toMatchObject({ state: 'ready', remaining: 4 })
  })

  test('an account whose week holds only Fable\'s reserve is ready and paced on a quarter of that reserve', () => {
    // 周额度只用了 55%、从没用过 Fable：剩下 4.5 份全是预留，按 1/4 计为 1.125 份，按 24 小时折算。
    const snapshot = quota({ shortUsed: 0, shortHours: 5, weekUsed: 55, weekHours: 120,
      extra: [window('modelWeekly:Fable', 0, 120)] })
    const result = rank(snapshot, 0, 'opus')
    expect(result).toMatchObject({ state: 'ready', remaining: 1, hasFiveHour: true, expiresAt: after(5).getTime() })
    expect(result.score).toBeCloseTo(1.125 / 24, 10)
    expect(result.reason).toBeUndefined()
    expect(result.recoversAt).toBeUndefined()
    // Fable 自己不打折：4.5 份总周按 24 小时折算。
    const forFable = rank(snapshot, 0, 'fable')
    expect(forFable).toMatchObject({ state: 'ready', remaining: 1 })
    expect(forFable.score).toBeCloseTo(4.5 / 24, 10)
  })

  test('an account whose week holds only Fable\'s reserve stays launchable beside a truly exhausted one', () => {
    const spent = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 100, weekHours: 120 }))
    const onlyReserve = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 60, weekHours: 120,
      extra: [window('modelWeekly:Fable', 0, 120)] }))
    expect(spent).toMatchObject({ state: 'exhausted', recoversAt: after(120).getTime() })
    // 剩下 4 份全是预留，按 1/4 计为 1 份，按 24 小时折算。
    expect(onlyReserve).toMatchObject({ state: 'ready', remaining: 1 })
    expect(onlyReserve.score).toBeCloseTo(1 / 24, 10)
    expect(winner({ spent, onlyReserve })).toBe('onlyReserve')
  })

  test('the reserve discount has no cliff where the unreserved week reaches zero', () => {
    // 扣预留后恰好为 0：5 份预留按 1/4 计 1.25；多出 0.01 份自有额度只多 0.01。
    expect(rank(weeklyOnly(50, 100, 0), 0, 'opus')).toMatchObject({ state: 'ready', remaining: 1.25 })
    expect(rank(weeklyOnly(49.9, 100, 0), 0, 'opus').remaining).toBeCloseTo(1.26, 10)
    // Fable 已用一半时预留 2.5 份：自有 1.5 份全额，预留部分按 1/4。
    const partial = rank(weeklyOnly(60, 100, 50), 0, 'opus')
    expect(partial).toMatchObject({ state: 'ready', remaining: 2.125 })
    expect(partial.score).toBeCloseTo(2.125 / 100, 10)
    // 十进制下自有额度恰为 0：浮点残差与精确 0 的结果连续，不再翻转档位。
    const crumb = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 64.1, weekHours: 100,
      extra: [window('modelWeekly:Fable', 28.2, 100)] }), 0, 'opus')
    const exact = rank(quota({ shortUsed: 0, shortHours: 5, weekUsed: 64, weekHours: 100,
      extra: [window('modelWeekly:Fable', 28, 100)] }), 0, 'opus')
    expect(crumb.remaining).toBeCloseTo(0.25 * 3.59, 10)
    expect(exact.remaining).toBeCloseTo(0.25 * 3.6, 10)
  })

  test('an account left with only Fable\'s reserve beats a nearly spent unreserved account', () => {
    // U 的 5h 窗口只剩 1%（0.01 份撑 4.9 小时）；R 窗口全新，周额度只剩预留（5 份按 1/4 计，按 24 小时折算）。
    const unreserved = rank(quota({ shortUsed: 99, shortHours: 4.9, weekUsed: 0, weekHours: 100 }))
    const onlyReserve = rank(onlyReserveLeft())
    expect(unreserved.score).toBeCloseTo(0.01 / 4.9, 10)
    expect(onlyReserve.score).toBeCloseTo(1.25 / 24, 10)
    expect(winner({ unreserved, onlyReserve })).toBe('onlyReserve')
    // 无 5h 账号同理：Opus 专属周只剩 0.01 份的未预留账号输给只剩预留的账号。
    const opusSpent = rank(quota({ weeklyOnly: true, weekUsed: 0, weekHours: 100, extra: [window('seven_day_opus', 99.9, 100)] }))
    const weeklyReserve = rank(weeklyOnly(50, 100, 0), 0, 'opus')
    expect(weeklyReserve.score).toBeCloseTo(1.25 / 100, 10)
    expect(winner({ opusSpent, weeklyReserve })).toBe('weeklyReserve')
  })

  test('accounts left with only Fable\'s reserve take launches once a fresh account is busy enough', () => {
    // 全新账号每会话 0.2/(n+1)，只剩预留的账号 1.25/24；只有绝对分档时 10 个会话全落在 U。
    expect(launches({ U: quota({ shortUsed: 0, shortHours: 5, weekUsed: 0, weekHours: 100,
      extra: [window('modelWeekly:Fable', 0, 100)] }), R1: onlyReserveLeft(), R2: onlyReserveLeft() }, 10))
      .toEqual(['U', 'U', 'U', 'R1', 'R2', 'U', 'U', 'U', 'U', 'R1'])
  })

  test('a missing Fable bucket never fabricates a reserve', () => {
    const result = rank(weeklyOnly(60, 100), 0, 'opus')
    expect(result).toMatchObject({ state: 'ready', remaining: 4 })
    expect(result.score).toBeCloseTo(4 / 100, 10)
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

  test('the five-hour window still constrains an account under the Fable reserve', () => {
    const snapshot = quota({ shortUsed: 90, weekUsed: 0, weekHours: 100,
      extra: [window('modelWeekly:Fable', 0, 100)] })
    expect(rank(snapshot, 0, 'opus')).toMatchObject({ state: 'ready', remaining: 0.1 })
    // 周额度只剩预留（按 1/4 计 1.25 份）时同样受 5h 窗口约束：0.1 份撑 3 小时。
    const onlyReserve = rank(quota({ shortUsed: 90, weekUsed: 50, weekHours: 100,
      extra: [window('modelWeekly:Fable', 0, 100)] }), 0, 'opus')
    expect(onlyReserve).toMatchObject({ state: 'ready', remaining: 0.1 })
    expect(onlyReserve.score).toBeCloseTo(0.1 / 3, 10)
  })
})

describe('exhausted accounts report when they recover', () => {
  test('recovery waits for every spent window to reset', () => {
    expect(rank(quota({ shortUsed: 100, shortHours: 2, weekUsed: 30, weekHours: 24 }))).toMatchObject({
      state: 'exhausted', score: null, pace: null, recoversAt: after(2).getTime() })
    // 5h 窗口 2 小时后重置，但周额度也用光了，要等 24 小时后的周重置。
    expect(rank(quota({ shortUsed: 100, shortHours: 2, weekUsed: 100, weekHours: 24 })).recoversAt).toBe(after(24).getTime())
    const oauth = quota({ weeklyOnly: true, weekUsed: 100, weekHours: 24, extra: [window('seven_day_oauth_apps', 100, 30)] })
    expect(rank(oauth).recoversAt).toBe(after(30).getTime())
    // 只看该模型适用的窗口：Fable 专属桶用光只推迟 Fable 的恢复。
    const fable = quota({ shortUsed: 100, shortHours: 2, extra: [window('modelWeekly:Fable', 100, 90)] })
    expect(rank(fable).recoversAt).toBe(after(2).getTime())
    expect(rank(fable, 0, 'fable').recoversAt).toBe(after(90).getTime())
  })

  test('an unknown reset on any spent window leaves recovery unknown', () => {
    for (const resetsAt of [null, new Date(NaN)]) {
      const snapshot = quota({ shortUsed: 100, weekUsed: 100 })
      snapshot.windows.find(item => item.kind === 'fiveHour')!.resetsAt = resetsAt
      expect(rank(snapshot)).toMatchObject({ state: 'exhausted', recoversAt: null })
    }
    const fable = quota({ extra: [{ ...window('modelWeekly:Fable', 100, 4), resetsAt: null }] })
    expect(rank(fable, 0, 'fable')).toMatchObject({ state: 'exhausted', recoversAt: null })
    // 只看用光的窗口：未用光窗口缺重置时间不影响已知的恢复时间。
    const unspent = quota({ shortUsed: 100, shortHours: 2 })
    unspent.windows.find(item => item.kind === 'weekly')!.resetsAt = null
    expect(rank(unspent)).toMatchObject({ state: 'exhausted', recoversAt: after(2).getTime() })
  })

  test('a reset already past in a stale snapshot still counts and recovers first', () => {
    const stale = rank(quota({ shortUsed: 100, shortHours: -1 }))
    expect(stale).toMatchObject({ state: 'exhausted', recoversAt: after(-1).getTime() })
    expect(stale.recoversAt!).toBeLessThan(rank(quota({ shortUsed: 100, shortHours: 2 })).recoversAt!)
  })

  test('only exhausted ranks carry a recovery time', () => {
    expect(rank(quota()).recoversAt).toBeUndefined()
    expect(rank(undefined).recoversAt).toBeUndefined()
  })
})

describe('Claude actual quota errors remain excluded', () => {
  test.each([NaN, Infinity, -Infinity])('invalid current time %s stays MISS', now => {
    expect(rankClaudeQuota(quota(), 'opus', now)).toMatchObject({ state: 'miss', score: null, pace: null })
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
      const target = snapshot.windows.find(item => item.kind === kind)!
      target.percent = 100
      expect(rank(snapshot, 100, 'fable')).toMatchObject({ state: 'exhausted', score: null, pace: null,
        recoversAt: target.resetsAt!.getTime() })
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

describe('an unstarted five-hour window does not expire', () => {
  // claudeUsageSnapshot 把尚未启动的短窗估算为读取时间 + 5h；快照变旧时估算会逼近现在，但窗口要到被使用才开始计时，
  // 不能因此显得比真正在计时、额度会作废的窗口更紧迫（审查用例 21）。
  test('it ranks as a full window however old the snapshot is, behind quota that really expires', () => {
    const hour = 3_600_000
    const unstarted = claudeUsageSnapshot({ subscription_type: 'max', rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 20, resets_at: new Date(Date.now() + 100 * hour).toISOString() },
    } })
    const fetched = unstarted.fetchedAt!
    const running = (now: number, windows: Array<[string, number, number]>): UsageSnapshotUnified => ({ state: 'ok', fetchedAt: now,
      windows: windows.map(([kind, percent, hours]) => ({ kind, label: kind, percent, resetsAt: new Date(now + hours * hour) })) })
    for (const ageMinutes of [1, 15, 120]) {
      const now = fetched + ageMinutes * 60_000
      const idle = rankClaudeQuota(unstarted, 'opus', now)
      expect(idle).toMatchObject({ state: 'ready', score: 0.2, pace: 0.2, expiresAt: now + 5 * hour })
      for (const rival of [
        running(now, [['fiveHour', 50, 2.5], ['weekly', 20, 100]]), // 0.5 unit expires unused in 2.5h
        running(now, [['fiveHour', 2, 5 - 10 / 60], ['weekly', 20, 100]]), // a window started 10 minutes ago
        running(now, [['weekly', 75, 12]]), // weekly-only, 2.5 units expire in 12h
      ]) expect(compareClaudeQuota(rankClaudeQuota(rival, 'opus', now), idle)).toBeLessThan(0)
    }
    // 估算时间过后仍按缓存过期 MISS，不续期。
    expect(rankClaudeQuota(unstarted, 'opus', fetched + 5 * hour).state).toBe('miss')
  })

  test('a running window that merely shows no usage keeps its real reset', () => {
    const result = rank(quota({ shortUsed: 0, shortHours: 1 }))
    expect(result).toMatchObject({ state: 'ready', score: 0.2, expiresAt: after(1).getTime() })
    expect(result.pace).toBeCloseTo(7 / 24, 10)
  })
})
