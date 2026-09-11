/**
 * Codex 订阅 token source(ChatGPT login)—— 自包含 provider 模块。
 *
 * 模型 = app-server `model/list` 动态拉(per-model effort、过滤 hidden);
 * 额度 = account/rateLimits/read(真);enabled = ~/.codex/auth.json 在。
 * 模块加载时 registerTokenSourceFactory 声明式登记。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
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

type Env = Record<string, string | undefined>

function windowToUnified(w: UsageWindow, kind: string, label: string): UsageWindowUnified {
  return { kind, label, percent: w.percent, resetsAt: w.resetsAt }
}

function codexUsageToUnified(s: UsageSnapshot): UsageSnapshotUnified {
  if (s.state !== 'ok') {
    return {
      state: s.state === 'auth_failed' ? 'no_credentials'
        : s.state === 'no_credentials' ? 'no_credentials'
        : s.state === 'rate_limited' ? 'rate_limited'
        : 'network',
      windows: [],
      resetCredits: null,
    }
  }
  const windows: UsageWindowUnified[] = []
  if (s.fiveHour) windows.push(windowToUnified(s.fiveHour, 'fiveHour', '5h 窗口'))
  if (s.weekly) windows.push(windowToUnified(s.weekly, 'weekly', '周配额'))
  return { state: 'ok', planLabel: s.subscriptionType, windows, fetchedAt: s.fetchedAt, resetCredits: s.resetCredits ?? null }
}

/** read 端点全量桶列表 → unified(console `hi` 面板可显示非默认桶,如 Spark
 *  附加包)。空桶列表(旧快照/读取失败)返回 null,调用方省略。 */
export function codexBucketsToUnified(s: UsageSnapshot): UsageWindowUnified[] | null {
  if (s.state !== 'ok' || !s.buckets?.length) return null
  const out: UsageWindowUnified[] = []
  for (const b of s.buckets) {
    const label = b.limitId === s.defaultLimitId
      ? (b.limitName ?? '默认配额')
      : (b.limitName ?? b.limitId)
    if (b.fiveHour) out.push(windowToUnified(b.fiveHour, 'fiveHour', `${label} 5h`))
    if (b.weekly) out.push(windowToUnified(b.weekly, 'weekly', `${label} 周`))
  }
  return out.length ? out : null
}

/** codex 本地登录态:~/.codex/auth.json 存在即视为已配置(廉价同步信号;
 *  订阅是否有效在 account/rateLimits 查询时如实暴露 MISS)。 */
function codexLoggedIn(): boolean {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
  return existsSync(join(codexHome, 'auth.json'))
}

registerTokenSourceFactory({
  kind: 'codex-subscription',
  // codex 登录态走本地 ~/.codex,但 config [token_source.codex-sub] 可选覆盖
  // display/model/effort/models(codex app-server 动态拉,config 只做 pin)。
  configSectionId: 'codex-sub',
  build: (cfg: TokenSourceConfig): TokenSource => {
    const enabled = codexLoggedIn()
    const cfgDefaultModel = cfg.model?.trim() || undefined
    const cfgEffort = (cfg.effort?.trim() || undefined) as AgentReasoningEffort | undefined
    const ts: TokenSource = {
      id: 'codex-sub',
      kind: 'codex-subscription',
      agent: 'codex',
      display: cfg.display?.trim() || 'Codex 订阅',
      enabled,
      models: [],
      modelCatalogState: { status: enabled ? 'idle' : 'disabled', updatedAt: Date.now() },
      defaultModel: cfgDefaultModel ?? '',
      async refreshModels(): Promise<void> {
        if (!ts.enabled) {
          ts.models = []
          ts.modelCatalogState = { status: 'disabled', updatedAt: Date.now() }
          return
        }
        ts.modelCatalogState = { status: 'loading', updatedAt: null }
        try {
          ts.models = await fetchCodexModels()
          // config effort pin:把订阅默认 effort 覆盖为用户选择(per-model 仍可用)。
          if (cfgEffort) {
            for (const m of ts.models) m.defaultEffort = cfgEffort
          }
          // 默认模型:config model 键优先;未配 → 动态列表第一个(app-server 自己
          // 的首选顺序,订阅语义明确,不重排)。
          if (!cfgDefaultModel) ts.defaultModel = ts.models[0]?.model ?? ''
          ts.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
        } catch (e: any) {
          log(`codex-sub refreshModels MISS: ${e?.message ?? e}`)
          ts.models = []
          ts.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: e?.message ?? String(e) }
        }
      },
      spawnEnv(base: Env): Env {
        const out = scrubAnthropicEnv(base)
        Object.assign(out, config.codex.env)
        return out
      },
      resolveSpawnModel(model: string): string {
        return model
      },
      async readUsage(): Promise<UsageSnapshotUnified> {
        const snap = await readUsage()
        const unified = codexUsageToUnified(snap)
        // 多桶透出:read 端点全量桶(如 Spark 附加包)在 console 额度行各占一行,
        // 服务端加/删桶自动跟进;单桶账号行为不变(就是默认桶的 5h+周)。
        const all = codexBucketsToUnified(snap)
        if (all) unified.windows = all
        return unified
      },
    }
    return ts
  },
})
