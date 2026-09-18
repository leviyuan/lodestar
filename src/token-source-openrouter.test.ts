import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tokenSourceFactories } from './token-source'
import { fetchOpenRouterUsage } from './token-source-openrouter'
import { OPENROUTER_DEFAULT_MODELS, openRouterModelExcluded } from './openrouter-defaults'
import { resetContextWindowCache } from './context-window-observe'

const factory = tokenSourceFactories().find(f => f.kind === 'openrouter')!
const originalFetch = globalThis.fetch
const originalDataDir = process.env.LODESTAR_DATA_DIR
const testDir = mkdtempSync(join(tmpdir(), 'lodestar-openrouter-'))
let requests: { url: string; init?: RequestInit }[] = []
let respond: () => Response
let quotaNow = Date.now(), quotaTestId = 0
let quotaClock: ReturnType<typeof spyOn>
let quotaTestKey: string

function model(id = 'anthropic/test-model', overrides: Record<string, unknown> = {}) {
  return { id, name: `Name: ${id}`, architecture: { output_modalities: ['text'] },
    supported_parameters: ['tools', 'reasoning'], context_length: 1_000_000,
    reasoning: { supported_efforts: ['high', 'medium', 'low'], default_effort: 'medium' }, ...overrides }
}
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}
const build = (cfg: Parameters<typeof factory.build>[0] = {}) => factory.build({ api_key: 'test-key', models: 'anthropic/test-model', ...cfg })

beforeAll(() => { process.env.LODESTAR_DATA_DIR = testDir })
beforeEach(() => {
  quotaNow = Date.now()
  quotaClock = spyOn(Date, 'now').mockImplementation(() => quotaNow)
  quotaTestKey = `quota-test-key-${++quotaTestId}`
  requests = []
  resetContextWindowCache()
  respond = () => json({ data: [model()] })
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    return respond()
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch; resetContextWindowCache(); quotaClock.mockRestore() })
afterAll(() => {
  if (originalDataDir === undefined) delete process.env.LODESTAR_DATA_DIR
  else process.env.LODESTAR_DATA_DIR = originalDataDir
  rmSync(testDir, { recursive: true, force: true })
})

