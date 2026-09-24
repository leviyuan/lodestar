import { existsSync, readFileSync } from 'node:fs'
import { codexAccounts, isCodexLoginPending, type CodexAccount } from './codex-accounts'
import { peekSuccessfulUsage, peekUsage, type UsageSnapshot } from './usage'
import { codexModelQuota, codexQuotaMeter, codexWeekUsedSince, compareCodexQuota, rankCodexQuota, type CodexQuotaRank } from './codex-quota'
import { getTokenSourceForAccount, tokenSourceRuntimeModel, type TokenSource } from './token-source'
import type { AgentReasoningEffort } from './agent-process'
import { CODEX_QUOTA_BLOCKS_FILE } from './paths'
import { writeJsonStateAtomic } from './state-store'
import { log } from './log'

export interface CodexAccountCandidate extends CodexQuotaRank {
  account: CodexAccount
  usage: UsageSnapshot | null
  identity: string
  duplicateOf?: string
}
export interface CodexAccountDecision {
  selected: CodexAccountCandidate | null
  candidates: CodexAccountCandidate[]
  retryAt?: number
}
interface Block {
  key: string
  identity: string
  meter: string
  blockedAt?: number
  windows: Array<{ kind: 'fiveHour' | 'weekly'; percent: number | null; reset: number | null }>
}
export interface CodexSelectionOptions {
  model: string
  effort?: AgentReasoningEffort
  preferred?: string | null
  signal?: AbortSignal
  /** Launch from the last successful cached quota if possible; all reads share the same cooldown. */
  preferCachedUsage?: boolean
  /** Native quota error from a manually chosen process whose quota had not been read. Only used once. */
  failedAccountId?: string
}

/** Shared by main sessions and workers. Only hashes/limit observations enter the private block file. */
export class CodexAccountScheduler {
  // Like quota caches, these observations live only in this daemon. Restarting reads a new native snapshot.
  private readonly lastUses = new Map<string, number>()

  constructor(private readonly deps: {
    accounts: () => CodexAccount[]
    usage: (id: string) => Promise<UsageSnapshot>
    cachedUsage: (id: string) => UsageSnapshot | null
    identity: (id: string) => string | null
    compatible: (id: string, model: string, effort?: AgentReasoningEffort) => Promise<string | null>
    pendingLogin: (id: string) => boolean
    now: () => number
    stateFile: string
  }) {}

  /** Called only for a current turn's real token usage, never when viewing or merely selecting an account. */
  recordUsage(accountId: string, model: string): void {
    const usage = this.deps.cachedUsage(accountId)
    // A manual launch may not have queried quota yet; its first read will observe the running window.
    if (usage?.state !== 'ok') return
    const identity = usage.accountFingerprint ?? this.deps.identity(accountId)
    if (!identity) return
    this.lastUses.set(JSON.stringify([identity, codexQuotaMeter(usage, model)]), this.deps.now())
  }

  private blocks(): Block[] {
    if (!existsSync(this.deps.stateFile)) return []
    const data = JSON.parse(readFileSync(this.deps.stateFile, 'utf8'))
    if (data?.version !== 1 || !Array.isArray(data.blocks) || data.blocks.some((b: any) =>
      typeof b?.key !== 'string' || typeof b?.identity !== 'string' || typeof b?.meter !== 'string' || !Array.isArray(b?.windows)
      || b.windows.some((w: any) => !['fiveHour', 'weekly'].includes(w?.kind)
        || (w.percent !== null && !Number.isFinite(w.percent)) || (w.reset !== null && !Number.isFinite(w.reset))))) {
      throw new Error('Codex 额度耗尽记录格式无效')
    }
    return data.blocks
  }

