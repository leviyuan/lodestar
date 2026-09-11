/**
 * Headless Codex app-server subprocess + JSON-RPC control protocol.
 *
 * Spawned with:
 *   codex app-server --listen stdio://
 *
 * Stdin/stdout are line-delimited JSON-RPC-ish messages. Client requests
 * carry `{ id, method, params }`; server responses carry `{ id, result }`
 * or `{ id, error }`; notifications carry `{ method, params }`; server
 * requests carry `{ id, method, params }` and expect a client response.
 */

import type { ChildProcessByStdio } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import type { Readable, Writable } from 'node:stream'
import { spawn as crossSpawn } from 'cross-spawn'
import { config } from './config'
import { log } from './log'
import { agentBin } from './agent-updates'
import {
  contextCompactionNoticeFromMessage,
  contextCompactionNoticeFromNotification,
  logContextCompactionPayload,
  logUnhandledAppServerPayload,
} from './codex-compaction'
import { usageFromTokenUsagePayload } from './codex-usage'
import { shellCommandDescription } from './cards/shell-command'
import type { AgentReasoningEffort, AgentTurnRetry } from './agent-process'
import { diagnosticIdLabel } from './session-util'
import {
  validateConversationLaunch,
  type ConversationLaunch,
  type ConversationRef,
  type ConversationSummary,
} from './conversation'
import { isAgentSession } from './agent-session-registry'
import type {
  BgTaskSettledEvent,
  BgTaskStartedEvent,
  BgTaskUpdatedEvent,
} from './claude-agent-process'

export function resolveCodexBin(): string {
  return agentBin('codex', 'codex')
}

function buildSpawnPath(): string {
  if (process.platform === 'win32') return process.env.PATH ?? ''
  return [...new Set([
    join(homedir(), '.local', 'npm-global', 'bin'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
    ...(process.env.PATH ?? '').split(delimiter),
    '/usr/local/bin', '/usr/bin', '/bin',
  ].filter(Boolean))].join(delimiter)
}

const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')
const CODEX_GENERATED_IMAGES_DIR = join(homedir(), '.codex', 'generated_images')
// app-server control requests return an acknowledgement, not the whole model
// turn. Bound them so a live PID with a dead transport cannot leak promises.
const CODEX_REQUEST_TIMEOUT_MS = 30_000
const CODEX_MATERIALIZATION_VERIFY_TIMEOUT_MS = 10 * 60_000
const CODEX_CAPACITY_RETRY_BASE_MS = 5_000
const CODEX_CAPACITY_RETRY_MAX_MS = 60_000
// The failed turn already contains the user's input and any completed work.
// Continue that history instead of replaying the original task and file hints.
const CODEX_CAPACITY_CONTINUATION = '上一轮因模型暂时满载而中断。请基于当前会话继续完成用户尚未完成的任务，沿用已有进度；执行操作前先确认结果，避免重复已完成的操作。'

function isModelCapacityError(message: unknown): message is string {
  return typeof message === 'string' && /\bselected\s+model\s+is\s+at\s+capacity\b/i.test(message)
}

export interface SpawnOpts {
  workDir: string
  /** Explicit backend conversation lifecycle. */
  launch?: ConversationLaunch
  model?: string
  effort?: CodexReasoningEffort
  appendSystemPrompt?: string
  allowDelegation?: boolean
  /** Host-owned environment injected before token-source credential routing. */
  hostEnv?: Record<string, string | undefined>
  /** App-server conversation source label. Delegated agents use a distinct
   * value so their resumable threads can be excluded from main rs/fk history. */
  serviceName?: string
  /** token source 注入:对 spawn env 做 scrub+inject(防 A 账号夹带 B 凭据)。未传 = 走 config 默认。 */
  transformEnv?: (env: Record<string, string | undefined>) => Record<string, string | undefined>
  /** 该进程 spawn 时绑定的 token source id;stopIdleMismatchedProcess 据此判跨 source 重启。 */
  tokenSourceId?: string | null
}

export function codexAppServerArgs(allowDelegation = true): string[] {
  return ['app-server', '--listen', 'stdio://', ...(allowDelegation ? [] : ['--disable', 'multi_agent'])]
}

export function codexAppServerSpawnOptions(
  workDir: string,
  env: Record<string, string | undefined>,
): {
  cwd: string
  stdio: ['pipe', 'pipe', 'pipe']
  shell: false
  env: Record<string, string | undefined>
} {
  return { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], shell: false, env }
}

// gpt-5.6 起服务端新增 max(单 agent 最深推理)与 ultra(多 agent 并行编排,默认 4 agent);
// per-model 实际支持集以 model/list 下发为准,这里只做全集枚举。
export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export interface CodexReasoningEffortOption {
  reasoningEffort: CodexReasoningEffort
  description: string
}
export const CODEX_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export const CODEX_EFFORT: CodexReasoningEffort = 'xhigh'

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === 'string' && CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort)
}

export interface CanUseToolRequest {
  request_id: string
  tool_name: string
  input: any
  permission_suggestions?: any
  blocked_paths?: string[]
  tool_use_id?: string
}

export interface HookCallbackRequest {
  request_id: string
  callback_id: string
  input: any
  tool_use_id?: string
}

export interface TurnPlanStep {
  step: string
  status: 'pending' | 'inProgress' | 'completed' | string
}

export interface TurnPlanUpdated {
  threadId?: string
  turnId?: string
  explanation: string | null
  plan: TurnPlanStep[]
}

export interface PlanDelta {
  threadId?: string
  turnId?: string
  itemId: string
  delta: string
}

export interface ContextCompactedNotification {
  threadId?: string
  turnId?: string
  itemId?: string
  sessionId?: string
  phase?: 'start' | 'end' | 'event'
  sourceMethod?: string
  sourceType?: string
  [key: string]: unknown
}

export interface ThreadGoal {
  threadId?: string
  objective: string
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete' | string
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
}

export interface CodexUsage {
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface TokenUsageUpdated {
  usage: CodexUsage | null
  totalUsage: CodexUsage | null
  contextWindow: number | null
  threadId?: string
  turnId?: string
}

export interface CodexResultMeta {
  cost_usd: number | null
  cost_delta_usd: number | null
  duration_ms: number | null
  num_turns: number | null
  usage: CodexUsage | null
  subtype: string | null
  is_error: boolean
}

export {
  contextCompactionNoticeFromMessage,
  contextCompactionNoticeFromNotification,
} from './codex-compaction'
export { diffUsageTotals, effectiveTurnTokens, usageFromTokenUsagePayload } from './codex-usage'

export interface CodexModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  supportedReasoningEfforts: CodexReasoningEffortOption[]
  defaultReasoningEffort: CodexReasoningEffort | null
}

function parseReasoningEffortOptions(raw: unknown): CodexReasoningEffortOption[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<CodexReasoningEffort>()
  const options: CodexReasoningEffortOption[] = []
  for (const item of raw) {
    const effort = typeof item === 'string'
      ? item
      : typeof item === 'object' && item
        ? (item as { reasoningEffort?: unknown }).reasoningEffort
        : null
    if (!isCodexReasoningEffort(effort) || seen.has(effort)) continue
    seen.add(effort)
    const description = typeof item === 'object' && item && typeof (item as { description?: unknown }).description === 'string'
      ? (item as { description: string }).description
      : ''
    options.push({ reasoningEffort: effort, description })
  }
  return options
}

type PendingRequest = {
  resolve: (v: any) => void
  reject: (e: Error) => void
  method: string
  timeout: ReturnType<typeof setTimeout>
}

/** Structured JSON-RPC response failure. Lifecycle code must classify on
 * these fields rather than parsing a rendered Error string. */
export class CodexRpcResponseError extends Error {
  constructor(
    readonly method: string,
    readonly requestId: string | number,
    readonly serverCode: number | null,
    readonly serverMessage: string,
  ) {
    super(
      `codex app-server ${method} failed (id=${requestId}, code=${serverCode ?? 'MISS'}): ${serverMessage}`,
    )
    this.name = 'CodexRpcResponseError'
  }
}

type ServerRequestState = {
  id: string | number
  method: string
  params: any
}

type TurnStartAttempt = {
  generation: number
  turnId: string | null
  confirmed: boolean
  terminal: boolean
  inputText?: string
  interrupted?: boolean
}

export class CodexProcess extends EventEmitter {
  readonly provider = 'codex' as const
  readonly tokenSourceId: string | null
  readonly launchKind: ConversationLaunch['kind']
  private proc: ChildProcessByStdio<Writable, Readable, Readable>
  private stdoutBuf = ''
  private stderrBuf = ''
  private requestCounter = 0
  private pending = new Map<string | number, PendingRequest>()
  private serverRequests = new Map<string | number, ServerRequestState>()
  private alive = true
  private expectedExit = false
  private exitEventEmitted = false
  private childExitCode: number | null = null
  private childExitSignal: NodeJS.Signals | null = null
  private readonly exitPromise: Promise<void>
  private resolveExit!: () => void
  private opts: SpawnOpts
  private readyPromise: Promise<void> | null = null
  private initializePromise: Promise<void> | null = null
  /** Fresh thread/start returns an id before Codex creates its rollout. A
   * resume/fork is already file-backed; a fresh thread becomes resumable only
   * after the persisted turn/started notification arrives. */
  private conversationResumable = false
  /** Exact rollout path returned by app-server for this thread. This is the
   * authority used for persistence checks; Lodestar never scans a second
   * index to decide whether a resume id is safe. */
  private conversationRolloutPath: string | null = null
  private conversationMaterializationVerification: Promise<void> | null = null
  private conversationMaterializationRetrySource: string | null = null
  private lastConversationMaterializationFailure: Error | null = null
  private currentTurnId: string | null = null
  private turnStartGeneration = 0
  private turnStartOwner: TurnStartAttempt | null = null
  private turnStartOwnersByTurnId = new Map<string, TurnStartAttempt>()
  /** Bounded terminal-turn memory prevents a late turn/start response from
   * reviving a turn whose turn/completed notification already arrived. */
  private finishedTurnIds = new Set<string>()
  private capacityRetryTimer: ReturnType<typeof setTimeout> | null = null
  private capacityRetryCount = 0
  private capacityRetryHasStarted = false
  private capacityRetryEnabled = true
  private turnError: { turnId: string; error: any } | null = null
  private rolloutFilePath: string | null = null
  private rolloutReadOffset = 0
  private rolloutLineRemainder = ''
  private rolloutDecoder = new StringDecoder('utf8')
  private emittedImageGenerationIds = new Set<string>()
  // ── Codex 多 agent(ultra 并行编排)状态机 ──────────────────────────
  // agentThreadId → 展示名(agentPath 末段,spawn 那刻从 subAgentActivity /
  // collabAgentToolCall 抓取)。仅用于 bg_task_* 事件的 description。
  private collabAgentNames = new Map<string, string>()
  // agentThreadId → 已 emit 的终态,防同一 agent 的多次 wait item 重复结算。
  private collabAgentSettled = new Set<string>()
  // agentThreadId → 是否见过 active(thread/status/changed)。子线程首个 idle 是
  // 创建态(spawn 后尚未开跑),见过 active 之后的 idle 才是「跑完回闲」。
  private collabAgentWasActive = new Set<string>()
  // agentThreadId → 子 agent 最终 agentMessage 文本(exec-cell 模式没有
  // agentsStates.message,它的末段答复是墓碑 summary 的唯一来源)。
  private collabAgentSummaries = new Map<string, string>()

