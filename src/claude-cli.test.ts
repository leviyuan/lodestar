import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAccounts } from './claude-accounts'

const temporary: string[] = []
let bundleRoot: string
let bundle: string
const managedKeys = ['LODESTAR_AGENT_ROLE', 'LODESTAR_AGENT_URL', 'LODESTAR_AGENT_CAPABILITY', 'LODESTAR_AGENT_SESSION', 'DSH_LODESTAR_AGENT_CONTEXT']

beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'lodestar-claude-cli-bundle-'))
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, 'claude-cli.ts')], outdir: bundleRoot, target: 'node' })
  if (!built.success) throw new Error(built.logs.join('\n'))
  bundle = join(bundleRoot, 'claude-cli.js')
  writeFileSync(join(bundleRoot, 'package.json'), '{"type":"module"}\n')
})
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
afterAll(() => { if (bundleRoot) rmSync(bundleRoot, { recursive: true, force: true }) })

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-claude-cli-test-'))
  temporary.push(root)
  return root
}

/** Only synthetic native executables are reachable from these standalone terminal fixtures. */
function fixture(install = true) {
  const root = scratch(), data = join(root, 'data'), runtime = join(root, 'runtime')
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', LODESTAR_DATA_DIR: data,
    LODESTAR_CONFIG: join(root, 'missing-config.toml'), HOME: join(root, 'home'), USERPROFILE: join(root, 'home') }
  for (const key of managedKeys) delete env[key]
  delete env.LODESTAR_TEST_AGENT_RUNTIME_ROOT
  delete env.CLAUDE_CONFIG_DIR
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  if (install) {
    const bin = join(runtime, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(data, 'agent-runtimes', 'claude'), { recursive: true })
    writeFileSync(join(data, 'agent-runtimes', 'claude', 'current.json'), JSON.stringify({ directory: runtime, checkedAt: 1 }))
    const script = `
const args = process.argv.slice(2)
if (args[0] === '--self-signal') process.kill(process.pid, args[1])
else {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', data => { input += data })
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ args, input, cwd: process.cwd(), home: process.env.HOME,
      configDir: process.env.CLAUDE_CONFIG_DIR ?? null, secureDir: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
      sentinel: process.env.CLI_TEST_SENTINEL }))
    process.stderr.write('native stderr\\n')
    process.exitCode = args[0] === '--exit' ? Number(args[1]) : 0
  })
}
`
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'fake.cjs'), script)
      writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0fake.cjs" %*\r\n')
    } else {
      writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node\n${script}`)
      chmodSync(join(bin, 'claude'), 0o700)
    }
  }
  return { root, data, runtime, env, run(args: string[], input = '', executable = bundle) {
    return spawnSync('node', [executable, ...args], { cwd: root, env, input, encoding: 'utf8', timeout: 10_000 })
  } }
}

test('first native login prepares global configuration without credentials or account enrollment', () => {
  const root = scratch(), stateFile = join(root, 'accounts.json')
  const manager = new ClaudeAccounts({ home: root, stateFile, env: {} })
  const original = { HOME: homedir(), KEEP: 'unchanged', CLAUDE_CONFIG_DIR: '/other', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/other' }
  const env = manager.nativeCliEnv('工作号', original)
  expect(env).toEqual({ ...original, CLAUDE_CONFIG_DIR: join(root, '.claude-accounts', '工作号'),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: join(root, '.claude-accounts', '工作号') })
  expect(original.CLAUDE_CONFIG_DIR).toBe('/other')
  expect(realpathSync(join(root, '.claude-accounts', '工作号', 'skills'))).toBe(realpathSync(join(root, '.claude', 'skills')))
  expect(existsSync(join(root, '.claude-accounts', '工作号', '.credentials.json'))).toBe(false)
  expect(existsSync(stateFile)).toBe(false)
  for (const name of ['../escape', 'a/b', 'a\\b', ' trailing ', 'CON']) {
    expect(() => manager.nativeCliEnv(name, original)).toThrow('备注名')
  }
})

test('registered case and Unicode aliases use the original path without changing history or registry', async () => {
  const root = scratch(), stateFile = join(root, 'accounts.json')
  const manager = new ClaudeAccounts({ home: root, stateFile, env: {} })
  const profile = join(root, '.claude-accounts', 'Café')
  mkdirSync(profile, { recursive: true })
  await manager.enroll('Café', async () => ({ email: 'synthetic@example.test', organization: 'test', subscriptionType: 'max', apiProvider: 'firstParty' }))
  const history = join(manager.sharedConfigDir(), 'plans', 'keep.txt')
  writeFileSync(history, 'native history')
  const before = readFileSync(stateFile, 'utf8')
  expect(manager.nativeCliEnv('CAFE\u0301', {}).CLAUDE_CONFIG_DIR).toBe(profile)
  expect(readFileSync(stateFile, 'utf8')).toBe(before)
  expect(readFileSync(history, 'utf8')).toBe('native history')
})

test('existing terminal accounts use global configuration and history while leaving the registry untouched', () => {
  const root = scratch(), stateFile = join(root, 'accounts.json')
  const manager = new ClaudeAccounts({ home: root, stateFile, env: {} })
  const profile = join(root, '.claude-accounts', '工作号'), skill = join(root, '.claude', 'skills', 'global-helper')
  mkdirSync(join(profile, 'projects'), { recursive: true })
  writeFileSync(join(profile, 'projects', 'keep.txt'), 'private history')
  mkdirSync(skill, { recursive: true }); writeFileSync(join(skill, 'SKILL.md'), 'global skill')
  mkdirSync(join(root, '.claude', 'projects'), { recursive: true })
  writeFileSync(join(root, '.claude', 'projects', 'shared.txt'), 'global history')
  const env = manager.nativeCliEnv('工作号', {})
  expect(env.CLAUDE_CONFIG_DIR).toBe(profile)
  expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(profile)
  expect(readFileSync(join(profile, 'skills', 'global-helper', 'SKILL.md'), 'utf8')).toBe('global skill')
  expect(existsSync(join(profile, 'projects', 'keep.txt'))).toBe(false)
  expect(readFileSync(join(profile, 'projects', 'shared.txt'), 'utf8')).toBe('global history')
  expect(existsSync(stateFile)).toBe(false)
})

test('native default keeps an unset or exact config and keychain namespace while preserving HOME', () => {
  const root = scratch(), stateFile = join(root, 'accounts.json'), home = homedir()
  const implicit = new ClaudeAccounts({ home: root, stateFile, env: {} })
  expect(implicit.nativeCliEnv('default', { HOME: home, CLAUDE_CONFIG_DIR: '/wrong', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/wrong' }))
    .toEqual({ HOME: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' })
  const originalPath = join(root, 'native') + '/'
  const explicit = new ClaudeAccounts({ home: root, stateFile, env: { CLAUDE_CONFIG_DIR: originalPath } })
  expect(explicit.nativeCliEnv('默认', { HOME: home })).toEqual({ HOME: home,
    CLAUDE_CONFIG_DIR: originalPath, CLAUDE_SECURESTORAGE_CONFIG_DIR: originalPath })
  expect(readdirSync(root)).toEqual([])
})

test('compiled terminal CLI passes native arguments and stdio exactly without needing daemon config', () => {
  const f = fixture()
  f.env.CLI_TEST_SENTINEL = 'keep native environment'
  const args = ['auth', 'login', '--example', 'spaces "quotes" $(literal) & ;']
  const result = f.run(['未登录的工作号', ...args], 'native input\n')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toBe('native stderr\n')
  expect(JSON.parse(result.stdout)).toEqual({ args, input: 'native input\n', cwd: realpathSync(f.root), home: f.env.HOME,
    configDir: join(f.env.HOME!, '.claude-accounts', '未登录的工作号'),
    secureDir: join(f.env.HOME!, '.claude-accounts', '未登录的工作号'), sentinel: 'keep native environment' })
  expect(existsSync(join(f.data, 'claude-accounts.json'))).toBe(false)
  expect(existsSync(f.env.LODESTAR_CONFIG!)).toBe(false)
})

test('compiled CLI preserves default namespace, native exit status and npm-style symlink entry', () => {
  const f = fixture()
  const implicit = f.run(['default'])
  expect(implicit.status, implicit.stderr).toBe(0)
  expect(JSON.parse(implicit.stdout)).toMatchObject({ configDir: null, secureDir: '', home: f.env.HOME })
  f.env.CLAUDE_CONFIG_DIR = join(f.root, 'native') + '/'
  f.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = '/wrong'
  const explicit = f.run(['default', '--exit', '37'])
  expect(explicit.status, explicit.stderr).toBe(37)
  expect(JSON.parse(explicit.stdout)).toMatchObject({ configDir: f.env.CLAUDE_CONFIG_DIR, secureDir: f.env.CLAUDE_CONFIG_DIR })
  if (process.platform !== 'win32') {
    const alias = join(f.root, 'lodestar-claude')
    symlinkSync(bundle, alias)
    const linked = f.run(['default'], '', alias)
    expect(linked.status, linked.stderr).toBe(0)
  }
})

test('help is independent of installation, while missing runtimes and invalid names fail explicitly', () => {
  const f = fixture(false)
  expect(f.run(['--help']).stdout).toContain('lodestar-claude 工作号 auth login')
  expect(f.run(['--help']).status).toBe(0)
  expect(f.run([]).status).toBe(1)
  const missing = f.run(['工作号'])
  expect(missing.status).toBe(1)
  expect(missing.stderr).toContain('claude runtime 未安装')
  expect(missing.stderr).toContain('lodestar-update --agents-only')
  const invalid = f.run(['../escape'])
  expect(invalid.status).toBe(1)
  expect(invalid.stderr).toContain('备注名')
  expect(existsSync(f.data)).toBe(false)
})

test('all inherited managed-context markers reject native launches without clearing the context', () => {
  const f = fixture()
  for (const key of managedKeys) {
    f.env[key] = ''
    const result = f.run(['default'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('受管 Agent 任务须通过 lodestar-agent')
    expect(result.stdout).toBe('')
    delete f.env[key]
  }
})

test.skipIf(process.platform === 'win32')('native spawn errors retain their cause and do not fall back to another executable', () => {
  const f = fixture()
  chmodSync(join(f.runtime, 'node_modules', '.bin', 'claude'), 0o600)
  const result = f.run(['default'])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('EACCES')
  expect(result.stdout).toBe('')
})

test.skipIf(process.platform === 'win32')('native signal termination propagates through the compiled wrapper', () => {
  const f = fixture()
  const result = f.run(['default', '--self-signal', 'SIGTERM'])
  expect(result.signal, result.stderr).toBe('SIGTERM')
  expect(result.status).toBeNull()
})

test('forwarded terminal signals retain the exact native status and remove all handlers', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { EventEmitter } from 'node:events'
    import { mock } from 'bun:test'
    const child = new EventEmitter(), sent = [], terminated = []
    child.kill = signal => { sent.push(signal); child.emit('close', null, signal); return true }
    mock.module('cross-spawn', () => ({ spawn: () => child }))
    mock.module('./src/agent-updates', () => ({ agentBin: () => '/synthetic/claude' }))
    mock.module('./src/claude-accounts', () => ({ claudeAccounts: { nativeCliEnv: () => ({}) } }))
    for (const key of ${JSON.stringify(managedKeys)}) delete process.env[key]
    const before = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, process.listenerCount(signal)]))
    process.kill = (pid, signal) => { terminated.push([pid, signal]); return true }
    const { main } = await import('./src/claude-cli')
    const pending = main(['default'])
    process.emit('SIGTERM')
    await pending
    assert.deepEqual(sent, ['SIGTERM'])
    assert.deepEqual(terminated, [[process.pid, 'SIGTERM']])
    assert.equal(process.exitCode, 143)
    process.exitCode = 0
    for (const [signal, count] of before) assert.equal(process.listenerCount(signal), count)
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
