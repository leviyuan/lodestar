import { createHash } from 'node:crypto'
import type { AgentProvider, AgentReasoningEffort } from './agent-process'
import { log } from './log'
import { listTokenSources, type TokenSource, type TokenSourceModel } from './token-source'

export type AgentIdentityStatus =
  | 'ready'
  | 'source_disabled'
  | 'catalog_loading'
  | 'catalog_failed'
  | 'model_unavailable'

export interface AgentIdentity {
  id: string
  displayName: string
  tokenSourceId: string
  tokenSourceDisplay: string
  provider: AgentProvider
  model: string
  modelDisplay: string
  defaultEffort: AgentReasoningEffort | null
  supportedEfforts: AgentReasoningEffort[]
  sourceDefault: boolean
  status: AgentIdentityStatus
  reason?: string
  spawnRevision?: string
}

export interface AgentSourceFailure {
  tokenSourceId: string
  display: string
  status: 'disabled' | 'loading' | 'failed' | 'models_miss'
  reason: string
}

export interface AgentIdentityCatalog {
  catalogGeneration: string
  identities: AgentIdentity[]
  sourceFailures: AgentSourceFailure[]
}

const SUBSCRIPTION_CHECK_TTL_MS = 30 * 60 * 1000
interface SubscriptionCheck {
  /** null 表示查询尚未完成；成功和失败都从完成时起保留 30 分钟。 */
  expiresAt: number | null
  result: Promise<string | null>
}
const subscriptionChecks = new WeakMap<TokenSource, SubscriptionCheck>()

export function agentIdentityId(tokenSourceId: string, model: string): string {
  return `agent:${Buffer.from(`${tokenSourceId}\u0000${model}`, 'utf8').toString('base64url')}`
}

export function getAgentIdentityCatalog(codexAccountId = 'default'): AgentIdentityCatalog {
  return buildAgentIdentityCatalog(identitySources(codexAccountId))
}

/** Skill 发现身份时惰性校验订阅；不修改 MD 使用的来源、模型目录或启用状态。 */
export function getAgentSkillIdentityCatalog(codexAccountId = 'default'): Promise<AgentIdentityCatalog> {
  return buildAgentSkillIdentityCatalog(identitySources(codexAccountId))
}

function identitySources(codexAccountId: string): TokenSource[] {
  return listTokenSources().map(source => source.forAccount?.(codexAccountId) ?? source)
}

export async function buildAgentSkillIdentityCatalog(sources: TokenSource[]): Promise<AgentIdentityCatalog> {
  const catalog = buildAgentIdentityCatalog(sources)
  const checks = await Promise.all(sources.filter(source => source.kind === 'claude-subscription').map(async source => {
    const existingFailure = catalog.sourceFailures.find(failure => failure.tokenSourceId === source.id)
    if (existingFailure) return existingFailure
    const reason = await subscriptionFailure(source)
    return reason === null ? null : { tokenSourceId: source.id, display: source.display, status: 'failed' as const, reason }
  }))
  const failures = checks.filter((failure): failure is AgentSourceFailure => failure !== null)
  const unavailable = new Set(failures.map(failure => failure.tokenSourceId))
  return identityCatalog(
    catalog.identities.filter(identity => !unavailable.has(identity.tokenSourceId)),
    [...catalog.sourceFailures.filter(failure => !unavailable.has(failure.tokenSourceId)), ...failures],
  )
}

function subscriptionFailure(source: TokenSource): Promise<string | null> {
  const cached = subscriptionChecks.get(source)
  if (cached && (cached.expiresAt === null || Date.now() < cached.expiresAt)) return cached.result
  // 只缓存校验结论；模型目录仍实时生成，配置重建后的 source 不沿用旧账号结论。
  const check: SubscriptionCheck = {
    expiresAt: null,
    result: readSubscriptionFailure(source).finally(() => {
      check.expiresAt = Date.now() + SUBSCRIPTION_CHECK_TTL_MS
    }),
  }
  subscriptionChecks.set(source, check)
  return check.result
}

async function readSubscriptionFailure(source: TokenSource): Promise<string | null> {
  let reason: string
  try {
    // accountInfo / supportedModels 可由本机登录信息返回；原生额度接口才实际检查当前订阅。
    const usage = await source.readUsage()
    if (usage.state === 'ok') return null
    reason = usage.reason ?? `订阅可用性查询失败：${usage.state}`
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  log(`agent identities ${source.id} MISS: ${reason}`)
  return reason
}

export function buildAgentIdentityCatalog(sources: TokenSource[]): AgentIdentityCatalog {
  const identities: AgentIdentity[] = []
  const sourceFailures: AgentSourceFailure[] = []
  for (const source of sources) collectSource(source, identities, sourceFailures)
  return identityCatalog(identities, sourceFailures)
}

function identityCatalog(identities: AgentIdentity[], sourceFailures: AgentSourceFailure[]): AgentIdentityCatalog {
  return {
    catalogGeneration: createHash('sha256')
      .update(JSON.stringify({ identities, sourceFailures }))
      .digest('hex')
      .slice(0, 16),
    identities,
    sourceFailures,
  }
}

function collectSource(
  source: TokenSource,
  identities: AgentIdentity[],
  failures: AgentSourceFailure[],
): void {
  const catalogState = source.modelCatalogState?.status
    ?? (!source.enabled ? 'disabled' : source.models.length > 0 ? 'ready' : 'idle')
  if (!source.enabled) {
    failures.push({ tokenSourceId: source.id, display: source.display, status: 'disabled', reason: '账号未启用' })
  } else if (catalogState === 'loading' || catalogState === 'idle') {
    failures.push({ tokenSourceId: source.id, display: source.display, status: 'loading', reason: '模型目录正在刷新' })
  } else if (catalogState === 'failed') {
    failures.push({
      tokenSourceId: source.id,
      display: source.display,
      status: 'failed',
      reason: source.modelCatalogState?.error ?? '模型目录刷新失败',
    })
  } else if (source.models.length === 0) {
    failures.push({ tokenSourceId: source.id, display: source.display, status: 'models_miss', reason: '模型目录为空' })
  }
  for (const model of source.models) identities.push(materializeIdentity(source, model, catalogState))
}

function materializeIdentity(source: TokenSource, model: TokenSourceModel, catalogState: string): AgentIdentity {
  let status: AgentIdentityStatus = 'ready'
  let reason: string | undefined
  if (!source.enabled) {
    status = 'source_disabled'
    reason = '所属 Token Source 未启用'
  } else if (catalogState === 'loading' || catalogState === 'idle') {
    status = 'catalog_loading'
    reason = '模型目录正在刷新'
  } else if (catalogState === 'failed') {
    status = 'catalog_failed'
    reason = source.modelCatalogState?.error ?? '模型目录刷新失败'
  } else if (model.unavailableReason || !model.efforts.length) {
    status = 'model_unavailable'
    reason = model.unavailableReason ?? 'effort MISS：上游未声明该后端支持的推理档位'
  }
  return {
    id: agentIdentityId(source.id, model.model),
    displayName: `${source.display} · ${model.display}`,
    tokenSourceId: source.id,
    tokenSourceDisplay: source.display,
    provider: source.agent,
    model: model.model,
    modelDisplay: model.display,
    defaultEffort: model.defaultEffort,
    supportedEfforts: [...model.efforts],
    sourceDefault: comparableModel(source.defaultModel) === comparableModel(model.model),
    status,
    ...(reason ? { reason } : {}),
    spawnRevision: source.spawnRevision,
  }
}

function comparableModel(value: string): string {
  return value.replace(/\[1m\]$/i, '').toLowerCase()
}
