import { describe, expect, test } from 'bun:test'
import { agentIdentityId, buildAgentIdentityCatalog, buildAgentSkillIdentityCatalog } from './agent-identities'
import type { TokenSource, UsageSnapshotUnified } from './token-source'
import { cachedTokenSource, disposeCachedTokenSource, refreshTokenSourceUsage } from './token-source-cache'

function source(overrides: Partial<TokenSource> = {}): TokenSource {
  return {
    id: 'glm', kind: 'glm', agent: 'claude', display: 'GLM', enabled: true,
    models: [
      { model: 'GLM-5.3', display: 'GLM-5.3', efforts: ['low', 'max'], defaultEffort: 'max' },
      { model: 'GLM-Air', display: 'GLM-Air', efforts: ['low', 'medium'], defaultEffort: 'medium' },
    ],
    defaultModel: 'GLM-5.3',
    refreshModels: async () => {},
    spawnEnv: env => env,
    resolveSpawnModel: model => model,
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    modelCatalogState: { status: 'ready', updatedAt: Date.now() },
    ...overrides,
  }
}

describe('Agent identity catalog', () => {
  test('exposes every model with its real default effort instead of forcing max', () => {
    const catalog = buildAgentIdentityCatalog([source()])
    expect(catalog.identities).toHaveLength(2)
    expect(catalog.identities[1]).toMatchObject({
      id: agentIdentityId('glm', 'GLM-Air'), defaultEffort: 'medium', status: 'ready',
    })
  })

  test('keeps disabled models visible but uncallable', () => {
    const catalog = buildAgentIdentityCatalog([source({ enabled: false, modelCatalogState: { status: 'disabled', updatedAt: 1 } })])
    expect(catalog.identities.every(identity => identity.status === 'source_disabled')).toBe(true)
    expect(catalog.sourceFailures[0].status).toBe('disabled')
  })

  test('keeps missing effort visible and uncallable without a fabricated default', () => {
    const catalog = buildAgentIdentityCatalog([source({
      models: [{ model: 'missing-effort', display: 'Missing effort', efforts: [], defaultEffort: null }],
    })])
    expect(catalog.identities[0]).toMatchObject({
      status: 'model_unavailable', defaultEffort: null, supportedEfforts: [], reason: expect.stringContaining('MISS'),
    })
  })
})

