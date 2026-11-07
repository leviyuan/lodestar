/**
 * 临时会话 / fork / back / rs 历史分支。
 *
 * 控制面只持有 provider-neutral ConversationLaunch。Claude/Codex 的具体
 * fork 参数由 Session.spawnAgent 翻译；选择卡只携带 panel/choice opaque id。
 */

import type { Session } from './session'
import * as feishu from './feishu'
import { formatFeishuError } from './feishu-errors'
import * as cards from './cards'
import { claudeTranscriptDir } from './claude-agent-process'
import { isAgentSession } from './agent-session-registry'
import {
  validateConversationLaunch,
  type ConversationBranchBase,
  type ConversationLaunch,
  type ConversationRouting,
  type ConversationSummary,
} from './conversation'
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { diagnosticIdLabel, messageOf } from './session-util'
import { claudeSessionAccount } from './claude-session-accounts'

const DAY_MS = 24 * 60 * 60 * 1000
const PANEL_TTL_MS = 30 * 60 * 1000
const CONSUMED_PANEL_TTL_MS = 60 * 60 * 1000
const HISTORY_CARD_MAX = 40

export interface TempSelectionResult {
  ok: boolean
  message: string
  /** false means validation never claimed the panel; keep the shared picker intact. */
  replaceCard?: boolean
  /** Trusted rs selection/result snapshot for replacing the consumed picker. */
  resumePresentation?: ResumeSelectionPresentation
}

export interface ResumeSelectionPresentation {
  projectName: string
  provider: 'claude' | 'codex' | 'dsh'
  selectedPreview: string
  selectedTs: number
  sourceSessionId: string
  /** 所选会话最后一条用户输入；缺失时省略。 */
  selectedLastPreview?: string | null
  sourceStatus?: string
  previousSessionId: string | null
  newSessionId: string | null
  bindingState: 'changed' | 'prepared' | 'unchanged' | 'unknown'
}

type PanelMode = 'fork' | 'back' | 'resume'

interface ForkChoice {
  kind: 'fork' | 'back'
  launch: ConversationLaunch
  branchBase: ConversationBranchBase
  seedAnchors: feishu.TurnAnchor[]
  writes: feishu.TurnWrite[]
}

interface ResumeChoice {
  kind: 'resume'
  launch: Extract<ConversationLaunch, { kind: 'fork' }>
  sourcePreview: string
  sourceLastPreview?: string
  sourceTs: number
  sourceStatus?: string
  /** Recorded Claude account of the source session; unknown for legacy sessions. */
  sourceAccountId?: string | null
}

type TempPanelChoice = ForkChoice | ResumeChoice

interface TempPanelState {
  id: string
  mode: PanelMode
  requesterOpenId: string
  provider: 'claude' | 'codex' | 'dsh'
  sourceSessionId: string | null
  workDir: string
  baseName: string
  routing: ConversationRouting
  createdAt: number
  status: 'open' | 'processing' | 'consumed'
  consumedAt?: number
  choices: Map<string, TempPanelChoice>
}

const panelsBySession = new WeakMap<Session, Map<string, TempPanelState>>()
const reservedTempChatNames = new Set<string>()

/** 临时群基名：剥掉 `*` 后缀，保留 worktree 的 `[分支]`。
 * 这样 WT 里发起的 btw/fk 落在该 worktree 目录，重启后也能由群名复原。 */
function baseSessionName(s: Session): string {
  return feishu.stripTempSuffix(s.sessionName)
}

function reserveTempChatName(baseName: string, role = ''): string {
  const name = feishu.tempChatName(baseName, reservedTempChatNames, role)
  reservedTempChatNames.add(name)
  return name
}

function releaseTempChatName(name: string): void {
  reservedTempChatNames.delete(name)
}

function panelMap(s: Session): Map<string, TempPanelState> {
  let panels = panelsBySession.get(s)
  if (!panels) {
    panels = new Map()
    panelsBySession.set(s, panels)
  }
  const now = Date.now()
  for (const [id, panel] of panels) {
    const ttl = panel.status === 'consumed' ? CONSUMED_PANEL_TTL_MS : PANEL_TTL_MS
    const since = panel.consumedAt ?? panel.createdAt
    if (now - since > ttl) panels.delete(id)
  }
  return panels
}

