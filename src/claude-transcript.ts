import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Native history naming: canonical cwd, ASCII path encoding, and the native long-path hash. */
export interface ClaudeTranscriptOptions {
  /** Effective child CONFIG_DIR; explicit empty string uses the native default. */
  configDir?: string
  /** Effective child PROJECT_DIR_NAME; explicit empty string disables an inherited override. */
  projectDirName?: string
}

export function claudeTranscriptDir(workDir: string, options: ClaudeTranscriptOptions = {}): string {
  const configuredDir = options.configDir ?? process.env.CLAUDE_CONFIG_DIR
  const configDir = (configuredDir || join(homedir(), '.claude')).normalize('NFC')
  const override = options.projectDirName ?? process.env.CLAUDE_CODE_PROJECT_DIR_NAME
  if (configuredDir && override && /^[A-Za-z0-9_-]{1,64}$/.test(override)
    && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(override)) {
    return join(configDir, 'projects', override)
  }
  let canonical = resolve(workDir)
  // The native catalog falls back to the absolute spelling if realpath is unavailable.
  try { canonical = realpathSync(canonical) } catch {}
  if (process.platform === 'darwin') canonical = canonical.normalize('NFC')
  const encoded = canonical.replace(/[^a-zA-Z0-9]/g, '-')
  // Claude Code uses a signed 32-bit string hash, then abs/base36, past 200 chars.
  let hash = 0
  if (encoded.length > 200) for (let i = 0; i < canonical.length; i++) hash = ((hash << 5) - hash + canonical.charCodeAt(i)) | 0
  return join(configDir, 'projects', encoded.length > 200 ? `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}` : encoded)
}

export function claudeTranscriptPath(workDir: string, sessionId: string, options: ClaudeTranscriptOptions = {}): string {
  return join(claudeTranscriptDir(workDir, options), `${sessionId}.jsonl`)
}
