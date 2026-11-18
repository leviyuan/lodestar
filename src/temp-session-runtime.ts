import { formatLogError } from './log'
import {
  validateConversationLaunch,
  type ConversationLaunch,
  type ConversationBranchBase,
  type ConversationRouting,
} from './conversation'
import type { TurnAnchor } from './feishu'

/** `create` 必须新建临时群;`reuse` 允许复用同名群(带备注的 btw)。*/
export type TempSessionGroupMode = 'create' | 'reuse'

export interface CreateTempSessionOptions {
  chatName: string
  userOpenId: string
  workDir: string
  routing: ConversationRouting
  launch: ConversationLaunch
  branchBase: ConversationBranchBase
  seedAnchors?: TurnAnchor[]
  /** 缺省 `create`:只有新建的群才启动会话,既有群一律拒绝。 */
  groupMode?: TempSessionGroupMode
  /** 只在新群必须是外部群时给出(外部联系人发起,或本企业成员在外部群里发起):新建的外部群由这位
   * 本企业成员当群主(机器人不能当外部群群主)。 */
  ownerOpenId?: string
  /** 发起人是外部联系人;加入已存在的同名群时没有群主,仍靠它给出外部联系人的报错提示。
   * 本企业成员在外部群里发起时显式为 false,不给外部联系人的提示。 */
  externalRequester?: boolean
}

export interface CreateTempSessionResult {
  ok: boolean
  chatId?: string
  error?: string
  /** `added` 表示刚被拉进既有临时群,`present` 表示本来就在群里；
   * 两者都不新建、不启动、不改动会话。 */
  join?: 'added' | 'present'
}

export interface DisbandTempSessionResult {
  ok: boolean
  error?: string
  /** 外部群不能由机器人解散,机器人已退群,群留给群主手动解散。`ok` 为 false 时表示退群后
   * 本地状态清理失败:机器人已不在群里,失败要报到别处。 */
  left?: boolean
}

export interface TempSessionHandle {
  readonly sessionName: string
  readonly workDir: string
  isRunning(): boolean
  applyConversationRouting(routing: ConversationRouting): void
  start(opts: { announce: boolean }): Promise<boolean>
  startForked(
    launch: Extract<ConversationLaunch, { kind: 'fork' }>,
    opts: { announce: boolean },
  ): Promise<boolean>
  backendLabel(): string
  stop(reason: string, opts: { announce: boolean }): Promise<void>
  dispose(): void
}

export interface TempSessionRegistry<TSession> {
  get(chatId: string): TSession | undefined
  set(chatId: string, session: TSession): unknown
  delete(chatId: string): unknown
}

export interface TempSessionRuntimeDeps<TSession extends TempSessionHandle> {
  registry: TempSessionRegistry<TSession>
  createSession(sessionName: string, chatId: string): TSession
  ensureChatForSession(
    sessionName: string,
    userOpenId: string,
    mode: TempSessionGroupMode,
    ownerOpenId?: string,
    externalRequester?: boolean,
  ): Promise<{ chatId: string; created: boolean; joined: boolean }>
  /** 外部群不能删除:机器人退群并返回 `left`,`disbanded` 为 false。 */
  disbandChatForSessionExact(
    sessionName: string,
    chatId: string,
  ): Promise<{ chatId: string | null; disbanded: boolean; left?: boolean }>
  chatIdForSession(sessionName: string): string | null
  /** Drops a name → chat binding that a group rename left pointing at this chat. */
  unbindSessionChat?(sessionName: string): void
  clearSessionConversationState(sessionName: string): void
  registerTempSessionLease(sessionName: string, chatId: string): void
  hasTempSessionLease(sessionName: string, chatId: string): boolean
  replaceTurnAnchors(sessionName: string, anchors: TurnAnchor[], base: ConversationBranchBase): void
  runExclusive?<T>(chatId: string, task: () => Promise<T>): Promise<T>
  log(message: string): void
}

