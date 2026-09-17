/**
 * Codex 订阅 token source(ChatGPT login)—— 自包含 provider 模块。
 *
 * 模型 = app-server `model/list` 动态拉(per-model effort、过滤 hidden);
 * 额度 = account/rateLimits/read；默认账号由原生认证接口确认（含系统钥匙串）。
 * 模块加载时 registerTokenSourceFactory 声明式登记。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { config, type TokenSourceConfig } from './config'
import {
  type TokenSource,
  type UsageSnapshotUnified,
  type UsageWindowUnified,
  scrubAnthropicEnv,
  registerTokenSourceFactory,
} from './token-source'
import { readUsage, type UsageSnapshot, type UsageWindow } from './usage'
import { fetchCodexModels } from './token-source-models'
import type { AgentReasoningEffort } from './agent-process'
import { log } from './log'
import { codexAccounts, DEFAULT_CODEX_ACCOUNT } from './codex-accounts'
import { withModelVisibility } from './token-source-visibility'

type Env = Record<string, string | undefined>

function windowToUnified(w: UsageWindow, kind: string, label: string): UsageWindowUnified {
  return { kind, label, percent: w.percent, resetsAt: w.resetsAt,
    ...(w.unreportedFull === undefined ? {} : { unreportedFull: w.unreportedFull }) }
}

/** Display only the authoritative main quota, as the footer and account cards do.
 * Model-specific buckets remain in the snapshot for quota scheduling. */
export function codexUsageToUnified(s: UsageSnapshot): UsageSnapshotUnified {
  if (s.state !== 'ok') {
    return {
      state: s.state === 'auth_failed' ? 'no_credentials'
        : s.state === 'no_credentials' ? 'no_credentials'
        : s.state === 'rate_limited' ? 'rate_limited'
        : 'network',
      windows: [],
      resetCredits: null,
      ...(s.state === 'network' && s.reason ? { reason: s.reason } : {}),
    }
  }
  const windows: UsageWindowUnified[] = []
  if (s.fiveHour) windows.push(windowToUnified(s.fiveHour, 'fiveHour', '5h 窗口'))
  if (s.weekly) windows.push(windowToUnified(s.weekly, 'weekly', '周配额'))
  return { state: 'ok', planLabel: s.subscriptionType, windows, fetchedAt: s.fetchedAt, resetCredits: s.resetCredits ?? null }
}

/** Default auth can live in an OS keyring or managed store. Only the native account/read is authoritative. */
function canReadCodexAccount(accountId: string): boolean {
  return accountId === DEFAULT_CODEX_ACCOUNT || existsSync(join(codexAccounts.home(accountId), 'auth.json'))
}

registerTokenSourceFactory({
  kind: 'codex-subscription',
  // codex 登录态走本地 ~/.codex,但 config [token_source.codex-sub] 可选覆盖
  // display/model/effort/models(codex app-server 动态拉,config 只做 pin)。
  configSectionId: 'codex-sub',
  build: (cfg: TokenSourceConfig): TokenSource => {
    const children = new Map<string, { revision: string; source: TokenSource }>()
    const make = (accountId: string): TokenSource => {
      const enabled = canReadCodexAccount(accountId)
      const cfgDefaultModel = cfg.model?.trim() || undefined
      const cfgEffort = (cfg.effort?.trim() || undefined) as AgentReasoningEffort | undefined
      const ts: TokenSource = {
        id: 'codex-sub',
        kind: 'codex-subscription',
        agent: 'codex',
        display: cfg.display?.trim() || 'Codex 订阅',
        spawnRevision: JSON.stringify([cfg.model, cfg.effort, codexAccounts.revision(accountId)]),
        enabled,
        models: [],
        modelCatalogState: { status: enabled ? 'idle' : 'disabled', updatedAt: Date.now() },
        defaultModel: cfgDefaultModel ?? '',
        async refreshModels(): Promise<void> {
          ts.enabled = canReadCodexAccount(accountId)
          if (!ts.enabled) {
            ts.models = []
            ts.modelCatalogState = { status: 'disabled', updatedAt: Date.now() }
            return
          }
          ts.modelCatalogState = { status: 'loading', updatedAt: null }
          try {
            ts.models = await fetchCodexModels(accountId)
            // config effort pin:把订阅默认 effort 覆盖为用户选择(per-model 仍可用)。
            if (cfgEffort) {
              for (const m of ts.models) m.defaultEffort = cfgEffort
            }
            // 默认模型:config model 键优先;未配 → 动态列表第一个(app-server 自己
            // 的首选顺序,订阅语义明确,不重排)。
            if (!cfgDefaultModel) ts.defaultModel = ts.models[0]?.model ?? ''
            ts.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
          } catch (e: any) {
            log(`codex-sub ${accountId} refreshModels MISS: ${e?.message ?? e}`)
            ts.models = []
            if (e?.code === 'CODEX_AUTH_MISSING') ts.enabled = false
            ts.modelCatalogState = { status: ts.enabled ? 'failed' : 'disabled', updatedAt: Date.now(), error: e?.message ?? String(e) }
          }
        },
        spawnEnv(base: Env): Env {
          const out = scrubAnthropicEnv(base)
          Object.assign(out, config.codex.env)
          return codexAccounts.env(accountId, out)
        },
        resolveSpawnModel(model: string): string {
          return model
        },
        async readUsage(): Promise<UsageSnapshotUnified> {
          return codexUsageToUnified(await readUsage(accountId))
        },
      }
      return ts
    }
    const root = make(DEFAULT_CODEX_ACCOUNT)
    root.forAccount = accountId => {
      if (accountId === DEFAULT_CODEX_ACCOUNT) return root
      const revision = codexAccounts.revision(accountId)
      const current = children.get(accountId)
      if (current?.revision === revision) return current.source
      const source = withModelVisibility(make(accountId), cfg)
      children.set(accountId, { revision, source })
      return source
    }
    const refreshDefault = root.refreshModels.bind(root)
    root.refreshModels = async () => {
      await Promise.all([refreshDefault(), ...codexAccounts.list()
        .filter(account => account.id !== DEFAULT_CODEX_ACCOUNT)
        .map(account => root.forAccount!(account.id).refreshModels())])
    }
    return root
  },
})
