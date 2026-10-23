import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log, logError } from './log'
import { writeStateFileAtomic } from './state-store'
import { MANAGED_CLAUDE_PLUGIN_DIR } from './paths'
import { removeManagedSkill as cleanupManagedSkill } from './managed-skill-cleanup.cjs'

export interface ManagedSkill {
  name: string
  body: string
}

/** Version-locked, idempotent sync for daemon-owned skills on both supported
 * main-agent backends. */
export function syncManagedSkill(skill: ManagedSkill, roots?: string[]): void {
  if (process.env.LODESTAR_DISABLE_SKILL_SYNC === '1') {
    return
  }
  const targetRoots = roots ?? [
    join(homedir(), '.codex', 'skills'),
    join(homedir(), '.claude', 'skills'),
  ]
  for (const root of targetRoots) {
    const skillFile = join(root, skill.name, 'SKILL.md')
    try {
      const current = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : null
      if (current === skill.body) continue
      writeStateFileAtomic(skillFile, skill.body)
    } catch (error) {
      logError('skill: sync failed', error)
    }
  }
  if (!roots) syncClaudePluginSkill(skill, MANAGED_CLAUDE_PLUGIN_DIR)
}

/** Claude SDK sessions with injected GLM/DeepSeek credentials deliberately
 * omit the `user` setting source, so ~/.claude/skills is not discoverable.
 * Mirror every daemon-owned Skill into one explicit local plugin; the SDK host
 * loads this path without importing user settings, hooks, env, or MCP. */
export function syncClaudePluginSkill(skill: ManagedSkill, pluginRoot: string): void {
  if (process.env.LODESTAR_DISABLE_SKILL_SYNC === '1') {
    return
  }
  const manifestFile = join(pluginRoot, '.claude-plugin', 'plugin.json')
  const skillFile = join(pluginRoot, 'skills', skill.name, 'SKILL.md')
  const manifest = JSON.stringify({
    name: 'lodestar-managed',
    description: 'Lodestar daemon-managed Skills for Claude Agent SDK sessions',
    version: '1.0.0',
    author: { name: 'Lodestar' },
  }, null, 2) + '\n'
  for (const [file, content] of [[manifestFile, manifest], [skillFile, skill.body]] as const) {
    try {
      const current = existsSync(file) ? readFileSync(file, 'utf8') : null
      if (current === content) continue
      writeStateFileAtomic(file, content)
    } catch (error) {
      logError('skill: Claude plugin sync failed', error)
    }
  }
}

/** Remove an obsolete daemon-owned Skill only when its exact SKILL.md still
 * identifies itself by that name. A same-named user replacement is preserved. */
export function removeManagedSkill(name: string, roots?: string[]): void {
  cleanupManagedSkill(name, roots, message => {
    if (/failed/i.test(message)) logError('skill: obsolete managed skill removal failed', message)
    else log('skill: obsolete managed skill checked')
  })
}
