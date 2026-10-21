import { readFileSync } from 'node:fs'
import type { AgentProcess } from './agent-process'
import { processClaudeAccount } from './claude-accounts'
import { SESSION_ACTIVITY_FILE } from './paths'
import { writeJsonStateAtomic } from './state-store'

export const USER_ACTIVITY_WINDOW_MS = 30 * 60_000
interface ActivityState { version: 1; chats: Record<string, number> }
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/** One daemon owns this private timestamp store. Never persists messages or mutable account counts. */
export class SessionActivityStore {
  private state: ActivityState | undefined
  constructor(readonly file = SESSION_ACTIVITY_FILE) {}

  private read(): ActivityState {
    if (this.state) return this.state
    let raw: string
    try { raw = readFileSync(this.file, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.state = { version: 1, chats: {} }
      throw error
    }
    const state = JSON.parse(raw) as ActivityState
    if (!state || state.version !== 1 || !state.chats || typeof state.chats !== 'object' || Array.isArray(state.chats)
      || Object.entries(state.chats).some(([chatId, time]) => !chatId.trim() || !validTime(time))) {
      throw new Error('会话活跃时间记录格式无效')
    }
    return this.state = state
  }

  lastUserMessageAt(chatId: string): number | undefined {
    const time = this.read().chats[chatId]
    return validTime(time) ? time : undefined
  }

  /** Receipt time is captured before actor queueing; old/reordered events never move time backwards. */
  recordUserMessage(chatId: string, createdAt: number, receivedAt: number): void {
    if (!chatId.trim()) throw new Error('记录用户消息活跃时间需要 chatId')
    const time = validTime(createdAt)
      ? validTime(receivedAt) ? Math.min(createdAt, receivedAt) : createdAt
      : receivedAt
    if (!validTime(time)) throw new Error('用户消息时间和接收时间均无效')
    const state = this.read()
    if ((this.lastUserMessageAt(chatId) ?? 0) >= time) return
    const next: ActivityState = { version: 1, chats: { ...state.chats, [chatId]: time } }
    writeJsonStateAtomic(this.file, next)
    this.state = next
  }
}

export const sessionActivity = new SessionActivityStore()

interface ActiveClaudeSession {
  readonly chatId: string
  readonly proc: AgentProcess | null
  hasActiveConversationWork(): boolean
}

/** Actual live Session bindings only: control queries and absent/default guesses never reserve quota. */
export function countActiveClaudeSessions(
  sessions: Iterable<ActiveClaudeSession>,
  options: { excludeChatId?: string; now?: number; activity?: SessionActivityStore } = {},
): ReadonlyMap<string, number> {
  const now = options.now ?? Date.now(), activity = options.activity ?? sessionActivity
  if (!validTime(now)) throw new Error('统计会话活跃度的当前时间无效')
  const counted = new Set<string>(), counts = new Map<string, number>()
  for (const session of sessions) {
    if (session.chatId === options.excludeChatId || counted.has(session.chatId)) continue
    const proc = session.proc
    if (!proc?.isAlive() || proc.provider !== 'claude' || proc.tokenSourceId !== 'claude-sub') continue
    const accountId = processClaudeAccount(proc)
    if (!accountId) continue
    const lastMessage = activity.lastUserMessageAt(session.chatId)
    if (!session.hasActiveConversationWork() && (lastMessage === undefined || now - lastMessage > USER_ACTIVITY_WINDOW_MS)) continue
    counted.add(session.chatId)
    counts.set(accountId, (counts.get(accountId) ?? 0) + 1)
  }
  return counts
}
