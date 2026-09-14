import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLodestarFileSkill } from './file-delivery-skill'
import { FILE_DELIVERY_SKILL_NAME, fileDeliverySkillBody } from './instructions'
import { syncClaudePluginSkill } from './managed-skills'

test('ships the same handoff Skill to standalone agents and the SDK/DSH shared skill directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-file-skill-test-'))
  try {
    const codex = join(root, 'codex')
    const claude = join(root, 'claude')
    const plugin = join(root, 'plugin')
    const skill = { name: FILE_DELIVERY_SKILL_NAME, body: fileDeliverySkillBody() }
    ensureLodestarFileSkill([codex, claude])
    syncClaudePluginSkill(skill, plugin)
    const paths = [
      join(codex, skill.name, 'SKILL.md'),
      join(claude, skill.name, 'SKILL.md'),
      join(plugin, 'skills', skill.name, 'SKILL.md'),
    ]
    for (const path of paths) {
      expect(readFileSync(path, 'utf8')).toBe(skill.body)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    const before = statSync(paths[0]).mtimeMs
    ensureLodestarFileSkill([codex, claude])
    expect(statSync(paths[0]).mtimeMs).toBe(before)
    expect(JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('lodestar-managed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