function sameRouting(a: ConversationRouting, b: ConversationRouting): boolean {
  return a.provider === b.provider
    && (a.codexAccountId ?? 'default') === (b.codexAccountId ?? 'default')
    && !!a.codexAccountAutomatic === !!b.codexAccountAutomatic
    && (a.claudeAccountId ?? 'default') === (b.claudeAccountId ?? 'default')
    && a.tokenSourceId === b.tokenSourceId
    && a.model === b.model
    && a.effort === b.effort
}

function createPanel(
  s: Session,
  mode: PanelMode,
  requesterOpenId: string,
  choices: Map<string, TempPanelChoice>,
): TempPanelState {
  const panel: TempPanelState = {
    id: randomUUID(),
    mode,
    requesterOpenId,
    provider: s.selectedProvider,
    sourceSessionId: s.lastSessionId,
    workDir: s.workDir,
    baseName: baseSessionName(s),
    routing: s.conversationRouting(),
    createdAt: Date.now(),
    status: 'open',
    choices,
  }
  panelMap(s).set(panel.id, panel)
  return panel
}

function claimPanelChoice(
  s: Session,
  mode: PanelMode,
  panelId: string,
  choiceId: string,
  userOpenId: string,
): { panel: TempPanelState; choice: TempPanelChoice } | { error: string } {
  const panel = panelMap(s).get(panelId)
  if (!panel || panel.mode !== mode) return { error: '这张选择卡已过期，请重新发送命令' }
  if (!userOpenId || panel.requesterOpenId !== userOpenId) {
    return { error: '只有打开这张选择卡的用户可以执行；请自行发送命令重新打开' }
  }
  if (panel.status !== 'open') return { error: '这张选择卡已执行或正在处理，请勿重复点击' }
  if (
    panel.provider !== s.selectedProvider
    || panel.workDir !== s.workDir
    || panel.sourceSessionId !== s.lastSessionId
    || !sameRouting(panel.routing, s.conversationRouting())
  ) {
    return { error: '这张卡对应的 provider、目录或源会话已经变化，请重新发送命令' }
  }
  const choice = panel.choices.get(choiceId)
  if (!choice) return { error: '无效的选择项，这张卡可能已过期' }
  panel.status = 'processing'
  return { panel, choice }
}

function consumePanel(panel: TempPanelState): void {
  panel.status = 'consumed'
  panel.consumedAt = Date.now()
}

function forkLaunch(checkpoint: feishu.TurnAnchor['checkpoint']): Extract<ConversationLaunch, { kind: 'fork' }> {
  return { kind: 'fork', source: checkpoint.source, through: checkpoint }
}

function eligibleAnchors(s: Session): feishu.TurnAnchor[] {
  return feishu.getTurnAnchors(s.sessionName)
    .filter(anchor => anchor.checkpoint.provider === s.selectedProvider && anchor.checkpoint.source.cwd === s.workDir)
}

function usableBranchBase(s: Session): ConversationBranchBase {
  const base = feishu.getSessionBranchBase(s.sessionName)
  if (base === null || base.kind === 'fresh') return base
  try {
    validateConversationLaunch(base, s.selectedProvider, s.workDir)
    return base
  } catch {
    return null
  }
}

// ── Claude stopped-session history catalog ───────────────────────────

