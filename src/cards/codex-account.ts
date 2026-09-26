import type { CodexUsageTotal } from '../codex-account-usage'
import { ELEMENTS } from './elements'
import { fmtResetIn, usageWindowElements } from './usage'
import { compareCodexQuota } from '../codex-quota'
import type { CodexAccountCandidate } from '../codex-account-scheduler'
import type { UsageSnapshot, UsageWindow } from '../usage'

export type CodexAccountPhase = 'connecting' | 'waiting' | 'checking' | 'success' | 'selected' | 'current' | 'accounts' | 'deleted' | 'cancelled' | 'expired' | 'error' | 'warning'
export interface CodexAccountCardView {
  phase: CodexAccountPhase
  flow?: 'login'
  name?: string
  title?: string
  message?: string
  hint?: string
  details?: string
  verification?: { url: string; code: string }
  email?: string | null
  plan?: string
  current?: string
  selected?: string
  total?: CodexUsageTotal
  currentId?: string
  selectedId?: string
  page?: number
  scheduling?: { candidates: CodexAccountCandidate[]; ultra: boolean }
  resetUsage?: UsageSnapshot
}
export const CODEX_ACCOUNTS_PAGE_SIZE = 4
const PHASE = {
  connecting: ['🔄', '连接中', 'blue'], waiting: ['🔐', '等待授权', 'blue'], checking: ['🔎', '校验中', 'blue'],
  success: ['✅', '登录成功', 'green'], selected: ['🎯', '下次启动生效', 'green'], current: ['🧭', '当前账号', 'blue'],
  accounts: ['🗂', '账号与额度', 'blue'], cancelled: ['⏹', '已取消', 'grey'], expired: ['⌛', '等待超时', 'orange'],
  deleted: ['🗑', '已删除', 'grey'],
  error: ['❌', '未完成', 'red'], warning: ['⚠️', '需要处理', 'orange'],
} as const

