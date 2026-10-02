import type { AgentProvider } from './agent-process'
import type { AgentRunOwner } from './agent-run-types'
import type { Session } from './session'

export interface AgentExecutionContext {
  owner: AgentRunOwner
  codexAccountId?: string
  sessionInstructions?: (provider: AgentProvider) => string
}

export type AgentPrincipal =
  | { kind: 'session'; session: Session; depth: -1 }
  | { kind: 'project'; context: AgentExecutionContext; depth: -1 }
  | { kind: 'worker'; context: AgentExecutionContext; runId: string; identityId: string; depth: number }

export function agentPrincipalContext(principal: AgentPrincipal): AgentExecutionContext {
  if (principal.kind !== 'session') return principal.context
  const session = principal.session
  return {
    owner: { kind: 'session', name: session.sessionName, chatId: session.chatId, workDir: session.workDir },
    codexAccountId: session.codexAccountId(),
    sessionInstructions: provider => session.delegatedAgentDeveloperInstructions(provider),
  }
}
