/**
 * Lodestar 2.0 daemon — Feishu (Lark) ↔ Codex app-server bridge.
 *
 * No source-file shebang on purpose:
 *   - `bun daemon.ts` and `systemctl --user start feishu-daemon` don't
 *     need it (they invoke the runtime explicitly).
 *   - `bun build --target=node --banner='#!/usr/bin/env node'` is the
 *     official entry; a duplicate shebang in source would survive into
 *     the bundle below the banner and break Node's parser (line-3
 *     shebang isn't recognized).
 *
 * Listens on Lark WebSocket for inbound messages and card-action
 * callbacks, routes each to a per-chat Session that owns a headless
 * `codex app-server` subprocess and a streaming Card Kit card.
 *
 * Run:   bun daemon.ts
 * Stop:  SIGTERM
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { startBackgroundRefresh, stopBackgroundRefresh } from './src/background-refresh'
import { refreshTokenSourceUsage } from './src/token-source-cache'
import { pendingSourceCommands } from './src/session-commands'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Session } from './src/session'
import * as feishu from './src/feishu'
import { formatFeishuError } from './src/feishu-errors'
import * as cards from './src/cards'
import { actionCardResponse } from './src/card-action'
import { debugModelActionEvent, debugModelState } from './src/debug-model'
import {
  get as getNotifyCallback,
  markResolved as markNotifyCallbackResolved,
  recordCallbackSuccess,
  recordCallbackFailure,
  beginCallbackDispatch,
  dispatchCallback,
  isDispatching,
  setDispatching,
  clearDispatching,
  loadCallbacks,
  type NotifyButton,
  type NotifyRegistration,
} from './src/notify-callbacks'
import { buildNotifyCardFromReg } from './src/notify'
import { startNotifyServer } from './src/notify'
import { ensureFeishuNotifySkill } from './src/notify-skill'
import { createNotifyReplyRuntime } from './src/notify-replies'
import { AgentService } from './src/agent-service'
import { codexLogins } from './src/codex-login'
import { settleCodexAccountCards } from './src/session-codex-accounts'
import { handleAgentRequest } from './src/agent-api'
import { ensureLodestarAgentSkill } from './src/agent-skill'
import { removeManagedSkill } from './src/managed-skills'
import { ensureLodestarAgentCommand } from './src/managed-commands'
import { config } from './src/config'
import { log } from './src/log'
import { startAgentAutoUpdates } from './src/agent-updates'
import { DEBUG_CTX_FILE, DEBUG_SOCK_FILE, PID_FILE } from './src/paths'
import { checkPidGuard, writePidFile } from './src/pid-guard'
import {
  inboundMessageResource,
  consumePendingTextInput,
  inboundResourceDownloadFailureText,
  isStaleAtReceipt,
} from './src/inbound-message'
import { drainDynamicWork, trackWork } from './src/inflight-work'
import { modelActionCompletion, type ModelActionResult } from './src/session-util'
import { DaemonSessionRecovery } from './src/daemon-session-recovery'
import {
  ActionDeduper,
  PerKeyActor,
  createCardActionAdmission,
  createPerChatAdmission,
} from './src/card-action-runtime'
import {
  createTempSessionRuntime,
  type CreateTempSessionOptions,
  type CreateTempSessionResult,
  type DisbandTempSessionResult,
} from './src/temp-session-runtime'

// ── PID guard ───────────────────────────────────────────────────────────
// dev 路径 (`bun daemon.ts` 直接跑) 不经过 cli.ts, 所以这里也守一道。
// 走 checkPidGuard 同一份逻辑: 校验 PID 文件里那个 pid 的 cmdline 包含
// 我们启动时记下的 marker, 避免 PID 被回收导致的假阳性把后续启动锁死。
{
  const guard = checkPidGuard(PID_FILE)
  if (guard.state === 'exit') {
    console.error(`lodestar-daemon: already running (pid ${guard.pid})`)
    process.exit(1)
  }
  if (existsSync(PID_FILE)) { try { unlinkSync(PID_FILE) } catch {} }
}

mkdirSync(dirname(PID_FILE), { recursive: true })
writePidFile(PID_FILE)

let cleanupDone = false
let shutdownRequested = false
let shutdownPromise: Promise<void> | null = null
let shutdownExitCode = 0
let stopAgentAutoUpdates: (() => void) | undefined
let stopFeishuWs: (() => void) | undefined
const SHUTDOWN_DEADLINE_MS = 15_000
const cleanup = () => {
  if (cleanupDone) return
  cleanupDone = true
  try {
    sessionRecovery.persist()
  } catch (e) { log(`alive marker write failed: ${e}`) }
  try { unlinkSync(PID_FILE) } catch {}
  try { unlinkSync(DEBUG_SOCK_FILE) } catch {}
}

function requestShutdown(reason: string, exitCode: number): Promise<void> {
  // A later fatal error must upgrade an already-running graceful shutdown.
  // Reusing the same drain promise is fine; reusing its original exit code is
  // not, otherwise SIGTERM followed by an unhandled rejection exits 0.
  shutdownExitCode = Math.max(shutdownExitCode, exitCode)
  if (shutdownPromise) return shutdownPromise
  shutdownRequested = true
  stopBackgroundRefresh()
  stopAgentAutoUpdates?.()
  // Seal both message and action admission synchronously before taking the
  // dynamic work snapshot. Already-admitted tails remain drainable.
  chatActor.close()
  for (const session of sessions.values()) session.closeModelSettingsChanges()
  try { stopFeishuWs?.() }
  catch (error) {
    shutdownExitCode = 1
    log(`shutdown WebSocket close failed: ${error}`)
  }
  // Keep boot's not-yet-restored names while admitted commands drain. Freeze
  // only after that drain, so an already-accepted user kill is respected.
  try {
    sessionRecovery.persist()
  } catch (e) {
    log(`shutdown alive marker write failed: ${e}`)
    shutdownExitCode = 1
  }
  shutdownPromise = (async () => {
    log(`${reason}: staged shutdown begin sessions=${sessions.size}`)
    try {
      const stopping = (async () => {
        await drainDynamicWork(() => [
          ...chatActor.pending(),
          ...inflightCardActions,
          ...pendingSourceCommands(),
        ])
        sessionRecovery.freezeForShutdown()
        const agentResults = await Promise.allSettled([
          agentService.shutdown(`daemon ${reason}`),
          codexLogins.shutdown(),
        ])
        const accountCardResults = await Promise.allSettled([settleCodexAccountCards()])
        const sessionResults = await Promise.allSettled(
          [...sessions.values()].map(session => session.stop(`daemon ${reason}`, { announce: false })),
        )
        return [...agentResults, ...accountCardResults, ...sessionResults]
      })()
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null
      const deadline = new Promise<'deadline'>(resolve => {
        deadlineTimer = setTimeout(() => resolve('deadline'), SHUTDOWN_DEADLINE_MS)
      })
      const outcome = await Promise.race([
        stopping.then(results => {
          for (const result of results) {
            if (result.status === 'rejected') {
              shutdownExitCode = 1
              log(`shutdown session stop failed: ${result.reason}`)
            }
          }
          return 'stopped' as const
        }),
        deadline,
      ])
      if (deadlineTimer) clearTimeout(deadlineTimer)
      if (outcome === 'deadline') {
        shutdownExitCode = 1
        log(`${reason}: shutdown deadline ${SHUTDOWN_DEADLINE_MS}ms reached; forcing exit`)
      } else {
        log(`${reason}: all sessions stopped`)
      }
    } catch (e) {
      log(`${reason}: staged shutdown failed: ${e}`)
      shutdownExitCode = 1
    } finally {
      cleanup()
      process.exit(shutdownExitCode)
    }
  })()
  return shutdownPromise
}

process.on('exit', cleanup)
process.on('SIGTERM', () => { void requestShutdown('SIGTERM', 0) })
process.on('SIGINT',  () => { void requestShutdown('SIGINT', 0) })
// Windows 没有 POSIX SIGTERM;NSSM/WinSW 这类 Windows service wrapper
// 在停服务时通常发 SIGBREAK (Ctrl-Break 的内核映射),让进程优雅退出。
// 仅在 Win32 上注册,避免 Linux/Mac 跑 listener-count 检查时多出一个
// 无关的信号 handler。
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => { void requestShutdown('SIGBREAK', 0) })
}
process.on('unhandledRejection', e => {
  log(`unhandledRejection: ${e instanceof Error ? e.stack ?? e.message : e}`)
  void requestShutdown('unhandledRejection', 1)
})
process.on('uncaughtException', e => {
  log(`uncaughtException: ${e.stack ?? e.message}`)
  void requestShutdown('uncaughtException', 1)
})

// ── Session registry ────────────────────────────────────────────────────
const sessions = new Map<string, Session>()  // key = chatId
const agentService = new AgentService()
const chatActor = new PerKeyActor()
const sessionRecovery = new DaemonSessionRecovery({
  readMarker: feishu.readAliveMarker,
  writeMarker: feishu.writeAliveMarker,
  sessions: () => sessions.values(),
  chatIdForSession: feishu.chatIdForSession,
  sessionFor,
  actor: chatActor,
  isShuttingDown: () => shutdownRequested,
  log,
})
const cardActionDeduper = new ActionDeduper(30_000)
const inflightCardActions = new Set<Promise<unknown>>()
const messageAdmission = createPerChatAdmission<any>({
  actor: chatActor,
  key: data => String(data?.message?.chat_id ?? ''),
  execute: (data, acceptedAt) => handleMessage(data, acceptedAt),
})

function trackCardActionWork<T>(work: Promise<T>): Promise<T> {
  return trackWork(inflightCardActions, work)
}

/** Preserve Feishu delivery order per chat without delaying the WS ACK. Work
 * in different groups remains concurrent; messages and lifecycle commands in
 * one group cannot overtake an earlier attachment download/card open. */
