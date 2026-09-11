import { networkFetch } from './network'
/**
 * GLM Coding Plan 用量快照 —— 给 `hi` console 面板的 claude/GLM 后端用。
 *
 * 数据源是 GLM 官方 `glm-plan-usage` 插件背后同一条 monitor API(逆向自
 * zai-org/zai-coding-plugins 的 query-usage.mjs),daemon 直接打,不走
 * plugin/agent/skill 那套(那是 Claude Code CLI 用的):
 *
 *   GET {baseDomain}/api/monitor/usage/quota/limit
 *
 * 鉴权用 Claude Code 自己的两个标准环境变量 —— 它们不在 daemon 进程 env 里
 * (systemd 起的 daemon 不继承),而是写在 `~/.claude/settings.json` 的 env
 * 段、由 Claude CLI 启动子进程时注入。所以这里自己读文件拿:
 *   ANTHROPIC_AUTH_TOKEN → 裸 token,直接作 Authorization header(不带 Bearer)
 *   ANTHROPIC_BASE_URL   → 判定平台 host(open.bigmodel.cn=ZHIPU / api.z.ai=ZAI)
 *
 * 失败可见 (no_fallbacks):无凭据 / 非 GLM 后端 / 限流 / 网络各自显式标 MISS,
 * 绝不假数据。与 src/usage.ts(Codex 侧)的 snapshot 模式对齐。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from './log'

const API_TIMEOUT_MS = 10_000

export interface GlmUsageWindow {
  /** 0–100 已用百分比;未知为 null(MISS) */
  percent: number | null
  /** 下次重置;未知为 null */
  resetsAt: Date | null
}

export interface GlmMonthlyWindow extends GlmUsageWindow {
  /** 已用绝对值(调用次数);TIME_LIMIT 才有 */
  used?: number
  /** 周期总额度;TIME_LIMIT 才有 */
  total?: number
}

export type GlmUsageSnapshot =
  | { state: 'no_credentials' }
  | { state: 'not_glm'; baseUrl?: string }
  | { state: 'rate_limited' }
  | { state: 'network'; reason?: string }
  | {
      state: 'ok'
      /** 套餐档位(open.bigmodel.cn 的 level 字段:max / standard / …) */
      level?: string
      /** 5 小时 token 滚动窗口(TOKENS_LIMIT unit=3 number=5) */
      fiveHour: GlmUsageWindow | null
      /** 周额度窗口(TOKENS_LIMIT unit=6 number=1);无周限额套餐为 null */
      weekly: GlmUsageWindow | null
      /** 月度工具/MCP 用量(TIME_LIMIT) */
      monthly: GlmMonthlyWindow | null
      fetchedAt: number
    }

type GlmUsageSnapshotOk = Extract<GlmUsageSnapshot, { state: 'ok' }>

let cache: GlmUsageSnapshot | null = null
let inFlight: Promise<GlmUsageSnapshot> | null = null

/** Claude Code settings 目录:优先 CLAUDE_CONFIG_DIR,否则 ~/.claude。 */
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/**
 * 读 ~/.claude/settings.json 的 env 段。daemon 进程默认 env 里没有
 * ANTHROPIC_* —— 那是 Claude CLI 注入给子进程的;这里从文件读才是真相源。
 * 读不到(文件缺失/解析失败)返回空 record,调用方按 no_credentials 处理。
 */
export function readClaudeSettingsEnv(): Record<string, string> {
  try {
    const raw = readFileSync(join(claudeConfigDir(), 'settings.json'), 'utf8')
    const env = JSON.parse(raw)?.env
    return env && typeof env === 'object' ? env as Record<string, string> : {}
  } catch (e) {
    log(`glm-usage: read settings.json env failed: ${e}`)
    return {}
  }
}

/** 判定一个 base_url 是否指向 GLM 官方平台 —— GLM source 的 detect(本机 settings.json 探测)
 *  与 build enabled + 额度查询(glmDomain)共用同一套 host,避免「探测说是 GLM、额度说不是」的认知割裂。
 *  只有官方端点(open./dev.bigmodel.cn、api.z.ai)才算 GLM source;第三方中转不匹配 → 不自动启用。 */
export function isGlmBaseUrl(baseUrl: string): boolean {
  // 严格 hostname 比较(非子串):解析 URL 取 hostname —— 避免 `open.bigmodel.cn.evil.example`
  // 或 URL 查询参数里含该文本被误判;hostname 大小写归一化。解析失败(无协议等)→ false。
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'open.bigmodel.cn' || host === 'dev.bigmodel.cn' || host === 'api.z.ai'
  } catch {
    return false
  }
}

