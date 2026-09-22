const DEFAULT_TASK_CONTENT_CHARS = 360
export const DEFAULT_RESULT_CONTENT_CHARS = 8_000

/** Keep the task request identifiable without putting the full prompt in the card. */
export function compactTaskContent(value: string, maxChars = DEFAULT_TASK_CONTENT_CHARS): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return '说明 MISS'
  if (normalized.length <= maxChars) return normalized
  const receipt = '_任务内容已精简，完整内容仅用于执行。_'
  const available = Math.max(1, maxChars - receipt.length - 2)
  return `${normalized.slice(0, available)}…\n\n${receipt}`
}

/** Bound result text for Card Kit while keeping ordinary results complete. */
export function boundedResultContent(value: string, maxChars = DEFAULT_RESULT_CONTENT_CHARS): string {
  if (value.length <= maxChars) return value
  const receipt = '_结果超过卡片安全上限，已截断。_'
  const available = Math.max(1, maxChars - receipt.length - 2)
  return `${value.slice(0, available)}…\n\n${receipt}`
}
