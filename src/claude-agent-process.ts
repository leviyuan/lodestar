import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn as crossSpawn } from 'cross-spawn'
import { delimiter, join } from 'node:path'
import { EventEmitter } from 'node:events'
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
    this.items = []
    this.close()
  }

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
   *  透传型 source(native)传 ['user','project','local'] → 读本机 Claude Code 配置(settings.json env / .credentials)。 */
  settingSources?: readonly string[]
  settings?: Settings
  validateAccount?: (account: AccountInfo) => void
  /** 该进程 spawn 时绑定的 token source id;stopIdleMismatchedProcess 据此判跨 source 重启。 */
  tokenSourceId?: string | null
  /** Daemon-owned local plugin containing shared Skills. Loaded only when the
   * effective settingSources omit `user`. */
  managedSkillPluginPath?: string
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

/** Read `<workDir>/.mcp.json` and return its `mcpServers` map, or undefined
 * when missing / unreadable / malformed. Missing (ENOENT) is silent — it's
 * the common case (most projects ship no .mcp.json, and loadProjectMcp
 * defaults to true so every spawn probes once); other failures are logged
 * so the project knows its MCP didn't load. */
export function readProjectMcpServers(workDir: string): Record<string, McpServerConfig> | undefined {
  const mcpPath = join(workDir, '.mcp.json')
  let raw: string
  try {
    raw = readFileSync(mcpPath, 'utf8')
  } catch (e) {
    // ENOENT (no .mcp.json) is the common case — most projects ship none, and
    // loadProjectMcp defaults to true so every spawn probes once. Stay silent
    // to avoid log noise; only warn when the file exists but can't be read.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`claude-agent-process: project .mcp.json not readable at ${mcpPath}: ${e}`)
    }
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      return parsed.mcpServers as Record<string, McpServerConfig>
    }
    log(`claude-agent-process: project .mcp.json has no mcpServers object at ${mcpPath}`)
    return undefined
  } catch (e) {
    log(`claude-agent-process: project .mcp.json parse failed at ${mcpPath}: ${e}`)
    return undefined
  }
}

function normalizeDialogQuestions(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const rawQuestions = payload.questions
  const items = Array.isArray(rawQuestions)
    ? rawQuestions
    : rawQuestions && typeof rawQuestions === 'object'
      ? [rawQuestions]
      : [payload]
  return items
    .map(item => normalizeDialogQuestion(item))
    .filter((item): item is Record<string, unknown> => item !== null)
}

function normalizeDialogQuestion(raw: unknown): Record<string, unknown> | null {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : { question: raw }
  const question = firstString(item.question, item.prompt, item.title, item.message, item.text, item.label)
  if (!question) return null
  if (!question.trim()) return null
  const options = normalizeDialogOptions(item.options ?? item.choices ?? item.suggestions)
  return {
    ...item,
    question,
    options,
    ...(typeof item.header === 'string' ? { header: item.header } : {}),
    ...(typeof item.multiSelect === 'boolean' ? { multiSelect: item.multiSelect } : {}),
  }
}

function normalizeDialogOptions(raw: unknown): Array<Record<string, string>> {
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
    options.push(description ? { label, description } : { label })
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
}

export interface BgTaskProgressEvent {
  task_id: string
  description?: string
  subagent_type?: string
  usage?: BgTaskUsage
  last_tool_name?: string
  summary?: string
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
}

export interface BgTaskSettledEvent {
  task_id: string
  tool_use_id?: string
  status: 'completed' | 'failed' | 'stopped'
  summary?: string
  usage?: BgTaskUsage
}