/** 从 ANTHROPIC_BASE_URL 取 protocol//host;非法返回 null。 */
function baseDomain(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/** 判定是否 GLM 平台 host,返回 domain 或 null(非 GLM)。与 isGlmBaseUrl 共用判定。 */
function glmDomain(baseUrl: string): string | null {
  const domain = baseDomain(baseUrl)
  return domain && isGlmBaseUrl(baseUrl) ? domain : null
}

function clampPct(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, v)) : null
}

function resetDate(ms: unknown): Date | null {
  return typeof ms === 'number' && isFinite(ms) && ms > 0 ? new Date(ms) : null
}

/** 解析 quota/limit 响应 → ok 快照;limits 缺字段按 null(MISS)渲染。
 * TOKENS_LIMIT 有两条:5h 窗口(unit=3 number=5)和周窗口(unit=6 number=1)
 * —— 靠 unit/number 区分,不能只 find 第一条(有周限额的账号会丢窗口或错配;
 * 无周限额的账号响应里只有 5h 那条,weekly 落 null)。字段语义来自
 * opencode-glm-quota / pi-glm-usage 对同一 API 的解析,2026-08-17 核实。 */
function parseQuotaLimit(data: any): GlmUsageSnapshotOk {
  const limits: any[] = Array.isArray(data?.limits) ? data.limits : []
  const tokens = limits.filter(l => l?.type === 'TOKENS_LIMIT')
  const fiveHourLimit = tokens.find(l => l?.unit === 3 && l?.number === 5)
  const weeklyLimit = tokens.find(l => l?.unit === 6 && l?.number === 1)
  const time = limits.find(l => l?.type === 'TIME_LIMIT')
  const win = (l: any): GlmUsageWindow | null =>
    l ? { percent: clampPct(l.percentage), resetsAt: resetDate(l.nextResetTime) } : null
  const fiveHour = win(fiveHourLimit)
  const weekly = win(weeklyLimit)
  const monthly: GlmMonthlyWindow | null = time
    ? {
        percent: clampPct(time.percentage),
        resetsAt: resetDate(time.nextResetTime),
        ...(typeof time.currentValue === 'number' ? { used: time.currentValue } : {}),
        ...(typeof time.usage === 'number' ? { total: time.usage } : {}),
      }
    : null
  return {
    state: 'ok',
    level: typeof data?.level === 'string' && data.level ? data.level : undefined,
    fiveHour,
    weekly,
    monthly,
    fetchedAt: Date.now(),
  }
}

export async function fetchGlmUsage(baseUrlOverride?: string, tokenOverride?: string): Promise<GlmUsageSnapshot> {
  const env = (baseUrlOverride && tokenOverride)
    ? { ANTHROPIC_BASE_URL: baseUrlOverride, ANTHROPIC_AUTH_TOKEN: tokenOverride }
    : readClaudeSettingsEnv()
  const token = env.ANTHROPIC_AUTH_TOKEN
  const baseUrl = env.ANTHROPIC_BASE_URL || ''
  if (!token) return { state: 'no_credentials' }

  const domain = glmDomain(baseUrl)
  if (!domain) return { state: 'not_glm', baseUrl: baseUrl || undefined }

  const url = `${domain}/api/monitor/usage/quota/limit`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const res = await networkFetch(url, {
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
      },
      signal: controller.signal,
    })
    if (res.status === 429) return { state: 'rate_limited' }
    if (!res.ok) return { state: 'network', reason: `HTTP ${res.status}` }
    const json = await res.json()
    if (json?.success === false || (typeof json?.code === 'number' && json.code !== 200)) {
      return { state: 'network', reason: json?.msg ? String(json.msg) : `code ${json?.code}` }
    }
    const data = json?.data ?? json
    return parseQuotaLimit(data)
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? `timeout ${API_TIMEOUT_MS}ms` : (e?.message ?? String(e))
    log(`glm-usage: quota/limit fetch failed: ${reason}`)
    return { state: 'network', reason }
  } finally {
    clearTimeout(timer)
  }
}

export async function readGlmUsage(): Promise<GlmUsageSnapshot> {
  if (inFlight) return inFlight
  inFlight = fetchGlmUsage()
    .then(d => {
      inFlight = null
      // 网络态保留上次成功的 cache(若有),否则如实返回失败态 ——
      // 与 usage.ts 一致:绝不假数据。
      if (d.state === 'network') return cache ?? d
      cache = d
      return d
    })
    .catch(e => {
      log(`glm-usage: fetchGlmUsage threw: ${e}`)
      inFlight = null
      return cache ?? { state: 'network', reason: String(e) }
    })
  return inFlight
}
