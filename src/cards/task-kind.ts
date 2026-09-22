/** The three user-visible kinds of work shown on the shared task card. */
export type AgentCardTaskKind = 'delegated' | 'subagent' | 'background'

export const AGENT_CARD_TASK_KIND_ORDER: readonly AgentCardTaskKind[] = [
  'delegated', 'subagent', 'background',
]

export function agentCardTaskKindLabel(kind: AgentCardTaskKind): string {
  switch (kind) {
    case 'delegated': return '委派任务'
    case 'subagent': return '子 Agent'
    case 'background': return '后台进程'
  }
}

export function agentCardTaskKindIcon(kind: AgentCardTaskKind): string {
  switch (kind) {
    case 'delegated': return '🧠'
    case 'subagent': return '🤖'
    case 'background': return '⚙️'
  }
}
