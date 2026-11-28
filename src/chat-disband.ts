/**
 * 群没了之后的本地清理：飞书群解散事件（`im.chat.disbanded_v1`）、启动后的解散核对，以及 wt 删除 WT 群
 * （外部群机器人不能解散、只能退群，退群后收不到解散事件）。daemon.ts 导入即启动服务，逻辑放在这里
 * 注入依赖单测，daemon 只做接线。
 *
 * 同名群各有自己的 Session（registry 按 chat_id），但绑定、resume、模型与 turns 按群名保存，群名绑定
 * 跟着最近说话的群走。所以只有群名绑定确实指向被清理的群时才清群名级状态；否则只停止并释放该群自己的
 * Session、清它自己的活跃时间/租约/群名缓存，不碰同名的另一个群。项目目录与云空间文件不删。
 */

export interface ChatDisbandSession {
  stop(reason: string, opts: { announce: boolean }): Promise<void>
  dispose(): void
}

export interface ChatDisbandDeps<TSession extends ChatDisbandSession> {
  /** daemon 的 Session registry（key = chat_id）。 */
  registry: {
    get(chatId: string): TSession | undefined
    delete(chatId: string): unknown
  }
  /** 已保存的群名 → chat_id 绑定（只读，`feishu.preferredChatForSession`）。 */
  bindings: ReadonlyMap<string, string>
  /** 群名绑定指向本群时清群名级会话状态。 */
  clearSessionConversationState(sessionName: string, chatId: string): void
  /** 只清本群自己的状态：活跃时间、该 chat_id 的租约、群名缓存。 */
  forgetChatState(chatId: string): void
  /** 刷新 alive marker。 */
  persistRecovery(): void
  /** 与该群的消息、卡片操作串行（daemon 的 chatActor）。 */
  runExclusive<T>(chatId: string, task: () => Promise<T>): Promise<T>
  log(event: string): void
  logError(event: string, error: unknown): void
}

/** 群怎么没的：飞书解散，或（外部群）机器人已退群。只决定停止原因与日志字面量。 */
export type ChatGoneKind = 'disbanded' | 'left'

export interface ChatDisbandRuntime {
  /** `im.chat.disbanded_v1` 入口；当前 SDK 把事件体拍平，旧形态在 `event` 下。失败只记日志。 */
  handleDisbandedEvent(data: unknown): Promise<void>
  /** 清理一个已经不存在的群；同群串行，失败只记日志。 */
  forgetGoneChat(chatId: string, kind: ChatGoneKind): Promise<void>
  /** 启动核对：逐个检查已绑定的群，已解散的按解散清理。 */
  reconcileDissolvedChats(wasDissolved: (chatId: string) => Promise<boolean>): Promise<void>
}

export function disbandedChatId(data: unknown): string {
  const event = data as { chat_id?: unknown; event?: { chat_id?: unknown } } | null | undefined
  return String(event?.chat_id ?? event?.event?.chat_id ?? '').trim()
}

