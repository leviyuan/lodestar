import { agentProviderLabel } from '../agent-process'
/**
 * Console / menu / settings cards — every non-turn-card Feishu surface
 * the daemon paints. Companion file to turn.ts; both re-exported from
 * src/cards.ts.
 */

import { SERVICE_LABEL, type SysInfo } from '../sysinfo'
import type { UsageSnapshot } from '../usage'
import type { GlmUsageSnapshot } from '../glm-usage'
import type { UsageSnapshotUnified, TokenSourceModelCatalogState } from '../token-source'
import type { AgentProvider } from '../agent-process'
import { ELEMENTS } from './elements'
import { formatDuration } from './duration'
import { fmtResetIn } from './usage'
import type { AccountUsage } from '../account-usage'
import { accountUsageRow, compactAccountUsage } from './account-usage'

export { fmtResetIn } from './usage'

export interface ConsoleOpts {
  accountUsages?: AccountUsage[]
  sessionName: string
  status: 'idle' | 'working' | 'awaiting_permission' | 'starting' | 'stopped'
  provider?: AgentProvider
  model?: string
  effort?: string
  worktreeInstructionNotice?: string | null
  /** All sessions currently running across every Feishu group
   * this daemon owns. Each entry is a sibling project. Empty/undefined
   * → 渲染 `_无_`。The session matching this card's chat is
   * flagged `isCurrent` so the row can be marked. */
  peers?: Array<{
    name: string
    isCurrent: boolean
    status: 'idle' | 'working' | 'awaiting_permission' | 'starting' | 'stopped'
    uptimeMs?: number
    /** Actual live Codex process account, independent of the next-start selection. */
    codexAccountName?: string
  }>
  /** Subscription usage snapshot from Codex app-server. Undefined → omit row.
   * 仅 codex 后端渲染;claude/GLM 后端走 glmUsage。 */
  usage?: UsageSnapshot
  /** GLM Coding Plan 用量快照(claude/GLM 后端)。Undefined → loading 占位。
   * 仅 claude 后端渲染;codex 后端走 usage。按 provider 二选一(方案 C)。 */
  glmUsage?: GlmUsageSnapshot
  /** 统一用量快照(来自 tokenSource.readUsage)。设了优先用它(取代 usage/glmUsage 二元)。
   * 加新 token source 的额度自动支持 —— 只要 source.readUsage 返回 unified。 */
  unifiedUsage?: UsageSnapshotUnified
  /** Host snapshot: CPU 负载、内存、AI-managed systemd 服务。
   * undefined 或字段缺失时明确渲染 `_n/a_`,不假数据。 */
  sysinfo?: SysInfo
}

interface StatusCardOpts {
  sessionName: string
  title: string
  status: string
  template?: 'blue' | 'green' | 'orange' | 'red' | 'grey' | 'turquoise'
}

export interface ModelChoice {
  provider?: AgentProvider
  /** 关联的 token source id(面板展开成 source×model 后,标记这条属于哪个 source) */
  sourceId?: string
  model: string
  displayName: string
  description?: string
  isDefault?: boolean
  selected?: boolean
  /** 该 source 是否已配置凭据;false = 灰显 +「启用」按钮(未配置 source 的占位项) */
  enabled?: boolean
  unavailableReason?: string
  origin?: 'upstream' | 'custom'
  efforts: ModelEffortChoice[]
}

export interface ModelEffortChoice {
  effort: string
  description?: string
  isDefault?: boolean
  selected?: boolean
}

interface ModelSelectionCardOpts {
  sessionName: string
  panelId: string
  currentModel?: string | null
  currentEffort?: string | null
  models: ModelChoice[]
  pagination?: { sourceId: string; page: number; totalPages: number }
  sourceId?: string
  editable?: boolean
  allowCustom?: boolean
  mode?: 'select' | 'add'
}

interface ModelEffortSelectionCardOpts {
  sessionName: string
  panelId: string
  currentModel?: string | null
  currentEffort?: string | null
  model: ModelChoice
}

interface ModelResultPanelOpts {
  sessionName: string
  provider?: AgentProvider
  model: string
  effort: string
  scope: string
}

export function statusCardContent(_title: string, status: string): string {
  return status
}

export function statusCard(opts: StatusCardOpts): object {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: true,
      summary: { content: opts.status },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: ELEMENTS.footer,
          content: statusCardContent(opts.title, opts.status),
        },
      ],
    },
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)}M`
  const gb = n / (1024 * 1024 * 1024)
  return gb < 10 ? `${gb.toFixed(1)}G` : `${gb.toFixed(0)}G`
}

/** Format token counts as a compact human-readable string: 1,234 → 1.2K. */
function fmtTokens(n: number): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K'
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M'
}

function fmtUptime(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h < 24) return `${h}h ${m}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

