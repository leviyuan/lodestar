/** 单一耗时单位，最多一位小数；粗档位向下取整以保留「+」的下界含义。 */
export function formatDuration(seconds: number, rounding: 'nearest' | 'down' = 'nearest'): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'MISS'
  const [value, unit] = seconds >= 3600
    ? [seconds / 3600, 'h'] as const
    : seconds >= 60 ? [seconds / 60, 'm'] as const : [seconds, 's'] as const
  const rounded = rounding === 'down' ? Math.floor(value * 10) / 10 : Number(value.toFixed(1))
  return `${rounded}${unit}`
}
