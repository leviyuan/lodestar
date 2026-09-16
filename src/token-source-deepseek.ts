import { networkFetch } from './network'
/**
 * DeepSeek token source(anthropic 兼容端点)—— 自包含 provider 模块。
 *
 * DeepSeek 官方提供 Anthropic 兼容端点(https://api.deepseek.com/anthropic),
 * 认证用 x-api-key → SDK 读 ANTHROPIC_API_KEY(注意:与 GLM 的
 * ANTHROPIC_AUTH_TOKEN / Bearer 不同 —— DeepSeek 走裸 api-key)。
 *
 * 模型 = OpenAI 风格 GET {origin}/models 动态拉(anthropic 侧 /v1/models 404);
 *      + config models 键补充(同 glm 约定);
 * 默认模型/slots = config model/slots 键(无代码级模型名默认);
 * [1m] 后缀 = 真实 turn 观测决策(context-window-observe.ts);
 * 额度 = {host}/user/balance(剩余余额标量,非 GLM 的滚动窗口百分比);
 * enabled = config [token_source.deepseek] 有 api_key(base_url 有官方默认,故只认 key)。
 *
 * 与 GLM / native 无互斥:GLM 的 isGlmBaseUrl 只认 bigmodel/z.ai host,DeepSeek
 * 官方 host 不被吞;native 的 enabled 只看 GLM 判定取反 —— 三者靠 model 面板的
 * tokenSourceId 二选一,可并存。模块加载时 registerTokenSourceFactory 声明式登记。
 */

import type { TokenSourceConfig } from './config'
import {
  type TokenSource,
  type TokenSourceModel,
  type UsageSnapshotUnified,
  scrubAnthropicEnv,
  registerTokenSourceFactory,
} from './token-source'
import { CLAUDE_EFFORTS } from './token-source-models'
import { resolveModelWithWindow, observedContextWindow } from './context-window-observe'
import { verifyModelExists } from './model-existence'
import { log } from './log'
import { fetchApiModelData } from './token-source-model-api'

type Env = Record<string, string | undefined>

/** DeepSeek 官方 Anthropic 兼容端点(用户可在 config 覆盖,如自建中转)。 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'

/** config models 键解析:逗号分隔 slug → 干净数组。 */
function parseModelList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

/** 版本号排序取最新(默认模型兜底用):'deepseek-v4-pro' → 4,数字大 = 新。零模型名假设。 */
function latestByVersion(models: string[]): string {
  const versionOf = (id: string): number => {
    const m = id.match(/(\d+(?:\.\d+)?)/)
    return m ? Number(m[1]) : -1
  }
  return [...models].sort((a, b) => versionOf(b) - versionOf(a))[0] ?? ''
}

/** config slots 键解析:'opus=X,sonnet=Y,haiku=Z' → record;非法段忽略。 */
function parseSlots(raw: string | undefined): Partial<Record<'opus' | 'sonnet' | 'haiku', string>> {
  const out: Partial<Record<'opus' | 'sonnet' | 'haiku', string>> = {}
  for (const seg of (raw ?? '').split(',')) {
    const eq = seg.indexOf('=')
    if (eq <= 0) continue
    const slot = seg.slice(0, eq).trim().toLowerCase()
    const model = seg.slice(eq + 1).trim()
    if ((slot === 'opus' || slot === 'sonnet' || slot === 'haiku') && model) out[slot] = model
  }
  return out
}

/** 判定 base_url 是否 DeepSeek 官方端点(detect 探测本机配置用)。 */
function isDeepseekBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.deepseek.com'
  } catch { return false }
}

/** OpenAI 风格 GET {origin}/models → 模型 id 列表(anthropic 侧 /v1/models 是 404)。 */
async function fetchDeepseekModels(baseUrl: string, apiKey: string): Promise<TokenSourceModel[]> {
  const ids = await fetchDeepseekModelIds(new URL(baseUrl).origin, apiKey)
  return ids.map(id => ({ model: id, display: id, efforts: CLAUDE_EFFORTS, defaultEffort: 'high' as const }))
}

