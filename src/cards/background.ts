/**
 * 后台任务 / 子 agent 的状态累积 + 游标卡渲染。
 *
 * 与 cards/task-board.ts 的区别:task-board 是 TaskCreate/Update/List 工具
 * (用户任务板)的累积,渲染成 turn 卡内的常驻元素(element_id task_board_live);
 * 本模块是 SDK task_* 消息族(子 agent / 后台 bash / MCP / workflow 的后台
 * 执行)的累积,渲染成一张独立的「后台游标卡」——吸附在对话末尾,被新消息
 * 超越时沉降为历史快照(updateCard),只在全部终态时固化留在原地。
 *
 * 卡片结构(每任务合一个 panel —— 标题写状态+时长,展开看详情):
 *   ┌ config.summary: "🧭 后台任务 · N 进行中·M 已结束"   ← 聊天列表预览
 *   │ [bg_<id> collapsible_panel]                          ← 每任务一个 panel
 *   │   header: "🟢 Explore · 搜索 — 🟡 运行中 47s"        ← 状态+时长 标题
 *   │   └ [bg_body_<id>] 耗时/用量/任务/执行过程(steps)
 *   │ ...
 *
 * 状态机由 session 驱动(事件来自 claude-agent-process.handleSystemMessage):
 *   task_started      → applyBgTaskStarted  (workflow/monitor 白名单直入 active;
 *                                            其余前台 task 进 pending 观察池)
 *   task_progress     → applyBgTaskProgress (刷 usage / last_tool / summary)
 *   task_updated      → applyBgTaskUpdated  (is_backgrounded:true 时 pending→active
 *                                            提升;其余 patch 原地改)
 *   主线程推进         → promotePendingOnAdvance (主 agent 继续发起 tool_use / 说新段 =
 *                            没在等 pending task → 全部提升入 active。run_in_background
 *                            的 Bash 靠它入卡 —— SDK 不给它发 is_backgrounded)
 *   task_notification → applyBgTaskSettled  (active 结算成墓碑;pending 前台 task 直接丢)
 * 子 agent 逐步工具调用(tool_use/tool_result 带 parent_tool_use_id)归属到对应
 * task,累积成 steps[](trim 到最近 ~1000 字)。
 *
 * 前台/后台区分靠控制流事实:主线程(tool_use / assistant)在某 task 未结算前继续
 * 推进了,该 task 就是后台(没在阻塞主线程);阻塞等待的就是前台。SDK 的
 * is_backgrounded 信号只覆盖显式后台化(Ctrl+B / background_tasks / background:
 * 子 agent),run_in_background 的 Bash 不发 —— 故 task_started 先落 pending 观察
 * 池,由「主线程推进」或「is_backgrounded:true」任一提升入 active 建卡。前台 task
 * 的 settled 先于主线程下一个动作到达,pending 已空,推进判定不会误提。workflow/
 * monitor 是天生后台执行模型,白名单直入 active。
 */

import type {
  BgTaskStartedEvent,
  BgTaskProgressEvent,
  BgTaskUpdatedEvent,
  BgTaskSettledEvent,
  BgTaskStatus,
} from '../claude-agent-process'
import { sanitizeMarkdownForCardKit } from './elements'
import { shellCommandDescription } from './shell-command'

export type { BgTaskStatus }

/** 后台任务种类,归一化自 SDK task_type + subagent_type 推断。 */
export type BgTaskType = 'subagent' | 'shell' | 'monitor' | 'workflow' | 'unknown'

/** 一条后台任务的累积视图,session 以 task_id 为 key 维护一份数组。 */
export interface BgTaskEntry {
  id: string
  toolUseId?: string
  type: BgTaskType
  description: string
  subagentType?: string
  workflowName?: string
  /** 子 agent 任务描述(task_started.prompt)。 */
  prompt?: string
  status: BgTaskStatus
  /** 任务启动时刻(ms) —— 算运行时长的起点。 */
  startedAt: number
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
  lastToolName?: string
  summary?: string
  error?: string
  isBackgrounded?: boolean
  /** 终态时刻(ms);终态时长 = endTime - startedAt。 */
  endTime?: number
  /** 子 agent 逐步工具调用(按 parent_tool_use_id 归属),trim 到最近 ~1000 字。 */
  steps: BgTaskStep[]
}

