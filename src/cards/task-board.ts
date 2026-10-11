/**
 * Claude TaskCreate/Update/List/Get 的累积状态与卡片渲染。
 * TaskCreate 结果兼容 JSON 和 "Task #N created successfully: ..." 文本；
 * TaskUpdate 兼容 taskId/id/task_id，缺失任务等待 Create/List 补齐。
 * session-tools.ts 在工具完成时应用更新，再渲染整个任务板。
 */

import { ELEMENTS } from './elements'

/** 一条任务在板上的累积视图。status 含 'deleted' —— 删除先标记,供渲染层过滤;
 * 真正移除由 TaskList 全量替换自然回收。 */
export interface TaskBoardEntry {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
}

export type TaskToolName = 'TaskCreate' | 'TaskUpdate' | 'TaskList' | 'TaskGet'

const TASK_TOOL_NAMES: ReadonlySet<TaskToolName> = new Set([
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
])

/** 判定 + 类型收窄合一:是 Task 工具就返回它的强类型名,否则 null。 */
export function asTaskToolName(name: string): TaskToolName | null {
  return TASK_TOOL_NAMES.has(name as TaskToolName) ? name as TaskToolName : null
}

/** 本次渲染的是哪个操作 + 面板状态。header 上的"创建任务/更新任务/..."区分
 * 仍保留(让用户知道这一步在干嘛),但 body 永远渲染整个 board 的当前快照。 */
export interface TaskBoardOp {
  name: TaskToolName
  status: '⏳' | '✅' | '❌'
}

const OP_LABEL: Record<TaskToolName, string> = {
  TaskCreate: '创建任务',
  TaskUpdate: '更新任务',
  TaskList: '任务列表',
  TaskGet: '查看任务',
}

const STATUS_LABEL: Record<TaskBoardEntry['status'], string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '完成',
  deleted: '已删',
}

/** 状态 emoji —— 列表行用,与 header 的 ✅⏳❌(工具执行状态)呼应,让任务状态
 * 也视觉化、风格统一:⬜待办 / 🔄进行中 / ✅完成。 */
const STATUS_EMOJI: Record<TaskBoardEntry['status'], string> = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
  deleted: '🗑️',
}

