/** 验收发布包与其自动安装的 latest Agent：真实路径、版本、审计和原生目录。 */
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
assert.ok(!Object.keys(installed.dependencies).some(name => name.startsWith('@deepseek-ai/') || name.startsWith('@anthropic-ai/') || name === '@openai/codex'),
  'Agent 不应作为固定发布依赖安装')

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
    import { execFileSync } from 'node:child_process'
    import { join } from 'node:path'
    import { queryDshRuntime } from ${JSON.stringify(join(import.meta.dir, '../src/dsh-runtime.ts'))}
    import { AGENTS, updateAgentRuntimes, agentRuntimeState, agentBin, loadClaudeSdk } from ${JSON.stringify(join(import.meta.dir, '../src/agent-updates.ts'))}
    const root = process.argv[2]
    await updateAgentRuntimes({ report: console.log })
    assert.equal(typeof (await loadClaudeSdk()).query, 'function')
    for (const agent of AGENTS) {
      const state = agentRuntimeState(agent)
      assert.ok(state?.directory && !state.error)
      execFileSync('npm', ['audit', '--prefix', state.directory, '--omit=dev'], { stdio: 'pipe', timeout: 120000 })
      if (agent !== 'dsh') console.log(execFileSync(agentBin(agent, agent), ['--version'], { encoding: 'utf8', timeout: 30000 }).trim())
      console.log(JSON.stringify({ agent, version: state.versions[agent === 'codex' ? '@openai/codex' : agent === 'claude' ? '@anthropic-ai/claude-agent-sdk' : '@deepseek-ai/dsh'], audit: 'passed' }))
    }
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
    env: { ...process.env, NODE_ENV: 'production', LODESTAR_DATA_DIR: join(scratch, 'state') }, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, `${stdout}\n${stderr}`)
  console.log(stdout.trim())
  console.log(JSON.stringify({ installedVersion: installed.version, latestAgentRuntimes: 'passed', cliSymlink: 'passed' }))
} finally {
  if (existsSync(output)) unlinkSync(output)
  rmSync(scratch, { recursive: true })
}
