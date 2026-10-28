import type { RelayConfig } from './config'
import { CLAUDE_REASONING_EFFORTS, type AgentReasoningEffort } from './agent-process'
import { CODEX_REASONING_EFFORTS } from './codex-process'
import { isDshReasoningEffort } from './agent-process'
import { fetchRelayModels, relayApiRoot, type RelayProtocol } from './relay-api'
import { readRelayUsage } from './relay-usage-script'
import { queryDshRuntime } from './dsh-runtime'
import { DSH_HOME_DIR } from './paths'
import { scrubAnthropicEnv, scrubDshEnv, type TokenSource, type TokenSourceModel } from './token-source'
import type { CodexApiProvider } from './codex-process'
import type { DshModel } from './dsh-protocol'

export type RelayAgent = 'claude' | 'codex' | 'dsh'

export function relaySourceId(siteId: string, agent: RelayAgent): string {
  return `relay:${siteId}:${agent}`
}

export function relaySourceParts(id: string): { siteId: string; agent: RelayAgent } | null {
  const match = /^relay:(.+):(claude|codex|dsh)$/.exec(id)
  return match ? { siteId: match[1]!, agent: match[2] as RelayAgent } : null
}

function list(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').map(value => value.trim()).filter(Boolean))]
}

function effortSet(agent: RelayAgent): AgentReasoningEffort[] {
  if (agent === 'claude') return [...CLAUDE_REASONING_EFFORTS]
  if (agent === 'codex') return [...CODEX_REASONING_EFFORTS]
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as AgentReasoningEffort[]
}

function defaultEffort(agent: RelayAgent): AgentReasoningEffort {
  return (agent === 'claude' ? 'high' : agent === 'codex' ? 'medium' : 'high') as AgentReasoningEffort
}

function modelEntry(agent: RelayAgent, entry: { id: string; display: string; efforts?: string[]; defaultEffort?: string }): TokenSourceModel {
  const allowed = new Set(effortSet(agent))
  const efforts: AgentReasoningEffort[] = entry.efforts?.length
    ? entry.efforts.filter(value => allowed.has(value as AgentReasoningEffort)) as AgentReasoningEffort[]
    : [...allowed] as AgentReasoningEffort[]
  const fallback = defaultEffort(agent)
  const requested: AgentReasoningEffort = entry.defaultEffort && allowed.has(entry.defaultEffort as AgentReasoningEffort)
    ? entry.defaultEffort as AgentReasoningEffort : fallback
  return { model: entry.id, display: entry.display, efforts,
    defaultEffort: efforts.includes(requested) ? requested : efforts[0] ?? null }
}

function modelFallback(agent: RelayAgent, id: string): TokenSourceModel {
  const efforts = effortSet(agent)
  return { model: id, display: id, efforts, defaultEffort: defaultEffort(agent), origin: 'custom' }
}

function dshModels(models: readonly TokenSourceModel[], native: readonly DshModel[]): TokenSourceModel[] {
  return models.map(model => {
    const item = native.find(entry => entry.model === model.model)
    if (!item) return model
    const efforts = item.efforts.filter(isDshReasoningEffort)
    const defaultEffort = isDshReasoningEffort(item.defaultEffort) && efforts.includes(item.defaultEffort)
      ? item.defaultEffort : model.defaultEffort
    return { ...model, display: item.display || model.display, efforts, defaultEffort }
  })
}

type RelayDshCatalogQuery = typeof queryDshRuntime

