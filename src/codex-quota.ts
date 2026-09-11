import type { UsageSnapshot, UsageWindow } from './usage'
import type { AgentReasoningEffort } from './agent-process'

export const PLUS_FIVE_HOUR_SHARES = 0.15
export const ULTRA_MIN_WEEKLY_SHARES = 0.5

/** User-defined subscription rule: successful Plus reads without a short window mean a full 5h budget.
 * This does not fabricate a reset timestamp, and never applies to failed reads or malformed windows. */
export function plusFiveHourWindow(plan: string | undefined, window: UsageWindow | null): UsageWindow | null {
  return plan === 'plus' && window === null
    ? { percent: 0, resetsAt: null, durationMins: 300, unreportedFull: true } : window
}

/** Native personal plan SKUs. Shares are relative weekly allowances, not token estimates. */
export function codexWeeklyShares(plan: string | undefined): 1 | 5 | 20 | null {
  switch (plan) {
    case 'plus': return 1
    case 'prolite': return 5
    case 'pro': return 20
    default: return null
  }
}

export function codexModelQuota(usage: Extract<UsageSnapshot, { state: 'ok' }>, model: string) {
  // Separate meters (e.g. Spark) must not block ordinary models or borrow their quota.
  const quota = usage.buckets?.find(b => b.limitName?.toLowerCase() === model.toLowerCase()
    || b.normalModelSlug === model) ?? usage
  return { ...quota, fiveHour: plusFiveHourWindow(usage.subscriptionType, quota.fiveHour) }
}

export function codexQuotaMeter(usage: UsageSnapshot, model: string): string {
  if (usage.state !== 'ok') throw new Error('额度计量桶 MISS')
  const quota = codexModelQuota(usage, model)
  return 'limitId' in quota ? quota.limitId : usage.defaultLimitId ?? 'codex'
}

export type CodexQuotaRank = {
  state: 'ready' | 'exhausted' | 'miss' | 'excluded' | 'waiting' | 'manual'
  score: number | null
  shares: number | null
  remaining: number | null
  hours: number | null
  weeklyScore?: number
  fiveHourRemaining?: number
  fiveHourHours?: number
  availableNow?: number
  reason?: string
  retryAt?: number
}

export function rankCodexQuota(usage: UsageSnapshot, model: string, now = Date.now(), effort?: AgentReasoningEffort): CodexQuotaRank {
  const out: CodexQuotaRank = { state: 'miss', score: null, shares: null, remaining: null, hours: null }
  if (usage.state !== 'ok') return { ...out, reason: usage.state === 'network' ? usage.reason ?? '额度读取失败' : usage.state }
  const shares = codexWeeklyShares(usage.subscriptionType)
  if (shares === null) return { ...out, reason: `未知周额度套餐：${usage.subscriptionType ?? 'MISS'}` }
  out.shares = shares
  if (effort === 'ultra' && usage.subscriptionType === 'plus') {
    return { ...out, state: 'excluded', reason: 'Ultra 自动选择不使用 Plus' }
  }
  const quota = codexModelQuota(usage, model)
  const windows = [quota.fiveHour, quota.weekly].filter((w): w is UsageWindow => w !== null)
  const exhausted = windows.filter(w => w.percent !== null && w.percent >= 100)
  if (exhausted.length || usage.ordinaryUsageAllowed === false || quota.rateLimitReachedType || quota.spendControlReached === true) {
    // All exhausted windows must reset before this account is usable.
    const resets = exhausted.map(w => w.resetsAt?.getTime()).filter((t): t is number => t != null && Number.isFinite(t) && t > now)
    return { ...out, state: 'exhausted', reason: '额度耗尽',
      ...(resets.length === exhausted.length && resets.length ? { retryAt: Math.max(...resets) } : {}) }
  }
  if (windows.some(w => w.percent === null || !Number.isFinite(w.percent) || w.percent < 0)) return { ...out, reason: '额度百分比 MISS' }
  const weekly = quota.weekly
  if (!weekly || weekly.percent === null) return { ...out, reason: '周额度 MISS' }
  // A stale/resetting window is not an infinite score or a fabricated new allowance.
  const reset = weekly.resetsAt?.getTime()
  if (reset == null || !Number.isFinite(reset) || reset <= now) return { ...out, reason: '周重置时间 MISS 或已过期' }
  const remaining = shares * (100 - weekly.percent) / 100
  const hours = (reset - now) / 3_600_000
  const weeklyScore = remaining / hours
  if (effort === 'ultra' && remaining < ULTRA_MIN_WEEKLY_SHARES) {
    return { ...out, state: 'waiting', remaining, hours, weeklyScore,
      reason: `Ultra 至少需要 ${ULTRA_MIN_WEEKLY_SHARES} 份周余量`, retryAt: reset }
  }
  if (usage.subscriptionType === 'plus') {
    const short = quota.fiveHour!
    const fiveHourRemaining = PLUS_FIVE_HOUR_SHARES * (100 - short.percent!) / 100
    const fiveHourHours = short.unreportedFull ? 5 : ((short.resetsAt?.getTime() ?? NaN) - now) / 3_600_000
    if (!Number.isFinite(fiveHourHours) || fiveHourHours <= 0) return { ...out, reason: '5h 重置时间 MISS 或已过期' }
    return { state: 'ready', shares, remaining, hours, weeklyScore, fiveHourRemaining, fiveHourHours,
      availableNow: Math.min(remaining, fiveHourRemaining), score: Math.min(weeklyScore, fiveHourRemaining / fiveHourHours) }
  }
  return { state: 'ready', shares, remaining, hours, weeklyScore, availableNow: remaining, score: weeklyScore }
}

/** Only native quota terminal failures qualify. HTTP 429, capacity and transport failures do not. */
export function isCodexQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { codexErrorInfo?: unknown; type?: unknown; code?: unknown; message?: unknown }
  if (e.codexErrorInfo === 'usageLimitExceeded' || e.type === 'usage_limit_reached' || e.code === 'usage_limit_reached') return true
  // turn/start JSON-RPC rejection can carry only the native rendered message.
  return typeof e.message === 'string' && /^You(?:'|’)ve hit your usage limit\b/i.test(e.message)
}

export interface CodexQuotaFailure {
  /** Accepted input already exists in native history and must never be replayed. */
  accepted: boolean
  rejectedInput?: string
}
