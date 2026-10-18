import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn as crossSpawn } from 'cross-spawn'
import { delimiter, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import {
  type AccountInfo,
  type EffortLevel,
  type McpServerConfig,
  type ModelInfo,
  type Query,
  type SDKControlGetUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
  type SettingSource,
  type Settings,
  type SpawnOptions as ClaudeSdkSpawnOptions,
  type SpawnedProcess,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk'
import { agentPackagePath, loadClaudeSdk } from './agent-updates'
import { config, type ProjectProfile } from './config'
import { log } from './log'
import {
  CLAUDE_EFFORT,
  isClaudeReasoningEffort,
  NothingToCompactError,
  ModelSettingsUpdateError,
  type AgentReasoningEffort,
  type AgentTranslationPresentationEvent,
  type AgentTranslationPresentationPolicy,
  type AgentTranslationPresentationSurface,
  type ClaudeReasoningEffort,
} from './agent-process'
import {
  claudeModelKey,
  resolveClaudeSdkModel,
} from './claude-models'
import type {
  CanUseToolRequest,
  CodexModel,
  CodexResultMeta,
  CodexUsage,
  SpawnOpts,
} from './codex-process'
import { usageFromTokenUsagePayload } from './codex-usage'
import { observeContextWindow } from './context-window-observe'
import type { ClaudeTranslation } from './claude-translation'
import { CLAUDE_TRANSLATION_ORIGINS, type ClaudeTranslationContext } from './claude-translation-context'
import { ClaudePresentationTranslation, claudeToolInputContext, claudeToolInputOrigin, claudeToolResultContext } from './claude-presentation-translation'

type QueueWaiter<T> = (value: IteratorResult<T>) => void

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private items: T[] = []
  private waiters: QueueWaiter<T>[] = []
  private closed = false

  push(item: T): void {
    if (this.closed) throw new Error('input stream is closed')
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length) this.waiters.shift()?.({ value: undefined, done: true })
  }

  abort(): void {
    this.clear()
    this.close()
  }

  clear(): void { this.items = [] }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise(resolve => this.waiters.push(resolve))
  }
}

type PendingUserDialog = {
  kind: 'dialog'
  resolve: (value: PermissionResult) => void
  request: CanUseToolRequest
  cleanup?: () => void
  originalInput?: Record<string, unknown>
  translationSignal?: AbortSignal
  answering?: boolean
}

type PendingControl = PendingUserDialog

type PendingServerToolInput = {
  name: string
  input: unknown
}

export interface ClaudeSpawnOpts extends Omit<SpawnOpts, 'effort'> {
  model?: string
  effort: ClaudeReasoningEffort
  /** Claude SDK conversation id to resume before optional forkSession. */
  resumeSessionId?: string
  /** SDK resumeSessionAt:只 resume 到该 assistant 消息 uuid 为止(回到历史某点)。
   *  这是 Claude 的 checkpoint 形态；Codex 对应使用 canonical turn id。 */
  resumeSessionAt?: string
  /** SDK forkSession:true = resume 时派生新 session id,原 transcript 不动。
   *  fk/bk 都用它(避免破坏/污染原会话)。 */
  forkSession?: boolean
  /** Optional per-project launch profile from `[projects.<name>].*` in
   * config.toml. When present, overrides setting sources / tool set /
   * strict-mcp / project-mcp loading for an isolated session. Absent ⇒
   * Lodestar defaults (user sources, claude_code preset, no project MCP). */
  profile?: ProjectProfile
  /** 覆盖 settingSources(优先于 profile / DEFAULT_SETTING_SOURCES)。
   *  注入 env 的 token source(glm/deepseek)不传 → DEFAULT(['project','local'],不读 user settings env,spawnEnv 权威);
   *  Claude 订阅传 ['user','project','local']，配合进程级 settings 和原生账号验证隔离认证。 */
  settingSources?: readonly string[]
  settings?: Settings
  validateAccount?: (account: AccountInfo) => void
  /** 该进程 spawn 时绑定的 token source id;stopIdleMismatchedProcess 据此判跨 source 重启。 */
  tokenSourceId?: string | null
  /** Daemon-owned local plugin containing shared Skills. Loaded only when the
   * effective settingSources omit `user`. */
  managedSkillPluginPath?: string
  /** Translate host-managed conversation text without changing native tool data. */
  translation?: ClaudeTranslation
  translationContext?: ClaudeTranslationContext
}

export function claudeManagedSkillOptions(
  settingSources: readonly string[],
  pluginPath: string | undefined,
): Record<string, unknown> {
  if (!pluginPath || settingSources.includes('user')) return {}
  return {
    plugins: [{ type: 'local', path: pluginPath, skipMcpDiscovery: true }],
    skills: 'all',
  }
}

type ClaudePathLookup = {
  platform?: NodeJS.Platform
  pathEnv?: string
  homeDir?: string
  exists?: (path: string) => boolean
  /** undefined = 读 config.claude.bin;显式 null = 视为未配置(测试隔离 config 用)。 */
  configuredBin?: string | null
}

type ClaudeExecutableConfig = {
  pathToClaudeCodeExecutable?: string
  spawnClaudeCodeProcess?: (options: ClaudeSdkSpawnOptions) => SpawnedProcess
  description: string
}

function windowsShellShim(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.cmd') || lower.endsWith('.bat')
}

function spawnWindowsShellShim(options: ClaudeSdkSpawnOptions): SpawnedProcess {
  const child = crossSpawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    shell: false,
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })
  if (!child.stdin || !child.stdout) {
    child.kill()
    throw new Error('failed to open stdio for Claude Code Windows shell shim')
  }
  return child as unknown as SpawnedProcess
}

export function assertClaudeCodeAvailable(): void {
  resolveClaudeExecutableConfig()
  agentPackagePath('claude', '@anthropic-ai/claude-agent-sdk')
}

export function resolveClaudeExecutableConfig(lookup: ClaudePathLookup = {}): ClaudeExecutableConfig {
  const platform = lookup.platform ?? process.platform
  const configured = lookup.configuredBin === undefined ? config.claude.bin : lookup.configuredBin
  if (configured) {
    const exists = lookup.exists ?? existsSync
    // [claude].bin 配错时必须明确报错，避免改用其他入口或凭据。
    if (!exists(configured)) {
      throw new Error(`lodestar: [claude].bin not found: ${configured} (config.toml)`)
    }
    if (platform === 'win32' && windowsShellShim(configured)) {
      return {
        pathToClaudeCodeExecutable: configured,
        spawnClaudeCodeProcess: spawnWindowsShellShim,
        description: `windows-shell-shim:${configured}`,
      }
    }
    return { pathToClaudeCodeExecutable: configured, description: `config:${configured}` }
  }
  // 未配 [claude].bin:使用自动更新的 SDK 自带程序。显式指定会让
  // claude 走 CLI 二进制的 stream-json 模式,该模式不下发 AskUserQuestion 等 dialog
  // 工具;SDK 默认入口才会下发。需要显式指定时用 [claude].bin(走 configured 分支)。
  return { description: 'sdk-default' }
}

export function buildClaudeSpawnPath(): string {
  if (process.platform === 'win32') return process.env.PATH ?? ''
  const entries = [
    join(homedir(), '.local', 'npm-global', 'bin'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
    ...(process.env.PATH ?? '').split(delimiter),
    '/usr/local/bin', '/usr/bin', '/bin',
  ]
  return [...new Set(entries.filter(Boolean))].join(delimiter)
}


function usageFromSdk(raw: any): CodexUsage | null {
  const out = usageFromTokenUsagePayload(raw)
  if (!out) return null
  const summedTotal = (out.input_tokens ?? 0)
    + (out.output_tokens ?? 0)
    + (out.cache_creation_input_tokens ?? 0)
    + (out.cache_read_input_tokens ?? 0)
  const effectiveTotal = out.total_tokens ?? summedTotal
  if (effectiveTotal <= 0) return null
  if (out.total_tokens == null) out.total_tokens = summedTotal
  return out
}

/** Claude 路径上下文占用 = 输入侧 token(喂进模型的全部 input:未缓存新输入
 * + 缓存命中复读 + 本轮新建缓存),不含 output。与 Claude Code 底栏(omc hud)
 * 同口径 = input_tokens + cache_read_input_tokens + cache_creation_input_tokens。
 * 调用方传 result.usage(单 turn query = 当前上下文);modelUsage 是会话累计、
 * assistant.message.usage 在 stream-json 下恒 0/0,都不能用。 */
function contextOccupancyFromUsage(usage: CodexUsage | null | undefined): number | null {
  if (!usage) return null
  const occ = (usage.input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
  return occ > 0 ? occ : null
}

/** Claude Code session transcript 路径:~/.claude/projects/<cwd 编码>/<sid>.jsonl。
 * cwd 编码 = 绝对路径的 / 全替换成 -(claude code 约定,如 /home/x → -home-x)。 */
/** Claude Code transcript 目录:~/.claude/projects/<cwd 编码>/。同 cwd 的所有会话
 *  jsonl 都在此 —— rs 历史列表扫这个目录,得到同工作目录的全部 claude 会话
 *  (worktree 不同 cwd → 不同编码目录,自然不混进来)。cwd 编码 = 绝对路径 / 全替换成 -。 */
export function claudeTranscriptDir(workDir: string): string {
  // 编码对齐 Claude Code SDK:cwd 非字母数字字符全 → -(不只 /,[ ] . _ - 等也 → -)。
  // 否则 workDir 含特殊字符(如 test[deepseek])时,SDK 实际 transcript dir 与本函数算出的
  // 不一致,readLastCallUsageFromTranscript 读不到 → lastContextTokens 恒 null → footer 无 🧠。
  const encoded = workDir.replace(/[^a-zA-Z0-9]/g, '-')
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(configDir, 'projects', encoded)
}

export function claudeTranscriptPath(workDir: string, sessionId: string): string {
  return join(claudeTranscriptDir(workDir), `${sessionId}.jsonl`)
}

/** 读 transcript jsonl,取最后一条 assistant message 的 usage —— 这是最后一次 API
 * call 的真实 per-call usage(transcript 是 claude CLI 写的,assistant 行带 finalize
 * 后的 usage;不像 stream-json 的 assistant event 恒 0/0)。= session 当前上下文快照,
 * 与 Claude Code 底栏(omc hud)的 context_window.current_usage 同口径。失败/空 → null。 */
export function readLastCallUsageFromTranscript(path: string): CodexUsage | null {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const m = JSON.parse(line)
      if (m?.type === 'assistant' && m?.message?.usage) {
        const u = m.message.usage as CodexUsage
        // 跳过 synthetic 占位(SDK 对部分 turn 写 model='<synthetic>' usage 0/0,非真实 API call)
        const occ = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
        if (occ > 0) return u
      }
    } catch { /* skip malformed line */ }
  }
  return null
}

/** Latest SDK contextWindow per source/model route. A fresh smaller value is
 * authoritative too; smoothing the denominator must not hide a limit change. */
const contextWindowByRoute = new Map<string, number>()

function claudeRouteKey(model: string | null | undefined, tokenSourceId?: string | null): string {
  // opts.model 形如 'claude:glm' / 'claude:default';null 归一到 default。
  const source = tokenSourceId?.trim() || 'no-source'
  const route = model && model.trim() ? model : 'claude:default'
  return `${source}:${route}`
}

/** 仅供测试重置全局缓存,保证用例隔离。 */
export function resetClaudeContextWindowCache(): void {
  contextWindowByRoute.clear()
}

