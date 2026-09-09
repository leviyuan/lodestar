/**
 * Schema 2.0 turn-card templates: the main dynamic turn card, the per-tool
 * collapsible panels, and the AskUserQuestion interactive panel. All
 * rendering for "the in-flight conversation card" lives here. Console
 * UI lives in console.ts; the shared element-id convention is in
 * elements.ts.
 */

import type { CodexUsage } from '../codex-process'
import type { AgentProvider } from '../agent-process'
import { contextPercentSummary, contextTokenRatioLabel } from '../context-window'
import { ELEMENTS, sanitizeMarkdownForCardKit } from './elements'

export interface TurnPlanStep {
  step: string
  status: 'pending' | 'inProgress' | 'completed' | string
}

export interface ThreadGoal {
  objective: string
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete' | string
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
}

export interface ContextCompactionNotice {
  threadId?: string
  turnId?: string
  itemId?: string
  phase?: 'start' | 'end' | 'event' | string
  [key: string]: unknown
}

export function goalDisplaySignature(goal: ThreadGoal): string {
  return JSON.stringify({
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
  })
}

function planStatusIcon(s: string): string {
  switch (s) {
    case 'pending':     return '☐'
    case 'inProgress':  return '🔄'
    case 'completed':   return '✅'
    default:            return '·'
  }
}

function truncateText(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function compactFooterTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '--'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'k'
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'm'
}


function goalStatusLabel(s: string): string {
  switch (s) {
    case 'active':       return '进行中'
    case 'paused':       return '已暂停'
    case 'blocked':      return '受阻'
    case 'usageLimited': return '额度受限'
    case 'budgetLimited': return '预算受限'
    case 'complete':     return '已完成'
    default:             return s
  }
}

function planStats(plan: TurnPlanStep[]): string {
  const completed = plan.filter(item => item.status === 'completed').length
  const inProgress = plan.filter(item => item.status === 'inProgress').length
  const pending = plan.filter(item => item.status === 'pending').length
  const parts = [`${plan.length} 项`]
  if (inProgress) parts.push(`${inProgress} 进行中`)
  if (completed) parts.push(`${completed} 完成`)
  if (pending) parts.push(`${pending} 待办`)
  return parts.join(' · ')
}

function planHeader(plan: TurnPlanStep[], draftText = ''): string {
  const draft = draftText.trim()
  if (plan.length === 0) return draft ? '📋 计划草稿' : '📋 计划更新'
  return `📋 计划更新 · ${planStats(plan)}`
}

function formatGoalTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'MISS'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const min = minutes % 60
  return min ? `${hours}h ${min}m` : `${hours}h`
}

