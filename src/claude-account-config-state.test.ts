import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncClaudeAccountConfigState } from './claude-account-config-state'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const dirLink = process.platform === 'win32' ? 'junction' : 'dir'
type State = Record<string, unknown>

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-account-config-state-'))
  roots.push(root)
  const shared = join(root, '.claude'), account = join(root, '.claude-accounts', 'named')
  mkdirSync(shared); mkdirSync(account, { recursive: true })
  const native = join(root, '.claude.json'), current = join(account, '.claude.json'), legacy = join(account, '.config.json')
  return { root, shared, account, native, current, legacy, sync: () => syncClaudeAccountConfigState(account, shared, native) }
}

function put(path: string, value: State) { writeFileSync(path, JSON.stringify(value)) }
function read(path: string): State { return JSON.parse(readFileSync(path, 'utf8')) }
function snapshot(path: string): unknown {
  const stat = lstatSync(path)
  return { inode: stat.ino, device: stat.dev, mtime: stat.mtimeMs, mode: stat.mode,
    contents: stat.isSymbolicLink() ? readlinkSync(path)
      : stat.isDirectory() ? readdirSync(path).sort().map(name => [name, snapshot(join(path, name))])
      : readFileSync(path, 'utf8') }
}

/** Synchronous spies are restored before returning, including assertion failures. */
function expectNoWrites(action: () => void): void {
  const spies = [spyOn(fs, 'writeFileSync'), spyOn(fs, 'renameSync'), spyOn(fs, 'unlinkSync'),
    spyOn(fs, 'mkdirSync'), spyOn(fs, 'rmdirSync'), spyOn(fs, 'rmSync'), spyOn(fs, 'utimesSync')]
  try {
    expect(action()).toBeUndefined()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  } finally { for (const spy of spies.reverse()) spy.mockRestore() }
}

