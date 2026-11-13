import type { UsageSnapshotUnified, UsageWindowUnified } from './token-source'
import { claudeFiveHourUnstarted, claudeModelFamily, claudeWeeklyUsageWindow } from './claude-usage'
import { resolveClaudeSdkModel } from './claude-models'

/** A complete five-hour window is one unit; a full week is ten. */
const WEEKLY_ALLOWANCE = 10
/** Fable's dedicated weekly bucket is only half of the shared weekly allowance. */
const FABLE_WEEKLY_ALLOWANCE = WEEKLY_ALLOWANCE / 2
/** Fable's unused share is discounted for other models until the last two days before the weekly reset. */
const FABLE_RESERVE_RELEASE_MS = 2 * 24 * 3_600_000
const HOUR_MS = 3_600_000
const FIVE_HOURS = 5
/**
 * A launch is credited at most one full window per five hours. It keeps running after a window or
 * week resets and then draws on the next allowance like any other launch, so quota about to expire
 * can only bring an account level with a full window: it must not pull every launch onto itself.
 */
const FIVE_HOUR_PACE = 1 / FIVE_HOURS
/** Requests arrive in bursts: room in a window resetting within the hour must still last an hour. */
const MIN_PACE_HOURS = 1
/** A five-hour account spends its week one window at a time; its week should last a day at that pace. */
const WEEKLY_GUARD_HOURS = 24
/** Fable's unused half week still counts for other models, at a quarter of its value. */
const FABLE_RESERVE_VALUE = 0.25

const FABLE_FAMILY = 'fable'

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high)

export interface ClaudeQuotaRank {
  state: 'ready' | 'miss' | 'exhausted'
  /** Smallest remaining applicable window, in complete five-hour units. */
  remaining: number | null
  /** Sustainable pace in units per hour, capped at one window per five hours, divided by active
   *  sessions including the one being launched. */
  score: number | null
  /** The account's pace before that cap: how fast its quota must be spent. Breaks score ties. */
  pace: number | null
  activeSessions: number
  /** The account still reports a five-hour window; false means weekly quota only. */
  hasFiveHour: boolean
  /** Reset of the quota discarded first: the five-hour window when reported, otherwise the weekly window. */
  expiresAt: number | null
  fiveHourRemaining?: number
  /** Exhausted only: when every spent window has reset; null when any of those reset times is unknown. */
  recoversAt?: number | null
  reason?: string
}

function isModelWeekly(window: UsageWindowUnified, family: string): boolean {
  return window.kind.startsWith('modelWeekly:')
    && claudeModelFamily(window.kind.slice('modelWeekly:'.length)) === family
}

/** The dedicated Fable weekly bucket, if the account reports one. */
function fableWeeklyWindows(snapshot: UsageSnapshotUnified): UsageWindowUnified[] {
  return snapshot.windows.filter(window => isModelWeekly(window, FABLE_FAMILY))
}

/**
 * No demand forecast. Each applicable window is valued by its pace: remaining units divided by the
 * hours until it resets, i.e. the rate it sustains until then, which is also the rate that spends it
 * in full. Whatever resets within the hour is still counted over an hour, because requests arrive in
 * bursts. The account's pace is its slowest window; a launch is credited at most one window per five
 * hours, and that capped pace is shared by the active sessions plus this launch.
 *
 * - A five-hour window on pace is therefore as good as a full one; only a window spent ahead of
 *   pace ranks lower.
 * - A five-hour account spends its week one window at a time, so its weekly windows are paced over
 *   at most a day; while its window has room and its week can last that day, it outranks
 *   weekly-only accounts, whose fresh week is paced over the whole week.
 * - A weekly-only account may spend the week at any pace, so its pace runs to the weekly reset: a
 *   week that would otherwise expire unused reaches the cap and wins ties, a far or nearly spent
 *   week ranks low.
 *
 * The weekly quota is split between Fable and the other models. Fable keeps its own half-week
 * bucket; until the weekly reset is two days away, the part of the shared week other models would
 * take from Fable's unused half counts at a quarter of its value. It lowers the account's rank but
 * never excludes it.
 */
