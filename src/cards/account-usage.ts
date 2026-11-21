import type { AccountUsage } from '../account-usage'
import type { UsageSnapshotUnified, UsageWindowUnified } from '../token-source'
import { CLAUDE_LOGIN_EARLY_END_MS, CLAUDE_LOGIN_WARNING_MS } from '../claude-credential'
import { codexCreditsSummary, fmtCountdown } from './usage'

// 额度明细：单聊面板（全部账号）与群里 hi（本项目账号）共用一套写法，以清晰为先。
// - 一个账号一块：首行账号名，后面跟单值结果（余额、失败原因等）或账号级事实（积分、重置卡、凭据剩余）。
// - 每个额度窗口单独一行：`名称　进度条 已用%　N 后重置`；距重置与凭据共用 fmtCountdown（m / 一位小数的 h、d）。
// - 整窗未知只写一次 MISS；已用已知而重置时间未知写「重置时间 MISS」；GLM 月工具只显示百分比。
// - 积分、重置卡确认为零时省略，未知写 MISS；金额符号紧贴数字，与回复 footer 一致。
// - 颜色只看显示值（百分比、进度条与凭据倒计时），同一文案颜色不变。

const DAY_MS = 86_400_000
const BAR_CELLS = 6

/** 单行纯文本放进卡片 markdown：换行并成空格，markdown 与标签字符转成实体。 */
export function escapeInlineMarkdown(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[&<>\\`*_\[\]~]/g, char => `&#${char.charCodeAt(0)};`)
}
const escape = escapeInlineMarkdown
const grey = (text: string): string => `<font color='grey'>${text}</font>`

/** 显示用的已用百分比（四舍五入）；不是 0–100 的数字时为 null，按 MISS 显示。 */
function shownPercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null
}

/** 颜色只看显示值：79.6 显示为 80% 即标橙，99.6 显示为 100% 即标红，同一文案颜色不变。 */
function percentText(shown: number): string {
  const text = `${shown}%`
  return shown >= 100 ? `<font color='red'>${text}</font>` : shown >= 80 ? `<font color='orange'>${text}</font>` : text
}

/** 六格进度条，格数与颜色都按显示值：80% 起橙、100% 红，其余绿。 */
function usageBar(shown: number): string {
  const filled = Math.round(shown / 100 * BAR_CELLS)
  const color = shown >= 100 ? 'red' : shown >= 80 ? 'orange' : 'green'
  return `<font color='${color}'>${'▰'.repeat(filled)}${'▱'.repeat(BAR_CELLS - filled)}</font>`
}

/** Claude 的模型专属周额度（含 OAuth 应用）。 */
const MODEL_WEEKLY_NAMES: Record<string, string> = {
  seven_day_opus: 'Opus', seven_day_sonnet: 'Sonnet', seven_day_oauth_apps: 'OAuth 应用',
}

/** 中转站脚本的窗口可能缺 kind 或不是字符串：只当作未登记的窗口，不能抛错。 */
function modelWeekly(kind: unknown): kind is string {
  return typeof kind === 'string' && (kind.startsWith('modelWeekly:') || Object.hasOwn(MODEL_WEEKLY_NAMES, kind))
}

/** 窗口名：5h、周、月工具；模型专属周额度写作「模型名 周」，与总周并列；其他来源未登记的窗口照写接口给的名称。 */
function windowLabel(window: UsageWindowUnified): string {
  const kind: unknown = window.kind
  const label = typeof window.label === 'string' ? window.label.trim() : ''
  if (kind === 'fiveHour') return '5h'
  if (kind === 'weekly') return '周'
  if (kind === 'monthly') return '月工具'
  if (modelWeekly(kind)) {
    const name = Object.hasOwn(MODEL_WEEKLY_NAMES, kind) ? MODEL_WEEKLY_NAMES[kind]! : kind.slice('modelWeekly:'.length)
    return label.replace(/额度$/, '') || `${name} 周`
  }
  return label || '额度'
}

/** 中转站余额脚本的 JSON 原样转入、日期是字符串：只认真正的 Date，其余按 MISS，不能让整个额度区出错。 */
function resetText(window: UsageWindowUnified): string | null {
  const date: unknown = window.resetsAt
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null
  const remaining = date.getTime() - Date.now()
  return remaining <= 0 ? '已重置' : `${fmtCountdown(remaining)} 后重置`
}

/** 一个窗口一行：`5h　▰▰▱▱▱▱ 34%　4.1h 后重置`。整窗未知只写一次 MISS，所以 `名称　MISS` 只表示什么都不知道。 */
function windowLine(window: UsageWindowUnified): string {
  const label = escape(windowLabel(window))
  const shown = shownPercent(window.percent)
  const used = shown === null ? 'MISS' : `${usageBar(shown)} ${percentText(shown)}`
  if (window.kind === 'monthly') return `${label}　${used}`
  const reset = resetText(window)
  if (reset === null) return shown === null ? `${label}　MISS` : `${label}　${used}　${grey('重置时间 MISS')}`
  return `${label}　${used}　${grey(reset)}`
}

/** 原生 loginExpiresAt 是最晚到期，实际最多提前 3 天结束：只显示到最早到期的剩余时间，格式同距重置。
 * 原生在最晚到期前 10 天（即最早到期前 7 天）开始提醒，显示不超过 7.0d 时标橙；不足 1 天（按 h/m 显示）标红；
 * 已过最早到期时登录随时可能已结束，标红「凭据可能已到期」。颜色只看显示值，同一文案不会时有时无颜色。 */
