import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findReclaude, parseReclaudeStatus, readReclaudeStatus, reclaudePath, selectReclaudeBinding } from './reclaude'

const root = mkdtempSync(join(tmpdir(), 'lodestar-reclaude-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Shape of `reclaude status --check --json` (schema_version 1), with invented identities. */
function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const first = { device_id: 101, org_id: 7, org_name: 'team-a', email: 'a@example.invalid' }
  const second = { device_id: 202, org_id: 9, org_name: 'team-b', email: 'b@example.invalid' }
  return {
    schema_version: 1,
    global: { version: 'v1.8.6', data_dir: '/home/u/.rec' },
    claude: { bindings: [first, second], current: first, login: { state: 'valid' }, cli: { state: 'present', path: '/usr/local/bin/claude' }, ...overrides },
  }
}

describe('parseReclaudeStatus', () => {
  test('maps bindings to their config directories', () => {
    const parsed = parseReclaudeStatus(status())
    expect(parsed.loginState).toBe('valid')
    expect(parsed.bindings).toEqual([
      { orgId: '7', deviceId: '101', configDir: join('/home/u/.rec', 'claude', 'accounts', '101', 'config') },
      { orgId: '9', deviceId: '202', configDir: join('/home/u/.rec', 'claude', 'accounts', '202', 'config') },
    ])
    expect(parsed.current).toBe(parsed.bindings[0]!)
  })

  test('a machine without bindings parses with no current organisation', () => {
    const parsed = parseReclaudeStatus(status({ bindings: [], current: undefined, login: { state: 'missing' } }))
    expect(parsed).toEqual({ loginState: 'missing', bindings: [], current: null })
  })

  test('reports the missing field instead of guessing a directory', () => {
    expect(() => parseReclaudeStatus({ claude: {} })).toThrow('reclaude status 输出缺少 global.data_dir')
    expect(() => parseReclaudeStatus({ global: { data_dir: '/d' } })).toThrow('reclaude status 输出缺少 claude')
    expect(() => parseReclaudeStatus({ global: { data_dir: '/d' }, claude: { bindings: [] } })).toThrow('claude.login.state')
    expect(() => parseReclaudeStatus({ global: { data_dir: '/d' }, claude: { login: { state: 'valid' } } })).toThrow('claude.bindings')
    expect(() => parseReclaudeStatus('nope')).toThrow('JSON 对象')
  })

  test('ignores a binding whose identifiers could escape the accounts directory', () => {
    const parsed = parseReclaudeStatus(status({ bindings: [{ device_id: '../../etc', org_id: 7 }], current: null }))
    expect(parsed.bindings).toEqual([])
  })
})

describe('selectReclaudeBinding', () => {
  const parsed = parseReclaudeStatus(status())

  test('follows the current organisation unless one is configured', () => {
    expect(selectReclaudeBinding(parsed, undefined).orgId).toBe('7')
    expect(selectReclaudeBinding(parsed, '9').deviceId).toBe('202')
  })

  test('explains what to run when the login or the binding is missing', () => {
    expect(() => selectReclaudeBinding(parseReclaudeStatus(status({ login: { state: 'expired' } })), undefined))
      .toThrow('reclaude 未登录或登录已失效；请在运行 Lodestar 的本机执行 reclaude login')
    expect(() => selectReclaudeBinding(parsed, '42')).toThrow('reclaude 尚未绑定组织 42；请在本机执行 reclaude org bind 42')
    expect(() => selectReclaudeBinding(parseReclaudeStatus(status({ current: null })), undefined))
      .toThrow('reclaude 没有当前组织')
  })

  test('a login that could not be checked is not reported as a lost login', () => {
    const unchecked = parseReclaudeStatus(status({ login: { state: 'unavailable', detail: 'Online check timed out' } }))
    expect(unchecked.loginDetail).toBe('Online check timed out')
    const failure = (() => { try { selectReclaudeBinding(unchecked, undefined); return '' } catch (error) { return (error as Error).message } })()
    expect(failure).toBe('reclaude 暂时无法确认登录状态（Online check timed out）；请检查本机网络与 reclaude 后台服务，稍后自动重试')
    expect(failure).not.toContain('未登录')
  })
})

test('reclaudePath appends only the missing system directories', () => {
  expect(reclaudePath('/usr/bin:/bin', 'darwin')).toBe('/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin')
  expect(reclaudePath('/opt/x:/usr/sbin', 'linux')).toBe('/opt/x:/usr/sbin:/usr/local/bin:/usr/bin:/bin:/sbin')
  expect(reclaudePath(undefined, 'darwin')).toBe('/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
  expect(reclaudePath('C:\\Windows', 'win32')).toBe('C:\\Windows')
})

describe('findReclaude', () => {
  const exists = (...paths: string[]) => (path: string) => paths.includes(path)

  test('a configured path must exist', () => {
    expect(findReclaude('/opt/reclaude', { exists: exists('/opt/reclaude') })).toBe('/opt/reclaude')
    expect(findReclaude('~/bin/reclaude', { homeDir: '/home/u', exists: exists('/home/u/bin/reclaude') })).toBe('/home/u/bin/reclaude')
    expect(() => findReclaude('/opt/reclaude', { exists: exists() })).toThrow('[token_source.reclaude].bin 指向的文件不存在: /opt/reclaude')
  })

  test('searches PATH first, then the default install directory', () => {
    const lookup = { pathEnv: '/a:/b', homeDir: '/home/u', platform: 'linux' as const }
    expect(findReclaude(undefined, { ...lookup, exists: exists('/b/reclaude', '/home/u/.local/bin/reclaude') })).toBe('/b/reclaude')
    expect(findReclaude(undefined, { ...lookup, exists: exists('/home/u/.local/bin/reclaude') })).toBe('/home/u/.local/bin/reclaude')
    expect(findReclaude(undefined, { ...lookup, exists: exists() })).toBeNull()
    expect(findReclaude('  ', { ...lookup, exists: exists('/a/reclaude') })).toBe('/a/reclaude')
  })

  test('uses the Windows executable names and separator', () => {
    const found = findReclaude(undefined, { pathEnv: 'C:\\x;C:\\y', homeDir: 'C:\\u', platform: 'win32', exists: path => path.endsWith('reclaude.exe') && path.includes('y') })
    expect(found).toBe(join('C:\\y', 'reclaude.exe'))
  })
})

describe.skipIf(process.platform === 'win32')('readReclaudeStatus', () => {
  function fake(name: string, body: string): string {
    const path = join(root, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  test('runs the read-only status query and parses its JSON', async () => {
    const bin = fake('ok', `[ "$*" = "status --check --json" ] || exit 9\ncat <<'JSON'\n${JSON.stringify(status())}\nJSON`)
    expect((await readReclaudeStatus(bin, { PATH: '/usr/bin:/bin' })).current?.orgId).toBe('7')
  })

  test('a failure reports only the launcher-prefixed lines', async () => {
    const bin = fake('fail', 'echo "token=secret-value /private/path" >&2\necho "reclaude: 暂不可用: gateway unreachable" >&2\nexit 1')
    await expect(readReclaudeStatus(bin, { PATH: '/usr/bin:/bin' })).rejects.toThrow('reclaude status 查询失败：reclaude: 暂不可用: gateway unreachable')
    const silent = fake('silent', 'echo "token=secret-value" >&2\nexit 3')
    await expect(readReclaudeStatus(silent, { PATH: '/usr/bin:/bin' })).rejects.toThrow(/^reclaude status 查询失败：退出码 3$/)
  })

  test('a non-zero exit that still printed the status is read from the status', async () => {
    // What reclaude does when its online check times out: exit 1, full status on stdout.
    const body = JSON.stringify(status({ login: { state: 'unavailable', detail: 'Online check timed out' } }))
    const bin = fake('degraded', `cat <<'JSON'\n${body}\nJSON\nexit 1`)
    const parsed = await readReclaudeStatus(bin, { PATH: '/usr/bin:/bin' })
    expect(parsed.loginState).toBe('unavailable')
    expect(parsed.current?.orgId).toBe('7')
  })

  test('rejects output that is not JSON and a missing command', async () => {
    await expect(readReclaudeStatus(fake('garbage', 'echo "not json"'), { PATH: '/usr/bin:/bin' })).rejects.toThrow('reclaude status 输出不是有效 JSON')
    await expect(readReclaudeStatus(join(root, 'absent'), { PATH: '/usr/bin:/bin' })).rejects.toThrow('reclaude status 查询失败：命令不存在')
  })
})
