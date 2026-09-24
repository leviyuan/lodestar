import { createHash } from 'node:crypto'

export const USAGE_FRESH_MS = 60_000
export const USAGE_MAX_COOLDOWN_MS = 5 * 60_000

interface UsageResult {
  state: string
  reason?: string
  retryAfterMs?: number
}
interface Entry<T> {
  value?: T
  /** The last authoritative successful snapshot survives transient failures. */
  successfulValue?: T
  error?: unknown
  failed: boolean
  failures: number
  retryAt: number
  pending?: Promise<T>
}

/** Lazy account reads: one request at a time, one minute freshness, bounded failure backoff. */
export class UsageReadCache<T extends UsageResult> {
  private readonly entries = new Map<string, Entry<T>>()
  constructor(private readonly now: () => number = () => Date.now()) {}

  read(key: string, load: () => Promise<T>): Promise<T> {
    let entry = this.entries.get(key)
    if (entry?.pending) return entry.pending
    if (entry && this.now() < entry.retryAt) {
      return entry.failed ? Promise.reject(entry.error) : Promise.resolve(entry.value!)
    }
    entry ??= { failed: false, failures: 0, retryAt: 0 }
    this.entries.set(key, entry)
    const current = entry
    const finish = (ok: boolean, retryAfterMs = 0) => {
      current.failures = ok ? 0 : current.failures + 1
      const delay = ok ? USAGE_FRESH_MS
        : Math.min(USAGE_MAX_COOLDOWN_MS, USAGE_FRESH_MS * 2 ** Math.min(current.failures - 1, 3))
      current.retryAt = this.now() + Math.max(delay, Number.isFinite(retryAfterMs) ? retryAfterMs : 0)
    }
    const pending = Promise.resolve().then(load).then(value => {
      if (this.entries.get(key) === current) {
        current.value = value
        if (value.state === 'ok') current.successfulValue = value
        else if (value.state === 'no_credentials' || value.state === 'auth_failed' || isUsageAuthError(value.reason)) current.successfulValue = undefined
        current.failed = false
        current.error = undefined
        finish(value.state === 'ok' || value.state === 'not_applicable', value.retryAfterMs)
      }
      return value
    }, error => {
      if (this.entries.get(key) === current) {
        current.value = undefined
        if (isUsageAuthError(error)) current.successfulValue = undefined
        current.failed = true
        current.error = error
        finish(false, Number((error as { retryAfterMs?: number })?.retryAfterMs))
      }
      throw error
    }).finally(() => { if (current.pending === pending) current.pending = undefined })
    current.pending = pending
    return pending
  }

  /**
   * Read a quota/balance while keeping the last successful value visible when
   * a transient refresh fails. The underlying read still returns its failure
   * to callers that need to make a live decision; this helper is for displays
   * that must remain populated during a timeout or short outage.
   */
  readStale(key: string, load: () => Promise<T>): Promise<T> {
    return this.read(key, load).then(value => {
      if (value.state === 'ok') return value
      const stale = this.peekSuccessful(key)
      return stale && (value.state === 'network' || value.state === 'rate_limited') && !isUsageAuthError(value.reason) ? stale : value
    }).catch(error => {
      const stale = this.peekSuccessful(key)
      if (stale && isUsageTransientError(error)) return stale
      throw error
    })
  }

  /** Return the last successful value without starting or extending a read. */
  peekSuccessful(key: string): T | undefined {
    return this.entries.get(key)?.successfulValue
  }

  prime(key: string, value: T): void {
    this.entries.set(key, {
      value,
      ...(value.state === 'ok' ? { successfulValue: value } : {}),
      failed: false,
      failures: 0,
      retryAt: this.now() + USAGE_FRESH_MS,
    })
  }

  invalidate(key: string): void { this.entries.delete(key) }
  clear(): void { this.entries.clear() }
}

function isUsageTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /abort|timed? ?out|timeout|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection (?:reset|closed)|\b(?:408|429|500|502|503|504)\b/i.test(message)
}

/** Authentication loss invalidates both model and quota snapshots, regardless of error shape. */
export function isUsageAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /\b(?:401|403)\b|unauthori[sz]ed|authentication (?:failed|required)|not authenticated|not logged in|未登录|not (?:a )?first[- ]party|subscription (?:expired|missing)|(?:invalid|expired|revoked).*(?:key|token)|(?:key|token).*(?:invalid|expired|revoked)|认证(?:失败|失效|不是)|(?:不是|非).*(?:第一方|订阅)/i.test(message)
}

/** Only a credential hash becomes a cache key; protocol paths on the same service share quota. */
export function usageCredentialKey(service: string, endpoint: string, credential: string): string {
  return createHash('sha256').update(JSON.stringify([service, endpoint, credential])).digest('hex')
}

export function usageRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined
}

export function isUsageRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b429\b|too many requests|\brate[ _-]?limit(?:ed|[ _-](?:exceeded|reached))\b/i.test(message)
}
