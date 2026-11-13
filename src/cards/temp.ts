/**
 * 临时群 / fork / back / rs 恢复 相关卡片。
 *
 *   - turnListCard     fk/bk 的"用户输入列表"卡片(倒序,每条一个按钮)
 *   - resumeListCard   rs 空闲模式的"项目最近会话"列表
 *   - writeLogCard     bk 后发的"观察到的文件变更"卡(代码块,可复制)
 *
 * 和 cards/worktree.ts 同一套 schema 2.0 + column_set + button callback 风格。
 * 按钮的 value.kind 在 daemon.ts handleCardAction 里 dispatch。
 */

import { agentProviderLabel, type AgentProvider } from '../agent-process'
import { diagnosticIdLabel } from '../session-util'
import { fencedCodeBlock, sliceWholeCharacters } from '../markdown-code'

export interface TurnListEntry {
  /** 仅供当前 panel 解析的稳定、不透明 choice id。 */
  choiceId: string
  preview: string
  ts: number
}

export interface TempListNotice {
  type: 'info' | 'error'
  content: string
}

export interface TurnListCardOpts {
  projectName: string
  /** 调用方登记的短期选择面板 id；回调必须同时校验 panel 和 choice。 */
  panelId: string
  mode: 'fork' | 'back'
  entries: TurnListEntry[]
  notice?: TempListNotice
}

export interface ResumeListEntry {
  /** 仅供当前 panel 解析的稳定、不透明 choice id。 */
  choiceId: string
  /** 首条用户输入（会话主题）。 */
  preview: string
  /** 最后一条用户输入；缺失（旧记录/其他后端）时省略。 */
  lastPreview?: string
  ts: number
  /** 仅展示：会话短标签（与状态卡/结果卡同一格式），不进入回调。 */
  label?: string
}

export interface ResumeListCardOpts {
  projectName: string
  /** 调用方登记的短期选择面板 id；回调必须同时校验 panel 和 choice。 */
  panelId: string
  entries: ResumeListEntry[]
}

export interface WriteLogEntry {
  /** Write / Edit / NotebookEdit / MultiEdit / FileChange */
  tool: string
  path: string
  /** content(Write) / new_string(Edit) / diff(FileChange) / 摘要。 */
  body: string
}

export interface WriteLogCardOpts {
  projectName: string
  entries: WriteLogEntry[]
}

export interface SelectionResultCardOpts {
  title: string
  message: string
  ok: boolean
}

export interface ResumeSelectionResultCardOpts {
  projectName: string
  provider: 'claude' | 'codex' | 'dsh'
  selectedPreview: string
  /** 所选会话最后一条用户输入；缺失时省略。 */
  selectedLastPreview?: string | null
  selectedTs: number
  sourceSessionId: string
  /** 后端返回的会话状态（仅 Codex）。 */
  sourceStatus?: string
  previousSessionId: string | null
  newSessionId: string | null
  bindingState: 'changed' | 'prepared' | 'unchanged' | 'unknown'
  message: string
  ok: boolean
}

const WRITE_BODY_MAX = 800
/** Serialized size budget of the write-log code block, below the 30 KB card limit. */
const WRITE_LOG_MAX_BYTES = 24_000

