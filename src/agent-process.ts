import type { EventEmitter } from 'node:events'
import type {
  CanUseToolRequest,
  CodexModel,
  CodexReasoningEffort,
  CodexResultMeta,
  CodexUsage,
  ContextCompactedNotification,
  HookCallbackRequest,
  PlanDelta,
  ThreadGoal,
  TokenUsageUpdated,
  TurnPlanUpdated,
} from './codex-process'
// type-only:claude-agent-process 运行时也 import 本模块(CLAUDE_EFFORT 等),
// 双向仅类型引用,无运行时环。
import type {
  BgTaskStartedEvent,
  BgTaskProgressEvent,
  BgTaskUpdatedEvent,
  BgTaskSettledEvent,
} from './claude-agent-process'

export const AGENT_PROVIDERS = ['codex', 'claude', 'dsh'] as const
export type AgentProvider = typeof AGENT_PROVIDERS[number]
export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(value)
}
export type DshReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export function isDshReasoningEffort(value: unknown): value is DshReasoningEffort {
  return typeof value === 'string' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)
}
/** default 表示模型没有 effort 选择器，SDK 不发送 effort 参数。 */
export type ClaudeReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'default'
export type AgentReasoningEffort = CodexReasoningEffort | ClaudeReasoningEffort | DshReasoningEffort

/** A Codex capacity failure keeps the logical task open while retrying. */
export interface AgentTurnRetry {
  phase: 'waiting' | 'retrying'
  attempt: number
  delayMs: number
  message: string
}

export const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'default'] as const
export const CLAUDE_EFFORT: ClaudeReasoningEffort = 'max'

export function isClaudeReasoningEffort(value: unknown): value is ClaudeReasoningEffort {
  return typeof value === 'string' && CLAUDE_REASONING_EFFORTS.includes(value as ClaudeReasoningEffort)
}

export function providerFromModel(model: string | null | undefined): AgentProvider {
  if (model?.startsWith('dsh:')) return 'dsh'
  return model?.startsWith('claude:') ? 'claude' : 'codex'
}

export function agentProviderLabel(provider: AgentProvider): string {
  return { claude: 'Claude', codex: 'Codex', dsh: 'DeepSeek Harness' }[provider]
}

/** 主动 compact 时上下文不足、后端未触发压缩。这不是错误 —— 是"无需压缩"的正常
 *  情况,调用方(runCompactCommand)应显示 ⓘ 提示而非 ❌ 失败。claude 路由 /compact
 *  在 transcript 不足时返回 "Not enough messages to compact." 且不 emit compact_boundary,
 *  compactThread 据此抛出;codex 目前不发此错误。 */
export class NothingToCompactError extends Error {
  constructor(message = '上下文窗口充足，无需压缩') {
    super(message)
    this.name = 'NothingToCompactError'
  }
}

export interface AgentProcess extends EventEmitter {
  readonly provider: AgentProvider
  /** 该进程 spawn 时绑定的 token source id(= spawnEnv 注入 env 的那个 source)。
   *  GLM/DeepSeek/native 同为 provider='claude' 但 env(base_url/凭据)不同;
   *  stopIdleMismatchedProcess 据此判定跨 source 切换要杀进程换 env(同 provider 也要杀)。
   *  null = 无 source(透传型 native 在 spawn 时仍带 'claude-native' id;null 仅用于无 ts 的裸跑)。 */
  readonly tokenSourceId: string | null
  sessionId: string | null
  lastAssistantUuid: string | null
  /** Canonical completed turn id when the backend exposes turn-granular forks (Codex). */
  lastCompletedTurnId?: string | null
  lastModel: string | null
  lastEffort: AgentReasoningEffort | null
  /** 当前思考块的实时估计，不能用于计费或累计 token。 */
  lastThinkingTokens?: number | null
  lastUsage: CodexUsage | null
  lastTotalUsage: CodexUsage | null
  lastResult: CodexResultMeta
  lastContextWindow: number | null
  /** Claude 路径的当前上下文占用 = 输入侧 token(input + cache_read +
   * cache_creation,不含 output),直接取自 SDK modelUsage。Codex 路径不用,
   * 恒 null(继续走 lastUsage.total_tokens)。 */
  lastContextTokens: number | null
  /** Codex-only transient status; absent for other backends. */
  turnRetry?: AgentTurnRetry | null