export function listClaudeSessions(workDir: string, options?: { configDir?: string; projectDirName?: string }): ConversationSummary[] {
  const dir = claudeTranscriptDir(workDir, options)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    throw new Error(`读取 Claude 会话目录失败: ${error?.message ?? error}`)
  }
  const all: Array<{ summary: ConversationSummary; path: string }> = []
  for (const name of names) {
    if (!name.endsWith('.jsonl') || name.includes('.orphaned-') || name.includes('.superseded-')) continue
    const sessionId = name.slice(0, -6)
    if (isAgentSession('claude', sessionId)) continue
    const full = join(dir, name)
    const preview = firstUserSummary(full, workDir)
    if (preview === null) continue
    let mtime: number
    try { mtime = statSync(full).mtimeMs } catch (error: any) {
      throw new Error(`读取 Claude 会话元数据失败 (${name}): ${error?.message ?? error}`)
    }
    all.push({ summary: { provider: 'claude', sessionId, cwd: workDir, preview, ts: mtime }, path: full })
  }
  all.sort((a, b) => b.summary.ts - a.summary.ts)
  // The picker only ever renders the newest HISTORY_CARD_MAX rows, so the
  // heavier tail read runs for those only instead of every transcript.
  return all.map((row, index) => {
    if (index >= HISTORY_CARD_MAX) return row.summary
    const lastPreview = lastMessageSummary(row.path)
    return lastPreview && lastPreview !== row.summary.preview
      ? { ...row.summary, lastPreview }
      : row.summary
  })
}

/** Tail size for the last-input scan. Tool output can be large, so a small
 *  tail can miss the closing prompt; 256 KiB keeps one rs open cheap. */
const HISTORY_TAIL_BYTES = 256 * 1024

/** Last *user* input of a Claude transcript, for the rs picker: the first
 *  input tells you how a session started, the latest request tells you what
 *  you were doing in it. Assistant prose, tool results and sidechains are
 *  ignored. Reads only the file tail. */
function lastMessageSummary(path: string): string | null {
  let text = ''
  let fd: number | null = null
  try {
    const size = statSync(path).size
    const length = Math.min(size, HISTORY_TAIL_BYTES)
    if (length <= 0) return null
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(length)
    const n = readSync(fd, buffer, 0, length, size - length)
    text = buffer.subarray(0, n).toString('utf8')
    if (size > length) {
      // Drop the partial first line created by slicing mid-file.
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1) : ''
    }
  } catch (error: any) {
    throw new Error(`读取 Claude 会话结尾失败 (${path}): ${error?.message ?? error}`)
  } finally {
    if (fd !== null) closeSync(fd)
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let data: any
    try { data = JSON.parse(line) } catch { continue }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    // Claude Code keeps the leaf prompt in its own near-EOF record; a big
    // assistant turn can push the raw user message megabytes back, so this
    // record is what makes a bounded tail read reliable. Assistant content,
    // tool results and sidechains never count: "last" means the user's last
    // input, matching the first-input preview.
    const raw = data.type === 'last-prompt' && typeof data.lastPrompt === 'string'
      ? data.lastPrompt
      : data.type === 'user' && data.isSidechain !== true ? userMessageText(data.message) : ''
    const preview = previewLine(raw)
    if (preview) return preview.slice(0, 80)
  }
  return null
}

/** First meaningful line: skip blank lines, markdown headings and fences. */
function previewLine(text: string): string {
  const withoutFiles = text.replace(/^(?:\[file: [^\]]+\]\s*)+/, '')
  for (const raw of withoutFiles.split(/\r?\n/)) {
    const line = raw.replace(/^[\s>#*\-–—]+/, '').trim()
    if (line) return line
  }
  return ''
}

function recentHistory(entries: ConversationSummary[]): ConversationSummary[] {
  const ordered = entries.slice().sort((a, b) => b.ts - a.ts)
  const cutoff = Date.now() - DAY_MS
  const withinCount = ordered.filter(entry => entry.ts >= cutoff).length
  return ordered.slice(0, Math.min(HISTORY_CARD_MAX, Math.max(10, withinCount)))
}

function firstUserSummary(path: string, workDir?: string): string | null {
  let text = ''
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const b = Buffer.alloc(65536)
    const n = readSync(fd, b, 0, 65536, 0)
    text = b.subarray(0, n).toString('utf8')
  } catch (error: any) {
    throw new Error(`读取 Claude 会话摘要失败 (${path}): ${error?.message ?? error}`)
  } finally {
    if (fd !== null) closeSync(fd)
  }
  let fallback = ''
  let queued = ''
  let checkedCwd = false
  const canonical = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let data: any
    try { data = JSON.parse(line) } catch { continue }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    if (data.isSidechain === true) return null
    if (!checkedCwd && workDir && typeof data.cwd === 'string' && isAbsolute(data.cwd)) {
      if (canonical(data.cwd) !== canonical(workDir)) return null
      checkedCwd = true
    }
    if (data.type === 'queue-operation' && data.operation === 'enqueue' && typeof data.content === 'string') {
      const content = data.content.trim()
      if (content && !queued) queued = content
    }
    if (!fallback && data.type === 'user' && data.message) {
      const userText = userMessageText(data.message)
      if (userText) fallback = userText
    }
  }
  return (queued || fallback).slice(0, 80)
}

