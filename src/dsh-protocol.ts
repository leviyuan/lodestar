import type { DshReasoningEffort } from './agent-process'
import type { ConversationLaunch } from './conversation'

/** Lodestar owns this small protocol; DSH's preview APIs stay inside the child. */
export const DSH_VERSION = '0.1.5-alpha.2'
export const DSH_PROTOCOL_VERSION = 1
export interface DshModel {
  model: string
  display: string
  efforts: DshReasoningEffort[]
  defaultEffort: DshReasoningEffort
  contextWindow: number | null
  isDefault: boolean
}
export interface DshOpenOptions {
  cwd: string
  model: string
  effort: DshReasoningEffort
  launch: ConversationLaunch
  allowDelegation: boolean
  developerInstructions: string
  allowedTools?: string[]
}
export interface DshNotification {
  method: string
  params: any
}
