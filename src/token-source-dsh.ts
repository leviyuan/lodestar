import { registerTokenSourceFactory, scrubDshEnv, tokenSourceRuntimeModels, type TokenSource } from './token-source'
import { isDshReasoningEffort } from './agent-process'
import { queryDshRuntime } from './dsh-runtime'
import { DSH_HOME_DIR } from './paths'
import type { DshModel } from './dsh-protocol'
import { fetchDeepseekBalance, fetchDeepseekModelIds } from './token-source-deepseek'
import { modelList } from './token-source-visibility'

registerTokenSourceFactory({
  kind: 'deepseek-harness', configSectionId: 'deepseek-harness',
  build(cfg) {
    const apiKey = cfg.api_key?.trim() ?? ''
    const baseUrl = cfg.base_url?.trim() || 'https://api.deepseek.com'
    const source: TokenSource = {
      id: 'deepseek-harness', kind: 'deepseek-harness', agent: 'dsh', display: cfg.display?.trim() || 'DeepSeek',
      enabled: !!apiKey, models: [], defaultModel: cfg.model?.trim() ?? '',
      modelCatalogState: { status: apiKey ? 'idle' : 'disabled', updatedAt: Date.now() },
      spawnEnv(base) {
        const env = scrubDshEnv(base)
        if (!apiKey) throw new Error('DeepSeek Harness API key is missing')
        env.DEEPSEEK_API_KEY = apiKey
        env.DEEPSEEK_BASE_URL = baseUrl
        env.LODESTAR_DSH_PROVIDER = 'deepseek-official'
        if (cfg.bin) env.LODESTAR_DSH_NODE = cfg.bin
        return env
      },
      async refreshModels() {
        if (!source.enabled) { source.models = []; source.modelCatalogState = { status: 'disabled', updatedAt: Date.now() }; return }
        source.modelCatalogState = { status: 'loading', updatedAt: null }
        try {
          const catalog: DshModel[] = await queryDshRuntime({ cwd: DSH_HOME_DIR,
            env: source.spawnEnv(process.env), profile: { loadProjectMcp: false } }, 'model/list',
            { models: [...modelList(cfg.models), ...modelList(cfg.custom_models)] })
          if (!Array.isArray(catalog) || !catalog.length) throw new Error('DeepSeek Harness model catalog is empty')
          for (const entry of catalog) {
            if (!entry.model || !entry.efforts.length || !entry.efforts.every(isDshReasoningEffort)
              || !isDshReasoningEffort(entry.defaultEffort) || !entry.efforts.includes(entry.defaultEffort)) {
              throw new Error(`Invalid DSH model/effort catalog: ${entry.model}`)
            }
          }
          const defaultModel = cfg.model?.trim() || catalog.find(model => model.isDefault)?.model
          if (!defaultModel || !catalog.some(model => model.model === defaultModel)) throw new Error('DSH default model is not in its catalog')
          source.models = catalog.map(({ model, display, efforts, defaultEffort, isCustom }) => {
            const configured = cfg.effort?.trim()
            if (configured && (!isDshReasoningEffort(configured) || !efforts.includes(configured))) {
              throw new Error(`DSH model ${model} does not support configured effort ${configured}`)
            }
            return { model, display, efforts, defaultEffort: configured ? configured as typeof defaultEffort : defaultEffort,
              origin: isCustom ? 'custom' : 'upstream' }
          })
          source.defaultModel = defaultModel
          source.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
        } catch (error) {
          source.models = []
          source.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
          throw error
        }
      },
      resolveSpawnModel(model) { return tokenSourceRuntimeModels(source).find(entry => entry.model === model)?.model },
      readUsage() { return apiKey ? fetchDeepseekBalance(baseUrl, apiKey) : Promise.resolve({ kind: 'balance', state: 'no_credentials', windows: [] }) },
    }
    return source
  },
  setup: {
    commandSuffix: 'deepseek-harness',
    hint: () => '启用 DeepSeek Harness：发送 `deepseek-harness-setup <api_key>`，或 `deepseek-harness-setup <base_url> <api_key>`。',
    parseArgs(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      if (parts.length < 1 || parts.length > 2 || /^https?:\/\//i.test(parts.at(-1)!)) return { error: '用法：deepseek-harness-setup [base_url] <api_key>' }
      return { config: { agent: 'dsh', api_key: parts.at(-1)!, ...(parts.length === 2 ? { base_url: parts[0] } : {}) } }
    },
    async validate(cfg) { await fetchDeepseekModelIds(cfg.base_url ?? 'https://api.deepseek.com', cfg.api_key ?? '') },
  },
})
