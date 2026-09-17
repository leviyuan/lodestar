import { CLAUDE_REASONING_EFFORTS, type AgentReasoningEffort } from './agent-process'
import { CODEX_REASONING_EFFORTS } from './codex-process'
import type { TokenSourceConfig } from './config'
import { fetchPackyBalance, fetchPackyModels, fetchPackyUsage, packyApiRoot, packyManagementRoot, PACKY_BASE_URL, type PackyModel } from './packy-api'
import { modelList } from './token-source-visibility'
import { tokenSourceErrorMessage } from './token-source-errors'
import { log } from './log'
import { usageCredentialKey } from './usage-cache'
import { registerTokenSourceFactory, scrubAnthropicEnv, tokenSourceRuntimeModels, type TokenSource, type TokenSourceModel } from './token-source'

export const PACKY_CODEX_KEY_ENV = 'LODESTAR_PACKY_API_KEY'

/** Gemini 网关请求使用原生有限重试；宿主不重放整轮输入或已完成的工具。 */
export const PACKY_GEMINI_RETRY_ENV = {
  API_TIMEOUT_MS: '60000',
  CLAUDE_ENABLE_BYTE_WATCHDOG: '1',
  CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: '45000',
  CLAUDE_CODE_MAX_RETRIES: '2',
  CLAUDE_CODE_RETRY_WATCHDOG: '0',
} as const

function usesGeminiRetryProfile(model: string): boolean {
  return model.replace(/\[1m\]$/, '') === 'gemini-3.8-flash'
}

function modelEntry(entry: PackyModel, agent: 'claude' | 'codex', cfg: TokenSourceConfig): TokenSourceModel {
  const requestEfforts: readonly AgentReasoningEffort[] = agent === 'claude' ? CLAUDE_REASONING_EFFORTS : CODEX_REASONING_EFFORTS
  const declared = entry.reasoning?.supported_efforts
  if (declared !== undefined && (!Array.isArray(declared) || !declared.length
    || !declared.every(value => typeof value === 'string'))) throw new Error(`PackyAPI ${entry.id} 的推理档位声明无效`)
  // Packy 常规目录只声明协议。未声明档位时提供 Agent 请求选项，不声称上游支持所有选项。
  const efforts = declared === undefined ? [...requestEfforts]
    : requestEfforts.filter(value => (declared as string[]).includes(value))
  if (!efforts.length) throw new Error(`PackyAPI ${entry.id} 未声明当前 Agent 可用的推理档位`)
  const configuredEffort = cfg.effort?.trim()
  const requested = configuredEffort || entry.reasoning?.default_effort
    || (declared === undefined ? agent === 'claude' ? 'default' : 'medium' : undefined)
  if (configuredEffort && !efforts.includes(configuredEffort as AgentReasoningEffort)) throw new Error(`PackyAPI effort 无效: ${configuredEffort}`)
  return { model: entry.id, display: entry.display, efforts,
    defaultEffort: typeof requested === 'string' && efforts.includes(requested as AgentReasoningEffort)
      ? requested as AgentReasoningEffort : null }
}

const definitions = [
  { id: 'packy', agent: 'claude', display: 'PackyAPI' },
  { id: 'packy-secondary', agent: 'claude', display: 'PackyAPI · 令牌2' },
  { id: 'packy-codex', agent: 'codex', display: 'PackyAPI' },
] as const

