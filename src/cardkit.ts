import { networkFetch } from './network'
/**
 * Feishu Card Kit v1 wrapper.
 *
 * Endpoints used (base = https://open.feishu.cn/open-apis/cardkit/v1):
 *   POST   /cards/id_convert                              message_id → card_id
 *   POST   /cards/:card_id/elements                       add element
 *   PUT    /cards/:card_id/elements/:element_id           replace element
 *   DELETE /cards/:card_id/elements/:element_id           remove element
 *   PATCH  /cards/:card_id/settings                       toggle streaming_mode etc.
 *
 * Per-card invariants enforced here:
 *   - `sequence` is monotonically increasing per card_id
 *   - all writes for a card are serialized through a Promise queue
 */

import { createHash, randomUUID } from 'node:crypto'
import { getTenantToken } from './feishu'
import { FeishuRequestError, readFeishuResponse, withFeishuRetry } from './feishu-retry'
import { log } from './log'
import { ELEMENTS, neutralizeMarkdownImagesInCard } from './cards/elements'

const BASE = 'https://open.feishu.cn/open-apis/cardkit/v1'
const CARDKIT_FETCH_TIMEOUT_MS = 15_000

const ID_CONVERT_RETRY_DELAYS_MS = [0, 250, 750, 1500]

interface ElementPlacement {
  type?: 'append' | 'insert_before' | 'insert_after'
  targetElementId?: string
}

interface CardState {
  sequence: number
  queue: Promise<void>
  /** Live count of elements on the card. Initialised by
   * `recordCardCreated` (session passes the body.elements.length of the
   * just-sent card), then incremented in addElement's success branch and
   * decremented in deleteElement's. Used by session to pre-empt the
   * Card Kit component-count ceiling (300305, sometimes nested in 300315)
   * — once
   * the count climbs into the danger zone, session rotates a new card
   * mid-turn before the next addElement would 400. Approximate (a failed
   * addElement won't bump it, so the count tracks "elements Feishu
   * believes exist" not "elements we tried to create"). */
  elementCount: number
  /** Hashes of successfully written body elements, without card-local IDs.
   * Used to recognize an unchanged rejected payload across replacement cards.
   * Footer timing/status changes do not count as content progress. */
  contentFingerprints: Map<string, string>
  /** 最新内容未落地或已经删除的元素，按卡隔离。后续更新可以重建失败的
   * add 或重试失败的 PUT；显式删除的元素不会被迟到的更新复活。 */
  deadElements: Set<string>
  /** Missing adds retain their original placement so a later tool/result
   * update can create the latest element. Failed PUTs still have a remote
   * element and may be retried; deleted elements must remain unwritable. */
  failedAdds: Map<string, ElementPlacement>
  failedReplacements: Set<string>
  /** Synchronous enqueue gate set by dispose before draining the queue. */
  closing?: boolean
  /** Card-level write-failure callback, set by recordCardCreated. Invoked
   * by any cardkit write op that fails even after the streaming-closed
   * reopen+retry; the session uses it to rotate onto a fresh card (see
   * Session.onCardWriteFailure). Not fired for deletes (a failed delete is
   * harmless — it doesn't block new content). */
  onFailure?: (code?: number, failure?: CardWriteFailure) => void
}

export interface CardWriteFailure {
  cardId: string
  operation: string
  elementId?: string
  targetElementId?: string
  code?: number
  httpStatus?: number
  logId?: string
  message: string
  /** Attempted body content, including the rejected element, independent of
   * card IDs, element renumbering and footer timers. Capacity failures only. */
  capacityFingerprint?: string
}

export interface CardWriteResult {
  landed: boolean
  failure?: CardWriteFailure
}

interface CardKitRequestError extends Error {
  code?: number
  httpStatus?: number
  logId?: string
}

/** 整卡容量包括组件数量（300305）和体积（200860）。300315 是通用插入
 * 错误，只在内层明确报告整卡容量超限时换卡；ID、布局等校验错误不换卡。 */