function credentialFact(expiresAt: number | null): string {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return '凭据 MISS'
  const remaining = expiresAt - CLAUDE_LOGIN_EARLY_END_MS - Date.now()
  if (remaining <= 0) return "<font color='red'>凭据可能已到期</font>"
  const shown = fmtCountdown(remaining)
  const text = `凭据剩余 ${shown}`
  if (!shown.endsWith('d')) return `<font color='red'>${text}</font>`
  return Number.parseFloat(shown) * DAY_MS + CLAUDE_LOGIN_EARLY_END_MS <= CLAUDE_LOGIN_WARNING_MS
    ? `<font color='orange'>${text}</font>` : text
}

/** 金额符号紧贴数字；中转站脚本没给币种（或给的不是字符串）时只写数字。 */
function money(amount: unknown, currency: unknown): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return 'MISS'
  const code = typeof currency === 'string' ? currency.trim() : ''
  const symbol = code === 'USD' ? '$' : code === 'CNY' ? '¥' : code ? `${escape(code)} ` : ''
  return `${symbol}${amount.toFixed(2)}`
}

/** 重置卡次数只认非负整数，其余（含 null）按 MISS。 */
function resetCardCount(count: unknown): string {
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? String(count) : 'MISS'
}

/** 一个账号的额度明细。 */
export interface AccountUsageDetail {
  /** 与账号名同一行：单值结果（余额、令牌额度、加载中、无额度查询），或积分、重置卡、凭据等账号级事实；可能为空。失败只写 `MISS`。 */
  summary: string
  /** 每个额度窗口一行；单值结果时为空。 */
  windows: string[]
  /** 读取失败时的完整原因，供默认折叠的错误详情使用；正常、加载中与不适用时为 undefined。 */
  error?: string
}

/** 额度快照里有中转站脚本原样转入的数据：任何格式问题都只让这一个账号显示 MISS，不能让整个面板生成失败。 */
export function accountUsageDetail(snapshot: UsageSnapshotUnified | undefined): AccountUsageDetail {
  try {
    return usageDetail(snapshot)
  } catch {
    return { summary: "<font color='red'>MISS</font>", windows: [], error: '额度数据格式无效' }
  }
}

function usageDetail(snapshot: UsageSnapshotUnified | undefined): AccountUsageDetail {
  const single = (summary: string): AccountUsageDetail => ({ summary, windows: [] })
  if (!snapshot) return single('加载中…')
  if (snapshot.state === 'not_applicable') return single(grey('无额度查询'))
  if (snapshot.state !== 'ok') {
    const reason = snapshot.state === 'no_credentials' ? '未登录或未配置'
      : snapshot.state === 'rate_limited' ? 'API 限频'
      : String(snapshot.reason ?? '查询失败').replace(/^Claude 原生额度接口未返回 rate_limits 数据$/, '原生接口未返回额度')
    // 行内只留 MISS：原因放进默认折叠的错误详情，长错误不挤坏版面。
    return { summary: "<font color='red'>MISS</font>", windows: [], error: reason.slice(0, 300) }
  }
  if (snapshot.kind === 'balance') {
    return single(`余额 ${snapshot.balance ? money(snapshot.balance.remaining, snapshot.balance.currency) : 'MISS'}`)
  }
  if (snapshot.quota) {
    const { remaining, limit, currency } = snapshot.quota
    return single(limit === null ? '额度 未设上限' : remaining === null ? '额度 MISS'
      // 令牌额度给的是剩余与上限：写明「剩余」，免得读成已用。
      : `剩余 ${money(remaining, currency)} / ${money(limit, currency)}`)
  }
  // 脚本给的不是窗口对象时，这一项按整窗未知处理。
  const windows = snapshot.windows.map(window => typeof window === 'object' && window !== null ? windowLine(window) : '额度　MISS')
  const facts: string[] = windows.length ? [] : ['额度 MISS']
  const credits = snapshot.credits !== undefined ? codexCreditsSummary(snapshot.credits) : null
  if (credits) facts.push(credits)
  if (snapshot.resetCredits !== undefined && snapshot.resetCredits !== 0) facts.push(`重置卡 ${resetCardCount(snapshot.resetCredits)}`)
  if (snapshot.credentialExpiresAt !== undefined) facts.push(credentialFact(snapshot.credentialExpiresAt))
  return { summary: facts.join(' · '), windows }
}

/** 失败原因（供折叠的错误详情）；正常、加载中或不适用时为 null。 */
export function accountUsageError(snapshot: UsageSnapshotUnified | undefined): string | null {
  return accountUsageDetail(snapshot).error ?? null
}

/** 群里 hi 的本项目账号（账号名已在上方）：摘要在前，其后每个窗口一行。 */
export function accountUsageLines(snapshot: UsageSnapshotUnified | undefined): string[] {
  const { summary, windows } = accountUsageDetail(snapshot)
  return summary ? [summary, ...windows] : windows
}

/** 单聊面板的一个账号：首行加粗账号名与摘要，其后每个窗口一行。 */
export function accountUsageBlock(row: AccountUsage): string {
  const { summary, windows } = accountUsageDetail(row.usage)
  return [`**${escape(row.label)}**${summary ? `　${summary}` : ''}`, ...windows].join('\n')
}