function enqueueMessage(data: any, source = 'ws'): boolean {
  if (shutdownRequested) {
    log(`${source}: reject inbound message: daemon shutdown in progress`)
    return false
  }
  const chatId = String(data?.message?.chat_id ?? '')
  const admitted = messageAdmission.accept(data)
  if (!admitted.accepted) {
    log(`${source}: reject inbound message${chatId ? '' : ' without chat_id'}: actor ${admitted.reason}`)
    return false
  }
  void admitted.completion.catch(e => { log(`${source}: handleMessage rejected chat=${chatId.slice(0, 8)}…: ${e}`) })
  return true
}

function writeCurrentAliveMarker(): void {
  sessionRecovery.persist()
}

const tempSessionRuntime = createTempSessionRuntime<Session>({
  registry: sessions,
  createSession: (sessionName, chatId) => {
    const session = new Session(sessionName, chatId, {
      agentCards: agentService.presentation,
      onLifecycleChange: writeCurrentAliveMarker,
      onCreateTempSession: createTempSession,
      onDisbandTempSession: disbandTempSession,
      onCancelAgentRuns: (name, chatId, reason) => agentService.cancelSessionRuns(name, chatId, reason),
    })
    sessionRecovery.transferPending(session)
    return session
  },
  ensureChatForSession: feishu.createTempChatForSession,
  disbandChatForSessionExact: feishu.disbandChatForSessionExact,
  chatIdForSession: feishu.chatIdForSession,
  clearSessionConversationState: feishu.clearSessionConversationState,
  registerTempSessionLease: feishu.registerTempSessionLease,
  hasTempSessionLease: feishu.hasTempSessionLease,
  replaceTurnAnchors: feishu.replaceTurnAnchors,
  runExclusive: (chatId, task) => chatActor.enqueue(chatId, task),
  log,
})

function sessionFor(chatId: string, sessionName: string): Session {
  return tempSessionRuntime.sessionFor(chatId, sessionName)
}

async function createTempSession(opts: CreateTempSessionOptions): Promise<CreateTempSessionResult> {
  return await tempSessionRuntime.createTempSession(opts)
}

async function disbandTempSession(chatName: string, expectedChatId: string): Promise<DisbandTempSessionResult> {
  return await tempSessionRuntime.disbandTempSession(chatName, expectedChatId)
}

// ── Feishu `post` (rich-text) → Markdown ────────────────────────────────
// 飞书客户端发 markdown 时,内容会被编码成 message_type='post' 的二维数组
// AST,不是 'text'。下面把它反向拼回 markdown 字符串(Codex 消化
// markdown 比拍平纯文本更结构化),并把内嵌图片/文件 key 抽出来交给
// `downloadAttachment` 走附件路径,跟原生 image/file 消息对齐。
//
// underline 暂不还原 —— markdown 无原生语法。
interface PostElement {
  tag: string
  text?: string
  href?: string
  style?: string[]
  image_key?: string
  file_key?: string
  file_name?: string
  user_id?: string
  user_name?: string
}
function extractPostMarkdown(
  contentObj: any,
): { markdown: string; imageKeys: string[]; fileKeys: { key: string; name?: string }[] } {
  const imageKeys: string[] = []
  const fileKeys: { key: string; name?: string }[] = []
  const paragraphs: string[] = []
  const title = typeof contentObj?.title === 'string' ? contentObj.title.trim() : ''
  if (title) paragraphs.push(`# ${title}`)
  const blocks: PostElement[][] = Array.isArray(contentObj?.content) ? contentObj.content : []
  for (const para of blocks) {
    if (!Array.isArray(para)) continue
    const parts: string[] = []
    for (const el of para) {
      if (!el || typeof el !== 'object') continue
      switch (el.tag) {
        case 'text': {
          let t = String(el.text ?? '')
          const styles = Array.isArray(el.style) ? el.style : []
          if (styles.includes('bold')) t = `**${t}**`
          if (styles.includes('italic')) t = `*${t}*`
          if (styles.includes('lineThrough') || styles.includes('strikethrough')) t = `~~${t}~~`
          parts.push(t)
          break
        }
        case 'a': {
          const href = String(el.href ?? '')
          const t = String(el.text ?? href)
          parts.push(`[${t}](${href})`)
          break
        }
        case 'at': {
          const name = String(el.user_name ?? el.user_id ?? '')
          parts.push(`@${name}`)
          break
        }
        case 'code_inline':
          parts.push(`\`${String(el.text ?? '')}\``)
          break
        case 'hr':
          parts.push('---')
          break
        case 'img':
          if (el.image_key) imageKeys.push(String(el.image_key))
          break
        case 'media':
          if (el.file_key) fileKeys.push({ key: String(el.file_key), name: el.file_name })
          break
        case 'emotion':
          // 飞书表情没有合适的 markdown 还原,塞 `:key:` 反而像代码引用
          break
        default:
          if (typeof el.text === 'string') parts.push(el.text)
      }
    }
    const line = parts.join('')
    if (line.trim()) paragraphs.push(line)
  }
  return { markdown: paragraphs.join('\n\n'), imageKeys, fileKeys }
}

// ── Inbound message handler ─────────────────────────────────────────────
const STALE_THRESHOLD_MS = 30_000
const seenMessageIds = new Set<string>()
const notifyReplies = createNotifyReplyRuntime({
  sendCard: feishu.sendCard,
  updateCard: feishu.updateCard,
  sendText: feishu.sendText,
  dispatch: dispatchCallback,
  onWaitingChanged: chatId => sessions.get(chatId)?.refreshPendingAsks(),
  log,
})