function userMessageText(message: any): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') return part.text
  }
  return ''
}

// ── Picker cards ─────────────────────────────────────────────────────

async function showTurnList(s: Session, mode: 'fork' | 'back', userOpenId: string): Promise<void> {
  if (!userOpenId) {
    await feishu.sendText(s.chatId, '❌ 找不到发起人，无法创建安全选择卡。')
    return
  }
  const anchors = eligibleAnchors(s)
  const branchBase = usableBranchBase(s)
  const choices = new Map<string, TempPanelChoice>()
  const entries: cards.TurnListEntry[] = []
  for (let index = 0; index < anchors.length; index++) {
    const anchor = anchors[index]
    // Legacy/unknown baseline cannot prove that the first retained prompt was
    // truly at conversation origin. Omit only that destructive choice; later
    // prompts can still fork through their previous canonical checkpoint.
    if (index === 0 && branchBase === null) continue
    const choiceId = randomUUID()
    const launch: ConversationLaunch = index === 0
      ? branchBase!
      : forkLaunch(anchors[index - 1].checkpoint)
    choices.set(choiceId, {
      kind: mode,
      launch,
      branchBase,
      seedAnchors: anchors.slice(0, index),
      writes: anchors.slice(index).flatMap(item => item.writes),
    })
    entries.push({ choiceId, preview: anchor.preview, ts: anchor.ts })
  }
  entries.reverse()
  const panel = createPanel(s, mode, userOpenId, choices)
  const card = cards.turnListCard({
    projectName: baseSessionName(s),
    panelId: panel.id,
    mode,
    entries,
  })
  let messageId: string | null
  let failure: unknown
  try { messageId = await feishu.sendCard(s.chatId, card, error => { failure = error }) } catch (error) {
    panelMap(s).delete(panel.id)
    throw error
  }
  if (!messageId) {
    panelMap(s).delete(panel.id)
    await feishu.sendTextRaw(s.chatId, `❌ ${mode === 'fork' ? 'fk' : 'bk'} 列表发送失败\n${formatFeishuError(failure)}`)
  }
}

export function showForkList(s: Session, userOpenId: string): Promise<void> {
  return showTurnList(s, 'fork', userOpenId)
}

export function showBackList(s: Session, userOpenId: string): Promise<void> {
  return showTurnList(s, 'back', userOpenId)
}

