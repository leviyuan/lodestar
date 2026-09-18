import { homedir } from 'node:os'
import type { ClaudeSpawnOpts } from './claude-agent-process'
import type { UsageSnapshotUnified, UsageWindowUnified } from './token-source'
import { log } from './log'
import { resolveClaudeSdkModel } from './claude-models'
import { UsageReadCache, isUsageRateLimitError } from './usage-cache'

const TIMEOUT_MS = 30_000
const usageReads = new UsageReadCache<UsageSnapshotUnified>()
type JsonObject = Record<string, unknown>

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function usageWindow(value: unknown, kind: string, label: string): UsageWindowUnified {
  if (value == null) return { kind, label, percent: null, resetsAt: null }
  if (!object(value)) throw new Error(`Claude ${label}格式无效`)
  const percent = value.utilization
  if (percent !== null && (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100)) {
    throw new Error(`Claude ${label} utilization 缺失或无效`)
  }
  const reset = value.resets_at
  if (reset !== null && (typeof reset !== 'string' || !Number.isFinite(Date.parse(reset)))) {
    throw new Error(`Claude ${label} resets_at 缺失或无效`)
  }
  return { kind, label, percent, resetsAt: reset === null ? null : new Date(reset as string) }
}

/** 同一模型族的 alias、完整模型 ID 和 SDK 显示名使用同一个额度桶。 */
function modelFamily(model: string): string {
  return model.trim().toLowerCase()
    .replace(/^claude:/, '').replace(/\[1m\]$/, '')
    .replace(/^claude[-\s]+/, '')
    // 旧 ID 的版本号在族名前，例如 claude-3-5-sonnet-20241022。
    .replace(/^(?:\d+[.-])+/, '')
    .split(/[-\s]+/, 1)[0]!
}

/** 有匹配的模型专属周额度时采用该桶；其余模型使用总周额度。 */
export function claudeWeeklyUsageWindow(snapshot: UsageSnapshotUnified, model: string | null): UsageWindowUnified | null {
  if (snapshot.state !== 'ok' || !model?.trim()) return null
  // default/旧 profile 别名与真实启动共用解析；未提供模型时不猜默认账号模型。
  const family = modelFamily(resolveClaudeSdkModel(model.trim()))
  if (!family || family === 'default') return null
  const matching = snapshot.windows.filter(window => {
    const scope = window.kind.startsWith('modelWeekly:') ? window.kind.slice('modelWeekly:'.length)
      : window.kind === 'seven_day_opus' ? 'opus'
      : window.kind === 'seven_day_sonnet' ? 'sonnet' : null
    return scope !== null && modelFamily(scope) === family
  })
  if (matching.length > 1) {
    log(`Claude weekly usage MISS: ${model} 匹配多个模型专属周额度窗口`)
    return null
  }
  // 专属桶已返回但数据缺失时，继续显示其 MISS，不替换为总额度。
  if (matching.length === 1) return matching[0]!
  return snapshot.windows.find(window => window.kind === 'weekly') ?? null
}

/** /usage 的 utilization 已是 0–100 百分比，区别于流式事件中的 0–1 比例。 */
export function claudeUsageSnapshot(data: unknown): UsageSnapshotUnified {
  if (!object(data) || typeof data.subscription_type !== 'string' || !data.subscription_type.trim()) {
    throw new Error('Claude 订阅额度响应缺少订阅身份')
  }
  if (data.rate_limits_available !== true) throw new Error('Claude 原生接口未开放当前订阅额度查询')
  if (!object(data.rate_limits)) throw new Error('Claude 原生额度接口未返回 rate_limits 数据')
  const limits = data.rate_limits
  // 主窗口缺失仍保留 MISS，不能用模型专属窗口冒充总周额度。
  const windows = [
    usageWindow(limits.five_hour, 'fiveHour', '5h 窗口'),
    usageWindow(limits.seven_day, 'weekly', '周额度'),
  ]
  let reported = limits.five_hour != null || limits.seven_day != null
  for (const [key, label] of [
    ['seven_day_oauth_apps', 'OAuth 应用周额度'],
    ['seven_day_opus', 'Opus 周额度'],
    ['seven_day_sonnet', 'Sonnet 周额度'],
  ] as const) {
    if (limits[key] == null) continue
    windows.push(usageWindow(limits[key], key, label))
    reported = true
  }
  if (limits.model_scoped != null) {
    if (!Array.isArray(limits.model_scoped)) throw new Error('Claude 模型专属额度 model_scoped 格式无效')
    for (const model of limits.model_scoped) {
      if (!object(model) || typeof model.display_name !== 'string' || !model.display_name.trim()) {
        throw new Error('Claude 模型专属额度缺少模型名称')
      }
      const name = model.display_name.trim()
      windows.push(usageWindow(model, `modelWeekly:${name}`, `${name} 周额度`))
      reported = true
    }
  }
  if (!reported) throw new Error('Claude 原生额度接口未返回任何订阅额度窗口')
  return { state: 'ok', windows, fetchedAt: Date.now() }
}

/** 沿用订阅来源的认证隔离；独立控制查询用完即关，瞬态失败沿用最近成功快照。 */
export async function fetchClaudeSubscriptionUsage(options: Pick<ClaudeSpawnOpts,
  'settingSources' | 'settings' | 'transformEnv' | 'validateAccount' | 'tokenSourceId'>): Promise<UsageSnapshotUnified> {
  return usageReads.readStale('claude-subscription', () => requestClaudeSubscriptionUsage(options))
}

async function requestClaudeSubscriptionUsage(options: Pick<ClaudeSpawnOpts,
  'settingSources' | 'settings' | 'transformEnv' | 'validateAccount' | 'tokenSourceId'>): Promise<UsageSnapshotUnified> {
  try {
    const { ClaudeAgentProcess } = await import('./claude-agent-process')
    const proc = new ClaudeAgentProcess({ workDir: homedir(), effort: 'default',
      allowDelegation: false, profile: { loadProjectMcp: false }, ...options })
    proc.on('error', error => log(`Claude subscription usage MISS: ${error.message}`))
    let timer: ReturnType<typeof setTimeout> | undefined
    let failure: Error | undefined
    try {
      const data = await Promise.race([
        proc.readSubscriptionUsage(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Claude 订阅额度查询超时（${TIMEOUT_MS / 1000}s）`)), TIMEOUT_MS)
        }),
      ])
      return claudeUsageSnapshot(data)
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
      throw failure
    } finally {
      clearTimeout(timer)
      try { await proc.kill() }
      catch (error) {
        if (failure) throw new AggregateError([failure, error],
          `${failure.message}；额度查询进程关闭失败：${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log(`claude-sub readUsage MISS: ${reason}`)
    return {
      state: (error as { code?: string })?.code === 'CLAUDE_SUBSCRIPTION_AUTH_MISSING' ? 'no_credentials'
        : isUsageRateLimitError(error) ? 'rate_limited' : 'network',
      windows: [], reason,
    }
  }
}