describe('OpenRouter configuration and routing', () => {
  test('registers setup, normalizes SDK base URLs and rejects malformed commands', () => {
    expect(factory.setup?.parseArgs('test-key')).toEqual({ config: { agent: 'claude', api_key: 'test-key' } })
    expect(factory.setup?.parseArgs('https://gateway.example/openrouter/v1/ test-key')).toEqual({
      config: { agent: 'claude', base_url: 'https://gateway.example/openrouter', api_key: 'test-key' },
    })
    for (const args of ['', 'https://openrouter.ai/api', 'one two three', 'invalid key', 'ftp://host key', 'https://host?key=x key']) {
      expect(factory.setup?.parseArgs(args)).toHaveProperty('error')
    }
  })

  test('detects only OpenRouter bearer credentials and does not mix them with an explicit route', () => {
    const detected = factory.detect?.fromSettingsEnv({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1', ANTHROPIC_AUTH_TOKEN: 'detected-key',
    })
    expect(detected).toEqual({ base_url: 'https://openrouter.ai/api', api_key: 'detected-key' })
    expect(factory.build({}, detected).enabled).toBe(true)
    expect(factory.build({ base_url: 'https://private.example/api' }, detected).enabled).toBe(false)
    for (const host of ['openrouter.ai.evil.example', 'api.deepseek.com', 'open.bigmodel.cn']) {
      expect(factory.detect?.fromSettingsEnv({ ANTHROPIC_BASE_URL: `https://${host}/api`, ANTHROPIC_AUTH_TOKEN: 'key' })).toBeNull()
    }
    expect(factory.detect?.fromSettingsEnv({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_API_KEY: 'wrong-auth' })).toBeNull()
  })

  test('disabled sources make no requests and cannot spawn with ambient credentials', async () => {
    const source = factory.build({})
    await source.refreshModels()
    expect(source.modelCatalogState?.status).toBe('disabled')
    expect(await source.readUsage()).toEqual({ kind: 'balance', state: 'no_credentials', windows: [] })
    expect(() => source.spawnEnv({ ANTHROPIC_AUTH_TOKEN: 'ambient' }, 'anthropic/test-model')).toThrow('key missing')
    expect(requests).toHaveLength(0)
  })

  test('isolates credentials and sends the chosen full slug to all unconfigured SDK roles', async () => {
    const source = build({ slots: 'haiku=anthropic/small', models: 'anthropic/test-model,anthropic/small' })
    respond = () => json({ data: [model(), model('anthropic/small')] })
    await source.refreshModels()
    const env = source.spawnEnv({ PATH: '/bin', LODESTAR_AGENT_CAPABILITY: 'cap',
      ANTHROPIC_API_KEY: 'old-api', ANTHROPIC_AUTH_TOKEN: 'old-token', ANTHROPIC_BASE_URL: 'https://old.example',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'old-model', ANTHROPIC_DEFAULT_FABLE_MODEL: 'old-fable',
      CLAUDE_CODE_SUBAGENT_MODEL: 'old-subagent', CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer old-key',
    }, 'anthropic/test-model')
    expect(env).toMatchObject({ PATH: '/bin', LODESTAR_AGENT_CAPABILITY: 'cap',
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'test-key', ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'anthropic/test-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/test-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/test-model', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/small',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'anthropic/test-model', CLAUDE_CODE_SUBAGENT_MODEL: 'anthropic/test-model',
      ANTHROPIC_SMALL_FAST_MODEL: 'anthropic/test-model',
    })
    expect(JSON.stringify(env)).not.toContain('old-')
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined()
    expect(source.settingSources).toBeUndefined()
    expect(source.resolveSpawnModel('anthropic/test-model')).toBe('anthropic/test-model')
    expect(source.resolveSpawnModel('anthropic/test-model[1m]')).toBe('anthropic/test-model[1m]')
    expect(() => build().spawnEnv({})).toThrow('未选择模型')
  })
})

