/** OpenRouter 保留腾讯、Gemini、Meta、MiMo、字节和美团六款。
 * 其他兼容模型仍可通过 MD 显示或补录；已配置的列表不会被默认值覆盖。
 */
import type { ClaudeReasoningEffort } from './agent-process'

export const OPENROUTER_DEFAULT_MODELS: ReadonlyArray<{
  rank?: number; lab: string; model: string; effort: ClaudeReasoningEffort
}> = [
  { rank: 4, lab: 'Tencent', model: 'tencent/hy4-preview', effort: 'high' },
  { rank: 7, lab: 'Google', model: 'google/gemini-3.8-flash', effort: 'high' },
  { rank: 10, lab: 'Meta', model: 'meta/muse-spark-1.2', effort: 'xhigh' },
  { rank: 11, lab: 'Xiaomi', model: 'xiaomi/mimo-v2.5-pro', effort: 'default' },
  { lab: 'ByteDance', model: 'bytedance-seed/seed-2-1-turbo', effort: 'default' },
  { lab: 'Meituan', model: 'meituan/longcat-2.0', effort: 'default' },
]

export function openRouterModelExcluded(model: string): boolean {
  const id = model.toLowerCase().replace(/^~/, '')
  return /^(openai|deepseek|z-ai|zai-org|thudm)\//.test(id)
    // 聚合路由不保证遵守用户指定的厂商排除范围。
    || /^(openrouter\/|@)/.test(id)
}
