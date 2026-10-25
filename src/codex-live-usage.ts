import { codexAccounts, liveCodexQuotaReaders, watchCodexQuotaReaders, type CodexQuotaReader } from './codex-accounts'
import { refreshUsageFromConnection, type UsageSnapshot } from './usage'
import { logError } from './log'

const POLL_MS = 60_000
const EVENT_COALESCE_MS = 1_000
type Reader = ReturnType<typeof liveCodexQuotaReaders>[number]
type Result = UsageSnapshot | null
interface Dependencies {
  readers(accountId?: string): Reader[]
  watch(listener: () => void): () => void
  revision(accountId: string): string
  refresh(request: (method: string, params: any) => Promise<any>, accountId: string,
    options: { force: boolean; isCurrent(): boolean }): Promise<Result>
  now(): number
  schedule(callback: () => void, delay: number): () => void
  error(error: unknown): void
}
const defaults: Dependencies = {
  readers: liveCodexQuotaReaders, watch: watchCodexQuotaReaders,
  revision: id => codexAccounts.revision(id), refresh: refreshUsageFromConnection,
  now: Date.now,
  schedule(callback, delay) {
    const timer = setTimeout(callback, delay)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
  error: error => logError('codex live quota refresh failed', error),
}
interface AccountRefresh {
  accountId: string
  requested: number
  requestedAt: number
  pending: boolean
  cancelTimer?: () => void
  timerAt?: number
  rechecked?: number
  waiters: Array<{ target: number; resolve(value: Result): void }>
}

/** Account-wide passive refreshes borrow existing native task transports.
 * Neither a missed reader nor a failed read can start a control process. */
export class CodexLiveUsageRefresh {
  private running = false
  private unwatch?: () => void
  private readonly accounts = new Map<string, AccountRefresh>()
  private readonly attached = new Map<CodexQuotaReader, { binding: Reader; signal(): void }>()
  private readonly deps: Dependencies

  constructor(deps: Partial<Dependencies> = {}) { this.deps = { ...defaults, ...deps } }

  start(): void {
    if (this.running) return
    this.running = true
    this.unwatch = this.deps.watch(() => this.reconcile())
    this.reconcile()
  }

  stop(): void {
    this.running = false
    this.unwatch?.(); this.unwatch = undefined
    for (const [reader, entry] of this.attached) this.detach(reader, entry.signal)
    this.attached.clear()
    for (const state of this.accounts.values()) this.retire(state)
    this.accounts.clear()
  }

  private detach(reader: CodexQuotaReader, listener: () => void): void {
    reader.off('rate_limits_updated', listener)
    reader.off('result', listener)
  }

  private reconcile(): void {
    if (!this.running) return
    const readers = this.deps.readers()
    for (const [reader, entry] of this.attached) {
      if (entry.binding.isCurrent() && readers.some(next => next.reader === reader && next.accountId === entry.binding.accountId)) continue
      this.detach(reader, entry.signal); this.attached.delete(reader)
    }
    for (const binding of readers) {
      if (this.attached.has(binding.reader)) continue
      const signal = () => {
        if (binding.isCurrent()) this.signal(binding.accountId, EVENT_COALESCE_MS)
      }
      this.attached.set(binding.reader, { binding, signal })
      binding.reader.on('rate_limits_updated', signal)
      binding.reader.on('result', signal)
    }
    const active = new Set(readers.map(binding => binding.accountId))
    for (const [id, state] of this.accounts) {
      if (active.has(id)) continue
      this.retire(state); this.accounts.delete(id)
    }
    for (const id of active) {
      if (this.accounts.has(id)) continue
      this.accounts.set(id, { accountId: id, requested: 0, requestedAt: this.deps.now(), pending: false, waiters: [] })
      this.signal(id, 0)
    }
  }

  private retire(state: AccountRefresh): void {
    state.cancelTimer?.()
    state.cancelTimer = undefined; state.timerAt = undefined
    for (const waiter of state.waiters.splice(0)) waiter.resolve(null)
  }

  private signal(accountId: string, delay: number): AccountRefresh | undefined {
    const state = this.accounts.get(accountId)
    if (!this.running || !state) return undefined
    state.requested++; state.requestedAt = this.deps.now()
    if (!state.pending) this.schedule(state, delay, false)
    return state
  }

  private schedule(state: AccountRefresh, delay: number, periodic: boolean): void {
    if (!this.running || this.accounts.get(state.accountId) !== state) return
    const at = this.deps.now() + delay
    if (state.timerAt !== undefined && state.timerAt <= at) return
    state.cancelTimer?.(); state.timerAt = at
    state.cancelTimer = this.deps.schedule(() => {
      state.cancelTimer = undefined; state.timerAt = undefined
      if (periodic) { state.requested++; state.requestedAt = this.deps.now() }
      void this.read(state)
    }, delay)
  }

  private async read(state: AccountRefresh): Promise<void> {
    if (!this.running || this.accounts.get(state.accountId) !== state || state.pending) return
    const binding = this.deps.readers(state.accountId)[0]
    if (!binding) { this.reconcile(); return }
    state.pending = true
    const target = state.requested, requestedAt = state.requestedAt
    let result: Result = null
    let current = () => false
    try {
      const revision = this.deps.revision(state.accountId)
      current = () => this.running && this.accounts.get(state.accountId) === state && binding.isCurrent()
        && this.deps.revision(state.accountId) === revision
      result = await this.deps.refresh(async () => {
        if (!current()) throw new Error('Codex live quota binding changed')
        return binding.reader.readRateLimits()
      }, state.accountId, { force: true, isCurrent: current })
      if (!current()) result = null
    } catch (error) { result = null; this.deps.error(error) }
    finally { state.pending = false }
    if (!this.running || this.accounts.get(state.accountId) !== state) return
    // A shared cold read may predate the notification we joined. Re-read once
    // after that request settles; never invalidate the footer's account epoch.
    if (result?.state === 'ok' && result.readStartedAt !== undefined && result.readStartedAt < requestedAt
      && state.rechecked !== target) {
      state.rechecked = target
      this.schedule(state, EVENT_COALESCE_MS, false)
      return
    }
    if (!binding.isCurrent() && this.deps.readers(state.accountId).length) {
      this.schedule(state, EVENT_COALESCE_MS, false)
      return
    }
    // Failure settles all current waiters. The shared UsageReadCache keeps
    // its original failure cooldown, even when another signal arrives early.
    const successful = result?.state === 'ok'
    const settled = successful ? target : state.requested
    const pending = state.waiters.filter(waiter => waiter.target > settled)
    for (const waiter of state.waiters) if (waiter.target <= settled) waiter.resolve(result)
    state.waiters = pending
    if (successful && state.requested > target) this.schedule(state, EVENT_COALESCE_MS, false)
    else this.schedule(state, POLL_MS, true)
  }

  /** Wait only for the request generation this caller asks for, not future
   * work continually arriving from other turns sharing the same account. */
  refresh(accountId: string): Promise<Result> {
    if (!this.running) return Promise.resolve(null)
    this.reconcile()
    const state = this.signal(accountId, 0)
    if (!state) return Promise.resolve(null)
    return new Promise(resolve => { state.waiters.push({ target: state.requested, resolve }) })
  }

  async wait(accountId: string, timeoutMs = 5_000): Promise<void> {
    let cancelTimeout: (() => void) | undefined
    try {
      await Promise.race([
        this.refresh(accountId),
        new Promise<null>(resolve => { cancelTimeout = this.deps.schedule(() => resolve(null), timeoutMs) }),
      ])
    } catch (error) { this.deps.error(error) }
    finally { cancelTimeout?.() }
  }
}

const refreshes = new CodexLiveUsageRefresh()
export function startCodexLiveUsageRefresh(): void { refreshes.start() }
export function stopCodexLiveUsageRefresh(): void { refreshes.stop() }
export function refreshLiveCodexUsage(accountId: string): Promise<Result> { return refreshes.refresh(accountId) }
export function waitForLiveCodexUsage(accountId: string, timeoutMs = 5_000): Promise<void> { return refreshes.wait(accountId, timeoutMs) }