for (const definition of definitions) {
  const { id, agent, display } = definition
  const protocol = agent === 'claude' ? 'anthropic' : 'openai-response'
  registerTokenSourceFactory({
    kind: id, configSectionId: id,
    build(cfg): TokenSource {
      const key = cfg.api_key?.trim() || cfg.auth_token?.trim() || ''
      const base = packyApiRoot(cfg.base_url?.trim() || PACKY_BASE_URL)
      const managementBase = cfg.management_url?.trim() ? packyApiRoot(cfg.management_url) : packyManagementRoot(base)
      const managementToken = cfg.management_token?.trim() || ''
      const managementUserId = cfg.management_user_id?.trim() || ''
      const hasBalanceAccount = !!(managementToken || managementUserId || cfg.management_url?.trim() || cfg.billing_source?.trim())
      const configuredModel = cfg.model?.trim()
      const customIds = new Set([...modelList(cfg.custom_models), ...modelList(cfg.models)])
      let catalog: PackyModel[] = []
      const validateRequestModel = (model: string) => {
        const entry = catalog.find(entry => entry.id === model)
        if (entry && !entry.protocols.includes(protocol) && !customIds.has(model)) {
          throw new Error(`PackyAPI ${model} 未声明 ${protocol}；确认兼容后可显式补录`)
        }
      }
      const source: TokenSource = {
        id, kind: id, agent, display: cfg.display?.trim() || display,
        enabled: !!key && cfg.enabled !== false, models: [], defaultModel: configuredModel ?? '',
        ...(hasBalanceAccount ? { usageAccount: {
          id: usageCredentialKey('packy-account', managementBase, managementUserId), label: 'PackyAPI',
        } } : {}),
        modelCatalogState: { status: key && cfg.enabled !== false ? 'idle' : 'disabled', updatedAt: Date.now() },
        ...(agent === 'claude' ? { modelEnvironmentRevision(model: string) {
          return usesGeminiRetryProfile(model) ? JSON.stringify(PACKY_GEMINI_RETRY_ENV) : 'native-retries'
        } } : {}),
        ...(agent === 'codex' ? { codexApiProvider: {
          id: 'packy', name: 'PackyAPI', baseUrl: `${base}/v1`, envKey: PACKY_CODEX_KEY_ENV,
        } } : {}),
        async refreshModels() {
          source.models = []; catalog = []
          if (!source.enabled) { source.modelCatalogState = { status: 'disabled', updatedAt: Date.now() }; return }
          source.modelCatalogState = { status: 'loading', updatedAt: null }
          try {
            catalog = await fetchPackyModels(base, key)
            const compatible = catalog.filter(entry => entry.protocols.includes(protocol) || customIds.has(entry.id))
            if (!compatible.length && !customIds.size) throw new Error(`PackyAPI 此令牌没有声明支持 ${protocol} 的模型，请检查分组和模型限制`)
            const models = compatible.map(entry => ({ ...modelEntry(entry, agent, cfg),
              ...(!entry.protocols.includes(protocol) ? { origin: 'custom' as const } : {}) }))
            if (configuredModel && !models.some(entry => entry.model === configuredModel)) {
              const known = catalog.find(entry => entry.id === configuredModel)
              if (known) throw new Error(`PackyAPI ${configuredModel} 未声明 ${protocol}，确认兼容后请显式补录`)
              if (![...modelList(cfg.custom_models), ...modelList(cfg.models)].includes(configuredModel)) {
                throw new Error(`PackyAPI 默认模型不在目录中且未补录: ${configuredModel}`)
              }
            }
            source.models = models
            source.defaultModel = configuredModel ?? models[0]?.model ?? [...customIds][0]!
            source.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
          } catch (error) {
            source.models = []; catalog = []
            const message = tokenSourceErrorMessage(error, [key])
            log(`${id} refreshModels MISS: ${message}`)
            source.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: message }
          }
        },
        resolveSpawnModel(model) {
          validateRequestModel(model)
          return model
        },
        spawnEnv(baseEnv, selectedModel) {
          if (!key) throw new Error('PackyAPI API key missing')
          const model = selectedModel || source.defaultModel
          if (!model) throw new Error('PackyAPI 尚未选择模型')
          validateRequestModel(model)
          const env = scrubAnthropicEnv(baseEnv)
          delete env[PACKY_CODEX_KEY_ENV]
          if (agent === 'codex') {
            for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN',
              'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT']) delete env[name]
            env[PACKY_CODEX_KEY_ENV] = key
            return env
          }
          env.ANTHROPIC_BASE_URL = base
          env.ANTHROPIC_AUTH_TOKEN = key
          env.ANTHROPIC_API_KEY = ''
          env.CLAUDE_CODE_NO_MODEL_FALLBACK = '1'
          if (usesGeminiRetryProfile(model)) Object.assign(env, PACKY_GEMINI_RETRY_ENV)
          env.ANTHROPIC_MODEL = model
          env.ANTHROPIC_SMALL_FAST_MODEL = model
          env.CLAUDE_CODE_SUBAGENT_MODEL = model
          for (const slot of ['OPUS', 'SONNET', 'HAIKU', 'FABLE']) env[`ANTHROPIC_DEFAULT_${slot}_MODEL`] = model
          const slots = { opus: 'OPUS', sonnet: 'SONNET', haiku: 'HAIKU', fable: 'FABLE' } as const
          for (const mapping of modelList(cfg.slots)) {
            const [slot, value, extra] = mapping.split('=')
            if (!slot || !Object.hasOwn(slots, slot) || !value || extra !== undefined) throw new Error(`PackyAPI slots 无效: ${mapping}`)
            if (!tokenSourceRuntimeModels(source).some(entry => entry.model === value)) throw new Error(`PackyAPI slot 模型不在当前来源: ${value}`)
            validateRequestModel(value)
            env[`ANTHROPIC_DEFAULT_${slots[slot as keyof typeof slots]}_MODEL`] = value
          }
          return env
        },
        readUsage() { return hasBalanceAccount ? fetchPackyBalance(managementBase, managementToken, managementUserId)
          : fetchPackyUsage(base, key) },
      }
      return source
    },
    setup: {
      commandSuffix: id,
      hint: () => `发送 \`${id}-setup [base_url] <api_key>\` 配置${display}。${id === 'packy-codex' ? '与 PackyAPI 主账号共用凭据。' : ''}`,
      parseArgs(raw) {
        const args = raw.trim().split(/\s+/).filter(Boolean)
        if (args.length < 1 || args.length > 2 || /^https?:\/\//i.test(args.at(-1)!)) return { error: `用法: ${id}-setup [base_url] <api_key>` }
        try { return { config: { agent, api_key: args.at(-1)!, base_url: packyApiRoot(args.length === 2 ? args[0]! : PACKY_BASE_URL) } } }
        catch (error) { return { error: tokenSourceErrorMessage(error, [args.at(-1)!]) } }
      },
      async validate(cfg) {
        const models = await fetchPackyModels(cfg.base_url ?? PACKY_BASE_URL, cfg.api_key ?? cfg.auth_token ?? '')
        if (!models.some(entry => entry.protocols.includes(protocol)) && !modelList(cfg.custom_models).length && !modelList(cfg.models).length) {
          throw new Error(`此令牌没有声明支持 ${protocol} 的模型`)
        }
      },
    },
    ...(id === 'packy-codex' ? {} : { usageSetup: {
      commandSuffix: `${id}-balance`,
      hint: () => `发送 \`${id}-balance-setup [management_url] <user_id> <system_token>\` 配置真实余额；共用已有账号用 \`${id}-balance-setup share <source_id>\`。`,
      parseArgs(raw: string) {
        const args = raw.trim().split(/\s+/).filter(Boolean)
        if (args.length === 2 && args[0] === 'share') {
          if (!definitions.some(entry => entry.id === args[1]) || args[1] === id) return { error: '请指定另一个已配置的 PackyAPI 来源：packy、packy-secondary 或 packy-codex' }
          return { config: { billing_source: args[1], management_token: '', management_user_id: '', management_url: '' } }
        }
        if (args.length < 2 || args.length > 3) return { error: `用法：${id}-balance-setup [management_url] <user_id> <system_token>，或 ${id}-balance-setup share <source_id>` }
        const userId = args.at(-2)!, token = args.at(-1)!
        if (!/^[1-9]\d*$/.test(userId) || !Number.isSafeInteger(Number(userId))) return { error: '用户 ID 必须是正整数' }
        try { return { config: { billing_source: '', management_token: token, management_user_id: userId,
          // 未指定时按候选来源的 API 地址解析，不能把自建账号令牌发送到官方站点。
          management_url: args.length === 3 ? packyApiRoot(args[0]!) : '' } } }
        catch (error) { return { error: tokenSourceErrorMessage(error, [token]) } }
      },
      async validate(cfg: TokenSourceConfig) {
        const base = cfg.management_url || packyManagementRoot(cfg.base_url || PACKY_BASE_URL)
        const result = await fetchPackyBalance(base, cfg.management_token || '', cfg.management_user_id || '', true)
        if (result.state !== 'ok') throw new Error(result.reason || 'PackyAPI 真实账户余额查询失败')
      },
    } }),
  })
}
