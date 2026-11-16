/** The three user-visible kinds of work shown on the shared task card. */
export type AgentCardTaskKind = 'delegated' | 'project' | 'subagent' | 'background'

export const AGENT_CARD_TASK_KIND_ORDER: readonly AgentCardTaskKind[] = [
  'delegated', 'project', 'subagent', 'background',
]

export function agentCardTaskKindLabel(kind: AgentCardTaskKind): string {
  switch (kind) {
    case 'project': return '项目任务'
    case 'delegated': return '委派任务'
    case 'subagent': return '子 Agent'
    case 'background': return '后台进程'
  }
}

/** Count-prefix labels for the task-card preview and the session status rows. */
export function agentCardTaskKindShortLabel(kind: AgentCardTaskKind): string {
  switch (kind) {
    case 'project': return '项目'
    case 'delegated': return '委派'
    case 'subagent': return '子Agent'
    case 'background': return '后台'
  }
}

/** Work a session still runs beside its main turn, shown after its status in `hi` and `bl`.
 * `background` is null when the backend's live background set could not be read. */
export interface SessionWorkload {
  background: number | null
  subagents: number
}

/** `子Agent2·后台1`, in the task-card preview's order. Zero counts are omitted, an
 * unreadable background count shows as `后台MISS`, and nothing running gives ''. */
export function sessionWorkloadLabel(workload: SessionWorkload | null | undefined): string {
  if (!workload) return ''
  const parts: string[] = []
  if (workload.subagents > 0) parts.push(`${agentCardTaskKindShortLabel('subagent')}${workload.subagents}`)
  const background = agentCardTaskKindShortLabel('background')
  if (workload.background === null) parts.push(`${background}MISS`)
  else if (workload.background > 0) parts.push(`${background}${workload.background}`)
  return parts.join('·')
}
