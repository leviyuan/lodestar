import { createHash } from 'node:crypto'
import type { AgentIdentity, AgentSourceFailure } from '../agent-identities'
import type { AgentRunSnapshot, AgentWorkerResult } from '../agent-run-types'
import { ELEMENTS, sanitizeMarkdownForCardKit } from './elements'
import { formatDuration } from './duration'
import {
  AGENT_CARD_TASK_KIND_ORDER,
  agentCardTaskKindIcon,
  agentCardTaskKindLabel,
  type AgentCardTaskKind,
} from './task-kind'
import { boundedResultContent, compactTaskContent } from './task-content'

export type { AgentCardTaskKind } from './task-kind'

const WORKER_TOTAL_PREVIEW_CHARS = 48_000
const WORKER_MAX_PREVIEW_CHARS = 8_000
const WORKER_MIN_PREVIEW_CHARS = 512

export interface AgentIdentityListCardOpts {
  panelId: string
  page: number
  totalPages: number
  catalog: AgentIdentity[]
  failures: AgentSourceFailure[]
}

export function agentIdentityListCard(opts: AgentIdentityListCardOpts): object {
  const elements: object[] = [{
    tag: 'markdown',
    element_id: ELEMENTS.agentIdentityPanel,
    content: [
      '**全局 Agent 身份**',
      '选择一个或多个 Agent 执行任务，由主 Agent 统一分配和汇总结果。',
      `目录第 ${opts.page + 1}/${opts.totalPages} 页`,
    ].join('\n'),
  }]
  if (opts.failures.length) {
    elements.push({
      tag: 'collapsible_panel',
      header: { title: { tag: 'plain_text', content: `MISS · ${opts.failures.length} 个账号` } },
      expanded: false,
      elements: [{
        tag: 'markdown',
        content: opts.failures.map(failure => `- **${escapeMarkdown(failure.display)}**：${escapeMarkdown(failure.reason)}`).join('\n'),
      }],
    })
  }
  elements.push(...opts.catalog.map(identityRow), pager(opts))
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '🧠 可用 Agent' }, template: 'purple' },
    body: { elements },
  }
}

export function agentRunCard(run: AgentRunSnapshot): object {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: !isTerminal(run.status),
      summary: { content: agentRunSummary(run) },
    },
    body: { elements: [agentRunElement(run)] },
  }
}

/** One visible line per invocation. Everything else stays inside this panel. */
export function agentRunElement(run: AgentRunSnapshot): object {
  return {
    tag: 'collapsible_panel',
    element_id: agentRunElementId(run.runId),
    header: { title: { tag: 'plain_text', content: agentRunSummary(run) } },
    expanded: false,
    elements: [{
      tag: 'markdown',
      content: [
        `**${escapeMarkdown(run.description ?? '说明 MISS')}**`,
        agentRunFooterElement(run).content,
        `**任务说明**\n${sanitizeMarkdownForCardKit(compactTaskContent(run.prompt))}`,
        ...run.workers.map(worker => agentWorkerElement(worker).content),
      ].join('\n\n'),
    }],
  }
}

export function agentRunElementId(runId: string): string {
  return `ar_${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`
}

export function agentCardSummary(runs: AgentRunSnapshot[]): string {
  return delegationCardSummary(runs.map(run => ({
    summary: agentRunSummary(run), status: run.status, terminal: isTerminal(run.status), kind: 'delegated',
  })))
}