describe('Claude startup-only native MCP configuration synchronization', () => {
  test('equal MCP ignores key order and all identity, cache, theme, trust and unknown differences without any write', () => {
    const f = fixture()
    put(f.native, {
      mcpServers: { alpha: { command: 'server', args: ['a'], env: { ONE: '1', TWO: '2' } }, beta: { url: 'https://example.test/mcp' } },
      projects: {
        '/workspace': { mcpServers: { project: { command: 'project-server', args: [] } }, enabledMcpServers: ['alpha'],
          disabledMcpServers: ['beta'], hasTrustDialogAccepted: true, allowedTools: ['default-only'] },
        '/default-only': { hasTrustDialogAccepted: true },
      },
      oauthAccount: { accountUuid: 'default' }, cachedDynamicConfigs: { default: true }, theme: 'light', futureDefaultOnly: true,
    })
    const target = {
      futurePrivateField: { tokenMetadata: 'SYNTHETIC-NAMED' }, oauthAccount: { accountUuid: 'named' }, theme: 'dark',
      cachedDynamicConfigs: { named: true },
      projects: {
        '/named-only': { hasTrustDialogAccepted: false, unknown: 'preserve' },
        '/workspace': { disabledMcpServers: ['beta'], enabledMcpServers: ['alpha'],
          mcpServers: { project: { args: [], command: 'project-server' } }, hasTrustDialogAccepted: false, allowedTools: ['named-only'] },
      },
      mcpServers: { beta: { url: 'https://example.test/mcp' }, alpha: { env: { TWO: '2', ONE: '1' }, args: ['a'], command: 'server' } },
    }
    writeFileSync(f.current, ` \n${JSON.stringify(target, null, 3)}\n\n`)
    const before = snapshot(f.current), source = snapshot(f.native), entries = readdirSync(f.account)
    expectNoWrites(f.sync)
    expect(snapshot(f.current)).toEqual(before)
    expect(snapshot(f.native)).toEqual(source)
    expect(readdirSync(f.account)).toEqual(entries)
  })

  test('different MCP replaces only the top-level and three project MCP fields', () => {
    const f = fixture()
    put(f.native, {
      oauthAccount: { accountUuid: 'default' }, primaryApiKey: 'SYNTHETIC-DEFAULT', theme: 'light', futureDefaultOnly: { auth: 'do-not-copy' },
      mcpServers: { global: { command: 'global-mcp' } },
      projects: {
        '/existing': { mcpServers: { project: { command: 'project-mcp' } }, enabledMcpServers: ['project'], disabledMcpServers: ['blocked'],
          hasTrustDialogAccepted: true, allowedTools: ['default-tool'], enableAllProjectMcpServers: true,
          enabledMcpjsonServers: ['legacy-default'], disabledMcpjsonServers: ['legacy-blocked'], unknownDefault: true },
        '/new-mcp': { mcpServers: {}, disabledMcpServers: [], hasTrustDialogAccepted: true, enabledMcpjsonServers: ['legacy-new'] },
        '/new-non-mcp': { hasTrustDialogAccepted: true, allowedTools: ['default-tool'] },
      },
    })
    put(f.current, {
      oauthAccount: { accountUuid: 'named' }, primaryApiKey: 'SYNTHETIC-NAMED', customApiKeyResponses: { approved: ['named'] },
      theme: 'dark', cachedDynamicConfigs: { keep: true }, unknownFutureIdentity: { owner: 'named' }, mcpServers: { old: {} },
      projects: {
        '/existing': { mcpServers: { old: {} }, enabledMcpServers: ['old'], disabledMcpServers: ['old-blocked'],
          hasTrustDialogAccepted: false, allowedTools: ['named-tool'], enableAllProjectMcpServers: false,
          enabledMcpjsonServers: ['legacy-named'], disabledMcpjsonServers: ['legacy-private'], unknownPrivate: { keep: true } },
        '/removed-mcp': { mcpServers: { obsolete: {} }, enabledMcpServers: ['obsolete'], disabledMcpServers: ['old'],
          hasTrustDialogAccepted: true, unknown: 42 },
        '/private-only': { hasTrustDialogAccepted: false },
      },
    })
    writeFileSync(join(f.account, '.credentials.json'), 'SYNTHETIC-PRIVATE-CREDENTIAL')
    const source = snapshot(f.native)
    f.sync()
    expect(read(f.current)).toEqual({
      oauthAccount: { accountUuid: 'named' }, primaryApiKey: 'SYNTHETIC-NAMED', customApiKeyResponses: { approved: ['named'] },
      theme: 'dark', cachedDynamicConfigs: { keep: true }, unknownFutureIdentity: { owner: 'named' },
      mcpServers: { global: { command: 'global-mcp' } },
      projects: {
        '/existing': { mcpServers: { project: { command: 'project-mcp' } }, enabledMcpServers: ['project'], disabledMcpServers: ['blocked'],
          hasTrustDialogAccepted: false, allowedTools: ['named-tool'], enableAllProjectMcpServers: false,
          enabledMcpjsonServers: ['legacy-named'], disabledMcpjsonServers: ['legacy-private'], unknownPrivate: { keep: true } },
        '/removed-mcp': { hasTrustDialogAccepted: true, unknown: 42 },
        '/private-only': { hasTrustDialogAccepted: false }, '/new-mcp': { mcpServers: {}, disabledMcpServers: [] },
      },
    })
    expect(snapshot(f.native)).toEqual(source)
    expect(readFileSync(join(f.account, '.credentials.json'), 'utf8')).toBe('SYNTHETIC-PRIVATE-CREDENTIAL')
    expect(readdirSync(f.account).sort()).toEqual(['.claude.json', '.credentials.json'])
    if (process.platform !== 'win32') expect(lstatSync(f.current).mode & 0o777).toBe(0o600)
  })

  test.each(['present', 'missing'])('removing all default MCP clears only named MCP when the source is %s', source => {
    const f = fixture()
    if (source === 'present') put(f.native, { theme: 'default', projects: { '/project': { hasTrustDialogAccepted: true } } })
    put(f.current, { mcpServers: { stale: {} }, theme: 'named', oauthAccount: { accountUuid: 'named' }, unknown: ['keep'],
      projects: { '/project': { mcpServers: { stale: {} }, enabledMcpServers: ['stale'], disabledMcpServers: [],
        hasTrustDialogAccepted: false, enabledMcpjsonServers: ['legacy-named'] }, '/private': { custom: 42 } } })
    f.sync()
    expect(read(f.current)).toEqual({ theme: 'named', oauthAccount: { accountUuid: 'named' }, unknown: ['keep'],
      projects: { '/project': { hasTrustDialogAccepted: false, enabledMcpjsonServers: ['legacy-named'] }, '/private': { custom: 42 } } })
    expect(existsSync(f.native)).toBe(source === 'present')
    expect(readdirSync(f.account)).toEqual(['.claude.json'])
  })

  test.each(['both-missing', 'source-only-no-mcp', 'target-only-no-mcp', 'both-no-mcp'])('does not create files or locks for %s', mode => {
    const f = fixture()
    if (mode === 'source-only-no-mcp' || mode === 'both-no-mcp') put(f.native, { theme: 'default', oauthAccount: { accountUuid: 'default' } })
    if (mode === 'target-only-no-mcp' || mode === 'both-no-mcp') put(f.current, { theme: 'named', unknown: 'keep' })
    const before = snapshot(f.root)
    expectNoWrites(f.sync)
    expect(snapshot(f.root)).toEqual(before)
  })

  test('creates a missing selected target with MCP only and no imported identity, trust or approvals', () => {
    const f = fixture()
    put(f.native, { oauthAccount: { accountUuid: 'default' }, unknownDefault: true, mcpServers: { top: {} },
      projects: { '/project': { enabledMcpServers: ['top'], hasTrustDialogAccepted: true, enabledMcpjsonServers: ['old'] } } })
    f.sync()
    expect(read(f.current)).toEqual({ mcpServers: { top: {} }, projects: { '/project': { enabledMcpServers: ['top'] } } })
    expect(readdirSync(f.account)).toEqual(['.claude.json'])
  })

  test('synchronizes the selected legacy file and leaves an inactive malformed current file untouched', () => {
    const f = fixture(), globalLegacy = join(f.shared, '.config.json')
    put(globalLegacy, { mcpServers: { selected: {} }, theme: 'global' }); put(f.native, { mcpServers: { inactive: {} } })
    put(f.legacy, { mcpServers: { old: {} }, oauthAccount: { accountUuid: 'legacy-login' }, theme: 'named' })
    writeFileSync(f.current, '{inactive-malformed')
    const before = snapshot(f.current)
    syncClaudeAccountConfigState(f.account, f.shared, globalLegacy)
    expect(read(f.legacy)).toEqual({ mcpServers: { selected: {} }, oauthAccount: { accountUuid: 'legacy-login' }, theme: 'named' })
    expect(snapshot(f.current)).toEqual(before)
  })

  test('does not create an inactive current file when only the selected legacy state exists', () => {
    const f = fixture()
    put(f.native, { mcpServers: { global: {} } }); put(f.legacy, { oauthAccount: { accountUuid: 'legacy-login' } })
    f.sync()
    expect(read(f.legacy)).toEqual({ mcpServers: { global: {} }, oauthAccount: { accountUuid: 'legacy-login' } })
    expect(readdirSync(f.account)).toEqual(['.config.json'])
  })

  test('an empty legacy file is inactive when current exists, so only current MCP changes', () => {
    const f = fixture()
    put(f.native, { mcpServers: { global: {} }, theme: 'default' })
    writeFileSync(f.legacy, '')
    put(f.current, { mcpServers: { old: {} }, theme: 'named', oauthAccount: { accountUuid: 'current-login' } })
    const inactive = snapshot(f.legacy)
    f.sync()
    expect(read(f.current)).toEqual({ mcpServers: { global: {} }, theme: 'named', oauthAccount: { accountUuid: 'current-login' } })
    expect(snapshot(f.legacy)).toEqual(inactive)
    expect(readdirSync(f.account).sort()).toEqual(['.claude.json', '.config.json'])
  })

  for (const sameMcp of [true, false]) {
    test.each(['file', 'empty-directory', 'nonempty-directory', 'symlink'])(`${sameMcp ? 'equal' : 'changed'} MCP ignores existing source and target %s locks`, kind => {
      const f = fixture()
      put(f.native, { mcpServers: { global: {} }, theme: 'default' })
      put(f.current, { mcpServers: sameMcp ? { global: {} } : { old: {} }, theme: 'named', oauthAccount: { accountUuid: 'named' } })
      const locks = [`${f.native}.lock`, `${f.current}.lock`], linkedTargets: string[] = []
      for (const [index, path] of locks.entries()) {
        if (kind === 'file') writeFileSync(path, 'native lock file')
        else if (kind === 'symlink') {
          const target = join(f.root, `lock-owner-${index}`)
          mkdirSync(target); writeFileSync(join(target, 'owner'), 'native owner')
          symlinkSync(target, path, dirLink); linkedTargets.push(target)
        } else {
          mkdirSync(path)
          if (kind === 'nonempty-directory') writeFileSync(join(path, 'owner'), 'native owner')
        }
      }
      const before = [...locks, ...linkedTargets].map(snapshot), target = snapshot(f.current)
      const started = performance.now()
      if (sameMcp) expectNoWrites(f.sync)
      else {
        const spies = [spyOn(fs, 'mkdirSync'), spyOn(fs, 'rmdirSync'), spyOn(fs, 'rmSync'), spyOn(fs, 'utimesSync')]
        try {
          expect(f.sync()).toBeUndefined()
          for (const spy of spies) expect(spy).not.toHaveBeenCalled()
        } finally { for (const spy of spies) spy.mockRestore() }
      }
      expect(performance.now() - started).toBeLessThan(1000)
      expect([...locks, ...linkedTargets].map(snapshot)).toEqual(before)
      expect(read(f.current)).toEqual({ mcpServers: { global: {} }, theme: 'named', oauthAccount: { accountUuid: 'named' } })
      if (sameMcp) expect(snapshot(f.current)).toEqual(target)
      expect(readdirSync(f.account).sort()).toEqual(['.claude.json', '.claude.json.lock'])
    })
  }

  test.each(['source', 'current', 'legacy'])('rejects malformed selected %s JSON without touching either native file', selected => {
    const f = fixture()
    put(f.native, { mcpServers: { global: {} } }); put(f.current, { mcpServers: { named: {} } })
    writeFileSync(selected === 'source' ? f.native : selected === 'legacy' ? f.legacy : f.current, '{invalid')
    const before = snapshot(f.root)
    expect(() => f.sync()).toThrow('JSON 无效')
    expect(snapshot(f.root)).toEqual(before)
  })

  test.each(['null', '[]', 'true', '42'])('rejects non-object native state %s before any write', text => {
    const f = fixture()
    writeFileSync(f.native, text); put(f.current, { mcpServers: { named: {} } })
    const before = snapshot(f.root)
    expect(() => f.sync()).toThrow('必须为 JSON 对象')
    expect(snapshot(f.root)).toEqual(before)
  })

  test.each(['source', 'target'])('rejects malformed %s projects without changing account state', side => {
    const f = fixture()
    put(f.native, { mcpServers: { global: {} } }); put(f.current, { mcpServers: { named: {} } })
    put(side === 'source' ? f.native : f.current, { projects: [] })
    const before = snapshot(f.root)
    expect(() => f.sync()).toThrow('projects 必须为 JSON 对象')
    expect(snapshot(f.root)).toEqual(before)
  })

  test('preserves unknown non-object private projects but refuses to overwrite them with MCP', () => {
    const f = fixture()
    put(f.native, { mcpServers: { global: {} } })
    put(f.current, { mcpServers: { old: {} }, projects: { '/unknown': 'future-native-value' } })
    f.sync()
    expect(read(f.current)).toEqual({ mcpServers: { global: {} }, projects: { '/unknown': 'future-native-value' } })
    put(f.native, { mcpServers: { global: {} }, projects: { '/unknown': { enabledMcpServers: ['global'] } } })
    const before = snapshot(f.current)
    expect(() => f.sync()).toThrow('项目必须为 JSON 对象')
    expect(snapshot(f.current)).toEqual(before)
  })

  test.each(['account', 'shared', 'source'])('rejects relative %s paths before any write', relative => {
    const f = fixture(), before = snapshot(f.root)
    expect(() => syncClaudeAccountConfigState(relative === 'account' ? 'relative' : f.account,
      relative === 'shared' ? 'relative' : f.shared, relative === 'source' ? 'relative' : f.native)).toThrow('绝对路径')
    expect(snapshot(f.root)).toEqual(before)
  })

  test('rejects a linked account root before any write', () => {
    const f = fixture(), alias = join(f.root, 'account-alias')
    put(f.native, { mcpServers: { global: {} } }); symlinkSync(f.account, alias, dirLink)
    const before = snapshot(f.root)
    expect(() => syncClaudeAccountConfigState(alias, f.shared, f.native)).toThrow('根目录必须为独立目录')
    expect(snapshot(f.root)).toEqual(before)
  })

  test('rejects shared ancestor overlap through an alias', () => {
    const f = fixture(), alias = join(f.root, 'shared-alias')
    symlinkSync(join(f.root, '.claude-accounts'), alias, dirLink)
    const before = snapshot(f.root)
    expect(() => syncClaudeAccountConfigState(f.account, alias, f.native)).toThrow('目录重叠')
    expect(snapshot(f.root)).toEqual(before)
  })

  test.each(['direct', 'symlink'])('rejects a global state inside the account via %s path', kind => {
    const f = fixture()
    put(f.current, { mcpServers: { named: {} } })
    if (kind === 'symlink') symlinkSync(f.current, f.native)
    const before = snapshot(f.root)
    expect(() => syncClaudeAccountConfigState(f.account, f.shared, kind === 'direct' ? f.current : f.native)).toThrow('不能位于账号目录内')
    expect(snapshot(f.root)).toEqual(before)
  })

  test.each(['symbolic', 'hard'])('rejects a selected account state %s link to the global state even if MCP matches', kind => {
    const f = fixture()
    put(f.native, { mcpServers: { global: {} }, oauthAccount: { accountUuid: 'default' } })
    if (kind === 'symbolic') symlinkSync(f.native, f.current)
    else linkSync(f.native, f.current)
    const before = snapshot(f.root)
    expect(() => f.sync()).toThrow(kind === 'symbolic' ? '独立文件' : '同一文件')
    expect(snapshot(f.root)).toEqual(before)
  })

  test('reads a linked global state without altering it or its link', () => {
    const f = fixture(), actual = join(f.root, 'global-state.json')
    put(actual, { mcpServers: { linked: {} }, oauthAccount: { accountUuid: 'default' } }); symlinkSync(actual, f.native)
    put(f.current, { oauthAccount: { accountUuid: 'named' } })
    const source = snapshot(actual), link = snapshot(f.native)
    f.sync()
    expect(read(f.current)).toEqual({ mcpServers: { linked: {} }, oauthAccount: { accountUuid: 'named' } })
    expect(snapshot(actual)).toEqual(source)
    expect(snapshot(f.native)).toEqual(link)
    expect(readdirSync(f.account)).toEqual(['.claude.json'])
    expect(existsSync(`${actual}.lock`)).toBe(false)
    expect(existsSync(`${f.native}.lock`)).toBe(false)
  })

  test('re-reads and re-merges after an external target write, preserving its latest identity and trust', () => {
    const f = fixture()
    put(f.native, { mcpServers: { desired: {} }, projects: { '/project': { enabledMcpServers: ['desired'] } } })
    put(f.current, { mcpServers: { old: {} }, oauthAccount: { accountUuid: 'before' }, theme: 'old' })
    const originalWrite = fs.writeFileSync
    let attempts = 0
    const write = spyOn(fs, 'writeFileSync').mockImplementation((path, contents, options) => {
      originalWrite(path, contents, options)
      if (String(path).startsWith(f.current + '.') && String(path).endsWith('.tmp') && ++attempts === 1) {
        originalWrite(f.current, JSON.stringify({ mcpServers: { external: {} }, oauthAccount: { accountUuid: 'latest' },
          theme: 'latest', futureIdentity: { keep: true }, projects: { '/project': { hasTrustDialogAccepted: true, unknown: 'latest' } } }))
      }
    })
    try { f.sync() }
    finally { write.mockRestore() }
    expect(attempts).toBe(2)
    expect(read(f.current)).toEqual({ mcpServers: { desired: {} }, oauthAccount: { accountUuid: 'latest' },
      theme: 'latest', futureIdentity: { keep: true },
      projects: { '/project': { enabledMcpServers: ['desired'], hasTrustDialogAccepted: true, unknown: 'latest' } } })
    expect(readdirSync(f.account)).toEqual(['.claude.json'])
  })

  test('three consecutive external target writes fail explicitly without overwriting the latest state or leaving temporary files', () => {
    const f = fixture()
    put(f.native, { mcpServers: { desired: {} } }); put(f.current, { mcpServers: { old: {} }, oauthAccount: { accountUuid: 'before' } })
    const originalWrite = fs.writeFileSync
    let attempts = 0
    const write = spyOn(fs, 'writeFileSync').mockImplementation((path, contents, options) => {
      originalWrite(path, contents, options)
      if (String(path).startsWith(f.current + '.') && String(path).endsWith('.tmp')) {
        attempts++
        originalWrite(f.current, JSON.stringify({ mcpServers: { external: { revision: attempts } },
          oauthAccount: { accountUuid: `latest-${attempts}` }, unknown: 'preserve' }))
      }
    })
    const rename = spyOn(fs, 'renameSync')
    try {
      expect(() => f.sync()).toThrow('持续变化，未覆盖')
      expect(rename).not.toHaveBeenCalled()
    } finally { rename.mockRestore(); write.mockRestore() }
    expect(attempts).toBe(3)
    expect(read(f.current)).toEqual({ mcpServers: { external: { revision: 3 } }, oauthAccount: { accountUuid: 'latest-3' }, unknown: 'preserve' })
    expect(readdirSync(f.account)).toEqual(['.claude.json'])
    expect(readdirSync(f.root).sort()).toEqual(['.claude', '.claude-accounts', '.claude.json'])
  })
})
