import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneLodestarProjectTrust } from './codex-config'

function fixture(): { root: string, config: string, cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-codex-trust-'))
  const projects = join(root, 'projects')
  mkdirSync(join(projects, 'group-a'), { recursive: true })
  mkdirSync(join(projects, 'group-b'), { recursive: true })
  mkdirSync(join(projects, 'nested', 'repo'), { recursive: true })
  mkdirSync(join(root, 'elsewhere'), { recursive: true })
  const config = join(root, 'config.toml')
  return { root: projects, config, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('Codex project-trust pruning', () => {
  test('removes only direct-child trust-only entries and preserves everything else', () => {
    const f = fixture()
    try {
      writeFileSync(f.config, [
        'model = "gpt-test"',
        '',
        '[projects."' + join(f.root, 'group-a') + '"]',
        'trust_level = "trusted"',
        '',
        '[projects."' + join(f.root, 'group-b') + '"]',
        '# user note',
        'trust_level = "trusted"',
        '',
        '[projects."' + join(f.root, 'nested', 'repo') + '"]',
        'trust_level = "trusted"',
        '',
        '[projects."' + join(f.root, '..', 'elsewhere') + '"]',
        'trust_level = "trusted"',
        '',
        '[projects."' + join(f.root, 'group-a') + '"]',
        'trust_level = "trusted"',
        'extra = true',
        '',
        '[other]',
        'value = 1',
        '',
      ].join('\n'))
      const removed = pruneLodestarProjectTrust(f.config, f.root)
      expect(removed).toBe(1)
      const text = readFileSync(f.config, 'utf8')
      expect(text.split(`[projects."${join(f.root, 'group-a')}"]`).length - 1).toBe(1)
      expect(text).toContain('extra = true')
      expect(text).toContain(`[projects."${join(f.root, 'group-b')}"]`)
      expect(text).toContain('# user note')
      expect(text).toContain(`[projects."${join(f.root, 'nested', 'repo')}"]`)
      expect(text).toContain(`[projects."${join(f.root, '..', 'elsewhere')}"]`)
      expect(text).toContain('extra = true')
      expect(text).toContain('[other]\nvalue = 1')
      expect(text).toContain('model = "gpt-test"')
      if (process.platform !== 'win32') expect(statSync(f.config).mode & 0o777).toBe(0o600)
    } finally { f.cleanup() }
  })

  test('is a no-op for a missing file or when nothing matches', () => {
    const f = fixture()
    try {
      expect(pruneLodestarProjectTrust(join(f.root, 'missing.toml'), f.root)).toBe(0)
      writeFileSync(f.config, '[projects."/outside/path"]\ntrust_level = "trusted"\n')
      expect(pruneLodestarProjectTrust(f.config, f.root)).toBe(0)
      expect(readFileSync(f.config, 'utf8')).toBe('[projects."/outside/path"]\ntrust_level = "trusted"\n')
    } finally { f.cleanup() }
  })
})

test('known session names preserve unrelated direct-child trust entries', () => {
  const f = fixture()
  try {
    const userOwn = join(f.root, 'user-own-repo')
    mkdirSync(userOwn, { recursive: true })
    writeFileSync(f.config, [
      '[projects."' + join(f.root, 'group-a') + '"]',
      'trust_level = "trusted"',
      '',
      '[projects."' + userOwn + '"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'))
    expect(pruneLodestarProjectTrust(f.config, f.root, new Set(['group-a']))).toBe(1)
    const text = readFileSync(f.config, 'utf8')
    expect(text).not.toContain(`[projects."${join(f.root, 'group-a')}"]`)
    expect(text).toContain(`[projects."${userOwn}"]`)
  } finally { f.cleanup() }
})
