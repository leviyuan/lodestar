/**
 * 账号、模型、启动环境和额度的共享接口及 registry。
 * 每个 token-source-*.ts 模块注册 factory，由 token-source-builtins.ts 构建实例。
 */

import type { AgentProvider, AgentReasoningEffort } from './agent-process'
import type { TokenSourceConfig } from './config'
import type { AccountInfo, Settings } from '@anthropic-ai/claude-agent-sdk'
import { log } from './log'

export type TokenSourceAgent = AgentProvider

/** 账号模型目录中的一个可选模型。 */
export interface TokenSourceModel {
  model: string
  display: string
  efforts: AgentReasoningEffort[]
  /** 模型默认或用户/Agent 选定的请求档位；null 表示需要手动选择。 */
  defaultEffort: AgentReasoningEffort | null
  /** 真实 turn 已观测到 1M 上下文；undefined 表示未确认，仅供面板展示。 */
  context1m?: boolean
  /** 账号或业务规则明确拒绝的模型；目录外的手动补录不因此禁用。 */
  unavailableReason?: string
  origin?: 'upstream' | 'custom'
}

export interface TokenSourceModelCatalogState {
  status: 'idle' | 'loading' | 'ready' | 'disabled' | 'failed'
  updatedAt: number | null
  error?: string
}

// ── 统一用量(codex 5h/weekly、glm 5h/monthly 归一) ────────────────────

export interface UsageWindowUnified {
  kind: string
  label: string
  percent: number | null
  resetsAt: Date | null
  used?: number
  total?: number
  /** Successful Plus response omitted 5h; preserve the full-window annotation without inventing a reset time. */
  unreportedFull?: boolean
}

export type UsageStateUnified =
  | 'ok'
  | 'no_credentials'
  | 'not_applicable'   // 该 source 无额度查询
  | 'rate_limited'
  | 'network'

export interface UsageSnapshotUnified {
  state: UsageStateUnified
  kind?: 'quota' | 'balance'
  balance?: { remaining: number; currency: string }
  quota?: { remaining: number | null; limit: number | null; currency: string }
  planLabel?: string
  windows: UsageWindowUnified[]
  reason?: string
  fetchedAt?: number
  /** Codex 账号可用的额度重置卡次数，仅在 hi 中展示。 */
  resetCredits?: number | null
}

// ── env helper(各 source 共享:scrub 残留凭据防 A 账号夹带 B 的 key) ─────
type Env = Record<string, string | undefined>

export const ANTHROPIC_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_EFFORT_LEVEL',
]

export function scrubAnthropicEnv(base: Env): Env {
  const out: Env = { ...base }
  for (const k of ANTHROPIC_ENV_KEYS) delete out[k]
  return out
}

export function scrubDshEnv(base: Env): Env {
  const out = scrubAnthropicEnv(base)
  for (const key of Object.keys(out)) {
    if (/^(DSH_|DEEPSEEK_|LODESTAR_DSH_|ZAI_|ZHIPU_)/.test(key)) delete out[key]
  }
  return out
}

// ── TokenSource 接口 ─────────────────────────────────────

