/**
 * A configuration problem the operator has to fix. The message names the offending key
 * and never carries credentials or local paths, so startup can show it verbatim while
 * every other startup failure stays reduced to its safe log summary.
 */
export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConfigError'
  }
}
