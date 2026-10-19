import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function checkRuntime(sources: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lodestar-reset-classifier-'))
  const configFile = join(dir, 'config.toml')
  const preload = join(dir, 'preload.ts')
  const callsFile = join(dir, 'calls.json')
  writeFileSync(configFile, `[feishu]\napp_id="test"\napp_secret="test"\n${sources}`, { mode: 0o600 })
  writeFileSync(preload, `
    import { mock } from 'bun:test'
    import { writeFileSync } from 'node:fs'
    const calls = []
    globalThis.fetch = async () => { throw new Error('Unexpected real HTTP request') }
    mock.module(${JSON.stringify(resolve(import.meta.dir, '../../src/network.ts'))}, () => ({
      networkFetch: async (input, init = {}) => {
        const url = String(input)
        const method = init.method ?? 'GET'
        calls.push({ url, method, authorization: new Headers(init.headers).get('authorization') })
        writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls))
        if (method !== 'GET' || !url.endsWith('/api/anthropic/v1/models')) {
          throw new Error('Preflight must only read the model catalog')
        }
        return Response.json({ data: [{ id: 'glm-5.3-flash', display_name: 'GLM-5.3-Flash' }] })
      },
    }))
  `)
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--preload', preload, join(import.meta.dir, 'glm_judge.ts'), '--check-runtime'],
      cwd: dir,
      env: { ...process.env, LODESTAR_CONFIG: configFile, LODESTAR_DATA_DIR: join(dir, 'state') },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    })
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      calls: existsSync(callsFile) ? JSON.parse(readFileSync(callsFile, 'utf8')) : [],
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('classifier preflight uses the shared legacy DSH-GLM credential and Anthropic endpoint', () => {
  const result = checkRuntime(`[token_source.dsh-glm]
api_key="legacy-test-key"
base_url="https://api.z.ai/api/coding/paas/v4"
`)
  expect(result.exitCode, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, model: 'GLM-5.3-Flash' })
  expect(result.calls).toEqual([{
    url: 'https://api.z.ai/api/anthropic/v1/models', method: 'GET', authorization: 'Bearer legacy-test-key',
  }])
  expect(result.stdout + result.stderr).not.toContain('legacy-test-key')
})

test('classifier preflight accepts api_key in the primary GLM account', () => {
  const result = checkRuntime(`[token_source.glm]
api_key="primary-test-key"
base_url="https://open.bigmodel.cn/api/anthropic"
`)
  expect(result.exitCode, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, model: 'GLM-5.3-Flash' })
  expect(result.calls).toEqual([{
    url: 'https://open.bigmodel.cn/api/anthropic/v1/models', method: 'GET', authorization: 'Bearer primary-test-key',
  }])
  expect(result.stdout + result.stderr).not.toContain('primary-test-key')
})

test.each([
  { name: 'credentials', otherKey: 'conflicting-test-key', otherBase: 'https://open.bigmodel.cn/api/coding/paas/v4' },
  { name: 'platforms', otherKey: 'primary-test-key', otherBase: 'https://api.z.ai/api/coding/paas/v4' },
])('classifier rejects conflicting shared GLM $name before making a request', ({ otherKey, otherBase }) => {
  const result = checkRuntime(`[token_source.glm]
auth_token="primary-test-key"
base_url="https://open.bigmodel.cn/api/anthropic"
[token_source.dsh-glm]
api_key="${otherKey}"
base_url="${otherBase}"
`)
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('旧账号配置冲突')
  expect(result.stdout).toBe('')
  expect(result.calls).toEqual([])
  expect(result.stderr).not.toContain('primary-test-key')
  expect(result.stderr).not.toContain('conflicting-test-key')
})
