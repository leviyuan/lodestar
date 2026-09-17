import type { AccountUsage } from '../account-usage'
import type { UsageSnapshotUnified, UsageWindowUnified } from '../token-source'
import { fmtResetIn } from './usage'

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
  if (window.unreportedFull) return `${value}（满窗）`
  return `${value}/${window.resetsAt && Number.isFinite(window.resetsAt.getTime()) ? fmtResetIn(window.resetsAt) : 'MISS'}`
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
  if (snapshot.resetCredits !== undefined) parts.push(`重置 ${snapshot.resetCredits === null ? 'MISS' : snapshot.resetCredits}`)
  return parts.join(' · ')
}

export function accountUsageRow(row: AccountUsage): object {
  return { tag: 'markdown', text_size: 'notation', content: `**${escape(row.label)}**　${compactAccountUsage(row.usage)}` }
}