export function isCardCapacityFailure(
  code?: number,
  failure?: Pick<CardWriteFailure, 'message'>,
): boolean {
  if (code === 300305 || code === 200860) return true
  if (code !== 300315) return false
  const message = failure?.message ?? ''
  return /(?:code\s*[:=]\s*(?:300305|200860)\b|number of card components[^\n.]{0,60}exceed|\bcard over max size\b)/i.test(message)
}

export function isDuplicateElementFailure(
  code?: number,
  failure?: Pick<CardWriteFailure, 'message'>,
): boolean {
  if (code !== 300315) return false
  return /(?:duplicate\s+(?:element\s*)?id|code\s*1001\s*:\s*duplicate id)/i
    .test(failure?.message ?? '')
}

const cards = new Map<string, CardState>()

interface SummaryState {
  latest: string
  lastSent: string
  timer: ReturnType<typeof setTimeout> | null
}
const summaryStates = new Map<string, SummaryState>()
const SUMMARY_FLUSH_MS = 1500

function state(cardId: string): CardState {
  const current = cards.get(cardId)
  if (!current) throw new Error(`cardkit card is not registered: ${cardId}`)
  return current
}

/** Closed or unregistered cards cannot accept writes. Ownership comes from
 * the live registry, so evicting old history can never resurrect a card. */
export function isDisposed(cardId: string): boolean {
  return !cards.has(cardId)
}

/** Session calls this once right after sendCard + convertMessageToCard,
 * passing the number of elements that were in the card's initial body
 * (banner + userInputPanel + footer = 1–3 depending on turn
 * kind). Without this, the element-count tracker only sees adds/deletes
 * that happen *after* card creation, and session can't reliably decide
 * "is this card close to the limit?" — that's the data point that
 * triggers a mid-turn rotate before a confirmed `300305` capacity error. */
export function recordCardCreated(
  cardId: string,
  initialElementCount: number,
  onFailure?: (code?: number, failure?: CardWriteFailure) => void,
): void {
  cards.set(cardId, {
    sequence: 0,
    queue: Promise.resolve(),
    elementCount: initialElementCount,
    contentFingerprints: new Map(),
    deadElements: new Set(),
    failedAdds: new Map(),
    failedReplacements: new Set(),
    onFailure,
    closing: false,
  })
}

/** Read the live element count maintained by addElement/deleteElement.
 * Returns 0 if the card has no state yet (which is also the right answer
 * for "this card has no elements that we know about"). */
export function getElementCount(cardId: string): number {
  return cards.get(cardId)?.elementCount ?? 0
}

/** Body elements whose latest content actually landed. Session uses these
 * IDs to distinguish completed output left on an old page from live content
 * that is rebuilt on every replacement. */
export function getWrittenContentElementIds(cardId: string): string[] {
  const s = cards.get(cardId)
  return s ? [...s.contentFingerprints.keys()].filter(id => !s.deadElements.has(id)) : []
}

/** 最新版本未写入或元素已删除；换卡时据此保留尚未显示的内容。 */
export function isDeadElement(cardId: string, elementId: string): boolean {
  return cards.get(cardId)?.deadElements.has(elementId) ?? false
}

/** A duplicate-id add may mean the element landed but the acknowledgement
 * was lost/raced. Allow one checked PUT reconciliation against that id. */
export function clearDeadElementForReconcile(cardId: string, elementId: string): void {
  const s = cards.get(cardId)
  s?.deadElements.delete(elementId)
  s?.failedAdds.delete(elementId)
  s?.failedReplacements.delete(elementId)
}

function nextSeq(cardId: string): number {
  const s = state(cardId)
  s.sequence += 1
  return s.sequence
}

function markElementDead(s: CardState, elementId: string): void {
  s.deadElements.add(elementId)
}

