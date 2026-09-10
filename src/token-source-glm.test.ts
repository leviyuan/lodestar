import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 通过 fetch 边界伪造上游列表滞后场景(只列到 GLM-5.2,无 5.3)。
// 不使用 mock.module:它是进程级的，会把不完整的 config /
// token-source-models 导出污染随机顺序中后续的测试文件。
let modelsResponse: any[] = []
const originalFetch = globalThis.fetch
const originalDataDir = process.env.LODESTAR_DATA_DIR
const testDataDir = mkdtempSync(join(tmpdir(), 'lodestar-glm-obs-'))
const {
  observeContextWindow,
  resetContextWindowCache,
} = await import('./context-window-observe')

const { resetTokenSourceRegistry, tokenSourceFactories } = await import('./token-source')
await import('./token-source-glm')
await import('./token-source-deepseek')

const glmFactory = tokenSourceFactories().find(f => f.kind === 'glm-coding-plan')!
const deepseekFactory = tokenSourceFactories().find(f => f.kind === 'deepseek')!

beforeAll(() => {
  process.env.LODESTAR_DATA_DIR = testDataDir
})

beforeEach(() => {
  resetTokenSourceRegistry()
  resetContextWindowCache()
  rmSync(join(testDataDir, 'context-window-cache.json'), { force: true })
  modelsResponse = [
    { model: 'GLM-5.2', display: 'GLM-5.2' },
    { model: 'GLM-4.7', display: 'GLM-4.7' },
  ]
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (!url.pathname.endsWith('/v1/models')) {
      throw new Error(`unexpected test request: ${url}`)
    }
    return new Response(JSON.stringify({
      data: modelsResponse.map(model => ({
        id: model.model,
        display_name: model.display,
      })),
    }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  resetContextWindowCache()
  rmSync(join(testDataDir, 'context-window-cache.json'), { force: true })
})

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.LODESTAR_DATA_DIR
  else process.env.LODESTAR_DATA_DIR = originalDataDir
  rmSync(testDataDir, { recursive: true, force: true })
})

function buildGlm(cfg: Record<string, any> = {}) {
  return glmFactory.build({
    base_url: 'https://open.bigmodel.cn/api/anthropic',
    auth_token: 'test-token',
    ...cfg,
  })
}

describe('glm models config 补充', () => {
  test('config models 键的 slug 补登到动态列表尾(上游未列出时)', async () => {
    const ts = buildGlm({ models: 'GLM-5.3' })
    await ts.refreshModels()
    expect(ts.models.map(m => m.model)).toEqual(['GLM-5.2', 'GLM-4.7', 'GLM-5.3'])
  })

  test('上游已列出的 slug 不重复(自动收敛为 no-op)', async () => {
    const ts = buildGlm({ models: 'GLM-5.2, GLM-5.3' })
    await ts.refreshModels()
    expect(ts.models.map(m => m.model)).toEqual(['GLM-5.2', 'GLM-4.7', 'GLM-5.3'])
  })

  test('大小写不敏感去重(上游 id 小写、config 大写)', async () => {
    modelsResponse = [{ model: 'GLM-5.3', display: 'GLM-5.3' }]
    const ts = buildGlm({ models: 'glm-5.3' })
    await ts.refreshModels()
    expect(ts.models.map(m => m.model)).toEqual(['GLM-5.3'])
  })

  test('无 models 键 = 纯动态列表,行为不变', async () => {
    const ts = buildGlm()
    await ts.refreshModels()
    expect(ts.models.map(m => m.model)).toEqual(['GLM-5.2', 'GLM-4.7'])
  })

  test('补登模型带 CLAUDE_EFFORTS / defaultEffort=max', async () => {
    const ts = buildGlm({ models: 'GLM-5.3' })
    await ts.refreshModels()
    const m = ts.models.find(m => m.model === 'GLM-5.3')!
    expect(m.efforts).toEqual(['max', 'xhigh', 'high', 'medium', 'low'])
    expect(m.defaultEffort).toBe('max')
  })
})

describe('anthropic-compatible source env isolation', () => {
  const contaminated = {
    KEEP_ME: 'yes',
    ANTHROPIC_API_KEY: 'old-api-key',
    ANTHROPIC_AUTH_TOKEN: 'old-auth-token',
    ANTHROPIC_BASE_URL: 'https://old.invalid',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'old-opus',
    ANTHROPIC_MODEL: 'openrouter/old-model',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'openrouter/old-fable',
    ANTHROPIC_SMALL_FAST_MODEL: 'openrouter/old-small',
    CLAUDE_CODE_SUBAGENT_MODEL: 'openrouter/old-subagent',
    CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth',
    CLAUDE_CODE_USE_BEDROCK: '1',
  }

  test('GLM keeps only its own auth and routing fields', () => {
    const env = buildGlm().spawnEnv(contaminated)
    expect(env.KEEP_ME).toBe('yes')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('test-token')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined()
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
  })

  test('DeepSeek keeps only its own API key and routing fields', () => {
    const source = deepseekFactory.build({
      base_url: 'https://api.deepseek.com/anthropic', api_key: 'deepseek-key',
    })
    const env = source.spawnEnv(contaminated)
    expect(env.KEEP_ME).toBe('yes')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(env.ANTHROPIC_API_KEY).toBe('deepseek-key')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
  })
})

describe('glm [1m] 后缀 = 真实窗口观测决策', () => {
  test('未观测 → 默认加 [1m](客户端记账最大化)', () => {
    const ts = buildGlm()
    expect(ts.resolveSpawnModel('GLM-5.2')).toBe('GLM-5.2[1m]')
    expect(ts.resolveSpawnModel('GLM-5.3')).toBe('GLM-5.3[1m]')
  })

  test('观测 1M → 加 [1m];观测/降级 200K → 裸名', () => {
    const ts = buildGlm()
    observeContextWindow('glm', 'GLM-5.3', 1_000_000)
    observeContextWindow('glm', 'GLM-4.7', 200_000)
    expect(ts.resolveSpawnModel('GLM-5.3')).toBe('GLM-5.3[1m]')
    expect(ts.resolveSpawnModel('GLM-4.7')).toBe('GLM-4.7')
  })

  test('refreshModels 的 1M 标注来自观测缓存(未观测 = 无标注,如实 MISS)', async () => {
    const ts = buildGlm()
    observeContextWindow('glm', 'GLM-5.2', 1_000_000)
    await ts.refreshModels()
    expect(ts.models.find(m => m.model === 'GLM-5.2')?.context1m).toBe(true)
    expect(ts.models.find(m => m.model === 'GLM-4.7')?.context1m).toBeUndefined()
  })
})