describe('OpenRouter authoritative model catalog', () => {
  test('uses the authenticated user catalog, preserves per-model efforts and exposes missing effort without inventing it', async () => {
    respond = () => json({ data: [model(),
      model('qwen/test', { reasoning: { supported_efforts: ['xhigh', 'high', 'minimal', 'none'], default_effort: 'high' } }),
      model('no-effort', { reasoning: undefined }),
      model('unsupported-default', { reasoning: { supported_efforts: ['high', 'minimal'], default_effort: 'minimal' } }),
      model('batch:batch'), model('no-tools', { supported_parameters: [] }),
      model('image-only', { architecture: { output_modalities: ['image'] } }), model(),
    ] })
    const source = build({ base_url: 'https://openrouter.ai/api/v1/', models: 'anthropic/test-model,qwen/test,no-effort,unsupported-default' })
    await source.refreshModels()
    expect(requests[0].url).toBe('https://openrouter.ai/api/v1/models/user')
    expect(new Headers(requests[0].init?.headers).get('Authorization')).toBe('Bearer test-key')
    expect(source.models.map(m => m.model)).toEqual(['anthropic/test-model', 'qwen/test', 'no-effort', 'unsupported-default'])
    expect(source.models[0]).toMatchObject({ display: 'Name: anthropic/test-model', efforts: ['high', 'medium', 'low'], defaultEffort: 'medium' })
    expect(source.models[1].efforts).toEqual(['xhigh', 'high'])
    expect(source.models[2]).toMatchObject({ efforts: ['default'], defaultEffort: 'default' })
    expect(source.models[3]).toMatchObject({ efforts: ['high'], defaultEffort: null })
    expect(source.models[0].context1m).toBeUndefined()
    expect(source.defaultModel).toBe('')
  })

  test('distinguishes explicit all-effort null from an omitted effort selector', async () => {
    respond = () => json({ data: [model('all', { reasoning: { supported_efforts: null, default_effort: 'high' } })] })
    const source = build({ models: 'all' })
    await source.refreshModels()
    expect(source.models[0].efforts).toEqual(['max', 'xhigh', 'high', 'medium', 'low'])
  })

  test('validates an explicit shortlist, default model and default effort against the fetched catalog', async () => {
    respond = () => json({ data: [model('anthropic/a'), model('qwen/b')] })
    const source = build({ models: 'qwen/b, qwen/b', model: 'qwen/b', effort: 'low' })
    await source.refreshModels()
    expect(source.models).toHaveLength(1)
    expect(source.models[0]).toMatchObject({ model: 'qwen/b', defaultEffort: 'low' })
    for (const config of [{ model: 'missing' }, { models: 'qwen/b', model: 'qwen/b', effort: 'max' }, { effort: 'high' }]) {
      const invalid = build(config)
      await invalid.refreshModels()
      expect(invalid.modelCatalogState?.status).toBe('failed')
      expect(invalid.models).toEqual([])
    }
  })

  test('preserves an explicitly configured context suffix without changing the authoritative model id lookup', async () => {
    const source = build({ models: 'anthropic/test-model[1m]', model: 'anthropic/test-model[1m]' })
    await source.refreshModels()
    expect(source.modelCatalogState?.status).toBe('ready')
    expect(source.models[0].model).toBe('anthropic/test-model[1m]')
  })

  test('keeps Gemini and MiMo on OpenRouter in the six-model defaults', async () => {
    respond = () => json({ data: OPENROUTER_DEFAULT_MODELS.map(entry => model(entry.model, {
      reasoning: entry.effort === 'default' ? { mandatory: false }
        : { supported_efforts: [entry.effort, 'low'], default_effort: 'low' },
    })) })
    const source = factory.build({ api_key: 'test-key' })
    await source.refreshModels()
    expect(source.models.map(entry => entry.model)).toEqual(OPENROUTER_DEFAULT_MODELS.map(entry => entry.model))
    expect(source.models.map(entry => entry.defaultEffort)).toEqual(OPENROUTER_DEFAULT_MODELS.map(entry => entry.effort))
    expect(source.models.map(entry => entry.model)).toEqual([
      'tencent/hy4-preview', 'google/gemini-3.8-flash', 'meta/muse-spark-1.2',
      'xiaomi/mimo-v2.5-pro', 'bytedance-seed/seed-2-1-turbo', 'meituan/longcat-2.0',
    ])
    expect(source.models.every(entry => !openRouterModelExcluded(entry.model))).toBe(true)
  })

  test('excluded authors cannot enter the add catalog or be routed through aliases', async () => {
    const excluded = ['openai/test', 'deepseek/test', 'z-ai/glm-test', 'openrouter/auto']
    respond = () => json({ data: [model(), ...excluded.map(id => model(id))] })
    const source = build()
    await source.refreshModels()
    expect(source.modelSelection?.availableModels.map(entry => entry.model)).toEqual(['anthropic/test-model'])
    for (const id of excluded) {
      expect(() => source.resolveSpawnModel(id)).toThrow('排除')
      expect(() => source.spawnEnv({}, id)).toThrow('排除')
    }
  })

  test('an explicit empty selection stays empty and an unavailable selected id remains a removable MISS', async () => {
    const empty = build({ models: '' })
    await empty.refreshModels()
    expect(empty.modelCatalogState?.status).toBe('ready')
    expect(empty.models).toEqual([])
    expect(empty.modelSelection?.availableModels).toHaveLength(1)
    const unavailable = build({ models: 'missing,openai/excluded' })
    await unavailable.refreshModels()
    expect(unavailable.models.every(entry => entry.unavailableReason && !entry.efforts.length)).toBe(true)
    expect(unavailable.modelSelection?.modelIds).toEqual(['missing', 'openai/excluded'])
  })

  test('an unavailable preset effort stays MISS instead of silently selecting another effort', async () => {
    respond = () => json({ data: [model('tencent/hy4-preview', {
      reasoning: { supported_efforts: ['medium', 'low'], default_effort: 'low' },
    })] })
    const source = build({ models: 'tencent/hy4-preview' })
    await source.refreshModels()
    expect(source.models[0].defaultEffort).toBeNull()
    expect(source.models[0].efforts).toEqual(['medium', 'low'])
  })

  test('does not keep stale or configured models when refresh fails, including malformed successes', async () => {
    for (const failure of [
      () => json({ error: { message: 'unauthorized' } }, 401),
      () => json({ error: { message: 'upstream failure' } }, 503),
      () => json({ data: {} }), () => json({ data: [] }), () => json({ data: [{ id: 'broken' }] }),
      () => { throw new Error('network disconnected') },
    ]) {
      respond = () => json({ data: [model()] })
      const source = build({ models: 'anthropic/test-model', model: 'anthropic/test-model' })
      await source.refreshModels()
      expect(source.models).toHaveLength(1)
      respond = failure
      await source.refreshModels()
      expect(source.models).toEqual([])
      expect(source.modelCatalogState).toMatchObject({ status: 'failed', error: expect.any(String) })
    }
  })
})

