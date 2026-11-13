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
  /** Directory refresh receipts recheck ownership when actually presented. */
  canPresent?: () => boolean
}

/** Attach after presenting the pending result so a fast late reply cannot
 * overwrite the final card with the older pending card. */
export function modelActionCompletion(
  completion: Promise<ModelActionResult> | undefined, present: (final: ModelActionResult) => Promise<void>,
): Promise<'complete' | 'retry'> | null {
  return completion?.then(async final => {
    if (!final.canPresent || final.canPresent()) await present(final)
    return final.ok ? 'complete' : 'retry'
  }) ?? null
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Short, stable session label shared by every user-visible surface.
 *
 * Only the random tail is distinguishing: a UUIDv7's first 8 hex chars are the
 * high bits of its millisecond timestamp, so sessions created within the same
 * ~65s (a source and its fork, or two `rs` restarts) share them and the labels
 * read as near-identical noise. Six trailing chars stay unique within a
 * project's history (16.7M values) and can be matched across the rs picker,
 * result cards and status texts. The leading ellipsis marks the truncation. */
export function diagnosticIdLabel(id: string): string {
  return id.length <= 16 ? id : `…${id.slice(-6)}`
}
