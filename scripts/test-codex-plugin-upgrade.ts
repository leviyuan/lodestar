/** 用真实 npm tarball 安装/重建验证旧共享插件目录自动隔离；仅操作私有假账号。 */
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const tarballIndex = args.indexOf('--tarball')
assert.ok(tarballIndex >= 0 && args[tarballIndex + 1],
  '用法：bun scripts/test-codex-plugin-upgrade.ts --tarball /abs/package.tgz [--keep]')
const tarball = args[tarballIndex + 1]!
assert.ok(isAbsolute(tarball) && statSync(tarball).isFile(), '--tarball 必须是已构建发布包的绝对路径')
assert.ok(args.every((arg, index) => index === tarballIndex || index === tarballIndex + 1 || arg === '--keep'), '未知参数')
const keep = args.includes('--keep')
const expected = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'))
const root = realpathSync(mkdtempSync(join(tmpdir(), 'lodestar-plugin-upgrade-')))
const fixtureHome = join(root, 'fixture-home')
const dataDir = join(root, 'state')
const prefix = join(root, 'installed')
const defaultHome = join(fixtureHome, '.codex')
const accounts = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'fixture-one' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'fixture-two' },
]
const homes = [defaultHome, ...accounts.map(account => join(dataDir, 'codex-accounts', account.id))]
const pluginNames = ['common', 'default-only', 'first-only', 'second-only']
// These are simulated server installation lists, not an assertion about Codex's on-disk schema.
const installationLists = [['common', 'default-only'], ['common', 'first-only'], ['common', 'second-only']]
const sentinels = new Map<string, { bytes: Buffer; inode: number; link: boolean }>()
const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir'