function totalUsageFromModelUsage(modelUsage: any): { usage: CodexUsage | null; contextWindow: number | null } {
  if (!modelUsage || typeof modelUsage !== 'object') return { usage: null, contextWindow: null }
  const usage: CodexUsage = {}
  let contextWindow: number | null = null
  for (const value of Object.values(modelUsage)) {
    if (!value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    usage.input_tokens = (usage.input_tokens ?? 0) + numberField(item.inputTokens ?? item.input_tokens)
    usage.output_tokens = (usage.output_tokens ?? 0) + numberField(item.outputTokens ?? item.output_tokens)
    usage.reasoning_output_tokens = (usage.reasoning_output_tokens ?? 0) + numberField(
      item.reasoningOutputTokens ?? item.reasoning_output_tokens,
    )
    usage.cache_read_input_tokens = (usage.cache_read_input_tokens ?? 0) + numberField(
      item.cacheReadInputTokens ?? item.cache_read_input_tokens,
    )
    usage.cache_creation_input_tokens = (usage.cache_creation_input_tokens ?? 0) + numberField(
      item.cacheCreationInputTokens ?? item.cache_creation_input_tokens,
    )
    const ctx = numberField(item.contextWindow ?? item.context_window)
    if (ctx > 0) contextWindow = Math.max(contextWindow ?? 0, ctx)
  }
  const total = (usage.input_tokens ?? 0)
    + (usage.output_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
  if (total <= 0) return { usage: null, contextWindow }
  usage.total_tokens = total
  return { usage, contextWindow }
}

function cloneUsage(usage: CodexUsage): CodexUsage {
  return { ...usage }
}

function objectKeys(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return []
  return Object.keys(raw as Record<string, unknown>).slice(0, 20)
}

function addUsageTotals(total: CodexUsage | null, delta: CodexUsage): CodexUsage {
  const out: CodexUsage = total ? { ...total } : {}
  const add = (key: keyof CodexUsage) => {
    const v = delta[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) return
    out[key] = (out[key] ?? 0) + v
  }
  add('total_tokens')
  add('input_tokens')
  add('output_tokens')
  add('reasoning_output_tokens')
  add('cache_creation_input_tokens')
  add('cache_read_input_tokens')
  return out
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function textFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
        return (item as { text: string }).text
      }
      return JSON.stringify(item)
    }).join('\n')
  }
  return content == null ? '' : JSON.stringify(content, null, 2)
}

function textFromServerToolResultContent(content: unknown): string {
  const text = textFromToolResultContent(content)
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) {
      const parts = parsed.map(item => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && typeof item.text === 'string') return item.text
        return JSON.stringify(item)
      }).filter(Boolean)
      if (parts.length > 0) return parts.join('\n')
    }
  } catch {
    // Provider server-tool output is often a JSON string array, but plain
    // text is valid too. Keep the original text when it is not JSON.
  }
  return text
}

function serverToolName(name: string): string {
  return `server_tool:${name}`
}