describe('OpenRouter account balance', () => {
  test('reads account credits and subtracts account usage independently of key limits', async () => {
    respond = () => json({ data: { total_credits: 100.5, total_usage: 25.75 } })
    const usage = await fetchOpenRouterUsage('https://openrouter.ai/api', quotaTestKey)
    expect(requests.map(r => r.url)).toEqual(['https://openrouter.ai/api/v1/credits'])
    expect(usage).toMatchObject({ kind: 'balance', state: 'ok', windows: [], balance: { currency: 'USD' } })
    expect(usage.balance?.remaining).toBe(74.75)
    expect(usage.planLabel).toBeUndefined()
    expect(usage.quota).toBeUndefined()
  })

  test('zero and overdrawn account balances are not replaced or clamped', async () => {
    respond = () => json({ data: { total_credits: 0, total_usage: 0 } })
    expect(await fetchOpenRouterUsage('https://openrouter.ai/api', quotaTestKey)).toMatchObject({
      kind: 'balance', state: 'ok', windows: [], balance: { remaining: 0, currency: 'USD' },
    })
    respond = () => json({ data: { total_credits: 1, total_usage: 1.25 } })
    quotaNow += 60_000
    expect((await fetchOpenRouterUsage('https://openrouter.ai/api', quotaTestKey)).balance?.remaining).toBe(-0.25)
  })

  test('HTTP, malformed response and network failures remain visible and do not query another endpoint', async () => {
    for (const failure of [
      () => json({ error: { message: 'forbidden ' + quotaTestKey } }, 403),
      () => new Response('<html>bad gateway</html>', { status: 502 }),
      () => json({ data: { total_credits: 10 } }),
      () => json({ data: { total_credits: 10, total_usage: 'unknown' } }),
      () => { throw new Error('timeout') },
    ]) {
      respond = failure
      quotaNow += 300_000
      const snap = await fetchOpenRouterUsage('https://openrouter.ai/api', quotaTestKey)
      expect(snap.state).toBe('network')
      expect(snap.windows).toEqual([])
      expect(snap.reason).toBeTruthy()
      expect(snap.reason).not.toContain(quotaTestKey)
    }
    expect(requests).toHaveLength(5)
    expect(requests.every(request => request.url.endsWith('/credits'))).toBe(true)
    respond = () => json({ error: { message: 'rate limited' } }, 429)
    quotaNow += 300_000
    expect((await fetchOpenRouterUsage('https://openrouter.ai/api', quotaTestKey)).state).toBe('rate_limited')
  })
})