async function handleMessage(data: any, receivedAt = Date.now()): Promise<void> {
  const message = data?.message
  if (!message) return

  // Feishu's im.message.receive_v1 event puts `sender` at the event
  // root, sibling of `message` — NOT inside `message` (we had this
  // wrong before, which silently emptied userOpenId and skipped every
  // urgent_app push). Try root first, fall back to nested in case the
  // SDK wraps the payload differently.
  const senderId = data?.sender?.sender_id ?? data?.event?.sender?.sender_id ?? message?.sender?.sender_id
  const userOpenId: string = senderId?.open_id ?? ''

  const msgId = message.message_id as string | undefined
  if (msgId && seenMessageIds.has(msgId)) return
  if (msgId) {
    seenMessageIds.add(msgId)
    if (seenMessageIds.size > 200) {
      const arr = [...seenMessageIds]
      seenMessageIds.clear()
      for (const id of arr.slice(-100)) seenMessageIds.add(id)
    }
  }

  // Drop replays of stale messages (Lark redelivers unacked events on reconnect).
  const createTime = Number(message.create_time ?? 0)
  if (isStaleAtReceipt(createTime, receivedAt, STALE_THRESHOLD_MS)) {
    log(`drop stale message ${msgId} ageAtReceipt=${Math.round((receivedAt - createTime) / 1000)}s`)
    if (msgId) void feishu.addReaction(msgId, 'CrossMark')
    return
  }

  const chatId = message.chat_id as string

  // `[DEBUG]` prefix — seed the inject context with the real chat/sender
  // captured from a live WS event, then strip the prefix and continue as
  // normal. The injector script (scripts/test-inject.ts) reads this
  // context to replay arbitrary messages without the user touching Feishu.
  let contentObjForDebug: any = {}
  try { contentObjForDebug = JSON.parse(message.content ?? '{}') } catch {}
  const debugTextRaw = (message.message_type === 'text' ? contentObjForDebug.text ?? '' : '')
  if (typeof debugTextRaw === 'string' && debugTextRaw.startsWith('[DEBUG]')) {
    try {
      writeFileSync(DEBUG_CTX_FILE, JSON.stringify({
        chat_id: chatId,
        sender_open_id: userOpenId,
        seeded_at: new Date().toISOString(),
        seeded_msg_id: msgId ?? '',
      }, null, 2))
      log(`debug: seeded inject context chat=${chatId.slice(0, 8)}… sender=${userOpenId.slice(0, 8)}…`)
    } catch (e) { log(`debug: seed context failed: ${e}`) }
    const stripped = debugTextRaw.slice('[DEBUG]'.length)
    contentObjForDebug.text = stripped
    message.content = JSON.stringify(contentObjForDebug)
  }

  let groupName = feishu.chatNameCache.get(chatId)
  if (!groupName) {
    await feishu.refreshChatList()
    groupName = feishu.chatNameCache.get(chatId)
  }
  if (!groupName) {
    // refreshChatList 走的 im.chat.list 是最终一致的：机器人刚被拉进一个
    // 新群时，群往往要过几秒才出现在列表里，而用户的第一条消息恰恰落在
    // 这个窗口。按 chat_id 直接点查 im.chat.get —— 同一数据源的更精确查询，
    // 拿得到列表还没刷出来的新群名，新群第一条消息就能接住。
    groupName = (await feishu.fetchChatName(chatId)) ?? undefined
  }
  if (!groupName) {
    log(`unknown chat ${chatId}, dropping message`)
    await feishu.sendText(chatId, '❌ 无法识别群名。请确认：① 机器人已被拉进本群；② 群已设置名称（未命名群拿不到群名，无法映射项目目录）。设置后再发一条消息即可。')
    return
  }
  const sessionName = feishu.sanitizeSessionName(groupName)
  feishu.bindSessionToChat(sessionName, chatId)
  const session = sessionFor(chatId, sessionName)

  let contentObj: any = {}
  try { contentObj = JSON.parse(message.content ?? '{}') } catch {}
  const msgType = message.message_type as string
  let text = ''
  let postHasAttachments = false
  const filePaths: string[] = []
  if (msgType === 'text') {
    text = (contentObj.text ?? '').trim()
  } else if (msgType === 'post') {
    // 飞书客户端 markdown 走 'post' 富文本通道,不是 'text'。反向拼回
    // markdown 给 Codex,内嵌图片/文件 key 走跟原生 image/file 一样的
    // downloadAttachment 路径。
    const post = extractPostMarkdown(contentObj)
    postHasAttachments = post.imageKeys.length > 0 || post.fileKeys.length > 0
    text = post.markdown.trim()
    for (const key of post.imageKeys) {
      const p = await feishu.downloadAttachment(message.message_id, key, 'image')
      if (p) filePaths.push(p)
    }
    for (const f of post.fileKeys) {
      const p = await feishu.downloadAttachment(message.message_id, f.key, 'file', f.name)
      if (p) filePaths.push(p)
    }
  }

  // Text-only control commands — intercept before any work that would
  // forward to Codex (download / spawn / interrupt). Bare words are
  // reserved globally by user request; `wt [name]` is also intercepted
  // for project worktree/group orchestration. Post 富文本整段不可能正好
  // 等于这些 bare word,所以这里只对 text 触发。
  if (msgType === 'text' && text) {
    if (await session.runCommand(text, userOpenId, msgId)) return
  }

  // Pending text is consumed once: notification reply → Agent question.
  // Only then can it reach model-entry or ordinary Agent input below.
  if ((msgType === 'text' || msgType === 'post') && text && !postHasAttachments
    && await consumePendingTextInput({
      reply: () => notifyReplies.consume({
        chatId, openId: userOpenId, messageId: msgId ?? '', text, createTime,
        parentId: message.parent_id,
      }),
      hasQuestion: () => session.hasPendingAsk(),
      answerQuestion: () => session.onAskMessageAnswer(text, userOpenId, msgId ?? ''),
    })) return

  // 补录应答态:点「➕ 补录模型」后的下一条文本作为模型名消费(裸词命令
  // 已在上面优先分流)。同 AskUserQuestion 的消息应答语义。
  if (msgType === 'text' && text && await session.consumeModelCustomMessage(text, userOpenId)) {
    return
  }

  const resource = inboundMessageResource(msgType, contentObj)
  if (resource) {
    const p = await feishu.downloadAttachment(
      message.message_id,
      resource.key,
      resource.type,
      resource.name,
    )
    if (!p) {
      await feishu.sendText(chatId, inboundResourceDownloadFailureText(msgType))
      return
    }
    filePaths.push(p)
    if (!text && resource.displayText) text = resource.displayText
  }

  if (!text && filePaths.length === 0) {
    // Post 已经走 markdown 解码;还落到空,要么是不支持的 message_type
    // (sticker / share_chat / audio / ...),要么是 post 里只剩 emotion /
    // 未知 tag。留 log 防再有"静默 1.5h"那种 case 没法回溯。
    log(`drop empty message ${msgId} type=${msgType}`)
    return
  }
  // 多条消息缓冲:>>> 开始收集 / <<< 收尾合并。返回 true = 已缓冲或已合并,
  // 不再往下走 onUserMessage。裸词控制命令已在上面 runCommand 先于本拦截。
  if (await session.onMultiMessageInbound(text, filePaths, userOpenId, msgId ?? '')) return
  await session.onUserMessage(text || '(empty)', filePaths, userOpenId, msgId ?? '')
}

// ── Card action handler ────────────────────────────────────────────────
function cardActionLabel(kind: string): string {
  const labels: Record<string, string> = {
    permission: '权限决定', menu: '菜单选择', provider_select: '账号选择', model_page: '模型翻页',
    model_list_open: '模型列表', model_add: '显示模型', model_remove: '隐藏模型', model_custom_remove: '删除补录模型',
    model_select: '模型选择', model_custom_prompt: '模型补录',
    model_panel_cancel: '取消模型补录', model_effort_select: '模型 effort 选择',
    ask: '问题回答', worktree_disband: 'worktree 解散', temp_fork_select: '会话分叉',
    temp_back_select: '会话回滚', temp_resume_select: '会话恢复',
    tasklist_enable: '启用任务清单', tasklist_delete_prompt: '删除任务清单',
    tasklist_delete_confirm: '确认删除任务清单', token_source_enable: '启用账号',
    agent_identity_page: 'Agent 身份翻页',
    notify_callback: '通知反馈', notify_reply: '通知回复', notify_reply_cancel: '取消通知回复',
  }
  return labels[kind] ?? kind
}

function rawCardFromActionResult(result: any): object | null {
  return result?.card?.type === 'raw' && result.card.data && typeof result.card.data === 'object'
    ? result.card.data
    : null
}

/** Internal-only metadata consumed by CardActionAdmission. The wrapper is
 * never returned as the callback ACK, and presentation ignores this field. */
function withBusinessOutcome(response: any, ok: boolean, message?: string): any {
  return {
    ...response,
    __businessOk: ok,
    ...(message ? { __businessMessage: message } : {}),
  }
}

function withNotifyContext(reg: NotifyRegistration, response: any): any {
  return {
    ...response,
    __cardActionMessageId: reg.messageId,
    __cardActionChatId: reg.chatId,
  }
}

function modelActionResponse(result: ModelActionResult): any {
  const response = withBusinessOutcome(
    result.card
      ? actionCardResponse(result.card)
      : { toast: { type: result.ok ? 'success' : 'error', content: result.message } },
    result.ok,
    result.pending ? undefined : result.message,
  )
  if (result.completion) response.__modelActionCompletion = result.completion
  return response
}

async function sendActionReceipt(chatId: string, text: string): Promise<void> {
  if (!chatId) {
    log(`card-action: cannot send receipt without chat_id: ${text}`)
    return
  }
  const sent = await feishu.sendTextRaw(chatId, text)
  if (!sent) log(`card-action: visible receipt MISS chat=${chatId.slice(0, 8)}… text=${text.slice(0, 120)}`)
}

async function publishCardActionResult(data: any, result: any): Promise<void> {
  if (result?.__cardActionPresented) return
  const kind = String(data?.action?.value?.kind ?? 'unknown')
  const label = cardActionLabel(kind)
  const chatId = String(
    result?.__cardActionChatId
    ?? data?.__cardActionChatId
    ?? data?.context?.open_chat_id
    ?? '',
  )
  // Notify registrations already persist the authoritative message id and may
  // be clicked through callback payloads that omit open_message_id. Ordinary
  // session actions are admission-validated and use the context id.
  const messageId = String(result?.__cardActionMessageId ?? data?.context?.open_message_id ?? '')
  const card = rawCardFromActionResult(result)
  const businessFailure = result?.__businessOk === false && typeof result?.__businessMessage === 'string'
    ? ` 业务失败: ${result.__businessMessage.replace(/\s+/g, ' ').trim().slice(0, 300)}。`
    : ''
  if (card && messageId) {
    try {
      await feishu.updateCard(messageId, card)
      return
    } catch (e) {
      log(`card-action: ${kind} original-card update failed: ${e instanceof Error ? e.message : e}`)
      const recovery = kind === 'temp_resume_select'
        ? '请发送 rs 查看当前状态。'
        : '请重新打开操作面板。'
      await sendActionReceipt(chatId, `⚠️ ${label}已处理，但原卡更新失败。${businessFailure}${recovery}`)
      return
    }
  }
  if (card) {
    const recovery = kind === 'temp_resume_select' ? '请发送 rs 查看当前状态。' : ''
    await sendActionReceipt(chatId, `⚠️ ${label}已处理，但回调缺少原卡 message_id，无法更新。${businessFailure}${recovery}`)
    return
  }
  // Push-mode notify callbacks own their two-phase visible card update. Other
  // notify outcomes (missing/expired registration, unknown button, persisted
  // unknown state) still need a post-ACK receipt through the generic path.
  if (kind === 'notify_callback' && result?.__cardActionCompletion) return
  const toast = result?.toast
  const content = typeof toast?.content === 'string' && toast.content.trim()
    ? toast.content.trim()
    : `${label}已完成`
  const permissionDenied = kind === 'permission' && String(data?.action?.value?.decision ?? '') === 'deny'
  const failed = result?.__businessOk === false || (toast?.type === 'error' && !permissionDenied)
  const selfVisibleSuccess = new Set([
    'permission', 'ask', 'token_source_enable',
  ])
  if (!failed && selfVisibleSuccess.has(kind)) return
  await sendActionReceipt(chatId, `${failed ? '❌' : '✅'} ${label}: ${content}`)
}

