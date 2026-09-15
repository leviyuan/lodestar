import { networkFetch } from './network'
import type { UsageSnapshotUnified } from './token-source'

export const RECLAUDE_API_BASE_URL = 'https://reclaude.ai'

function amount(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`ReClaude 额度响应 ${field} 缺失或无效`)
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`ReClaude 额度响应 ${field} 无效`)
  return parsed
}

/** 拼车金额是 5 小时窗口的用量口径，不能作为账户余额展示。 */
export function reclaudeUsageSnapshot(data: unknown): UsageSnapshotUnified {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('ReClaude 额度响应格式无效')
  }
  const value = data as Record<string, unknown>
  if (value.enabled !== true) throw new Error('ReClaude 当前组织未开放拼车额度查询')
  if (value.status !== 'active' && value.status !== 'depleted') {
    throw new Error(`ReClaude 拼车额度状态不可用：${typeof value.status === 'string' ? value.status : 'MISS'}`)
  }
  const used = amount(value.used_usd, 'used_usd')
  const total = amount(value.quota_usd, 'quota_usd')
  if (total <= 0) throw new Error('ReClaude 拼车额度 quota_usd 必须大于零')
  const reset = value.resets_at_ms
  if (reset !== null && (typeof reset !== 'number' || !Number.isFinite(reset) || reset <= 0
    || !Number.isFinite(new Date(reset).getTime()))) {
    throw new Error('ReClaude 额度响应 resets_at_ms 缺失或无效')
  }
  return {
    state: 'ok', kind: 'quota', fetchedAt: Date.now(),
    windows: [{ kind: 'fiveHour', label: '拼车 5h 窗口', percent: used / total * 100,
      resetsAt: reset === null ? null : new Date(reset as number), used, total }],
  }
}

/** rck_ 个人 key 仅供只读接口，绝不注入 Claude 模型进程。 */
export async function fetchReclaudeUsage(apiKey: string | undefined, orgId: string | undefined): Promise<UsageSnapshotUnified> {
  if (!apiKey?.trim()) return { state: 'no_credentials', windows: [], reason: '未配置 ReClaude 个人只读 API key' }
  try {
    if (!orgId || !/^[1-9]\d*$/.test(orgId)) throw new Error('未配置有效的 ReClaude 拼车组织 org_id')
    const url = new URL('/api/v1/carpool/quota', RECLAUDE_API_BASE_URL)
    url.searchParams.set('org_id', orgId)
    const response = await networkFetch(url, {
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return {
      state: response.status === 401 || response.status === 403 ? 'no_credentials'
        : response.status === 429 ? 'rate_limited' : 'network',
      windows: [], reason: `ReClaude 额度接口 HTTP ${response.status}`,
    }
    return reclaudeUsageSnapshot(await response.json())
  } catch (error) {
    return { state: 'network', windows: [], reason: error instanceof Error ? error.message : String(error) }
  }
}
