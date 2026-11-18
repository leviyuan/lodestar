import type { UsageWindow } from '../usage'
import { codexCreditAvailability, type CodexCredits } from '../codex-credits'

/** Omit confirmed empty credits; keep unknown credit data visibly distinct from zero. */
export function codexCreditsSummary(credits: CodexCredits | null | undefined): string | null {
  if (!credits) return '积分 MISS'
  if (codexCreditAvailability(credits) === 'empty') return null
  if (credits.unlimited) return '积分 无限'
  if (credits.balance === null) return '积分 MISS'
  let amount = credits.balance
  let unit = ''
  // Promote after rounding too: 999.95k should display as 1m.
  for (const nextUnit of ['k', 'm']) {
    if (Math.round(amount * 10) < 10_000) break
    amount /= 1000
    unit = nextUnit
  }
  const value = amount > 0 && amount < 0.05 ? '<0.1'
    : amount.toLocaleString('en-US', { maximumFractionDigits: 1, useGrouping: false })
  return `积分 ${value}${unit}`
}

/** Compact positive countdown: whole minutes below an hour, then hours or days to one decimal.
 * Window resets and the hi login end share it, so every countdown in a row reads the same way.
 * The unit follows the rounded value: 59.7 minutes reads 1.0h and 23.97 hours 1.0d, never 60m or 24.0h. */
export function fmtCountdown(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = (ms / 3_600_000).toFixed(1)
  return Number(hours) < 24 ? `${hours}h` : `${(ms / 86_400_000).toFixed(1)}d`
}

/** Human-readable time until reset; keep the compact footer's h/d precision. */
export function fmtResetIn(date: Date | null): string {
  if (!date) return '?'
  const ms = date.getTime() - Date.now()
  return ms <= 0 ? '已重置' : fmtCountdown(ms)
}

/** Shared six-cell usage bar and reset caption for hi and Codex account cards. */
export function usageWindowElements(
  window: UsageWindow & { used?: number; total?: number },
  label: string,
): Array<{ tag: 'markdown'; content: string; text_size?: 'notation' }> {
  const title = label.replace(/[&<>\\`*_\[\]~]/g, char => `&#${char.charCodeAt(0)};`)
  const counts = typeof window.used === 'number' && typeof window.total === 'number'
    ? ` · ${window.used}/${window.total}` : ''
  const value = window.percent
  if (value === null || !Number.isFinite(value) || value < 0 || value > 100) {
    return [{ tag: 'markdown', content: `**${title} · MISS${counts}**` }]
  }
  const filled = Math.round(value / 100 * 6)
  const color = value >= 100 ? 'red' : value >= 80 ? 'orange' : 'green'
  const reset = window.resetsAt && Number.isFinite(window.resetsAt.getTime()) ? `${fmtResetIn(window.resetsAt)} 重置`
    : '重置时间 MISS'
  return [
    { tag: 'markdown', content: `**${title} · ${Math.round(value)}%${counts}**\n<font color='${color}'>${'▰'.repeat(filled)}${'▱'.repeat(6 - filled)}</font>` },
    { tag: 'markdown', content: `<font color='grey'>${reset}</font>`, text_size: 'notation' },
  ]
}