function numberValue(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function compactionDurationLabel(data: Record<string, unknown>): string {
  const startedAt = numberValue(data.startedAtMs)
  const completedAt = numberValue(data.completedAtMs)
  if (startedAt == null || completedAt == null || completedAt < startedAt) return ''
  return ` · 耗时 ${formatGoalTime((completedAt - startedAt) / 1000)}`
}

function compactTokenLabel(value: unknown): string | null {
  const n = numberValue(value)
  return n == null ? null : compactFooterTokens(n)
}

function compactionDetailLines(data: Record<string, unknown>, done: boolean): string[] {
  if (!done) return ['压缩中...']
  const lines: string[] = []
  const trigger = typeof data.trigger === 'string' && data.trigger.trim() ? data.trigger.trim() : ''
  const preTokens = compactTokenLabel(data.preTokens)
  const source = typeof data.sourceType === 'string' && data.sourceType.trim() ? data.sourceType.trim() : ''
  if (trigger) lines.push(`**触发**: ${trigger}`)
  if (preTokens) lines.push(`**压缩前**: ${preTokens} tokens`)
  if (source) lines.push(`**来源**: ${source}`)
  return lines.length > 0 ? lines : ['压缩完成，无摘要内容']
}

export function footerContextPercentLabel(
  tokens: number | null,
  limit: number | null | undefined,
  baseline?: number,
): string | null {
  if (tokens == null || !Number.isFinite(tokens)) return null
  const pct = contextPercentSummary(tokens, limit, baseline)
  return pct ? `${pct.used}% · ${contextTokenRatioLabel(tokens, limit)}` : '--'
}

export function footerTokenDetailLine(usage: CodexUsage | null | undefined): string {
  const input = compactFooterTokens(usage?.input_tokens ?? Number.NaN)
  const cached = compactFooterTokens(usage?.cache_read_input_tokens ?? Number.NaN)
  const output = compactFooterTokens(usage?.output_tokens ?? Number.NaN)
  return `└ 入 ${input} ｜ 缓 ${cached} ｜ 出 ${output}`
}

export function contextCompactionElement(i: number, notice: ContextCompactionNotice, elementId: string): object {
  const data = notice && typeof notice === 'object' ? notice as Record<string, unknown> : {}
  const done = data.phase === 'end' || data.phase === 'event'
  const status = done ? '✅' : '⏳'
  const duration = done ? compactionDurationLabel(data) : ''
  const headerText = `${status} 🚨 上下文压缩 #${i + 1}${duration}`
  const lines = compactionDetailLines(data, done)
  return {
    tag: 'collapsible_panel',
    element_id: elementId,
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: false,
    elements: [
      { tag: 'markdown', content: lines.join('\n') },
    ],
  }
}

function renderPlanContent(plan: TurnPlanStep[], explanation?: string | null, draftText = ''): string {
  const lines = ['**📋 当前计划**']
  const cleanExplanation = explanation?.trim()
  if (cleanExplanation) {
    lines.push('')
    lines.push(cleanExplanation)
  }
  if (plan.length > 0) {
    lines.push('')
    for (const item of plan) {
      lines.push(`- ${planStatusIcon(item.status)} ${item.step}`)
    }
  } else {
    const draft = draftText.trim()
    lines.push('')
    if (draft) {
      lines.push('正在生成计划草稿...')
      lines.push('')
      lines.push(draft)
    } else {
      lines.push('--')
    }
  }
  return lines.join('\n')
}

export function planElement(
  plan: TurnPlanStep[],
  explanation: string | null | undefined,
  draftText = '',
  elementId: string,
): object {
  return {
    tag: 'collapsible_panel',
    element_id: elementId,
    header: { title: { tag: 'plain_text', content: planHeader(plan, draftText) } },
    expanded: false,
    elements: [{ tag: 'markdown', content: renderPlanContent(plan, explanation, draftText) }],
  }
}

/**
 * 实时计划面板(footer 正前常驻,与 taskBoardLive 同语义)。codex 每次
 * turn/plan/updated 都会推完整最新计划 —— 这里 replace 成最新快照,让最新
 * 计划永远压在卡片末尾,不被后续 tool/assistant 元素顶走,对齐 claude cli
 * 底部常驻 todo 的"保持最新状态在末尾"体验。
 *
 * header 固定 "📋 当前计划 · 统计"(无序号 —— planUpdateCount 在换卡时清零,
 * 序号会从 1 重数,语义失真);expanded=true 让用户不用点开就能看计划。body
 * 复用 renderPlanContent,与 timeline 快照(planElement,折叠过程记录)视觉一致。
 */
export function planLiveElement(
  plan: TurnPlanStep[],
  explanation: string | null,
  elementId: string,
): object {
  const header = plan.length > 0
    ? `📋 当前计划 · ${planStats(plan)}`
    : '📋 当前计划'
  return {
    tag: 'collapsible_panel',
    element_id: elementId,
    header: { title: { tag: 'plain_text', content: header } },
    expanded: true,
    elements: [{ tag: 'markdown', content: renderPlanContent(plan, explanation) }],
  }
}

export function goalElement(goal: ThreadGoal, elementId: string): object {
  const tokensUsed = Number.isFinite(goal.tokensUsed) ? String(goal.tokensUsed) : 'MISS'
  const tokenBudget = goal.tokenBudget == null
    ? ''
    : Number.isFinite(goal.tokenBudget)
      ? ` / ${goal.tokenBudget}`
      : ' / MISS'
  const lines = [
    `**🎯 当前目标** · ${goalStatusLabel(goal.status)}`,
    '',
    goal.objective,
    '',
    `- 用量: ${tokensUsed}${tokenBudget} tokens`,
    `- 用时: ${formatGoalTime(goal.timeUsedSeconds)}`,
  ]
  return {
    tag: 'collapsible_panel',
    element_id: elementId,
    header: {
      title: {
        tag: 'plain_text',
        content: `🎯 目标更新 · ${goalStatusLabel(goal.status)}: ${truncateText(goal.objective, 48)}`,
      },
    },
    expanded: false,
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  }
}

interface MainCardOpts {
  sessionName: string
  turn: number
  provider?: AgentProvider
  model?: string
  effort?: string
  /** What started this turn:
   *   'user_message'   — user input batch(panel "📥 收到 (N)" 渲染原文)
   *   'card_full'      — 同一 turn 的续卡：前卡体积或组件数量超限后创建，
   *                     (banner `📨 接续上一张`,无 panel,turn 号跟旧卡
   *                     相同)
   *   'bg_task_resume' — 后台任务结算后 SDK 自发的恢复轮(无用户消息,
   *                     banner `🔁 后台任务完成`,无 panel)
   *   'scheduled_wakeup' — Claude SDK Cron 定时唤醒轮
   *                        (banner `⏰ 定时任务触发`,无 prompt panel) */
  kind?: 'user_message' | 'card_full' | 'bg_task_resume' | 'scheduled_wakeup'
  /** 本轮 Codex 收到的 user wireText 列表。boot turn 通常是 1 条;mid-turn
   * 用户连发的 N 条会在下一 turn 一并塞进。空数组 / undefined 时不渲染
   * userInput panel。 */
  userInputs?: string[]
  /** Initial stable footer text. Session replaces it with a live timer
   * after it has converted message_id → card_id, but this value is what
   * the user sees immediately when Feishu creates the card. */
  initialFooter?: string
  /** True when a bare user prompt cold-started Codex. */
  directStart?: boolean
}

/** Initial card sent at the start of each turn. CardKit streaming mode stays
 * on so the daemon can add/replace elements during the turn; assistant text
 * and footer status themselves are rendered via static element updates. */
export function mainConversationCard(opts: MainCardOpts): object {
  const providerLabel = opts.provider === 'claude' ? 'Claude' : 'Codex'
  const banner = opts.kind === 'card_full'
    ? [{ tag: 'markdown', content: `📨 接续上一张（同一轮 ${providerLabel}，前卡写满或写入受限）` }]
    : opts.kind === 'bg_task_resume'
      ? [{ tag: 'markdown', content: `🔁 后台任务完成，${providerLabel} 继续处理结果 #${opts.turn}` }]
      : opts.kind === 'scheduled_wakeup'
        ? [{ tag: 'markdown', content: `⏰ 定时任务触发，${providerLabel} 正在执行巡检 #${opts.turn}` }]
      : []
  const inputs = opts.userInputs ?? []
  const userInputHeader = `📥 收到 (${inputs.length}) ${opts.directStart ? '🚀' : `#${opts.turn}`}`
  const userInputPanel = inputs.length > 0
    ? [{
        tag: 'collapsible_panel',
        element_id: ELEMENTS.userInput,
        header: { title: { tag: 'plain_text', content: userInputHeader } },
        expanded: false,
        elements: inputs.map(text => ({ tag: 'markdown', content: sanitizeMarkdownForCardKit(text) })),
      }]
    : []
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: '[Lodestar 正在生成…]' },
      streaming_config: {
        print_frequency_ms: { default: 60, android: 60, ios: 60, pc: 30 },
        print_step: { default: 2, android: 2, ios: 2, pc: 4 },
        print_strategy: 'fast',
      },
    },
    body: {
      // Initial body: [handoff banner?] + [userInput panel?] + footer.
      // Assistant segments and tool panels insert_before footer during
      // Codex events. The footer itself is the only live status element:
      // `Thinking...(Ns)` while the model is silent, `Writing...(Ns)` while
      // assistant text is buffered, `Working...(Ns)` while tools/non-text
      // work are visible, and the terminal line when the turn ends.
      elements: [
        ...banner,
        ...userInputPanel,
        { tag: 'markdown', element_id: ELEMENTS.footer, content: opts.initialFooter ?? 'Waiting...(0s)' },
      ],
    },
  }
}

