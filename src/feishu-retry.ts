import { log } from './log'
import { feishuErrorDetails, formatFeishuError } from './feishu-errors'

const RETRY_DELAYS_MS = [1000, 4000]
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

function isTransient(error: any): boolean {
  if (!error || typeof error !== 'object') return false
  const { status, code } = feishuErrorDetails(error)
  // Drive explicitly marks 1061045 as retryable; rate limits may also use HTTP 400.
  if (code === 99991400 || code === 230020 || code === 1061045
    || (status !== undefined && TRANSIENT_HTTP_STATUS.has(status))) return true
  if (typeof status === 'number' && status >= 400) return false
  if ((typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) || error.name === 'TimeoutError') return true
  // Native fetch wraps socket errors in cause; do not retry arbitrary TypeErrors,
  // caller cancellation, certificate failures, local I/O or configuration errors.
  return error.cause !== error && isTransient(error.cause)
}

function retryAfterMs(error: any): number {
  const value = feishuErrorDetails(error).retryAfter
  if (typeof value !== 'string' || !value.trim()) return 0
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(delay) ? Math.max(0, delay) : 0
}

/** Retry the same operation, at most three attempts. Callers must make message
 * creation idempotent and recreate consumed upload bodies on each attempt. */
export async function withFeishuRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation() }
    catch (error) {
      const delay = Math.max(RETRY_DELAYS_MS[attempt] ?? 0, retryAfterMs(error))
      const retry = isTransient(error) && attempt < RETRY_DELAYS_MS.length && delay <= 60_000
      log(`feishu: ${label} attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1} failed: ${formatFeishuError(error)}; ${retry ? `retry in ${delay}ms` : 'FINAL'}`)
      if (!retry) {
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
      await new Promise(resolve => setTimeout(resolve, delay))
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