function contentFingerprint(element: object): string {
  return createHash('sha256').update(JSON.stringify(element, (key, value) =>
    key === 'element_id' ? undefined : value,
  )).digest('hex')
}

function attemptedContentFingerprint(s: CardState, elementId?: string, fingerprint?: string): string {
  const contents = [...s.contentFingerprints]
    .filter(([id]) => id !== elementId)
    .map(([, hash]) => hash)
  if (fingerprint && elementId !== ELEMENTS.footer) contents.push(fingerprint)
  return createHash('sha256').update(contents.sort().join('\n')).digest('hex')
}

async function call(method: string, path: string, body?: object): Promise<any> {
  // Mutations carry a sequence; id_convert is a lookup and has no UUID field.
  // Freeze the whole mutation before retrying: a lost acknowledgement must
  // resend the same UUID, sequence and content for Feishu's idempotency check.
  // A TTL reopen invokes call again, so that new operation gets a fresh UUID.
  const payload = body ? JSON.stringify({
    ...body,
    ...('sequence' in body ? { uuid: randomUUID() } : {}),
  }) : undefined
  const label = `cardkit ${method} ${path}`
  return withFeishuRetry(label, async () => {
    const token = await getTenantToken()
    const signal = AbortSignal.timeout(CARDKIT_FETCH_TIMEOUT_MS)
    let res: Response | undefined
    try {
      res = await networkFetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(payload !== undefined ? { body: payload } : {}),
        signal,
      })
      return (await readFeishuResponse(res, label))?.data
    } catch (error) {
      // node-fetch turns deadline expiry into AbortError, including body reads.
      // Restore the owned timeout reason; arbitrary cancellation is not retried.
      if (signal.aborted && signal.reason?.name === 'TimeoutError') throw signal.reason
      if (res && error instanceof FeishuRequestError) {
        const logId = res.headers.get('x-tt-logid') ?? res.headers.get('x-request-id') ?? res.headers.get('request-id') ?? undefined
        Object.assign(error, { httpStatus: res.status, logId })
        if (logId) error.message += ` log_id=${logId}`
      }
      throw error
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isStreamingClosed(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const code = (e as any).code
  // 300309 "streaming mode is closed" — TTL already fired before our write.
  // 200850 "card streaming timeout"   — TTL fired exactly during our write.
  // Both mean the streaming session is gone and a reopen will unstick the card.
  return code === 300309 || code === 200850
}

/** Reopen streaming_mode on a card that Feishu auto-closed after its
 * 10-minute streaming TTL (no keepalive, no idle reset — the timer
 * starts when streaming is opened and fires regardless of activity).
 * Called from inside the per-card queue's catch path, so it allocates
 * its own sequence and runs inline without re-enqueueing. */
async function reopenStreaming(cardId: string): Promise<void> {
  const seq = nextSeq(cardId)
  await call('PATCH', `/cards/${cardId}/settings`, {
    settings: JSON.stringify({ config: { streaming_mode: true } }),
    sequence: seq,
  })
}

/** Run `op` inside the per-card queue. If it fails with code=300309
 * or 200850 (Feishu auto-closed / timed-out streaming after the 10-
 * minute TTL), reopen streaming inline and retry `op` exactly once.
 * Each call first exhausts its bounded, idempotent transport retries.
 * Other failures, including failed reopens, are logged and reported through
 * callbacks, matching the fire-and-forget contract at the call sites. */
async function withReopenOnStreamingClosed(
  cardId: string,
  label: string,
  op: () => Promise<void>,
  onFailure?: (failure: CardWriteFailure) => void,
  silent = false,
  meta: Pick<CardWriteFailure, 'elementId' | 'targetElementId'> & { contentFingerprint?: string } = {},
): Promise<void> {
  // 失败统一出口:card-level handler 先(它同步快照当前段/tool 后再异步
  // 换卡),per-call onFailure 后(addElement 的 deadElements.add + session
  // 段游标 reset)。顺序要紧 —— 换卡的同步快照必须在 reset 把
  // currentAssistant* 清空之前跑。silent(deleteElement)跳过 card-level:
  // 删不掉一个元素不影响新内容,不值得为它换卡。
  const fail = (error: unknown): void => {
    const requestError = typeof error === 'object' && error !== null
      ? error as CardKitRequestError
      : null
    const failure: CardWriteFailure = {
      cardId,
      operation: label,
      elementId: meta.elementId,
      targetElementId: meta.targetElementId,
      code: requestError?.code,
      httpStatus: requestError?.httpStatus,
      logId: requestError?.logId,
      message: error instanceof Error ? error.message : String(error),
    }
    if (isCardCapacityFailure(failure.code, failure)) {
      failure.capacityFingerprint = attemptedContentFingerprint(
        state(cardId), meta.elementId, meta.contentFingerprint,
      )
    }
    try {
      if (!silent) state(cardId).onFailure?.(failure.code, failure)
    } catch (error) {
      log(`cardkit failure callback ${cardId}: ${error}`)
    }
    try {
      onFailure?.(failure)
    } catch (error) {
      log(`cardkit per-call failure callback ${cardId}: ${error}`)
    }
  }
  try {
    await op()
    return
  } catch (e) {
    if (!isStreamingClosed(e)) {
      log(`cardkit ${label} ${cardId}: ${e}`)
      fail(e)
      return
    }
    log(`cardkit ${label} ${cardId}: streaming closed (code=${(e as any).code}) — reopening`)
  }
  try {
    await reopenStreaming(cardId)
  } catch (re) {
    log(`cardkit STREAMING_REOPEN_FAILED ${cardId}: ${re}`)
    fail(re)
    return
  }
  try {
    await op()
  } catch (e2) {
    log(`cardkit ${label} ${cardId} retry-after-reopen: ${e2}`)
    fail(e2)
  }
}

function isIdConvertEmptyResult(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as any).code === 200740
}

interface IdConvertOptions {
  retryDelaysMs?: number[]
}

/** Convert a sent interactive message into a card entity. */
export async function convertMessageToCard(
  messageId: string,
  opts: IdConvertOptions = {},
): Promise<string> {
  const delays = opts.retryDelaysMs?.length ? opts.retryDelaysMs : ID_CONVERT_RETRY_DELAYS_MS
  let lastErr: unknown = null
  for (let i = 0; i < delays.length; i++) {
    const delay = delays[i] ?? 0
    if (delay > 0) await sleep(delay)
    try {
      const data = await call('POST', '/cards/id_convert', { message_id: messageId })
      if (typeof data?.card_id !== 'string' || !data.card_id) {
        throw new Error(`cardkit POST /cards/id_convert: missing card_id`)
      }
      return data.card_id
    } catch (e) {
      lastErr = e
      if (!isIdConvertEmptyResult(e) || i === delays.length - 1) throw e
      const nextDelay = delays[i + 1] ?? 0
      log(`cardkit id_convert ${messageId}: empty result, retry ${i + 2}/${delays.length} in ${nextDelay}ms`)
    }
  }
  throw lastErr
}

/** Wait for all currently queued writes for a card. */
export async function flush(cardId: string): Promise<void> {
  const s = cards.get(cardId)
  if (!s) return
  await s.queue
}

/** Add a new element to the card body or relative to a sibling.
 *
 * `onFailure` fires asynchronously (after promise queue settles) if the
 * element was NOT confirmed after transport retries and any TTL reopen.
 * Use it to invalidate
 * any daemon-side reference to the element you tried to add (e.g. a segment
 * id), so subsequent writes don't keep PUTting content to a phantom element
 * that Feishu will silently reject. Default (no callback) preserves the
 * legacy fire-and-forget swallow behavior. */
export function addElement(
  cardId: string,
  element: object,
  opts: ElementPlacement = {},
  onFailure?: (code?: number, failure?: CardWriteFailure) => void,
): Promise<void> {
  if (isDisposed(cardId)) return Promise.resolve()
  const s = state(cardId)
  if (s.closing) return Promise.resolve()
  const safeElement = neutralizeMarkdownImagesInCard(element)
  const elementId = (safeElement as { element_id?: string }).element_id
  const fingerprint = contentFingerprint(safeElement)
  const missing = () => {
    if (!elementId) return
    markElementDead(s, elementId)
    s.failedAdds.set(elementId, opts)
  }
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `addElement`,
    async () => {
      const seq = nextSeq(cardId)
      await call('POST', `/cards/${cardId}/elements`, {
        type: opts.type ?? 'append',
        ...(opts.targetElementId ? { target_element_id: opts.targetElementId } : {}),
        elements: JSON.stringify([safeElement]),
        sequence: seq,
      })
      // Only bump after the API returns 0 — any rejected add will
      // bypass this line, so the count tracks "elements Feishu actually
      // accepted" not "elements we tried to push".
      s.elementCount += 1
      if (elementId !== ELEMENTS.footer) s.contentFingerprints.set(elementId ?? `#${seq}`, fingerprint)
      if (elementId) {
        s.deadElements.delete(elementId)
        s.failedAdds.delete(elementId)
        s.failedReplacements.delete(elementId)
      }
    },
    (failure) => {
      // Retain the missing add's placement. A later tool result must create
      // its latest content rather than PUT a phantom ID or be discarded.
      missing()
      onFailure?.(failure.code, failure)
    },
    false,
    { elementId, targetElementId: opts.targetElementId, contentFingerprint: fingerprint },
  ))
  return s.queue
}