  block(candidate: CodexAccountCandidate, model: string): void {
    if (!candidate.usage) throw new Error('未读取额度，不能记录耗尽窗口')
    const quota = candidate.usage.state === 'ok' ? codexModelQuota(candidate.usage, model) : null
    const windows = (['fiveHour', 'weekly'] as const).flatMap(kind => {
      const w = quota?.[kind]
      return w ? [{ kind, percent: w.percent, reset: w.resetsAt?.getTime() ?? null }] : []
    })
    const meter = codexQuotaMeter(candidate.usage, model)
    const key = JSON.stringify([candidate.identity, meter])
    const blocks = this.blocks().filter(b => b.key !== key)
    blocks.push({ key, identity: candidate.identity, meter, windows, blockedAt: this.deps.now() })
    writeJsonStateAtomic(this.deps.stateFile, { version: 1, blocks })
  }

  async choose(opts: CodexSelectionOptions): Promise<CodexAccountDecision> {
    opts.signal?.throwIfAborted()
    const accounts = this.deps.accounts()
    if (opts.preferred) {
      const account = accounts.find(a => a.id === opts.preferred)
      if (!account) throw new Error(`指定 Codex 账号不存在：${opts.preferred}`)
      return { selected: { account, identity: `record:${account.id}`, usage: null, state: 'manual',
        score: null, shares: null, remaining: null, hours: null }, candidates: [] }
    }
    // Cached and live quota passes belong to one decision. Recheck each account's catalog only once.
    const checkedModels = new Map<string, Promise<string | null>>()
    if (opts.preferCachedUsage) {
      const cached = await this.chooseAutomatic(accounts, opts, true, checkedModels)
      if (cached.selected) return cached
    }
    return this.chooseAutomatic(accounts, opts, false, checkedModels)
  }

  private async chooseAutomatic(accounts: CodexAccount[], opts: CodexSelectionOptions, cached: boolean,
    checkedModels: Map<string, Promise<string | null>>): Promise<CodexAccountDecision> {
    opts.signal?.throwIfAborted()
    const rows = await Promise.all(accounts.map(async account => {
      let usage: UsageSnapshot | null
      let reason: string | null = null
      let identity: string = `record:${account.id}`
      if (this.deps.pendingLogin(account.id)) {
        usage = { state: 'network', reason: '正在登录' }
      } else {
        try {
          usage = cached ? this.deps.cachedUsage(account.id) : await this.deps.usage(account.id)
          const fingerprint = usage?.state === 'ok' ? usage.accountFingerprint ?? this.deps.identity(account.id) : null
          if (fingerprint) identity = fingerprint
          else if (usage?.state === 'ok') reason = '账号身份 MISS'
          if (usage?.state === 'ok' && !reason) {
            let checked = checkedModels.get(account.id)
            if (!checked) {
              checked = this.deps.compatible(account.id, opts.model, opts.effort)
              checkedModels.set(account.id, checked)
            }
            reason = await checked
          }
        } catch (error) { usage = { state: 'network', reason: String(error) } }
      }
      return { account, usage, identity, reason }
    }))
    opts.signal?.throwIfAborted()
    const failed = opts.failedAccountId && rows.find(r => r.account.id === opts.failedAccountId)
    if (failed && failed.usage?.state === 'ok') this.block({ account: failed.account, usage: failed.usage, identity: failed.identity,
      ...rankCodexQuota(failed.usage, opts.model, this.deps.now(), opts.effort) }, opts.model)
    // Read after network awaits so concurrent exhaustion reports cannot be overwritten.
    const blocks = this.blocks()
    const now = this.deps.now()
    const recovered = new Set<string>()
    const seen = new Map<string, string>()
    const candidates = rows.map(({ account, usage, identity, reason }): CodexAccountCandidate => {
      let rank = rankCodexQuota(usage ?? { state: 'network', reason: '尚无额度缓存' }, opts.model, now, opts.effort)
      if (reason) rank = { ...rank, state: 'miss', score: null, reason }
      const duplicateOf = seen.get(identity)
      seen.set(identity, duplicateOf ?? account.name)
      if (duplicateOf) rank = { ...rank, state: 'miss', score: null, reason: `重复账号：${duplicateOf}` }
      const meter = usage?.state === 'ok' ? codexQuotaMeter(usage, opts.model) : null
      const usedAt = this.lastUses.get(JSON.stringify([identity, meter]))
      if (rank.priority === 'unused' && usage?.state === 'ok' && usedAt !== undefined
        && codexWeekUsedSince(usage, opts.model, usedAt)) rank = { ...rank, priority: undefined }
      const block = blocks.find(b => (b.identity === identity || b.identity === `record:${account.id}`) && b.meter === meter)
      if (block && usage?.state === 'ok' && rank.state === 'ready') {
        const quota = codexModelQuota(usage, opts.model)
        // Cached observations may predate the native failure; only a fresh read can clear it.
        const resetObserved = (usage.readStartedAt ?? usage.fetchedAt) > (block.blockedAt ?? 0) && block.windows.some(old => {
          const w = quota[old.kind]
          return w && w.percent !== null && ((old.percent !== null && w.percent < old.percent)
            || (old.reset !== null && old.reset <= now && (w.resetsAt?.getTime() ?? 0) > old.reset))
        })
        if (resetObserved) recovered.add(block.key)
        else rank = { ...rank, state: 'exhausted', score: null, reason: '上次请求已确认额度耗尽，等待接口确认恢复' }
      }
      return { account, usage, identity, ...rank, ...(duplicateOf ? { duplicateOf } : {}) }
    })
    if (recovered.size) writeJsonStateAtomic(this.deps.stateFile, { version: 1, blocks: blocks.filter(b => !recovered.has(b.key)) })
    const ready = candidates.filter(c => c.state === 'ready')
    ready.sort(compareCodexQuota)
    const selected = ready[0] ?? null
    const exhausted = candidates.filter(c => c.state === 'exhausted' || c.state === 'waiting')
    const retryAt = exhausted.length ? Math.min(...exhausted.map(c => c.retryAt ?? now + 60_000)) : undefined
    for (const c of candidates) log(`codex scheduler${cached ? ' [cache]' : ''}: ${c.account.name} ${c.state} priority=${c.priority ?? 'score'} score=${c.score ?? (c.priority === 'expiring' ? 'N/A' : 'MISS')}${c.reason ? ` (${c.reason})` : ''}`)
    return { selected, candidates, ...(retryAt !== undefined ? { retryAt } : {}) }
  }
}