const PEER_STATUS_EMOJI: Record<string, string> = {
  idle: '🟢', working: '⚙️', awaiting_permission: '🔐',
  starting: '🚀', stopped: '⚪',
}

const PEER_STATUS_LABEL: Record<string, string> = {
  idle: '闲',
  working: '工作中',
  awaiting_permission: '等审批',
  starting: '启动中',
  stopped: '未运行',
}

/** Render the subscription-usage section of the console card. Pulled out
 * of `consoleCard` so the caller can patch it in after the initial card
 * is on screen (网络往返可能慢于第一次 paint;先占位、回包后替换)。
 *
 * 数据源是 Codex app-server 的 ChatGPT 账号与 OpenAI/Codex rate-limit
 * 快照 (见 src/usage.ts)。百分比是真实 usedPercent,失败态按 state 区分。
 *
 * `usage === undefined` → 初始 loading 占位。
 */
export function consoleUsageContent(
  usage: UsageSnapshot | undefined,
): string {
  if (usage === undefined) return '**📊 订阅额度**　_加载中…_'
  switch (usage.state) {
    case 'no_credentials':
      return '**📊 Codex 额度**　未登录 ChatGPT — 运行 `codex login`'
    case 'auth_failed':
      return '**📊 Codex 额度**　当前不是 ChatGPT 登录 — 请运行 `codex login`'
    case 'rate_limited':
      return '**📊 Codex 额度**　API 429 限流,稍后重试'
    case 'network':
      return `**📊 Codex 额度**　拉取失败${usage.reason ? ' — `' + usage.reason + '`' : ''}`
  }
  const head = usage.subscriptionType
    ? `**📊 Codex 额度** · ChatGPT ${usage.subscriptionType}`
    : '**📊 Codex 额度**'
  const lines: string[] = [head]
  if (usage.fiveHour) {
    const parts = [fmtUsagePercent(usage.fiveHour.percent)]
    if (usage.fiveHour.resetsAt) parts.push(`重置 ${fmtResetIn(usage.fiveHour.resetsAt)}`)
    lines.push(`　· ${fmtWindowLabel(usage.fiveHour.durationMins, '主窗口')}　${parts.join(' · ')}`)
  }
  if (usage.weekly) {
    const parts = [fmtUsagePercent(usage.weekly.percent)]
    if (usage.weekly.resetsAt) parts.push(`重置 ${fmtResetIn(usage.weekly.resetsAt)}`)
    lines.push(`　· ${fmtWindowLabel(usage.weekly.durationMins, '次窗口')}　${parts.join(' · ')}`)
  }
  return lines.length === 1 ? '**📊 Codex 额度**　_无数据_' : lines.join('\n')
}

/** Render the GLM Coding Plan usage row for the console card. 数据源是
 * src/glm-usage.ts 打的 open.bigmodel.cn / api.z.ai quota/limit。结构与左侧
 * Codex 行对齐(标题挂套餐档 + 两个窗口行),失败态按 no_fallbacks 显式 MISS。
 *
 * `glmUsage === undefined` → 初始 loading 占位。 */
export function consoleGlmUsageContent(glmUsage: GlmUsageSnapshot | undefined): string {
  if (glmUsage === undefined) return '**📊 GLM 额度**　_加载中…_'
  switch (glmUsage.state) {
    case 'no_credentials':
      return '**📊 GLM 额度**　未配置 `ANTHROPIC_AUTH_TOKEN` — 检查 ~/.claude/settings.json'
    case 'not_glm':
      return '**📊 GLM 额度**　非 GLM 后端 — ANTHROPIC_BASE_URL 不是 bigmodel / z.ai'
    case 'rate_limited':
      return '**📊 GLM 额度**　API 限流,稍后重试'
    case 'network':
      return `**📊 GLM 额度**　拉取失败${glmUsage.reason ? ' — `' + glmUsage.reason + '`' : ''}`
  }
  // level 是 GLM 原样返回的小写档位名(max/standard/lite…),首字母大写对齐观感。
  const levelLabel = glmUsage.level
    ? glmUsage.level.charAt(0).toUpperCase() + glmUsage.level.slice(1)
    : ''
  const head = levelLabel
    ? `**📊 GLM 额度** · ${levelLabel} 套餐`
    : '**📊 GLM 额度**'
  const lines: string[] = [head]
  if (glmUsage.fiveHour) {
    const parts = [fmtUsagePercent(glmUsage.fiveHour.percent)]
    if (glmUsage.fiveHour.resetsAt) parts.push(`重置 ${fmtResetIn(glmUsage.fiveHour.resetsAt)}`)
    lines.push(`　· 5h 窗口　${parts.join(' · ')}`)
  }
  if (glmUsage.weekly) {
    const parts = [fmtUsagePercent(glmUsage.weekly.percent)]
    if (glmUsage.weekly.resetsAt) parts.push(`重置 ${fmtResetIn(glmUsage.weekly.resetsAt)}`)
    lines.push(`　· 周额度　${parts.join(' · ')}`)
  }
  if (glmUsage.monthly) {
    const parts = [fmtUsagePercent(glmUsage.monthly.percent)]
    if (typeof glmUsage.monthly.used === 'number' && typeof glmUsage.monthly.total === 'number') {
      parts.push(`${glmUsage.monthly.used}/${glmUsage.monthly.total}`)
    }
    if (glmUsage.monthly.resetsAt) parts.push(`重置 ${fmtResetIn(glmUsage.monthly.resetsAt)}`)
    lines.push(`　· 月度工具　${parts.join(' · ')}`)
  }
  return lines.length === 1 ? '**📊 GLM 额度**　_无数据_' : lines.join('\n')
}