/** Replace an entire element (used to swap a tool placeholder with its result). */
export function replaceElement(
  cardId: string,
  elementId: string,
  element: object,
  onFailure?: (code?: number, failure?: CardWriteFailure) => void,
  notifyCardFailure = true,
): Promise<void> {
  if (isDisposed(cardId)) return Promise.resolve()
  const s = state(cardId)
  if (s.closing) return Promise.resolve()
  const safeElement = neutralizeMarkdownImagesInCard(element)
  const fingerprint = contentFingerprint(safeElement)
  const rejected = () => {
    markElementDead(s, elementId)
    s.failedReplacements.add(elementId)
  }
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `replaceElement ${elementId}`,
    async () => {
      const missing = s.failedAdds.get(elementId)
      if (s.deadElements.has(elementId) && !missing && !s.failedReplacements.has(elementId)) return
      const seq = nextSeq(cardId)
      if (missing) {
        await call('POST', `/cards/${cardId}/elements`, {
          type: missing.type ?? 'append',
          ...(missing.targetElementId ? { target_element_id: missing.targetElementId } : {}),
          elements: JSON.stringify([safeElement]),
          sequence: seq,
        })
        s.elementCount++
      } else {
        await call('PUT', `/cards/${cardId}/elements/${elementId}`, {
          element: JSON.stringify(safeElement),
          sequence: seq,
        })
      }
      s.deadElements.delete(elementId)
      s.failedAdds.delete(elementId)
      s.failedReplacements.delete(elementId)
      if (elementId !== ELEMENTS.footer) s.contentFingerprints.set(elementId, fingerprint)
    },
    failure => {
      // 工具已完成不代表结果已写入。标记失败的更新，避免换卡时把最新结果
      // 留在旧卡。公式增强等局部事务自行处理失败，保留原始元素可写。
      if (notifyCardFailure) rejected()
      onFailure?.(failure.code, failure)
    },
    !notifyCardFailure,
    { elementId, contentFingerprint: fingerprint },
  ))
  return s.queue
}

