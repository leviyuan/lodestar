/** Bookkeeping for Feishu WSClients replaced by a rebuild.
 *
 * The SDK's `close()` cannot cancel a connect attempt that is already in
 * flight: the endpoint request and handshake complete afterwards, open a new
 * socket and (on the start path) even fire `onReady`. Such a "closed" client
 * becomes a second live long connection. A retired client is therefore closed
 * again on every check for a bounded window, and immediately whenever one of
 * its own lifecycle callbacks fires (the daemon calls `retire` again). Its
 * inbound events are still processed: Feishu may deliver to either connection
 * and message handling is deduplicated, so dropping them would lose messages. */

export interface WsRetireTimers<H> {
  set(fn: () => void, ms: number): H
  clear(handle: H): void
}

export interface WsRetireOptions<C, H> {
  close(client: C): void
  onCloseError(error: unknown): void
  timers?: WsRetireTimers<H>
  checkIntervalMs?: number
  checks?: number
}

/** Covers endpoint request + 10s handshake + SDK reconnect intervals with margin. */
export const WS_RETIRE_CHECK_INTERVAL_MS = 30_000
export const WS_RETIRE_CHECKS = 20

const realTimers: WsRetireTimers<ReturnType<typeof setTimeout>> = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms)
    // Retirement must never keep the process alive on its own.
    handle.unref?.()
    return handle
  },
  clear(handle) { clearTimeout(handle) },
}

export function createWsRetirement<C, H = ReturnType<typeof setTimeout>>(options: WsRetireOptions<C, H>) {
  const timers = options.timers ?? realTimers as unknown as WsRetireTimers<H>
  const interval = options.checkIntervalMs ?? WS_RETIRE_CHECK_INTERVAL_MS
  const checks = options.checks ?? WS_RETIRE_CHECKS
  const retired = new Map<C, H>()
  let stopped = false

  const closeQuietly = (client: C) => {
    try { options.close(client) } catch (error) { options.onCloseError(error) }
  }
  const schedule = (client: C, remaining: number) => {
    retired.set(client, timers.set(() => {
      closeQuietly(client)
      if (remaining > 1) schedule(client, remaining - 1)
      else retired.delete(client)
    }, interval))
  }

  return {
    /** Close now and keep re-closing for the retirement window. Calling it
     * again for an already-retired client restarts that window. */
    retire(client: C): void {
      const pending = retired.get(client)
      if (pending !== undefined) timers.clear(pending)
      retired.delete(client)
      closeQuietly(client)
      if (!stopped) schedule(client, checks)
    },
    get size(): number {
      return retired.size
    },
    /** Shutdown: close every retired client once more and cancel all checks. */
    closeAll(): void {
      stopped = true
      for (const [client, handle] of retired) {
        timers.clear(handle)
        closeQuietly(client)
      }
      retired.clear()
    },
  }
}

/** A client's own view of the shared event dispatcher. Every event is handled whichever
 * connection delivers it, but only one delivered by the current client proves that the
 * current connection receives events: an event through a retired client says nothing
 * about the client that replaced it. */
export function clientEventDispatcher<D extends { invoke(data: any, params?: any): unknown }>(
  dispatcher: D, isCurrent: () => boolean, onCurrentEvent: () => void,
): D {
  return {
    invoke(data: unknown, params?: unknown) {
      if (isCurrent()) onCurrentEvent()
      return dispatcher.invoke(data, params)
    },
  } as unknown as D
}