/** Schema of an AskUserQuestion question, projected to just the fields
 * the panel needs. Mirrors the SDK tool's input — kept loose since the
 * runtime guarantees it matches. */
export interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

/** Per-question final-state. Mutually-exclusive branches: option pick
 * vs. free-form custom text. */
export interface AskAnswered {
  optionIdx?: number
  customText?: string
  user?: string
}

/** State the panel renders against. `currentIdx` undefined → terminal
 * (every question answered). Otherwise it's the question currently on
 * screen; everything in `answered` is history. */
export interface AskState {
  currentIdx?: number
  answered: Map<number, AskAnswered>
  waitingFor?: 'notification' | 'question'
}

function askQuestionTitle(q: AskQuestion, questionIdx: number, total: number): string {
  const label = q.question.trim() || `问题 ${questionIdx + 1}`
  return `${questionIdx + 1}/${total} · ${label}`
}

function askAnswerValue(q: AskQuestion, picked?: AskAnswered): string {
  if (!picked) return '?'
  return picked.customText
    ?? (picked.optionIdx !== undefined ? q.options[picked.optionIdx]?.label : undefined)
    ?? '?'
}

/** Render only the current question's clickable option rows. Historical
 * answered rows are rendered as plain markdown in the timeline view. */
function renderAskQuestionOptions(
  q: AskQuestion,
  toolUseId: string,
  questionIdx: number,
): any[] {
  const els: any[] = []
  for (let oi = 0; oi < q.options.length; oi++) {
    const opt = q.options[oi]
    const desc = opt.description ? `  ·  ${sanitizeMarkdownForCardKit(opt.description)}` : ''
    els.push({
      tag: 'interactive_container',
      background_style: 'default',
      has_border: true,
      corner_radius: '6px',
      padding: '8px 12px',
      margin: '4px 0px 4px 0px',
      behaviors: [{
        type: 'callback',
        value: {
          kind: 'ask',
          tool_use_id: toolUseId,
          question_idx: questionIdx,
          option_idx: oi,
        },
      }],
      elements: [{ tag: 'markdown', content: `**${sanitizeMarkdownForCardKit(opt.label)}**${desc}` }],
    })
  }
  return els
}

