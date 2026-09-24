import { codexAccounts } from './codex-accounts'
import { readAllCodexUsage } from './codex-account-usage'
import { codexUsageToUnified } from './token-source-codex'
import { listTokenSources, tokenSourceRegistryRevision, type UsageSnapshotUnified } from './token-source'
import { sharedAccountId } from './token-source-accounts'
import { codexUsageCacheRevision } from './usage'
import { log } from './log'

export interface AccountUsage {
  id: string
  label: string
  usage: UsageSnapshotUnified
}

let pending: { key: string; promise: Promise<AccountUsage[]> } | undefined

function cacheKey(): string {
  return JSON.stringify([tokenSourceRegistryRevision(), codexUsageCacheRevision(),
    listTokenSources().map(source => [source.id, source.enabled, source.spawnRevision, source.usageAccount]),
    codexAccounts.list().map(account => [account.id, account.name, account.revision])])
}

/** One row per billing account, independent of the Agent selected in this chat. */
export function readAllAccountUsage(): Promise<AccountUsage[]> {
  const key = cacheKey()
  if (pending?.key === key) return pending.promise
  const order = ['codex-sub', 'claude-sub', 'glm', 'dsh-glm', 'deepseek', 'deepseek-harness', 'openrouter', 'claude-native']
  const position = (id: string) => order.includes(id) ? order.indexOf(id) : order.length
  const sources = listTokenSources().filter(source => source.enabled
    || source.kind === 'codex-subscription' && codexAccounts.list().some(account => account.id !== 'default'))
    .sort((a, b) => position(a.id) - position(b.id))
  const seen = new Set<string>()
  const reads: Array<Promise<AccountUsage[]>> = []
  for (const source of sources) {
    if (source.kind === 'codex-subscription') {
      reads.push(readAllCodexUsage().then(total => total.entries.filter(entry => !entry.duplicateOf).map(entry => ({
        id: `codex:${entry.account.id}`, label: `Codex·${entry.account.name}`, usage: codexUsageToUnified(entry.usage),
      }))))
      continue
    }
    const id = source.usageAccount?.id ?? sharedAccountId(source.id)
    if (seen.has(id)) continue
    seen.add(id)
    const label = source.usageAccount?.label ?? (id === 'glm' ? 'GLM Coding Plan' : id === 'deepseek' ? 'DeepSeek'
      : source.kind === 'claude-subscription' ? 'Claude 订阅' : source.display)
    reads.push(Promise.resolve().then(() => source.readUsage()).catch((error): UsageSnapshotUnified => {
      const reason = error instanceof Error ? error.message : String(error)
      log(`account usage ${id} MISS: ${reason}`)
      return { state: 'network', windows: [], reason }
    }).then(usage => [{ id, label, usage }]))
  }
  const promise = Promise.all(reads).then(groups => groups.flat())
    .finally(() => { if (pending?.promise === promise) pending = undefined })
  pending = { key, promise }
  return promise
}