export function createChatDisbandRuntime<TSession extends ChatDisbandSession>(
  deps: ChatDisbandDeps<TSession>,
): ChatDisbandRuntime {
  const forget = async (chatId: string, kind: ChatGoneKind, reason: string): Promise<void> => {
    const session = deps.registry.get(chatId)
    if (session) {
      try { await session.stop(reason, { announce: false }) }
      catch (e) { deps.logError('daemon.chat.disbanded_stop_failed', e) }
      deps.registry.delete(chatId)
      session.dispose()
    }
    // 绑定在排队期间、以及 stop 打断/杀进程的几秒里都可能被同名的另一个群改走，而
    // clearSessionConversationState 按群名无条件清理：stop 结束后才挑名字，清每个名字前再核对一次。
    const boundNames = [...deps.bindings].filter(([, id]) => id === chatId).map(([name]) => name)
    for (const sessionName of boundNames) {
      if (deps.bindings.get(sessionName) !== chatId) continue
      try { deps.clearSessionConversationState(sessionName, chatId) }
      catch (e) { deps.logError('daemon.chat.disbanded_cleanup_failed', e) }
    }
    try { deps.forgetChatState(chatId) }
    catch (e) { deps.logError('daemon.chat.disbanded_cleanup_failed', e) }
    if (!session && boundNames.length === 0) {
      // 与 Lodestar 无关（或已清理过）的群：只丢掉群名缓存这类按 chat 的残留。
      deps.log('daemon.chat.disbanded_ignored')
      return
    }
    try { deps.persistRecovery() }
    catch (e) { deps.logError('daemon.chat.disbanded_marker_failed', e) }
    deps.log(kind === 'left' ? 'daemon.chat.left' : 'daemon.chat.disbanded')
  }

  const forgetGoneChat = (chatId: string, kind: ChatGoneKind): Promise<void> => {
    if (!chatId) return Promise.resolve()
    return deps.runExclusive(chatId, () => forget(chatId, kind, kind === 'left' ? '机器人已退群' : '群已解散'))
      .catch(e => deps.logError('daemon.chat.disbanded_failed', e))
  }

  const handleDisbandedEvent = (data: unknown): Promise<void> => {
    const chatId = disbandedChatId(data)
    if (!chatId) {
      deps.log('daemon.chat.disbanded_ignored')
      return Promise.resolve()
    }
    return forgetGoneChat(chatId, 'disbanded')
  }

  const reconcileDissolvedChats = async (wasDissolved: (chatId: string) => Promise<boolean>): Promise<void> => {
    const chatIds = [...new Set(deps.bindings.values())]
    let next = 0
    const worker = async () => {
      for (;;) {
        const index = next++
        if (index >= chatIds.length) return
        const chatId = chatIds[index]!
        if (!await wasDissolved(chatId)) continue
        await deps.runExclusive(chatId, () => forget(chatId, 'disbanded', '群已解散（启动核对）'))
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, chatIds.length) }, () => worker()))
    deps.log('daemon.chat.reconciled')
  }

  return { handleDisbandedEvent, forgetGoneChat, reconcileDissolvedChats }
}

/** 飞书 `chat_status` 里表示群已解散的取值（`dissolved_save` 为“已解散（保留）”）。 */
const DISSOLVED_CHAT_STATUSES = new Set(['dissolved', 'dissolved_save'])
/** 群已不存在 / 已解散时 `chat.get` 的拒绝码。 */
const DISSOLVED_CHAT_CODES = new Set([232009, 232006])

/** 启动核对用：读一次群信息判断是否已解散。超时或其他失败一律按“未解散”，下次启动再核对。 */
export function chatWasDissolved(
  chatId: string,
  deps: {
    getChat(chatId: string): Promise<unknown>
    errorCode(error: unknown): unknown
    timeoutMs?: number
  },
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    deps.getChat(chatId),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('chat.get timeout')), deps.timeoutMs ?? 8_000)
    }),
  ]).then(res => {
    const response = res as { code?: unknown; data?: { code?: unknown; chat_status?: unknown } } | null | undefined
    const code = response?.code ?? response?.data?.code ?? 0
    return code === 0 && DISSOLVED_CHAT_STATUSES.has(String(response?.data?.chat_status ?? ''))
  }, error => {
    const code = deps.errorCode(error)
    return typeof code === 'number' && DISSOLVED_CHAT_CODES.has(code)
  }).finally(() => { if (timer) clearTimeout(timer) })
}

// ── WT 群删除后的本地清理 ────────────────────────────────────────────────
// wt 删除 WT 群后（外部群机器人只能退群，飞书不会再推解散事件）由 Session 侧代码通知 daemon 释放该群的
// Session。Session 侧没有 daemon 的 registry，daemon 启动时在这里登记处理函数；脚本直接构造 Session
// 时没有登记，什么也不做。
let goneChatHandler: ((chatId: string, kind: ChatGoneKind) => Promise<void>) | null = null

export function setGoneChatHandler(handler: ((chatId: string, kind: ChatGoneKind) => Promise<void>) | null): void {
  goneChatHandler = handler
}

export async function notifyChatGone(chatId: string, kind: ChatGoneKind): Promise<void> {
  if (chatId && goneChatHandler) await goneChatHandler(chatId, kind)
}
