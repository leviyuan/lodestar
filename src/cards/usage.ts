import type { UsageWindow } from '../usage'

/** Human-readable time until reset; keep the compact footer's h/d precision. */
export function fmtResetIn(date: Date | null): string {
  if (!date) return '?'
  const ms = date.getTime() - Date.now()
  if (ms <= 0) return '已重置'
  if (ms < 60 * 60 * 1000) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (ms < 24 * 60 * 60 * 1000) return `${(ms / (60 * 60 * 1000)).toFixed(1)}h`
  return `${(ms / (24 * 60 * 60 * 1000)).toFixed(1)}d`
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
  const reset = window.unreportedFull ? '满窗 · 0.15 份'
    : window.resetsAt && Number.isFinite(window.resetsAt.getTime()) ? `${fmtResetIn(window.resetsAt)} 重置`
    : '重置时间 MISS'
  return [
    { tag: 'markdown', content: `**${title} · ${Math.round(value)}%${counts}**\n<font color='${color}'>${'▰'.repeat(filled)}${'▱'.repeat(6 - filled)}</font>` },
    { tag: 'markdown', content: `<font color='grey'>${reset}</font>`, text_size: 'notation' },
  ]
}
