export type ActionClaim = 'started' | 'inflight' | 'completed'
export type ActionCompletion = 'complete' | 'retry'

export type ActorEnqueueResult<T> =
  | { accepted: true; completion: Promise<T> }
  | { accepted: false; reason: 'closed' | 'invalid-key' }

export const SUPPORTED_CARD_ACTION_KINDS = new Set([
  'permission', 'menu', 'provider_select', 'model_select', 'model_custom_prompt',
  'model_panel_cancel', 'model_effort_select', 'ask', 'worktree_disband',
  'temp_fork_select', 'temp_back_select', 'temp_resume_select', 'tasklist_enable',
  'tasklist_delete_prompt', 'tasklist_delete_confirm', 'token_source_enable',
  'agent_identity_page', 'model_page', 'notify_callback', 'notify_reply', 'notify_reply_cancel',
  'model_list_open', 'model_add', 'model_remove', 'model_custom_remove',
])

/** Admission validation runs synchronously before actor/dedupe reservation;
 * malformed callbacks must never reach business handlers. */
export function validateCardActionAdmission(data: any): string | null {
  const value = data?.action?.value ?? {}
  const kind = String(value.kind ?? '')
  if (!kind) return '无效操作'
  if (!SUPPORTED_CARD_ACTION_KINDS.has(kind)) return `不支持的操作: ${kind}`
  const notification = kind === 'notify_callback' || kind === 'notify_reply' || kind === 'notify_reply_cancel'
  if (!notification && !String(data?.context?.open_chat_id ?? '')) {
    return '回调缺少 chat_id，操作未执行'
  }
  if (!notification && !String(data?.context?.open_message_id ?? '')) {
    return '回调缺少原卡 message_id，操作未执行'
  }
  if (kind === 'permission' && !['allow', 'allow_always', 'deny'].includes(String(value.decision ?? ''))) {
    return '无效的权限决定，操作未执行'
  }
  return null
}

/** Per-key actor used by both chat messages and card actions. Each key is
 * strictly FIFO while unrelated chats remain concurrent. */
export class PerKeyActor {
  private readonly tails = new Map<string, Promise<void>>()
  private accepting = true

  tryEnqueue<T>(keyRaw: string, task: () => Promise<T>): ActorEnqueueResult<T> {
    if (!this.accepting) return { accepted: false, reason: 'closed' }
    const key = keyRaw.trim()
    if (!key) return { accepted: false, reason: 'invalid-key' }
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(task)
    let tail!: Promise<void>
    tail = result.then(
      () => {},
      () => {},
    ).finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    this.tails.set(key, tail)
    return { accepted: true, completion: result }
  }

  enqueue<T>(keyRaw: string, task: () => Promise<T>): Promise<T> {
    const admitted = this.tryEnqueue(keyRaw, task)
    return admitted.accepted
      ? admitted.completion
      : Promise.reject(new Error(`per-key actor ${admitted.reason}`))
  }

  /** Stop accepting new roots synchronously. Already-admitted tails keep
   * running and remain visible through pending() for shutdown drain. */
  close(): void {
    this.accepting = false
  }

  isAccepting(): boolean {
    return this.accepting
  }

  pending(): Iterable<Promise<void>> {
    return this.tails.values()
  }
}

export interface PerChatAdmission<TData> {
  accept(data: TData): ActorEnqueueResult<void>
}

/** Minimal message-side ingress using the same actor as card actions. Capture
 * arrival time before queueing so FIFO delay never makes a fresh event stale. */
export function createPerChatAdmission<TData>(deps: {
  actor: PerKeyActor
  key(data: TData): string
  execute(data: TData, acceptedAt: number): Promise<void>
  now?: () => number
}): PerChatAdmission<TData> {
  const now = deps.now ?? Date.now
  return {
    accept(data: TData): ActorEnqueueResult<void> {
      const acceptedAt = now()
      return deps.actor.tryEnqueue(
        deps.key(data),
        () => deps.execute(data, acceptedAt),
      )
    },
  }
}

/** Short-lived in-memory idempotency for Feishu callback retries and rapid
 * double-clicks. Failed handlers may be retried; completed actions remain
 * suppressed only for the configured TTL. */
export class ActionDeduper {
  private readonly inflight = new Set<string>()
  private readonly completed = new Map<string, number>()

  constructor(
    private readonly completedTtlMs = 30_000,
    private readonly now: () => number = Date.now,
    private readonly maxCompletedEntries = 4096,
  ) {}

  claim(key: string): ActionClaim {
    return this.claimAll([key])
  }

