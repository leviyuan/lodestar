import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { fetchPackyBalance, fetchPackyUsage, packyApiRoot, packyManagementRoot } from './packy-api'
import { tokenSourceFactories } from './token-source'
import { sharedTokenSourceConfigs, tokenSourceConfigUpdates } from './token-source-accounts'
import { withModelVisibility } from './token-source-visibility'
import { PACKY_CODEX_KEY_ENV, PACKY_GEMINI_RETRY_ENV } from './token-source-packy'

const originalFetch = globalThis.fetch
let counter = 0, key: string
let requests: { url: string; authorization: string | null }[]
let respond: (url: string, init?: RequestInit) => Response | Promise<Response>
const mixed = [
  { id: 'MiniMax-M3', supported_endpoint_types: ['anthropic', 'openai'] },
  { id: 'mimo-v2.5-pro', supported_endpoint_types: ['anthropic', 'openai-response'] },
  { id: 'kimi-k3', supported_endpoint_types: ['openai-response'] },
  { id: 'gemini-3.8-flash', supported_endpoint_types: ['gemini', 'openai'] },
]
const factory = (id: string) => tokenSourceFactories().find(item => item.configSectionId === id)!
const build = (id = 'packy', cfg: Parameters<ReturnType<typeof factory>['build']>[0] = {}) =>
  withModelVisibility(factory(id).build({ api_key: key, ...cfg }), { api_key: key, ...cfg })

beforeEach(() => {
  key = `packy-test-${++counter}`
  requests = []
  respond = () => Response.json({ data: mixed })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
    return respond(String(input), init)
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch })

