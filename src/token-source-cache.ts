import { BackgroundRefresh } from './background-refresh'
import type { TokenSourceConfig } from './config'
import { codexAccounts, DEFAULT_CODEX_ACCOUNT } from './codex-accounts'
import { customModelEfforts, modelList } from './token-source-visibility'
import type { TokenSource, TokenSourceModel, UsageSnapshotUnified } from './token-source'
import { invalidateCodexUsage, peekUsage } from './usage'
import { codexUsageToUnified } from './token-source-codex'
import { isUsageAuthError } from './usage-cache'

export const MODEL_REFRESH_MS = 5 * 60_000
const USAGE_REFRESH_MS = 60_000
const metadata = new WeakMap<TokenSource, CachedSource>()
const modelLoads = new Map<string, { configuration: string; promise: Promise<{ source: TokenSource; error?: unknown }> }>()

interface CachedSource {
  baseIdentity: string
  identity: string
  configuration: string
  model: BackgroundRefresh
  usage: BackgroundRefresh
  snapshot(): UsageSnapshotUnified | undefined
  children: Map<string, { revision: string; source: TokenSource }>
  active(): boolean
  dispose(): void
}

/** Reapply local visibility/custom choices to the same account's cached upstream catalog. */
function restoreCatalog(source: TokenSource, previous: TokenSource, cfg: TokenSourceConfig): void {
  if (!source.enabled || previous.modelCatalogState?.status !== 'ready') return
  const selection = source.modelSelection
  const upstream = (previous.modelSelection?.availableModels ?? previous.models)
    .filter(model => model.origin !== 'custom').map(model => ({ ...model, efforts: [...model.efforts] }))
  const custom = [...new Set([...modelList(cfg.custom_models),
    ...(selection?.mode === 'catalog' || source.kind.startsWith('packy') ? modelList(cfg.models) : [])])]
  const catalog: TokenSourceModel[] = [...upstream]
  for (const id of custom) {
    if (!catalog.some(model => model.model.toLowerCase() === id.toLowerCase())) {
      const old = previous.modelSelection?.availableModels.find(model => model.model === id)
      catalog.push(old ? { ...old, efforts: [...old.efforts] }
        : { model: id, display: id, origin: 'custom', ...customModelEfforts(source, cfg) })
    }
  }
  const hidden = new Set(modelList(cfg.hidden_models))
  const ids = cfg.models !== undefined ? modelList(cfg.models)
    : selection?.modelIds.length ? selection.modelIds : previous.modelSelection?.modelIds ?? []
  const visible = selection?.mode === 'allowlist'
    ? ids.map(id => {
      const key = source.agent === 'claude' ? id.replace(/\[1m\]$/, '') : id
      const entry = catalog.find(model => model.model === key) ?? previous.models.find(model => model.model === id)
      return entry ? { ...entry, model: id } : { model: id, display: id, efforts: [], defaultEffort: null,
        unavailableReason: '账号目录缓存未返回该模型' }
    })
      .filter((model): model is TokenSourceModel => !!model)
    : catalog.filter(model => model.origin === 'custom' || !hidden.has(model.model))
  source.models = [...visible, ...catalog.filter(model => model.origin === 'custom' && !visible.some(item => item.model === model.model))]
  if (selection) {
    selection.availableModels = catalog
    selection.modelIds = source.models.map(model => model.model)
  }
  source.defaultModel = cfg.model?.trim() || (catalog.some(model => model.model === previous.defaultModel)
    ? previous.defaultModel : source.models[0]?.model ?? '')
  source.modelCatalogState = { ...previous.modelCatalogState }
}