export async function showResumeList(s: Session, userOpenId: string): Promise<void> {
  if (!userOpenId) {
    await feishu.sendText(s.chatId, '❌ 找不到发起人，无法创建安全选择卡。')
    return
  }
  let history: ConversationSummary[]
  try {
    history = s.selectedProvider === 'codex'
      ? await s.listCodexConversations()
      : s.selectedProvider === 'dsh' ? await s.listDshConversations() : listClaudeSessions(s.workDir, s.claudeHistoryOptions())
  } catch (error) {
    await feishu.sendTextRaw(s.chatId, `❌ 历史会话读取失败: ${error instanceof Error ? error.message : error}`)
    return
  }
  const choices = new Map<string, TempPanelChoice>()
  const entries = recentHistory(history).map(summary => {
    const choiceId = randomUUID()
    const sourceAccountId = summary.provider === 'claude' ? claudeSessionAccount(summary.sessionId) : null
    choices.set(choiceId, {
      kind: 'resume',
      launch: { kind: 'fork', source: { provider: summary.provider, sessionId: summary.sessionId, cwd: summary.cwd } },
      sourcePreview: summary.preview,
      ...(summary.lastPreview ? { sourceLastPreview: summary.lastPreview } : {}),
      sourceTs: summary.ts,
      sourceStatus: summary.status,
      sourceAccountId,
    })
    return {
      choiceId,
      preview: summary.preview,
      ...(summary.lastPreview ? { lastPreview: summary.lastPreview } : {}),
      ts: summary.ts,
      label: diagnosticIdLabel(summary.sessionId),
    }
  })
  const panel = createPanel(s, 'resume', userOpenId, choices)
  const card = cards.resumeListCard({ projectName: baseSessionName(s), panelId: panel.id, entries })
  let messageId: string | null
  let failure: unknown
  try { messageId = await feishu.sendCard(s.chatId, card, error => { failure = error }) } catch (error) {
    panelMap(s).delete(panel.id)
    throw error
  }
  if (!messageId) {
    panelMap(s).delete(panel.id)
    await feishu.sendTextRaw(s.chatId, `❌ rs 历史列表发送失败\n${formatFeishuError(failure)}`)
  }
}

// ── btw / bye ────────────────────────────────────────────────────────
// 交互提示统一用 `cards.tempSessionNoticeCard`：状态一眼可见，创建、加入、
// 退出和解散共用同一版式；卡片发送失败时回退到原文并附带飞书诊断。

/** 卡片发送失败必须回退原文并保留飞书诊断，不能静默丢掉回执。 */
async function sendTempNotice(
  s: Session,
  opts: cards.TempSessionNoticeCardOpts,
  fallback: string,
): Promise<void> {
  let failure: unknown
  let messageId: string | null = null
  try {
    messageId = await feishu.sendCard(s.chatId, cards.tempSessionNoticeCard(opts), error => { failure = error })
  } catch (error) {
    failure = error
  }
  if (!messageId) await feishu.sendTextRaw(s.chatId, `${fallback}\n${formatFeishuError(failure)}`)
}

function tempNoticeFailure(s: Session, chatName: string, message: string): Promise<void> {
  return sendTempNotice(s, { chatName, state: 'error', body: message }, `❌ ${message}`)
}

export async function runBtwCommand(s: Session, userOpenId: string, role = ''): Promise<void> {
  const baseName = baseSessionName(s)
  const normalizedRole = feishu.normalizeTempRole(role)
  if (!userOpenId) { await tempNoticeFailure(s, baseName, '找不到发起人，无法建临时群。'); return }
  if (!s.opts.onCreateTempSession) { await tempNoticeFailure(s, baseName, '临时群能力未就绪（daemon 未注入回调）。'); return }
  if (role.trim() && !normalizedRole) {
    await tempNoticeFailure(s, baseName, 'btw 备注至少需要一个中文、字母或数字字符；空格等会写成 _。不带备注时使用时间后缀。')
    return
  }
  // 带备注的 btw 用真实备注当群名,同名即同一个群:后到的人加入既有群,不再另开 *备注-2。
  const reuse = Boolean(normalizedRole)
  let chatName: string
  try {
    chatName = reuse ? feishu.tempRoleChatName(baseName, normalizedRole) : reserveTempChatName(baseName)
  } catch (error) {
    await tempNoticeFailure(s, baseName, messageOf(error))
    return
  }
  if (chatName.length > feishu.SESSION_NAME_MAX) {
    if (!reuse) releaseTempChatName(chatName)
    await tempNoticeFailure(s, chatName, `群名太长（${chatName.length} > ${feishu.SESSION_NAME_MAX}），请换一个更短的备注。`)
    return
  }
  await sendTempNotice(
    s,
    { chatName, state: 'creating', backendLabel: s.backendLabel() },
    reuse ? `🚀 正在创建或加入 ${chatName} · ${s.backendLabel()}` : `🚀 正在创建 ${chatName} · ${s.backendLabel()}`,
  )
  let result
  try {
    result = await s.opts.onCreateTempSession({
      chatName,
      userOpenId,
      workDir: s.workDir,
      routing: s.conversationRouting(),
      launch: { kind: 'fresh' },
      branchBase: { kind: 'fresh' },
      seedAnchors: [],
      ...(reuse ? { groupMode: 'reuse' as const } : {}),
    })
  } finally {
    if (!reuse) releaseTempChatName(chatName)
  }
  if (!result.ok) {
    await tempNoticeFailure(s, chatName, `建临时会话失败: ${result.error ?? '未知'}`)
    return
  }
  await sendTempNotice(
    s,
    {
      chatName,
      state: result.join ? (result.join === 'added' ? 'joined' : 'present') : 'created',
      backendLabel: s.backendLabel(),
    },
    result.join ? `✅ 已加入 ${chatName}` : `✅ 已创建 ${chatName}`,
  )
}

