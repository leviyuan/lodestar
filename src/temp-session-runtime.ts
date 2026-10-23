import { formatLogError } from './log'
import {
  validateConversationLaunch,
  type ConversationLaunch,
  type ConversationBranchBase,
  type ConversationRouting,
} from './conversation'
import type { TurnAnchor } from './feishu'

export interface CreateTempSessionOptions {
  chatName: string
  userOpenId: string
  workDir: string
  routing: ConversationRouting
  launch: ConversationLaunch
  branchBase: ConversationBranchBase
  seedAnchors?: TurnAnchor[]
}

export interface CreateTempSessionResult {
  ok: boolean
  chatId?: string
  error?: string
}

export interface DisbandTempSessionResult {
  ok: boolean
  error?: string
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
  ): Promise<{ chatId: string; created: boolean; joined: boolean }>
  disbandChatForSessionExact(
    sessionName: string,
    chatId: string,
  ): Promise<{ chatId: string | null; disbanded: boolean }>
  chatIdForSession(sessionName: string): string | null
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

function confirmDeleted(
  sessionName: string,
  expectedChatId: string | null,
  result: { chatId: string | null; disbanded: boolean },
): string {
  if (!result.disbanded || !result.chatId) {
    throw new Error(`飞书未确认删除临时群 "${sessionName}"`)
  }
  if (expectedChatId && result.chatId !== expectedChatId) {
    throw new Error(`飞书删除结果 chat_id 不匹配: expected=${expectedChatId} actual=${result.chatId}`)
  }
  return result.chatId
}

/**
 * Owns the temporary-group lifecycle transaction while keeping Session and
 * Feishu side effects injectable. Remote deletion is the commit point: local
 * registry and persisted conversation state remain intact until it succeeds.
 */
export function createTempSessionRuntime<TSession extends TempSessionHandle>(
  deps: TempSessionRuntimeDeps<TSession>,
): TempSessionRuntime<TSession> {
  const sessionFor = (chatId: string, sessionName: string): TSession => {
    let session = deps.registry.get(chatId)
    if (session && session.sessionName !== sessionName) {
      throw new Error(`chat ${chatId} is already owned by session "${session.sessionName}", not "${sessionName}"`)
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
    try {
      validateConversationLaunch(opts.launch, opts.routing.provider, opts.workDir)
      if (opts.launch.kind === 'resume') {
        throw new Error('temporary groups must start fresh or fork; resume is not allowed')
      }
      ensured = await deps.ensureChatForSession(opts.chatName, opts.userOpenId)
      if (!ensured.created) {
        return { ok: false, chatId: ensured.chatId, error: '临时会话必须使用新群；既有群保留，未执行加入、启动或删除' }
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
        if (!ensured.created) return { ok: false, error: `${failure}；既有群保留，未执行删除` }

        let deletedChatId: string
        try {
          const deleted = await deps.disbandChatForSessionExact(opts.chatName, ensured.chatId)
          deletedChatId = confirmDeleted(opts.chatName, ensured.chatId, deleted)
        } catch (deleteError) {
          const cleanupFailure = messageOf(deleteError)
          deps.log(formatLogError('temp-session: create cleanup failed', cleanupFailure))
          return {
            ok: false,
            chatId: ensured.chatId,
            error: `${failure}；自动解散失败，临时群/session 仍保留: ${cleanupFailure}`,
          }
        }

        try {
          deps.registry.delete(deletedChatId)
          tempSession?.dispose()
          deps.clearSessionConversationState(opts.chatName)
        } catch (cleanupError) {
          const cleanupFailure = messageOf(cleanupError)
          deps.log(formatLogError('temp-session: local cleanup failed', cleanupFailure))
          return { ok: false, error: `${failure}；临时群已确认解散，但本地状态清理失败: ${cleanupFailure}` }
        }
        return { ok: false, error: `${failure}；本次新建的临时群已确认解散` }
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

    let deletedChatId: string
    try {
      const deleted = await deps.disbandChatForSessionExact(chatName, knownChatId)
      deletedChatId = confirmDeleted(chatName, knownChatId, deleted)
    } catch (deleteError) {
      const failure = messageOf(deleteError)
      deps.log(formatLogError('temp-session: disband failed', failure))
      return { ok: false, error: `${failure}；临时群/session 仍保留` }
    }

    try {
      deps.registry.delete(deletedChatId)
      session?.dispose()
      deps.clearSessionConversationState(chatName)
      return { ok: true }
    } catch (cleanupError) {
      const failure = messageOf(cleanupError)
      deps.log(formatLogError('temp-session: local cleanup after disband failed', failure))
      return { ok: false, error: `临时群已确认解散，但本地状态清理失败: ${failure}` }
    }
  }

  return { sessionFor, createTempSession, disbandTempSession }
}
