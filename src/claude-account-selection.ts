import { homedir } from 'node:os'
import { config } from './config'
import type { AgentReasoningEffort } from './agent-process'
import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeAgentProcess } from './claude-agent-process'
import { claudeAccounts, DEFAULT_CLAUDE_ACCOUNT } from './claude-accounts'
import { compareClaudeQuota, rankClaudeQuota, type ClaudeQuotaRank } from './claude-quota'
import { assertClaudeDefaultSettingsEnvironment, claudeSubscriptionSettings, validateClaudeSubscriptionAccount } from './token-source-claude'
import { getTokenSourceForAccount, scrubAnthropicEnv, tokenSourceRuntimeModel } from './token-source'
import { peekTokenSourceUsage, refreshTokenSourceUsage } from './token-source-cache'
import { log } from './log'

/** Startup selection only; this function neither queries upstream nor changes any running process. */
export function selectClaudeAccount(options: { model?: string | null; effort?: AgentReasoningEffort | null;
  preferred?: string | null; activeSessions?: ReadonlyMap<string, number> }): string {
  if (config.token_sources?.['claude-sub']?.enabled === false) throw new Error('Claude 订阅已禁用；发送 claude-sub on 启用')
  if (options.preferred) return claudeAccounts.get(options.preferred).id
  const diagnostics: string[] = []
  const identities = new Set<string>()
  const candidates: Array<ClaudeQuotaRank & { id: string }> = []
  const now = Date.now()
  for (const account of claudeAccounts.list()) {
    try {
      const source = getTokenSourceForAccount('claude-sub', account.id)
      if (!source?.enabled || source.modelCatalogState?.status !== 'ready') {
        throw new Error(source?.modelCatalogState?.error ?? '账号模型目录 MISS')
      }
      const model = options.model || source.defaultModel
      if (!model) throw new Error('Claude Opus 默认模型 MISS')
      const entry = tokenSourceRuntimeModel(source, model)
      if (!entry || entry.unavailableReason || !entry.efforts.length) throw new Error(entry?.unavailableReason ?? `${model} 模型目录 MISS`)
      const effort = options.effort ?? entry.defaultEffort
      if (!effort || !entry.efforts.includes(effort)) throw new Error(`${model}/${effort ?? 'MISS'} 档位不可用`)
      const rank = rankClaudeQuota(peekTokenSourceUsage(source), model, now, options.activeSessions?.get(account.id) ?? 0)
      if (rank.state !== 'ready') throw new Error(rank.reason ?? '额度缓存 MISS')
      if (!account.identity) throw new Error('原生账号身份 MISS')
      if (identities.has(account.identity)) continue
      identities.add(account.identity)
      candidates.push({ id: account.id, ...rank })
    } catch (error) { diagnostics.push(`${account.name}：${error instanceof Error ? error.message : String(error)}`) }
  }
  candidates.sort(compareClaudeQuota)
  if (!candidates.length) throw new Error(`Claude 自动选号 MISS：${diagnostics.join('；') || '尚无已收录账号'}`)
  return candidates[0]!.id
}

/** Explicit hi <name> may discover/authenticate a new manually logged-in directory. */
export async function enrollClaudeAccount(name: string): Promise<string> {
  if (config.token_sources?.['claude-sub']?.enabled === false) throw new Error('Claude 订阅已禁用；发送 claude-sub on 启用')
  const candidate = claudeAccounts.candidate(name)
  if (candidate.state === 'ready' && candidate.identity) return candidate.id
  const account = await claudeAccounts.enroll(name, async candidate => {
    if (candidate.id === DEFAULT_CLAUDE_ACCOUNT && candidate.configDir === undefined) {
      assertClaudeDefaultSettingsEnvironment(claudeAccounts.sharedConfigDir())
    }
    const settings = claudeSubscriptionSettings(claudeAccounts.candidateEnv(candidate, {}))
    const release = claudeAccounts.acquireCandidateUse(candidate)
    let proc: ClaudeAgentProcess
    try { proc = new ClaudeAgentProcess({ workDir: homedir(), effort: 'default', controlOnly: true,
      tokenSourceId: 'claude-sub', settingSources: ['user'], settings,
      profile: { loadProjectMcp: false }, validateAccount: validateClaudeSubscriptionAccount,
      transformEnv: base => claudeAccounts.candidateEnv(candidate, { ...scrubAnthropicEnv(base), ...settings.env }) }) }
    catch (error) { release(); throw error }
    proc.once('exit', release)
    proc.on('error', error => log(`Claude account enrollment MISS: ${error.message}`))
    let timer: ReturnType<typeof setTimeout> | undefined
    let failure: unknown
    try {
      const info = await Promise.race([proc.readAccountInfo(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Claude 原生账号认证查询超时（30s）')), 30_000)
      })]) as AccountInfo
      validateClaudeSubscriptionAccount(info)
      return info
    } catch (error) { failure = error; throw error }
    finally {
      clearTimeout(timer)
      try { await proc.kill() }
      catch (error) {
        if (failure) throw new AggregateError([failure, error], 'Claude 账号认证失败且查询进程关闭失败')
        throw error
      } finally { if (!proc.isAlive()) release() }
    }
  })
  let source = getTokenSourceForAccount('claude-sub', account.id)
  if (!source) throw new Error('Claude 账号已收录，但 claude-sub 来源不可用')
  await source.refreshModels()
  const current = getTokenSourceForAccount('claude-sub', account.id)!
  if (current !== source) { source = current; await source.refreshModels() }
  if (source.modelCatalogState?.status !== 'ready') throw new Error(`Claude 账号已收录，模型目录 MISS：${source.modelCatalogState?.error ?? '后台刷新中'}`)
  try { await refreshTokenSourceUsage(source) }
  catch (error) { log(`Claude account enrolled; quota warming MISS: ${error instanceof Error ? error.message : String(error)}`) }
  return account.id
}