function fmtUsagePercent(percent: number | null | undefined): string {
  return typeof percent === 'number' && Number.isFinite(percent) ? `${Math.round(percent)}%` : 'MISS'
}

function fmtWindowLabel(mins: number | null | undefined, fallback: string): string {
  if (!mins || mins <= 0) return fallback
  if (mins % (24 * 60) === 0) return `${mins / (24 * 60)}d`
  if (mins % 60 === 0) return `${mins / 60}h`
  return `${mins}m`
}

const SERVICE_STATUS_EMOJI: Record<string, string> = {
  active: '🟢', activating: '🚀', reloading: '🔄',
  inactive: '⚪', deactivating: '🟡', failed: '❌',
}

/** Host snapshot panel body: 负载、内存、服务列表。 */
function hostSummary(sysinfo?: SysInfo): string[] {
  const parts: string[] = []
  if (sysinfo?.cpu) parts.push(`L${sysinfo.cpu.load1.toFixed(2)}`)
  if (sysinfo?.mem) parts.push(`M${sysinfo.mem.percent}%`)
  if (sysinfo && !sysinfo.servicesError) parts.push(`S${sysinfo.services.length}`)
  return parts
}

export function consoleHostContent(sysinfo?: SysInfo): string {
  if (!sysinfo) {
    return [
      '**负载**　_n/a_',
      '**内存**　_n/a_',
      `**服务** ${SERVICE_LABEL}　_n/a_`,
    ].join('\n')
  }

  const lines: string[] = []
  if (sysinfo.cpu) {
    const { cores, load1, load5, load15 } = sysinfo.cpu
    lines.push(`**负载**　${load1.toFixed(2)} / ${load5.toFixed(2)} / ${load15.toFixed(2)} (${cores}核)`)
  } else {
    lines.push('**负载**　_n/a_')
  }

  if (sysinfo.mem) {
    lines.push(`**内存**　${sysinfo.mem.percent}% (${fmtBytes(sysinfo.mem.usedBytes)}/${fmtBytes(sysinfo.mem.totalBytes)})`)
  } else {
    lines.push('**内存**　_n/a_')
  }

  if (sysinfo.servicesError) {
    lines.push(`**服务** ${SERVICE_LABEL}　_${sysinfo.servicesError}_`)
  } else if (sysinfo.services.length === 0) {
    lines.push(`**服务** ${SERVICE_LABEL}　_无_`)
  } else {
    lines.push(`**服务** ${SERVICE_LABEL} (${sysinfo.services.length})`)
    for (const s of sysinfo.services) {
      const dot = SERVICE_STATUS_EMOJI[s.active] ?? '·'
      const lastActive = s.lastActiveAgoSec
      const stateAge = s.stateAgoSec
      const parts: string[] = [s.active]
      if (s.active === 'active') {
        if (stateAge != null) parts.push(`已运行 ${fmtUptime(stateAge * 1000)}`)
      } else if (s.active === 'inactive' || s.active === 'failed') {
        if (lastActive != null) {
          parts.push(`上次活跃 ${fmtUptime(lastActive * 1000)}前`)
        } else {
          parts.push('从未启动')
        }
        if (stateAge != null) {
          const verb = s.active === 'failed' ? '已挂' : '已停'
          parts.push(`${verb} ${fmtUptime(stateAge * 1000)}`)
        }
      } else if (stateAge != null) {
        parts.push(`已 ${fmtUptime(stateAge * 1000)}`)
      }
      lines.push(`　· ${dot} \`${s.name}\` · ${parts.join(' · ')}`)
    }
  }

  return lines.join('\n')
}

