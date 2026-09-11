import { networkFetch } from './network'
/** OpenRouter 的 Anthropic Messages 接入；模型目录和账户余额均从账号 API 获取。 */
import type { TokenSourceConfig } from './config'
import { isClaudeReasoningEffort, type ClaudeReasoningEffort } from './agent-process'
import {
  registerTokenSourceFactory, scrubAnthropicEnv,
  type TokenSource, type TokenSourceModel, type UsageSnapshotUnified,
} from './token-source'
import { observedContextWindow } from './context-window-observe'
import { log } from './log'
import { OPENROUTER_DEFAULT_MODELS, openRouterModelExcluded } from './openrouter-defaults'

const DEFAULT_BASE_URL = 'https://openrouter.ai/api'
const TIMEOUT_MS = 10_000
const SLOT_ENV = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
} as const

type JsonObject = Record<string, unknown>
function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function modelList(raw?: string): string[] {
  return [...new Set((raw ?? '').split(',').map(s => s.trim()).filter(Boolean))]
}
function modelId(model: string): string {
  return model.replace(/\[1m\]$/, '')
}

/** SDK 自己追加 /v1/messages；兼容用户粘贴的 OpenAI SDK /api/v1 根地址。 */
function baseUrl(raw: string): string {
  const url = new URL(raw)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OpenRouter base_url 必须是无凭据、查询参数和 fragment 的 HTTP(S) API 根地址')
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  return url.toString().replace(/\/+$/, '')
}

class OpenRouterHttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`HTTP ${status}${detail ? `: ${detail}` : ''}`)
  }
}

