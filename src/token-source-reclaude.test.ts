import { afterEach, describe, expect, test } from 'bun:test'
import type { TokenSourceConfig } from './config'
import type { ReclaudeStatus } from './reclaude'
import { tokenSourceFactories, tokenSourceProcessRevision, type TokenSource, type TokenSourceModel } from './token-source'
import { cachedTokenSource, disposeCachedTokenSource, refreshTokenSourceUsage } from './token-source-cache'
import { reclaudeRuntime, resetReclaudeState } from './token-source-reclaude'
import { withModelVisibility } from './token-source-visibility'

const factory = tokenSourceFactories().find(def => def.kind === 'reclaude')!
const original = { ...reclaudeRuntime }
afterEach(() => {
  Object.assign(reclaudeRuntime, original)
  resetReclaudeState()
})

const CATALOG: TokenSourceModel[] = [
  { model: 'opus', display: 'Opus', efforts: ['high', 'max'], defaultEffort: 'max' },
  { model: 'haiku', display: 'Haiku', efforts: ['high'], defaultEffort: 'high' },
]

const status = (overrides: Partial<ReclaudeStatus> = {}): ReclaudeStatus => {
  const bindings = [
    { orgId: '7', deviceId: '101', configDir: '/rec/claude/accounts/101/config' },
    { orgId: '9', deviceId: '202', configDir: '/rec/claude/accounts/202/config' },
  ]
  return { loginState: 'valid', bindings, current: bindings[0]!, ...overrides }
}

/** Native `/usage` control response as it comes back through the launcher. */
const usagePayload = {
  subscription_type: 'team', rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 15, resets_at: '2099-01-01T05:00:00+00:00' },
    seven_day: { utilization: 33, resets_at: '2099-01-06T00:00:00+00:00' },
    model_scoped: [{ display_name: 'Fable', utilization: 64, resets_at: '2099-01-06T00:00:00+00:00' }],
  },
}

type ModelOptions = Parameters<typeof reclaudeRuntime.models>[0]

function install(options: {
  status?: ReclaudeStatus | Error
  catalog?: TokenSourceModel[]
  usage?: unknown | Error
  ready?: boolean
} = {}): { calls: ModelOptions[] } {
  const calls: ModelOptions[] = []
  reclaudeRuntime.find = () => '/opt/reclaude'
  reclaudeRuntime.status = async () => {
    if (options.status instanceof Error) throw options.status
    return options.status ?? status()
  }
  reclaudeRuntime.bindingReady = () => options.ready ?? true
  reclaudeRuntime.models = async (spawn = {}) => {
    calls.push(spawn)
    await spawn.afterCatalog?.({
      readSubscriptionUsage: async () => {
        if (options.usage instanceof Error) throw options.usage
        return options.usage ?? usagePayload
      },
    })
    return (options.catalog ?? CATALOG).map(model => ({ ...model, efforts: [...model.efforts] }))
  }
  return { calls }
}

const build = (cfg: TokenSourceConfig = {}): TokenSource => factory.build(cfg)

