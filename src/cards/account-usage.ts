import type { AccountUsage } from '../account-usage'
import type { UsageSnapshotUnified, UsageWindowUnified } from '../token-source'
import { CLAUDE_LOGIN_EARLY_END_MS, CLAUDE_LOGIN_WARNING_MS } from '../claude-credential'
import { codexCreditsSummary, fmtResetIn } from './usage'

const DAY_MS = 86_400_000

function escape(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[&<>\\`*_\[\]~]/g, char => `&#${char.charCodeAt(0)};`)
}

function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 100) return 'MISS'
  const text = `${Math.round(value)}%`
  return value >= 100 ? `<font color='red'>${text}</font>` : value >= 80 ? `<font color='orange'>${text}</font>` : text
}

function windowContent(window: UsageWindowUnified): string {
  const labels: Record<string, string> = {
    fiveHour: '5h', weekly: '周', monthly: '月工具',
    seven_day_opus: 'Opus周', seven_day_sonnet: 'Sonnet周', seven_day_oauth_apps: 'OAuth周',
  }
  const label = labels[window.kind] ?? window.label.replace(/\s*周额度$/, '周')
  const value = `${escape(label)} ${percent(window.percent)}`
  if (window.kind === 'monthly') return value
  return `${value}/${window.resetsAt && Number.isFinite(window.resetsAt.getTime()) ? fmtResetIn(window.resetsAt) : 'MISS'}`
}

/** 原生 loginExpiresAt 是最晚到期时刻，实际可能最多提前 3 天结束：按原生口径显示整天区间。
 * 最早到期已不足 1 天（原生称随时可能结束）时只给上限并标红，已过该时刻同样标红；
 * 显示的上限不超过 10 天（原生开始提醒）标橙，颜色只看显示值，同一文案不会时有时无颜色。 */
function credentialExpiry(expiresAt: number | null): string {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return '凭据 MISS'
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) return "<font color='red'>凭据 可能已到期</font>"
  const earliestDays = Math.floor((remaining - CLAUDE_LOGIN_EARLY_END_MS) / DAY_MS)
  if (earliestDays < 1) return `<font color='red'>凭据 ≤${fmtResetIn(new Date(expiresAt))}</font>`
  const latestDays = Math.floor(remaining / DAY_MS)
  const text = `凭据 ${earliestDays}–${latestDays}d`
  return latestDays * DAY_MS <= CLAUDE_LOGIN_WARNING_MS ? `<font color='orange'>${text}</font>` : text
}

export function compactAccountUsage(snapshot: UsageSnapshotUnified | undefined): string {
  if (!snapshot) return '加载中…'
  if (snapshot.state === 'not_applicable') return '—'
  if (snapshot.state !== 'ok') {
    const reason = snapshot.state === 'no_credentials' ? '未登录或未配置'
      : snapshot.state === 'rate_limited' ? 'API 限频'
      : (snapshot.reason ?? '查询失败').replace(/^Claude 原生额度接口未返回 rate_limits 数据$/, '原生接口未返回额度')
    return `<font color='red'>MISS · ${escape(reason.slice(0, 100))}</font>`
  }
  const money = (amount: number, currency: string) => {
    if (!Number.isFinite(amount)) return 'MISS'
    const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : escape(currency)
    return `${symbol} ${amount.toFixed(2)}`
  }
  if (snapshot.kind === 'balance') return `余额 ${snapshot.balance ? money(snapshot.balance.remaining, snapshot.balance.currency) : 'MISS'}`
  if (snapshot.quota) return snapshot.quota.limit === null ? '额度 未设上限'
    : snapshot.quota.remaining === null ? '额度 MISS'
    : `额度 ${money(snapshot.quota.remaining, snapshot.quota.currency)} / ${money(snapshot.quota.limit, snapshot.quota.currency)}`
  const parts = snapshot.windows.map(windowContent)
  if (!parts.length) parts.push('额度 MISS')
  const credits = snapshot.credits !== undefined ? codexCreditsSummary(snapshot.credits) : null
  if (credits) parts.push(credits)
  if (snapshot.resetCredits !== undefined) parts.push(`重置 ${snapshot.resetCredits === null ? 'MISS' : snapshot.resetCredits}`)
  if (snapshot.credentialExpiresAt !== undefined) parts.push(credentialExpiry(snapshot.credentialExpiresAt))
  return parts.join(' · ')
}

export function accountUsageRow(row: AccountUsage): object {
  return { tag: 'markdown', text_size: 'notation', content: `**${escape(row.label)}**　${compactAccountUsage(row.usage)}` }
}
