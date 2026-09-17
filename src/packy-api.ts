import { networkFetch } from './network'
import { fetchApiModelData } from './token-source-model-api'
import { tokenSourceErrorMessage } from './token-source-errors'
import type { UsageSnapshotUnified } from './token-source'
import { UsageReadCache, usageCredentialKey, usageRetryAfter } from './usage-cache'
import { log } from './log'

export const PACKY_BASE_URL = 'https://cf.api.fan'
export const PACKY_MANAGEMENT_URL = 'https://www.packyapi.ai'

export function packyApiRoot(raw: string): string {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('PackyAPI 地址必须是无凭据、查询参数和 fragment 的 HTTP(S) API 根地址')
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  return url.toString().replace(/\/$/, '')
}

/** 官方推理域名没有 /api 管理路由；自建地址的管理接口仍属于自身 origin。 */
export function packyManagementRoot(base: string): string {
  const root = packyApiRoot(base)
  const url = new URL(root)
  return url.protocol === 'https:' && !url.port && url.pathname === '/'
    && ['cf.api.fan', 'slb-v1.api.fan', 'www.packyapi.ai'].includes(url.hostname)
    ? PACKY_MANAGEMENT_URL : root
}

export interface PackyModel {
  id: string
  display: string
  protocols: string[]
  reasoning?: Record<string, unknown>
}

const modelReads = new Map<string, Promise<PackyModel[]>>()

/** 两种 Agent 共享同一令牌的在途查询；完成后不保留旧目录。 */
export function fetchPackyModels(base: string, key: string): Promise<PackyModel[]> {
  const root = packyApiRoot(base)
  const cacheKey = usageCredentialKey('packy-models', root, key)
  const pending = modelReads.get(cacheKey)
  if (pending) return pending
  const request = fetchApiModelData(`${root}/v1/models`, key, 'PackyAPI models').then(data => {
    const seen = new Set<string>()
    return data.map(entry => {
      if (typeof entry.id !== 'string' || !entry.id.trim() || seen.has(entry.id)
        || !Array.isArray(entry.supported_endpoint_types) || !entry.supported_endpoint_types.length
        || !entry.supported_endpoint_types.every(value => typeof value === 'string' && value)) {
        throw new Error('PackyAPI 模型目录缺少有效 id/协议声明，或含重复模型')
      }
      seen.add(entry.id)
      return { id: entry.id, display: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
        protocols: [...entry.supported_endpoint_types] as string[],
        ...(object(entry.reasoning) ? { reasoning: entry.reasoning } : {}) }
    })
  }).finally(() => { if (modelReads.get(cacheKey) === request) modelReads.delete(cacheKey) })
  modelReads.set(cacheKey, request)
  return request
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

class PackyHttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number) {
    super(`PackyAPI HTTP ${status}: ${message}`)
  }
}

