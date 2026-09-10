/**
 * GLM Coding Plan token source(anthropic 兼容端点)—— 自包含 provider 模块。
 *
 * 模型 = anthropic 端点 /v1/models 动态拉(display_name)
 *      + config models 键补充(上游列表滞后、新模型已可用但未列出时手动补登);
 * 默认模型/slots = config model/slots 键(无代码级模型名默认);
 * [1m] 后缀 = 真实 turn 观测决策(context-window-observe.ts);
 * 额度 = quota/limit(真);enabled = config 有 base_url+token。
 * 模块加载时 registerTokenSourceFactory 声明式登记。
 */

import type { TokenSourceConfig } from './config'
import {
  type TokenSource,
  type TokenSourceModel,
  type UsageSnapshotUnified,
  type UsageWindowUnified,
  scrubAnthropicEnv,
  registerTokenSourceFactory,
} from './token-source'
import { fetchGlmUsage, isGlmBaseUrl, type GlmUsageSnapshot, type GlmUsageWindow, type GlmMonthlyWindow } from './glm-usage'
import { fetchGlmModels, CLAUDE_EFFORTS } from './token-source-models'
import { resolveModelWithWindow, observedContextWindow } from './context-window-observe'
import { verifyModelExists } from './model-existence'
import { log } from './log'

type Env = Record<string, string | undefined>

function glmWindowToUnified(w: GlmUsageWindow, kind: string, label: string): UsageWindowUnified {
  return { kind, label, percent: w.percent, resetsAt: w.resetsAt }
}

function glmMonthlyToUnified(w: GlmMonthlyWindow): UsageWindowUnified {
  return {
    kind: 'monthly', label: '月度工具', percent: w.percent, resetsAt: w.resetsAt,
    ...(w.used != null ? { used: w.used } : {}),
    ...(w.total != null ? { total: w.total } : {}),
  }
}

/** config models 键解析:逗号分隔 slug(如 'GLM-5.3,GLM-4.7')→ 干净数组。 */
function parseModelList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

/** 版本号排序取最新(默认模型兜底用):取模型名里第一个数字组('GLM-5.2' → 5.2,
 *  'deepseek-v4-pro' → 4),数字大 = 新。无数字(-1)排最后。零模型名假设。 */
function latestByVersion(models: string[]): string {
  const versionOf = (id: string): number => {
    const m = id.match(/(\d+(?:\.\d+)?)/)
    return m ? Number(m[1]) : -1
  }
  return [...models].sort((a, b) => versionOf(b) - versionOf(a))[0] ?? ''
}

/** config slots 键解析:'opus=X,sonnet=Y,haiku=Z' → record;非法段忽略。 */
function parseSlots(raw: string | undefined): Partial<Record<'opus' | 'sonnet' | 'haiku', string>> {
  const out: Partial<Record<'opus' | 'sonnet' | 'haiku', string>> = {}
  for (const seg of (raw ?? '').split(',')) {
    const eq = seg.indexOf('=')
    if (eq <= 0) continue
    const slot = seg.slice(0, eq).trim().toLowerCase()
    const model = seg.slice(eq + 1).trim()
    if ((slot === 'opus' || slot === 'sonnet' || slot === 'haiku') && model) out[slot] = model
  }
  return out
}

export function glmUsageToUnified(s: GlmUsageSnapshot): UsageSnapshotUnified {
  if (s.state !== 'ok') {
    return {
      state: s.state === 'no_credentials' ? 'no_credentials'
        : s.state === 'not_glm' ? 'not_applicable'
        : s.state === 'rate_limited' ? 'rate_limited'
        : 'network',
      windows: [],
      ...(s.state === 'network' && s.reason ? { reason: s.reason } : {}),
    }
  }
  const windows: UsageWindowUnified[] = []
  if (s.fiveHour) windows.push(glmWindowToUnified(s.fiveHour, 'fiveHour', '5h 窗口'))
  if (s.weekly) windows.push(glmWindowToUnified(s.weekly, 'weekly', '周额度'))
  if (s.monthly) windows.push(glmMonthlyToUnified(s.monthly))
  return {
    state: 'ok',
    planLabel: s.level ? `${s.level} 套餐` : undefined,
    windows,
    fetchedAt: s.fetchedAt,
  }
}