/** 一步工具调用的简述(tool_use 到达时建,tool_result 到达时回填结果)。 */
export interface BgTaskStep {
  /** 关联的 tool_use id —— tool_result 到达时按它回填结果摘要到同一 step。 */
  toolUseId: string
  tool: string
  /** 单行简述:`工具 输入摘要` 或 `工具 输入摘要 → 结果摘要`(result 回填后)。 */
  brief: string
}

/** 后台任务累积库 —— 双池结构,session 以此为单一可变状态。
 *  - active:已确认后台(workflow/monitor 白名单,或收到 is_backgrounded:true 提升),
 *    驱动游标卡渲染。
 *  - pending:观察池。task_started 进来但还没后台化的前台 task(Bash 命令/前台子 agent),
 *    不渲染;等 task_updated.is_backgrounded=true 提升到 active,或 task_settled 时丢弃。 */
export interface BgStore {
  active: BgTaskEntry[]
  pending: BgTaskEntry[]
}

/** 空库 —— session 初始化 / settle 后复位用。 */
export function emptyBgStore(): BgStore {
  return { active: [], pending: [] }
}

/** 后台卡内部 element_id:每任务一个 panel(bg_<hash>),其 body 是 bg_body_<hash>。
 *  刷新任务时 replaceElement 整个 panel(header 状态/时长 + body 一起)。
 *  飞书 element_id 规则(300315 报错原文):字母开头、只能字母数字下划线、
 *  ≤20 字符。Claude 的 task id(bw0ez19dm)天然满足;Codex 的 agentThreadId 是
 *  36 字符带 '-' 的 UUID —— 直接拼既含非法字符又超长,sanitize 连字符后仍 39+
 *  字符照样被拒。改为对完整 id 做短哈希(FNV-1a 32bit → base36,≤7 字符),
 *  前缀 bg_/bgb_ 后总长 10/11,同一 id 稳定映射,不同 id 碰撞率 ~2^-33
 *  (每卡任务数 ≤ 十级,可忽略)。 */