async function readJson(url: string, key?: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await networkFetch(url, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'Lodestar-Account-Balance/1.0', ...headers,
      ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let json: unknown
  try { json = JSON.parse(text) }
  catch { throw new PackyHttpError(response.status, '响应不是有效 JSON', usageRetryAfter(response.headers)) }
  const code = object(json) ? json.code : undefined
  const failedCode = code !== undefined && ![true, 0, 200, '0', '200'].some(value => value === code)
  if (!response.ok || !object(json) || json.success === false || failedCode || json.error != null) {
    const error = object(json) && object(json.error) ? json.error.message : object(json) ? json.message : null
    throw new PackyHttpError(response.status, typeof error === 'string' ? error : '上游接口返回错误', usageRetryAfter(response.headers))
  }
  return json
}

const usageReads = new UsageReadCache<UsageSnapshotUnified>()

/** New API /user/self 的 quota 是账户剩余额度；单位以当前站点声明为准。 */
export async function fetchPackyBalance(base: string, token: string, userId: string, fresh = false): Promise<UsageSnapshotUnified> {
  token = token.trim(); userId = userId.trim()
  if (!token || !/^[1-9]\d*$/.test(userId) || !Number.isSafeInteger(Number(userId))) {
    return { state: 'no_credentials', kind: 'balance', windows: [],
      reason: 'PackyAPI 真实余额需要系统访问令牌和正整数用户 ID；请配置 packy-balance-setup。' }
  }
  const root = packyApiRoot(base)
  const cacheKey = usageCredentialKey('packy-balance', root, JSON.stringify([userId, token]))
  const load = async (): Promise<UsageSnapshotUnified> => {
    try {
      const json = await readJson(`${root}/api/user/self`, token, { 'New-Api-User': userId })
      const data = json.data
      if (json.success !== true || !object(data) || data.id !== Number(userId)) {
        throw new Error('PackyAPI 账户响应缺少成功状态，或用户 ID 与余额凭据不匹配')
      }
      if (typeof data.quota !== 'number' || !Number.isSafeInteger(data.quota)) {
        throw new Error('PackyAPI 账户余额 quota 缺失或无效')
      }
      const status = (await readJson(`${root}/api/status`)).data
      if (!object(status) || typeof status.quota_per_unit !== 'number' || !Number.isFinite(status.quota_per_unit)
        || status.quota_per_unit <= 0 || status.quota_display_type !== 'USD') {
        throw new Error('PackyAPI 账户余额单位缺失或不是已支持的 USD 单位')
      }
      const remaining = data.quota / status.quota_per_unit
      if (!Number.isFinite(remaining)) throw new Error('PackyAPI 账户余额换算结果无效')
      return { state: 'ok', kind: 'balance', windows: [], fetchedAt: Date.now(), balance: { remaining, currency: 'USD' } }
    } catch (error) {
      const reason = tokenSourceErrorMessage(error, [token])
      log(`PackyAPI balance MISS: ${reason}`)
      return { state: error instanceof PackyHttpError && [401, 403].includes(error.status) ? 'no_credentials'
        : error instanceof PackyHttpError && error.status === 429 ? 'rate_limited' : 'network',
        kind: 'balance', windows: [], reason,
        ...(error instanceof PackyHttpError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) }
    }
  }
  if (!fresh) return usageReads.read(cacheKey, load)
  // setup 必须重新验证，不能靠此前的成功缓存接受失效凭据。
  const result = await load()
  if (result.state === 'ok') usageReads.prime(cacheKey, result)
  else usageReads.invalidate(cacheKey)
  return result
}

/** API key 提供令牌配额，绝不把无限令牌的占位数值当成账户余额。 */
export async function fetchPackyUsage(base: string, key: string): Promise<UsageSnapshotUnified> {
  if (!key) return { state: 'no_credentials', kind: 'quota', windows: [] }
  const root = packyManagementRoot(base)
  return usageReads.read(usageCredentialKey('packy', root, key), async () => {
    try {
      const json = await readJson(`${root}/api/usage/token/`, key)
      const data = json.data
      if (!object(data) || typeof data.unlimited_quota !== 'boolean') throw new Error('PackyAPI 令牌配额响应缺少 unlimited_quota')
      if (data.unlimited_quota) return { state: 'not_applicable', kind: 'balance', windows: [],
        reason: '此 API key 为无限额度令牌；令牌接口不提供账户余额，需要系统访问令牌查询。' }
      const remaining = data.total_available, limit = data.total_granted
      if (typeof remaining !== 'number' || !Number.isFinite(remaining)
        || typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
        throw new Error('PackyAPI 令牌配额数值缺失或无效')
      }
      const status = (await readJson(`${root}/api/status`)).data
      if (!object(status) || typeof status.quota_per_unit !== 'number' || !Number.isFinite(status.quota_per_unit)
        || status.quota_per_unit <= 0 || status.quota_display_type !== 'USD') {
        throw new Error('PackyAPI 配额单位缺失或不是已支持的 USD 额度单位')
      }
      return { state: 'ok', kind: 'quota', windows: [], fetchedAt: Date.now(),
        quota: { remaining: remaining / status.quota_per_unit, limit: limit / status.quota_per_unit, currency: 'USD' } }
    } catch (error) {
      const reason = tokenSourceErrorMessage(error, [key])
      log(`PackyAPI quota MISS: ${reason}`)
      return { state: error instanceof PackyHttpError && [401, 403].includes(error.status) ? 'no_credentials'
        : error instanceof PackyHttpError && error.status === 429 ? 'rate_limited' : 'network',
        kind: 'quota', windows: [], reason,
        ...(error instanceof PackyHttpError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) }
    }
  })
}