export function buildRelayTokenSource(siteId: string, cfg: RelayConfig, agent: RelayAgent,
  dshCatalogQuery: RelayDshCatalogQuery = queryDshRuntime): TokenSource {
  const protocol = cfg.protocol?.trim().toLowerCase() as RelayProtocol | undefined
  const key = cfg.api_key?.trim() ?? ''
  let base = ''
  let addressError: string | undefined
  try { base = relayApiRoot(cfg.base_url?.trim() ?? '') }
  catch (error) { addressError = error instanceof Error ? error.message : String(error) }
  const enabled = cfg.enabled !== false && !!key && !!base && (protocol === 'anthropic' || protocol === 'openai')
  if (protocol === 'anthropic' && agent !== 'claude') throw new Error(`relay ${siteId} 的 anthropic 地址只能用于 Claude Code`)
  if (protocol === 'openai' && agent === 'claude') throw new Error(`relay ${siteId} 的 openai 地址不能用于 Claude Code`)
  const codexApiProvider: CodexApiProvider | undefined = agent === 'codex' ? {
    id: `relay-${siteId}`.replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'relay',
    name: cfg.display?.trim() || siteId, baseUrl: `${base}/v1`, envKey: 'LODESTAR_RELAY_API_KEY',
  } : undefined
  const source: TokenSource = {
    id: relaySourceId(siteId, agent), kind: `relay-${protocol ?? 'unknown'}-${agent}`, agent,
    relaySiteId: siteId, relayProtocol: protocol, display: cfg.display?.trim() || siteId,
    usageAccount: { id: `relay:${siteId}`, label: cfg.display?.trim() || siteId },
    enabled, models: [], defaultModel: '',
    modelCatalogState: { status: enabled ? 'idle' : 'disabled', updatedAt: Date.now(), ...(addressError ? { error: addressError } : {}) },
    resolveSpawnModel(model) { return model || source.defaultModel || undefined },
    ...(codexApiProvider ? { codexApiProvider } : {}),
    modelEnvironmentRevision(model: string) {
      return agent === 'dsh' ? JSON.stringify(source.models.map(entry => entry.model).sort())
        : model
    },
    async refreshModels() {
      source.models = []
      if (!source.enabled) { source.modelCatalogState = { status: 'disabled', updatedAt: Date.now() }; return }
      source.modelCatalogState = { status: 'loading', updatedAt: null }
      try {
        const upstream = await fetchRelayModels(base, key, protocol!)
        const configured = list(cfg.models)
        const custom = list(cfg.custom_models)
        const ids = [...new Set([...upstream.map(entry => entry.id), ...configured, ...custom])]
        const entries = ids.map(id => upstream.find(entry => entry.id === id) ?? { id, display: id })
        const models = entries.map(entry => upstream.some(item => item.id === entry.id)
          ? modelEntry(agent, entry) : modelFallback(agent, entry.id))
        if (agent === 'dsh') {
          // Publish the upstream ids to the bootstrap environment before the
          // native DSH catalog query; otherwise pi-ai receives no declared
          // models and returns an empty route.
          source.models = models
          // DSH model discovery needs a route before source.defaultModel is
          // committed. Bootstrap the child with the first catalog model; the
          // selected/default model is published after native discovery.
          const native = await dshCatalogQuery({ cwd: DSH_HOME_DIR,
            env: source.spawnEnv(process.env, models[0]?.model), profile: { loadProjectMcp: false } }, 'model/list')
          source.models = dshModels(models, Array.isArray(native) ? native : [])
        } else source.models = models
        source.defaultModel = source.models.find(model => model.origin !== 'custom')?.model ?? source.models[0]?.model ?? ''
        source.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
      } catch (error) {
        source.models = []
        source.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
      }
    },
    spawnEnv(baseEnv, selectedModel) {
      if (!key) throw new Error('中转站 API Key 缺失')
      const model = selectedModel || source.defaultModel
      if (!model) throw new Error('中转站尚未选择模型')
      if (agent === 'claude') {
        const env = scrubAnthropicEnv(baseEnv)
        env.ANTHROPIC_BASE_URL = base
        env.ANTHROPIC_AUTH_TOKEN = key
        env.ANTHROPIC_API_KEY = ''
        env.CLAUDE_CODE_NO_MODEL_FALLBACK = '1'
        env.ANTHROPIC_MODEL = model
        env.ANTHROPIC_SMALL_FAST_MODEL = model
        env.CLAUDE_CODE_SUBAGENT_MODEL = model
        return env
      }
      if (agent === 'codex') {
        const env = scrubDshEnv(baseEnv)
        for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'LODESTAR_PACKY_API_KEY']) delete env[name]
        env.LODESTAR_RELAY_API_KEY = key
        return env
      }
      const env = scrubDshEnv(baseEnv)
      for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'DEEPSEEK_API_KEY', 'LODESTAR_DSH_GLM_API_KEY']) delete env[name]
      env.LODESTAR_DSH_PROVIDER = 'openai-relay'
      env.LODESTAR_DSH_OPENAI_API_KEY = key
      env.LODESTAR_DSH_BASE_URL = `${base}/v1`
      env.LODESTAR_DSH_DEFAULT_MODEL = model
      const models = source.models.map(entry => entry.model)
      if (models.length) env.LODESTAR_DSH_MODELS = JSON.stringify(models)
      return env
    },
    readUsage() { return readRelayUsage(siteId, cfg, protocol ?? 'unknown') },
  }
  return source
}

export function relayAgentTargets(cfg: RelayConfig): RelayAgent[] {
  const protocol = cfg.protocol?.trim().toLowerCase()
  return protocol === 'anthropic' ? ['claude'] : protocol === 'openai' ? ['codex', 'dsh'] : []
}
