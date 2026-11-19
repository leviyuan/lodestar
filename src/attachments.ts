/**
 * Inbound attachment storage.
 *
 * Attachments are handed to a backend Agent as absolute `[file: …]` hints in
 * the prompt, so their location must never point at Lodestar's state
 * directory: that directory holds the chat map, delegated prompts and project
 * credentials. A private per-daemon directory under the OS temp root keeps
 * the hint useful without disclosing the data dir or other chats' state.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'lodestar-attachments-'
const MAX_AGE_MS = 24 * 60 * 60_000

let current: string | null = null

/** Private directory (0700) shared by this process's inbound attachments. */
export function attachmentDir(): string {
  current ??= mkdtempSync(join(tmpdir(), PREFIX))
  return current
}

/** Best-effort removal of this process's directory at shutdown. */
export function removeAttachmentDir(): void {
  if (!current) return
  try { rmSync(current, { recursive: true, force: true }) } catch {}
  current = null
}

/** Remove directories left behind by interrupted daemons. */
export function pruneStaleAttachmentDirs(now = Date.now(), maxAgeMs = MAX_AGE_MS): number {
  let names: string[]
  try { names = readdirSync(tmpdir()) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue
    const path = join(tmpdir(), name)
    try {
      const info = statSync(path)
      if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) continue
      rmSync(path, { recursive: true, force: true })
      removed++
    } catch {}
  }
  return removed
}
