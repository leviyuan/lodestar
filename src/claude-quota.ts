import type { UsageSnapshotUnified, UsageWindowUnified } from './token-source'
import { claudeModelFamily, claudeWeeklyUsageWindow } from './claude-usage'
import { resolveClaudeSdkModel } from './claude-models'

/** A complete five-hour window is one unit; a full week is ten. */
const WEEKLY_ALLOWANCE = 10
/** Fable's dedicated weekly bucket is only half of the shared weekly allowance. */
const FABLE_WEEKLY_ALLOWANCE = WEEKLY_ALLOWANCE / 2
/** Other models may spend Fable's unused share only in the last two days before the weekly reset. */
const FABLE_RESERVE_RELEASE_MS = 2 * 24 * 3_600_000

const FABLE_FAMILY = 'fable'

export interface ClaudeQuotaRank {
  state: 'ready' | 'miss' | 'exhausted'
  /** Smallest remaining applicable window, in complete five-hour units. */
  remaining: number | null
  /** Remaining units divided by active sessions including the one being launched. */
  score: number | null
  activeSessions: number
  /** The account still reports a five-hour window; false means weekly quota only. */
  hasFiveHour: boolean
  /** Reset of the quota discarded first: the five-hour window when reported, otherwise the weekly window. */
  expiresAt: number | null
  fiveHourRemaining?: number
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
 * Spacing only: no demand or time forecast. Each account exposes its real
 * remaining units, and the launch goes where the per-session share is largest,
 * so tasks spread across accounts in proportion to their actual headroom.
 *
 * The weekly quota is split between Fable and the other models. Fable keeps its
 * own half-week bucket; until the weekly reset is two days away, other models
 * may only spend their own half, so Fable's unused share stays available.
 */
export function rankClaudeQuota(snapshot: UsageSnapshotUnified | undefined, model: string,
  now = Date.now(), activeSessions = 0): ClaudeQuotaRank {
  const out: ClaudeQuotaRank = { state: 'miss', remaining: null, score: null, activeSessions,
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
  const spent = windows.find(window => window.percent! >= 100)
  if (spent) return { ...out, state: 'exhausted', reason: `${spent.label} 已耗尽` }
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

  // Every applicable window constrains the same account, so the tightest one is the
  // account's real remaining room. Fable's dedicated bucket holds half a week;
  // other models may only spend the unreserved part of the shared week.
  const remaining = Math.min(...windows.map(window => {
    const capacity = window.kind === 'fiveHour' ? 1
      : isModelWeekly(window, FABLE_FAMILY) ? FABLE_WEEKLY_ALLOWANCE : WEEKLY_ALLOWANCE
    const room = capacity * (100 - window.percent!) / 100
    return window.kind === 'weekly' ? Math.max(0, room - reserved) : room
  }))
  // 周额度只够保留给 Fable 时，该账号不能再用其他模型启动任务；全部账号都这样时
  // 由调用方的耗尽回退处理，不把预留额度当成可分配余量。
  if (family !== FABLE_FAMILY && reserved > 0 && remaining === 0) {
    return { ...out, state: 'exhausted', reason: '周额度已为 Fable 预留' }
  }
  // 没有 5h 限额时以该模型实际生效的周额度重置时间为到期时间。
  const expiresAt = (short ?? weekly).resetsAt!.getTime()
  return { state: 'ready', activeSessions, remaining,
    score: remaining / (activeSessions + 1), hasFiveHour: short !== undefined, expiresAt,
    ...(short ? { fiveHourRemaining: (100 - short.percent!) / 100 } : {}) }
}

const expiryOf = (rank: ClaudeQuotaRank): number => rank.expiresAt ?? Number.POSITIVE_INFINITY

/**
 * 5h 窗口的速率额度不能结转：能安排任务的 5h 账号是更优先的状态，
 * 只有在这里花掉窗口额度，该账号的周额度才用得完。
 * 没有 5h 限额的账号只剩周额度，先接周额度最快到期作废的账号。
 * 5h 组内仍按余量份额分摊，避免并发任务都压在同一个受限窗口上；
 * 其余同分时也按到期时间兜底，5h 账号即先花快到重置的窗口。
 */
export function compareClaudeQuota(a: ClaudeQuotaRank, b: ClaudeQuotaRank): number {
  return Number(b.hasFiveHour) - Number(a.hasFiveHour)
    || (a.hasFiveHour ? 0 : expiryOf(a) - expiryOf(b))
    || b.score! - a.score!
    || a.activeSessions - b.activeSessions
    || b.remaining! - a.remaining!
    || (b.fiveHourRemaining ?? 0) - (a.fiveHourRemaining ?? 0)
    || expiryOf(a) - expiryOf(b)
}
