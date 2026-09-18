/**
 * Packy 承载 OpenRouter 精选列表之外的指定模型，避免两个来源在面板中重复。
 *
 * Packy 目录里的模型 ID 可能带厂商前缀，也可能是裸 ID，因此这里按
 * slash 后的末段匹配。没有命中精选列表的接口模型默认只放在“显示模型”
 * 目录中，不进入主模型选择面板；用户仍可显式添加或通过 custom_models
 * 补录。
 */
const CLAUDE_MODELS = ['minimax-m3', 'claude-opus-5', 'claude-fable-5-1', 'qwen3.8-max-0902'] as const
export const PACKY_DEFAULT_MODEL_SUFFIXES = {
  packy: CLAUDE_MODELS,
  'packy-secondary': CLAUDE_MODELS,
  'packy-codex': ['kimi-k3', 'grok-4.6'],
} as const

function modelSuffix(model: string): string {
  return model.trim().replace(/\[1m\]$/, '').toLowerCase().split('/').at(-1) ?? ''
}

export function isPackyDefaultModel(model: string, sourceId: keyof typeof PACKY_DEFAULT_MODEL_SUFFIXES = 'packy'): boolean {
  return (PACKY_DEFAULT_MODEL_SUFFIXES[sourceId] as readonly string[]).includes(modelSuffix(model))
}
