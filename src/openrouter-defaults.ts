/** 精选家族的基准项确定顺序与请求档位；实际模型 ID 从账号目录选择最新版。 */
import type { ClaudeReasoningEffort } from './agent-process'

export const OPENROUTER_DEFAULT_MODELS: ReadonlyArray<{
  rank?: number; lab: string; model: string; effort: ClaudeReasoningEffort; family: string; pattern: RegExp
}> = [
  { rank: 4, lab: 'Tencent', model: 'tencent/hy4-preview', effort: 'high', family: 'hy',
    pattern: /^tencent\/hy(?<version>\d+(?:[.-]\d+)*)(?:-(?<preview>preview))?(?:-(?<date>\d{8}))?$/ },
  { rank: 7, lab: 'Google', model: 'google/gemini-3.8-flash', effort: 'high', family: 'gemini-flash',
    pattern: /^google\/gemini-(?<version>\d+(?:[.-]\d+)*)-flash(?:-(?<date>\d{8}))?$/ },
  { rank: 10, lab: 'Meta', model: 'meta/muse-spark-1.2', effort: 'xhigh', family: 'muse-spark',
    pattern: /^meta\/muse-spark-(?<version>\d+(?:[.-]\d+)*)$/ },
  { rank: 11, lab: 'Xiaomi', model: 'xiaomi/mimo-v2.5-pro', effort: 'default', family: 'mimo-pro',
    pattern: /^xiaomi\/mimo-v(?<version>\d+(?:[.-]\d+)*)-pro(?:-(?<date>\d{8}))?$/ },
  { lab: 'ByteDance', model: 'bytedance-seed/seed-2-1-turbo', effort: 'default', family: 'seed-turbo',
    pattern: /^bytedance-seed\/seed-(?<version>\d+(?:[.-]\d+)*)-turbo(?:-(?<date>\d{8}))?$/ },
  { lab: 'Meituan', model: 'meituan/longcat-2.0', effort: 'default', family: 'longcat',
    pattern: /^meituan\/longcat-(?<version>\d+(?:[.-]\d+)*)$/ },
]

function identify(model: string) {
  for (const preset of OPENROUTER_DEFAULT_MODELS) {
    const match = preset.pattern.exec(model.toLowerCase())
    if (!match) continue
    const groups = match.groups!
    const parts = groups.version!.split(/[.-]/)
    // 日期修订独立于版本，不能让 3-20261001 排在 3.8 之后。
    const date = groups.date ?? (parts.at(-1)!.length === 8 ? parts.pop() : undefined)
    if (!parts.length || parts.some(part => !Number.isSafeInteger(Number(part)))) return undefined
    return { preset, version: parts.map(Number), date: date ? Number(date) : 0, preview: !!groups.preview }
  }
  return undefined
}

export function openRouterModelPreset(model: string) { return identify(model)?.preset }

export function openRouterModelVisibilityKey(model: string): string {
  const family = identify(model.replace(/\[1m\]$/, ''))?.preset.family
  return family ? `family:${family}` : `model:${model}`
}

/** 只选择真实目录项；保持家族顺序，不把不同档次或特殊路由当作同款升级。 */
export function selectOpenRouterDefaultModels(models: readonly string[]): string[] {
  type Candidate = NonNullable<ReturnType<typeof identify>> & { model: string }
  const winners = new Map<string, Candidate>()
  for (const model of models) {
    const item = identify(model)
    if (!item) continue
    const previous = winners.get(item.preset.family)
    let order = 0
    if (previous) {
      for (let i = 0; i < Math.max(item.version.length, previous.version.length); i++) {
        order = (item.version[i] ?? 0) - (previous.version[i] ?? 0)
        if (order) break
      }
      order ||= Number(previous.preview) - Number(item.preview) || item.date - previous.date
        || previous.model.length - model.length || previous.model.localeCompare(model)
    }
    if (!previous || order > 0) winners.set(item.preset.family, { ...item, model })
  }
  return OPENROUTER_DEFAULT_MODELS.flatMap(preset => {
    const winner = winners.get(preset.family)
    return winner ? [winner.model] : []
  })
}

export function openRouterModelExcluded(model: string): boolean {
  const id = model.toLowerCase().replace(/^~/, '')
  return /^(openai|deepseek|z-ai|zai-org|thudm)\//.test(id)
    // 聚合路由不保证遵守用户指定的厂商排除范围。
    || /^(openrouter\/|@)/.test(id)
}
