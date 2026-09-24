import { localFetch } from './network'
/**
 * Persistent registration store for `/notify` cards that carry
 * interactive buttons.
 *
 * A caller POSTs `/notify` with `buttons:[{id,text,type?}]` and a
 * loopback `callback` URL. The notify server:
 *   1. generates a `notify_id`,
 *   2. renders each button with `value={kind:'notify_callback',notify_id,button_id}`,
 *   3. sends the card, and
 *   4. {@link register}s the binding here (notify_id → callback URL +
 *      original card params).
 *
 * When a user taps a button, the WS `card.action.trigger` event routes
 * to `kind:'notify_callback'` in `daemon.ts`, which looks the binding up
 * here and {@link dispatchCallback}s the click as a local-HTTP POST to
 * the caller's URL — closing the loop entirely on the host (no inbound
 * network). The caller's server acks 2xx; the daemon then
 * {@link markResolved}s and rebuilds the card into a resolved state.
 *
 * The map is persisted to {@link NOTIFY_CALLBACKS_FILE} so a daemon
 * restart does not strand clickable cards, and pruned to 7 days so the
 * file cannot grow unbounded. All communication is loopback-only — the
 * `/notify` HTTP server and the callback POST both stay on the host —
 * matching the owner-equivalent trust tier of the rest of the daemon
 * (same tier as `debug.sock` and the bot's stdin).
 */

import { readFileSync } from 'node:fs'
import { log } from './log'
import { NOTIFY_CALLBACKS_FILE } from './paths'
import { writeJsonStateAtomic } from './state-store'

/** Caller-declared button shape (after validation). `type` mirrors the
 * Feishu schema-2.0 button `type` field; omitted serializes as the
 * client default (`default`). */
export interface NotifyButton {
  id: string
  text: string
  type: 'default' | 'primary' | 'danger'
}

export interface NotifyTextResponse {
  text: string
  /** User's message, distinct from the original notification message_id. */
  message_id: string
  prompt_message_id: string
}

export interface NotifyReplyState {
  id: string
  openId: string
  promptMessageId: string
  openedAt: number
  status: 'waiting' | 'sending' | 'failed' | 'cancelled'
  cancelReason?: 'switched'
  response?: NotifyTextResponse
  error?: string
}

/** A registered interactive `/notify` card. Persisted wholesale so the
 * resolved-card rebuild after a click can re-render the original
 * images/text/header without re-uploading. */
export interface NotifyRegistration {
  notifyId: string
  /** Loopback HTTP URL the caller pledged to listen on. */
  callbackUrl: string
  chatId: string
  /** The original card's `message_id` — surfaced back to the caller in
   * the click payload so it can correlate / update. */
  messageId: string
  project: string
  title: string
  text: string
  level: 'info' | 'warn' | 'error'
  /** Uploaded image keys (already on Feishu's CDN — reuse, don't
   * re-upload, on the resolved rebuild). `key==''` marks an upload
   * failure rendered inline in red. */
  imageKeys: Array<{ key: string; src: string; error?: string }>
  buttons: NotifyButton[]
  allowReply?: boolean
  replyState?: NotifyReplyState
  /** Keep dedupe across explicit failed-attempt retries and different owners. */
  replyMessageIds?: string[]
  /** Written before a button callback can run. An interrupted dispatch must
   * not become retryable after restart because its external effect is unknown. */
  dispatchState?: { buttonId: string; openId: string; startedAt: number }
  /** Unix-ms epoch. Used by {@link prune} (7-day TTL) and never
   * mutated after creation. */
  createdAt: number
  /** Set by {@link markResolved} on the first successful callback.
   * Further clicks return an idempotent "已处理过" toast and do NOT
   * re-dispatch — prevents a double-fire when two members tap the
   * same card near-simultaneously. */
  resolvedAt?: number
  resolvedBy?: { buttonId?: string; openId: string }
  /** Dispatch was interrupted or its durable completion could not be
   * confirmed. Never retry automatically: the external side effect may
   * already have happened. */
  unknownAt?: number
  unknownBy?: { buttonId?: string; openId: string }
  unknownReason?: string
}

