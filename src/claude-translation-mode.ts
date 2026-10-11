import { config } from './config'

/** Resolve the I/O boundary from the selected Token Source and catalog model ID. */
export function claudeTranslationModeEnabled(
  sourceId: string | null | undefined,
  model?: string | null,
): boolean {
  if (!sourceId || !Object.hasOwn(config.claude.safe_mode, sourceId)) return false
  const models = config.claude.safe_mode[sourceId]
  return !!models && (models.includes('*') || (model != null && models.includes(model)))
}