function parseOutput(output: string | null): any {
  if (!output) return null
  try {
    const parsed = JSON.parse(output)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** task id 防御性读取:官方说 SDK 会把 id/task_id 修成 taskId,但修复不反映在
 * 流里,所以三种名都认。 */
function taskIdOf(t: any): string {
  return String(t?.taskId ?? t?.id ?? t?.task_id ?? '').trim()
}

function subjectOf(t: any): string {
  return String(t?.subject ?? t?.content ?? '').trim()
}

/** 状态读取:合法值返回,缺省/非法返回 undefined(供调用方区分"改状态"vs"不改")。 */
function statusOf(t: any): TaskBoardEntry['status'] | undefined {
  const s = t?.status
  return s === 'pending' || s === 'in_progress' || s === 'completed' || s === 'deleted'
    ? s
    : undefined
}

/** 没有可靠 id 时的稳定回退 key —— 用 subject 本身,保证同一 subject 不会
 * 重复堆叠。仅在 TaskCreate output 既无 JSON id 也无 #N 文本时使用。 */
function fallbackId(subject: string): string {
  return `subj:${subject}`
}

/** 从 TaskCreate 的**纯文本** result 解析 id —— "Task #1 created successfully:
 * xxx" → "1";"Updated task #1 status" → "1"。官方规范是 JSON {task:{id}},
 * 但实测 Claude Code 流的是文本,两种都要兼容。 */
function idFromResultText(text: string): string {
  const m = text.match(/#\s*(\d+)/)
  return m ? m[1] : ''
}

function entryFromSnapshot(t: any): TaskBoardEntry | null {
  const subject = subjectOf(t)
  if (!subject) return null
  const id = taskIdOf(t) || fallbackId(subject)
  return {
    id,
    subject,
    description: typeof t?.description === 'string' ? t.description : undefined,
    activeForm: typeof t?.activeForm === 'string' ? t.activeForm : undefined,
    status: statusOf(t) ?? 'pending',
  }
}

/**
 * 把一次 Task 工具调用累积到 board 上,返回**新** board(不可变更新)。
 *
 * - TaskList → output 是完整快照(JSON {tasks:[...]},含空数组),全量替换;
 *   解析失败/非 JSON 保留旧 board。
 * - TaskCreate → 从 output 抓 id(JSON {task:{id}} 或纯文本 "Task #N ..."),
 *   按 id upsert;同 id 保留旧 status(不重置回 pending)。
 * - TaskUpdate → 按 id(input 的 taskId/id/task_id)改 status/subject;
 *   status='deleted' 移除;**找不到 id 不造假条目**(no-fallbacks)。
 * - TaskGet → output 单条详情,补全/刷新板上对应条目。
 *
 * addTool 阶段(output=null)调用各分支会安全 no-op 返回原 board。
 */
export function applyTaskTool(
  board: TaskBoardEntry[],
  name: TaskToolName,
  input: any,
  output: string | null,
  displayInput?: any,
): TaskBoardEntry[] {
  // ── TaskList:全量快照,权威替换(校正之前所有漂移) ──
  if (name === 'TaskList') {
    const parsed = parseOutput(output)
    const tasksArr: any[] | null = Array.isArray(parsed?.tasks)
      ? parsed.tasks
      : Array.isArray(parsed)
        ? parsed
        : null
    if (tasksArr === null) return board  // 解析失败/非 JSON:数据缺失,保留旧 board
    const next: TaskBoardEntry[] = []
    for (const t of tasksArr) {
      const e = entryFromSnapshot(t)
      if (e) next.push(e)
    }
    return next
  }

  // ── TaskCreate:从 output 抓 id(JSON 或纯文本),按 id upsert ──
  if (name === 'TaskCreate') {
    // 批量创建:input.tasks 数组(schema 支持,实测未见但兼容)
    const inputTasks = Array.isArray(input?.tasks) ? input.tasks : null
    if (inputTasks) {
      const parsed = parseOutput(output)
      const resultTasks: any[] | null = Array.isArray(parsed?.tasks)
        ? parsed.tasks
        : Array.isArray(parsed) ? parsed : null
      let next = board
      inputTasks.forEach((it: any, idx: number) => {
        const shown = displayInput === undefined ? it : displayInput.tasks[idx]
        const subject = subjectOf(shown)
        if (!subject) return
        const fromResult = resultTasks?.[idx]
        const id = (fromResult && taskIdOf(fromResult)) || idFromResultText(output ?? '')
        next = upsertCreate(next, id, subject, shown)
      })
      return next
    }
    // 单条
    const parsed = parseOutput(output)
    const t = parsed?.task ?? parsed
    const id = taskIdOf(t) || idFromResultText(output ?? '')
    const subject = displayInput === undefined ? subjectOf(t) || subjectOf(input) : subjectOf(displayInput)
    if (!subject) return board
    return upsertCreate(board, id, subject, displayInput ?? input)
  }

  // ── TaskUpdate:按 id 改 status/subject;找不到 no-op(绝不拿 id 当内容) ──
  if (name === 'TaskUpdate') {
    const id = taskIdOf(input)
    if (!id) return board
    const status = statusOf(input)
    if (status === 'deleted') return board.filter(e => e.id !== id)
    const newSubject = subjectOf(input)
    if (board.some(e => e.id === id)) {
      return board.map(e => e.id === id
        ? {
            ...e,
            ...(status ? { status } : {}),
            ...(newSubject ? { subject: newSubject } : {}),
            ...(typeof input?.activeForm === 'string' ? { activeForm: input.activeForm } : {}),
          }
        : e)
    }
    // board 里没这条:不造假条目(no-fallbacks)。TaskCreate 拿到正确 id 后自然对上;
    // 若顺序颠倒或 resume 后板空,等下一次 TaskList 全量校正。
    return board
  }

  // ── TaskGet:单条详情,补全/刷新 ──
  if (name === 'TaskGet') {
    const parsed = parseOutput(output)
    const t = parsed?.task ?? parsed
    const id = taskIdOf(t) || taskIdOf(input)
    if (!id) return board
    const existing = board.find(e => e.id === id)
    const subject = subjectOf(t) || existing?.subject || subjectOf(input)
    if (!subject) return board
    const merged: TaskBoardEntry = {
      id,
      subject,
      description: typeof t?.description === 'string' ? t.description : existing?.description,
      activeForm: typeof t?.activeForm === 'string' ? t.activeForm : existing?.activeForm,
      status: statusOf(t) ?? existing?.status ?? 'pending',
    }
    return existing
      ? board.map(e => e.id === id ? merged : e)
      : [...board, merged]
  }

  return board
}

/** TaskCreate 的 upsert:同 id 更新(保留旧 status,不重置回 pending),否则追加
 * pending。带 activeForm/description 时一并记下(渲染进行中项优先用 activeForm)。 */
function upsertCreate(board: TaskBoardEntry[], id: string, subject: string, src: any): TaskBoardEntry[] {
  const key = id || fallbackId(subject)
  const extra = {
    ...(typeof src?.activeForm === 'string' && src.activeForm ? { activeForm: src.activeForm } : {}),
    ...(typeof src?.description === 'string' && src.description ? { description: src.description } : {}),
  }
  if (board.some(e => e.id === key)) {
    return board.map(e => e.id === key ? { ...e, id: key, subject, ...extra } : e)
  }
  return [...board, { id: key, subject, status: 'pending', ...extra }]
}

/** 渲染当前 board 的统计摘要,用作面板 header —— 与 codex TodoWrite 的
 * summarizeTodoInput 输出格式对齐("N 项 · 进行中 X · 待办 Y")。 */
export function summarizeTaskBoard(board: TaskBoardEntry[]): string {
  const visible = board.filter(t => t.status !== 'deleted')
  if (visible.length === 0) return '空'
  const counts = new Map<string, number>()
  for (const t of visible) {
    const label = STATUS_LABEL[t.status]
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  // 固定顺序:进行中 → 待办 → 完成,让进度一眼可读。
  const order = ['进行中', '待办', '完成']
  const summary = order
    .map(label => counts.has(label) ? `${label} ${counts.get(label)}` : '')
    .filter(Boolean)
    .join(' · ')
  return `${visible.length} 项${summary ? ` · ${summary}` : ''}`
}

function renderTaskBoardBody(board: TaskBoardEntry[], resolvedNote?: string): string {
  const visible = board.filter(t => t.status !== 'deleted')
  const lines: string[] = [`**待办**: ${visible.length} 项`]
  // 始终按 #N(创建顺序)排列 —— 不按状态重排,否则 #1 一旦完成就沉底,顺序乱。
  const numId = (id: string): number => {
    const n = parseInt(id, 10)
    return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n
  }
  const ordered = [...visible].sort((a, b) => {
    const d = numId(a.id) - numId(b.id)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
  for (const t of ordered.slice(0, 12)) {
    const emoji = STATUS_EMOJI[t.status]
    // 进行中时优先用 activeForm(更"正在进行"的语气),其余用 subject。
    const content = (t.status === 'in_progress' && t.activeForm) ? t.activeForm : t.subject
    lines.push(`- ${emoji} ${content || '(空)'}`)
  }
  if (ordered.length > 12) lines.push(`- 还有 ${ordered.length - 12} 项未显示`)
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  return lines.join('\n')
}

/**
 * Task 工具的面板:header 是本次操作名 + board 统计,body 是整个 board 的列表
 * 快照。与 codex TodoWrite 面板视觉一致 —— 无论这次是 Create/Update/Get,
 * 用户看到的都是"当前完整任务板 + 进度",而不是孤立的单条。session-tools.ts
 * 会让一次任务流程里的所有 Task 工具复用同一个面板(同一 element_id)。
 */
export function taskBoardElement(
  i: number,
  board: TaskBoardEntry[],
  op: TaskBoardOp,
  resolvedNote?: string,
): object {
  const toolName = OP_LABEL[op.name]
  const summary = summarizeTaskBoard(board)
  const headerText = `${op.status} 🔧 ${toolName}: ${summary}`
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: false,
    elements: [
      { tag: 'markdown', content: renderTaskBoardBody(board, resolvedNote) },
    ],
  }
}

/**
 * 实时任务总览面板(footer 正前常驻)。与 timeline 上的 taskBoardElement 并存:
 * 那个折叠、记录"每次 Task 工具调用时的 board 快照"(过程变更记录);这个展开、
 * 始终反映 board 最新态(实时总览),对齐 claude cli 底部常驻 todo。
 *
 * header 固定 "📋 任务总览 · 统计" —— 不挂操作名也不挂 ⏳/✅,因为它不代表某次
 * 工具调用,而是全局任务进度的持续视图。expanded=true 让用户不用点开就能看任务。
 * body 复用 renderTaskBoardBody,与 timeline 面板视觉一致(同 emoji/排序/截断)。 */
export function taskBoardLiveElement(board: TaskBoardEntry[]): object {
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.taskBoardLive,
    header: { title: { tag: 'plain_text', content: `📋 任务总览 · ${summarizeTaskBoard(board)}` } },
    expanded: true,
    elements: [
      { tag: 'markdown', content: renderTaskBoardBody(board) },
    ],
  }
}
