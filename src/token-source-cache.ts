import { BackgroundRefresh } from './background-refresh'
import type { TokenSourceConfig } from './config'
import { DEFAULT_CODEX_ACCOUNT } from './codex-accounts'
import { customModelEfforts, modelList } from './token-source-visibility'
import { tokenSourceAccounts, tokenSourceAccountRevision, type TokenSource, type TokenSourceModel, type UsageSnapshotUnified } from './token-source'
import { invalidateCodexUsage, peekUsage } from './usage'
import { codexUsageToUnified } from './token-source-codex'
import { isUsageAuthError } from './usage-cache'

export const MODEL_REFRESH_MS = 5 * 60_000
const USAGE_REFRESH_MS = 60_000
// Each subscription probe starts Codex's native model-catalog refresh too.
// Keep both periodic reads and failed refreshes within the same cadence.
const CODEX_MODEL_REFRESH_MS = 2 * 60 * 60_000
const CODEX_USAGE_REFRESH_MS = 2 * 60 * 60_000
const metadata = new WeakMap<TokenSource, CachedSource>()
const modelLoads = new Map<string, { configuration: string; promise: Promise<{ source: TokenSource; error?: unknown }> }>()

interface CachedSource {
  baseIdentity: string
  identity: string
  configuration: string
  model?: BackgroundRefresh
  usage?: BackgroundRefresh
  snapshot(): UsageSnapshotUnified | undefined
  children: Map<string, { revision: string; source: TokenSource }>
  active(): boolean
  dispose(): void
}

/** Synchronous cache-only quota access for startup selection. */
export function peekTokenSourceUsage(source: TokenSource): UsageSnapshotUnified | undefined {
  return metadata.get(source)?.snapshot()
}

