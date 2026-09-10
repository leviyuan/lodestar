import type { TokenSourceConfig } from './config'
import type { TokenSource } from './token-source'

export function modelList(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map(model => model.trim()).filter(Boolean))]
}

/** 接口项与补录项分开管理；无法确认的补录只显示 MISS，不猜测模型能力。 */
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
      catalog.push({ model: id, display: id, origin: 'custom', efforts: [], defaultEffort: null,
        unavailableReason: '已补录，模型或 effort 尚未获后端确认' })
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