/** Drop registrations older than this on load. 7 days matches the
 * daemon log retention; a card still clickable after a week is stale
 * UX, not a live handle. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Hard cap on the callback POST. Loopback round-trips are sub-100ms;
 * anything slower means the caller's server is wedged, and we must stay
 * inside Feishu's ~3s inline card-replace window so the resolved card
 * still renders. Surfaced as a timeout, not papered over. */
const CALLBACK_TIMEOUT_MS = 2500

const map = new Map<string, NotifyRegistration>()
let lastRuntimePruneAt = Date.now()
const RUNTIME_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Fast in-memory double-click guard. dispatchState separately preserves
 * uncertainty across a process interruption. */
const dispatching = new Set<string>()
export function isDispatching(notifyId: string): boolean { return dispatching.has(notifyId) }
export function setDispatching(notifyId: string): void { dispatching.add(notifyId) }
export function clearDispatching(notifyId: string): void { dispatching.delete(notifyId) }

/** Persistence target. Defaults to {@link NOTIFY_CALLBACKS_FILE}; the
 * `__setStoreFileForTest` escape hatch redirects it so the unit test
 * can run hermetically without clobbering the user's real state. */
let storeFile = NOTIFY_CALLBACKS_FILE

function saveCallbacks(): void {
  try {
    const obj: Record<string, NotifyRegistration> = {}
    for (const [k, v] of map) obj[k] = v
    writeJsonStateAtomic(storeFile, obj)
  } catch (e) {
    log(`notify-callbacks: save failed (${storeFile}): ${e}`)
    throw e
  }
}

/** Load + prune on daemon boot. An unreadable or corrupt store is an error,
 * since treating it as empty would lose callback deduplication records. */
