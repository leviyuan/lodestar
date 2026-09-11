import type { TokenSourceConfig } from './config'
import type { TokenSource } from './token-source'
import { CLAUDE_REASONING_EFFORTS, type AgentReasoningEffort } from './agent-process'
import { CODEX_REASONING_EFFORTS } from './codex-process'

export function modelList(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map(model => model.trim()).filter(Boolean))]
}

/** 手动模型使用 Agent 的请求档位；目录不是允许用户调用模型的白名单。 */
export function customModelEfforts(source: TokenSource, cfg: TokenSourceConfig): { efforts: AgentReasoningEffort[]; defaultEffort: AgentReasoningEffort } {
  const efforts: AgentReasoningEffort[] = source.agent === 'claude' ? CLAUDE_REASONING_EFFORTS.filter(effort => effort !== 'default')
    : source.agent === 'codex' ? [...CODEX_REASONING_EFFORTS] : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const requested = cfg.effort?.trim() as AgentReasoningEffort | undefined
  return { efforts, defaultEffort: requested && efforts.includes(requested) ? requested
    : source.agent === 'claude' ? 'max' : source.agent === 'codex' ? 'xhigh' : 'high' }
}

/** 接口项管理可见性，补录项可直接选择请求档位并使用。 */
export function withModelVisibility(source: TokenSource, cfg: TokenSourceConfig): TokenSource {
  const inheritedSelection = source.modelSelection
  const hidden = new Set(modelList(cfg.hidden_models))
  const customIds = [...new Set([...modelList(cfg.custom_models), ...(inheritedSelection ? [] : modelList(cfg.models))])]
  const selection = source.modelSelection = inheritedSelection ?? { mode: 'catalog' as const, modelIds: [] as string[], availableModels: [] as typeof source.models }
  const refresh = source.refreshModels.bind(source)
  source.refreshModels = async () => {
    source.models = []
    selection.availableModels = []
    if (!inheritedSelection) selection.modelIds = []
    try { await refresh() }
    catch (error) {
      source.models = []
      source.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
      throw error
    }
    if (source.modelCatalogState?.status !== 'ready') return
    const listed = source.models
    const catalog = (inheritedSelection ? selection.availableModels : listed).map(model => ({ ...model, origin: model.origin ?? 'upstream' as const }))
    for (const id of customIds) {
      if (catalog.some(model => model.model.toLowerCase() === id.toLowerCase())) continue
      catalog.push({ model: id, display: id, origin: 'custom', ...customModelEfforts(source, cfg) })
    }
    selection.availableModels = catalog
    const visible = inheritedSelection ? listed.map(model => catalog.find(item => item.model === model.model) ?? { ...model, origin: 'upstream' as const }) : catalog
    source.models = [
      ...visible.filter(model => model.origin === 'custom' || !hidden.has(model.model)),
      ...catalog.filter(model => model.origin === 'custom' && !visible.some(item => item.model === model.model)),
    ]
    selection.modelIds = source.models.map(model => model.model)
  }
  return source
}
