import { codexAccounts, isCodexLoginPending } from './codex-accounts'
import { codexAccountScheduler } from './codex-account-scheduler'
import { activateCodexAccount, activationEffort, closeCodexActivationClients, CODEX_ACTIVATION_MODEL, isUnusedMainWeek,
  type ActivationRequestOptions, type CodexActivationUsage } from './codex-activation-request'
import { log } from './log'
import { getTokenSourceForAccount, type TokenSource } from './token-source'
import { peekSuccessfulUsage } from './usage'

const MIN_DELAY_MS = 30 * 60_000
const MAX_DELAY_MS = 60 * 60_000
const SCAN_MS = 60_000

interface Account {
  id: string
  name: string
  revision: string
  usage: CodexActivationUsage | null
}
interface Pending {
  accountId: string
  revision: string
  dueAt: number
  completed: boolean
  error?: string
}
interface Deps {
  accounts(): Account[]
  source(id: string): TokenSource | undefined
  loginPending(id: string): boolean
  used(identity: string, usage: CodexActivationUsage): boolean
  recordUsage(id: string, usage: CodexActivationUsage): void
  activate(opts: ActivationRequestOptions): Promise<'sent' | 'skipped'>
  now(): number
  random(): number
  log(message: string): void
  close?(): Promise<void>
}

/** Polling observes cache only. Each newly untouched identity gets its own random 30–60 minute delay. */
export class CodexActivation {
  private readonly entries = new Map<string, Pending>()
  private controller: AbortController | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined

  constructor(private readonly deps: Deps) {}

  start(): void {
    if (this.controller) return
    this.controller = new AbortController()
    this.schedule(0)
  }

  /** Abort before awaiting, so shutdown cannot admit another inference request. */
  async stop(): Promise<void> {
    clearTimeout(this.timer)
    this.controller?.abort(new Error('服务退出，取消后台激活'))
    this.controller = undefined
    const errors: unknown[] = []
    try { await this.pending } catch (error) { errors.push(error) }
    this.entries.clear()
    try { await this.deps.close?.() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, `后台激活停止失败：${errors.map(String).join('；')}`)
  }

  error(accountId: string): string | undefined {
    return [...this.entries.values()].find(entry => entry.accountId === accountId)?.error
  }

  private schedule(delay?: number): void {
    clearTimeout(this.timer)
    if (!this.controller) return
    delay ??= Math.min(SCAN_MS, ...[...this.entries.values()].filter(entry => !entry.completed)
      .map(entry => Math.max(0, entry.dueAt - this.deps.now())))
    this.timer = setTimeout(() => {
      void this.check().catch(error => this.deps.log(`codex activation scan MISS: ${error}`))
        .finally(() => this.schedule())
    }, delay)
    this.timer.unref?.()
  }

  private dueAt(): number {
    const random = this.deps.random()
    if (!Number.isFinite(random) || random < 0 || random >= 1) throw new Error('后台激活随机间隔无效')
    return this.deps.now() + MIN_DELAY_MS + Math.floor(random * (MAX_DELAY_MS - MIN_DELAY_MS))
  }

  /** One pass at a time, and one activation at a time; native account aliases share the same entry. */
  check(): Promise<void> {
    if (this.pending) return this.pending
    const signal = this.controller?.signal
    if (!signal || signal.aborted) return Promise.resolve()
    const pending = this.scan(signal).finally(() => { if (this.pending === pending) this.pending = undefined })
    this.pending = pending
    return pending
  }

  private async scan(signal: AbortSignal): Promise<void> {
    const accounts = this.deps.accounts()
    const identities = new Set(accounts.flatMap(account => account.usage?.accountFingerprint ? [account.usage.accountFingerprint] : []))
    for (const identity of this.entries.keys()) if (!identities.has(identity)) this.entries.delete(identity)
    const seen = new Set<string>()
    for (const account of accounts) {
      if (signal.aborted) return
      const usage = account.usage
      const identity = usage?.accountFingerprint
      if (!usage || !identity || seen.has(identity)) continue
      seen.add(identity)
      let entry = this.entries.get(identity)
      if (!isUnusedMainWeek(usage) || this.deps.used(identity, usage)) {
        // A confirmed request's refresh/close error must remain inspectable after activation.
        if (!entry?.completed || !entry.error || entry.revision !== account.revision) this.entries.delete(identity)
        continue
      }
      // The native snapshot describes another untouched week, with no matching local use.
      if (entry?.completed) entry = undefined
      if (!entry || entry.revision !== account.revision || entry.accountId !== account.id) {
        entry = { accountId: account.id, revision: account.revision, dueAt: this.dueAt(), completed: false }
        this.entries.set(identity, entry)
      }
      if (entry.completed || this.deps.now() < entry.dueAt) continue
      // Every retry is independently jittered. A failed read never triggers a send from stale cache.
      entry.dueAt = this.dueAt()
      try {
        const revision = account.revision
        if (this.deps.loginPending(account.id)) throw new Error('账号正在登录，后台激活延后')
        const effort = activationEffort(this.deps.source(account.id))
        const result = await this.deps.activate({ accountId: account.id, identity, effort, signal,
          eligible: fresh => !signal.aborted && this.deps.accounts().some(current => current.id === account.id
            && current.revision === revision && current.usage?.accountFingerprint === identity)
            && !this.deps.loginPending(account.id) && !this.deps.used(identity, fresh),
          used: (fresh, tokens) => {
            entry!.completed = true
            this.deps.recordUsage(account.id, fresh)
            this.deps.log(`codex activation: ${account.name} ${CODEX_ACTIVATION_MODEL}/${effort} completed tokens=${tokens}`)
          },
        })
        entry.error = undefined
        if (result === 'skipped') this.deps.log(`codex activation: ${account.name} skipped after fresh quota/account check`)
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error)
        this.deps.log(`codex activation: ${account.name} MISS: ${entry.error}`)
      }
    }
  }
}

export const codexActivation = new CodexActivation({
  accounts: () => codexAccounts.list().map(account => ({ id: account.id, name: account.name,
    revision: codexAccounts.revision(account.id), usage: peekSuccessfulUsage(account.id) })),
  source: id => getTokenSourceForAccount('codex-sub', id), loginPending: isCodexLoginPending,
  used: (identity, usage) => codexAccountScheduler.weekWasUsed(identity, usage, ''),
  recordUsage: (id, usage) => codexAccountScheduler.recordUsage(id, CODEX_ACTIVATION_MODEL, usage),
  activate: activateCodexAccount, now: Date.now, random: Math.random, log, close: closeCodexActivationClients,
})