export function turnListCard(opts: TurnListCardOpts): object {
  const isFork = opts.mode === 'fork'
  const btnText = isFork ? '分叉' : '回退'
  const kind = isFork ? 'temp_fork_select' : 'temp_back_select'
  const hint = isFork
    ? '💡 选择一条「用户输入」，将在临时群从它**之前**创建独立对话分支；选中的输入本身不包含。\n分支与本群共享 cwd 和磁盘文件；只分叉对话历史，不复制或回滚文件，原会话不动。'
    : '⚠️ 选择一条「用户输入」，将停止本群当前 turn 和后台任务，并从它**之前**创建后续对话分支；选中的输入本身不包含。\n只回退对话历史，不会回滚 cwd 中的文件。'
  const elements: object[] = []
  if (opts.notice) elements.push({ tag: 'markdown', content: noticeMarkdown(opts.notice) })
  if (!opts.entries.length) {
    elements.push({ tag: 'markdown', content: '_当前会话还没有已完成的 turn，无法分叉/回退。_' })
  } else {
    elements.push({ tag: 'markdown', content: hint })
    for (const e of opts.entries) {
      elements.push({
        tag: 'column_set',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 5,
            elements: [{
              tag: 'markdown',
              content: `**${fmtTime(e.ts)}**\n${inlineCode(e.preview.slice(0, 60) || '(空)')}`,
            }],
          },
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: btnText },
              type: isFork ? 'primary' : 'danger',
              behaviors: [{
                type: 'callback',
                value: { kind, panel_id: opts.panelId, choice_id: e.choiceId },
              }],
            }],
          },
        ],
      })
    }
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `${isFork ? '🔱 fk 分叉' : '⏪ bk 回退'} · ${opts.projectName}` },
      template: isFork ? 'turquoise' : 'orange',
    },
    body: { elements },
  }
}

export function resumeListCard(opts: ResumeListCardOpts): object {
  const elements: object[] = []
  if (!opts.entries.length) {
    elements.push({ tag: 'markdown', content: `_项目「${opts.projectName}」没有可创建分支的历史会话。_` })
  } else {
    elements.push({
      tag: 'markdown',
      content: '💡 选择一个历史会话，在**当前群**创建独立对话分支；源会话不动。\n新分支共享当前 cwd 和磁盘文件；只分叉对话历史，不复制或回滚文件。',
    })
    for (const e of opts.entries) {
      elements.push({
        tag: 'column_set',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 5,
            elements: [{
              tag: 'markdown',
              content: [
                `**${fmtTime(e.ts)}**${e.label ? ` · ${inlineCode(e.label)}` : ''}`,
                `🚩 ${inlineCode(e.preview.slice(0, 60) || '(无摘要)')}`,
                ...(e.lastPreview ? [`🏁 ${inlineCode(e.lastPreview.slice(0, 60))}`] : []),
              ].join('\n'),
            }],
          },
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: '分支' },
              type: 'primary',
              behaviors: [{
                type: 'callback',
                value: {
                  kind: 'temp_resume_select',
                  panel_id: opts.panelId,
                  choice_id: e.choiceId,
                },
              }],
            }],
          },
        ],
      })
    }
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `🔁 rs 独立分支 · ${opts.projectName}` },
      template: 'purple',
    },
    body: { elements },
  }
}

export function writeLogCard(opts: WriteLogCardOpts): object {
  // An interactive card is limited to about 30 KB of JSON. Past that the whole record
  // failed to send; show what fits and say how much was left out.
  const blocks: string[] = []
  let bytes = 0
  for (const e of opts.entries) {
    const body = e.body.length > WRITE_BODY_MAX ? sliceWholeCharacters(e.body, WRITE_BODY_MAX) + '\n…(截断)' : e.body
    const block = `${e.path}  (${e.tool})\n${body}`
    const size = Buffer.byteLength(JSON.stringify(block)) + 4
    if (bytes + size > WRITE_LOG_MAX_BYTES) break
    bytes += size
    blocks.push(block)
  }
  const omitted = opts.entries.length - blocks.length
  if (omitted > 0) blocks.push(`…(另有 ${omitted} 处文件变更超出卡片大小上限，未显示)`)
  const code = opts.entries.length === 0
    ? '(回退范围内未观察到 Write/Edit/FileChange 类文件变更)'
    : blocks.join('\n\n')
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `📋 观察到的文件变更 · ${opts.projectName}` },
      template: 'grey',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '以下是回退范围内观察到的文件变更，可复制、编辑后交给新分支参考。bk 只回退对话历史，不会回滚磁盘文件；Shell/MCP 等工具造成的副作用可能未被记录。',
        },
        // File contents are literal: a fence they cannot close keeps them from becoming card markup.
        { tag: 'markdown', content: fencedCodeBlock(code) },
      ],
    },
  }
}

/** Terminal replacement for one-shot menu/fork/back/resume selection cards.
 * It intentionally contains no callback elements, so a completed source card
 * cannot become actionable again after the short in-memory dedupe TTL. */