async function publishCardActionFailure(data: any, error: unknown): Promise<void> {
  const kind = String(data?.action?.value?.kind ?? 'unknown')
  const detail = error instanceof Error ? error.message : String(error)
  await sendActionReceipt(
    String(data?.__cardActionChatId ?? data?.context?.open_chat_id ?? ''),
    `❌ ${cardActionLabel(kind)}失败: ${detail}`,
  )
}

const cardActionAdmission = createCardActionAdmission<any, object>({
  actor: chatActor,
  deduper: cardActionDeduper,
  scope: data => {
    const kind = String(data?.action?.value?.kind ?? '')
    if (kind.startsWith('agent_identity_')) return '__agent_identities_global__'
    if (kind === 'notify_callback' || kind === 'notify_reply' || kind === 'notify_reply_cancel') {
      const reg = getNotifyCallback(String(data?.action?.value?.notify_id ?? ''))
      if (reg) return reg.chatId
    }
    return String(data?.context?.open_chat_id ?? '') || '__notify_global__'
  },
  execute: data => {
    if (shutdownRequested) sessions.get(String(data?.context?.open_chat_id ?? ''))?.closeModelSettingsChanges()
    return handleCardAction(data)
  },
  present: publishCardActionResult,
  presentExecutionFailure: async (data, error) => {
    const kind = String(data?.action?.value?.kind ?? 'unknown')
    log(`handleCardAction ${kind}: ${error instanceof Error ? error.stack ?? error.message : error}`)
    await publishCardActionFailure(data, error)
  },
  presentPresentationFailure: async (data, error) => {
    const kind = String(data?.action?.value?.kind ?? 'unknown')
    log(`card-action presentation ${kind}: ${error instanceof Error ? error.message : error}`)
    await sendActionReceipt(
      String(data?.context?.open_chat_id ?? ''),
      `⚠️ ${cardActionLabel(kind)}已执行，但结果呈现失败。`,
    )
  },
  businessSucceeded: (data, result) => {
    if (typeof result?.__businessOk === 'boolean') return result.__businessOk
    const permissionDenied = data?.action?.value?.kind === 'permission'
      && data?.action?.value?.decision === 'deny'
    return permissionDenied || result?.toast?.type !== 'error'
  },
  completion: (data, result) => {
    const modelCompletion: Promise<ModelActionResult> | undefined = result?.__modelActionCompletion
    if (modelCompletion) {
      // Start presentation only after the pending card has landed. The actor
      // is released while the backend works, so stop/questions stay usable.
      return modelActionCompletion(modelCompletion,
        final => publishCardActionResult(data, modelActionResponse(final)))
    }
    const completion = result?.__cardActionCompletion
    return completion && typeof completion.then === 'function' ? completion : null
  },
  track: work => { trackCardActionWork(work) },
  onBackgroundError: error => {
    log(`card-action background: ${error instanceof Error ? error.stack ?? error.message : error}`)
  },
  responses: {
    accepted: data => ({
      toast: {
        type: 'info',
        content: `⏳ ${cardActionLabel(String(data?.action?.value?.kind ?? 'unknown'))}已接收，后台处理中…`,
      },
    }),
    inflight: () => ({ toast: { type: 'info', content: '相同操作正在处理…' } }),
    completed: () => ({
      toast: {
        type: 'info',
        content: '该操作近期已执行或尝试；为防重复暂不再次执行，请查看原卡或群消息',
      },
    }),
    closed: () => ({ toast: { type: 'error', content: '服务正在重启，请稍后重试' } }),
    invalid: (_data, message) => ({ toast: { type: 'error', content: message } }),
  },
})

function acceptCardAction(data: any): object {
  return cardActionAdmission.accept(data)
}

async function handleCardAction(data: any): Promise<any> {
  const action = data?.action
  const value = action?.value
  if (!value?.kind) return
  const chatId = data?.context?.open_chat_id ?? ''
  const userId = data?.operator?.open_id ?? ''

  // Interactive /notify cards must route even when no Session exists for
  // this chat — a notify push doesn't start a session, and the click's
  // job is to ping the local caller, not drive a turn. Short-circuit
  // before the session guard below.
  if (value.kind === 'notify_callback' || value.kind === 'notify_reply' || value.kind === 'notify_reply_cancel') {
    const notifyId = String(value.notify_id ?? '')
    const reg = getNotifyCallback(notifyId)
    if (reg) data.__cardActionChatId = reg.chatId
    if (value.kind === 'notify_callback') return await handleNotifyCallback(value, chatId, userId)
    const result = value.kind === 'notify_reply'
      ? await notifyReplies.open(notifyId, chatId, userId)
      : await notifyReplies.cancel(notifyId, String(value.reply_id ?? ''), chatId, userId)
    const response = withBusinessOutcome({
      toast: { type: result.ok ? 'success' : 'error', content: result.message },
      __cardActionPresented: result.presented === true,
    }, result.ok)
    return reg ? withNotifyContext(reg, response) : response
  }

  const session = sessions.get(chatId)
  if (!session) {
    return withBusinessOutcome(
      { toast: { type: 'error', content: '会话不存在，请先发消息启动' } },
      false,
    )
  }

  switch (value.kind) {
    case 'permission': {
      const decision = String(value.decision ?? '')
      if (!['allow', 'allow_always', 'deny'].includes(decision)) {
        return { toast: { type: 'error', content: '无效的权限决定' } }
      }
      const result = await session.onPermissionDecision(
        value.request_id,
        decision as 'allow' | 'allow_always' | 'deny',
        userId,
      )
      return withBusinessOutcome(
        {
          toast: {
            type: result.ok ? (decision === 'deny' ? 'error' : 'success') : 'error',
            content: result.message,
          },
        },
        result.ok,
      )
    }
    case 'menu': {
      const choice = Number(value.choice ?? -1)
      try {
        if (!Number.isInteger(choice) || choice < 0) throw new Error('无效的菜单选项')
        await session.onUserMessage(`(menu choice ${choice + 1})`)
        return withBusinessOutcome(actionCardResponse(cards.selectionResultCard({
          title: '📋 菜单选择',
          message: `已选择第 ${choice + 1} 项`,
          ok: true,
        })), true)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return withBusinessOutcome(actionCardResponse(cards.selectionResultCard({
          title: '📋 菜单选择', message, ok: false,
        })), false)
      }
    }
    case 'provider_select': {
      const result = await session.onProviderSelect(String(value.source_id ?? ''), String(value.panel_id ?? ''))
      return modelActionResponse(result)
    }
    case 'model_page': {
      const result = await session.onModelPage(String(value.panel_id ?? ''), String(value.source_id ?? ''), Number(value.page))
      return modelActionResponse(result)
    }
    case 'model_list_open': {
      const panel = String(value.panel_id ?? '')
      const source = String(value.source_id ?? '')
      if (value.mode !== 'add' && value.mode !== 'select') throw new Error('模型管理模式无效')
      return modelActionResponse(await (value.mode === 'add'
        ? session.onModelAddOpen(panel, source) : session.onProviderSelect(source, panel)))
    }
    case 'model_add':
    case 'model_remove':
    case 'model_custom_remove': {
      return modelActionResponse(await session.onModelListEdit(String(value.panel_id ?? ''), String(value.source_id ?? ''),
        String(value.model ?? ''), value.kind === 'model_add' ? 'add' : value.kind === 'model_remove' ? 'remove' : 'delete'))
    }
    case 'model_select': {
      const result = await session.onModelSelect(String(value.model ?? ''), String(value.panel_id ?? ''), userId, value)
      return modelActionResponse(result)
    }
    case 'model_custom_prompt': {
      // context.open_message_id = 补录卡所在消息;等待态记住它,回复后原位更新。
      const result = await session.onModelCustomPrompt(
        String(value.source_id ?? ''),
        String(value.panel_id ?? ''),
        String(data?.context?.open_message_id ?? ''),
      )
      return modelActionResponse(result)
    }
    case 'model_panel_cancel': {
      const result = await session.onModelPanelCancel(String(value.panel_id ?? ''))
      return modelActionResponse(result)
    }
    case 'model_effort_select': {
      const result = await session.onModelEffortSelect(
        String(value.model ?? ''),
        String(value.effort ?? ''),
        String(value.panel_id ?? ''),
        userId,
        String(value.provider ?? ''),
      )
      return modelActionResponse(result)
    }
    case 'ask': {
      const blocked = session.askBlockReason(String(value.tool_use_id ?? ''))
      if (blocked) return withBusinessOutcome({ toast: { type: 'error', content: blocked } }, false)
      // Custom-text branch: form submit packages the input under
      // `form_value`. Try a couple of plausible keys since the exact
      // shape can drift between Feishu schema versions; fall back to
      // empty (onAskCustomAnswer ignores blank).
      if (value.custom) {
        const fv = action?.form_value ?? action?.input ?? {}
        const customText: string = fv?.custom_answer ?? action?.input_value ?? ''
        const answered = await session.onAskCustomAnswer(value.tool_use_id, value.question_idx ?? 0, customText, userId)
        return withBusinessOutcome(
          { toast: { type: answered ? 'success' : 'error', content: answered ? '已回答' : customText.trim() ? '问题已失效或答案未被接受' : '请输入答案' } },
          answered,
        )
      }
      const answered = await session.onAskAnswer(value.tool_use_id, value.question_idx ?? 0, value.option_idx, userId)
      return withBusinessOutcome(
        { toast: { type: answered ? 'success' : 'error', content: answered ? '已回答' : '问题已失效或选项无效' } },
        answered,
      )
    }
    case 'worktree_disband': {
      const result = await session.onWorktreeDisband(String(value.slug ?? ''))
      return withBusinessOutcome(actionCardResponse(result.card), result.ok)
    }
    case 'temp_fork_select': {
      const result = await session.onForkSelect(String(value.panel_id ?? ''), String(value.choice_id ?? ''), userId)
      return withBusinessOutcome(result.replaceCard === false
        ? { toast: { type: 'error', content: result.message } }
        : actionCardResponse(cards.selectionResultCard({ title: '🔱 会话分叉', message: result.message, ok: result.ok })), result.ok)
    }
    case 'temp_back_select': {
      const result = await session.onBackSelect(String(value.panel_id ?? ''), String(value.choice_id ?? ''), userId)
      return withBusinessOutcome(result.replaceCard === false
        ? { toast: { type: 'error', content: result.message } }
        : actionCardResponse(cards.selectionResultCard({ title: '⏪ 会话回滚', message: result.message, ok: result.ok })), result.ok)
    }
    case 'temp_resume_select': {
      const result = await session.onResumeSelect(String(value.panel_id ?? ''), String(value.choice_id ?? ''), userId)
      if (result.replaceCard === false) {
        return withBusinessOutcome({ toast: { type: 'error', content: result.message } }, result.ok)
      }
      if (!result.resumePresentation) {
        throw new Error('rs selection result missing trusted presentation snapshot')
      }
      return withBusinessOutcome(actionCardResponse(cards.resumeSelectionResultCard({
        ...result.resumePresentation,
        message: result.message,
        ok: result.ok,
      })), result.ok, result.message)
    }
    case 'tasklist_enable': {
      const result = await session.onTasklistEnable()
      return withBusinessOutcome(actionCardResponse(result.card), result.ok)
    }
    case 'tasklist_delete_prompt': {
      const result = session.onTasklistDeletePrompt(String(value.guid ?? ''))
      return withBusinessOutcome(actionCardResponse(result.card), result.ok)
    }
    case 'tasklist_delete_confirm': {
      const result = await session.onTasklistDeleteConfirm(String(value.guid ?? ''))
      return withBusinessOutcome(actionCardResponse(result.card), result.ok)
    }
    case 'token_source_enable': {
      const { onTokenSourceEnable } = await import('./src/token-source-setup')
      await onTokenSourceEnable(session, String(value.source_id ?? ''))
      return { toast: { type: 'info', content: '已处理' } }
    }
    case 'agent_identity_page': {
      return modelActionResponse(session.onAgentIdentityPage(
        String(value.panel_id ?? ''), value.page, userId,
      ))
    }
  }
  return { toast: { type: 'info', content: 'unknown action' } }
}

