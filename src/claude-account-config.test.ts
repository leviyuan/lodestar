import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isClaudeAccountPrivateEntry, syncClaudeAccountConfig } from './claude-account-config'

const roots: string[] = []
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-account-config-test-')); roots.push(root)
  const account = join(root, 'named'), shared = join(root, 'global')
  mkdirSync(account); mkdirSync(shared)
  return { root, account, shared }
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function expectShared(account: string, shared: string, name: string): void {
  expect(lstatSync(join(account, name)).isSymbolicLink()).toBe(true)
  expect(realpathSync(join(account, name))).toBe(realpathSync(join(shared, name)))
}

describe('Claude named accounts share all non-login configuration', () => {
  test('shares authored resources, native state, unknown extensions and complete Skill/plugin trees', () => {
    const { account, shared } = fixture()
    const files = [
      'CLAUDE.md', 'AGENTS.md', 'settings.json', 'keybindings.json', 'history.jsonl', 'stats-cache.json',
      'rules/style.md', 'agents/reviewer.md', 'commands/check.md', 'hooks/check.js', 'workflows/review.js',
      'output-styles/concise.md', 'agent-memory/reviewer/MEMORY.md', 'themes/custom.json',
      'skills/helper/SKILL.md', 'skills/synced/cloud/SKILL.md', 'skills/.trash/removed/SKILL.md',
      'plugins/installed_plugins.json', 'plugins/cache/example/plugin.json', 'plugins/synced/cloud/plugin.json',
      'plugins/.trash/removed/plugin.json', 'cache/changelog.md', 'statsig/legacy.json',
      'projects/project/memory/MEMORY.md', 'todos/legacy.json', 'tasks/list/task.json',
      'future-extension/data.bin', '.custom-extension.json',
    ]
    for (const name of files) put(join(shared, name), `global:${name}`)
    syncClaudeAccountConfig(account, shared)
    for (const name of files) {
      expect(readFileSync(join(account, name), 'utf8')).toBe(`global:${name}`)
      expectShared(account, shared, name.split('/')[0]!)
    }
    put(join(account, 'skills', 'helper', 'SKILL.md'), 'edited through named account')
    expect(readFileSync(join(shared, 'skills', 'helper', 'SKILL.md'), 'utf8')).toBe('edited through named account')
    put(join(shared, 'plugins', 'new-plugin', 'plugin.json'), 'added while running')
    expect(readFileSync(join(account, 'plugins', 'new-plugin', 'plugin.json'), 'utf8')).toBe('added while running')
  })

  test('known files created globally later become visible without another synchronization', () => {
    const { account, shared } = fixture()
    syncClaudeAccountConfig(account, shared)
    for (const name of ['CLAUDE.md', 'AGENTS.md', 'settings.json', 'keybindings.json']) {
      expect(lstatSync(join(account, name)).isSymbolicLink()).toBe(true)
      expect(existsSync(join(account, name))).toBe(false)
      put(join(shared, name), `created later:${name}`)
      expect(readFileSync(join(account, name), 'utf8')).toBe(`created later:${name}`)
    }
    put(join(shared, 'rules', 'new.md'), 'later rule')
    expect(readFileSync(join(account, 'rules', 'new.md'), 'utf8')).toBe('later rule')
    put(join(shared, 'new-top-level.json'), 'new extension')
    syncClaudeAccountConfig(account, shared)
    expect(readFileSync(join(account, 'new-top-level.json'), 'utf8')).toBe('new extension')
  })

  test('global files and directories replace conflicting account types without retaining local content', () => {
    const { account, shared } = fixture()
    put(join(shared, 'settings.json'), 'global settings')
    put(join(account, 'settings.json', 'old.json'), 'discard local directory')
    put(join(shared, 'agents', 'global.md'), 'global agent')
    put(join(account, 'agents'), 'discard local file')
    put(join(shared, 'skills', 'global', 'SKILL.md'), 'global skill')
    put(join(account, 'skills', 'local', 'SKILL.md'), 'discard local skill')
    syncClaudeAccountConfig(account, shared)
    expect(readFileSync(join(account, 'settings.json'), 'utf8')).toBe('global settings')
    expect(readFileSync(join(account, 'agents', 'global.md'), 'utf8')).toBe('global agent')
    expect(readdirSync(join(account, 'skills'))).toEqual(['global'])
    for (const name of ['settings.json', 'agents', 'skills']) expectShared(account, shared, name)
    expect(readdirSync(shared)).not.toContain('backups')
    expect(readdirSync(account).some(name => /backup|\.old/.test(name))).toBe(false)
  })

  test('replaces account symlinks without deleting their external targets', () => {
    const { root, account, shared } = fixture()
    const external = join(root, 'external'), externalFile = join(root, 'outside-settings.json')
    put(join(external, 'keep.md'), 'external directory survives')
    put(externalFile, 'external file survives')
    symlinkSync(external, join(account, 'skills'), directoryLinkType)
    symlinkSync(externalFile, join(account, 'settings.json'), 'file')
    put(join(shared, 'skills', 'global', 'SKILL.md'), 'global')
    put(join(shared, 'settings.json'), 'global settings')
    syncClaudeAccountConfig(account, shared)
    expectShared(account, shared, 'skills'); expectShared(account, shared, 'settings.json')
    expect(readFileSync(join(external, 'keep.md'), 'utf8')).toBe('external directory survives')
    expect(readFileSync(externalFile, 'utf8')).toBe('external file survives')
  })

  test('discards account-only content and links its global location instead of importing it', () => {
    const { account, shared } = fixture()
    put(join(account, 'account-only', 'private-work.txt'), 'discard this content')
    put(join(account, 'account-only.json'), 'discard this preference')
    syncClaudeAccountConfig(account, shared)
    expectShared(account, shared, 'account-only')
    expect(readdirSync(join(shared, 'account-only'))).toEqual([])
    expect(lstatSync(join(account, 'account-only.json')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(shared, 'account-only.json'))).toBe(false)
    put(join(shared, 'account-only.json'), 'later global preference')
    expect(readFileSync(join(account, 'account-only.json'), 'utf8')).toBe('later global preference')
  })

  test('keeps credentials, mixed identity JSON, refresh locks, account policies and backups private', () => {
    const { account, shared } = fixture()
    const privateFiles = [
      '.credentials.json', '.credentials.json.lock', '.credentials.json.backup',
      '.claude.json', '.claude.json.backup.1', '.claude-staging.json',
      '.config.json', '.config.json.lock', '.session_ingress_token', '.session_ingress_token.lock',
      'hfi-auth.json', 'remote-settings.json', 'remote-settings.json.stamp.json',
      'remote-settings-helper-consent', 'policy-limits.json', 'policy-limits.json.stamp.json',
      'mcp-needs-auth-cache.json',
    ]
    for (const name of privateFiles) {
      put(join(shared, name), `synthetic default:${name}`)
      put(join(account, name), `synthetic named:${name}`)
      expect(isClaudeAccountPrivateEntry(name)).toBe(true)
    }
    for (const name of ['.oauth_refresh.lock', '.oauth_refresh.lock.stale', 'backups']) {
      put(join(shared, name, 'owner'), 'synthetic default owner')
      put(join(account, name, 'owner'), 'synthetic named owner')
      expect(isClaudeAccountPrivateEntry(name)).toBe(true)
    }
    syncClaudeAccountConfig(account, shared)
    for (const name of privateFiles) {
      expect(lstatSync(join(account, name)).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(account, name), 'utf8')).toBe(`synthetic named:${name}`)
      expect(readFileSync(join(shared, name), 'utf8')).toBe(`synthetic default:${name}`)
    }
    for (const name of ['.oauth_refresh.lock', '.oauth_refresh.lock.stale', 'backups']) {
      expect(lstatSync(join(account, name)).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(account, name, 'owner'), 'utf8')).toBe('synthetic named owner')
      expect(readFileSync(join(shared, name, 'owner'), 'utf8')).toBe('synthetic default owner')
    }
    for (const name of ['cache', 'statsig', 'skills', 'plugins', 'settings.json', 'auth-notes.md']) {
      expect(isClaudeAccountPrivateEntry(name)).toBe(false)
    }
  })

  test('does not copy global login state into a named account that has none', () => {
    const { account, shared } = fixture()
    for (const name of ['.credentials.json', '.claude.json', 'hfi-auth.json', 'remote-settings.json']) {
      put(join(shared, name), 'synthetic default identity')
    }
    put(join(shared, 'backups', '.claude.json.backup'), 'synthetic default backup')
    syncClaudeAccountConfig(account, shared)
    for (const name of ['.credentials.json', '.claude.json', 'hfi-auth.json', 'remote-settings.json', 'backups']) {
      expect(readdirSync(account)).not.toContain(name)
    }
  })

  test('excluded history remains untouched until the account enrollment owner migrates it', () => {
    const { account, shared } = fixture()
    const history = ['projects', 'tasks', 'file-history', 'plans']
    for (const name of history) {
      put(join(account, name, 'old.txt'), `named:${name}`)
      put(join(shared, name, 'global.txt'), `global:${name}`)
    }
    put(join(shared, 'CLAUDE.md'), 'global instructions')
    syncClaudeAccountConfig(account, shared, history)
    expectShared(account, shared, 'CLAUDE.md')
    for (const name of history) {
      expect(lstatSync(join(account, name)).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(account, name, 'old.txt'), 'utf8')).toBe(`named:${name}`)
      expect(readdirSync(join(shared, name))).toEqual(['global.txt'])
    }
  })

  test('repeated synchronization preserves existing shared link and source identities', () => {
    const { account, shared } = fixture()
    put(join(shared, 'settings.json'), 'global settings')
    put(join(shared, 'rules', 'shared.md'), 'global rule')
    syncClaudeAccountConfig(account, shared)
    const links = readdirSync(account).map(name => [name, lstatSync(join(account, name)).ino] as const)
    const sourceInode = lstatSync(join(shared, 'settings.json')).ino
    syncClaudeAccountConfig(account, shared)
    expect(readdirSync(account).map(name => [name, lstatSync(join(account, name)).ino] as const)).toEqual(links)
    expect(lstatSync(join(shared, 'settings.json')).ino).toBe(sourceInode)
    expect(readFileSync(join(account, 'settings.json'), 'utf8')).toBe('global settings')
  })

  test.each(['shared-directory', 'account-link', 'both'] as const)('repairs native cleanup of %s without changing surviving shared or private content', removed => {
    const { account, shared } = fixture()
    const directories = ['projects', 'tasks', 'file-history', 'plans', 'todos', 'sessions', 'teams', 'cache', 'debug', 'logs']
    const preservedFiles = [
      [shared, 'settings.json', 'global settings'],
      [shared, 'rules/style.md', 'global rule'],
      [shared, 'skills/helper/SKILL.md', 'global skill'],
      [shared, '.credentials.json', 'synthetic default identity'],
      [account, '.credentials.json', 'synthetic named identity'],
      [account, '.config.json', '{"syntheticNamedIdentity":true}'],
      [account, 'backups/.claude.json.backup', 'synthetic named backup'],
    ] as const
    for (const [root, name, contents] of preservedFiles) put(join(root, name), contents)
    for (const name of directories) put(join(shared, name, 'before-cleanup.txt'), `existing:${name}`)
    syncClaudeAccountConfig(account, shared)
    const preserved = preservedFiles.map(([root, name, contents]) => {
      const path = join(root, name), stat = lstatSync(path)
      return { path, contents, ino: stat.ino, mtimeMs: stat.mtimeMs }
    })
    const unaffectedLinks = ['settings.json', 'rules', 'skills'].map(name => [name, lstatSync(join(account, name)).ino] as const)
    const originalLinks = new Map(directories.map(name => [name, lstatSync(join(account, name)).ino]))
    for (const name of directories) {
      if (removed !== 'account-link') rmSync(join(shared, name), { recursive: true })
      if (removed !== 'shared-directory') rmSync(join(account, name))
    }

    syncClaudeAccountConfig(account, shared)
    for (const name of directories) {
      expectShared(account, shared, name)
      expect(lstatSync(join(shared, name)).isDirectory()).toBe(true)
      if (removed === 'shared-directory') expect(lstatSync(join(account, name)).ino).toBe(originalLinks.get(name)!)
      if (removed === 'account-link') {
        expect(readFileSync(join(account, name, 'before-cleanup.txt'), 'utf8')).toBe(`existing:${name}`)
      } else {
        expect(readdirSync(join(shared, name))).toEqual([])
      }
      put(join(account, name, 'after-cleanup.txt'), `recovered:${name}`)
      expect(readFileSync(join(shared, name, 'after-cleanup.txt'), 'utf8')).toBe(`recovered:${name}`)
    }
    const repairedIdentities = directories.map(name => [name, lstatSync(join(account, name)).ino, lstatSync(join(shared, name)).ino])
    syncClaudeAccountConfig(account, shared)
    syncClaudeAccountConfig(account, shared)
    expect(directories.map(name => [name, lstatSync(join(account, name)).ino, lstatSync(join(shared, name)).ino])).toEqual(repairedIdentities)
    expect(unaffectedLinks.map(([name]) => [name, lstatSync(join(account, name)).ino] as const)).toEqual(unaffectedLinks)
    for (const { path, contents, ino, mtimeMs } of preserved) {
      expect(readFileSync(path, 'utf8')).toBe(contents)
      expect(lstatSync(path).ino).toBe(ino)
      expect(lstatSync(path).mtimeMs).toBe(mtimeMs)
    }
    for (const name of ['.credentials.json', '.config.json', 'backups']) {
      expect(lstatSync(join(account, name)).isSymbolicLink()).toBe(false)
    }
  })

  test('deleted global files stay absent files through repeated directory repair', () => {
    const { account, shared } = fixture()
    syncClaudeAccountConfig(account, shared)
    // Discover initially absent file targets instead of mirroring the full
    // implementation catalog; directory targets must already exist.
    const files = readdirSync(account).filter(name => !existsSync(join(shared, name)))
    expect(files).toEqual(expect.arrayContaining(['CLAUDE.md', 'settings.json', 'history.jsonl', '.last-cleanup']))
    const fileLinks = files.map(name => [name, lstatSync(join(account, name)).ino])
    for (const name of files) {
      put(join(shared, name), `before cleanup:${name}`)
      rmSync(join(shared, name))
    }
    rmSync(join(shared, 'file-history'), { recursive: true })
    syncClaudeAccountConfig(account, shared)
    syncClaudeAccountConfig(account, shared)
    expectShared(account, shared, 'file-history')
    expect(files.map(name => [name, lstatSync(join(account, name)).ino])).toEqual(fileLinks)
    for (const name of files) {
      expect(lstatSync(join(account, name)).isSymbolicLink()).toBe(true)
      expect(existsSync(join(shared, name))).toBe(false)
      put(join(shared, name), `after cleanup:${name}`)
      expect(readFileSync(join(account, name), 'utf8')).toBe(`after cleanup:${name}`)
    }
  })

  test('accepts a symlinked global root and globally linked resource directories', () => {
    const { root, account, shared } = fixture()
    const alias = join(root, 'global-alias'), externalRules = join(root, 'authored-rules')
    symlinkSync(shared, alias, directoryLinkType)
    put(join(externalRules, 'shared.md'), 'linked global rule')
    symlinkSync(externalRules, join(shared, 'rules'), directoryLinkType)
    syncClaudeAccountConfig(account, alias)
    expectShared(account, shared, 'rules')
    expect(readFileSync(join(account, 'rules', 'shared.md'), 'utf8')).toBe('linked global rule')
    expect(lstatSync(join(shared, 'rules')).isSymbolicLink()).toBe(true)
  })

  test('rejects a global resource pointing into the named account before removing any named content', () => {
    const { account, shared } = fixture()
    put(join(account, 'settings.json'), 'keep until source validation passes')
    put(join(account, 'rules', 'local.md'), 'keep local rule')
    symlinkSync(join(account, 'rules'), join(shared, 'rules'), directoryLinkType)
    expect(() => syncClaudeAccountConfig(account, shared)).toThrow('拒绝形成循环')
    expect(readFileSync(join(account, 'settings.json'), 'utf8')).toBe('keep until source validation passes')
    expect(readFileSync(join(account, 'rules', 'local.md'), 'utf8')).toBe('keep local rule')
    expect(readdirSync(account).sort()).toEqual(['rules', 'settings.json'])
  })

  test.each(['same', 'shared-child', 'account-child'] as const)('rejects %s root overlap without deleting account content', relation => {
    const { account, shared } = fixture()
    const named = relation === 'account-child' ? join(shared, 'nested-account') : account
    const global = relation === 'same' ? account : relation === 'shared-child' ? join(account, 'nested-global') : shared
    mkdirSync(named, { recursive: true }); mkdirSync(global, { recursive: true })
    put(join(named, 'keep.txt'), `retain:${relation}`)
    expect(() => syncClaudeAccountConfig(named, global)).toThrow('重叠')
    expect(readFileSync(join(named, 'keep.txt'), 'utf8')).toBe(`retain:${relation}`)
  })
})