describe('Packy sources', () => {
  test('filters by declared protocol and deduplicates concurrent account catalog reads', async () => {
    const claude = build(), codex = build('packy-codex')
    await Promise.all([claude.refreshModels(), codex.refreshModels()])
    expect(requests).toEqual([{ url: 'https://cf.api.fan/v1/models', authorization: `Bearer ${key}` }])
    expect(claude.models.map(m => m.model)).toEqual(['MiniMax-M3'])
    expect(codex.models.map(m => m.model)).toEqual(['kimi-k3'])
    expect(claude.modelSelection?.mode).toBe('allowlist')
    expect(claude.modelSelection?.availableModels.map(m => m.model)).toEqual([
      'MiniMax-M3', 'mimo-v2.5-pro', 'gemini-3.8-flash',
    ])
    expect(claude.models[0]!.defaultEffort).toBe('default')
    expect(codex.models[0]!.defaultEffort).toBe('medium')
    expect(() => claude.resolveSpawnModel('kimi-k3')).toThrow('未声明 anthropic')
    expect(() => codex.resolveSpawnModel('gemini-3.8-flash')).toThrow('未声明 openai-response')
  })

  test('honors upstream effort declarations and explicit account request preferences', async () => {
    respond = () => Response.json({ data: [{ ...mixed[2], reasoning: {
      supported_efforts: ['high', 'low'], default_effort: 'low',
    } }] })
    const source = build('packy-codex')
    await source.refreshModels()
    expect(source.models[0]).toMatchObject({ efforts: ['low', 'high'], defaultEffort: 'low' })
    const invalid = build('packy-codex', { effort: 'ultra' })
    await invalid.refreshModels()
    expect(invalid.modelCatalogState).toMatchObject({ status: 'failed', error: expect.stringContaining('effort') })
  })

  test('defaults to the curated replacement models while keeping other catalog entries available to add', async () => {
    respond = () => Response.json({ data: [
      { id: 'MiniMax-M3', supported_endpoint_types: ['anthropic'] },
      { id: 'qwen3.8-max-0902', supported_endpoint_types: ['anthropic'] },
      { id: 'mimo-v2.5-pro', supported_endpoint_types: ['anthropic', 'openai-response'] },
      { id: 'unlisted-packy-model', supported_endpoint_types: ['anthropic', 'openai-response'] },
    ] })
    const source = build()
    await source.refreshModels()
    expect(source.models.map(m => m.model)).toEqual([
      'MiniMax-M3', 'qwen3.8-max-0902',
    ])
    expect(source.modelSelection?.availableModels.map(m => m.model)).toEqual([
      'MiniMax-M3', 'qwen3.8-max-0902', 'mimo-v2.5-pro', 'unlisted-packy-model',
    ])
  })

  test('Fable 5.1 retains its authoritative hyphenated ID and Grok 4.6 uses only Responses', async () => {
    respond = () => Response.json({ data: [
      { id: 'MiniMax-M3', supported_endpoint_types: ['anthropic'] },
      { id: 'grok-4.6', supported_endpoint_types: ['openai-response'] },
      { id: 'claude-opus-5', supported_endpoint_types: ['anthropic'] },
      { id: 'claude-fable-5-1', supported_endpoint_types: ['anthropic'] },
      { id: 'gemini-3.8-flash', supported_endpoint_types: ['gemini', 'openai'] },
      { id: 'qwen3.8-max-0902', supported_endpoint_types: ['anthropic'] },
      { id: 'claude-fable-5', supported_endpoint_types: ['anthropic'] },
      { id: 'grok-4.5', supported_endpoint_types: ['openai-response'] },
    ] })
    const source = build()
    const secondary = build('packy-secondary')
    const codex = build('packy-codex')
    await Promise.all([source.refreshModels(), secondary.refreshModels(), codex.refreshModels()])
    expect(source.models.map(m => m.model)).toEqual([
      'MiniMax-M3', 'claude-opus-5', 'claude-fable-5-1', 'qwen3.8-max-0902',
    ])
    expect(secondary.models).toEqual(source.models)
    expect(codex.models.map(m => m.model)).toEqual(['grok-4.6'])
    expect(source.spawnEnv({}, 'claude-fable-5-1').ANTHROPIC_MODEL).toBe('claude-fable-5-1')
    expect(() => source.spawnEnv({}, 'grok-4.6')).toThrow('未声明 anthropic')
    expect(codex.resolveSpawnModel('grok-4.6')).toBe('grok-4.6')
    expect(codex.codexApiProvider?.baseUrl).toBe('https://cf.api.fan/v1')
    expect(source.models.some(m => m.model === 'gemini-3.8-flash')).toBe(false)
    expect(secondary.models.some(m => m.model === 'gemini-3.8-flash')).toBe(false)
    expect(source.modelSelection?.availableModels.find(m => m.model === 'gemini-3.8-flash')?.origin).toBe('upstream')
    expect(source.models.find(m => m.model === 'qwen3.8-max-0902')).toBeDefined()
  })

  test('an explicit Packy models list replaces the curated defaults', async () => {
    const source = build('packy', { models: 'MiniMax-M3' })
    await source.refreshModels()
    expect(source.models.map(m => m.model)).toEqual(['MiniMax-M3'])
    expect(source.modelSelection?.availableModels.map(m => m.model)).toEqual([
      'MiniMax-M3', 'mimo-v2.5-pro', 'gemini-3.8-flash',
    ])
  })

  test('an empty explicit list stays empty without disabling its configured runtime model', async () => {
    const source = build('packy', { models: '', model: 'MiniMax-M3' })
    await source.refreshModels()
    await source.refreshModels()
    expect(source.models).toEqual([])
    expect(source.modelSelection?.availableModels.some(m => m.model === 'MiniMax-M3')).toBe(true)
    expect(source.spawnEnv({}).ANTHROPIC_MODEL).toBe('MiniMax-M3')
  })

  test('a token without a model does not acquire invented Grok or Fable entries', async () => {
    respond = () => Response.json({ data: [{ id: 'qwen3.8-max-0902', supported_endpoint_types: ['anthropic'] }] })
    const source = build('packy-secondary')
    await source.refreshModels()
    expect(source.models.map(m => m.model)).toEqual(['qwen3.8-max-0902'])
    expect(source.modelSelection?.availableModels.map(m => m.model)).toEqual(['qwen3.8-max-0902'])
    const manual = build('packy-secondary', { custom_models: 'claude-fable-5-1' })
    await manual.refreshModels()
    expect(manual.models.find(m => m.model === 'claude-fable-5-1')?.origin).toBe('custom')
  })

  test('keeps the two keys independent and routes all Claude role models through the selected key', async () => {
    const source = build('packy-secondary', { api_key: 'second-test-key', model: 'MiniMax-M3' })
    await source.refreshModels()
    expect(requests[0]!.authorization).toBe('Bearer second-test-key')
    const env = source.spawnEnv({ ANTHROPIC_API_KEY: 'old', ANTHROPIC_AUTH_TOKEN: 'old',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription', [PACKY_CODEX_KEY_ENV]: 'old-codex', KEEP: 'yes' }, 'MiniMax-M3')
    expect(env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://cf.api.fan', ANTHROPIC_AUTH_TOKEN: 'second-test-key',
      ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: 'MiniMax-M3', ANTHROPIC_DEFAULT_FABLE_MODEL: 'MiniMax-M3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3', CLAUDE_CODE_NO_MODEL_FALLBACK: '1', KEEP: 'yes' })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env[PACKY_CODEX_KEY_ENV]).toBeUndefined()
  })

  test('API Codex receives only its own key and an explicit Responses provider', async () => {
    const source = build('packy-codex', { base_url: 'https://gateway.test/api/v1/' })
    await source.refreshModels()
    const env = source.spawnEnv({ ANTHROPIC_AUTH_TOKEN: 'wrong', OPENAI_API_KEY: 'wrong',
      CODEX_API_KEY: 'wrong', OPENAI_BASE_URL: 'https://wrong.test', KEEP: 'yes' }, 'kimi-k3')
    expect(env).toEqual({ [PACKY_CODEX_KEY_ENV]: key, KEEP: 'yes' })
    expect(source.codexApiProvider).toEqual({ id: 'packy', name: 'PackyAPI',
      baseUrl: 'https://gateway.test/api/v1', envKey: PACKY_CODEX_KEY_ENV })
  })

  test('refresh failures clear previous models and report malformed or unsupported catalogs', async () => {
    const failures = [
      () => Response.json({ data: [] }),
      () => Response.json({ data: [{ id: 'unknown' }] }),
      () => Response.json({ data: [{ ...mixed[0], supported_endpoint_types: [] }] }),
      () => Response.json({ data: [mixed[0], mixed[0]] }),
      () => Response.json({ data: [{ id: 'unsupported-model', supported_endpoint_types: ['other'] }] }),
      () => Response.json({ error: { message: `invalid ${key}` } }, { status: 401 }),
      () => { throw new Error(`disconnected ${key}`) },
    ]
    for (const failure of failures) {
      respond = () => Response.json({ data: mixed })
      const source = build()
      await source.refreshModels()
      expect(source.models.length).toBeGreaterThan(0)
      respond = failure
      await source.refreshModels()
      expect(source.models).toEqual([])
      expect(source.modelCatalogState?.status).toBe('failed')
      expect(source.modelCatalogState?.error).not.toContain(key)
    }
  })

  test('supports hide/show and out-of-catalog registration without inventing upstream entries', async () => {
    const source = build('packy', { hidden_models: 'MiniMax-M3', custom_models: 'future-model' })
    await source.refreshModels()
    expect(source.models.map(m => m.model)).toEqual([
      'future-model',
    ])
    expect(source.modelSelection?.availableModels.find(m => m.model === 'MiniMax-M3')?.origin).toBe('upstream')
    expect(source.models.find(m => m.model === 'future-model')?.origin).toBe('custom')
    expect(source.resolveSpawnModel('future-model')).toBe('future-model')
  })

  test('an explicitly registered Gemini can use Messages without rewriting its upstream protocol declaration', async () => {
    respond = () => Response.json({ data: [mixed[3]] })
    const source = build('packy', { model: 'gemini-3.8-flash', models: 'gemini-3.8-flash', custom_models: 'gemini-3.8-flash', effort: 'default' })
    await source.refreshModels()
    expect(source.modelCatalogState?.status).toBe('ready')
    expect(source.models).toHaveLength(1)
    expect(source.models[0]).toMatchObject({ model: 'gemini-3.8-flash', origin: 'custom', defaultEffort: 'default' })
    expect(source.resolveSpawnModel('gemini-3.8-flash')).toBe('gemini-3.8-flash')
    expect(source.spawnEnv({}, 'gemini-3.8-flash').ANTHROPIC_MODEL).toBe('gemini-3.8-flash')
    expect(mixed[3]!.supported_endpoint_types).toEqual(['gemini', 'openai'])
    await expect(factory('packy').setup!.validate({ api_key: key, custom_models: 'gemini-3.8-flash' })).resolves.toBeUndefined()
  })

  test('Gemini uses bounded native retries without changing the model, key or other models retry settings', async () => {
    const source = build('packy', { custom_models: 'gemini-3.8-flash' })
    await source.refreshModels()
    const base = { API_TIMEOUT_MS: '600000', CLAUDE_CODE_MAX_RETRIES: '7', CLAUDE_CODE_RETRY_WATCHDOG: '1' }
    const gemini = source.spawnEnv(base, 'gemini-3.8-flash')
    expect(gemini).toMatchObject({ ...PACKY_GEMINI_RETRY_ENV, ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_BASE_URL: 'https://cf.api.fan', ANTHROPIC_MODEL: 'gemini-3.8-flash' })
    const other = source.spawnEnv(base, 'MiniMax-M3')
    expect(other).toMatchObject(base)
    expect(other.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBeUndefined()
    expect(source.modelEnvironmentRevision!('gemini-3.8-flash')).not.toBe(source.modelEnvironmentRevision!('MiniMax-M3'))
    expect(source.modelEnvironmentRevision!('gemini-3.8-flash[1m]')).toBe(source.modelEnvironmentRevision!('gemini-3.8-flash'))
    expect(base).toEqual({ API_TIMEOUT_MS: '600000', CLAUDE_CODE_MAX_RETRIES: '7', CLAUDE_CODE_RETRY_WATCHDOG: '1' })
  })

  test('normalizes API roots, validates setup and rejects credential-bearing URLs', async () => {
    expect(packyApiRoot('https://cf.api.fan/v1/')).toBe('https://cf.api.fan')
    expect(packyManagementRoot('https://cf.api.fan/v1')).toBe('https://www.packyapi.ai')
    expect(packyManagementRoot('https://gateway.test/v1')).toBe('https://gateway.test')
    for (const url of ['https://user:pass@host.test', 'https://host.test?key=value', 'ftp://host.test']) {
      expect(() => packyApiRoot(url)).toThrow()
    }
    expect(factory('packy').setup!.parseArgs('https://cf.api.fan/v1 test-key')).toEqual({
      config: { agent: 'claude', base_url: 'https://cf.api.fan', api_key: 'test-key' },
    })
    respond = () => Response.json({ data: [mixed[3]] })
    await expect(factory('packy').setup!.validate({ api_key: key })).resolves.toBeUndefined()
    expect(factory('packy').setup!.parseArgs('https://cf.api.fan')).toHaveProperty('error')
  })
})

test('primary Claude and Codex share one stored credential while account 2 stays independent', () => {
  const cfg = { packy: { api_key: 'first', hidden_models: 'a' }, 'packy-secondary': { api_key: 'second' },
    'packy-codex': { model: 'kimi-k3', effort: 'high' } }
  const effective = sharedTokenSourceConfigs(cfg)
  expect(effective['packy-codex']).toMatchObject({ api_key: 'first', base_url: 'https://cf.api.fan', model: 'kimi-k3' })
  expect(effective['packy-secondary'].api_key).toBe('second')
  const updated = tokenSourceConfigUpdates(cfg, 'packy-codex', { api_key: 'rotated', base_url: 'https://gateway.test/v1' })
  expect(updated.packy).toMatchObject({ api_key: 'rotated', base_url: 'https://gateway.test', hidden_models: 'a' })
  expect(updated['packy-codex']).toEqual({ model: 'kimi-k3', effort: 'high' })
  expect(() => sharedTokenSourceConfigs({ packy: { api_key: 'a' }, 'packy-codex': { api_key: 'b' } })).toThrow('冲突')
})

describe('Packy quota', () => {
  test('unlimited token placeholders never become a fake account balance and reads share a cache', async () => {
    respond = () => Response.json({ code: true, data: { unlimited_quota: true, total_available: 500000 } })
    const [one, two] = await Promise.all([fetchPackyUsage('https://cf.api.fan', key), fetchPackyUsage('https://cf.api.fan/v1', key)])
    expect(one).toMatchObject({ state: 'not_applicable', kind: 'balance', reason: expect.stringContaining('不提供账户余额') })
    expect(one.balance).toBeUndefined()
    expect(two).toBe(one)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://www.packyapi.ai/api/usage/token/')
  })

  test('finite token quota uses the site unit and is labeled quota, not account balance', async () => {
    respond = url => url.endsWith('/api/status')
      ? Response.json({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } })
      : Response.json({ code: true, data: { unlimited_quota: false, total_available: 750000, total_granted: 1000000 } })
    expect(await fetchPackyUsage('https://cf.api.fan', key)).toMatchObject({ state: 'ok', kind: 'quota',
      quota: { remaining: 1.5, limit: 2, currency: 'USD' } })
    expect(requests[1]!.authorization).toBeNull()
  })

  test('missing units and authentication errors remain visible and redact the key', async () => {
    respond = () => Response.json({ error: { message: `denied ${key}` } }, { status: 403 })
    const result = await fetchPackyUsage('https://cf.api.fan', key)
    expect(result.state).toBe('no_credentials')
    expect(result.reason).toContain('403')
    expect(result.reason).not.toContain(key)
    respond = url => url.endsWith('/api/status') ? Response.json({ data: {} })
      : Response.json({ data: { unlimited_quota: false, total_available: 1, total_granted: 2 } })
    expect((await fetchPackyUsage('https://cf.api.fan', `${key}-units`)).state).toBe('network')
  })

  test('HTTP 200 business errors are not treated as a successful unlimited token', async () => {
    for (const code of [false, 500, '502']) {
      respond = () => Response.json({ code, message: 'upstream quota failure', data: { unlimited_quota: true } })
      const result = await fetchPackyUsage('https://cf.api.fan', `${key}-${code}`)
      expect(result.state).toBe('network')
      expect(result.reason).toContain('upstream quota failure')
    }
  })
})