export function consoleMainContent(opts: ConsoleOpts): string {
  const peers = opts.peers ?? []
  if (peers.length === 0) return '_无_'
  return peers.map((p) => {
    const dot = PEER_STATUS_EMOJI[p.status] ?? '·'
    const label = PEER_STATUS_LABEL[p.status] ?? p.status
    const up = p.uptimeMs != null && p.uptimeMs > 0 ? ` · ${fmtUptime(p.uptimeMs)}` : ''
    const mark = p.isCurrent ? ' · 当前' : ''
    const account = p.codexAccountName === undefined ? '' : ` · Codex：${inlineCode(escapeMarkdown(p.codexAccountName))}`
    return `　· ${dot} \`${p.name}\` · ${label}${up}${mark}${account}`
  }).join('\n')
}

export function consoleMainElement(opts: ConsoleOpts, elementId = ELEMENTS.consoleProjects): object {
  const peers = opts.peers ?? []
  return {
    tag: 'collapsible_panel',
    element_id: elementId,
    header: {
      title: { tag: 'plain_text', content: `🗂 活跃项目 (${peers.length})` },
    },
    expanded: false,
    elements: [{ tag: 'markdown', content: consoleMainContent(opts) }],
  }
}

export function consoleCurrentModelContent(opts: ConsoleOpts): string {
  const label = opts.model
    ? `${opts.model}${opts.effort ? `/${opts.effort}` : ''}`
    : opts.effort
      ? `强度 ${opts.effort}`
      : '未就绪'
  const provider = opts.provider === 'claude' ? ` (${providerLabel(opts.provider)})` : ''
  return [
    `**🤖 当前模型${provider}**　\`${label}\``,
    ...(opts.worktreeInstructionNotice ? [opts.worktreeInstructionNotice] : []),
  ].join('\n')
}

export function consoleCurrentModelElement(
  opts: ConsoleOpts,
  elementId: string = ELEMENTS.consoleCurrentModel,
): object {
  return {
    tag: 'markdown',
    element_id: elementId,
    content: consoleCurrentModelContent(opts),
  }
}

export function consoleHostElement(sysinfo?: SysInfo, elementId = ELEMENTS.consoleHost): object {
  const summary = hostSummary(sysinfo)
  return {
    tag: 'collapsible_panel',
    element_id: elementId,
    header: {
      title: {
        tag: 'plain_text',
        content: summary.length > 0 ? `🖥 主机 · ${summary.join(' · ')}` : '🖥 主机',
      },
    },
    expanded: false,
    elements: [{ tag: 'markdown', content: consoleHostContent(sysinfo) }],
  }
}

/** 统一额度渲染:从 tokenSource.readUsage() 的 UsageSnapshotUnified 渲染。
 * 取代 consoleUsageContent/consoleGlmUsageContent 二元 —— 加新 token source 的额度
 * 自动支持(只要它的 readUsage 返回 unified)。失败态按 no_fallbacks 显式 MISS。 */