  claimAll(keys: string[]): ActionClaim {
    this.prune()
    if (keys.some(key => this.inflight.has(key))) return 'inflight'
    if (keys.some(key => this.completed.has(key))) return 'completed'
    for (const key of keys) this.inflight.add(key)
    return 'started'
  }

  complete(key: string): void {
    this.completeAll([key])
  }

  completeAll(keys: string[]): void {
    this.prune()
    const expiresAt = this.now() + this.completedTtlMs
    for (const key of keys) {
      this.inflight.delete(key)
      // Refresh insertion order so bounded eviction removes the oldest claim.
      this.completed.delete(key)
      this.completed.set(key, expiresAt)
    }
    while (this.completed.size > this.maxCompletedEntries) {
      const oldest = this.completed.keys().next().value
      if (oldest === undefined) break
      this.completed.delete(oldest)
    }
  }

  fail(key: string): void {
    this.failAll([key])
  }

  failAll(keys: string[]): void {
    for (const key of keys) this.inflight.delete(key)
  }

  private prune(): void {
    const now = this.now()
    for (const [key, expiresAt] of this.completed) {
      if (expiresAt <= now) this.completed.delete(key)
    }
  }
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value === undefined) return 'undefined'
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(',')}}`
}

/** One logical choice per visible action stage. Choice values themselves are
 * deliberately omitted for one-shot panels, so two different buttons clicked
 * rapidly cannot both execute. Resource identifiers remain for cards that
 * contain several independent rows/questions. */
function cardActionSemanticKey(data: any): string {
  const value = data?.action?.value ?? {}
  const kind = String(value?.kind ?? 'unknown')
  const chatId = String(data?.context?.open_chat_id ?? '')
  const messageId = String(data?.context?.open_message_id ?? '')
  let resource: unknown = null
  switch (kind) {
    case 'menu': resource = { request_id: value.request_id }; break
    case 'permission': resource = { request_id: value.request_id }; break
    case 'ask': resource = { tool_use_id: value.tool_use_id, question_idx: value.question_idx }; break
    case 'worktree_disband': resource = { slug: value.slug }; break
    case 'temp_fork_select':
    case 'temp_back_select':
    case 'temp_resume_select': resource = { panel_id: value.panel_id }; break
    case 'tasklist_delete_prompt':
    case 'tasklist_delete_confirm': resource = { guid: value.guid }; break
    case 'tasklist_enable': resource = { guid: value.guid, project: value.project, panel_id: value.panel_id }; break
    case 'token_source_enable': resource = { source_id: value.source_id }; break
    case 'agent_identity_page': resource = { panel_id: value.panel_id, page: value.page }; break
    case 'model_page': resource = { panel_id: value.panel_id, source_id: value.source_id, page: value.page }; break
    case 'model_list_open': resource = { panel_id: value.panel_id, source_id: value.source_id, mode: value.mode }; break
    case 'model_add':
    case 'model_remove':
    case 'model_custom_remove': resource = { panel_id: value.panel_id, source_id: value.source_id, model: value.model }; break
    case 'notify_callback': resource = { notify_id: value.notify_id }; break
    case 'notify_reply': resource = { notify_id: value.notify_id }; break
    case 'notify_reply_cancel': resource = { notify_id: value.notify_id, reply_id: value.reply_id }; break
    case 'provider_select':
    case 'model_select':
    case 'model_custom_prompt':
    case 'model_panel_cancel':
    case 'model_effort_select': resource = { panel_id: value.panel_id }; break
    default: resource = value
  }
  return `${chatId}\u0000${messageId}\u0000${kind}\u0000${stableValue(resource)}`
}

export interface CardActionDedupeIdentity {
  deliveryKey?: string
  businessKey: string
  repeatable?: boolean
}

export function cardActionDedupeIdentity(data: any): CardActionDedupeIdentity {
  const eventId = String(
    data?.event_id
    ?? data?.header?.event_id
    ?? data?.event?.event_id
    ?? '',
  )
  return {
    ...(eventId ? { deliveryKey: `event\u0000${eventId}` } : {}),
    businessKey: `semantic\u0000${cardActionSemanticKey(data)}`,
    ...(['agent_identity_page', 'model_page', 'model_list_open', 'model_add', 'model_remove', 'model_custom_remove', 'notify_reply'].includes(data?.action?.value?.kind) ? { repeatable: true } : {}),
  }
}

export function cardActionDedupeKeys(data: any): string[] {
  const identity = cardActionDedupeIdentity(data)
  return identity.deliveryKey
    ? [identity.deliveryKey, identity.businessKey]
    : [identity.businessKey]
}

export function cardActionDedupeKey(data: any): string {
  return cardActionDedupeKeys(data).at(-1)!
}

/** Ensure the dispatcher can resolve and the SDK can send its toast ACK before
 * any queued handler is allowed to patch the original card. */
export function afterCardActionAck(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

export interface CardActionAdmissionResponses<TResponse> {
  accepted(data: any): TResponse
  inflight(data: any): TResponse
  completed(data: any): TResponse
  closed(data: any): TResponse
  invalid(data: any, message: string): TResponse
}

export interface CardActionAdmissionDeps<TResult, TResponse> {
  actor: PerKeyActor
  deduper: ActionDeduper
  /** Ordinary actions use chat_id; callback-only notifications may supply a
   * dedicated non-empty scope when Feishu omitted chat context. */
  scope(data: any): string
  execute(data: any): Promise<TResult>
  present(data: any, result: TResult): Promise<void>
  presentExecutionFailure(data: any, error: unknown): Promise<void>
  presentPresentationFailure(data: any, error: unknown): Promise<void>
  businessSucceeded(data: any, result: TResult): boolean
  completion(data: any, result: TResult): Promise<ActionCompletion> | null
  track(work: Promise<unknown>): void
  afterAck?: () => Promise<void>
  onBackgroundError?: (error: unknown) => void
  responses: CardActionAdmissionResponses<TResponse>
}

export interface CardActionAdmission<TResponse> {
  /** Synchronous admission: validates, claims idempotency keys and registers
   * the complete actor promise before returning the Feishu ACK. */
  accept(data: any): TResponse
}

function settleAction(
  deduper: ActionDeduper,
  identity: CardActionDedupeIdentity,
  businessCompleted: boolean,
): void {
  if (identity.deliveryKey) deduper.complete(identity.deliveryKey)
  if (businessCompleted && !identity.repeatable) deduper.complete(identity.businessKey)
  else deduper.fail(identity.businessKey)
}

/** Admission/runtime split for card actions. The module owns concurrency and
 * idempotency only; daemon injects the existing business handler, presentation
 * and user-visible response text. */
export function createCardActionAdmission<TResult, TResponse>(
  deps: CardActionAdmissionDeps<TResult, TResponse>,
): CardActionAdmission<TResponse> {
  const afterAck = deps.afterAck ?? afterCardActionAck
  const report = (error: unknown) => {
    try { deps.onBackgroundError?.(error) } catch { /* reporting is best effort */ }
  }
  const bestEffort = async (work: () => Promise<void>): Promise<void> => {
    try { await work() } catch (error) { report(error) }
  }

  return {
    accept(data: any): TResponse {
      if (!deps.actor.isAccepting()) return deps.responses.closed(data)
      const admissionError = validateCardActionAdmission(data)
      if (admissionError) return deps.responses.invalid(data, admissionError)

      const identity = cardActionDedupeIdentity(data)
      const keys = identity.deliveryKey
        ? [identity.deliveryKey, identity.businessKey]
        : [identity.businessKey]
      const claim = deps.deduper.claimAll(keys)
      if (claim === 'inflight') return deps.responses.inflight(data)
      if (claim === 'completed') return deps.responses.completed(data)

      const admitted = deps.actor.tryEnqueue(deps.scope(data), async () => {
        try {
          await afterAck()
        } catch (error) {
          deps.deduper.failAll(keys)
          report(error)
          return
        }

        let result: TResult
        try {
          result = await deps.execute(data)
        } catch (error) {
          // The handler may have thrown after an external side effect. Keep a
          // short tombstone for both keys rather than risking destructive replay.
          settleAction(deps.deduper, identity, true)
          await bestEffort(() => deps.presentExecutionFailure(data, error))
          return
        }

        await bestEffort(async () => {
          try {
            await deps.present(data, result)
          } catch (error) {
            await deps.presentPresentationFailure(data, error)
          }
        })

        let completion: Promise<ActionCompletion> | null
        try {
          completion = deps.completion(data, result)
        } catch (error) {
          settleAction(deps.deduper, identity, false)
          report(error)
          return
        }
        if (completion) {
          const settlement = completion.then(
            outcome => { settleAction(deps.deduper, identity, outcome === 'complete') },
            error => {
              settleAction(deps.deduper, identity, false)
              report(error)
            },
          )
          deps.track(settlement)
          return
        }

        settleAction(deps.deduper, identity, deps.businessSucceeded(data, result))
      })

      if (!admitted.accepted) {
        deps.deduper.failAll(keys)
        return deps.responses.closed(data)
      }
      deps.track(admitted.completion)
      void admitted.completion.catch(report)
      return deps.responses.accepted(data)
    },
  }
}
