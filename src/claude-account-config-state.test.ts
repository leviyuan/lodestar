import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncClaudeAccountConfigState } from './claude-account-config-state'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const dirLink = process.platform === 'win32' ? 'junction' : 'dir'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-account-config-state-'))
  roots.push(root)
  const shared = join(root, '.claude'), account = join(root, '.claude-accounts', 'named')
  mkdirSync(shared); mkdirSync(account, { recursive: true })
  const native = join(root, '.claude.json'), current = join(account, '.claude.json'), legacy = join(account, '.config.json')
  return { root, shared, account, native, current, legacy, sync: () => syncClaudeAccountConfigState(account, shared, native) }
}

function put(path: string, value: Record<string, unknown>) { writeFileSync(path, JSON.stringify(value)) }
function read(path: string): Record<string, unknown> { return JSON.parse(readFileSync(path, 'utf8')) }

describe('Claude account native config state sharing', () => {
  test('global MCP, project settings and preferences replace local non-login values while preserving the named identity', () => {
    const f = fixture()
    put(f.native, {
      oauthAccount: { accountUuid: 'default' }, primaryApiKey: 'SYNTHETIC-DEFAULT',
      theme: 'light', mcpServers: { global: { command: 'global-mcp' } },
      projects: { '/global-project': { mcpServers: { project: { command: 'project-mcp' } }, hasTrustDialogAccepted: true } },
      autoCompactEnabled: false,
    })
    put(f.current, {
      oauthAccount: { accountUuid: 'named' }, primaryApiKey: 'SYNTHETIC-NAMED',
      customApiKeyResponses: { approved: ['named-only'] }, hasCompletedOnboarding: true,
      theme: 'dark', mcpServers: { stale: { command: 'stale-mcp' } }, projects: { '/old': {} }, localOnly: true,
    })
    writeFileSync(join(f.account, '.credentials.json'), 'SYNTHETIC-PRIVATE-CREDENTIAL')
    const source = readFileSync(f.native, 'utf8')

    f.sync()

    expect(read(f.current)).toEqual({
      oauthAccount: { accountUuid: 'named' }, primaryApiKey: 'SYNTHETIC-NAMED',
      customApiKeyResponses: { approved: ['named-only'] }, hasCompletedOnboarding: true,
      theme: 'light', mcpServers: { global: { command: 'global-mcp' } },
      projects: { '/global-project': { mcpServers: { project: { command: 'project-mcp' } }, hasTrustDialogAccepted: true } },
      autoCompactEnabled: false,
    })
    expect(readFileSync(f.native, 'utf8')).toBe(source)
    expect(readFileSync(join(f.account, '.credentials.json'), 'utf8')).toBe('SYNTHETIC-PRIVATE-CREDENTIAL')
    expect(readdirSync(f.account).sort()).toEqual(['.claude.json', '.credentials.json'])
    if (process.platform !== 'win32') expect(lstatSync(f.current).mode & 0o777).toBe(0o600)
  })

  test('never imports global identity, onboarding, entitlement or feature caches absent from the named account', () => {
    const f = fixture()
    put(f.native, {
      oauthAccount: { accountUuid: 'default' }, primaryApiKey: 'SYNTHETIC-DEFAULT', customApiKeyResponses: { approved: ['default'] },
      hasCompletedOnboarding: true, hasAvailableSubscription: true, lastOnboardingVersion: 'other', subscriptionNoticeCount: 3,
      userID: 'default-user', machineID: 'default-machine', summonSidKey: 'default-key', remoteControlMachineId: 'default-remote',
      modelAccessCache: [{ entitled: true }], orgModelDefaultCache: { orgUuid: 'default' },
      clientDataCache: { permission: true }, clientDataCacheSlots: { default: {} },
      additionalModelOptionsCache: ['other-model'], additionalModelOptionsAnsweredAt: 42, additionalModelCostsCache: { other: {} },
      cachedArtifactRoster: ['default-artifact'], lastSeenOrgDefaultUpdatedAt: 'default-date', autoCompactWindowsCache: {},
      cachedUsageUtilization: { percent: 0 }, githubWebConnectionStatusCache: { loggedIn: true }, startupPrefetchedAt: 42,
      cachedDynamicConfigs: { permission: true }, cachedGrowthBookFeatures: { permission: true }, cachedGrowthBookFeaturesAt: 42,
      cachedExperimentFeatures: ['default-feature'], cachedExperimentData: { default: true }, theme: 'light',
    })
    put(f.current, { oauthAccount: { accountUuid: 'named' }, modelAccessCache: [{ entitled: false }], userID: 'named-user' })

    f.sync()

    expect(read(f.current)).toEqual({ theme: 'light', oauthAccount: { accountUuid: 'named' }, modelAccessCache: [{ entitled: false }], userID: 'named-user' })
  })

  test('uses an existing legacy file and keeps each existing state file’s own login fields', () => {
    const f = fixture()
    const globalLegacy = join(f.shared, '.config.json')
    put(globalLegacy, { theme: 'global-legacy', oauthAccount: { accountUuid: 'default' } })
    put(f.native, { theme: 'wrong-source' })
    put(f.legacy, { theme: 'old', oauthAccount: { accountUuid: 'legacy-login' } })
    put(f.current, { theme: 'old', oauthAccount: { accountUuid: 'current-login' } })

    syncClaudeAccountConfigState(f.account, f.shared, globalLegacy)

    expect(read(f.legacy)).toEqual({ theme: 'global-legacy', oauthAccount: { accountUuid: 'legacy-login' } })
    expect(read(f.current)).toEqual({ theme: 'global-legacy', oauthAccount: { accountUuid: 'current-login' } })
  })

  test('does not create an inactive current file when only the legacy state exists', () => {
    const f = fixture()
    put(f.native, { theme: 'light' }); put(f.legacy, { oauthAccount: { accountUuid: 'legacy-login' } })
    f.sync()
    expect(read(f.legacy)).toEqual({ theme: 'light', oauthAccount: { accountUuid: 'legacy-login' } })
    expect(existsSync(f.current)).toBe(false)
  })

  test('creates a missing current state with ordinary defaults and no default login', () => {
    const f = fixture()
    put(f.native, { theme: 'light', oauthAccount: { accountUuid: 'default' } })
    f.sync()
    expect(read(f.current)).toEqual({ theme: 'light' })
  })

  test('a missing global state removes local ordinary fields but retains local login metadata', () => {
    const f = fixture()
    put(f.current, { oauthAccount: { accountUuid: 'named' }, theme: 'old', mcpServers: { stale: {} } })
    f.sync()
    expect(read(f.current)).toEqual({ oauthAccount: { accountUuid: 'named' } })
    expect(existsSync(f.native)).toBe(false)
  })

  test('does not create state or locks when both native states are absent', () => {
    const f = fixture()
    f.sync()
    expect(readdirSync(f.account)).toEqual([])
    expect(readdirSync(f.root).sort()).toEqual(['.claude', '.claude-accounts'])
  })

  test('handles a missing global state beneath a linked home directory', () => {
    const f = fixture()
    const homeAlias = join(f.root, 'home-alias')
    symlinkSync(f.shared, homeAlias, dirLink)
    put(f.current, { oauthAccount: { accountUuid: 'named' }, theme: 'stale' })
    syncClaudeAccountConfigState(f.account, f.shared, join(homeAlias, '.claude.json'))
    expect(read(f.current)).toEqual({ oauthAccount: { accountUuid: 'named' } })
    expect(readdirSync(f.shared)).toEqual([])
  })

  test('later syncs propagate global changes and removals without retaining named overrides', () => {
    const f = fixture()
    put(f.native, { theme: 'first', mcpServers: { first: {} } })
    put(f.current, { oauthAccount: { accountUuid: 'named' } })
    f.sync()
    put(f.native, { theme: 'second' })
    f.sync()
    expect(read(f.current)).toEqual({ theme: 'second', oauthAccount: { accountUuid: 'named' } })
  })

  test('an unchanged sync preserves native bytes and inode without making backups', () => {
    const f = fixture()
    put(f.native, { theme: 'light' })
    const text = '{ "theme": "light", "oauthAccount": { "accountUuid": "named" } }'
    writeFileSync(f.current, text)
    const before = lstatSync(f.current)
    f.sync()
    expect(readFileSync(f.current, 'utf8')).toBe(text)
    expect(lstatSync(f.current).ino).toBe(before.ino)
    expect(lstatSync(f.current).mtimeMs).toBe(before.mtimeMs)
    expect(readdirSync(f.account)).toEqual(['.claude.json'])
  })

  test.each(['source', 'legacy', 'current'])('rejects malformed %s JSON before changing any account state', target => {
    const f = fixture()
    put(f.native, { theme: 'light' }); put(f.legacy, { theme: 'old-legacy' }); put(f.current, { theme: 'old-current' })
    writeFileSync(target === 'source' ? f.native : target === 'legacy' ? f.legacy : f.current, '{invalid')
    const before = [f.legacy, f.current].map(path => readFileSync(path, 'utf8'))
    expect(f.sync).toThrow('JSON 无效')
    expect([f.legacy, f.current].map(path => readFileSync(path, 'utf8'))).toEqual(before)
    expect(readdirSync(f.account).sort()).toEqual(['.claude.json', '.config.json'])
    expect(existsSync(`${f.native}.lock`)).toBe(false)
  })

  test.each(['source', 'account'])('respects an existing %s native lock without removing or stealing it', target => {
    const f = fixture()
    put(f.native, { theme: 'light' }); put(f.current, { theme: 'old', oauthAccount: { accountUuid: 'named' } })
    const path = `${target === 'source' ? f.native : f.current}.lock`
    mkdirSync(path); writeFileSync(join(path, 'owned-by-native'), 'keep')
    const before = readFileSync(f.current, 'utf8')
    expect(f.sync).toThrow('正在被写入')
    expect(readFileSync(f.current, 'utf8')).toBe(before)
    expect(readFileSync(join(path, 'owned-by-native'), 'utf8')).toBe('keep')
    expect(existsSync(`${target === 'source' ? f.current : f.native}.lock`)).toBe(false)
  })

  test('rejects a linked account root before any write', () => {
    const f = fixture()
    put(f.native, { theme: 'light' })
    const alias = join(f.root, 'account-alias')
    symlinkSync(f.account, alias, dirLink)
    expect(() => syncClaudeAccountConfigState(alias, f.shared, f.native)).toThrow('根目录必须为独立目录')
    expect(readdirSync(f.account)).toEqual([])
    expect(existsSync(`${f.native}.lock`)).toBe(false)
  })

  test('rejects shared ancestor overlap even when the shared path is an alias', () => {
    const f = fixture()
    put(f.native, { theme: 'light' })
    const alias = join(f.root, 'shared-alias')
    symlinkSync(join(f.root, '.claude-accounts'), alias, dirLink)
    expect(() => syncClaudeAccountConfigState(f.account, alias, f.native)).toThrow('目录重叠')
    expect(readdirSync(f.account)).toEqual([])
  })

  test.each(['symbolic', 'hard'])('rejects an account state %s link to the default state without overwriting it', kind => {
    const f = fixture()
    put(f.native, { theme: 'light', oauthAccount: { accountUuid: 'default' } })
    if (kind === 'symbolic') symlinkSync(f.native, f.current)
    else linkSync(f.native, f.current)
    const before = readFileSync(f.native, 'utf8')
    expect(f.sync).toThrow(kind === 'symbolic' ? '独立文件' : '同一文件')
    expect(readFileSync(f.native, 'utf8')).toBe(before)
    expect(readFileSync(f.current, 'utf8')).toBe(before)
  })

  test('reads a linked global state without following account state links or changing the source', () => {
    const f = fixture()
    const actual = join(f.root, 'global-state.json')
    put(actual, { theme: 'linked-source', oauthAccount: { accountUuid: 'default' } })
    symlinkSync(actual, f.native)
    put(f.current, { oauthAccount: { accountUuid: 'named' } })
    f.sync()
    expect(read(f.current)).toEqual({ theme: 'linked-source', oauthAccount: { accountUuid: 'named' } })
    expect(lstatSync(f.native).isSymbolicLink()).toBe(true)
    expect(read(actual)).toEqual({ theme: 'linked-source', oauthAccount: { accountUuid: 'default' } })
    expect(existsSync(`${actual}.lock`)).toBe(false)
    expect(existsSync(`${f.native}.lock`)).toBe(false)
  })
})
