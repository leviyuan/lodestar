export const MAX_AGENT_PROMPT_CHARS = 800_000

export interface AgentRunRequest {
  identityIds: string[]
  prompt: string
  effort?: string
}

export interface AgentFollowUpRequest {
  identityId?: string
  prompt: string
  effort?: string
}

export interface AgentAnswerRequest {
  identityId?: string
  requestId: string
  answers: Record<string, string>
}

export interface AgentInputOption {
  label: string
  description?: string
}

export interface AgentInputQuestion {
  id: string
  header?: string
  question: string
  options: AgentInputOption[]
}

export interface AgentInputRequest {
  requestId: string
  toolUseId?: string
  questions: AgentInputQuestion[]
}

export interface AgentStep {
  at: string
  phase: 'started' | 'completed' | 'info'
  tool: string
  detail: string
}

export type AgentWorkerStatus = 'queued' | 'running' | 'needs_input' | 'completed' | 'failed' | 'cancelled'
export type AgentRunStatus = 'queued' | 'running' | 'needs_input' | 'completed' | 'failed' | 'cancelled'

export interface AgentWorkerResult {
  identityId: string
  identityName: string
  tokenSourceId: string
  provider: 'codex' | 'claude' | 'dsh'
  model: string
  effort: string
  status: AgentWorkerStatus
  output: string
  /** Durable output is stored separately so lifecycle snapshots stay small. */
  outputArtifact?: string
  outputTruncated?: boolean
  sessionId?: string
  checkpointId?: string
  pendingInput?: AgentInputRequest
  queuedReason?: string
  steps: AgentStep[]
  error?: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  usage?: Record<string, number | undefined> | null
}

export interface AgentRunSnapshot {
  runId: string
  sessionName: string
  chatId: string
  workDir: string
  prompt: string
  /** Durable prompt body is stored separately from lifecycle metadata. */
  promptArtifact?: string
  parentRunId?: string
  parentKind?: 'delegate' | 'follow_up'
  /** Legacy history metadata. New tasks are always main-Agent delegates (0). */
  depth: number
  status: AgentRunStatus
  workers: AgentWorkerResult[]
  createdAt: string
  finishedAt?: string
  error?: string
  presentationErrors?: string[]
  cardMessageId?: string
}

export function parseAgentRunRequest(raw: unknown): AgentRunRequest {
  const value = objectValue(raw, 'agent run request')
  const ids = Array.isArray(value.identity_ids)
    ? value.identity_ids.map(String)
    : Array.isArray(value.identityIds)
      ? value.identityIds.map(String)
      : []
  const identityIds = [...new Set(ids.map(id => id.trim()).filter(Boolean))]
  if (identityIds.length === 0) throw new Error('agent run requires at least one identity_id')
  if (identityIds.length > 64) throw new Error('agent run supports at most 64 identities')
  const prompt = requiredPrompt(value.prompt, 'agent run requires "prompt"')
  const effort = optionalString(value.effort)
  return { identityIds, prompt, ...(effort ? { effort } : {}) }
}

export function parseAgentFollowUpRequest(raw: unknown): AgentFollowUpRequest {
  const value = objectValue(raw, 'agent follow-up request')
  const prompt = requiredPrompt(value.prompt, 'agent follow-up requires "prompt"')
  const identityId = optionalString(value.identity_id ?? value.identityId)
  const effort = optionalString(value.effort)
  return {
    prompt,
    ...(identityId ? { identityId } : {}),
    ...(effort ? { effort } : {}),
  }
}

export function parseAgentAnswerRequest(raw: unknown): AgentAnswerRequest {
  const value = objectValue(raw, 'agent answer request')
  const identityId = optionalString(value.identity_id ?? value.identityId)
  const requestId = optionalString(value.request_id ?? value.requestId)
  if (!requestId) throw new Error('agent answer requires request_id')
  if (!value.answers || typeof value.answers !== 'object' || Array.isArray(value.answers)) {
    throw new Error('agent answer requires an answers object')
  }
  const answers: Record<string, string> = {}
  for (const [key, answer] of Object.entries(value.answers as Record<string, unknown>)) {
    if (!key.trim()) throw new Error('agent answer contains an empty question key')
    answers[key] = String(answer)
  }
  if (Object.keys(answers).length === 0) throw new Error('agent answer requires at least one answer')
  return { requestId, answers, ...(identityId ? { identityId } : {}) }
}

function objectValue(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be an object`)
  return raw as Record<string, unknown>
}

function requiredPrompt(raw: unknown, message: string): string {
  const prompt = String(raw ?? '')
  if (!prompt.trim()) throw new Error(message)
  if (prompt.length > MAX_AGENT_PROMPT_CHARS) {
    throw new Error(`agent prompt exceeds ${MAX_AGENT_PROMPT_CHARS} chars`)
  }
  return prompt
}

function optionalString(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value || undefined
}
