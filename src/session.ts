import { isAgentSession } from './agent-session-registry'
import { queryDshRuntime } from './dsh-runtime'
import { isDshReasoningEffort } from './agent-process'
/**
 * Session — 1 Feishu chat ↔ 1 Codex app-server process ↔ 1 streaming card.
 *
 * Owns the CodexProcess lifecycle, the per-turn card state machine, and
 * the in-flight permission map.  Wires Codex app-server events into Card
 * Kit ops, and wires Feishu inbound (text + card-action callbacks) into
 * Codex turns.
 *
 * Tool tracking, AskUserQuestion flow, permission rendering, command
 * routing and model/task/wt/compact panels live in sibling
 * session-*.ts modules. Fields touched by those helpers carry no
 * `private` modifier — convention is "no modifier = package-internal,
 * only the session-*.ts helpers should touch it."
 */

import { existsSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  CODEX_EFFORT,
  CodexRpcResponseError,
  CodexProcess,
  diffUsageTotals,
  effectiveTurnTokens,
  isCodexReasoningEffort,
  type CanUseToolRequest,
  type CodexReasoningEffort,
  type CodexUsage,
  type ContextCompactedNotification,
  type HookCallbackRequest,
  type PlanDelta,
  type TokenUsageUpdated,
  type ThreadGoal,
  type TurnPlanUpdated,
} from './codex-process'
import {
  liveElapsed,
  type LiveElapsedMode,
} from './cards/background'
import {
  CLAUDE_EFFORT,
  agentProviderLabel,
  isClaudeReasoningEffort,
  type AgentProcess,
  type AgentProcessEventMap,
  type AgentProvider,
  type AgentReasoningEffort,
  type ClaudeReasoningEffort,
} from './agent-process'
import { config } from './config'
import { createAgentProcess } from './agent-launch'
import { agentApiUrl } from './agent-runtime'
import { createAgentCards } from './agent-cards-runtime'
import type { AgentCards } from './agent-cards'
import { getTokenSource, getTokenSourceForAccount, listEnabledTokenSourcesByAgent, waitForTokenSourceModelRefresh, tokenSourceProcessRevision, tokenSourceRuntimeModel, type TokenSource } from './token-source'
import { codexAccounts, DEFAULT_CODEX_ACCOUNT, processCodexAccount } from './codex-accounts'
import { codexAccountCard } from './cards/codex-account'
import {
  claudeTranscriptPath,
  type BgTaskStartedEvent,
  type BgTaskProgressEvent,
  type BgTaskUpdatedEvent,
  type BgTaskSettledEvent,
} from './claude-agent-process'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'
import { MANAGED_CLAUDE_PLUGIN_DIR } from './paths'
import { readSysInfo } from './sysinfo'
import { readUsage, refreshUsageFromConnection, observeRateLimitsNotification, captureCodexUsageCache, type UsageSnapshot } from './usage'
import { readGlmUsage, type GlmUsageSnapshot } from './glm-usage'
import { claudeWeeklyUsageWindow } from './claude-usage'
import {
  contextLimitFromAppServer,
  contextTokensFromUsage,
} from './context-window'
import { extractSendMarkerPaths, normalizeOutboundPath } from './outbound-markers'
import * as sessionMultimsg from './session-multimsg'
import * as mathRender from './math-render'
import type { TurnState, Status, SessionOpts, LastTurnDelta, CumStats } from './session-types'
import * as sessionTools from './session-tools'
import * as sessionAsk from './session-ask'
import * as sessionPermission from './session-permission'
import {
  diagnosticIdLabel,
  messageOf,
  type FooterTimer,
  type LifecycleProgressOpts,
  type ModelActionResult,
  type StatusCardHandle,
  type TasklistActionResult,
  type WorktreeActionResult,
} from './session-util'
import * as sessionCommands from './session-commands'
import * as sessionCompact from './session-compact'
import * as sessionModel from './session-model'
import * as sessionAgentIdentities from './session-agent-identities'
import * as sessionTasklist from './session-tasklist'
import { createFileDelivery, groupFileDelivery } from './file-delivery-runtime'
import type { FileDeliveryHandle, FileDeliveryMode } from './file-delivery-types'
import { runFileDeliveryCommand } from './file-delivery-command'
import { fileDeliveryAgentContext } from './instructions'
import * as sessionWorktree from './session-worktree'
import * as sessionTemp from './session-temp'
import {
  validateConversationLaunch,
  type ConversationBranchBase,
  type ConversationCheckpoint,
  type ConversationLaunch,
  type ConversationRef,
  type ConversationRouting,
  type ConversationSummary,
  type PendingConversationLaunch,
} from './conversation'

export type { SessionOpts } from './session-types'

function findCodexRpcResponseError(
  error: unknown,
  seen = new Set<unknown>(),
): CodexRpcResponseError | null {
  if (error instanceof CodexRpcResponseError) return error
  if (!error || (typeof error !== 'object' && typeof error !== 'function') || seen.has(error)) return null
  seen.add(error)
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findCodexRpcResponseError(nested, seen)
      if (found) return found
    }
  }
  if (error instanceof Error && error.cause !== undefined) {
    return findCodexRpcResponseError(error.cause, seen)
  }
  return null
}

function compactionKey(notice: ContextCompactedNotification): string {
  return notice.itemId || notice.turnId || '__latest__'
}

function compactionReceiptKeys(notice: ContextCompactedNotification): string[] {
  const keys: string[] = []
  if (notice.itemId) keys.push(`item:${notice.itemId}`)
  if (notice.turnId) {
    keys.push(`turn:${notice.threadId ?? notice.sessionId ?? '-'}:${notice.turnId}`)
  }
  return keys
}

function latestPendingCompactionKey(turn: TurnState): string | null {
  let key: string | null = null
  for (const k of turn.contextCompactionPending.keys()) key = k
  return key
}

function mergeCompactionNotices(
  start: ContextCompactedNotification | undefined,
  end: ContextCompactedNotification,
): ContextCompactedNotification {
  if (!start) return end
  return { ...start, ...end, phase: 'end' }
}

const FOOTER_THINKING_PREFIX = 'Thinking...'
const FOOTER_WRITING = 'Writing...'
const FOOTER_WORKING = 'Working...'
/** Final transaction guard: two 30s control RPCs plus a materialization read
 * of up to 10 minutes. Leave a minute for local lifecycle work so the exact
 * method timeout can surface before this outer guard. */
const CODEX_INIT_NOTICE_MS = 10_000
const CODEX_INIT_TIMEOUT_MS = 12 * 60_000
/** 提前换卡，为在途写入和复杂嵌套元素留出余量。
 * Feishu 的容量按卡片结构计数；实际 300305 容量错误另触发换卡。 */
const CARD_ELEMENT_SOFT_LIMIT = 50

const MAX_CONTEXT_COMPACTION_RECEIPTS = 256
const ANONYMOUS_COMPACTION_DEDUPE_MS = 10_000
/** Claude Agent SDK does not emit stream `init` until the first user input.
 * Still give synchronous/early startup failures a chance to surface before
 * presenting the session as ready. */
const CLAUDE_STARTUP_GRACE_MS = 250

interface TurnOpenOwner {
  token: number
  proc: AgentProcess | null
  procEpoch: number
  sawResult: boolean
  terminalSuffix?: string
  terminalForcePush: boolean
  pendingCompactions: ContextCompactedNotification[]
  /** True only when this card open was triggered by an SDK init for a turn
   * that is already running. Eager user/drain opens happen before input is
   * sent, so compaction events in that window belong to an older turn. */
  backendTurnStarted: boolean
  /** Resolves exactly once when this owner is released or invalidated. Same-
   * process follow-up opens await it instead of replacing openingTurnOwner. */
  done: Promise<void>
  resolveDone: () => void
}

interface TurnCloseSnapshot {
  turn: TurnState
  proc: AgentProcess | null
  procEpoch: number
  contextTokens: number | null
  contextLimit: number | null
  lastTurnDelta: LastTurnDelta | null
  lastTurnUsage: CodexUsage | null
  tokenSourceId: string | null
  tokenSource: TokenSource | undefined
  codexUsage: ReturnType<typeof captureCodexUsageCache> | null
  currentBatchReactionIds: Map<string, string>
  pendingReactionIds: Map<string, string>
}

/** 读取 `[runtime].live_elapsed`;缺 runtime 时回退 bucket(测试 mock 常只 stub claude)。 */
function liveElapsedMode(): LiveElapsedMode {
  return config.runtime?.live_elapsed ?? 'bucket'
}

/** footer 状态文案:状态词 + 耗时标签。
 *  bucket 模式:相对档位(<30s / <1m / …),只在边界 push;
 *  second 模式:按时长选择单位,前 10m 每 1s push,之后按 5m 档位。
 *  见 startFooterTimer / startFooterStatus。*/
function timedStatus(status: string, startedAt: number): string {
  return `${status} (${liveElapsed(Date.now() - startedAt, liveElapsedMode()).label})`
}

export class Session {
  /** Process-wide registry of every Session ever constructed in this daemon.
   * Used by the `hi` console panel to enumerate sibling sessions across
   * Feishu groups. Sessions are never removed (matches the daemon's
   * `sessions` map lifecycle — one Session per chat for the daemon's
   * lifetime). Callers should filter on `isRunning()` when they only
   * want currently-alive Codex processes. */
  static readonly all: Set<Session> = new Set()

  // ── package-internal state (touched by session-*.ts helpers) ──
  proc: AgentProcess | null = null
  /** Lifecycle operations that can replace `proc` are serialized per Session.
   * The daemon deliberately dispatches Feishu messages concurrently so two
   * `restart` commands can overlap; without this gate both callers can observe
   * `proc === null` while the first kill is pending and each spawn a process. */
  private lifecycleTail: Promise<void> = Promise.resolve()
  private lifecycleSequence = 0
  /** Generation of the process currently owned by this Session. Event
   * listeners capture it at wire time so a late event from a killed/replaced
   * process cannot mutate the new process' turn, queue, usage, or cards. */
  private procEpoch = 0
  /** Process currently being stopped by a serialized lifecycle operation.
   * While set, every event except `exit` is ignored. */
  private stoppingProc: AgentProcess | null = null
  /** A stop/kill timed out while this process still reports alive. Keep the
   * handle attached and block all new input/spawns until a real exit arrives
   * or a later explicit stop/restart successfully confirms termination. */
  private blockedProc: AgentProcess | null = null
  private blockedProcReason: string | null = null
  private agentCapability: string | null = null
  /** Spawn-affecting token-source revision captured for each owned process.
   * Same source id with rotated credentials/base URL must still replace the
   * idle child after the registry is rebuilt. Weak keys avoid lifecycle leaks. */
  private readonly procSourceRevisions = new WeakMap<AgentProcess, string | null>()
  /** Delivery rules actually given to each process, including later group changes. */
  private readonly procFileDeliveryModes = new WeakMap<AgentProcess, FileDeliveryMode>()
  currentTurn: TurnState | null = null
  /** Item-scoped compaction ownership survives a turn-card close so a late
   * completion cannot attach itself to the next turn. Completed receipts keep
   * no TurnState reference and are bounded as duplicate tombstones. */
  private contextCompactionReceipts = new Map<string, {
    ownerId: number | null
    completed: boolean
    completedAt: number
    completionKey?: string
    hasItemAlias: boolean
  }>()
  private contextCompactionOwnerIds = new WeakMap<TurnState, number>()
  private contextCompactionOwnerSequence = 0
  private lastManualContextCompactionCompletedAt = 0
  private lastManualContextCompactionWasAnonymous = false
  /** Native children are visible immediately; foreground shell tasks stay pending. */
  backgroundTasks: cards.BgTaskEntry[] = []
  pendingBgTasks: cards.BgTaskEntry[] = []
  private readonly agentCards: AgentCards
  private backgroundOwner = randomBytes(16).toString('hex')
  private backgroundRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private backgroundSync: Promise<void> | null = null
  private backgroundWriteError: string | null = null
  private lastMainTaskToolUseId: string | null = null
  private nativeAgentTools = new Map<string, { confirmed: boolean; input: any }>()
  /** turn 收尾后有后台任务结算 → SDK 会自发开一轮恢复轮(task_notification
   *  合并结果),该轮 init 没有伴随用户消息。置位后,下一个无用户批次的 init
   *  据此开 bg_task_resume 卡承接输出;任何 turn 开卡即消费(结算通知会被
   *  并入那一轮),避免陈旧标记把无关的空 init 误判成恢复轮。 */
  private bgResumePending = false
  /** 无 currentTurn 时到达的 assistant 正文(恢复轮开卡前的窗口期 / 开卡
   *  失败)。openTurnCard 落地时并入新卡;result/exit 时纯文本兜底推送。
   *  决不静默丢弃(2026-07-04 etmmo 终报告事故:恢复轮 6.6KB 合并终报告
   *  整轮无卡,appendAssistant 首行 return 全部丢光,飞书无痕)。
   *  只在"合法无卡窗口"缓冲(openingTurn 正在开卡 / bgResumeCardless 恢复轮
   *  开卡失败续窗);其余无卡场景(被打断的轮尾、kill 窗口残字)一律丢弃,
   *  否则会被错误推送或并入下一张不相干的卡。 */
  private orphanAssistantSegments: string[] = []
  private orphanAssistantCurrent = ''
  /** 恢复轮 openTurnCard 失败后置位:该轮此后再无卡,正文继续进孤儿缓冲直到
   *  result 纯文本兜底。区别于 openingTurn(仅开卡 await 窗口)。 */
  private bgResumeCardless = false
  pendingPermissions = new Map<string, { toolUseId: string; permissionSuggestions?: unknown }>()
  /** Open AskUserQuestion tool calls — keyed by tool_use_id. Codex and
   * Claude both route AskUserQuestion through the can_use_tool flow;
   * we have to thread the permission `requestId` through here so the
   * answer (option click OR custom text submit) can resolve the
   * permission with `updatedInput.answers` populated.
   * `deferredAnswer` covers the race where the user clicks/submits
   * BEFORE can_use_tool arrives (addTool fires on the assistant
   * message; can_use_tool is a separate control_request that lands
   * slightly later). */
  pendingAsks = new Map<string, {
    questions: cards.AskQuestion[]
    i: number
    requestId?: string
    /** 累计答案 — key 是 question 原文 (SDK 把这条 record 格式
     * 化进 tool_result), value 是用户选的 option label 或自定
     * 义文字。全部 question 都答完时一并塞进 updatedInput.answers
     * 发回 SDK。 */
    answers: Record<string, string>
    /** 已答详情 (按 question idx 索引)，用来给历史面板和 terminal
     * 状态画选中态。answers 同步累计，但这里多保留 customText /
     * optionIdx 字段以便 UI 区分两种回答路径。 */
    answered: Map<number, cards.AskAnswered>
    /** 当前展示的 question idx。undefined 表示全部答完 (terminal)
     * —— 这时若 requestId 已就位则 finalize；否则等 renderPermission
     * 一来立即 finalize。 */
    currentIdx?: number
    /** Send a phone notification only when this ask becomes answerable. */
    announced?: boolean
    announcementVersion?: number
  }>()
  /** Thread-scoped goal reported by Codex app-server. Pure progress
   * accounting updates refresh this snapshot without adding card elements;
   * only objective/status/budget changes are rendered. */
  currentGoal: cards.ThreadGoal | null = null
  status: Status = 'stopped'

  // ── strictly private state ──
  /** Number of daemon writes handed to the backend but not yet claimed by an
   * authoritative backend turn boundary (`init`/`turn_started`). Mid-turn
   * user messages stay in `pendingMidTurnMsgs` and are joined into exactly one
   * `sendUserText`, so production keeps this at 0 or 1. A boundary belonging
   * to an already eager-opened card must still consume the claim before the
   * currentTurn/openingTurn guard returns; otherwise the next Claude
   * task-notification init is misclassified as a user batch and opens an empty
   * `trigger=user_message inputs=0` card. */
  pendingUserMessageCount = 0
  /** Mid-turn user messages buffered DAEMON-SIDE (not yet sendUserText'd
   * to the SDK). Drained in the `result` handler by writing each to SDK
   * stdin, which doubles as the wake signal the Codex app-server needs
   * to start the next batch turn (it won't auto-dequeue queued
   * type-ahead msgs after `result` — confirmed in dogfood testing).
   * Buffering also keeps mid-turn msgs out
   * of any AskUserQuestion `QUEUE remove` storm, since they were never
   * in the SDK queue to begin with. */
  pendingMidTurnMsgs: Array<{ text: string; wireText: string; userOpenId: string; msgId: string }> = []
  /** 下一个 turn 的 user inputs 暂存区。所有 sendUserText 的 wireText 在
   * sendUserText 之前 push 这里;openTurnCard 创建 turn 时一次性取走 + clear。
   * mainConversationCard 把这些 wireText 渲染成顶部"📥 收到 (N)"折叠面板,
   * 让用户在卡片自己里就能看到这一轮触发了什么(不必滚群里找原消息)。
   * mid-turn buffer 的消息不在这里 push —— 它们走 drainMidTurnAndOpen 那条
   * 路径,drain 时统一 push。 */
  pendingTurnInputs: string[] = []
  /** 用户用 `>>>`(≥3 个 >)主动开启的多条消息缓冲。null = 当前不在多条
   *  收集模式;非 null = 正在累积,直到 `<<<`(≥3 个 <)收尾合并成一条
   *  onUserMessage。跟 pendingMidTurnMsgs 不同:后者是 turn 进行中被动到达
   *  的排队,这个是用户显式分段。状态机在 session-multimsg.ts,永不超时。*/
  multiMsgBuffer: sessionMultimsg.MultiMsgSegment[] | null = null
  /** multiMsgBuffer 里每条消息上挂的 📌 reaction_id('' = addReaction 还在
   *  飞)。flush 时释放 📌,clear 时换成 ❌。*/
  multiMsgReactions = new Map<string, string>()
  /** Most recent userOpenId seen via `onUserMessage`. Used only when a
   * merged batch fires its init event and the daemon needs *some* open_id
   * to scope the eventual `urgent_app` push — there's no obviously right
   * answer when N messages from possibly different users collapse into
   * one turn, and "the most recent sender" is a defensible default for
   * the single-user private-bot scenario this product targets. */
  lastUserOpenId = ''
  /** Feishu message_ids of user messages that arrived while the daemon
   * was busy (turn in flight or mid-open), mapped to the `reaction_id`
   * of the `OneSecond` reaction placed at arrival. The reaction_id is
   * what `deleteReaction` needs to *remove* the OneSecond once the
   * message has been absorbed by the SDK (either system-reminder
   * injection mid-turn or a merged-batch dequeue on next turn).
   * User feedback (2026-05-15): replacing OneSecond with a second
   * CheckMark stacked two emojis on the same row; cleaner UX is
   * "queued → released" via removal, not "queued → done" via
   * stacking. */
  pendingReactionIds = new Map<string, string>()
  /** Snapshot of `pendingReactionIds` taken when the init handler
   * claims a merged batch — these are the Feishu messages whose
   * OneSecond reactions are the currently-open turn's responsibility
   * to clear (via deleteReaction). Empty for eager-opened solo turns. */
  currentBatchReactionIds = new Map<string, string>()
  /** Count of `system/init` events seen this subprocess. The first one is
   * the boot init (claimed by whichever user message lands first); later
   * ones can mark the start of SDK-driven queued user message draining.
   * Reset on stop/restart/exit
   * since `init` re-fires after every spawn. */
  private initCount = 0
  /** Sync guard set before any `await` in the eager-open path of
   * `onUserMessage`, cleared after `currentTurn` is set. Closes the race
   * where an SDK-emitted `init` event lands during the eager open's
   * Feishu API await — without this, the init handler would observe
   * `currentTurn === null && queue empty` (we've already shifted) and
   * incorrectly open a second card for the same user message. The flag
   * tells the init handler "an eager open is already
   * claiming the slot, stand down". */
  openingTurn = false
  private openingTurnOwner: TurnOpenOwner | null = null
  private turnOpenSequence = 0
  /** Every captured close remains registered until its terminal CardKit
   * transaction finishes. Lifecycle replacement waits this set even after
   * closeTurnCard has synchronously removed the old turn from currentTurn. */
  private turnCloseInflight = new Set<Promise<void>>()
  private fileDeliveries = new Set<FileDeliveryHandle>()
  private turnCounter = 0
  /** One-shot: user invoked `stop` during the current turn. Set right
   * before `sendInterrupt`; consumed by the next `result` handler so it
   * does not overwrite the 🛑 footer already painted by the stop path.
   * Reset by exit handler for the proc-died-before-result case. */
  userInterrupted = false
  // Last known resumable thread id. Persisted once a turn starts, so
  // `restart` can resume an in-flight conversation even if the daemon
  // exits before the turn finishes.
  lastSessionId: string | null = null
  private lastSessionRef: ConversationRef | null = null
  selectedProvider: AgentProvider = 'claude'
  selectedModel: string | null = null
  selectedEffort: AgentReasoningEffort | null = null
  /** 当前 token source id(账号)。token source 决定 agent + 凭据 + 模型 + 额度查询。
   *  null = 未配 token source,走旧路径(provider/model 自治)。 */
  selectedTokenSourceId: string | null = null
  modelPanels = new Map<string, sessionModel.ModelPanelState>()
  modelSettingsChange: sessionModel.ModelSettingsChange | null = null
  modelSettingsChangesClosed = false
  /** 补录应答态:点「➕ 补录模型」后置位,下一条群消息(裸词命令除外)作为
   *  模型名消费(校验/补录)。一次性,消费或取消即清。cardMessageId 是补录
   *  提示卡的消息 id —— 消费后原位更新它(通过→effort 卡;失败→红字),
   *  不单发群消息(和正常消息流混淆会产生"下条是否还是模型名"的歧义)。 */
  modelCustomPrompt: { sourceId: string, panelId: string, cardMessageId: string } | null = null
  private startedAt: number = 0
  private cumStats: CumStats = { tokens: 0, costUsd: 0, turns: 0 }
  private lastTurnDelta: LastTurnDelta | null = null
  private currentTurnUsageBaseline: CodexUsage | null = null
  private currentTurnUsageBaselineKnown = false
  private lastTurnUsage: CodexUsage | null = null
  /** Resume path can restore a historical thread without replaying its
   * absolute token totals into the new subprocess. Until we observe one
   * fresh absolute total snapshot, the next turn's baseline is unknown
   * and must not be guessed as zero. */
  private usageTotalsSeedUnknown = false
  private resumePersistenceError: string | null = null
  /** A failed daemon recovery must not turn the next queued message into a
   * fresh conversation. Retain this intent until an explicit lifecycle action
   * or a successful recovery resolves it. */
  private daemonRestoreRequired = false
  /** Set while the `compact` command owns a status card for a standalone
   * compaction. Suppresses the generic no-turn compaction text alert;
   * command feedback is rendered on that status card instead. */
  manualContextCompactionPending = false
  /** Claude Code Task 工具(TaskCreate/Update/List/Get)的累积任务板。codex
   * 的 TodoWrite 一次就带完整列表,直接渲染即可;但 Claude Code 把它拆成 4
   * 个单点工具,只有 TaskList 才有完整快照。这里跨 turn / rotate 累积一份
   * 以 task id 为 key 的 board(官方 todo-tracking 文档推荐的做法),每次 Task
   * 工具完成时由 session-tools.ts 调 applyTaskTool 更新,渲染整个 board 而非
   * 孤立的单条 —— 见 cards/task-board.ts。 */
  taskBoard: cards.TaskBoardEntry[] = []

  constructor(
    public readonly sessionName: string,
    public readonly chatId: string,
    public opts: SessionOpts = {},
  ) {
    this.agentCards = opts.agentCards ?? createAgentCards()
    Session.all.add(this)
    const selection = feishu.getSessionModelSelection(sessionName)
    this.selectedProvider = selection?.provider ?? 'claude'
    this.selectedModel = selection?.model ?? null
    this.selectedEffort = selection?.effort ?? null
    // 推导 tokenSourceId(账号):优先持久化值,否则从 provider/model 映射 registry 的 source。
    // 推导到 token source 后,以 ts.agent 校正 selectedProvider(token source 决定 agent)。
    this.selectedTokenSourceId = this.deriveTokenSourceId(selection)
    const derivedTs = getTokenSource(this.selectedTokenSourceId)
    if (derivedTs) {
      this.selectedProvider = derivedTs.agent
      // 仅迁移旧版固定 profile 键。新版 token source 持久化真实模型 slug，
      // 不能再把 GLM-5.2 归一成 claude:glm，否则重启会把错误模型名交给 SDK。
      if (derivedTs.id === 'glm' && this.selectedModel === 'claude:glm') {
        this.selectedModel = derivedTs.defaultModel
        this.selectedEffort = 'max'
      }
    }
    if (this.selectedModel) {
      log(`session "${sessionName}": restored selected provider=${this.selectedProvider} model=${this.selectedModel} effort=${this.selectedEffort ?? 'unset'}`)
    }
    // Restore last-known thread/session id for the selected backend from
    // disk so a daemon restart (systemctl, crash, watchdog) doesn't
    // strand the user with a fresh conversation when they next type
    // `restart`.
    this.lastSessionRef = feishu.getSessionResumeRef(sessionName, this.selectedProvider)
    this.lastSessionId = this.lastSessionRef?.sessionId ?? null
    if (this.lastSessionId) {
      log(`session "${sessionName}": restored ${this.selectedProvider} lastSessionId=${this.lastSessionId}`)
    }
    const pendingLaunch = feishu.getPendingConversationLaunch(sessionName)
    if (pendingLaunch) {
      if (this.selectedProvider !== 'claude') {
        feishu.replaceTurnAnchors(sessionName, [], null, null)
        log(`session "${sessionName}": cleared pending Claude fork after provider changed`)
      } else {
        validateConversationLaunch(pendingLaunch.launch, 'claude', this.workDir)
        const stillPending = this.lastSessionId === pendingLaunch.previousSessionId
        const materializedRef = this.lastSessionRef
        const materialized = !stillPending
          && materializedRef?.provider === 'claude'
          && materializedRef.cwd === this.workDir
          && materializedRef.sessionId !== pendingLaunch.launch.source.sessionId
          && materializedRef.sessionId !== pendingLaunch.previousSessionId
        if (!stillPending && !materialized) {
          throw new Error(`pending Claude fork has inconsistent resume binding for session "${sessionName}"`)
        }
        this.pendingConversationMaterialization = pendingLaunch
        log(`session "${sessionName}": restored ${materialized ? 'materialized' : 'pending'} Claude fork source=${pendingLaunch.launch.source.sessionId}`)
      }
    }
  }

  /** Minimal cross-chat snapshot for the `hi` peer-list section.
   * `startedAt` stays private so this is the documented read path. */
  peerSnapshot(): { name: string; status: Status; uptimeMs?: number; codexAccountName?: string } {
    return {
      name: this.sessionName,
      status: this.status,
      uptimeMs: this.startedAt ? (Date.now() - this.startedAt) : undefined,
      ...(this.proc?.isAlive() && this.proc.provider === 'codex'
        && this.proc.codexAccountSelectionMode?.() !== null
        && !(this.proc.turnRetry?.reason === 'quota' && this.proc.turnRetry.phase === 'waiting')
        ? { codexAccountName: codexAccounts.get(processCodexAccount(this.proc)).name } : {}),
    }
  }

  get workDir(): string {
    // 临时群先剥 * 后缀，再按普通/工作树群名解析；因此从 worktree 发起
    // `btw`/`fk` 仍落在原 worktree，而不是悄悄回主项目目录。
    return sessionWorktree.worktreeSessionDir(this)
  }
  isRunning(): boolean { return !!this.proc && this.proc.isAlive() }
  /** Running sessions normally revive after daemon restart. A process kept
   * only because the user's explicit stop could not yet be confirmed must not
   * undo that stop intent on the next boot. */
  shouldRevive(): boolean {
    return this.daemonRestoreRequired || (this.isRunning()
      && this.stoppingProc !== this.proc
      && this.blockedProc !== this.proc)
  }
  /** 从持久化 selection 推导 tokenSourceId;无匹配返回 default 或 null(走旧路径)。 */
  private deriveTokenSourceId(selection: { tokenSourceId?: string | null; provider?: string; model?: string | null } | null): string | null {
    const explicit = selection?.tokenSourceId
    // An explicit persisted account is part of the user's routing choice.
    // Preserve it even when temporarily disabled/missing so start() can expose
    // the concrete failure instead of silently billing/sending data through a
    // different account of the same provider.
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
    const provider: AgentProvider = (selection?.provider as AgentProvider) ?? this.selectedProvider
    // 只认 enabled source:disabled 的不参与 spawn,避免未配置凭据注入子进程把 claude 搞挂。
    // claude 侧 native 与 GLM 严格互斥,恒有一个 enabled;codex 侧 codex-sub 未登录时为空(走 ~/.codex)。
    const list = listEnabledTokenSourcesByAgent(provider)
    // provider 侧无 enabled source → 返回 null(走旧路径:claude 透传 / codex 走 ~/.codex),
    // 不跨界 fallback 到别的 provider 的 default —— 否则 codex-sub 未登录会把 provider 误切成 claude。
    return list[0]?.id ?? null
  }

  /** 当前 token source(账号);未配返回 undefined → 调用方走旧路径 fallback。 */
  currentTokenSource(): TokenSource | undefined {
    return this.tokenSource(this.selectedTokenSourceId)
  }

  /** Pending account selection takes effect only after the old process exits. */
  private codexStartAccountOverride: string | undefined

  codexAccountId(): string {
    return this.proc?.isAlive() && this.proc.provider === 'codex'
      ? processCodexAccount(this.proc) : this.codexStartAccountOverride ?? codexAccounts.selected(this.sessionName)
  }

  tokenSource(id: string | null | undefined): TokenSource | undefined {
    const source = getTokenSource(id)
    return source?.forAccount ? getTokenSourceForAccount(id, this.codexAccountId()) : source
  }

  currentProvider(): AgentProvider { return this.selectedProvider }

  conversationRouting(): ConversationRouting {
    return {
      provider: this.selectedProvider,
      tokenSourceId: this.selectedTokenSourceId,
      model: this.selectedModel,
      effort: this.selectedEffort,
      ...(this.codexAccountId() === DEFAULT_CODEX_ACCOUNT ? {} : { codexAccountId: this.codexAccountId() }),
      ...(codexAccounts.preferred(this.sessionName) === null ? { codexAccountAutomatic: true } : {}),
    }
  }

  /** Apply an inherited routing snapshot before a temporary Session starts. */
  applyConversationRouting(routing: ConversationRouting): void {
    if (this.isRunning() || this.currentTurn || this.openingTurn) {
      throw new Error('cannot change conversation routing while the session is running')
    }
    if (routing.codexAccountId) codexAccounts.get(routing.codexAccountId)
    const source = getTokenSource(routing.tokenSourceId)
    if (source && source.agent !== routing.provider) {
      throw new Error(`token source "${source.id}" belongs to ${source.agent}, not ${routing.provider}`)
    }
    if (this.selectedProvider !== routing.provider) {
      feishu.replaceTurnAnchors(this.sessionName, [], null, null)
      this.pendingConversationMaterialization = null
    }
    this.selectedProvider = routing.provider
    this.selectedTokenSourceId = routing.tokenSourceId
    this.selectedModel = routing.model
    this.selectedEffort = routing.effort
    this.lastSessionRef = feishu.getSessionResumeRef(this.sessionName, routing.provider)
    this.lastSessionId = this.lastSessionRef?.sessionId ?? null
    feishu.bindSessionModelChecked(
      this.sessionName,
      routing.provider,
      routing.model,
      routing.effort,
      routing.tokenSourceId,
    )
    const accountId = routing.codexAccountId ?? DEFAULT_CODEX_ACCOUNT
    if (routing.codexAccountAutomatic) codexAccounts.selectAuto(this.sessionName)
    else if (codexAccounts.selected(this.sessionName) !== accountId) codexAccounts.select(this.sessionName, accountId)
  }

  dshEffortForSpawn() {
    if (isDshReasoningEffort(this.selectedEffort)) return this.selectedEffort
    const source = this.currentTokenSource()
    const entry = source && tokenSourceRuntimeModel(source, this.selectedModel ?? source.defaultModel)
    if (!entry || !isDshReasoningEffort(entry.defaultEffort)) throw new Error('DSH model reasoning effort is unavailable')
    return entry.defaultEffort
  }

  async listDshConversations(): Promise<ConversationSummary[]> {
    if (this.selectedProvider !== 'dsh') throw new Error('DSH history requested under a different provider')
    const source = this.currentTokenSource()
    if (!source?.enabled || source.agent !== 'dsh') throw new Error('DSH token source is unavailable')
    const rows: ConversationSummary[] = await queryDshRuntime({ cwd: this.workDir,
      env: source.spawnEnv(process.env), profile: { loadProjectMcp: false } }, 'session/list', { cwd: this.workDir })
    return rows.filter(row => !isAgentSession('dsh', row.sessionId))
  }