describe('Packy real account balance', () => {
  const root = 'https://www.packyapi.ai'
  const userId = '123'
  const status = () => Response.json({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } })
  const balance = (quota = 49834851) => Response.json({ success: true, data: { id: 123, quota, used_quota: 665149 } })

  test('uses system authentication and the site unit, sharing concurrent and fresh reads', async () => {
    respond = (url, init) => {
      const headers = new Headers(init?.headers)
      if (url.endsWith('/api/status')) {
        expect(headers.has('authorization')).toBe(false)
        expect(headers.has('new-api-user')).toBe(false)
        return status()
      }
      expect(url).toBe(`${root}/api/user/self`)
      expect(headers.get('new-api-user')).toBe(userId)
      expect(headers.get('authorization')).toBe(`Bearer ${key}`)
      return balance()
    }
    const [one, two] = await Promise.all([fetchPackyBalance(root, key, userId), fetchPackyBalance(`${root}/`, key, userId)])
    expect(one).toMatchObject({ state: 'ok', kind: 'balance', balance: { remaining: 99.669702, currency: 'USD' } })
    expect(two).toBe(one)
    expect(await fetchPackyBalance(root, key, userId)).toBe(one)
    expect(requests).toHaveLength(2)
  })

  test('preserves zero and overdrawn balances, rejecting absent, mismatched or invalid account data', async () => {
    for (const quota of [0, -500000]) {
      respond = url => url.endsWith('/api/status') ? status() : balance(quota)
      expect((await fetchPackyBalance(root, `${key}-${quota}`, userId)).balance?.remaining).toBe(quota / 500000)
    }
    const invalid = [
      { success: true, data: { id: 456, quota: 500000 } },
      { success: true, data: { id: 123 } },
      { success: true, data: { id: 123, quota: '500000' } },
      { success: true, data: { id: 123, quota: 0.5 } },
      { success: true, data: { id: 123, quota: Number.MAX_SAFE_INTEGER + 1 } },
      { data: { id: 123, quota: 500000 } },
      { success: false, message: 'access token rejected', data: { id: 123, quota: 500000 } },
    ]
    for (let i = 0; i < invalid.length; i++) {
      respond = () => Response.json(invalid[i])
      const result = await fetchPackyBalance(root, `${key}-bad-${i}`, userId)
      expect(result.state).toBe('network')
      expect(result.balance).toBeUndefined()
      expect(result.reason).toBeTruthy()
    }
    for (const unit of [{}, { quota_per_unit: 0, quota_display_type: 'USD' }, { quota_per_unit: 500000, quota_display_type: 'CNY' }]) {
      respond = url => url.endsWith('/api/status') ? Response.json({ data: unit }) : balance()
      expect((await fetchPackyBalance(root, `${key}-${JSON.stringify(unit)}`, userId)).state).toBe('network')
    }
  })

  test('missing system credentials do not query or substitute model-token quota', async () => {
    for (const user of ['', '0', 'NaN', '1.1', '9007199254740992']) {
      expect((await fetchPackyBalance(root, key, user)).state).toBe('no_credentials')
    }
    expect((await fetchPackyBalance(root, '', userId)).state).toBe('no_credentials')
    const source = build('packy', { management_user_id: userId })
    expect((await source.readUsage()).state).toBe('no_credentials')
    expect(requests).toHaveLength(0)
  })

  test('management redirects never send the system token to another endpoint', async () => {
    respond = () => new Response(null, { status: 302, headers: { Location: 'https://other.test/api/user/self' } })
    const result = await fetchPackyBalance(root, key, userId)
    expect(result).toMatchObject({ state: 'network', reason: expect.stringContaining('redirect rejected') })
    expect(requests).toHaveLength(1)
  })

  test('failed refresh keeps success visible, respects Retry-After, redacts tokens and allows rotation', async () => {
    const originalNow = Date.now
    let now = originalNow()
    Date.now = () => now
    try {
      respond = url => url.endsWith('/api/status') ? status() : balance()
      const cached = await fetchPackyBalance(root, key, userId)
      expect(cached.state).toBe('ok')
      now += 60000
      respond = () => Response.json({ message: `rate limited ${key}` }, { status: 429, headers: { 'Retry-After': '300' } })
      const failed = await fetchPackyBalance(root, key, userId)
      expect(failed).toBe(cached)
      expect(failed.state).toBe('ok')
      const count = requests.length
      now += 299999
      expect(await fetchPackyBalance(root, key, userId)).toBe(failed)
      expect(requests).toHaveLength(count)
      now++
      respond = () => Response.json({ message: `denied ${key}` }, { status: 403 })
      expect((await fetchPackyBalance(root, key, userId)).state).toBe('no_credentials')
      respond = url => url.endsWith('/api/status') ? status() : balance()
      expect((await fetchPackyBalance(root, `${key}-rotated`, userId)).state).toBe('ok')
      expect(requests.some(request => request.url.includes('/usage/token'))).toBe(false)
    } finally { Date.now = originalNow }
  })

  test('setup validates again instead of trusting a cached successful credential', async () => {
    respond = url => url.endsWith('/api/status') ? status() : balance()
    const setup = factory('packy').usageSetup!
    const parsed = setup.parseArgs(`${userId} ${key}`)
    expect('config' in parsed).toBe(true)
    if (!('config' in parsed)) throw new Error('invalid test arguments')
    await setup.validate(parsed.config)
    respond = () => Response.json({ message: `expired ${key}` }, { status: 401 })
    await expect(setup.validate(parsed.config)).rejects.toThrow('401')
    expect(requests).toHaveLength(3)
    expect('error' in setup.parseArgs(`not-an-id ${key}`)).toBe(true)
    expect('error' in setup.parseArgs('share packy')).toBe(true)
  })

  test('billing references preserve separate model keys, management origin and process identity', async () => {
    const { tokenSourceSpawnRevision } = await import('./token-source-builtins')
    const cfg = { packy: { api_key: 'model-one', base_url: 'https://gateway.test/v1', management_token: key, management_user_id: userId },
      'packy-secondary': { api_key: 'model-two', base_url: 'https://different.test', billing_source: 'packy' } }
    const effective = sharedTokenSourceConfigs(cfg)
    const primary = factory('packy').build(effective.packy)
    const secondary = factory('packy-secondary').build(effective['packy-secondary'])
    const codex = factory('packy-codex').build(effective['packy-codex'])
    expect(primary.usageAccount).toEqual(secondary.usageAccount)
    expect(primary.usageAccount).toEqual(codex.usageAccount)
    respond = url => url.endsWith('/api/status') ? status() : balance()
    const values = await Promise.all([primary.readUsage(), secondary.readUsage(), codex.readUsage()])
    expect(values.every(value => value === values[0])).toBe(true)
    expect(requests.map(r => r.url)).toEqual(['https://gateway.test/api/user/self', 'https://gateway.test/api/status'])
    expect(secondary.spawnEnv({}, 'qwen-test').ANTHROPIC_AUTH_TOKEN).toBe('model-two')
    expect(codex.spawnEnv({}, 'kimi-test')[PACKY_CODEX_KEY_ENV]).toBe('model-one')
    for (const source of [primary, secondary, codex]) expect(Object.values(source.spawnEnv({}, 'test-model'))).not.toContain(key)
    expect(tokenSourceSpawnRevision('packy', cfg.packy, null)).toBe(tokenSourceSpawnRevision('packy', {
      ...cfg.packy, management_token: 'new-balance-token', management_user_id: '456', management_url: 'https://management.test',
    }, null))
    expect(packyManagementRoot('https://cf.api.fan:8443')).toBe('https://cf.api.fan:8443')
  })

  test('unknown, circular or contradictory billing references fail visibly', async () => {
    expect(() => sharedTokenSourceConfigs({ packy: { billing_source: 'openrouter' } })).toThrow('不存在')
    expect(() => sharedTokenSourceConfigs({ packy: { billing_source: 'packy-secondary' },
      'packy-secondary': { billing_source: 'packy' } })).toThrow('循环')
    expect(() => sharedTokenSourceConfigs({ packy: { billing_source: 'packy-codex' } })).toThrow('循环')
    expect(() => sharedTokenSourceConfigs({ 'packy-secondary': { billing_source: 'packy', management_token: 'other' } })).toThrow('同时配置')
    const effective = sharedTokenSourceConfigs({ 'packy-secondary': { api_key: key, billing_source: 'packy' } })
    await expect(factory('packy-secondary').build(effective['packy-secondary']).readUsage()).resolves.toMatchObject({ state: 'no_credentials' })
  })
})
