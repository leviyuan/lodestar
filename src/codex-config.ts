/**
 * Codex project-trust maintenance.
 *
 * Lodestar used to append `[projects."<workDir>"] trust_level = "trusted"` to
 * the user's global `~/.codex/config.toml` for every project directory it
 * provisioned. That file is read by the Codex Agent itself, so the accumulated
 * entries would disclose every group/project directory name to any backend
 * Agent. New launches pass the same trust level with `-c` instead; this module
 * removes the entries Lodestar wrote while leaving unrelated Codex settings
 * untouched.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeStateFileAtomic } from './state-store'

const HEADER = /^\[projects\.("(?:[^"\\]|\\.)*")\]\s*$/
const TRUST_ONLY = 'trust_level = "trusted"'

export function codexConfigFile(home = homedir()): string {
  return join(home, '.codex', 'config.toml')
}

/** True only for a direct child of the configured projects root: those are the
 * group/worktree directories Lodestar provisions. Nested user repositories are
 * left alone. */
function isDirectProjectChild(path: string, projectsRoot: string): boolean {
  const rel = relative(resolve(projectsRoot), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
}

/**
 * Remove trust sections that (a) point at a direct child of `projectsRoot`,
 * and (b) contain nothing but `trust_level = "trusted"`. Returns how many were
 * removed; the file is only rewritten when at least one matched.
 */
export function pruneLodestarProjectTrust(file: string, projectsRoot: string): number {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0
    throw error
  }
  const lines = text.split('\n')
  const kept: string[] = []
  let removed = 0
  for (let index = 0; index < lines.length; index++) {
    const match = HEADER.exec(lines[index].trim())
    if (!match) {
      kept.push(lines[index])
      continue
    }
    let end = index + 1
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++
    const body = lines.slice(index + 1, end).map(line => line.trim()).filter(Boolean)
    let path: string
    try {
      path = JSON.parse(match[1]) as string
    } catch {
      kept.push(...lines.slice(index, end))
      index = end - 1
      continue
    }
    if (body.length === 1 && body[0] === TRUST_ONLY && isDirectProjectChild(path, projectsRoot)) {
      removed++
      index = end - 1
      continue
    }
    kept.push(...lines.slice(index, end))
    index = end - 1
  }
  if (removed > 0) writeStateFileAtomic(file, kept.join('\n'))
  return removed
}
