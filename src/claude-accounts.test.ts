import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk'
import type { AgentProcess } from './agent-process'
import * as fs from 'node:fs'
import * as stateStore from './state-store'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, lstatSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { ClaudeAccounts, CLAUDE_SHARED_DIRS, DEFAULT_CLAUDE_ACCOUNT, bindProcessClaudeAccount, processClaudeAccount } from './claude-accounts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function nativeInfo(email = 'one@example.test', organization = 'synthetic-org'): AccountInfo {
  return { email, organization, subscriptionType: 'max', apiProvider: 'firstParty', apiKeySource: 'none' }
}
function fixture(env: Record<string, string | undefined> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-accounts-test-')); roots.push(root)
  const options = { home: root, accountsDir: join(root, '.claude-accounts'), stateFile: join(root, 'state', 'accounts.json'), env }
  const accounts = new ClaudeAccounts(options)
  mkdirSync(options.accountsDir)
  for (const key of CLAUDE_SHARED_DIRS) {
    mkdirSync(join(accounts.sharedConfigDir(), key), { recursive: true })
    writeFileSync(join(accounts.sharedConfigDir(), key, 'shared.txt'), 'shared:' + key)
  }
  writeFileSync(join(accounts.sharedConfigDir(), '.credentials.json'), 'SYNTHETIC-DEFAULT-CREDENTIAL')
  writeFileSync(join(accounts.sharedConfigDir(), 'settings.json'), '{"theme":"global"}')
  const profile = (name = '备用一') => {
    const path = join(options.accountsDir, name); mkdirSync(path)
    for (const key of CLAUDE_SHARED_DIRS) { mkdirSync(join(path, key)); writeFileSync(join(path, key, 'old.txt'), 'old:' + key) }
    writeFileSync(join(path, '.credentials.json'), 'SYNTHETIC-EXTRA-CREDENTIAL')
    writeFileSync(join(path, 'settings.json'), 'SYNTHETIC-SETTINGS')
    return path
  }
  const protect = () => {
    for (const key of CLAUDE_SHARED_DIRS) expect(readFileSync(join(accounts.sharedConfigDir(), key, 'shared.txt'), 'utf8')).toBe('shared:' + key)
    expect(readFileSync(join(accounts.sharedConfigDir(), '.credentials.json'), 'utf8')).toBe('SYNTHETIC-DEFAULT-CREDENTIAL')
  }
  const oldPresent = (path: string) => { for (const key of CLAUDE_SHARED_DIRS) expect(readFileSync(join(path, key, 'old.txt'), 'utf8')).toBe('old:' + key) }
  return { root, options, accounts, profile, protect, oldPresent }
}