/** Checked variants for callers that must know whether the write actually
 *  landed (math render: only mark a segment "rendered" when every write
 *  succeeded — a false marker would swallow the formula entirely, review #4).
 *  Resolves false on: card disposed, element deleted, or the
 *  API call failing after retries. Never throws. */
export async function replaceElementChecked(
  cardId: string,
  elementId: string,
  element: object,
  opts: { notifyCardFailure?: boolean } = {},
): Promise<boolean> {
  if (isDisposed(cardId)) return false
  const s = state(cardId)
  if (s.closing) return false
  let failed = false
  await replaceElement(
    cardId,
    elementId,
    element,
    () => { failed = true },
    opts.notifyCardFailure !== false,
  )
  return !failed && !s.deadElements.has(elementId)
}

/** Preserve failure classification for callers that rotate only on capacity. */
export async function replaceElementResult(cardId: string, elementId: string, element: object): Promise<CardWriteResult> {
  if (isDisposed(cardId)) return { landed: false }
  const s = state(cardId)
  if (s.closing) return { landed: false }
  let failure: CardWriteFailure | undefined
  await replaceElement(cardId, elementId, element, (_code, detail) => { failure = detail })
  return { landed: !failure && !s.deadElements.has(elementId), ...(failure ? { failure } : {}) }
}