export function rankClaudeQuota(snapshot: UsageSnapshotUnified | undefined, model: string,
  now = Date.now(), activeSessions = 0): ClaudeQuotaRank {
  const out: ClaudeQuotaRank = { state: 'miss', remaining: null, score: null, pace: null, activeSessions,
    hasFiveHour: false, expiresAt: null }
  if (!Number.isFinite(now)) return { ...out, reason: '当前时间 MISS' }
  if (!Number.isSafeInteger(activeSessions) || activeSessions < 0) return { ...out, reason: '活跃会话数 MISS' }
  if (!snapshot || snapshot.state !== 'ok') return { ...out, reason: snapshot?.reason ?? '额度缓存 MISS' }
  if (!Array.isArray(snapshot.windows) || snapshot.windows.some(window => !window || typeof window.kind !== 'string')) {
    return { ...out, reason: '额度窗口格式 MISS' }
  }
  const family = claudeModelFamily(resolveClaudeSdkModel(model))
  if (!family || family === 'default') return { ...out, reason: '模型额度归属 MISS' }
  const windows = snapshot.windows.filter(window => window.kind === 'fiveHour' || window.kind === 'weekly'
    || window.kind === 'seven_day_oauth_apps'
    || window.kind === 'seven_day_opus' && family === 'opus'
    || window.kind === 'seven_day_sonnet' && family === 'sonnet'
    || isModelWeekly(window, family))
  const short = windows.find(window => window.kind === 'fiveHour')
  const totalWeek = windows.find(window => window.kind === 'weekly')
  // 没有 5h 窗口的账号只受周额度约束，仍然可以接任务，不当作 MISS。
  if (!totalWeek) return { ...out, reason: '订阅周额度 MISS' }
  if (new Set(windows.map(window => window.kind)).size !== windows.length) {
    return { ...out, reason: '额度窗口重复，归属 MISS' }
  }
  // Every window is validated before any is judged: an account with an unreadable window
  // is MISS, and must not pass as "clearly exhausted" because an earlier window was full.
  for (const window of windows) {
    if (typeof window.percent !== 'number' || !Number.isFinite(window.percent) || window.percent < 0 || window.percent > 100) {
      return { ...out, reason: `${window.label} MISS` }
    }
  }
  const spent = windows.filter(window => window.percent! >= 100)
  if (spent.length) {
    // 所有用光的窗口都重置后账号才恢复；其中任一重置时间缺失时恢复时间未知。
    const resets = spent.map(window => window.resetsAt instanceof Date ? window.resetsAt.getTime() : NaN)
    return { ...out, state: 'exhausted', reason: `${spent[0]!.label} 已耗尽`,
      recoversAt: resets.every(Number.isFinite) ? Math.max(...resets) : null }
  }
  for (const window of windows) {
    const reset = window.resetsAt instanceof Date ? window.resetsAt.getTime() : NaN
    if (!Number.isFinite(reset) || reset <= now) return { ...out, reason: `${window.label} 重置时间 MISS 或已过期` }
  }
  const weekly = claudeWeeklyUsageWindow(snapshot, model)
  if (!weekly) return { ...out, reason: '模型周额度匹配 MISS 或有歧义' }
  if (family === FABLE_FAMILY && weekly.kind === 'weekly') return { ...out, reason: 'Fable 专属周额度 MISS' }

  // 非 Fable 模型继续预留 Fable 尚未使用的半周额度；只认接口返回的专属周窗口，
  // 缺失时不猜测预留量。重置前 2 天内释放，让本周期用不完的额度仍可被其他模型使用。
  let reserved = 0
  if (family !== FABLE_FAMILY && totalWeek.resetsAt!.getTime() - now > FABLE_RESERVE_RELEASE_MS) {
    const fable = fableWeeklyWindows(snapshot)
    if (fable.length > 1) return { ...out, reason: 'Fable 周额度归属 MISS' }
    if (fable[0]) {
      const percent = fable[0].percent
      if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
        return { ...out, reason: 'Fable 周额度 MISS' }
      }
      reserved = FABLE_WEEKLY_ALLOWANCE * (100 - percent) / 100
    }
  }

  const capacity = (window: UsageWindowUnified): number => window.kind === 'fiveHour' ? 1
    : isModelWeekly(window, FABLE_FAMILY) ? FABLE_WEEKLY_ALLOWANCE : WEEKLY_ALLOWANCE
  // Every applicable window constrains the same account, so the tightest one is the account's real
  // remaining room. 动用 Fable 预留的那部分总周额度只按四分之一计：账号排名降低但不排除，也没有分档跳变。
  const room = (window: UsageWindowUnified): number => {
    const left = capacity(window) * (100 - window.percent!) / 100
    if (window.kind !== 'weekly' || reserved === 0) return left
    const own = Math.max(0, left - reserved)
    return own + FABLE_RESERVE_VALUE * (left - own)
  }
  // 尚未启动的短窗不会作废，被使用时才开始计时：按完整 5 小时、到期时间按现在起 5 小时计，
  // 不因快照变旧而显得比真正在计时的窗口更紧迫。
  const unstarted = short !== undefined && claudeFiveHourUnstarted(snapshot, short)
  const windowPace = (window: UsageWindowUnified, left: number): number => {
    const hours = window === short && unstarted ? FIVE_HOURS : (window.resetsAt!.getTime() - now) / HOUR_MS
    const span = window.kind === 'fiveHour' ? clamp(hours, MIN_PACE_HOURS, FIVE_HOURS)
      : short ? clamp(hours, MIN_PACE_HOURS, WEEKLY_GUARD_HOURS) : Math.max(hours, MIN_PACE_HOURS)
    return left / span
  }
  const rooms = windows.map(room)
  const remaining = Math.min(...rooms)
  const pace = Math.min(...windows.map((window, index) => windowPace(window, rooms[index]!)))
  // 没有 5h 限额时以该模型实际生效的周额度重置时间为到期时间。
  const expiresAt = unstarted ? now + FIVE_HOURS * HOUR_MS : (short ?? weekly).resetsAt!.getTime()
  return { state: 'ready', activeSessions, remaining, pace,
    score: Math.min(pace, FIVE_HOUR_PACE) / (activeSessions + 1), hasFiveHour: short !== undefined, expiresAt,
    ...(short ? { fiveHourRemaining: (100 - short.percent!) / 100 } : {}) }
}

const expiryOf = (rank: ClaudeQuotaRank): number => rank.expiresAt ?? Number.POSITIVE_INFINITY

/**
 * 一个统一分数：每会话可持续的消耗节奏（见 rankClaudeQuota），高者优先。不按“是否有 5h 窗口”、
 * “谁先重置”或“是否动用 Fable 预留”整组排队：快用光的窗口靠节奏自然靠后；快作废的额度最多与满窗并列，
 * 不会把新任务全部吸走。同分时（例如几个都跟得上节奏的账号）依次取活跃会话少、封顶前节奏高（额度更需要
 * 尽快花掉）、先到期、余量大的账号。
 */
export function compareClaudeQuota(a: ClaudeQuotaRank, b: ClaudeQuotaRank): number {
  return b.score! - a.score!
    || a.activeSessions - b.activeSessions
    || b.pace! - a.pace!
    || expiryOf(a) - expiryOf(b)
    || b.remaining! - a.remaining!
}
