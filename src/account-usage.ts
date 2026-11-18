import { codexAccounts } from './codex-accounts'
import { readAllCodexUsage } from './codex-account-usage'
import { codexUsageToUnified } from './token-source-codex'
import { listTokenSources, tokenSourceRegistryRevision, tokenSourceAccounts, tokenSourceAccountRevision, type TokenSource, type UsageSnapshotUnified } from './token-source'
import { sharedAccountId } from './token-source-accounts'
import { codexUsageCacheRevision, readUsageForDisplay, type UsageSnapshot } from './usage'
import { logError } from './log'

export interface AccountUsage {
  id: string
  label: string
  usage: UsageSnapshotUnified
}

/** 额度的账号名：单账号来源只写短名，多账号来源写「来源·备注」；同一计费账号的各 Agent 视图共用一个 id。 */
export function tokenSourceUsageAccount(source: TokenSource): { id: string; label: string } {
  const id = source.usageAccount?.id ?? sharedAccountId(source.id)
  const label = source.usageAccount?.label ?? (id === 'glm' ? 'GLM' : id === 'deepseek' ? 'DeepSeek'
    : source.kind === 'claude-subscription' ? 'Claude 订阅' : source.display)
  return { id, label }
}

function codexAccountRow(account: { id: string; name: string }, usage: UsageSnapshot): AccountUsage {
  return { id: `codex:${account.id}`, label: `Codex·${account.name}`, usage: codexUsageToUnified(usage) }
}

/** 一个 Codex 订阅账号的额度（只读缓存）：群里 hi 显示本项目进程实际所用的账号。 */
export async function readCodexAccountUsage(accountId: string): Promise<AccountUsage> {
  return codexAccountRow(codexAccounts.get(accountId), await readUsageForDisplay(accountId))
}

/** 一个来源（或其账号视图）的额度；读取失败按 network 显示 MISS，不让整个额度区出错。 */
export async function readTokenSourceAccountUsage(source: TokenSource): Promise<AccountUsage> {
  const { id, label } = tokenSourceUsageAccount(source)
  try {
    return { id, label, usage: await source.readUsage() }
  } catch (error) {
    logError('account usage read failed', error)
    return { id, label, usage: { state: 'network', windows: [], reason: error instanceof Error ? error.message : String(error) } }
  }
}

let pending: { key: string; promise: Promise<AccountUsage[]> } | undefined

function cacheKey(): string {
  return JSON.stringify([tokenSourceRegistryRevision(), codexUsageCacheRevision(),
    listTokenSources().map(source => [source.id, source.enabled, source.spawnRevision, source.usageAccount,
      tokenSourceAccounts(source).map(account => [account.id, account.name, tokenSourceAccountRevision(source, account.id)])]),
    codexAccounts.list().map(account => [account.id, account.name, account.revision])])
}

/** One row per billing account, independent of the Agent selected in this chat. */
export function readAllAccountUsage(): Promise<AccountUsage[]> {
  // Callers chain .then/.catch; a synchronous throw (account file, registry) must reject instead.
  try { return startAccountUsageRead() }
  catch (error) { return Promise.reject(error) }
}

function startAccountUsageRead(): Promise<AccountUsage[]> {
  const key = cacheKey()
  if (pending?.key === key) return pending.promise
  const order = ['codex-sub', 'claude-sub', 'glm', 'dsh-glm', 'deepseek', 'deepseek-harness', 'openrouter']
  const position = (id: string) => order.includes(id) ? order.indexOf(id) : order.length
  const sources = listTokenSources().filter(source => source.enabled
    || source.kind === 'codex-subscription' && codexAccounts.list().some(account => account.id !== 'default')
    || source.forAccount && tokenSourceAccounts(source).some(account => account.id !== 'default'))
    .sort((a, b) => position(a.id) - position(b.id))
  const seen = new Set<string>()
  const reads: Array<Promise<AccountUsage[]>> = []
  for (const source of sources) {
    if (source.kind === 'codex-subscription') {
      reads.push(readAllCodexUsage().then(total => total.entries.filter(entry => !entry.duplicateOf)
        .map(entry => codexAccountRow(entry.account, entry.usage))))
      continue
    }
    if (source.aggregateAccountCatalog && source.forAccount) {
      reads.push(Promise.all(tokenSourceAccounts(source).map(async account => {
        const view = source.forAccount!(account.id)
        let usage: UsageSnapshotUnified
        try { usage = await view.readUsage() }
        catch (error) { usage = { state: 'network', windows: [], reason: error instanceof Error ? error.message : String(error) } }
        return { id: view.usageAccount?.id ?? `${source.id}:${account.id}`,
          label: view.usageAccount?.label ?? `${source.display}·${account.name}`, usage }
      })))
      continue
    }
    // 同一计费账号（DeepSeek、GLM 的跨 Agent 入口、同一中转站的各视图）只列一次。
    const { id } = tokenSourceUsageAccount(source)
    if (seen.has(id)) continue
    seen.add(id)
    reads.push(readTokenSourceAccountUsage(source).then(row => [row]))
  }
  const promise = Promise.all(reads).then(groups => groups.flat())
    .finally(() => { if (pending?.promise === promise) pending = undefined })
  pending = { key, promise }
  return promise
}