export function selectionResultCard(opts: SelectionResultCardOpts): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: opts.title },
      template: opts.ok ? 'green' : 'red',
    },
    body: {
      elements: [{
        tag: 'markdown',
        content: `${opts.ok ? '✅' : '❌'} ${escapeMarkdown(opts.message)}`,
      }],
    },
  }
}

/** Terminal in-place replacement for an rs history picker. It keeps the
 * trusted selection snapshot visible after the buttons are consumed, so the
 * user can verify which backend/history produced the current branch. */
export function resumeSelectionResultCard(opts: ResumeSelectionResultCardOpts): object {
  const provider = agentProviderLabel(opts.provider)
  const stateLabel = opts.bindingState === 'changed'
    ? '已接入'
    : opts.bindingState === 'prepared'
      ? '已准备'
    : opts.bindingState === 'unchanged'
      ? '未切换'
      : '状态待确认'
  const stateIcon = opts.bindingState === 'changed'
    ? '✅'
    : opts.bindingState === 'prepared'
      ? '⏳'
      : opts.bindingState === 'unchanged'
        ? '❌'
        : '⚠️'
  const preview = opts.selectedPreview.slice(0, 80) || '(无摘要)'
  const sourceStatus = opts.sourceStatus
    ? ` · 状态 ${inlineCode(opts.sourceStatus)}`
    : ''
  const outcome = opts.bindingState === 'changed'
    ? [
        '**当前群**',
        `新会话 ${inlineCode(compactSessionId(opts.newSessionId))}`,
        '',
        '源会话未修改；新分支与当前群共享 cwd 和磁盘文件。',
      ].join('\n')
    : opts.bindingState === 'prepared'
      ? [
        '**当前群**',
        `Claude 独立分支已准备；发送下一条消息时生成并接入新会话。`,
        '',
        '源会话未修改；新分支与当前群共享 cwd 和磁盘文件。',
      ].join('\n')
      : opts.bindingState === 'unchanged'
      ? [
        `${escapeMarkdown(opts.message)}`,
        '',
        `本群原绑定 ${inlineCode(compactSessionId(opts.previousSessionId))}；源会话未修改。`,
      ].join('\n')
      : [
        `${escapeMarkdown(opts.message)}`,
        '',
        `后端返回会话 ${inlineCode(compactSessionId(opts.newSessionId))}；当前绑定无法确认。`,
        '请发送 hi 或 rs 检查当前状态，不要把本卡视为成功回执。',
      ].join('\n')
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: {
        tag: 'plain_text',
        content: `🔁 rs ${stateLabel} · ${opts.projectName}`,
      },
      template: opts.bindingState === 'changed'
        ? 'green'
        : opts.bindingState === 'prepared'
          ? 'purple'
          : opts.bindingState === 'unchanged'
            ? 'red'
            : 'orange',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `${stateIcon} ${opts.bindingState === 'changed' ? '已从所选历史创建独立分支' : opts.bindingState === 'prepared' ? '已准备从所选历史创建独立分支' : opts.bindingState === 'unchanged' ? '历史分支创建失败' : '分支结果需要确认'}`,
        },
        {
          tag: 'markdown',
          content: [
            `**所选历史 · ${provider}**`,
            `**${fmtTime(opts.selectedTs)}**${sourceStatus}`,
            `🚩 ${inlineCode(preview)}`,
            ...(opts.selectedLastPreview ? [`🏁 ${inlineCode(opts.selectedLastPreview.slice(0, 80))}`] : []),
            `源会话 ${inlineCode(compactSessionId(opts.sourceSessionId))}`,
          ].join('\n'),
        },
        { tag: 'markdown', content: outcome },
      ],
    },
  }
}

/** btw / bye 的生命周期提示卡：创建、加入、退出、解散和失败都用同一套版式。 */
export type TempSessionNoticeState =
  | 'creating'
  | 'created'
  | 'joined'
  | 'present'
  | 'disbanding'
  | 'leaving'
  | 'error'

