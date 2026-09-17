import { createHash } from 'node:crypto'

export const USAGE_FRESH_MS = 60_000
export const USAGE_MAX_COOLDOWN_MS = 5 * 60_000

interface UsageResult {
  state: string
  retryAfterMs?: number
}
interface Entry<T> {
  value?: T
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
        current.failed = false
        current.error = undefined
        finish(value.state === 'ok' || value.state === 'not_applicable', value.retryAfterMs)
      }
      return value
    }, error => {
      if (this.entries.get(key) === current) {
        current.value = undefined
        current.failed = true
        current.error = error
        finish(false)
      }
      throw error
    }).finally(() => { if (current.pending === pending) current.pending = undefined })
    current.pending = pending
    return pending
  }

  prime(key: string, value: T): void {
    this.entries.set(key, { value, failed: false, failures: 0, retryAt: this.now() + USAGE_FRESH_MS })
  }

  invalidate(key: string): void { this.entries.delete(key) }
  clear(): void { this.entries.clear() }
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