// ── Interactive /notify button callback ───────────────────────────────
// A group member tapped a button on a /notify card. Two visual phases
// (push mode), both rendered via message.patch on the original card:
//
//   ACK: a toast ("⏳ 已选择:X · 推送中…") returned instantly. Deliberately
//     NOT an inline card ACK, and NOT the callback-token endpoint:
//       • Method 1 (inline card ACK) + a follow-up update silently fails
//         to re-render.
//       • The callback-token endpoint `/interactive/v1/card/update` is a
//         legacy path that returns code=0 for our schema-2.0 card but
//         draws it BLANK (verified live, 2026-07-05).
//     So both card states go through message.patch AFTER the toast ACK.
//     The AGENTS.md footgun ("don't message.patch around a click") is
//     specifically BEFORE-ACK — the patch races the ACK response. After
//     a toast ACK (no card in the response) there's nothing to race.
//
//   Phase 1: message.patch → "⏳ 已选择:X · 推送中…", fired immediately so
//     the push's ~2.5s in-flight window shows progress.
//   Phase 2: message.patch → "✅ 反馈已送达" / "⚠️ 回调失败:…" once the
//     loopback push resolves.
//
// Pull / display-only mode (no callback) freezes on the verdict in a
// single inline step (no push to wait for). Every failure is surfaced
// on the card or toast — no silent swallow.
async function handleNotifyCallback(value: any, _chatId: string, userId: string): Promise<any> {
  const notifyId = String(value?.notify_id ?? '')
  const buttonId = String(value?.button_id ?? '')
  if (!notifyId) return { toast: { type: 'error', content: '回调缺少 notify_id' } }

  const reg = getNotifyCallback(notifyId)
  if (!reg) {
    log(`notify-callback: notify_id=${notifyId.slice(0, 12)}… not found (expired or pre-restart)`)
    return { toast: { type: 'error', content: '通知已过期或已移除' } }
  }
  if (reg.unknownAt) {
    return withNotifyContext(reg, withBusinessOutcome({
      toast: {
        type: 'error',
        content: `外部回调可能已成功，但本地确认状态未知，已禁止自动重试${reg.unknownReason ? `: ${reg.unknownReason}` : ''}`,
      },
    }, true))
  }
  // Idempotency: a finalized card refuses re-fire ("已处理过"); an
  // in-flight Phase-2 refuses concurrent double-click ("处理中"). Both
  // prevent two members / a double-click from firing the push twice.
  if (reg.resolvedAt) {
    return withNotifyContext(reg, { toast: { type: 'info', content: '已处理过' } })
  }
  if (isDispatching(notifyId)) {
    return withNotifyContext(reg, { toast: { type: 'info', content: '处理中…' } })
  }
  if (reg.replyState?.status === 'waiting' || reg.replyState?.status === 'sending') {
    return withNotifyContext(reg, withBusinessOutcome({
      toast: { type: 'error', content: '正在等待文字回复，请先发送或取消回复，再选择按钮' },
    }, false))
  }
  const button = reg.buttons.find((b) => b.id === buttonId)
  if (!button) {
    log(`notify-callback: notify_id=${notifyId.slice(0, 12)}… unknown button_id="${buttonId}"`)
    return withNotifyContext(reg, withBusinessOutcome(
      { toast: { type: 'error', content: '未知按钮' } },
      false,
    ))
  }

  // Pull / display-only mode: no push to wait for — freeze on the
  // verdict now (single phase).
  if (!reg.callbackUrl) {
    try {
      markNotifyCallbackResolved(reg.notifyId, button.id, userId)
    } catch (e) {
      return withNotifyContext(reg, withBusinessOutcome({
        toast: { type: 'error', content: `保存反馈结果失败: ${e instanceof Error ? e.message : e}` },
      }, false))
    }
    log(`notify-callback: notify_id=${notifyId.slice(0, 12)}… resolved button="${buttonId}" by=${userId.slice(0, 8)}… (no callback, pull/display)`)
    return withNotifyContext(reg, {
      ...actionCardResponse(
        buildNotifyCardFromReg(reg, { status: 'done', buttonId: button.id, text: button.text, operatorOpenId: userId }),
      ),
    })
  }

  // Push mode: ACK with a toast immediately, then async drive BOTH card
  // states via message.patch on the original card (Phase 1 processing →
  // push → Phase 2 final). The dispatching guard is set synchronously
  // here so a fast second click is blocked before the async work starts.
  try {
    beginCallbackDispatch(reg.notifyId, button.id, userId)
  } catch (error) {
    return withNotifyContext(reg, withBusinessOutcome({
      toast: { type: 'error', content: `保存回调发送状态失败，未发送: ${error instanceof Error ? error.message : error}` },
    }, false))
  }
  setDispatching(reg.notifyId)
  const phase2 = trackCardActionWork(pushNotifyCallbackPhase2(reg, button, userId))
  void phase2.catch(e => {
    log(`notify-callback: notify_id=${reg.notifyId.slice(0, 12)}… phase-2 rejected: ${e instanceof Error ? e.message : e}`)
  })
  const completion = phase2.then<'complete' | 'retry'>(outcome =>
    outcome === 'retry' ? 'retry' : 'complete'
  ).catch(() => 'retry' as const)
  return withNotifyContext(reg, {
    toast: { type: 'info', content: `⏳ 已选择:${button.text} · 推送中…` },
    __cardActionCompletion: completion,
  })
}

