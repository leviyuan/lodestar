/** Packy 精选家族只从当前令牌的兼容目录选最新版，不构造目录外的 ID。 */
const families = [
  { id: 'minimax', agent: 'claude', pattern: /^minimax-m(\d+(?:[.-]\d+)*)$/ },
  { id: 'opus', agent: 'claude', pattern: /^claude-opus-(\d+(?:[.-]\d+)*)$/ },
  { id: 'fable', agent: 'claude', pattern: /^claude-fable-(\d+(?:[.-]\d+)*)$/ },
  { id: 'qwen-max', agent: 'claude', pattern: /^qwen-?(\d+(?:[.-]\d+)*)-max(?:-(\d{4}|\d{8}))?$/ },
  { id: 'kimi', agent: 'codex', pattern: /^kimi-k(\d+(?:[.-]\d+)*)$/ },
  { id: 'grok', agent: 'codex', pattern: /^grok-(\d+(?:[.-]\d+)*)$/ },
] as const

type PackySourceId = 'packy' | 'packy-secondary' | 'packy-codex'

function identify(model: string, sourceId: PackySourceId) {
  const suffix = model.trim().toLowerCase().split('/').at(-1) ?? ''
  const agent = sourceId === 'packy-codex' ? 'codex' : 'claude'
  for (const family of families) {
    if (family.agent !== agent) continue
    const match = family.pattern.exec(suffix)
    if (!match) continue
    const parts = match[1]!.split(/[.-]/)
    // 日期是发布修订，不是语义版本；避免 5-20260901 比 5-5 更“新”。
    const date = match[2] ?? (parts.at(-1)!.length === 8 ? parts.pop() : undefined)
    if (!parts.length) continue
    return { family: family.id, version: parts.map(Number), date: date ? Number(date) : 0 }
  }
  return undefined
}

/** 隐藏精选模型时保留家族选择，后续目录升级不会让隐藏项重新出现。 */
export function packyModelVisibilityKey(model: string, sourceId: PackySourceId): string {
  const family = identify(model, sourceId)?.family
  return family ? `family:${family}` : `model:${model}`
}

/** 数字版本逐段比较；同版本按发布日期，再按最短/字典序 ID 确定，忽略目录返回顺序。 */
export function selectPackyDefaultModels(models: readonly string[], sourceId: PackySourceId = 'packy'): string[] {
  const winners = new Map<string, { model: string; version: number[]; date: number }>()
  for (const model of models) {
    const item = identify(model, sourceId)
    if (!item) continue
    const previous = winners.get(item.family)
    let order = 0
    if (previous) {
      for (let i = 0; i < Math.max(item.version.length, previous.version.length); i++) {
        order = (item.version[i] ?? 0) - (previous.version[i] ?? 0)
        if (order) break
      }
      order ||= item.date - previous.date || previous.model.length - model.length || previous.model.localeCompare(model)
    }
    if (!previous || order > 0) winners.set(item.family, { model, version: item.version, date: item.date })
  }
  const selected = new Set([...winners.values()].map(item => item.model))
  return models.filter(model => selected.has(model))
}