registerTokenSourceFactory({
  kind: 'glm-coding-plan',
  configSectionId: 'glm',
  build: (cfg: TokenSourceConfig, detected?: Partial<TokenSourceConfig> | null): TokenSource => {
    // config.toml 优先,本机 settings.json 探测(detected)兜底 —— 有任一且 host 命中 GLM 即启用。
    const baseUrl = cfg.base_url?.trim() || detected?.base_url?.trim() || ''
    const token = cfg.auth_token?.trim() || detected?.auth_token?.trim() || ''
    const enabled = !!(baseUrl && token) && isGlmBaseUrl(baseUrl)
    // config 键(零代码默认):model = 默认模型;slots = SDK alias 槽位。
    // 两者都未配 → undefined,refreshModels 后回落动态列表第一个(refreshModels 里)。
    const cfgDefaultModel = cfg.model?.trim() || undefined
    const slots = parseSlots(cfg.slots)
    const ts: TokenSource = {
      id: 'glm',
      kind: 'glm-coding-plan',
      agent: 'claude',
      display: cfg.display?.trim() || 'GLM Coding Plan',
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
          const fetched = await fetchGlmModels(baseUrl, token)
          // config models 键补充:上游 /v1/models 列表滞后(新模型已可用但未列出)时手动补登。
          // 按 model 去重合并 —— 上游哪天补列出同名模型后自动收敛为 no-op。
          const extra = [...new Set([...parseModelList(cfg.models), ...parseModelList(cfg.custom_models)])].filter(
            m => !fetched.some(f => f.model.toLowerCase() === m.toLowerCase()),
          )
          const extras: TokenSourceModel[] = extra.map(m => ({
            model: m, display: m, efforts: CLAUDE_EFFORTS, defaultEffort: 'max', origin: 'custom',
          }))
          ts.models = [...fetched, ...extras]
          // 默认模型:config model 键优先;未配 → 版本号最新的(端点列表顺序是旧→新,
          // 取第一项会拿到最老模型,故按版本号排序)。列表空(拉取 MISS)→ 保持空,
          // spawn 侧 undefined → SDK 'opus' alias → config slots。
          if (!cfgDefaultModel) ts.defaultModel = latestByVersion(ts.models.map(m => m.model))
          // 1M 标注 = 真实 turn 观测缓存(纯被动,零探测):面板如实显示已知状态。
          for (const m of ts.models) {
            const observed = observedContextWindow('glm', m.model)
            m.context1m = observed != null && observed >= 1_000_000 || undefined
          }
          ts.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
        } catch (e: any) {
          log(`glm refreshModels MISS: ${e?.message ?? e}`)
          ts.models = []
          ts.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: e?.message ?? String(e) }
        }
      },
      spawnEnv(base: Env): Env {
        const out = scrubAnthropicEnv(base)
        // `base` already contains config.claude.env (ClaudeAgentProcess adds it
        // before invoking the token-source transform).  Re-spreading the raw
        // config here would undo scrubAnthropicEnv and could leave a competing
        // API_KEY/AUTH_TOKEN from a previously selected source in the child.
        // Keep the scrubbed non-Anthropic environment and inject only this
        // source's routing/auth fields as the final authority.
        const merged: Env = { ...out }
        merged.ANTHROPIC_BASE_URL = baseUrl
        merged.ANTHROPIC_AUTH_TOKEN = token
        // slots 只从 config slots 键来(零代码默认);resolveSpawnModel 下发具体
        // model 时不读这些,仅在 SDK 走 opus/sonnet/haiku alias 的 fallback 路径生效。
        if (slots.opus) merged.ANTHROPIC_DEFAULT_OPUS_MODEL = slots.opus
        if (slots.sonnet) merged.ANTHROPIC_DEFAULT_SONNET_MODEL = slots.sonnet
        if (slots.haiku) merged.ANTHROPIC_DEFAULT_HAIKU_MODEL = slots.haiku
        return merged
      },
      resolveSpawnModel(model: string): string | undefined {
        // [1m] 是 CLI 客户端侧后缀(剥后缀 + context-1m beta header,窗口按 1M 记账)。
        // 加不加 = 真实 turn 观测说了算(见 context-window-observe.ts):观测 1M 加、
        // SDK 观测低于 1M 时使用裸名；未观测时保留已有 [1m] 路由约定。
        return resolveModelWithWindow('glm', model)
      },
      async verifyModel(model: string) {
        return verifyModelExists(baseUrl, { Authorization: `Bearer ${token}` }, model)
      },
      async readUsage(): Promise<UsageSnapshotUnified> {
        // 额度用本 source 的 baseUrl/token 查(不经全局 readGlmUsage 的 settings.json,避免凭据不一致)
        return glmUsageToUnified(await fetchGlmUsage(baseUrl, token))
      },
    }
    return ts
  },
  setup: {
    commandSuffix: 'glm',
    hint: display => `启用 ${display}:发送\n\`\`\`\nglm-setup <base_url> <token>\n\`\`\``,
    parseArgs: args => {
      const parts = args.trim().split(/\s+/)
      if (parts.length < 2) return { error: '用法:`glm-setup <base_url> <token>\`' }
      return { config: { agent: 'claude', base_url: parts[0], auth_token: parts[1] } }
    },
  },
  detect: {
    fromSettingsEnv(env) {
      const baseUrl = env.ANTHROPIC_BASE_URL?.trim() ?? ''
      if (!isGlmBaseUrl(baseUrl)) return null
      const token = env.ANTHROPIC_AUTH_TOKEN?.trim() ?? ''
      return token ? { base_url: baseUrl, auth_token: token } : null
    },
  },
})