/** `bl` / `btwlist`：列出本机登记的全部临时会话（btw/fk 都算），
 * 并合并本 daemon 已构造会话的实时状态；只读本地租约与内存，不发网络查询。 */
export async function runBtwListCommand(s: Session): Promise<void> {
  const peers = new Map(s.tempSessionPeers().map(peer => [peer.chatId, peer]))
  const entries = new Map<string, cards.BtwListEntry>()
  const entryFor = (
    chatName: string,
    chatId: string,
    createdAt: number | null,
    peer: ReturnType<Session['tempSessionPeers']>[number] | undefined,
  ): cards.BtwListEntry => {
    const selection = peer ? null : feishu.getSessionModelSelection(chatName)
    return {
      chatName,
      projectName: feishu.tempProjectName(chatName) ?? chatName,
      createdAt,
      isCurrent: chatId === s.chatId,
      status: peer?.status ?? null,
      running: peer?.running ?? false,
      provider: peer?.provider ?? selection?.provider ?? null,
      model: peer ? peer.model : selection?.model ?? null,
      effort: peer ? peer.effort : selection?.effort ?? null,
    }
  }
  for (const lease of feishu.listTempSessionLeases()) {
    entries.set(lease.chatId, entryFor(lease.sessionName, lease.chatId, lease.createdAt, peers.get(lease.chatId)))
  }
  // 兼容租约机制之前创建、但本 daemon 已加载的临时群：内存里仍在就同样列出。
  for (const peer of peers.values()) {
    if (!entries.has(peer.chatId)) entries.set(peer.chatId, entryFor(peer.sessionName, peer.chatId, null, peer))
  }
  const list = [...entries.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      if (a.createdAt === null) return 1
      if (b.createdAt === null) return -1
      return b.createdAt - a.createdAt
    }
    return a.chatName.localeCompare(b.chatName)
  })
  let messageId: string | null = null
  let failure: unknown
  try {
    messageId = await feishu.sendCard(s.chatId, cards.btwListCard({ entries: list }), error => { failure = error })
  } catch (error) {
    failure = error
  }
  if (!messageId) await feishu.sendTextRaw(s.chatId, `❌ bl 列表发送失败\n${formatFeishuError(failure)}`)
}