export interface TempSessionNoticeCardOpts {
  /** 目标临时群名（`<项目>*<备注>` 或 `<项目>*MMDD-HHMM`）。 */
  chatName: string
  state: TempSessionNoticeState
  /** 本次会话的后端名（`Codex` / `Claude` / `DeepSeek Harness`），未知时省略。 */
  backendLabel?: string
  /** 失败原因或补充说明；错误态必填。 */
  body?: string
}

interface TempSessionNoticeCopy {
  emoji: string
  status: string
  template: string
  /** 一行以内的补充说明；群名已由标题承载，正文不重复。 */
  hint: string
}

const TEMP_SESSION_NOTICE_COPY: Record<TempSessionNoticeState, TempSessionNoticeCopy> = {
  creating: { emoji: '🚀', status: '创建中…', template: 'blue', hint: '' },
  created: { emoji: '✅', status: '临时群已就绪', template: 'green', hint: 'bye 退出' },
  joined: { emoji: '👥', status: '已加入', template: 'turquoise', hint: '沿用群内会话' },
  present: { emoji: '👤', status: '已在群内', template: 'blue', hint: '沿用群内会话' },
  disbanding: { emoji: '👋', status: '正在解散', template: 'orange', hint: '' },
  leaving: { emoji: '🚪', status: '正在退出', template: 'grey', hint: '群和会话保留' },
  error: { emoji: '❌', status: '操作失败', template: 'red', hint: '' },
}

export function tempSessionNoticeCard(opts: TempSessionNoticeCardOpts): object {
  const copy = TEMP_SESSION_NOTICE_COPY[opts.state]
  const lines = [`**${copy.status}**${opts.backendLabel ? ` · ${opts.backendLabel}` : ''}`]
  if (opts.state === 'error') {
    lines.push(opts.body ?? '未知错误')
  } else {
    if (copy.hint) lines.push(copy.hint)
    if (opts.body) lines.push(opts.body)
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `${copy.emoji} ${opts.chatName}` },
      template: copy.template,
    },
    body: { elements: [{ tag: 'markdown', content: lines.join('\n') }] },
  }
}

/** `bl` 列表的一行：租约 + 当前 daemon 中已构造的会话状态。 */
export interface BtwListEntry {
  /** 临时群名 / 会话名（`<基名>*<备注或时间>`）。 */
  chatName: string
  /** 去掉 `*后缀` 的所属项目，WT 临时群保留 `[分支]`。 */
  projectName: string
  /** 租约创建时间；旧记录或未登记会话为 null。 */
  createdAt: number | null
  /** 是否为发送 `bl` 的当前群。 */
  isCurrent: boolean
  /** 已构造会话的实时状态；本 daemon 尚未构造时为 null。 */
  status: 'idle' | 'working' | 'awaiting_permission' | 'starting' | 'stopped' | null
  running: boolean
  provider: AgentProvider | null
  model: string | null
  effort: string | null
}

export interface BtwListCardOpts {
  entries: BtwListEntry[]
}

const BTW_LIST_STATUS: Record<string, { emoji: string; label: string }> = {
  idle: { emoji: '🟢', label: '空闲' },
  working: { emoji: '⚙️', label: '工作中' },
  awaiting_permission: { emoji: '🔐', label: '等审批' },
  starting: { emoji: '🚀', label: '启动中' },
  stopped: { emoji: '⚪', label: '未运行' },
}

export function btwListCard(opts: BtwListCardOpts): object {
  const elements: object[] = []
  if (!opts.entries.length) {
    elements.push({ tag: 'markdown', content: '_还没有临时会话。发送 `btw` 创建。_' })
  } else {
    const running = opts.entries.filter(entry => entry.running).length
    elements.push({
      tag: 'markdown',
      content: [
        `共 **${opts.entries.length}** 个临时会话${running ? ` · 已启动 **${running}** 个` : ''}`,
        '_按创建时间倒序；`btw` 创建，`bye` 自己退出，最后一人退出时解散。_',
      ].join('\n'),
    })
    const rows = opts.entries.map(btwListEntryMarkdown)
    // 一个 markdown 元素最多放 20 条，避免群很多时单元素内容超限；卡片元素本身远低于上限。
    for (let index = 0; index < rows.length; index += 20) {
      elements.push({ tag: 'markdown', content: rows.slice(index, index + 20).join('\n\n') })
    }
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '📋 bl · btw 列表' },
      template: 'turquoise',
    },
    body: { elements },
  }
}

