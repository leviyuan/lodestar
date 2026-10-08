import { log } from './log'
import { feishuErrorDetails, formatFeishuError } from './feishu-errors'

const RETRY_DELAYS_MS = [1000, 4000]
const RECOVERY_DELAYS_MS = [3000, 8000, 15000]
const TRANSIENT_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504])
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'ConnectionRefused', // Bun fetch uses this instead of Node's ECONNREFUSED.
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
])

export class FeishuRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number | string,
    readonly retryAfter?: string | null,
    readonly logId?: string,
    readonly apiMessage: string = message,
  ) {
    super(message)
    this.name = 'FeishuRequestError'
  }
}

export interface FeishuRetryOptions {
  api?: 'cardkit'
  recovery?: FeishuRecoveryWindow
}

export function isTransientFeishuError(error: unknown, options: FeishuRetryOptions = {}): boolean {
  if (!error || typeof error !== 'object') return false
  const { status, code, message } = feishuErrorDetails(error)
  // Card Kit can return HTTP 200 for its internal server failure. Keep this
  // observed code/message pair scoped to Card Kit; other 300xxx rejections
  // (parameters, permissions, layout and sequence) remain permanent.
  if (options.api === 'cardkit' && (code === 300308 || code === '300308')
    && /^server internal error[.!]?$/i.test(message.trim())) return true
  // Drive explicitly marks 1061045 as retryable; rate limits may also use HTTP 400.
  if (code === 99991400 || code === 230020 || code === 1061045
    || (status !== undefined && TRANSIENT_HTTP_STATUS.has(status))) return true
  if (typeof status === 'number' && status >= 400) return false
  if ((typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code))
    || ('name' in error && error.name === 'TimeoutError')) return true
  // Native fetch wraps socket errors in cause; do not retry arbitrary TypeErrors,
  // caller cancellation, certificate failures, local I/O or configuration errors.
  return 'cause' in error && error.cause !== error && isTransientFeishuError(error.cause, options)
}

export function feishuRetryAfterMs(error: unknown): number {
  const value = feishuErrorDetails(error).retryAfter
  if (typeof value !== 'string' || !value.trim()) return 0
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(delay) ? Math.max(0, delay) : 0
}

/** One output operation, including transport retries and explicit reconciliation,
 * shares this deadline. Callers must also cap each request with timeoutMs(). */
export class FeishuRecoveryWindow {
  private readonly deadline = Date.now() + 60_000
  private retries = 0
  private lastFailure: unknown

  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now())
  }

  timeoutMs(maxMs: number): number {
    const remaining = this.remainingMs()
    if (remaining <= 0) {
      throw this.lastFailure ?? new DOMException('Feishu output recovery window expired', 'TimeoutError')
    }
    return Math.min(maxMs, remaining)
  }

  async waitUntilDeadline(): Promise<void> {
    while (this.remainingMs() > 0) {
      await new Promise(resolve => setTimeout(resolve, this.remainingMs()))
    }
  }

  async waitForRetry(label: string, error: unknown, minimumDelayMs = 0): Promise<boolean> {
    this.lastFailure = error
    const remaining = this.remainingMs()
    if (remaining <= 0) return false
    const backoff = RECOVERY_DELAYS_MS[Math.min(this.retries++, RECOVERY_DELAYS_MS.length - 1)]!
    const delay = Math.max(backoff, minimumDelayMs, feishuRetryAfterMs(error))
    const retryAt = Date.now() + delay
    const retryFits = retryAt < this.deadline
    log(`feishu: ${label} failed: ${formatFeishuError(error)}; ${retryFits
      ? `retry in ${delay}ms (recovery remaining ${remaining}ms)`
      : `waiting ${remaining}ms for recovery deadline; next retry requires ${delay}ms`}`)
    const wakeAt = Math.min(this.deadline, retryAt)
    // Recheck the clock after waking so an early timer cannot skip Retry-After
    // or cause a final failure notification before the shared deadline.
    while (Date.now() < wakeAt) {
      await new Promise(resolve => setTimeout(resolve, wakeAt - Date.now()))
    }
    return retryFits && this.remainingMs() > 0
  }
}

/** Retry a known transient failure until an explicitly shared recovery window
 * expires, or use the default three-attempt policy when no window was supplied.
 * Callers must make message creation idempotent and recreate upload bodies. */
export async function withFeishuRetry<T>(
  label: string, operation: () => Promise<T>, options: FeishuRetryOptions = {},
): Promise<T> {
  const startedAt = Date.now()
  for (let attempt = 0; ; attempt++) {
    options.recovery?.timeoutMs(60_000)
    try {
      const result = await operation()
      if (attempt > 0) log(`feishu: ${label} recovered: attempts=${attempt + 1} elapsed=${Date.now() - startedAt}ms`)
      return result
    }
    catch (error) {
      const transient = isTransientFeishuError(error, options)
      if (options.recovery) {
        if (transient && await options.recovery.waitForRetry(label, error)) continue
        log(`feishu: ${label} attempt ${attempt + 1} failed: ${formatFeishuError(error)}; FINAL`)
      } else {
        const delay = Math.max(RETRY_DELAYS_MS[attempt] ?? 0, feishuRetryAfterMs(error))
        const retry = transient && attempt < RETRY_DELAYS_MS.length && delay <= 60_000
        log(`feishu: ${label} attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1} failed: ${formatFeishuError(error)}; ${retry ? `retry in ${delay}ms` : 'FINAL'}`)
        if (retry) {
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }
      }
      // SDK HTTP exceptions often expose only "Request failed with status ..."
      // through Error.message. Preserve Feishu's body diagnostics for callers.
      if (!(error instanceof FeishuRequestError) && error && typeof error === 'object' && 'response' in error) {
        const details = feishuErrorDetails(error)
        const failure = new FeishuRequestError(`${label}: ${formatFeishuError(error)}`,
          details.status, details.code, details.retryAfter, details.logId, details.message)
        failure.cause = error
        throw failure
      }
      throw error
    }
  }
}

/** Keep HTTP failures (including non-JSON gateway responses) distinguishable
 * from permanent API rejections and malformed success responses. */
export async function readFeishuResponse(response: Response, label: string): Promise<any> {
  const raw = await response.text()
  const retryAfter = response.headers.get('retry-after') ?? response.headers.get('x-ogw-ratelimit-reset')
  const headerDetails = feishuErrorDetails({ headers: response.headers })
  let data: any
  try { data = JSON.parse(raw) }
  catch {
    const message = `invalid JSON — ${raw.slice(0, 200)}`
    const details = { message, logId: headerDetails.logId }
    throw new FeishuRequestError(`${label} HTTP ${response.status}: ${formatFeishuError(details)}`,
      response.status, undefined, retryAfter, details.logId, message)
  }
  if (!response.ok || data?.code !== 0) {
    const details = feishuErrorDetails({ response: { data, headers: response.headers, status: response.status } })
    throw new FeishuRequestError(`${label} HTTP ${response.status}: ${formatFeishuError(details)}`,
      response.status, details.code, retryAfter, details.logId, details.message)
  }
  return data
}
