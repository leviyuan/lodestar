/** 用户指定：Arena Agent Labs 前 12 家，各取榜单代表模型，排除 OpenAI/Z.ai/DeepSeek。
 * 榜单快照 2026-09-08：https://arena.ai/leaderboard/agent?rankBy=labs
 * 顺序固定为该次榜单顺序；后续增删持久化在 token_source.openrouter.models。
 */
import type { ClaudeReasoningEffort } from './agent-process'

export const OPENROUTER_DEFAULT_MODELS: ReadonlyArray<{
  rank: number; lab: string; model: string; effort: ClaudeReasoningEffort
}> = [
  { rank: 1, lab: 'Anthropic', model: 'anthropic/claude-fable-5.1', effort: 'max' },
  { rank: 3, lab: 'Moonshot', model: 'moonshotai/kimi-k3', effort: 'max' },
  { rank: 4, lab: 'Tencent', model: 'tencent/hy4-preview', effort: 'high' },
  { rank: 7, lab: 'Google', model: 'google/gemini-3.8-flash', effort: 'high' },
  { rank: 8, lab: 'SpaceXAI', model: 'x-ai/grok-4.5', effort: 'high' },
  { rank: 9, lab: 'Alibaba', model: 'qwen/qwen3.8-max-0902', effort: 'xhigh' },
  { rank: 10, lab: 'Meta', model: 'meta/muse-spark-1.2', effort: 'xhigh' },
  { rank: 11, lab: 'Xiaomi', model: 'xiaomi/mimo-v2.5-pro', effort: 'default' },
  { rank: 12, lab: 'MiniMax', model: 'minimax/minimax-m3', effort: 'default' },
]

export function openRouterModelExcluded(model: string): boolean {
  const id = model.toLowerCase().replace(/^~/, '')
  return /^(openai|deepseek|z-ai|zai-org|thudm)\//.test(id)
    // 聚合路由不保证遵守用户指定的厂商排除范围。
    || /^(openrouter\/|@)/.test(id)
}
