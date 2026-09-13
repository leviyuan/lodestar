import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Session } from './session'
import type { AgentService, AgentPrincipal } from './agent-service'
import { getAgentIdentityCatalog } from './agent-identities'
import {
  parseAgentAnswerRequest,
  parseAgentFollowUpRequest,
  parseAgentRunRequest,
  type AgentRunSnapshot,
} from './agent-run-types'
import { pendingTokenSourceModelRefresh } from './token-source'

const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface AgentApiContext {
  service: AgentService
  authorizeSession(capability: string): Session | null
}

export async function handleAgentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: AgentApiContext,
): Promise<boolean> {
  if (url.pathname !== '/agents' && !url.pathname.startsWith('/agents/')) return false
  const send = (status: number, value: object): true => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(value))
    return true
  }
  const capability = bearerToken(req.headers.authorization)
  if (!capability) return send(401, { error: 'missing bearer capability' })
  const principal = authorizePrincipal(context, capability)
  if (!principal) return send(403, { error: 'invalid or stale agent capability' })

  if (req.method === 'GET' && url.pathname === '/agents/identities') {
    await pendingTokenSourceModelRefresh()
    return send(200, serializeCatalog(getAgentIdentityCatalog(principal.session.codexAccountId())))
  }
  if (req.method === 'POST' && url.pathname === '/agents/runs') {
    try {
      const run = await context.service.startRun(principal, parseAgentRunRequest(await readJsonBody(req)))
      return send(202, serializeRun(run))
    } catch (error) {
      return send(409, { error: messageOf(error) })
    }
  }
  const match = url.pathname.match(/^\/agents\/runs\/([^/]+)(?:\/(follow-up|answer))?$/)
  if (!match) return send(405, { error: 'unsupported agent endpoint' })
  const runId = decodeRunId(match[1])
  if (!runId) return send(400, { error: 'invalid agent run id encoding' })
  const action = match[2]
  try {
    if (!action && req.method === 'GET') {
      return send(200, serializeRun(context.service.getRun(principal, runId)))
    }
    if (!action && req.method === 'DELETE') {
      const cancelled = await context.service.cancelRun(principal, runId, 'cancelled by agent client')
      return send(cancelled ? 200 : 409, cancelled
        ? { ok: true, run_id: runId }
        : { error: 'agent run is already terminal', run_id: runId })
    }
    if (action === 'follow-up' && req.method === 'POST') {
      const run = await context.service.followUp(principal, runId, parseAgentFollowUpRequest(await readJsonBody(req)))
      return send(202, serializeRun(run))
    }
    if (action === 'answer' && req.method === 'POST') {
      const run = await context.service.answer(principal, runId, parseAgentAnswerRequest(await readJsonBody(req)))
      return send(200, serializeRun(run))
    }
  } catch (error) {
    return send(409, { error: messageOf(error) })
  }
  return send(405, { error: 'unsupported agent endpoint' })
}

function authorizePrincipal(context: AgentApiContext, capability: string): AgentPrincipal | null {
  const session = context.authorizeSession(capability)
  if (session) return context.service.rootPrincipal(session)
  return context.service.principalForCapability(capability)
}

function decodeRunId(value: string): string | null {
  try { return decodeURIComponent(value) }
  catch { return null }
}

function bearerToken(header: string | undefined): string {
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? ''
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk.toString()
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
  }
  try { return JSON.parse(raw || '{}') }
  catch { throw new Error('bad json') }
}

function serializeCatalog(catalog: ReturnType<typeof getAgentIdentityCatalog>): object {
  return {
    catalog_generation: catalog.catalogGeneration,
    identities: catalog.identities.map(identity => ({
      id: identity.id,
      display_name: identity.displayName,
      token_source_id: identity.tokenSourceId,
      token_source_display: identity.tokenSourceDisplay,
      provider: identity.provider,
      model: identity.model,
      model_display: identity.modelDisplay,
      default_effort: identity.defaultEffort,
      supported_efforts: identity.supportedEfforts,
      source_default: identity.sourceDefault,
      status: identity.status,
      reason: identity.reason,
    })),
    source_failures: catalog.sourceFailures.map(failure => ({
      token_source_id: failure.tokenSourceId,
      display: failure.display,
      status: failure.status,
      reason: failure.reason,
    })),
  }
}

function serializeRun(run: AgentRunSnapshot): object {
  return {
    run_id: run.runId,
    session_name: run.sessionName,
    prompt: run.prompt,
    description: run.description,
    parent_run_id: run.parentRunId,
    parent_kind: run.parentKind,
    depth: run.depth,
    status: run.status,
    workers: run.workers.map(worker => ({
      identity_id: worker.identityId,
      identity_name: worker.identityName,
      token_source_id: worker.tokenSourceId,
      provider: worker.provider,
      model: worker.model,
      effort: worker.effort,
      status: worker.status,
      output: worker.output,
      output_truncated: worker.outputTruncated,
      session_id: worker.sessionId,
      checkpoint_id: worker.checkpointId,
      pending_input: worker.pendingInput && {
        request_id: worker.pendingInput.requestId,
        tool_use_id: worker.pendingInput.toolUseId,
        questions: worker.pendingInput.questions,
      },
      queued_reason: worker.queuedReason,
      steps: worker.steps,
      error: worker.error,
      started_at: worker.startedAt,
      finished_at: worker.finishedAt,
      duration_ms: worker.durationMs,
      usage: worker.usage,
    })),
    created_at: run.createdAt,
    finished_at: run.finishedAt,
    error: run.error,
    presentation_errors: run.presentationErrors,
    card_message_id: run.cardMessageId,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