function text(value: string): string {
  return value.replace(/[&<>\\`*_\[\]~]/g, char => `&#${char.charCodeAt(0)};`)
}
const md = (content: string): object => ({ tag: 'markdown', content })
const muted = (content: string): object => ({ tag: 'markdown', content: `<font color='grey'>${text(content)}</font>`, text_size: 'notation' })
function columns(elements: object[][]): object {
  return { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '12px', columns: elements.map(items => ({ tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', vertical_spacing: '4px', elements: items })) }
}

export function codexAccountSummary(view: CodexAccountCardView): string {
  const [icon, label] = PHASE[view.phase]
  const name = view.name && view.name.length > 40 ? view.name.slice(0, 37) + '…' : view.name
  return `${icon} Codex · ${name ? `${name} · ` : ''}${view.title ?? label}`
}
export function codexAccountCard(view: CodexAccountCardView, streaming = false): object {
  return { schema: '2.0', config: { update_multi: true, width_mode: 'compact', streaming_mode: streaming,
    summary: { content: codexAccountSummary(view) } }, body: { elements: [codexAccountPanel(view)] } }
}
export function codexAccountPanel(view: CodexAccountCardView): object {
  const [, , color] = PHASE[view.phase]
  const elements: object[] = []
  if (view.flow === 'login' && ['connecting', 'waiting', 'checking', 'success'].includes(view.phase)) {
    const stage = view.phase === 'connecting' ? 0 : view.phase === 'waiting' ? 1 : 2
    elements.push(md(['连接', '授权', '就绪'].map((label, i) => i === stage ? `**${i + 1} ${label}**` : `${i < stage ? '✓' : i + 1} ${label}`).join('　→　')))
  }
  if (view.phase === 'waiting' && view.verification) {
    const url = new URL(view.verification.url)
    if (url.protocol !== 'https:' || /[\s<>]/.test(view.verification.url)) throw new Error('授权链接无效')
    if (!/^[A-Za-z0-9-]{1,64}$/.test(view.verification.code)) throw new Error('验证码格式无效')
    elements.push(columns([
      [muted('验证码'), { tag: 'markdown', content: `**${view.verification.code}**`, text_size: 'heading-2' }],
      [md(`[**打开授权页 ↗**](${url.href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`), muted('登录账号，输入左侧验证码')],
    ]))
  }
  if (view.current) {
    elements.push(columns([
      [muted('当前使用'), md(`**${text(view.current)}**`)],
      ...(view.selected && view.selected !== view.current ? [[muted('下次启动'), md(`**${text(view.selected)}**`)]] : []),
    ]))
  }
  if (view.plan || view.email) elements.push(md([view.plan?.toUpperCase(), view.email].filter(Boolean).map(value => text(value!)).join(' · ')))
  if (view.message) elements.push(md(text(view.message)))
  if (view.resetUsage) {
    const usage = view.resetUsage
    elements.push(md(`**重置卡**　${usage.state === 'ok' && usage.resetCredits != null ? `${usage.resetCredits} 次可用` : 'MISS'}`))
    if (usage.state === 'ok') {
      for (const [window, label] of [[usage.fiveHour, '5h'], [usage.weekly, '周']] as const) {
        if (window) elements.push(...usageWindowElements(window, label))
      }
    } else elements.push(md('⚠️ 额度 MISS · 查看详情中的查询错误'))
  }
  if (view.total) elements.push(...accountRows(view))
  if (view.phase === 'accounts') elements.push({ tag: 'collapsible_panel', expanded: false,
    header: { title: { tag: 'plain_text', content: '⌨️ Codex 命令' }, background_color: 'grey-50' },
    border: { color: 'grey-100', corner_radius: '8px' }, padding: '8px', elements: [md([
      '`hi` · 打开控制台；未运行时启动',
      '`hi 备注` · 本次指定账号；换号时重启并续跑',
      '`codex-login [备注]` · 设备码登录；省略备注为默认账号',
      '`codex-login-cancel [备注]` · 取消本人在本群的登录；仅一个任务时可省略备注',
      '`codex-accounts [页码]` · 查看账号、额度与调度顺序',
      '`codex-reset [备注]` · 使用一次重置卡；省略备注为当前使用账号',
      '`codex-account` · 查看当前账号与下次启动策略',
      '`codex-account 备注` · 持久指定账号，下次启动生效',
      '`codex-auto` · 清除指定，下次启动自动选择',
      '`codex-account-delete 备注` · 删除额外账号',
    ].join('\n')), muted('备注可用 default 指定设备默认账号；默认账号不可删除。')] })
  if (view.hint) elements.push(muted(view.hint))
  if (view.details) elements.push({ tag: 'collapsible_panel', expanded: false,
    header: { title: { tag: 'plain_text', content: '查看详情' } }, elements: [md(text(view.details))] })
  return { tag: 'collapsible_panel', element_id: ELEMENTS.codexAccountPanel, expanded: true,
    header: { title: { tag: 'plain_text', content: codexAccountSummary(view) }, background_color: `${color}-50` },
    border: { color: `${color}-100`, corner_radius: '8px' }, padding: view.phase === 'accounts' ? '8px' : '12px',
    ...(view.phase === 'accounts' ? { vertical_spacing: '8px' } : {}), elements }
}

function accountUsageWindow(window: UsageWindow | null, label: string): object {
  const value = window?.percent
  if (value == null || !Number.isFinite(value) || value < 0 || value > 100) return md(`${label}　MISS`)
  const filled = Math.round(value / 100 * 6)
  const color = value >= 100 ? 'red' : value >= 80 ? 'orange' : 'green'
  const reset = window!.unreportedFull ? '满窗'
    : window!.resetsAt && Number.isFinite(window!.resetsAt.getTime()) ? fmtResetIn(window!.resetsAt) : 'MISS'
  return md(`${label}　<font color='${color}'>${'▰'.repeat(filled)}${'▱'.repeat(6 - filled)}</font>　${Math.round(value)}% <font color='grey'>「${reset}」</font>`)
}

function accountRows(view: CodexAccountCardView): object[] {
  const total = view.total!
  const pages = Math.max(1, Math.ceil(total.entries.length / CODEX_ACCOUNTS_PAGE_SIZE))
  const page = view.page ?? 1
  if (!Number.isInteger(page) || page < 1 || page > pages) throw new Error(`页码应为 1–${pages}`)
  const elements: object[] = []
  const ranked = view.scheduling?.candidates.filter(c => c.state === 'ready').sort(compareCodexQuota) ?? []
  const positions = new Map(ranked.map((candidate, index) => [candidate.account.id, index + 1]))
  const entries = total.entries.slice().sort((a, b) =>
    (positions.get(a.account.id) ?? Infinity) - (positions.get(b.account.id) ?? Infinity))
  for (const entry of entries.slice((page - 1) * CODEX_ACCOUNTS_PAGE_SIZE, page * CODEX_ACCOUNTS_PAGE_SIZE)) {
    const usage = entry.usage
    const row: object[] = []
    const schedule = view.scheduling?.candidates.find(c => c.account.id === entry.account.id)
    const position = positions.get(entry.account.id)
    const score = entry.duplicateOf ? '重复' : schedule?.state === 'ready'
      ? schedule.priority === 'expiring' ? '临期优先' : `${schedule.score!.toPrecision(3)}/h`
      : 'MISS'
    elements.push({ tag: 'collapsible_panel', expanded: true,
      header: { title: { tag: 'plain_text', content: `#${position ?? '—'}·${entry.account.name}「${score}」 · 重置 ${usage.state === 'ok' ? usage.resetCredits ?? 'MISS' : 'MISS'}` }, background_color: 'grey-50' },
      border: { color: 'grey-100', corner_radius: '8px' }, padding: '8px', vertical_spacing: '2px', elements: row })
    row.push(muted(`邮箱：${entry.email ?? 'MISS'}`))
    if (entry.emailError) row.push({ tag: 'collapsible_panel', expanded: false,
      header: { title: { tag: 'plain_text', content: '邮箱查询错误' } }, elements: [md(text(entry.emailError))] })
    if (entry.duplicateOf) { row.push(muted(`与「${entry.duplicateOf}」同一账号，合计只计一次`)); continue }
    if (schedule && schedule.state !== 'ready') {
      row.push(muted(schedule.state === 'exhausted' ? '⏳ 耗尽 · 暂不参与'
          : schedule.state === 'excluded' ? 'Ultra 自动排除 Plus'
          : schedule.state === 'waiting' ? `⏳ 周余量 ${schedule.remaining?.toPrecision(3)} 份 · 未达 0.5 份`
          : 'MISS · 无法排序'))
      if (schedule.state === 'miss' && schedule.reason && usage.state === 'ok') row.push({ tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: '未参与原因' } }, elements: [md(text(schedule.reason))] })
    }
    if (usage.state !== 'ok') {
      row.push(md(usage.state === 'no_credentials' ? '⚪ 未登录' : '⚠️ 额度 MISS'))
      if (usage.state === 'network' && usage.reason) row.push({ tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: '查询错误' } }, elements: [md(text(usage.reason))] })
      continue
    }
    row.push(accountUsageWindow(usage.weekly, '周'))
    if (usage.fiveHour) row.push(accountUsageWindow(usage.fiveHour, '5h'))
  }
  if (pages > 1) elements.push(muted(`${page}/${pages} 页 · ${page < pages ? `下一页 codex-accounts ${page + 1}` : '首页 codex-accounts'}`))
  return elements
}