export function unifiedUsageSummary(snap: UsageSnapshotUnified | undefined): string {
  const label = snap?.kind === 'balance' ? '余额' : '额度'
  if (!snap) return `${label} 加载中…`
  if (snap.state === 'not_applicable') return `${label} —`
  if (snap.state !== 'ok') return `${label} MISS`
  const money = (amount: number, currency: string) => `${currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `}${amount.toFixed(2)}`
  if (snap.kind === 'balance') return snap.balance
    ? `余额 ${money(snap.balance.remaining, snap.balance.currency)}` : '余额 MISS'
  if (snap.quota) return snap.quota.limit === null ? '额度 未设上限'
    : snap.quota.remaining === null ? '额度 MISS'
    : `额度 ${money(snap.quota.remaining, snap.quota.currency)} / ${money(snap.quota.limit, snap.quota.currency)}`
  if (!snap.windows.length) return '额度 MISS'
  return `额度 ${snap.windows.map(usageWindowSummary).join(' · ')}`
}

function usageWindowSummary(w: UsageSnapshotUnified['windows'][number]): string {
  const value = typeof w.used === 'number' && typeof w.total === 'number' ? `${w.used}/${w.total}`
    : w.percent === null ? 'MISS' : `${Math.round(w.percent)}%`
  return `${w.label} 已用 ${value}`
}

export function consoleUnifiedUsageContent(snap: UsageSnapshotUnified | undefined): string {
  return compactAccountUsage(snap)
}

/** The expanded quota panel lists each billing account once, without per-window rows. */
export function consoleUsageElement(opts: ConsoleOpts): object {
  const rows = opts.accountUsages
  return {
    tag: 'collapsible_panel', element_id: ELEMENTS.consoleUsage, expanded: true,
    header: { title: { tag: 'plain_text', content: '全部账号额度 · 已用 / 距重置' }, background_color: 'blue-50' },
    border: { color: 'blue-100', corner_radius: '8px' }, padding: '8px', vertical_spacing: '2px',
    elements: rows === undefined ? [{ tag: 'markdown', text_size: 'notation', content: '加载中…' }]
      : rows.length ? rows.map(accountUsageRow) : [{ tag: 'markdown', text_size: 'notation', content: '暂无已配置账号' }],
  }
}

export function consoleBodyElements(opts: ConsoleOpts, currentModelElementId?: string): object[] {
  return [
    consoleCurrentModelElement(opts, currentModelElementId),
    consoleMainElement(opts),
    consoleHostElement(opts.sysinfo),
    consoleUsageElement(opts),
  ]
}

export function consoleCard(opts: ConsoleOpts): object {
  const { sessionName, status } = opts
  const template = status === 'working' ? 'blue'
    : status === 'awaiting_permission' ? 'orange'
    : status === 'stopped' ? 'grey'
    : 'green'

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `🌟 Lodestar · ${sessionName}` },
      template,
    },
    body: { elements: consoleBodyElements(opts) },
  }
}

export interface ProviderChoice {
  provider?: AgentProvider
  sourceId: string
  display: string
  enabled: boolean
  modelCount: number
  catalogStatus?: TokenSourceModelCatalogState['status']
  catalogError?: string
  selected?: boolean
}

interface ProviderSelectionCardOpts {
  sessionName: string
  panelId: string
  currentDisplay?: string | null
  providers: ProviderChoice[]
}

/** 第1级 model 面板:选账号(codex订阅/glm)。点 enabled 账号 → 第2级(该账号模型)。 */
export function providerSelectionCard(opts: ProviderSelectionCardOpts): object {
  return modelCard(opts.sessionName, {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.modelPanel,
    header: { title: { tag: 'plain_text', content: '选择账号' } },
    expanded: true,
    elements: [
      {
        tag: 'markdown',
        content: `当前: ${inlineCode(opts.currentDisplay ?? '未选择')}\n选账号进入模型选择。`,
      },
      ...(['claude', 'codex', 'dsh'] as const).flatMap(agent => {
        const providers = opts.providers.filter(p => (p.provider ?? 'codex') === agent)
        return providers.length ? [{
          tag: 'collapsible_panel',
          element_id: ELEMENTS.modelAgentGroup(agent),
          expanded: true,
          header: {
            title: { tag: 'markdown', content: `**Agent · ${{ claude: 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness' }[agent]}**` },
            background_color: 'blue-50',
          },
          border: { color: 'blue-100', corner_radius: '8px' },
          padding: '8px',
          margin: '8px 0px 0px 0px',
          elements: providers.map(p => providerChoiceElement(p, opts.panelId)),
        }] : []
      }),
    ],
  })
}

function providerChoiceElement(p: ProviderChoice, panelId: string): object {
  if (!p.enabled) {
    return {
      tag: 'column_set',
      columns: [
        {
          tag: 'column', width: 'weighted', weight: 4,
          elements: [{ tag: 'markdown', content: `⚙️ **${escapeMarkdown(p.display)}** · 未配置` }],
        },
        {
          tag: 'column', width: 'weighted', weight: 1,
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '启' },
            type: 'primary',
            behaviors: [{ type: 'callback', value: { kind: 'token_source_enable', source_id: p.sourceId } }],
          }],
        },
      ],
    }
  }
  const catalog = p.catalogStatus === 'failed' ? `模型目录 MISS${p.catalogError ? `：${p.catalogError}` : ''}`
    : p.catalogStatus === 'loading' || p.catalogStatus === 'idle' ? '模型目录加载中'
    : `${p.modelCount} 个模型${p.catalogError ? ` · 刷新 MISS：${p.catalogError}` : ''}`
  const flags = [p.selected ? '当前账号' : '', catalog].filter(Boolean).join(' · ')
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column', width: 'weighted', weight: 4,
        elements: [{ tag: 'markdown', content: `**${escapeMarkdown(p.display)}**\n${flags}` }],
      },
      {
        tag: 'column', width: 'weighted', weight: 1,
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '选' },
          type: p.selected ? 'primary' : 'default',
          behaviors: [{
            type: 'callback',
            value: {
              kind: 'provider_select', panel_id: panelId, source_id: p.sourceId,
              ...(p.provider ? { provider: p.provider } : {}),
            },
          }],
        }],
      },
    ],
  }
}

export function modelSelectionCard(opts: ModelSelectionCardOpts): object {
  return modelCard(opts.sessionName, modelSelectionPanelElement(opts))
}

export function modelEffortSelectionCard(opts: ModelEffortSelectionCardOpts): object {
  return modelCard(opts.sessionName, modelEffortSelectionPanelElement(opts))
}

export function modelResultCard(opts: ModelResultPanelOpts): object {
  return modelCard(opts.sessionName, modelResultPanelElement(opts), 'green')
}

export function modelChangeStatusPanelElement(pending: boolean, message: string): object {
  return {
    tag: 'collapsible_panel', element_id: ELEMENTS.modelPanel, expanded: true,
    header: { title: { tag: 'plain_text', content: pending ? '模型设置确认中' : '模型设置未完成' } },
    elements: [{ tag: 'markdown', content: escapeMarkdown(message) }],
  }
}

