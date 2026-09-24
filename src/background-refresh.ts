import { log } from './log'

const resources = new Set<BackgroundRefresh>()
let running = false

/** A refresh owns its I/O; readers never receive or await this promise. */
export class BackgroundRefresh {
  private pending: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private dueAt: number
  private failures = 0
  private retired = false

  constructor(readonly label: string, private readonly interval: number,
    private readonly load: () => Promise<void>, dueAt = 0) {
    this.dueAt = dueAt
    resources.add(this)
    this.schedule()
  }

  get nextRefreshAt(): number { return this.dueAt }

  refresh(): Promise<void> {
    if (this.retired) return Promise.resolve()
    if (this.pending) return this.pending
    clearTimeout(this.timer)
    const pending = Promise.resolve().then(() => this.retired ? undefined : this.load()).then(() => {
      this.failures = 0
      this.dueAt = Date.now() + this.interval
    }, error => {
      this.failures++
      const retryAfter = Number((error as { retryAfterMs?: number })?.retryAfterMs)
      this.dueAt = Date.now() + Math.max(
        Math.min(300_000, 60_000 * 2 ** Math.min(this.failures - 1, 3)),
        Number.isFinite(retryAfter) ? retryAfter : 0,
      )
      log(`${this.label} refresh MISS: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined
      this.schedule()
    })
    this.pending = pending
    return pending
  }

  schedule(): void {
    clearTimeout(this.timer)
    if (!running || this.retired || this.pending) return
    this.timer = setTimeout(() => {
      // The error is recorded above; cached readers keep their own explicit state.
      void this.refresh().catch(() => {})
    }, Math.max(0, this.dueAt - Date.now()))
    this.timer.unref?.()
  }

  dispose(): void {
    this.retired = true
    clearTimeout(this.timer)
    resources.delete(this)
  }
}

export function startBackgroundRefresh(): void {
  running = true
  for (const resource of resources) resource.schedule()
}

export function stopBackgroundRefresh(): void {
  running = false
  for (const resource of resources) resource.schedule()
}
