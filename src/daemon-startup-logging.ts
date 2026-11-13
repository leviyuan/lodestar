import { ConfigError } from './config-error'
import { logError } from './log'

// This must be the daemon's first import. Configuration and other static
// dependencies can fail before its normal shutdown handlers exist; letting
// the runtime print those exceptions exposes private paths and config values.
function startupFailed(error: unknown): never {
  // A configuration error names the key to fix and holds no secret or path; without it
  // a supervised daemon restarts forever on a summary nobody can act on.
  if (error instanceof ConfigError) process.stderr.write(`${error.message}\n`)
  logError('daemon: startup failed', error)
  process.exit(1)
}

process.on('uncaughtException', startupFailed)
process.on('unhandledRejection', startupFailed)

/** Hand ownership to the normal staged shutdown handlers after they exist. */
export function finishStartupLogging(): void {
  process.off('uncaughtException', startupFailed)
  process.off('unhandledRejection', startupFailed)
}
