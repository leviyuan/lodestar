/** Isolate the Bun test process from real Lodestar credentials and XDG state. */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testRoot = mkdtempSync(join(tmpdir(), 'lodestar-test-'))
const configFile = join(testRoot, 'config.toml')
const dataDir = join(testRoot, 'data')
const codexHome = join(testRoot, 'codex')
const claudeConfigDir = join(testRoot, 'claude')

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

process.on('exit', () => {
  try { rmSync(testRoot, { recursive: true, force: true }) } catch {}
})
