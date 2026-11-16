import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** PATH for native Claude Code processes (sessions, control queries, auth status):
 * user tool directories first, then the daemon's PATH, then the standard system directories. */
export function buildClaudeSpawnPath(): string {
  if (process.platform === 'win32') return process.env.PATH ?? ''
  const entries = [
    join(homedir(), '.local', 'npm-global', 'bin'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
    ...(process.env.PATH ?? '').split(delimiter),
    '/usr/local/bin', '/usr/bin', '/bin',
  ]
  return [...new Set(entries.filter(Boolean))].join(delimiter)
}
