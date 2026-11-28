import { describe, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCodexProviderIsolated, pruneLodestarProjectTrust } from './codex-config'

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
    } finally { f.cleanup() }
  })

  test('rewrites a symlinked config at its target and keeps the file mode', () => {
    const f = fixture()
    try {
      const entry = `[projects.${JSON.stringify(join(f.root, 'group-a'))}]\ntrust_level = "trusted"\n`
      // A config kept by a dotfiles manager is a symlink with its owner's mode.
      const target = join(f.root, '..', 'dotfiles-codex.toml')
      writeFileSync(target, `model = "x"\n\n${entry}`, { mode: 0o640 })
      if (process.platform !== 'win32') {
        symlinkSync(target, f.config)
        expect(pruneLodestarProjectTrust(f.config, f.root)).toBe(1)
        expect(lstatSync(f.config).isSymbolicLink()).toBe(true)
        expect(readFileSync(target, 'utf8')).toBe('model = "x"\n')
        expect(statSync(target).mode & 0o777).toBe(0o640)
      }
      // A plain file keeps its mode too instead of becoming 0600.
      writeFileSync(join(f.root, 'plain.toml'), entry, { mode: 0o644 })
      expect(pruneLodestarProjectTrust(join(f.root, 'plain.toml'), f.root)).toBe(1)
      if (process.platform !== 'win32') expect(statSync(join(f.root, 'plain.toml')).mode & 0o777).toBe(0o644)
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

describe('Codex API provider isolation', () => {
  const provider = { id: 'relay-site', name: 'Site' }
  const ours = { name: { type: 'sessionFlags' }, version: '1', config: { model_providers: { 'relay-site': { name: 'Site' } } } }
  test('only Lodestar\'s own definition passes', () => {
    expect(() => assertCodexProviderIsolated({ layers: [ours, { name: { type: 'user', file: '/home/u/.codex/config.toml' },
      version: '1', config: { model_providers: { other: { http_headers: { X: '1' } } } } }] }, provider)).not.toThrow()
    // An untrusted project layer is not applied, so its definitions do not merge either.
    expect(() => assertCodexProviderIsolated({ layers: [ours, { name: { type: 'project', dotCodexFolder: '/repo/.codex' },
      version: '1', disabledReason: 'untrusted', config: { model_providers: { 'relay-site': {} } } }] }, provider)).not.toThrow()
  })

  test('a same-named provider in an applied local layer is refused, naming where it is', () => {
    for (const layer of [
      { name: { type: 'user', file: '/home/u/.codex/config.toml' }, where: '/home/u/.codex/config.toml' },
      { name: { type: 'mdm', domain: 'com.openai.codex', key: 'config' }, where: 'mdm' },
    ]) {
      expect(() => assertCodexProviderIsolated({ layers: [ours, { name: layer.name, version: '1',
        config: { model_providers: { 'relay-site': { http_headers: { 'X-Local': 'leak' } } } } }] }, provider))
        .toThrow(`本机 Codex 配置（${layer.where}）也定义了 model provider「relay-site」`)
    }
  })

  test('a response without layers cannot prove isolation', () => {
    expect(() => assertCodexProviderIsolated({ config: {} }, provider)).toThrow('未返回配置分层')
    expect(() => assertCodexProviderIsolated(null, provider)).toThrow('未返回配置分层')
  })
})
