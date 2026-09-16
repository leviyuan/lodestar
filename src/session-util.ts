export type FooterTimer = {
  setStatus(status: string): void
  stop(): void
  elapsedSec(): number
}

export type StatusCardHandle = {
  cardId: string
  title: string
  timer: FooterTimer
}

export type LifecycleProgressOpts = {
  announce?: boolean
  onStatus?: (status: string) => void
  /** Internal: startColdUserTurn resets fresh state before opening the
   * first direct-start card, because the visible turn number is decided
   * before Codex starts. */
  freshConversationStateAlreadyReset?: boolean
}

export type WorktreeActionResult = { ok: boolean; message: string; card: object }
export type TasklistActionResult = { ok: boolean; message: string; card: object }
export type ModelActionResult = {
  ok: boolean
  message: string
  card?: object
  pending?: boolean
  completion?: Promise<ModelActionResult>
}

/** Attach after presenting the pending result so a fast late reply cannot
 * overwrite the final card with the older pending card. */
export function modelActionCompletion(
  completion: Promise<ModelActionResult> | undefined, present: (final: ModelActionResult) => Promise<void>,
): Promise<'complete' | 'retry'> | null {
  return completion?.then(async final => {
    await present(final)
    return final.ok ? 'complete' : 'retry'
  }) ?? null
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Compact diagnostic label that keeps both the UUIDv7 time prefix and random
 * tail. A longer timestamp-only prefix still collides for concurrently-created
 * threads, while first-8 + last-4 remains compact and disambiguates them. */
export function diagnosticIdLabel(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
