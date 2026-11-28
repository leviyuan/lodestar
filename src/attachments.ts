/**
 * Inbound attachment storage.
 *
 * Attachments are handed to a backend Agent as absolute `[file: …]` hints in
 * the prompt, so their location must never point at Lodestar's state
 * directory: that directory holds the chat map, delegated prompts and project
 * credentials. A private per-daemon directory under the OS temp root keeps
 * the hint useful without disclosing the data dir or other chats' state.
 *
 * 停机不删除：重启或 kickstart 续接后，会话历史里的 `[file: …]` 仍指向这些文件。
 * 附件按年龄清理，保留 7 天（与日志保留一致）：启动时一次，本进程用过附件目录后每天一次。
 */
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'lodestar-attachments-'
export const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60_000
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000

let current: string | null = null
let sweep: ReturnType<typeof setInterval> | null = null

/** Private directory (0700) shared by this process's inbound attachments. */
export function attachmentDir(): string {
  // 定期清理或系统临时目录清理可能删掉它；缺失时另建一个随机命名的私有目录，不复用旧路径。
  if (!current || !existsSync(current)) current = mkdtempSync(join(tmpdir(), PREFIX))
  if (!sweep) {
    sweep = setInterval(() => { pruneStaleAttachmentDirs() }, PRUNE_INTERVAL_MS)
    sweep.unref?.()
  }
  return current
}

/** 停机时只放弃本进程目录的引用、停掉定期清理，不删除其中的附件；过期内容由 {@link pruneStaleAttachmentDirs} 清理。 */
export function removeAttachmentDir(): void {
  current = null
  if (sweep) { clearInterval(sweep); sweep = null }
}

/**
 * 按年龄清理收件附件，返回删除的目录与文件数。超过保留期没有任何变动的旧目录整体删除；
 * 近期仍有写入的目录（含本进程正在使用的目录）只删除其中超过保留期的附件。只处理当前用户
 * 自己的目录，单项失败跳过。
 */
export function pruneStaleAttachmentDirs(now = Date.now(), maxAgeMs = ATTACHMENT_RETENTION_MS): number {
  const root = tmpdir()
  let names: string[]
  try { names = readdirSync(root) } catch { return 0 }
  const uid = process.getuid?.()
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue
    const path = join(root, name)
    try {
      const info = lstatSync(path)
      if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) continue
      if (path !== current && now - info.mtimeMs >= maxAgeMs) {
        rmSync(path, { recursive: true, force: true })
        removed++
        continue
      }
      for (const entry of readdirSync(path)) {
        const file = join(path, entry)
        try {
          if (now - lstatSync(file).mtimeMs < maxAgeMs) continue
          rmSync(file, { recursive: true, force: true })
          removed++
        } catch {}
      }
    } catch {}
  }
  return removed
}