export interface TempSessionRuntime<TSession extends TempSessionHandle> {
  sessionFor(chatId: string, sessionName: string): TSession
  createTempSession(opts: CreateTempSessionOptions): Promise<CreateTempSessionResult>
  disbandTempSession(chatName: string, expectedChatId: string): Promise<DisbandTempSessionResult>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 解散或(外部群)机器人退群都算移除成功;`left` 表示群仍在、只是机器人已退出。 */
function confirmRemoved(
  sessionName: string,
  expectedChatId: string | null,
  result: { chatId: string | null; disbanded: boolean; left?: boolean },
): { chatId: string; left: boolean } {
  if (!(result.disbanded || result.left === true) || !result.chatId) {
    throw new Error(`飞书未确认删除临时群 "${sessionName}"`)
  }
  if (expectedChatId && result.chatId !== expectedChatId) {
    throw new Error(`飞书删除结果 chat_id 不匹配: expected=${expectedChatId} actual=${result.chatId}`)
  }
  return { chatId: result.chatId, left: !result.disbanded }
}

/**
 * Owns the temporary-group lifecycle transaction while keeping Session and
 * Feishu side effects injectable. Remote deletion is the commit point: local
 * registry and persisted conversation state remain intact until it succeeds.
 * An external group cannot be deleted by the bot; there the bot leaving the
 * group is the commit point instead.
 */
export function createTempSessionRuntime<TSession extends TempSessionHandle>(
  deps: TempSessionRuntimeDeps<TSession>,
): TempSessionRuntime<TSession> {
  const sessionFor = (chatId: string, sessionName: string): TSession => {
    let session = deps.registry.get(chatId)
    if (session && session.sessionName !== sessionName) {
      // The group was renamed. Work that is still running stays with its project and is
      // never stopped implicitly; the caller reports this to the chat.
      if (session.isRunning()) {
        throw new Error(`本群已改名为「${sessionName}」，但原群名「${session.sessionName}」的会话仍在运行，本条消息未执行。`
          + `请把群名改回「${session.sessionName}」并发送 kill 结束该会话，再改为新群名`)
      }
      // A stopped session holds no process: retire it so the new name maps to its own project.
      const previousName = session.sessionName
      session.dispose()
      deps.registry.delete(chatId)
      if (deps.chatIdForSession(previousName) === chatId) deps.unbindSessionChat?.(previousName)
      session = undefined
    }
    if (!session) {
      session = deps.createSession(sessionName, chatId)
      deps.registry.set(chatId, session)
    }
    return session
  }

  const createTempSession = async (
    opts: CreateTempSessionOptions,
  ): Promise<CreateTempSessionResult> => {
    let ensured: Awaited<ReturnType<typeof deps.ensureChatForSession>>
    const mode = opts.groupMode ?? 'create'
    try {
      validateConversationLaunch(opts.launch, opts.routing.provider, opts.workDir)
      if (opts.launch.kind === 'resume') {
        throw new Error('temporary groups must start fresh or fork; resume is not allowed')
      }
      ensured = await deps.ensureChatForSession(opts.chatName, opts.userOpenId, mode, opts.ownerOpenId, opts.externalRequester)
      if (!ensured.created) {
        if (mode !== 'reuse') {
          return { ok: false, chatId: ensured.chatId, error: '临时会话必须使用新群；既有群保留，未执行加入、启动或删除' }
        }
        // 加入既有群:群里的会话、模型/账号和 lease 都归创建者,这里不改动任何状态。
        deps.log('temp-session: reused existing group')
        return { ok: true, chatId: ensured.chatId, join: ensured.joined ? 'added' : 'present' }
      }
    } catch (error) {
      const failure = messageOf(error)
      deps.log(formatLogError('temp-session: create failed', failure))
      return { ok: false, error: failure }
    }

    const initializeAndCompensate = async (): Promise<CreateTempSessionResult> => {
      let tempSession: TSession | null = null
      try {
        deps.registerTempSessionLease(opts.chatName, ensured.chatId)
        tempSession = sessionFor(ensured.chatId, opts.chatName)
        if (tempSession.isRunning()) {
          return { ok: false, error: `${opts.chatName} 已有会话在跑,先 bye 解散再重试` }
        }
        if (tempSession.workDir !== opts.workDir) {
          throw new Error(`临时群 cwd 不匹配: source=${opts.workDir} target=${tempSession.workDir}`)
        }
        tempSession.applyConversationRouting(opts.routing)
        const started = opts.launch.kind === 'fork'
          ? await tempSession.startForked(opts.launch, { announce: false })
          : await tempSession.start({ announce: false })
        if (!started) throw new Error(`${tempSession.backendLabel()} 启动失败`)
        deps.replaceTurnAnchors(opts.chatName, opts.seedAnchors ?? [], opts.branchBase)
        return { ok: true, chatId: ensured.chatId }
      } catch (error) {
        const failure = messageOf(error)
        deps.log(formatLogError('temp-session: initialize failed', failure))
        if (tempSession) {
          try {
            await tempSession.stop('临时群启动失败清理', { announce: false })
          } catch (stopError) {
            const stopFailure = messageOf(stopError)
            deps.log(formatLogError('temp-session: failed-create stop failed', stopFailure))
            return {
              ok: false,
              chatId: ensured.chatId,
              error: `${failure}；无法确认 Session 已停止，临时群/session 仍保留: ${stopFailure}`,
            }
          }
        }

        let removed: { chatId: string; left: boolean }
        try {
          const deleted = await deps.disbandChatForSessionExact(opts.chatName, ensured.chatId)
          removed = confirmRemoved(opts.chatName, ensured.chatId, deleted)
        } catch (deleteError) {
          const cleanupFailure = messageOf(deleteError)
          deps.log(formatLogError('temp-session: create cleanup failed', cleanupFailure))
          return {
            ok: false,
            chatId: ensured.chatId,
            error: `${failure}；自动解散失败，临时群/session 仍保留: ${cleanupFailure}`,
          }
        }

        const removedNote = removed.left
          ? '机器人已退出本次新建的外部临时群，请群主手动解散'
          : '本次新建的临时群已确认解散'
        try {
          deps.registry.delete(removed.chatId)
          tempSession?.dispose()
          deps.clearSessionConversationState(opts.chatName)
        } catch (cleanupError) {
          const cleanupFailure = messageOf(cleanupError)
          deps.log(formatLogError('temp-session: local cleanup failed', cleanupFailure))
          return { ok: false, error: `${failure}；${removedNote}，但本地状态清理失败: ${cleanupFailure}` }
        }
        return { ok: false, error: `${failure}；${removedNote}` }
      }
    }

    try {
      return deps.runExclusive
        ? await deps.runExclusive(ensured.chatId, initializeAndCompensate)
        : await initializeAndCompensate()
    } catch (error) {
      const failure = messageOf(error)
      deps.log(formatLogError('temp-session: target actor failed', failure))
      return { ok: false, chatId: ensured.chatId, error: `${failure}；临时群/session 仍保留` }
    }
  }

  const disbandTempSession = async (
    chatName: string,
    expectedChatId: string,
  ): Promise<DisbandTempSessionResult> => {
    const knownChatId = deps.chatIdForSession(chatName)
    if (!expectedChatId || knownChatId !== expectedChatId) {
      const failure = `临时群 chat_id 已变化: expected=${expectedChatId || '-'} bound=${knownChatId ?? '-'}`
      deps.log(formatLogError('temp-session: disband identity rejected', failure))
      return { ok: false, error: `${failure}；未执行停止或删群` }
    }
    if (!deps.hasTempSessionLease(chatName, expectedChatId)) {
      const failure = `群 ${expectedChatId} 没有 Lodestar 临时会话 lease，拒绝解散`
      deps.log(formatLogError('temp-session: disband lease rejected', failure))
      return { ok: false, error: `${failure}；未执行停止或删群` }
    }
    const session = deps.registry.get(knownChatId)
    try {
      if (session) await session.stop('bye 解散', { announce: false })
    } catch (stopError) {
      const failure = messageOf(stopError)
      deps.log(formatLogError('temp-session: stop before disband failed', failure))
      return { ok: false, error: `${failure}；无法确认 Session 已停止，未执行删群` }
    }

    let removed: { chatId: string; left: boolean }
    try {
      const deleted = await deps.disbandChatForSessionExact(chatName, knownChatId)
      removed = confirmRemoved(chatName, knownChatId, deleted)
    } catch (deleteError) {
      const failure = messageOf(deleteError)
      deps.log(formatLogError('temp-session: disband failed', failure))
      return { ok: false, error: `${failure}；临时群/session 仍保留` }
    }

    try {
      deps.registry.delete(removed.chatId)
      session?.dispose()
      deps.clearSessionConversationState(chatName)
      return removed.left ? { ok: true, left: true } : { ok: true }
    } catch (cleanupError) {
      const failure = messageOf(cleanupError)
      deps.log(formatLogError('temp-session: local cleanup after disband failed', failure))
      // 外部群:机器人已经退群,调用方不能再往这个群里报错,用 `left` 告诉它改报到别处。
      if (removed.left) return { ok: false, left: true, error: `机器人已退出外部临时群，但本地状态清理失败: ${failure}` }
      return { ok: false, error: `临时群已确认解散，但本地状态清理失败: ${failure}` }
    }
  }

  return { sessionFor, createTempSession, disbandTempSession }
}