describe('Agent skill subscription availability', () => {
  test('removes unavailable subscriptions only from skill results and keeps the failure visible', async () => {
    let checks = 0
    const subscription = source({
      id: 'claude-sub', kind: 'claude-subscription', display: 'Claude Code 订阅',
      readUsage: async () => {
        checks++
        return { state: 'network', windows: [], reason: 'Claude 原生额度接口未返回 rate_limits 数据' }
      },
    })
    const other = source({ readUsage: async () => { throw new Error('must not query third-party usage') } })
    const models = subscription.models
    const sources = [subscription, other]
    const before = buildAgentIdentityCatalog(sources)
    const catalog = await buildAgentSkillIdentityCatalog(sources)

    expect(checks).toBe(1)
    expect(catalog.identities).toEqual(before.identities.filter(identity => identity.tokenSourceId === other.id))
    expect(catalog.sourceFailures).toEqual([{
      tokenSourceId: subscription.id, display: subscription.display, status: 'failed',
      reason: 'Claude 原生额度接口未返回 rate_limits 数据',
    }])
    expect(catalog.catalogGeneration).not.toBe(before.catalogGeneration)
    expect(buildAgentIdentityCatalog(sources)).toEqual(before)
    expect(subscription.models).toBe(models)
    expect(subscription.enabled).toBe(true)
    expect(subscription.modelCatalogState?.status).toBe('ready')
  })

  test('availability follows the shared usage cache without a second thirty-minute cache', async () => {
    let usage: UsageSnapshotUnified = { state: 'ok', windows: [] }
    const subscription = source({ id: 'claude-sub', kind: 'claude-subscription', readUsage: async () => usage })
    const ready = await buildAgentSkillIdentityCatalog([subscription])
    usage = { state: 'no_credentials', windows: [], reason: 'subscription expired' }
    const failed = await buildAgentSkillIdentityCatalog([subscription])
    expect(failed.identities).toEqual([])
    expect(failed.sourceFailures[0]?.reason).toBe('subscription expired')
    usage = { state: 'ok', windows: [] }
    expect(await buildAgentSkillIdentityCatalog([subscription])).toEqual(ready)
  })

  test('surfaces thrown availability errors without dropping other sources', async () => {
    let checks = 0
    const subscription = source({
      id: 'claude-sub', kind: 'claude-subscription',
      readUsage: async () => { checks++; throw new Error('subscription query timed out') },
    })
    const sources = [subscription, source()]
    const catalog = await buildAgentSkillIdentityCatalog(sources)
    expect(catalog.identities).toHaveLength(2)
    expect(catalog.sourceFailures).toMatchObject([{
      tokenSourceId: 'claude-sub', status: 'failed', reason: 'subscription query timed out',
    }])
    expect(await buildAgentSkillIdentityCatalog(sources)).toEqual(catalog)
    expect(checks).toBe(2)
  })

  test('identity discovery responds from cache while subscription refresh is blocked', async () => {
    let checks = 0
    let finish!: () => void
    let barrier = Promise.resolve()
    const subscription = cachedTokenSource(() => source({ id: 'claude-sub', kind: 'claude-subscription',
      readUsage: async () => { checks++; await barrier; return { state: 'ok', windows: [] } },
    }), {}, 'identity-cache-test', 'identity-cache-test')
    try {
      await refreshTokenSourceUsage(subscription)
      barrier = new Promise(resolve => { finish = resolve })
      const refreshing = refreshTokenSourceUsage(subscription)
      const catalogs = await Promise.all([buildAgentSkillIdentityCatalog([subscription]), buildAgentSkillIdentityCatalog([subscription])])
      expect(catalogs[0].identities).toHaveLength(2)
      expect(catalogs[1]).toEqual(catalogs[0])
      expect(checks).toBe(2)
      finish()
      await refreshing
    } finally { finish?.(); disposeCachedTokenSource(subscription) }
  })

  test('caches only availability and does not retain an old model list', async () => {
    let checks = 0
    const subscription = source({
      id: 'claude-sub', kind: 'claude-subscription',
      readUsage: async () => { checks++; return { state: 'ok', windows: [] } },
    })
    const first = await buildAgentSkillIdentityCatalog([subscription])
    subscription.models = [subscription.models[1]!]
    const updated = await buildAgentSkillIdentityCatalog([subscription])
    expect(updated.identities).toEqual([first.identities[1]!])
    expect(updated.catalogGeneration).not.toBe(first.catalogGeneration)
    expect(checks).toBe(2)
  })

  test('rebuilt sources do not reuse an earlier subscription check with the same source id', async () => {
    const original = source({
      id: 'claude-sub', kind: 'claude-subscription',
      readUsage: async () => ({ state: 'no_credentials', windows: [], reason: 'old subscription expired' }),
    })
    expect((await buildAgentSkillIdentityCatalog([original])).identities).toEqual([])
    let checks = 0
    const rebuilt = { ...original, readUsage: async (): Promise<UsageSnapshotUnified> => {
      checks++
      return { state: 'ok', windows: [] }
    } }
    expect((await buildAgentSkillIdentityCatalog([rebuilt])).identities).toHaveLength(2)
    expect(checks).toBe(1)
  })

  test('removes subscriptions with catalog failures while preserving their diagnostics', async () => {
    for (const status of ['disabled', 'loading', 'failed'] as const) {
      let checks = 0
      const subscription = source({
        id: 'claude-sub', kind: 'claude-subscription', enabled: status !== 'disabled',
        modelCatalogState: { status, updatedAt: 1, ...(status === 'failed' ? { error: 'catalog failed' } : {}) },
        readUsage: async () => { checks++; return { state: 'ok', windows: [] } },
      })
      const before = buildAgentIdentityCatalog([subscription])
      const catalog = await buildAgentSkillIdentityCatalog([subscription])
      expect(catalog.identities).toEqual([])
      expect(catalog.sourceFailures).toEqual(before.sourceFailures)
      expect(checks).toBe(0)
    }
  })
})
