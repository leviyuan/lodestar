import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeManagedSkill, syncClaudePluginSkill, syncManagedSkill } from './managed-skills'

describe('managed skill sync', () => {
  test('installs to every backend root and updates daemon-owned content', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-managed-skills-'))
    const codex = join(root, 'codex')
    const claude = join(root, 'claude')
    syncManagedSkill({ name: 'test-skill', body: 'v1\n' }, [codex, claude])
    const codexFile = join(codex, 'test-skill', 'SKILL.md')
    const claudeFile = join(claude, 'test-skill', 'SKILL.md')
    expect(readFileSync(codexFile, 'utf8')).toBe('v1\n')
    expect(readFileSync(claudeFile, 'utf8')).toBe('v1\n')
    expect(statSync(codexFile).mode & 0o777).toBe(0o600)

    syncManagedSkill({ name: 'test-skill', body: 'v2\n' }, [codex, claude])
    expect(readFileSync(codexFile, 'utf8')).toBe('v2\n')
    expect(readFileSync(claudeFile, 'utf8')).toBe('v2\n')
  })

  test('accumulates every managed Skill in one Claude SDK plugin', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-managed-plugin-'))
    const plugin = join(root, 'plugin')
    syncClaudePluginSkill({ name: 'feishu-notify', body: 'notify-v1\n' }, plugin)
    syncClaudePluginSkill({ name: 'lodestar-agent', body: 'agent-v1\n' }, plugin)
    expect(JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')))
      .toMatchObject({ name: 'lodestar-managed' })
    expect(readFileSync(join(plugin, 'skills', 'feishu-notify', 'SKILL.md'), 'utf8')).toBe('notify-v1\n')
    expect(readFileSync(join(plugin, 'skills', 'lodestar-agent', 'SKILL.md'), 'utf8')).toBe('agent-v1\n')
  })

  test.each(['lodestar-consult', 'lodestar-files'])('removes obsolete %s across managed roots while preserving user replacements', name => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-managed-remove-'))
    try {
      const roots = [join(root, 'codex'), join(root, 'claude'), join(root, 'plugin', 'skills')]
      for (const [index, skillRoot] of roots.entries()) {
        mkdirSync(join(skillRoot, name), { recursive: true })
        const declaredName = [name, `"${name}"`, `'${name}'`][index]
        writeFileSync(join(skillRoot, name, 'SKILL.md'), `---\nname: ${declaredName}\n---\n`)
        mkdirSync(join(skillRoot, 'lodestar-agent'), { recursive: true })
        writeFileSync(join(skillRoot, 'lodestar-agent', 'SKILL.md'), 'active skill\n')
      }
      const customRoot = join(root, 'custom')
      const customFile = join(customRoot, name, 'SKILL.md')
      mkdirSync(join(customRoot, name), { recursive: true })
      writeFileSync(customFile, 'user content\n')

      removeManagedSkill(name, [...roots, customRoot])
      removeManagedSkill(name, [...roots, customRoot])
      for (const skillRoot of roots) {
        expect(existsSync(join(skillRoot, name))).toBe(false)
        expect(readFileSync(join(skillRoot, 'lodestar-agent', 'SKILL.md'), 'utf8')).toBe('active skill\n')
      }
      expect(readFileSync(customFile, 'utf8')).toBe('user content\n')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test.each(['---\nname: lodestar-files-custom\n---\n', '# Notes\nname: lodestar-files\n'])('preserves a same-path file without exact Skill ownership: %s', body => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-managed-custom-'))
    try {
      const file = join(root, 'lodestar-files', 'SKILL.md')
      mkdirSync(join(root, 'lodestar-files'))
      writeFileSync(file, body)
      removeManagedSkill('lodestar-files', [root])
      expect(readFileSync(file, 'utf8')).toBe(body)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
