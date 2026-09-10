import { config, type TokenSourceConfig } from './config'
import { isDshReasoningEffort } from './agent-process'
import { registerTokenSourceFactory, scrubDshEnv, tokenSourceRuntimeModels, type TokenSource, type TokenSourceModel } from './token-source'
import { queryDshRuntime } from './dsh-runtime'
import type { DshModel } from './dsh-protocol'
import { DSH_HOME_DIR } from './paths'
import { fetchGlmUsage, isGlmBaseUrl } from './glm-usage'
import { glmUsageToUnified } from './token-source-glm'

/** Coding Plan 的 OpenAI 入口，与 Claude 的 Anthropic 入口共用同一账号。 */
export function glmCodingBaseUrl(raw: string): string {
  const url = new URL(raw)
  if (!isGlmBaseUrl(url.origin)) throw new Error('DSH GLM 需要 bigmodel.cn 或 z.ai 的 Coding Plan 端点')
  url.pathname = '/api/coding/paas/v4'
  url.search = ''; url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export async function fetchGlmCodingModels(base: string, key: string): Promise<Array<{ model: string; display: string }>> {
  const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`GLM Coding Plan models HTTP ${response.status}`)
  const payload = await response.json()
  if (!Array.isArray(payload?.data) || !payload.data.length) throw new Error('GLM Coding Plan 模型目录为空或无效')
  return payload.data.map((entry: any) => {
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
      modelCatalogState: { status: key ? 'idle' : 'disabled', updatedAt: Date.now() },
      spawnEnv(baseEnv) {
        if (!key) throw new Error('DSH GLM Coding Plan API key is missing')
        const env = scrubDshEnv(baseEnv)
        env.LODESTAR_DSH_PROVIDER = provider
        env.LODESTAR_DSH_GLM_API_KEY = key
        env.LODESTAR_DSH_BASE_URL = base
        env.LODESTAR_DSH_DEFAULT_MODEL = source.defaultModel
        if (allowedModels) env.LODESTAR_DSH_MODELS = JSON.stringify(allowedModels)
        if (cfg.bin) env.LODESTAR_DSH_NODE = cfg.bin
        return env
      },
      async refreshModels() {
        source.models = []; allowedModels = undefined
        if (!source.enabled) { source.modelCatalogState = { status: 'disabled', updatedAt: Date.now() }; return }
        source.modelCatalogState = { status: 'loading', updatedAt: null }
        try {
          const [account, native]: [Awaited<ReturnType<typeof fetchGlmCodingModels>>, DshModel[]] = await Promise.all([
            fetchGlmCodingModels(base, key),
            queryDshRuntime({ cwd: DSH_HOME_DIR, env: source.spawnEnv(process.env), profile: { loadProjectMcp: false } }, 'model/list'),
          ])
          source.models = account.map(entry => {
            const match = native.find(model => model.model === entry.model)
            const efforts = match?.efforts.filter(isDshReasoningEffort) ?? []
            if (!match || !efforts.length) return { ...entry, efforts: [], defaultEffort: null,
              unavailableReason: 'DSH 原生目录未声明此模型的能力' } satisfies TokenSourceModel
            const effort = cfg.effort?.trim() || match.defaultEffort
            return { ...entry, display: match.display, efforts,
              defaultEffort: isDshReasoningEffort(effort) && efforts.includes(effort) ? effort : null }
          })
          allowedModels = source.models.filter(model => !model.unavailableReason).map(model => model.model)
          if (!allowedModels.length) throw new Error('账号模型与 DSH 原生能力目录没有可用交集')
          if (!cfg.model?.trim()) {
            const version = (id: string) => Number(id.match(/\d+(?:\.\d+)?/)?.[0] ?? -1)
            source.defaultModel = [...allowedModels].sort((a, b) => version(b) - version(a))[0]!
          }
          if (!allowedModels.includes(source.defaultModel)) throw new Error('DSH GLM 默认模型未获账号及原生目录确认')
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
    hint: () => 'DSH 可复用已配置的 GLM Coding Plan；独立账号用 `dsh-glm-setup [base_url] <api_key>`。',
    parseArgs(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      if (parts.length < 1 || parts.length > 2) return { error: '用法：dsh-glm-setup [base_url] <api_key>' }
      try { return { config: { agent: 'dsh', api_key: parts.at(-1)!,
        base_url: glmCodingBaseUrl(parts.length === 2 ? parts[0]! : 'https://open.bigmodel.cn/api/coding/paas/v4') } } }
      catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
    },
  },
})