function serverToolInputFromScaffoldText(text: string): PendingServerToolInput | null {
  const name = text.match(/Built-in Tool:\s*([A-Za-z0-9_.:-]+)/)?.[1]
  if (!name) return null
  const inputText = text.match(/\*\*Input:\*\*\s*```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim()
  if (!inputText) return { name, input: {} }
  try {
    return { name, input: JSON.parse(inputText) }
  } catch {
    return { name, input: { raw: inputText } }
  }
}

function isServerToolScaffoldText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.includes('Built-in Tool:')
    || (trimmed.startsWith('**Output:**') && trimmed.includes('_result'))
}

function mapModelInfo(info: ModelInfo): CodexModel {
  const efforts = info.supportedEffortLevels && info.supportedEffortLevels.length > 0
    ? info.supportedEffortLevels
    : [CLAUDE_EFFORT]
  return {
    id: claudeModelKey(info.value),
    model: claudeModelKey(info.value),
    displayName: info.displayName || claudeModelKey(info.value),
    description: info.description || 'Claude Agent SDK backend',
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: efforts.map(effort => ({
      reasoningEffort: effort as any,
      description: '',
    })),
    defaultReasoningEffort: efforts.includes(CLAUDE_EFFORT) ? CLAUDE_EFFORT as any : efforts[0] as any,
  }
}

// default 模式保留 canUseTool 回调，使 AskUserQuestion 能等待用户回答。
export const CLAUDE_PERMISSION_MODE = 'default' as const

/** 未指定来源时读取项目配置。Token Source 可覆盖；注入凭据的来源不读 user，
 * 避免本机 settings 中的 Anthropic env 覆盖所选账号。 */
const DEFAULT_SETTING_SOURCES: readonly string[] = ['project', 'local']

/** Resolve SDK `settingSources` from a project profile's comma-separated
 * string (e.g. `"project"`), falling back to project+local. */
export function settingSourcesFromProfile(profile: ProjectProfile | undefined): string[] {
  if (!profile?.settingSources) return [...DEFAULT_SETTING_SOURCES]
  const list = profile.settingSources.split(',').map(s => s.trim()).filter(Boolean)
  return list.length ? list : [...DEFAULT_SETTING_SOURCES]
}

/** Resolve SDK `tools` from a project profile's comma-separated built-in
 * tool allow-list (e.g. `"Read,Write,Edit,Bash,Glob,Grep"`), falling back
 * to the `claude_code` preset. MCP tools are NOT listed here — they are
 * enabled separately via `mcpServers` and auto-join the tool set. */
export function toolsFromProfile(
  profile: ProjectProfile | undefined,
): string[] | { type: 'preset'; preset: 'claude_code' } {
  if (!profile?.tools) return { type: 'preset', preset: 'claude_code' }
  const list = profile.tools.split(',').map(s => s.trim()).filter(Boolean)
  return list.length ? list : { type: 'preset', preset: 'claude_code' }
}

/** Read `<workDir>/.mcp.json`, allowing an absent optional file. An existing
 * configuration that cannot be loaded must fail startup instead of silently
 * launching the Agent without the project's MCP tools. */
export function readProjectMcpServers(workDir: string): Record<string, McpServerConfig> | undefined {
  const mcpPath = join(workDir, '.mcp.json')
  let raw: string
  try {
    raw = readFileSync(mcpPath, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`project .mcp.json not readable at ${mcpPath}: ${e}`, { cause: e })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`project .mcp.json parse failed at ${mcpPath}: ${e}`, { cause: e })
  }
  const servers = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).mcpServers : undefined
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`project .mcp.json has no valid mcpServers object at ${mcpPath}`)
  }
  return servers as Record<string, McpServerConfig>
}

function normalizeDialogQuestions(payload: Record<string, unknown>, preservePreview = false): Array<Record<string, unknown>> {
  const rawQuestions = payload.questions
  const items = Array.isArray(rawQuestions)
    ? rawQuestions
    : rawQuestions && typeof rawQuestions === 'object'
      ? [rawQuestions]
      : [payload]
  return items
    .map(item => normalizeDialogQuestion(item, preservePreview))
    .filter((item): item is Record<string, unknown> => item !== null)
}

function normalizeDialogQuestion(raw: unknown, preservePreview: boolean): Record<string, unknown> | null {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : { question: raw }
  const question = firstString(item.question, item.prompt, item.title, item.message, item.text, item.label)
  if (!question) return null
  if (!question.trim()) return null
  const options = normalizeDialogOptions(item.options ?? item.choices ?? item.suggestions, preservePreview)
  return {
    ...item,
    question,
    options,
    ...(typeof item.header === 'string' ? { header: item.header } : {}),
    ...(typeof item.multiSelect === 'boolean' ? { multiSelect: item.multiSelect } : {}),
  }
}

function normalizeDialogOptions(raw: unknown, preservePreview: boolean): Array<Record<string, string>> {
  if (!Array.isArray(raw)) return []
  const options: Array<Record<string, string>> = []
  for (const item of raw) {
    if (typeof item === 'string') {
      options.push({ label: item })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const label = firstString(obj.label, obj.value, obj.text, obj.title)
    if (!label?.trim()) continue
    const description = firstString(obj.description, obj.detail, obj.preview)
    options.push({ label, ...(description ? { description } : {}),
      ...(preservePreview && typeof obj.preview === 'string' ? { preview: obj.preview } : {}) })
  }
  return options
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') return value
  }
  return undefined
}

// ── 后台任务 / 子 agent 生命周期事件 payload ─────────────────────────
// 对应 SDK 的 task_started / task_progress / task_updated / task_notification
// 四个 system subtype(见 handleSystemMessage 的 case 分支)。session 据此维护
// backgroundTasks 状态并驱动后台游标卡。之前这四个 subtype 全落 default 静默丢,
// 子 agent 启动后全程黑盒直到 tool_result 回来。

export type BgTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused'

export interface BgTaskUsage {
  total_tokens: number
  tool_uses: number
  duration_ms: number
}

export interface BgTaskStartedEvent {
  task_id: string
  tool_use_id?: string
  task_type?: string
  description: string
  subagent_type?: string
  workflow_name?: string
  prompt?: string
  display?: { description?: string; prompt?: string; workflow_name?: string }
}

export interface BgTaskProgressEvent {
  task_id: string
  description?: string
  subagent_type?: string
  usage?: BgTaskUsage
  last_tool_name?: string
  summary?: string
  display?: { description?: string; summary?: string }
}

export interface BgTaskUpdatedEvent {
  task_id: string
  patch: {
    status?: BgTaskStatus
    description?: string
    end_time?: number
    total_paused_ms?: number
    error?: string
    is_backgrounded?: boolean
  }
  display?: { description?: string; error?: string }
}

export interface BgTaskSettledEvent {
  task_id: string
  tool_use_id?: string
  status: 'completed' | 'failed' | 'stopped'
  summary?: string
  usage?: BgTaskUsage
  display?: { summary?: string }
}

type ClaudeMessageDisplay = {
  texts: Map<number, string>
  serverToolInputs: Map<string, unknown>
  toolInputs: Map<string, any>
  toolResults: Map<string, string>
  presentations: Map<string, { event: AgentTranslationPresentationEvent; surface: AgentTranslationPresentationSurface }>
  hidden: Set<string>
  system?: Record<string, unknown>
  scheduledText?: string
  error?: string
  failed?: boolean
}

export class ClaudeAgentProcess extends EventEmitter {
  readonly provider = 'claude' as const
  readonly tokenSourceId: string | null
  readonly translationEnabled: boolean

  private opts: ClaudeSpawnOpts
  private input = new AsyncQueue<SDKUserMessage>()
  private query: Query | null = null
  private readonly abortController = new AbortController()
  private alive = true
  private expectedExit = false
  private readonly exitPromise: Promise<void>
  private resolveExit!: () => void
  private started = false
  private queryStart?: Promise<void>
  private initializationError: Error | null = null
  private pendingPermissions = new Map<string, PendingControl>()
  private requestCounter = 0
  private cumulativeUsageFromResults: CodexUsage | null = null
  private turnActive = false
  /** Headless SDK streams do not always emit session_state_changed. A
   * submitted prompt also owns the task until its authoritative result. */
  private inputTurnPending = false
  /** Actual native submission/running state, excluding pending host translation. */
  private nativeTurnPending = false
  private steeringInputs = new Set<string>()
  /** A native result can beat a streaming-input write. Keep that native
   * continuation in the same visible task, and retain all result metadata. */
  private steeringResults: Array<{ usage: CodexUsage | null; duration: number | null; turns: number; error: string | null }> = []
  private steeringFailures: string[] = []
  private deferredSteeringResult: { raw: any; subtype: string; error: string | null } | null = null
  private emittedToolUseIds = new Set<string>()
  private emittedToolResultIds = new Set<string>()
  private pendingServerToolInputs: PendingServerToolInput[] = []
  private translationController = new AbortController()
  private translationInputQueue: Promise<void> = Promise.resolve()
  private translationFailure: Error | null = null
  private translationOutputStopped = false
  private translationContextInitialized = false
  private translationContextFailure: Error | null = null
  private readonly presentation?: ClaudePresentationTranslation
  private presentationPolicy?: AgentTranslationPresentationPolicy
  private readonly translatedToolNames = new Map<string, string>()
  private readonly translatedToolInputs = new Map<string, any>()
  private readonly translatedErrors = new Map<string, string>()

  sessionId: string | null = null
  lastAssistantUuid: string | null = null
  lastModel: string | null = null
  lastEffort: ClaudeReasoningEffort | null = null
  lastThinkingTokens: number | null = null
  lastUsage: CodexUsage | null = null
  lastTotalUsage: CodexUsage | null = null
  lastResult: CodexResultMeta = {
    cost_usd: null, cost_delta_usd: null, duration_ms: null, num_turns: null,
    usage: null, subtype: null, is_error: false,
  }
  lastContextWindow: number | null = null
  lastContextTokens: number | null = null

  constructor(opts: ClaudeSpawnOpts) {
    super()
    this.on('error', () => {})
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve })
    this.opts = opts
    this.presentation = opts.translation ? new ClaudePresentationTranslation(opts.translation) : undefined
    this.tokenSourceId = opts.tokenSourceId ?? null
    this.translationEnabled = !!opts.translation
    this.lastEffort = opts.effort
    this.lastModel = opts.model ? claudeModelKey(opts.model) : null
  }

  sendInitialize(): void {
    if (this.started) return
    this.started = true
    this.queryStart = this.initializeQuery().catch(error => {
      this.initializationError = error instanceof Error ? error : new Error(String(error))
      this.emit('error', this.initializationError)
      // 已启动的 query 由 readLoop 确认退出；清理失败时不能伪造进程已退出。
      if (!this.query) this.finishExit(1, null)
    })
  }

  private async *validatedInput(): AsyncIterableIterator<SDKUserMessage> {
    await this.queryStart
    if (this.initializationError || !this.alive) return
    yield* this.input
  }

  private async initializeQuery(): Promise<void> {
    const model = resolveClaudeSdkModel(this.opts.model)
    const profile = this.opts.profile
    if (profile) {
      log(`claude-agent-process: project profile active — settingSources=${profile.settingSources ?? '-'} strictMcp=${profile.strictMcp ?? false} tools=${profile.tools ?? '-'} loadProjectMcp=${profile.loadProjectMcp ?? true}`)
    }
    const settingSources = this.opts.settingSources ?? settingSourcesFromProfile(profile)
    const managedSkillOptions = claudeManagedSkillOptions(
      settingSources,
      this.opts.managedSkillPluginPath,
    )
    const toolsOption = toolsFromProfile(profile)
    const disallowedTools = [
      ...(this.opts.allowUserInput === false ? ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'] : []),
    ]
    const strictMcpConfig = profile?.strictMcp === true
    // Default true (CLI parity): discover <cwd>/.mcp.json like bare `claude`.
    // readProjectMcpServers returns undefined when no .mcp.json is present, so
    // this is a no-op for projects without one. Opt out: load_project_mcp = "false".
    const mcpServers = profile?.loadProjectMcp !== false ? readProjectMcpServers(this.opts.workDir) : undefined
    try {
      // Validate the local executable before any asynchronous context/GLM work.
      // Invalid explicit configuration must keep its synchronous error event.
      const executable = resolveClaudeExecutableConfig()
      if (this.opts.translation) await this.initializeTranslationContext()
      if (!this.alive || this.abortController.signal.aborted) return
      // resolveClaudeExecutableConfig 在 [claude].bin 配错路径时同步抛出;
      // 必须在 try 内调用,确保错误走 error/exit 事件而非穿透到调用方。
      const { query } = await loadClaudeSdk()
      if (!this.alive || this.abortController.signal.aborted) return
      const baseEnv: Record<string, string | undefined> = { ...(process.env as Record<string, string>), PATH: buildClaudeSpawnPath(),
        ...config.claude.env, ...(this.opts.hostEnv ?? {}) }
      const env = this.opts.transformEnv ? this.opts.transformEnv(baseEnv) : baseEnv
      // Claude Code 2.1.268+ hides task tracking on newer/unknown models unless
      // the host opts in. The session card consumes these Task tool events.
      env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1'
      if (this.opts.effort === 'default') env.CLAUDE_CODE_EFFORT_LEVEL = 'unset'
      log(`claude-agent-process: spawn SDK query model=${model ?? 'default'} effort=${this.opts.effort} cwd=${this.opts.workDir} executable=${executable.description}`)
      this.query = query({
        prompt: this.opts.validateAccount ? this.validatedInput() : this.input,
        options: {
          cwd: this.opts.workDir,
          abortController: this.abortController,
          ...(model ? { model } : {}),
          // 显式启动档位解除 CLI 的 Fable alias 启动固定档位；default 模式由真实
          // 子进程环境中的 unset 阻止发送 effort，不能只省略选项（CLI 会补 high）。
          effort: (this.opts.effort === 'default' ? 'high' : this.opts.effort) as EffortLevel,
          resume: this.opts.resumeSessionId,
          ...(this.opts.resumeSessionAt ? { resumeSessionAt: this.opts.resumeSessionAt } : {}),
          ...(this.opts.forkSession ? { forkSession: true } : {}),
          ...(executable.pathToClaudeCodeExecutable
            ? { pathToClaudeCodeExecutable: executable.pathToClaudeCodeExecutable }
            : {}),
          ...(executable.spawnClaudeCodeProcess
            ? { spawnClaudeCodeProcess: executable.spawnClaudeCodeProcess }
            : {}),
          permissionMode: CLAUDE_PERMISSION_MODE,
          env,
          settingSources: [...settingSources] as SettingSource[],
          ...(this.opts.settings ? { settings: this.opts.settings } : {}),
          ...managedSkillOptions,
          tools: toolsOption,
          ...(disallowedTools.length ? { disallowedTools } : {}),
          ...(strictMcpConfig ? { strictMcpConfig: true } : {}),
          ...(mcpServers ? { mcpServers } : {}),
          toolConfig: {
            askUserQuestion: { previewFormat: 'markdown' },
          },
          canUseTool: (toolName, input, opts) => this.canUseTool(toolName, input, opts),
          includePartialMessages: false,
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            // Native prompt snapshots otherwise keep an earlier host's append
            // verbatim on resume, including a different invocation's input policy.
            ...(this.opts.appendSystemPrompt ? { append: this.opts.appendSystemPrompt, snapshot: false } : {}),
          },
          stderr: data => {
            const text = data.trim()
            if (text) log(`claude-agent-process[stderr]: ${text}`)
          },
        },
      })
    } catch (e) {
      if (this.opts.translation && this.expectedExit) return
      const err = e instanceof Error ? e : new Error(String(e))
      this.initializationError = err
      this.emit('error', err)
      this.finishExit(1, null)
      return
    }
    void this.readLoop(this.query)
    if (this.opts.validateAccount) {
      try {
        this.opts.validateAccount(await this.query.accountInfo())
      } catch (error) {
        this.initializationError = error instanceof Error ? error : new Error(String(error))
        this.emit('error', this.initializationError)
        await this.kill()
      }
    }
  }

  sendUserText(text: string, files: string[] = [], metadata?: { contextPrefix?: string }): void {
    if (!this.alive) {
      log('claude-agent-process: sendUserText ignored on dead process')
      return
    }
    if (this.translationContextFailure) { this.failTurnStart(this.translationContextFailure); return }
    if (!this.started) this.sendInitialize()
    const fileHints = (metadata?.contextPrefix ?? '') + (files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n\n' : '')
    if (this.opts.translation) {
      this.translationOutputStopped = false
      this.inputTurnPending = true
      const signal = this.translationController.signal
      const inputId = randomUUID()
      void this.queueTranslatedInput(text, signal).then(translated => {
        if (signal.aborted || !this.alive || this.expectedExit) return
        this.pushUserText(fileHints + translated, inputId)
        this.opts.translationContext?.stageInput(inputId, text, translated, this.translationInputOrigin())
        this.emit('user_input_submitted', {})
      }).catch(error => {
        if (signal.aborted || !this.alive || this.expectedExit) return
        this.invalidateTranslations()
        this.failTurnStart(this.translationError('input', error))
      })
      return
    }
    try {
      this.inputTurnPending = true
      this.pushUserText(fileHints + text)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      log(`claude-agent-process: sendUserText failed: ${err.message}`)
      this.failTurnStart(err)
    }
  }

  async steerUserText(text: string, files: string[] = [], inputId = randomUUID()): Promise<boolean> {
    if (!this.alive || this.expectedExit) throw new Error('Claude 进程已关闭')
    if (!this.turnActive && !this.inputTurnPending && this.steeringResults.length === 0) return false
    const uuid = inputId
    const originalText = text
    const fileHints = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n\n' : ''
    const translationSignal = this.translationController.signal
    this.steeringInputs.add(uuid)
    try {
      if (this.opts.translation) {
        text = await this.queueTranslatedInput(text, translationSignal)
        if (translationSignal.aborted || !this.alive || this.expectedExit) {
          this.steeringInputs.delete(uuid)
          return false
        }
      }
      this.input.push({ type: 'user', uuid, session_id: this.sessionId ?? '',
        message: { role: 'user', content: [{ type: 'text', text: fileHints + text }] },
        // `now` aborts the current native request. `next` is folded in at
        // a tool boundary, or starts the next native turn if this one ended.
        parent_tool_use_id: null, priority: 'next' })
      this.nativeTurnPending = true
      this.opts.translationContext?.stageInput(uuid, originalText, text, this.translationInputOrigin())
    } catch (error) {
      this.steeringInputs.delete(uuid)
      if (this.opts.translation) {
        if (translationSignal.aborted || !this.alive || this.expectedExit) return false
        const failure = this.translationError('additional input', error)
        this.steeringFailures.push(failure.message)
        if (!this.steeringInputs.size && !this.inputTurnPending && !this.turnActive && this.deferredSteeringResult) {
          const deferred = this.deferredSteeringResult
          this.finishInputResult(deferred.raw, deferred.subtype, deferred.error)
        }
        throw failure
      }
      throw error
    }
    return true
  }

  private pushUserText(text: string, uuid?: string): void {
    this.input.push({
      type: 'user', session_id: this.sessionId ?? '', ...(uuid ? { uuid } : {}),
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null, priority: 'now',
    } as SDKUserMessage)
    this.nativeTurnPending = true
  }

  private queueTranslatedInput(text: string, signal: AbortSignal): Promise<string> {
    const operation = this.translationInputQueue.then(async () => {
      await this.initializeTranslationContext()
      signal.throwIfAborted()
      const translated = await this.opts.translation!.toEnglish(text, signal, this.translationInputOrigin())
      signal.throwIfAborted()
      return translated
    })
    // Each caller handles its own failure. A failed input must not poison the
    // queue for a subsequent, explicitly submitted user turn.
    this.translationInputQueue = operation.then(() => {}, () => {})
    return operation
  }

  private invalidateTranslations(): void {
    this.translationController.abort(new Error('Claude translation cancelled'))
    this.translationController = new AbortController()
    this.translationInputQueue = Promise.resolve()
    if (this.translationContextInitialized) this.opts.translationContext?.cancelPendingInputs()
  }

  private async initializeTranslationContext(): Promise<void> {
    if (this.translationContextFailure) throw this.translationContextFailure
    if (!this.opts.translationContext) return
    await this.opts.translationContext.initialize(this.abortController.signal)
    this.translationContextInitialized = true
  }

  async translateDisplayFields(texts: string[], signal = this.translationController.signal,
    acceptDisplay?: (translated: string[]) => boolean): Promise<string[]> {
    if (!this.opts.translation) throw new Error('Claude display translation is unavailable')
    await this.initializeTranslationContext()
    signal.throwIfAborted()
    const translated = await this.opts.translation.toChineseFields(texts, signal, CLAUDE_TRANSLATION_ORIGINS.delegatedRequest)
    signal.throwIfAborted()
    if (translated.length !== texts.length) throw new Error('展示翻译字段数量不符')
    if (acceptDisplay?.(translated)) {
      signal.throwIfAborted()
      this.opts.translationContext?.recordOutput('delegated-request', texts.join('\n\n'), translated.join('\n\n'),
        undefined, undefined, CLAUDE_TRANSLATION_ORIGINS.delegatedRequest)
    }
    return translated
  }

  private translationInputOrigin(): string {
    return this.opts.hostEnv?.LODESTAR_AGENT_ROLE === 'worker'
      ? CLAUDE_TRANSLATION_ORIGINS.delegatedRequest : CLAUDE_TRANSLATION_ORIGINS.userMessage
  }

  private translationAnswerOrigin(): string {
    return this.opts.hostEnv?.LODESTAR_AGENT_ROLE === 'worker'
      ? CLAUDE_TRANSLATION_ORIGINS.delegatedAnswer : CLAUDE_TRANSLATION_ORIGINS.userAnswer
  }

  private translationQuestionOrigin(): string {
    return this.opts.hostEnv?.LODESTAR_AGENT_ROLE === 'worker'
      ? CLAUDE_TRANSLATION_ORIGINS.delegatedQuestion : CLAUDE_TRANSLATION_ORIGINS.question
  }

  private translationReplyOrigin(parentToolUseId?: string | null): string {
    if (parentToolUseId) return CLAUDE_TRANSLATION_ORIGINS.subagentOutput
    return this.opts.hostEnv?.LODESTAR_AGENT_ROLE === 'worker'
      ? CLAUDE_TRANSLATION_ORIGINS.delegatedOutput : CLAUDE_TRANSLATION_ORIGINS.reply
  }

  private translationToolOrigin(name: string, parentToolUseId?: string | null, result = false): string {
    if (result) return CLAUDE_TRANSLATION_ORIGINS.toolResult
    const origin = claudeToolInputOrigin(name)
    if (parentToolUseId || this.opts.hostEnv?.LODESTAR_AGENT_ROLE === 'worker') {
      return `${this.translationReplyOrigin(parentToolUseId)} Content: ${origin.slice(origin.lastIndexOf(':') + 1).trim()}`
    }
    return origin
  }

  setTranslationPresentationPolicy(policy: AgentTranslationPresentationPolicy): void {
    this.presentationPolicy = policy
  }

  private presentationSurface(event: AgentTranslationPresentationEvent): AgentTranslationPresentationSurface | 'hidden' {
    return this.presentationPolicy ? this.presentationPolicy(event) : event.parentToolUseId ? 'background' : 'main'
  }

  /** A child can settle while GLM is in flight. Keep its native events, but do
   * not publish or record text the consumer no longer displays. */
  private discardHiddenPresentations(display: ClaudeMessageDisplay): void {
    for (const [key, presentation] of display.presentations) {
      if (this.presentationSurface(presentation.event) !== 'hidden') continue
      display.hidden.add(key)
      display.presentations.delete(key)
      if (key.startsWith('text:')) display.texts.delete(Number(key.slice(5)))
      else if (key.startsWith('input:')) {
        const id = key.slice(6)
        if (this.translatedToolInputs.get(id) === display.toolInputs.get(id)) this.translatedToolInputs.delete(id)
        display.toolInputs.delete(id)
      } else if (key.startsWith('result:')) display.toolResults.delete(key.slice(7))
      else if (key === 'background') display.system = undefined
      else if (key === 'scheduled') display.scheduledText = undefined
    }
  }

  private translationError(boundary: string, cause: unknown): Error {
    const label: Record<string, string> = { input: '输入', output: '输出', context: '会话上下文', question: '提问', 'question answer': '回答', 'additional input': '追加输入' }
    return new Error(`Claude ${label[boundary] ?? boundary}翻译失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }

  private reportTranslationFailure(boundary: string, cause: unknown, awaitNativeResult = true): Error {
    const error = this.translationError(boundary, cause)
    if (awaitNativeResult) this.translationFailure ??= error
    log(`claude-agent-process: ${error.message}`)
    this.emit('error', error)
    this.emit('turn_input_error', { error: error.message })
    // Background presentation can outlive the main turn. An idle query will
    // not produce a result for an interrupt; do not poison the next user turn.
    if (!awaitNativeResult) return error
    // The SDK remains alive. Interrupt the actual turn and wait for its native
    // result; a presentation failure is not evidence of a process exit.
    this.translationOutputStopped = true
    this.invalidateTranslations()
    this.input.clear()
    this.inputTurnPending = false
    this.steeringInputs.clear()
    // Keep usage/errors from native continuation results already received.
    // Translation failure must not erase work completed earlier in this task.
    this.requestNativeInterrupt()
    return error
  }

  sendInterrupt(): void {
    if (this.opts.translation) {
      this.translationOutputStopped = true
      this.invalidateTranslations()
    }
    this.input.clear()
    this.inputTurnPending = false
    this.steeringInputs.clear()
    this.steeringResults = []
    this.steeringFailures = []
    this.deferredSteeringResult = null
    this.requestNativeInterrupt()
  }

  private requestNativeInterrupt(): void {
    // The runtime supports cancel_queued, while the SDK public declaration
    // still omits the options argument. Cancel both already-written messages
    // and the local stream backlog so stop cannot wake another user turn.
    const query = this.query as (Query & { interrupt(options: { cancelQueued: true }): ReturnType<Query['interrupt']> }) | null
    void query?.interrupt({ cancelQueued: true }).then(receipt => {
      if (!receipt || !Array.isArray(receipt.still_queued) || receipt.still_queued.length > 0) {
        throw new Error('停止请求未确认全部追加消息已取消')
      }
    }).catch(e => {
      log(`claude-agent-process: interrupt failed: ${e}`)
      this.emit('turn_input_error', { error: `停止请求失败：${e instanceof Error ? e.message : String(e)}` })
    })
  }

  sendPermissionResponse(
    requestId: string | number,
    decision: 'allow' | 'deny',
    payload?: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown; denyMessage?: string },
  ): void {
    // default 模式下 canUseTool 是唯一权限入口;此方法同时服务于两条路:
    // AskUserQuestion(allow 回填 answers / deny 取消)和普通工具审批卡片。
    const pending = this.pendingPermissions.get(String(requestId))
    if (!pending) {
      log(`claude-agent-process: permission response for unknown request ${requestId}`)
      return
    }
    if (this.opts.translation && pending.originalInput) {
      if (pending.answering) return
      pending.answering = true
      void this.resolveTranslatedPermission(String(requestId), pending, decision, payload)
      return
    }
    this.pendingPermissions.delete(String(requestId))
    pending.cleanup?.()
    if (decision === 'allow') {
      // allow 的 updatedInput 运行时必填(SDK Zod 校验,比 .d.ts 可选更严):给空=不改。
      pending.resolve({
        behavior: 'allow',
        updatedInput: payload?.updatedInput ?? {},
      })
    } else {
      // deny 的 message 同样必填;空字符串=无附加说明。
      pending.resolve({ behavior: 'deny', message: payload?.denyMessage ?? '' })
    }
  }

  sendHookResponse(_requestId: string, _output: object = {}): void {
    log('claude-agent-process: sendHookResponse ignored; hooks are handled by SDK callbacks')
  }

  isAlive(): boolean {
    return this.alive
  }

  hasPendingNativeTurn(): boolean {
    return this.nativeTurnPending || this.turnActive
  }

  async kill(timeoutMs = 5000): Promise<void> {
    if (!this.alive) return
    this.expectedExit = true
    if (this.opts.translation) this.invalidateTranslations()
    this.denyPendingPermissions('claude process is stopping')
    // Hard process stop: queued user turns belong to the discarded process
    // generation and must never drain during the SDK abort window.
    this.input.abort()
    if (!this.started || !this.query) {
      if (this.opts.translation && !this.abortController.signal.aborted) this.abortController.abort(new Error('claude process shutdown requested'))
      this.finishExit(null, null)
      return
    }

    let closeError: Error | null = null
    try {
      this.query.close()
    } catch (e) {
      closeError = e instanceof Error ? e : new Error(String(e))
    }
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(closeError ?? new Error('claude process shutdown requested'))
    }

    if (!await this.waitForExit(timeoutMs)) {
      const error = new Error(
        `claude Agent SDK query did not exit within ${timeoutMs}ms after close/abort`,
        closeError ? { cause: closeError } : undefined,
      )
      log(`claude-agent-process: kill failed: ${error.message}`)
      throw error
    }
    if (closeError) {
      const error = new Error(`claude Agent SDK close failed: ${closeError.message}`, { cause: closeError })
      log(`claude-agent-process: kill failed: ${error.message}`)
      throw error
    }
  }

  async listModels(): Promise<CodexModel[]> {
    if (!this.started) this.sendInitialize()
    await this.queryStart
    if (this.initializationError) throw this.initializationError
    if (!this.query) throw new Error('claude-agent-process: SDK query not initialized (sendInitialize failed or not called)')
    const models = await this.query.supportedModels()
    return models.map(mapModelInfo)
  }

  /** 原生 /usage 控制查询；不发送对话，也不扫描本机历史用量。 */
  async readSubscriptionUsage(): Promise<SDKControlGetUsageResponse> {
    if (!this.started) this.sendInitialize()
    await this.queryStart
    if (this.initializationError) throw this.initializationError
    if (!this.query || !this.alive) throw new Error('Claude 订阅额度查询连接未就绪或已退出')
    const readUsage = this.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof readUsage !== 'function') {
      throw new Error('当前 Claude SDK 不支持原生订阅额度查询，需更新 Agent 或适配其接口')
    }
    return readUsage.call(this.query, { skipBehaviors: true })
  }

  async setModelSettings(model: string, effort: AgentReasoningEffort): Promise<void> {
    const claudeModel = resolveClaudeSdkModel(model)
    if (!isClaudeReasoningEffort(effort)) throw new Error(`invalid Claude effort: ${String(effort)}`)
    if ((this.opts.effort === 'default') !== (effort === 'default')) {
      throw new Error('effort 参数模式改变，需要使用新的启动环境恢复会话')
    }
    if (!this.started) this.sendInitialize()
    await this.queryStart
    if (this.initializationError) throw this.initializationError
    if (!this.query) throw new Error('claude-agent-process: SDK query not initialized (sendInitialize failed or not called)')
    try {
      await this.query.setModel(claudeModel)
    } catch (cause) {
      this.lastModel = null
      this.lastEffort = null
      throw new ModelSettingsUpdateError(`模型设置未确认：${cause instanceof Error ? cause.message : String(cause)}`, null, { cause })
    }
    this.opts.model = model
    this.lastModel = claudeModel ? claudeModelKey(model) : 'claude:default'
    this.lastEffort = null
    try {
      await this.query.applyFlagSettings({ effortLevel: effort === 'default' ? null : effort, ultracode: null })
    } catch (cause) {
      throw new ModelSettingsUpdateError(`模型已切换为 ${model}，但思考档位未确认：${cause instanceof Error ? cause.message : String(cause)}`, model, { cause })
    }
    this.opts.effort = effort
    this.lastEffort = effort
  }

  async compactThread(): Promise<void> {
    // /compact 通过 streaming input 执行，以 compact_boundary 为完成信号。
    // 不设固定时限；仅明确的 "Not enough messages to compact" 表示无需压缩。
    // result 可能先于 boundary 到达，不能据此提前结束等待。
    if (!this.input) throw new Error('claude thread not initialized')
    if (this.opts.translation) this.translationOutputStopped = false
    this.input.push({
      type: 'user',
      session_id: this.sessionId ?? '',
      message: { role: 'user', content: [{ type: 'text', text: '/compact' }] },
      parent_tool_use_id: null,
      priority: 'now',
    } as SDKUserMessage)
    const assistantTextEvent = this.opts.translation ? 'assistant_control_text' : 'assistant_text'
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        this.off('context_compacted', onCompacted)
        this.off(assistantTextEvent, onAssistantText)
        this.off('exit', onExit)
        this.off('error', onError)
      }
      const onCompacted = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const onAssistantText = (e: { text?: string } | undefined) => {
        // 只认 claude code /compact 在 transcript 不足时的固定输出文案。真压缩不会 emit
        // 这句(实测:真压缩 emit compact_boundary + 可选总结文本,无此句),所以不会误杀真压缩。
        if (settled) return
        const text = e?.text ?? ''
        if (text.includes('Not enough messages to compact')) {
          settled = true
          cleanup()
          reject(new NothingToCompactError())
        }
      }
      const onExit = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error('claude thread exited during /compact'))
      }
      const onError = (e: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
      this.on('context_compacted', onCompacted)
      this.on(assistantTextEvent, onAssistantText)
      this.once('exit', onExit)
      this.once('error', onError)
    })
  }

  private canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ): Promise<PermissionResult> {
    // 非 AskUserQuestion:秒放,复刻旧 bypassPermissions「不弹审批」语义。
    // default 模式下 canUseTool 对每个需权限的工具都会被调,这里只拦 AskUserQuestion。
    if (toolName !== 'AskUserQuestion') {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    // AskUserQuestion:SDK 把它当权限工具经 canUseTool 下发。host 渲染卡片、等用户
    // 点选,再以 allow + updatedInput.answers 回送,模型据此续跑。
    const questions = normalizeDialogQuestions(input, !!this.opts.translation)
    if (questions.length === 0) {
      log('claude-agent-process: AskUserQuestion 无有效 questions — allow 原样')
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    const normalizedInput = { ...input, questions }
    if (this.opts.translation) return this.translatedDialog(normalizedInput, options)
    return this.beginDialog(normalizedInput, options)
  }

  private beginDialog(
    normalizedInput: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
    originalInput?: Record<string, unknown>,
    cleanup?: () => void,
  ): Promise<PermissionResult> {
    if (this.opts.translation && options.signal.aborted) {
      cleanup?.()
      return Promise.resolve({ behavior: 'deny', message: 'aborted' })
    }
    const requestId = `claude_perm_${++this.requestCounter}`
    const toolUseId = options.toolUseID || requestId
    const req: CanUseToolRequest = {
      request_id: requestId,
      tool_name: 'AskUserQuestion',
      input: normalizedInput,
      tool_use_id: toolUseId,
      ...(originalInput ? { originalInput } : {}),
    }
    const pending = new Promise<PermissionResult>(resolve => {
      const finish = (value: PermissionResult) => {
        options.signal.removeEventListener('abort', abort)
        cleanup?.()
        resolve(value)
      }
      const abort = () => {
        if (!this.pendingPermissions.delete(requestId)) return
        finish({ behavior: 'deny', message: 'aborted' })
      }
      options.signal.addEventListener('abort', abort, { once: true })
      this.pendingPermissions.set(requestId, { kind: 'dialog', resolve: finish, request: req,
        ...(originalInput ? { originalInput, translationSignal: options.signal } : {}) })
    })
    this.emitToolUseOnce(toolUseId, 'AskUserQuestion', originalInput ?? normalizedInput, null, originalInput ? normalizedInput : undefined)
    this.emit('can_use_tool', req)
    return pending
  }

  private async translatedDialog(
    originalInput: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ): Promise<PermissionResult> {
    const controller = new AbortController()
    const signals = [options.signal, this.translationController.signal]
    const abort = () => controller.abort(new Error('Claude question translation cancelled'))
    const cleanup = () => signals.forEach(signal => signal.removeEventListener('abort', abort))
    for (const signal of signals) {
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    try {
      await this.initializeTranslationContext()
      controller.signal.throwIfAborted()
      const fields: string[] = []
      const bindings: Array<{ target: Record<string, unknown>; key: string }> = []
      const bind = (target: Record<string, unknown>, key: string) => {
        if (typeof target[key] !== 'string') return
        fields.push(target[key] as string)
        bindings.push({ target, key })
      }
      const questions = (originalInput.questions as Array<Record<string, unknown>>).map(question => {
        const options = (Array.isArray(question.options) ? question.options as Array<Record<string, unknown>> : []).map(option => ({ ...option }))
        const translated: Record<string, unknown> & { options: Array<Record<string, unknown>> } = { ...question, options }
        bind(translated, 'question')
        for (const option of options) {
          bind(option, 'label')
          bind(option, 'description')
        }
        return translated
      })
      const translatedFields = await this.opts.translation!.toChineseFields(fields, controller.signal, this.translationQuestionOrigin())
      if (translatedFields.length !== fields.length || translatedFields.some(field => typeof field !== 'string')) {
        throw new Error('translated question field count or type is invalid')
      }
      bindings.forEach(({ target, key }, index) => { target[key] = translatedFields[index]! })
      controller.signal.throwIfAborted()
      if (new Set(questions.map(question => question.question)).size !== questions.length) {
        throw new Error('translated questions are ambiguous')
      }
      for (const question of questions) {
        if (new Set(question.options.map(option => option.label)).size !== question.options.length) {
          throw new Error('translated question options are ambiguous')
        }
      }
      this.opts.translationContext?.recordOutput('question', fields.join('\n\n'), translatedFields.join('\n\n'), undefined,
        options.toolUseID ? `question:${options.toolUseID}` : undefined, this.translationQuestionOrigin())
      return await this.beginDialog({ ...originalInput, questions }, { ...options, signal: controller.signal }, originalInput, cleanup)
    } catch (cause) {
      cleanup()
      if (controller.signal.aborted || !this.alive || this.expectedExit) return { behavior: 'deny', message: 'aborted' }
      this.reportTranslationFailure('question', cause)
      return { behavior: 'deny', message: 'The host could not translate or validate this question. The user has been informed and this turn is being interrupted.' }
    }
  }

  private async resolveTranslatedPermission(
    requestId: string,
    pending: PendingUserDialog,
    decision: 'allow' | 'deny',
    payload?: { updatedInput?: Record<string, unknown>; denyMessage?: string },
  ): Promise<void> {
    const signal = pending.translationSignal!
    try {
      let result: PermissionResult
      if (decision === 'deny') {
        const message = payload?.denyMessage ? await this.opts.translation!.toEnglish(payload.denyMessage, signal, this.translationAnswerOrigin()) : ''
        result = { behavior: 'deny', message }
      } else {
        const rawAnswers = payload?.updatedInput?.answers
        if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
          throw new Error('question response has no valid answers object')
        }
        const original = pending.originalInput!.questions as Array<Record<string, unknown>>
        const displayed = pending.request.input.questions as Array<Record<string, unknown>>
        const answers: Record<string, string> = {}
        for (const [key, value] of Object.entries(rawAnswers)) {
          if (typeof value !== 'string') throw new Error('question answer must be text')
          const index = displayed.findIndex((question, i) => question.question === key || original[i]?.question === key || original[i]?.id === key)
          if (index < 0) throw new Error('question response references an unknown question')
          const sourceQuestion = original[index]!
          const sourceKey = String(sourceQuestion.question)
          if (Object.hasOwn(answers, sourceKey)) throw new Error('question response contains duplicate answer keys')
          const visibleOptions = displayed[index]!.options as Array<Record<string, unknown>>
          const sourceOptions = sourceQuestion.options as Array<Record<string, unknown>>
          const selections = this.resolveAnswerSelection(value, sourceOptions, visibleOptions, sourceQuestion.multiSelect === true)
          if (selections) {
            // Check the native selection representation for ambiguity without
            // replacing the user's actual answer in the translation request.
            const sourceLabels = selections.map(selected => String(sourceOptions[selected]!.label)).join(', ')
            this.resolveAnswerSelection(sourceLabels, sourceOptions, sourceOptions, sourceQuestion.multiSelect === true)
          }
          answers[sourceKey] = await this.opts.translation!.toEnglish(value, signal, this.translationAnswerOrigin())
        }
        result = { behavior: 'allow', updatedInput: { ...pending.originalInput!, answers } }
      }
      signal.throwIfAborted()
      if (this.pendingPermissions.get(requestId) !== pending || !this.alive || this.expectedExit) return
      const answerText = (answers: unknown): string => answers && typeof answers === 'object' && !Array.isArray(answers)
        ? Object.entries(answers).map(([question, value]) => `${question}: ${String(value)}`).join('\n') : String(answers ?? '')
      this.opts.translationContext?.recordInteraction('user/answer',
        answerText(payload?.updatedInput?.answers ?? payload?.denyMessage),
        answerText(result.behavior === 'allow' ? (result.updatedInput as Record<string, unknown>)?.answers : result.message),
        this.translationAnswerOrigin())
      this.pendingPermissions.delete(requestId)
      pending.resolve(result)
    } catch (cause) {
      if (this.pendingPermissions.get(requestId) !== pending) return
      this.pendingPermissions.delete(requestId)
      if (signal.aborted || !this.alive || this.expectedExit) {
        pending.resolve({ behavior: 'deny', message: 'aborted' })
        return
      }
      this.reportTranslationFailure('question answer', cause)
      pending.resolve({ behavior: 'deny', message: 'The host could not translate or validate the answer. The user has been informed and this turn is being interrupted.' })
    }
  }

  private resolveAnswerSelection(
    answer: string,
    original: Array<Record<string, unknown>>,
    displayed: Array<Record<string, unknown>>,
    multiSelect: boolean,
  ): number[] | null {
    const matches = new Map<string, number[]>()
    const visit = (offset: number, selected: number[]) => {
      if (matches.size > 1) return
      for (let index = 0; index < original.length; index++) {
        if (selected.includes(index)) continue
        for (const label of new Set([String(original[index]!.label), String(displayed[index]!.label)])) {
          if (!label || !answer.startsWith(label, offset)) continue
          const next = offset + label.length
          const selection = [...selected, index]
          if (next === answer.length) matches.set(selection.join(','), selection)
          else if (multiSelect && answer[next] === ',') {
            const separator = answer.slice(next).match(/^,\s*/)?.[0]
            if (separator) visit(next + separator.length, selection)
          }
        }
      }
    }
    visit(0, [])
    if (matches.size > 1) throw new Error('question answer has ambiguous option labels')
    return matches.values().next().value ?? null
  }

  private async readLoop(q: Query): Promise<void> {
    try {
      for await (const message of q) {
        if (this.opts.translation) await this.handleTranslatedMessage(message)
        else this.handleMessage(message)
      }
      this.finishExit(null, null)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      if (this.expectedExit && this.abortController.signal.aborted) {
        log(`claude-agent-process: read loop stopped after requested shutdown: ${err.message}`)
        this.finishExit(null, null)
        return
      }
      log(`claude-agent-process: read loop failed: ${err.message}`)
      this.emit('error', err)
      this.finishExit(1, null)
    }
  }

  private finishExit(code: number | null, signal: string | null): void {
    if (!this.alive) return
    this.alive = false
    if (this.opts.translation) this.invalidateTranslations()
    this.translatedToolInputs.clear()
    this.turnActive = false
    this.nativeTurnPending = false
    this.inputTurnPending = false
    this.steeringInputs.clear()
    this.steeringResults = []
    this.steeringFailures = []
    this.deferredSteeringResult = null
    this.denyPendingPermissions('claude process exited')
    this.resolveExit()
    log(`claude-agent-process: exited code=${code} signal=${signal} expected=${this.expectedExit}`)
    this.emit('exit', { code, signal, expected: this.expectedExit })
  }

  private denyPendingPermissions(message: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      pending.cleanup?.()
      pending.resolve({ behavior: 'deny', message })
      this.pendingPermissions.delete(id)
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.alive) return true
    return new Promise(resolve => {
      let settled = false
      const finish = (exited: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(exited)
      }
      const timeout = setTimeout(() => finish(!this.alive), Math.max(0, timeoutMs))
      void this.exitPromise.then(() => finish(true))
    })
  }

  private observeTranslationContext(raw: any): void {
    if (!this.translationContextInitialized || !this.opts.translationContext) return
    const context = this.opts.translationContext
    if (!raw.parent_tool_use_id && typeof raw.session_id === 'string' && raw.session_id) {
      context.bindSession(raw.session_id)
      this.opts.translation?.bindSession?.(raw.session_id)
    }
    if (raw.type === 'command_lifecycle' && typeof raw.command_uuid === 'string') {
      if (raw.state === 'started' || raw.state === 'completed') context.confirmInput(raw.command_uuid)
      if (raw.state === 'cancelled') context.cancelInput(raw.command_uuid)
    }
    if (!raw.parent_tool_use_id) {
      const ids = Array.isArray(raw.user_message_uuids) ? raw.user_message_uuids : []
      for (const id of [...ids, raw.user_message_uuid]) if (typeof id === 'string') context.confirmInput(id)
      if (raw.type === 'user' && typeof raw.uuid === 'string') context.confirmInput(raw.uuid)
    }
  }

  private resultErrorText(raw: any): string | null {
    const subtype = typeof raw.subtype === 'string' ? raw.subtype : raw.is_error ? 'error' : 'success'
    return raw.is_error === true || subtype !== 'success'
      ? Array.isArray(raw.errors) && raw.errors.length ? raw.errors.map(String).join('\n')
        : String(raw.result ?? raw.error ?? raw.api_error_message ?? subtype)
      : null
  }

  private userToolOutput(raw: any, block: any): string {
    const content = textFromToolResultContent(block.content)
    if (content) return content
    const result = raw.tool_use_result
    return result && typeof result === 'object'
      ? [typeof result.stdout === 'string' ? result.stdout : '', typeof result.stderr === 'string' ? result.stderr : ''].filter(Boolean).join('\n') : ''
  }

  private async handleTranslatedMessage(message: SDKMessage): Promise<void> {
    const raw = message as any
    // Native child-task steps display receipts that main question/task panels omit.
    const receiptVisible = typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id.length > 0
    if (raw.type === 'assistant') this.emitAssistantControlText(raw)
    const scheduled = raw.type === 'user' && raw.isMeta === true && raw.promptSource === 'sdk'
      && typeof raw.message?.content === 'string' && raw.message.content.trim()
    if (scheduled) this.translationOutputStopped = false
    const signal = this.translationController.signal
    const display: ClaudeMessageDisplay = { texts: new Map(), toolInputs: new Map(), toolResults: new Map(),
      serverToolInputs: raw.type === 'assistant' ? this.prepareServerToolInputs(raw) : new Map(),
      presentations: new Map(), hidden: new Set() }
    const parentToolUseId = typeof raw.parent_tool_use_id === 'string' ? raw.parent_tool_use_id : null
    const prepare = async <T>(key: string, event: AgentTranslationPresentationEvent,
      translate: (surface: AgentTranslationPresentationSurface) => Promise<T>): Promise<T | undefined> => {
      const surface = this.presentationSurface(event)
      if (surface === 'hidden') { display.hidden.add(key); return undefined }
      const translated = await translate(surface)
      signal.throwIfAborted()
      if (this.presentationSurface(event) === 'hidden') { display.hidden.add(key); return undefined }
      display.presentations.set(key, { event, surface })
      return translated
    }
    try {
      if (!this.translationContextFailure) this.observeTranslationContext(raw)
    } catch (cause) {
      this.translationContextFailure = this.translationError('context', cause)
      this.reportTranslationFailure('context', cause)
    }
    const canTranslate = !this.translationContextFailure && !this.translationFailure && !this.translationOutputStopped && this.alive && !this.expectedExit
    try {
      if (canTranslate) {
        if (raw.type === 'assistant') {
          const blocks = Array.isArray(raw.message?.content) ? raw.message.content : []
          for (let index = 0; index < blocks.length; index++) {
            const block = blocks[index]
            if (block?.type === 'text' && typeof block.text === 'string' && block.text && !isServerToolScaffoldText(block.text)) {
              const translated = await prepare(`text:${index}`, { kind: 'assistant_text', parentToolUseId },
                () => this.opts.translation!.toChinese(block.text, signal, this.translationReplyOrigin(parentToolUseId)))
              if (translated !== undefined) display.texts.set(index, translated)
            } else if ((block?.type === 'tool_use' || block?.type === 'server_tool_use') && typeof block.id === 'string' && typeof block.name === 'string' && block.name !== 'AskUserQuestion') {
              const name = block.type === 'server_tool_use' ? serverToolName(block.name) : block.name
              const input = block.type === 'server_tool_use' ? display.serverToolInputs.get(block.id) : block.input ?? {}
              this.translatedToolNames.set(block.id, name)
              const translated = await prepare(`input:${block.id}`,
                { kind: 'tool_input', parentToolUseId, toolUseId: block.id, toolName: name },
                surface => this.presentation!.toolInput(name, input, signal, surface, this.translationToolOrigin(name, parentToolUseId)))
              if (translated !== undefined) {
                display.toolInputs.set(block.id, translated)
                this.translatedToolInputs.set(block.id, translated)
              }
            } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              const content = textFromServerToolResultContent(block.content)
              const translated = await prepare(`result:${block.tool_use_id}`, {
                kind: 'tool_result', parentToolUseId, toolUseId: block.tool_use_id, isError: block.is_error === true,
                toolName: this.translatedToolNames.get(block.tool_use_id) ?? this.opts.translationContext?.toolName(block.tool_use_id),
              }, surface => this.presentation!.toolResult(this.toolNameForResult(block.tool_use_id), content,
                block.is_error === true, signal, receiptVisible, surface, this.translationToolOrigin('', parentToolUseId, true)))
              if (translated !== undefined) display.toolResults.set(block.tool_use_id, translated)
            }
            signal.throwIfAborted()
          }
        } else if (raw.type === 'user') {
          if (scheduled) display.scheduledText = await prepare('scheduled', { kind: 'scheduled_input', parentToolUseId },
            () => this.opts.translation!.toChinese(raw.message.content, signal, CLAUDE_TRANSLATION_ORIGINS.scheduledPrompt))
          for (const block of Array.isArray(raw.message?.content) ? raw.message.content : []) {
            if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
            const content = this.userToolOutput(raw, block)
            const fromStdout = !textFromToolResultContent(block.content) && raw.tool_use_result
              && (typeof raw.tool_use_result.stdout === 'string' || typeof raw.tool_use_result.stderr === 'string')
            const isError = block.is_error === true || raw.tool_use_result?.interrupted === true
            const name = fromStdout ? 'Bash'
              : this.translatedToolNames.get(block.tool_use_id) ?? this.opts.translationContext?.toolName(block.tool_use_id)
            const translated = await prepare(`result:${block.tool_use_id}`, {
              kind: 'tool_result', parentToolUseId, toolUseId: block.tool_use_id, toolName: name, isError,
            }, surface => this.presentation!.toolResult(name ?? this.toolNameForResult(block.tool_use_id), content,
              isError, signal, receiptVisible, surface, this.translationToolOrigin('', parentToolUseId, true)))
            if (translated !== undefined) display.toolResults.set(block.tool_use_id, translated)
          }
        } else if (raw.type === 'system') {
          const fields = raw.subtype === 'task_started' ? ['description', 'prompt', 'workflow_name']
            : raw.subtype === 'task_progress' ? ['description', 'summary']
              : raw.subtype === 'task_notification' ? ['summary'] : raw.subtype === 'task_updated' ? ['description', 'error'] : []
          const source = raw.subtype === 'task_updated' ? raw.patch ?? {} : raw
          if (fields.length) display.system = await prepare('background', {
            kind: 'background', parentToolUseId, subtype: raw.subtype,
            ...(typeof raw.task_id === 'string' ? { taskId: raw.task_id } : {}),
          }, () => this.presentation!.naturalFields(source, fields, signal, CLAUDE_TRANSLATION_ORIGINS.backgroundUpdate))
        } else if (raw.type === 'result') {
          const error = this.resultErrorText(raw)
          if (error) {
            display.error = await this.opts.translation!.toChinese(error, signal, CLAUDE_TRANSLATION_ORIGINS.error)
            this.translatedErrors.set(error, display.error)
          }
        }
        signal.throwIfAborted()
      } else display.failed = true
    } catch (cause) {
      display.failed = true
      display.texts.clear()
      display.toolInputs.clear()
      display.toolResults.clear()
      display.system = undefined
      display.scheduledText = undefined
      if (!signal.aborted && this.alive && !this.expectedExit) this.reportTranslationFailure('output', cause,
        this.hasPendingNativeTurn() || raw.type === 'result' || raw.type === 'assistant' && !raw.parent_tool_use_id)
      if (raw.type === 'result') {
        const error = this.resultErrorText(raw)
        if (error) {
          log(`claude-agent-process: untranslated native error: ${error}`)
          this.translatedErrors.set(error, '原生错误翻译失败，原始诊断已保留在日志中。')
        }
      }
    }
    if (raw.type === 'result' && display.failed) {
      const error = this.resultErrorText(raw)
      if (error && !this.translatedErrors.has(error)) {
        log(`claude-agent-process: untranslated native error: ${error}`)
        this.translatedErrors.set(error, '原生错误未能翻译，原始诊断已保留在日志中。')
      }
    }
    if (!display.failed && !this.translationContextFailure) {
      try {
        this.discardHiddenPresentations(display)
        this.recordDisplayContext(raw, display)
      }
      catch (cause) {
        this.translationContextFailure = this.translationError('context', cause)
        display.failed = true
        display.texts.clear(); display.toolInputs.clear(); display.toolResults.clear()
        display.system = undefined; display.scheduledText = undefined
        this.reportTranslationFailure('context', cause,
          this.hasPendingNativeTurn() || raw.type === 'result' || raw.type === 'assistant' && !raw.parent_tool_use_id)
      }
    }
    this.handleMessage(message, display, true)
  }

  /** Record only the bilingual presentation payload crossing this boundary.
   * Never ingest SDK user/meta content, thinking, tool payloads or transcripts. */
  private recordDisplayContext(raw: any, display: ClaudeMessageDisplay): void {
    const context = this.opts.translationContext
    if (!context || display.failed) return
    const receiptVisible = typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id.length > 0
    const originals: string[] = [], translations: string[] = []
    const origins = new Set<string>()
    const tools: Array<{ id: string; name: string }> = []
    const add = (original: string, translated: string, origin: string) => {
      if (original.trim()) { originals.push(original); translations.push(translated); origins.add(origin) }
    }
    const blocks = Array.isArray(raw.message?.content) ? raw.message.content : []
    if (raw.type === 'assistant') {
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]
        const text = display.texts.get(index)
        if (block?.type === 'text' && text !== undefined) add(block.text, text, this.translationReplyOrigin(raw.parent_tool_use_id))
        if ((block?.type === 'tool_use' || block?.type === 'server_tool_use') && typeof block.id === 'string' && typeof block.name === 'string') {
          const name = block.type === 'server_tool_use' ? serverToolName(block.name) : block.name
          tools.push({ id: block.id, name })
          const shown = display.toolInputs.get(block.id)
          if (shown !== undefined && !this.emittedToolUseIds.has(block.id)) {
            const input = block.type === 'server_tool_use' ? display.serverToolInputs.get(block.id) : block.input ?? {}
            const surface = display.presentations.get(`input:${block.id}`)!.surface
            add(claudeToolInputContext(name, input, surface).join('\n'), claudeToolInputContext(name, shown, surface).join('\n'),
              this.translationToolOrigin(name, raw.parent_tool_use_id))
          }
        }
      }
    }
    // These results are recorded only when selected for translated display.
    // Raw file bytes, code, stdout/stderr and opaque JSON are excluded by the
    // same field selector used to prepare the card's natural-language copy.
    if (raw.type === 'assistant' || raw.type === 'user') {
      for (const block of blocks) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        const translated = display.toolResults.get(block.tool_use_id)
        if (translated === undefined || this.emittedToolResultIds.has(block.tool_use_id)) continue
        const fromStdout = raw.type === 'user' && !textFromToolResultContent(block.content)
          && raw.tool_use_result && (typeof raw.tool_use_result.stdout === 'string' || typeof raw.tool_use_result.stderr === 'string')
        const name = fromStdout ? 'Bash' : this.toolNameForResult(block.tool_use_id)
        const original = raw.type === 'user' ? this.userToolOutput(raw, block) : textFromServerToolResultContent(block.content)
        const isError = block.is_error === true || raw.tool_use_result?.interrupted === true
        const surface = display.presentations.get(`result:${block.tool_use_id}`)!.surface
        add(claudeToolResultContext(name, original, isError, receiptVisible, surface).join('\n'), claudeToolResultContext(name, translated, isError, receiptVisible, surface).join('\n'),
          this.translationToolOrigin(name, raw.parent_tool_use_id, true))
      }
    }
    if (display.system) {
      const keys = raw.subtype === 'task_started' ? ['description', 'prompt', 'workflow_name']
        : raw.subtype === 'task_progress' ? ['description', 'summary']
          : raw.subtype === 'task_updated' ? ['description', 'error'] : raw.subtype === 'task_notification' ? ['summary'] : []
      const source = raw.subtype === 'task_updated' ? raw.patch ?? {} : raw
      for (const key of keys) if (typeof source[key] === 'string' && typeof display.system[key] === 'string') {
        add(source[key], display.system[key] as string, CLAUDE_TRANSLATION_ORIGINS.backgroundUpdate)
      }
    }
    if (display.scheduledText !== undefined) add(raw.message.content, display.scheduledText, CLAUDE_TRANSLATION_ORIGINS.scheduledPrompt)
    if (display.error !== undefined) add(this.resultErrorText(raw) ?? '', display.error, CLAUDE_TRANSLATION_ORIGINS.error)
    const kind = raw.parent_tool_use_id ? `subagent:${raw.parent_tool_use_id}`
      : raw.type === 'assistant' ? 'message' : raw.type === 'system' ? 'background'
        : raw.type === 'result' ? 'error' : display.scheduledText !== undefined ? 'scheduled' : 'tool-result'
    const uuid = typeof raw.uuid === 'string' ? raw.uuid : undefined
    context.recordDisplay({ tools,
      ...(originals.length ? { output: { kind, original: originals.join('\n\n'), display: translations.join('\n\n'), uuid,
        origin: [...origins].join(' '),
        ...(uuid ? { key: `${raw.type}:${raw.parent_tool_use_id ?? ''}:${uuid}` } : {}) } } : {}),
      ...(raw.type === 'assistant' && !raw.parent_tool_use_id && uuid ? { checkpoint: uuid } : {}),
    })
  }

  private toolNameForResult(id: string): string {
    const name = this.translatedToolNames.get(id) ?? this.opts.translationContext?.toolName(id)
    if (!name) throw new Error(`工具结果来源 MISS，不能判定可翻译字段：${id}`)
    return name
  }

  private handleMessage(message: SDKMessage, display?: ClaudeMessageDisplay, contextObserved = false): void {
    const raw = message as any
    if (!contextObserved && !this.translationContextFailure) this.observeTranslationContext(raw)
    if (!this.translationContextFailure && (!this.opts.translation || !raw.parent_tool_use_id)
      && typeof raw.session_id === 'string' && raw.session_id) this.sessionId = raw.session_id
    switch (raw.type) {
      case 'system':
        this.handleSystemMessage(raw, display)
        return
      case 'assistant':
        this.handleAssistantMessage(raw, display)
        return
      case 'user':
        this.handleUserMessage(raw, display)
        return
      case 'result':
        this.handleResultMessage(raw)
        return
      case 'command_lifecycle':
        if (typeof raw.command_uuid !== 'string' || !['queued', 'started', 'completed', 'cancelled'].includes(raw.state)) {
          log(`claude-agent-process: malformed command lifecycle ${JSON.stringify(raw)}`)
          return
        }
        if (raw.state === 'started' || raw.state === 'completed') {
          if (this.steeringInputs.delete(raw.command_uuid)) {
            this.inputTurnPending = true
            if (raw.state === 'started') this.nativeTurnPending = true
            if (raw.state === 'started') this.emit('user_input_consumed', { inputId: raw.command_uuid })
          }
        }
        if (raw.state === 'cancelled' && this.steeringInputs.delete(raw.command_uuid)) {
          const error = '原生 Claude 取消了一条尚未处理的追加消息，请重新发送。'
          this.steeringFailures.push(error)
          this.emit('turn_input_error', { error })
          // Cancellation outside our own stop path must not leave an already
          // completed native turn waiting forever for the discarded input.
          if (!this.steeringInputs.size && !this.inputTurnPending && !this.turnActive && this.deferredSteeringResult) {
            const deferred = this.deferredSteeringResult
            this.finishInputResult(deferred.raw, deferred.subtype, deferred.error)
          }
        }
        return
      case 'rate_limit_event':
        this.emit('rate_limits_updated', raw.rate_limit_info)
        return
      case 'stream_event':
        return
      default:
        log(`claude-agent-process: unhandled message type=${raw.type ?? 'unknown'} subtype=${raw.subtype ?? ''}`)
    }
  }

  private handleSystemMessage(raw: any, display?: ClaudeMessageDisplay): void {
    const presentation = (fields: string[], source = raw): Record<string, string> | undefined => {
      if (!display || display.hidden.has('background')) return undefined
      return Object.fromEntries(fields.filter(key => typeof source[key] === 'string').map(key => [key,
        typeof display.system?.[key] === 'string' ? display.system[key] : '翻译失败，详情见本轮错误提示。']))
    }
    switch (raw.subtype) {
      case 'init':
        if (typeof raw.model === 'string' && raw.model) this.lastModel = claudeModelKey(raw.model)
        this.lastEffort = this.opts.effort
        this.emit('init', { session_id: this.sessionId, raw })
        return
      case 'session_state_changed':
        if (raw.state === 'running') this.nativeTurnPending = true
        if (raw.state === 'running' && !this.turnActive) {
          this.turnActive = true
          this.lastThinkingTokens = null
          // A checkpoint belongs to exactly one clean turn. Clear the prior
          // assistant UUID at the authoritative SDK turn boundary.
          this.lastAssistantUuid = null
          this.emit('turn_started', { turn_id: raw.uuid, thread_id: this.sessionId,
            ...(this.steeringResults.length ? { retry: true } : {}) })
        } else if (raw.state === 'idle') {
          this.turnActive = false
        }
        return
      case 'compact_boundary':
        this.emit('context_compacted', {
          threadId: raw.session_id ?? this.sessionId ?? undefined,
          sessionId: raw.session_id ?? this.sessionId ?? undefined,
          itemId: raw.uuid,
          phase: 'event',
          sourceMethod: 'claude_agent_sdk',
          sourceType: 'compact_boundary',
          preTokens: raw.compact_metadata?.pre_tokens,
          trigger: raw.compact_metadata?.trigger,
        })
        return
      case 'api_retry':
        log(`claude-agent-process: api retry attempt=${raw.attempt}/${raw.max_retries} status=${raw.error_status} error=${raw.error}`)
        return
      case 'thinking_tokens':
        if (typeof raw.estimated_tokens !== 'number' || !Number.isFinite(raw.estimated_tokens) || raw.estimated_tokens < 0) {
          log('claude-agent-process: invalid thinking_tokens estimate')
          return
        }
        this.lastThinkingTokens = raw.estimated_tokens
        this.emit('thinking_progress', { estimatedTokens: raw.estimated_tokens })
        return
      case 'permission_denied':
        log(`claude-agent-process: permission denied ${raw.tool_name} ${raw.tool_use_id}: ${raw.message}`)
        return
      // ── 后台任务 / 子 agent 生命周期(SDK 的 task_* 消息族,统一 type:'system')
      // 全部 emit 出去给 session 维护 backgroundTasks 状态 + 驱动后台游标卡。
      // 之前落 default 静默丢,子 agent 启动后全程黑盒直到 tool_result 回来。
      case 'task_started':
        this.emit('bg_task_started', {
          task_id: String(raw.task_id ?? ''),
          tool_use_id: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : undefined,
          task_type: typeof raw.task_type === 'string' ? raw.task_type : undefined,
          description: String(raw.description ?? ''),
          subagent_type: typeof raw.subagent_type === 'string' ? raw.subagent_type : undefined,
          workflow_name: typeof raw.workflow_name === 'string' ? raw.workflow_name : undefined,
          prompt: typeof raw.prompt === 'string' ? raw.prompt : undefined,
          ...(display ? { display: presentation(['description', 'prompt', 'workflow_name']) } : {}),
        })
        return
      case 'task_progress':
        this.emit('bg_task_progress', {
          task_id: String(raw.task_id ?? ''),
          description: typeof raw.description === 'string' ? raw.description : undefined,
          subagent_type: typeof raw.subagent_type === 'string' ? raw.subagent_type : undefined,
          usage: raw.usage,
          last_tool_name: typeof raw.last_tool_name === 'string' ? raw.last_tool_name : undefined,
          summary: typeof raw.summary === 'string' ? raw.summary : undefined,
          ...(display ? { display: presentation(['description', 'summary']) } : {}),
        })
        return
      case 'task_updated':
        this.emit('bg_task_updated', {
          task_id: String(raw.task_id ?? ''),
          patch: raw.patch && typeof raw.patch === 'object' ? raw.patch : {},
          ...(display ? { display: presentation(['description', 'error'], raw.patch ?? {}) } : {}),
        })
        return
      case 'task_notification':
        // task_notification 是任务结算的权威信号:带终态 status + 最终 usage。
        if (typeof raw.task_id !== 'string' || !raw.task_id) {
          log('claude-agent-process: task_notification missing task_id')
          return
        }
        if (raw.status !== 'completed' && raw.status !== 'failed' && raw.status !== 'stopped') {
          log(`claude-agent-process: task_notification unknown status=${String(raw.status)} task=${raw.task_id}`)
          return
        }
        this.emit('bg_task_settled', {
          task_id: raw.task_id,
          tool_use_id: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : undefined,
          status: raw.status,
          summary: typeof raw.summary === 'string' ? raw.summary : undefined,
          usage: raw.usage,
          ...(display ? { display: presentation(['summary']) } : {}),
        })
        return
      default:
        log(`claude-agent-process: unhandled system subtype=${String(raw.subtype ?? 'unknown')}`)
        return
    }
  }

  private handleAssistantMessage(raw: any, display?: ClaudeMessageDisplay): void {
    const displayTexts = display?.texts
    if (this.opts.translation && !displayTexts) this.emitAssistantControlText(raw)
    this.confirmSteeringInputs(raw)
    if (!raw.parent_tool_use_id) this.lastThinkingTokens = null
    const message = raw.message
    const parentToolUseId = typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id
      ? raw.parent_tool_use_id
      : null
    // SDK/CLI 在开启子 Agent 文本转发或部分兼容路由上会把子 Agent assistant
    // 消息送进主 query() stream。只有主线程 UUID 才是本会话可 fork 的
    // checkpoint；子 Agent UUID 属于另一份 transcript，不能污染 rs/fk 锚点。
    if (!parentToolUseId && typeof raw.uuid === 'string') this.lastAssistantUuid = raw.uuid
    if (typeof message?.model === 'string' && message.model) this.lastModel = claudeModelKey(message.model)
    const content = Array.isArray(message?.content) ? message.content : []
    for (let index = 0; index < content.length; index++) {
      const block = content[index]
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        if (!display) this.rememberServerToolInput(block.text)
        if (isServerToolScaffoldText(block.text)) continue
        if (displayTexts && !displayTexts.has(index) && !display?.hidden.has(`text:${index}`)) continue
        const uuid = raw.uuid ?? message?.id
        this.emit('assistant_text', { uuid, text: block.text, parentToolUseId,
          ...(displayTexts?.has(index) ? { displayText: displayTexts.get(index)! } : {}) })
        this.emit('assistant_block_stop', { index: uuid, parentToolUseId })
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        // canUseTool owns translated question presentation and the original
        // question/answer mapping. Its callback can arrive after this event.
        if (this.opts.translation && block.name === 'AskUserQuestion') continue
        if (display && !display.toolInputs.has(block.id) && !display.hidden.has(`input:${block.id}`)) continue
        this.emitToolUseOnce(block.id, block.name, block.input ?? {}, parentToolUseId, display?.toolInputs.get(block.id))
      } else if (block.type === 'server_tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        if (display && !display.toolInputs.has(block.id) && !display.hidden.has(`input:${block.id}`)) continue
        this.emitToolUseOnce(block.id, serverToolName(block.name), display ? display.serverToolInputs.get(block.id) : {
          tool: block.name,
          input: this.serverToolInput(block.name, block.input ?? {}),
        }, parentToolUseId, display?.toolInputs.get(block.id))
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        this.emitToolResultOnce(
          block.tool_use_id,
          textFromServerToolResultContent(block.content),
          block.is_error === true,
          parentToolUseId,
          display && !display.hidden.has(`result:${block.tool_use_id}`)
            ? display.toolResults.get(block.tool_use_id) ?? '工具结果翻译失败。' : undefined,
        )
      }
    }
  }

  private emitAssistantControlText(raw: any): void {
    if (raw.parent_tool_use_id) return
    for (const block of Array.isArray(raw.message?.content) ? raw.message.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        this.emit('assistant_control_text', { text: block.text })
      }
    }
  }

  private emitToolUseOnce(id: string, name: string, input: any, parentToolUseId: string | null, displayInput?: any): void {
    if (this.emittedToolUseIds.has(id)) return
    this.emittedToolUseIds.add(id)
    if (!name.trim()) {
      log(`claude-agent-process: tool_use ${id} has an empty name`)
      name = 'MISS'
    }
    // parentToolUseId:子 agent 内的工具调用 = 触发它的 Task tool_use id;主线程为 null。
    // session 据此把子 agent 的逐步过程累积进对应后台 task 的 steps[]。
    if (this.opts.translation) this.translatedToolNames.set(id, name)
    this.emit('tool_use', { id, name, input, parentToolUseId, ...(displayInput !== undefined ? { displayInput } : {}) })
  }

  private rememberServerToolInput(text: string): void {
    const input = serverToolInputFromScaffoldText(text)
    if (!input) return
    this.pendingServerToolInputs.push(input)
    if (this.pendingServerToolInputs.length > 20) this.pendingServerToolInputs.shift()
  }

  /** Resolve scaffold inputs in native block order once, including scaffolds
   * from prior messages. Translation, history and events reuse these originals. */
  private prepareServerToolInputs(raw: any): Map<string, unknown> {
    const inputs = new Map<string, unknown>()
    for (const block of Array.isArray(raw.message?.content) ? raw.message.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string') this.rememberServerToolInput(block.text)
      else if (block?.type === 'server_tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        inputs.set(block.id, { tool: block.name, input: this.serverToolInput(block.name, block.input ?? {}) })
      }
    }
    return inputs
  }

  private serverToolInput(name: string, rawInput: unknown): unknown {
    const structuredInput = rawInput
    if (
      structuredInput &&
      typeof structuredInput === 'object' &&
      !Array.isArray(structuredInput) &&
      Object.keys(structuredInput as Record<string, unknown>).length > 0
    ) {
      return structuredInput
    }
    const idx = this.pendingServerToolInputs.findIndex(item => item.name === name)
    if (idx >= 0) {
      const [item] = this.pendingServerToolInputs.splice(idx, 1)
      return item.input
    }
    return structuredInput
  }

  private emitToolResultOnce(toolUseId: string, content: string, isError: boolean, parentToolUseId: string | null, displayContent?: string): void {
    if (this.emittedToolResultIds.has(toolUseId)) return
    this.emittedToolResultIds.add(toolUseId)
    const displayInput = this.translatedToolInputs.get(toolUseId)
    this.translatedToolInputs.delete(toolUseId)
    this.emit('tool_result', {
      tool_use_id: toolUseId,
      content,
      ...(displayContent !== undefined ? { displayContent, displayInput } : {}),
      is_error: isError,
      parentToolUseId,
    })
  }

  private handleUserMessage(raw: any, display?: ClaudeMessageDisplay): void {
    const rawContent = raw.message?.content
    // CronCreate 的 SDK 定时唤醒实测形状:user + isMeta=true +
    // promptSource='sdk' + string content。手动输入是 text block 数组；图片
    // 结果虽也是 meta string，但没有 promptSource=sdk；task-notification 则
    // isMeta 为空。只认完整组合，避免普通 internal user 消息误开定时卡。
    if (
      raw.isMeta === true &&
      raw.promptSource === 'sdk' &&
      typeof rawContent === 'string' &&
      rawContent.trim()
    ) {
      this.translationOutputStopped = false
      this.emit('scheduled_turn_input', {
        text: rawContent,
        ...(display && !display.hidden.has('scheduled') ? { displayText: display.scheduledText ?? '定时任务提示词翻译失败。' } : {}),
        promptId: typeof raw.promptId === 'string' && raw.promptId ? raw.promptId : null,
      })
    }
    const content = Array.isArray(rawContent) ? rawContent : []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const toolResult = raw.tool_use_result
      // 优先 block.content(tool_result 的标准结果文本 —— Claude Code 把 Task/
      // Read/WebSearch 等工具结果放这里);为空时才回退 tool_use_result.stdout/stderr
      // (codex 风格命令输出)。之前只看 stdout/stderr,非命令工具 output 全丢:
      // TaskCreate 的 "Task #N created" 丢失 → id 解析失败 → 任务板永远卡在待办。
      const contentText = textFromToolResultContent(block.content)
      const stdoutStderr = toolResult && typeof toolResult === 'object'
        ? [
            typeof toolResult.stdout === 'string' ? toolResult.stdout : '',
            typeof toolResult.stderr === 'string' ? toolResult.stderr : '',
          ].filter(Boolean).join('\n')
        : ''
      const output = contentText || stdoutStderr
      this.emitToolResultOnce(block.tool_use_id, output, block.is_error === true || toolResult?.interrupted === true, raw.parent_tool_use_id ?? null,
        display && !display.hidden.has(`result:${block.tool_use_id}`)
          ? display.toolResults.get(block.tool_use_id) ?? '工具结果翻译失败。' : undefined)
    }
  }

  private handleResultMessage(raw: any): void {
    if (!this.translationContextFailure && typeof raw.session_id === 'string' && raw.session_id) this.sessionId = raw.session_id
    this.turnActive = false
    this.nativeTurnPending = false
    this.inputTurnPending = false
    const usage = usageFromSdk(raw.usage)
    const modelUsageRaw = raw.modelUsage ?? raw.model_usage
    const total = totalUsageFromModelUsage(modelUsageRaw)
    if (!usage && !total.usage) {
      log(`claude-agent-process: result usage missing rootKeys=${objectKeys(raw).join(',') || '-'} usageKeys=${objectKeys(raw.usage).join(',') || '-'} modelUsageKeys=${objectKeys(modelUsageRaw).join(',') || '-'}`)
    }
    this.lastUsage = usage
    if (total.usage) {
      this.cumulativeUsageFromResults = cloneUsage(total.usage)
      this.lastTotalUsage = cloneUsage(total.usage)
    } else if (usage) {
      this.cumulativeUsageFromResults = addUsageTotals(this.cumulativeUsageFromResults, usage)
      this.lastTotalUsage = cloneUsage(this.cumulativeUsageFromResults)
    } else {
      this.lastTotalUsage = this.cumulativeUsageFromResults ? cloneUsage(this.cumulativeUsageFromResults) : null
    }
    // Use the current report, including decreases; a prior larger context
    // window is not evidence that this turn has the same capacity.
    if (total.contextWindow != null) {
      const routeKey = claudeRouteKey(this.opts.model, this.tokenSourceId)
      contextWindowByRoute.set(routeKey, total.contextWindow)
      // 真实窗口观测落盘(纯被动):token source 模型名 → contextWindow,spawn 侧
      // resolveSpawnModel 据此决定 [1m] 后缀(观测 1M 加 / 200K 裸名)。per-model
      // 粒度(modelUsage 的 key 即模型名),比 routeKey 聚合更准。
      if (this.tokenSourceId) {
        for (const [model, entry] of Object.entries(modelUsageRaw ?? {})) {
          const ctx = (entry as any)?.contextWindow
          if (typeof ctx === 'number' && ctx > 0) {
            observeContextWindow(this.tokenSourceId, model, ctx)
          }
        }
      }
    }
    this.lastContextWindow = contextWindowByRoute.get(claudeRouteKey(this.opts.model, this.tokenSourceId)) ?? total.contextWindow ?? null
    // 上下文占用 = session 当前上下文 = 最后一次 API call 的输入侧 token。从 claude
    // session transcript 读最后一条 assistant 的 per-call usage(transcript 带 finalize
    // 后的真实值;stream-json 的 assistant event 恒 0/0、result.usage 是 turn 聚合、
    // modelUsage 是 session 累计,都不能代表当前上下文)。与 Claude Code 底栏(omc hud)
    // context_window.current_usage 同口径。transcript 不可读 → null → footer 显 MISS。
    // transcript 读最后真实 assistant usage(跳 synthetic);文件存在但全 synthetic(DeepSeek 前 turn
    // SDK 只写占位)→ fallback result.usage 单 turn input;文件不存在(test / 新 session 首次)→ null(MISS)。
    const transcriptPath = claudeTranscriptPath(this.opts.workDir, this.sessionId ?? '')
    const transcriptUsage = readLastCallUsageFromTranscript(transcriptPath)
    this.lastContextTokens = contextOccupancyFromUsage(transcriptUsage)
      ?? (existsSync(transcriptPath) ? contextOccupancyFromUsage(usage) : null)
    if (this.lastTotalUsage || this.lastUsage) {
      this.emit('token_usage', {
        usage: this.lastUsage,
        totalUsage: this.lastTotalUsage,
        contextWindow: this.lastContextWindow,
        threadId: this.sessionId ?? undefined,
        turnId: raw.uuid,
      })
    }
    const subtype = typeof raw.subtype === 'string' ? raw.subtype : raw.is_error ? 'error' : 'success'
    this.confirmSteeringInputs(raw)
    const resultError = this.resultErrorText(raw)
    if (this.steeringInputs.size || this.steeringResults.length) {
      this.steeringResults.push({ usage, duration: typeof raw.duration_ms === 'number' ? raw.duration_ms : null,
        turns: typeof raw.num_turns === 'number' ? raw.num_turns : 1, error: resultError })
      if (this.steeringInputs.size) {
        this.deferredSteeringResult = { raw, subtype, error: resultError }
        if (resultError) this.emit('turn_input_error', { error: resultError, displayError: this.translatedErrors.get(resultError) })
        log(`claude-agent-process: native result has ${this.steeringInputs.size} unconsumed steering inputs`)
        return
      }
    }
    this.finishInputResult(raw, subtype, resultError)
  }

  private finishInputResult(raw: any, subtype: string, resultError: string | null): void {
    this.deferredSteeringResult = null
    const continued = this.steeringResults.splice(0)
    const errors = continued.length ? continued.flatMap(r => r.error ? [r.error] : []) : resultError ? [resultError] : []
    errors.push(...this.steeringFailures.splice(0))
    const translationFailed = this.translationFailure !== null || this.translationContextFailure !== null
    if (this.translationContextFailure && !errors.includes(this.translationContextFailure.message)) errors.push(this.translationContextFailure.message)
    if (this.translationFailure) {
      errors.push(this.translationFailure.message)
      this.translationFailure = null
    }
    if (continued.length) {
      this.lastUsage = continued.every(r => r.usage !== null)
        ? continued.reduce<CodexUsage | null>((total, r) => addUsageTotals(total, r.usage!), null) : null
    }
    // A context-length error proves this request was too large, not that the
    // endpoint has a 200K window. Keep the reported capacity and requested model.
    this.lastResult = {
      cost_usd: null,
      cost_delta_usd: null,
      duration_ms: continued.length ? continued.every(r => r.duration !== null)
        ? continued.reduce((total, r) => total + r.duration!, 0) : null
        : typeof raw.duration_ms === 'number' ? raw.duration_ms : null,
      num_turns: continued.length ? continued.reduce((total, r) => total + r.turns, 0)
        : typeof raw.num_turns === 'number' ? raw.num_turns : 1,
      usage: this.lastUsage,
      subtype: errors.length && subtype === 'success'
        ? translationFailed ? 'claude_translation_failed' : 'claude_steering_failed'
        : subtype,
      is_error: errors.length > 0,
    }
    this.emit('result', {
      subtype: this.lastResult.subtype,
      is_error: this.lastResult.is_error,
      ...(this.lastResult.is_error ? {
        error: errors.join('\n'),
        ...(this.opts.translation ? { displayError: errors.map(error => this.translatedErrors.get(error) ?? error).join('\n') } : {}),
      } : {}),
      duration_ms: this.lastResult.duration_ms,
      usage: this.lastUsage,
      checkpoint: !this.lastResult.is_error && this.lastAssistantUuid && this.sessionId
        ? {
            provider: 'claude',
            kind: 'assistant-message',
            id: this.lastAssistantUuid,
            source: { provider: 'claude', sessionId: this.sessionId, cwd: this.opts.workDir },
          }
        : null,
    })
  }

  private confirmSteeringInputs(raw: any): void {
    if (raw.parent_tool_use_id) return
    const ids = Array.isArray(raw.user_message_uuids) ? raw.user_message_uuids : []
    for (const id of [...ids, raw.user_message_uuid]) {
      if (typeof id === 'string' && this.steeringInputs.delete(id) && raw.type !== 'result') this.inputTurnPending = true
    }
  }

  private failTurnStart(e: Error): void {
    this.turnActive = false
    this.inputTurnPending = false
    this.lastAssistantUuid = null
    this.lastResult = {
      cost_usd: null,
      cost_delta_usd: null,
      duration_ms: null,
      num_turns: null,
      usage: this.lastUsage,
      subtype: 'claude_turn_start_failed',
      is_error: true,
    }
    this.emit('result', {
      subtype: this.lastResult.subtype,
      is_error: true,
      duration_ms: null,
      usage: this.lastUsage,
      error: e.message,
    })
  }
}
