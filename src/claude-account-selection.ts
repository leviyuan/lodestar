import { homedir } from 'node:os'
import { config } from './config'
import type { AgentReasoningEffort } from './agent-process'
import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeAgentProcess } from './claude-agent-process'
import { claudeAccounts, DEFAULT_CLAUDE_ACCOUNT } from './claude-accounts'
import { claudeModelFamily } from './claude-usage'
import { resolveClaudeSdkModel } from './claude-models'
import { assertClaudeDefaultSettingsEnvironment, claudeSubscriptionSettings, validateClaudeSubscriptionAccount } from './token-source-claude'
import { getTokenSourceForAccount, scrubAnthropicEnv, tokenSourceRuntimeModel, type UsageSnapshotUnified } from './token-source'
import { peekTokenSourceUsage, refreshTokenSourceUsage } from './token-source-cache'
import { log } from './log'

/** All independently applicable plan windows must permit this model. No missing quota is inferred. */
export function claudeAccountAvailability(snapshot: UsageSnapshotUnified | undefined, model: string): number {
  if (!snapshot || snapshot.state !== 'ok') throw new Error(snapshot?.reason ?? '额度缓存 MISS')
  const family = claudeModelFamily(resolveClaudeSdkModel(model))
  if (!family || family === 'default') throw new Error('模型额度归属 MISS')
  const windows = snapshot.windows.filter(window => window.kind === 'fiveHour' || window.kind === 'weekly'
    || window.kind === 'seven_day_oauth_apps'
    || window.kind === 'seven_day_opus' && family === 'opus'
    || window.kind === 'seven_day_sonnet' && family === 'sonnet'
    || window.kind.startsWith('modelWeekly:') && claudeModelFamily(window.kind.slice('modelWeekly:'.length)) === family)
  if (!windows.some(window => window.kind === 'fiveHour') || !windows.some(window => window.kind === 'weekly')) {
    throw new Error('订阅主窗口额度 MISS')
  }
  for (const window of windows) {
    if (typeof window.percent !== 'number' || !Number.isFinite(window.percent) || window.percent < 0 || window.percent > 100) {
      throw new Error(`${window.label} MISS`)
    }
    if (window.percent >= 100) throw new Error(`${window.label} 已耗尽`)
  }
  return Math.min(...windows.map(window => 100 - window.percent!))
}

/** Startup selection only; this function neither queries upstream nor changes any running process. */
export function selectClaudeAccount(options: { model?: string | null; effort?: AgentReasoningEffort | null; preferred?: string | null }): string {
  if (config.token_sources?.['claude-sub']?.enabled === false) throw new Error('Claude 订阅已禁用；发送 claude-sub on 启用')
  if (options.preferred) return claudeAccounts.get(options.preferred).id
  const diagnostics: string[] = []
  const identities = new Set<string>()
  const candidates: Array<{ id: string; score: number }> = []
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
      const score = claudeAccountAvailability(peekTokenSourceUsage(source), model)
      if (!account.identity) throw new Error('原生账号身份 MISS')
      if (identities.has(account.identity)) continue
      identities.add(account.identity)
      candidates.push({ id: account.id, score })
    } catch (error) { diagnostics.push(`${account.name}：${error instanceof Error ? error.message : String(error)}`) }
  }
  candidates.sort((a, b) => b.score - a.score)
  if (!candidates.length) throw new Error(`Claude 自动选号 MISS：${diagnostics.join('；') || '尚无已收录账号'}`)
  return candidates[0]!.id
}

/** Explicit hi <name> may discover/authenticate a new manually logged-in directory. */
export async function enrollClaudeAccount(name: string): Promise<string> {
  if (config.token_sources?.['claude-sub']?.enabled === false) throw new Error('Claude 订阅已禁用；发送 claude-sub on 启用')
  const candidate = claudeAccounts.candidate(name)
  if (candidate.state === 'ready' && candidate.identity) {
    claudeAccounts.prepareShared(candidate.id)
    return candidate.id
  }
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