export function delegationCardSummary(tasks: Array<{
  summary: string
  status: string
  terminal: boolean
  kind?: AgentCardTaskKind
}>): string {
  if (tasks.length === 1) return tasks[0]!.summary
  const done = tasks.filter(task => task.terminal).length
  const failed = tasks.filter(task => task.status === 'failed').length
  const waiting = tasks.filter(task => task.status === 'needs_input' || task.status === 'paused').length
  const kinds = new Set(tasks.map(task => task.kind ?? 'delegated'))
  const kindList = AGENT_CARD_TASK_KIND_ORDER.filter(kind => kinds.has(kind))
  const category = kindList.length === 1
    ? `${agentCardTaskKindIcon(kindList[0]!)} ${agentCardTaskKindLabel(kindList[0]!)}`
    : `🧩 运行任务 · ${kindList.map(kind => `${agentCardTaskKindLabel(kind)} ${tasks.filter(task => (task.kind ?? 'delegated') === kind).length}`).join(' · ')}`
  return `${category} · 已结束 ${done}/${tasks.length}${failed ? ` · 失败 ${failed}` : ''}${waiting ? ` · 待处理 ${waiting}` : ''}`
}

/** Render a bounded worker result; only the task prompt uses the shorter limit. */
export function agentWorkerElement(worker: AgentWorkerResult, outputPreviewChars = WORKER_MAX_PREVIEW_CHARS) {
  const status = workerStatusLabel(worker)
  const body: string[] = [`模型 ${inlineCode(worker.model)} · 推理 ${inlineCode(worker.effort)}`]
  if (worker.durationMs != null) body.push(`用时 ${formatDuration(worker.durationMs / 1000)}`)
  if (worker.status === 'queued' && worker.queuedReason) body.push('', escapeMarkdown(worker.queuedReason))
  if (worker.pendingInput) {
    body.push('', '**等待主 Agent 回答**')
    for (const question of worker.pendingInput.questions) {
      body.push(`- ${escapeMarkdown(question.question)}`)
      if (question.options.length) body.push(`  选项：${question.options.map(option => inlineCode(option.label)).join(' / ')}`)
    }
  }
  if (worker.error) body.push('', worker.status === 'cancelled' ? '**停止原因**' : '**失败原因**', sanitizeMarkdownForCardKit(worker.error))
  if (worker.output) body.push('', worker.status === 'failed' || worker.status === 'cancelled' ? '**已生成的内容**' : '**结果**', sanitizeMarkdownForCardKit(boundedResultContent(worker.output, outputPreviewChars)))
  if (!worker.output && !worker.error && !worker.pendingInput) {
    body.push('', worker.status === 'completed'
      ? '_任务已完成，没有正文输出。_'
      : worker.status === 'cancelled'
        ? '_任务已取消。_'
        : worker.status === 'queued' ? '_等待开始执行。_' : '_正在执行任务，结果会显示在这里。_')
  }
  if (worker.steps.length) {
    body.push('', '**最近动作**')
    for (const step of worker.steps.slice(-3)) {
      const icon = step.tool === 'tool error' ? '❌' : step.phase === 'completed' ? '✓' : step.phase === 'started' ? '→' : '·'
      const label = step.tool === 'tool error' ? '工具执行失败' : step.tool === 'tool result' ? '工具执行完成' : step.tool
      body.push(`- ${icon} ${inlineCode(label)} ${escapeMarkdown(shortText(step.detail, 180))}`)
    }
  }
  return {
    tag: 'markdown',
    content: [`**${status} · ${escapeMarkdown(worker.identityName)}**`, ...body].join('\n'),
  }
}

export function agentRunFooterElement(run: AgentRunSnapshot) {
  const completed = run.workers.filter(item => item.status === 'completed').length
  const failed = run.workers.filter(item => item.status === 'failed').length
  const waiting = run.workers.filter(item => item.status === 'needs_input').length
  const running = run.workers.filter(item => item.status === 'running').length
  const queued = run.workers.filter(item => item.status === 'queued').length
  const cancelled = run.workers.filter(item => item.status === 'cancelled').length
  const counts = [
    running ? `执行中 ${running}` : '', queued ? `排队 ${queued}` : '',
    waiting ? `待答 ${waiting}` : '', failed ? `失败 ${failed}` : '', cancelled ? `已取消 ${cancelled}` : '',
  ].filter(Boolean)
  const duration = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.createdAt) : null
  const lines = [
    `**${runStatusLabel(run)}** · 完成 ${completed}/${run.workers.length}`,
    ...(counts.length ? [counts.join(' · ')] : []),
    ...(duration != null && Number.isFinite(duration) ? [`⏱ 用时 ${formatDuration(duration / 1000)}`] : []),
    ...(run.error ? [escapeMarkdown(run.error)] : []),
  ]
  return {
    tag: 'markdown',
    content: lines.join('\n'),
  }
}