describe('Claude native environment and explicit account enrollment', () => {
  test('construction/default environment never creates or scans a native directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-uncreated-test-')); roots.push(root)
    const accounts = new ClaudeAccounts({ home: root, stateFile: join(root, 'unused', 'accounts.json'), env: {} })
    expect(accounts.list()).toEqual([{ id: 'default', name: '默认', state: 'ready', generation: 0 }])
    accounts.prepareShared('default')
    expect(accounts.env('default', { CLAUDE_CONFIG_DIR: '/other/account', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/other/keychain', KEEP: 'yes' }))
      .toEqual({ KEEP: 'yes', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' })
    const release = accounts.acquireUse('default'); release(); release()
    expect(readdirSync(root)).toEqual([])
  })
  test('unset and explicit native path preserve their distinct Keychain namespaces', () => {
    const { root, options } = fixture()
    const spelling = join(root, '.claude') + '/'
    const explicit = new ClaudeAccounts({ ...options, env: { CLAUDE_CONFIG_DIR: spelling } })
    const implicit = new ClaudeAccounts(options)
    expect(explicit.get('default').configDir).toBe(spelling)
    expect(explicit.env('default', {}).CLAUDE_CONFIG_DIR).toBe(spelling)
    expect(explicit.env('default', { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/other' }).CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(spelling)
    expect(implicit.env('default', { CLAUDE_CONFIG_DIR: spelling }).CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(explicit.revision('default')).not.toBe(implicit.revision('default'))
    const before = implicit.revision('default')
    implicit.observeIdentity('default', nativeInfo('native@example.test'), before)
    expect(implicit.get('default').generation).toBe(1)
    expect(explicit.get('default').identity).toBeUndefined()
  })
  test('bootstrap uses the native process/config environment merge for history and both auth namespaces', () => {
    const { accounts, root } = fixture()
    accounts.configureNativeEnv({ CLAUDE_CONFIG_DIR: join(root, 'synthetic-process-env') })
    const configured = join(root, 'configured-native') + '/'
    accounts.configureNativeEnv({ CLAUDE_CONFIG_DIR: configured })
    expect(accounts.sharedConfigDir()).toBe(join(root, 'configured-native'))
    expect(accounts.get('default').configDir).toBe(configured)
    const env = accounts.env('default', { CLAUDE_CONFIG_DIR: '/synthetic-host-override', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/wrong-keychain' })
    expect(env.CLAUDE_CONFIG_DIR).toBe(configured)
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(configured)
    expect(existsSync(join(root, 'configured-native'))).toBe(false)
    accounts.configureNativeEnv({})
    expect(accounts.sharedConfigDir()).toBe(join(root, '.claude'))
    expect(accounts.env('default', env).CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(accounts.env('default', env).CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('')
  })
  test.each(['', 'relative-native', './relative-native', '~/native'])('rejects explicit non-absolute native config %j without changing the last valid binding', value => {
    const { accounts, options, root } = fixture()
    const configured = join(root, 'configured-native') + '/'
    accounts.configureNativeEnv({ CLAUDE_CONFIG_DIR: configured })
    expect(() => new ClaudeAccounts({ ...options, env: { CLAUDE_CONFIG_DIR: value } })).toThrow('非空绝对路径')
    expect(() => accounts.configureNativeEnv({ CLAUDE_CONFIG_DIR: value })).toThrow('非空绝对路径')
    expect(accounts.get('default').configDir).toBe(configured)
    expect(accounts.env('default', {}).CLAUDE_CONFIG_DIR).toBe(configured)
    expect(accounts.env('default', {}).CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(configured)
  })
  test('only named directory is discovered and auth completes before any legacy history is removed', async () => {
    const { accounts, profile, oldPresent, protect } = fixture()
    const path = profile(); const untouched = profile('未指定')
    const before = accounts.candidate('备用一')
    expect(before.state).toBe('candidate')
    expect(accounts.list()).toHaveLength(1)
    const row = await accounts.enroll('备用一', async candidate => {
      expect(candidate.id).toBe(before.id); oldPresent(path)
      expect(accounts.candidateEnv(candidate, { KEEP: 'x', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }))
        .toEqual({ KEEP: 'x', CLAUDE_CONFIG_DIR: path, CLAUDE_SECURESTORAGE_CONFIG_DIR: path })
      return nativeInfo()
    })
    expect(row.state).toBe('ready'); expect(row.generation).toBe(1)
    expect(accounts.list().map(a => a.name)).toEqual(['默认', '备用一'])
    for (const key of CLAUDE_SHARED_DIRS) {
      expect(lstatSync(join(path, key)).isSymbolicLink()).toBe(true)
      expect(realpathSync(join(path, key))).toBe(realpathSync(join(accounts.sharedConfigDir(), key)))
    }
    oldPresent(untouched); protect()
    expect(readFileSync(join(path, '.credentials.json'), 'utf8')).toBe('SYNTHETIC-EXTRA-CREDENTIAL')
    expect(readFileSync(join(path, 'settings.json'), 'utf8')).toBe('{"theme":"global"}')
    expect(readFileSync(accounts.stateFile, 'utf8')).not.toContain('one@example.test')
    if (process.platform !== 'win32') expect(lstatSync(accounts.stateFile).mode & 0o777).toBe(0o600)
  })
  test('unknown explicit name neither creates nor scans a profile', async () => {
    const { accounts, options, profile, oldPresent } = fixture()
    const sibling = profile('existing')
    expect(() => accounts.find('missing')).toThrow('尚未收录')
    await expect(accounts.enroll('missing', async () => nativeInfo())).rejects.toThrow('目录不存在')
    expect(readdirSync(options.accountsDir)).toEqual(['existing']); oldPresent(sibling)
  })
  test('new named accounts discover global Skills while retaining their native authentication directories', async () => {
    const { accounts, profile, protect } = fixture(); const path = profile()
    const globalSkill = join(accounts.sharedConfigDir(), 'skills', 'shared-helper')
    mkdirSync(globalSkill, { recursive: true })
    writeFileSync(join(globalSkill, 'SKILL.md'), 'global skill')
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    const env = accounts.env(row.id, {})
    expect(env.CLAUDE_CONFIG_DIR).toBe(path)
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(path)
    expect(readFileSync(join(env.CLAUDE_CONFIG_DIR!, 'skills', 'shared-helper', 'SKILL.md'), 'utf8')).toBe('global skill')
    expect(readFileSync(join(path, '.credentials.json'), 'utf8')).toBe('SYNTHETIC-EXTRA-CREDENTIAL')
    expect(readFileSync(join(path, 'settings.json'), 'utf8')).toBe('{"theme":"global"}')
    protect()
  })
  test.each(['implicit', 'explicit', 'legacy'])('syncs only %s native MCP definitions at launch while keeping all other named state', async mode => {
    const { accounts: original, options, root, profile, protect } = fixture(); const path = profile()
    const accounts = mode === 'explicit'
      ? new ClaudeAccounts({ ...options, env: { CLAUDE_CONFIG_DIR: original.sharedConfigDir() } }) : original
    const source = mode === 'legacy' ? join(accounts.sharedConfigDir(), '.config.json')
      : join(mode === 'explicit' ? accounts.sharedConfigDir() : root, '.claude.json')
    writeFileSync(source, JSON.stringify({ oauthAccount: { accountUuid: 'default-account' },
      mcpServers: { shared: { command: 'shared-server' } }, theme: 'global' }))
    writeFileSync(join(path, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'named-account' },
      mcpServers: { old: { command: 'old-server' } }, theme: 'private' }))
    const before = readFileSync(source, 'utf8')
    const accountBefore = readFileSync(join(path, '.claude.json'), 'utf8')
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    expect(readFileSync(join(path, '.claude.json'), 'utf8')).toBe(accountBefore)
    accounts.env(row.id, {})
    const release = accounts.acquireUse(row.id)
    release()
    expect(readFileSync(join(path, '.claude.json'), 'utf8')).toBe(accountBefore)
    accounts.prepareShared(row.id)
    expect(JSON.parse(readFileSync(join(path, '.claude.json'), 'utf8'))).toEqual({
      oauthAccount: { accountUuid: 'named-account' }, mcpServers: { shared: { command: 'shared-server' } }, theme: 'private',
    })
    expect(lstatSync(join(path, '.claude.json')).isSymbolicLink()).toBe(false)
    expect(readFileSync(source, 'utf8')).toBe(before)
    protect()
  })
  test.each(['launch', 'enroll'])('existing ready accounts gain global Skills on %s without migrating history or changing registry format', async method => {
    const { accounts, options, profile, protect } = fixture(); const path = profile()
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    // Simulate a v1 ready account from before non-login config sharing existed.
    unlinkSync(join(path, 'skills')); mkdirSync(join(path, 'skills'))
    const state = readFileSync(accounts.stateFile, 'utf8')
    const globalSkill = join(accounts.sharedConfigDir(), 'skills', 'added-later')
    mkdirSync(globalSkill, { recursive: true })
    writeFileSync(join(globalSkill, 'SKILL.md'), 'added after enrollment')
    const reloaded = new ClaudeAccounts(options)
    if (method === 'launch') reloaded.prepareShared(row.id)
    else await reloaded.enroll('备用一', async () => nativeInfo())
    expect(readFileSync(join(path, 'skills', 'added-later', 'SKILL.md'), 'utf8')).toBe('added after enrollment')
    expect(readFileSync(accounts.stateFile, 'utf8')).toBe(state)
    protect()
  })
  test('empty global legacy file does not hide current MCP configuration during startup', async () => {
    const { accounts, root, profile } = fixture(); const path = profile()
    const mcpServers = { shared: { command: 'current-global-server' } }
    writeFileSync(join(accounts.sharedConfigDir(), '.config.json'), '')
    writeFileSync(join(root, '.claude.json'), JSON.stringify({ mcpServers }))
    writeFileSync(join(path, '.claude.json'), JSON.stringify({ theme: 'own' }))
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    accounts.prepareShared(row.id)
    expect(JSON.parse(readFileSync(join(path, '.claude.json'), 'utf8'))).toEqual({ theme: 'own', mcpServers })
    expect(readFileSync(join(accounts.sharedConfigDir(), '.config.json'), 'utf8')).toBe('')
  })
  test('global config failures are reported before any enrollment history is cleared', async () => {
    const { accounts, root, profile, oldPresent, protect } = fixture(); const path = profile()
    const globalSkill = join(accounts.sharedConfigDir(), 'skills', 'helper')
    mkdirSync(globalSkill, { recursive: true }); writeFileSync(join(globalSkill, 'SKILL.md'), 'global')
    symlinkSync(join(root, 'missing-source'), join(accounts.sharedConfigDir(), 'commands'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(accounts.enroll('备用一', async () => nativeInfo())).rejects.toThrow('全局配置共享失败')
    expect(accounts.find('备用一').state).toBe('authenticating')
    oldPresent(path); protect()
  })
  test.each(['.', '..', '../escape', '/absolute', 'a/b', 'a\\b', 'bad\nname', 'bad\0name', ' leading', 'trailing ', 'trailing.', 'CON', 'a:b'])('rejects unsafe explicit remark %j', async name => {
    const { accounts, protect } = fixture()
    await expect(accounts.enroll(name, async () => nativeInfo())).rejects.toThrow('备注名')
    protect()
  })
  test.each([
    {}, { ...nativeInfo(), apiProvider: 'bedrock' }, { ...nativeInfo(), subscriptionType: '' },
    { ...nativeInfo(), apiKeySource: 'env' }, { ...nativeInfo(), email: '' },
  ] satisfies AccountInfo[])('unverified subscription identity never clears legacy history %#', async info => {
    const { accounts, profile, oldPresent, protect } = fixture(); const path = profile()
    await expect(accounts.enroll('备用一', async () => info)).rejects.toThrow('Claude')
    oldPresent(path); protect(); expect(accounts.find('备用一').state).toBe('authenticating')
  })
  test('authentication failure releases enrollment ownership and can be retried', async () => {
    const { accounts, profile, oldPresent } = fixture(); const path = profile()
    await expect(accounts.enroll('备用一', async () => { throw new Error('native auth failed') })).rejects.toThrow('native auth failed')
    oldPresent(path)
    expect((await accounts.enroll('备用一', async () => nativeInfo())).state).toBe('ready')
  })
  test('default directory and either ancestor overlap are rejected', async () => {
    const { accounts, options, profile, protect, oldPresent } = fixture()
    const same = new ClaudeAccounts({ ...options, accountsDir: options.home })
    await expect(same.enroll('.claude', async () => nativeInfo())).rejects.toThrow('祖先重叠')
    mkdirSync(join(accounts.sharedConfigDir(), 'nested'))
    const nested = new ClaudeAccounts({ ...options, accountsDir: accounts.sharedConfigDir() })
    await expect(nested.enroll('nested', async () => nativeInfo())).rejects.toThrow('祖先重叠')
    const path = profile(); mkdirSync(join(path, 'native'))
    const parent = new ClaudeAccounts({ ...options, env: { CLAUDE_CONFIG_DIR: join(path, 'native') } })
    await expect(parent.enroll('备用一', async () => nativeInfo())).rejects.toThrow('祖先重叠')
    oldPresent(path); protect()
  })
  test('profile-root and credential symlinks cannot alias another account', async () => {
    const { accounts, options, profile, protect, oldPresent } = fixture()
    symlinkSync(accounts.sharedConfigDir(), join(options.accountsDir, 'alias'), 'dir')
    await expect(accounts.enroll('alias', async () => nativeInfo())).rejects.toThrow('不能是软链接')
    const path = profile(); unlinkSync(join(path, '.credentials.json'))
    symlinkSync(join(accounts.sharedConfigDir(), '.credentials.json'), join(path, '.credentials.json'))
    await expect(accounts.enroll('备用一', async () => nativeInfo())).rejects.toThrow('凭据必须为独立文件')
    oldPresent(path); protect()
  })
  test.each(['wrong', 'broken'])('rejects %s shared links before auth or clearing another directory', async kind => {
    const { accounts, profile, protect } = fixture(); const path = profile()
    rmSync(join(path, 'plans'), { recursive: true })
    symlinkSync(join(accounts.sharedConfigDir(), kind === 'wrong' ? 'tasks' : 'missing'), join(path, 'plans'), 'dir')
    let authenticated = false
    await expect(accounts.enroll('备用一', async () => { authenticated = true; return nativeInfo() })).rejects.toThrow('其他位置')
    expect(authenticated).toBe(false)
    expect(readFileSync(join(path, 'projects', 'old.txt'), 'utf8')).toBe('old:projects'); protect()
  })
  test.each(CLAUDE_SHARED_DIRS.flatMap(key => ['target', 'link', 'both'].map(removed => ({ key, removed }))))(
    'repairs native cleanup of $key ($removed) without changing account state or existing history', async ({ key, removed }) => {
      const { accounts, options, profile } = fixture(); const path = profile()
      const row = await accounts.enroll('备用一', async () => nativeInfo())
      const source = join(path, key), target = join(accounts.sharedConfigDir(), key)
      const state = readFileSync(accounts.stateFile, 'utf8'), linkInode = lstatSync(source).ino
      if (removed !== 'link') rmSync(target, { recursive: true })
      if (removed !== 'target') unlinkSync(source)
      const reloaded = new ClaudeAccounts(options)
      reloaded.prepareShared(row.id)
      expect(lstatSync(target).isDirectory()).toBe(true)
      expect(lstatSync(source).isSymbolicLink()).toBe(true)
      expect(realpathSync(source)).toBe(realpathSync(target))
      if (removed === 'target') expect(lstatSync(source).ino).toBe(linkInode)
      for (const other of CLAUDE_SHARED_DIRS) {
        if (other !== key || removed === 'link') {
          expect(readFileSync(join(path, other, 'shared.txt'), 'utf8')).toBe('shared:' + other)
        }
      }
      writeFileSync(join(source, 'after-cleanup.txt'), 'shared again')
      expect(readFileSync(join(target, 'after-cleanup.txt'), 'utf8')).toBe('shared again')
      const repairedLinkInode = lstatSync(source).ino, targetInode = lstatSync(target).ino
      reloaded.prepareShared(row.id)
      expect(lstatSync(source).ino).toBe(repairedLinkInode)
      expect(lstatSync(target).ino).toBe(targetInode)
      expect(readFileSync(accounts.stateFile, 'utf8')).toBe(state)
      expect(reloaded.get(row.id)).toEqual(row)
      expect(readFileSync(join(path, '.credentials.json'), 'utf8')).toBe('SYNTHETIC-EXTRA-CREDENTIAL')
      expect(readFileSync(join(accounts.sharedConfigDir(), '.credentials.json'), 'utf8')).toBe('SYNTHETIC-DEFAULT-CREDENTIAL')
    },
  )
  test.each(['env', 'lease', 'candidate', 'reenroll', 'terminal'] as const)(
    '%s also recovers cleaned shared directories before launch preparation', async entry => {
      const { accounts, profile } = fixture(); const path = profile()
      const row = await accounts.enroll('备用一', async () => nativeInfo())
      for (const key of CLAUDE_SHARED_DIRS) rmSync(join(accounts.sharedConfigDir(), key), { recursive: true })
      if (entry === 'env') expect(accounts.env(row.id, {}).CLAUDE_CONFIG_DIR).toBe(path)
      else if (entry === 'lease') accounts.acquireUse(row.id)()
      else if (entry === 'candidate') expect(accounts.candidate(row.name)).toEqual(row)
      else if (entry === 'reenroll') expect(await accounts.enroll(row.name, async () => nativeInfo())).toEqual(row)
      else expect(accounts.nativeCliEnv(row.name, {}).CLAUDE_CONFIG_DIR).toBe(path)
      for (const key of CLAUDE_SHARED_DIRS) {
        expect(lstatSync(join(accounts.sharedConfigDir(), key)).isDirectory()).toBe(true)
        expect(realpathSync(join(path, key))).toBe(realpathSync(join(accounts.sharedConfigDir(), key)))
      }
    },
  )
  test('repairs a correct dangling link through a shared-root alias', async () => {
    const { accounts, root, profile } = fixture(); const path = profile()
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    const alias = join(root, 'shared-alias'), source = join(path, 'file-history')
    const directoryLink = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(accounts.sharedConfigDir(), alias, directoryLink)
    unlinkSync(source)
    const target = join(alias, 'file-history')
    symlinkSync(process.platform === 'win32' ? target : relative(path, target), source, directoryLink)
    const inode = lstatSync(source).ino
    rmSync(join(accounts.sharedConfigDir(), 'file-history'), { recursive: true })
    accounts.prepareShared(row.id)
    expect(realpathSync(source)).toBe(realpathSync(target))
    expect(lstatSync(source).ino).toBe(inode)
  })
  test.each(['wrong-link', 'target-file', 'target-symlink'] as const)(
    'rejects %s before repairing another missing directory and preserves conflicting entries', async conflict => {
      const { accounts, root, profile } = fixture(); const path = profile()
      const row = await accounts.enroll('备用一', async () => nativeInfo())
      const missing = join(accounts.sharedConfigDir(), 'file-history'), target = join(accounts.sharedConfigDir(), 'plans')
      rmSync(missing, { recursive: true }); rmSync(target, { recursive: true })
      const outside = join(root, 'outside')
      if (conflict === 'wrong-link') {
        unlinkSync(join(path, 'plans'))
        symlinkSync(outside, join(path, 'plans'), process.platform === 'win32' ? 'junction' : 'dir')
      } else if (conflict === 'target-file') writeFileSync(target, 'keep conflicting file')
      else symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => accounts.prepareShared(row.id)).toThrow(conflict === 'wrong-link' ? '其他位置' : '不是独立目录')
      expect(existsSync(missing)).toBe(false)
      expect(existsSync(outside)).toBe(false)
      if (conflict === 'target-file') expect(readFileSync(target, 'utf8')).toBe('keep conflicting file')
      else expect(lstatSync(conflict === 'wrong-link' ? join(path, 'plans') : target).isSymbolicLink()).toBe(true)
    },
  )
  test('reports a directory repair permission failure and can recover on the next attempt', async () => {
    const { accounts, profile } = fixture(); const path = profile()
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    const target = join(realpathSync(accounts.sharedConfigDir()), 'file-history'), source = join(path, 'file-history')
    rmSync(target, { recursive: true })
    const inode = lstatSync(source).ino, mkdir = fs.mkdirSync
    const denied = spyOn(fs, 'mkdirSync').mockImplementation((directory, options) => {
      if (directory === target) throw Object.assign(new Error('EACCES: synthetic repair denied'), { code: 'EACCES' })
      return mkdir(directory, options)
    })
    try { expect(() => accounts.prepareShared(row.id)).toThrow('EACCES: synthetic repair denied') }
    finally { denied.mockRestore() }
    expect(lstatSync(source).ino).toBe(inode)
    accounts.prepareShared(row.id)
    expect(realpathSync(source)).toBe(realpathSync(target))
  })
  test('recovers when native cleanup removes the target between stat and link resolution', async () => {
    const { accounts, profile } = fixture(); const path = profile()
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    const source = join(path, 'file-history'), target = join(accounts.sharedConfigDir(), 'file-history')
    const realpath = fs.realpathSync
    let cleaned = false
    const cleanup = spyOn(fs, 'realpathSync').mockImplementation(new Proxy(realpath, {
      apply(fn, receiver, args) {
        if (args[0] === source && !cleaned) { cleaned = true; rmSync(target, { recursive: true }) }
        return Reflect.apply(fn, receiver, args)
      },
    }))
    try { accounts.prepareShared(row.id) }
    finally { cleanup.mockRestore() }
    expect(cleaned).toBe(true)
    expect(realpathSync(source)).toBe(realpathSync(target))
  })
  test.each(['correct', 'wrong'] as const)('rechecks a concurrently recreated %s link after EEXIST', async kind => {
    const { accounts, root, profile } = fixture(); const path = profile()
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    const source = join(path, 'plans'), target = join(accounts.sharedConfigDir(), 'plans')
    unlinkSync(source)
    const symlink = fs.symlinkSync, other = join(root, 'other')
    mkdirSync(other); writeFileSync(join(other, 'keep.txt'), 'keep concurrent target')
    const concurrent = spyOn(fs, 'symlinkSync').mockImplementation((destination, link, type) => {
      if (link === source) {
        symlink(kind === 'correct' ? destination : other, link, type)
        throw Object.assign(new Error('EEXIST: concurrent link'), { code: 'EEXIST' })
      }
      symlink(destination, link, type)
    })
    try {
      if (kind === 'correct') accounts.prepareShared(row.id)
      else expect(() => accounts.prepareShared(row.id)).toThrow('其他位置')
    } finally { concurrent.mockRestore() }
    expect(realpathSync(source)).toBe(realpathSync(kind === 'correct' ? target : other))
    expect(readFileSync(join(other, 'keep.txt'), 'utf8')).toBe('keep concurrent target')
  })
  test.each(['once', 'continuous'] as const)('bounds repair attempts during %s concurrent cleanup', async cleanupMode => {
    const { accounts, profile } = fixture(); const path = profile()
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    const target = join(realpathSync(accounts.sharedConfigDir()), 'tasks')
    rmSync(target, { recursive: true })
    const mkdir = fs.mkdirSync
    let attempts = 0
    const cleanup = spyOn(fs, 'mkdirSync').mockImplementation((directory, options) => {
      const result = mkdir(directory, options)
      if (directory === target) {
        attempts++
        if (cleanupMode === 'continuous' || attempts === 1) rmSync(target, { recursive: true })
      }
      return result
    })
    try {
      if (cleanupMode === 'continuous') expect(() => accounts.prepareShared(row.id)).toThrow('修复后再次缺失：tasks')
      else accounts.prepareShared(row.id)
    } finally { cleanup.mockRestore() }
    expect(attempts).toBe(cleanupMode === 'continuous' ? 3 : 2)
    expect(lstatSync(join(path, 'tasks')).isSymbolicLink()).toBe(true)
    if (cleanupMode === 'once') expect(realpathSync(join(path, 'tasks'))).toBe(realpathSync(target))
  })
  test('resumes enrollment after cleanup removes already recorded links and targets', async () => {
    const { accounts, options, profile } = fixture(); const path = profile()
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    const state = JSON.parse(readFileSync(accounts.stateFile, 'utf8'))
    state.accounts[0].state = 'enrolling'
    writeFileSync(accounts.stateFile, JSON.stringify(state))
    unlinkSync(join(path, 'tasks'))
    rmSync(join(accounts.sharedConfigDir(), 'tasks'), { recursive: true })
    rmSync(join(accounts.sharedConfigDir(), 'file-history'), { recursive: true })
    const recovered = await new ClaudeAccounts(options).enroll(row.name, async () => nativeInfo())
    expect(recovered).toEqual(row)
    for (const key of CLAUDE_SHARED_DIRS) expect(realpathSync(join(path, key))).toBe(realpathSync(join(accounts.sharedConfigDir(), key)))
  })
  test('ready validation and repeated enrollment never clear a newly replaced local directory', async () => {
    const { accounts, profile, protect } = fixture(); const path = profile()
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    unlinkSync(join(path, 'plans')); mkdirSync(join(path, 'plans')); writeFileSync(join(path, 'plans', 'new.md'), 'new private plan')
    expect(() => accounts.prepareShared(row.id)).toThrow('已被替换')
    await expect(accounts.enroll('备用一', async () => nativeInfo())).rejects.toThrow('已被替换')
    expect(readFileSync(join(path, 'plans', 'new.md'), 'utf8')).toBe('new private plan'); protect()
  })
  test('repeat successful enrollment is idempotent including identity generation', async () => {
    const { accounts, profile, protect } = fixture(); profile()
    const first = await accounts.enroll('备用一', async () => nativeInfo())
    const state = readFileSync(accounts.stateFile, 'utf8')
    expect(await accounts.enroll('备用一', async () => nativeInfo())).toEqual(first)
    expect(readFileSync(accounts.stateFile, 'utf8')).toBe(state); protect()
  })
  test.each(CLAUDE_SHARED_DIRS.flatMap(key => [`after-delete:${key}`, `after-link:${key}`]))('durable enrollment recovers from %s without a persistent lock', async phase => {
    const { accounts, options, profile, protect } = fixture(); const path = profile()
    const [when, key] = phase.split(':')
    const originalRm = fs.rmSync, originalLink = fs.symlinkSync
    const injected = when === 'after-delete'
      ? spyOn(fs, 'rmSync').mockImplementation((target, opts) => { originalRm(target, opts); if (target === join(path, key!)) throw new Error('injected crash boundary') })
      : spyOn(fs, 'symlinkSync').mockImplementation((target, destination, type) => { originalLink(target, destination, type); if (destination === join(path, key!)) throw new Error('injected crash boundary') })
    try { await expect(accounts.enroll('备用一', async () => nativeInfo())).rejects.toThrow('injected crash boundary') }
    finally { injected.mockRestore() }
    expect(accounts.find('备用一').state).toBe('enrolling'); expect(accounts.list()).toHaveLength(1)
    expect(() => accounts.acquireUse(accounts.find('备用一').id)).toThrow('尚未完成')
    protect()
    const recovered = await new ClaudeAccounts(options).enroll('备用一', async () => nativeInfo())
    expect(recovered.state).toBe('ready')
    expect(readdirSync(join(options.home, 'state'))).toEqual(['accounts.json'])
    protect()
  })
  test('failed intent persistence leaves all legacy histories intact', async () => {
    const { accounts, profile, oldPresent } = fixture(); const path = profile()
    const write = spyOn(stateStore, 'writeJsonStateAtomic').mockImplementation(() => { throw new Error('disk full') })
    try { await expect(accounts.enroll('备用一', async () => nativeInfo())).rejects.toThrow('disk full') }
    finally { write.mockRestore() }
    oldPresent(path); expect(existsSync(accounts.stateFile)).toBe(false)
  })
  test.skipIf(process.platform === 'win32')('SIGKILL of the exact enrollment worker leaves durable intent that a new process owner can resume', async () => {
    const { accounts, options, root, profile, protect } = fixture(); const path = profile()
    const marker = join(root, 'worker-ready.json'), workerFile = join(root, 'enrollment-worker.test.ts')
    // A separate test process pauses synchronously after linking projects, before phase persistence.
    // All directories, identities, and credential sentinels are synthetic fixtures.
    writeFileSync(workerFile, `
import { test, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { ClaudeAccounts } from ${JSON.stringify(join(import.meta.dir, 'claude-accounts.ts'))}
test('synthetic enrollment worker', async () => {
  const link = fs.symlinkSync
  spyOn(fs, 'symlinkSync').mockImplementation((target, destination, type) => {
    link(target, destination, type)
    if (destination === ${JSON.stringify(join(path, 'projects'))}) {
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, phase: 'after-link:projects' }))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }
  })
  await new ClaudeAccounts(${JSON.stringify(options)}).enroll('备用一', async () => (${JSON.stringify(nativeInfo())}))
}, 15000)
`)
    const worker = Bun.spawn([process.execPath, 'test', workerFile], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    let exited = false
    const stopExactWorker = async () => {
      if (exited) return
      const ps = Bun.spawn(['ps', '-p', String(worker.pid), '-o', 'pid=,command='], { stdout: 'pipe', stderr: 'pipe' })
      const command = (await new Response(ps.stdout).text()).trim()
      expect(await ps.exited).toBe(0); expect(command).toContain(workerFile)
      console.log('收录崩溃测试终止前确认精确 PID 与完整命令：\n' + command)
      worker.kill('SIGKILL'); await worker.exited; exited = true
    }
    try {
      const deadline = Date.now() + 5_000
      while (!existsSync(marker)) {
        if (Date.now() > deadline) throw new Error('synthetic worker readiness timeout')
        await Bun.sleep(10)
      }
      expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ pid: worker.pid, phase: 'after-link:projects' })
      expect(accounts.find('备用一').state).toBe('enrolling')
      await stopExactWorker(); protect()
      const recovered = await new ClaudeAccounts(options).enroll('备用一', async () => nativeInfo())
      expect(recovered.state).toBe('ready')
      for (const key of CLAUDE_SHARED_DIRS) expect(realpathSync(join(path, key))).toBe(realpathSync(join(accounts.sharedConfigDir(), key)))
      expect(readdirSync(join(root, 'state'))).toEqual(['accounts.json'])
      expect(readFileSync(join(path, '.credentials.json'), 'utf8')).toBe('SYNTHETIC-EXTRA-CREDENTIAL')
      protect()
    } finally { await stopExactWorker() }
  }, 15_000)
  test('same-account enrollment serializes across manager instances', async () => {
    const { accounts, options, profile } = fixture(); profile(); let active = 0; let maximum = 0
    const auth = async () => { active++; maximum = Math.max(maximum, active); await Bun.sleep(10); active--; return nativeInfo() }
    const rows = await Promise.all([accounts, new ClaudeAccounts(options), accounts].map(manager => manager.enroll('备用一', auth)))
    expect(maximum).toBe(1); expect(new Set(rows.map(row => row.id)).size).toBe(1)
    expect(accounts.get(rows[0]!.id).generation).toBe(1)
  })
  test('first sync persists its gate across restart and leaves the default account usable', async () => {
    const { accounts, options, profile, oldPresent, protect } = fixture(); const path = profile()
    const releaseDefault = accounts.acquireUse('default')
    let continueSync!: () => void, entered!: () => void
    const pending = new Promise<void>(resolve => { continueSync = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const enrollment = accounts.enroll('备用一', async (candidate, syncing) => {
      expect(accounts.get(candidate.id).state).toBe('authenticating')
      // These must already be shared when native startup begins writing.
      expect(realpathSync(join(path, 'skills'))).toBe(realpathSync(join(accounts.sharedConfigDir(), 'skills')))
      expect(realpathSync(join(path, 'plugins'))).toBe(realpathSync(join(accounts.sharedConfigDir(), 'plugins')))
      const release = accounts.acquireCandidateUse(candidate)
      syncing(nativeInfo()); entered()
      try { await pending; oldPresent(path); return nativeInfo() } finally { release() }
    })
    try {
      await started
      const restarted = new ClaudeAccounts(options), row = restarted.find('备用一')
      expect(row.state).toBe('syncing'); expect(row.identity).toBeTruthy()
      expect(restarted.list().map(item => item.id)).toEqual(['default'])
      expect(() => restarted.assertReady(row.id)).toThrow('正在完成首次同步')
      expect(() => restarted.env(row.id, {})).toThrow('正在完成首次同步')
      expect(() => restarted.acquireUse(row.id)).toThrow('尚未完成')
      expect(() => restarted.prepareShared(row.id)).toThrow('尚未完成')
      expect(() => restarted.observeIdentity(row.id, nativeInfo())).toThrow('尚未完成')
      restarted.acquireUse('default')()
      oldPresent(path); protect()
    } finally { continueSync(); releaseDefault() }
    expect((await enrollment).state).toBe('ready')
  })
  test('sync failure is durable, throttles explicit retries and resumes after cooldown', async () => {
    const { accounts, options, profile, oldPresent } = fixture(); const path = profile()
    let calls = 0
    const fail = async (_candidate: unknown, syncing: (info: AccountInfo) => void) => {
      calls++; syncing(nativeInfo()); throw new Error('首次同步超时：skills manifest 未完成')
    }
    await expect(accounts.enroll('备用一', fail)).rejects.toThrow('首次同步超时')
    const failed = accounts.find('备用一')
    expect(failed.state).toBe('sync_failed'); expect(failed.syncFailure?.attempts).toBe(1)
    expect(failed.syncFailure?.message).toContain('manifest')
    const restarted = new ClaudeAccounts(options)
    expect(restarted.list()).toHaveLength(1)
    await expect(restarted.enroll('备用一', fail)).rejects.toThrow('秒后重试 hi')
    expect(calls).toBe(1); oldPresent(path)
    const now = spyOn(Date, 'now').mockReturnValue(failed.syncFailure!.retryAt + 1)
    try {
      await expect(restarted.enroll('备用一', fail)).rejects.toThrow('首次同步超时')
      const second = restarted.find('备用一')
      expect(second.syncFailure?.attempts).toBe(2)
      expect(second.syncFailure!.retryAt - Date.now()).toBe(120_000)
      now.mockReturnValue(second.syncFailure!.retryAt + 1)
      const ready = await restarted.enroll('备用一', async (_candidate, syncing) => { syncing(nativeInfo()); return nativeInfo() })
      expect(ready.state).toBe('ready'); expect(ready.syncFailure).toBeUndefined()
      expect(ready.generation).toBe(1)
    } finally { now.mockRestore() }
  })
  test('interrupted syncing records retry without deleting already shared histories', async () => {
    const { accounts, options, profile } = fixture(); const path = profile()
    const ready = await accounts.enroll('备用一', async () => nativeInfo())
    const state = JSON.parse(readFileSync(accounts.stateFile, 'utf8'))
    state.accounts[0].state = 'syncing'
    writeFileSync(accounts.stateFile, JSON.stringify(state))
    writeFileSync(join(path, 'projects', 'retained.md'), 'keep shared history')
    const resumed = await new ClaudeAccounts(options).enroll('备用一', async (_candidate, syncing) => {
      syncing(nativeInfo()); return nativeInfo()
    })
    expect(resumed).toEqual(ready)
    expect(readFileSync(join(path, 'projects', 'retained.md'), 'utf8')).toBe('keep shared history')
  })
  test('use leases block reinitialization until every exact lease is released', async () => {
    const { accounts, profile } = fixture(); profile()
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    const one = accounts.acquireUse(row.id), two = accounts.acquireUse(row.id)
    try {
      await expect(accounts.enroll('备用一', async () => nativeInfo())).rejects.toThrow('正在使用')
      one(); one()
      await expect(accounts.enroll('备用一', async () => nativeInfo())).rejects.toThrow('正在使用')
    } finally { one(); two() }
    expect((await accounts.enroll('备用一', async () => nativeInfo())).state).toBe('ready')
  })
  test('ordinary queries cannot acquire an initializing ready account while raw auth is pending', async () => {
    const { accounts, profile } = fixture(); profile()
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    await accounts.enroll('备用一', async candidate => {
      expect(accounts.candidateEnv(candidate, {}).CLAUDE_CONFIG_DIR).toBe(row.configDir)
      expect(() => accounts.acquireUse(row.id)).toThrow('正在校验收录')
      return nativeInfo()
    })
  })
  test('candidate lease exception is restricted to the active enrollment owner', async () => {
    const { accounts, profile } = fixture(); profile()
    const candidate = accounts.candidate('备用一')
    expect(() => accounts.acquireCandidateUse(candidate)).toThrow('正在执行的收录回调')
    await accounts.enroll('备用一', async active => {
      expect(() => accounts.acquireCandidateUse(candidate)).toThrow('正在执行的收录回调')
      const release = accounts.acquireCandidateUse(active)
      expect(() => accounts.acquireUse(active.id)).toThrow()
      release(); release()
      return nativeInfo()
    })
    expect(() => accounts.acquireCandidateUse(candidate)).toThrow('正在执行的收录回调')
  })
  test('an unclosed native auth probe retains use across failed enrollment and blocks destructive retries', async () => {
    const { accounts, profile, oldPresent, protect } = fixture(); const path = profile()
    let release: (() => void) | undefined
    try {
      await expect(accounts.enroll('备用一', async candidate => {
        release = accounts.acquireCandidateUse(candidate)
        throw new Error('native close unconfirmed')
      })).rejects.toThrow('native close unconfirmed')
      oldPresent(path); protect()
      await expect(accounts.enroll('备用一', async () => nativeInfo())).rejects.toThrow('正在使用')
      oldPresent(path)
    } finally { release?.() }
    expect((await accounts.enroll('备用一', async () => nativeInfo())).state).toBe('ready')
  })
  test('even a successful auth response cannot clear history before its native process exits', async () => {
    const { accounts, profile, oldPresent } = fixture(); const path = profile()
    let release: (() => void) | undefined
    try {
      await expect(accounts.enroll('备用一', async candidate => {
        release = accounts.acquireCandidateUse(candidate)
        return nativeInfo()
      })).rejects.toThrow('退出尚未确认')
      oldPresent(path); expect(accounts.find('备用一').state).toBe('authenticating')
    } finally { release?.() }
  })
  test('default identity and another remark cannot duplicate a real account', async () => {
    const { accounts, profile, oldPresent } = fixture(); const path = profile()
    accounts.observeIdentity('default', nativeInfo())
    await expect(accounts.enroll('备用一', async () => nativeInfo())).rejects.toThrow('同一订阅身份'); oldPresent(path)
    await accounts.enroll('备用一', async () => nativeInfo('other@example.test'))
    const duplicate = profile('duplicate')
    await expect(accounts.enroll('duplicate', async () => nativeInfo('OTHER@example.test'))).rejects.toThrow('同一订阅身份')
    oldPresent(duplicate)
  })
  test('concurrent remarks admitting one real identity preserve the losing profile', async () => {
    const { accounts, profile, oldPresent } = fixture(); const one = profile('one'), two = profile('two')
    const results = await Promise.allSettled(['one', 'two'].map(name => accounts.enroll(name, async () => nativeInfo())))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(accounts.list()).toHaveLength(2)
    oldPresent(results[0]!.status === 'rejected' ? one : two)
  })
  test('identities invalidate generations, preserve other accounts, and fence late A/B/A observations', async () => {
    const { accounts, profile } = fixture(); profile()
    accounts.observeIdentity('default', nativeInfo('native@example.test'))
    const nativeRevision = accounts.revision('default')
    const row = await accounts.enroll('备用一', async () => nativeInfo('A@example.test'))
    const first = accounts.revision(row.id)
    expect(accounts.observeIdentity(row.id, nativeInfo('a@example.test'), first)).toBe(first)
    const second = accounts.observeIdentity(row.id, nativeInfo('B@example.test'), first)
    expect(second).not.toBe(first)
    expect(() => accounts.observeIdentity(row.id, nativeInfo('A@example.test'), first)).toThrow('旧代次')
    accounts.observeIdentity(row.id, nativeInfo('A@example.test'), second)
    expect(accounts.get(row.id).generation).toBe(3)
    expect(() => accounts.observeIdentity(row.id, nativeInfo('A@example.test'), first)).toThrow('旧代次')
    expect(accounts.revision('default')).toBe(nativeRevision)
    const nativeSecond = accounts.observeIdentity('default', nativeInfo('native2@example.test'), nativeRevision)
    expect(nativeSecond).not.toBe(nativeRevision); expect(accounts.get('default').generation).toBe(2)
  })
  test('identity conflict invalidates a previously successful identity before rejecting the probe', async () => {
    const { accounts, profile } = fixture(); profile()
    accounts.observeIdentity('default', nativeInfo('native@example.test'))
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    const before = accounts.revision(row.id)
    expect(() => accounts.observeIdentity(row.id, nativeInfo('native@example.test'), before)).toThrow('同一订阅身份')
    expect(accounts.revision(row.id)).not.toBe(before)
    expect(accounts.get(row.id).identity).toBeUndefined()
  })
  test('explicit reenrollment invalidates the old revision when a ready account changed to a duplicate identity', async () => {
    const { accounts, profile, protect } = fixture(); const path = profile()
    accounts.observeIdentity('default', nativeInfo('native@example.test'))
    const row = await accounts.enroll('备用一', async () => nativeInfo('old@example.test'))
    const before = accounts.revision(row.id)
    await expect(accounts.enroll('备用一', async () => nativeInfo('native@example.test'))).rejects.toThrow('同一订阅身份')
    expect(accounts.revision(row.id)).not.toBe(before)
    expect(accounts.get(row.id).identity).toBeUndefined()
    expect(accounts.get(row.id).generation).toBe(row.generation + 1)
    expect(accounts.get(row.id).state).toBe('ready')
    for (const key of CLAUDE_SHARED_DIRS) expect(lstatSync(join(path, key)).isSymbolicLink()).toBe(true)
    protect()
  })
  test('broken registry is not silently replaced and ready account relocation is rejected', async () => {
    const { accounts, options, profile } = fixture(); profile()
    const row = await accounts.enroll('备用一', async () => nativeInfo())
    const saved = readFileSync(accounts.stateFile, 'utf8')
    writeFileSync(accounts.stateFile, '{broken')
    expect(() => accounts.list()).toThrow(); expect(readFileSync(accounts.stateFile, 'utf8')).toBe('{broken')
    writeFileSync(accounts.stateFile, saved)
    const otherShared = join(options.home, 'other-native'); mkdirSync(otherShared)
    const changed = new ClaudeAccounts({ ...options, env: { CLAUDE_CONFIG_DIR: otherShared } })
    expect(() => changed.prepareShared(row.id)).toThrow('共享目录已变化')
  })
  test('process mapping has no implicit default and owns no lease', () => {
    const one = {} as AgentProcess, two = {} as AgentProcess
    expect(processClaudeAccount()).toBeNull(); expect(processClaudeAccount(one)).toBeNull()
    bindProcessClaudeAccount(one, DEFAULT_CLAUDE_ACCOUNT)
    bindProcessClaudeAccount(two, 'named-id')
    expect(processClaudeAccount(one)).toBe('default'); expect(processClaudeAccount(two)).toBe('named-id')
  })
})
