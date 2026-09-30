/** Native consumable credits, separate from earned rate-limit reset cards. */
export interface CodexCredits {
  hasCredits: boolean
  unlimited: boolean
  balance: number | null
}

/** Missing, malformed or contradictory credit data stays unknown, never an empty balance. */
export function parseCodexCredits(raw: unknown): CodexCredits | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.hasCredits !== 'boolean' || typeof value.unlimited !== 'boolean') return null
  let balance: number | null = null
  if (value.balance != null) {
    if (typeof value.balance !== 'number'
      && !(typeof value.balance === 'string' && /^\d+(?:\.\d+)?$/.test(value.balance.trim()))) return null
    balance = Number(value.balance)
    if (!Number.isFinite(balance) || balance < 0 || balance > Number.MAX_SAFE_INTEGER) return null
  }
  if (!value.unlimited && balance !== null && value.hasCredits !== (balance > 0)) return null
  return { hasCredits: value.hasCredits, unlimited: value.unlimited, balance }
}

export function codexCreditAvailability(credits: CodexCredits | null | undefined): 'available' | 'empty' | 'unknown' {
  return credits == null ? 'unknown' : credits.hasCredits || credits.unlimited ? 'available' : 'empty'
}

/** A positive balance alone cannot undo an actual request failure. Observe a replenishment. */
export function codexCreditsReplenished(before: CodexCredits | null | undefined, after: CodexCredits | null | undefined): boolean {
  if (!before || !after || codexCreditAvailability(after) !== 'available') return false
  return codexCreditAvailability(before) === 'empty' || (!before.unlimited && after.unlimited)
    || (!before.unlimited && before.balance !== null && after.balance !== null && after.balance > before.balance)
}