describe('reclaude token source', () => {
  test('is listed but disabled when the command is not installed', async () => {
    reclaudeRuntime.find = () => null
    const source = build()
    expect(source).toMatchObject({ id: 'reclaude', kind: 'reclaude', agent: 'claude', display: 'reclaude', enabled: false })
    expect(source.modelCatalogState).toMatchObject({ status: 'disabled' })
    expect(source.modelCatalogState!.error).toContain('未检测到 reclaude 命令')
    await source.refreshModels()
    expect(source.enabled).toBe(false)
    expect(source.modelCatalogState!.status).toBe('disabled')
    expect(await source.readUsage()).toMatchObject({ state: 'not_applicable', windows: [] })
  })

  test('a config switch disables it without looking for the command', () => {
    let searched = false
    reclaudeRuntime.find = () => { searched = true; return '/opt/reclaude' }
    const source = build({ enabled: false })
    expect(searched).toBe(false)
    expect(source.enabled).toBe(false)
    expect(source.modelCatalogState!.error).toContain('已在 Lodestar 中禁用')
  })

  test('a configured path that does not exist is reported, not replaced by a PATH lookup', () => {
    reclaudeRuntime.find = () => { throw new Error('[token_source.reclaude].bin 指向的文件不存在: /nope') }
    const source = build({ bin: '/nope' })
    expect(source.enabled).toBe(false)
    expect(source.modelCatalogState!.error).toBe('[token_source.reclaude].bin 指向的文件不存在: /nope')
  })

  test('loads the catalog and the quota through one launcher process bound to the current organisation', async () => {
    const { calls } = install()
    const source = build()
    expect(source.enabled).toBe(true)
    expect(source.modelCatalogState!.status).toBe('idle')
    expect(() => source.spawnEnv({})).toThrow('reclaude 组织绑定尚未就绪')

    await source.refreshModels()
    expect(source.modelCatalogState).toMatchObject({ status: 'ready' })
    expect(source.models.map(model => model.model)).toEqual(['opus', 'haiku'])
    expect(source.defaultModel).toBe('opus')
    expect(source.claudeLauncher).toEqual({ command: '/opt/reclaude', args: ['--org', '7', 'cli'], diagnosticPrefix: 'reclaude:' })
    // Conversations of this source live under the binding, not in the store other sources share.
    expect(source.claudeHistoryDir).toBe('/rec/claude/accounts/101/config')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.launcher).toBe(source.claudeLauncher)
    expect(calls[0]!.tokenSourceId).toBe('reclaude')

    // Other sources' credentials never reach the launcher; the binding's directory is explicit.
    const { PATH, ...env } = source.spawnEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://example.invalid',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/x', KEEP: '1', PATH: '/opt/tools' })
    expect(env).toEqual({ KEEP: '1', CLAUDE_CONFIG_DIR: '/rec/claude/accounts/101/config' })
    // reclaude reads the system proxy with system tools; a service manager's PATH may lack them.
    if (process.platform !== 'win32') expect(PATH).toBe('/opt/tools:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
    expect(calls[0]!.transformEnv!({ ANTHROPIC_AUTH_TOKEN: 't' }).CLAUDE_CONFIG_DIR).toBe('/rec/claude/accounts/101/config')
    expect('ANTHROPIC_AUTH_TOKEN' in calls[0]!.transformEnv!({ ANTHROPIC_AUTH_TOKEN: 't' })).toBe(false)

    const usage = await source.readUsage()
    expect(usage.state).toBe('ok')
    expect(usage.windows.map(window => [window.kind, window.percent])).toEqual([['fiveHour', 15], ['weekly', 33], ['modelWeekly:Fable', 64]])
  })

  test('a configured organisation pins the binding; switching organisation changes the process identity', async () => {
    install()
    const pinned = build({ org: '9' })
    await pinned.refreshModels()
    expect(pinned.claudeLauncher!.args).toEqual(['--org', '9', 'cli'])
    expect(pinned.spawnEnv({}).CLAUDE_CONFIG_DIR).toBe('/rec/claude/accounts/202/config')

    const followed = build()
    await followed.refreshModels()
    expect(tokenSourceProcessRevision(followed, 'opus')).not.toBe(tokenSourceProcessRevision(pinned, 'opus'))
  })

  test.each([
    ['login expired', status({ loginState: 'expired' }), {}, 'reclaude 未登录或登录已失效'],
    ['login could not be checked', status({ loginState: 'unavailable', loginDetail: 'Online check timed out' }), {},
      'reclaude 暂时无法确认登录状态（Online check timed out）'],
    ['organisation not bound', status(), { org: '42' }, 'reclaude 尚未绑定组织 42'],
    ['no current organisation', status({ current: null }), {}, 'reclaude 没有当前组织'],
    ['status query failed', new Error('reclaude status 查询失败：退出码 1'), {}, 'reclaude status 查询失败：退出码 1'],
  ] as const)('%s leaves the source failed with the reason and starts no process', async (_name, state, cfg, reason) => {
    const { calls } = install({ status: state })
    const source = build(cfg)
    await source.refreshModels()
    expect(source.modelCatalogState!.status).toBe('failed')
    expect(source.modelCatalogState!.error).toContain(reason)
    expect(source.models).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('a binding whose directory is missing is not used', async () => {
    const { calls } = install({ ready: false })
    const source = build()
    await source.refreshModels()
    expect(source.modelCatalogState!.error).toContain('配置目录不存在')
    expect(calls).toHaveLength(0)
  })

  test('a failed quota read keeps the catalog and reports the quota as missing', async () => {
    install({ usage: new Error('usage endpoint closed') })
    const source = build()
    await source.refreshModels()
    expect(source.modelCatalogState!.status).toBe('ready')
    expect(await source.readUsage()).toEqual({ state: 'network', windows: [], reason: 'usage endpoint closed' })
  })

  test('the quota is pending until the first catalog refresh', async () => {
    install()
    expect(await build().readUsage()).toMatchObject({ state: 'network', reason: '额度缓存尚未就绪，后台刷新中' })
  })

  test('configured default model and effort are validated against the catalog', async () => {
    install()
    const configured = build({ model: 'haiku', effort: 'high' })
    await configured.refreshModels()
    expect(configured.defaultModel).toBe('haiku')
    expect(configured.models.find(model => model.model === 'haiku')!.defaultEffort).toBe('high')

    const unknown = build({ model: 'sonnet' })
    await unknown.refreshModels()
    expect(unknown.modelCatalogState).toMatchObject({ status: 'failed', error: 'reclaude 默认模型不在目录中且未补录: sonnet' })

    const custom = build({ model: 'sonnet', custom_models: 'sonnet' })
    await custom.refreshModels()
    expect(custom.modelCatalogState!.status).toBe('ready')
    expect(custom.defaultModel).toBe('sonnet')

    const effort = build({ model: 'haiku', effort: 'max' })
    await effort.refreshModels()
    expect(effort.modelCatalogState!.error).toBe('reclaude 默认模型不支持 effort: max')
  })

  test('an empty catalog is a failure', async () => {
    install({ catalog: [] })
    const source = build()
    await source.refreshModels()
    expect(source.modelCatalogState).toMatchObject({ status: 'failed', error: 'reclaude 模型目录为空' })
  })
})

test('the published source carries the launcher, binding and quota of its last refresh', async () => {
  let current = '7'
  install()
  const bindings = status().bindings
  reclaudeRuntime.status = async () => status({ current: bindings.find(item => item.orgId === current)! })
  const cfg: TokenSourceConfig = { hidden_models: 'haiku' }
  const published = cachedTokenSource(() => withModelVisibility(build(cfg), cfg), cfg, 'reclaude-facade-test', 'same')
  try {
    expect(published.claudeLauncher).toBeUndefined()
    await published.refreshModels()
    expect(published.modelCatalogState!.status).toBe('ready')
    expect(published.models.map(model => model.model)).toEqual(['opus'])
    expect(published.claudeLauncher!.args).toEqual(['--org', '7', 'cli'])
    expect(published.spawnEnv({}).CLAUDE_CONFIG_DIR).toBe('/rec/claude/accounts/101/config')
    await refreshTokenSourceUsage(published)
    expect((await published.readUsage()).state).toBe('ok')
    const before = tokenSourceProcessRevision(published, 'opus')

    // `reclaude org use 9`: the next refresh rebinds, and an idle process no longer matches.
    current = '9'
    await published.refreshModels()
    expect(published.claudeLauncher!.args).toEqual(['--org', '9', 'cli'])
    expect(published.spawnEnv({}).CLAUDE_CONFIG_DIR).toBe('/rec/claude/accounts/202/config')
    expect(published.claudeHistoryDir).toBe('/rec/claude/accounts/202/config')
    expect(tokenSourceProcessRevision(published, 'opus')).not.toBe(before)
  } finally {
    disposeCachedTokenSource(published)
  }
})

test('a config edit between refreshes keeps the source startable', async () => {
  install()
  const first: TokenSourceConfig = {}
  const before = cachedTokenSource(() => withModelVisibility(build(first), first), first, 'reclaude-reload', 'config-1')
  // Hiding a model in md rebuilds the registry: same identity, new configuration, no refresh yet.
  const edited: TokenSourceConfig = { hidden_models: 'haiku' }
  let after: TokenSource | undefined
  try {
    await before.refreshModels()
    await refreshTokenSourceUsage(before)
    const revision = tokenSourceProcessRevision(before, 'opus')
    let statusCalls = 0
    reclaudeRuntime.status = async () => { statusCalls++; return status() }

    after = cachedTokenSource(() => withModelVisibility(build(edited), edited), edited, 'reclaude-reload', 'config-2', before)
    expect(statusCalls).toBe(0)
    expect(after.modelCatalogState!.status).toBe('ready')
    expect(after.models.map(model => model.model)).toEqual(['opus'])
    expect(after.claudeLauncher).toEqual(before.claudeLauncher!)
    expect(after.claudeHistoryDir).toBe('/rec/claude/accounts/101/config')
    expect(after.spawnEnv({}).CLAUDE_CONFIG_DIR).toBe('/rec/claude/accounts/101/config')
    // An idle process started before the edit still matches: nothing about its launch changed.
    expect(tokenSourceProcessRevision(after, 'opus')).toBe(revision)
    expect((await after.readUsage()).state).toBe('ok')
  } finally {
    disposeCachedTokenSource(before)
    if (after) disposeCachedTokenSource(after)
  }
})

test('a failed refresh reports its reason as the quota state instead of staying pending', async () => {
  install({ status: new Error('reclaude status 查询失败：退出码 1') })
  const failed = build()
  await failed.refreshModels()
  expect(await failed.readUsage()).toEqual({ state: 'network', windows: [], reason: 'reclaude status 查询失败：退出码 1' })

  // Login lost after the source was ready: the published quota names the login, not "loading".
  install()
  const published = cachedTokenSource(() => withModelVisibility(build(), {}), {}, 'reclaude-login-lost', 'same')
  try {
    await published.refreshModels()
    await refreshTokenSourceUsage(published)
    expect((await published.readUsage()).state).toBe('ok')
    reclaudeRuntime.status = async () => status({ loginState: 'expired' })
    await published.refreshModels().catch(() => {})
    await refreshTokenSourceUsage(published).catch(() => {})
    const usage = await published.readUsage()
    expect(usage.state).toBe('no_credentials')
    expect(usage.reason).toContain('reclaude 未登录或登录已失效')
    expect(published.modelCatalogState!.status).toBe('failed')
  } finally {
    disposeCachedTokenSource(published)
  }
})

test('installing or removing the command later is picked up by the next catalog refresh, without a restart', async () => {
  install()
  reclaudeRuntime.find = () => null
  const published = cachedTokenSource(() => withModelVisibility(build(), {}), {}, 'reclaude-install-later', 'same')
  try {
    await published.refreshModels()
    expect(published.enabled).toBe(false)
    expect(published.modelCatalogState!.status).toBe('disabled')

    reclaudeRuntime.find = () => '/opt/reclaude'
    await published.refreshModels()
    expect(published.enabled).toBe(true)
    expect(published.modelCatalogState!.status).toBe('ready')
    expect(published.claudeLauncher!.command).toBe('/opt/reclaude')

    reclaudeRuntime.find = () => null
    await published.refreshModels()
    expect(published.enabled).toBe(false)
    expect(published.modelCatalogState!.error).toContain('未检测到 reclaude 命令')
  } finally {
    disposeCachedTokenSource(published)
  }
})

test('the registry lists reclaude for md, reads its organisation from config and explains why it is unavailable', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { appendFileSync } from 'node:fs'
    const { sentTexts } = await import('./src/feishu-test-mock')
    const { CONFIG_FILE } = await import('./src/paths')
    const { reloadTokenSources } = await import('./src/config')
    const registry = await import('./src/token-source')
    const { reclaudeRuntime } = await import('./src/token-source-reclaude')
    const { buildTokenSourcesFromConfig } = await import('./src/token-source-builtins')
    const { onTokenSourceEnable } = await import('./src/token-source-setup')
    const session = { chatId: 'test-chat' }

    // Not installed: still listed under Claude Code, with the reason behind the enable button.
    buildTokenSourcesFromConfig()
    let source = registry.getTokenSource('reclaude')
    assert.equal(source.agent, 'claude'); assert.equal(source.kind, 'reclaude'); assert.equal(source.enabled, false)
    assert.ok(registry.listTokenSourcesByAgent('claude').includes(source))
    await onTokenSourceEnable(session, 'reclaude')
    assert.match(sentTexts.at(-1), /^reclaude 当前不可用：未检测到 reclaude 命令/)

    // Installed, with an organisation and a path in config.toml.
    const seen = []
    reclaudeRuntime.find = bin => { seen.push(bin); return '/opt/reclaude' }
    const bindings = [{ orgId: '7', deviceId: '101', configDir: '/rec/101' }, { orgId: '9', deviceId: '202', configDir: '/rec/202' }]
    reclaudeRuntime.status = async () => ({ loginState: 'valid', bindings, current: bindings[0] })
    reclaudeRuntime.bindingReady = () => true
    reclaudeRuntime.models = async options => {
      await options.afterCatalog({ readSubscriptionUsage: async () => { throw new Error('quota closed') } })
      return [{ model: 'opus', display: 'Opus', efforts: ['high'], defaultEffort: 'high' }]
    }
    appendFileSync(CONFIG_FILE, '\\n[token_source.reclaude]\\nbin = "/custom/reclaude"\\norg = "9"\\ndisplay = "团队 Claude"\\n')
    reloadTokenSources()
    buildTokenSourcesFromConfig()
    source = registry.getTokenSource('reclaude')
    assert.ok(seen.length > 0 && seen.every(bin => bin === '/custom/reclaude'))
    assert.equal(source.enabled, true); assert.equal(source.display, '团队 Claude')
    await source.refreshModels()
    assert.equal(source.modelCatalogState.status, 'ready')
    assert.deepEqual(source.claudeLauncher.args, ['--org', '9', 'cli'])
    assert.equal(source.spawnEnv({}).CLAUDE_CONFIG_DIR, '/rec/202')
    await onTokenSourceEnable(session, 'reclaude')
    assert.match(sentTexts.at(-1), /已启用/)

    // A login that expired later shows the reason and what to run.
    reclaudeRuntime.status = async () => ({ loginState: 'expired', bindings, current: bindings[0] })
    await source.refreshModels().catch(() => {})
    await onTokenSourceEnable(session, 'reclaude')
    assert.match(sentTexts.at(-1), /reclaude 未登录或登录已失效；请在运行 Lodestar 的本机执行 reclaude login/)
    process.exit(0)
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