export async function runByeCommand(s: Session, userOpenId = ''): Promise<void> {
  if (!feishu.tempProjectName(s.sessionName)) {
    await tempNoticeFailure(s, s.sessionName, 'bye 只能在带 *MMDD-HHMM 或 *备注 后缀的临时会话群里使用。')
    return
  }
  if (!s.opts.onDisbandTempSession) { await tempNoticeFailure(s, s.sessionName, '解散能力未就绪（daemon 未注入回调）。'); return }
  if (!userOpenId) { await tempNoticeFailure(s, s.sessionName, '找不到发起人，无法退出临时群。'); return }

  // bye 不看创建者：谁发谁退出；群里的最后一个人退出时连同会话一起解散。
  const disband = async (): Promise<void> => {
    await sendTempNotice(s, { chatName: s.sessionName, state: 'disbanding' }, `👋 正在停止会话并解散 ${s.sessionName}`)
    const result = await s.opts.onDisbandTempSession!(s.sessionName, s.chatId)
    if (!result.ok) await tempNoticeFailure(s, s.sessionName, `解散失败: ${result.error ?? '未知'}`)
  }

  let others: string[]
  try {
    others = (await feishu.chatMemberOpenIds(s.chatId)).filter(id => id !== userOpenId)
  } catch (error) {
    await tempNoticeFailure(s, s.sessionName, `读取群成员失败: ${messageOf(error)}；未执行退出或解散。`)
    return
  }
  if (others.length === 0) { await disband(); return }

  await sendTempNotice(s, { chatName: s.sessionName, state: 'leaving' }, `🚪 正在退出 ${s.sessionName}`)
  try {
    await feishu.leaveChatForMember(s.chatId, userOpenId)
  } catch (error) {
    await tempNoticeFailure(s, s.sessionName, `退出失败: ${messageOf(error)}；可以在飞书群设置里手动退出。`)
    return
  }
  // 两个人同时退出时可能都看到还有人：退出后再数一次，最后一个走的负责解散。
  try {
    if ((await feishu.chatMemberOpenIds(s.chatId)).length > 0) return
  } catch (error) {
    await tempNoticeFailure(s, s.sessionName, `已退出，但无法确认是否还有成员: ${messageOf(error)}；群未解散。`)
    return
  }
  await disband()
}

// ── Picker actions ───────────────────────────────────────────────────

export async function onForkSelect(s: Session, panelId: string, choiceId: string, userOpenId: string): Promise<TempSelectionResult> {
  const claimed = claimPanelChoice(s, 'fork', panelId, choiceId, userOpenId)
  if ('error' in claimed) return { ok: false, message: claimed.error, replaceCard: false }
  const { panel, choice } = claimed
  try {
    if (choice.kind !== 'fork') return { ok: false, message: '选择项类型不匹配' }
    if (!s.opts.onCreateTempSession) return { ok: false, message: '临时群能力未就绪' }
    const chatName = reserveTempChatName(panel.baseName)
    await feishu.sendText(s.chatId, `🔱 正在分叉到 ${chatName}…`)
    let result
    try {
      result = await s.opts.onCreateTempSession({
        chatName,
        userOpenId,
        workDir: panel.workDir,
        routing: panel.routing,
        launch: choice.launch,
        branchBase: choice.branchBase,
        seedAnchors: choice.seedAnchors,
      })
    } finally {
      releaseTempChatName(chatName)
    }
    if (!result.ok) return { ok: false, message: `分叉失败: ${result.error ?? '未知'}` }
    return { ok: true, message: `已分叉到 ${chatName}；原会话和磁盘文件未回滚` }
  } catch (error) {
    return { ok: false, message: `分叉失败: ${error instanceof Error ? error.message : error}` }
  } finally {
    consumePanel(panel)
  }
}

export async function onBackSelect(s: Session, panelId: string, choiceId: string, userOpenId: string): Promise<TempSelectionResult> {
  const claimed = claimPanelChoice(s, 'back', panelId, choiceId, userOpenId)
  if ('error' in claimed) return { ok: false, message: claimed.error, replaceCard: false }
  const { panel, choice } = claimed
  try {
    if (choice.kind !== 'back') return { ok: false, message: '选择项类型不匹配' }
    let writeLogWarning = ''
    try {
      let failure: unknown
      const messageId = await feishu.sendCard(s.chatId, cards.writeLogCard({ projectName: panel.baseName, entries: choice.writes }), error => { failure = error })
      if (!messageId) writeLogWarning = `；文件变更记录卡发送失败: ${formatFeishuError(failure)}`
    } catch (error) {
      writeLogWarning = `；文件变更记录卡发送失败: ${formatFeishuError(error)}`
    }
    const ok = await s.rollbackTo(choice.launch, {
      anchors: choice.seedAnchors,
      base: choice.branchBase,
    })
    if (!ok) return { ok: false, message: `回退失败；原会话绑定未改，请检查日志后重试${writeLogWarning}` }
    if (panel.routing.provider === 'claude') {
      return {
        ok: true,
        message: `本群已准备 Claude 新分支；发送下一条消息时生成并接入，旧会话未删除，磁盘文件未回滚${writeLogWarning}`,
      }
    }
    const thread = s.lastSessionId ? ` ${diagnosticIdLabel(s.lastSessionId)}` : ''
    return { ok: true, message: `本群已改接新会话${thread}；旧会话未删除，磁盘文件未回滚${writeLogWarning}` }
  } catch (error) {
    return { ok: false, message: `回退失败: ${error instanceof Error ? error.message : error}` }
  } finally {
    consumePanel(panel)
  }
}

