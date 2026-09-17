import { codexAccounts, type CodexAccount } from './codex-accounts'
import { readUsage, type UsageSnapshot, type UsageWindow } from './usage'

export interface CodexAccountUsage {
  account: CodexAccount
  usage: UsageSnapshot
  fingerprint: string | null
  duplicateOf?: string
}
export interface CodexUsageTotal {
  entries: CodexAccountUsage[]
  complete: boolean
  available: number | null
  resetCredits: number | null
  /** Sum of per-account remaining fractions; one full account window is one share, never a token estimate. */
  windows: Array<{ kind: 'fiveHour' | 'weekly'; remaining: number | null; count: number }>
}

export function aggregateCodexUsage(input: CodexAccountUsage[]): CodexUsageTotal {
  const seen = new Map<string, string>()
  const entries = input.map(entry => {
    const duplicateOf = entry.fingerprint ? seen.get(entry.fingerprint) : undefined
    if (entry.fingerprint && !duplicateOf) seen.set(entry.fingerprint, entry.account.name)
    return { ...entry, ...(duplicateOf ? { duplicateOf } : {}) }
  })
  const distinct = entries.filter(entry => !entry.duplicateOf)
  const identityKnown = distinct.length <= 1 || distinct.every(entry => entry.fingerprint !== null)
  const complete = identityKnown && distinct.every(entry => entry.usage.state === 'ok')
  const snapshots = distinct.flatMap(entry => entry.usage.state === 'ok' ? [entry.usage] : [])
  const available = complete && snapshots.every(s => [s.fiveHour, s.weekly].filter(Boolean).every(w => w!.percent !== null))
    ? snapshots.filter(s => [s.fiveHour, s.weekly].filter(Boolean).every(w => w!.percent! < 100)).length : null
  const resetCredits = complete && snapshots.every(s => s.resetCredits != null)
    ? snapshots.reduce((sum, s) => sum + s.resetCredits!, 0) : null
  const windows = (['fiveHour', 'weekly'] as const).map(kind => {
    const rows = snapshots.map(s => s[kind]).filter((w): w is UsageWindow => w !== null)
    const known = complete && rows.every(w => w.percent !== null && w.percent >= 0 && w.percent <= 100)
    return { kind, count: rows.length, remaining: known ? rows.reduce((sum, w) => sum + (100 - w.percent!) / 100, 0) : null }
  }).filter(w => w.count || !complete)
  return { entries, complete, available, resetCredits, windows }
}

export async function readAllCodexUsage(current?: { id: string; usage: UsageSnapshot }): Promise<CodexUsageTotal> {
  const reads = new Map<string, Promise<UsageSnapshot>>()
  const entries = await Promise.all(codexAccounts.list().map(async account => {
    let fingerprint: string | null = null
    try { fingerprint = codexAccounts.fingerprint(account.id) }
    catch (error) {
      return { account, fingerprint, usage: { state: 'network' as const, reason: `账号身份读取失败：${String(error)}` } }
    }
    const key = fingerprint ?? account.id
    let pending = reads.get(key)
    if (!pending) {
      pending = current?.id === account.id ? Promise.resolve(current.usage) : readUsage(account.id)
      reads.set(key, pending)
    }
    const usage = await pending
    if (usage.state === 'ok' && usage.accountFingerprint) fingerprint = usage.accountFingerprint
    return { account, usage, fingerprint }
  }))
  return aggregateCodexUsage(entries)
}
