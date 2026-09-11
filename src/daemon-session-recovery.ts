import type { PerKeyActor } from './card-action-runtime'

export interface RecoverableSession {
  readonly sessionName: string
  shouldRevive(): boolean
  restoreAfterDaemonRestart(): Promise<boolean>
}

/** Owns the durable restart intent, independently of process teardown. */
export class DaemonSessionRecovery {
  private pending: Set<string> | null = null
  private shutdownSnapshot: string[] | null = null
  private revival: Promise<void> | null = null

  constructor(private readonly deps: {
    readMarker(): string[]
    writeMarker(names: string[]): void
    sessions(): Iterable<RecoverableSession>
    chatIdForSession(name: string): string | null
    sessionFor(chatId: string, name: string): RecoverableSession
    actor: PerKeyActor
    isShuttingDown(): boolean
    log(message: string): void
  }) {}

  /** Must run before the first boot await, including Agent auto-update. */
  load(): void {
    if (this.pending) throw new Error('session recovery already loaded')
    this.pending = new Set(this.deps.readMarker())
  }

  /** Also covers a chat first discovered by an inbound event after boot.
   * Transfer intent only after its Session constructor succeeds. */
  transferPending(session: { sessionName: string; requireDaemonRestore(): void }): void {
    if (!this.pending) throw new Error('session recovery not loaded')
    if (!this.pending.has(session.sessionName)) return
    session.requireDaemonRestore()
    this.pending.delete(session.sessionName)
  }

  private currentNames(): string[] {
    const names = new Set(this.pending)
    for (const session of this.deps.sessions()) {
      if (session.shouldRevive()) names.add(session.sessionName)
    }
    return [...names]
  }

  persist(): void {
    // A failed read must never be replaced with an empty startup snapshot.
    if (!this.pending) return
    this.deps.writeMarker(this.shutdownSnapshot ?? this.currentNames())
  }

  /** Call after admitted commands drain, before daemon-owned Session.stop().
   * A user kill in that queue still takes effect; teardown callbacks and even
   * SIGKILL during teardown cannot erase the frozen revival intent. */
  freezeForShutdown(): void {
    if (!this.pending) return
    this.shutdownSnapshot ??= this.currentNames()
    this.persist()
  }

  /** Reserve every chat's FIFO slot synchronously, before opening ingress.
   * Recovery is then included in the actor's normal shutdown drain. */
  enqueue(): Promise<void> {
    if (!this.pending) throw new Error('session recovery not loaded')
    if (this.revival) return this.revival
    if (this.deps.isShuttingDown()) return Promise.resolve()
    const names = [...this.pending]
    this.deps.log(`revive: ${names.length} session(s) marked alive on shutdown: ${names.join(', ')}`)
    this.revival = Promise.all(names.map(name => {
      const chatId = this.deps.chatIdForSession(name)
      if (!chatId) {
        // Keep the unresolved intent for the next boot; do not silently lose
        // a saved conversation because its chat binding is unavailable.
        this.deps.log(`revive: no chatId binding for "${name}"; recovery remains pending`)
        return Promise.resolve()
      }
      return this.deps.actor.enqueue(chatId, async () => {
        if (this.deps.isShuttingDown()) return
        let session: RecoverableSession | undefined
        try {
          session = this.deps.sessionFor(chatId, name)
          const ok = await session.restoreAfterDaemonRestart()
          this.deps.log(`revive: "${name}" ${ok ? 'restored' : 'did not start'}`)
        } catch (error) {
          this.deps.log(`revive: restore "${name}" failed: ${error}`)
        } finally {
          // Once constructed, Session owns failed recovery intent as well as
          // a running process. Construction failure leaves our intent intact.
          if (session) this.pending!.delete(name)
          this.persist()
        }
      })
    })).then(() => {})
    return this.revival
  }
}