  /** Query Codex history without attaching the catalog process to this Session. */
  async listCodexConversations(): Promise<ConversationSummary[]> {
    if (this.selectedProvider !== 'codex') throw new Error('Codex history requested for a non-Codex session')
    if (!feishu.isOpenAIChatGPTAuthenticated(this.codexAccountId())) throw new Error('Codex 未登录 ChatGPT 账号')
    const raw = this.currentTokenSource()
    if (this.selectedTokenSourceId && (!raw || !raw.enabled)) {
      throw new Error(`token source "${this.selectedTokenSourceId}" 不可用，请重新配置或选择其他账号`)
    }
    const source = raw?.enabled ? raw : undefined
    const transformEnv = source
      ? (base: Record<string, string | undefined>) => source.spawnEnv(base)
      : undefined
    const proc = new CodexProcess({
      workDir: this.workDir,
      codexAccountId: this.codexAccountId(),
      launch: { kind: 'fresh' },
      tokenSourceId: source?.id ?? null,
      transformEnv,
    })
    let conversations: ConversationSummary[] | null = null
    let queryError: unknown = null
    try {
      conversations = await proc.listConversations()
    } catch (error) {
      queryError = error
    }
    let closeError: unknown = null
    try { await proc.kill(2000) } catch (error) { closeError = error }
    if (queryError && closeError) {
      throw new AggregateError([queryError, closeError], `Codex history query and cleanup failed: ${messageOf(queryError)}; ${messageOf(closeError)}`)
    }
    if (queryError) throw queryError
    if (closeError) throw closeError
    return conversations ?? []
  }

  /** Upgrade a pre-cwd resume record from backend-authoritative metadata. */
  private async resolveLegacyResumeRef(ref: ConversationRef): Promise<ConversationRef> {
    if (ref.cwd !== null) return ref
    if (ref.provider !== this.selectedProvider) {
      throw new Error(`legacy resume provider mismatch: ${ref.provider} != ${this.selectedProvider}`)
    }
    let resolved: ConversationRef
    if (ref.provider === 'dsh') {
      throw new Error('DSH resume reference requires its original cwd')
    } else if (ref.provider === 'claude') {
      const transcript = claudeTranscriptPath(this.workDir, ref.sessionId)
      if (!existsSync(transcript)) {
        throw new Error(`旧 Claude 会话不属于当前 cwd，或 transcript 不存在: ${diagnosticIdLabel(ref.sessionId)}`)
      }
      resolved = { ...ref, cwd: this.workDir }
    } else {
      if (!feishu.isOpenAIChatGPTAuthenticated(this.codexAccountId())) throw new Error('Codex 未登录 ChatGPT 账号')
      const raw = this.currentTokenSource()
      if (this.selectedTokenSourceId && (!raw || !raw.enabled)) {
        throw new Error(`token source "${this.selectedTokenSourceId}" 不可用，请重新配置或选择其他账号`)
      }
      const source = raw?.enabled ? raw : undefined
      const proc = new CodexProcess({
        workDir: this.workDir,
        codexAccountId: this.codexAccountId(),
        launch: { kind: 'fresh' },
        tokenSourceId: source?.id ?? null,
        transformEnv: source ? base => source.spawnEnv(base) : undefined,
      })
      let readError: unknown = null
      try { resolved = await proc.readConversationRef(ref.sessionId) }
      catch (error) { readError = error; resolved = ref }
      let closeError: unknown = null
      try { await proc.kill(2000) } catch (error) { closeError = error }
      if (readError && closeError) {
        throw new AggregateError(
          [readError, closeError],
          `Codex legacy resume lookup and cleanup failed: read=${messageOf(readError)}; cleanup=${messageOf(closeError)}`,
        )
      }
      if (readError) throw readError
      if (closeError) throw closeError
    }
    validateConversationLaunch({ kind: 'resume', source: resolved }, this.selectedProvider, this.workDir)
    feishu.bindSessionResumeChecked(this.sessionName, resolved)
    return resolved
  }

  hasRunningPeerSession(sessionName: string): boolean {
    return [...Session.all].some(s => s.sessionName === sessionName && s.isRunning())
  }

  private modelForSpawn(): string | undefined {
    // 无 token source 的旧 Codex 路径不下发 model；Claude 用 selectedModel。
    if (this.selectedProvider === 'codex') return undefined
    return this.selectedModel ?? undefined
  }

  effortForSpawn(): CodexReasoningEffort | undefined {
    // codex 有 token source(订阅):下发 effort(面板选,冷启动随面板,与 model 下发一致);
    // 无 ts 旧路径:走 ~/.codex/config.toml。
    // 热切换 setModelSettings 仍 no-op(thread/settings/update 踩坑避),需重启进程生效。
    if (this.selectedProvider === 'codex') {
      // 与 spawnAgent 一致只认 enabled source:disabled codex-sub(热重建后凭据失效)→ 不下发
      // effort,让 codex 走 ~/.codex/config.toml,避免「model 不下发但 effort 覆盖」的不一致。
      const ts = this.currentTokenSource()
      if (!ts || (!ts.enabled && ts.id !== 'codex-sub')) return undefined
      return isCodexReasoningEffort(this.selectedEffort) ? this.selectedEffort : CODEX_EFFORT
    }
    return CODEX_EFFORT
  }

  claudeEffortForSpawn(): ClaudeReasoningEffort {
    if (this.selectedProvider === 'claude' && isClaudeReasoningEffort(this.selectedEffort)) return this.selectedEffort
    const source = this.currentTokenSource()
    if (this.selectedProvider === 'claude' && source?.agent === 'claude') {
      const model = tokenSourceRuntimeModel(source, this.selectedModel ?? source.defaultModel)
      if (!isClaudeReasoningEffort(model?.defaultEffort)) throw new Error('Claude 默认 effort MISS，请通过 model 面板明确选择')
      return model.defaultEffort
    }
    return CLAUDE_EFFORT
  }

  currentModelLabel(): string | null {
    if (this.modelSettingsChange?.proc === this.proc && this.modelSettingsChange.phase === 'failed') {
      return this.modelSettingsChange.confirmedModel
    }
    // 有 token source 时 fallback 到它声明的真实模型(ts.defaultModel 如 GLM-5.2[1m]),
    // 而非 proc.lastModel —— 那是 SDK alias(如 'opus'),用户看着像切错了模型。
    // 显示/比对统一出口:剥 claude: 前缀和 [1m] 记账后缀 —— 面板选中态比对
    // (session-model)用裸模型名,内部后缀不参与。
    const raw = this.selectedModel ?? this.currentTokenSource()?.defaultModel ?? this.proc?.lastModel ?? null
    return raw?.replace(/^claude:/i, '').replace(/\[1m\]$/i, '') ?? null
  }

  currentEffortLabel(): AgentReasoningEffort | null {
    if (this.modelSettingsChange?.proc === this.proc && this.modelSettingsChange.phase === 'failed') {
      return this.modelSettingsChange.confirmedEffort
    }
    const source = this.currentTokenSource()
    if (this.selectedProvider === 'claude' && source?.agent === 'claude') {
      return this.selectedEffort ?? tokenSourceRuntimeModel(source, this.selectedModel ?? source.defaultModel)?.defaultEffort ?? null
    }
    return this.selectedEffort
      ?? (this.selectedProvider === 'dsh' ? this.dshEffortForSpawn() : undefined)
      ?? this.proc?.lastEffort
      ?? (this.selectedProvider === 'claude' ? CLAUDE_EFFORT : CODEX_EFFORT)
  }

  /** 当前实际进程的显示快照。selected* 是持久目标；只要旧 proc 还活着，
   * footer/console 就必须显示 proc，而不能提前冒充下一次启动目标。
   *  model 剥 claude: 前缀和 [1m] 记账后缀 —— 这是显示层,内部细节不外露。 */
  private runtimeModelSelection(): Pick<TurnState, 'provider' | 'model' | 'effort'> {
    const proc = this.proc?.isAlive() ? this.proc : null
    const provider = proc?.provider ?? this.selectedProvider
    if (proc && this.modelSettingsChange?.proc === proc && this.modelSettingsChange.phase === 'failed') {
      return { provider, model: this.modelSettingsChange.confirmedModel, effort: this.modelSettingsChange.confirmedEffort }
    }
    const selectedMatchesProc = !proc || proc.provider === this.selectedProvider
    const model = (proc?.lastModel
      ?? (selectedMatchesProc ? this.currentModelLabel() : null))
      ?.replace(/^claude:/i, '').replace(/\[1m\]$/i, '') ?? null
    const effort = proc?.lastEffort
      ?? (selectedMatchesProc
        ? this.currentEffortLabel()
        : provider === 'claude' ? CLAUDE_EFFORT : CODEX_EFFORT)
    return { provider, model, effort }
  }

  withModel(
    text: string,
    selection?: Pick<TurnState, 'provider' | 'model' | 'effort'>,
  ): string {
    const label = this.modelLine(selection)
    return text.includes(label) ? text : `${text} · ${label}`
  }

  private replaceFooterContent(cardId: string, content: string): Promise<void> {
    // 活跃 footer 是可丢的实时状态：second 模式下一秒就会再次刷新，单次
    // replace MISS 不影响正文或 turn 状态。保留 Card Kit 日志，但不要触发
    // Session 的群内写入失败告警；终态 footer 仍走 checked 事务并显式报错。
    return cardkit.replaceElement(
      cardId,
      cards.ELEMENTS.footer,
      this.footerElement(content),
      undefined,
      false,
    )
  }

  private footerElement(content: string): object {
    return {
      tag: 'markdown',
      element_id: cards.ELEMENTS.footer,
      content: content.trim() || ' ',
    }
  }

  private modelLine(
    selection: Pick<TurnState, 'provider' | 'model' | 'effort'> = this.currentTurn ?? this.runtimeModelSelection(),
  ): string {
    return cards.footerModelLabel(selection.provider, selection.model, selection.effort)
  }

  backendLabel(provider: AgentProvider = this.selectedProvider): string {
    return agentProviderLabel(provider)
  }

  /** Explicit one-shot launch intent owned by startForked/rollbackTo. */
  private pendingConversationLaunch: ConversationLaunch | null = null
  /** Durable Claude fork intent until first SDK init returns a new session id. */
  private pendingConversationMaterialization: PendingConversationLaunch | null = null
  /** 最近一个 turn 的用户输入预览(首条文本,recordTurnAnchor 用;openTurnCard 时设)。 */
  private lastTurnUserPreview = ''
  /** A very fast Codex turn can complete before the asynchronous authoritative
   * materialization read returns. Retain its fully captured anchor until the
   * exact owning process becomes resumable instead of losing fk/bk history. */
  private pendingCodexTurnAnchors: Array<{
    proc: AgentProcess
    anchor: feishu.TurnAnchor
  }> = []

  private pendingMaterializationLaunch(): ConversationLaunch | null {
    const pending = this.pendingConversationMaterialization
    if (!pending) return null
    validateConversationLaunch(pending.launch, 'claude', this.workDir)
    if (this.selectedProvider !== 'claude') {
      throw new Error('pending Claude fork cannot launch under a non-Claude provider')
    }
    if (this.lastSessionId === pending.previousSessionId) return pending.launch
    const materializedRef = this.lastSessionRef
    if (
      materializedRef?.provider === 'claude'
      && materializedRef.cwd === this.workDir
      && materializedRef.sessionId !== pending.launch.source.sessionId
      && materializedRef.sessionId !== pending.previousSessionId
    ) {
      return { kind: 'resume', source: materializedRef }
    }
    throw new Error('pending Claude fork has no safe launch target')
  }

  private spawnAgent(resumeRef?: ConversationRef): AgentProcess {
    this.agentCapability = randomBytes(32).toString('base64url')
    const hostEnv = {
      LODESTAR_AGENT_URL: agentApiUrl(config.notify.bind, config.notify.port),
      LODESTAR_AGENT_CAPABILITY: this.agentCapability,
      LODESTAR_AGENT_SESSION: this.sessionName,
      LODESTAR_AGENT_ROLE: 'main',
    }
    const launch: ConversationLaunch = this.pendingConversationLaunch
      ?? this.pendingMaterializationLaunch()
      ?? (resumeRef
        ? { kind: 'resume', source: resumeRef }
        : { kind: 'fresh' })
    validateConversationLaunch(launch, this.selectedProvider, this.workDir)
    // 只让 enabled source 参与 spawn。显式选择过但当前 disabled/missing 的
    // source 必须 fail closed；只有从未绑定 source 的 legacy 路径才允许裸跑。
    const raw = this.currentTokenSource()
    const codexPool = this.selectedProvider === 'codex' && this.selectedTokenSourceId === 'codex-sub'
    if (this.selectedTokenSourceId && (!raw || (!raw.enabled && !codexPool))) {
      throw new Error(`token source "${this.selectedTokenSourceId}" 不可用，请重新配置或在 model 面板选择其他账号`)
    }
    const ts = raw?.enabled || codexPool ? raw : undefined
    const fileDeliveryMode = this.currentTurn?.fileDeliveryMode ?? this.getFileDeliveryMode()
    const created = createAgentProcess({
      provider: this.selectedProvider,
      workDir: this.workDir,
      tokenSourceId: ts?.id ?? null,
      ...(this.selectedProvider === 'codex' ? { codexAccountId: codexAccounts.selected(this.sessionName) } : {}),
      ...(codexPool ? { codexAccountPreference: this.codexStartAccountOverride ?? codexAccounts.preferred(this.sessionName) } : {}),
      model: ts ? (this.selectedModel ?? ts.defaultModel) : this.modelForSpawn(),
      effort: this.selectedProvider === 'dsh'
        ? this.dshEffortForSpawn()
        : this.selectedProvider === 'claude' ? this.claudeEffortForSpawn() : this.effortForSpawn(),
      launch,
      developerInstructions: this.spawnDeveloperInstructions(fileDeliveryMode),
      profile: feishu.projectProfile(this.worktreeProjectName()),
      ...(process.env.LODESTAR_DISABLE_SKILL_SYNC === '1' ? {} : { managedSkillPluginPath: MANAGED_CLAUDE_PLUGIN_DIR }),
      hostEnv,
    })
    this.procSourceRevisions.set(created.process, created.sourceRevision)
    this.procFileDeliveryModes.set(created.process, fileDeliveryMode)
    return created.process
  }

  async applyModelSelection(
    provider: AgentProvider,
    model: string,
    effort: AgentReasoningEffort | null,
    tokenSourceId?: string,
  ): Promise<void> {
    await this.runLifecycle('apply-model-selection', () =>
      this.applyModelSelectionUnlocked(provider, model, effort, tokenSourceId)
    )
  }

  async applyModelSelectionUnlocked(
    provider: AgentProvider,
    model: string,
    effort: AgentReasoningEffort | null,
    tokenSourceId?: string,
  ): Promise<void> {
    const previousProvider = this.selectedProvider
    const nextSourceId = tokenSourceId ?? this.selectedTokenSourceId
    const ts = getTokenSource(nextSourceId)
    const nextModel = ts ? model || null : provider === 'codex' ? null : model
    const nextEffort = ts
      ? effort ?? tokenSourceRuntimeModel(ts, model || ts.defaultModel)?.defaultEffort ?? null
      : provider === 'codex' ? null : effort

    // Keep both routing and its durable selection unchanged until the old
    // process has actually stopped. A failed close must remain retryable.
    await this.stopIdleMismatchedProcessUnlocked(provider, nextSourceId, nextModel)
    const previousConversation = previousProvider !== provider ? {
      anchors: feishu.getTurnAnchors(this.sessionName).slice(),
      base: feishu.getSessionBranchBase(this.sessionName),
      pending: feishu.getPendingConversationLaunch(this.sessionName),
    } : null
    if (previousConversation) feishu.replaceTurnAnchors(this.sessionName, [], null, null)
    try {
      feishu.bindSessionModelChecked(this.sessionName, provider, nextModel, nextEffort, nextSourceId)
    } catch (error) {
      if (previousConversation) {
        try {
          feishu.replaceTurnAnchors(this.sessionName, previousConversation.anchors,
            previousConversation.base, previousConversation.pending)
        } catch (restoreError) {
          throw new AggregateError([error, restoreError],
            `model selection write failed: ${messageOf(error)}; conversation state restore failed: ${messageOf(restoreError)}`)
        }
      }
      throw error
    }
    if (previousConversation) this.pendingConversationMaterialization = null
    this.selectedProvider = provider
    this.selectedTokenSourceId = nextSourceId
    this.selectedModel = nextModel
    this.selectedEffort = nextEffort
    this.lastSessionRef = feishu.getSessionResumeRef(this.sessionName, provider)
    this.lastSessionId = this.lastSessionRef?.sessionId ?? null
  }

  async stopIdleMismatchedProcess(): Promise<void> {
    await this.runLifecycle('stop-idle-mismatched', () => this.stopIdleMismatchedProcessUnlocked())
  }

  processSourceMatches(source: TokenSource | undefined, model?: string | null): boolean {
    if (this.proc?.quotaWaitPromise && !this.proc.sessionId && this.proc.turnRetry?.reason === 'quota') return true
    if (this.proc?.sourceRevision) return this.proc.sourceRevision() === tokenSourceProcessRevision(source, model)
    return !this.proc || !this.procSourceRevisions.has(this.proc)
      || this.procSourceRevisions.get(this.proc) === tokenSourceProcessRevision(source, model)
  }

  modelSelectionNeedsProcessStop(
    provider = this.selectedProvider,
    tokenSourceId = this.selectedTokenSourceId,
    model = this.selectedModel,
  ): boolean {
    const proc = this.proc
    return !!proc?.isAlive() && (
      this.blockedProc === proc
      || proc.provider !== provider
      || proc.tokenSourceId !== tokenSourceId
      || !this.processSourceMatches(this.tokenSource(tokenSourceId), model)
    )
  }