// Drive the two card states via message.patch, fire-and-forget from
// {@link handleNotifyCallback} so the ACK toasts fast. Phase 1
// (processing) must precede the push so the in-flight window shows
// progress; Phase 2 (delivered/failed) lands once the push resolves.
// On push failure resolvedAt is NOT set (the dispatching guard is
// cleared) so the user can tap again to retry.
async function pushNotifyCallbackPhase2(
  reg: NotifyRegistration,
  button: NotifyButton,
  userId: string,
): Promise<'complete' | 'retry' | 'unknown'> {
  try {
    // Phase 1: processing card via message.patch (after the toast ACK).
    const processingCard = buildNotifyCardFromReg(reg, {
      status: 'processing', buttonId: button.id, text: button.text, operatorOpenId: userId,
    })
    try {
      await feishu.updateCard(reg.messageId, processingCard)
    } catch (e) {
      log(`notify-callback: notify_id=${reg.notifyId.slice(0, 12)}… phase-1 (processing) updateCard failed: ${e instanceof Error ? e.message : e}`)
    }

    // Push + Phase 2 final card.
    const result = await dispatchCallback(reg, button, userId)
    let outcome: 'complete' | 'retry' | 'unknown' = result.ok ? 'complete' : 'retry'
    let resolution: Parameters<typeof buildNotifyCardFromReg>[1]
    if (result.ok) {
      // The external side effect has already happened. A local persistence
      // failure is therefore UNKNOWN, never retryable. recordCallbackSuccess
      // attempts to persist that unknown tombstone and retains an in-memory
      // guard even when the store itself remains unavailable.
      const recorded = recordCallbackSuccess(reg.notifyId, button.id, userId)
      if (recorded.state === 'complete') {
        resolution = {
          status: 'delivered', buttonId: button.id, text: button.text,
          operatorOpenId: userId, reply: result.reply,
        }
      } else {
        outcome = 'unknown'
        resolution = {
          status: 'unknown', buttonId: button.id, text: button.text,
          operatorOpenId: userId, detail: recorded.detail,
        }
        log(`notify-callback: notify_id=${reg.notifyId.slice(0, 12)}… callback succeeded but tombstone is UNKNOWN: ${recorded.detail}`)
        try {
          await sendActionReceipt(
            reg.chatId,
            `⚠️ 通知反馈的外部回调已成功，但本地确认状态未知；为避免重复副作用，已禁止自动重试。${recorded.detail}`,
          )
        } catch (e) {
          // Presentation failure after an external success must never turn the
          // business outcome back into retry.
          log(`notify-callback: notify_id=${reg.notifyId.slice(0, 12)}… UNKNOWN warning receipt failed: ${e instanceof Error ? e.message : e}`)
        }
      }
    } else {
      const recorded = recordCallbackFailure(reg.notifyId)
      outcome = recorded.state
      resolution = {
        status: recorded.state === 'retry' ? 'failed' : 'unknown', buttonId: button.id, text: button.text,
        operatorOpenId: userId, detail: recorded.state === 'retry' ? result.detail : `${result.detail}; ${recorded.detail}`,
      }
    }

    try {
      const finalCard = buildNotifyCardFromReg(reg, resolution)
      await feishu.updateCard(reg.messageId, finalCard)
    } catch (e) {
      log(`notify-callback: notify_id=${reg.notifyId.slice(0, 12)}… phase-2 (final) presentation failed: ${e instanceof Error ? e.message : e}`)
      try {
        await sendActionReceipt(
          reg.chatId,
          `⚠️ 通知反馈${outcome === 'retry' ? '失败且结果卡更新失败，可重新点击' : outcome === 'unknown' ? '送达状态未知且结果卡更新失败，禁止自动重试' : '已执行，但结果卡更新失败'}: ${e instanceof Error ? e.message : e}`,
        )
      } catch (receiptError) {
        log(`notify-callback: notify_id=${reg.notifyId.slice(0, 12)}… final fallback receipt failed: ${receiptError instanceof Error ? receiptError.message : receiptError}`)
      }
    }
    log(`notify-callback: notify_id=${reg.notifyId.slice(0, 12)}… button="${button.id}" ${outcome === 'complete' ? 'delivered' : outcome === 'unknown' ? 'unknown/non-retryable' : `failed: ${result.detail}`} by=${userId.slice(0, 8)}…`)
    return outcome
  } finally {
    clearDispatching(reg.notifyId)
  }
}

// ── WebSocket boot ─────────────────────────────────────────────────────
function fmt(m: any[]): string {
  return m.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')
}