export interface TokenSource {
  id: string
  /** One visible Codex source, with a separate native auth/catalog binding for each named account. */
  forAccount?(accountId: string): TokenSource
  /** Stable fingerprint of fields that affect spawned process routing/env.
   * Registry rebuilds with the same effective config keep the same value;
   * credential/base-url/slot changes force an idle process replacement. */
  spawnRevision?: string
  /** 模型能力需要不同的进程环境时参与启动身份，例如无 effort 参数的网关模型。 */
  modelEnvironmentRevision?(model: string): string
  /** 固定种类(声明式:string —— 加 source 不扩枚举) */
  kind: string
  /** 绑定哪个 agent 进程(协议强制:claude 走 Anthropic,codex 走 OpenAI/app-server) */
  agent: TokenSourceAgent
  display: string
  /** 配没配凭据(面板据此决定可选 vs 灰显「启用」)。廉价同步信号:
   *  codex 看 ~/.codex 登录态;glm 看 config 有没有 token。精确有效性在 spawn/查额度时暴露。 */
  enabled: boolean
  models: TokenSourceModel[]
  /** availableModels 包含接口目录及补录记录，origin 区分隐藏/显示和补录/删除。 */
  modelSelection?: { mode?: 'allowlist' | 'catalog'; modelIds: string[]; availableModels: TokenSourceModel[] }
  /** Last authoritative model-catalog refresh result. Real built-in sources
   * populate this; test/custom sources may omit it and are reported as idle. */
  modelCatalogState?: TokenSourceModelCatalogState
  defaultModel: string
  /** 启动/刷新时拉模型填 models。失败如实留空(MISS),绝不假数据。 */
  refreshModels(): Promise<void>
  /** 面板手动补录模型名时的存在性校验(端点 200/1214 判别)。
   *  未声明时允许手动补录并选择 Agent 请求档位，实际请求错误由后端报告。 */
  verifyModel?(model: string): Promise<'exists' | 'not_found' | 'no_verdict'>
  validateCustomModelId?(model: string): void
  spawnEnv(base: Env, model?: string): Env
  resolveSpawnModel(model: string): string | undefined
  /** 该 source spawn 的 claude 子进程 settingSources(覆盖 DEFAULT_SETTING_SOURCES)。
   *  注入 env 的 source(glm/deepseek)不设 → DEFAULT(['project','local'],spawnEnv 权威);
   *  透传型 source(native)设 ['user','project','local'] → 读本机 Claude Code 配置。 */
  settingSources?: readonly string[]
  /** Claude 来源的进程级设置覆盖；不修改本机 settings 文件。 */
  claudeSettings?: Settings
  /** 在 Claude SDK 接收用户输入前确认实际认证来源。 */
  validateClaudeAccount?(account: AccountInfo): void
  readUsage(): Promise<UsageSnapshotUnified>
}

/** 隐藏只影响选择面板，已配置的模型仍按上游能力启动。 */
export function tokenSourceRuntimeModels(source: TokenSource): TokenSourceModel[] {
  return source.modelSelection ? [...source.models, ...source.modelSelection.availableModels.filter(
    model => !source.models.some(selected => selected.model === model.model))] : source.models
}

export function tokenSourceRuntimeModel(source: TokenSource, model: string | undefined | null): TokenSourceModel | undefined {
  const key = (id: string | undefined | null) => source.agent === 'claude' ? id?.replace(/\[1m\]$/, '') : id
  return tokenSourceRuntimeModels(source).find(entry => key(entry.model) === key(model))
}

export function tokenSourceProcessRevision(source: TokenSource | undefined, model?: string | null): string | null {
  const revision = source?.spawnRevision ?? null
  const modelRevision = source?.modelEnvironmentRevision?.(model ?? source.defaultModel)
  return modelRevision === undefined ? revision : JSON.stringify([revision, modelRevision])
}

// ── provider factory registry(声明式:每 source 模块加载时登记) ──────────

/** 飞书 setup 命令接入(`<commandSuffix>-setup`):source 声明引导 + 参数解析,
 *  加新 source 不必改 session-commands 命令路由(声明式 generic 路由)。 */
export interface TokenSourceSetup {
  /** 命令后缀:飞书发 `<commandSuffix>-setup <args>`;通常 = configSectionId。 */
  commandSuffix: string
  /** model 面板「启用」按钮的引导文本(含命令用法)。 */
  hint: (display: string) => string
  /** 解析飞书命令参数 → 写 config.toml 的 cfg;失败返 { error }。 */
  parseArgs: (args: string) => { config: TokenSourceConfig } | { error: string }
  /** 保存前使用候选凭据查询账号接口；不依赖本机 Agent 安装，不修改运行中来源。 */
  validate: (cfg: TokenSourceConfig) => Promise<void>
}

/** 本机 settings.json 探测:config.toml 没配时,若本机 Claude Code 配的 host 命中本 source,
 *  自动启用(凭据从 settings.json 取)—— 新机装 lodestar 不用手动 config.toml,本机配啥自动认。 */
export interface TokenSourceDetection {
  fromSettingsEnv(env: Record<string, string>): Partial<TokenSourceConfig> | null
}