  private async stopIdleMismatchedProcessUnlocked(
    provider = this.selectedProvider,
    tokenSourceId = this.selectedTokenSourceId,
    model = this.selectedModel,
  ): Promise<void> {
    // provider 或 token source 任一变化 = 进程 env 不再匹配 → idle 时杀掉,下轮重 spawn 换 env。
    // 同 provider 跨 source(GLM↔DeepSeek↔native)env(base_url/凭据)不同也必须重启,
    // 否则热切换只改 model 不换 env → 模型名打到上一个 source 的 base_url(silent divergence)。
    if (!this.proc || !this.modelSelectionNeedsProcessStop(provider, tokenSourceId, model)) return
    if (this.currentTurn || this.openingTurn || this.pendingUserMessageCount > 0 || this.pendingMidTurnMsgs.length > 0) return
    const proc = this.proc
    log(`session "${this.sessionName}": stop idle ${proc.provider} process before switching to ${provider}`)
    this.beginProcStop(proc)
    this.initCount = 0
    // 进程换掉:恢复轮标记 / 孤儿缓冲随旧进程作废,否则会泄漏到新进程的
    // boot init,把一次干净启动误判成 bg_task_resume 轮开出幽灵卡。
    this.bgResumePending = false
    this.discardOrphanAssistant()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.usageTotalsSeedUnknown = false
    this.status = 'stopped'
    let resumableStateError = await this.settleProcResumableState(proc)
    let killError: unknown = null
    // Use the backend's shutdown deadline: Claude SDK alone allows about 2 s
    // for graceful cleanup, so the former 1 s override reported false failures.
    try { await proc.kill() }
    catch (e) { killError = e }
    resumableStateError = await this.settleProcResumableState(proc)
    const confirmed = this.finishProcStop(proc, killError)
    this.opts.onLifecycleChange?.()
    const failures = [
      ...(killError ? [killError] : !confirmed ? [new Error(this.blockedProcReason ?? 'process stop unconfirmed')] : []),
      ...(resumableStateError ? [new Error(resumableStateError)] : []),
    ]
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, `idle process stop failed: ${failures.map(messageOf).join('; ')}`)
    }
  }

  async stopIdleCurrentProcess(reason: string): Promise<boolean> {
    return await this.runLifecycle('stop-idle-current', () => this.stopIdleCurrentProcessUnlocked(reason))
  }

  private async stopIdleCurrentProcessUnlocked(reason: string): Promise<boolean> {
    if (!this.proc?.isAlive()) return false
    if (this.currentTurn || this.openingTurn || this.pendingUserMessageCount > 0 || this.pendingMidTurnMsgs.length > 0) return false
    const proc = this.proc
    log(`session "${this.sessionName}": stop idle ${proc.provider} process: ${reason}`)
    this.beginProcStop(proc)
    this.initCount = 0
    this.bgResumePending = false
    this.discardOrphanAssistant()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.usageTotalsSeedUnknown = false
    this.status = 'stopped'
    let resumableStateError = await this.settleProcResumableState(proc)
    let killError: unknown = null
    try { await proc.kill() }
    catch (e) { killError = e }
    resumableStateError = await this.settleProcResumableState(proc)
    const confirmed = this.finishProcStop(proc, killError)
    this.opts.onLifecycleChange?.()
    const failures = [
      ...(killError ? [killError] : !confirmed ? [new Error(this.blockedProcReason ?? 'process stop unconfirmed')] : []),
      ...(resumableStateError ? [new Error(resumableStateError)] : []),
    ]
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, `idle process stop failed: ${failures.map(messageOf).join('; ')}`)
    }
    return true
  }

  private startFooterTimer(
    cardId: string,
    initialStatus: string,
    renderContent: (status: string) => string = status => status,
  ): FooterTimer {
    const startedAt = Date.now()
    let status = initialStatus
    let stopped = false
    const render = (): void => {
      if (stopped) return
      void this.replaceFooterContent(cardId, renderContent(timedStatus(status, startedAt)))
    }
    // footer 显示「状态词 + 耗时」(见 timedStatus)。bucket 只在档位边界 push;
    // second 前 10m 固定 1s,之后按 5m 档位。setStatus 切换状态也立即 push。
    // elapsedSec 仍基于 startedAt,供 closeStatusCard 结束时显示总耗时。
    let timer: ReturnType<typeof setTimeout> | null = null
    const scheduleNext = (): void => {
      if (stopped) return
      const { nextDelayMs } = liveElapsed(Date.now() - startedAt, liveElapsedMode())
      timer = setTimeout(() => { render(); scheduleNext() }, Math.max(1, Math.ceil(nextDelayMs)))
    }
    render()
    scheduleNext()
    return {
      setStatus(next: string): void {
        status = next
        render()
      },
      stop(): void {
        stopped = true
        if (timer) clearTimeout(timer)
      },
      elapsedSec(): number {
        return (Date.now() - startedAt) / 1000
      },
    }
  }

  async openStatusCard(
    title: string,
    initialStatus: string,
    template: 'blue' | 'green' | 'orange' | 'red' | 'grey' | 'turquoise' = 'blue',
  ): Promise<StatusCardHandle | null> {
    const startedAt = Date.now()
    const card = cards.statusCard({
      sessionName: this.sessionName,
      title,
      status: timedStatus(initialStatus, startedAt),
      template,
    })
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) {
      log(`session "${this.sessionName}": status card send failed title=${title}`)
      await feishu.sendTextRaw(this.chatId, `❌ 创建状态卡片失败: ${title}`)
      return null
    }
    let cardId: string
    try { cardId = await cardkit.convertMessageToCard(messageId) }
    catch (e) {
      log(`session "${this.sessionName}": status card id_convert failed title=${title}: ${e}`)
      await feishu.sendTextRaw(this.chatId, `❌ 状态卡片初始化失败: ${title}`)
      return null
    }
    cardkit.recordCardCreated(cardId, 1)
    return {
      cardId,
      title,
      timer: this.startFooterTimer(
        cardId,
        initialStatus,
        status => cards.statusCardContent(title, status),
      ),
    }
  }

  setStatusCard(handle: StatusCardHandle | null, status: string): void {
    handle?.timer.setStatus(status)
  }

  async closeStatusCard(handle: StatusCardHandle | null, finalStatus: string): Promise<void> {
    if (!handle) return
    handle.timer.stop()
    const elapsed = handle.timer.elapsedSec()
    const content = cards.statusCardContent(handle.title, `${finalStatus} (${cards.formatDuration(elapsed)})`)
    await cardkit.flush(handle.cardId)
    const footerLanded = await cardkit.replaceElementChecked(
      handle.cardId,
      cards.ELEMENTS.footer,
      this.footerElement(content),
    )
    cardkit.cancelSummary(handle.cardId)
    const settingsLanded = await cardkit.patchSettingsChecked(handle.cardId, cards.streamingOffSettings({
      durationSec: elapsed,
      suffix: finalStatus,
    }))
    if (footerLanded && settingsLanded) {
      await cardkit.dispose(handle.cardId)
    } else {
      const detail = `footer=${footerLanded ? 'ok' : 'MISS'}, settings=${settingsLanded ? 'ok' : 'MISS'}`
      log(`session "${this.sessionName}": status card terminal transaction incomplete card=${handle.cardId.slice(0, 12)} ${detail}`)
      await feishu.sendTextRaw(this.chatId, `⚠️ 状态卡片终态写入失败 (${detail})：${finalStatus}`)
    }
  }

  private async runLifecycle<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail
    let release!: () => void
    this.lifecycleTail = new Promise<void>(resolve => { release = resolve })
    await previous
    const sequence = ++this.lifecycleSequence
    log(`session "${this.sessionName}": lifecycle#${sequence} ${label} begin`)
    try {
      return await operation()
    } finally {
      release()
      log(`session "${this.sessionName}": lifecycle#${sequence} ${label} end`)
    }
  }

  private beginTurnOpen(
    proc: AgentProcess | null = this.proc,
    procEpoch = this.procEpoch,
    backendTurnStarted = false,
  ): TurnOpenOwner {
    if (this.openingTurnOwner) {
      throw new Error(
        `turn card open already owned by token=${this.openingTurnOwner.token}; ` +
        'same-process opens must wait for the current owner',
      )
    }
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    const owner: TurnOpenOwner = {
      token: ++this.turnOpenSequence,
      proc,
      procEpoch,
      sawResult: false,
      terminalForcePush: false,
      pendingCompactions: [],
      backendTurnStarted,
      done,
      resolveDone,
    }
    this.openingTurnOwner = owner
    this.openingTurn = true
    return owner
  }

  private ownsTurnOpen(owner: TurnOpenOwner): boolean {
    return this.openingTurnOwner === owner
      && this.proc === owner.proc
      && this.procEpoch === owner.procEpoch
  }

  private releaseTurnOpen(owner: TurnOpenOwner): void {
    if (this.openingTurnOwner !== owner) return
    this.openingTurnOwner = null
    this.openingTurn = false
    owner.resolveDone()
  }

  private invalidateTurnOpen(): void {
    const owner = this.openingTurnOwner
    this.openingTurnOwner = null
    this.openingTurn = false
    owner?.resolveDone()
  }

  /** Wait for a same-process card-open transaction to finish. Process
   * replacement invalidates the old owner and fails this wait, preserving the
   * existing “new process supersedes old open” lifecycle while prohibiting two
   * opens in one process generation from migrating/rendering concurrently. */
  private async waitForTurnOpenSlot(proc: AgentProcess, epoch: number): Promise<boolean> {
    while (this.openingTurnOwner) {
      const owner = this.openingTurnOwner
      await owner.done
      if (this.proc !== proc || this.procEpoch !== epoch || !proc.isAlive()) return false
    }
    return this.proc === proc && this.procEpoch === epoch && proc.isAlive()
  }

  private attachProc(proc: AgentProcess): void {
    this.modelSettingsChange?.cancel('原进程已更换')
    this.modelSettingsChange = null
    this.invalidateTurnOpen()
    this.stoppingProc = null
    this.blockedProc = null
    this.blockedProcReason = null
    this.proc = proc
    const epoch = ++this.procEpoch
    this.wireProc(proc, epoch)
  }

  private detachProc(proc: AgentProcess): boolean {
    if (this.proc !== proc) return false
    this.modelSettingsChange?.cancel('原进程已退出')
    this.modelSettingsChange = null
    this.invalidateTurnOpen()
    this.proc = null
    this.agentCapability = null
    if (this.stoppingProc === proc) this.stoppingProc = null
    if (this.blockedProc === proc) {
      this.blockedProc = null
      this.blockedProcReason = null
    }
    this.procEpoch++
    return true
  }

  private beginProcStop(proc: AgentProcess): void {
    if (this.modelSettingsChange?.proc === proc) {
      this.modelSettingsChange.cancel('原进程正在停止')
      this.modelSettingsChange = null
    }
    this.stoppingProc = proc
    this.agentCapability = null
  }

  acceptsAgentCapability(value: string): boolean {
    const expected = this.agentCapability
    if (!expected || !value || !this.proc?.isAlive()) return false
    const a = Buffer.from(expected)
    const b = Buffer.from(value)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  async cancelAgentRuns(reason = '用户取消'): Promise<void> {
    await this.opts.onCancelAgentRuns?.(this.sessionName, this.chatId, reason)
  }

  /** Returns true only when process termination is confirmed. */
  private finishProcStop(proc: AgentProcess, error: unknown): boolean {
    if (this.stoppingProc === proc) this.stoppingProc = null
    if (!proc.isAlive()) {
      this.discardPendingCodexTurnAnchors(proc, 'confirmed process stop')
      this.detachProc(proc)
      return true
    }
    this.blockedProc = proc
    this.blockedProcReason = error ? messageOf(error) : 'kill returned while process still reports alive'
    log(`session "${this.sessionName}": process stop unconfirmed; lifecycle blocked: ${this.blockedProcReason}`)
    return false
  }

  private blockedProcessMessage(): string | null {
    const proc = this.blockedProc
    if (!proc) return null
    if (!proc.isAlive()) {
      this.detachProc(proc)
      return null
    }
    return `旧 ${this.backendLabel(proc.provider)} 进程尚未确认退出，会话已阻断: ${this.blockedProcReason ?? '未知原因'}`
  }

  private async stopOwnedProc(proc: AgentProcess, timeoutMs: number): Promise<boolean> {
    if (this.proc !== proc) return !proc.isAlive()
    this.beginProcStop(proc)
    let error: unknown = null
    try { await proc.kill(timeoutMs) }
    catch (e) { error = e }
    return this.finishProcStop(proc, error)
  }

  /** Settle the exact process-owned Codex persistence transaction without
   * consulting mutable Session routing. Safe both before kill (barrier can
   * finish) and after close (late verified flag/failure is observable). */
  private async settleProcResumableState(proc: AgentProcess): Promise<string | null> {
    let materializationError: string | null = null
    const barrier = proc.conversationMaterializationBarrier?.()
    if (barrier) {
      try { await barrier }
      catch (error) {
        materializationError = `Codex 会话落盘确认失败: ${messageOf(error)}`
      }
    }
    const lateFailure = proc.conversationMaterializationFailure?.()
    if (lateFailure && proc.isConversationResumable?.() !== true) {
      materializationError = `Codex 会话落盘确认失败: ${messageOf(lateFailure)}`
    }
    const persistenceError = this.persistResumableSessionId(false, proc, false)
    return [materializationError, persistenceError].filter(Boolean).join('；') || null
  }

  // ── Lifecycle ──────────────────────────────────────────────────────
  private resetFreshConversationState(): void {
    this.daemonRestoreRequired = false
    this.turnCounter = 0
    this.pendingConversationMaterialization = null
    feishu.replaceTurnAnchors(this.sessionName, [], { kind: 'fresh' }, null)
    this.currentGoal = null
    this.cumStats = { tokens: 0, costUsd: 0, turns: 0 }
    this.lastTurnDelta = null
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.lastTurnUsage = null
    this.usageTotalsSeedUnknown = false
  }

  async start(opts: LifecycleProgressOpts = {}): Promise<boolean> {
    return await this.runLifecycle('start', () => this.startUnlocked(opts))
  }

  /** hi <name> is an explicit, one-start account override. Native errors remain authoritative. */
  async startWithCodexAccount(accountId: string, opts: LifecycleProgressOpts = {}): Promise<boolean> {
    return this.runLifecycle('hi-account', async () => {
      codexAccounts.get(accountId)
      if (this.selectedProvider !== 'codex') {
        if (this.proc?.isAlive()) await this.stopUnlocked('切换到 Codex', { ...opts, announce: false })
        const source = getTokenSourceForAccount('codex-sub', accountId)
        const model = source?.defaultModel || null
        feishu.replaceTurnAnchors(this.sessionName, [], null, null)
        feishu.bindSessionModelChecked(this.sessionName, 'codex', model, null, 'codex-sub')
        this.pendingConversationMaterialization = null
        this.selectedProvider = 'codex'
        this.selectedTokenSourceId = 'codex-sub'
        this.selectedModel = model
        this.selectedEffort = null
        this.lastSessionRef = feishu.getSessionResumeRef(this.sessionName, 'codex')
        this.lastSessionId = this.lastSessionRef?.sessionId ?? null
      }
      if (this.selectedTokenSourceId !== 'codex-sub') {
        feishu.bindSessionModelChecked(this.sessionName, 'codex', this.selectedModel, this.selectedEffort, 'codex-sub')
        this.selectedTokenSourceId = 'codex-sub'
      }
      this.codexStartAccountOverride = accountId
      try {
        if (this.proc?.isAlive() && this.proc.provider === 'codex' && processCodexAccount(this.proc) === accountId
          && this.proc.turnRetry?.reason !== 'quota') {
          opts.onStatus?.(`✅ 正在使用「${codexAccounts.get(accountId).name}」`)
          return true
        }
        return this.proc?.isAlive() ? await this.restartUnlocked(true, opts) : await this.startUnlocked(opts)
      } finally { this.codexStartAccountOverride = undefined }
    })
  }

  private async startUnlocked(opts: LifecycleProgressOpts = {}): Promise<boolean> {
    const announce = opts.announce ?? true
    const report = opts.onStatus
    const blocked = this.blockedProcessMessage()
    if (blocked) {
      this.status = 'stopped'
      report?.(`❌ ${blocked}`)
      if (announce) await feishu.sendText(this.chatId, `❌ ${blocked}。请重试 stop/restart，或等待旧进程退出。`)
      return false
    }
    if (this.proc && !this.proc.isAlive()) this.detachProc(this.proc)
    if (this.isRunning()) {
      if (this.proc?.provider === this.selectedProvider) {
        report?.(this.withModel(`✅ ${this.backendLabel()} 已运行`))
        return true
      }
      await this.stopIdleMismatchedProcessUnlocked()
      if (this.proc?.isAlive()) {
        report?.(`⚠️ 当前 ${this.backendLabel(this.proc.provider)} turn 尚未结束，模型切换将在后续新 turn 生效`)
        return true
      }
    }
    if (this.selectedProvider === 'codex') report?.('🔎 检查 Codex 登录')
    else report?.('🔎 检查 Claude Code')
    if (this.selectedProvider === 'codex' && this.selectedTokenSourceId !== 'codex-sub'
      && !feishu.isOpenAIChatGPTAuthenticated(this.codexAccountId())) {
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      report?.('❌ Codex 未登录 ChatGPT 账号')
      if (announce) {
        const sent = await feishu.sendCard(this.chatId, codexAccountCard({ phase: 'warning', title: '需要登录',
          hint: '默认：codex-login · 额外：codex-login 备注' }))
        if (!sent) throw new Error('Codex 登录引导卡片发送失败')
      }
      return false
    }
    if (!existsSync(this.workDir)) {
      report?.(`🆕 创建项目目录 ~/${this.sessionName}`)
      if (announce) await feishu.sendText(this.chatId, `🆕 目录 ~/${this.sessionName} 不存在，正在创建…`)
      try { feishu.provisionProject(this.workDir) }
      catch (e) {
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        report?.(`❌ 创建项目失败: ${e}`)
        if (announce) await feishu.sendText(this.chatId, `❌ 创建项目失败: ${e}`)
        return false
      }
    }

    if (!opts.freshConversationStateAlreadyReset && !this.pendingConversationMaterialization) {
      this.resetFreshConversationState()
    }
    this.status = 'starting'
    report?.(this.withModel(`🚀 启动 ${this.backendLabel()}`))
    let proc: AgentProcess
    try {
      if (this.selectedProvider !== 'codex' || (!this.codexStartAccountOverride && codexAccounts.preferred(this.sessionName) === null)) await waitForTokenSourceModelRefresh()
      proc = this.spawnAgent()
    } catch (e) {
      const message = `${this.backendLabel()} 启动失败: ${messageOf(e)}`
      log(`session "${this.sessionName}": ${message}`)
      report?.(`❌ ${message}`)
      if (announce) await feishu.sendText(this.chatId, `❌ ${message}`)
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      return false
    }
    this.attachProc(proc)
    const backend = this.backendLabel()
    // Claude can emit a synchronous startup error, so install its event
    // waiter before sendInitialize. Codex instead returns the exact readiness
    // Promise for initialize + thread/start; awaiting that transaction avoids
    // a shorter Session timer killing the process before its method-specific
    // RPC error can surface.
    const claudeInitWait = this.selectedProvider === 'claude'
      ? this.waitForProcEarlyFailure(proc, CLAUDE_STARTUP_GRACE_MS)
      : null
    report?.(this.selectedProvider === 'claude'
      ? `⏳ 检查 ${backend} 启动`
      : `⏳ 等待 ${backend} init`)
    let initialization: Promise<void> | undefined
    let initializeThrown: unknown = null
    try {
      proc.sendInitialize()
      initialization = proc.initializationPromise?.()
    } catch (error) {
      initialization = undefined
      initializeThrown = error
    }
    // Codex: 等 `system/init` 落地再认定 ready —— sendInitialize 只把 RPC
    // 写进 app-server 之前 proc.sessionId 还是 null,这时候 showConsole()
    // 看到 null 会 fallback 到磁盘上**上一次**会话的 lastSessionId,
    // 面板就把陈年 thread_id 当成"当前会话"贴出去。
    //
    // Claude: SDK 的 streaming-input 模式在第一条 user message 到达前
    // 不发 stream `init`。这里不能硬等 init,否则 `hi` 和冷启动首条消息
    // 都会超时;只短暂等待同步/早期 error 或 exit,首条输入触发的 init
    // 仍由 wireProc 正常处理。监听必须先于 sendInitialize 注册,否则
    // Claude wrapper 内同步暴露的启动失败会被错过。
    const init = initializeThrown
      ? { state: 'error' as const, error: initializeThrown }
      : this.selectedProvider === 'claude'
        ? await claudeInitWait!
        : await this.waitForCodexInitialization(
            this.requireCodexInitializationPromise(initialization),
            () => {
              log(`session "${this.sessionName}": codex init still pending after ${CODEX_INIT_NOTICE_MS / 1000}s`)
              report?.(this.withModel(`⏳ 仍在等待 ${backend} init 确认`))
            },
          )
    if (init.state === 'error' || init.state === 'exit') {
      const detail = init.error ? messageOf(init.error) : init.state
      log(`session "${this.sessionName}": ${this.selectedProvider} init failed: ${detail}`)
      const stopConfirmed = await this.stopOwnedProc(proc, 1000)
      const cleanup = stopConfirmed
        ? ''
        : `；进程终止未确认: ${this.blockedProcReason ?? '未知原因'}`
      const failure = `❌ ${backend} 启动失败: ${detail}${cleanup}`
      report?.(failure)
      if (announce) await feishu.sendText(this.chatId, failure)
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      return false
    }
    if (init.state === 'timeout') {
      log(`session "${this.sessionName}": ${this.selectedProvider} init wait timeout (${CODEX_INIT_TIMEOUT_MS / 1000}s)`)
      const stopConfirmed = await this.stopOwnedProc(proc, 1000)
      const cleanup = stopConfirmed
        ? ''
        : `；进程终止未确认: ${this.blockedProcReason ?? '未知原因'}`
      const message = `❌ ${backend} 启动超时: ${CODEX_INIT_TIMEOUT_MS / 1000} 秒内初始化事务未完成${cleanup}`
      report?.(message)
      if (announce) await feishu.sendText(this.chatId, message)
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      return false
    }
    if (this.proc !== proc || !proc.isAlive()) {
      const message = `${backend} 启动期间已退出`
      log(`session "${this.sessionName}": ${message}`)
      report?.(`❌ ${message}`)
      if (announce) await feishu.sendText(this.chatId, `❌ ${message}`)
      this.detachProc(proc)
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      return false
    }

    if (init.state === 'waiting_quota') {
      this.status = 'starting'
      this.startedAt = Date.now()
      this.opts.onLifecycleChange?.()
      report?.('⏳ 账号额度用尽 · 自动等待恢复，可用后继续')
      if (announce) await feishu.sendCard(this.chatId, codexAccountCard({ phase: 'checking', title: '等待额度恢复',
        message: '额度恢复后自动继续', hint: 'stop 可取消等待' }))
      return true
    }
    if (announce) {
      const modelLine = this.modelLine()
      await feishu.sendText(this.chatId, [
        this.withWorktreeInstructionNotice(`✅ Lodestar session "${this.sessionName}" 已就绪，发消息开始对话。`),
        modelLine,
      ].filter(Boolean).join('\n'))
    }
    this.status = 'idle'
    this.startedAt = Date.now()
    this.daemonRestoreRequired = false
    this.opts.onLifecycleChange?.()
    report?.(this.withModel(this.withWorktreeInstructionNotice(`✅ ${this.backendLabel()} 已就绪`)))
    return true
  }

  private requireCodexInitializationPromise(value: Promise<void> | undefined): Promise<void> {
    if (!value || typeof value.then !== 'function') {
      return Promise.reject(new Error('Codex process did not expose its initialization transaction'))
    }
    return Promise.resolve(value)
  }

  private async waitForCodexInitialization(
    initialization: Promise<void>,
    onStillWaiting?: () => void,
  ): Promise<{ state: 'init' | 'error' | 'timeout' | 'waiting_quota'; error?: unknown }> {
    return await new Promise(resolve => {
      let settled = false
      const finish = (state: 'init' | 'error' | 'timeout' | 'waiting_quota', error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(noticeTimer)
        clearTimeout(timeoutTimer)
        resolve({ state, error })
      }
      const noticeTimer = setTimeout(() => {
        if (settled) return
        try { onStillWaiting?.() }
        catch (error) { finish('error', error) }
      }, CODEX_INIT_NOTICE_MS)
      const timeoutTimer = setTimeout(() => {
        finish('timeout', new Error(`codex init timed out after ${CODEX_INIT_TIMEOUT_MS / 1000}s`))
      }, CODEX_INIT_TIMEOUT_MS)
      void initialization.then(
        () => finish('init'),
        error => finish('error', error),
      )
      void this.proc?.quotaWaitPromise?.().then(() => finish('waiting_quota'), error => finish('error', error))
    })
  }

  private async waitForProcEarlyFailure(
    proc: AgentProcess,
    graceMs: number,
  ): Promise<{ state: 'init' | 'error' | 'exit' | 'ready'; error?: unknown }> {
    return await new Promise(resolve => {
      let settled = false
      const finish = (state: 'init' | 'error' | 'exit' | 'ready', error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        proc.off('init', onInit)
        proc.off('error', onError)
        proc.off('exit', onExit)
        resolve({ state, error })
      }
      const timer = setTimeout(() => finish('ready'), graceMs)
      const onInit = () => finish('init')
      const onError = (e: unknown) => finish('error', e)
      const onExit = (e: unknown) => finish('exit', e)
      proc.once('init', onInit)
      proc.once('error', onError)
      proc.once('exit', onExit)
    })
  }

  /** Drop every ⏳ OneSecond reaction this session is currently holding
   * on user chat messages, then empty the two tracking maps. Used by
   * every tear-down path (proc exit, kill, restart) so reactions don't
   * outlive the conversation that placed them — without this, a Codex
   * crash / daemon SIGTERM leaves orphan ⏳ stuck on user messages until
   * Feishu's UI eventually GCs them (which it doesn't, in practice).
   * closeTurnCard has its own release pass (with the slightly-early
   * merged-batch trade-off documented there); this is the catastrophic-
   * exit pass. Direct `deleteReaction` calls are fire-and-forget and
   * swallow their own failures (see feishu.deleteReaction). */
  private releaseAllReactions(): void {
    for (const [msgId, rid] of [
      ...this.pendingReactionIds.entries(),
      ...this.currentBatchReactionIds.entries(),
    ]) {
      if (rid) void feishu.deleteReaction(msgId, rid)
    }
    this.pendingReactionIds = new Map()
    this.currentBatchReactionIds = new Map()
  }

  clearStaleIdleQueueState(reason: string): void {
    if (this.initCount < 1 || this.currentTurn || this.openingTurn || this.pendingUserMessageCount === 0) return
    log(`session "${this.sessionName}": clear stale pending queue before ${reason} pendingCount=${this.pendingUserMessageCount} reactions=${this.pendingReactionIds.size}`)
    this.pendingUserMessageCount = 0
    // Release stale ⏳ reactions left on the abandoned batch's chat
    // messages. addReaction callbacks still in flight will fall through
    // to the orphan path in onUserMessage's trackReaction helper.
    for (const [m, rid] of this.pendingReactionIds) {
      if (rid) void feishu.deleteReaction(m, rid)
    }
    this.pendingReactionIds = new Map()
  }

  async stop(reason = '已终止', opts: LifecycleProgressOpts = {}): Promise<void> {
    this.cancelFileDeliveries(reason)
    await this.runLifecycle('stop', () => this.stopUnlocked(reason, opts))
  }

  cancelFileDeliveries(reason: string): boolean {
    let cancelled = false
    for (const delivery of this.fileDeliveries) cancelled = delivery.cancel(reason) || cancelled
    return cancelled
  }

  private async stopUnlocked(reason = '已终止', opts: LifecycleProgressOpts = {}): Promise<void> {
    this.cancelFileDeliveries(reason)
    const announce = opts.announce ?? true
    const report = opts.onStatus
    this.daemonRestoreRequired = false
    await this.cancelAgentRuns(reason)
    if (!this.proc) {
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      report?.('⚪ session 当前未运行')
      if (announce) await feishu.sendText(this.chatId, `⚪ session "${this.sessionName}" 当前未运行`)
      return
    }
    const proc = this.proc
    // Close the tiny materialization→stop window: Codex sets its durable flag
    // before emitting conversation_materialized, so an immediately following
    // stop can still persist the exact process-owned resume point.
    let stopResumeError = this.persistResumableSessionId(false, proc, false)
    let stopMaterializationError: string | null = null
    report?.(`🛑 停止 ${this.backendLabel(this.proc.provider)}`)
    // Flip lifecycle state SYNCHRONOUSLY before awaiting kill — daemon's
    // SIGTERM cleanup snapshots `isRunning()` and if we're still mid-
    // `proc.kill()` await it'll see proc!=null and write us into the
    // alive marker, which makes the next boot auto-revive a session
    // the user explicitly killed. Reordering the null-out fixes that
    // race (bug observed 2026-05-15: `kill` immediately followed by
    // `systemctl restart` revived the killed session on boot).
    log(`session "${this.sessionName}": stop (${reason})`)
    this.invalidateTurnOpen()
    if (this.currentTurn) {
      void this.closeTurnCard(`🛑 ${reason}`).catch(e => {
        log(`session "${this.sessionName}": stop current main-card close failed: ${messageOf(e)}`)
      })
    }
    const turnClose = this.waitForTurnCloses()
      .catch(e => log(`session "${this.sessionName}": stop main-card close failed: ${messageOf(e)}`))
    this.beginProcStop(proc)
    this.status = 'stopped'
    const lifecycleErrors: unknown[] = []
    // Persist the user's stop intent before the first kill await. If the
    // daemon is hard-killed while the backend exits, the alive marker must
    // already exclude this Session.
    try { this.opts.onLifecycleChange?.() }
    catch (e) {
      lifecycleErrors.push(e)
      log(`session "${this.sessionName}": stop intent lifecycle write failed: ${messageOf(e)}`)
    }
    const materializationBarrier = proc.conversationMaterializationBarrier?.()
    if (materializationBarrier) {
      try { await materializationBarrier }
      catch (error) {
        stopMaterializationError = `Codex 会话落盘确认失败: ${messageOf(error)}`
      }
      stopResumeError = this.persistResumableSessionId(false, proc, false)
    }
    this.clearMultiMsgBuffer('stop')
    this.pendingUserMessageCount = 0
    this.pendingMidTurnMsgs = []
    this.pendingTurnInputs = []
    this.lastUserOpenId = ''
    this.releaseAllReactions()
    this.initCount = 0
    this.invalidateTurnOpen()
    this.bgResumePending = false
    // 用户主动停止:孤儿缓冲随轮作废,不兜底推送。
    this.discardOrphanAssistant()
    this.pendingAsks.clear()
    this.pendingPermissions.clear()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.usageTotalsSeedUnknown = false
    let killError: unknown = null
    try { await proc.kill() }
    catch (e) { killError = e }
    const lateMaterializationFailure = proc.conversationMaterializationFailure?.()
    if (lateMaterializationFailure && proc.isConversationResumable?.() !== true) {
      stopMaterializationError = `Codex 会话落盘确认失败: ${messageOf(lateMaterializationFailure)}`
    }
    // A turn may materialize while SIGTERM is in flight. wireProc deliberately
    // ignores ordinary events once stopping begins, but Codex flips its
    // verified resumable flag before emitting the event; persist that exact
    // owned process once more before detach.
    stopResumeError = this.persistResumableSessionId(false, proc, false)
    // Card cleanup is independent from process ownership. Never let a
    // Feishu/CardKit failure skip finishProcStop: that would leave
    // stoppingProc set without blockedProc and turn later inputs into a black
    // hole whose backend events are deliberately ignored.
    const cleanupResults = await Promise.allSettled([this.resetBackgroundTasks(), turnClose])
    const cleanupErrors = cleanupResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    for (const error of cleanupErrors) {
      log(`session "${this.sessionName}": stop terminal cleanup failed: ${messageOf(error)}`)
    }
    const confirmed = this.finishProcStop(proc, killError)
    try { this.opts.onLifecycleChange?.() }
    catch (e) {
      lifecycleErrors.push(e)
      log(`session "${this.sessionName}": stop final lifecycle write failed: ${messageOf(e)}`)
    }
    const failures: unknown[] = [
      ...(killError ? [killError] : []),
      ...(!confirmed && !killError ? [new Error(this.blockedProcReason ?? 'process stop unconfirmed')] : []),
      ...cleanupErrors,
      ...lifecycleErrors,
      ...(stopResumeError ? [new Error(stopResumeError)] : []),
      ...(stopMaterializationError && proc.isConversationResumable?.() !== true
        ? [new Error(stopMaterializationError)]
        : []),
    ]
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, `stop failed: ${failures.map(messageOf).join('; ')}`)
    }
    report?.(`✅ ${reason}`)
    if (announce) await feishu.sendText(this.chatId, `🔴 ${reason} (session: ${this.sessionName})`)
  }

  async restart(resume = false, opts: LifecycleProgressOpts = {}): Promise<boolean> {
    return await this.runLifecycle('restart', () => this.restartUnlocked(resume, opts))
  }

  requireDaemonRestore(): void {
    this.daemonRestoreRequired = true
  }

  async restoreAfterDaemonRestart(): Promise<boolean> {
    return await this.runLifecycle('daemon-restore', async () => {
      this.requireDaemonRestore()
      if (!this.lastSessionRef && !this.pendingMaterializationLaunch()) {
        const message = '❌ daemon 重启后没有可用的恢复点。请发送 rs 选择历史会话，或 hi 明确启动新会话。'
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        await feishu.sendText(this.chatId, message)
        return false
      }
      return await this.restartUnlocked(true)
    })
  }

  private async restartUnlocked(
    resume = false,
    opts: LifecycleProgressOpts = {},
    onResumeInvalidated?: (sessionId: string) => void,
  ): Promise<boolean> {
    const announce = opts.announce ?? true
    let report = opts.onStatus
    const statusBeforeResumeValidation = this.status
    let cancelledPending: PendingConversationLaunch | null = null
    if (!resume && !this.pendingConversationLaunch && this.pendingConversationMaterialization) {
      // Explicit clear/fresh restart cancels a prepared fork before any process
      // is stopped. Persistence failure leaves both routing and process intact.
      cancelledPending = this.pendingConversationMaterialization
      feishu.setPendingConversationLaunchChecked(this.sessionName, null)
      this.pendingConversationMaterialization = null
    }
    const explicitLaunch = this.pendingConversationLaunch ?? this.pendingMaterializationLaunch()
    let prevSessionRef = this.lastSessionRef
    if (resume && !explicitLaunch && prevSessionRef?.cwd === null) {
      try {
        prevSessionRef = await this.resolveLegacyResumeRef(prevSessionRef)
        this.lastSessionRef = prevSessionRef
        this.lastSessionId = prevSessionRef.sessionId
      } catch (error) {
        const invalidation = this.invalidateMissingCodexResume(
          prevSessionRef.sessionId,
          error,
          onResumeInvalidated,
        )
        const status = invalidation
          ? `❌ 旧会话不可恢复: ${messageOf(error)}；${invalidation}`
          : `❌ 旧会话 cwd 校验失败: ${messageOf(error)}；请在进程已停时发送 rs 重新选择历史会话`
        this.status = this.proc?.isAlive() ? statusBeforeResumeValidation : 'stopped'
        report?.(status)
        if (announce) await feishu.sendText(this.chatId, status)
        return false
      }
    }
    let prevSessionId = prevSessionRef?.sessionId ?? null
    let launchSourceId = explicitLaunch && explicitLaunch.kind !== 'fresh'
      ? explicitLaunch.source.sessionId
      : prevSessionId
    let prevThreadLabel = launchSourceId ? diagnosticIdLabel(launchSourceId) : ''
    let resumeRefreshError: string | null = null
    const refreshMaterializedCodexResume = (current: AgentProcess | null = this.proc): void => {
      if (
        !resume
        || explicitLaunch
        || current?.provider !== 'codex'
        || current.isConversationResumable?.() !== true
      ) return
      resumeRefreshError = this.persistResumableSessionId(false, current, false)
      prevSessionRef = this.lastSessionRef
      prevSessionId = prevSessionRef?.sessionId ?? null
      launchSourceId = prevSessionId
      prevThreadLabel = launchSourceId ? diagnosticIdLabel(launchSourceId) : ''
    }
    let statusCard: StatusCardHandle | null = null
    if (!report && announce && resume && prevSessionId) {
      const initialStatus = this.proc
        ? this.withModel(`🔁 重启 ${this.backendLabel(this.proc.provider)}`)
        : this.withModel(`🔁 恢复上一会话 thread=${prevThreadLabel}`)
      statusCard = await this.openStatusCard('restart', initialStatus)
      if (statusCard) report = status => this.setStatusCard(statusCard, status)
    }
    const announceText = announce && !statusCard
    const closeInternalStatusCard = async (finalStatus: string): Promise<void> => {
      if (statusCard) await this.closeStatusCard(statusCard, finalStatus)
    }
    const hadActiveConversationWork = Boolean(
      this.currentTurn
      || this.openingTurn
      || this.pendingUserMessageCount > 0
      || this.pendingMidTurnMsgs.length > 0
      || this.pendingTurnInputs.length > 0
      || cards.hasActiveBgTask(this.backgroundTasks)
      || this.pendingBgTasks.length > 0
      || this.backgroundSync,
    )
    // 主动重启:孤儿缓冲随轮作废,不兜底推送。必须在 kill 之前丢弃 ——
    // 否则 kill 触发的 exit 处理器会抢先把缓冲当作"进程崩溃残留"兜底推出去,
    // 违背 restart 的作废语义。null this.proc 也放到 kill 之前,让 exit 走
    // stale-proc 早退,不再重复兜底(与 stop() 同一模式)。
    this.bgResumePending = false
    this.invalidateTurnOpen()
    this.discardOrphanAssistant()
    for (const delivery of this.fileDeliveries) delivery.cancel('会话正在重启')
    if (this.currentTurn) {
      void this.closeTurnCard('🔁 已中止，正在重启').catch(e => {
        log(`session "${this.sessionName}": restart current main-card close failed: ${messageOf(e)}`)
      })
    }
    const turnClose = this.waitForTurnCloses()
      .catch(e => log(`session "${this.sessionName}": restart main-card close failed: ${messageOf(e)}`))
    let killError: unknown = null
    let stoppedProc: AgentProcess | null = null
    if (this.proc) {
      const proc = this.proc
      report?.(`🛑 停止当前 ${this.backendLabel(proc.provider)}`)
      stoppedProc = proc
      // Seal the old owner before awaiting materialization. Otherwise a result
      // in this window can drain queued user input into the branch we are
      // about to kill, then restart clears that queue as if it never ran.
      this.beginProcStop(proc)
      const materializationBarrier = proc.conversationMaterializationBarrier?.()
      if (materializationBarrier) {
        try { await materializationBarrier }
        catch (error) {
          resumeRefreshError = `Codex 会话落盘确认失败: ${messageOf(error)}`
        }
      }
      // Freeze any verified materialization after the old owner's event gate
      // has closed but before the process is signalled.
      refreshMaterializedCodexResume(proc)
      if (
        resume
        && !explicitLaunch
        && resumeRefreshError
        && !hadActiveConversationWork
        && proc.isAlive()
      ) {
        if (this.stoppingProc === proc) this.stoppingProc = null
        this.status = statusBeforeResumeValidation
        const finalStatus = `❌ ${this.backendLabel(proc.provider)} 恢复点尚未安全落盘，已保留当前进程: ${resumeRefreshError}`
        log(`session "${this.sessionName}": abort restart before kill: ${resumeRefreshError}`)
        report?.(finalStatus)
        if (announceText) await feishu.sendText(this.chatId, finalStatus)
        await closeInternalStatusCard(finalStatus)
        return false
      }
      try { await proc.kill() }
      catch (e) { killError = e }
      const lateMaterializationFailure = proc.conversationMaterializationFailure?.()
      if (lateMaterializationFailure && proc.isConversationResumable?.() !== true) {
        resumeRefreshError = `Codex 会话落盘确认失败: ${messageOf(lateMaterializationFailure)}`
      }
      // Also close the beginStop→process-exit window (see stopUnlocked).
      refreshMaterializedCodexResume(proc)
    }
    this.clearMultiMsgBuffer('restart')
    this.pendingUserMessageCount = 0
    this.pendingMidTurnMsgs = []
    this.pendingTurnInputs = []
    this.lastUserOpenId = ''
    this.releaseAllReactions()
    this.initCount = 0
    this.invalidateTurnOpen()
    // bgResumePending / 孤儿缓冲已在 kill 前作废(见上)。
    this.pendingAsks.clear()
    this.pendingPermissions.clear()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    // 后台任务随轮作废:旧 proc 的活跃 entry 不能带进新会话(会跨会话「复活」
    // 到新卡)。清理失败与 kill 失败分别保留，但二者都不能跳过进程所有权收敛。
    const cleanupResults = await Promise.allSettled([this.resetBackgroundTasks(), turnClose])
    const cleanupErrors = cleanupResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    for (const error of cleanupErrors) {
      log(`session "${this.sessionName}": restart terminal cleanup failed: ${messageOf(error)}`)
    }
    const stopConfirmed = stoppedProc ? this.finishProcStop(stoppedProc, killError) : true
    const stopFailures = [
      ...(killError ? [`kill=${messageOf(killError)}`] : []),
      ...(!stopConfirmed && !killError ? [`kill=${this.blockedProcReason ?? 'process stop unconfirmed'}`] : []),
      ...cleanupErrors.map(error => `cleanup=${messageOf(error)}`),
      ...(resumeRefreshError ? [`resume=${resumeRefreshError}`] : []),
    ]
    if (stopFailures.length > 0 && cancelledPending) {
      try {
        feishu.setPendingConversationLaunchChecked(this.sessionName, cancelledPending)
        this.pendingConversationMaterialization = cancelledPending
      } catch (error) {
        stopFailures.push(`pendingRestore=${messageOf(error)}`)
      }
    }
    if (stopFailures.length > 0) {
      const finalStatus = `❌ 旧 ${this.backendLabel()} 进程停止/清理失败: ${stopFailures.join('; ')}`
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      report?.(finalStatus)
      if (announceText) await feishu.sendText(this.chatId, finalStatus)
      await closeInternalStatusCard(finalStatus)
      return false
    }
    const hasExplicitHistoricalLaunch = explicitLaunch?.kind === 'resume' || explicitLaunch?.kind === 'fork'
    if ((resume && prevSessionRef) || hasExplicitHistoricalLaunch) {
      this.status = 'starting'
      this.usageTotalsSeedUnknown = true
      report?.(this.withModel(`🔁 恢复上一会话 thread=${prevThreadLabel}`))
      let proc: AgentProcess
      try {
        if (this.selectedProvider !== 'codex' || (!this.codexStartAccountOverride && codexAccounts.preferred(this.sessionName) === null)) await waitForTokenSourceModelRefresh()
        proc = this.spawnAgent(prevSessionRef ?? undefined)
      } catch (e) {
        const finalStatus = `❌ ${this.backendLabel()} 恢复失败: ${messageOf(e)}`
        log(`session "${this.sessionName}": ${this.selectedProvider} resume failed before spawn: ${messageOf(e)}`)
        report?.(finalStatus)
        if (announceText) await feishu.sendText(this.chatId, finalStatus)
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        await closeInternalStatusCard(finalStatus)
        return false
      }
      this.attachProc(proc)
      const backend = this.backendLabel()
      const claudeInitWait = this.selectedProvider === 'claude'
        ? this.waitForProcEarlyFailure(proc, CLAUDE_STARTUP_GRACE_MS)
        : null
      report?.(this.selectedProvider === 'claude'
        ? `⏳ 检查 ${backend} 恢复启动`
        : `⏳ 等待 ${backend} init 确认`)
      let initialization: Promise<void> | undefined
      let initializeThrown: unknown = null
      try {
        proc.sendInitialize()
        initialization = proc.initializationPromise?.()
      } catch (error) {
        initialization = undefined
        initializeThrown = error
      }
      const init = initializeThrown
        ? { state: 'error' as const, error: initializeThrown }
        : this.selectedProvider === 'claude'
          ? await claudeInitWait!
          : await this.waitForCodexInitialization(
              this.requireCodexInitializationPromise(initialization),
              () => {
                log(`session "${this.sessionName}": codex resume init still pending after ${CODEX_INIT_NOTICE_MS / 1000}s`)
                report?.(this.withModel(`⏳ 仍在等待 ${backend} init 确认 thread=${prevThreadLabel}`))
              },
            )
      if (init.state === 'error' || init.state === 'exit' || init.state === 'timeout') {
        const invalidation = init.state === 'error'
          ? this.invalidateMissingCodexResume(launchSourceId, init.error, onResumeInvalidated)
          : null
        const detail = [init.error ? messageOf(init.error) : init.state, invalidation]
          .filter(Boolean)
          .join('；')
        log(`session "${this.sessionName}": ${this.selectedProvider} resume failed: ${detail}`)
        const stopConfirmed = await this.stopOwnedProc(proc, 1000)
        const cleanup = stopConfirmed
          ? ''
          : `；进程终止未确认: ${this.blockedProcReason ?? '未知原因'}`
        const finalStatus = init.state === 'timeout'
          ? `❌ ${backend} 恢复超时${cleanup}`
          : `❌ ${backend} 恢复失败: ${detail}${cleanup}`
        report?.(finalStatus)
        if (announceText) await feishu.sendText(this.chatId, finalStatus)
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        await closeInternalStatusCard(finalStatus)
        return false
      }
      if (this.proc !== proc || !proc.isAlive()) {
        const finalStatus = `❌ ${backend} 恢复期间已退出`
        log(`session "${this.sessionName}": ${this.selectedProvider} resume process exited before ready`)
        report?.(finalStatus)
        if (announceText) await feishu.sendText(this.chatId, finalStatus)
        this.detachProc(proc)
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        await closeInternalStatusCard(finalStatus)
        return false
      }
      const msg = this.withModel(this.withWorktreeInstructionNotice(
        init.state === 'waiting_quota' ? '⏳ 账号额度用尽 · 等待后自动恢复原会话'
        : this.selectedProvider === 'claude' && init.state === 'ready'
          ? `✅ 已准备恢复上一会话 thread=${prevThreadLabel}`
          : `✅ 已恢复上一会话 thread=${prevThreadLabel}`,
      ))
      report?.(msg)
      if (announceText) await feishu.sendText(this.chatId, msg)
      this.status = init.state === 'waiting_quota' ? 'starting' : 'idle'
      this.startedAt = Date.now()
      if (init.state !== 'waiting_quota') this.daemonRestoreRequired = false
      this.opts.onLifecycleChange?.()
      try { await closeInternalStatusCard(msg) } catch (error) {
        log(`session "${this.sessionName}": restart succeeded but status-card close failed: ${messageOf(error)}`)
        await feishu.sendTextRaw(this.chatId, `⚠️ ${msg}\n状态卡收尾失败: ${messageOf(error)}`)
      }
      return true
    } else {
      // Resume requested but no prior session_id on file — surface it
      // explicitly rather than silently fresh-starting (the old behavior
      // hid the daemon-restart sessionId-loss bug for months).
      if (resume && !explicitLaunch) {
        report?.('⚠️ 没有可恢复的上一会话，将以新会话启动')
        if (announceText) await feishu.sendText(this.chatId, '⚠️ 没有可恢复的上一会话，将以新会话启动')
      }
      // Fresh conversation — drop cumulative stats and the visible turn
      // number so the next card starts from turn 1.
      this.resetFreshConversationState()
      return await this.startUnlocked({ ...opts, freshConversationStateAlreadyReset: true })
    }
  }

  /** Start a new Session process from a backend-native fork source. */
  async startForked(launch: Extract<ConversationLaunch, { kind: 'fork' }>, opts: LifecycleProgressOpts = {}): Promise<boolean> {
    return await this.runLifecycle('start-forked', async () => {
      validateConversationLaunch(launch, this.selectedProvider, this.workDir)
      const previousPending = feishu.getPendingConversationLaunch(this.sessionName)
      const pendingMaterialization: PendingConversationLaunch | null = this.selectedProvider === 'claude'
        ? { launch, previousSessionId: this.lastSessionId }
        : null
      if (pendingMaterialization) {
        // Persist before spawning. A daemon crash during Claude's startup grace
        // must still leave enough intent for the next boot/message to fork the
        // selected source rather than silently starting fresh.
        feishu.setPendingConversationLaunchChecked(this.sessionName, pendingMaterialization)
        this.pendingConversationMaterialization = pendingMaterialization
      }
      this.pendingConversationLaunch = launch
      try {
        const ok = await this.startUnlocked(opts)
        if (!ok && pendingMaterialization) {
          feishu.setPendingConversationLaunchChecked(this.sessionName, previousPending)
          this.pendingConversationMaterialization = previousPending
        }
        return ok
      } catch (error) {
        if (!pendingMaterialization) throw error
        try {
          feishu.setPendingConversationLaunchChecked(this.sessionName, previousPending)
          this.pendingConversationMaterialization = previousPending
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `fork start and pending-intent restore failed: ${messageOf(error)}; ${messageOf(restoreError)}`,
          )
        }
        throw error
      } finally {
        this.pendingConversationLaunch = null
      }
    })
  }

  /** Stop the current process and bind this group to an explicit new launch.
   * Branch metadata commits only after the replacement backend is ready. If
   * that checked write fails, the replacement process is stopped and the old
   * resume/branch snapshot is restored before the failure escapes. */
  async rollbackTo(
    launch: ConversationLaunch,
    branchState?: {
      anchors: feishu.TurnAnchor[]
      base: ConversationBranchBase
      pendingLaunch?: PendingConversationLaunch | null
    },
    opts: LifecycleProgressOpts = {},
  ): Promise<boolean> {
    return await this.runLifecycle('rollback', async () => {
      validateConversationLaunch(launch, this.selectedProvider, this.workDir)
      const nextBranchState = branchState
        ? {
            anchors: branchState.anchors.slice(),
            base: branchState.base,
            pendingLaunch: branchState.pendingLaunch !== undefined
              ? branchState.pendingLaunch
              : this.selectedProvider === 'claude' && launch.kind === 'fork'
                ? { launch, previousSessionId: this.lastSessionId }
                : null,
          }
        : null
      const previousProc = this.proc
      const previousLastSessionId = this.lastSessionId
      const previousLastSessionRef = this.lastSessionRef
      const previousAnchors = feishu.getTurnAnchors(this.sessionName).slice()
      const previousBranchBase: ConversationBranchBase = feishu.getSessionBranchBase(this.sessionName)
      const previousPendingLaunch = feishu.getPendingConversationLaunch(this.sessionName)
      const previousState = {
        turnCounter: this.turnCounter,
        currentGoal: this.currentGoal,
        cumStats: { ...this.cumStats },
        lastTurnDelta: this.lastTurnDelta ? { ...this.lastTurnDelta } : null,
        currentTurnUsageBaseline: this.currentTurnUsageBaseline ? { ...this.currentTurnUsageBaseline } : null,
        currentTurnUsageBaselineKnown: this.currentTurnUsageBaselineKnown,
        lastTurnUsage: this.lastTurnUsage ? { ...this.lastTurnUsage } : null,
        usageTotalsSeedUnknown: this.usageTotalsSeedUnknown,
      }
      let invalidatedPreviousResume = false
      const restore = (): void => {
        if (invalidatedPreviousResume) {
          this.lastSessionId = null
          this.lastSessionRef = null
          feishu.clearSessionResumeChecked(this.sessionName, 'codex')
        } else {
          this.lastSessionId = previousLastSessionId
          this.lastSessionRef = previousLastSessionRef
          if (previousLastSessionRef) feishu.bindSessionResumeChecked(this.sessionName, previousLastSessionRef)
          else feishu.clearSessionResumeChecked(this.sessionName, this.selectedProvider)
        }
        feishu.replaceTurnAnchors(
          this.sessionName,
          previousAnchors,
          previousBranchBase,
          previousPendingLaunch,
        )
        this.pendingConversationMaterialization = previousPendingLaunch
        this.turnCounter = previousState.turnCounter
        this.currentGoal = previousState.currentGoal
        this.cumStats = previousState.cumStats
        this.lastTurnDelta = previousState.lastTurnDelta
        this.currentTurnUsageBaseline = previousState.currentTurnUsageBaseline
        this.currentTurnUsageBaselineKnown = previousState.currentTurnUsageBaselineKnown
        this.lastTurnUsage = previousState.lastTurnUsage
        this.usageTotalsSeedUnknown = previousState.usageTotalsSeedUnknown
      }
      let pendingPrecommitted = false
      if (nextBranchState?.pendingLaunch) {
        // Claude does not emit the forked session id until first input. Commit
        // its launch intent before touching the process so a crash inside the
        // startup grace can be recovered on the next daemon boot.
        feishu.replaceTurnAnchors(
          this.sessionName,
          nextBranchState.anchors,
          nextBranchState.base,
          nextBranchState.pendingLaunch,
        )
        this.pendingConversationMaterialization = nextBranchState.pendingLaunch
        pendingPrecommitted = true
      }
      this.pendingConversationLaunch = launch
      const onResumeInvalidated = (sessionId: string): void => {
        invalidatedPreviousResume = previousLastSessionRef?.provider === 'codex'
          && previousLastSessionRef.sessionId === sessionId
      }
      try {
        let ok: boolean
        try {
          ok = launch.kind === 'fresh'
            ? await this.restartUnlocked(false, opts, onResumeInvalidated)
            : await this.restartUnlocked(true, opts, onResumeInvalidated)
        } catch (error) {
          // restartUnlocked can throw after a replacement has already been
          // attached (for example a ready/status callback failure). Never put
          // the old resume id back while that new fork is still alive.
          let stopError: unknown = null
          const candidate = this.proc && this.proc !== previousProc ? this.proc : null
          if (candidate) {
            try {
              await this.stopUnlocked('回滚启动事务失败', { announce: false })
            } catch (candidateStopError) {
              stopError = candidateStopError
            }
          }
          const candidateStopped = !candidate || (this.proc !== candidate && !candidate.isAlive())
          if (!candidateStopped && !stopError) {
            stopError = new Error('replacement process stop was not confirmed')
          }
          let restoreError: unknown = null
          if (candidateStopped) {
            try { restore() } catch (stateRestoreError) { restoreError = stateRestoreError }
          }
          const failures = [error, ...(stopError ? [stopError] : []), ...(restoreError ? [restoreError] : [])]
          if (failures.length === 1) throw error
          throw new AggregateError(
            failures,
            `rollback launch and cleanup failed: ${failures.map(messageOf).join('; ')}`,
          )
        }
        if (!ok) {
          restore()
          return false
        }
        if (nextBranchState) {
          try {
            if (!pendingPrecommitted) {
              feishu.replaceTurnAnchors(
                this.sessionName,
                nextBranchState.anchors,
                nextBranchState.base,
                nextBranchState.pendingLaunch,
              )
            }
            this.pendingConversationMaterialization = nextBranchState.pendingLaunch
          } catch (commitError) {
            let stopError: unknown = null
            const candidate = this.proc
            try {
              await this.stopUnlocked('回滚分支状态持久化失败', { announce: false })
            } catch (error) {
              stopError = error
            }
            const candidateStopped = !candidate || (this.proc !== candidate && !candidate.isAlive())
            if (!candidateStopped && !stopError) {
              stopError = new Error('replacement process stop was not confirmed')
            }
            let restoreError: unknown = null
            if (candidateStopped) {
              try { restore() } catch (error) { restoreError = error }
            }
            const failures = [commitError, ...(stopError ? [stopError] : []), ...(restoreError ? [restoreError] : [])]
            if (failures.length === 1) throw commitError
            throw new AggregateError(
              failures,
              `rollback branch commit failed: ${failures.map(messageOf).join('; ')}`,
            )
          }
        }
        return ok
      } finally {
        this.pendingConversationLaunch = null
      }
    })
  }

  /** daemon 解散临时群(bye)时调:从 Session.all registry 移除,避免长期运行的 daemon
   *  因临时群不断建/散而累积孤立 Session 实例(sessions Map 已 delete,但 static all 不会)。 */
  dispose(): void { Session.all.delete(this) }

  /** Clean result 时记 backend-native checkpoint + 用户输入预览 + 文件变更记录。 */
  private recordTurnAnchor(checkpoint: ConversationCheckpoint | null | undefined): string | null {
    const proc = this.proc
    if (!proc?.sessionId || !checkpoint) return null
    if (
      checkpoint.provider !== proc.provider
      || checkpoint.source.sessionId !== proc.sessionId
      || checkpoint.source.cwd !== this.workDir
    ) {
      const message = `拒绝了与当前会话不匹配的 checkpoint provider=${checkpoint.provider} source=${checkpoint.source.sessionId}`
      log(`session "${this.sessionName}": ${message}`)
      this.lastTurnUserPreview = ''
      return message
    }
    const anchor: feishu.TurnAnchor = {
      checkpoint,
      preview: this.lastTurnUserPreview.slice(0, 80),
      ts: Date.now(),
      writes: this.collectTurnWrites(),
    }
    this.lastTurnUserPreview = ''
    if (proc.provider === 'codex' && proc.isConversationResumable?.() !== true) {
      const pendingForProc = this.pendingCodexTurnAnchors.filter(pending => pending.proc === proc).length
      if (pendingForProc >= 64) {
        const message = 'Codex rollout 长期未确认，延迟 checkpoint 队列已满'
        log(`session "${this.sessionName}": ${message} thread=${proc.sessionId}`)
        return message
      }
      this.pendingCodexTurnAnchors.push({ proc, anchor })
      log(`session "${this.sessionName}": defer Codex turn checkpoint until rollout confirmation thread=${proc.sessionId} checkpoint=${checkpoint.id}`)
      return null
    }
    return this.appendTurnAnchor(anchor)
  }

  private appendTurnAnchor(anchor: feishu.TurnAnchor): string | null {
    try {
      feishu.appendTurnAnchorChecked(this.sessionName, anchor)
      return null
    } catch (error) {
      const message = `分叉 checkpoint 持久化失败: ${messageOf(error)}`
      log(`session "${this.sessionName}": ${message}`)
      return message
    }
  }

  private flushPendingCodexTurnAnchors(proc: AgentProcess): string | null {
    let failure: string | null = null
    const remaining: typeof this.pendingCodexTurnAnchors = []
    for (const pending of this.pendingCodexTurnAnchors) {
      if (pending.proc !== proc || failure) {
        remaining.push(pending)
        continue
      }
      failure = this.appendTurnAnchor(pending.anchor)
      if (failure) remaining.push(pending)
    }
    this.pendingCodexTurnAnchors = remaining
    return failure
  }

  private discardPendingCodexTurnAnchors(proc: AgentProcess, reason: string): void {
    if (proc.provider !== 'codex') return
    const before = this.pendingCodexTurnAnchors.length
    this.pendingCodexTurnAnchors = this.pendingCodexTurnAnchors.filter(pending => pending.proc !== proc)
    const dropped = before - this.pendingCodexTurnAnchors.length
    if (dropped > 0) {
      log(`session "${this.sessionName}": dropped ${dropped} unmaterialized Codex checkpoint(s): ${reason}`)
    }
  }

  private collectTurnWrites(): feishu.TurnWrite[] {
    const turn = this.currentTurn
    if (!turn) return []
    const out: feishu.TurnWrite[] = []
    for (const t of turn.toolByUseId.values()) {
      out.push(...cards.writeLogEntriesFromToolInput(t.name, t.input))
    }
    return out
  }

  worktreeProjectName(): string {
    return sessionWorktree.worktreeProjectName(this)
  }

  worktreeProjectDir(): string {
    return sessionWorktree.worktreeProjectDir(this)
  }

  private spawnDeveloperInstructions(mode: FileDeliveryMode = this.getFileDeliveryMode()): string {
    return sessionWorktree.spawnDeveloperInstructions(this, mode)
  }

  delegatedAgentDeveloperInstructions(provider: AgentProvider): string {
    return sessionWorktree.delegatedAgentDeveloperInstructions(this, provider)
  }

  worktreeInstructionLoadedNotice(): string | null {
    return sessionWorktree.worktreeInstructionLoadedNotice(this)
  }

  withWorktreeInstructionNotice(text: string): string {
    return sessionWorktree.withWorktreeInstructionNotice(this, text)
  }

  worktreeExtraInstruction(): string | null {
    return sessionWorktree.worktreeExtraInstruction(this)
  }

  runWorktreeCommand(arg: string, userOpenId: string): Promise<void> {
    return sessionWorktree.runWorktreeCommand(this, arg, userOpenId)
  }

  showWorktrees(): Promise<void> {
    return sessionWorktree.showWorktrees(this)
  }

  showTasklistPanel(): Promise<void> {
    return sessionTasklist.showTasklistPanel(this)
  }

  showAgentIdentityPanel(userOpenId = ''): Promise<void> {
    return sessionAgentIdentities.showAgentIdentityPanel(this, userOpenId)
  }

  onAgentIdentityPage(panelId: string, page: unknown, userOpenId: string): ModelActionResult {
    return sessionAgentIdentities.onAgentIdentityPage(panelId, page, userOpenId)
  }

  onTasklistEnable(): Promise<TasklistActionResult> {
    return sessionTasklist.onTasklistEnable(this)
  }

  onTasklistDeletePrompt(guidRaw: string): TasklistActionResult {
    return sessionTasklist.onTasklistDeletePrompt(this, guidRaw)
  }

  onTasklistDeleteConfirm(guidRaw: string): Promise<TasklistActionResult> {
    return sessionTasklist.onTasklistDeleteConfirm(this, guidRaw)
  }

  runCompactCommand(): Promise<void> {
    return sessionCompact.runCompactCommand(this)
  }

  showModelPanel(): Promise<void> {
    return sessionModel.showModelPanel(this)
  }

  finishModelSettingsChange(change: sessionModel.ModelSettingsChange, outcome: sessionModel.ModelSettingsOutcome): Promise<ModelActionResult> {
    return this.runLifecycle('model-settings-complete', () => sessionModel.finishModelSettingsChange(this, change, outcome))
  }

  closeModelSettingsChanges(): void {
    this.modelSettingsChangesClosed = true
    this.modelSettingsChange?.cancel('daemon 正在停止')
  }

  private modelSettingsBlockReason(): string | null {
    const change = this.modelSettingsChange
    if (!change || change.proc !== this.proc || !change.proc.isAlive()) return null
    return change.phase === 'pending'
      ? '模型设置仍在等待后端确认，请等待结果；取消切换请发 kill 或 restart。'
      : change.error ?? '模型设置未确认，请重新发送 md 选择模型。'
  }

  resumeInputAfterModelSettingsChange(): void {
    void this.drainMidTurnAndOpen().catch(async error => {
      const message = `模型设置已完成，但排队输入提交失败：${messageOf(error)}`
      log(`session "${this.sessionName}": ${message}`)
      await feishu.sendTextRaw(this.chatId, `❌ ${message}`)
    })
  }

  onModelSelect(modelRaw: string, panelIdRaw = '', userOpenId = '', actionValue: any = null): Promise<ModelActionResult> {
    return this.runLifecycle('model-select', () =>
      sessionModel.onModelSelect(this, modelRaw, panelIdRaw, userOpenId, actionValue)
    )
  }

  onModelEffortSelect(modelRaw: string, effortRaw: string, panelIdRaw = '', userOpenId = '', providerRaw = ''): Promise<ModelActionResult> {
    return this.runLifecycle('model-effort-select', () =>
      sessionModel.onModelEffortSelect(this, modelRaw, effortRaw, panelIdRaw, userOpenId, providerRaw)
    )
  }
  onProviderSelect(sourceIdRaw: string, panelIdRaw = ''): Promise<ModelActionResult> {
    return sessionModel.onProviderSelect(this, sourceIdRaw, panelIdRaw)
  }
  onModelPage(panelId: string, sourceId: string, page: number): Promise<ModelActionResult> {
    return sessionModel.onModelPage(this, panelId, sourceId, page)
  }
  onModelAddOpen(panelId: string, sourceId: string): Promise<ModelActionResult> {
    return sessionModel.onModelAddOpen(this, panelId, sourceId)
  }
  onModelListEdit(panelId: string, sourceId: string, model: string, action: 'add' | 'remove' | 'delete'): Promise<ModelActionResult> {
    return this.runLifecycle('model-list-edit', () => sessionModel.onModelListEdit(this, panelId, sourceId, model, action))
  }
  onModelPanelCancel(panelIdRaw = ''): Promise<ModelActionResult> {
    return sessionModel.onModelPanelCancel(this, panelIdRaw)
  }
  onModelCustomPrompt(sourceIdRaw: string, panelIdRaw: string, cardMessageId = ''): Promise<ModelActionResult> {
    return sessionModel.onModelCustomPrompt(this, sourceIdRaw, panelIdRaw, cardMessageId)
  }
  consumeModelCustomMessage(text: string, user: string): Promise<boolean> {
    return sessionModel.consumeModelCustomMessage(this, text, user)
  }

  onWorktreeDisband(slugRaw: string): Promise<WorktreeActionResult> {
    return sessionWorktree.onWorktreeDisband(this, slugRaw)
  }

  // ── 临时会话 / fork / back / rs 恢复(委托 session-temp)──
  showForkList(userOpenId = ''): Promise<void> { return sessionTemp.showForkList(this, userOpenId) }
  showBackList(userOpenId = ''): Promise<void> { return sessionTemp.showBackList(this, userOpenId) }
  showResumeList(userOpenId = ''): Promise<void> { return sessionTemp.showResumeList(this, userOpenId) }
  runBtwCommand(userOpenId: string): Promise<void> { return sessionTemp.runBtwCommand(this, userOpenId) }
  runByeCommand(): Promise<void> { return sessionTemp.runByeCommand(this) }
  onForkSelect(panelId: string, choiceId: string, userOpenId = ''): Promise<sessionTemp.TempSelectionResult> {
    return sessionTemp.onForkSelect(this, panelId, choiceId, userOpenId)
  }
  onBackSelect(panelId: string, choiceId: string, userOpenId = ''): Promise<sessionTemp.TempSelectionResult> {
    return sessionTemp.onBackSelect(this, panelId, choiceId, userOpenId)
  }
  onResumeSelect(panelId: string, choiceId: string, userOpenId = ''): Promise<sessionTemp.TempSelectionResult> {
    return sessionTemp.onResumeSelect(this, panelId, choiceId, userOpenId)
  }

  /** Run a bare-text control command (`hi`, `stop`, `kill`, `restart`, `clear`, `compact`, `model`, `task`)
   * plus their two-letter aliases where applicable.
   * Returns true if the command was consumed (don't forward to Codex). */
  runCommand(raw: string, userOpenId = '', messageId?: string): Promise<boolean> {
    return sessionCommands.runCommand(this, raw, userOpenId, messageId)
  }

  getFileDeliveryMode(): FileDeliveryMode { return groupFileDelivery.mode(this.chatId) }

  runFileDeliveryCommand(argument: string, userOpenId: string): Promise<void> {
    return runFileDeliveryCommand(this.chatId, this.sessionName, userOpenId, argument, {
      get: chatId => groupFileDelivery.get(chatId),
      enable: (chatId, managerOpenId) => groupFileDelivery.enable(chatId, managerOpenId),
      disable: chatId => groupFileDelivery.disable(chatId),
      sendCard: card => feishu.sendCard(this.chatId, card),
      reportError: async message => {
        log(`session "${this.sessionName}": ${message}`)
        if (!await feishu.sendText(this.chatId, message)) throw new Error(message)
      },
    })
  }

  /** Build the hi-panel data snapshot for this session.
   *
   * Passing `usage=undefined` paints the `_加载中…_` placeholder — the
   * caller is responsible for the async patch if the panel was sent. */
  async buildConsoleOpts(
    usage: UsageSnapshot | undefined,
    glmUsage?: GlmUsageSnapshot,
  ): Promise<cards.ConsoleOpts> {
    const sysinfo = await readSysInfo()
    const runtime = this.runtimeModelSelection()
    return {
      sessionName: this.sessionName,
      status: this.status,
      provider: runtime.provider,
      model: runtime.model ?? undefined,
      effort: runtime.effort ?? 'MISS',
      worktreeInstructionNotice: this.worktreeInstructionLoadedNotice(),
      peers: [...Session.all]
        .filter(s => s.isRunning())
        .map(s => ({
          ...s.peerSnapshot(),
          isCurrent: s === this,
        })),
      usage,
      glmUsage,
      sysinfo,
    }
  }

  async buildConsoleCard(usage: UsageSnapshot | undefined): Promise<object> {
    return cards.consoleCard(await this.buildConsoleOpts(usage))
  }

  private async patchConsoleUsage(cardId: string): Promise<void> {
    // 按当前 provider 只拉对应后端那一个数据源(方案 C,始终一行):
    //   claude/GLM → src/glm-usage.ts(open.bigmodel.cn / z.ai quota/limit)
    //   codex      → src/usage.ts(codex app-server rate-limit)
    const opts = await this.buildConsoleOpts(undefined)
    const provider = opts.provider ?? this.currentProvider()
    const selectedTs = this.currentTokenSource()
    const ts = (selectedTs && selectedTs.agent === provider && selectedTs.enabled)
      ? selectedTs
      : this.selectedTokenSourceId
        ? undefined
        : listEnabledTokenSourcesByAgent(provider)[0]
    if (ts) {
      opts.unifiedUsage = await ts.readUsage()
    } else if (this.selectedTokenSourceId) {
      opts.unifiedUsage = {
        state: 'no_credentials',
        windows: [],
        reason: `token source ${this.selectedTokenSourceId} unavailable`,
      }
    } else if (opts.provider === 'claude') {
      opts.glmUsage = await readGlmUsage()
    } else {
      opts.usage = await readUsage(this.codexAccountId())
    }
    const landed = await cardkit.replaceElementChecked(
      cardId,
      cards.ELEMENTS.consoleUsage,
      cards.consoleUsageElement(opts),
      { notifyCardFailure: false },
    )
    if (!landed) throw new Error('console usage element replace rejected')
  }

  /** Run a one-shot mutation on a static card, then close any streaming mode
   * that a 300309 recovery may have reopened. Only tombstone local state once
   * the close is confirmed; a failed close remains available for diagnosis or
   * a later repair instead of becoming an unwritable streaming orphan. */
  private async mutateStaticCard(
    cardId: string,
    label: string,
    mutation: () => Promise<void>,
  ): Promise<boolean> {
    let mutationLanded = true
    try {
      await mutation()
    } catch (e) {
      mutationLanded = false
      log(`session "${this.sessionName}": ${label} mutation failed: ${messageOf(e)}`)
    }
    let closed = false
    try {
      closed = await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })
    } catch (e) {
      log(`session "${this.sessionName}": ${label} streaming-off failed: ${messageOf(e)}`)
    }
    if (!mutationLanded || !closed) {
      log(`session "${this.sessionName}": ${label} state retained after checked MISS mutation=${mutationLanded} streamingOff=${closed} card=${cardId.slice(0, 12)}`)
      return false
    }
    try { await cardkit.dispose(cardId) }
    catch (e) {
      log(`session "${this.sessionName}": ${label} dispose failed: ${messageOf(e)}`)
      return false
    }
    return mutationLanded
  }

  private patchConsoleUsageLater(cardId: string): void {
    void this.mutateStaticCard(cardId, 'console usage', () => this.patchConsoleUsage(cardId))
  }

  async replaceStatusCardWithConsole(handle: StatusCardHandle, finalStatus: string): Promise<void> {
    handle.timer.stop()
    const elapsed = handle.timer.elapsedSec()
    const consoleOpts = await this.buildConsoleOpts(undefined)
    await cardkit.flush(handle.cardId)
    const currentModelLanded = await cardkit.replaceElementChecked(
      handle.cardId,
      cards.ELEMENTS.footer,
      cards.consoleCurrentModelElement(consoleOpts, cards.ELEMENTS.footer),
    )
    const mainLanded = await cardkit.addElementChecked(
      handle.cardId,
      cards.consoleMainElement(consoleOpts),
      { type: 'insert_after', targetElementId: cards.ELEMENTS.footer },
    )
    const hostLanded = await cardkit.addElementChecked(
      handle.cardId,
      cards.consoleHostElement(consoleOpts.sysinfo),
      { type: 'insert_after', targetElementId: cards.ELEMENTS.consoleProjects },
    )
    const usageLanded = await cardkit.addElementChecked(
      handle.cardId,
      cards.consoleUsageElement(consoleOpts),
      { type: 'insert_after', targetElementId: cards.ELEMENTS.consoleHost },
    )
    if (!currentModelLanded || !mainLanded || !hostLanded || !usageLanded) {
      await feishu.sendTextRaw(this.chatId, '⚠️ 控制台卡片结构写入失败，请重新发送 hi。')
      await this.mutateStaticCard(handle.cardId, 'console structure', async () => {})
      return
    }
    cardkit.cancelSummary(handle.cardId)
    await cardkit.patchSettingsChecked(handle.cardId, cards.streamingOffSettings({
      durationSec: elapsed,
      suffix: finalStatus,
    }))
    this.patchConsoleUsageLater(handle.cardId)
  }

  async showConsole(): Promise<void> {
    // Initial paint without usage → cards.ts renders the
    // `_加载中…_` placeholder in the consoleUsage element. We patch
    // it in below once readUsage() resolves; not worth blocking the
    // panel on the Codex account/rate-limit round trip.
    const card = await this.buildConsoleCard(undefined)
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) return
    // Patch the usage element asynchronously so the rest of the panel
    // stays responsive. We don't await; failures are logged and the
    // placeholder stays visible (no fallback fabrication).
    void (async () => {
      let cardId = ''
      try {
        cardId = await cardkit.convertMessageToCard(messageId)
        cardkit.recordCardCreated(cardId, 4)
      } catch (e) {
        log(`session "${this.sessionName}": console card conversion failed: ${messageOf(e)}`)
        return
      }
      await this.mutateStaticCard(cardId, 'console usage', () => this.patchConsoleUsage(cardId))
    })().catch(e => log(`session "${this.sessionName}": console async update rejected: ${messageOf(e)}`))
  }

  interrupt(): void {
    if (!this.proc) return
    log(`session "${this.sessionName}": interrupt`)
    this.proc.sendInterrupt()
  }

  private disabledSubscriptionMessage(sourceId = this.selectedTokenSourceId): string | null {
    const source = this.tokenSource(sourceId)
    return source?.kind === 'claude-subscription' && !source.enabled
      ? source.modelCatalogState?.error ?? 'Claude Code 订阅未启用，请发送 claude-sub 查看状态'
      : null
  }

  /** Register the SDK-input claim before the write. AgentProcess implementations
   * may emit init/turn_started synchronously in tests or immediately on their
   * read loop, so incrementing after sendUserText leaves a boundary race. */
  private async sendClaimedUserText(proc: AgentProcess, text: string): Promise<boolean> {
    const settingsBlocked = this.modelSettingsBlockReason()
    if (settingsBlocked) throw new Error(settingsBlocked)
    // 其他群可能在开卡期间关闭全局开关；真正送入进程前再检查一次。
    const blocked = this.disabledSubscriptionMessage(proc.tokenSourceId)
    if (blocked) {
      const message = `❌ ${blocked}。消息未送给 Agent，请启用后重发或通过 md 切换来源。`
      this.pendingTurnInputs = []
      if (this.currentTurn) await this.closeTurnCard(message)
      else await feishu.sendText(this.chatId, message)
      this.status = 'idle'
      return false
    }
    const turn = this.currentTurn
    const mode = turn ? (turn.fileDeliveryMode ??= this.getFileDeliveryMode()) : this.getFileDeliveryMode()
    const previousMode = this.procFileDeliveryModes.get(proc)
    const context = previousMode === mode ? '' : `${fileDeliveryAgentContext(mode)}\n\n`
    // Capture before the write: synchronous backend events can open a card or deliver a file.
    this.procFileDeliveryModes.set(proc, mode)
    this.pendingUserMessageCount++
    try {
      proc.sendUserText(context + text, [])
    } catch (error) {
      this.pendingUserMessageCount = Math.max(0, this.pendingUserMessageCount - 1)
      if (previousMode === undefined) this.procFileDeliveryModes.delete(proc)
      else this.procFileDeliveryModes.set(proc, previousMode)
      throw error
    }
    return true
  }

  private async startColdUserTurn(text: string, wireText: string, userOpenId: string): Promise<void> {
    if (!this.pendingConversationMaterialization) this.resetFreshConversationState()
    this.pendingTurnInputs.push(text)
    const openOwner = this.beginTurnOpen()
    try {
      const opened = await this.openTurnCard(openOwner, userOpenId, 'user_message', {
        initialFooter: 'Waiting...(0s)',
        startThinking: false,
        directStart: true,
      })
      const turn = opened
      if (!turn || this.currentTurn !== turn) return
      const bootTimer = this.startFooterTimer(
        turn.cardId,
        `🚀 启动 ${this.backendLabel()}`,
        status => this.withModel(status),
      )
      let lastBootStatus = `🚀 启动 ${this.backendLabel()}`
      const ok = await this.startUnlocked({
        announce: false,
        freshConversationStateAlreadyReset: true,
        onStatus: status => {
          lastBootStatus = status
          bootTimer.setStatus(status)
        },
      })
      bootTimer.stop()
      await cardkit.flush(turn.cardId)
      if (!ok) {
        this.pendingUserMessageCount = 0
        this.pendingMidTurnMsgs = []
        this.pendingTurnInputs = []
        this.lastUserOpenId = ''
        this.releaseAllReactions()
        await this.closeTurnCard(lastBootStatus.startsWith('❌') ? lastBootStatus : '❌ 启动失败', { forcePush: true })
        return
      }
      const proc = this.proc
      if (!proc?.isAlive()) {
        await this.closeTurnCard(`❌ ${this.backendLabel()} 启动后已退出`, { forcePush: true })
        return
      }
      this.startThinkingFooter(turn)
      if (!await this.sendClaimedUserText(proc, wireText)) return
      this.status = 'working'
    } finally {
      this.releaseTurnOpen(openOwner)
    }
  }

  // ── Inbound from Feishu ────────────────────────────────────────────
  /** Inbound user message. Starts a Codex turn immediately when idle —
   * the SDK queues internally if a turn is in flight (FIFO, exactly the
   * type-ahead semantics of the native Codex UI). Card opening:
   *   - First msg of session OR no turn in flight  → open card eagerly here
   *   - Mid-flight msg                              → defer; the `init`
   *     handler opens its card when the SDK actually starts the turn
   * This is what lets a single subprocess host both user-typed turns and
   * cron-fired wakeups without the daemon ever calling `sendInterrupt` —
   * `kill`/`stop` are the only paths that interrupt now. */
  async onUserMessage(text: string, files: string[] = [], userOpenId = '', msgId = ''): Promise<void> {
    await this.runLifecycle('user-message', () => this.onUserMessageUnlocked(text, files, userOpenId, msgId))
  }

  private async onUserMessageUnlocked(text: string, files: string[], userOpenId: string, msgId: string): Promise<void> {
    const settingsBlocked = this.modelSettingsBlockReason()
    if (settingsBlocked) {
      await feishu.sendText(this.chatId, `⚠️ ${settingsBlocked} 本条消息未送给 Agent，请确认设置后重发。`)
      return
    }
    const subscriptionDisabled = this.disabledSubscriptionMessage()
    if (subscriptionDisabled) {
      await feishu.sendText(this.chatId, `❌ ${subscriptionDisabled}。消息未送给 Agent，请启用后重发或通过 md 切换来源。`)
      return
    }
    const blocked = this.blockedProcessMessage()
    if (blocked) {
      await feishu.sendText(this.chatId, `❌ ${blocked}。请重试 stop/restart，或等待旧进程退出。`)
      return
    }
    if (this.daemonRestoreRequired) {
      await feishu.sendText(this.chatId, '❌ daemon 重启后的会话恢复尚未成功，这条消息未送给 Agent。请发送 rs 选择历史会话，或 hi 明确启动新会话，然后重发消息。')
      return
    }
    // Garbage-collect leftover state from a batch the SDK abandoned —
    // most commonly an AskUserQuestion mid-turn, which makes the SDK
    // emit `QUEUE remove × N` and drop every msg we'd already
    // sendText'd into its queue. The daemon doesn't see those remove
    // events, so `pendingUserMessageCount` and `pendingReactionIds`
    // stay stuck. If the SDK is idle right now (no turn, no eager-
    // open in flight) AND init has already fired at least once
    // (otherwise we'd be in the bootstrap race window where
    // leftover count IS valid — see wasBusy comment below), the
    // leftover count is stale and must be cleared BEFORE the
    // wasBusy computation — otherwise this fresh solo message is
    // misclassified as queued and its card closes with `📨 转交新卡`
    // instead of `✅`.
    this.clearStaleIdleQueueState('user_message')
    if (
      this.proc?.isAlive() &&
      !this.currentTurn &&
      !this.openingTurn &&
      this.pendingUserMessageCount === 0 &&
      this.pendingMidTurnMsgs.length === 0
    ) {
      await this.stopIdleMismatchedProcessUnlocked()
    }
    // Capture busy-state SYNC, before any state mutation — this decides
    // whether the message will visibly queue (gets the OneSecond → later
    // CheckMark lifecycle reactions on its Feishu chat message) or
    // eager-open its own card (no reaction needed; the card itself is
    // the acknowledgement).
    //
    // `pendingUserMessageCount > 0` catches the bootstrap race: daemon
    // just spawned, `initCount` is still 0 so no card is open yet, but
    // we've already sendText'd a previous user message into the SDK.
    // The next message lands in the SAME merged-batch SDK queue, so
    // it IS mid-flight from the SDK's perspective — without this
    // check, the daemon would mark it as solo (no ⏳ reaction) and
    // lose track of the queued turn.
    const wasBusy = this.currentTurn !== null || this.openingTurn
      || this.pendingUserMessageCount > 0 || this.pendingMidTurnMsgs.length > 0
    this.lastUserOpenId = userOpenId
    // File hint **inline 在 wireText 内部**,而不是依赖 sendUserText 把
    // files 拼到 message 整体头部。原因:drainMidTurnAndOpen merge N 条
    // wireText 时,若 files 还按整体拼接 → 所有 file hint 全堆在 long
    // message 开头,模型分不清哪个文件配哪条。inline 后每条 sub-message
    // 自带 file hint,SDK side 所有 sendUserText 调用 files 一律传空。
    const filePrefix = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n' : ''
    const wireText = filePrefix + text

    // Reaction helper: track the OneSecond reaction so deleteReaction can
    // clear it later. Use empty-string sentinel until addReaction returns.
    const trackReaction = (id: string) => {
      this.pendingReactionIds.set(id, '')
      void (async () => {
        const rid = await feishu.addReaction(id, 'OneSecond')
        if (!rid) return
        if (this.pendingReactionIds.has(id)) {
          this.pendingReactionIds.set(id, rid)
        } else if (this.currentBatchReactionIds.has(id)) {
          this.currentBatchReactionIds.set(id, rid)
        } else {
          // Orphan: both maps cleared before our add returned. Delete
          // directly so the user doesn't see a stale ⏳ forever.
          void feishu.deleteReaction(id, rid)
        }
      })().catch(e => {
        log(`session "${this.sessionName}": reaction tracking failed: ${messageOf(e)}`)
      })
    }

    if (!this.isRunning()) {
      if (this.openingTurn || this.currentTurn) {
        this.pendingMidTurnMsgs.push({ text, wireText, userOpenId, msgId })
        if (msgId) trackReaction(msgId)
        return
      }
      await this.startColdUserTurn(text, wireText, userOpenId)
      return
    }

    if (this.currentTurn !== null) {
      // Mid-turn — BUFFER instead of immediate sendUserText. The SDK polling
      // loop will not auto-dequeue queued type-ahead msgs after `result`
      // (we explicitly write again to wake the Codex app-server),
      // so writing here would leave the msg stuck until the next user msg
      // arrives. Drain happens in the `result` handler, which both wakes
      // the SDK and opens a fresh card for the new batch turn.
      this.pendingMidTurnMsgs.push({ text, wireText, userOpenId, msgId })
      if (msgId) trackReaction(msgId)
      return
    }

    // No in-flight turn: send straight to SDK. This path handles
    //   - first message after spawn (init not yet fired)
    //   - bootstrap race (sibling msgs landing before init#1)
    //   - solo message after a prior turn has fully closed
    // Eager-open path: open the card BEFORE feeding SDK, so a card-open
    // failure doesn't strand the daemon with SDK processing a turn we
    // have nowhere to render. `!openingTurn` means no sibling is mid-
    // open; `initCount >= 1` means SDK boot init has fired (otherwise
    // the init handler owns turn opening and we just feed the queue
    // below). On failure openTurnCard surfaces a red banner via
    // sendTextRaw; SDK was idle so no interrupt needed.
    if (!this.openingTurn && this.initCount >= 1) {
      const proc = this.proc!
      const epoch = this.procEpoch
      const openOwner = this.beginTurnOpen(proc, epoch)
      try {
        // openTurnCard 内部读 pendingTurnInputs 渲染 "📥 收到" panel,要在
        // 它之前 push;之后再 sendUserText 给 SDK,顺序无关紧要(panel 是
        // daemon 自渲染,跟 SDK input 流分离)。
        this.pendingTurnInputs.push(text)
        const opened = await this.openTurnCard(openOwner, userOpenId, 'user_message')
        if (!opened || this.currentTurn !== opened) return
        if (this.proc !== proc || this.procEpoch !== epoch || !proc.isAlive()) {
          await this.closeTurnCard(`⚠️ ${this.backendLabel(proc.provider)} 已退出`)
          return
        }
        if (!await this.sendClaimedUserText(proc, wireText)) return
        this.status = 'working'
      } finally {
        this.releaseTurnOpen(openOwner)
      }
      return
    }

    // Non-eager path 分两支:
    //   A) openingTurn=true 或 pendingUserMessageCount>0 — sibling 在
    //      openTurnCard,或者 cold-start 第一条 sendUserText 已经发出在
    //      等 SDK init#1。两种情况下直接 sendUserText 都会让 SDK
    //      把这条偷偷合并进 sibling 的 turn(或第一条触发的 cold-start
    //      turn),但 panel input 已经被 snapshot 决定 → "内容跟响应不
    //      一致"race(02:22 + 03:19 现场,以及 commit 2258af4 注释里的
    //      cold-start "first write lands in idle SDK" empirical 行为)。
    //      改成 mid-turn buffer 风格:不 sendUserText、不 push
    //      pendingTurnInputs,等 sibling turn close 后由 result handler
    //      的 midBuffer drain 走 merge 一致处理。
    //   B) cold start 第一条 (initCount===0 且 pendingCount===0) — init
    //      还没来,必须 sendUserText 喂 SDK 才能 wake;init handler 后续
    //      触发 openTurnCard 时一次性消费 pendingTurnInputs。
    if (this.openingTurn || this.pendingUserMessageCount > 0) {
      this.pendingMidTurnMsgs.push({ text, wireText, userOpenId, msgId })
      if (msgId) trackReaction(msgId)
      return
    }
    this.pendingTurnInputs.push(text)
    if (!await this.sendClaimedUserText(this.proc!, wireText)) return
    if (wasBusy && msgId) {
      // Bootstrap race / sibling-opening race: until a card is open,
      // the OneSecond ⏳ is the only ack the user gets. The init handler
      // inherits these via currentBatchReactionIds when it opens.
      trackReaction(msgId)
    }
  }

  // ── External API delegated to helpers ──────────────────────────────
  // Thin wrappers so daemon.ts keeps its `session.xxx(...)` call style;
  // bodies live in session-ask.ts / session-permission.ts.

  hasPendingAsk(): boolean {
    return sessionAsk.hasPendingAsk(this)
  }

  refreshPendingAsks(): void {
    sessionAsk.refreshPendingAsks(this)
  }

  askBlockReason(toolUseId: string): string | null {
    return sessionAsk.askBlockReason(this, toolUseId)
  }

  /** 多条消息缓冲入口(`>>>` 开始 / `<<<` 收尾 / 中段普通消息)。返回 true
   *  表示这条已被缓冲或已合并 flush,daemon 不应再调 onUserMessage。*/
  onMultiMessageInbound(text: string, files: string[], userOpenId: string, msgId: string): Promise<boolean> {
    return sessionMultimsg.onMultiMessageInbound(this, text, files, userOpenId, msgId)
  }

  /** 丢弃多条消息缓冲并给每条打 ❌。stop/kill/restart/clear/exit 调用。*/
  clearMultiMsgBuffer(reason: string): void {
    sessionMultimsg.clearMultiMsgBuffer(this, reason)
  }

  onAskMessageAnswer(text: string, user: string, msgId: string): Promise<void> {
    return sessionAsk.onAskMessageAnswer(this, text, user, msgId)
  }

  onAskAnswer(toolUseId: string, questionIdx: number, optionIdx: number, user: string): Promise<boolean> {
    return sessionAsk.onAskAnswer(this, toolUseId, questionIdx, optionIdx, user)
  }

  onAskCustomAnswer(toolUseId: string, questionIdx: number, customText: string, user: string): Promise<boolean> {
    return sessionAsk.onAskCustomAnswer(this, toolUseId, questionIdx, customText, user)
  }

  onPermissionDecision(
    requestId: string,
    decision: 'allow' | 'allow_always' | 'deny',
    user: string,
  ): Promise<{ ok: boolean; message: string }> {
    return sessionPermission.onPermissionDecision(this, requestId, decision, user)
  }

  // ── Wiring Codex → Feishu ──────────────────────────────────────────
  /** A fresh Codex init only owns an in-memory thread id. Remove any older
   * selected Codex binding after the new process is ready so an idle stop or
   * daemon restart cannot revive either that ghost id or the pre-fresh
   * conversation. The checked write is part of the init transaction. */
  private clearResumeBindingForFreshCodex(proc: AgentProcess): void {
    if (proc.isConversationResumable?.()) {
      throw new Error('fresh Codex thread was unexpectedly marked resumable during init')
    }
    const previous = feishu.getSessionResumeRef(this.sessionName, 'codex')
    feishu.clearSessionResumeChecked(this.sessionName, 'codex')
    if (this.selectedProvider === 'codex') {
      this.lastSessionRef = null
      this.lastSessionId = null
    }
    if (previous) {
      log(`session "${this.sessionName}": cleared pre-fresh Codex resume binding thread=${previous.sessionId}`)
    }
  }

  /** Migrate a ghost binding created by older Lodestar versions, but only
   * when the app-server explicitly confirms the exact bound Codex id has no
   * rollout. Other resume failures keep the binding for diagnosis/retry. */
  private invalidateMissingCodexResume(
    sessionId: string | null,
    error: unknown,
    onInvalidated?: (sessionId: string) => void,
  ): string | null {
    if (!sessionId || this.selectedProvider !== 'codex') return null
    const rpcError = findCodexRpcResponseError(error)
    if (
      !rpcError
      || !['thread/read', 'thread/resume', 'thread/fork'].includes(rpcError.method)
      || rpcError.serverCode !== -32600
      || rpcError.serverMessage !== `no rollout found for thread id ${sessionId}`
    ) return null
    const bound = feishu.getSessionResumeRef(this.sessionName, 'codex')
    if (!bound || bound.sessionId !== sessionId) return null
    try {
      feishu.clearSessionResumeChecked(this.sessionName, 'codex')
    } catch (clearError) {
      const failure = `已确认恢复点无 rollout，但作废失败: ${messageOf(clearError)}`
      log(`session "${this.sessionName}": ${failure} thread=${sessionId}`)
      return failure
    }
    if (this.lastSessionRef?.provider === 'codex' && this.lastSessionRef.sessionId === sessionId) {
      this.lastSessionRef = null
      this.lastSessionId = null
    }
    onInvalidated?.(sessionId)
    const receipt = `已作废无 rollout 的恢复点 thread=${diagnosticIdLabel(sessionId)}`
    log(`session "${this.sessionName}": ${receipt} fullThread=${sessionId}`)
    return receipt
  }

  private persistResumableSessionId(
    fatal = false,
    proc: AgentProcess | null = this.proc,
    notify = true,
  ): string | null {
    const pendingMaterialization = proc?.provider === 'claude'
      ? this.pendingConversationMaterialization
      : null
    const sessionId = proc?.sessionId
    if (!proc) return null
    // Codex thread/start returns an id before its rollout exists. Only
    // resume/fork init or the explicit conversation_materialized signal may
    // advance the durable resume binding.
    if (proc.provider === 'codex' && proc.isConversationResumable?.() !== true) return null
    if (!sessionId) {
      if (!pendingMaterialization) return null
      const error = new Error('Claude pending fork did not provide a materialized session id')
      log(`session "${this.sessionName}": ${error.message}`)
      if (fatal) throw error
      return error.message
    }
    const ref: ConversationRef = { provider: proc.provider, sessionId, cwd: this.workDir }
    if (
      pendingMaterialization
      && (
        sessionId === pendingMaterialization.launch.source.sessionId
        || (
          pendingMaterialization.previousSessionId !== null
          && sessionId === pendingMaterialization.previousSessionId
        )
      )
    ) {
      const error = new Error(`Claude fork did not materialize an independent session id (${sessionId})`)
      log(`session "${this.sessionName}": ${error.message}`)
      if (fatal) throw error
      return error.message
    }
    try {
      feishu.bindSessionResumeChecked(this.sessionName, ref)
    } catch (error) {
      const message = `会话恢复点持久化失败: ${messageOf(error)}`
      const firstReport = this.resumePersistenceError !== message
      this.resumePersistenceError = message
      if (proc.provider === this.selectedProvider) {
        this.lastSessionRef = ref
        this.lastSessionId = sessionId
      }
      log(`session "${this.sessionName}": ${message}`)
      if (fatal) throw error
      if (firstReport && notify) {
        void feishu.sendTextRaw(this.chatId, `⚠️ ${message}；当前进程可继续，但 daemon 重启前请先解决本机状态目录写入问题。`)
      }
      return message
    }
    if (proc.provider === this.selectedProvider) {
      this.lastSessionRef = ref
      this.lastSessionId = sessionId
    }
    const anchorError = proc.provider === 'codex'
      ? this.flushPendingCodexTurnAnchors(proc)
      : null
    if (anchorError) {
      const firstReport = this.resumePersistenceError !== anchorError
      this.resumePersistenceError = anchorError
      if (fatal) throw new Error(anchorError)
      if (firstReport && notify) void feishu.sendTextRaw(this.chatId, `⚠️ ${anchorError}`)
      return anchorError
    }
    this.resumePersistenceError = null
    return null
  }

  /** The first Claude result proves the prepared fork has materialized and
   * completed its first turn. Until then the durable marker lets process exit
   * or daemon restart resume the new id (if init arrived) or retry the fork. */
  private consumePendingConversationMaterialization(): string | null {
    const pending = this.pendingConversationMaterialization
    if (!pending) return null
    const ref = this.lastSessionRef
    if (
      ref?.provider !== 'claude'
      || ref.cwd !== this.workDir
      || ref.sessionId === pending.launch.source.sessionId
      || ref.sessionId === pending.previousSessionId
    ) {
      const message = 'Claude 待生成分支没有可验证的新会话恢复点，保留 pending marker'
      log(`session "${this.sessionName}": ${message}`)
      return message
    }
    try {
      feishu.setPendingConversationLaunchChecked(this.sessionName, null)
      this.pendingConversationMaterialization = null
      return null
    } catch (error) {
      const message = `Claude 待生成分支标记清除失败: ${messageOf(error)}`
      log(`session "${this.sessionName}": ${message}`)
      return message
    }
  }

  // ── 原生子 Agent / 后台任务 → 共享委派面板 ───────────────────────

  /** 当前双池快照 —— 喂给纯函数累积器的入参。 */
  private bgStore(): cards.BgStore {
    return { active: this.backgroundTasks, pending: this.pendingBgTasks }
  }

  /** 把 BgStore 双池结果写回 backgroundTasks(active)+ pendingBgTasks。
   *  bg_task_* 事件与子 agent tool_use/tool_result 累积的统一落点。 */
  private applyBgStore(next: cards.BgStore): void {
    this.backgroundTasks = next.active
    this.pendingBgTasks = next.pending
  }

  /** 主线程推进(新的主线程 tool_use / assistant 段定稿):pending 观察池里还没结算
   *  的 task 都没在阻塞主线程 —— 判为后台,提升到 active 入卡。治 run_in_background
   *  的 Bash 不发 is_backgrounded、永远卡 pending 不渲染。 */
  private onMainThreadAdvance(): void {
    if (this.pendingBgTasks.length === 0) return
    this.applyBgStore(cards.promotePendingOnAdvance(this.bgStore()))
    this.onBackgroundTaskChanged()
  }

  /** parentToolUseId 是否归属某个已知后台 task(active 入卡池或 pending 观察池)。
   *  子 agent 前台跑时在 pending,提升后在 active,两池都要认才能持续累积 steps。 */
  private bgTaskOwns(parentToolUseId: string): boolean {
    return this.backgroundTasks.some(t => t.toolUseId === parentToolUseId)
      || this.pendingBgTasks.some(t => t.toolUseId === parentToolUseId)
  }

  hasPendingAgentTool(): boolean {
    return this.nativeAgentTools.size > 0
  }

  private onBackgroundTaskChanged(immediate = false): void {
    if (!this.backgroundTasks.length) return
    // Start and terminal states are published immediately; tool/progress bursts
    // coalesce within 1.5s. Titles have no ticking clock, so idle jobs need no timer.
    if (immediate) {
      if (this.backgroundRefreshTimer) clearTimeout(this.backgroundRefreshTimer)
      this.backgroundRefreshTimer = null
      void this.refreshBackgroundCardFull().catch(error => this.reportBackgroundWriteFailure(error))
    } else {
      this.scheduleBackgroundRefresh()
    }
  }

  private scheduleBackgroundRefresh(): void {
    if (this.backgroundRefreshTimer) return
    this.backgroundRefreshTimer = setTimeout(() => {
      this.backgroundRefreshTimer = null
      void this.refreshBackgroundCardFull().catch(error => this.reportBackgroundWriteFailure(error))
    }, 1500)
  }

  private refreshBackgroundCardFull(): Promise<void> {
    const owner = this.backgroundOwner
    const snapshot = [...this.backgroundTasks]
    const operation = this.agentCards.syncBackground(this.chatId, owner, snapshot)
    let guarded!: Promise<void>
    guarded = operation.then(() => { this.backgroundWriteError = null }).finally(() => {
      if (this.backgroundSync === guarded) this.backgroundSync = null
    })
    this.backgroundSync = guarded
    return guarded
  }

  private async reportBackgroundWriteFailure(error: unknown): Promise<void> {
    const detail = messageOf(error)
    log(`session "${this.sessionName}": delegation panel update failed: ${detail}`)
    if (this.backgroundWriteError === detail) return
    this.backgroundWriteError = detail
    await feishu.sendTextRaw(this.chatId, `⚠️ 委派面板更新失败：${detail}`)
  }

  /** Drain admitted writes and settle only this process's rows. The shared card
   * stays streaming while other delegated work is still running. */
  private async resetBackgroundTasks(): Promise<void> {
    if (this.backgroundRefreshTimer) clearTimeout(this.backgroundRefreshTimer)
    this.backgroundRefreshTimer = null
    const now = Date.now()
    this.backgroundTasks = this.backgroundTasks.map(task => cards.isBgTerminal(task)
      ? task : { ...task, status: 'killed', endTime: task.endTime ?? now })
    this.pendingBgTasks = []
    // A previous write may have failed, but terminal cleanup still attempts its
    // own authoritative snapshot and propagates any final failure to stop().
    if (this.backgroundSync) {
      try { await this.backgroundSync }
      catch (error) { log(`session "${this.sessionName}": retrying terminal delegation update after: ${messageOf(error)}`) }
    }
    await this.refreshBackgroundCardFull()
    if (this.backgroundRefreshTimer) clearTimeout(this.backgroundRefreshTimer)
    this.backgroundRefreshTimer = null
    this.agentCards.releaseBackground(this.backgroundOwner)
    this.backgroundOwner = randomBytes(16).toString('hex')
    this.backgroundTasks = []
    this.nativeAgentTools.clear()
    this.lastMainTaskToolUseId = null
  }

  /** Claude SDK Cron prompts are injected outside Lodestar's sendUserText
   * path, so they have neither a pending input claim nor a daemon-opened card.
   * Claim the turn as soon as the SDK exposes its meta user message; this puts
   * the open guard in place before assistant/tool events begin. */
  private startScheduledTurnCard(
    p: AgentProcess,
    epoch: number,
    text: string,
    promptId: string | null,
  ): void {
    if (this.proc !== p || this.procEpoch !== epoch || !p.isAlive()) return
    // If another visible owner already exists, the SDK has folded this prompt
    // into that turn and its output will render there. Never create a second
    // card over a live/opening user or background turn.
    if (
      this.currentTurn ||
      this.openingTurn ||
      this.pendingUserMessageCount > 0 ||
      this.bgResumePending
    ) return

    let openOwner: TurnOpenOwner
    try {
      openOwner = this.beginTurnOpen(p, epoch, true)
    } catch (error) {
      log(`session "${this.sessionName}": scheduled turn-open ownership conflict: ${messageOf(error)}`)
      return
    }
    const preview = text.replace(/\s+/g, ' ').trim()
    this.lastTurnUserPreview = `⏰ ${preview.slice(0, 78)}`
    log(`session "${this.sessionName}": scheduled wakeup prompt=${promptId ?? 'MISS'}`)

    void (async () => {
      try {
        const opened = await this.openTurnCard(openOwner, '', 'scheduled_wakeup')
        if (this.proc !== p || this.procEpoch !== epoch) {
          log(`session "${this.sessionName}": scheduled ${p.provider} turn became stale while opening epoch=${epoch}`)
          if (opened && this.currentTurn === opened) {
            await this.closeTurnCard(`⚠️ ${this.backendLabel(p.provider)} 已退出`)
          }
          return
        }
        if (!opened || this.currentTurn !== opened) {
          if (!this.ownsTurnOpen(openOwner)) return
          // The scheduled turn is already executing inside the SDK. Preserve
          // its report via the same cardless buffer used by background resume
          // turns; result/exit will send an explicit raw-text fallback.
          this.bgResumeCardless = true
          if (openOwner.sawResult) {
            openOwner.sawResult = false
            log(`session "${this.sessionName}": scheduled open failed after result — flushing orphan now`)
            this.flushOrphanAssistantToChat('scheduled open failed, result already arrived')
          } else {
            log(`session "${this.sessionName}": scheduled open failed — orphan text flush will cover the output`)
          }
        } else if (openOwner.sawResult) {
          openOwner.sawResult = false
          log(`session "${this.sessionName}": scheduled result raced card-open — closing freshly-opened card`)
          await this.closeTurnCard(openOwner.terminalSuffix, {
            forcePush: openOwner.terminalForcePush,
            hasFreshResult: true,
          })
          this.status = 'idle'
        } else {
          this.status = 'working'
        }
      } finally {
        this.releaseTurnOpen(openOwner)
      }
    })().catch(error => {
      log(`session "${this.sessionName}": scheduled turn-open handler failed: ${messageOf(error)}`)
    })
  }

  private wireProc(p: AgentProcess, wiredEpoch?: number): void {
    // Tests and a few package-internal probes historically call wireProc
    // directly. Treat that form as an explicit attach; production uses
    // attachProc() and passes the already-incremented generation.
    if (wiredEpoch === undefined) {
      this.invalidateTurnOpen()
      }
    const epoch = wiredEpoch ?? ++this.procEpoch
    if (wiredEpoch === undefined && this.proc !== p) this.proc = p
    const isCurrent = (): boolean => this.proc === p && this.procEpoch === epoch
    let staleEventLogged = false
    let stoppedEventLogged = false
    const on = <K extends keyof AgentProcessEventMap>(
      event: K,
      handler: (payload: AgentProcessEventMap[K]) => void,
    ): void => {
      p.on(event, (payload: AgentProcessEventMap[K]) => {
        if (!isCurrent()) {
          if (!staleEventLogged) {
            staleEventLogged = true
            log(`session "${this.sessionName}": ignore stale ${p.provider} event=${String(event)} epoch=${epoch} currentEpoch=${this.procEpoch}`)
          }
          return
        }
        if (event !== 'exit' && (this.stoppingProc === p || this.blockedProc === p)) {
          if (!stoppedEventLogged) {
            stoppedEventLogged = true
            log(`session "${this.sessionName}": ignore ${p.provider} event=${String(event)} while process stop is pending`)
          }
          return
        }
        handler(payload)
      })
    }

    on('error', err => {
      log(`session "${this.sessionName}": ${p.provider} process error: ${err}`)
    })
    on('init', () => {
      if (p.provider === 'codex' && p.quotaWaitPromise) {
        this.daemonRestoreRequired = false
        if (this.status === 'starting') this.status = this.currentTurn ? 'working' : 'idle'
        this.opts.onLifecycleChange?.()
      }
      if (p.provider === 'codex' && p.launchKind === 'fresh') {
        this.clearResumeBindingForFreshCodex(p)
      } else {
        this.persistResumableSessionId(true)
      }
      this.initCount++
      log(`session "${this.sessionName}": SDK init#${this.initCount} pendingCount=${this.pendingUserMessageCount} midBuffer=${this.pendingMidTurnMsgs.length} currentTurn=${this.currentTurn ? 'yes' : 'no'} openingTurn=${this.openingTurn}`)

      // Boot init (initCount === 1) is claimed by `onUserMessage`'s
      // eager-open path — if a user message landed before the init
      // arrived, it sits in `pendingUserMessageCount` and we drain it
      // below; otherwise the init opens nothing. Subsequent inits
      // (initCount >= 2) can mark the start of an SDK-initiated turn
      // when the SDK is draining the type-ahead queue we fed it via
      // `sendUserText` (isUserBatch).
      //
      // SDK-driven rotation puts the boundary HERE: the previous
      // turn's `result` already closed the in-flight card with
      // `📨 转交新卡` (because pendingUserMessageCount > 0). Now we
      // open a fresh card whose top panel shows the queued messages.
      // currentTurn should be null at this point (result null'd it);
      // the openingTurn guard catches the eager-open vs init race.
      // Eager/cold/drain paths open their card before sendUserText. Their init
      // therefore arrives with currentTurn/openingTurn already set; consume
      // the SDK-input claim here, but leave pending reactions alone because
      // those belong to later daemon-buffered messages, not this open turn.
      if (this.currentTurn || this.openingTurn) {
        if (this.pendingUserMessageCount > 0) {
          log(`session "${this.sessionName}": SDK init claimed eager input pendingCount=${this.pendingUserMessageCount}`)
          this.pendingUserMessageCount = 0
        }
        return
      }
      const isUserBatch = this.pendingUserMessageCount > 0
      // SDK 自发恢复轮:后台任务结算通知唤醒 SDK 合并结果,init 没有伴随
      // 用户消息。必须照样开卡,否则这一轮的全部正文会被 appendAssistant
      // 静默丢弃(2026-07-04 etmmo 终报告事故)。bgResumePending 只在
      // bg_task_settled 落在无活跃 turn 时置位,保证 probe/模型切换等
      // 无关的空 init 不受影响。
      const isBgResume = !isUserBatch && this.bgResumePending
      if (!isUserBatch && !isBgResume) return
      const userOpenId = this.lastUserOpenId
      let openOwner: TurnOpenOwner
      try {
        openOwner = this.beginTurnOpen(p, epoch, true)
      } catch (error) {
        // Preserve pendingCount/bgResumePending/reactions so a later boundary
        // can still claim this turn. An invariant violation is visible in logs
        // but must not escape EventEmitter and tear down the whole SDK process.
        log(`session "${this.sessionName}": init turn-open ownership conflict: ${messageOf(error)}`)
        return
      }
      this.bgResumePending = false
      if (isUserBatch) {
        this.pendingUserMessageCount = 0
        // Inherit the queued reaction_ids — this turn is collectively
        // responsible for releasing their OneSecond reactions when it
        // closes (via deleteReaction in closeTurnCard).
        this.currentBatchReactionIds = this.pendingReactionIds
        this.pendingReactionIds = new Map()
      }
      const claimedReactionMsgIds = isUserBatch ? [...this.currentBatchReactionIds.keys()] : []
      const releaseClaimedReactions = (): void => {
        for (const msgId of claimedReactionMsgIds) {
          const rid = this.currentBatchReactionIds.get(msgId)
          this.currentBatchReactionIds.delete(msgId)
          if (rid) void feishu.deleteReaction(msgId, rid)
        }
      }
      void (async () => {
        try {
          const opened = await this.openTurnCard(openOwner, userOpenId, isUserBatch ? 'user_message' : 'bg_task_resume')
          if (!isCurrent()) {
            log(`session "${this.sessionName}": ${p.provider} became stale while opening turn card epoch=${epoch}`)
            if (opened && this.currentTurn === opened) {
              await this.closeTurnCard(`⚠️ ${this.backendLabel(p.provider)} 已退出`)
            }
            releaseClaimedReactions()
            return
          }
          if (!opened || this.currentTurn !== opened) {
            // A newer open on the same process can supersede this owner while
            // Feishu is resolving message_id -> card_id. Never interrupt or
            // close the newer turn from the obsolete continuation.
            if (!this.ownsTurnOpen(openOwner)) {
              releaseClaimedReactions()
              return
            }
            if (openOwner.sawResult && openOwner.terminalSuffix) {
              void feishu.sendTextRaw(this.chatId, openOwner.terminalSuffix)
            }
            if (isUserBatch) {
              // SDK already started this turn (its `init` is what got us
              // here) but we have no card to render into. Interrupt so
              // assistant/tool events aren't silently dropped while the
              // model burns tokens. Release the reactions this batch
              // inherited (init handler moved them above) — otherwise
              // they stay ⏳ forever on the user's chat messages.
              log(`session "${this.sessionName}": init-path openTurnCard failed — sendInterrupt + release reactions`)
              this.proc?.sendInterrupt()
              releaseClaimedReactions()
            } else {
              // 恢复轮开卡失败不打断 —— 打断会把正在合并的后台结果整轮
              // 作废。cardless 续窗:此后正文继续进孤儿缓冲。若 result 已在
              // 开卡窗口内到达(不会再有第二次),这里立即兜底,否则由
              // result 处理器 flush。
              this.bgResumeCardless = true
              if (openOwner.sawResult) {
                openOwner.sawResult = false
                log(`session "${this.sessionName}": bg-resume openTurnCard failed, result already arrived — flushing orphan now`)
                this.flushOrphanAssistantToChat('bg-resume open failed, result already arrived')
              } else {
                log(`session "${this.sessionName}": bg-resume openTurnCard failed — orphan text flush will cover the output`)
              }
            }
          } else if (openOwner.sawResult) {
            // 卡片开成了,但这一轮的 result 已在开卡 await 窗口内到达 ——
            // result 处理器当时 currentTurn 还是 null,closeTurnCard 空转了。
            // 这里补一次收尾,否则卡片 footer 永远计时、session 卡在 working。
            openOwner.sawResult = false
            log(`session "${this.sessionName}": result raced card-open — closing freshly-opened turn card now`)
            await this.closeTurnCard(openOwner.terminalSuffix, {
              forcePush: openOwner.terminalForcePush,
              hasFreshResult: true,
            })
            this.status = 'idle'
          } else {
            this.status = 'working'
          }
        } finally {
          this.releaseTurnOpen(openOwner)
        }
      })().catch(e => {
        log(`session "${this.sessionName}": init turn-open handler failed: ${messageOf(e)}`)
      })
    })
    on('scheduled_turn_input', ({ text, promptId }) => {
      if (p.provider !== 'claude' && p.provider !== 'dsh') return
      this.startScheduledTurnCard(p, epoch, text, promptId)
    })
    on('conversation_materialized', ({ session_id: sessionId, source }) => {
      if (p.provider !== 'codex') return
      if (p.sessionId !== sessionId) {
        log(`session "${this.sessionName}": ignore mismatched Codex materialization session=${sessionId} current=${p.sessionId ?? 'MISS'} source=${source}`)
        return
      }
      log(`session "${this.sessionName}": Codex resume point materialized thread=${sessionId} source=${source}`)
      this.persistResumableSessionId()
    })
    on('conversation_materialization_failed', ({ session_id: sessionId, source, error }) => {
      if (p.provider !== 'codex' || p.sessionId !== sessionId) return
      const message = `Codex 会话落盘确认失败，未写恢复点: ${messageOf(error)}`
      const firstReport = this.resumePersistenceError !== message
      this.resumePersistenceError = message
      log(`session "${this.sessionName}": ${message} thread=${sessionId} source=${source}`)
      if (firstReport) void feishu.sendTextRaw(this.chatId, `⚠️ ${message}`)
    })
    on('turn_retry', () => {
      if (this.currentTurn) this.startThinkingFooter(this.currentTurn)
    })
    on('codex_account_changed', ({ accountId, diagnostics }) => {
      log(`session "${this.sessionName}": Codex account=${accountId}`)
      this.pendingAsks.clear()
      this.pendingPermissions.clear()
      if (diagnostics.length) {
        void feishu.sendCard(this.chatId, codexAccountCard({ phase: 'warning', title: '部分账号 MISS',
          message: `${diagnostics.length} 个账号未参与选择`, details: diagnostics.join('\n'), hint: '详情：codex-accounts' })).catch(error => {
          log(`session "${this.sessionName}": 账号诊断卡失败: ${messageOf(error)}`)
        })
      }
    })
    on('turn_started', ({ retry }) => {
      // Codex app-server emits init only at process startup, not for every
      // turn. turn_started is its authoritative claim for an input that was
      // already given an eager-opened card. Claude normally consumed it in
      // init above; this is an idempotent second boundary.
      if ((this.currentTurn || this.openingTurn) && this.pendingUserMessageCount > 0) {
        log(`session "${this.sessionName}": turn_started claimed eager input pendingCount=${this.pendingUserMessageCount}`)
        this.pendingUserMessageCount = 0
      }
      this.persistResumableSessionId()
      if (retry) {
        if (this.currentTurn) this.startThinkingFooter(this.currentTurn)
        // Capacity retries belong to the same visible task. Keep its original
        // usage baseline so work preceding the capacity error is still counted.
        return
      }
      const total = this.proc?.lastTotalUsage
      if (this.usageTotalsSeedUnknown && !total) {
        this.currentTurnUsageBaseline = null
        this.currentTurnUsageBaselineKnown = false
        return
      }
      this.currentTurnUsageBaseline = total ? { ...total } : null
      this.currentTurnUsageBaselineKnown = true
    })
    on('token_usage', ({ totalUsage }: TokenUsageUpdated) => {
      this.persistResumableSessionId()
      if (totalUsage) this.usageTotalsSeedUnknown = false
    })
    on('turn_plan_updated', (plan: TurnPlanUpdated) => {
      this.handleTurnPlanUpdated(plan)
    })
    on('plan_delta', (delta: PlanDelta) => {
      this.handlePlanDelta(delta)
    })
    on('context_compacted', (notice: ContextCompactedNotification) => {
      this.handleContextCompacted(notice)
    })
    on('rate_limits_updated', (rateLimits: any) => {
      // codex rolling 通知 limitId 不可信(2026-08-20 源码核实:上游 SSE/WS
      // 事件缺 metered_limit_name 时,codex 解析器把 limitId 强补 "codex",
      // Spark 桶内容会被贴上主桶标签)—— 通知不写 cache,只观察日志;
      // 权威状态在 turn 收尾用现有连接 read 端点整体刷新(closeTurnCard)。
      // claude 的 rate_limit_info 形状不同,同样不进 codex 快照。
      if (p.provider === 'codex') observeRateLimitsNotification(rateLimits, processCodexAccount(p))
    })
    on('thread_goal_updated', (goal: ThreadGoal) => {
      this.handleThreadGoalUpdated(goal)
    })
    on('thread_goal_cleared', () => {
      this.handleThreadGoalCleared()
    })
    on('assistant_text', ({ text, parentToolUseId }: { text: string; parentToolUseId: string | null }) => {
      // SDK/CLI 若转发子 Agent assistant 正文，会在 parentToolUseId 上标归属；
      // 其工具已进委派面板，正文同样不得泄漏进主对话卡。后台任务的可见进度/
      // 终稿由 task_progress/task_notification 权威事件承载。
      if (parentToolUseId) return
      this.appendAssistant(text)
    })
    on('assistant_block_stop', ({ parentToolUseId }: { parentToolUseId: string | null }) => {
      if (parentToolUseId) return
      // 一段 content block 收尾(SSE content_block_stop)→ 把当前 assistant 段
      // 静态化成完整 markdown,然后 reset 段游标让下一段开新元素。这条 emit 在该段最后一个
      // text_delta 之后同步到达(codex-process 按 stdout 行序 emit),所以
      // appendAssistant 已把全量累进 currentAssistantText,这里定稿拿到的是完整段。
      this.finalizeCurrentAssistantSegment()
      // 主线程定稿一段 assistant = 主 agent 在继续说话、没在等 pending task → 提升后台入卡。
      this.onMainThreadAdvance()
    })
    on('tool_use', ({ id, name, input, parentToolUseId }: { id: string; name: string; input: any; parentToolUseId: string | null }) => {
      // 子 agent 内的工具调用(parentToolUseId 非空)不上主卡 —— 只累积进对应后台
      // task 的 steps[](委派面板展开可见)。与 codex 侧 isSubagentThread 分流同构:
      // 主卡只承载主 agent,子 agent 过程不把主卡面板数刷爆。parentToolUseId 无
      // 归属 task(如 canUseTool 合成的 AskUserQuestion)不在此列,仍走主卡。
      if (parentToolUseId && this.bgTaskOwns(parentToolUseId)) {
        this.applyBgStore(cards.applyBgToolUse(
          { active: this.backgroundTasks, pending: this.pendingBgTasks },
          parentToolUseId, id, name, input,
        ))
        this.onBackgroundTaskChanged()
        return
      }
      if (!parentToolUseId && (name === 'Task' || name === 'Agent'
        || p.provider === 'dsh' && (name === 'subagent' || name === 'subagent_fork'))) {
        const turn = this.currentTurn
        if (turn) {
          this.startWorkingFooter(turn)
          this.finalizeCurrentAssistantSegment()
          turn.openBatchI = null
          turn.taskCreateI = null
          turn.taskUpdateI = null
        }
        this.onMainThreadAdvance()
        this.nativeAgentTools.set(id, { confirmed: false, input })
        // Codex exposes each child separately through collab lifecycle events.
        // Claude's native tool is itself the initial task until task_started
        // supplies its SDK id. Both paths keep launch details off the main card.
        if (p.provider === 'claude') {
          this.lastMainTaskToolUseId = id
          this.applyBgStore(cards.applyBgTaskStarted(this.bgStore(), {
            task_id: id, tool_use_id: id, task_type: 'subagent',
            description: input?.description || input?.name || '子 Agent',
            prompt: input?.prompt, subagent_type: input?.subagent_type,
          }))
          this.onBackgroundTaskChanged(true)
        }
        return
      }
      sessionTools.addTool(this, id, name, input)
      // 主线程发起新 tool_use = 主 agent 没在等 pending 里的 task → 它们是后台,提升入卡。
      // 前台 task 的 settled 先于主线程下一个 tool_use 到达,pending 已空,不会误提。
      if (!parentToolUseId) this.onMainThreadAdvance()
    })
    on('tool_result', ({ tool_use_id, content, is_error, parentToolUseId, input }: any) => {
      // 子 agent 内的工具结果同 tool_use:只回填后台 task steps,不上主卡面板。
      if (parentToolUseId && this.bgTaskOwns(parentToolUseId)) {
        this.applyBgStore(cards.applyBgToolResult(
          { active: this.backgroundTasks, pending: this.pendingBgTasks },
          parentToolUseId, tool_use_id, content, is_error,
        ))
        this.onBackgroundTaskChanged()
        return
      }
      const nativeTool = !parentToolUseId && this.nativeAgentTools.get(tool_use_id)
      if (nativeTool) {
        this.nativeAgentTools.delete(tool_use_id)
        if (this.lastMainTaskToolUseId === tool_use_id) this.lastMainTaskToolUseId = null
        // A background launch receipt is not the child's result. Only an
        // unbound synchronous invocation or a failed launch settles here.
        if (is_error || p.provider === 'claude' && !nativeTool.confirmed && nativeTool.input?.run_in_background !== true) {
          const output = typeof content === 'string' ? content : Array.isArray(content)
            ? content.map((block: any) => typeof block?.text === 'string' ? block.text : JSON.stringify(block)).join('\n')
            : JSON.stringify(content) ?? 'MISS'
          let task = this.backgroundTasks.find(entry => entry.toolUseId === tool_use_id)
          if (!task) {
            this.applyBgStore(cards.applyBgTaskStarted(this.bgStore(), {
              task_id: tool_use_id, tool_use_id, task_type: 'subagent',
              description: nativeTool.input?.description || '子 Agent', prompt: nativeTool.input?.prompt,
            }))
            task = this.backgroundTasks.find(entry => entry.toolUseId === tool_use_id)!
          }
          this.applyBgStore(cards.applyBgTaskSettled(this.bgStore(), {
            task_id: task.id, status: is_error ? 'failed' : 'completed', summary: output,
          }))
          this.onBackgroundTaskChanged(true)
        }
        sessionTools.startThinkingIfNoToolsRunning(this)
        return
      }
      sessionTools.completeTool(this, tool_use_id, content, is_error, input)
    })
    on('can_use_tool', (req: CanUseToolRequest) => {
      sessionPermission.renderPermission(this, req)
    })
    on('hook_callback', (req: HookCallbackRequest) => {
      // No hooks registered → fail-safe ack.
      this.proc?.sendHookResponse(req.request_id, {})
    })
    on('result', (result: any) => {
      const resumePersistenceError = this.persistResumableSessionId()
      const pendingPersistenceError = resumePersistenceError
        ? null
        : this.consumePendingConversationMaterialization()
      const persistenceError = [resumePersistenceError, pendingPersistenceError].filter(Boolean).join('；') || null
      this.accumulateResultStats()
      // result 抢在 openTurnCard 的 await 窗口内到达:标记给开卡 IIFE,
      // 它落地后据此立即收尾(否则卡片悬挂、session 卡在 working)。
      if (this.openingTurnOwner) this.openingTurnOwner.sawResult = true
      // User just hit `stop` — this result is the SDK closing the in-flight
      // turn after sendInterrupt landed. The card already shows `🛑 打断`
      // from the stop path, so skip the rest unconditionally. 被取消轮次的
      // post-interrupt 尾巴随之作废,不兜底推送。
      if (this.userInterrupted) {
        this.userInterrupted = false
        this.discardOrphanAssistant()
        this.bgResumePending = false
        const subtype = this.proc?.lastResult.subtype ?? 'unknown'
        const isError = this.proc?.lastResult.is_error === true
        log(`session "${this.sessionName}": SDK result after user stop subtype=${subtype} isError=${isError} — ignored`)
        this.status = 'idle'
        return
      }
      // 仅后端显式给出本轮 clean checkpoint 时记锚点；失败/中断/畸形
      // result 不得复用上一轮 checkpoint。
      const checkpointError = result?.is_error !== true
        ? this.recordTurnAnchor(result?.checkpoint as ConversationCheckpoint | null | undefined)
        : null
      if (result?.is_error === true) this.lastTurnUserPreview = ''
      // 整轮无卡且不在开卡中(恢复轮开卡失败):孤儿正文纯文本兜底。开卡
      // 窗口内(openingTurn)不 flush —— 让 openTurnCard 把缓冲并入卡片,
      // 避免又推一遍。有卡的轮次已在开卡时并入,这里 flush 为 no-op。
      if (!this.currentTurn && !this.openingTurn) this.flushOrphanAssistantToChat('result with no turn card')
      const hasMidTurn = this.pendingMidTurnMsgs.length > 0
      const isError = this.proc?.lastResult.is_error === true
      const subtype = this.proc?.lastResult.subtype ?? 'success'
      const failureDetail = typeof result?.error === 'string' && result.error.trim()
        ? result.error.trim() : subtype

      let suffix: string | undefined
      let forcePush = false

      const backend = this.proc ? this.backendLabel(this.proc.provider) : this.backendLabel()
      const stateError = [persistenceError, checkpointError].filter(Boolean).join('；') || null
      if (stateError) {
        suffix = `⚠️ ${stateError}`
        forcePush = true
      } else if (hasMidTurn) {
        suffix = isError ? `⚠️ ${backend} ${failureDetail},用户已介入` : '📨 转交新卡'
      } else if (isError) {
        suffix = `⚠️ ${backend} ${failureDetail}`
        forcePush = true
      }

      if (this.openingTurnOwner) {
        this.openingTurnOwner.terminalSuffix = suffix
        this.openingTurnOwner.terminalForcePush = forcePush
      }

      if (stateError && !this.currentTurn && !this.openingTurn) {
        void feishu.sendTextRaw(this.chatId, `⚠️ ${stateError}`)
      }

      log(`session "${this.sessionName}": SDK result subtype=${subtype} isError=${isError} midBuffer=${this.pendingMidTurnMsgs.length} forcePush=${forcePush}`)
      void this.closeTurnCard(suffix, { forcePush, hasFreshResult: true }).catch(e => {
        log(`session "${this.sessionName}": result card close failed: ${messageOf(e)}`)
      })
      this.status = 'idle'

      if (hasMidTurn) {
        void this.drainMidTurnAndOpen().catch(e => {
          log(`session "${this.sessionName}": mid-turn drain failed: ${messageOf(e)}`)
        })
      }
    })
    on('bg_task_started', (e: BgTaskStartedEvent) => {
      // SDK 若没填 tool_use_id,用最近的主线程 Task tool_use id 兜底 —— 子 agent 消息
      //  的 parent_tool_use_id 等于它,据此才能把 steps 关联到 task。
      const toolUseId = e.tool_use_id ?? (p.provider === 'claude' ? this.lastMainTaskToolUseId : null) ?? undefined
      const nativeTool = toolUseId ? this.nativeAgentTools.get(toolUseId) : undefined
      if (nativeTool) nativeTool.confirmed = true
      log(`session "${this.sessionName}": bg_task_started task=${e.task_id} type=${e.task_type ?? '-'} subagent=${e.subagent_type ?? '-'} toolUseId=${toolUseId?.slice(0, 8) ?? '-'} desc=${(e.description ?? '').slice(0, 40)}`)
      this.applyBgStore(cards.applyBgTaskStarted(this.bgStore(), { ...e, tool_use_id: toolUseId }))
      this.onBackgroundTaskChanged(true)
    })
    on('bg_task_progress', (e: BgTaskProgressEvent) => {
      this.applyBgStore(cards.applyBgTaskProgress(this.bgStore(), e))
      this.onBackgroundTaskChanged()
    })
    on('bg_task_updated', (e: BgTaskUpdatedEvent) => {
      this.applyBgStore(cards.applyBgTaskUpdated(this.bgStore(), e))
      this.onBackgroundTaskChanged(!!e.patch.status || e.patch.is_backgrounded === true)
    })
    on('bg_task_settled', (e: BgTaskSettledEvent) => {
      log(`session "${this.sessionName}": bg_task_settled task=${e.task_id} status=${e.status}`)
      this.applyBgStore(cards.applyBgTaskSettled(this.bgStore(), e))
      this.onBackgroundTaskChanged(true)
      // turn 已收尾后才结算的任务:Claude SDK 会自发开一轮恢复轮合并结果,
      // 标记给下一个无用户批次的 init 开卡。Codex 的 collab 子 agent 结果由
      // 主 turn 内的 wait 收编,app-server 不会自发开轮 —— 不置位。
      if (p.provider === 'claude' && !this.currentTurn && !this.openingTurn && this.initCount >= 1) {
        this.bgResumePending = true
      }
    })
    on('subagent_step', (e: { thread_id: string; item_id: string; tool: string; phase: 'started' | 'completed'; brief: string }) => {
      // Codex 子 agent 的过程步骤 → 委派面板 steps(主卡不承载,见 codex-process
      // isSubagentThread 过滤)。未知 thread(先于 started 到达的极早期)丢弃。
      this.applyBgStore(cards.applySubagentStep(this.bgStore(), e.thread_id, e.item_id, e.tool, e.phase, e.brief))
      this.onBackgroundTaskChanged()
    })
    on('exit', ({ code, signal, expected }: any) => {
      log(`session "${this.sessionName}": ${p.provider} exited code=${code} signal=${signal} expected=${expected}`)
      if (this.stoppingProc === p || this.blockedProc === p) {
        if (this.blockedProc === p) {
          const materializationFailure = p.conversationMaterializationFailure?.()
          const persistenceFailure = this.persistResumableSessionId(false, p, false)
          const lateStateFailure = [
            materializationFailure && p.isConversationResumable?.() !== true
              ? `Codex 会话落盘确认失败: ${messageOf(materializationFailure)}`
              : null,
            persistenceFailure,
          ].filter(Boolean).join('；')
          if (lateStateFailure) {
            void feishu.sendTextRaw(this.chatId, `⚠️ 旧进程退出后的恢复状态收尾失败: ${lateStateFailure}`)
          }
          this.discardPendingCodexTurnAnchors(p, 'blocked process finally exited')
        }
        log(`session "${this.sessionName}": blocked/stopping ${p.provider} exit confirmed`)
        this.detachProc(p)
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        return
      }
      this.discardPendingCodexTurnAnchors(p, 'unexpected process exit')
      void this.cancelAgentRuns(`${p.provider} process exited`).catch(error => {
        log(`session "${this.sessionName}": cancel Agent runs after process exit failed: ${messageOf(error)}`)
      })
      const backend = this.backendLabel(p.provider)
      const exitDetail = `code=${code ?? 'null'}, signal=${signal ?? 'null'}`
      const terminalSuffix = expected
        ? `🛑 ${backend} 已退出`
        : `⚠️ ${backend} 异常退出 (${exitDetail})`
      // closeTurnCard captures-and-nulls currentTurn synchronously before its
      // first await. Start it before detaching so the in-flight main card is
      // guaranteed to reach a terminal footer instead of being abandoned in
      // streaming mode.
      if (this.currentTurn) {
        void this.closeTurnCard(terminalSuffix).catch(e => {
          log(`session "${this.sessionName}": process-exit current main-card close failed: ${messageOf(e)}`)
        })
      }
      const turnClose = this.waitForTurnCloses()
        .catch(e => {
          log(`session "${this.sessionName}": process-exit main-card close failed: ${messageOf(e)}`)
        })
      this.detachProc(p)
      // 进程死了,残留的孤儿正文再不兜底就永远丢了(非用户主动停止的崩溃
      // 路径;stop/restart 已在 kill 前 null 掉 this.proc,走上面的 stale
      // 早退不到这里)。
      this.flushOrphanAssistantToChat('process exit')
      this.bgResumePending = false
      this.bgResumeCardless = false
      this.clearMultiMsgBuffer('process exit')
      this.pendingUserMessageCount = 0
      this.pendingMidTurnMsgs = []
      this.pendingTurnInputs = []
      this.lastUserOpenId = ''
      this.releaseAllReactions()
      this.initCount = 0
      this.invalidateTurnOpen()
      // 进程没了 ⇒ 任何 pending ask 都不可能再收到 can_use_tool 或回传答案,
      // 定义上已死。不清的话 hasPendingAsk() 恒 true,后续每条消息都被
      // onAskMessageAnswer 当僵尸答案吞掉,session 焊死到下次 daemon 重启
      // (kill/restart 同样在上面补了这一清理)。
      this.pendingAsks.clear()
      this.pendingPermissions.clear()
      this.userInterrupted = false
      this.currentTurnUsageBaseline = null
      this.currentTurnUsageBaselineKnown = false
      this.usageTotalsSeedUnknown = false
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      void this.runLifecycle('process-exit-cleanup', async () => {
        const settled = await Promise.allSettled([
          turnClose,
          this.resetBackgroundTasks(),
        ])
        for (const outcome of settled) {
          if (outcome.status === 'rejected') {
            log(`session "${this.sessionName}": process-exit terminal cleanup failed: ${messageOf(outcome.reason)}`)
          }
        }
        // `expected` is the process wrapper's explicit contract. Every exit
        // it marks unexpected is user-visible, including code=0 or SIGTERM;
        // filtering those values hid real upstream shutdowns in the past.
        if (!expected) {
          await feishu.sendText(
            this.chatId,
            `⚠️ ${backend} 异常退出 (${exitDetail})。回复任意消息将重新启动。`,
          )
        }
      }).catch(e => {
        log(`session "${this.sessionName}": process-exit cleanup rejected: ${messageOf(e)}`)
      })
    })
  }

  /** Pull per-turn numbers off `proc.lastResult` (set by CodexProcess when
   * the `result` message landed) and roll them into cumStats + the
   * "上一轮" delta. Turn usage uses absolute thread totals from
   * `thread/tokenUsage/updated.total` minus the baseline captured at
   * `turn_started`, so a multi-request turn is aggregated correctly
   * instead of inheriting only the final request's `last` snapshot.
   * Called exactly once per result event, right before closeTurnCard. */
  private accumulateResultStats(): void {
    const r = this.proc?.lastResult
    if (!r) return
    // Claude result.usage is scoped to the just-finished SDK query; after a
    // resumed session starts with no local total baseline, this is the only
    // accurate per-turn figure we have.
    const u = this.currentTurnUsageBaselineKnown
      ? diffUsageTotals(this.proc?.lastTotalUsage, this.currentTurnUsageBaseline)
      : this.proc?.provider === 'claude' && r.usage
        ? { ...r.usage }
        : null
    this.lastTurnUsage = u
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    // 有效 token = 真正喂进(input + 本轮新建缓存)+ 产出。故意不含
    // cache_read_input_tokens —— 那是把整段已缓存上下文又复读一遍的计费量,
    // 每轮几乎等于全窗口,计进来会让累计虚高一个量级。这里的 usage 是
    // 整个 turn 的绝对总量差值,不是最后一次模型请求的快照。
    const tokens = effectiveTurnTokens(u)
    // Claude subscription/router cost fields are not reliable enough to show
    // as billing. Keep Claude turns token-only even if the SDK sends dollars.
    const costUsd = this.proc?.provider === 'claude' ? 0 : r.cost_delta_usd ?? 0
    const durationMs = r.duration_ms ?? 0
    if (tokens != null) this.cumStats.tokens += tokens
    this.cumStats.costUsd += costUsd
    this.cumStats.turns += r.num_turns ?? 1
    this.lastTurnDelta = { tokens, costUsd, durationMs }
  }

  /** Current context-window occupancy. Claude 路径直接读 SDK modelUsage 算好
   * 的输入侧占用(proc.lastContextTokens = input+cache_read+cache_creation,
   * 不含 output);Codex 路径继续用 lastUsage.total_tokens。 */
  private currentContextTokens(proc: AgentProcess | null = this.proc): number | null {
    if (proc?.provider === 'claude' || proc?.provider === 'dsh') {
      return proc.lastContextTokens ?? null
    }
    const u = proc?.lastUsage as CodexUsage | null | undefined
    return contextTokensFromUsage(u)
  }

  /** Display denominator for context percentage. Codex: app-server's
   * effective modelContextWindow;Claude: SDK modelUsage.contextWindow。 */
  private contextLimitForDisplay(proc: AgentProcess | null = this.proc): number | null {
    return contextLimitFromAppServer(proc?.lastContextWindow)
  }

  /** Drain `pendingMidTurnMsgs` to the SDK and open a fresh card for the
   * resulting batch turn. Called from the `result` handler when buffered
   * mid-turn messages need to start their own turn. The `sendUserText`
   * calls wake the SDK polling loop (priority="now" semantics) and
   * comprise the input for the new turn. Opens the card here rather
   * than deferring to init because the init for this batch will arrive
   * with `currentTurn` already set and bail.
   *
   * N 条 wireText 用 `\n\n` join 成 **单条** sendUserText 发给 SDK,而不是
   * N 次独立写。背景:SDK polling loop 在 turn 边界一次只 dequeue 一条
   * user message 进 prompt,N 次独立写会让
   * SDK 把第 1 条单独开 turn、剩 N-1 条进下一 turn —— daemon 这边 panel
   * 在 openTurnCard 时已经 commit 了全部 N 条到 "前一个" turn,跟 SDK
   * 实际 turn 边界错位(03:19 现场 turn=5 panel 7 条 vs 模型只看到 1 条
   * "1 和 2 两条都收到了")。join 成单条后,SDK 看到 1 个 user message,
   * panel 跟模型实际 input 一致。
   *
   * pendingCount 一次 ++(对应一次 sendUserText)。因为 SDK 不再拆 turn,
   * commit 2258af4 当年用累加保护 spurious 第二 turn 的逻辑不再需要 —
   * SDK 不会自发开 user_batch 子 turn。 */
  private async drainMidTurnAndOpen(): Promise<void> {
    if (this.pendingMidTurnMsgs.length === 0) return
    if (this.modelSettingsBlockReason()) return
    const proc = this.proc
    const epoch = this.procEpoch
    if (!proc?.isAlive()) return
    // A result may arrive while a bg-resume card is still migrating/opening.
    // That result also asks us to drain a user message buffered mid-window.
    // Never replace the bg owner: wait until it has attached+closed its own
    // orphan output, then open the user batch as a distinct turn.
    if (!await this.waitForTurnOpenSlot(proc, epoch)) return
    if (this.currentTurn || this.openingTurn || this.pendingMidTurnMsgs.length === 0 || this.modelSettingsBlockReason()) return
    let openOwner: TurnOpenOwner
    try {
      openOwner = this.beginTurnOpen(proc, epoch)
    } catch (error) {
      // Keep the batch and reactions in their pending maps. This guard should
      // be unreachable after waitForTurnOpenSlot, but an invariant violation
      // must never silently delete user input.
      log(`session "${this.sessionName}": mid-turn open ownership conflict: ${messageOf(error)}`)
      return
    }
    const batch = this.pendingMidTurnMsgs
    this.pendingMidTurnMsgs = []
    try {
      // daemon-side state: panel inputs + reaction transfer。不走 sendUserText,
      // SDK 那边由 join 后的单条统一处理。
      for (const msg of batch) {
        this.pendingTurnInputs.push(msg.text)
        if (msg.msgId) {
          const rid = this.pendingReactionIds.get(msg.msgId) ?? ''
          this.currentBatchReactionIds.set(msg.msgId, rid)
          this.pendingReactionIds.delete(msg.msgId)
        }
      }
      // wireText 每条已经在 onUserMessage 内 inline 了自己的 file hint;
      // SDK side files 一律传空,避免 file ↔ message 归属丢失(P1-1)。
      const merged = batch.map(m => m.wireText).join('\n\n')
      const last = batch[batch.length - 1]
      const userOpenId = last?.userOpenId ?? this.lastUserOpenId
      // The card is the rendering transaction for this input. Do not feed the
      // agent until it exists: if sendCard/id_convert fails, the user can
      // safely resend and the model has not already changed files off-screen.
      const opened = await this.openTurnCard(openOwner, userOpenId, 'user_message')
      if (!opened || this.currentTurn !== opened) {
        for (const msg of batch) {
          if (!msg.msgId) continue
          const rid = this.currentBatchReactionIds.get(msg.msgId)
          this.currentBatchReactionIds.delete(msg.msgId)
          if (rid) void feishu.deleteReaction(msg.msgId, rid)
        }
        this.status = 'idle'
        return
      }
      if (this.proc !== proc || this.procEpoch !== epoch || !proc.isAlive()) {
        await this.closeTurnCard(`⚠️ ${this.backendLabel(proc.provider)} 已退出`)
        for (const msg of batch) {
          if (!msg.msgId) continue
          const rid = this.currentBatchReactionIds.get(msg.msgId)
          this.currentBatchReactionIds.delete(msg.msgId)
          if (rid) void feishu.deleteReaction(msg.msgId, rid)
        }
        this.status = 'stopped'
        return
      }
      try {
        if (!await this.sendClaimedUserText(proc, merged)) return
      } catch (e) {
        log(`session "${this.sessionName}": mid-turn sendUserText failed after card open: ${e}`)
        await this.closeTurnCard(`❌ ${this.backendLabel(proc.provider)} 接收消息失败`)
        await feishu.sendTextRaw(
          this.chatId,
          `❌ ${this.backendLabel(proc.provider)} 接收消息失败: ${messageOf(e)}。这批消息未开始处理,请重发。`,
        )
        this.status = 'idle'
        return
      }
      // init/turn_started 消费 sendClaimedUserText 建立的 claim。merge 后 SDK
      // 只看到一条 user message，不再存在需要保留脏 count 等“第二轮”的理由。
      this.status = 'working'
    } finally {
      this.releaseTurnOpen(openOwner)
      // Messages that arrived while this card was opening belong to a later
      // batch. If this batch failed before creating a turn there will be no
      // SDK `result` event to trigger their drain, so hand them off now.
      if (
        !this.currentTurn &&
        this.pendingMidTurnMsgs.length > 0 &&
        this.proc === proc &&
        this.procEpoch === epoch &&
        proc.isAlive()
      ) {
        void this.drainMidTurnAndOpen()
      }
    }
  }

  private async terminalizeSupersededCard(
    cardId: string,
    status: string,
    hasFooter: boolean,
  ): Promise<void> {
    const footerLanded = hasFooter
      ? await cardkit.replaceElementChecked(cardId, cards.ELEMENTS.footer, this.footerElement(status))
      : true
    cardkit.cancelSummary(cardId)
    const settingsLanded = await cardkit.patchSettingsChecked(
      cardId,
      cards.streamingOffSettings({ suffix: status }),
    )
    if (footerLanded && settingsLanded) {
      await cardkit.dispose(cardId)
      return
    }
    const detail = `footer=${footerLanded ? 'ok' : 'MISS'}, settings=${settingsLanded ? 'ok' : 'MISS'}`
    log(`session "${this.sessionName}": superseded card terminal transaction incomplete card=${cardId.slice(0, 12)} ${detail}`)
    await feishu.sendTextRaw(this.chatId, `⚠️ 已作废卡片未能正常关闭 (${detail})。`)
  }

  private async openTurnCard(
    owner: TurnOpenOwner,
    userOpenId: string,
    trigger: TurnState['trigger'],
    opts: { initialFooter?: string; startThinking?: boolean; directStart?: boolean } = {},
  ): Promise<TurnState | null> {
    if (!this.ownsTurnOpen(owner)) return null
    // 任何 turn 开卡都消费掉 pending 的恢复轮标记 —— 若用户消息抢在恢复轮
    // init 前开了卡,SDK 会把结算通知并入该轮,标记留着只会误伤后续空 init。
    this.bgResumePending = false
    const turn = ++this.turnCounter
    // Snapshot+clear pendingTurnInputs synchronously here so concurrent
    // pushes between snapshot and the await don't sneak into THIS turn's
    // panel (they'll be picked up by the next turn's open).
    const userInputs = this.pendingTurnInputs
    this.pendingTurnInputs = []
    this.lastTurnUserPreview = userInputs[0]?.slice(0, 80) ?? this.lastTurnUserPreview
    log(`session "${this.sessionName}": openTurnCard turn=${turn} trigger=${trigger} inputs=${userInputs.length}`)
    const turnSelection = this.runtimeModelSelection()
    const initialFooter = this.withModel(opts.initialFooter ?? 'Waiting...(0s)', turnSelection)
    const card = cards.mainConversationCard({
      sessionName: this.sessionName,
      turn,
      provider: turnSelection.provider,
      model: turnSelection.model ?? undefined,
      effort: turnSelection.effort ?? 'MISS',
      kind: trigger,
      userInputs,
      initialFooter,
      directStart: opts.directStart,
    })
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) {
      if (!this.ownsTurnOpen(owner)) return null
      log(`session "${this.sessionName}": openTurnCard sendCard EXHAUSTED retries — surfacing via raw text`)
      // sendCard already retried 3× through the SDK. If it still came back
      // null we're either on a sustained SDK-axios outage or a Feishu
      // business reject. Either way the user just sent us a message and
      // it's gone into a black hole — surface that explicitly so they
      // know to resend instead of waiting for a reply that won't come.
      // Use raw fetch (not sendText) because if the SDK is the broken
      // thing we'd be doomed to silence otherwise.
      // bg-resume 轮没有"用户这条消息",提示重发只会误导;其输出会走
      // 孤儿缓冲纯文本兜底,这里不必告警。
      if (trigger === 'user_message') {
        await feishu.sendTextRaw(
          this.chatId,
          `❌ 创建对话卡片失败 (Feishu SDK 重试 3 次后仍连不上)。你这条消息尚未送给 ${this.backendLabel()},请稍后重发。`,
        )
      }
      // currentTurn left null as the failure signal. Caller decides
      // whether to sendInterrupt: onUserMessage's eager-open path
      // hasn't fed SDK yet so doesn't need to; the init handler has
      // (SDK started the turn itself) and must.
      return null
    }
    let cardId: string
    try { cardId = await cardkit.convertMessageToCard(messageId) }
    catch (e) {
      log(`session "${this.sessionName}": id_convert failed: ${e}`)
      if (trigger === 'user_message' && this.ownsTurnOpen(owner)) {
        await feishu.sendTextRaw(
          this.chatId,
          `❌ 对话卡片初始化失败。你这条消息尚未送给 ${this.backendLabel()},请稍后重发。`,
        )
      }
      return null
    }
    // Tell cardkit how many elements the initial body already has so
    // its element-count tracker is correct from the first addElement
    // onwards (bg-resume banner + userInputPanel + footer).
    const initialElementCount =
      (trigger === 'bg_task_resume' || trigger === 'scheduled_wakeup' ? 1 : 0) +
      (userInputs.length > 0 ? 1 : 0) +
      1
    if (!this.ownsTurnOpen(owner)) {
      cardkit.recordCardCreated(cardId, initialElementCount)
      await this.terminalizeSupersededCard(cardId, '⚠️ 会话已切换，本卡已作废', true)
      return null
    }
    const turnState: TurnState = {
      cardId,
      ...turnSelection,
      messageId,
      userOpenId,
      trigger,
      toolCount: 0,
      toolByUseId: new Map(),
      planSteps: [],
      planExplanation: null,
      planUpdateCount: 0,
      goalUpdateCount: 0,
      contextCompactCount: 0,
      contextCompactionPending: new Map(),
      contextCompactionCompleted: new Set(),
      contextCompactionCompleting: new Set(),
      contextCompactionEndOnly: new Map(),
      lastContextCompactionCompletedAt: 0,
      lastContextCompactionWasAnonymous: false,
      toolBatches: new Map(),
      openBatchI: null,
      taskCreateI: null,
      taskUpdateI: null,
      taskBoardResetThisTurn: false,
      taskLiveInserted: false,
      planLiveInserted: false,
      assistantSegmentCount: 0,
      currentAssistantSegmentId: null,
      currentAssistantText: '',
      segmentTexts: new Map(),
      startedAt: Date.now(),
      footerStatusHandle: null,
      footerStatusStartedAt: 0,
      footerStatusLabel: null,
      rotating: null,
      rotateCount: 0,
      failureRotateCount: 0,
      cardCapacityFailures: new Map(),
      cardWriteFailureNotices: new Set(),
      cardRotationFailed: false,
      outboundSeenPaths: new Set(),
      outboundSentPaths: new Set(),
      // Eager user cards get their policy when input is handed to the Agent.
      // Backend-driven turns keep the policy the process has already received.
      fileDeliveryMode: trigger === 'user_message' && this.pendingUserMessageCount === 0
        ? undefined
        : this.proc ? this.procFileDeliveryModes.get(this.proc) : undefined,
    }
    cardkit.recordCardCreated(cardId, initialElementCount, (code, failure) => {
      this.onCardWriteFailure(turnState, cardId, code, failure)
    })
    this.currentTurn = turnState
    if (opts.startThinking !== false) this.startThinkingFooter(turnState)
    if (owner.pendingCompactions.length > 0) {
      const buffered = owner.pendingCompactions.splice(0)
      log(`session "${this.sessionName}": replay ${buffered.length} context compaction event(s) buffered during card open`)
      for (const notice of buffered) this.handleContextCompacted(notice)
    }
    // 开卡 await 窗口期(sendCard/id_convert)先到的 assistant 正文攒在
    // 孤儿缓冲里,现在有卡了,作为首段并入 —— 后续 delta 接着正常追加。
    const orphan = this.takeOrphanAssistantText()
    if (orphan) {
      this.appendAssistant(orphan)
      this.finalizeCurrentAssistantSegment()
    }
    return turnState
  }

  /** Cheap synchronous check called from stream handlers right before
   * they `addElement` a new tool / assistant segment / file-tool batch /
   * etc. If the current card is close to Feishu's element ceiling and
   * we haven't already kicked off a rotation, fire-and-forget start a
   * `startMidTurnRotate` and let it run async on its own. The current
   * stream handler still uses `turn.cardId` (the old card) for this
   * iteration — that's fine because (a) cardkit's per-card queue keeps
   * its writes ordered against the soft-close that's about to happen,
   * and (b) the soft limit (CARD_ELEMENT_SOFT_LIMIT=50) sits well under
   * the observed ~75 ceiling, so an in-flight add either fits or — if it
   * doesn't — trips onCardWriteFailure, which rotates reactively anyway. */
  maybeMidTurnRotate(): void {
    const turn = this.currentTurn
    if (!turn) return
    if (turn.rotating) return
    if (!turn.cardRotationFailed && cardkit.getElementCount(turn.cardId) < CARD_ELEMENT_SOFT_LIMIT) return
    this.startMidTurnRotate(turn)
  }

  /** Reactive rotation is reserved for a confirmed card size or component ceiling.
   * `300315` is only a generic add wrapper and also carries duplicate-ID or
   * invalid-schema failures. Those require corrected content; temporary
   * transport failures can recover on the same card. The callback is bound to the
   * TurnState and card id that registered it so a late old-card failure cannot
   * rotate a newer healthy turn/card. */
  onCardWriteFailure(
    owner: TurnState,
    sourceCardId: string,
    code?: number,
    failure?: cardkit.CardWriteFailure,
  ): void {
    const turn = this.currentTurn
    if (turn !== owner) {
      log(`session "${this.sessionName}": ignore stale card failure card=${sourceCardId.slice(0, 12)} code=${code ?? 'n/a'} (turn owner changed)`)
      return
    }
    if (turn.cardId !== sourceCardId) {
      log(`session "${this.sessionName}": ignore retired-card failure card=${sourceCardId.slice(0, 12)} current=${turn.cardId.slice(0, 12)} code=${code ?? 'n/a'}`)
      return
    }
    if (turn.rotating) return
    if (turn.cardRotationFailed) return
    if (!cardkit.isCardCapacityFailure(code, failure)) {
      const operation = failure?.operation ?? 'unknown operation'
      const element = failure?.elementId ? ` element=${failure.elementId}` : ''
      log(`session "${this.sessionName}": non-capacity card write failure card=${sourceCardId.slice(0, 12)} operation=${operation}${element} code=${code ?? 'n/a'} — not rotating`)
      const noticeKey = `${sourceCardId}:${operation}:${failure?.elementId ?? ''}:${code ?? 'MISS'}`
      if (!turn.cardWriteFailureNotices.has(noticeKey)) {
        turn.cardWriteFailureNotices.add(noticeKey)
        void feishu.sendTextRaw(
          this.chatId,
          `⚠️ 对话卡片有一项写入失败(code=${code ?? 'MISS'}, ${operation}${element})。未识别为卡片容量超限，未自动换卡；其余输出继续处理。`,
        )
      }
      return
    }
    const fingerprint = failure?.capacityFingerprint
    if (fingerprint) {
      const notified = turn.cardCapacityFailures.get(fingerprint)
      if (notified !== undefined) {
        log(`session "${this.sessionName}": unchanged content still exceeds card capacity card=${sourceCardId} operation=${failure.operation} element=${failure.elementId ?? 'MISS'} code=${code ?? 'MISS'}`)
        if (!notified) {
          turn.cardCapacityFailures.set(fingerprint, true)
          void feishu.sendTextRaw(
            this.chatId,
            `⚠️ 有一项内容换卡后仍超出飞书容量，写入失败(code=${code ?? 'MISS'}, ${failure.operation}, element=${failure.elementId ?? 'MISS'})；其余输出继续处理。`,
          )
        }
        return
      }
      turn.cardCapacityFailures.set(fingerprint, false)
    }
    log(`session "${this.sessionName}": confirmed card capacity limit (${code}) on card=${turn.cardId.slice(0, 8)}… — rotating to fresh card`)
    turn.failureRotateCount++
    this.startMidTurnRotate(turn)
  }

  /** Open a fresh card under the **same** SDK turn number to dodge
   * Feishu's per-card size or element limit. The old card stays in the chat —
   * we flip its footer to "📨 已续至下一张卡", turn streaming off, and
   * dispose its cardkit state — but it never becomes the writable one
   * again. Turn state is reset so subsequent stream handlers wire up
   * against the new card cleanly; the still-live content is carried over
   * rather than dropped: the in-flight assistant segment (rebuilt and
   * continued) and any unfinished / failed tools (rebuildToolsOnRotate
   * moves them, file-tool batches split out), while already-finished tools stay on
   * the old card. */
  private startMidTurnRotate(turn: TurnState): void {
    if (turn.rotating) return
    turn.rotateCount++
    const oldCardId = turn.cardId
    // 同步快照 tool 簿子 —— swap 会把这俩 Map 换成新的空 Map,旧对象仍被这俩
    // 引用持有(切卡 async 窗口里到达的新 tool 也继续 append 进旧 Map),
    // rebuildToolsOnRotate 用它们把"未完成/建失败"的 tool 搬到新卡。
    // assistant 段不在这里快照:它要带的是 swap 那一刻的最新全文(含切卡窗口期
    // 的 delta),所以放到 swap 时再读 —— 配合 appendAssistant onFailure 在
    // rotating 期间不 reset,这段会一直累积到 swap,窗口期的字一个不丢。
    const oldToolByUseId = turn.toolByUseId
    const oldBatches = turn.toolBatches
    const deferredWriteFailure: {
      value: { code?: number; failure?: cardkit.CardWriteFailure } | null
    } = { value: null }
    const rememberDeferredWriteFailure = (
      code?: number,
      failure?: cardkit.CardWriteFailure,
    ): void => {
      const current = deferredWriteFailure.value
      // Card writes are serialized. Preserve the first rejection as the root
      // cause: later target/duplicate errors can be cascades from an anchor
      // element that the first write failed to create.
      if (!current) {
        deferredWriteFailure.value = { code, failure }
      }
    }
    turn.rotating = (async () => {
      try {
        log(`session "${this.sessionName}": mid-turn rotate triggered card=${oldCardId.slice(0, 8)}… elementCount=${cardkit.getElementCount(oldCardId)}`)
        const card = cards.mainConversationCard({
          sessionName: this.sessionName,
          turn: this.turnCounter,
          provider: turn.provider,
          model: turn.model ?? undefined,
          effort: turn.effort ?? 'MISS',
          kind: 'card_full',
          userInputs: [],
        })
        const newMessageId = await feishu.sendCard(this.chatId, card)
        if (!newMessageId) {
          log(`session "${this.sessionName}": mid-turn rotate sendCard failed — retry on the next content event`)
          if (this.currentTurn === turn) {
            turn.cardRotationFailed = true
            this.stopFooterStatus(turn)
          }
          await feishu.sendTextRaw(
            this.chatId,
            '⚠️ 续卡发送失败，后续内容到达时会再次尝试。',
          )
          return
        }
        let newCardId: string
        try { newCardId = await cardkit.convertMessageToCard(newMessageId) }
        catch (e) {
          log(`session "${this.sessionName}": mid-turn rotate id_convert failed: ${e}`)
          if (this.currentTurn === turn) {
            turn.cardRotationFailed = true
            this.stopFooterStatus(turn)
            await feishu.sendTextRaw(
              this.chatId,
              '⚠️ 续卡已发送，但 Card Kit 初始化失败；后续内容到达时会再次尝试。',
            )
          }
          return
        }
        // card_full body has banner(1) + footer(1) = 2 elements.
        cardkit.recordCardCreated(newCardId, 2, (code, failure) => {
          if (turn.rotating) {
            rememberDeferredWriteFailure(code, failure)
            return
          }
          this.onCardWriteFailure(turn, newCardId, code, failure)
        })
        // 先让旧卡上已经登记的 assistant raw 写入定局，再读取 deadElements、
        // 迁移失败段和 drain mathRenderInflight。rotating 期间 finalize 会早退，
        // 不会再新增旧卡 completed write；这一轮 drain 足以封住 swap 竞态。
        const oldAssistantWrites = turn.assistantWriteInflight?.get(oldCardId)
        if (oldAssistantWrites?.size) {
          await Promise.allSettled([...oldAssistantWrites])
        }
        // 同步 swap：从这一行起,后续 stream handler 看到的 turn.cardId
        // 是新卡。reset 所有 element-id 引用 (toolCount / assistantSegmentCount
        // 等),旧卡上的 element_id 在新卡里查不到,继续 PUT 会 300313。
        this.stopFooterStatus(turn)
        turn.cardId = newCardId
        turn.cardRotationFailed = false
        turn.messageId = newMessageId
        turn.toolCount = 0
        turn.toolByUseId = new Map()
        turn.toolBatches = new Map()
        turn.openBatchI = null
        turn.planUpdateCount = 0
        turn.goalUpdateCount = 0
        // swap 那一刻读当前正在写的段(含切卡 async 窗口里到达的全部 delta ——
        // onFailure 在 rotating 期间不 reset,所以这段一直累积到这里)。先读后清。
        const carrySegId = turn.currentAssistantSegmentId
        const carryText = turn.currentAssistantText ?? ''
        const oldSegmentTexts = turn.segmentTexts
        turn.assistantSegmentCount = 0
        turn.currentAssistantSegmentId = null
        turn.currentAssistantText = ''
        turn.segmentTexts = new Map()
        // Restore the live buffer in the same synchronous swap. Migration
        // awaits below may receive more deltas; those must append to this
        // buffer rather than be overwritten by the pre-migration snapshot.
        if (carrySegId && carryText) {
          const reSegId = cards.ELEMENTS.assistant(turn.assistantSegmentCount++)
          turn.currentAssistantSegmentId = reSegId
          turn.currentAssistantText = carryText
          turn.segmentTexts.set(reSegId, carryText)
        }
        // 渲染状态按卡隔离(review #2):旧卡的 rendered/inflight 条目原样
        // 保留(下面旧卡收尾要 drain + 跳过),新卡从零开始 —— 段 id 重编号
        // 后同名段不会被旧卡标记误伤。
        if (carryText) this.startWritingFooter(turn)
        else this.startThinkingFooter(turn)
        // 先在新卡重建实时任务总览区(紧贴 footer)。必须在 assistant/tool 重建
        // 之前 —— 后者 insert_before taskLiveAnchor(turn),live 区没建就会指向
        // 不存在的 target 而写入失败。taskLiveInserted 是 turn 级 flag,swap 不重置,
        // 新卡照搬本 turn 是否建过实时区,保证换卡后任务总览不丢。
        if (turn.taskLiveInserted) {
          void cardkit.addElement(turn.cardId, cards.taskBoardLiveElement(this.taskBoard), {
            type: 'insert_before', targetElementId: cards.ELEMENTS.footer,
          })
        }
        // 实时计划区同样重建(任务总览正上、顺序与首建一致)。planLiveInserted
        // 同为 turn 级 flag,swap 不重置。
        if (turn.planLiveInserted) {
          void cardkit.addElement(turn.cardId, cards.planLiveElement(turn.planSteps, turn.planExplanation, cards.ELEMENTS.planLive), {
            type: 'insert_before', targetElementId: turn.taskLiveInserted ? cards.ELEMENTS.taskBoardLive : cards.ELEMENTS.footer,
          })
        }
        // A compaction can span the rotation window. Rebuild its in-progress
        // panel on the fresh card and move the pending receipt before the end
        // event arrives; otherwise completion would PUT the disposed old card
        // and leave the visible panel stuck at "压缩中".
        for (const pending of turn.contextCompactionPending.values()) {
          if (pending.cardId !== oldCardId) continue
          pending.cardId = newCardId
          pending.created = false
          pending.createFailure = undefined
          const elementId = cards.ELEMENTS.contextCompact(pending.i)
          pending.createPromise = cardkit.addElementResult(
            newCardId,
            cards.contextCompactionElement(pending.i, pending.notice, elementId),
            {
              type: 'insert_before',
              targetElementId: sessionTools.taskLiveAnchor(turn),
            },
          ).then(result => {
            if (pending.cardId === newCardId) {
              pending.created = result.landed
              pending.createFailure = result.failure
            }
            return result.landed
          })
        }
        // 已完成但在旧卡插入失败的 assistant 段也要搬到新卡。正文现在是
        // block 完成后一次性 addElement；如果这个 addElement 撞上元素上限,
        // cardkit 会把旧元素标 dead 并触发轮转,这里负责补显示。
        for (const [segId, fullText] of oldSegmentTexts) {
          if (carrySegId && carryText && segId === carrySegId) continue
          if (!cardkit.isDeadElement(oldCardId, segId)) continue
          const ri = turn.assistantSegmentCount++
          const reSegId = cards.ELEMENTS.assistant(ri)
          turn.segmentTexts.set(reSegId, fullText)
          // 与主路径共用 checked 原文写入 + 原子公式替换；保留 task board
          // 和其他双后端轮转状态，不在这里复制一套公式事务。
          await this.addCompletedAssistantSegment(turn, reSegId, fullText)
        }
        // 把"还在跑 / 建失败"的 tool 搬到新卡(已完成的留旧卡),Read/Edit 批次切开重建。
        sessionTools.rebuildToolsOnRotate(this, oldCardId, newCardId, oldToolByUseId, oldBatches, turn)
        // A completed tool's old-card add may still be queued at swap time.
        // Once the card id/map have switched, no new handler can enqueue to
        // the old card; drain it, then run the idempotent rebuild pass again
        // so a late rejected add is not lost from both cards.
        await cardkit.flush(oldCardId)
        sessionTools.rebuildToolsOnRotate(this, oldCardId, newCardId, oldToolByUseId, oldBatches, turn)
        // Finished output left on the old page is real pagination progress,
        // even when later tools/paragraphs happen to contain identical text.
        const carriedIds = new Set<string>([
          cards.ELEMENTS.taskBoardLive,
          cards.ELEMENTS.planLive,
          ...[...turn.contextCompactionPending.values()].map(pending => cards.ELEMENTS.contextCompact(pending.i)),
        ])
        if (carrySegId) carriedIds.add(carrySegId)
        for (const meta of oldToolByUseId.values()) {
          if (meta.output == null) carriedIds.add(cards.ELEMENTS.tool(meta.i))
        }
        const retiredContent = cardkit.getWrittenContentElementIds(oldCardId)
          .some(id => !carriedIds.has(id))
        if (retiredContent) turn.cardCapacityFailures.clear()
        // Include queued tool/live-panel migration failures before releasing
        // the rotation lock. Keep unresolved failures until content is left
        // on an old page: a pending compaction completion may retry only after
        // this lock is released, even if its start panel migrated successfully.
        await cardkit.flush(newCardId)
        // 旧卡收尾:footer 红字 + streaming_off + dispose。放到 swap 后
        // 是因为这条链是 async,期间 cardkit 队列上还可能有 add/replace 等;
        // 让它们排在 footer 之前,视觉更连贯。
        try {
          // 旧卡 inflight 公式渲染先 drain(渲染 promise 只写捕获的
          // oldCardId,不会碰新卡)—— 不等的话下面原文 replace 会覆盖
          // 还没落地的渲染版,渲染晚到再写已被 dispose 拒绝(review #2)。
          await sessionTools.waitForImageDeliveries(turn, oldCardId)
          const oldInflight = turn.mathRenderInflight?.get(oldCardId)
          if (oldInflight?.size) {
            await Promise.allSettled([...oldInflight])
          }
          await cardkit.flush(oldCardId)
          // 旧卡上已完成的 assistant 段做最终替换。当前迁移中的半段尚未
          // 插入旧卡,直接跳过,避免同一段同时出现在两张卡上。已渲染段
          // 跳过 —— 原文重渲会把渲染版覆盖回 $$…$$ 降级(review #2)。
          const oldRendered = turn.mathRendered?.get(oldCardId)
          for (const [segId, fullText] of oldSegmentTexts) {
            if (carrySegId && carryText && segId === carrySegId) continue
            if (cardkit.isDeadElement(oldCardId, segId)) continue
            if (oldRendered?.has(segId)) continue
            await cardkit.replaceElement(
              oldCardId,
              segId,
              this.completedAssistantElement(segId, fullText),
            )
          }
          const compactNote = turn.contextCompactCount > 0
            ? ` · 🚨 压缩×${turn.contextCompactCount}`
            : ''
          const footerLanded = await cardkit.replaceElementChecked(
            oldCardId,
            cards.ELEMENTS.footer,
            this.footerElement(this.withModel(`📨 已续至下一张卡 ↓${compactNote}`)),
            { notifyCardFailure: false },
          )
          cardkit.cancelSummary(oldCardId)
          const settingsLanded = await cardkit.patchSettingsChecked(oldCardId, cards.streamingOffSettings({ suffix: '📨 转下一张' }))
          if (footerLanded && settingsLanded) await cardkit.dispose(oldCardId)
          else {
            log(`session "${this.sessionName}": rotate old-card terminal MISS footer=${footerLanded} settings=${settingsLanded}`)
            await feishu.sendTextRaw(
              this.chatId,
              `⚠️ 上一张对话卡未能正常关闭 (footer=${footerLanded ? 'ok' : 'MISS'}, settings=${settingsLanded ? 'ok' : 'MISS'})，本轮输出已续到新卡。`,
            )
          }
        } catch (e) {
          log(`session "${this.sessionName}": mid-turn rotate close-old failed: ${e}`)
        }
        log(`session "${this.sessionName}": mid-turn rotate done old=${oldCardId.slice(0, 8)}… new=${newCardId.slice(0, 8)}…`)
      } finally {
        turn.rotating = null
        // 新卡在 swap/rebuild 窗口里的写失败不能递归换卡；释放本轮锁后
        // 合并触发一次。若 close 已捕获 turn，则由 close 的正文保全处理。
        const deferred = deferredWriteFailure.value
        if (deferred && this.currentTurn === turn) {
          this.onCardWriteFailure(
            turn,
            turn.cardId,
            deferred.code,
            deferred.failure,
          )
        }
      }
    })()
  }

  // Stream-event handlers are intentionally SYNCHRONOUS. Every cardkit op
  // is queued (per-card Promise chain in cardkit.ts), so we fire-and-
  // forget here and rely on enqueue source order — that way no `await`
  // can yield mid-handler and let `closeTurnCard` (or another event) race
  // and mutate `this.currentTurn` underfoot.

  private addPlanSnapshotOnCurrentTurn(): void {
    const turn = this.currentTurn
    if (!turn || turn.planSteps.length === 0) return
    this.maybeMidTurnRotate()
    const cardId = turn.cardId
    const elementId = cards.ELEMENTS.planUpdate(turn.planUpdateCount++)
    void cardkit.addElement(cardId, cards.planElement(turn.planSteps, turn.planExplanation, '', elementId), {
      type: 'insert_before',
      targetElementId: sessionTools.taskLiveAnchor(turn),
    })
  }

  private addGoalUpdateOnCurrentTurn(goal: cards.ThreadGoal): void {
    const turn = this.currentTurn
    if (!turn) return
    this.maybeMidTurnRotate()
    const elementId = cards.ELEMENTS.goalUpdate(turn.goalUpdateCount++)
    void cardkit.addElement(turn.cardId, cards.goalElement(goal, elementId), {
      type: 'insert_before',
      targetElementId: sessionTools.taskLiveAnchor(turn),
    })
  }

  private addGoalClearedOnCurrentTurn(): void {
    const turn = this.currentTurn
    if (!turn) return
    this.maybeMidTurnRotate()
    const elementId = cards.ELEMENTS.goalUpdate(turn.goalUpdateCount++)
    void cardkit.addElement(turn.cardId, {
      tag: 'markdown',
      element_id: elementId,
      content: '**🎯 当前目标**\n\n已清除',
    }, {
      type: 'insert_before',
      targetElementId: sessionTools.taskLiveAnchor(turn),
    })
  }

  private handleContextCompacted(notice: ContextCompactedNotification): void {
    const receiptKeys = compactionReceiptKeys(notice)
    // Standalone `cm` owns its own status card and watcher. Even if a user
    // starts a new turn before that command finishes, its completion must not
    // leak into the new conversation card.
    if (this.manualContextCompactionPending) {
      if (receiptKeys.length > 0) {
        this.rememberContextCompactionReceipt(
          receiptKeys,
          null,
          notice.phase !== 'start',
        )
      }
      if (notice.phase !== 'start') {
        this.lastManualContextCompactionCompletedAt = Date.now()
        this.lastManualContextCompactionWasAnonymous = receiptKeys.length === 0
      }
      log(`session "${this.sessionName}": manual context compaction ${notice.phase ?? 'event'} handled by command status card`)
      return
    }
    if (notice.phase === 'start') {
      this.lastManualContextCompactionWasAnonymous = false
    } else if (
      (receiptKeys.length === 0 || this.lastManualContextCompactionWasAnonymous) &&
      Date.now() - this.lastManualContextCompactionCompletedAt < ANONYMOUS_COMPACTION_DEDUPE_MS
    ) {
      log(`session "${this.sessionName}": late anonymous manual compaction duplicate ignored`)
      return
    }

    const turn = this.currentTurn
    const itemReceiptKey = notice.itemId ? `item:${notice.itemId}` : undefined
    const turnReceiptKey = receiptKeys.find(candidate => candidate.startsWith('turn:'))
    let receiptLookupKey = itemReceiptKey ?? turnReceiptKey
    let receipt = receiptLookupKey
      ? this.contextCompactionReceipts.get(receiptLookupKey)
      : undefined
    // The generic turn notification and item notification may arrive in
    // either order. A near-simultaneous completed turn alias closes the same
    // physical event; a later explicit item remains eligible as a new one.
    if (itemReceiptKey && !receipt && notice.phase !== 'start' && turnReceiptKey) {
      const turnReceipt = this.contextCompactionReceipts.get(turnReceiptKey)
      if (
        (!turnReceipt?.hasItemAlias && turnReceipt?.completed &&
          Date.now() - turnReceipt.completedAt < ANONYMOUS_COMPACTION_DEDUPE_MS) ||
        (!turnReceipt?.hasItemAlias && turnReceipt?.completionKey &&
          turn?.contextCompactionCompleting.has(turnReceipt.completionKey))
      ) {
        receiptLookupKey = turnReceiptKey
        receipt = turnReceipt
        // Claim this explicit item as the item-side alias of the generic
        // receipt. Later distinct items in the same turn must remain new.
        turnReceipt.hasItemAlias = true
        this.contextCompactionReceipts.delete(itemReceiptKey)
        this.contextCompactionReceipts.set(itemReceiptKey, turnReceipt)
      }
    }

    if (!turn) {
      if (this.openingTurnOwner?.backendTurnStarted) {
        this.openingTurnOwner.pendingCompactions.push(notice)
        log(`session "${this.sessionName}": buffer context compaction ${notice.phase ?? 'event'} while turn card opens`)
        return
      }
      if (receiptKeys.length > 0) {
        this.rememberContextCompactionReceipt(receiptKeys, null, notice.phase !== 'start')
      }
      // A terminal compaction notification may legally arrive after result.
      // It carries no assistant content and needs no user action.
      log(`session "${this.sessionName}": context compaction ${notice.phase ?? 'event'} with no current turn thread=${notice.threadId ?? '-'} turn=${notice.turnId ?? '-'} item=${notice.itemId ?? '-'}`)
      return
    }

    if (receiptLookupKey && receipt?.completed) {
      log(`session "${this.sessionName}": duplicate context compaction ${notice.phase ?? 'event'} ignored receipt=${receiptLookupKey}`)
      return
    }
    const ownerId = this.contextCompactionOwnerId(turn)
    if (receiptLookupKey && receipt && receipt.ownerId !== ownerId) {
      this.rememberContextCompactionReceipt(receiptKeys, null, true)
      log(`session "${this.sessionName}": late context compaction ${notice.phase ?? 'event'} ignored receipt=${receiptLookupKey} (turn owner changed)`)
      return
    }
    if (
      receiptLookupKey &&
      receipt?.completionKey &&
      turn.contextCompactionCompleting.has(receipt.completionKey)
    ) {
      log(`session "${this.sessionName}": context compaction alias already writing receipt=${receiptLookupKey}`)
      return
    }
    if (
      notice.phase !== 'start' &&
      receiptKeys.length > 0 &&
      turn.contextCompactionPending.size === 0 &&
      turn.contextCompactionCompleting.has('__anonymous__')
    ) {
      log(`session "${this.sessionName}": identified context compaction duplicate ignored while anonymous completion writes`)
      return
    }
    if (
      notice.phase !== 'start' &&
      receiptKeys.length > 0 &&
      turn.contextCompactionPending.size === 0 &&
      turn.lastContextCompactionWasAnonymous &&
      Date.now() - turn.lastContextCompactionCompletedAt < ANONYMOUS_COMPACTION_DEDUPE_MS
    ) {
      log(`session "${this.sessionName}": identified context compaction duplicate ignored after anonymous completion`)
      return
    }

    if (notice.phase === 'start') {
      const key = compactionKey(notice)
      if (turn.contextCompactionPending.has(key) || turn.contextCompactionCompleted.has(key)) {
        log(`session "${this.sessionName}": duplicate context compaction start ignored key=${key}`)
        return
      }
      this.startWorkingFooter(turn)
      if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
      turn.openBatchI = null
      this.maybeMidTurnRotate()
      turn.lastContextCompactionWasAnonymous = false
      if (receiptKeys.length > 0) {
        this.rememberContextCompactionReceipt(receiptKeys, ownerId, false)
      }
      const i = turn.contextCompactCount++
      const cardId = turn.cardId
      const elementId = cards.ELEMENTS.contextCompact(i)
      const pending = {
        i,
        cardId,
        notice,
        created: false,
        createFailure: undefined as cardkit.CardWriteFailure | undefined,
        createPromise: Promise.resolve(false),
      }
      pending.createPromise = cardkit.addElementResult(
        cardId,
        cards.contextCompactionElement(i, notice, elementId),
        {
          type: 'insert_before',
          targetElementId: sessionTools.taskLiveAnchor(turn),
        },
      ).then(result => {
        if (pending.cardId === cardId) {
          pending.created = result.landed
          pending.createFailure = result.failure
        }
        return result.landed
      })
      turn.contextCompactionPending.set(key, pending)
      log(`session "${this.sessionName}": context compaction start #${i + 1} key=${key}`)
      cardkit.patchSummaryThrottled(turn.cardId, `🚨 压缩×${turn.contextCompactCount}`)
      return
    }

    if (
      !notice.itemId &&
      !notice.turnId &&
      turn.contextCompactionCompleting.size > 0
    ) {
      log(`session "${this.sessionName}": anonymous context compaction duplicate ignored while completion writes`)
      return
    }
    if (
      !notice.itemId &&
      !notice.turnId &&
      turn.contextCompactionPending.size === 0 &&
      Date.now() - turn.lastContextCompactionCompletedAt < ANONYMOUS_COMPACTION_DEDUPE_MS
    ) {
      log(`session "${this.sessionName}": immediate anonymous context compaction duplicate ignored`)
      return
    }
    const explicitKey = notice.itemId || notice.turnId
    if (explicitKey && turn.contextCompactionCompleted.has(explicitKey)) {
      log(`session "${this.sessionName}": duplicate context compaction completion ignored key=${explicitKey}`)
      return
    }
    const key = notice.itemId
      ? (turn.contextCompactionPending.has(notice.itemId) ? notice.itemId : null)
      : latestPendingCompactionKey(turn)
    const pending = key ? turn.contextCompactionPending.get(key) : undefined
    const completionKey = key ?? explicitKey ?? '__anonymous__'
    if (turn.contextCompactionCompleting.has(completionKey)) {
      log(`session "${this.sessionName}": context compaction completion already writing key=${completionKey}`)
      return
    }

    this.startWorkingFooter(turn)
    if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
    turn.openBatchI = null
    this.maybeMidTurnRotate()
    const merged = mergeCompactionNotices(pending?.notice, notice)
    const priorEndOnlyI = turn.contextCompactionEndOnly.get(completionKey)
    const i = pending?.i ?? priorEndOnlyI ?? turn.contextCompactCount++
    if (!pending && priorEndOnlyI === undefined) {
      turn.contextCompactionEndOnly.set(completionKey, i)
    }
    turn.contextCompactionCompleting.add(completionKey)
    const completionReceiptKeys = [...new Set([
      ...compactionReceiptKeys(pending?.notice ?? {}),
      ...receiptKeys,
    ])]
    if (completionReceiptKeys.length > 0) {
      this.rememberContextCompactionReceipt(
        completionReceiptKeys,
        ownerId,
        false,
        completionKey,
      )
    }
    const elementId = cards.ELEMENTS.contextCompact(i)
    const element = cards.contextCompactionElement(i, merged, elementId)
    log(`session "${this.sessionName}": context compaction completion write #${i + 1} key=${completionKey}`)
    void (async () => {
      let landed = false
      if (!pending) {
        while (true) {
          const targetCardId = turn.cardId
          landed = await cardkit.addElementChecked(targetCardId, element, {
            type: 'insert_before',
            targetElementId: sessionTools.taskLiveAnchor(turn),
          })
          if (landed) break
          const rotation = turn.rotating
          if (rotation) {
            await rotation
            continue
          }
          if (turn.cardId !== targetCardId) continue
          break
        }
      } else {
        // A start add and rotation copy may still be in flight. Always finish
        // the latest authoritative card; a failed start is retried as an add
        // of the terminal element, not a PUT to a phantom id.
        while (true) {
          const targetCardId = pending.cardId
          await pending.createPromise
          if (pending.cardId !== targetCardId) continue
          if (pending.created) {
            landed = await cardkit.replaceElementChecked(targetCardId, elementId, element)
          } else {
            if (cardkit.isDuplicateElementFailure(
              pending.createFailure?.code,
              pending.createFailure,
            )) {
              cardkit.clearDeadElementForReconcile(targetCardId, elementId)
              landed = await cardkit.replaceElementChecked(
                targetCardId,
                elementId,
                element,
                { notifyCardFailure: false },
              )
            }
            if (!landed) {
              landed = await cardkit.addElementChecked(targetCardId, element, {
                type: 'insert_before',
                targetElementId: sessionTools.taskLiveAnchor(turn),
              })
            }
          }
          if (pending.cardId !== targetCardId) continue
          if (landed) {
            pending.created = true
            break
          }
          const rotation = turn.rotating
          if (rotation) {
            await rotation
            continue
          }
          if (pending.cardId !== targetCardId) continue
          break
        }
      }
      turn.contextCompactionCompleting.delete(completionKey)
      if (!landed) {
        log(`session "${this.sessionName}": context compaction completion write MISS #${i + 1} key=${completionKey}`)
        return
      }
      if (key && turn.contextCompactionPending.get(key) === pending) {
        turn.contextCompactionPending.delete(key)
      }
      turn.contextCompactionEndOnly.delete(completionKey)
      if (completionKey !== '__anonymous__') {
        turn.contextCompactionCompleted.add(completionKey)
      }
      turn.lastContextCompactionCompletedAt = Date.now()
      turn.lastContextCompactionWasAnonymous = completionKey === '__anonymous__'
      if (completionReceiptKeys.length > 0) {
        const claimedAliases = [...this.contextCompactionReceipts.entries()]
          .filter(([, candidate]) => candidate.completionKey === completionKey)
          .map(([alias]) => alias)
        this.rememberContextCompactionReceipt(
          [...new Set([...completionReceiptKeys, ...claimedAliases])],
          null,
          true,
        )
      }
      log(`session "${this.sessionName}": context compaction completed #${i + 1} key=${completionKey}`)
    })().catch(error => {
      turn.contextCompactionCompleting.delete(completionKey)
      log(`session "${this.sessionName}": context compaction completion transaction failed: ${messageOf(error)}`)
    })
    cardkit.patchSummaryThrottled(turn.cardId, `🚨 压缩×${turn.contextCompactCount}`)
  }

  private contextCompactionOwnerId(turn: TurnState): number {
    const current = this.contextCompactionOwnerIds.get(turn)
    if (current !== undefined) return current
    const id = ++this.contextCompactionOwnerSequence
    this.contextCompactionOwnerIds.set(turn, id)
    return id
  }

  private rememberContextCompactionReceipt(
    keys: string[],
    ownerId: number | null,
    completed: boolean,
    completionKey?: string,
  ): void {
    const receipt = {
      ownerId: completed ? null : ownerId,
      completed,
      completedAt: completed ? Date.now() : 0,
      ...(completed || !completionKey ? {} : { completionKey }),
      hasItemAlias: keys.some(key => key.startsWith('item:')),
    }
    for (const key of keys) {
      this.contextCompactionReceipts.delete(key)
      this.contextCompactionReceipts.set(key, receipt)
    }
    while (this.contextCompactionReceipts.size > MAX_CONTEXT_COMPACTION_RECEIPTS) {
      let victim: {
        ownerId: number | null
        completed: boolean
        completedAt: number
        completionKey?: string
        hasItemAlias: boolean
      } | undefined
      for (const candidate of this.contextCompactionReceipts.values()) {
        if (candidate.completed) { victim = candidate; break }
        victim ??= candidate
      }
      if (!victim) break
      // Aliases for one receipt are an atomic tombstone. Remove all together
      // so eviction never leaves item-only or turn-only half-state behind.
      for (const [key, candidate] of this.contextCompactionReceipts) {
        if (candidate === victim) this.contextCompactionReceipts.delete(key)
      }
    }
  }

  private handleTurnPlanUpdated(update: TurnPlanUpdated): void {
    const turn = this.currentTurn
    if (!turn) {
      log(`session "${this.sessionName}": turn/plan/updated with no current turn`)
      return
    }
    this.startWorkingFooter(turn)
    if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
    turn.openBatchI = null
    if (!Array.isArray(update.plan)) {
      log(`session "${this.sessionName}": turn/plan/updated missing plan array`)
      turn.planSteps = []
    } else {
      turn.planSteps = update.plan.map(step => ({
        step: typeof step.step === 'string' && step.step ? step.step : 'MISS',
        status: typeof step.status === 'string' && step.status ? step.status : 'MISS',
      }))
    }
    turn.planExplanation = typeof update.explanation === 'string' ? update.explanation : null
    // 实时计划区:首次 plan 更新建立(任务总览正上),之后 replace 成最新快照 ——
    // codex 的 turn/plan/updated 每次都带完整计划,这里让卡片末尾永远是最新的,
    // 与 claude 侧任务总览(taskBoardLive)常驻语义一致。timeline 快照仍照旧插入
    // (过程变更记录)。空 plan(steps 为空/畸形数组)与 timeline 快照的守卫
    // (addPlanSnapshotOnCurrentTurn 跳过空 steps)对齐:不建立也不刷掉已建立的
    // —— 否则一次空更新会把 live 面板 replace 成 '--' 占位,刷掉上一次有效计划。
    if (turn.planSteps.length > 0) {
      if (!turn.planLiveInserted) {
        // 目标锚点先于置位计算:置位后 taskLiveAnchor 会返回 plan_live 自身。
        const target = turn.taskLiveInserted ? cards.ELEMENTS.taskBoardLive : cards.ELEMENTS.footer
        turn.planLiveInserted = true
        void cardkit.addElement(turn.cardId, cards.planLiveElement(turn.planSteps, turn.planExplanation, cards.ELEMENTS.planLive), {
          type: 'insert_before', targetElementId: target,
        })
      } else {
        void cardkit.replaceElement(turn.cardId, cards.ELEMENTS.planLive, cards.planLiveElement(turn.planSteps, turn.planExplanation, cards.ELEMENTS.planLive))
      }
    }
    this.addPlanSnapshotOnCurrentTurn()
  }

  private handlePlanDelta(delta: PlanDelta): void {
    if (typeof delta.delta !== 'string' || !delta.delta) {
      log(`session "${this.sessionName}": item/plan/delta missing delta text`)
      return
    }
    if (typeof delta.itemId !== 'string' || !delta.itemId) {
      log(`session "${this.sessionName}": item/plan/delta missing itemId`)
    }
  }

  private handleThreadGoalUpdated(goal: ThreadGoal): void {
    if (!goal || typeof goal.objective !== 'string') {
      log(`session "${this.sessionName}": thread/goal/updated missing objective`)
      return
    }
    if (goal.tokenBudget != null && typeof goal.tokenBudget !== 'number') {
      log(`session "${this.sessionName}": thread/goal/updated invalid tokenBudget`)
    }
    const previousGoal = this.currentGoal
    const currentGoal: cards.ThreadGoal = {
      objective: goal.objective,
      status: typeof goal.status === 'string' && goal.status ? goal.status : 'MISS',
      tokenBudget: typeof goal.tokenBudget === 'number'
        ? goal.tokenBudget
        : goal.tokenBudget === null
          ? null
          : Number.NaN,
      tokensUsed: typeof goal.tokensUsed === 'number' ? goal.tokensUsed : Number.NaN,
      timeUsedSeconds: typeof goal.timeUsedSeconds === 'number' ? goal.timeUsedSeconds : Number.NaN,
    }
    this.currentGoal = currentGoal
    if (
      previousGoal &&
      cards.goalDisplaySignature(previousGoal) === cards.goalDisplaySignature(currentGoal)
    ) {
      return
    }
    const turn = this.currentTurn
    if (turn) {
      this.startWorkingFooter(turn)
      if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
      turn.openBatchI = null
    }
    this.addGoalUpdateOnCurrentTurn(currentGoal)
  }

  private handleThreadGoalCleared(): void {
    if (!this.currentGoal) return
    this.currentGoal = null
    const turn = this.currentTurn
    if (!turn) return
    this.startWorkingFooter(turn)
    if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
    turn.openBatchI = null
    this.addGoalClearedOnCurrentTurn()
  }

  private appendAssistant(delta: string): void {
    if (!this.currentTurn) {
      // 只在合法无卡窗口缓冲:正在开卡(openingTurn),或恢复轮开卡失败后
      // 的续窗(bgResumeCardless)。其余无卡场景(被打断的轮尾、进程 kill
      // 窗口的残字、轮间游离 delta)一律丢弃 —— 缓冲下来只会被错误推送或
      // 并入下一张不相干的卡(旧代码此处直接 return 丢弃,行为一致)。
      if (this.openingTurn || this.bgResumeCardless) this.orphanAssistantCurrent += delta
      return
    }
    const turn = this.currentTurn
    // 第一条 assistant text_delta 到达 → footer 切到 Writing 计时。
    // 正文自身只进入内存缓冲,等 agentMessage completed 后一次性插入卡片。
    this.startWritingFooter(turn)
    if (!turn.currentAssistantSegmentId) {
      // New assistant segment opens a visual break — any prior file-tool run
      // is now visually separated from future calls, so close the batch
      // window. Future file-tool calls will start a fresh batch at a new i.
      turn.openBatchI = null
      // Pre-empt the 300305 component-count cliff (which Card Kit may wrap
      // inside a generic 300315 add failure) —
      // if the card's element count is approaching Feishu's cap, fire-and-
      // forget kick off a mid-turn rotation onto a fresh card before this
      // buffered segment is eventually inserted. The rotation handler resets
      // turn state once the new card is up so subsequent stream handlers see
      // the new cardId.
      this.maybeMidTurnRotate()
      const i = turn.assistantSegmentCount++
      const segId = cards.ELEMENTS.assistant(i)
      turn.currentAssistantSegmentId = segId
      turn.currentAssistantText = ''
    }
    turn.currentAssistantText += delta
    const segId = turn.currentAssistantSegmentId
    if (!segId) return
    turn.segmentTexts.set(segId, turn.currentAssistantText)
    this.processOutboundMarkers(turn.currentAssistantText)
    const displayText = this.cleanAssistantTextForDisplay(turn.currentAssistantText)
    // Chat-list preview: head of the latest assistant text (~40 chars —
    // 开头即主题,流式期间稳定不闪;尾部截断会把 markdown 语法尾巴糊进列表行)。
    // Feishu truncates anyway. patchSummaryThrottled is rate-limited on its own.
    const head = displayText.slice(0, 40)
    cardkit.patchSummaryThrottled(turn.cardId, head)
  }

  /** 取走并清空孤儿 assistant 缓冲(定稿段 + 未定稿尾段,空行分隔)。 */
  private takeOrphanAssistantText(): string {
    const parts = [...this.orphanAssistantSegments]
    if (this.orphanAssistantCurrent.trim()) parts.push(this.orphanAssistantCurrent)
    this.orphanAssistantSegments = []
    this.orphanAssistantCurrent = ''
    return parts.join('\n\n').trim()
  }

  /** 丢弃孤儿缓冲并复位 cardless 续窗标记 —— 用户主动作废(打断/停止/重启)
   *  或进程被替换时调用,内容随轮作废不兜底。 */
  private discardOrphanAssistant(): void {
    this.orphanAssistantSegments = []
    this.orphanAssistantCurrent = ''
    this.bgResumeCardless = false
  }

  /** 无卡兜底:孤儿正文以纯文本消息推进聊天 —— 宁可丢排版,不可丢内容。 */
  private flushOrphanAssistantToChat(reason: string): void {
    const text = this.takeOrphanAssistantText()
    if (!text) return
    const display = this.cleanAssistantTextForDisplay(text).trim()
    if (!display) return
    log(`session "${this.sessionName}": flushing ${display.length} chars of orphan assistant text (${reason})`)
    void feishu.sendText(this.chatId, `📄 后台轮输出(未能建卡,纯文本兜底):\n\n${display}`)
  }

  private completedAssistantElement(segId: string, text: string): object {
    if (mathRender.hasMathSpans(text)) {
      return this.mathAssistantContainer(segId, [{ type: 'markdown', text }])
    }
    return {
      tag: 'markdown',
      element_id: segId,
      content: this.cleanAssistantTextForDisplay(text).trim() || ' ',
    }
  }

  /** 公式段从 raw 到 rendered 始终保持同一个顶层 column_set tag；内部
   *  children 严格按源码顺序交错 markdown/img。这样一次 checked PUT 就能
   *  原子完成 A→公式→B→公式→C，不再把所有图片堆到整段末尾。 */
  private mathAssistantContainer(segId: string, blocks: mathRender.RenderedMathBlock[]): object {
    const elements = blocks.map(block => block.type === 'markdown'
      ? {
          tag: 'markdown',
          content: this.cleanAssistantTextForDisplay(block.text).trim() || ' ',
        }
      : { ...block.element })
    return {
      tag: 'column_set',
      element_id: segId,
      flex_mode: 'none',
      columns: [{
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: elements.length ? elements : [{ tag: 'markdown', content: ' ' }],
      }],
    }
  }

  /** 把 raw column_set 原子替换成严格原位交错的 markdown/image 子元素链。
   *  cardId 是调度时捕获的快照，不能在异步渲染后读取 turn.cardId。公式增强
   *  失败不触发整卡轮转：raw LaTeX 已经可见，保留它并暴露日志即可。 */
  private async replaceSegmentWithMathImgs(turn: TurnState, cardId: string, segId: string, text: string): Promise<void> {
    const rendered = await mathRender.renderMathInText(text)
    const okReplace = await cardkit.replaceElementChecked(
      cardId,
      segId,
      this.mathAssistantContainer(segId, rendered.blocks),
      { notifyCardFailure: false },
    )
    if (!okReplace) {
      log(`session "${this.sessionName}": math render ${segId} write dropped (card closed/element dead) — raw text stays`)
      return
    }

    turn.mathRendered ??= new Map()
    turn.mathRendered.get(cardId) ?? (turn.mathRendered.set(cardId, new Set()), undefined)
    turn.mathRendered.get(cardId)!.add(segId)
    log(`session "${this.sessionName}": math rendered ${segId} (${rendered.renderedImageCount} img, ${rendered.blocks.length} blocks)`)
  }

  private addCompletedAssistantSegment(turn: TurnState, segId: string, text: string): Promise<boolean> {
    // 先确认原文容器真实落地，再启动公式渲染。checked 写入与公式 promise
    // 都按 cardId 分组登记，close 会依次 drain，避免幽灵元素和 dispose 竞态。
    const cardId = turn.cardId
    const targetElementId = sessionTools.taskLiveAnchor(turn)
    const write = (async (): Promise<boolean> => {
      const added = await cardkit.addElementChecked(
        cardId,
        this.completedAssistantElement(segId, text),
        { type: 'insert_before', targetElementId },
      )
      if (!added) {
        log(`session "${this.sessionName}": assistant segment ${segId} raw write failed on card=${cardId}`)
        return false
      }

      if (mathRender.hasMathSpans(text)) {
        const rp = this.replaceSegmentWithMathImgs(turn, cardId, segId, text)
          .catch(e => log(`session "${this.sessionName}": math render ${segId} failed: ${e}`))
        turn.mathRenderInflight ??= new Map()
        turn.mathRenderInflight.get(cardId) ?? (turn.mathRenderInflight.set(cardId, new Set()), undefined)
        turn.mathRenderInflight.get(cardId)!.add(rp)
        void rp.finally(() => turn.mathRenderInflight?.get(cardId)?.delete(rp))
      }
      return true
    })()
    turn.assistantWriteInflight ??= new Map()
    turn.assistantWriteInflight.get(cardId) ?? (turn.assistantWriteInflight.set(cardId, new Set()), undefined)
    turn.assistantWriteInflight.get(cardId)!.add(write)
    void write.finally(() => turn.assistantWriteInflight?.get(cardId)?.delete(write))
    return write
  }

  /** CardKit 正文写入失败时显式保全完整回复；不伪装卡片成功。 */
  private async sendAssistantTextFallback(text: string, reason: string): Promise<void> {
    const raw = text.trim()
    if (!raw) return
    const message = `⚠️ 对话卡片正文写入失败(${reason}),以下为 agent 原始回复:\n\n${raw}`
    const sent = await feishu.sendText(this.chatId, message)
    if (!sent) {
      log(`session "${this.sessionName}": ASSISTANT_TEXT_PRESERVATION_FAILED (${reason}, ${raw.length} chars)`)
    }
  }

  /** 收尾当前 assistant 段:正文不再逐字流式输出,只在完整段收到后
   * 一次性插入静态 markdown,然后清空段游标。 */
  finalizeCurrentAssistantSegment(): void {
    const turn = this.currentTurn
    if (!turn) {
      // 无卡窗口的段边界:当前孤儿段定稿进列表,flush 时段间以空行分隔。
      if (this.orphanAssistantCurrent.trim()) this.orphanAssistantSegments.push(this.orphanAssistantCurrent)
      this.orphanAssistantCurrent = ''
      return
    }
    // 正在切卡:别动当前段 —— rotate 会在 swap 时读 currentAssistantText carry
    // 到新卡续写。这里若定稿/reset,过渡窗口里的当前段文字会被清空、carry 落空
    // (跟 appendAssistant onFailure 在 rotating 期间不 reset 同一个道理)。代价是
    // 切卡窗口恰好跨 block 边界时两段可能并作一段 —— 不丢内容,可接受。
    if (turn.cardRotationFailed) this.maybeMidTurnRotate()
    if (turn.rotating) return
    const segId = turn.currentAssistantSegmentId
    const text = turn.currentAssistantText ?? ''
    if (segId && text.trim()) {
      void this.addCompletedAssistantSegment(turn, segId, text)
      this.startWorkingFooter(turn)
    }
    turn.currentAssistantSegmentId = null
    turn.currentAssistantText = ''
  }

  /** 从一段文字里找完整 [[send: /abs/path]] 标记,一看到就立即发。正文保留
   * 原标记不改,让用户知道触发了哪个文件路径。 */
  private processOutboundMarkers(text: string): void {
    for (const path of extractSendMarkerPaths(text)) {
      this.sendOutboundPath(path, 'send marker')
    }
  }

  private cleanAssistantTextForDisplay(text: string): string {
    // sanitize 把外链图片降级、HTML 实体转义 —— LLM 正文里出现 ![alt](url)
    // 会让该 assistant 段 CardKit 更新失败(ErrCode 200570),必须先清掉。
    return cards.sanitizeMarkdownForCardKit(text)
  }

  sendOutboundPath(rawPath: string, source: string): void {
    // 归一化 MSYS/Git Bash 风格路径(/c/Users/... → C:\Users\...);否则
    // Windows 上 statSync 把 /c 当成当前盘根下的相对路径,stat 成
    // C:\c\Users\... 而 ENOENT。
    const p = normalizeOutboundPath(rawPath.trim())
    if (!p) return
    const turn = this.currentTurn
    if (turn?.outboundSeenPaths.has(p)) return
    turn?.outboundSeenPaths.add(p)
    if (!isAbsolute(p)) {
      log(`session "${this.sessionName}": ignore non-absolute outbound path from ${source}: ${p}`)
      return
    }
    log(`session "${this.sessionName}": outbound send from ${source}: ${p}`)
    try {
      // Input can reach the backend before its card opens. Reuse its injected
      // policy even if the group switch changed during that opening window.
      const mode = turn?.fileDeliveryMode
        ?? (this.proc ? this.procFileDeliveryModes.get(this.proc) : undefined)
        ?? this.getFileDeliveryMode()
      if (turn) turn.fileDeliveryMode = mode
      if (mode === 'chat') {
        turn?.outboundSentPaths.add(p)
        void feishu.uploadAndSend(this.chatId, p)
        return
      }
      if (!turn) throw new Error('当前没有可关联的交付轮次')
      if (!turn.fileDelivery) {
        turn.fileDelivery = this.createFileDeliveryForTurn(turn)
        this.fileDeliveries.add(turn.fileDelivery)
      }
      turn.fileDelivery.add(p)
    } catch (error) {
      log(`session "${this.sessionName}": file delivery rejected: ${messageOf(error)}`)
      void feishu.sendText(this.chatId, `❌ 文件交付失败：${messageOf(error)}`)
    }
  }

  createFileDeliveryForTurn(turn: TurnState) {
    return createFileDelivery({
      chatId: this.chatId,
      managerOpenId: turn.userOpenId,
      projectName: this.sessionName,
      createdAt: turn.startedAt,
    })
  }

  /** Start or switch the turn footer phase. It lives in the stable footer
   * element and uses replaceElement so status updates appear immediately
   * instead of invoking Feishu's typewriter. */
  private startFooterStatus(turn: TurnState, status: string): void {
    // 续卡失败时暂停定时刷新；后续真实内容触发重试，成功后恢复。
    if (turn.cardRotationFailed) return
    const retry = turn.provider === 'codex' ? this.proc?.turnRetry : null
    if (retry) {
      status = retry.reason === 'quota' ? `⏳ ${retry.message}` : retry.phase === 'waiting'
        ? `⏳ 模型满载 · ${retry.delayMs / 1000}s 后重试 #${retry.attempt}`
        : `⏳ 模型满载 · 正在重试 #${retry.attempt}`
    }
    if (turn.footerStatusHandle && turn.footerStatusLabel === status) return
    this.stopFooterStatus(turn)
    turn.footerStatusLabel = status
    turn.footerStatusStartedAt = Date.now()
    // footer 显示「状态词 + 耗时」(见 cards/background.ts liveElapsed)。
    // bucket 只在档位边界 push;second 固定 1s。
    const render = (): void => {
      if (turn.footerStatusLabel !== status) return
      const { label } = liveElapsed(Date.now() - turn.footerStatusStartedAt, liveElapsedMode())
      const thinking = status === FOOTER_THINKING_PREFIX ? this.proc?.lastThinkingTokens : null
      const progress = typeof thinking === 'number' ? ` · 约 ${thinking} tokens` : ''
      void this.replaceFooterContent(turn.cardId, this.withModel(`${status}${progress} (${label})`))
    }
    const scheduleNext = (): void => {
      if (turn.footerStatusLabel !== status) return
      const { nextDelayMs } = liveElapsed(Date.now() - turn.footerStatusStartedAt, liveElapsedMode())
      turn.footerStatusHandle = setTimeout(() => { render(); scheduleNext() }, Math.max(1, Math.ceil(nextDelayMs)))
    }
    render()
    scheduleNext()
  }

  startThinkingFooter(turn: TurnState): void {
    this.startFooterStatus(turn, FOOTER_THINKING_PREFIX)
  }

  startWritingFooter(turn: TurnState): void {
    this.startFooterStatus(turn, FOOTER_WRITING)
  }

  startWorkingFooter(turn: TurnState): void {
    this.startFooterStatus(turn, FOOTER_WORKING)
  }

  stopFooterStatus(turn: TurnState | null): void {
    if (!turn) return
    if (turn.footerStatusHandle) clearTimeout(turn.footerStatusHandle)
    turn.footerStatusHandle = null
    turn.footerStatusStartedAt = 0
    turn.footerStatusLabel = null
  }

  /** 页脚只显示当前来源额度；Codex 刷新失败时按原格式展示同账号缓存。 */
  private async footerUsageSuffix(
    provider: AgentProvider,
    proc: AgentProcess | null,
    selectedTokenSourceId: string | null,
    ts: TokenSource | undefined,
    cachedCodexUsage: ReturnType<typeof captureCodexUsageCache> | null,
    model: string | null,
  ): Promise<string> {
    if (selectedTokenSourceId && (!ts || !ts.enabled || ts.agent !== provider)) return '  |  额度 MISS'
    if (ts?.agent === provider && ts.enabled && (provider === 'claude' || provider === 'dsh')) {
      const snap = await ts.readUsage()
      if (snap.state === 'ok' && snap.kind !== 'balance') {
        const fiveHour = snap.windows.find(w => w.kind === 'fiveHour')
        if (ts.kind === 'claude-subscription') {
          const weekly = claudeWeeklyUsageWindow(snap, model)
          const missing = { percent: null, resetsAt: null }
          return this.fmtDualWindowSuffix(fiveHour ?? missing, weekly ?? missing)
        }
        const weekly = snap.windows.find(w => w.kind === 'weekly')
        if (fiveHour || weekly) return this.fmtDualWindowSuffix(fiveHour ?? null, weekly ?? null)
      }
      return `  |  ${cards.unifiedUsageSummary(snap)}`
    }
    if (provider === 'codex') {
      const cache = cachedCodexUsage ?? (proc?.provider === 'codex' ? captureCodexUsageCache(processCodexAccount(proc)) : null)
      if (!cache) return '  |  额度 MISS'
      // Capture the account before any await: a closing card must not read a replacement account.
      const codexProc = proc?.isAlive() && proc.provider === 'codex' && proc.readRateLimits
        && processCodexAccount(proc) === cache.accountId
        ? proc as CodexProcess : null
      const fresh = codexProc ? await refreshUsageFromConnection(() => {
        if (processCodexAccount(codexProc) !== cache.accountId) throw new Error('Codex 额度查询所属账号已切换')
        return codexProc.readRateLimits!()
      }, cache.accountId) : null
      const u = fresh?.state === 'ok' ? fresh : cache.read()
      if (!u) return '  |  额度 MISS'
      return this.fmtDualWindowSuffix(u.fiveHour, u.weekly)
    }
    return '  |  额度 MISS'
  }

  /** 沿用原紧凑窗口格式：4.1h·7%·[6.9d·17%]；不添加周期标签或“已用”等文字。 */
  private fmtDualWindowSuffix(
    fiveHour: { percent: number | null; resetsAt: Date | null } | null,
    weekly: { percent: number | null; resetsAt: Date | null } | null,
  ): string {
    const segment = (window: { percent: number | null; resetsAt: Date | null } | null): string | null => {
      if (!window) return null
      if (window.percent == null) return 'MISS'
      const reset = window.resetsAt && window.resetsAt.getTime() > Date.now() ? cards.fmtResetIn(window.resetsAt) : ''
      const percent = `${Math.round(window.percent)}%`
      return reset ? `${reset}·${percent}` : percent
    }
    const five = segment(fiveHour)
    const week = segment(weekly)
    if (five && week) return `  |  ${five}·[${week}]`
    if (five) return `  |  ${five}`
    if (week) return `  |  [${week}]`
    return '  |  额度 MISS'
  }

  private waitForTurnCloses(): Promise<void> {
    const closes = [...this.turnCloseInflight]
    if (closes.length === 0) return Promise.resolve()
    return Promise.allSettled(closes).then(results => {
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason)
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(errors, `turn close failed: ${errors.map(messageOf).join('; ')}`)
      }
    })
  }

  private releaseTurnCloseReactions(snapshot: TurnCloseSnapshot): void {
    for (const [msgId, rid] of [
      ...snapshot.currentBatchReactionIds.entries(),
      ...snapshot.pendingReactionIds.entries(),
    ]) {
      if (rid) void feishu.deleteReaction(msgId, rid)
    }
  }

  closeTurnCard(
    suffix?: string,
    opts: { forcePush?: boolean; hasFreshResult?: boolean } = {},
  ): Promise<void> {
    // CRITICAL: capture-and-null in a single synchronous block at entry
    // so a parallel `closeTurnCard` (e.g. result event firing while
    // onUserMessage is awaiting an interrupt) can't double-process the
    // same turn — second caller observes null and bails. The promised
    // sync-handler invariant only protects callers that take the turn
    // off the table BEFORE their first await.
    const turn = this.currentTurn
    if (!turn) return this.waitForTurnCloses()
    // A terminal label (including a queued-input handoff or Agent error) only
    // describes the conversation card. Admitted uploads keep their turn owner
    // and finish below; stop/restart cancel them through the session registry.
    if (!suffix && turn.cardRotationFailed) this.maybeMidTurnRotate()
    this.currentTurn = null
    this.stopFooterStatus(turn)
    const proc = this.proc
    const snapshot: TurnCloseSnapshot = {
      turn,
      proc,
      procEpoch: this.procEpoch,
      contextTokens: this.currentContextTokens(proc),
      contextLimit: this.contextLimitForDisplay(proc),
      lastTurnDelta: this.lastTurnDelta ? { ...this.lastTurnDelta } : null,
      lastTurnUsage: this.lastTurnUsage ? { ...this.lastTurnUsage } : null,
      tokenSourceId: this.selectedTokenSourceId,
      tokenSource: proc?.provider === 'codex'
        ? getTokenSourceForAccount(proc.tokenSourceId ?? this.selectedTokenSourceId, processCodexAccount(proc))
        : this.currentTokenSource(),
      codexUsage: proc?.provider === 'codex' ? captureCodexUsageCache(processCodexAccount(proc)) : null,
      currentBatchReactionIds: this.currentBatchReactionIds,
      pendingReactionIds: this.pendingReactionIds,
    }
    // Ownership of reactions transfers with the captured turn. New input can
    // now populate fresh maps while this close awaits rotation/CardKit/usage.
    this.currentBatchReactionIds = new Map()
    this.pendingReactionIds = new Map()
    const close = this.finishTurnCardClose(snapshot, suffix, opts)
      .finally(() => this.releaseTurnCloseReactions(snapshot))
    this.turnCloseInflight.add(close)
    void close.then(
      () => { this.turnCloseInflight.delete(close) },
      () => { this.turnCloseInflight.delete(close) },
    )
    return close
  }

  private async finishTurnCardClose(
    snapshot: TurnCloseSnapshot,
    suffix?: string,
    opts: { forcePush?: boolean; hasFreshResult?: boolean } = {},
  ): Promise<void> {
    const { turn } = snapshot
    // 竞态修复:mid-turn rotation 的 swap 阶段(sendCard / id_convert 的 await
    // 之后,见 startMidTurnRotate)会切 turn.cardId 到新卡并 startWritingFooter
    // 重启一个 footer 计时 interval。若 result 在那个 await 窗口里抢先到达,
    // 本函数会先终态化旧卡、置 currentTurn=null,随后 swap 才重启 interval ——
    // 该 interval 再没有路径会 stop(closeTurnCard 只跑一次;stop/kill/exit 的
    // stopFooterStatus(this.currentTurn) 拿到的是 null),新卡 footer 一直计时。
    // 首 turn 长输出触发 rotation 时必现(2026-06-26 turn=1 计时不止)。等
    // rotating 落定后再终态化:turn.cardId 此时是新卡,再 stop 一次清掉 swap
    // 重启的 interval,终态 footer 也写在新卡上。
    if (turn.rotating) await turn.rotating
    await sessionTools.waitForImageDeliveries(turn)
    if (turn.fileDelivery) {
      try {
        for (const path of await turn.fileDelivery.finish()) turn.outboundSentPaths.add(path)
      } catch (error) {
        log(`session "${this.sessionName}": file delivery close failed: ${messageOf(error)}`)
        await feishu.sendTextRaw(this.chatId, `❌ 文件交付收尾失败：${messageOf(error)}`)
      } finally {
        this.fileDeliveries.delete(turn.fileDelivery)
      }
    }
    this.stopFooterStatus(turn)
    const elapsed = (Date.now() - turn.startedAt) / 1000
    const cardId = turn.cardId
    const segmentTexts = turn.segmentTexts
    await cardkit.flush(cardId)

    // Markers are admitted during deltas; their cloud uploads and separate
    // receipt have settled above. The remaining work finalizes conversation prose.
    // 如果最后一个 assistant 段没有等到 block_stop,这里先把内存缓冲的完整
    // 文本作为静态 markdown 插入卡片。
    const fallbackSegments = new Map<string, string>()
    if (turn.currentAssistantSegmentId && turn.currentAssistantText.trim()) {
      const segId = turn.currentAssistantSegmentId
      const text = turn.currentAssistantText
      const added = await this.addCompletedAssistantSegment(turn, segId, text)
      if (!added) fallbackSegments.set(segId, text)
      turn.currentAssistantSegmentId = null
      turn.currentAssistantText = ''
    }

    // block_stop handler 是同步 fire-and-forget；先等 raw 容器 checked 写完，
    // 才能完整看到随后登记的 mathRenderInflight，避免 close 抢先 dispose。
    const assistantWrites = turn.assistantWriteInflight?.get(cardId)
    if (assistantWrites?.size) {
      await Promise.allSettled([...assistantWrites])
    }

    // 等本卡全部 in-flight 公式渲染落地(渲染+上传是秒级 async,且有超时
    // 上限——math-render 上传 15s AbortController,不会无限挂)。不等的话
    // 下面的原文 replace 会先赢,把还没落地的渲染版覆盖回 $$…$$ 原码降级;
    // 渲染 promise 晚到再写就打在已 dispose 的卡上静默死 —— 这正是「公式
    // 图永远不出现、只见代码块」的病根。只 drain 本卡:rotation 期间登记
    // 的旧卡渲染由 rotation 自己 drain(review #2)。
    const inflight = turn.mathRenderInflight?.get(cardId)
    if (inflight?.size) {
      await Promise.allSettled([...inflight])
    }
    // 对每个 assistant 段 replaceElement 成最终内容。正文已经是静态 markdown,
    // 这里只是收尾重渲兜住异常路径 —— 但公式段例外:replaceSegmentWithMathImgs
    // 已经把段替换成摘出文本 + 紧贴插入公式图,这里再用原文重渲会把渲染版
    // 覆盖回 $$…$$ 原码降级(代码块占位),图也失去归属段。已渲染标记按卡
    // 隔离:本卡的段才跳过(rotation 重编号后新卡同名段不受旧卡标记影响)。
    const renderedHere = turn.mathRendered?.get(cardId)
    for (const [segId, fullText] of segmentTexts) {
      if (cardkit.isDeadElement(cardId, segId)) {
        fallbackSegments.set(segId, fullText)
        continue
      }
      if (renderedHere?.has(segId)) continue
      await cardkit.replaceElement(cardId, segId, this.completedAssistantElement(segId, fullText))
    }
    if (turn.cardRotationFailed) {
      for (const [segId, fullText] of segmentTexts) fallbackSegments.set(segId, fullText)
    }

    // State marker leads the footer (✅ for natural completion, or the
    // suffix verbatim for non-natural states like `🛑 打断`). The
    // trailing "done" word is gone — the ✅ already carries that
    // meaning. User-confirmed footer order 2026-05-16.
    const stateMark = suffix ? suffix : '✅'
    // Footer line 1 keeps the terminal status compact. Usage-derived
    // numbers only render when a fresh SDK result landed for THIS turn;
    // interrupts/boot failures would otherwise show stale prior-turn data.
    const line1Parts = [`${stateMark} ⏱ ${cards.formatDuration(elapsed)}`]
    if (opts.hasFreshResult) {
      const ctxTokens = snapshot.contextTokens
      const ctxMax = snapshot.contextLimit
      // Claude 路径分母已是 SDK 实测窗口、分子是输入侧占用,走纯除法(baseline=0);
      // Codex 路径保留 12K baseline 扣减。
      const isClaude = turn.provider === 'claude'
      const ctxPercent = cards.footerContextPercentLabel(ctxTokens, ctxMax, isClaude ? 0 : undefined)
      if (ctxPercent) line1Parts.push(`🧠 ${ctxPercent}`)
      const cost = snapshot.lastTurnDelta?.costUsd ?? 0
      if (cost > 0) line1Parts.push(`💰 $${cost.toFixed(3)}`)
    }
    if (turn.contextCompactCount > 0) line1Parts.push(`🚨 压缩×${turn.contextCompactCount}`)
    if (turn.outboundSentPaths.size > 0) line1Parts.push(`📎 ${turn.outboundSentPaths.size}`)
    const modelLabel = this.modelLine(turn)
    if (modelLabel) line1Parts.push(modelLabel)
    const footerLine1 = line1Parts.join(' ｜ ')
    const footerLine2 = opts.hasFreshResult
      ? cards.footerTokenDetailLine(snapshot.lastTurnUsage) + (turn.cardRotationFailed
        ? ''
        : await this.footerUsageSuffix(
            turn.provider,
            snapshot.proc,
            snapshot.tokenSourceId,
            snapshot.tokenSource,
            snapshot.codexUsage,
            turn.model,
          ))
      : ''
    const footer = footerLine2 ? `${footerLine1}\n${footerLine2}` : footerLine1
    const footerLanded = await cardkit.replaceElementChecked(
      cardId,
      cards.ELEMENTS.footer,
      this.footerElement(footer),
    )
    // Final chat-list preview: clean finish shows "⏱ duration · NK tokens";
    // interrupted shows the suffix instead (no usage event landed).
    // cancelSummary kills any in-flight throttled write so a stale
    // in-flight summary update can't clobber this terminal summary.
    cardkit.cancelSummary(cardId)
    const settingsLanded = await cardkit.patchSettingsChecked(cardId, cards.streamingOffSettings({
      durationSec: elapsed,
      outputTokens: opts.hasFreshResult ? snapshot.lastTurnUsage?.output_tokens : undefined,
      suffix,
    }))
    if (footerLanded && settingsLanded) {
      await cardkit.dispose(cardId)
    } else {
      // Keep CardKit state alive: disposing after a rejected terminal write
      // would make the in-memory state claim success while Feishu still shows
      // a streaming/running card, and would prevent any later repair attempt.
      const detail = `footer=${footerLanded ? 'ok' : 'MISS'}, settings=${settingsLanded ? 'ok' : 'MISS'}`
      log(`session "${this.sessionName}": terminal card transaction incomplete card=${cardId.slice(0, 12)} ${detail}`)
      await feishu.sendTextRaw(
        this.chatId,
        `⚠️ 对话卡片终态写入失败 (${detail})。本轮已结束: ${stateMark}`,
      )
    }

    for (const text of fallbackSegments.values()) {
      await this.sendAssistantTextFallback(text, 'CardKit 元素未落地')
    }

    // Phone push on clean turn close so the user knows Codex is done
    // even with the chat backgrounded. Skip on interrupts (no real
    // completion), when we don't know who to ping, and when the turn
    // wasn't kicked off by the user typing a message. `opts.forcePush`
    // overrides the suffix-gate when the backend reports a failed turn.
    // Fire-and-forget; urgent_app failures are non-fatal and already
    // logged in feishu.ts.
    // 续卡仍未成功时已有失败提示，不推送旧卡的完成通知。
    if ((opts.forcePush || !suffix) && turn.userOpenId && turn.messageId && !turn.cardRotationFailed) {
      void feishu.urgentApp(turn.messageId, [turn.userOpenId])
    }

    // Release the OneSecond reactions on every queued Feishu message
    // this turn was responsible for. Two buckets:
    //   1. `currentBatchReactionIds` — msgs the init handler explicitly
    //      claimed (SDK dequeued them as a merged next-turn batch).
    //   2. `pendingReactionIds` — msgs whose fate is invisible to the
    //      daemon: the SDK either dequeued them as part of the
    //      JUST-CLOSED turn OR injected them mid-turn as
    //      `<system-reminder>` and silently removed them from the
    //      queue (common when the current turn had tool calls).
    //      Without visibility into queue-operation events the daemon
    //      can't tell which; the safe default is "the prior turn just
    //      ended, so the msg is at least *acknowledged* now —
    //      release the OneSecond and let it stop saying 'queued',
    //      instead of leaving it stuck permanently."
    //      For merged-batch follow-ups, this releases slightly early
    //      (before the merged turn actually runs), which is an
    //      acceptable trade vs. msgs stuck under OneSecond forever.
    // Reaction ownership was transferred into `snapshot` synchronously at
    // close entry and is released by the wrapper's finally. Never touch the
    // fresh maps that may already belong to the next turn here.
  }
}
