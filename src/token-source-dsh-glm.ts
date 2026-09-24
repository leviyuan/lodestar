import { fetchApiModelData } from './token-source-model-api'
import { config, type TokenSourceConfig } from './config'
import { isDshReasoningEffort } from './agent-process'
import { registerTokenSourceFactory, scrubDshEnv, tokenSourceRuntimeModels, type TokenSource } from './token-source'
import { queryDshRuntime } from './dsh-runtime'
import type { DshModel } from './dsh-protocol'
import { DSH_HOME_DIR } from './paths'
import { fetchGlmUsage, isGlmBaseUrl } from './glm-usage'
import { glmUsageToUnified } from './token-source-glm'
import { modelList, customModelEfforts } from './token-source-visibility'

/** Coding Plan 的 OpenAI 入口，与 Claude 的 Anthropic 入口共用同一账号。 */
export function glmCodingBaseUrl(raw: string): string {
  const url = new URL(raw)
  if (!isGlmBaseUrl(url.origin) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('DSH GLM 需要智谱或 Z.ai 的 Coding Plan HTTPS 端点；地址中不能包含凭据或查询参数')
  }
  url.pathname = '/api/coding/paas/v4'
  url.search = ''; url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export async function fetchGlmCodingModels(base: string, key: string): Promise<Array<{ model: string; display: string }>> {
  const data = await fetchApiModelData(`${base}/models`, key, 'GLM Coding Plan models')
  return data.map(entry => {
    if (typeof entry?.id !== 'string' || !entry.id) throw new Error('GLM Coding Plan 模型 id 无效')
    return { model: entry.id, display: typeof entry.name === 'string' ? entry.name : entry.id }
  })
}

registerTokenSourceFactory({
  kind: 'dsh-glm', configSectionId: 'dsh-glm',
  detect: {
    fromSettingsEnv(env) {
      const linked = config.token_sources?.glm
      const key = linked?.auth_token?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()
      const base = linked?.base_url?.trim() || env.ANTHROPIC_BASE_URL?.trim()
      return key && base && isGlmBaseUrl(base)
        ? { api_key: key, base_url: glmCodingBaseUrl(base) } : null
    },
  },
  build(cfg: TokenSourceConfig, detected) {
    const key = cfg.api_key?.trim() || cfg.auth_token?.trim() || detected?.api_key?.trim() || ''
    const base = glmCodingBaseUrl(cfg.base_url?.trim() || detected?.base_url?.trim() || 'https://open.bigmodel.cn/api/coding/paas/v4')
    const provider = new URL(base).hostname.endsWith('bigmodel.cn') ? 'zai-coding-cn' : 'zai'
    let allowedModels: string[] | undefined
    const source: TokenSource = {
      id: 'dsh-glm', kind: 'dsh-glm', agent: 'dsh', display: cfg.display?.trim() || 'GLM Coding Plan',
      enabled: !!key, models: [], defaultModel: cfg.model?.trim().toLowerCase() ?? '',
      modelEnvironmentRevision() { return JSON.stringify((source.modelSelection?.availableModels ?? source.models).map(model => model.model).sort()) },
      modelCatalogState: { status: key ? 'idle' : 'disabled', updatedAt: Date.now() },
      spawnEnv(baseEnv) {
        if (!key) throw new Error('DSH GLM Coding Plan API key is missing')
        const env = scrubDshEnv(baseEnv)
        env.LODESTAR_DSH_PROVIDER = provider
        env.LODESTAR_DSH_GLM_API_KEY = key
        env.LODESTAR_DSH_BASE_URL = base
        env.LODESTAR_DSH_DEFAULT_MODEL = source.defaultModel
        const cachedModels = (source.modelSelection?.availableModels ?? source.models).map(model => model.model)
        if (allowedModels || cachedModels.length) env.LODESTAR_DSH_MODELS = JSON.stringify(allowedModels ?? cachedModels)
        if (cfg.bin) env.LODESTAR_DSH_NODE = cfg.bin
        return env
      },
      async refreshModels() {
        source.models = []; allowedModels = undefined
        if (!source.enabled) { source.modelCatalogState = { status: 'disabled', updatedAt: Date.now() }; return }
        source.modelCatalogState = { status: 'loading', updatedAt: null }
        try {
          const account = await fetchGlmCodingModels(base, key)
          const entries = [...account]
          for (const model of [...modelList(cfg.models), ...modelList(cfg.custom_models)]) {
            if (!entries.some(entry => entry.model.toLowerCase() === model.toLowerCase())) entries.push({ model, display: model })
          }
          allowedModels = entries.map(entry => entry.model)
          if (!cfg.model?.trim()) {
            const version = (id: string) => Number(id.match(/\d+(?:\.\d+)?/)?.[0] ?? -1)
            source.defaultModel = [...account].sort((a, b) => version(b.model) - version(a.model))[0]!.model
          }
          const native: DshModel[] = await queryDshRuntime({ cwd: DSH_HOME_DIR,
            env: source.spawnEnv(process.env), profile: { loadProjectMcp: false } }, 'model/list')
          source.models = entries.map(entry => {
            const match = native.find(model => model.model === entry.model)
            const request = customModelEfforts(source, cfg)
            const efforts = match ? match.efforts.filter(isDshReasoningEffort) : request.efforts
            const effort = cfg.effort?.trim() || match?.defaultEffort || request.defaultEffort
            return { ...entry, display: match?.display ?? entry.display, efforts,
              defaultEffort: isDshReasoningEffort(effort) && efforts.includes(effort) ? effort : null,
              origin: account.some(item => item.model === entry.model) ? 'upstream' as const : 'custom' as const }
          })
          source.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
        } catch (error) {
          source.models = []; allowedModels = []
          source.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
          throw error
        }
      },
      resolveSpawnModel(model) { return tokenSourceRuntimeModels(source).find(entry => entry.model === model && !entry.unavailableReason)?.model },
      async readUsage() { return key ? glmUsageToUnified(await fetchGlmUsage(base, key)) : { state: 'no_credentials', windows: [] } },
    }
    return source
  },
  setup: {
    commandSuffix: 'dsh-glm',
    hint: () => 'GLM Coding Plan 账号由 Claude Code 和 DeepSeek Harness 共用。发送 `glm-setup <api_key>` 配置两边；`dsh-glm-setup [base_url] <api_key>` 同样更新共享账号。',
    parseArgs(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      if (parts.length < 1 || parts.length > 2 || /^https?:\/\//i.test(parts.at(-1)!)) return { error: '用法：dsh-glm-setup [base_url] <api_key>' }
      try { return { config: { agent: 'dsh', api_key: parts.at(-1)!,
        base_url: glmCodingBaseUrl(parts.length === 2 ? parts[0]! : 'https://open.bigmodel.cn/api/coding/paas/v4') } } }
      catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
    },
    async validate(cfg) {
      await fetchGlmCodingModels(glmCodingBaseUrl(cfg.base_url ?? 'https://open.bigmodel.cn/api/coding/paas/v4'), cfg.api_key ?? cfg.auth_token ?? '')
    },
  },
})