export async function addElementChecked(
  cardId: string,
  element: object,
  opts: { type?: 'append' | 'insert_before' | 'insert_after'; targetElementId?: string } = {},
): Promise<boolean> {
  return (await addElementResult(cardId, element, opts)).landed
}

export async function addElementResult(
  cardId: string,
  element: object,
  opts: { type?: 'append' | 'insert_before' | 'insert_after'; targetElementId?: string } = {},
): Promise<CardWriteResult> {
  if (isDisposed(cardId)) return { landed: false }
  const s = state(cardId)
  if (s.closing) return { landed: false }
  const elementId = (element as { element_id?: string }).element_id
  let failure: CardWriteFailure | undefined
  await addElement(cardId, element, opts, (_code, detail) => { failure = detail })
  return {
    landed: !failure && !(elementId && s.deadElements.has(elementId)),
    ...(failure ? { failure } : {}),
  }
}

/** Delete an element by id. */
export function deleteElement(
  cardId: string,
  elementId: string,
  onFailure?: (code?: number, failure?: CardWriteFailure) => void,
): Promise<void> {
  if (isDisposed(cardId)) return Promise.resolve()
  const s = state(cardId)
  if (s.closing) return Promise.resolve()
  const deleted = () => s.deadElements.has(elementId)
    && !s.failedAdds.has(elementId) && !s.failedReplacements.has(elementId)
  if (deleted()) return Promise.resolve()
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `deleteElement ${elementId}`,
    async () => {
      if (deleted()) return
      const seq = nextSeq(cardId)
      await call('DELETE', `/cards/${cardId}/elements/${elementId}`, {
        sequence: seq,
      })
      s.elementCount = Math.max(0, s.elementCount - 1)
      s.contentFingerprints.delete(elementId)
      s.failedAdds.delete(elementId)
      s.failedReplacements.delete(elementId)
      markElementDead(s, elementId)
    },
    failure => onFailure?.(failure.code, failure),
    true,
    { elementId },
  ))
  return s.queue
}

export async function deleteElementChecked(
  cardId: string,
  elementId: string,
  onFailure?: (failure: CardWriteFailure) => void,
): Promise<boolean> {
  if (isDisposed(cardId)) return false
  const s = state(cardId)
  if (s.closing) return false
  if (s.deadElements.has(elementId) && !s.failedAdds.has(elementId) && !s.failedReplacements.has(elementId)) return true
  let failed = false
  await deleteElement(cardId, elementId, (_code, failure) => {
    failed = true
    if (failure) onFailure?.(failure)
  })
  return !failed && s.deadElements.has(elementId)
}

