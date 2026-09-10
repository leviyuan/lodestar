/** 验收已安装的发布包：真实依赖版本、全局命令链接和原生 DSH 目录。 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

assert.ok(process.argv[2], '需要实际安装 tarball 的 npm prefix')
const prefix = resolve(process.argv[2]!)
assert.ok(isAbsolute(prefix))
const expected = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'))
const packageRoot = join(prefix, 'node_modules', expected.name)
const installed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
assert.equal(installed.version, expected.version)
const lock = JSON.parse(readFileSync(join(prefix, 'package-lock.json'), 'utf8'))
const versions = new Set(Object.entries(lock.packages).filter(([name]) => name.split('node_modules/').at(-1)!.startsWith('@deepseek-ai/dsh'))
  .map(([, value]) => (value as { version: string }).version))
assert.deepEqual([...versions], [expected.dependencies['@deepseek-ai/dsh']], '安装后 DSH 插件版本发生漂移')

const help = Bun.spawnSync({ cmd: [join(prefix, 'node_modules/.bin/lodestar-agent'), '--help'], stdout: 'pipe', stderr: 'pipe' })
assert.equal(help.exitCode, 0, help.stderr.toString())
assert.ok(help.stdout.toString().includes('lodestar-agent'), 'npm 命令链接没有执行 CLI')

const scratch = mkdtempSync(join(tmpdir(), 'lodestar-installed-check-'))
const entry = join(scratch, 'probe.ts')
const output = join(packageRoot, 'dist', '_installed_runtime_check.js')
assert.ok(!existsSync(output), '安装目录已存在同名验收文件')
try {
  writeFileSync(entry, `
    import assert from 'node:assert/strict'
    import { mkdirSync } from 'node:fs'
    import { join } from 'node:path'
    import { queryDshRuntime } from ${JSON.stringify(join(import.meta.dir, '../src/dsh-runtime.ts'))}
    const root = process.argv[2]
    mkdirSync(join(root, 'workspace'))
    const models = await queryDshRuntime({ cwd: join(root, 'workspace'), home: join(root, 'home'),
      profile: { loadProjectMcp: false }, env: { PATH: process.env.PATH, LODESTAR_DSH_NODE: process.execPath,
        DEEPSEEK_API_KEY: 'catalog-probe-no-network', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1', LODESTAR_DSH_PROVIDER: 'deepseek-official' } }, 'model/list')
    assert.ok(models.length > 0 && models.every(model => model.efforts.includes(model.defaultEffort)))
    console.log(JSON.stringify({ installedDshCatalog: models.map(model => model.model) }))
  `, { mode: 0o600 })
  const built = await Bun.build({ entrypoints: [entry], target: 'node', packages: 'external',
    outdir: join(packageRoot, 'dist'), naming: '_installed_runtime_check.js' })
  assert.ok(built.success, built.logs.map(String).join('\n'))
  const child = Bun.spawn({ cmd: ['node', output, scratch],
    env: { ...process.env, LODESTAR_DATA_DIR: join(scratch, 'state') }, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, `${stdout}\n${stderr}`)
  console.log(stdout.trim())
  console.log(JSON.stringify({ installedVersion: installed.version, dshVersion: [...versions][0], cliSymlink: 'passed' }))
} finally {
  if (existsSync(output)) unlinkSync(output)
  rmSync(scratch, { recursive: true })
}