// ── Debug message injection ─────────────────────────────────────────────
// Listens on a unix socket so scripts/test-inject.ts can replay messages
// through the same `handleMessage` path that real WS events take. Seeded
// by a one-time `[DEBUG]<anything>` from the real Feishu user; from then
// on the injector reuses that chat_id + sender_open_id.
function startDebugSocket(): void {
  if (process.platform === 'win32') {
    // Bun.serve({unix:...}) 在 Windows 上不支持,且 debug 注入是
    // dev-only 路径(scripts/test-inject.ts 用的),end user 不需要。
    // 想在 Windows 上 spike 这个,换成 loopback HTTP 即可。
    log('debug: inject socket skipped on Windows (dev-only feature)')
    return
  }
  if (typeof Bun === 'undefined') {
    // 走 npm 发布出去给 end user 时跑的是 node,Bun.serve 不在。
    // debug 注入纯 dev-only(scripts/test-inject.ts 才用),production
    // 直接跳过即可 —— 既不报错也不引入 node:http 的 socket-path 端口
    // 适配工作量。本机 `bun daemon.ts` 因为 Bun 是 defined 的,这条
    // 分支不进。
    log('debug: inject socket skipped (Bun runtime only — npm/Node build does not include it)')
    return
  }
  try { if (existsSync(DEBUG_SOCK_FILE)) unlinkSync(DEBUG_SOCK_FILE) } catch {}
  try {
    Bun.serve({
      unix: DEBUG_SOCK_FILE,
      fetch: async (req: Request) => {
        const url = new URL(req.url)
        const readModelState = req.method === 'GET' && url.pathname === '/model-state'
        if (req.method !== 'POST' && !readModelState) return new Response('unsupported debug method', { status: 405 })
        if (shutdownRequested) return new Response('daemon shutdown in progress', { status: 503 })
        let body: any = {}
        if (req.method === 'POST') {
          try { body = await req.json() } catch { return new Response('bad json', { status: 400 }) }
        }
        if (!existsSync(DEBUG_CTX_FILE)) {
          return new Response('no debug context yet — send `[DEBUG]hi` from Feishu first', { status: 412 })
        }
        let ctx: any = {}
        try { ctx = JSON.parse(readFileSync(DEBUG_CTX_FILE, 'utf8')) } catch (e) {
          return new Response(`ctx read failed: ${e}`, { status: 500 })
        }
        const target = readModelState ? url.searchParams.get('chat_id') : body.chat_id
        if ((target !== undefined && target !== ctx.chat_id) || (url.pathname !== '/' && !target)) {
          return new Response('explicit debug chat_id must match the seeded context', { status: 409 })
        }
        if (readModelState) {
          const session = sessions.get(ctx.chat_id)
          return session ? Response.json(debugModelState(session)) : new Response('send md to open a model panel first', { status: 404 })
        }
        if (url.pathname === '/model-action') {
          const session = sessions.get(ctx.chat_id)
          if (!session) return new Response('debug session not found', { status: 404 })
          try {
            if (typeof body.message_id !== 'string' || !body.message_id.startsWith('om_')) throw new Error('message_id required')
            const panelId = typeof body.value?.panel_id === 'string' ? body.value.panel_id.trim() : ''
            const panel = session.modelPanels.get(panelId)
            if (!panel?.messageId || panel.messageId !== body.message_id) throw new Error('stale or mismatched model panel')
            const response = await feishu.client.im.v1.message.get({ path: { message_id: body.message_id } })
            if (response.code !== 0) throw new Error(`message.get failed: ${formatFeishuError(response)}`)
            const event = debugModelActionEvent(body, ctx, response.data?.items?.[0], config.feishu.app_id, panel.messageId)
            log(`debug: model action ${body.value.kind} chat=${ctx.chat_id.slice(0, 8)}…`)
            const admission = acceptCardAction(event)
            // 排到相同群的 actor 尾部，等待正常业务处理与卡片呈现完成。
            await chatActor.enqueue(ctx.chat_id, async () => {})
            return Response.json({ admission, state: debugModelState(session) })
          } catch (error) {
            return new Response(error instanceof Error ? error.message : String(error), { status: 400 })
          }
        }
        if (url.pathname !== '/') return new Response('unknown debug endpoint', { status: 404 })
        const text: string = String(body.text ?? '')
        if (!text) return new Response('text required', { status: 400 })
        // 把 inject 内容**真发到目标群**,带"【自动化测试】"前缀让群成员
        // 一眼能区分。拿飞书返回的真 message_id 再构造 event 灌
        // handleMessage:
        //   - msg_id 是真的 → 后续 addReaction / 其它 outbound 不再因
        //     `om_DEBUG_*` 合成 id 报 99992354 污染飞书侧错误日志。
        //   - daemon 看到的 content.text 是**原始 text**(不含前缀),
        //     Codex 那头不会被"【自动化测试】"标签干扰。
        //   - bot 自己发的消息默认不通过 receive_v1 回环(飞书协议层防
        //     死循环),daemon 只通过这条 inject 路径看到一份消息,不会
        //     重复触发 handleMessage。
        const flaggedText = `【自动化测试】:${text}`
        const realMsgId = await feishu.sendText(ctx.chat_id, flaggedText)
        if (!realMsgId) {
          return new Response('sendText failed — see daemon log', { status: 502 })
        }
        const payload = {
          sender: { sender_id: { open_id: ctx.sender_open_id } },
          message: {
            message_id: realMsgId,
            chat_id: ctx.chat_id,
            message_type: 'text',
            content: JSON.stringify({ text }),
            create_time: String(Date.now()),
          },
        }
        log(`debug: inject text=${JSON.stringify(text).slice(0, 80)} msg_id=${realMsgId}`)
        // Don't await — match real WS dispatcher behavior (fire-and-forget per event).
        if (!enqueueMessage(payload, 'debug')) {
          return new Response('daemon shutdown in progress', { status: 503 })
        }
        if (body.wait_for_handling === true) await chatActor.enqueue(ctx.chat_id, async () => {})
        return new Response(JSON.stringify({ ok: true, msg_id: realMsgId }), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    try { chmodSync(DEBUG_SOCK_FILE, 0o600) } catch {}
    log(`debug: inject socket listening at ${DEBUG_SOCK_FILE}`)
  } catch (e) {
    log(`debug: socket bind failed: ${e}`)
  }
}

async function boot(): Promise<void> {
  log(`lodestar-daemon: pid ${process.pid} starting`)
  sessionRecovery.load()
  // token source registry 先于 session 构建填充:session 构造会查 registry 推导 tokenSourceId。
  // config.toml [token_source.*] 在此落地为可用的 TokenSource。
  const { buildTokenSourcesFromConfig } = await import('./src/token-source-builtins')
  if (shutdownRequested) return
  buildTokenSourcesFromConfig()
  // 先完成模型目录加载，再接受群消息和恢复会话。空的加载中目录不能用于
  // 判断已保存的模型是否存在；刷新失败由对应 source 保留明确错误。
  const { refreshAllTokenSourceModels, listTokenSourceAccounts } = await import('./src/token-source')
  if (shutdownRequested) return
  await refreshAllTokenSourceModels()
  await Promise.allSettled(listTokenSourceAccounts().map(refreshTokenSourceUsage))
  if (shutdownRequested) return
  startBackgroundRefresh()
  feishu.loadTempSessionLeases()
  feishu.loadSessionChatMap()
  feishu.loadSessionResumeMap()
  feishu.loadSessionTurnsMap()
  feishu.loadSessionModelMap()
  await feishu.refreshChatList()
  if (shutdownRequested) return
  // 群名解析靠 chatNameCache,但新群/改名走 fetchChatName 点查,不依赖这里全量刷。
  // 5min 全量 chat.list 是纯空转(IM API 计入免费版配额),拉长到 30min 足够保持缓存新鲜。
  setInterval(() => { void feishu.refreshChatList() }, 30 * 60 * 1000)
  const { reconcileTasklistDeletions } = await import('./src/tasklist')
  if (shutdownRequested) return
  try {
    await reconcileTasklistDeletions()
  } catch (e) {
    log(`tasklist deletion reconcile failed: ${e instanceof Error ? e.message : e}`)
  }
  if (shutdownRequested) return

  // Lark WSClient sends pings every ~120s but doesn't verify pongs by default.
  // On a half-open TCP (NAT idle-kill, network blip) the socket stays OPEN and
  // 'close' never fires — we'd go silently deaf. SDK exposes `pingTimeout`:
  // after sending a ping, if no inbound frame arrives within the window the
  // socket is terminated, which triggers the 'close' handler and the SDK's
  // standard reconnect loop. The daemon process stays alive — every Codex
  // subprocess, card streaming state and setInterval is
  // preserved across the WS hiccup. We only let systemd restart us if the
  // SDK's own reconnect loop exhausts its retry budget (onError).
  let ws: lark.WSClient
  let lastEventAt = Date.now()        // 收到任意真实事件就刷新 = 通道存活铁证
  let consecRebuilds = 0
  let rebuilding = false
  let verifyTimer: ReturnType<typeof setTimeout> | null = null
  const SETTLE_MS = 1500              // 让 SDK 自身重连流程先落定再换 client
  const VERIFY_WINDOW_MS = 90_000     // rebuild 后等多久确认事件恢复
  const RECENT_ACTIVITY_MS = 10 * 60_000  // 重连前这段内有过事件 = 活跃群,值得重试
  const MAX_CONSEC_REBUILDS = 3       // 活跃群连续重建上限,到顶只告警不死循环

  let scheduledRebuildTimer: ReturnType<typeof setTimeout> | null = null
  let scheduledRebuildDueAt = 0
  let scheduledRebuildReason = ''
  let scheduledRebuildVerifyAfter = false
  let rebuildWs: (reason: string, verifyAfter?: boolean) => void = (reason) => {
    log(`[ws] rebuild requested before WS init — ${reason}`)
  }
  const scheduleWsRebuild = (reason: string, delayMs = 0, verifyAfter = false) => {
    if (shutdownRequested) return
    const dueAt = Date.now() + delayMs
    if (scheduledRebuildTimer) {
      scheduledRebuildVerifyAfter ||= verifyAfter
      if (dueAt >= scheduledRebuildDueAt) {
        log(`[ws] rebuild already scheduled — ${reason}`)
        return
      }
      clearTimeout(scheduledRebuildTimer)
    }
    scheduledRebuildDueAt = dueAt
    scheduledRebuildReason = reason
    scheduledRebuildVerifyAfter = verifyAfter
    scheduledRebuildTimer = setTimeout(() => {
      const scheduledReason = scheduledRebuildReason
      const scheduledVerifyAfter = scheduledRebuildVerifyAfter
      scheduledRebuildTimer = null
      scheduledRebuildDueAt = 0
      scheduledRebuildReason = ''
      scheduledRebuildVerifyAfter = false
      rebuildWs(scheduledReason, scheduledVerifyAfter)
    }, delayMs)
  }

  const wsLogger = {
    error: (m: any[]) => log(`[ws-sdk error] ${fmt(m)}`),
    warn:  (m: any[]) => {
      const text = fmt(m)
      log(`[ws-sdk warn] ${text}`)
      if (text.includes('no pong/inbound')) {
        scheduleWsRebuild(
          'ping-timeout: SDK liveness watchdog fired',
          2_000,
          (Date.now() - lastEventAt) < RECENT_ACTIVITY_MS,
        )
      }
    },
    info:  (m: any[]) => log(`[ws-sdk] ${fmt(m)}`),
    debug: (_m: any[]) => { /* drop */ },
    trace: (_m: any[]) => { /* drop */ },
  }
  const dispatcher = new lark.EventDispatcher({})

  // ── connected-but-deaf self-heal ────────────────────────────────────────
  // Feishu 长连接是**集群模式**(官方文档原话:"同一应用部署多个 client,
  // 只有随机一个 client 收到消息",且每 app ≤50 连接)。SDK 自带的重连
  // (reConnect → 同一个 WSClient 复用 tryConnect)断线后会重新握手成功、
  // pong 照常收发、getConnectionStatus().state==='connected' —— 但服务端
  // gateway 有时仍把旧连接当成该 app 的活跃 client,把事件**随机路由到那条
  // 已死的旧连接**,新连接 connected 却永远收不到任何 im.message 事件。
  // 这是 lark 长连接生态公认、但官方至今未修的 bug(同症状见 openclaw
  // #11719 / hermes-agent #24807)。三道旧防线全看不到它:pingTimeout 因
  // pong 仍在流动不触发;state 一直是 connected;onError 不报。
  //
  // 解法:不信 SDK 的同-client 重连,也不信 close()+start() in-place revive
  // (底层还是同一个 tryConnect,可能拉回同样被服务端判死的状态)。每次重连
  // 后**整个换一个全新的 lark.WSClient(新 token、新连接),force-close 旧的**
  // —— 这复刻了"整进程重启之所以管用"的核心(gateway 只剩一条新连可认),
  // 但全程不碰任何 Codex 子进程、不退进程。lastEventAt 作为唯一可信的"事件
  // 通道还活着"信号(不信 state);活跃群在 rebuild 后还聋就退避重建,封顶后
  // 只打日志、绝不 process.exit。
  const markEvent = () => {
    lastEventAt = Date.now()
    // 收到真实事件 = 通道确认健康:撤掉待验证、清零重建计数。
    consecRebuilds = 0
    if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null }
  }

  dispatcher.register({
    'im.message.receive_v1': async (d: any) => {
      markEvent()
      // ⚠️ 不要 await handleMessage —— Lark WS 长连接对事件 ack 有 ~4s
      // 硬超时,handleMessage 内部可能触发 openTurnCard / spawn Codex /
      // sendInterrupt 等数百 ms~数秒的链路,任一组合超 4s 飞书侧就判投递
      // 失败把事件直接丢弃(后台 event log 里这一类 errorInfo=timeout,
      // costMills≈3760ms,用户侧表现就是"发的消息 daemon 完全没收到")。
      // 这里立刻 return 让 dispatcher 回 ack,实际处理后台跑;handleMessage
      // 入口已用 seenMessageIds 做了同 message_id 去重,fire-and-forget
      // 不会引入重复处理。
      if (!enqueueMessage(d)) throw new Error('daemon shutdown in progress')
    },
  })
  dispatcher.register({
    'card.action.trigger': async (d: any) => {
      markEvent()
      // Synchronous acceptance only: reserve the per-chat actor and dedupe
      // slots before returning, then let the queued handler start next task.
      return acceptCardAction(d)
    },
  })

  const makeWs = (): lark.WSClient => new lark.WSClient({
    appId: config.feishu.app_id,
    appSecret: config.feishu.app_secret,
    loggerLevel: lark.LoggerLevel.info,
    logger: wsLogger,
    // MUST be < the SDK's 120s pingInterval. The pong-watchdog is re-armed on
    // every ping and (deliberately) NOT re-armed on inbound; it only fires if a
    // full pingTimeout window elapses with no inbound between two pings. With
    // pingTimeout ≥ 120 the next ping always re-arms it before it can expire, so
    // on a half-open/zombie socket it NEVER terminates — the whole
    // close→reConnect→onReconnected→rebuildWs self-heal chain below stays dead.
    // 60s leaves margin under the 120s interval so a dead link is killed within
    // ~60s of the next ping. (Earlier 180 silently disabled the watchdog.)
    wsConfig: { pingTimeout: 60 },
    // Without this, connect() awaits the 'open'/'error' event forever when
    // neither fires (wedged WS upgrade behind NAT/proxy) — start() deadlocks
    // silently: process alive, REST fine, but permanently deaf, no log and no
    // reconnect (the pingTimeout watchdog only arms AFTER 'open'). 10s cap →
    // fail-fast into the SDK's reconnect loop instead of hanging indefinitely.
    handshakeTimeoutMs: 10_000,
    onReconnecting: () => log('[ws] reconnecting — WS lost, SDK is retrying'),
    // SDK 自己重连成功了 —— 但这正是僵尸聋的高发点。不信它,延迟一拍后整个
    // 换新 client(见 onReconnectedHeal)。
    onReconnected:  () => onReconnectedHeal(),
    // SDK exhausted its own reconnect budget. Do NOT exit the process — that
    // SIGTERMs every Codex subprocess / live card across all
    // groups. Rebuild a fresh WS client in place; the rest keeps running.
    onError: (err) => rebuildWs(`SDK onError: ${err?.message ?? err}`),
  })

  // Fresh-client rebuild: force-close the (possibly server-side-zombie) old
  // client, stand up a brand-new WSClient with a fresh token + connection, and
  // hand it the same dispatcher. Never touches Codex subprocesses or live
  // cards; never exits the process. close({force}) does
  // removeAllListeners() before terminate(), so the old client fires no stray
  // reconnect. verifyAfter arms a post-rebuild check (only for active groups).
  rebuildWs = (reason: string, verifyAfter = false) => {
    if (shutdownRequested) return
    if (rebuilding) { log(`[ws] rebuild skipped (already rebuilding) — ${reason}`); return }
    if (scheduledRebuildTimer) {
      clearTimeout(scheduledRebuildTimer)
      scheduledRebuildTimer = null
      scheduledRebuildDueAt = 0
    }
    rebuilding = true
    consecRebuilds++
    log(`[ws] rebuild #${consecRebuilds} (fresh WSClient) — ${reason}`)
    const old = ws
    try { old?.close({ force: true }) } catch (e) { log(`[ws] rebuild: old close failed: ${e}`) }
    ws = makeWs()
    void ws.start({ eventDispatcher: dispatcher }).catch(e => {
      log(`[ws] rebuild start failed: ${e}`)
      scheduleWsRebuild(`fresh client start failed: ${e}`, SETTLE_MS, verifyAfter)
    })
    rebuilding = false
    if (verifyAfter) armVerify()
  }

  // After a rebuild, confirm events actually resumed. lastEventAt is the only
  // trustworthy signal (state lies). If nothing arrives in the window, the
  // rebuild also landed deaf → rebuild again with the same window as backoff,
  // capped at MAX_CONSEC_REBUILDS. Past the cap we stop and log loudly (no
  // process exit, no alert spam) — the last client stays up and a manual
  // `systemctl --user restart feishu-daemon` is the escape hatch.
  const armVerify = () => {
    if (verifyTimer) clearTimeout(verifyTimer)
    const armedAt = Date.now()
    verifyTimer = setTimeout(() => {
      verifyTimer = null
      if (lastEventAt >= armedAt) { consecRebuilds = 0; return }  // events resumed → healthy
      if (consecRebuilds >= MAX_CONSEC_REBUILDS) {
        log(`[ws] STILL deaf after ${MAX_CONSEC_REBUILDS} fresh rebuilds — auto-heal exhausted, ` +
            `leaving last client up (no process exit). Restart the configured service or run lodestar-stop && lodestar-daemon`)
        consecRebuilds = 0
        return
      }
      rebuildWs(`verify: no event ${Math.round((Date.now() - armedAt) / 1000)}s after rebuild`, true)
    }, VERIFY_WINDOW_MS)
  }

  // Every reconnect (any client) → replace it with a fresh one. Cheap (~3s WS
  // blip, no subprocess loss) and reconnects are rare (~4×/day), so doing it
  // unconditionally has near-zero cost and zero false-positive risk. Only arm
  // the verify-and-retry loop for groups that were active just before the drop
  // — a dormant group's post-reconnect silence is normal, not deafness, so it
  // gets the single precautionary rebuild and no retry storm.
  const onReconnectedHeal = () => {
    const wasRecentlyActive = (Date.now() - lastEventAt) < RECENT_ACTIVITY_MS
    log(`[ws] reconnected — swapping in a fresh WSClient (cluster-routing precaution; ` +
        `recentlyActive=${wasRecentlyActive})`)
    consecRebuilds = 0
    scheduleWsRebuild('post-reconnect precaution', SETTLE_MS, wasRecentlyActive)
  }

  ws = makeWs()

  // Liveness watchdog for the OTHER failure mode the deaf-heal can't see: a
  // wedged handshake / zombie socket that leaves the client stuck OFF
  // 'connected' with no callback firing. Poll state frequently; `idle` means
  // the SDK has no live socket and is not reconnecting, so rebuild immediately.
  // `connecting`/`reconnecting` gets a short grace window before we replace the
  // client. (connected-but-deaf is handled by the event-channel path above,
  // not here — state stays 'connected' in that case so this never sees it.)
  const WS_WATCHDOG_INTERVAL_MS = 15_000
  const WS_CONNECTING_GRACE_TICKS = 2
  let wsUnhealthyTicks = 0
  const wsWatchdog = setInterval(() => {
    if (shutdownRequested) return
    const { state } = ws.getConnectionStatus()
    if (state === 'connected') { wsUnhealthyTicks = 0; return }
    if (state === 'failed' || state === 'idle') {
      wsUnhealthyTicks = 0
      rebuildWs(`watchdog: state=${state}`)
      return
    }
    wsUnhealthyTicks++
    log(`[ws] watchdog: state=${state} (${wsUnhealthyTicks}/${WS_CONNECTING_GRACE_TICKS})`)
    if (wsUnhealthyTicks >= WS_CONNECTING_GRACE_TICKS) {
      wsUnhealthyTicks = 0
      rebuildWs(`watchdog: stuck in '${state}' ~${Math.round((WS_WATCHDOG_INTERVAL_MS * WS_CONNECTING_GRACE_TICKS) / 1000)}s`)
    }
  }, WS_WATCHDOG_INTERVAL_MS)
  stopFeishuWs = () => {
    clearInterval(wsWatchdog)
    if (scheduledRebuildTimer) clearTimeout(scheduledRebuildTimer)
    if (verifyTimer) clearTimeout(verifyTimer)
    ws.close({ force: true })
  }
  const recoveredCallbacks = loadCallbacks()
  startNotifyServer({
    bind: config.notify.bind,
    port: config.notify.port,
    extraHandler: (req, res, url) => handleAgentRequest(req, res, url, {
      service: agentService,
      authorizeSession: capability => {
        for (const session of sessions.values()) {
          if (session.acceptsAgentCapability(capability)) return session
        }
        return null
      },
    }),
  })

  // Install the bare delegated-agent command first, then sync managed Skills.
  // Source checkouts execute the TS entry through Bun; release installs execute
  // the sibling Node bundle. Missing entries fail boot instead of shipping a
  // Skill whose first command is guaranteed to fail.
  ensureLodestarAgentCommand()

  // Sync the feishu-notify skill into ~/.codex/skills (idempotent).
  // Lets the user's main Codex session push to bound groups via
  // /notify without manually placing the skill file. Runs after
  // notify server is up so the port number we bake into the skill
  // body matches what's actually listening.
  ensureFeishuNotifySkill()
  ensureLodestarAgentSkill()
  // File delivery is injected into each hosted session, not exposed as a Skill.
  removeManagedSkill('lodestar-files')

  // Reserve recovery ahead of both messages and card actions in each chat's
  // FIFO before ingress opens. Feishu REST status cards do not require WS.
  const revival = sessionRecovery.enqueue()
  stopAgentAutoUpdates = startAgentAutoUpdates(log, { enabled: config.runtime.agent_auto_update })
  void ws.start({ eventDispatcher: dispatcher }).catch(e => {
    log(`[ws] initial start failed: ${e}`)
    scheduleWsRebuild(`initial start failed: ${e}`, SETTLE_MS, false)
  })
  log(`lodestar-daemon: WS start requested, watching ${feishu.chatNameCache.size} groups`)
  startDebugSocket()
  for (const reg of recoveredCallbacks) {
    void trackCardActionWork(chatActor.enqueue(reg.chatId, () => notifyReplies.recover(reg)))
      .catch(error => log(`notify-reply recovery failed: ${error instanceof Error ? error.message : error}`))
  }
  await revival
}

boot().catch(e => {
  log(`boot fatal: ${e}`)
  void requestShutdown('boot fatal', 1)
})