  sessionId: string | null = null
  lastAssistantUuid: string | null = null
  /** Canonical app-server turn id from the latest main-thread turn/completed notification. */
  lastCompletedTurnId: string | null = null
  lastModel: string | null = null
  lastEffort: CodexReasoningEffort | null = null
  lastUsage: CodexUsage | null = null
  lastTotalUsage: CodexUsage | null = null
  lastResult: CodexResultMeta = {
    cost_usd: null, cost_delta_usd: null, duration_ms: null, num_turns: null,
    usage: null, subtype: null, is_error: false,
  }
  lastContextWindow: number | null = null
  lastContextTokens: number | null = null
  turnRetry: AgentTurnRetry | null = null

  constructor(opts: SpawnOpts) {
    super()
    // EventEmitter treats unhandled `error` specially. We still expose it
    // for Session logging, but a direct utility script should not
    // crash before it can surface the app-server failure.
    this.on('error', () => {})
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve })
    this.opts = opts
    this.tokenSourceId = opts.tokenSourceId ?? null
    this.launchKind = (opts.launch ?? { kind: 'fresh' }).kind
    const codexBin = resolveCodexBin()
    const args = codexAppServerArgs(opts.allowDelegation !== false)
    log(`codex-process: spawn ${codexBin} app-server (cwd=${opts.workDir})`)
    const baseEnv = {
      ...(process.env as Record<string, string>),
      NPM_CONFIG_LOGLEVEL: 'error',
      PATH: buildSpawnPath(),
      ...config.codex.env,
      ...(opts.hostEnv ?? {}),
    }
    const spawnEnv = opts.transformEnv ? opts.transformEnv(baseEnv) : baseEnv
    // cross-spawn resolves Windows .cmd shims without `shell:true`; keeping an
    // argv vector preserves quoted TOML values passed through --config.
    this.proc = crossSpawn(
      codexBin,
      args,
      codexAppServerSpawnOptions(opts.workDir, spawnEnv),
    ) as ChildProcessByStdio<Writable, Readable, Readable>

    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.proc.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk))
    this.proc.stdin.on('error', err => this.handleStdinError(err))
    this.proc.on('exit', (code, signal) => this.handleChildExit(code, signal))
    this.proc.on('close', (code, signal) => this.handleChildClose(code, signal))
    this.proc.on('error', err => this.handleChildProcessError(err))
  }

  private handleStdinError(reason: unknown): void {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    log(`codex-process: stdin failed: ${error.message}`)
    // Per-write callbacks reject the request whose bytes failed. Do not
    // blanket-reject every already-sent RPC here: an EPIPE during shutdown
    // can race valid responses still buffered in stdout, which close drains
    // before rejecting any genuinely unanswered request.
    if (!this.expectedExit) this.emit('error', error)
  }

  private handleChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.alive) {
      log(`codex-process: duplicate exit ignored code=${code} signal=${signal}`)
      return
    }
    this.alive = false
    this.cancelCapacityRetry()
    this.childExitCode = code
    this.childExitSignal = signal
    // Do not reject pending RPCs here: Node's `exit` precedes stdio `close`,
    // and a final response may still be buffered in stdout. close drains that
    // tail first, then rejects only requests that truly received no response.
    log(`codex-process: OS exit code=${code} signal=${signal}; awaiting stdio close`)
  }

  private handleChildClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.alive = false
    this.cancelCapacityRetry()
    this.flushStdoutTail()
    this.flushStderrTail()
    this.rejectPendingRequests((id, pending) => (
      new Error(`codex app-server closed before ${pending.method} response (id=${id})`)
    ))
    this.serverRequests.clear()
    const finalCode = code ?? this.childExitCode
    const finalSignal = signal ?? this.childExitSignal
    const materializationBarrier = this.conversationMaterializationBarrier()
    if (materializationBarrier) {
      // A tail thread/read response resolves its Promise in flushStdoutTail,
      // but the verification/materialized continuations run as microtasks.
      // Delay public exit so Session can commit deferred anchors before its
      // exit handler drops process-owned pending state.
      void materializationBarrier.then(
        () => this.emitProcessExit(finalCode, finalSignal),
        () => this.emitProcessExit(finalCode, finalSignal),
      )
      return
    }
    this.emitProcessExit(finalCode, finalSignal)
  }

  private handleChildProcessError(err: Error): void {
    log(`codex-process: child process error: ${err}`)
    this.rejectPendingRequests((id, pending) => new Error(
      `codex app-server process failed before ${pending.method} response (id=${id}): ${err.message}`,
      { cause: err },
    ))
    // A spawn failure normally emits `error` without `exit`; leaving alive=true
    // would make Session's precise cleanup block forever on an OS process that
    // never existed. Other ChildProcess errors may still have a real PID and
    // must keep the ordinary exit/kill confirmation path.
    const spawnFailed = typeof this.proc.pid !== 'number'
    let terminalized = false
    if (spawnFailed && this.alive) {
      this.alive = false
      this.cancelCapacityRetry()
      this.serverRequests.clear()
      terminalized = true
    }
    this.emit('error', err)
    if (terminalized) {
      log(`codex-process: spawn failed before pid assignment expected=${this.expectedExit}`)
      this.emitProcessExit(null, null)
    }
  }

  private emitProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitEventEmitted) return
    this.exitEventEmitted = true
    this.resolveExit()
    log(`codex-process: exited code=${code} signal=${signal} expected=${this.expectedExit}`)
    this.emit('exit', { code, signal, expected: this.expectedExit })
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString()
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch (e) {
        log(`codex-process: bad json: ${line.slice(0, 200)} (${e})`)
        continue
      }
      try {
        this.handleMessage(msg)
      } catch (e) {
        // 分发异常(handler/emit listener 抛出)与坏 JSON 分开暴露:2026-08-18
        // 事故 —— cards barrel 漏导出 applySubagentStep,session listener 每个
        // subagent item 抛 TypeError,被这里误标成 bad json,整条消息分发中断,
        // 后台卡僵死、主卡混乱。解析与分发分离后,一条 item 的 handler 异常只
        // 丢自己,不连坐后续消息;异常照实记日志等修复。
        log(`codex-process: dispatch error: ${JSON.stringify(msg).slice(0, 200)} (${e})`)
      }
    }
  }

  /** Child `close` guarantees stdio has drained, but the final JSON record is
   * not required to end with a newline. Feed one synthetic delimiter so the
   * ordinary parser handles that last record before public exit/detach. */
  private flushStdoutTail(): void {
    if (!this.stdoutBuf) return
    this.onStdout(Buffer.from('\n'))
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBuf += chunk.toString()
    let nl: number
    while ((nl = this.stderrBuf.indexOf('\n')) >= 0) {
      const line = this.stderrBuf.slice(0, nl)
      this.stderrBuf = this.stderrBuf.slice(nl + 1)
      if (line.trim()) log(`codex-process[stderr]: ${line}`)
    }
  }

  private flushStderrTail(): void {
    const line = this.stderrBuf
    this.stderrBuf = ''
    if (line.trim()) log(`codex-process[stderr]: ${line}`)
  }

  private handleMessage(msg: any): void {
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && !msg.method) {
      const pending = this.pending.get(msg.id)
      if (!pending) {
        log(`codex-process: response for unknown id=${msg.id}`)
        return
      }
      this.pending.delete(msg.id)
      clearTimeout(pending.timeout)
      if (msg.error) {
        const serverCode = typeof msg.error?.code === 'number' ? msg.error.code : null
        const serverMessage = typeof msg.error === 'string'
          ? msg.error
          : typeof msg.error?.message === 'string'
            ? msg.error.message
            : JSON.stringify(msg.error)
        pending.reject(new CodexRpcResponseError(
          pending.method,
          msg.id,
          serverCode,
          serverMessage,
        ))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (Object.prototype.hasOwnProperty.call(msg, 'id') && msg.method) {
      this.handleServerRequest(msg)
      return
    }

    if (msg.method) {
      this.handleNotification(msg.method, msg.params ?? {})
      return
    }

    const compaction = contextCompactionNoticeFromMessage(msg)
    if (compaction) {
      const notice = this.withSessionId(compaction)
      logContextCompactionPayload(compaction.sourceMethod ?? 'raw_message', msg, notice)
      this.emit('context_compacted', notice)
      return
    }

    logUnhandledAppServerPayload('RAW_MESSAGE', msg)
    this.emit('raw', msg)
  }

  private handleNotification(method: string, params: any): void {
    // ── 子 agent 线程分流(入口级)────────────────────────────────────
    // app-server 的 v2 通知(thread/turn/item 级)全部附带发出线程的 threadId。
    // 子 agent 的 turn/completed、agentMessage/delta、tokenUsage、turn/diff
    // 等若不在这里拦下,会冒充主轮信号:子 agent 一完成就 emit result 关掉主卡、
    // 子 delta 流进主卡正文、子 usage 覆盖主线程状态(2026-08-18 CrossEX 实测:
    // 每个子线程 idle 后紧跟一条 SDK result)。子线程通知只允许驱动后台卡:
    // item 级转 subagent_step,状态级由 handleThreadStatusChanged 消费,其余丢弃。
    if (this.isSubagentThread(params)) {
      if (method === 'thread/status/changed') this.handleThreadStatusChanged(params)
      else if (method === 'item/started') this.handleSubagentItemStarted(params)
      else if (method === 'item/completed') this.handleSubagentItemCompleted(params)
      // 其余(delta/turn/usage/diff/plan):子 agent 过程噪音,吞掉。
      return
    }
    const compaction = contextCompactionNoticeFromNotification(method, params)
    if (compaction) {
      const notice = this.withSessionId(compaction)
      logContextCompactionPayload(method, params, notice)
      this.emit('context_compacted', notice)
      return
    }
    switch (method) {
      case 'thread/started': {
        const thread = params.thread
        if (thread?.id) this.sessionId = thread.id
        return
      }
      case 'thread/settings/updated': {
        const settings = params.threadSettings
        if (typeof settings?.model === 'string') this.lastModel = settings.model
        if (isCodexReasoningEffort(settings?.effort)) this.lastEffort = settings.effort
        return
      }
      case 'thread/tokenUsage/updated': {
        // `last` is the latest model request and therefore the current
        // context-window footprint. `total` is cumulative across requests
        // in the thread and must not drive context-window percentages.
        const last = usageFromTokenUsagePayload(params.tokenUsage?.last)
        if (last) {
          this.lastUsage = last
          this.lastResult.usage = this.lastUsage
        } else {
          log('codex-process: tokenUsage notification missing last breakdown')
        }
        this.lastTotalUsage = usageFromTokenUsagePayload(params.tokenUsage?.total)
        const ctx = params.tokenUsage?.modelContextWindow
        if (typeof ctx === 'number' && ctx > 0) this.lastContextWindow = ctx
        this.emit('token_usage', {
          usage: this.lastUsage,
          totalUsage: this.lastTotalUsage,
          contextWindow: this.lastContextWindow,
          threadId: params.threadId,
          turnId: params.turnId,
        } as TokenUsageUpdated)
        return
      }
      case 'turn/started': {
        if (typeof params.threadId !== 'string' || params.threadId !== this.sessionId) {
          logUnhandledAppServerPayload('TURN_STARTED_THREAD_MISMATCH', { method, params })
          return
        }
        this.recordTurnStarted(params.turn, params.threadId, 'turn/started notification')
        this.markConversationMaterialized('turn/started notification')
        return
      }
      case 'turn/completed': {
        if (typeof params.threadId !== 'string' || params.threadId !== this.sessionId) {
          logUnhandledAppServerPayload('TURN_COMPLETED_THREAD_MISMATCH', { method, params })
          return
        }
        const turn = params.turn ?? {}
        const completedTurnId = typeof turn.id === 'string' && turn.id ? turn.id : null
        if (completedTurnId) {
          if (this.finishedTurnIds?.has(completedTurnId)) {
            log(`codex-process: duplicate turn/completed ignored turn=${completedTurnId}`)
            return
          }
          if (this.currentTurnId && this.currentTurnId !== completedTurnId) {
            // A late terminal notification for the prior turn must never clear
            // or close the newer active turn. Retire only the matching old
            // attempt and remember the id so further duplicates stay inert.
            this.markTurnStartTerminal(completedTurnId)
            this.rememberFinishedTurn(completedTurnId)
            log(`codex-process: stale turn/completed ignored turn=${completedTurnId} current=${this.currentTurnId}`)
            return
          }
          this.flushRolloutImageGenerations()
          this.markConversationMaterialized('turn/completed notification')
          this.markTurnStartTerminal(completedTurnId)
          this.rememberFinishedTurn(completedTurnId)
        } else {
          logUnhandledAppServerPayload('TURN_COMPLETED_MISSING_ID', { method, params })
        }
        const status = turn.status
        const error = turn.error ?? (status === 'failed' && this.turnError && this.turnError.turnId === completedTurnId
          ? this.turnError.error : null)
        this.turnError = null
        const isError = status === 'failed' || !!error
        const isCheckpointable = status === 'completed' && !isError && !!completedTurnId
        // Never leave a previous turn's checkpoint visible on a failed,
        // interrupted, or malformed terminal notification.
        this.lastCompletedTurnId = isCheckpointable ? completedTurnId : null
        this.currentTurnId = null
        if (status === 'failed' && completedTurnId && isModelCapacityError(error?.message)
          && this.scheduleCapacityRetry(error.message, CODEX_CAPACITY_CONTINUATION)) return
        this.cancelCapacityRetry()
        this.capacityRetryCount = 0
        this.capacityRetryHasStarted = false
        const subtype = isError ? (error?.type ?? error?.message ?? 'failed') : 'success'
        this.lastResult = {
          cost_usd: null,
          cost_delta_usd: null,
          duration_ms: typeof turn.durationMs === 'number' ? turn.durationMs : null,
          num_turns: 1,
          usage: this.lastUsage,
          subtype,
          is_error: isError,
        }
        this.emit('result', {
          subtype,
          is_error: isError,
          ...(isError && typeof error?.message === 'string' ? { error: error.message } : {}),
          duration_ms: this.lastResult.duration_ms,
          usage: this.lastUsage,
          turn_id: completedTurnId,
          checkpoint: isCheckpointable && this.sessionId
            ? {
                provider: 'codex',
                kind: 'turn',
                id: completedTurnId,
                source: { provider: 'codex', sessionId: this.sessionId, cwd: this.opts.workDir },
              }
            : null,
        })
        return
      }
      case 'turn/plan/updated': {
        this.emit('turn_plan_updated', params as TurnPlanUpdated)
        return
      }
      case 'item/plan/delta': {
        this.emit('plan_delta', params as PlanDelta)
        return
      }
      case 'thread/goal/updated': {
        if (params.goal) {
          this.emit('thread_goal_updated', params.goal as ThreadGoal)
        } else {
          log('codex-process: thread/goal/updated missing goal')
        }
        return
      }
      case 'thread/goal/cleared': {
        this.emit('thread_goal_cleared', params)
        return
      }
      case 'thread/status/changed': {
        this.handleThreadStatusChanged(params)
        return
      }
      case 'item/agentMessage/delta': {
        if (typeof params.delta === 'string' && params.delta.length > 0) {
          this.emit('assistant_text', { uuid: params.itemId, text: params.delta, parentToolUseId: null })
        } else {
          logUnhandledAppServerPayload('AGENT_MESSAGE_DELTA_EMPTY', { method, params })
        }
        return
      }
      case 'item/started': {
        this.handleItemStarted(params)
        return
      }
      case 'item/completed': {
        this.handleItemCompleted(params)
        return
      }
      case 'mcpServer/startupStatus/updated': {
        log(`codex-process: mcp ${params.name} ${params.status}${params.error ? `: ${params.error}` : ''}`)
        return
      }
      case 'account/rateLimits/updated': {
        this.emit('rate_limits_updated', params.rateLimits)
        return
      }
      case 'configWarning':
      case 'warning':
      case 'guardianWarning':
      case 'deprecationNotice': {
        log(`codex-process: ${method}: ${params.summary ?? params.message ?? JSON.stringify(params).slice(0, 200)}`)
        return
      }
      case 'error': {
        log(`codex-process: server error: ${JSON.stringify(params).slice(0, 500)}`)
        const error = params.error ?? params
        if (typeof params.turnId === 'string' && params.threadId === this.sessionId
          && !this.finishedTurnIds?.has(params.turnId)
          && (!this.currentTurnId || this.currentTurnId === params.turnId)) {
          this.turnError = { turnId: params.turnId, error }
        }
        // Even willRetry=false precedes turn/completed. Never start a competing
        // turn here, particularly while app-server is doing its own retries.
        this.emit('error', new Error(error.message ?? error.summary ?? 'codex app-server error'))
        return
      }
    }
    logUnhandledAppServerPayload('NOTIFICATION', { method, params })
    this.emit('raw', { method, params })
  }

  private handleItemStarted(params: any): void {
    const item = params?.item
    if (!item?.id) {
      logUnhandledAppServerPayload('ITEM_STARTED_MISSING_ID', { method: 'item/started', params })
      return
    }
    // 多 agent 编排 item 不走通用 tool_use 映射,先喂给 collab 状态机。
    if (this.feedCollabItem(item, 'started')) return
    const mapped = mapStartedItem(item, this.opts.workDir)
    if (!mapped) {
      logUnhandledAppServerPayload('ITEM_STARTED_UNMAPPED', { method: 'item/started', params })
      return
    }
    this.emit('tool_use', { id: item.id, name: mapped.name, input: mapped.input })
  }

  /** 子 agent 线程的 item/started —— 入口分流后的专用通路,只转 subagent_step
   *  (后台卡 steps),collab 编排 item(subAgentActivity 等)仍走 feedCollabItem。 */
  private handleSubagentItemStarted(params: any): void {
    const item = params?.item
    if (!item?.id) return
    if (this.feedCollabItem(item, 'started')) return
    this.emitSubagentStep(item, 'started', params)
  }

  /** 子 agent 线程的 item/completed:工具 item 转 step;agentMessage 捕获末段
   *  文本作 idle 结算的 summary(exec-cell 模式没有 agentsStates message,
   *  子 agent 的最终答复是唯一信息源 —— 保留有界预览,墓碑不再「暂无执行记录」)。 */
  private handleSubagentItemCompleted(params: any): void {
    const item = params?.item
    if (!item?.id) return
    if (item.type === 'agentMessage') {
      const text = typeof item.text === 'string' ? item.text : ''
      if (text) {
        const threadId = typeof params?.threadId === 'string' ? params.threadId : ''
        this.collabAgentSummaries.set(threadId, text)
      }
      return
    }
    if (this.feedCollabItem(item, 'completed')) return
    this.emitSubagentStep(item, 'completed', params)
  }

  private handleItemCompleted(params: any): void {
    const item = params?.item
    if (!item?.id) {
      logUnhandledAppServerPayload('ITEM_COMPLETED_MISSING_ID', { method: 'item/completed', params })
      return
    }
    if (item.type === 'agentMessage') {
      this.lastAssistantUuid = item.id
      this.emit('assistant_block_stop', { index: item.id, parentToolUseId: null })
      return
    }
    if (this.feedCollabItem(item, 'completed')) return
    const mapped = mapCompletedItem(item, this.opts.workDir, this.sessionId ?? undefined)
    if (!mapped) {
      logUnhandledAppServerPayload('ITEM_COMPLETED_UNMAPPED', { method: 'item/completed', params })
      return
    }
    this.emit('tool_result', {
      tool_use_id: item.id,
      content: mapped.output,
      is_error: mapped.isError,
      ...(item.type === 'imageGeneration' ? { input: imageGenerationInput(item) } : {}),
    })
    if (item.type === 'imageGeneration') this.emittedImageGenerationIds.add(item.id)
  }

  // ── Codex 多 agent(ultra)→ bg_task_* 翻译 ────────────────────────
  // Codex 的编排 item(app-server v2 协议):
  //  - subAgentActivity {kind, agentThreadId, agentPath}:子 agent 生命周期信号。
  //    kind=started 是子 agent 首个可靠信号(带 agentPath 任务名)→ bg_task_started。
  //  - collabAgentToolCall {tool, agentsStates}:编排调用(spawn/wait/…)。它的
  //    agentsStates 是每个 receiver agent 的最新状态 —— 每次到达都 diff 出
  //    running / 终态,终态(completed 带 message / errored)→ bg_task_settled。
  // phase 区分 started/completed 两条通路:spawn 面板 tool_use 只在 started 落,
  // tool_result 只在 completed 回 —— 同 id 两次到达不会重复渲染。
  // 返回 true 表示 item 已被 collab 通路消费,不再走通用 tool_use 映射。

  /** item 通知的 threadId 是否属于子 agent(≠ 主线程 sessionId)。collab 编排
   *  下,子 agent 的 commandExecution/fileChange/agentMessage 都以自己的
   *  threadId 广播 —— 它们不属于主卡 timeline。sessionId 未落地前(极早期)
   *  不过滤,保持旧行为。 */
  private isSubagentThread(params: any): boolean {
    const threadId = typeof params?.threadId === 'string' ? params.threadId : ''
    return !!this.sessionId && !!threadId && threadId !== this.sessionId
  }

  /** thread/status/changed → 子 agent 生命周期。这是 exec-cell 编排(gpt-5.6-sol
   *  默认)下子 agent 的**唯一**终态信号 —— 该模式不发 collabAgentToolCall
   *  item,agentsStates 无从到达;子线程状态序列 idle(创建)→ active(跑)→
   *  idle(跑完)。见过 active 之后的 idle = 结算 completed。collab 工具编排
   *  (老路径)的子线程同样发这个通知,两条编排路径统一在这里兜底结算。 */
  private handleThreadStatusChanged(params: any): void {
    const threadId = typeof params?.threadId === 'string' ? params.threadId : ''
    const status = params?.status?.type
    if (!threadId || typeof status !== 'string') return
    // 只关心已知子 agent(名字表里有);主线程 / 未知线程(尚未 spawn 信号的)
    // 的状态变化不驱动后台卡。
    if (!this.collabAgentNames?.has(threadId)) return
    if (status === 'active') {
      this.collabAgentWasActive.add(threadId)
      // 翻活:collabAgentSettled 里的老终态(如 closeAgent 后线程又被重新拉起)
      // 在重新 active 时作废 —— 复用 translateAgentState 的翻活路径不合适
      // (它面向 agentsStates 形状),这里直接清标记 + running patch。
      if (this.collabAgentSettled.has(threadId)) {
        this.collabAgentSettled.delete(threadId)
        this.emit('bg_task_started', {
          task_id: threadId,
          task_type: 'local_agent',
          description: this.collabAgentNames.get(threadId) ?? diagnosticIdLabel(threadId),
        } satisfies BgTaskStartedEvent)
        this.emit('bg_task_updated', {
          task_id: threadId,
          patch: { is_backgrounded: true },
        } satisfies BgTaskUpdatedEvent)
      }
      this.emit('bg_task_updated', {
        task_id: threadId,
        patch: { status: 'running' },
      } satisfies BgTaskUpdatedEvent)
      return
    }
    if (status === 'idle' || status === 'systemError') {
      // systemError:子 agent 出错(独立于主线程),结算成 failed;后续 active
      // 仍可复活(followup 重试)。notLoaded 不算 —— 那是空闲卸载的正常回闲。
      // 首个 idle 是创建态(spawn 后未开跑)—— 没见过 active 不结算。
      if (!this.collabAgentWasActive.has(threadId)) return
      if (this.collabAgentSettled.has(threadId)) return
      this.collabAgentSettled.add(threadId)
      this.emit('bg_task_settled', {
        task_id: threadId,
        status: status === 'systemError' ? 'failed' : 'completed',
        summary: this.collabAgentSummaries.get(threadId) ?? undefined,
      } satisfies BgTaskSettledEvent)
    }
  }

  /** 子 agent 的过程 item → subagent_step 事件(session 据此累积进 bg task 的
   *  steps,后台卡展开可见),不进主卡。只转有信息量的工具类 item —— reasoning
   *  这类(mapStartedItem 不认识)每轮上百条,转成空 step 会把 steps 的 ~1000
   *  字符预算刷满,挤掉真正有用的 Bash/FileChange 记录(trimSteps 保新丢旧)。 */
  private emitSubagentStep(item: any, phase: 'started' | 'completed', params: any): void {
    const threadId = typeof params?.threadId === 'string' ? params.threadId : ''
    const mapped = phase === 'started'
      ? mapStartedItem(item, this.opts.workDir)
      : mapCompletedItem(item, this.opts.workDir, this.sessionId ?? undefined)
    if (!mapped) return // reasoning/agentMessage 等非工具 item:不出 step
    const output = 'output' in mapped && typeof mapped.output === 'string' ? mapped.output : undefined
    this.emit('subagent_step', {
      thread_id: threadId,
      item_id: item.id,
      tool: mapped.name,
      phase,
      brief: subagentStepBrief(mapped.name, mapped.input, output),
    })
  }

  private feedCollabItem(item: any, phase: 'started' | 'completed'): boolean {
    if (item.type === 'subAgentActivity') {
      const threadId = typeof item.agentThreadId === 'string' ? item.agentThreadId : ''
      if (!threadId) return true // 吞掉,不进通用映射也不进 UNHANDLED 噪音
      if (item.kind === 'started' && !this.collabAgentNames.has(threadId)) {
        const name = collabAgentDisplayName(item.agentPath, threadId)
        this.collabAgentNames.set(threadId, name)
        this.emit('bg_task_started', {
          task_id: threadId,
          task_type: 'local_agent',
          description: name,
        } satisfies BgTaskStartedEvent)
        // Codex ultra 编排的子 agent 生而并行(主 agent spawn 后自己继续跑),
        // 直接后台化入卡 —— 不等主线程推进信号。
        this.emit('bg_task_updated', {
          task_id: threadId,
          patch: { is_backgrounded: true },
        } satisfies BgTaskUpdatedEvent)
      } else if (item.kind === 'started') {
        // 已知 id(collabAgentToolCall 先落时占了「子 agent」占位名)—— agentPath
        // 才是真名,发一次 started 让 applyBgTaskStarted 的已知 id patch 补名。
        // 已 settle 的不发:沉降已清 entry,started 会被当新任务重新入池成
        // running 僵尸(晚到的纯元数据修正不该有生命周期语义)。
        const prev = this.collabAgentNames.get(threadId)
        const name = collabAgentDisplayName(item.agentPath, threadId)
        if (prev !== name && !this.collabAgentSettled.has(threadId)) {
          this.collabAgentNames.set(threadId, name)
          this.emit('bg_task_started', {
            task_id: threadId,
            task_type: 'local_agent',
            description: name,
          } satisfies BgTaskStartedEvent)
        }
      } else if (item.kind === 'interrupted') {
        // 打断等待新输入 → paused(计时停走),不冒充 running。
        this.emit('bg_task_updated', {
          task_id: threadId,
          patch: { status: 'paused' },
        } satisfies BgTaskUpdatedEvent)
      }
      return true
    }
    if (item.type === 'collabAgentToolCall') {
      const states = item.agentsStates
      if (states && typeof states === 'object') {
        for (const [threadId, state] of Object.entries(states)) {
          this.translateAgentState(threadId, state as any, item)
        }
      }
      // closeAgent 完成时 agentsStates 带的是关闭前快照(常见 running,见官方
      // close_agent.rs:subscribe_status 先取再 close)—— 收到的 receiver 无条件
      // 结算成 stopped,否则 agent 已关、后台卡还在跑计时。
      if (item.tool === 'closeAgent' && phase === 'completed' && item.status !== 'failed') {
        const ids = collabReceiverThreadIds(item)
        for (const threadId of ids) {
          if (this.collabAgentSettled.has(threadId)) continue
          this.collabAgentSettled.add(threadId)
          if (!this.collabAgentNames.has(threadId)) {
            this.collabAgentNames.set(threadId, collabAgentDisplayName(null, threadId))
          }
          this.emit('bg_task_settled', {
            task_id: threadId,
            status: 'stopped',
          } satisfies BgTaskSettledEvent)
        }
      }
      // spawn 在主卡 timeline 留一行「派生 agent」摘要面板(状态由后台卡承载);
      // 纯编排(wait/sendInput/resumeAgent/closeAgent)无独立信息量,不出面板。
      if (item.tool === 'spawnAgent') {
        if (phase === 'started') {
          this.emit('tool_use', {
            id: item.id,
            name: 'Agent',
            input: {
              tool: 'spawnAgent',
              // fork_turns=all 的 prompt 是服务端密文(gAAAAB…),渲染时归一成占位。
              prompt: collabPromptText(item.prompt),
              description: collabSpawnDescription(item),
              model: typeof item.model === 'string' ? item.model : undefined,
            },
          })
        } else if (item.status !== 'inProgress') {
          this.emit('tool_result', {
            tool_use_id: item.id,
            content: collabSpawnResult(item),
            is_error: item.status === 'failed',
          })
        }
      }
      return true
    }
    return false
  }

  /** agentsStates 单项 → bg_task_updated / bg_task_settled。 */
  private translateAgentState(threadId: string, state: any, item: any): void {
    const status = state?.status
    if (typeof status !== 'string') return
    // 已终态的 agent 又收到 running —— followup_task/interaction 重新激活:
    // 清 settled 标记并补 started+promote(bgStore 全终态沉降后可能已清空该
    // entry,updated 对未知 task 是 no-op —— 重新入池才能翻活)。其余情况
    // (终态快照重复到达)直接跳过 —— 防重复结算,唯一例外:权威终态纠正
    // (见下方分支)。
    if (this.collabAgentSettled.has(threadId)) {
      if (status !== 'running' && status !== 'pendingInit') {
        // 权威终态纠正:thread/status idle 兜底结算已写成 completed,随后
        // agentsStates 带真实终态到达 —— 不翻活,用 updated 把墓碑改成正确
        // 终态(errored→failed / shutdown·notFound→killed)。summary 通道
        // applyBgTaskUpdated 不支持,兜底结算已尽量带了子 agent 末段答复。
        if (status === 'errored' || status === 'shutdown' || status === 'notFound' || status === 'interrupted') {
          this.emit('bg_task_updated', {
            task_id: threadId,
            patch: {
              status: status === 'errored' ? 'failed' : 'killed',
              error: typeof state?.message === 'string' && state.message ? state.message : undefined,
            },
          } satisfies BgTaskUpdatedEvent)
        }
        return
      }
      this.collabAgentSettled.delete(threadId)
      const name = this.collabAgentNames.get(threadId) ?? collabAgentDisplayName(null, threadId)
      this.emit('bg_task_started', {
        task_id: threadId,
        task_type: 'local_agent',
        description: name,
      } satisfies BgTaskStartedEvent)
      this.emit('bg_task_updated', {
        task_id: threadId,
        patch: { is_backgrounded: true },
      } satisfies BgTaskUpdatedEvent)
    }
    if (!this.collabAgentNames.has(threadId)) {
      // 先于 subAgentActivity 到达(spawn 的 inProgress item 先落)。v2 wire 不带
      // receiverAgents,这里没有 agentPath —— 先用中性占位名入卡,subAgentActivity
      // (带 agentPath)到达时经 applyBgTaskStarted 的已知 id patch 补真名。
      const name = '子 agent'
      this.collabAgentNames.set(threadId, name)
      const started: BgTaskStartedEvent = {
        task_id: threadId,
        task_type: 'local_agent',
        description: name,
        prompt: collabPromptText(item.prompt),
      }
      this.emit('bg_task_started', started)
      const promoted: BgTaskUpdatedEvent = {
        task_id: threadId,
        patch: { is_backgrounded: true },
      }
      this.emit('bg_task_updated', promoted)
    }
    if (status === 'running' || status === 'pendingInit' || status === 'interrupted') {
      const updated: BgTaskUpdatedEvent = {
        task_id: threadId,
        // interrupted = 被打断等待新输入(可能 followup)→ paused 计时停走,
        // 不冒充 running。
        patch: { status: status === 'pendingInit' ? 'pending' : status === 'interrupted' ? 'paused' : 'running' },
      }
      this.emit('bg_task_updated', updated)
      return
    }
    // 终态:completed(message 即最终答复)/ errored / shutdown / notFound。
    // 同一 agent 的后续 wait item 会重复携带终态 —— settled 去重(顶部 guard 已滤)。
    // session 复用 alive 进程跨 turn,settled 随子 agent 数增长 —— 超上限清空
    // 重来:最坏后果是极老 agent 的重复终态快照多发一次 settled(store 对已终态
    // entry 幂等),比无界增长可接受。
    if (this.collabAgentSettled.size >= 5000) this.collabAgentSettled.clear()
    this.collabAgentSettled.add(threadId)
    const settled: BgTaskSettledEvent = {
      task_id: threadId,
      status: status === 'completed' ? 'completed' : status === 'errored' ? 'failed' : 'stopped',
      summary: typeof state?.message === 'string' && state.message ? state.message : undefined,
    }
    this.emit('bg_task_settled', settled)
  }

  private primeRolloutImageGenerationScan(): void {
    this.rolloutFilePath = null
    this.rolloutReadOffset = 0
    this.rolloutLineRemainder = ''
    this.rolloutDecoder = new StringDecoder('utf8')
    this.emittedImageGenerationIds.clear()
    if (!this.sessionId) return
    const filePath = findCodexRolloutFile(this.sessionId)
    if (!filePath) return
    this.rolloutFilePath = filePath
    try {
      this.rolloutReadOffset = statSync(filePath).size
      log(`codex-process: image generation rollout scan primed ${filePath} offset=${this.rolloutReadOffset}`)
    } catch (e) {
      log(`codex-process: image generation rollout stat failed ${filePath}: ${e instanceof Error ? e.message : e}`)
      this.rolloutFilePath = null
      this.rolloutReadOffset = 0
    }
  }

  private flushRolloutImageGenerations(): void {
    if (!this.sessionId) return
    const filePath = this.rolloutFilePath ?? findCodexRolloutFile(this.sessionId)
    if (!filePath) {
      log(`codex-process: image generation rollout file not found for thread=${this.sessionId}`)
      return
    }
    this.rolloutFilePath = filePath
    let buf: Buffer
    try {
      const size = statSync(filePath).size
      if (size <= this.rolloutReadOffset) return
      const length = size - this.rolloutReadOffset
      buf = Buffer.allocUnsafe(length)
      const fd = openSync(filePath, 'r')
      let read = 0
      try {
        while (read < length) {
          const n = readSync(fd, buf, read, length - read, this.rolloutReadOffset + read)
          if (n === 0) break
          read += n
        }
      } finally {
        closeSync(fd)
      }
      buf = buf.subarray(0, read)
      this.rolloutReadOffset += read
    } catch (e) {
      log(`codex-process: image generation rollout read failed ${filePath}: ${e instanceof Error ? e.message : e}`)
      return
    }

    const text = this.rolloutLineRemainder + this.rolloutDecoder.write(buf)
    const lines = text.split(/\r?\n/)
    this.rolloutLineRemainder = text.endsWith('\n') ? '' : (lines.pop() ?? '')
    for (const line of lines) {
      if (!line.trim()) continue
      let record: any
      try {
        record = JSON.parse(line)
      } catch (e) {
        log(`codex-process: image generation rollout JSON parse failed ${filePath}: ${e instanceof Error ? e.message : e}`)
        continue
      }
      const payload = record?.payload
      const type = payload?.type
      if (type !== 'image_generation_end' && type !== 'image_generation_call') continue
      this.emitRolloutImageGeneration(payload)
    }
  }

  private emitRolloutImageGeneration(payload: any): void {
    const callId = typeof payload?.call_id === 'string'
      ? payload.call_id
      : typeof payload?.id === 'string'
        ? payload.id
        : ''
    if (!callId || this.emittedImageGenerationIds.has(callId)) return
    const output = imageGenerationOutput(payload, this.sessionId ?? undefined)
    if (!output) return
    const isError = payload?.status === 'failed'
    const status = payload?.status === 'generating' && isAbsolute(output) ? 'completed' : payload?.status
    this.emittedImageGenerationIds.add(callId)
    this.emit('tool_use', {
      id: callId,
      name: 'ImageGeneration',
      input: imageGenerationInput({ ...payload, status }),
    })
    this.emit('tool_result', {
      tool_use_id: callId,
      content: output,
      is_error: isError,
    })
  }

  private withSessionId(notice: ContextCompactedNotification): ContextCompactedNotification {
    const sessionId = notice.sessionId ?? this.sessionId ?? undefined
    return sessionId ? { ...notice, sessionId } : notice
  }

  private handleServerRequest(req: any): void {
    const requestId = String(req.id)
    this.serverRequests.set(requestId, { id: req.id, method: req.method, params: req.params })
    switch (req.method) {
      case 'item/commandExecution/requestApproval': {
        const p = req.params ?? {}
        this.emit('can_use_tool', {
          request_id: requestId,
          tool_name: 'Bash',
          input: { command: p.command, cwd: p.cwd, reason: p.reason },
          tool_use_id: p.itemId,
        } as CanUseToolRequest)
        return
      }
      case 'item/fileChange/requestApproval': {
        const p = req.params ?? {}
        this.emit('can_use_tool', {
          request_id: requestId,
          tool_name: 'FileChange',
          input: { reason: p.reason, grantRoot: p.grantRoot },
          tool_use_id: p.itemId,
        } as CanUseToolRequest)
        return
      }
      case 'item/tool/requestUserInput': {
        const p = req.params ?? {}
        const input = {
          questions: (p.questions ?? []).map((q: any) => ({
            id: q.id,
            header: q.header,
            question: q.question,
            options: Array.isArray(q.options) && q.options.length
              ? q.options.map((o: any) => ({ label: o.label, description: o.description }))
              : [{ label: '自定义回答', description: q.isSecret ? '请直接在群里回复' : '可直接在群里回复' }],
          })),
        }
        this.emit('tool_use', { id: p.itemId, name: 'AskUserQuestion', input })
        this.emit('can_use_tool', {
          request_id: requestId,
          tool_name: 'AskUserQuestion',
          input,
          tool_use_id: p.itemId,
        } as CanUseToolRequest)
        return
      }
      case 'item/permissions/requestApproval': {
        const p = req.params ?? {}
        this.emit('can_use_tool', {
          request_id: requestId,
          tool_name: 'PermissionProfile',
          input: { cwd: p.cwd, reason: p.reason, permissions: p.permissions },
          tool_use_id: p.itemId,
        } as CanUseToolRequest)
        return
      }
      case 'item/tool/call': {
        const p = req.params ?? {}
        this.emit('tool_use', {
          id: p.callId,
          name: p.namespace ? `${p.namespace}.${p.tool}` : p.tool,
          input: p.arguments,
        })
        this.respond(requestId, { contentItems: [{ type: 'inputText', text: 'Lodestar does not implement this dynamic tool.' }], success: false })
        return
      }
      case 'account/chatgptAuthTokens/refresh':
      case 'attestation/generate':
      case 'applyPatchApproval':
      case 'execCommandApproval':
      default: {
        logUnhandledAppServerPayload('SERVER_REQUEST_UNSUPPORTED', req)
        this.respondError(requestId, `unsupported server request: ${req.method}`)
      }
    }
  }

  private write(obj: object, onError?: (error: Error) => void): boolean {
    const fail = (reason: unknown): false => {
      const error = reason instanceof Error ? reason : new Error(String(reason))
      log(`codex-process: stdin write failed: ${error.message}`)
      onError?.(error)
      return false
    }
    if (!this.alive) {
      return fail(new Error(`write to dead process: ${JSON.stringify(obj).slice(0, 200)}`))
    }
    if (this.proc.stdin.destroyed || this.proc.stdin.writableEnded || !this.proc.stdin.writable) {
      return fail(new Error('stdin is not writable'))
    }
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n', error => {
        if (error) fail(error)
      })
      return true
    } catch (e) {
      return fail(e)
    }
  }

  private request(method: string, params: any, timeoutMs = CODEX_REQUEST_TIMEOUT_MS): Promise<any> {
    const id = ++this.requestCounter
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.reject(new Error(`codex app-server ${method} request timed out after ${timeoutMs}ms (id=${id})`))
      }, Math.max(0, timeoutMs))
      const pending: PendingRequest = { resolve, reject, method, timeout }
      this.pending.set(id, pending)
      this.write({ id, method, params }, error => {
        if (this.pending.get(id) !== pending) return
        this.pending.delete(id)
        clearTimeout(timeout)
        reject(new Error(`codex app-server ${method} request write failed (id=${id}): ${error.message}`, { cause: error }))
      })
    })
  }

  private rejectPendingRequests(errorFor: (id: string | number, pending: PendingRequest) => Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(errorFor(id, pending))
    }
    this.pending.clear()
  }

  private respond(id: string | number, result: any): void {
    const key = String(id)
    const req = this.serverRequests.get(key)
    this.serverRequests.delete(key)
    this.write({ id: req?.id ?? id, result })
  }

  private respondError(id: string | number, message: string): void {
    const key = String(id)
    const req = this.serverRequests.get(key)
    this.serverRequests.delete(key)
    // code 必填:app-server 的 JSONRPCMessage 反序列化只认带 code 的 error
    // 对象,只回 {message} 会 deserialize 失败、request 永久悬挂(2026-08-17
    // 探针实测)。-32601 MethodNotFound 语义最接近"host 拒绝/不支持"。
    this.write({ id: req?.id ?? id, error: { code: -32601, message } })
  }

  sendInitialize(): void {
    if (!this.readyPromise) {
      this.readyPromise = this.initializeAndStartThread()
      void this.readyPromise.catch(e => {
        log(`codex-process: initialize failed: ${e}`)
        this.emit('error', e)
      })
    }
  }

  initializationPromise(): Promise<void> {
    if (!this.readyPromise) this.sendInitialize()
    return this.readyPromise!
  }

  isConversationResumable(): boolean {
    return this.conversationResumable
  }

  conversationMaterializationBarrier(): Promise<void> | null {
    return this.conversationMaterializationVerification
      ? this.drainConversationMaterialization()
      : null
  }

  conversationMaterializationFailure(): Error | null {
    return this.lastConversationMaterializationFailure
  }

  private async drainConversationMaterialization(): Promise<void> {
    while (this.conversationMaterializationVerification) {
      const active = this.conversationMaterializationVerification
      try { await active } catch { /* latest typed failure is stored by the owner */ }
      // The owner clears `active` and can install a queued completion retry in
      // its derived `finally` microtask. Yield so this loop observes the retry
      // rather than treating the first failed attempt as the final barrier.
      await Promise.resolve()
    }
    if (!this.conversationResumable && this.lastConversationMaterializationFailure) {
      throw this.lastConversationMaterializationFailure
    }
  }

  /** 在本进程的 app-server 连接上读账号额度(read 端点,权威多桶视图)。
   *  给 turn 收尾刷新 usage cache 用 —— rolling 通知 limitId 不可信
   *  (2026-08-20 源码核实:上游缺 meter 名时 codex 解析器强补 "codex"),
   *  额度状态只认 read。须在 initialize 之后调用。 */
  async readRateLimits(): Promise<any> {
    await this.ensureInitialized()
    return this.request('account/rateLimits/read', {})
  }

  private initializeParams(): Record<string, unknown> {
    return {
      clientInfo: { name: 'lodestar', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }
  }

  /** Initialize this app-server transport exactly once, then complete the
   * JSON-RPC handshake before any catalog or thread request is sent. */
  private async ensureInitialized(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.request('initialize', this.initializeParams()).then(() => {
        if (!this.write({ method: 'initialized' })) {
          throw new Error('codex app-server initialized notification write failed')
        }
      })
    }
    await this.initializePromise
  }

  private async initializeAndStartThread(): Promise<void> {
    const launch = this.conversationLaunch()
    await this.ensureInitialized()

    const params = this.threadParams()
    let method: 'thread/start' | 'thread/resume' | 'thread/fork'
    let res: any
    if (launch.kind === 'resume') {
      method = 'thread/resume'
      res = await this.request(method, {
        threadId: launch.source.sessionId,
        ...params,
        excludeTurns: true,
        persistExtendedHistory: false,
      })
    } else if (launch.kind === 'fork') {
      method = 'thread/fork'
      res = await this.request(method, {
        threadId: launch.source.sessionId,
        ...(launch.through ? { lastTurnId: launch.through.id } : {}),
        ...params,
        excludeTurns: true,
      })
    } else {
      method = 'thread/start'
      res = await this.request(method, {
        ...params,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      })
    }
    const thread = res?.thread
    if (typeof thread?.id !== 'string' || !thread.id) {
      throw new Error(`codex app-server ${method} returned no thread.id`)
    }
    const returnedCwd = typeof thread.cwd === 'string'
      ? thread.cwd
      : typeof res?.cwd === 'string'
        ? res.cwd
        : null
    if (returnedCwd !== this.opts.workDir) {
      throw new Error(`codex app-server ${method} returned cwd=${returnedCwd ?? 'MISS'}, expected ${this.opts.workDir}`)
    }
    if (launch.kind === 'fork' && thread.id === launch.source.sessionId) {
      throw new Error(`codex app-server thread/fork returned source thread id ${thread.id}`)
    }
    if (launch.kind === 'resume' && thread.id !== launch.source.sessionId) {
      throw new Error(`codex app-server thread/resume returned thread id ${thread.id}, expected ${launch.source.sessionId}`)
    }
    const rolloutPath = typeof thread.path === 'string' && thread.path ? thread.path : null
    if (!rolloutPath || !isAbsolute(rolloutPath) || !rolloutPath.endsWith(`${thread.id}.jsonl`)) {
      throw new Error(`codex app-server ${method} returned invalid thread.path=${rolloutPath ?? 'MISS'}`)
    }
    this.sessionId = thread.id
    this.conversationRolloutPath = rolloutPath
    // Resume requires an existing rollout and fork materializes its own rollout
    // before the RPC returns. Only fresh thread/start is still an in-memory id.
    this.conversationResumable = false
    if (launch.kind !== 'fresh') {
      await this.verifyConversationMaterialized(`${method} response`)
      this.conversationResumable = true
    }
    if (res?.model) this.lastModel = res.model
    if (isCodexReasoningEffort(res?.reasoningEffort)) this.lastEffort = res.reasoningEffort
    else this.lastEffort = this.opts.effort ?? null
    log(`codex-process: thread=${this.sessionId}`)
    this.primeRolloutImageGenerationScan()
    this.emit('init', { session_id: this.sessionId, thread })
  }

  private markConversationMaterialized(source: string): void {
    if (this.conversationResumable) return
    if (!this.sessionId) {
      throw new Error(`codex ${source} arrived before thread initialization`)
    }
    if (this.conversationMaterializationVerification) {
      this.conversationMaterializationRetrySource = source
      return
    }
    const sessionId = this.sessionId
    const verification = this.verifyConversationMaterialized(source)
    this.conversationMaterializationVerification = verification
    void verification.then(() => {
      if (this.sessionId !== sessionId || this.conversationResumable) return
      this.lastConversationMaterializationFailure = null
      this.conversationResumable = true
      log(`codex-process: conversation materialized thread=${sessionId} source=${source}`)
      this.emit('conversation_materialized', { session_id: sessionId, source })
    }, cause => {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      this.lastConversationMaterializationFailure = error
      log(`codex-process: conversation materialization check failed thread=${sessionId} source=${source}: ${error.message}`)
      this.emit('conversation_materialization_failed', {
        session_id: sessionId,
        path: this.conversationRolloutPath,
        source,
        error,
      })
    }).finally(() => {
      if (this.conversationMaterializationVerification === verification) {
        this.conversationMaterializationVerification = null
      }
      const retrySource = this.conversationMaterializationRetrySource
      this.conversationMaterializationRetrySource = null
      if (!this.conversationResumable && retrySource) {
        this.markConversationMaterialized(retrySource)
      }
    })
  }

  private async verifyConversationMaterialized(source: string): Promise<void> {
    const sessionId = this.sessionId
    const path = this.conversationRolloutPath
    if (!sessionId || !path) throw new Error(`codex ${source} has no initialized rollout identity`)
    // On Codex 0.149 thread/read(includeTurns=true) explicitly rejects a fresh
    // in-memory thread as "not materialized yet". A successful read is the
    // app-server's authoritative persistence acknowledgement; the exact path
    // check then prevents a mismatched/foreign thread from being bound.
    const res = await this.request('thread/read', {
      threadId: sessionId,
      includeTurns: true,
    }, CODEX_MATERIALIZATION_VERIFY_TIMEOUT_MS)
    const thread = res?.thread
    if (
      thread?.id !== sessionId
      || thread.cwd !== this.opts.workDir
      || thread.path !== path
      || !Array.isArray(thread.turns)
    ) {
      throw new Error(`codex ${source} thread/read returned an invalid materialized thread`)
    }
    this.assertConversationRolloutMaterialized(source)
  }

  private assertConversationRolloutMaterialized(source: string): void {
    const path = this.conversationRolloutPath
    if (!path) throw new Error(`codex ${source} has no authoritative rollout path`)
    let stat: ReturnType<typeof statSync>
    try { stat = statSync(path) }
    catch (cause) {
      throw new Error(`codex ${source} rollout is not readable at ${path}: ${cause instanceof Error ? cause.message : cause}`, {
        cause,
      })
    }
    if (!stat.isFile()) throw new Error(`codex ${source} rollout path is not a file: ${path}`)
  }

  private conversationLaunch(): ConversationLaunch {
    const launch: ConversationLaunch = this.opts.launch
      ?? { kind: 'fresh' }
    validateConversationLaunch(launch, 'codex', this.opts.workDir)
    if (launch.kind !== 'fresh' && (typeof launch.source.sessionId !== 'string' || !launch.source.sessionId)) {
      throw new Error(`codex ${launch.kind} launch requires a source session id`)
    }
    if (launch.kind === 'fork' && launch.through) {
      if (launch.through.provider !== 'codex' || launch.through.kind !== 'turn') {
        throw new Error('codex fork through checkpoint must be a codex turn checkpoint')
      }
      if (typeof launch.through.id !== 'string' || !launch.through.id) {
        throw new Error('codex fork through checkpoint requires a turn id')
      }
    }
    return launch
  }

  private threadParams(): Record<string, unknown> {
    // model/effort 由 token source 决定、经 opts 下发(取代自治 ~/.codex/config.toml)。
    // opts 为空(无 token source,如旧路径)则不下发,走 codex 原生配置 —— 平滑过渡。
    // request_user_input 工具默认只在 Plan mode 注册;开 flag 让 Default mode 也能用,
    // 澄清问题走原生阻塞式工具调用(2026-08-17 探针验证全链路)。answer 回包格式见
    // sendPermissionResponse 的 item/tool/requestUserInput 分支。
    return {
      cwd: this.opts.workDir,
      runtimeWorkspaceRoots: [this.opts.workDir],
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      // config 键合并下发:request_user_input flag + effort。effort 走
      // config.model_reasoning_effort —— codex 0.147 顶层 effort 参数是摆设
      // (下发任何值都被无视、回落 ~/.codex/config.toml),config 键才真生效
      // (2026-08-18 探针:effort=ultra 顶层回包 xhigh,config 路径回包 ultra)。
      config: {
        'features.default_mode_request_user_input': true,
        ...(this.opts.allowDelegation === false ? { 'features.multi_agent': false } : {}),
        ...(this.opts.effort ? { model_reasoning_effort: this.opts.effort } : {}),
      },
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.appendSystemPrompt ? { developerInstructions: this.opts.appendSystemPrompt } : {}),
      serviceName: this.opts.serviceName ?? 'lodestar',
    }
  }

  sendUserText(text: string, files: string[] = []): void {
    const fileHints = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n\n' : ''
    this.cancelCapacityRetry()
    this.capacityRetryCount = 0
    this.capacityRetryHasStarted = false
    this.capacityRetryEnabled = true
    this.turnError = null
    const attempt = this.beginTurnStart(fileHints + text)
    void this.startTurn(fileHints + text, attempt).catch(e => this.failTurnStart(e, attempt))
  }

  async listModels(): Promise<CodexModel[]> {
    await this.ensureInitialized()
    const models: CodexModel[] = []
    let cursor: string | null = null
    do {
      const res = await this.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      })
      if (!Array.isArray(res?.data)) {
        throw new Error('model/list returned no data array')
      }
      for (const raw of res.data) {
        if (typeof raw?.model !== 'string' || !raw.model) continue
        models.push({
          id: typeof raw.id === 'string' && raw.id ? raw.id : raw.model,
          model: raw.model,
          displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : raw.model,
          description: typeof raw.description === 'string' ? raw.description : '',
          hidden: raw.hidden === true,
          isDefault: raw.isDefault === true,
          supportedReasoningEfforts: parseReasoningEffortOptions(raw.supportedReasoningEfforts),
          defaultReasoningEffort: isCodexReasoningEffort(raw.defaultReasoningEffort)
            ? raw.defaultReasoningEffort
            : null,
        })
      }
      cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null
    } while (cursor)
    return models
  }

  /** List persisted Codex interactive conversations for this exact cwd.
   * App-server owns discovery and pagination; Lodestar does not scan rollouts
   * or substitute a second session index. `sourceKinds` is intentionally
   * omitted: current app-server can persist Lodestar-created threads as `vscode`,
   * and the protocol-defined default already selects interactive sources while
   * excluding sub-agent-only histories. */
  async listConversations(): Promise<ConversationSummary[]> {
    await this.ensureInitialized()
    const conversations: ConversationSummary[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    do {
      const res = await this.request('thread/list', {
        cursor,
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        cwd: this.opts.workDir,
      })
      if (!Array.isArray(res?.data)) {
        throw new Error('thread/list returned no data array')
      }
      for (const raw of res.data) {
        if (
          typeof raw?.id !== 'string' || !raw.id
          || typeof raw.preview !== 'string'
          || typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)
          || typeof raw.cwd !== 'string' || raw.cwd !== this.opts.workDir
        ) {
          throw new Error('thread/list returned an invalid thread summary')
        }
        const status = typeof raw.status === 'string'
          ? raw.status
          : typeof raw.status?.type === 'string'
            ? raw.status.type
            : undefined
        if (isAgentSession('codex', raw.id)) continue
        conversations.push({
          provider: 'codex',
          sessionId: raw.id,
          cwd: raw.cwd,
          preview: raw.preview,
          // app-server timestamps are Unix seconds; card/history callers use ms.
          ts: raw.updatedAt * 1000,
          ...(status ? { status } : {}),
        })
      }
      const nextCursor = res?.nextCursor
      if (nextCursor !== null && typeof nextCursor !== 'string') {
        throw new Error('thread/list returned an invalid nextCursor')
      }
      if (nextCursor && seenCursors.has(nextCursor)) {
        throw new Error(`thread/list repeated pagination cursor ${nextCursor}`)
      }
      if (nextCursor) seenCursors.add(nextCursor)
      cursor = nextCursor
    } while (cursor)
    return conversations
  }

  /** Resolve one legacy resume id to its authoritative stored cwd without loading it. */
  async readConversationRef(sessionId: string): Promise<ConversationRef> {
    if (!sessionId.trim()) throw new Error('thread/read requires a session id')
    await this.ensureInitialized()
    const res = await this.request('thread/read', { threadId: sessionId, includeTurns: false })
    const thread = res?.thread
    if (thread?.id !== sessionId || typeof thread.cwd !== 'string') {
      throw new Error('thread/read returned an invalid conversation reference')
    }
    return { provider: 'codex', sessionId, cwd: thread.cwd }
  }

  async setModelSettings(_model: string, _effort: AgentReasoningEffort): Promise<void> {
    // Session 保存目标设置，重启时由启动参数应用；不修改运行中的 thread。
    log('codex-process: model settings require a process restart')
  }

  async compactThread(): Promise<void> {
    if (!this.readyPromise) throw new Error('codex thread not initialized')
    await this.readyPromise
    if (!this.sessionId) throw new Error('codex thread not initialized')
    await this.request('thread/compact/start', {
      threadId: this.sessionId,
    })
  }

  private failTurnStart(e: unknown, attempt: TurnStartAttempt): void {
    if (!this.ownsTurnStartFailure(attempt)) {
      log(`codex-process: ignored stale turn/start failure generation=${attempt.generation}`)
      return
    }
    this.turnStartOwner = null
    attempt.terminal = true
    const message = e instanceof Error ? e.message : String(e)
    log(`codex-process: turn/start failed: ${message}`)
    if (e instanceof CodexRpcResponseError && e.method === 'turn/start'
      && isModelCapacityError(e.serverMessage) && attempt.inputText !== undefined
      && this.scheduleCapacityRetry(e.serverMessage, attempt.inputText)) return
    this.cancelCapacityRetry()
    this.capacityRetryCount = 0
    this.capacityRetryHasStarted = false
    this.lastResult = {
      cost_usd: null,
      cost_delta_usd: null,
      duration_ms: null,
      num_turns: null,
      usage: this.lastUsage,
      subtype: 'codex_turn_start_failed',
      is_error: true,
    }
    this.currentTurnId = null
    this.lastCompletedTurnId = null
    this.emit('result', {
      subtype: this.lastResult.subtype,
      is_error: true,
      duration_ms: null,
      usage: this.lastUsage,
      error: message,
    })
  }

  private recordTurnStarted(
    turn: any,
    threadId: unknown,
    source: string,
    attempt?: TurnStartAttempt,
  ): void {
    const turnId = typeof turn?.id === 'string' && turn.id ? turn.id : null
    if (!turnId) {
      throw new Error(`codex app-server ${source} returned no turn.id`)
    }
    if (this.finishedTurnIds?.has(turnId)) return
    const owner = attempt ?? this.turnStartOwner
    if (owner?.interrupted) {
      this.rememberFinishedTurn(turnId)
      if (this.turnStartOwner === owner) this.turnStartOwner = null
      this.interruptTurn(turnId)
      return
    }
    this.confirmTurnStart(turnId, attempt)
    // turn/start response and turn/started notification describe the same
    // transition. Whichever arrives first owns the event; the duplicate only
    // confirms the canonical id.
    const changed = this.currentTurnId !== turnId
    this.currentTurnId = turnId
    if (!changed) return
    const retrying = this.capacityRetryHasStarted && (this.capacityRetryCount ?? 0) > 0
    this.capacityRetryHasStarted = true
    if (this.capacityRetryTimer && this.turnRetry) {
      // A native goal/background continuation can beat our timer.
      const retry = { ...this.turnRetry, phase: 'retrying' as const, delayMs: 0 }
      this.cancelCapacityRetry()
      this.emit('turn_retry', retry)
    }
    this.turnRetry = null
    this.lastCompletedTurnId = null
    this.emit('turn_started', {
      turn_id: turnId,
      thread_id: typeof threadId === 'string' && threadId ? threadId : this.sessionId,
      ...(retrying ? { retry: true } : {}),
    })
  }

  private beginTurnStart(inputText?: string): TurnStartAttempt {
    const attempt: TurnStartAttempt = {
      generation: (this.turnStartGeneration ?? 0) + 1,
      turnId: null,
      confirmed: false,
      terminal: false,
      inputText,
    }
    this.turnStartGeneration = attempt.generation
    this.turnStartOwner = attempt
    return attempt
  }

  private confirmTurnStart(turnId: string, explicitAttempt?: TurnStartAttempt): void {
    if (!this.turnStartOwnersByTurnId) this.turnStartOwnersByTurnId = new Map()
    const attempt = explicitAttempt
      ?? this.turnStartOwnersByTurnId.get(turnId)
      ?? this.turnStartOwner
    if (!attempt) return
    if (attempt.turnId && attempt.turnId !== turnId) {
      throw new Error(
        `codex turn/start generation=${attempt.generation} changed turn id from ${attempt.turnId} to ${turnId}`,
      )
    }
    if (attempt.terminal) return
    attempt.turnId = turnId
    attempt.confirmed = true
    this.turnStartOwnersByTurnId.set(turnId, attempt)
  }

  private markTurnStartTerminal(turnId: string): void {
    if (!this.turnStartOwnersByTurnId) this.turnStartOwnersByTurnId = new Map()
    let attempt = this.turnStartOwnersByTurnId.get(turnId)
    if (!attempt && this.turnStartOwner && (!this.currentTurnId || this.currentTurnId === turnId)) {
      attempt = this.turnStartOwner
      this.confirmTurnStart(turnId, attempt)
    }
    if (!attempt) return
    attempt.confirmed = true
    attempt.terminal = true
    this.turnStartOwnersByTurnId.delete(turnId)
    if (this.turnStartOwner === attempt) this.turnStartOwner = null
  }

  private ownsTurnStartFailure(attempt: TurnStartAttempt): boolean {
    return this.turnStartOwner === attempt && !attempt.confirmed && !attempt.terminal
  }

  private rememberFinishedTurn(turnId: string): void {
    // Object.create(CodexProcess.prototype) test/probe harnesses do not run
    // class field initializers, so retain lazy initialization here.
    if (!this.finishedTurnIds) this.finishedTurnIds = new Set<string>()
    this.finishedTurnIds.add(turnId)
    if (this.finishedTurnIds.size <= 64) return
    const oldest = this.finishedTurnIds.values().next().value
    if (typeof oldest === 'string') this.finishedTurnIds.delete(oldest)
  }

  private async startTurn(text: string, suppliedAttempt?: TurnStartAttempt): Promise<void> {
    const attempt = suppliedAttempt ?? this.beginTurnStart(text)
    // A turn/start transport failure also emits result; clear the previous
    // checkpoint before any await so that failure cannot reuse it as an anchor.
    this.lastCompletedTurnId = null
    try {
      if (!this.readyPromise) this.sendInitialize()
      await this.readyPromise
      if (attempt.interrupted || this.expectedExit || !this.alive) return
      if (!this.sessionId) throw new Error('codex thread not initialized')
      const res = await this.request('turn/start', {
        threadId: this.sessionId,
        input: [{ type: 'text', text, text_elements: [] }],
        cwd: this.opts.workDir,
        runtimeWorkspaceRoots: [this.opts.workDir],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      })
      this.recordTurnStarted(res?.turn, this.sessionId, 'turn/start response', attempt)
    } catch (e) {
      if (!this.ownsTurnStartFailure(attempt)) {
        log(`codex-process: ignored stale turn/start rejection generation=${attempt.generation}`)
        return
      }
      throw e
    }
  }

  sendInterrupt(): void {
    this.capacityRetryEnabled = false
    const wasWaiting = !!this.turnRetry && !this.currentTurnId
    this.cancelCapacityRetry()
    const pendingStart = this.turnStartOwner
    const interruptPendingStart = pendingStart && !pendingStart.confirmed && !pendingStart.terminal
    if (interruptPendingStart) {
      pendingStart.interrupted = true
      pendingStart.terminal = true
    }
    if (this.currentTurnId) this.interruptTurn(this.currentTurnId)
    else if (wasWaiting || interruptPendingStart) {
      this.lastCompletedTurnId = null
      this.lastResult = {
        cost_usd: null, cost_delta_usd: null, duration_ms: null, num_turns: null,
        usage: this.lastUsage, subtype: 'interrupted', is_error: false,
      }
      this.emit('result', { ...this.lastResult, checkpoint: null })
    }
  }

  private interruptTurn(turnId: string): void {
    if (!this.sessionId) return
    void this.request('turn/interrupt', { threadId: this.sessionId, turnId })
      .catch(e => log(`codex-process: interrupt failed: ${e}`))
  }

  private cancelCapacityRetry(): void {
    if (this.capacityRetryTimer) clearTimeout(this.capacityRetryTimer)
    this.capacityRetryTimer = null
    this.turnRetry = null
  }

  private scheduleCapacityRetry(message: string, inputText: string): boolean {
    if (!this.alive || this.expectedExit || !this.capacityRetryEnabled) return false
    if (this.capacityRetryTimer) return true
    const attempt = (this.capacityRetryCount ?? 0) + 1
    this.capacityRetryCount = attempt
    const delayMs = Math.min(CODEX_CAPACITY_RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 4), CODEX_CAPACITY_RETRY_MAX_MS)
    const generation = this.turnStartGeneration ?? 0
    const notice: AgentTurnRetry = { phase: 'waiting', attempt, delayMs, message }
    this.turnRetry = notice
    log(`codex-process: model capacity retry #${attempt} in ${delayMs}ms: ${message}`)
    // Deliberately keep retrying this specific capacity error until cancelled;
    // delays are capped, and every failure stays visible in the log and UI.
    const timer = setTimeout(() => {
      if (this.capacityRetryTimer !== timer) return
      this.capacityRetryTimer = null
      if (!this.alive || this.expectedExit || !this.capacityRetryEnabled
        || this.currentTurnId || generation !== (this.turnStartGeneration ?? 0)) return
      this.turnRetry = { ...notice, phase: 'retrying', delayMs: 0 }
      this.emit('turn_retry', this.turnRetry)
      // Event consumers can synchronously stop the worker or supply new input.
      if (!this.alive || this.expectedExit || !this.capacityRetryEnabled
        || generation !== (this.turnStartGeneration ?? 0)) return
      const owner = this.beginTurnStart(inputText)
      void this.startTurn(inputText, owner).catch(e => this.failTurnStart(e, owner))
    }, delayMs)
    this.capacityRetryTimer = timer
    this.emit('turn_retry', notice)
    return true
  }

  sendPermissionResponse(
    requestId: string | number,
    decision: 'allow' | 'deny',
    payload?: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown; denyMessage?: string },
  ): void {
    const req = this.serverRequests.get(String(requestId))
    if (!req) {
      log(`codex-process: permission response for unknown request ${requestId}`)
      return
    }
    const allow = decision === 'allow'
    switch (req.method) {
      case 'item/commandExecution/requestApproval':
        this.respond(requestId, { decision: allow ? 'accept' : 'decline' })
        return
      case 'item/fileChange/requestApproval':
        this.respond(requestId, { decision: allow ? 'accept' : 'decline' })
        return
      case 'item/permissions/requestApproval':
        if (allow) {
          this.respond(requestId, {
            permissions: req.params?.permissions ?? {},
            scope: 'session',
          })
        } else {
          this.respondError(requestId, payload?.denyMessage ?? 'denied by user')
        }
        return
      case 'item/tool/requestUserInput': {
        if (!allow) {
          this.respondError(requestId, payload?.denyMessage ?? 'denied by user')
          return
        }
        const answersByQuestion = (payload?.updatedInput?.answers ?? {}) as Record<string, string>
        const answers: Record<string, { answers: string[] }> = {}
        for (const q of req.params?.questions ?? []) {
          const value = answersByQuestion[q.question] ?? answersByQuestion[q.id]
          if (value !== undefined) answers[q.id] = { answers: [String(value)] }
        }
        this.respond(requestId, { answers })
        return
      }
      default:
        logUnhandledAppServerPayload('APPROVAL_RESPONSE_UNSUPPORTED', {
          requestId,
          method: req.method,
          params: req.params,
          decision,
          payload,
        })
        this.respondError(requestId, payload?.denyMessage ?? 'unsupported approval request')
    }
  }

  sendHookResponse(requestId: string, output: object = {}): void {
    this.respond(requestId, output)
  }

  /** Session ownership remains live through child `close`, even after the OS
   * `exit` event, so no caller can detach while final stdout is still draining. */
  isAlive(): boolean { return !this.exitEventEmitted }

  async kill(timeoutMs = 5000): Promise<void> {
    this.capacityRetryEnabled = false
    this.cancelCapacityRetry()
    if (!this.alive) {
      if (await this.waitForExit(timeoutMs)) return
      throw new Error(`codex app-server exited but stdio did not close within ${timeoutMs}ms`)
    }
    this.expectedExit = true
    log(`codex-process: SIGTERM (timeout=${timeoutMs}ms)`)
    const signalErrors: string[] = []
    this.sendSignal('SIGTERM', signalErrors)
    if (await this.waitForExit(timeoutMs)) return

    log(`codex-process: SIGKILL (lifecycle not closed after ${timeoutMs}ms)`)
    if (this.alive) this.sendSignal('SIGKILL', signalErrors)
    if (await this.waitForExit(timeoutMs)) return

    const details = signalErrors.length ? `; ${signalErrors.join('; ')}` : ''
    const error = new Error(`codex app-server did not exit after SIGTERM and SIGKILL (${timeoutMs}ms each)${details}`)
    log(`codex-process: kill failed: ${error.message}`)
    throw error
  }

  private sendSignal(signal: NodeJS.Signals, errors: string[]): void {
    try {
      if (!this.proc.kill(signal) && this.alive) errors.push(`${signal} was not delivered`)
    } catch (e) {
      errors.push(`${signal} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exitEventEmitted) return true
    return new Promise(resolve => {
      let settled = false
      const finish = (exited: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(exited)
      }
      const timeout = setTimeout(() => finish(false), Math.max(0, timeoutMs))
      void this.exitPromise.then(() => finish(true))
    })
  }
}

function mapStartedItem(item: any, workDir: string): { name: string; input: any } | null {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'Bash', input: { command: item.command, cwd: item.cwd, source: item.source } }
    case 'fileChange':
      return { name: 'FileChange', input: { changes: item.changes, status: item.status, cwd: workDir } }
    case 'mcpToolCall':
      return { name: 'MCP', input: { server: item.server, tool: item.tool, arguments: item.arguments } }
    case 'dynamicToolCall':
      return { name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool, input: item.arguments }
    case 'webSearch':
      return { name: 'WebSearch', input: { query: item.query, action: item.action } }
    case 'imageGeneration':
      return { name: 'ImageGeneration', input: imageGenerationInput(item) }
  }
  return null
}

function imageGenerationRevisedPrompt(item: any): string | undefined {
  const prompt = item?.revisedPrompt ?? item?.revised_prompt
  return typeof prompt === 'string' && prompt ? prompt : undefined
}

function imageGenerationInput(item: any): object {
  return { status: item.status, revisedPrompt: imageGenerationRevisedPrompt(item),
    ...(typeof item?.prompt === 'string' && item.prompt ? { prompt: item.prompt } : {}) }
}

function findCodexRolloutFile(sessionId: string): string | null {
  if (!sessionId || !existsSync(CODEX_SESSIONS_DIR)) return null
  let best: { path: string; mtimeMs: number } | null = null
  const stack = [CODEX_SESSIONS_DIR]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      log(`codex-process: cannot scan Codex session dir ${dir}: ${e instanceof Error ? e.message : e}`)
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith(`${sessionId}.jsonl`)) continue
      try {
        const mtimeMs = statSync(path).mtimeMs
        if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs }
      } catch (e) {
        log(`codex-process: cannot stat Codex rollout ${path}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }
  return best?.path ?? null
}

export function imageGenerationOutput(
  item: any,
  threadId?: string,
  outputRoot = CODEX_GENERATED_IMAGES_DIR,
): string {
  const directPath = item?.savedPath ?? item?.saved_path
  if (typeof directPath === 'string' && directPath) return directPath

  const result = item?.result
  if (typeof result === 'string') {
    const materialized = materializeImageGenerationResult(item, threadId, outputRoot)
    if (materialized) return materialized
    if (result.length > 2048) {
      const id = imageGenerationCallId(item)
      log(`codex-process: image generation inline result could not be decoded id=${id} length=${result.length}`)
      return `Image generation returned ${result.length} chars of inline data, but Lodestar could not materialize it as an image file.`
    }
    return result
  }
  if (result && typeof result === 'object') {
    const resultPath = result.savedPath ?? result.saved_path ?? result.path
    if (typeof resultPath === 'string' && resultPath) return resultPath
    return JSON.stringify(result, null, 2)
  }
  return ''
}

function materializeImageGenerationResult(item: any, threadId: string | undefined, outputRoot: string): string | null {
  const result = item?.result
  if (typeof result !== 'string') return null
  const decoded = imageBufferFromBase64Result(result)
  if (!decoded) return null

  const threadPart = sanitizeGeneratedImagePart(threadId ?? 'unknown-thread')
  const callPart = sanitizeGeneratedImagePart(imageGenerationCallId(item))
  const dir = join(outputRoot, threadPart)
  const path = join(dir, `${callPart}.${decoded.ext}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, decoded.buffer)
    return path
  } catch (e) {
    log(`codex-process: failed to write image generation result ${path}: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

function imageGenerationCallId(item: any): string {
  const id = item?.callId ?? item?.call_id ?? item?.id
  return typeof id === 'string' && id ? id : `image-${Date.now()}`
}

function sanitizeGeneratedImagePart(part: string): string {
  const sanitized = part.trim().replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^_+|_+$/g, '')
  return sanitized ? sanitized.slice(0, 140) : 'unknown'
}

function imageBufferFromBase64Result(result: string): { buffer: Buffer; ext: string } | null {
  const trimmed = result.trim()
  let base64 = trimmed
  let hintedExt: string | null = null
  const dataUrl = trimmed.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s)
  if (dataUrl) {
    hintedExt = mimeSubtypeToExtension(dataUrl[1])
    base64 = dataUrl[2]
  } else {
    if (trimmed.length < 64) return null
    if (!/^[a-zA-Z0-9+/=_\-\s]+$/.test(trimmed)) return null
  }
  base64 = base64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (!base64 || base64.length % 4 === 1) return null

  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  let buffer: Buffer
  try {
    buffer = Buffer.from(padded, 'base64')
  } catch {
    return null
  }
  if (buffer.length < 12) return null

  const ext = detectImageExtension(buffer) ?? hintedExt
  if (!ext) return null
  return { buffer, ext }
}

function detectImageExtension(buffer: Buffer): string | null {
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  const header = buffer.subarray(0, 6).toString('ascii')
  if (header === 'GIF87a' || header === 'GIF89a') return 'gif'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return null
}

function mimeSubtypeToExtension(subtype: string): string | null {
  const normalized = subtype.toLowerCase()
  if (normalized === 'jpeg' || normalized === 'jpg') return 'jpg'
  if (normalized === 'png') return 'png'
  if (normalized === 'gif') return 'gif'
  if (normalized === 'webp') return 'webp'
  return null
}

function mapCompletedItem(
  item: any,
  workDir: string,
  threadId?: string,
): { name: string; input: any; output: string; isError: boolean } | null {
  const started = mapStartedItem(item, workDir)
  if (!started) return null
  switch (item.type) {
    case 'commandExecution':
      return {
        ...started,
        output: item.aggregatedOutput ?? '',
        isError: item.exitCode != null && item.exitCode !== 0,
      }
    case 'fileChange':
      return { ...started, output: JSON.stringify(item.changes ?? [], null, 2), isError: item.status === 'failed' }
    case 'mcpToolCall':
      return {
        ...started,
        output: item.error ? JSON.stringify(item.error, null, 2) : JSON.stringify(item.result ?? null, null, 2),
        isError: !!item.error,
      }
    case 'dynamicToolCall':
      return {
        ...started,
        output: JSON.stringify(item.contentItems ?? [], null, 2),
        isError: item.success === false,
      }
    case 'webSearch':
      return { ...started, output: JSON.stringify(item.action ?? {}, null, 2), isError: false }
    case 'imageGeneration':
      return { ...started, output: imageGenerationOutput(item, threadId), isError: item.status === 'failed' }
  }
  return null
}

// ── 多 agent 编排 item 的展示辅助 ───────────────────────────────────

/** agentPath(如 "/root/order_schema/official_history_orders")末段作展示名;
 *  无 path 时退回 threadId 的诊断前缀。 */
function collabAgentDisplayName(agentPath: unknown, threadId: string): string {
  if (typeof agentPath === 'string' && agentPath) {
    const last = agentPath.split('/').filter(Boolean).pop()
    if (last) return last
  }
  return diagnosticIdLabel(threadId)
}

/** spawn/followup 的 prompt 文本:fork_turns=all 时是服务端 Fernet 密文
 *  (gAAAAAB…,2000 字乱码会糊满面板),归一成占位说明。 */
function collabPromptText(prompt: unknown): string | undefined {
  if (typeof prompt !== 'string' || !prompt) return undefined
  if (prompt.startsWith('gAAAA') && !/[一-鿿]/.test(prompt)) return '(继承主线程历史的密文任务书)'
  return prompt
}

/** 子 agent 过程步骤的单行简报(后台卡 steps 展示用)。 */
function subagentStepBrief(name: string, input: any, output?: string): string {
  const s = (x: unknown): string => typeof x === 'string' ? x : ''
  switch (name) {
    case 'Bash': {
      // completed 的 output 是命令输出,取首行;started 显示命令本身。
      if (output != null) {
        const c = output.replace(/\s+/g, ' ').trim()
        return c ? `→ ${c.slice(0, 60)}` : ''
      }
      // 与主卡工具面板共用 shell-command 解析,Windows PowerShell 包装 / desc
      // 注释统一剥掉,后台卡 steps 显示中文说明而非 powershell.exe 路径。
      return shellCommandDescription(s(input?.command)) || '(空命令)'
    }
    case 'FileChange': {
      const changes = Array.isArray(input?.changes) ? input.changes.length : 0
      if (output != null) {
        // completed:output 是 changes JSON —— 重复 started 的信息,显示应用状态。
        return ''
      }
      return changes > 0 ? `改 ${changes} 个文件` : '文件变更'
    }
    case 'MCP': return `${s(input?.server)}/${s(input?.tool)}`.slice(0, 60)
    case 'WebSearch': return `"${s(input?.query).slice(0, 50)}"`
    default: {
      if (output != null) {
        const c = output.replace(/\s+/g, ' ').trim()
        return c ? `→ ${c.slice(0, 60)}` : ''
      }
      return JSON.stringify(input ?? {}).replace(/\s+/g, ' ').slice(0, 60)
    }
  }
}

/** v2 wire 的 receiver 线程 id 列表(receiverThreadIds;内部 proto 的
 *  receiver_agents 在 v2 转换时被丢弃,agentPath/nickname 不下发)。 */
function collabReceiverThreadIds(item: any): string[] {
  const ids = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
  return ids.filter((id: unknown): id is string => typeof id === 'string' && !!id)
}

/** spawn 面板描述:receiver 线程数(wire 无名字,只有 id)。 */
function collabSpawnDescription(item: any): string {
  const ids = collabReceiverThreadIds(item)
  return ids.length > 0 ? `派生 ${ids.length} 个子 agent` : '派生子 agent'
}

/** spawn 面板完成态输出:agentsStates 的可读摘要(每 agent 一行「线程:状态」),
 *  替代旧的 agentsStates JSON dump。真名由后台卡(subAgentActivity agentPath)
 *  承载,这里只有线程 id 的诊断前缀。 */
function collabSpawnResult(item: any): string {
  const states = item.agentsStates
  if (!states || typeof states !== 'object') return ''
  const lines: string[] = []
  for (const [threadId, state] of Object.entries(states)) {
    const s = state as any
    const status = typeof s?.status === 'string' ? s.status : 'unknown'
    lines.push(`${diagnosticIdLabel(threadId)}: ${status}`)
  }
  return lines.join('\n')
}
