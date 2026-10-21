import type { UsageSnapshotUnified } from './token-source'
import { claudeModelFamily, claudeWeeklyUsageWindow } from './claude-usage'
import { resolveClaudeSdkModel } from './claude-models'

const HOUR_MS = 3_600_000
const FORECAST_HOURS = 1
const SESSION_HOURLY_ALLOWANCE = 0.1
const WEEKLY_ALLOWANCE = 10
const ROUNDING_EPSILON = Number.EPSILON * 16

export interface ClaudeQuotaRank {
  state: 'ready' | 'miss' | 'exhausted'
  /** Effective model weekly fraction, without subtracting forecast reservations. */
  remaining: number | null
  hours: number | null
  /** Unreserved full-five-hour allowances per hour; negative when squeezing is necessary. */
  score: number | null
  fits: boolean
  /** Largest forecast demand / allowance ratio, across every pre-reset and post-reset segment. */
  pressure: number | null
  activeSessions: number
  fiveHourRemaining?: number
  reason?: string
}

/** Forecasts are scheduling estimates only. They never mutate upstream quota or exclude a usable account. */
export function rankClaudeQuota(snapshot: UsageSnapshotUnified | undefined, model: string,
  now = Date.now(), activeSessions = 0): ClaudeQuotaRank {
  const out: ClaudeQuotaRank = { state: 'miss', remaining: null, hours: null, score: null,
    fits: false, pressure: null, activeSessions }
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
    || window.kind.startsWith('modelWeekly:') && claudeModelFamily(window.kind.slice('modelWeekly:'.length)) === family)
  const short = windows.find(window => window.kind === 'fiveHour')
  const totalWeek = windows.find(window => window.kind === 'weekly')
  if (!short || !totalWeek) return { ...out, reason: '订阅主窗口额度 MISS' }
  if (new Set(windows.map(window => window.kind)).size !== windows.length) {
    return { ...out, reason: '额度窗口重复，归属 MISS' }
  }
  for (const window of windows) {
    if (typeof window.percent !== 'number' || !Number.isFinite(window.percent) || window.percent < 0 || window.percent > 100) {
      return { ...out, reason: `${window.label} MISS` }
    }
    if (window.percent >= 100) return { ...out, state: 'exhausted', reason: `${window.label} 已耗尽` }
  }
  for (const window of windows) {
    const reset = window.resetsAt instanceof Date ? window.resetsAt.getTime() : NaN
    if (!Number.isFinite(reset) || reset <= now) return { ...out, reason: `${window.label} 重置时间 MISS 或已过期` }
  }
  const weekly = claudeWeeklyUsageWindow(snapshot, model)
  if (!weekly) return { ...out, reason: '模型周额度匹配 MISS 或有歧义' }
  if (family === 'fable' && weekly.kind === 'weekly') return { ...out, reason: 'Fable 专属周额度 MISS' }

  // Every applicable window constrains the same account's projected load. Fable's total-week
  // allowance is halved; its dedicated week keeps a full ten short-window allowances.
  const budgets = windows.map(window => {
    const capacity = window.kind === 'fiveHour' ? 1
      : family === 'fable' && window.kind === 'weekly' ? WEEKLY_ALLOWANCE / 2 : WEEKLY_ALLOWANCE
    return { window, capacity, balance: capacity * (100 - window.percent!) / 100,
      hours: (window.resetsAt!.getTime() - now) / HOUR_MS }
  })
  const demand = SESSION_HOURLY_ALLOWANCE * (activeSessions + 1)
  let fits = true, pressure = 0, score = Infinity
  const segment = (allowance: number, hours: number, scoringHours: number): void => {
    const required = demand * hours
    const difference = allowance - required
    // Exact boundaries such as 30% for three sessions must not fail because 0.1 * 3 rounds up.
    const slack = Math.abs(difference) <= ROUNDING_EPSILON * Math.max(allowance, required) ? 0 : difference
    fits &&= slack >= 0
    pressure = Math.max(pressure, slack === 0 ? 1 : required / allowance)
    score = Math.min(score, slack / scoringHours)
  }
  for (const budget of budgets) {
    segment(budget.balance, Math.min(budget.hours, FORECAST_HOURS), Math.max(budget.hours, FORECAST_HOURS))
    if (budget.hours < FORECAST_HOURS) {
      segment(budget.capacity, FORECAST_HOURS - budget.hours, FORECAST_HOURS)
    }
  }
  const modelWeeks = budgets.filter(budget => budget.window === totalWeek || budget.window === weekly)
  return { state: 'ready', fits, pressure, activeSessions, score,
    remaining: Math.min(...modelWeeks.map(budget => budget.balance)) / WEEKLY_ALLOWANCE,
    hours: Math.min(...modelWeeks.map(budget => budget.hours)),
    fiveHourRemaining: (100 - short.percent!) / 100 }
}

/** Ready candidates only. Overcommitted accounts remain selectable, distributed by forecast pressure. */
export function compareClaudeQuota(a: ClaudeQuotaRank, b: ClaudeQuotaRank): number {
  const fitOrder = Number(b.fits) - Number(a.fits)
  if (fitOrder) return fitOrder
  return (a.fits ? b.score! - a.score! || a.pressure! - b.pressure!
    : a.pressure! - b.pressure! || b.score! - a.score!)
    || a.activeSessions - b.activeSessions
    || b.fiveHourRemaining! - a.fiveHourRemaining!
}