function modelCatalogMismatch(source: TokenSource, model: string, effort?: AgentReasoningEffort): string | null {
  const entry = tokenSourceRuntimeModel(source, model)
  if (!entry) return `模型目录缺少 ${model}`
  if (entry.unavailableReason) return `${model} 不可用：${entry.unavailableReason}`
  if (effort && !entry.efforts.includes(effort)) {
    return `${model} 缺少推理档位 ${effort}（目录档位：${entry.efforts.join('、') || 'MISS'}）`
  }
  return null
}

/** Automatic selection reads only the account's committed catalog, even during a refresh. */
export async function checkCodexModelCompatibility(source: TokenSource, model: string,
  effort?: AgentReasoningEffort, _now = Date.now()): Promise<string | null> {
  if (!source.enabled || source.modelCatalogState?.status !== 'ready') {
    return `模型目录查询失败：${source.modelCatalogState?.error ?? (source.enabled ? '模型目录 MISS' : '订阅来源未启用')}`
  }
  return modelCatalogMismatch(source, model, effort)
}

export const codexAccountScheduler = new CodexAccountScheduler({
  accounts: () => codexAccounts.list(), usage: async id => peekUsage(id)
    ?? { state: 'network', reason: '额度缓存尚未就绪，后台刷新中' }, cachedUsage: peekSuccessfulUsage,
  identity: id => codexAccounts.fingerprint(id), pendingLogin: isCodexLoginPending,
  now: Date.now, stateFile: CODEX_QUOTA_BLOCKS_FILE,
  compatible: async (id, model, effort) => {
    const source = getTokenSourceForAccount('codex-sub', id)
    if (!source) return '订阅来源 MISS'
    return checkCodexModelCompatibility(source, model, effort)
  },
})