function shortIdHash(id: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export const BG_ELEMENTS = {
  panel: (id: string) => `bg_${shortIdHash(id)}`,
  body: (id: string) => `bgb_${shortIdHash(id)}`,
} as const

// ── 归一化 / 判定 ────────────────────────────────────────────────────

function normalizeType(taskType?: string, subagentType?: string): BgTaskType {
  // SDK 实测 task_type 带 local_ 前缀:local_agent / local_bash / local_workflow。
  const t = taskType ?? ''
  if (t === 'subagent' || t === 'local_agent') return 'subagent'
  if (t === 'shell' || t === 'local_bash' || t === 'local_shell') return 'shell'
  if (t === 'monitor' || t === 'local_monitor') return 'monitor'
  if (t === 'workflow' || t === 'local_workflow') return 'workflow'
  if (subagentType) return 'subagent'
  return 'unknown'
}

/** 天生后台的 task_type:workflow / monitor 在 SDK 里是 fire-and-forget 后台执行
 *  模型,task_started 即可入 active;subagent / shell / unknown 默认前台,先进
 *  pending 观察池,等 is_backgrounded:true 才提升。 */
function isInherentlyBackground(type: BgTaskType): boolean {
  return type === 'workflow' || type === 'monitor'
}

/** 终态:不再变化,不再占活跃计数。running / pending / paused 都算活跃。 */
export function isBgTerminal(t: BgTaskEntry): boolean {
  return t.status === 'completed' || t.status === 'failed' || t.status === 'killed'
}

/** 是否还有活跃任务(决定游标卡要不要继续跟随 / 重建)。 */
export function hasActiveBgTask(tasks: BgTaskEntry[]): boolean {
  return tasks.some(t => !isBgTerminal(t))
}

// ── 累积器(纯函数,不可变更新;now 默认 Date.now()) ────────────────────

export function applyBgTaskStarted(
  store: BgStore,
  e: BgTaskStartedEvent,
  now: number = Date.now(),
): BgStore {
  const type = normalizeType(e.task_type, e.subagent_type)
  const inActive = store.active.some(t => t.id === e.task_id)
  const inPending = store.pending.some(t => t.id === e.task_id)
  // 已知 task:补全字段,留在原池(不跨池迁移;提升只由 applyBgTaskUpdated 做)。
  if (inActive || inPending) {
    const patchField = (t: BgTaskEntry): BgTaskEntry => ({
      ...t,
      type,
      toolUseId: e.tool_use_id ?? t.toolUseId,
      description: e.description || t.description,
      subagentType: e.subagent_type ?? t.subagentType,
      workflowName: e.workflow_name ?? t.workflowName,
      prompt: e.prompt ?? t.prompt,
    })
    return {
      active: inActive ? store.active.map(t => t.id === e.task_id ? patchField(t) : t) : store.active,
      pending: inPending ? store.pending.map(t => t.id === e.task_id ? patchField(t) : t) : store.pending,
    }
  }
  // 新 task:workflow/monitor 白名单天生后台 → 直入 active;其余前台 → pending 观察池。
  const entry: BgTaskEntry = {
    id: e.task_id,
    toolUseId: e.tool_use_id,
    type,
    description: e.description,
    subagentType: e.subagent_type,
    workflowName: e.workflow_name,
    prompt: e.prompt,
    status: 'running',
    startedAt: now,
    steps: [],
    ...(isInherentlyBackground(type) ? { isBackgrounded: true } : {}),
  }
  return isInherentlyBackground(type)
    ? { active: [...store.active, entry], pending: store.pending }
    : { active: store.active, pending: [...store.pending, entry] }
}

export function applyBgTaskProgress(store: BgStore, e: BgTaskProgressEvent): BgStore {
  const inActive = store.active.some(t => t.id === e.task_id)
  const inPending = store.pending.some(t => t.id === e.task_id)
  if (!inActive && !inPending) return store
  const patchField = (t: BgTaskEntry): BgTaskEntry => ({
    ...t,
    description: e.description ?? t.description,
    subagentType: e.subagent_type ?? t.subagentType,
    usage: e.usage ?? t.usage,
    lastToolName: e.last_tool_name ?? t.lastToolName,
    summary: e.summary ?? t.summary,
    status: t.status === 'pending' ? 'running' : t.status,
  })
  return {
    active: inActive ? store.active.map(t => t.id === e.task_id ? patchField(t) : t) : store.active,
    pending: inPending ? store.pending.map(t => t.id === e.task_id ? patchField(t) : t) : store.pending,
  }
}

export function applyBgTaskUpdated(store: BgStore, e: BgTaskUpdatedEvent): BgStore {
  const idxPending = store.pending.findIndex(t => t.id === e.task_id)
  const p = e.patch
  // 前台 task 被后台化(is_backgrounded:true) —— 提升到 active,带 steps。
  // 「观察池 → 入卡」的唯一路径。SDK 触发:Ctrl+B / background_tasks 控制请求 /
  // background:true 子 agent 被标记后台。
  if (p.is_backgrounded === true && idxPending >= 0) {
    const entry = store.pending[idxPending]
    const promoted: BgTaskEntry = {
      ...entry,
      isBackgrounded: true,
      status: p.status ?? entry.status,
      description: p.description ?? entry.description,
      error: p.error ?? entry.error,
      endTime: p.end_time ?? entry.endTime,
    }
    return {
      active: [...store.active, promoted],
      pending: store.pending.filter(t => t.id !== e.task_id),
    }
  }
  const inActive = store.active.some(t => t.id === e.task_id)
  const inPending = idxPending >= 0
  // 已在 active 的非提升 patch(status/error 等),或已在 pending 的 patch(不提升)。
  if (inActive || inPending) {
    const patchField = (t: BgTaskEntry): BgTaskEntry => ({
      ...t,
      status: p.status ?? t.status,
      description: p.description ?? t.description,
      error: p.error ?? t.error,
      isBackgrounded: p.is_backgrounded ?? t.isBackgrounded,
      endTime: p.end_time ?? t.endTime,
    })
    return {
      active: inActive ? store.active.map(t => t.id === e.task_id ? patchField(t) : t) : store.active,
      pending: inPending ? store.pending.map(t => t.id === e.task_id ? patchField(t) : t) : store.pending,
    }
  }
  // 未知 task:no-op。没 started 也没后台化信号的 task 不凭空入卡(no-fallback)。
  return store
}

/** 主线程推进信号(新的主线程 tool_use / 新的 assistant 段定稿)到达:pending 观察
 *  池里的 task 都没在阻塞主线程(主 agent 还在往前走) —— 判为后台,提升入 active。
 *  控制流事实判据,不依赖 SDK 回传 is_backgrounded:run_in_background 的 Bash、
 *  后台子 agent 都靠它入卡。前台 task 不会被误提 —— 它的 task_settled 先于主线程
 *  下一个动作到达,pending 已清空。 */
export function promotePendingOnAdvance(store: BgStore): BgStore {
  if (store.pending.length === 0) return store
  return {
    active: [...store.active, ...store.pending.map(t => ({ ...t, isBackgrounded: true }))],
    pending: [],
  }
}

export function applyBgTaskSettled(
  store: BgStore,
  e: BgTaskSettledEvent,
  now: number = Date.now(),
): BgStore {
  const mapped: BgTaskStatus = e.status === 'completed' ? 'completed'
    : e.status === 'failed' ? 'failed'
    : 'killed'
  // 前台 task 结算,从未后台化 —— 不进卡,直接从观察池丢。这是治「随便跑个命令就
  // 冒一项」的关键:前台 Bash/子 agent 从 pending 沉掉,不进 active 不渲染。
  if (store.pending.some(t => t.id === e.task_id)) {
    return { active: store.active, pending: store.pending.filter(t => t.id !== e.task_id) }
  }
  // 在 active:结算成墓碑(终态任务留在卡里显示「用时/失败 Ns」)。
  if (store.active.some(t => t.id === e.task_id)) {
    return {
      active: store.active.map(t => t.id === e.task_id
        ? { ...t, status: mapped, usage: e.usage ?? t.usage, summary: e.summary ?? t.summary, endTime: t.endTime ?? now }
        : t),
      pending: store.pending,
    }
  }
  // 未知 task 终态:no-op。漏接 started 的前台命令结算不该冒充后台任务(no-fallback)。
  return store
}

// ── 子 agent 逐步工具调用(parent_tool_use_id 关联) ────────────────────

const STEP_CHAR_BUDGET = 1000

/** 从最新 step 往回累加 brief 长度,超出 budget 丢最旧的 —— 保留最新的 ~1000 字过程。 */
function trimSteps(steps: BgTaskStep[]): BgTaskStep[] {
  let total = 0
  let keepFrom = 0
  for (let i = steps.length - 1; i >= 0; i--) {
    total += steps[i].brief.length + 5
    if (total > STEP_CHAR_BUDGET) { keepFrom = i + 1; break }
  }
  return keepFrom === 0 ? steps : steps.slice(keepFrom)
}

function briefInput(name: string, input: any): string {
  const s = (x: unknown): string => typeof x === 'string' ? x : ''
  switch (name) {
    // 与主卡工具面板共用 shell-command 解析:Windows PowerShell 包装 / desc 注释
    // 统一剥掉,steps 里显示中文说明而非 powershell.exe 路径。
    case 'Bash': return shellCommandDescription(s(input?.command)) || '(空命令)'
    case 'Read': return s(input?.file_path)
    case 'Edit': return s(input?.file_path)
    case 'Write': return s(input?.file_path)
    case 'Grep': return `"${s(input?.pattern)}" in ${s(input?.path ?? '.')}`
    case 'Glob': return `"${s(input?.pattern)}"`
    case 'Task': return s(input?.description)
    case 'WebSearch': return `"${s(input?.query)}"`
    default: return JSON.stringify(input ?? {}).replace(/\s+/g, ' ').slice(0, 60)
  }
}

function briefResult(content: unknown, isError: boolean): string {
  // DSH and MCP can return content blocks; the shared process contract also
  // permits plain text and structured values. Match the main tool-card path.
  const output = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((block: any) => typeof block?.text === 'string' ? block.text : JSON.stringify(block)).join('\n')
      : JSON.stringify(content)
  const c = (output ?? 'MISS').replace(/\s+/g, ' ').trim()
  return isError ? `❌ ${c.slice(0, 80)}` : c.slice(0, 80)
}

/** tool_use 到达:parent_tool_use_id 匹配的 task 追加一步(无结果)。主线程工具
 *  (parentToolUseId 为 null/undefined)或无归属 task 跳过 —— 返回原 store 引用。
 *  同时在 active 和 pending 累积:前台子 agent 跑时 steps 暂存 pending,
 *  is_backgrounded 提升后 entry 自带 steps 带到 active。 */
export function applyBgToolUse(
  store: BgStore,
  parentToolUseId: string | null | undefined,
  toolUseId: string,
  name: string,
  input: any,
): BgStore {
  if (!parentToolUseId) return store
  const inActive = store.active.some(t => t.toolUseId === parentToolUseId)
  const inPending = store.pending.some(t => t.toolUseId === parentToolUseId)
  if (!inActive && !inPending) return store
  const acc = (tasks: BgTaskEntry[]): BgTaskEntry[] => tasks.map(t => t.toolUseId === parentToolUseId
    ? { ...t, steps: trimSteps([...t.steps, { toolUseId, tool: name, brief: `${name} ${briefInput(name, input)}`.trim() }]) }
    : t)
  return {
    active: inActive ? acc(store.active) : store.active,
    pending: inPending ? acc(store.pending) : store.pending,
  }
}

/** Codex 子 agent 过程步骤(按 thread_id 直接归属,codex 无 parent_tool_use_id):
 *  started 追加一步,completed 按 item_id 回填结果段。双池同查。 */
export function applySubagentStep(
  store: BgStore,
  threadId: string,
  itemId: string,
  tool: string,
  phase: 'started' | 'completed',
  brief: string,
): BgStore {
  const inActive = store.active.some(t => t.id === threadId)
  const inPending = store.pending.some(t => t.id === threadId)
  if (!inActive && !inPending) return store
  const acc = (tasks: BgTaskEntry[]): BgTaskEntry[] => tasks.map(t => {
    if (t.id !== threadId) return t
    if (phase === 'started') {
      return { ...t, steps: trimSteps([...t.steps, { toolUseId: itemId, tool, brief: `${tool} ${brief}`.trim() }]) }
    }
    // completed:同 item 的 step 追加结果段;item 无对应 step(漏 started)则补一步。
    let matched = false
    const steps = t.steps.map(s => {
      if (matched || s.toolUseId !== itemId) return s
      matched = true
      return { ...s, brief: brief ? `${s.brief} ${brief}` : s.brief }
    })
    if (!matched && brief) steps.push({ toolUseId: itemId, tool, brief: `${tool} ${brief}`.trim() })
    return { ...t, steps: trimSteps(steps) }
  })
  return {
    active: inActive ? acc(store.active) : store.active,
    pending: inPending ? acc(store.pending) : store.pending,
  }
}

/** tool_result 到达:按 tool_use_id 回填结果摘要到对应 step(同 task 内)。
 *  同 applyBgToolUse,active/pending 双池都处理;无归属 task 返回原 store 引用。 */
export function applyBgToolResult(
  store: BgStore,
  parentToolUseId: string | null | undefined,
  toolUseId: string,
  content: unknown,
  isError: boolean,
): BgStore {
  if (!parentToolUseId) return store
  const inActive = store.active.some(t => t.toolUseId === parentToolUseId)
  const inPending = store.pending.some(t => t.toolUseId === parentToolUseId)
  if (!inActive && !inPending) return store
  const acc = (tasks: BgTaskEntry[]): BgTaskEntry[] => tasks.map(t => {
    if (t.toolUseId !== parentToolUseId) return t
    let matched = false
    const steps = t.steps.map(s => {
      if (matched || s.toolUseId !== toolUseId) return s
      matched = true
      return { ...s, brief: `${s.brief} → ${briefResult(content, isError)}` }
    })
    return { ...t, steps: trimSteps(steps) }
  })
  return {
    active: inActive ? acc(store.active) : store.active,
    pending: inPending ? acc(store.pending) : store.pending,
  }
}

// ── 渲染 ─────────────────────────────────────────────────────────────

const TYPE_ICON: Record<BgTaskType, string> = {
  subagent: '🟢',
  shell: '⚙️',
  monitor: '📡',
  workflow: '🔁',
  unknown: '🔹',
}

const TYPE_LABEL: Record<BgTaskType, string> = {
  subagent: '子agent',
  shell: 'shell',
  monitor: '监控',
  workflow: '工作流',
  unknown: '任务',
}

/** ms → "45s" / "2m13s" / "1h5m"。 */
function fmtElapsed(ms: number): string {
  if (!ms || ms < 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

const FOOTER_BUCKETS = [
  { limit: 30_000, label: '<30s' },
  { limit: 60_000, label: '<1m' },
  { limit: 180_000, label: '<3m' },
  { limit: 300_000, label: '<5m' },
  { limit: 600_000, label: '<10m' },
]

/** 活跃 footer / 后台卡 header 的耗时展示模式。
 *  - `bucket`: 粗档位 (`<30s`/`<1m`/…)，只在档位边界 push（默认，省飞书配额）
 *  - `second`: 按秒显示并每秒 push;超 10m 后改 5m 档位(10m+/15m+/20m+…,见 liveElapsed) */
export type LiveElapsedMode = 'bucket' | 'second'

/** second 模式下 footer / 后台卡前 10m 都按 1s tick(对齐旧 FOOTER_STATUS_TICK_MS)。 */
export const LIVE_ELAPSED_SECOND_FOOTER_TICK_MS = 1000

/** second 模式超 10m 后切粗档位,治「等用户答 AskUserQuestion 时 footer 无限按秒计到
 *  隔夜 / 一两天」——前 10m 仍按秒,之后只在 5m 边界 push 一次(10m+ / 15m+ / 20m+…)。
 *  颗粒度 5m(细于 bucket 的 10m):second 本就是「想看精确」,超 10m 后也不宜一下跳太粗。*/
const SECOND_BUCKET_BASE_MS = 600_000
const SECOND_BUCKET_STEP_MS = 300_000

/** 相对时长档位:<30s / <1m / <3m / <5m / <10m,超过 10m 后每 10 分钟一档(10m+、20m+…)。
 *  返回当前档位标签 + 到下一档位边界的毫秒数。footer / 后台任务 header 用粗粒度档位
 *  代替秒数 —— 档位只在边界变,所以更新只发生在档位边界,不是每秒 tick。*/
export function elapsedBucket(elapsedMs: number): { label: string; nextDelayMs: number } {
  const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  for (const b of FOOTER_BUCKETS) {
    if (ms < b.limit) return { label: b.label, nextDelayMs: b.limit - ms }
  }
  const step = 600_000
  const idx = Math.floor((ms - 600_000) / step)
  const nextBoundary = 600_000 + (idx + 1) * step
  return { label: `${(idx + 1) * 10}m+`, nextDelayMs: nextBoundary - ms }
}

/**
 * Live elapsed for footer / background headers.
 * `bucket` → coarse label + delay to next boundary;
 * `second` → `Ns` label + fixed 1s delay (callers may override for background).
 */
export function liveElapsed(
  elapsedMs: number,
  mode: LiveElapsedMode = 'bucket',
): { label: string; nextDelayMs: number } {
  if (mode === 'second') {
    const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
    // 超 10m 不再按秒:改 5m 颗粒度档位 10m+ / 15m+ / 20m+…,只在 5m 边界 push。
    if (ms >= SECOND_BUCKET_BASE_MS) {
      const idx = Math.floor((ms - SECOND_BUCKET_BASE_MS) / SECOND_BUCKET_STEP_MS)
      const nextBoundary = SECOND_BUCKET_BASE_MS + (idx + 1) * SECOND_BUCKET_STEP_MS
      return { label: `${10 + idx * 5}m+`, nextDelayMs: nextBoundary - ms }
    }
    return {
      label: `${Math.floor(ms / 1000)}s`,
      nextDelayMs: LIVE_ELAPSED_SECOND_FOOTER_TICK_MS,
    }
  }
  return elapsedBucket(elapsedMs)
}

function ownerOf(t: BgTaskEntry): string {
  return t.subagentType ?? t.workflowName ?? TYPE_LABEL[t.type]
}

function terminalElapsed(t: BgTaskEntry): number {
  if (t.usage?.duration_ms) return t.usage.duration_ms
  if (t.endTime && t.endTime > t.startedAt) return t.endTime - t.startedAt
  return 0
}

/** 标题里的状态+时长标签(折叠时常驻可见)。
 *  活跃态按 liveElapsedMode 显示档位或秒数;终态保留精确耗时。 */
function statusLabel(
  t: BgTaskEntry,
  now: number,
  liveElapsedMode: LiveElapsedMode = 'bucket',
): string {
  const liveLabel = (elapsedMs: number): string =>
    liveElapsed(elapsedMs, liveElapsedMode).label
  switch (t.status) {
    case 'running': return `🟡 运行中 (${liveLabel(now - t.startedAt)})`
    case 'paused': return `⏸️ 已暂停 (${liveLabel(now - t.startedAt)})`
    case 'pending': return `⚪ 等待中`
    case 'completed': return `✅ 用时 ${fmtElapsed(terminalElapsed(t))}`
    case 'failed': return `❌ 失败 ${fmtElapsed(terminalElapsed(t))}`
    case 'killed': return `💀 已终止 ${fmtElapsed(terminalElapsed(t))}`
  }
}

/** header 摘要:N 进行中(· M 已结束)。聊天列表预览(config.summary)用。 */
export function summarizeBackground(tasks: BgTaskEntry[]): string {
  const active = tasks.filter(t => !isBgTerminal(t)).length
  const terminal = tasks.length - active
  if (active > 0) return `${active} 进行中${terminal ? ` · ${terminal} 已结束` : ''}`
  return terminal ? `${terminal} 已结束` : '空'
}

/** 聊天列表预览全文(🧭 前缀 + 计数)。活卡建卡(sendCard)与增量刷新(patchSummary)
 *  共用此函数 —— 否则建卡后 summary 永远停在首任务到达时的"1 进行中",后续任务
 *  增减 / 结算都不再反映到预览。 */
export function backgroundLiveSummary(tasks: BgTaskEntry[]): string {
  return `🧭 后台任务 · ${summarizeBackground(tasks)}`
}

/** 详情 body —— 精简:仅 error(异常一行) + steps(执行过程,每步一行)。
 *  用量/摘要/prompt 等元信息不入 body(header 状态行已够,后面占行越少越好)。 */
function renderDetailBody(t: BgTaskEntry): string {
  const lines: string[] = []
  if (t.error) lines.push(`⚠ ${t.error}`)
  // 终态摘要(子 agent 最终答复 / Claude task summary)置顶:墓碑展开第一眼
  // 是结果,不是过程。有界预览,steps 仍然完整跟在后面。
  if (isBgTerminal(t) && t.summary) lines.push(`📝 ${t.summary.slice(0, 400)}`, '')
  for (let i = 0; i < t.steps.length; i++) {
    lines.push(`${i + 1}. ${t.steps[i].brief}`)
  }
  return sanitizeMarkdownForCardKit(lines.length > 0 ? lines.join('\n') : '_(暂无执行记录)_')
}

/** 单任务的整 panel —— 标题写「图标 责任人·描述 — 状态·时长」,展开看详情 body。
 *  session 据此 addElement(新任务)/replaceElement(刷新,整个 panel)。
 *  liveElapsedMode 只影响活跃态 header 时长文案;终态仍用精确 fmtElapsed。 */
export function backgroundTaskPanel(
  t: BgTaskEntry,
  now: number = Date.now(),
  liveElapsedMode: LiveElapsedMode = 'bucket',
): object {
  return {
    tag: 'collapsible_panel',
    element_id: BG_ELEMENTS.panel(t.id),
    header: { title: { tag: 'plain_text', content: `${TYPE_ICON[t.type]} ${ownerOf(t)} · ${t.description || '(无描述)'} — ${statusLabel(t, now, liveElapsedMode)}` } },
    expanded: false,
    elements: [{ tag: 'markdown', element_id: BG_ELEMENTS.body(t.id), content: renderDetailBody(t) }],
  }
}

/** 活卡整张 JSON —— 首个后台任务到来时 sendCard 用。streaming 开。
 *  初始 body = 每任务一个 panel。 */
export function backgroundLiveCard(
  tasks: BgTaskEntry[],
  now: number = Date.now(),
  liveElapsedMode: LiveElapsedMode = 'bucket',
): object {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: backgroundLiveSummary(tasks) },
    },
    body: {
      elements: tasks.map(t => backgroundTaskPanel(t, now, liveElapsedMode)),
    },
  }
}

/** 历史沉降卡 —— 用户发新消息且仍有活跃任务时,把旧卡 updateCard 成这个。
 *  只渲染终态任务,streaming 关。留在原地不再跟随。 */
export function backgroundHistoryCard(
  tasks: BgTaskEntry[],
  now: number = Date.now(),
  liveElapsedMode: LiveElapsedMode = 'bucket',
): object {
  const terminal = tasks.filter(isBgTerminal)
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: { content: `🧭 后台任务(历史) · ${terminal.length} 已结束` },
    },
    body: {
      elements: terminal.map(t => backgroundTaskPanel(t, now, liveElapsedMode)),
    },
  }
}

/** 固定标识卡 —— 旧卡撤销时若全部仍在跑(无终态),updateCard 成这个占位。 */
export function backgroundMigratedMarker(): object {
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: { content: '↪ 后台任务进行中' },
    },
    body: {
      elements: [{
        tag: 'markdown',
        element_id: 'bg_marker',
        content: '↪ 本轮后台任务仍在进行，进度已迁至最新卡片',
      }],
    },
  }
}
