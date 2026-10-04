export const MAX_AGENT_PROMPT_CHARS = 800_000
export const MAX_AGENT_DESCRIPTION_CHARS = 60
export const PROJECT_AGENT_INPUT_ERROR = 'project Agent calls are non-interactive and have no question or answer interface; complete the supplied goal autonomously'

/** Ownership is independent of the chat used to display a run. */
export interface AgentRunOwner {
  kind: 'session' | 'project'
  name: string
  chatId: string
  workDir: string
}

export interface AgentRunRequest {
  identityIds: string[]
  description: string
  prompt: string
  effort?: string
  /** Fresh runs and native resumes stay within the caller's project directory. */
  workDir?: string
  /** Unique native conversation id, registered to the same project and group. */
  sessionId?: string
  requestId?: string
  /** Optional caller attribution; never enables file delivery. */
  requesterOpenId?: string
}

export interface AgentFollowUpRequest {
  identityId?: string
  description: string
  prompt: string
  effort?: string
  /** Optional working directory for this native continuation. */
  workDir?: string
  requestId?: string
  requesterOpenId?: string
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
  codexAccountId?: string
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
  /** Missing only on legacy, session-owned runs. */
  owner?: AgentRunOwner
  requestId?: string
  requestHash?: string
  requesterOpenId?: string
  /** Legacy history only. Agent output no longer triggers file delivery. */
  deliveryMode?: 'chat' | 'drive'
  codexAccountId?: string
  runId: string
  sessionName: string
  chatId: string
  /** Main Session's directory; legacy snapshots used workDir for both roles. */
  sessionWorkDir?: string
  workDir: string
  prompt: string
  /** Durable prompt body is stored separately from lifecycle metadata. */
  promptArtifact?: string
  /** Required for new runs; absent only in history written before compact cards. */
  description?: string
  parentRunId?: string
  /** Resume provenance only; never grants access or joins another owner's cancellation tree. */
  resumedFromRunId?: string
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
  const rawSessionId = value.session_id !== undefined ? value.session_id : value.sessionId
  const sessionId = optionalString(rawSessionId)
  if (rawSessionId !== undefined && !sessionId) throw new Error('agent session_id must be a non-empty string')
  if (value.session_id !== undefined && value.sessionId !== undefined
    && value.session_id !== value.sessionId) throw new Error('conflicting agent session_id and sessionId')
  if (sessionId && identityIds.length > 1) throw new Error('agent session continuation accepts at most one identity_id')
  if (!sessionId && identityIds.length === 0) throw new Error('agent run requires at least one identity_id')
  const prompt = requiredPrompt(value.prompt, 'agent run requires "prompt"')
  const effort = optionalString(value.effort)
  const workDir = parseWorkDir(value)
  return {
    identityIds, description: requireAgentDescription(value.description), prompt,
    ...(effort ? { effort } : {}), ...(sessionId ? { sessionId } : {}),
    ...(workDir !== undefined ? { workDir } : {}),
    ...parseProjectOptions(value),
  }
}

export function parseAgentFollowUpRequest(raw: unknown): AgentFollowUpRequest {
  const value = objectValue(raw, 'agent follow-up request')
  const prompt = requiredPrompt(value.prompt, 'agent follow-up requires "prompt"')
  const identityId = optionalString(value.identity_id ?? value.identityId)
  const effort = optionalString(value.effort)
  const workDir = parseWorkDir(value)
  return {
    description: requireAgentDescription(value.description),
    prompt,
    ...(identityId ? { identityId } : {}),
    ...(effort ? { effort } : {}),
    ...(workDir !== undefined ? { workDir } : {}),
    ...parseProjectOptions(value),
  }
}

function parseProjectOptions(value: Record<string, unknown>): { requestId?: string; requesterOpenId?: string } {
  const out: { requestId?: string; requesterOpenId?: string } = {}
  for (const [key, field] of [['request_id', 'requestId'], ['requester_open_id', 'requesterOpenId']] as const) {
    if (value[key] === undefined) continue
    const raw = value[key]
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 200 || /[\x00-\x1f]/.test(raw)) {
      throw new Error(`invalid ${key}`)
    }
    out[field] = raw.trim()
  }
  return out
}

export function agentRunOwner(run: AgentRunSnapshot): AgentRunOwner {
  return run.owner ?? { kind: 'session', name: run.sessionName, chatId: run.chatId, workDir: run.sessionWorkDir ?? run.workDir }
}

export function agentOwnerKey(owner: AgentRunOwner): string {
  return JSON.stringify([owner.kind, owner.name, owner.chatId, owner.workDir])
}

export function requireAgentWorkDir(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) {
    throw new Error('agent work_dir must be a non-empty path without null bytes')
  }
  return raw
}

function parseWorkDir(value: Record<string, unknown>): string | undefined {
  if (value.work_dir !== undefined && value.workDir !== undefined && value.work_dir !== value.workDir) {
    throw new Error('conflicting agent work_dir and workDir')
  }
  const raw = value.work_dir !== undefined ? value.work_dir : value.workDir
  return raw === undefined ? undefined : requireAgentWorkDir(raw)
}

export function requireAgentDescription(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('agent run requires "description" (CLI: --description)')
  const description = raw.trim()
  if (/[\r\n\u2028\u2029]/.test(description)) throw new Error('agent description must be a single line')
  if ([...description].length > MAX_AGENT_DESCRIPTION_CHARS) {
    throw new Error(`agent description exceeds ${MAX_AGENT_DESCRIPTION_CHARS} characters`)
  }
  return description
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
