/**
 * Which Claude subscription account ran a native session.
 *
 * Native history (`projects/*.jsonl`, and the resume map) is shared by every
 * Claude account, so the account is not recoverable from the transcript. This
 * file keeps the observation Lodestar already has at bind time, so the `rs`
 * history can show the account and an all-exhausted restart can continue on
 * the conversation's original account instead of an arbitrary one.
 *
 * Only account ids are stored. Display names are resolved from the live
 * account registry at render time; a deleted account simply renders nothing.
 */

import { readFileSync } from 'node:fs'
import { CLAUDE_SESSION_ACCOUNTS_FILE } from './paths'
import { writeJsonStateAtomic } from './state-store'
import { logError } from './log'

/** Diagnostic metadata is FIFO-bounded so a long-lived project cannot grow it without limit. */
const MAX_ENTRIES = 2000

let accounts: Map<string, string> | null = null

function load(): Map<string, string> {
  if (accounts) return accounts
  const loaded = new Map<string, string>()
  try {
    const parsed: unknown = JSON.parse(readFileSync(CLAUDE_SESSION_ACCOUNTS_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [sessionId, accountId] of Object.entries(parsed)) {
        if (!sessionId || typeof accountId !== 'string' || !accountId) continue
        loaded.set(sessionId, accountId)
      }
    } else {
      logError('claude session account map load failed', new Error('state must be an object'))
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') logError('claude session account map load failed', error)
  }
  accounts = loaded
  return loaded
}

/** Account that last ran this native session, or null when it was never observed. */
export function claudeSessionAccount(sessionId: string): string | null {
  if (!sessionId) return null
  return load().get(sessionId) ?? null
}

/** Observed account for a conversation. Best-effort: persistence failures only
 *  log, because this metadata must never fail a turn or a resume. */
export function recordClaudeSessionAccount(sessionId: string, accountId: string): void {
  if (!sessionId || !accountId) return
  const map = load()
  if (map.get(sessionId) === accountId) return
  // Re-insert so the FIFO order reflects the latest observation.
  map.delete(sessionId)
  map.set(sessionId, accountId)
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  try {
    writeJsonStateAtomic(CLAUDE_SESSION_ACCOUNTS_FILE, Object.fromEntries(map))
  } catch (error) {
    logError('claude session account map save failed', error)
  }
}
