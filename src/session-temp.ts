/**
 * 临时会话 / fork / back / rs 历史分支。
 *
 * 控制面只持有 provider-neutral ConversationLaunch。Claude/Codex 的具体
 * fork 参数由 Session.spawnAgent 翻译；选择卡只携带 panel/choice opaque id。
 */

import type { Session } from './session'
import * as feishu from './feishu'
import * as cards from './cards'
import { log } from './log'
import { claudeTranscriptDir } from './claude-agent-process'
import { isAgentSession } from './agent-session-registry'
import {
  validateConversationLaunch,
  type ConversationBranchBase,
  type ConversationLaunch,
  type ConversationRouting,
  type ConversationSummary,
} from './conversation'
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { diagnosticIdLabel } from './session-util'

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
  sourceTs: number
  sourceStatus?: string
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

function baseSessionName(s: Session): string {
  return feishu.tempProjectName(s.sessionName) ?? s.sessionName
}

function reserveTempChatName(baseName: string): string {
  const name = feishu.tempChatName(baseName, reservedTempChatNames)
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

export function listClaudeSessions(workDir: string): ConversationSummary[] {
  const dir = claudeTranscriptDir(workDir)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    throw new Error(`读取 Claude 会话目录失败: ${error?.message ?? error}`)
  }
  const all: ConversationSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const sessionId = name.slice(0, -6)
    if (isAgentSession('claude', sessionId)) continue
    const full = join(dir, name)
    let mtime: number
    try { mtime = statSync(full).mtimeMs } catch (error: any) {
      throw new Error(`读取 Claude 会话元数据失败 (${name}): ${error?.message ?? error}`)
    }
    all.push({
      provider: 'claude',
      sessionId,
      cwd: workDir,
      preview: firstUserSummary(full),
      ts: mtime,
    })
  }
  return all.sort((a, b) => b.ts - a.ts)
}

function recentHistory(entries: ConversationSummary[]): ConversationSummary[] {
  const ordered = entries.slice().sort((a, b) => b.ts - a.ts)
  const cutoff = Date.now() - DAY_MS
  const withinCount = ordered.filter(entry => entry.ts >= cutoff).length
  return ordered.slice(0, Math.min(HISTORY_CARD_MAX, Math.max(10, withinCount)))
}

function firstUserSummary(path: string): string {
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
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let data: any
    try { data = JSON.parse(line) } catch { continue }
    if (data.type === 'queue-operation' && data.operation === 'enqueue' && typeof data.content === 'string') {
      const content = data.content.trim()
      if (content) return content.slice(0, 80)
    }
    if (!fallback && data.type === 'user' && data.message) {
      const userText = userMessageText(data.message)
      if (userText) fallback = userText
    }
  }
  return fallback.slice(0, 80)
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
  try { messageId = await feishu.sendCard(s.chatId, card) } catch (error) {
    panelMap(s).delete(panel.id)
    throw error
  }
  if (!messageId) {
    panelMap(s).delete(panel.id)
    await feishu.sendTextRaw(s.chatId, `❌ ${mode === 'fork' ? 'fk' : 'bk'} 列表发送失败`)
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
      : s.selectedProvider === 'dsh' ? await s.listDshConversations() : listClaudeSessions(s.workDir)
  } catch (error) {
    await feishu.sendTextRaw(s.chatId, `❌ 历史会话读取失败: ${error instanceof Error ? error.message : error}`)
    return
  }
  const choices = new Map<string, TempPanelChoice>()
  const entries = recentHistory(history).map(summary => {
    const choiceId = randomUUID()
    choices.set(choiceId, {
      kind: 'resume',
      launch: { kind: 'fork', source: { provider: summary.provider, sessionId: summary.sessionId, cwd: summary.cwd } },
      sourcePreview: summary.preview,
      sourceTs: summary.ts,
      sourceStatus: summary.status,
    })
    return { choiceId, preview: summary.preview, ts: summary.ts }
  })
  const panel = createPanel(s, 'resume', userOpenId, choices)
  const card = cards.resumeListCard({ projectName: baseSessionName(s), panelId: panel.id, entries })
  let messageId: string | null
  try { messageId = await feishu.sendCard(s.chatId, card) } catch (error) {
    panelMap(s).delete(panel.id)
    throw error
  }
  if (!messageId) {
    panelMap(s).delete(panel.id)
    await feishu.sendTextRaw(s.chatId, '❌ rs 历史列表发送失败')
  }
}

// ── btw / bye ────────────────────────────────────────────────────────

export async function runBtwCommand(s: Session, userOpenId: string): Promise<void> {
  if (!userOpenId) { await feishu.sendText(s.chatId, '❌ 找不到发起人，无法建临时群。'); return }
  if (!s.opts.onCreateTempSession) { await feishu.sendText(s.chatId, '❌ 临时群能力未就绪（daemon 未注入回调）。'); return }
  const chatName = reserveTempChatName(baseSessionName(s))
  await feishu.sendText(s.chatId, `🚀 正在创建 ${chatName} · ${s.backendLabel()} 新会话。它与当前群共享工作目录；当前会话不受影响。`)
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
    })
  } finally {
    releaseTempChatName(chatName)
  }
  if (!result.ok) {
    await feishu.sendText(s.chatId, `❌ 建临时会话失败: ${result.error ?? '未知'}`)
    return
  }
  await feishu.sendText(s.chatId, `✅ 已创建 ${chatName}。临时群不会自动删除；在该群发送 bye 可停止并解散。`)
}

export async function runByeCommand(s: Session): Promise<void> {
  if (!feishu.tempProjectName(s.sessionName)) {
    await feishu.sendText(s.chatId, '❌ bye 只能在带 *MMDD-HHMM 后缀的临时会话群里使用。')
    return
  }
  if (!s.opts.onDisbandTempSession) { await feishu.sendText(s.chatId, '❌ 解散能力未就绪（daemon 未注入回调）。'); return }
  await feishu.sendText(s.chatId, `👋 正在停止会话并解散 ${s.sessionName}…`)
  const result = await s.opts.onDisbandTempSession(s.sessionName, s.chatId)
  if (!result.ok) await feishu.sendText(s.chatId, `❌ 解散失败: ${result.error ?? '未知'}`)
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
    log(`session-temp: fork ${s.sessionName} → ${chatName} (${choice.launch.kind})`)
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
      const messageId = await feishu.sendCard(s.chatId, cards.writeLogCard({ projectName: panel.baseName, entries: choice.writes }))
      if (!messageId) writeLogWarning = '；文件变更记录卡发送失败'
    } catch (error) {
      writeLogWarning = `；文件变更记录卡发送失败: ${error instanceof Error ? error.message : error}`
    }
    log(`session-temp: back ${s.sessionName} (${choice.launch.kind}, writes=${choice.writes.length})`)
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
  const previousSessionId = s.lastSessionId
  const presentation = (
    newSessionId: string | null,
    bindingState: ResumeSelectionPresentation['bindingState'],
  ): ResumeSelectionPresentation => ({
    projectName: panel.baseName,
    provider: choice.launch.source.provider,
    selectedPreview: choice.sourcePreview,
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
    log(`session-temp: history fork ${s.sessionName} ← ${choice.launch.source.provider} ${sourceId}`)
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