export async function fetchDeepseekModelIds(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = new URL(baseUrl)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('DeepSeek 需要无凭据和查询参数的 HTTP(S) API 根地址')
  }
  const data = await fetchApiModelData(`${url.toString().replace(/\/+$/, '')}/models`, apiKey, 'DeepSeek models')
  return data.map(entry => {
    if (typeof entry.id !== 'string' || !entry.id.trim()) throw new Error('DeepSeek models 模型 id 无效')
    return entry.id
  })
}

const BALANCE_TIMEOUT_MS = 10_000

/** GET {host}/user/balance(OpenAI 根路径,Bearer 认证)→ 剩余余额标量。
 *  DeepSeek 是充值余额模型，返回结构化余额、windows 空;
 *  失败如实 MISS(no_fallbacks),绝不假数据。 */
export async function fetchDeepseekBalance(baseUrl: string, apiKey: string): Promise<UsageSnapshotUnified> {
  let origin: string
  try {
    origin = new URL(baseUrl).origin
  } catch {
    return { kind: 'balance', state: 'network', windows: [], reason: 'bad base_url' }
  }
  try {
    const res = await networkFetch(`${origin}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json: any = await res.json()
    const infos: any[] = Array.isArray(json?.balance_infos) ? json.balance_infos : []
    const info = infos[0]
    const currency = typeof info?.currency === 'string' ? info.currency : ''
    const total = info?.total_balance
    if (!currency || (typeof total !== 'string' && typeof total !== 'number')
      || String(total).trim() === '' || !Number.isFinite(Number(total))) throw new Error('余额明细缺失或无效')
    return {
      kind: 'balance', state: 'ok',
      windows: [],
      balance: { remaining: Number(total), currency },
    }
  } catch (e: any) {
    log(`deepseek readUsage MISS: ${e?.message ?? e}`)
    return { kind: 'balance', state: 'network', windows: [], reason: e?.message ?? String(e) }
  }
}

registerTokenSourceFactory({
  kind: 'deepseek',
  configSectionId: 'deepseek',
  build: (cfg: TokenSourceConfig, detected?: Partial<TokenSourceConfig> | null): TokenSource => {
    const baseUrl = cfg.base_url?.trim() || detected?.base_url?.trim() || DEFAULT_BASE_URL
    const apiKey = cfg.api_key?.trim() || detected?.api_key?.trim() || ''
    const enabled = !!apiKey
    // config 键(零代码默认):model = 默认模型;slots = SDK alias 槽位。
    const cfgDefaultModel = cfg.model?.trim() || undefined
    const slots = parseSlots(cfg.slots)
    const ts: TokenSource = {
      id: 'deepseek',
      kind: 'deepseek',
      agent: 'claude',
      display: cfg.display?.trim() || 'DeepSeek',
      enabled,
      models: [],
      modelCatalogState: { status: enabled ? 'idle' : 'disabled', updatedAt: Date.now() },
      defaultModel: cfgDefaultModel ?? '',
      async refreshModels(): Promise<void> {
        if (!ts.enabled) {
          ts.models = []
          ts.modelCatalogState = { status: 'disabled', updatedAt: Date.now() }
          return
        }
        ts.modelCatalogState = { status: 'loading', updatedAt: null }
        try {
          const fetched = await fetchDeepseekModels(baseUrl, apiKey)
          // config models 键补充(同 glm 约定):端点列表缺模型时手动补登,去重合并。
          const extra = [...new Set([...parseModelList(cfg.models), ...parseModelList(cfg.custom_models)])].filter(
            m => !fetched.some(f => f.model.toLowerCase() === m.toLowerCase()),
          )
          const extras: TokenSourceModel[] = extra.map(m => ({
            model: m, display: m, efforts: CLAUDE_EFFORTS, defaultEffort: 'high', origin: 'custom',
          }))
          ts.models = [...fetched, ...extras]
          // 默认模型:config model 键优先;未配 → 版本号最新的(flash<pro 不成立,
          // 4 同版本时取排序首个,行为确定)。列表空(拉取 MISS)→ 保持空,
          // spawn 侧 undefined → SDK 'opus' alias → config slots。
          if (!cfgDefaultModel) ts.defaultModel = latestByVersion(ts.models.map(m => m.model))
          // 1M 标注 = 真实 turn 观测缓存(纯被动,零探测)。
          for (const m of ts.models) {
            const observed = observedContextWindow('deepseek', m.model)
            m.context1m = observed != null && observed >= 1_000_000 || undefined
          }
          ts.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
        } catch (e: any) {
          log(`deepseek refreshModels MISS: ${e?.message ?? e}`)
          ts.models = []
          ts.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: e?.message ?? String(e) }
        }
      },
      spawnEnv(base: Env): Env {
        const out = scrubAnthropicEnv(base)
        // `base` already includes config.claude.env. Re-applying the raw
        // section after scrubbing would resurrect credentials belonging to a
        // different Anthropic-compatible source. The selected source must be
        // the final and sole authority for routing/authentication.
        const merged: Env = { ...out }
        merged.ANTHROPIC_BASE_URL = baseUrl
        // DeepSeek Anthropic 端点认 x-api-key → ANTHROPIC_API_KEY(非 AUTH_TOKEN/Bearer)。
        merged.ANTHROPIC_API_KEY = apiKey
        // slots 只从 config slots 键来(零代码默认);alias fallback 路径才读。
        if (slots.opus) merged.ANTHROPIC_DEFAULT_OPUS_MODEL = slots.opus
        if (slots.sonnet) merged.ANTHROPIC_DEFAULT_SONNET_MODEL = slots.sonnet
        if (slots.haiku) merged.ANTHROPIC_DEFAULT_HAIKU_MODEL = slots.haiku
        return merged
      },
      resolveSpawnModel(model: string): string | undefined {
        // [1m] 后缀同 GLM 约定:加不加由真实 turn 观测定(见 context-window-observe.ts),
        // 未观测时保留已有 [1m] 路由约定；请求错误不改变模型或窗口。
        return resolveModelWithWindow('deepseek', model)
      },
      async verifyModel(model: string) {
        return verifyModelExists(baseUrl, { 'x-api-key': apiKey }, model)
      },
      async readUsage(): Promise<UsageSnapshotUnified> {
        if (!apiKey) return { kind: 'balance', state: 'no_credentials', windows: [] }
        return fetchDeepseekBalance(baseUrl, apiKey)
      },
    }
    return ts
  },
  setup: {
    commandSuffix: 'deepseek',
    hint: display => `启用 ${display}:发送\n\`\`\`\ndeepseek-setup <api_key>\n\`\`\`\n默认官方 Anthropic 端点;自建中转用 \`deepseek-setup <base_url> <api_key>\`。`,
    parseArgs: args => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      if (!parts.length || parts.length > 2 || /^https?:\/\//i.test(parts.at(-1)!)) return { error: '用法:`deepseek-setup <api_key>`(官方端点)或 `deepseek-setup <base_url> <api_key>`(自建中转)' }
      const baseUrl = parts.length >= 2 ? parts[0] : undefined
      const apiKey = parts.length >= 2 ? parts[1] : parts[0]
      return { config: { agent: 'claude', ...(baseUrl ? { base_url: baseUrl } : {}), api_key: apiKey } }
    },
    async validate(cfg) { await fetchDeepseekModels(cfg.base_url ?? DEFAULT_BASE_URL, cfg.api_key ?? '') },
  },
  detect: {
    fromSettingsEnv(env) {
      const baseUrl = env.ANTHROPIC_BASE_URL?.trim() ?? ''
      if (!isDeepseekBaseUrl(baseUrl)) return null
      const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? ''
      return apiKey ? { base_url: baseUrl, api_key: apiKey } : null
    },
  },
})