function aggregateAccountCatalog(create: () => TokenSource, cfg: TokenSourceConfig,
  baseIdentity: string, configuration: string, previous?: TokenSource): TokenSource {
  const old = previous && metadata.get(previous)
  if (old?.active() && old.baseIdentity === baseIdentity && old.configuration === configuration) return previous!
  const raw = create()
  const source: TokenSource = { ...raw }
  const children: CachedSource['children'] = new Map()
  let active = true
  source.forAccount = id => {
    const revision = tokenSourceAccountRevision(raw, id)
    const current = children.get(id)
    if (current?.revision === revision) return current.source
    if (current) disposeCachedTokenSource(current.source)
    const prior = old?.baseIdentity === baseIdentity ? old.children.get(id) : undefined
    const child = cachedTokenSource(() => create().forAccount!(id), cfg, baseIdentity, configuration,
      prior?.revision === revision ? prior.source : undefined, id)
    children.set(id, { revision, source: child })
    return child
  }
  const accounts = () => tokenSourceAccounts(raw).map(account => source.forAccount!(account.id))
  const available = () => accounts().filter(account => account.enabled && account.modelCatalogState?.status === 'ready')
  const catalog = (): TokenSourceModel[] => {
    const result = new Map<string, TokenSourceModel>()
    for (const account of available()) for (const model of account.models) {
      const prior = result.get(model.model)
      result.set(model.model, prior ? { ...prior, efforts: [...new Set([...prior.efforts, ...model.efforts])] } : { ...model })
    }
    return [...result.values()]
  }
  // These are projections of committed child snapshots, never a second upstream cache.
  Object.defineProperties(source, {
    enabled: { enumerable: true, get: () => raw.enabled && (available().length > 0
      || accounts().some(account => account.modelCatalogState?.status === 'idle' || account.modelCatalogState?.status === 'loading')) },
    models: { enumerable: true, get: catalog },
    defaultModel: { enumerable: true, get: () => cfg.model?.trim()
      || available().map(account => account.defaultModel).find(model => /(?:^|[- :])opus(?:$|[- \[])/i.test(model)) || '' },
    modelSelection: { enumerable: true, get: () => {
      const all = new Map<string, TokenSourceModel>()
      for (const account of available()) for (const model of account.modelSelection?.availableModels ?? account.models) {
        const prior = all.get(model.model)
        all.set(model.model, prior ? { ...prior, efforts: [...new Set([...prior.efforts, ...model.efforts])] } : { ...model })
      }
      return { ...raw.modelSelection, mode: 'catalog', modelIds: catalog().map(model => model.model), availableModels: [...all.values()] }
    } },
    modelCatalogState: { enumerable: true, get: () => {
      if (!raw.enabled) return raw.modelCatalogState
      const ready = available()
      if (ready.length) {
        const errors = ready.map(account => account.modelCatalogState?.error).filter(Boolean)
        return { status: 'ready', updatedAt: Math.max(...ready.map(account => account.modelCatalogState?.updatedAt ?? 0)),
          ...(errors.length ? { error: errors.join('；') } : {}) }
      }
      const all = accounts()
      const state = all.find(account => account.modelCatalogState?.status === 'failed')?.modelCatalogState
        ?? all.find(account => account.modelCatalogState?.status === 'disabled')?.modelCatalogState
        ?? all[0]?.modelCatalogState
      return state ?? { status: 'idle', updatedAt: null }
    } },
  })
  source.refreshModels = async () => {
    if (!raw.enabled) return
    const initial = tokenSourceAccounts(raw).map(account => ({ id: account.id, revision: tokenSourceAccountRevision(raw, account.id) }))
    const results = await Promise.allSettled(initial.map(account => source.forAccount!(account.id).refreshModels()))
    // First native identity discovery may advance a generation. Warm that new binding once.
    const changed = initial.filter(account => tokenSourceAccountRevision(raw, account.id) !== account.revision)
    const repeated = await Promise.allSettled(changed.map(account => source.forAccount!(account.id).refreshModels()))
    if (!available().length || available().every(account => !!account.modelCatalogState?.error)) {
      const failure = [...results, ...repeated].find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) throw failure.reason
    }
  }
  source.readUsage = async () => ({ state: 'not_applicable', windows: [], reason: 'Claude 订阅额度按实际账号展示' })
  metadata.set(source, { baseIdentity, identity: baseIdentity, configuration, children,
    snapshot: () => undefined, active: () => active,
    dispose() { active = false; for (const child of children.values()) disposeCachedTokenSource(child.source) } })
  // Register each account's background refresh, including the native default.
  accounts()
  return source
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
  const visibilityKey = selection?.visibilityKey ?? ((model: string) => model)
  const automatic = new Set(selection?.selectDefaults?.(catalog) ?? [])
  const shown = new Set(modelList(cfg.shown_models))
  const configuredModel = source.kind === 'openrouter' ? cfg.model?.trim().replace(/\[1m\]$/, '') : cfg.model?.trim()
  const ids = cfg.models !== undefined ? modelList(cfg.models)
    : selection?.selectDefaults ? [...new Set([...(configuredModel ? [configuredModel] : []),
      ...automatic, ...shown])]
    : selection?.modelIds.length ? selection.modelIds : previous.modelSelection?.modelIds ?? []
  const visible = selection?.mode === 'allowlist'
    ? ids.map(id => {
      const key = source.agent === 'claude' ? id.replace(/\[1m\]$/, '') : id
      const entry = catalog.find(model => model.model === key) ?? previous.models.find(model => model.model === id)
      return entry ? { ...entry, model: id } : { model: id, display: id, efforts: [], defaultEffort: null,
        unavailableReason: '账号目录缓存未返回该模型' }
    })
      .filter(model => model.origin === 'custom' || !hidden.has(model.model)
        && (!automatic.has(model.model) || shown.has(model.model) || !hidden.has(visibilityKey(model.model))))
    : catalog.filter(model => model.origin === 'custom' || !hidden.has(model.model))
  source.models = [...visible, ...catalog.filter(model => model.origin === 'custom' && !visible.some(item => item.model === model.model))]
  if (selection) {
    selection.availableModels = catalog
    selection.modelIds = source.models.map(model => model.model)
  }
  source.defaultModel = source.kind === 'openrouter' ? cfg.model?.trim() || ''
    : cfg.model?.trim() || (source.kind === 'claude-subscription' ? previous.defaultModel : catalog.some(model => model.model === previous.defaultModel)
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
  if (committed.aggregateAccountCatalog && accountId === undefined) {
    return aggregateAccountCatalog(create, cfg, baseIdentity, configuration, previous)
  }
  const selectedId = accountId ?? committed.accountId ?? DEFAULT_CODEX_ACCOUNT
  const revision = () => committed.accountRevision || committed.kind === 'codex-subscription'
    ? tokenSourceAccountRevision(committed, selectedId) : null
  const initialRevision = revision()
  const identity = initialRevision === null ? baseIdentity : JSON.stringify([baseIdentity, selectedId, initialRevision])
  const currentIdentity = () => initialRevision === revision()
  if (old?.active() && old.configuration === configuration && old.identity === identity) return previous!
  if (old?.identity === identity) restoreCatalog(committed, previous!, cfg)
  const source: TokenSource = { ...committed }
  const codexSubscription = committed.kind === 'codex-subscription'
  const modelRefreshMs = codexSubscription ? CODEX_MODEL_REFRESH_MS : MODEL_REFRESH_MS
  const usageRefreshMs = codexSubscription ? CODEX_USAGE_REFRESH_MS : USAGE_REFRESH_MS
  let active = true
  let usageSnapshot = old?.identity === identity ? old.snapshot() : undefined
  const children: CachedSource['children'] = new Map()

  const publish = (next: TokenSource): void => {
    committed = next
    // Keep the facade's lifecycle methods; all other closures belong to the committed instance.
    const { refreshModels: _refresh, readUsage: _usage, forAccount: _accounts, ...snapshot } = next
    Object.assign(source, snapshot)
  }
  const model = new BackgroundRefresh('model catalog', modelRefreshMs, async () => {
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
    if (!active || !currentIdentity()) return
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
  }, old?.identity === identity ? old.model?.nextRefreshAt : 0, codexSubscription ? modelRefreshMs : 0)
  const usage = new BackgroundRefresh('usage', usageRefreshMs, async () => {
    let snapshot: UsageSnapshotUnified
    try { snapshot = await committed.readUsage() }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (active && currentIdentity() && (usageSnapshot?.state !== 'ok' || isUsageAuthError(reason))) {
        usageSnapshot = { state: isUsageAuthError(reason) ? 'no_credentials' : 'network', windows: [], reason }
      }
      throw error
    }
    if (!active || !currentIdentity()) return
    if (usageSnapshot?.state !== 'ok' || !['network', 'rate_limited'].includes(snapshot.state)
      || isUsageAuthError(snapshot.reason)) usageSnapshot = snapshot
    if (snapshot.state !== 'ok' && snapshot.state !== 'not_applicable' && snapshot.state !== 'no_credentials') {
      throw Object.assign(new Error(snapshot.reason ?? snapshot.state), { retryAfterMs: snapshot.retryAfterMs })
    }
  }, old?.identity === identity ? old.usage?.nextRefreshAt : 0, codexSubscription ? usageRefreshMs : 0)
  source.refreshModels = () => model.refresh()
  const snapshot = (): UsageSnapshotUnified | undefined => !currentIdentity()
    ? { state: 'no_credentials', windows: [], reason: '账号认证身份已变化，后台刷新中' }
    : !source.enabled ? { state: 'no_credentials', windows: [], reason: source.modelCatalogState?.error }
    : source.kind === 'codex-subscription'
      ? codexUsageToUnified(peekUsage(selectedId) ?? { state: 'network', reason: '额度缓存尚未就绪，后台刷新中' }) : usageSnapshot
  source.readUsage = async () => snapshot() ?? (!source.enabled
    ? { state: 'no_credentials', windows: [], reason: source.modelCatalogState?.error }
    : source.kind === 'codex-subscription'
    ? codexUsageToUnified(peekUsage(accountId) ?? { state: 'network', reason: '额度缓存尚未就绪，后台刷新中' })
    : usageSnapshot ?? {
    state: source.enabled ? 'network' : 'no_credentials', windows: [], reason: '额度缓存尚未就绪，后台刷新中',
  })
  if (committed.forAccount) {
    source.forAccount = id => {
      if (id === selectedId && currentIdentity()) return source
      const revision = tokenSourceAccountRevision(committed, id)
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
  metadata.set(source, { baseIdentity, identity, configuration, model, usage, children, snapshot, active: () => active,
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
  if (source.aggregateAccountCatalog && source.forAccount) {
    return Promise.all(tokenSourceAccounts(source).map(account => refreshTokenSourceUsage(source.forAccount!(account.id)))).then(() => {})
  }
  return metadata.get(source)?.usage?.refresh() ?? Promise.resolve()
}
