import type { UsageSnapshotUnified } from './token-source'
import { claudeModelFamily, claudeWeeklyUsageWindow } from './claude-usage'
import { resolveClaudeSdkModel } from './claude-models'

/** A complete five-hour window is one unit; a full week is ten. */
const WEEKLY_ALLOWANCE = 10

export interface ClaudeQuotaRank {
  state: 'ready' | 'miss' | 'exhausted'
  /** Smallest remaining applicable window, in complete five-hour units. */
  remaining: number | null
  /** Remaining units divided by active sessions including the one being launched. */
  score: number | null
  activeSessions: number
  fiveHourRemaining?: number
  reason?: string
}

/**
 * Spacing only: no demand or time forecast. Each account exposes its real
 * remaining units, and the launch goes where the per-session share is largest,
 * so tasks spread across accounts in proportion to their actual headroom.
 */
export function rankClaudeQuota(snapshot: UsageSnapshotUnified | undefined, model: string,
  now = Date.now(), activeSessions = 0): ClaudeQuotaRank {
  const out: ClaudeQuotaRank = { state: 'miss', remaining: null, score: null, activeSessions }
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

  // Every applicable window constrains the same account, so the tightest one is the
  // account's real remaining room. Fable's shared week holds five units, its
  // dedicated week ten.
  const remaining = Math.min(...windows.map(window => {
    const capacity = window.kind === 'fiveHour' ? 1
      : family === 'fable' && window.kind === 'weekly' ? WEEKLY_ALLOWANCE / 2 : WEEKLY_ALLOWANCE
    return capacity * (100 - window.percent!) / 100
  }))
  return { state: 'ready', activeSessions, remaining,
    score: remaining / (activeSessions + 1),
    fiveHourRemaining: (100 - short.percent!) / 100 }
}

/** Equal per-session share is the goal; ties keep the launch on the least busy, roomiest account. */
export function compareClaudeQuota(a: ClaudeQuotaRank, b: ClaudeQuotaRank): number {
  return b.score! - a.score!
    || a.activeSessions - b.activeSessions
    || b.remaining! - a.remaining!
    || b.fiveHourRemaining! - a.fiveHourRemaining!
}
