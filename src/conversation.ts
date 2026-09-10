import { isAbsolute } from 'node:path'
import type { AgentProvider, AgentReasoningEffort } from './agent-process'

/** A persisted backend conversation that can be resumed or used as a fork source. */
export interface ConversationRef {
  provider: AgentProvider
  sessionId: string
  /** Absolute source working directory. null is reserved for legacy persisted data. */
  cwd: string | null
}

/**
 * Backend-native checkpoint for a completed user turn.
 *
 * Claude forks at the final assistant message UUID for that turn. Codex forks
 * at the canonical app-server turn ID. Keeping the source conversation on the
 * checkpoint makes checkpoints remain valid across nested forks/backtracks.
 */
export type ConversationCheckpoint =
  | {
      provider: 'dsh'
      kind: 'event'
      id: string
      source: ConversationRef & { provider: 'dsh' }
    }
  | {
      provider: 'claude'
      kind: 'assistant-message'
      id: string
      source: ConversationRef & { provider: 'claude' }
    }
  | {
      provider: 'codex'
      kind: 'turn'
      id: string
      source: ConversationRef & { provider: 'codex' }
    }

/** Explicit conversation lifecycle intent passed from Session to a backend. */
export type ConversationLaunch =
  | { kind: 'fresh' }
  | { kind: 'resume'; source: ConversationRef }
  | { kind: 'fork'; source: ConversationRef; through?: ConversationCheckpoint }

/** Persisted baseline preceding the retained turn anchors. null means legacy/unknown, never fresh. */
export type ConversationBranchBase = ConversationLaunch | null

/** A fork accepted by a backend process but not yet materialized into a new
 * resumable session id. Claude streaming-input forks stay in this state until
 * the first user message triggers SDK init. */
export interface PendingConversationLaunch {
  launch: Extract<ConversationLaunch, { kind: 'fork' }>
  /** Resume id bound to the group before the pending fork was prepared. */
  previousSessionId: string | null
}

/** Provider/model/account snapshot inherited by a newly-created temporary group. */
export interface ConversationRouting {
  provider: AgentProvider
  tokenSourceId: string | null
  model: string | null
  effort: AgentReasoningEffort | null
}

/** Provider-neutral row rendered by the stopped-session history picker. */
export interface ConversationSummary {
  provider: AgentProvider
  sessionId: string
  /** Absolute working directory reported by the backend-native catalog. */
  cwd: string
  preview: string
  ts: number
  status?: string
}

export function conversationLaunchProvider(launch: ConversationLaunch): AgentProvider | null {
  return launch.kind === 'fresh' ? null : launch.source.provider
}

export function validateConversationLaunch(
  launch: ConversationLaunch,
  provider: AgentProvider,
  expectedCwd?: string,
): void {
  const sourceProvider = conversationLaunchProvider(launch)
  if (sourceProvider && sourceProvider !== provider) {
    throw new Error(`conversation launch provider mismatch: source=${sourceProvider} target=${provider}`)
  }
  if (launch.kind !== 'fresh' && !launch.source.sessionId.trim()) {
    throw new Error('conversation launch source session id is empty')
  }
  if (
    launch.kind !== 'fresh'
    && launch.source.cwd !== null
    && (typeof launch.source.cwd !== 'string' || !isAbsolute(launch.source.cwd))
  ) {
    throw new Error(`conversation launch source cwd is not absolute: ${String(launch.source.cwd)}`)
  }
  if (launch.kind !== 'fresh' && expectedCwd !== undefined) {
    if (!isAbsolute(expectedCwd)) {
      throw new Error(`expected conversation cwd is not absolute: ${expectedCwd}`)
    }
    if (launch.source.cwd === null) {
      throw new Error('conversation launch source cwd is missing')
    }
    if (launch.source.cwd !== expectedCwd) {
      throw new Error(`conversation launch cwd mismatch: source=${launch.source.cwd} target=${expectedCwd}`)
    }
  }
  if (launch.kind !== 'fork' || !launch.through) return
  if (launch.through.provider !== provider || launch.through.source.provider !== provider) {
    throw new Error(`conversation checkpoint provider mismatch: checkpoint=${launch.through.provider} target=${provider}`)
  }
  if (launch.through.source.sessionId !== launch.source.sessionId) {
    throw new Error('conversation checkpoint source does not match fork source')
  }
  if (launch.through.source.cwd !== launch.source.cwd) {
    throw new Error('conversation checkpoint cwd does not match fork source')
  }
  if (!launch.through.id.trim()) throw new Error('conversation checkpoint id is empty')
  if (provider === 'dsh' && (!/^\d+$/.test(launch.through.id) || !Number.isSafeInteger(Number(launch.through.id)))) {
    throw new Error('DSH checkpoint must be a non-negative event sequence')
  }
}