export function agentWorkerPreviewChars(workerCount: number): number {
  // Keep the shared-card budget bounded when several workers finish together.
  const count = Math.max(1, Math.floor(workerCount))
  return Math.min(WORKER_MAX_PREVIEW_CHARS, Math.max(WORKER_MIN_PREVIEW_CHARS, Math.floor(WORKER_TOTAL_PREVIEW_CHARS / count)))
}

export function agentRunSummary(run: AgentRunSnapshot): string {
  const done = run.workers.filter(item => item.status === 'completed').length
  return `${runStatusLabel(run)} · ${shortText(run.description ?? '说明 MISS', 40)}${run.workers.length > 1 ? ` · ${done}/${run.workers.length}` : ''}`
}

function identityRow(identity: AgentIdentity): object {
  const ready = identity.status === 'ready'
  const detail = ready ? '可用' : `不可用：${identity.reason ?? 'MISS'}`
  return {
    tag: 'markdown',
    content: [
      `**${escapeMarkdown(identity.displayName)}** ${identity.sourceDefault ? '· 默认' : ''}`,
      `${inlineCode(identity.id)}\n${inlineCode(identity.model)} · 默认 ${inlineCode(identity.defaultEffort ?? 'MISS')} · ${escapeMarkdown(detail)}`,
    ].join('\n'),
  }
}

function pager(opts: AgentIdentityListCardOpts): object {
  return {
    tag: 'column_set',
    columns: [
      buttonColumn('上一页', { kind: 'agent_identity_page', panel_id: opts.panelId, page: Math.max(0, opts.page - 1) }),
      buttonColumn('刷新', { kind: 'agent_identity_page', panel_id: opts.panelId, page: opts.page }),
      buttonColumn('下一页', { kind: 'agent_identity_page', panel_id: opts.panelId, page: Math.min(opts.totalPages - 1, opts.page + 1) }),
    ],
  }
}

function buttonColumn(text: string, value: Record<string, unknown>): object {
  return {
    tag: 'column', width: 'weighted', weight: 1,
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: text },
      type: 'default',
      behaviors: [{ type: 'callback', value }],
    }],
  }
}

function workerStatusLabel(worker: AgentWorkerResult): string {
  switch (worker.status) {
    case 'completed': return '✅ 完成'
    case 'failed': return '❌ 失败'
    case 'cancelled': return '🛑 取消'
    case 'needs_input': return '❓ 等待输入'
    case 'running': return '⏳ 运行中'
    default: return '⏳ 排队中'
  }
}

function isTerminal(status: AgentRunSnapshot['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function runStatusLabel(run: AgentRunSnapshot): string {
  const kindLabel = agentCardTaskKindLabel('delegated')
  switch (run.status) {
    case 'completed': return `✅ ${kindLabel}完成`
    case 'failed': return `❌ ${kindLabel}失败`
    case 'cancelled': return `🛑 ${kindLabel}已取消`
    case 'needs_input': return `❓ ${kindLabel}等待主 Agent 回复`
    case 'queued': return `⏳ ${kindLabel}等待执行`
    case 'running': return run.workers.length > 0 && run.workers.every(worker => isTerminal(worker.status))
      ? `⏳ ${kindLabel}正在收尾` : `⏳ ${kindLabel}正在执行`
  }
}

function inlineCode(value: string): string {
  return '`' + value.replace(/`/g, '\\`') + '`'
}

function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function shortText(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