export class ClaudeAgentProcess extends EventEmitter {
  readonly provider = 'claude' as const
  readonly tokenSourceId: string | null

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
  private emittedToolUseIds = new Set<string>()
  private emittedToolResultIds = new Set<string>()
  private pendingServerToolInputs: PendingServerToolInput[] = []

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
    this.tokenSourceId = opts.tokenSourceId ?? null
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
    const strictMcpConfig = profile?.strictMcp === true
    // Default true (CLI parity): discover <cwd>/.mcp.json like bare `claude`.
    // readProjectMcpServers returns undefined when no .mcp.json is present, so
    // this is a no-op for projects without one. Opt out: load_project_mcp = "false".
    const mcpServers = profile?.loadProjectMcp !== false ? readProjectMcpServers(this.opts.workDir) : undefined
    try {
      // resolveClaudeExecutableConfig 在 [claude].bin 配错路径时同步抛出;
      // 必须在 try 内调用,确保错误走 error/exit 事件而非穿透到调用方。
      const executable = resolveClaudeExecutableConfig()
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
          ...(this.opts.allowDelegation === false ? { disallowedTools: ['Agent', 'Task'] } : {}),
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
            ...(this.opts.appendSystemPrompt ? { append: this.opts.appendSystemPrompt } : {}),
          },
          stderr: data => {
            const text = data.trim()
            if (text) log(`claude-agent-process[stderr]: ${text}`)
          },
        },
      })
    } catch (e) {
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

  sendUserText(text: string, files: string[] = []): void {
    if (!this.alive) {
      log('claude-agent-process: sendUserText ignored on dead process')
      return
    }
    if (!this.started) this.sendInitialize()
    const fileHints = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n\n' : ''
    try {
      this.input.push({
        type: 'user',
        session_id: this.sessionId ?? '',
        message: {
          role: 'user',
          content: [{ type: 'text', text: fileHints + text }],
        },
        parent_tool_use_id: null,
        priority: 'now',
      } as SDKUserMessage)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      log(`claude-agent-process: sendUserText failed: ${err.message}`)
      this.failTurnStart(err)
    }
  }

  sendInterrupt(): void {
    void this.query?.interrupt().catch(e => log(`claude-agent-process: interrupt failed: ${e}`))
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

  async kill(timeoutMs = 5000): Promise<void> {
    if (!this.alive) return
    this.expectedExit = true
    this.denyPendingPermissions('claude process is stopping')
    // Hard process stop: queued user turns belong to the discarded process
    // generation and must never drain during the SDK abort window.
    this.input.abort()
    if (!this.started || !this.query) {
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
    this.input.push({
      type: 'user',
      session_id: this.sessionId ?? '',
      message: { role: 'user', content: [{ type: 'text', text: '/compact' }] },
      parent_tool_use_id: null,
      priority: 'now',
    } as SDKUserMessage)
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        this.off('context_compacted', onCompacted)
        this.off('assistant_text', onAssistantText)
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
      this.on('assistant_text', onAssistantText)
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
    const questions = normalizeDialogQuestions(input)
    if (questions.length === 0) {
      log('claude-agent-process: AskUserQuestion 无有效 questions — allow 原样')
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    const normalizedInput = { ...input, questions }
    const requestId = `claude_perm_${++this.requestCounter}`
    const toolUseId = options.toolUseID || requestId
    const req: CanUseToolRequest = {
      request_id: requestId,
      tool_name: 'AskUserQuestion',
      input: normalizedInput,
      tool_use_id: toolUseId,
    }
    const pending = new Promise<PermissionResult>(resolve => {
      const finish = (value: PermissionResult) => {
        options.signal.removeEventListener('abort', abort)
        resolve(value)
      }
      const abort = () => {
        if (!this.pendingPermissions.delete(requestId)) return
        finish({ behavior: 'deny', message: 'aborted' })
      }
      options.signal.addEventListener('abort', abort, { once: true })
      this.pendingPermissions.set(requestId, { kind: 'dialog', resolve: finish, request: req })
    })
    this.emitToolUseOnce(toolUseId, 'AskUserQuestion', normalizedInput, null)
    this.emit('can_use_tool', req)
    return pending
  }

  private async readLoop(q: Query): Promise<void> {
    try {
      for await (const message of q) this.handleMessage(message)
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
    this.turnActive = false
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

  private handleMessage(message: SDKMessage): void {
    const raw = message as any
    if (typeof raw.session_id === 'string' && raw.session_id) this.sessionId = raw.session_id
    switch (raw.type) {
      case 'system':
        this.handleSystemMessage(raw)
        return
      case 'assistant':
        this.handleAssistantMessage(raw)
        return
      case 'user':
        this.handleUserMessage(raw)
        return
      case 'result':
        this.handleResultMessage(raw)
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

  private handleSystemMessage(raw: any): void {
    switch (raw.subtype) {
      case 'init':
        if (typeof raw.model === 'string' && raw.model) this.lastModel = claudeModelKey(raw.model)
        this.lastEffort = this.opts.effort
        this.emit('init', { session_id: this.sessionId, raw })
        return
      case 'session_state_changed':
        if (raw.state === 'running' && !this.turnActive) {
          this.turnActive = true
          this.lastThinkingTokens = null
          // A checkpoint belongs to exactly one clean turn. Clear the prior
          // assistant UUID at the authoritative SDK turn boundary.
          this.lastAssistantUuid = null
          this.emit('turn_started', { turn_id: raw.uuid, thread_id: this.sessionId })
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
        })
        return
      case 'task_updated':
        this.emit('bg_task_updated', {
          task_id: String(raw.task_id ?? ''),
          patch: raw.patch && typeof raw.patch === 'object' ? raw.patch : {},
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
        })
        return
      default:
        log(`claude-agent-process: unhandled system subtype=${String(raw.subtype ?? 'unknown')}`)
        return
    }
  }

  private handleAssistantMessage(raw: any): void {
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
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        const pendingServerToolInput = serverToolInputFromScaffoldText(block.text)
        if (pendingServerToolInput) {
          this.pendingServerToolInputs.push(pendingServerToolInput)
          if (this.pendingServerToolInputs.length > 20) this.pendingServerToolInputs.shift()
        }
        if (isServerToolScaffoldText(block.text)) continue
        const uuid = raw.uuid ?? message?.id
        this.emit('assistant_text', { uuid, text: block.text, parentToolUseId })
        this.emit('assistant_block_stop', { index: uuid, parentToolUseId })
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.emitToolUseOnce(block.id, block.name, block.input ?? {}, parentToolUseId)
      } else if (block.type === 'server_tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.emitToolUseOnce(block.id, serverToolName(block.name), {
          tool: block.name,
          input: this.serverToolInput(block.name, block.input ?? {}),
        }, parentToolUseId)
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        this.emitToolResultOnce(
          block.tool_use_id,
          textFromServerToolResultContent(block.content),
          block.is_error === true,
          parentToolUseId,
        )
      }
    }
  }

  private emitToolUseOnce(id: string, name: string, input: any, parentToolUseId: string | null): void {
    if (this.emittedToolUseIds.has(id)) return
    this.emittedToolUseIds.add(id)
    if (!name.trim()) {
      log(`claude-agent-process: tool_use ${id} has an empty name`)
      name = 'MISS'
    }
    // parentToolUseId:子 agent 内的工具调用 = 触发它的 Task tool_use id;主线程为 null。
    // session 据此把子 agent 的逐步过程累积进对应后台 task 的 steps[]。
    this.emit('tool_use', { id, name, input, parentToolUseId })
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

  private emitToolResultOnce(toolUseId: string, content: string, isError: boolean, parentToolUseId: string | null): void {
    if (this.emittedToolResultIds.has(toolUseId)) return
    this.emittedToolResultIds.add(toolUseId)
    this.emit('tool_result', {
      tool_use_id: toolUseId,
      content,
      is_error: isError,
      parentToolUseId,
    })
  }

  private handleUserMessage(raw: any): void {
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
      this.emit('scheduled_turn_input', {
        text: rawContent,
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
      this.emitToolResultOnce(block.tool_use_id, output, block.is_error === true || toolResult?.interrupted === true, raw.parent_tool_use_id ?? null)
    }
  }

  private handleResultMessage(raw: any): void {
    if (typeof raw.session_id === 'string' && raw.session_id) this.sessionId = raw.session_id
    this.turnActive = false
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
    // A context-length error proves this request was too large, not that the
    // endpoint has a 200K window. Keep the reported capacity and requested model.
    this.lastResult = {
      cost_usd: null,
      cost_delta_usd: null,
      duration_ms: typeof raw.duration_ms === 'number' ? raw.duration_ms : null,
      num_turns: typeof raw.num_turns === 'number' ? raw.num_turns : 1,
      usage: this.lastUsage,
      subtype,
      is_error: raw.is_error === true || subtype !== 'success',
    }
    this.emit('result', {
      subtype,
      is_error: this.lastResult.is_error,
      ...(this.lastResult.is_error ? {
        error: Array.isArray(raw.errors) && raw.errors.length
          ? raw.errors.map(String).join('\n')
          : String(raw.result ?? raw.error ?? raw.api_error_message ?? subtype),
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

  private failTurnStart(e: Error): void {
    this.turnActive = false
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
