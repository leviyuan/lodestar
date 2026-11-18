import type { AccountUsage } from '../account-usage'
import type { UsageSnapshotUnified, UsageWindowUnified } from '../token-source'
import { CLAUDE_LOGIN_EARLY_END_MS, CLAUDE_LOGIN_WARNING_MS } from '../claude-credential'
import { codexCreditsSummary, fmtCountdown, fmtResetIn } from './usage'

// hi 额度区一账号一行，各来源同一套写法：`**账号**　项 · 项`。
// - 额度窗口 `名称 已用%/距重置`；距重置与凭据共用 fmtCountdown（m / 一位小数的 h、d）。
// - 每个事实只写一次：整窗未知只写一次 MISS；模型专属周额度只写模型名，距重置显示与总周相同时不重复。
// - 积分、重置卡等计数确认为零时省略，未知写 MISS；金额符号紧贴数字，与回复 footer 一致。
// - 颜色只看显示值（百分比与凭据倒计时），同一文案颜色不变。

const DAY_MS = 86_400_000

/** 单行纯文本放进卡片 markdown：换行并成空格，markdown 与标签字符转成实体。 */
export function escapeInlineMarkdown(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[&<>\\`*_\[\]~]/g, char => `&#${char.charCodeAt(0)};`)
}
const escape = escapeInlineMarkdown

/** 颜色只看显示值：79.6 显示为 80% 即标橙，99.6 显示为 100% 即标红，同一文案颜色不变。 */
function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 100) return 'MISS'
  const shown = Math.round(value)
  const text = `${shown}%`
  return shown >= 100 ? `<font color='red'>${text}</font>` : shown >= 80 ? `<font color='orange'>${text}</font>` : text
}

/** 模型专属周额度（含 OAuth 应用）只写名称：它们都是周额度，紧跟在总周之后。 */
const MODEL_WEEKLY_LABELS: Record<string, string> = {
  seven_day_opus: 'Opus', seven_day_sonnet: 'Sonnet', seven_day_oauth_apps: 'OAuth',
}
const WINDOW_LABELS: Record<string, string> = { fiveHour: '5h', weekly: '周', monthly: '月工具', ...MODEL_WEEKLY_LABELS }

/** 中转站脚本的窗口可能缺 kind 或不是字符串：只当作未登记的窗口，不能抛错。 */
function modelWeekly(kind: unknown): boolean {
  return typeof kind === 'string' && (kind.startsWith('modelWeekly:') || Object.hasOwn(MODEL_WEEKLY_LABELS, kind))
}

/** 中转站余额脚本的 JSON 原样转入、日期是字符串：只认真正的 Date，其余按 MISS，不能让整个额度区出错。 */
function resetIn(window: UsageWindowUnified): string | null {
  return window.resetsAt instanceof Date && Number.isFinite(window.resetsAt.getTime()) ? fmtResetIn(window.resetsAt) : null
}

/** 距重置按显示值比较：已用已知、且与总周显示相同的模型专属周额度不再重复；任一方缺失时各自照写，
 * 所以 `名称 MISS` 只表示整窗未知。其他来源未登记的周额度仍写作“名称周”。 */
function windowContent(window: UsageWindowUnified, reset: string | null, weeklyReset: string | null): string {
  const label = Object.hasOwn(WINDOW_LABELS, window.kind) ? WINDOW_LABELS[window.kind]!
    : window.label.replace(/\s*周额度$/, modelWeekly(window.kind) ? '' : '周') || window.label
  const used = percent(window.percent)
  const value = `${escape(label)} ${used}`
  if (window.kind === 'monthly') return value
  if (reset === null) return used === 'MISS' ? value : `${value}/MISS`
  return used !== 'MISS' && modelWeekly(window.kind) && reset === weeklyReset ? value : `${value}/${reset}`
}

/** 原生 loginExpiresAt 是最晚到期，实际最多提前 3 天结束：只显示到最早到期的倒计时，格式同距重置。
 * 原生在最晚到期前 10 天（即最早到期前 7 天）开始提醒，显示不超过 7.0d 时标橙；不足 1 天（按 h/m 显示）标红；
 * 已过最早到期时登录随时可能已结束，标红「可能已到期」。颜色只看显示值，同一文案不会时有时无颜色。 */
function credentialExpiry(expiresAt: number | null): string {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return '凭据 MISS'
  const remaining = expiresAt - CLAUDE_LOGIN_EARLY_END_MS - Date.now()
  if (remaining <= 0) return "<font color='red'>凭据 可能已到期</font>"
  const shown = fmtCountdown(remaining)
  const text = `凭据 ${shown}`
  if (!shown.endsWith('d')) return `<font color='red'>${text}</font>`
  return Number.parseFloat(shown) * DAY_MS + CLAUDE_LOGIN_EARLY_END_MS <= CLAUDE_LOGIN_WARNING_MS
    ? `<font color='orange'>${text}</font>` : text
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
    const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${escape(currency)} `
    return `${symbol}${amount.toFixed(2)}`
  }
  if (snapshot.kind === 'balance') return `余额 ${snapshot.balance ? money(snapshot.balance.remaining, snapshot.balance.currency) : 'MISS'}`
  if (snapshot.quota) return snapshot.quota.limit === null ? '额度 未设上限'
    : snapshot.quota.remaining === null ? '额度 MISS'
    // 令牌额度给的是剩余与上限：写明「剩余」，免得在「已用/距重置」标题下读反。
    : `剩余 ${money(snapshot.quota.remaining, snapshot.quota.currency)} / ${money(snapshot.quota.limit, snapshot.quota.currency)}`
  // 每个窗口的距重置只算一次：比较用的就是显示出来的文案。
  const resets = snapshot.windows.map(resetIn)
  const weekly = snapshot.windows.findIndex(window => window.kind === 'weekly')
  const weeklyReset = weekly < 0 ? null : resets[weekly] ?? null
  const parts = snapshot.windows.map((window, index) => windowContent(window, resets[index] ?? null, weeklyReset))
  if (!parts.length) parts.push('额度 MISS')
  const credits = snapshot.credits !== undefined ? codexCreditsSummary(snapshot.credits) : null
  if (credits) parts.push(credits)
  if (snapshot.resetCredits !== undefined && snapshot.resetCredits !== 0) parts.push(`重置 ${snapshot.resetCredits ?? 'MISS'}`)
  if (snapshot.credentialExpiresAt !== undefined) parts.push(credentialExpiry(snapshot.credentialExpiresAt))
  return parts.join(' · ')
}

export function accountUsageRow(row: AccountUsage): object {
  return { tag: 'markdown', text_size: 'notation', content: `**${escape(row.label)}**　${compactAccountUsage(row.usage)}` }
}