/** Only this facade is published. Refreshes mutate a private factory instance and commit once. */
export function cachedTokenSource(
  create: () => TokenSource, cfg: TokenSourceConfig, baseIdentity: string, configuration: string,
  previous?: TokenSource, accountId?: string,
): TokenSource {
  const old = previous && metadata.get(previous)
  let committed = create()
  const identity = committed.kind === 'codex-subscription'
    ? `${baseIdentity}:${codexAccounts.revision(accountId ?? DEFAULT_CODEX_ACCOUNT)}` : baseIdentity
  if (old?.active() && old.configuration === configuration && old.identity === identity) return previous!
  if (old?.identity === identity) restoreCatalog(committed, previous!, cfg)
  const source: TokenSource = { ...committed }
  let active = true
  let usageSnapshot = old?.identity === identity ? old.snapshot() : undefined
  const children: CachedSource['children'] = new Map()

  const publish = (next: TokenSource): void => {
    committed = next
    // Keep the facade's lifecycle methods; all other closures belong to the committed instance.
    const { refreshModels: _refresh, readUsage: _usage, forAccount: _accounts, ...snapshot } = next
    Object.assign(source, snapshot)
  }
  const model = new BackgroundRefresh(`token-source ${source.id}${accountId ? `/${accountId}` : ''} models`, MODEL_REFRESH_MS, async () => {
    let work = modelLoads.get(identity)
    if (!work) {
      let next: TokenSource
      try { next = create() }
      catch (error) {
        source.modelCatalogState = { status: source.modelCatalogState?.status === 'ready' ? 'ready' : 'failed',
          updatedAt: source.modelCatalogState?.updatedAt ?? null, error: error instanceof Error ? error.message : String(error) }
        throw error
      }
      const promise = Promise.resolve().then(() => next.refreshModels())
        .then(() => ({ source: next }), error => ({ source: next, error }))
        .finally(() => { if (modelLoads.get(identity)?.promise === promise) modelLoads.delete(identity) })
      work = { configuration, promise }
      modelLoads.set(identity, work)
    }
    const result = await work.promise
    let next = result.source
    const failure = result.error
    if (work.configuration !== configuration) {
      next = create()
      if (result.source.modelCatalogState?.status === 'ready') restoreCatalog(next, result.source, cfg)
      else {
        next.modelCatalogState = result.source.modelCatalogState && { ...result.source.modelCatalogState }
        if (!result.source.enabled) next.enabled = false
      }
    }
    if (!active) return
    if (failure !== undefined && !next.modelCatalogState?.error) {
      next.modelCatalogState = { status: 'failed', updatedAt: Date.now(),
        error: failure instanceof Error ? failure.message : String(failure) }
    }
    const authError = next.modelCatalogState?.error
    if (authError && isUsageAuthError(authError)) {
      usageSnapshot = { state: 'no_credentials', windows: [], reason: authError }
      if (source.kind === 'codex-subscription') invalidateCodexUsage(accountId ?? DEFAULT_CODEX_ACCOUNT)
    }
    if (next.modelCatalogState?.status === 'failed' || failure) {
      const error = next.modelCatalogState?.error ?? (failure instanceof Error ? failure.message : String(failure))
      if (source.modelCatalogState?.status === 'ready' && !isUsageAuthError(error)) {
        source.modelCatalogState = { ...source.modelCatalogState, error }
      } else publish(next)
      throw failure ?? new Error(error)
    }
    publish(next)
  }, old?.identity === identity ? old.model.nextRefreshAt : 0)
  const usage = new BackgroundRefresh(`token-source ${source.id}${accountId ? `/${accountId}` : ''} usage`, USAGE_REFRESH_MS, async () => {
    let snapshot: UsageSnapshotUnified
    try { snapshot = await committed.readUsage() }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (active && (usageSnapshot?.state !== 'ok' || isUsageAuthError(reason))) {
        usageSnapshot = { state: isUsageAuthError(reason) ? 'no_credentials' : 'network', windows: [], reason }
      }
      throw error
    }
    if (!active) return
    if (usageSnapshot?.state !== 'ok' || !['network', 'rate_limited'].includes(snapshot.state)
      || isUsageAuthError(snapshot.reason)) usageSnapshot = snapshot
    if (snapshot.state !== 'ok' && snapshot.state !== 'not_applicable' && snapshot.state !== 'no_credentials') {
      throw Object.assign(new Error(snapshot.reason ?? snapshot.state), { retryAfterMs: snapshot.retryAfterMs })
    }
  }, old?.identity === identity ? old.usage.nextRefreshAt : 0)
  source.refreshModels = () => model.refresh()
  source.readUsage = async () => !source.enabled
    ? { state: 'no_credentials', windows: [], reason: source.modelCatalogState?.error }
    : source.kind === 'codex-subscription'
    ? codexUsageToUnified(peekUsage(accountId) ?? { state: 'network', reason: '额度缓存尚未就绪，后台刷新中' })
    : usageSnapshot ?? {
    state: source.enabled ? 'network' : 'no_credentials', windows: [], reason: '额度缓存尚未就绪，后台刷新中',
  }
  if (committed.forAccount) {
    source.forAccount = id => {
      if (id === DEFAULT_CODEX_ACCOUNT) return source
      const revision = codexAccounts.revision(id)
      const current = children.get(id)
      if (current?.revision === revision) return current.source
      if (current) disposeCachedTokenSource(current.source)
      const prior = old?.baseIdentity === baseIdentity ? old.children.get(id) : undefined
      const child = cachedTokenSource(() => create().forAccount!(id), cfg, baseIdentity,
        configuration, prior?.revision === revision ? prior.source : undefined, id)
      children.set(id, { revision, source: child })
      return child
    }
  }
  metadata.set(source, { baseIdentity, identity, configuration, model, usage, children, snapshot: () => usageSnapshot, active: () => active,
    dispose() {
      active = false
      model.dispose(); usage.dispose()
      for (const child of children.values()) disposeCachedTokenSource(child.source)
    } })
  return source
}

export function disposeCachedTokenSource(source: TokenSource): void { metadata.get(source)?.dispose() }

export function removeCachedTokenSourceAccount(source: TokenSource | undefined, accountId: string): void {
  const cache = source && metadata.get(source)
  const child = cache?.children.get(accountId)
  if (child) { disposeCachedTokenSource(child.source); cache!.children.delete(accountId) }
}

/** Used only by initial warmup and explicit invalidation, never by interactive reads. */
export function refreshTokenSourceUsage(source: TokenSource): Promise<void> {
  return metadata.get(source)?.usage.refresh() ?? Promise.resolve()
}