/** Throttled card-summary update. The summary text is what Feishu shows
 * in the chat list as the message preview. We coalesce writes on a
 * SUMMARY_FLUSH_MS window so assistant deltas don't blow up
 * the settings-PATCH endpoint. Whitespace is collapsed and the input
 * is trimmed; empty content is ignored. */
export function patchSummaryThrottled(cardId: string, content: string): void {
  if (isDisposed(cardId) || cards.get(cardId)?.closing) return
  const trimmed = (content ?? '').replace(/\s+/g, ' ').trim()
  if (!trimmed) return
  let s = summaryStates.get(cardId)
  if (!s) {
    s = { latest: trimmed, lastSent: '', timer: null }
    summaryStates.set(cardId, s)
  } else {
    s.latest = trimmed
  }
  if (s.timer) return
  s.timer = setTimeout(() => {
    const st = summaryStates.get(cardId)
    if (!st) return
    if (isDisposed(cardId)) { summaryStates.delete(cardId); return }
    st.timer = null
    if (st.latest === st.lastSent) return
    const toSend = st.latest
    void patchSettingsChecked(cardId, { config: { summary: { content: toSend } } })
      .then(landed => {
        const current = summaryStates.get(cardId)
        if (landed && current === st) current.lastSent = toSend
      })
  }, SUMMARY_FLUSH_MS)
}

/** Cancel any pending throttled summary write. Call before emitting
 * a terminal summary (e.g. "✅ ⏱ 12.3s · 4.2K tokens") so a stale
 * in-flight update can't fire after and clobber the final preview. */
export function cancelSummary(cardId: string): void {
  const s = summaryStates.get(cardId)
  if (!s) return
  if (s.timer) { clearTimeout(s.timer); s.timer = null }
  summaryStates.delete(cardId)
}

/** Patch settings — used to flip streaming_mode off when a turn finishes.
 *
 * `nextSeq` is called inside the queued task (not at enqueue time) to
 * match addElement/replaceElement/deleteElement above. Mixing
 * call-time and execution-time seq allocation interleaves badly: a
 * patchSettings enqueued right after a replaceElement would grab the
 * smaller seq number, but the replaceElement's then-block would grab
 * the larger one when it ran first, so the patchSettings PATCH lands
 * with a stale seq and Feishu rejects 300317 "sequence number compare
 * failed". Keeping all writes on execution-time allocation makes the
 * seq order match the queue order. */
export function patchSettings(cardId: string, settings: object): Promise<void> {
  return patchSettingsChecked(cardId, settings).then(() => {})
}

/** Checked settings mutation for terminal/static-card transactions. Unlike
 * the legacy fire-and-forget wrapper, callers can distinguish a landed PATCH
 * from a timeout/rejection and must not dispose bookkeeping on false. */
export async function patchSettingsChecked(
  cardId: string,
  settings: object,
  onFailure?: (failure: CardWriteFailure) => void,
): Promise<boolean> {
  if (isDisposed(cardId)) return false
  const s = state(cardId)
  if (s.closing) return false
  let landed = false
  let failed = false
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    'patchSettings',
    async () => {
      if (isDisposed(cardId)) return
      const seq = nextSeq(cardId)
      await call('PATCH', `/cards/${cardId}/settings`, {
        settings: JSON.stringify(settings),
        sequence: seq,
      })
      landed = true
    },
    failure => { failed = true; onFailure?.(failure) },
    true,
  ))
  await s.queue
  return landed && !failed && !isDisposed(cardId)
}

/** Drop in-memory bookkeeping for a finished card. */
export async function dispose(cardId: string): Promise<void> {
  const s = cards.get(cardId)
  if (!s) {
    cancelSummary(cardId)
    return
  }
  if (s.closing) {
    await s.queue
    return
  }
  // Close the enqueue gate synchronously. Operations already in s.queue are
  // allowed to finish; later callers observe closing and cannot extend it.
  s.closing = true
  cancelSummary(cardId)
  await s.queue
  cards.delete(cardId)
}
