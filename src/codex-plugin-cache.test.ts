import { afterEach, expect, spyOn, test } from 'bun:test'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { prepareCodexPluginDirectory, migrateCodexPluginCaches } from './codex-plugin-cache.cjs'

const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const first = '11111111-1111-1111-1111-111111111111'
const second = '22222222-2222-2222-2222-222222222222'
const backupName = '.lodestar-plugins-shared-link'
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'codex-plugin-migration-')))
  roots.push(root)
  const defaultHome = join(root, 'native')
  const accountsRoot = join(root, 'accounts')
  const source = join(defaultHome, 'plugins')
  fs.mkdirSync(join(source, 'cache', 'market', 'a', '1.0'), { recursive: true })
  fs.mkdirSync(join(source, 'cache', 'market', 'b', '1.0'), { recursive: true })
  fs.writeFileSync(join(source, 'cache', 'market', 'a', '1.0', 'plugin.json'), 'plugin a')
  fs.writeFileSync(join(source, 'cache', 'market', 'b', '1.0', 'plugin.json'), 'plugin b')
  fs.writeFileSync(join(defaultHome, 'auth.json'), 'native auth')
  const homes = [first, second].map((id, index) => {
    const home = join(accountsRoot, id)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(join(home, 'auth.json'), `auth ${index}`)
    fs.writeFileSync(join(home, '.codex-global-state.json'), JSON.stringify({ plugins: [index === 0 ? 'a' : 'b'] }))
    fs.symlinkSync(source, join(home, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir')
    return home
  })
  return { root, defaultHome, accountsRoot, source, homes }
}

test('legacy three-account caches become independent without changing account state or source contents', () => {
  const f = fixture()
  const originals = f.homes.map(home => ['auth.json', '.codex-global-state.json'].map(name => fs.readFileSync(join(home, name), 'utf8')))
  migrateCodexPluginCaches(f)
  for (const [index, home] of f.homes.entries()) {
    const plugins = join(home, 'plugins')
    expect(fs.lstatSync(plugins).isSymbolicLink()).toBe(false)
    expect(fs.realpathSync(plugins)).not.toBe(fs.realpathSync(f.source))
    if (process.platform !== 'win32') expect(fs.statSync(plugins).mode & 0o777).toBe(0o700)
    expect(['auth.json', '.codex-global-state.json'].map(name => fs.readFileSync(join(home, name), 'utf8'))).toEqual(originals[index]!)
  }
  fs.rmSync(join(f.homes[0]!, 'plugins', 'cache', 'market', 'b'), { recursive: true })
  fs.rmSync(join(f.homes[1]!, 'plugins', 'cache', 'market', 'a'), { recursive: true })
  expect(fs.readFileSync(join(f.homes[0]!, 'plugins', 'cache', 'market', 'a', '1.0', 'plugin.json'), 'utf8')).toBe('plugin a')
  expect(fs.readFileSync(join(f.homes[1]!, 'plugins', 'cache', 'market', 'b', '1.0', 'plugin.json'), 'utf8')).toBe('plugin b')
  expect(fs.readdirSync(join(f.source, 'cache', 'market')).sort()).toEqual(['a', 'b'])
  expect(fs.readFileSync(join(f.defaultHome, 'auth.json'), 'utf8')).toBe('native auth')
  const before = fs.statSync(join(f.homes[0]!, 'plugins'))
  migrateCodexPluginCaches(f)
  const after = fs.statSync(join(f.homes[0]!, 'plugins'))
  expect(after.ino).toBe(before.ino)
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect(fs.existsSync(join(f.homes[0]!, 'plugins', 'cache', 'market', 'b'))).toBe(false)
})

test('fresh account plugin directory is empty while relative and dangling legacy links are repaired', () => {
  const f = fixture()
  const [one, two] = f.homes as [string, string]
  fs.unlinkSync(join(one, 'plugins'))
  prepareCodexPluginDirectory(one, f.defaultHome)
  expect(fs.readdirSync(join(one, 'plugins'))).toEqual([])
  fs.unlinkSync(join(two, 'plugins'))
  fs.symlinkSync(process.platform === 'win32' ? f.source : relative(two, f.source), join(two, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir')
  prepareCodexPluginDirectory(two, f.defaultHome)
  expect(fs.readFileSync(join(two, 'plugins', 'cache', 'market', 'a', '1.0', 'plugin.json'), 'utf8')).toBe('plugin a')
  fs.rmSync(join(two, 'plugins'), { recursive: true })
  fs.rmSync(f.source, { recursive: true })
  fs.symlinkSync(f.source, join(two, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir')
  prepareCodexPluginDirectory(two, f.defaultHome)
  expect(fs.readdirSync(join(two, 'plugins'))).toEqual([])
  expect(fs.existsSync(f.source)).toBe(false)
})

test('all account paths are preflighted before migrating any cache and foreign backups are preserved', () => {
  const f = fixture()
  const [one, two] = f.homes as [string, string]
  const foreign = join(f.root, 'foreign'); fs.mkdirSync(foreign)
  fs.unlinkSync(join(two, 'plugins'))
  fs.symlinkSync(foreign, join(two, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => migrateCodexPluginCaches(f)).toThrow('未知位置')
  expect(fs.lstatSync(join(one, 'plugins')).isSymbolicLink()).toBe(true)
  fs.writeFileSync(join(one, backupName), 'unrelated user data')
  expect(() => prepareCodexPluginDirectory(one, f.defaultHome)).toThrow('不是旧共享链接')
  expect(fs.readFileSync(join(one, backupName), 'utf8')).toBe('unrelated user data')
  expect(fs.readdirSync(foreign)).toEqual([])
})

test('interrupted swaps recover both before and after independent directory publication', () => {
  const f = fixture()
  const [one, two] = f.homes as [string, string]
  fs.renameSync(join(one, 'plugins'), join(one, backupName))
  prepareCodexPluginDirectory(one, f.defaultHome)
  expect(fs.lstatSync(join(one, 'plugins')).isDirectory()).toBe(true)
  expect(fs.existsSync(join(one, backupName))).toBe(false)
  fs.renameSync(join(two, 'plugins'), join(two, backupName))
  fs.mkdirSync(join(two, 'plugins'))
  fs.writeFileSync(join(two, 'plugins', 'keep'), 'published copy')
  prepareCodexPluginDirectory(two, f.defaultHome)
  expect(fs.readdirSync(join(two, 'plugins'))).toEqual(['keep'])
  expect(fs.existsSync(join(two, backupName))).toBe(false)
})

test('copy and publication failures preserve the legacy link and can be retried', () => {
  const f = fixture()
  const home = f.homes[0]!
  const copy = spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('ENOSPC simulated copy failure') })
  try { expect(() => prepareCodexPluginDirectory(home, f.defaultHome)).toThrow('ENOSPC') }
  finally { copy.mockRestore() }
  expect(fs.realpathSync(join(home, 'plugins'))).toBe(fs.realpathSync(f.source))
  expect(fs.readdirSync(home).some(name => name.startsWith('.lodestar-plugins'))).toBe(false)
  const originalRename = fs.renameSync
  const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(from).includes('.lodestar-plugins-copy-')) throw new Error('EACCES simulated publication failure')
    return originalRename(from, to)
  })
  try { expect(() => prepareCodexPluginDirectory(home, f.defaultHome)).toThrow('EACCES') }
  finally { rename.mockRestore() }
  expect(fs.realpathSync(join(home, 'plugins'))).toBe(fs.realpathSync(f.source))
  prepareCodexPluginDirectory(home, f.defaultHome)
  expect(fs.lstatSync(join(home, 'plugins')).isDirectory()).toBe(true)
})

test('copied internal links point within the private cache and external links fail before detaching', () => {
  const f = fixture()
  const home = f.homes[0]!
  fs.symlinkSync(join(f.source, 'cache', 'market', 'a'), join(f.source, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  prepareCodexPluginDirectory(home, f.defaultHome)
  expect(fs.realpathSync(join(home, 'plugins', 'alias'))).toBe(join(home, 'plugins', 'cache', 'market', 'a'))
  fs.writeFileSync(join(home, 'plugins', 'alias', '1.0', 'plugin.json'), 'isolated write')
  expect(fs.readFileSync(join(f.source, 'cache', 'market', 'a', '1.0', 'plugin.json'), 'utf8')).toBe('plugin a')
  fs.symlinkSync(join(f.defaultHome, 'auth.json'), join(f.source, 'external'))
  expect(() => prepareCodexPluginDirectory(f.homes[1]!, f.defaultHome)).toThrow('目录外链接')
  expect(fs.realpathSync(join(f.homes[1]!, 'plugins'))).toBe(f.source)
})

test('live migration ownership blocks safely and unknown account directory aliases are rejected', () => {
  const f = fixture()
  const home = f.homes[0]!
  const lock = join(home, '.lodestar-plugins-migration.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }))
  expect(() => prepareCodexPluginDirectory(home, f.defaultHome)).toThrow('正在迁移')
  expect(fs.existsSync(lock)).toBe(true)
  fs.unlinkSync(lock)
  fs.rmSync(home, { recursive: true })
  fs.symlinkSync(f.defaultHome, home, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => migrateCodexPluginCaches(f)).toThrow('不是独立目录')
  expect(() => migrateCodexPluginCaches({ defaultHome: f.defaultHome, accountsRoot: join(f.root, 'absent') })).not.toThrow()
})

test('a terminated migration owner is recovered but malformed ownership is preserved and reported', () => {
  const f = fixture()
  const home = f.homes[0]!
  const lock = join(home, '.lodestar-plugins-migration.lock')
  const exited = Bun.spawnSync(['node', '-e', 'process.stdout.write(String(process.pid))'], { stdout: 'pipe', stderr: 'pipe' })
  expect(exited.exitCode).toBe(0)
  fs.writeFileSync(lock, JSON.stringify({ pid: Number(exited.stdout.toString()) }))
  prepareCodexPluginDirectory(home, f.defaultHome)
  expect(fs.lstatSync(join(home, 'plugins')).isDirectory()).toBe(true)
  expect(fs.existsSync(lock)).toBe(false)
  const otherLock = join(f.homes[1]!, '.lodestar-plugins-migration.lock')
  fs.writeFileSync(otherLock, '{"pid":0}')
  expect(() => prepareCodexPluginDirectory(f.homes[1]!, f.defaultHome)).toThrow('迁移锁无效')
  expect(fs.readFileSync(otherLock, 'utf8')).toBe('{"pid":0}')
})

test('an account nested under the source plugin directory is rejected before staging or copying', () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'codex-plugin-nested-')))
  roots.push(root)
  const defaultHome = join(root, 'native')
  const source = join(defaultHome, 'plugins')
  const accountsRoot = join(source, 'custom-data', 'codex-accounts')
  const home = join(accountsRoot, first)
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(join(source, 'keep'), 'source stays intact')
  fs.symlinkSync(source, join(home, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => migrateCodexPluginCaches({ defaultHome, accountsRoot })).toThrow('拒绝递归复制')
  expect(fs.readdirSync(home)).toEqual(['plugins'])
  expect(fs.realpathSync(join(home, 'plugins'))).toBe(source)
  expect(fs.readFileSync(join(source, 'keep'), 'utf8')).toBe('source stays intact')
})