  /** Start backend initialization. */
  sendInitialize(): void
  /** Codex exposes the exact readiness transaction so Session can surface
   * method-specific RPC failures before teardown. Claude stream init is
   * deferred until first input and therefore does not implement this hook. */
  initializationPromise?(): Promise<void>
  /** Codex launch/persistence metadata. Claude does not use these hooks. */
  readonly launchKind?: 'fresh' | 'resume' | 'fork'
  isConversationResumable?(): boolean
  conversationMaterializationBarrier?(): Promise<void> | null
  conversationMaterializationFailure?(): Error | null
  sendUserText(text: string, files?: string[]): void
  sendInterrupt(): void
  sendPermissionResponse(
    requestId: string | number,
    decision: 'allow' | 'deny',
    payload?: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown; denyMessage?: string },
  ): void
  sendHookResponse(requestId: string, output?: object): void
  isAlive(): boolean
  /** Resolve only after the backend's real lifecycle has ended. Reject when
   *  TERM/KILL (Codex) or SDK close/abort (Claude) cannot confirm exit. */
  kill(timeoutMs?: number): Promise<void>

  listModels(): Promise<AgentModel[]>
  setModelSettings(model: string, effort: AgentReasoningEffort): Promise<void>
  compactThread(): Promise<void>
  /** codex:在现有 app-server 连接上读账号额度(read 端点,权威多桶);
   *  claude:无此通道,返回 null(session 的额度走 token source)。 */
  readRateLimits?(): Promise<any>
}

export interface AgentModel extends Omit<CodexModel, 'supportedReasoningEfforts' | 'defaultReasoningEffort'> {
  supportedReasoningEfforts: Array<{ reasoningEffort: AgentReasoningEffort; description: string }>
  defaultReasoningEffort: AgentReasoningEffort | null
}

export type AgentProcessEventMap = {
  error: Error
  init: any
  /** The backend has durably materialized this conversation. For fresh Codex
   * threads this is later than thread/start + init. */
  conversation_materialized: { session_id: string; source: string }
  conversation_materialization_failed: {
    session_id: string
    path: string | null
    source: string
    error: Error
  }
  turn_started: { turn_id?: string | null; thread_id?: string | null; retry?: boolean }
  turn_retry: AgentTurnRetry
  token_usage: TokenUsageUpdated
  turn_plan_updated: TurnPlanUpdated
  plan_delta: PlanDelta
  context_compacted: ContextCompactedNotification
  rate_limits_updated: any
  thread_goal_updated: ThreadGoal
  thread_goal_cleared: any
  /** A backend dequeued autonomous work (Claude Cron or a DSH continuation). Unlike a daemon user
   * write, this has no pending input claim, so Session must open its own card. */
  scheduled_turn_input: { text: string; promptId: string | null }
  /** parentToolUseId 非空 = 子 agent 的正文块。它必须与子 agent 工具事件
   *  一样保留归属，Session 不得把它追加到主 Agent 对话卡。 */
  assistant_text: { uuid?: string; text: string; parentToolUseId: string | null }
  assistant_block_stop: { index?: string; parentToolUseId: string | null }
  /** parentToolUseId 非空 = 子 agent 内的调用,session 只累积进后台 task steps,
   *  不上主卡(与 codex isSubagentThread 分流同构)。 */
  tool_use: { id: string; name: string; input: any; parentToolUseId: string | null }
  tool_result: { tool_use_id: string; content: any; is_error: boolean; parentToolUseId: string | null }
  can_use_tool: CanUseToolRequest
  hook_callback: HookCallbackRequest
  /** 后台任务/子 agent 生命周期(claude: SDK task_* 消息族;codex: collab 状态机
   *  翻译)。session 据此维护双池(active/pending)驱动后台游标卡。 */
  bg_task_started: BgTaskStartedEvent
  bg_task_progress: BgTaskProgressEvent
  bg_task_updated: BgTaskUpdatedEvent
  bg_task_settled: BgTaskSettledEvent
  /** 子 agent 过程步骤(codex: 子线程 item 按 thread_id 归属;claude 走
   *  tool_use/tool_result 的 parentToolUseId 路径,不发此事件)。 */
  subagent_step: { thread_id: string; item_id: string; tool: string; phase: 'started' | 'completed'; brief: string }
  result: any
  exit: { code: number | null; signal: string | null; expected: boolean }
}