function put(file: string, content: string): void {
  mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(file, content, { mode: 0o600 })
}
function remember(file: string): void {
  sentinels.set(file, { bytes: readFileSync(file), inode: statSync(file).ino, link: lstatSync(file).isSymbolicLink() })
}
function verifySentinels(): void {
  for (const [file, original] of sentinels) {
    assert.deepEqual(readFileSync(file), original.bytes, '账号状态或共享历史字节被改动')
    assert.equal(statSync(file).ino, original.inode, '账号状态或共享历史被替换')
    assert.equal(lstatSync(file).isSymbolicLink(), original.link, '账号状态或共享历史的链接类型被改动')
  }
}
function verifyIsolation(): void {
  const roots = homes.map(home => join(home, 'plugins'))
  for (const directory of roots) {
    assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), '插件目录仍为共享链接')
    assert.ok(!lstatSync(join(directory, 'cache')).isSymbolicLink(), '缓存目录仍为共享链接')
  }
  assert.equal(new Set(roots.map(path => realpathSync(path))).size, 3, '三个账号插件目录未隔离')
  const commonFiles = homes.map(home => join(home, 'plugins/cache/common/1.0.0/plugin.txt'))
  assert.equal(new Set(commonFiles.map(path => `${statSync(path).dev}:${statSync(path).ino}`)).size, 3,
    '插件文件共用 inode，写入仍会互相影响')
}
async function npm(label: string, command: string[]): Promise<void> {
  console.log(`${label}：开始`)
  const child = Bun.spawn(['npm', ...command, '--prefix', prefix, '--ignore-scripts=false', '--foreground-scripts', '--no-fund'], {
    cwd: root,
    env: {
      ...process.env,
      // Only the child gets a fake native home. The caller's HOME and managed environment stay intact.
      NODE_OPTIONS: `--require=${JSON.stringify(join(root, 'isolate-home.cjs'))}`,
      LODESTAR_TEST_UPGRADE_HOME: fixtureHome,
      LODESTAR_DATA_DIR: dataDir,
      LODESTAR_DISABLE_SKILL_SYNC: '0',
      npm_config_userconfig: join(root, 'empty.npmrc'),
      npm_config_cache: join(root, 'npm-cache'),
    },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  put(join(root, `${label}.log`), `${stdout}\n${stderr}`)
  assert.equal(code, 0, `${label} 失败；详见 ${join(root, `${label}.log`)}`)
  assert.ok(stdout.includes('node scripts/postinstall.cjs'), `${label} 未执行实际 postinstall`)
  console.log(`${label}：通过`)
}

let verified = false
try {
  for (const home of homes) mkdirSync(home, { recursive: true, mode: 0o700 })
  put(join(root, 'empty.npmrc'), '')
  put(join(root, 'isolate-home.cjs'), [
    "const os = require('node:os')",
    "const fixture = process.env.LODESTAR_TEST_UPGRADE_HOME",
    "if (!fixture) throw new Error('missing isolated upgrade fixture')",
    'os.homedir = () => fixture',
    "process.env.CODEX_HOME = require('node:path').join(fixture, '.codex')",
    "require('node:module').syncBuiltinESMExports()",
    '',
  ].join('\n'))
  put(join(dataDir, 'codex-accounts.json'), JSON.stringify({ version: 1, accounts, selections: { fixture: accounts[0]!.id } }))
  remember(join(dataDir, 'codex-accounts.json'))
  put(join(defaultHome, 'config.toml'), '# fixture shared native configuration\n')
  put(join(defaultHome, 'history.jsonl'), '{"fixture":"shared native history"}\n')
  put(join(defaultHome, 'sessions', 'fixture.jsonl'), '{"fixture":"shared native session"}\n')
  for (const name of pluginNames) put(join(defaultHome, 'plugins/cache', name, '1.0.0/plugin.txt'), `fixture package ${name}\n`)
  put(join(defaultHome, 'plugins/.remote-plugin-install-staging', 'fixture.txt'), 'fixture staging sentinel\n')
  for (const [index, home] of homes.entries()) {
    put(join(home, 'auth.json'), JSON.stringify({ fixture: `fake-auth-${index}`, neverRealCredentials: true }))
    put(join(home, '.test-installation-state.json'), JSON.stringify({ fixture: `fake-local-state-${index}` }))
    put(join(root, `simulated-installation-list-${index}.json`), JSON.stringify(installationLists[index]))
    if (index > 0) {
      symlinkSync(join(defaultHome, 'plugins'), join(home, 'plugins'), dirLinkType)
      symlinkSync(join(defaultHome, 'sessions'), join(home, 'sessions'), dirLinkType)
      for (const file of ['config.toml', 'history.jsonl']) symlinkSync(join(defaultHome, file), join(home, file), 'file')
    }
    for (const file of ['auth.json', '.test-installation-state.json', 'config.toml', 'history.jsonl', 'sessions/fixture.jsonl']) remember(join(home, file))
  }
  assert.equal(new Set(homes.map(home => realpathSync(join(home, 'plugins/cache')))).size, 1, '旧版共享缓存场景未建立')
  // Seed an old installation before npm replaces it with the actual new release archive.
  put(join(prefix, 'package.json'), JSON.stringify({ private: true, dependencies: { [expected.name]: '0.0.0' } }))
  put(join(prefix, 'node_modules', expected.name, 'package.json'), JSON.stringify({ name: expected.name, version: '0.0.0' }))
  await npm('npm-install', ['install', tarball, '--omit=dev', '--no-audit'])
  const installed = JSON.parse(readFileSync(join(prefix, 'node_modules', expected.name, 'package.json'), 'utf8'))
  assert.equal(installed.version, expected.version, '未安装待发布的新版本')
  verifyIsolation()
  verifySentinels()
  for (const home of homes) {
    for (const name of pluginNames) assert.equal(readFileSync(join(home, 'plugins/cache', name, '1.0.0/plugin.txt'), 'utf8'), `fixture package ${name}\n`)
    assert.equal(readFileSync(join(home, 'plugins/.remote-plugin-install-staging/fixture.txt'), 'utf8'), 'fixture staging sentinel\n')
  }

  for (const [index, home] of homes.entries()) {
    const installedNames: string[] = JSON.parse(readFileSync(join(root, `simulated-installation-list-${index}.json`), 'utf8'))
    const cache = join(home, 'plugins/cache')
    for (const name of readdirSync(cache)) if (!installedNames.includes(name)) rmSync(join(cache, name), { recursive: true })
    // Updating the same package must also be isolated, so a hardlink-only copy cannot pass.
    put(join(cache, 'common/1.0.0/plugin.txt'), `fixture account ${index} updated common\n`)
    for (const later of homes.slice(index + 1)) {
      assert.deepEqual(readdirSync(join(later, 'plugins/cache')).sort(), [...pluginNames].sort(), '同步清理影响了其他账号')
      assert.equal(readFileSync(join(later, 'plugins/cache/common/1.0.0/plugin.txt'), 'utf8'), 'fixture package common\n', '更新插件改写了其他账号文件')
    }
  }
  function verifyPruned(): void {
    verifyIsolation()
    verifySentinels()
    for (const [index, home] of homes.entries()) {
      assert.deepEqual(readdirSync(join(home, 'plugins/cache')).sort(), [...installationLists[index]!].sort(), '重复安装恢复了已删除的插件或影响了其他账号')
      assert.equal(readFileSync(join(home, 'plugins/cache/common/1.0.0/plugin.txt'), 'utf8'), `fixture account ${index} updated common\n`)
    }
  }
  verifyPruned()
  await npm('npm-rebuild', ['rebuild', expected.name])
  verifyPruned()
  assert.ok(!existsSync(join(dataDir, 'agent-runtimes')), 'postinstall 不应安装 Agent')
  assert.ok(!existsSync(join(dataDir, 'daemon.pid')), 'postinstall 不应启动 daemon')
  console.log(JSON.stringify({ result: 'passed', installedVersion: installed.version, accounts: 3,
    installLifecycle: true, cacheIsolation: true, independentPruningAndWrites: true, rebuildIdempotent: true,
    authConfigHistoryPreserved: true, realCredentialsUsed: false, daemonStarted: false,
    ...(keep ? { fixture: root, prefix } : {}) }))
  verified = true
} finally {
  if (verified && !keep) rmSync(root, { recursive: true })
  else console.error(`升级模拟目录已保留：${root}`)
}