export async function onResumeSelect(s: Session, panelId: string, choiceId: string, userOpenId: string): Promise<TempSelectionResult> {
  const claimed = claimPanelChoice(s, 'resume', panelId, choiceId, userOpenId)
  if ('error' in claimed) return { ok: false, message: claimed.error, replaceCard: false }
  const { panel, choice } = claimed
  if (choice.kind !== 'resume') {
    consumePanel(panel)
    throw new Error('resume panel contained a non-resume choice')
  }
  const sourceId = choice.launch.source.sessionId
  const sourceProvider = choice.launch.source.provider
  const previousSessionId = s.lastSessionId
  const presentation = (
    newSessionId: string | null,
    bindingState: ResumeSelectionPresentation['bindingState'],
  ): ResumeSelectionPresentation => ({
    projectName: panel.baseName,
    provider: sourceProvider,
    selectedPreview: choice.sourcePreview,
    ...(choice.sourceLastPreview ? { selectedLastPreview: choice.sourceLastPreview } : {}),
    selectedTs: choice.sourceTs,
    sourceSessionId: sourceId,
    ...(choice.sourceStatus ? { sourceStatus: choice.sourceStatus } : {}),
    previousSessionId,
    newSessionId,
    bindingState,
  })
  const finish = (
    ok: boolean,
    message: string,
    bindingState: ResumeSelectionPresentation['bindingState'],
    newSessionId: string | null = null,
  ): TempSelectionResult => ({
    ok,
    message,
    resumePresentation: presentation(newSessionId, bindingState),
  })
  try {
    if (s.isRunning()) return finish(false, '当前群已经启动了新进程；为避免误杀，请先停止后重新发送 rs', 'unchanged')
    if (choice.sourceStatus === 'active') {
      return finish(false, '所选 Codex 会话仍在运行；请先在原位置停止后再创建完整分支', 'unchanged')
    }
    // Keep the account this history ran on. It is only used when every usable
    // account is out of quota, so rs does not silently move the conversation
    // to the default account just because all quotas are spent.
    if (sourceProvider === 'claude') s.claudeResumeAccountId = choice.sourceAccountId ?? undefined
    const ok = await s.rollbackTo(choice.launch, {
      anchors: [],
      base: choice.launch,
      pendingLaunch: choice.launch.source.provider === 'claude'
        ? { launch: choice.launch, previousSessionId }
        : null,
    })
    if (!ok) return finish(false, '历史分支创建失败；原会话绑定未改，请检查日志后重试', 'unchanged')
    if (choice.launch.source.provider === 'claude') {
      return finish(true, 'Claude 独立分支已准备；首条消息时生成并接入新会话', 'prepared')
    }
    const newSessionId = s.lastSessionId
    if (!newSessionId) {
      return finish(false, '历史分支已启动，但后端没有返回新会话 id', 'unknown')
    }
    if (newSessionId === sourceId || (previousSessionId && newSessionId === previousSessionId)) {
      return finish(false, '后端没有返回独立的新会话 id；为避免误判，本次不标记为恢复成功', 'unknown', newSessionId)
    }
    return finish(true, '已创建并接入独立分支；源会话未修改', 'changed', newSessionId)
  } catch (error) {
    return finish(false, `历史分支创建失败: ${error instanceof Error ? error.message : error}`, 'unknown')
  } finally {
    consumePanel(panel)
  }
}
