import { codexAccounts, type CodexAccount } from './codex-accounts'
import { AppServerOnce, readUsageForDisplay, requestCodexControlWithRetry, type UsageSnapshot, type UsageWindow } from './usage'
import { log } from './log'

export interface CodexAccountUsage {
  account: CodexAccount
  usage: UsageSnapshot
  fingerprint: string | null
  duplicateOf?: string
  /** Read from this record's native account/read, independently of quota deduplication. */
  email?: string | null
  emailError?: string
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

/** Explicit account inspection reads every login, even when quota identities have been merged. */
export async function readCodexAccountEmails(
  total: CodexUsageTotal,
  createClient: (id: string) => Pick<AppServerOnce, 'initialize' | 'request' | 'close'> = id => new AppServerOnce({ accountId: id }),
): Promise<CodexUsageTotal> {
  const entries = await Promise.all(total.entries.map(async entry => {
    let app: ReturnType<typeof createClient> | undefined
    let email: string | null = null
    let emailError: string | undefined
    try {
      app = createClient(entry.account.id)
      await app.initialize('lodestar-account-email')
      const response = await requestCodexControlWithRetry(() => app!.request('account/read', { refreshToken: false }), '账号邮箱查询')
      if (response?.account === null || response?.account?.type === 'apiKey') throw new Error('该账号未登录 ChatGPT')
      if (response?.account?.type !== 'chatgpt') throw new Error('account/read 返回的账号状态无效')
      if (typeof response.account.email !== 'string' || !response.account.email.trim()) throw new Error('原生账号未提供邮箱')
      email = response.account.email.trim()
    } catch (error) {
      emailError = error instanceof Error ? error.message : String(error)
    } finally {
      if (app) {
        try { await app.close() }
        catch (error) { emailError = [emailError, `账号查询进程关闭失败：${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('；') }
      }
    }
    if (emailError) log(`codex-accounts: ${entry.account.id} email read: ${emailError}`)
    return { ...entry, email, emailError }
  }))
  return { ...total, entries }
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
      pending = current?.id === account.id ? Promise.resolve(current.usage) : readUsageForDisplay(account.id)
      reads.set(key, pending)
    }
    const usage = await pending
    if (usage.state === 'ok' && usage.accountFingerprint) fingerprint = usage.accountFingerprint
    return { account, usage, fingerprint }
  }))
  return aggregateCodexUsage(entries)
}