async function request(base: string, apiKey: string, path: string): Promise<unknown> {
  if (!apiKey) throw new Error('OpenRouter API key missing')
  const response = await networkFetch(`${baseUrl(base)}/v1/${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) {
    // 错误正文可能是网关 HTML。始终报告 HTTP 状态，只提取结构化错误信息。
    const body = await response.text()
    let detail = ''
    if (body.trim().startsWith('{')) {
      try {
        const json: unknown = JSON.parse(body)
        if (object(json) && object(json.error) && typeof json.error.message === 'string') detail = json.error.message
      } catch { /* 非 JSON 错误仍由下面的 HTTP 状态向调用方报告。 */ }
    }
    throw new OpenRouterHttpError(response.status, detail.replaceAll(apiKey, '[redacted]'))
  }
  return response.json()
}

/** 仅收录可用于交互 Agent 的文本 + tools 模型；未细分档位时使用网关请求选项。
 * reasoning.supported_efforts 的 null 表示所有网关档位；省略表示无档位选择。
 * https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 */
export async function fetchOpenRouterModels(base: string, apiKey: string): Promise<TokenSourceModel[]> {
  const json = await request(base, apiKey, 'models/user')
  if (!object(json) || !Array.isArray(json.data)) throw new Error('OpenRouter models: data 数组缺失')
  const models: TokenSourceModel[] = []
  const seen = new Set<string>()
  for (const entry of json.data) {
    if (!object(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string') {
      throw new Error('OpenRouter models: 模型 id/name 无效')
    }
    if (!object(entry.architecture) || !Array.isArray(entry.architecture.output_modalities)
      || !Array.isArray(entry.supported_parameters)) {
      throw new Error(`OpenRouter models: ${entry.id} 的模型能力缺失`)
    }
    if (openRouterModelExcluded(entry.id) || !entry.architecture.output_modalities.includes('text') || !entry.supported_parameters.includes('tools')
      || entry.id.endsWith(':batch') || seen.has(entry.id)) continue
    const reasoning = object(entry.reasoning) ? entry.reasoning : undefined
    const declared = reasoning?.supported_efforts
    const efforts: ClaudeReasoningEffort[] = declared === null || declared === undefined && entry.supported_parameters.includes('reasoning_effort')
      ? ['max', 'xhigh', 'high', 'medium', 'low']
      : Array.isArray(declared) ? [...new Set(declared.filter(e => e !== 'default' && isClaudeReasoningEffort(e)))] as ClaudeReasoningEffort[]
      : ['default']
    const preset = OPENROUTER_DEFAULT_MODELS.find(preset => preset.model === entry.id)
    const defaultEffort = preset ? (efforts.includes(preset.effort) ? preset.effort : null)
      : efforts[0] === 'default' ? 'default'
      : isClaudeReasoningEffort(reasoning?.default_effort) && efforts.includes(reasoning.default_effort)
        ? reasoning.default_effort : null
    const observed = observedContextWindow('openrouter', entry.id)
    models.push({
      model: entry.id, display: entry.name, efforts, defaultEffort,
      context1m: observed !== undefined && observed >= 1_000_000 || undefined,
    })
    seen.add(entry.id)
  }
  if (!models.length) throw new Error('OpenRouter 未返回支持文本和工具调用的交互模型')
  return models
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
/** 账户余额直接读取 /credits；失败显示 MISS，不换用 Key 限额或累计用量。 */
export async function fetchOpenRouterUsage(base: string, apiKey: string): Promise<UsageSnapshotUnified> {
  if (!apiKey) return { kind: 'balance', state: 'no_credentials', windows: [] }
  try {
    const json = await request(base, apiKey, 'credits')
    if (!object(json) || !object(json.data)) throw new Error('OpenRouter credits: data 对象缺失')
    const { total_credits: credits, total_usage: usage } = json.data
    if (!nonnegative(credits) || !nonnegative(usage)) throw new Error('OpenRouter credits: total_credits/total_usage 缺失或无效')
    return {
      kind: 'balance', state: 'ok', fetchedAt: Date.now(), windows: [],
      balance: { remaining: credits - usage, currency: 'USD' },
    }
  } catch (error) {
    const reason = messageOf(error)
    log(`openrouter readUsage MISS: ${reason}`)
    return { kind: 'balance', state: error instanceof OpenRouterHttpError && error.status === 429 ? 'rate_limited' : 'network',
      windows: [], reason }
  }
}

registerTokenSourceFactory({
  kind: 'openrouter',
  configSectionId: 'openrouter',
  build(cfg: TokenSourceConfig, detected?: Partial<TokenSourceConfig> | null): TokenSource {
    // 显式配置路由时只使用该配置的凭据，不能夹带本机另一端点的 Key。
    const account = cfg.api_key || cfg.auth_token || cfg.base_url ? cfg : detected
    const apiKey = account?.api_key?.trim() || account?.auth_token?.trim() || ''
    const base = account?.base_url?.trim() || DEFAULT_BASE_URL
    const configuredModel = cfg.model?.trim() || ''
    const modelIds = cfg.models === undefined ? OPENROUTER_DEFAULT_MODELS.map(entry => entry.model) : modelList(cfg.models)
    const source: TokenSource = {
      id: 'openrouter', kind: 'openrouter', agent: 'claude', display: cfg.display?.trim() || 'OpenRouter',
      enabled: !!apiKey, models: [], defaultModel: configuredModel,
      modelSelection: { mode: 'allowlist', modelIds, availableModels: [] },
      validateCustomModelId(model) {
        if (openRouterModelExcluded(model)) throw new Error(`OpenRouter 已排除此厂商或自动路由: ${model}`)
        if (!model.includes('/')) throw new Error('OpenRouter 模型请填写完整的 作者/模型 ID')
      },
      modelEnvironmentRevision(model) {
        const entry = source.modelSelection!.availableModels.find(entry => modelId(entry.model) === modelId(model))
        if (!entry || entry.unavailableReason || !entry.efforts.length) return 'model-unavailable'
        return entry.efforts.includes('default') ? 'effort-unset' : 'effort-level'
      },
      modelCatalogState: { status: apiKey ? 'idle' : 'disabled', updatedAt: Date.now() },
      async refreshModels() {
        source.models = []
        source.modelSelection!.availableModels = []
        if (!source.enabled) {
          source.modelCatalogState = { status: 'disabled', updatedAt: Date.now() }
          return
        }
        source.modelCatalogState = { status: 'loading', updatedAt: null }
        try {
          const catalog = await fetchOpenRouterModels(base, apiKey)
          const defaultEntry = catalog.find(m => m.model === modelId(configuredModel))
          if (configuredModel && !defaultEntry) throw new Error(`OpenRouter 默认模型不在账号目录中: ${configuredModel}`)
          if (cfg.effort) {
            if (!configuredModel) throw new Error('OpenRouter effort 需要同时配置 model')
            if (!isClaudeReasoningEffort(cfg.effort) || !defaultEntry!.efforts.includes(cfg.effort)) {
              throw new Error(`OpenRouter 模型 ${configuredModel} 不支持 effort ${cfg.effort}`)
            }
            defaultEntry!.defaultEffort = cfg.effort
          }
          // 空字符串是用户删除全部模型后的有效选择，不能重新填回默认列表。
          const selected = modelIds.map(id => {
            const model = catalog.find(m => m.model === modelId(id))
            if (!model) return { model: id, display: id, efforts: [], defaultEffort: null,
              unavailableReason: openRouterModelExcluded(id) ? '此厂商或自动路由已被排除' : '账号目录未返回该模型' }
            return { ...model, model: id }
          })
          source.models = selected
          source.modelSelection!.availableModels = catalog
          source.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
        } catch (error) {
          const message = messageOf(error)
          log(`openrouter refreshModels MISS: ${message}`)
          source.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: message }
        }
      },
      spawnEnv(baseEnv, selectedModel) {
        if (!apiKey) throw new Error('OpenRouter API key missing')
        const model = selectedModel || configuredModel
        if (!model) throw new Error('OpenRouter 未选择模型，请通过 model 面板选择或配置 model')
        if (openRouterModelExcluded(model)) throw new Error(`OpenRouter 已排除此厂商或自动路由: ${model}`)
        const out = scrubAnthropicEnv(baseEnv)
        out.ANTHROPIC_BASE_URL = baseUrl(base)
        out.ANTHROPIC_AUTH_TOKEN = apiKey
        out.ANTHROPIC_API_KEY = ''
        out.CLAUDE_CODE_NO_MODEL_FALLBACK = '1'
        out.ANTHROPIC_MODEL = model
        out.ANTHROPIC_SMALL_FAST_MODEL = model
        out.CLAUDE_CODE_SUBAGENT_MODEL = model
        out.ANTHROPIC_DEFAULT_FABLE_MODEL = model
        for (const key of Object.values(SLOT_ENV)) out[key] = model
        for (const slot of modelList(cfg.slots)) {
          const eq = slot.indexOf('=')
          const name = slot.slice(0, eq).trim()
          const value = slot.slice(eq + 1).trim()
          if (eq < 1 || !Object.hasOwn(SLOT_ENV, name) || !value) throw new Error(`OpenRouter slots 无效: ${slot}`)
          if (openRouterModelExcluded(value) || !source.modelSelection!.availableModels.some(m => !m.unavailableReason && modelId(m.model) === modelId(value))) {
            throw new Error(`OpenRouter slot 模型不在账号目录中: ${value}`)
          }
          if (source.modelEnvironmentRevision!(value) !== source.modelEnvironmentRevision!(model)) {
            throw new Error(`OpenRouter slot 不能混合无 effort 档位与有 effort 档位的模型: ${value}`)
          }
          out[SLOT_ENV[name as keyof typeof SLOT_ENV]] = value
        }
        return out
      },
      resolveSpawnModel(model) {
        if (openRouterModelExcluded(model)) throw new Error(`OpenRouter 已排除此厂商或自动路由: ${model}`)
        return model || undefined
      },
      readUsage() { return fetchOpenRouterUsage(base, apiKey) },
    }
    return source
  },
  setup: {
    commandSuffix: 'openrouter',
    hint: display => `启用 ${display}:发送 \`openrouter-setup <api_key>\`，然后通过 \`model\` 选择模型。自建端点用 \`openrouter-setup <base_url> <api_key>\`。`,
    parseArgs(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      if (parts.length < 1 || parts.length > 2 || (parts.length === 1 && /^https?:\/\//i.test(parts[0]))) {
        return { error: '用法: openrouter-setup <api_key> 或 openrouter-setup <base_url> <api_key>' }
      }
      try {
        return { config: { agent: 'claude', api_key: parts[parts.length - 1],
          ...(parts.length === 2 ? { base_url: baseUrl(parts[0]) } : {}) } }
      } catch (error) { return { error: messageOf(error) } }
    },
  },
  detect: {
    fromSettingsEnv(env) {
      const raw = env.ANTHROPIC_BASE_URL?.trim()
      const apiKey = env.ANTHROPIC_AUTH_TOKEN?.trim()
      if (!raw || !apiKey) return null
      try {
        const base = baseUrl(raw)
        if (new URL(base).hostname !== 'openrouter.ai') return null
        return { base_url: base, api_key: apiKey }
      } catch { return null }
    },
  },
})