function btwListEntryMarkdown(entry: BtwListEntry): string {
  const status = entry.status
    ? BTW_LIST_STATUS[entry.status]
    : { emoji: entry.running ? '🟢' : '⚪', label: entry.running ? '运行中' : '未运行' }
  return [
    `**${inlineCode(entry.chatName)}**${entry.isCurrent ? ' · 本群' : ''}`,
    [
      `项目 ${inlineCode(entry.projectName)}`,
      entry.createdAt === null ? '创建 MISS' : `创建 ${fmtTime(entry.createdAt)}`,
      btwListModelLabel(entry),
      `${status.emoji} ${status.label}`,
    ].join(' · '),
  ].join('\n')
}

function btwListModelLabel(entry: BtwListEntry): string {
  if (!entry.provider) return '模型 MISS'
  const provider = agentProviderLabel(entry.provider)
  if (!entry.model) return `${provider} · 默认模型`
  const effort = entry.effort ? `/${inlineCode(entry.effort)}` : ''
  return `${provider} · ${inlineCode(entry.model)}${effort}`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function inlineCode(s: string): string {
  return '`' + escapeHtml(s.replace(/`/g, '\\`').replace(/\n/g, ' ')) + '`'
}

function compactSessionId(value: string | null): string {
  const id = value?.trim() ?? ''
  return id ? diagnosticIdLabel(id) : 'MISS'
}

function escapeMarkdown(s: string): string {
  return escapeHtml(s)
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]()#+\-.!|>~])/g, '\\$1')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function noticeMarkdown(notice: TempListNotice): string {
  const color = notice.type === 'error' ? 'red' : 'grey'
  return notice.content
    .split('\n')
    .map(line => `<font color='${color}'>${line || ' '}</font>`)
    .join('\n')
}

/** 截断 Write/Edit 工具 input → 卡片用的 body 文本(给 writeLogCard 喂数据)。 */
export function writeBodyFromToolInput(input: any): string {
  if (!input || typeof input !== 'object') return ''
  if (typeof input.content === 'string') return input.content
  if (typeof input.new_string === 'string') return input.new_string
  if (typeof input.new_source === 'string') return input.new_source  // NotebookEdit
  if (Array.isArray(input.edits)) {
    // MultiEdit:多组 old/new,取所有 new_string 拼接
    return input.edits
      .map((ed: any) => typeof ed?.new_string === 'string' ? ed.new_string : '')
      .filter(Boolean)
      .join('\n---\n')
  }
  return ''
}

/**
 * 把后端文件工具输入展开成 writeLogCard 可消费的记录。
 * Claude 的 Write/Edit 等一次对应一条；Codex FileChange 一次可能含多个文件，
 * 因此按 changes[path,diff] 逐条展开。Shell/MCP 不在这里推断，避免伪造记录。
 */
export function writeLogEntriesFromToolInput(tool: string, input: any): WriteLogEntry[] {
  if (!input || typeof input !== 'object') return []

  if (tool === 'FileChange' || tool === 'fileChange') {
    if (!Array.isArray(input.changes)) return []
    return input.changes
      .filter((change: any) => change && typeof change === 'object')
      .map((change: any) => ({
        tool,
        path: typeof change.path === 'string' && change.path ? change.path : '?',
        body: typeof change.diff === 'string'
          ? change.diff
          : typeof change.unified_diff === 'string'
            ? change.unified_diff
            : '',
      }))
  }

  if (!['Write', 'Edit', 'NotebookEdit', 'MultiEdit'].includes(tool)) return []
  const path = input.file_path ?? input.path ?? input.notebook_path
  return [{
    tool,
    path: typeof path === 'string' && path ? path : '?',
    body: writeBodyFromToolInput(input),
  }]
}
