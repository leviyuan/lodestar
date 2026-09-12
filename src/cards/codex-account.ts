import type { CodexUsageTotal } from '../codex-account-usage'
import type { UsageWindow } from '../usage'
import { ELEMENTS } from './elements'
import { fmtResetIn } from './console'
import type { CodexAccountCandidate } from '../codex-account-scheduler'

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
  if (view.total) elements.push(...accountRows(view))
  if (view.hint) elements.push(muted(view.hint))
  if (view.details) elements.push({ tag: 'collapsible_panel', expanded: false,
    header: { title: { tag: 'plain_text', content: '查看详情' } }, elements: [md(text(view.details))] })
  return { tag: 'collapsible_panel', element_id: ELEMENTS.codexAccountPanel, expanded: true,
    header: { title: { tag: 'plain_text', content: codexAccountSummary(view) }, background_color: `${color}-50` },
    border: { color: `${color}-100`, corner_radius: '8px' }, padding: '12px', elements }
}

function accountRows(view: CodexAccountCardView): object[] {
  const total = view.total!
  const pages = Math.max(1, Math.ceil(total.entries.length / CODEX_ACCOUNTS_PAGE_SIZE))
  const page = view.page ?? 1
  if (!Number.isInteger(page) || page < 1 || page > pages) throw new Error(`页码应为 1–${pages}`)
  const elements: object[] = [muted(`${total.entries.length} 个记录 · 可用 ${total.available ?? 'MISS'} 个账号${total.complete ? '' : ' · 汇总不完整'}`)]
  const ranked = view.scheduling?.candidates.filter(c => c.state === 'ready').sort((a, b) =>
    b.score! - a.score! || (b.availableNow ?? 0) - (a.availableNow ?? 0) || a.account.id.localeCompare(b.account.id))
  if (view.scheduling) elements.push(muted(`${view.scheduling.ultra ? 'Ultra · Pro ≥ 0.5 份' : '普通 · 周 / 5h 综合'} · 最高分优先 · 可调度 ${ranked!.length}`))
  for (const entry of total.entries.slice((page - 1) * CODEX_ACCOUNTS_PAGE_SIZE, page * CODEX_ACCOUNTS_PAGE_SIZE)) {
    const badges = [entry.account.id === view.currentId ? '使用中' : '',
      entry.account.id === view.selectedId && view.selectedId !== view.currentId ? '下次启动' : ''].filter(Boolean)
    const usage = entry.usage
    const row: object[] = []
    elements.push({ tag: 'collapsible_panel', expanded: true,
      header: { title: { tag: 'plain_text', content: `${entry.account.name}${badges.length ? ` · ${badges.join(' · ')}` : ''}` },
        background_color: entry.account.id === view.currentId ? 'blue-50' : 'grey-50' },
      border: { color: 'grey-100', corner_radius: '8px' }, padding: '8px', vertical_spacing: '4px', elements: row })
    if (entry.duplicateOf) { row.push(muted(`与「${entry.duplicateOf}」同一账号，合计只计一次`)); continue }
    const schedule = view.scheduling?.candidates.find(c => c.account.id === entry.account.id)
    if (schedule) {
      const position = ranked!.findIndex(c => c.account.id === entry.account.id)
      row.push(schedule.state === 'ready'
        ? md(`**#${position + 1} · ${schedule.score!.toPrecision(3)} 份/h**`)
        : muted(schedule.state === 'exhausted' ? '⏳ 耗尽 · 暂不参与'
          : schedule.state === 'excluded' ? 'Ultra 自动排除 Plus'
          : schedule.state === 'waiting' ? `⏳ 周余量 ${schedule.remaining?.toPrecision(3)} 份 · 未达 0.5 份`
          : 'MISS · 无法排序'))
      if (schedule.state === 'ready' && schedule.remaining != null) row.push(muted(
        `周余量 ${schedule.remaining.toPrecision(3)} 份${schedule.fiveHourRemaining != null ? ` · 5h ${schedule.fiveHourRemaining.toPrecision(3)} 份` : ''}`))
      if (schedule.state === 'miss' && schedule.reason && usage.state === 'ok') row.push({ tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: '未参与原因' } }, elements: [md(text(schedule.reason))] })
    }
    if (usage.state !== 'ok') {
      row.push(md(usage.state === 'no_credentials' ? '⚪ 未登录' : '⚠️ 额度 MISS'))
      if (usage.state === 'network' && usage.reason) row.push({ tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: '查询错误' } }, elements: [md(text(usage.reason))] })
      continue
    }
    const plan = usage.subscriptionType === 'pro' ? 'Pro 20×' : usage.subscriptionType === 'prolite' ? 'Pro 5×'
      : usage.subscriptionType === 'plus' ? 'Plus 1×' : usage.subscriptionType ?? '套餐 MISS'
    row.push(muted(`${plan} · 重置卡 ${usage.resetCredits ?? 'MISS'}`))
    const windows = [windowCard(usage.fiveHour, '5h'), windowCard(usage.weekly, '周')].filter((w): w is object[] => w !== null)
    if (windows.length) row.push(columns(windows))
  }
  if (pages > 1) elements.push(muted(`${page}/${pages} 页 · ${page < pages ? `下一页 codex-accounts ${page + 1}` : '首页 codex-accounts'}`))
  return elements
}
function windowCard(window: UsageWindow | null, label: string): object[] | null {
  if (!window) return null
  const value = window.percent
  if (value === null || !Number.isFinite(value) || value < 0 || value > 100) return [md(`**${label} · MISS**`)]
  const filled = Math.round(value / 100 * 6)
  const color = value >= 100 ? 'red' : value >= 80 ? 'orange' : 'green'
  return [md(`**${label} · ${Math.round(value)}%**\n<font color='${color}'>${'▰'.repeat(filled)}${'▱'.repeat(6 - filled)}</font>`),
    muted(window.unreportedFull ? '满窗 · 0.15 份' : window.resetsAt ? `${fmtResetIn(window.resetsAt)} 重置` : '重置时间 MISS')]
}