export function modelChangeStatusCard(sessionName: string, pending: boolean, message: string): object {
  return modelCard(sessionName, modelChangeStatusPanelElement(pending, message), pending ? 'orange' : 'red')
}

function modelCard(sessionName: string, element: object, template = 'turquoise'): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `🤖 model · ${sessionName}` },
      template,
    },
    body: {
      elements: [element],
    },
  }
}

export function modelSelectionPanelElement(opts: ModelSelectionCardOpts): object {
  const modelElements = modelChoiceElements(opts.models, opts.panelId, opts.mode, opts.editable)
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.modelPanel,
    header: { title: { tag: 'plain_text', content: opts.mode === 'add' ? '显示模型' : '选择模型' } },
    expanded: true,
    elements: [
      {
        tag: 'markdown',
        content: [
          `当前: ${settingsLine(opts.currentModel, opts.currentEffort)}`,
          opts.mode === 'add' ? '显示账号接口中的模型。' : '接口模型可隐藏，补录模型可删除。有多个 effort 档位时再选择档位。',
        ].join('\n'),
      },
      ...(opts.models.length
        ? modelElements
        : [{ tag: 'markdown', content: opts.editable ? (opts.mode === 'add' ? '_没有待显示的接口模型_' : '_列表为空，可显示接口模型或补录_') : '_未返回可用模型列表_' }]),
      ...(opts.pagination ? modelPaginationElements(opts.panelId, opts.pagination) : []),
      ...(opts.editable && opts.allowCustom ? [{
        tag: 'button', text: { tag: 'plain_text', content: '补录模型' }, type: 'default',
        behaviors: [{ type: 'callback', value: { kind: 'model_custom_prompt', panel_id: opts.panelId, source_id: opts.sourceId } }],
      }] : []),
      // 列表外模型补录:上游列表滞后(新模型已可用但未列出)时用。点击进入
      // 「群里直接回复模型名」应答态(同 AskUserQuestion 的消息应答语义),
      // 回复后端点校验,存在才补进列表。
      {
        tag: 'button',
        text: { tag: 'plain_text', content: opts.editable ? (opts.mode === 'add' ? '返回模型列表' : '显示模型') : '补录模型' },
        type: 'default',
        width: 'default',
        behaviors: [{
          type: 'callback',
          value: {
            kind: opts.editable ? 'model_list_open' : 'model_custom_prompt',
            panel_id: opts.panelId,
            ...(opts.sourceId || opts.models[0]?.sourceId ? { source_id: opts.sourceId ?? opts.models[0]?.sourceId } : {}),
            ...(opts.editable ? { mode: opts.mode === 'add' ? 'select' : 'add' } : {}),
          },
        }],
      },
    ],
  }
}

function modelPaginationElements(panelId: string, pagination: NonNullable<ModelSelectionCardOpts['pagination']>): object[] {
  const { sourceId, page, totalPages } = pagination
  const button = (text: string, target: number): object => ({
    tag: 'column', width: 'weighted', weight: 1,
    elements: [{ tag: 'button', text: { tag: 'plain_text', content: text }, type: 'default',
      behaviors: [{ type: 'callback', value: { kind: 'model_page', panel_id: panelId, source_id: sourceId, page: target } }] }],
  })
  return [
    { tag: 'markdown', content: `第 ${page + 1} / ${totalPages} 页` },
    { tag: 'column_set', columns: [
      ...(page > 0 ? [button('上一页', page - 1)] : []),
      ...(page + 1 < totalPages ? [button('下一页', page + 1)] : []),
    ] },
  ]
}

/** 补录等待态取消后的收尾卡:一行静态文本,无可交互元素。 */
export function modelCancelledCard(sessionName: string, state: 'cancelled' | 'stale' = 'cancelled'): object {
  return modelCard(sessionName, {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.modelPanel,
    header: { title: { tag: 'plain_text', content: '补录模型' } },
    expanded: true,
    elements: [{
      tag: 'markdown',
      content: state === 'stale'
        ? '_此补录面板已失效 — 当前等待中的补录未受影响_'
        : '_已取消补录 — 列表未改动_',
    }],
  }, 'grey')
}

/** 补录应答态提示卡:告知用户直接在群里回复模型名(同 AskUserQuestion 语义)。
 *  取消按钮只在这里 —— 唯一会拦群消息的等待态;普通选择面板不拦任何消息,
 *  扔着不管即可,不需要取消。 */
