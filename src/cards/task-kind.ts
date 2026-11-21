/** The three user-visible kinds of work shown on the shared task card. */
export type AgentCardTaskKind = 'delegated' | 'project' | 'subagent' | 'background'

export const AGENT_CARD_TASK_KIND_ORDER: readonly AgentCardTaskKind[] = [
  'delegated', 'project', 'subagent', 'background',
]

/** 子 Agent 与后台进程在产品里的通用图标：任务卡行、`hi`、`bl` 和单聊面板都用它表示这两类，
 * 不再写中文类别名，任何地方都取同一份定义。委派与项目任务不在卡片正文里成段出现，仍用中文。
 * 后台进程的 ⏳ 与任务「进行中」的状态图标相同，同一个字符串里只写一次。 */
export const AGENT_CARD_TASK_KIND_ICON: Readonly<Record<'subagent' | 'background', string>> = {
  subagent: '🤖',
  background: '⏳',
}

/** 中文类别名：只在需要和具体任务类型（`子 Agent`、`后台命令`）比较时用，界面上显示图标。 */
export function agentCardTaskKindName(kind: AgentCardTaskKind): string {
  switch (kind) {
    case 'project': return '项目任务'
    case 'delegated': return '委派任务'
    case 'subagent': return '子 Agent'
    case 'background': return '后台进程'
  }
}

/** 类别前缀：子 Agent 与后台进程用通用图标代替中文类别名，任务行、任务说明与状态句共用。 */
export function agentCardTaskKindLabel(kind: AgentCardTaskKind): string {
  switch (kind) {
    case 'project': return '项目任务'
    case 'delegated': return '委派任务'
    case 'subagent': return AGENT_CARD_TASK_KIND_ICON.subagent
    case 'background': return AGENT_CARD_TASK_KIND_ICON.background
  }
}

/** Count-prefix labels for the task-card preview and the session status rows. */
export function agentCardTaskKindShortLabel(kind: AgentCardTaskKind): string {
  switch (kind) {
    case 'project': return '项目'
    case 'delegated': return '委派'
    case 'subagent': return AGENT_CARD_TASK_KIND_ICON.subagent
    case 'background': return AGENT_CARD_TASK_KIND_ICON.background
  }
}

/** Work a session still runs beside its main turn, shown after its status in `hi` and `bl`.
 * `background` is null when the backend's live background set could not be read. */
export interface SessionWorkload {
  background: number | null
  subagents: number
}

/** `🤖2·⏳1`, in the task-card preview's order. Zero counts are omitted, an
 * unreadable background count shows as `⏳MISS`, and nothing running gives ''. */
export function sessionWorkloadLabel(workload: SessionWorkload | null | undefined): string {
  if (!workload) return ''
  const parts: string[] = []
  if (workload.subagents > 0) parts.push(`${agentCardTaskKindShortLabel('subagent')}${workload.subagents}`)
  const background = agentCardTaskKindShortLabel('background')
  if (workload.background === null) parts.push(`${background}MISS`)
  else if (workload.background > 0) parts.push(`${background}${workload.background}`)
  return parts.join('·')
}