export interface TokenSourceFactoryDef {
  kind: string
  /** config.toml 里该 source 的 section id(如 'glm');undefined = 无 config(codex 走本地 login) */
  configSectionId?: string
  build: (cfg: TokenSourceConfig, detected?: Partial<TokenSourceConfig> | null) => TokenSource
  /** 飞书 setup 命令接入(可选;codex login / native 无独立 setup)。 */
  setup?: TokenSourceSetup
  /** 本机 settings.json 探测(可选;codex / native 无)—— 命中 host 则自动启用。 */
  detect?: TokenSourceDetection
}

const factoryRegistry = new Map<string, TokenSourceFactoryDef>()

/** 每个 source 模块加载时调:声明式登记。加新 source = 新建模块 + builtins import。 */
export function registerTokenSourceFactory(def: TokenSourceFactoryDef): void {
  factoryRegistry.set(def.kind, def)
}

export function tokenSourceFactories(): TokenSourceFactoryDef[] {
  return [...factoryRegistry.values()]
}

// ── instance registry(daemon 运行时:已构建的 source 实例) ──────────────

const registry = new Map<string, TokenSource>()
let defaultId: string | null = null
let registryGeneration = 0

export function registerTokenSource(s: TokenSource, opts?: { default?: boolean }): void {
  registry.set(s.id, s)
  if (opts?.default || defaultId === null) defaultId = s.id
}

export function getTokenSource(id: string | null | undefined): TokenSource | undefined {
  return id ? registry.get(id) : undefined
}

export function getTokenSourceForAccount(id: string | null | undefined, accountId = 'default'): TokenSource | undefined {
  const source = getTokenSource(id)
  return source?.forAccount ? source.forAccount(accountId) : source
}

export function listTokenSources(): TokenSource[] {
  return [...registry.values()]
}

export function listTokenSourcesByAgent(agent: TokenSourceAgent): TokenSource[] {
  return listTokenSources().filter(s => s.agent === agent)
}

/** 某 agent 下所有「已启用」的 source(spawn / 默认选择 / 额度查询只认 enabled,
 *  disabled 的不参与 —— 避免未配置的 source 把空凭据注入子进程)。 */
export function listEnabledTokenSourcesByAgent(agent: TokenSourceAgent): TokenSource[] {
  return listTokenSourcesByAgent(agent).filter(s => s.enabled)
}

export function setDefaultTokenSource(id: string): void {
  if (registry.has(id)) defaultId = id
}

/** 仅供测试重置全局 registry,保证用例隔离。 */
export function resetTokenSourceRegistry(): void {
  registry.clear()
  defaultId = null
  registryGeneration++
}

/** 全量刷新所有 token source 的 models(boot 启动 / setup rebuild 后调)。
 *  rebuild(resetTokenSourceRegistry)丢弃旧实例、重建空实例,必须重新 refresh,
 *  否则非当前操作的 source 的 models 永远空(deepseek-setup 后 glm/codex 变空)。
 *  allSettled:单个失败不阻断其余;失败如实留空,绝不假数据。 */
let refreshAllInFlight: { generation: number; promise: Promise<void> } | null = null

export function refreshAllTokenSourceModels(): Promise<void> {
  const generation = registryGeneration
  if (refreshAllInFlight?.generation === generation) return refreshAllInFlight.promise
  const promise = Promise.allSettled(listTokenSources().map(async ts => {
    await ts.refreshModels()
    log(`token-source ${ts.id}: ${ts.models.length} models loaded`)
  }))
    .then(() => {})
    .finally(() => {
      if (refreshAllInFlight?.promise === promise) refreshAllInFlight = null
    })
  refreshAllInFlight = { generation, promise }
  return promise
}

/** Await an already-running catalog refresh without starting a new network
 * refresh. Agent discovery uses this to avoid returning a transient
 * loading-only catalog immediately after boot/setup. */
export function pendingTokenSourceModelRefresh(): Promise<void> | null {
  return refreshAllInFlight?.promise ?? null
}

/** 等待当前目录加载；等待期间若配置重建了 registry，继续等待新一轮。
 * 只等待已有请求，不自行重新拉取模型。 */
export async function waitForTokenSourceModelRefresh(): Promise<void> {
  let pending: Promise<void> | null
  while ((pending = pendingTokenSourceModelRefresh())) await pending
}