export function modelCustomPromptCard(sessionName: string, sourceDisplay: string, panelId: string): object {
  return modelCard(sessionName, {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.modelPanel,
    header: { title: { tag: 'plain_text', content: '补录模型' } },
    expanded: true,
    elements: [
      {
        tag: 'markdown',
        content: [
          `**直接回复模型名补录到 ${sourceDisplay}**`,
          '补录后可选择 effort 并使用；模型是否接受该档位由实际请求确认。',
          '_裸词命令(hi/stop/model 等)不受影响_',
        ].join('\n'),
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '取消' },
        type: 'default',
        width: 'default',
        behaviors: [{ type: 'callback', value: { kind: 'model_panel_cancel', panel_id: panelId } }],
      },
    ],
  }, 'blue')
}

/** 补录结果 panel(原位替换补录卡的 modelPanel 元素):红/绿字说明结果。 */
export function modelCustomResultPanelElement(
  ok: boolean,
  model: string,
  reason: string,
): object {
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.modelPanel,
    header: { title: { tag: 'plain_text', content: '补录模型' } },
    expanded: true,
    elements: [{
      tag: 'markdown',
      content: ok
        ? `✅ \`${model}\` 已加入列表${reason ? `\n${reason}` : ''}`
        : `❌ \`${model}\` 未加入 — ${reason}`,
    }],
  }
}

export function modelEffortSelectionPanelElement(opts: ModelEffortSelectionCardOpts): object {
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.modelPanel,
    header: { title: { tag: 'plain_text', content: '选择 effort' } },
    expanded: true,
    elements: [
      {
        tag: 'markdown',
        content: [
          `模型: ${modelTitle(opts.model)}`,
          `当前: ${settingsLine(opts.currentModel, opts.currentEffort)}`,
        ].join('\n'),
      },
      ...(opts.model.efforts.length
        ? opts.model.efforts.map(effort => effortChoiceElement(
            opts.model,
            effort,
            opts.panelId,
            opts.currentModel,
            opts.currentEffort,
          ))
        : [{ tag: 'markdown', content: '_该模型未返回可用 effort_' }]),
    ],
  }
}

export function modelResultPanelElement(opts: ModelResultPanelOpts): object {
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.modelPanel,
    header: { title: { tag: 'plain_text', content: '选择已保存' } },
    expanded: true,
    elements: [{
      tag: 'markdown',
      content: [
        '**已保存**',
        inlineCode(settingsText(opts.model, opts.effort, opts.provider)),
        escapeMarkdown(opts.scope),
      ].join('\n'),
    }],
  }
}

function modelChoiceElement(model: ModelChoice, panelId: string, mode?: 'select' | 'add', editable = false): object[] {
  // 未配置 source 的占位项:灰显 + 「启用」按钮
  if (model.enabled === false) {
    return [{
      tag: 'column_set',
      columns: [
        {
          tag: 'column', width: 'weighted', weight: 4,
          elements: [{
            tag: 'markdown',
            content: `⚙️ **${escapeMarkdown(model.displayName)}** · 未配置\n${escapeMarkdown(model.description ?? '')}`,
          }],
        },
        {
          tag: 'column', width: 'weighted', weight: 1,
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '启' },
            type: 'primary',
            behaviors: [{ type: 'callback', value: { kind: 'token_source_enable', source_id: model.sourceId } }],
          }],
        },
      ],
    }]
  }
  const title = model.displayName && model.displayName !== model.model
    ? `**${escapeMarkdown(model.displayName)}**`
    : `**${inlineCode(model.model)}**`
  const flags = [
    model.isDefault ? `${providerLabel(model.provider)} 默认` : '',
    model.selected ? '当前模型' : '',
  ].filter(Boolean)
  const desc = model.description
    ? '\n' + escapeMarkdown(truncate(model.description, 110))
    : ''
  const listAction = (kind: 'model_add' | 'model_remove' | 'model_custom_remove', text: string): object => ({
    tag: 'button', text: { tag: 'plain_text', content: text }, type: 'default',
    behaviors: [{ type: 'callback', value: { kind, panel_id: panelId, source_id: model.sourceId, model: model.model } }],
  })
  const row = {
    tag: 'column_set',
    columns: [
      {
        tag: 'column', width: 'weighted', weight: 4, vertical_align: 'center',
        elements: [{
          tag: 'markdown',
          content: [
            title,
            model.displayName && model.displayName !== model.model ? inlineCode(model.model) : '',
            flags.length ? flags.join(' · ') : '',
          ].filter(Boolean).join('\n') + desc,
        }],
      },
      {
        tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
        elements: [
          ...(mode === 'add' ? [listAction('model_add', '显')]
            : model.unavailableReason ? [{ tag: 'markdown', content: '**MISS**' }] : [{
          tag: 'button',
          text: { tag: 'plain_text', content: '选' },
          type: model.selected ? 'primary' : 'default',
          behaviors: [{ type: 'callback', value: modelSelectActionValue(model, panelId) }],
          }]),
          ...(editable && mode !== 'add' ? [model.origin === 'custom'
            ? listAction('model_custom_remove', '删') : listAction('model_remove', '隐')] : []),
        ],
      },
    ],
  }
  return [row]
}

