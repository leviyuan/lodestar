/** Isolate the Bun test process from real Lodestar credentials and XDG state. */
import { afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testRoot = mkdtempSync(join(tmpdir(), 'lodestar-test-'))
const configFile = join(testRoot, 'config.toml')
const dataDir = join(testRoot, 'data')
const codexHome = join(testRoot, 'codex')
const claudeConfigDir = join(testRoot, 'claude')
const testTmp = join(testRoot, 'tmp')

// 系统临时目录与线上 daemon 共用：收件附件目录的创建和按年龄清理等逻辑在测试里只能落在
// 测试自己的临时目录，进程退出时随 testRoot 一起删除。子进程继承同一设置。
mkdirSync(testTmp)
process.env.TMPDIR = process.env.TMP = process.env.TEMP = testTmp

mkdirSync(dataDir, { recursive: true })
mkdirSync(codexHome, { recursive: true })
mkdirSync(claudeConfigDir, { recursive: true })
writeFileSync(configFile, [
  '[feishu]',
  'app_id = "cli_test"',
  'app_secret = "test_secret"',
  '',
  '[runtime]',
  `projects_root = "${testRoot.replace(/\\/g, '\\\\')}"`,
  '',
  '[token_source.glm]',
  'base_url = "https://open.bigmodel.cn/api/anthropic"',
  'auth_token = "test-token"',
  'model = "GLM-5.2"',
  '',
].join('\n'))
writeFileSync(join(claudeConfigDir, 'settings.json'), '{"env":{}}\n')

process.env.NODE_ENV = 'test'
const testRuntime = join(testRoot, 'agent-runtime')
mkdirSync(testRuntime)
writeFileSync(join(testRuntime, 'package.json'), '{"private":true,"type":"module"}\n')
symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(testRuntime, 'node_modules'), 'junction')
process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT = testRuntime
process.env.LODESTAR_CONFIG = configFile
process.env.LODESTAR_DATA_DIR = dataDir
process.env.CODEX_HOME = codexHome
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
// 在受管 Agent 会话里跑测试时，这些变量指向线上 daemon 与真实 capability；子进程继承
// 后，`lodestar agent` 之类的测试会请求线上 daemon。测试需要时自行设置。
for (const name of ['LODESTAR_AGENT_ROLE', 'LODESTAR_AGENT_URL', 'LODESTAR_AGENT_CAPABILITY', 'LODESTAR_AGENT_SESSION', 'DSH_LODESTAR_AGENT_CONTEXT']) {
  delete process.env[name]
}

// The machine's proxy must not choose the transport a test exercises. With a proxy in
// the environment, loopback and bypassed requests leave `globalThis.fetch` for Bun's
// direct dispatcher and skip fetch mocks; without one, non-loopback requests probe the
// system proxy. Tests of proxy routing pass an explicit environment instead.
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[name]
  delete process.env[name.toLowerCase()]
}
process.env.NO_PROXY = process.env.no_proxy = '*'

const removeTestRoot = () => {
  try { rmSync(testRoot, { recursive: true, force: true }) } catch {}
}
// `bun test` 不触发 process 的 exit 事件，测试根目录（含私有临时目录）以前每次都残留在
// 系统临时目录里：测试进程改用预加载里的全局 afterAll（全部测试文件结束后执行）。以
// `--preload` 加载本文件的普通子进程不能调用 afterAll，仍在退出时清理。
try { afterAll(removeTestRoot) } catch { process.on('exit', removeTestRoot) }