function renderAskTimeline(
  questions: AskQuestion[],
  toolUseId: string,
  currentIdx: number | undefined,
  answered: Map<number, AskAnswered>,
): any | null {
  if (questions.length === 0) return null
  const total = questions.length
  const body: any[] = []
  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx]
    if (!q) continue
    const title = askQuestionTitle(q, idx, total)
    const picked = answered.get(idx)
    if (picked) {
      const answer = askAnswerValue(q, picked)
      const lines = [`**✅ ${title}**`, `**回答**：${answer}`]
      body.push({ tag: 'markdown', content: lines.join('\n') })
      continue
    }
    if (idx === currentIdx) {
      body.push({ tag: 'markdown', content: `**🤔 ${title}**` })
      if (q.options.length > 0) {
        body.push(...renderAskQuestionOptions(q, toolUseId, idx))
      }
      body.push({
        tag: 'markdown',
        content: '_💬 也可以直接在群里回复你的答案（裸词命令 `hi`/`stop`/`kill`/`restart`/`clear`/`model` 仍然优先）_',
      })
      continue
    }
    body.push({ tag: 'markdown', content: `**⏳ ${title}**` })
  }
  return body
}

/** Tool-panel renderer for `AskUserQuestion` — Codex's structured
 * multiple-choice question. Daemon takes over the client-side role:
 * instead of letting the request fall through to the generic JSON
 * dump (or worse, the permission flow that misappropriates it), we
 * render each question with one button per option, callbacks tagged
 * `kind:'ask'` so the Lark handler can route the answer back as a
 * `tool_result`.
 *
 * Single-question is the common case; multi-question gets buttons on
 * the first question only and a text-only listing for the rest (an
 * acceptable limitation — these are rare in practice and we can lift
 * it once the UX is validated). */
export function askUserQuestionElement(
  i: number,
  toolUseId: string,
  questions: AskQuestion[],
  status: '🤔' | '✅' | '❌' = '🤔',
  state?: AskState,
): object {
  const total = questions.length
  const answered = state?.answered ?? new Map<number, AskAnswered>()
  const currentIdx = state?.currentIdx
  const isTerminal = currentIdx === undefined && answered.size > 0
  const bodyElements: any[] = []
  let headerText: string

  if (state?.waitingFor) {
    headerText = state.waitingFor === 'notification' ? '⏳ 等待通知回复完成' : '⏳ 提问排队中'
    bodyElements.push({ tag: 'markdown', content: state.waitingFor === 'notification'
      ? '请先完成或取消通知回复，再回答这个问题。'
      : '先回答当前问题，再显示这个提问。' })
  } else if (isTerminal) {
    headerText = `${status} 已回答 · ${total}/${total}`
    bodyElements.push(...(renderAskTimeline(questions, toolUseId, currentIdx, answered) ?? []))
    const lastUser = [...answered.values()].reverse().find(a => a.user)?.user
    if (lastUser) {
      bodyElements.push({
        tag: 'markdown',
        content: `\n*— 由 ${lastUser} 回答*`,
      })
    }
  } else if (currentIdx !== undefined && questions[currentIdx]) {
    headerText = `${status} 等你确认 · ${currentIdx + 1}/${total}`
    bodyElements.push(...(renderAskTimeline(questions, toolUseId, currentIdx, answered) ?? []))
  } else {
    // Defensive fallback — neither answered nor a valid currentIdx.
    headerText = `${status} 等你确认`
    if (questions[0]) {
      bodyElements.push({ tag: 'markdown', content: `**${askQuestionTitle(questions[0], 0, total || 1)}**` })
    }
  }

  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: !isTerminal && !state?.waitingFor,
    elements: bodyElements,
  }
}