export function loadCallbacks(): NotifyRegistration[] {
  const interruptedCallbacks: NotifyRegistration[] = []
  let raw: string
  try {
    raw = readFileSync(storeFile, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    log(`notify-callbacks: read failed (${storeFile}): ${error}`)
    throw error
  }
  try {
    const obj = JSON.parse(raw) as Record<string, any>
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('notify callback store must be an object')
    const cutoff = Date.now() - MAX_AGE_MS
    let dropped = 0
    let interrupted = 0
    for (const rec of Object.values(obj)) {
      if (!rec || typeof rec !== 'object') continue
      if (typeof rec.notifyId !== 'string' || typeof rec.callbackUrl !== 'string') continue
      if (typeof rec.createdAt !== 'number' || rec.createdAt < cutoff) { dropped++; continue }
      // A durable sending marker precedes the external POST. After a crash
      // its outcome is uncertain; never replay a potentially delivered reply.
      if (rec.replyState?.status === 'sending' && !rec.resolvedAt && !rec.unknownAt) {
        rec.unknownAt = Date.now()
        rec.unknownBy = { openId: rec.replyState.openId }
        rec.unknownReason = '服务在文字回复回传期间中断，无法确认是否送达，禁止自动重试'
        interrupted++
      }
      if (rec.dispatchState && !rec.resolvedAt && !rec.unknownAt) {
        rec.unknownAt = Date.now()
        rec.unknownBy = { buttonId: rec.dispatchState.buttonId, openId: rec.dispatchState.openId }
        rec.unknownReason = '服务在按钮回调期间中断，无法确认是否送达，禁止自动重试'
        interrupted++
      }
      map.set(rec.notifyId, rec as NotifyRegistration)
      if ((rec.replyState?.status === 'sending' || rec.dispatchState) && rec.unknownAt) interruptedCallbacks.push(rec)
    }
    log(`notify-callbacks: loaded ${map.size} registration(s)${dropped ? `, dropped ${dropped} stale` : ''}`)
    if (interrupted) log(`notify-callbacks: ${interrupted} interrupted callback(s) marked UNKNOWN`)
    if (dropped > 0 || interrupted > 0) saveCallbacks()
  } catch (e) {
    log(`notify-callbacks: load failed (${storeFile}): ${e}`)
    throw e
  }
  return interruptedCallbacks
}

export function register(reg: NotifyRegistration): void {
  // The daemon is expected to run for weeks; prune-on-boot alone lets a
  // long-lived process grow this map and its state file without bound.
  const now = Date.now()
  if (now - lastRuntimePruneAt >= RUNTIME_PRUNE_INTERVAL_MS) {
    prune(now)
    lastRuntimePruneAt = now
  }
  map.set(reg.notifyId, reg)
  saveCallbacks()
}

export function get(notifyId: string): NotifyRegistration | undefined {
  return map.get(notifyId)
}

/** Commit the uncertain interval before any external side effect is allowed. */
export function beginCallbackDispatch(notifyId: string, buttonId: string, openId: string): void {
  const rec = map.get(notifyId)
  if (!rec) throw new Error(`notify registration not found: ${notifyId}`)
  if (rec.resolvedAt || rec.unknownAt || rec.dispatchState) throw new Error('notify callback is already dispatched or finalized')
  rec.dispatchState = { buttonId, openId, startedAt: Date.now() }
  try { saveCallbacks() }
  catch (error) { delete rec.dispatchState; throw error }
}

/** A failed POST becomes retryable only once removing its pending marker is
 * durable. Retain UNKNOWN when that transition cannot be saved. */
export function recordCallbackFailure(notifyId: string): { state: 'retry' } | { state: 'unknown'; detail: string } {
  const rec = map.get(notifyId)
  if (!rec?.dispatchState) throw new Error(`notify callback is not dispatching: ${notifyId}`)
  const state = rec.dispatchState
  delete rec.dispatchState
  try { saveCallbacks(); return { state: 'retry' } }
  catch (error) {
    rec.dispatchState = state
    const detail = `callback failure persistence failed: ${error instanceof Error ? error.message : error}`
    try { markUnknown(notifyId, state.buttonId, state.openId, detail) }
    catch (unknownError) {
      rec.unknownReason = `${detail}; unknown tombstone persistence also failed: ${unknownError instanceof Error ? unknownError.message : unknownError}`
    }
    return { state: 'unknown', detail: rec.unknownReason ?? detail }
  }
}

export function pendingRepliesForChat(chatId: string): NotifyRegistration[] {
  return [...map.values()].filter(rec => rec.chatId === chatId && !rec.resolvedAt && !rec.unknownAt
    && (rec.replyState?.status === 'waiting' || rec.replyState?.status === 'sending'))
}

export function findPendingReply(chatId: string, openId?: string): NotifyRegistration | undefined {
  if (!chatId) return undefined
  return pendingRepliesForChat(chatId).find(rec => openId === undefined || rec.replyState?.openId === openId)
}

export function hasReplyMessage(chatId: string, messageId: string): boolean {
  return !!messageId && [...map.values()].some(rec => rec.chatId === chatId
    && (rec.replyMessageIds?.includes(messageId) || rec.replyState?.response?.message_id === messageId))
}

/** Mutate only after the state has been durably written; a failed write must
 * not leave an invisible input reservation or authorize an external POST. */
export function setReplyState(notifyId: string, state: NotifyReplyState): void {
  const rec = map.get(notifyId)
  if (!rec) throw new Error(`notify registration not found: ${notifyId}`)
  const previous = rec.replyState
  const previousIds = rec.replyMessageIds
  rec.replyState = state
  if (state.response && !rec.replyMessageIds?.includes(state.response.message_id)) {
    rec.replyMessageIds = [...(rec.replyMessageIds ?? []), state.response.message_id]
  }
  try { saveCallbacks() }
  catch (error) {
    if (previous) rec.replyState = previous
    else delete rec.replyState
    if (previousIds) rec.replyMessageIds = previousIds
    else delete rec.replyMessageIds
    throw error
  }
}

export function markResolved(notifyId: string, buttonId: string | undefined, openId: string): void {
  const rec = map.get(notifyId)
  if (!rec) throw new Error(`notify registration not found: ${notifyId}`)
  const previous = {
    resolvedAt: rec.resolvedAt,
    resolvedBy: rec.resolvedBy,
    unknownAt: rec.unknownAt,
    unknownBy: rec.unknownBy,
    unknownReason: rec.unknownReason,
    dispatchState: rec.dispatchState,
  }
  rec.resolvedAt = Date.now()
  rec.resolvedBy = { ...(buttonId !== undefined ? { buttonId } : {}), openId }
  delete rec.unknownAt
  delete rec.unknownBy
  delete rec.unknownReason
  delete rec.dispatchState
  try {
    saveCallbacks()
  } catch (e) {
    if (previous.resolvedAt === undefined) delete rec.resolvedAt
    else rec.resolvedAt = previous.resolvedAt
    if (previous.resolvedBy === undefined) delete rec.resolvedBy
    else rec.resolvedBy = previous.resolvedBy
    if (previous.unknownAt === undefined) delete rec.unknownAt
    else rec.unknownAt = previous.unknownAt
    if (previous.unknownBy === undefined) delete rec.unknownBy
    else rec.unknownBy = previous.unknownBy
    if (previous.unknownReason === undefined) delete rec.unknownReason
    else rec.unknownReason = previous.unknownReason
    if (previous.dispatchState !== undefined) rec.dispatchState = previous.dispatchState
    throw e
  }
}

export function markUnknown(
  notifyId: string,
  buttonId: string | undefined,
  openId: string,
  reason: string,
): void {
  const rec = map.get(notifyId)
  if (!rec) throw new Error(`notify registration not found: ${notifyId}`)
  delete rec.resolvedAt
  delete rec.resolvedBy
  rec.unknownAt = Date.now()
  rec.unknownBy = { ...(buttonId !== undefined ? { buttonId } : {}), openId }
  rec.unknownReason = reason
  // Keep the in-memory unknown guard even if this write throws. The caller
  // will also freeze the visible card so an ambiguous external success is not
  // exposed as a retryable button after a local persistence failure.
  saveCallbacks()
}

export type NotifyCallbackSuccessRecord =
  | { state: 'complete' }
  | { state: 'unknown'; detail: string }

/** Record a successful external callback without ever turning an ambiguous
 * local persistence failure into a retryable outcome. */
export function recordCallbackSuccess(
  notifyId: string,
  buttonId: string | undefined,
  openId: string,
): NotifyCallbackSuccessRecord {
  try {
    markResolved(notifyId, buttonId, openId)
    return { state: 'complete' }
  } catch (resolvedError) {
    const resolvedDetail = resolvedError instanceof Error ? resolvedError.message : String(resolvedError)
    let detail = `resolved tombstone persistence failed: ${resolvedDetail}`
    try {
      markUnknown(notifyId, buttonId, openId, detail)
    } catch (unknownError) {
      const unknownDetail = unknownError instanceof Error ? unknownError.message : String(unknownError)
      detail += `; unknown tombstone persistence also failed: ${unknownDetail}`
      const rec = map.get(notifyId)
      if (rec) rec.unknownReason = detail
    }
    return { state: 'unknown', detail }
  }
}

/** Defensive cleanup hook (not currently on a timer — prune-on-load is
 * sufficient). Exported so tests and future schedulers can drive it. */
export function prune(now: number = Date.now()): number {
  const cutoff = now - MAX_AGE_MS
  let removed = 0
  for (const [id, rec] of map) {
    if (typeof rec.createdAt !== 'number' || rec.createdAt < cutoff) {
      map.delete(id)
      removed++
    }
  }
  if (removed > 0) saveCallbacks()
  return removed
}

export interface DispatchResult {
  ok: boolean
  /** Short human-readable reason surfaced in the Feishu toast when
   * `ok===false`. Never a "safe" fallback value — always the actual
   * failure (HTTP status, timeout, network error). */
  detail: string
  /** Optional reply text the caller returned in its 2xx response body
   * (JSON `{text|reply|message}` or plain text). Rendered on the final
   * card so the caller can report an outcome ("已发布 v1.2.3"). Capped
   * at 500 chars; undefined when the caller acked with an empty body. */
  reply?: string
}

/** POST the click payload to the caller's loopback server and await its
 * verdict within {@link CALLBACK_TIMEOUT_MS}. The body is the contract:
 *
 *   {
 *     "notify_id": "nf_...",
 *     "message_id": "om_...",
 *     "chat_id": "oc_...",
 *     "project": "feishu",
 *     "button": { "id": "approve", "text": "✅ 通过", "type": "primary" },
 *     "operator": { "open_id": "ou_..." },
 *     "timestamp": 1700000000
 *   }
 *
 * 2xx ⇒ ok; anything else (or a timeout/network error) ⇒ !ok with the
 * real reason. The caller's server must respond fast — this is the
 * host-local, owner-equivalent channel, not a public webhook. */
export async function dispatchCallback(
  reg: NotifyRegistration,
  answer: NotifyButton | NotifyTextResponse,
  operatorOpenId: string,
): Promise<DispatchResult> {
  const payload = {
    notify_id: reg.notifyId,
    message_id: reg.messageId,
    chat_id: reg.chatId,
    project: reg.project,
    ...('id' in answer
      ? { button: { id: answer.id, text: answer.text, type: answer.type } }
      : { response: { type: 'text', ...answer } }),
    operator: { open_id: operatorOpenId },
    timestamp: Math.floor(Date.now() / 1000),
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS)
  try {
    const res = await localFetch(reg.callbackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (res.status >= 200 && res.status < 300) {
      // Capture an optional reply the caller surfaced in its 2xx body.
      // JSON `{text|reply|message}` or plain text — capped at 500 chars
      // so a runaway response can't bloat the card. Unparseable/empty ⇒
      // no reply (the standard "反馈已送达" marker still renders).
      let reply: string | undefined
      try {
        const raw = (await res.text()).trim()
        if (raw.startsWith('{')) {
          const obj = JSON.parse(raw) as any
          const r = typeof obj?.text === 'string' ? obj.text
            : typeof obj?.reply === 'string' ? obj.reply
            : typeof obj?.message === 'string' ? obj.message
            : ''
          if (r.trim()) reply = r.trim().slice(0, 500)
        } else if (raw) {
          reply = raw.slice(0, 500)
        }
      } catch {
        // body not parseable — treat as no reply
      }
      return { ok: true, detail: `${res.status}`, reply }
    }
    let body = ''
    try { body = (await res.text()).slice(0, 120) } catch {}
    return { ok: false, detail: `HTTP ${res.status}${body ? ` ${body}` : ''}` }
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return { ok: false, detail: `回调超时 ${CALLBACK_TIMEOUT_MS}ms(本地服务未在窗口内 2xx)` }
    }
    return { ok: false, detail: `回调失败: ${String(e?.message ?? e).slice(0, 160)}` }
  } finally {
    clearTimeout(timer)
  }
}

/** Test-only: redirect persistence at a temp file and clear the
 * in-memory map so the suite runs hermetically — never clobbers the
 * user's real `notify-callbacks.json`. Production paths never call this;
 * they use {@link loadCallbacks} / {@link register} against
 * {@link NOTIFY_CALLBACKS_FILE}. */
export function __setStoreFileForTest(file: string, clearMemory = true): void {
  storeFile = file
  if (clearMemory) {
    map.clear()
    dispatching.clear()  // simulate a full process restart
  }
}

/** Build the pull-result payload for `GET /notify/result/<id>`. Pure
 * function over a registration — extracted so the HTTP handler stays
 * thin and the shape is unit-testable. `resolved:false` while pending;
 * once frozen, the chosen button (id+text+type), resolve timestamp and
 * operator open_id are included so a stateless caller has the full
 * verdict without running a callback server. */
export function buildNotifyResult(reg: NotifyRegistration): object {
  const resolved = !!reg.resolvedAt
  const unknown = !!reg.unknownAt
  const buttonId = reg.resolvedBy?.buttonId ?? reg.unknownBy?.buttonId
  const button = buttonId ? reg.buttons.find((b) => b.id === buttonId) : undefined
  const response = reg.replyState?.response
  const verdict = buttonId !== undefined
    ? { button: button ? { id: button.id, text: button.text, type: button.type } : { id: buttonId } }
    : response ? { response: { type: 'text', ...response } } : {}
  return {
    notify_id: reg.notifyId,
    project: reg.project,
    message_id: reg.messageId,
    resolved,
    unknown,
    ...(reg.replyState ? {
      reply: {
        status: resolved && buttonId === undefined ? 'resolved'
          : unknown && buttonId === undefined ? 'unknown' : reg.replyState.status,
        prompt_message_id: reg.replyState.promptMessageId,
        operator: { open_id: reg.replyState.openId },
        ...(reg.replyState.cancelReason ? { cancel_reason: reg.replyState.cancelReason } : {}),
        ...(reg.replyState.error ? { error: reg.replyState.error } : {}),
      },
    } : {}),
    ...(resolved
      ? {
          ...verdict,
          resolved_at: reg.resolvedAt,
          resolved_by: reg.resolvedBy?.openId ?? null,
        }
      : {}),
    ...(unknown
      ? {
          ...verdict,
          unknown_at: reg.unknownAt,
          unknown_by: reg.unknownBy?.openId ?? null,
          unknown_reason: reg.unknownReason,
        }
      : {}),
  }
}
