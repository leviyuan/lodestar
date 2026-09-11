import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAccounts, reserveCodexLogin, isCodexLoginPending } from './codex-accounts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-account-test-')); roots.push(root)
  const home = join(root, 'native'); mkdirSync(home)
  writeFileSync(join(home, 'config.toml'), 'model = "test-model"\n')
  writeFileSync(join(home, 'auth.json'), '{"native":"must-not-change"}')
  return new CodexAccounts(home, join(root, 'accounts'), join(root, 'accounts.json'))
}

describe('Codex native and named accounts', () => {
  test('named account aliases cannot redirect credential writes into the native account', () => {
    const accounts = fixture()
    const named = accounts.ensure('alias')
    mkdirSync(accounts.root)
    symlinkSync(accounts.defaultHome, accounts.home(named.id), 'dir')
    expect(() => accounts.prepareHome(named.id)).toThrow('不能是软链接')
    unlinkSync(accounts.home(named.id))
    const home = accounts.prepareHome(named.id)
    symlinkSync(join(accounts.defaultHome, 'auth.json'), join(home, 'auth.json'))
    expect(() => accounts.prepareHome(named.id)).toThrow('必须为独立文件')
    expect(readFileSync(join(accounts.defaultHome, 'auth.json'), 'utf8')).toBe('{"native":"must-not-change"}')
  })
  test('credential writes exclude other launches until their exact login lease is released', () => {
    const accounts = fixture()
    const account = accounts.ensure('login lock')
    const release = reserveCodexLogin(account.id)
    try {
      expect(isCodexLoginPending(account.id)).toBe(true)
      expect(() => reserveCodexLogin(account.id)).toThrow('已有登录任务')
      expect(() => accounts.env(account.id, {})).toThrow('正在登录')
      expect(accounts.env(account.id, {}, true, true).CODEX_HOME).toBe(accounts.home(account.id))
      expect(accounts.env('default', {}).CODEX_HOME).toBe(accounts.defaultHome)
    } finally { release() }
    expect(isCodexLoginPending(account.id)).toBe(false)
    expect(accounts.env(account.id, {}).CODEX_HOME).toBe(accounts.home(account.id))
  })
  test('default is the native home; named logins never copy or replace native auth', () => {
    const accounts = fixture()
    expect(accounts.find().id).toBe('default')
    expect(accounts.find('默认').id).toBe('default')
    const named = accounts.ensure('工作 订阅')
    const home = accounts.prepareHome(named.id)
    expect(home).not.toBe(accounts.defaultHome)
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
    expect(readFileSync(join(accounts.defaultHome, 'auth.json'), 'utf8')).toBe('{"native":"must-not-change"}')
    expect(realpathSync(join(home, 'sessions'))).toBe(realpathSync(join(accounts.defaultHome, 'sessions')))
    expect(realpathSync(join(home, 'thread-writer-locks'))).toBe(realpathSync(join(accounts.defaultHome, 'thread-writer-locks')))
    expect(realpathSync(join(home, 'config.toml'))).toBe(join(accounts.defaultHome, 'config.toml'))
    expect(existsSync(join(home, 'models_cache.json'))).toBe(false)
    if (process.platform !== 'win32') expect(statSync(home).mode & 0o777).toBe(0o700)
  })

  test('name lookup is normalized and per-group selections survive reconstruction', () => {
    const accounts = fixture()
    const a = accounts.ensure('Work')
    expect(accounts.ensure('work').id).toBe(a.id)
    expect(accounts.find(' WORK ').id).toBe(a.id)
    accounts.select('one', a.id)
    const reloaded = new CodexAccounts(accounts.defaultHome, accounts.root, accounts.stateFile)
    expect(reloaded.selected('one')).toBe(a.id)
    expect(reloaded.selected('two')).toBe('default')
    expect(reloaded.selected('constructor')).toBe('default')
    reloaded.select('__proto__', a.id)
    expect(reloaded.selected('__proto__')).toBe(a.id)
    expect(reloaded.home('default')).toBe(accounts.defaultHome)
    expect(() => reloaded.select('one', 'missing')).toThrow('不存在')
    expect(reloaded.selected('one')).toBe(a.id)
    for (const name of ['../escape', 'a\\b', 'a\nb', '..']) expect(() => accounts.ensure(name)).toThrow()
  })

  test('conflicting shared files and corrupt state fail visibly', () => {
    const accounts = fixture()
    const named = accounts.ensure('work')
    const home = accounts.prepareHome(named.id)
    unlinkSync(join(home, 'config.toml'))
    writeFileSync(join(home, 'config.toml'), 'diverged = true')
    expect(() => accounts.prepareHome(named.id)).toThrow('已被替换')
    writeFileSync(accounts.stateFile, '{"version":9}')
    expect(() => accounts.list()).toThrow('格式无效')
  })

  test('named launches require their own ChatGPT file credentials and shared database directory', () => {
    const accounts = fixture()
    const named = accounts.ensure('work')
    const env = accounts.env(named.id, { CODEX_HOME: '/foreign', CODEX_ACCESS_TOKEN: 'foreign-token',
      OPENAI_API_KEY: 'foreign-key', OPENAI_IDENTITY_TOKEN_FILE: '/foreign-token', PATH: '/bin' })
    expect(env.CODEX_HOME).toBe(accounts.home(named.id))
    expect(env.CODEX_SQLITE_HOME).toBe(process.env.CODEX_SQLITE_HOME || accounts.defaultHome)
    expect(env.PATH).toBe('/bin')
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.OPENAI_IDENTITY_TOKEN_FILE).toBeUndefined()
    expect(accounts.env(named.id, { CODEX_SQLITE_HOME: '/shared/custom-state' }).CODEX_SQLITE_HOME).toBe('/shared/custom-state')
    expect(accounts.cliArgs(named.id)).toContain('cli_auth_credentials_store="file"')
    expect(accounts.cliArgs('default')).toEqual([])
    expect(accounts.env('default', { CODEX_ACCESS_TOKEN: 'native-token' }).CODEX_ACCESS_TOKEN).toBe('native-token')
  })

  test('quota deduplication uses stable user/workspace identity, never a token or remark', () => {
    const accounts = fixture()
    const named = accounts.ensure('same login')
    const home = accounts.prepareHome(named.id)
    const token = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`
    const auth = { tokens: { account_id: 'workspace-test', id_token: token('user-test'), access_token: 'secret-one' } }
    writeFileSync(join(accounts.defaultHome, 'auth.json'), JSON.stringify(auth))
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { ...auth.tokens, access_token: 'secret-two' } }))
    expect(accounts.fingerprint('default')).toBe(accounts.fingerprint(named.id))
    expect(accounts.fingerprint('default')).not.toContain('secret')
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { ...auth.tokens, id_token: token('different-user') } }))
    expect(accounts.fingerprint('default')).not.toBe(accounts.fingerprint(named.id))
  })
})