function modelChoiceElements(models: ModelChoice[], panelId: string, mode?: 'select' | 'add', editable = false): object[] {
  const groups = [
    { title: 'Codex', models: models.filter(m => (m.provider ?? 'codex') === 'codex') },
    { title: 'Claude Code 后端', models: models.filter(m => m.provider === 'claude') },
    { title: 'DeepSeek Harness', models: models.filter(m => m.provider === 'dsh') },
  ].filter(group => group.models.length > 0)
  const flat = (ms: ModelChoice[]) => ms.flatMap((model, index) => [
    ...(index ? [{ tag: 'hr' }] : []),
    ...modelChoiceElement(model, panelId, mode, editable),
  ])
  if (groups.length <= 1) return flat(models)
  const elements: object[] = []
  for (const group of groups) {
    elements.push({ tag: 'markdown', content: `**${group.title}**` })
    elements.push(...flat(group.models))
  }
  return elements
}

function effortChoiceElement(
  model: ModelChoice,
  effort: ModelEffortChoice,
  panelId: string,
  currentModel?: string | null,
  currentEffort?: string | null,
): object {
  const isCurrent = currentModel === model.model && currentEffort === effort.effort
  const flags = [effort.isDefault ? '默认' : '', isCurrent ? '当前' : ''].filter(Boolean).join(' · ')
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column', width: 'weighted', weight: 4,
        elements: [{
          tag: 'markdown',
          content: [
            `**${effort.effort === 'default' ? '模型默认' : escapeMarkdown(effort.effort)}**`,
            flags,
            effort.description ? escapeMarkdown(effort.description) : '',
          ].filter(Boolean).join('\n'),
        }],
      },
      {
        tag: 'column', width: 'weighted', weight: 1,
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '选' },
          type: isCurrent ? 'primary' : 'default',
          behaviors: [{
            type: 'callback',
            value: {
              kind: 'model_effort_select',
              panel_id: panelId,
              ...(model.sourceId ? { source_id: model.sourceId } : {}),
              ...(model.provider ? { provider: model.provider } : {}),
              model: model.model,
              effort: effort.effort,
            },
          }],
        }],
      },
    ],
  }
}

function modelSelectActionValue(model: ModelChoice, panelId: string): object {
  return {
    kind: 'model_select',
    panel_id: panelId,
    ...(model.sourceId ? { source_id: model.sourceId } : {}),
    ...(model.provider && model.provider !== 'codex' ? { provider: model.provider } : {}),
    model: model.model,
    display_name: model.displayName,
    is_default: model.isDefault === true,
    efforts: model.efforts.map(effort => ({
      effort: effort.effort,
      description: effort.description ?? '',
      is_default: effort.isDefault === true,
    })),
  }
}

function modelTitle(model: ModelChoice): string {
  return model.displayName && model.displayName !== model.model
    ? `${escapeMarkdown(model.displayName)} (${inlineCode(model.model)})`
    : inlineCode(model.model)
}

function settingsLine(model?: string | null, effort?: string | null): string {
  return inlineCode(settingsText(model, effort))
}

function settingsText(model?: string | null, effort?: string | null, provider?: AgentProvider): string {
  const prefix = provider && provider !== 'codex' ? `${providerLabel(provider)} · ` : ''
  if (model && effort) return `${prefix}${model}/${effort}`
  if (model) return `${prefix}${model}`
  if (effort) return `${prefix}${effort}`
  return '未选择'
}

function providerLabel(provider?: AgentProvider): string {
  return agentProviderLabel(provider ?? 'codex')
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function escapeMarkdown(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inlineCode(s: string): string {
  return '`' + s.replace(/`/g, '\\`') + '`'
}

/** Settings patch applied when a turn finishes — flips streaming off
 * and updates the chat-list preview with `⏱ duration · 📶 NK`
 * (or just the suffix if interrupted before a result event). */
export function streamingOffSettings(opts: {
  durationSec?: number
  outputTokens?: number | null
  suffix?: string
}): object {
  const parts: string[] = []
  parts.push(opts.suffix ?? '✅')
  // durationSec 缺省的场景:mid-turn rotate 收尾旧卡 (turn 还在跑,没
  // turn-final elapsed)。此时省掉 ⏱ 段,合法的 0 秒仍显示。
  if (opts.durationSec != null) parts.push(`⏱ ${formatDuration(opts.durationSec)}`)
  if (opts.outputTokens != null && opts.outputTokens > 0) {
    parts.push(`📶 ${fmtTokens(opts.outputTokens)}`)
  }
  return {
    config: { streaming_mode: false, summary: { content: parts.join(' · ') } },
  }
}
