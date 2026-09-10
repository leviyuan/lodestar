/** Cordis plugin loaded only in the Node DSH child, never in the daemon. */
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-attachment'
import type { DshOpenOptions } from './dsh-protocol.ts'

export const name = 'lodestar-bridge'
export const inject = ['agents', 'llm', 'agentDefaultModel', 'sessionPersistence', 'tools', 'systemPrompt', 'userQuestions', 'compaction', 'shellEnv', 'attachments', 'sdkAppStartup']
const PROVIDER = 'deepseek-official'
const DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'workflow', 'ralph', 'send_message']

export function apply(ctx: Context): void {
  let root: AgentHandle | undefined
  let rootId: string | undefined
  let initialized = false
  let closing = false
  const lifecycle = new AbortController()
  let opening: Promise<unknown> | undefined
  let selected: LlmCallConfig | undefined
  let turnRoute: LlmCallConfig | undefined
  let lastEnd: SessionEvent<'turn/end'> | undefined
  let activeTurn = 0
  let turnFailure: string | undefined
  let settledSeq = -1
  let settling: Promise<void> | undefined
  const questions = new Map<string, { resolve: (answer: any) => void; reject: (error: Error) => void }>()
  const notify = (method: string, params: unknown): void => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  const fail = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`lodestar-dsh: ${message}\n`)
    notify('failure', { message })
  }
  const live = (): Agent => {
    if (!root || closing) throw new Error('DSH session is not open')
    return root.agent
  }
  const delegationContext = process.env.DSH_LODESTAR_AGENT_CONTEXT
  delete process.env.DSH_LODESTAR_AGENT_CONTEXT
  ctx.shellEnv.register({ name: 'lodestar-agent',
    variables: { DSH_LODESTAR_AGENT_CONTEXT: { description: 'Lodestar delegation context for the current root agent only.' } },
    resolve: execution => delegationContext && execution.agent === root?.agent
      ? { DSH_LODESTAR_AGENT_CONTEXT: delegationContext } : {},
  })
  const settle = (): void => {
    if (root?.agent.status === 'idle' && turnFailure && lastEnd?.data.turn !== activeTurn) {
      const message = turnFailure
      turnFailure = undefined
      fail(new Error(`DSH turn could not be committed: ${message}`))
      return
    }
    if (settling || !lastEnd || !root || root.agent.status !== 'idle' || lastEnd.seq <= settledSeq) return
    const end = lastEnd
    settling = ctx.sessionPersistence.flush().then(() => {
      settledSeq = end.seq
      notify('settled', { sessionId: rootId, event: end })
    }).catch(error => { settledSeq = end.seq; fail(error) }).finally(() => { settling = undefined; settle() })
  }
  ctx.on('session/event', (session, event) => {
    notify('session.event', { sessionId: session.id, event })
    if (session.id === rootId && event.type === 'turn/start') {
      turnRoute = selected
      if (root) Object.assign(root.agent.options, selected)
      activeTurn = event.data.turn
      turnFailure = undefined
    }
    if (session.id === rootId && event.type === 'turn/end') {
      lastEnd = event as SessionEvent<'turn/end'>
      queueMicrotask(settle)
    }
  })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    notify('assistant.frame', { sessionId: agent.session.id, frame })
  })
  ctx.on('agent/status', ({ agent, status }) => {
    notify('session.status', { sessionId: agent.session.id, status })
    if (agent.session.id === rootId && status === 'idle') settle()
  })
  ctx.on('agent/error', ({ agent, error }) => {
    const message = error instanceof Error ? error.message : String(error)
    if (agent.session.id === rootId) turnFailure = message
    notify('agent.error', { sessionId: agent.session.id, message })
  })
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.id === rootId) return
    // Native descendants retain coding tools but can never delegate again.
    agent.ctx.tools.restrict({ deny: DELEGATION_TOOLS })
    notify('subagent.started', { sessionId: agent.session.id, parentSessionId: agent.session.header.parentSession })
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent.session.id !== rootId) notify('subagent.disposed', { sessionId: agent.session.id })
  })
  ctx.on('approval/request', async () => 'allowed-once')
  ctx.on('user-questions/request', request => {
    if (request.agent !== root?.agent || closing) throw new Error('DSH question is not owned by this session')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const abort = () => {
        questions.delete(id)
        notify('question.cancelled', { id })
        reject(new Error('DSH question cancelled'))
      }
      if (request.signal?.aborted) return abort()
      questions.set(id, {
        resolve: (answer) => { request.signal?.removeEventListener('abort', abort); resolve(answer) },
        reject: (error) => { request.signal?.removeEventListener('abort', abort); reject(error) },
      })
      request.signal?.addEventListener('abort', abort, { once: true })
      notify('question', { id, questions: request.questions })
    })
  })

  async function catalog() {
    const models = await ctx.llm.listModels(PROVIDER)
    if (!models.length) throw new Error('DSH model catalog is empty')
    return Promise.all(models.map(async model => {
      const info = await ctx.llm.resolveModelInfo(PROVIDER, model.id)
      if (!info.reasoning?.efforts.length || !info.reasoning.defaultEffort) {
        throw new Error(`DSH model ${model.id} has no reasoning catalog/default`)
      }
      return {
        model: model.id, display: model.name,
        efforts: info.reasoning.efforts.map(e => e.id),
        defaultEffort: info.reasoning.defaultEffort,
        contextWindow: info.context?.contextWindow ?? null,
        isDefault: ctx.agentDefaultModel.currentSelection().provider === PROVIDER && ctx.agentDefaultModel.currentSelection().model === model.id,
      }
    }))
  }
  async function route(model: string, effort: string): Promise<LlmCallConfig> {
    const info = (await catalog()).find(entry => entry.model === model)
    if (!info || !info.efforts.some(e => e === effort)) throw new Error(`DSH model/effort unavailable: ${model}/${effort}`)
    return ctx.llm.resolveCallConfig({ provider: PROVIDER, model, reasoningEffort: ReasoningEffortId(effort) })
  }
  async function open(input: DshOpenOptions) {
    if (root || rootId) throw new Error('DSH process already owns a session')
    if (await realpath(input.cwd) !== await realpath(process.cwd())) throw new Error('DSH workspace differs from process cwd')
    selected = await route(input.model, input.effort)
    turnRoute = selected
    const setup = (agentCtx: Context, agent: Agent): void => {
      // Selection changes are staged until the next root turn, including steering.
      agentCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembly = await next()
        if (context.scope !== agent) return assembly
        return { ...assembly, variables: { ...assembly.variables, provider: turnRoute!.provider, model: turnRoute!.model } }
      })
      agentCtx.on('agent/request', async (payload, next) => {
        const resolved = await next()
        return payload.agent === agent ? { ...resolved, ...turnRoute } : resolved
      })
      if (!input.allowDelegation) agentCtx.tools.restrict({ deny: DELEGATION_TOOLS })
      if (input.allowedTools) agentCtx.tools.restrict({ allow: input.allowedTools })
      if (input.developerInstructions) {
        agentCtx.systemPrompt.section({ name: 'lodestar:instructions', order: 999, text: input.developerInstructions })
      }
      // A resumed selection is explicit and cannot inherit a previous account route.
      Object.assign(agent.options, selected)
    }
    const launch = input.launch
    if (!['fresh', 'resume', 'fork'].includes(launch.kind)) throw new Error('unknown DSH launch kind')
    if (launch.kind !== 'fresh') {
      if (launch.source.provider !== 'dsh' || launch.source.cwd !== input.cwd) throw new Error('DSH source provider/cwd mismatch')
      const snapshot = await ctx.sessionPersistence.stat(launch.source.sessionId as SessionId)
      if (!snapshot || !snapshot.header.cwd || await realpath(snapshot.header.cwd) !== await realpath(input.cwd)) {
        throw new Error('DSH stored session missing or belongs to another workspace')
      }
    }
    rootId = launch.kind === 'resume' ? launch.source.sessionId : `session-${randomUUID()}`
    lastEnd = undefined
    try {
      lifecycle.signal.throwIfAborted()
      if (launch.kind === 'resume') {
        root = await ctx.agents.resume({ resumeSessionId: rootId as SessionId, agentOptions: selected, setup, signal: lifecycle.signal })
      } else if (launch.kind === 'fork') {
        const stored = await ctx.sessionPersistence.open(launch.source.sessionId as SessionId, 'read')
        let events: readonly SessionEvent[]
        try { events = (await stored.read()).events } finally { await stored.close() }
        const at = launch.through
        if (at && (at.provider !== 'dsh' || at.kind !== 'event' || at.source.sessionId !== launch.source.sessionId
          || !/^\d+$/.test(at.id) || !Number.isSafeInteger(Number(at.id)))) throw new Error('invalid DSH fork checkpoint')
        const boundary = at ? events.find(e => e.seq === Number(at.id) && e.type === 'turn/end')
          : [...events].reverse().find(e => e.type === 'turn/end')
        if (!boundary) throw new Error('DSH fork source has no completed turn at requested checkpoint')
        const seed = events.slice(0, boundary.seq + 1)
        root = await ctx.agents.create({ sessionId: rootId as SessionId, seed,
          inheritedEventCount: SessionLogOffset(seed.length),
          meta: { cwd: input.cwd, parentSession: launch.source.sessionId as SessionId, isSeeded: true },
          agentOptions: selected, setup, signal: lifecycle.signal })
      } else {
        root = await ctx.agents.create({ sessionId: rootId as SessionId, meta: { cwd: input.cwd }, agentOptions: selected, setup, signal: lifecycle.signal })
      }
      await ctx.sessionPersistence.flush()
      lifecycle.signal.throwIfAborted()
      return { sessionId: rootId, models: await catalog() }
    } catch (error) {
      // Keep a successfully acquired handle available for shutdown after failure.
      if (!root) rootId = undefined
      throw error
    }
  }

  async function dispatch(method: string, params: any): Promise<unknown> {
    if (closing && method !== 'shutdown') throw new Error('DSH runtime is closing')
    if (method === 'initialize') {
      if (initialized) throw new Error('DSH already initialized')
      await ctx.get('loader')?.await()
      initialized = true
      return { protocolVersion: 1, runtimeVersion: '0.1.5-alpha.2' }
    }
    if (!initialized) throw new Error('DSH not initialized')
    switch (method) {
      case 'model/list': return catalog()
      case 'session/open': {
        if (opening) throw new Error('DSH session initialization is already in progress')
        opening = open(params)
        try { return await opening } finally { opening = undefined }
      }
      case 'session/list': {
        if (await realpath(params.cwd) !== await realpath(process.cwd())) throw new Error('DSH history cwd differs from process workspace')
        const entries = await ctx.sessionPersistence.list()
        const rows = []
        for (const { header } of [...entries].sort((a, b) => b.header.createdAt - a.header.createdAt)) {
          // Lodestar conversation references bind the original absolute cwd.
          // Unrelated, possibly deleted worktrees never need to be opened.
          if (header.origin === 'subagent' || header.cwd !== params.cwd) continue
          const stored = await ctx.sessionPersistence.open(header.id, 'read')
          let preview: string = header.id
          try {
            const { events } = await stored.read(0, 256)
            const input = events.find(e => e.type === 'user/message' && e.data.source.kind === 'user')
            if (input?.type === 'user/message') {
              const text = input.data.content.filter(part => part.type === 'text').map(part => part.text).join(' ')
              if (text.trim()) preview = text.replace(/\s+/g, ' ').slice(0, 120)
            }
          } finally { await stored.close() }
          rows.push({ provider: 'dsh', sessionId: header.id, cwd: header.cwd, ts: header.createdAt, preview })
        }
        return rows.sort((a, b) => b.ts - a.ts)
      }
      case 'session/model': {
        live()
        selected = await route(params.model, params.effort)
        return {}
      }
      case 'session/prompt': {
        const agent = live()
        if (!Array.isArray(params.content) || !params.content.length) throw new Error('empty DSH prompt')
        if (params.content.some((part: any) => part.type === 'image')) {
          const routeInfo = await ctx.llm.resolveModelInfo(PROVIDER, selected!.model)
          if (!routeInfo.inputModalities?.includes('image')) throw new Error(`DSH model ${selected!.model} does not accept images`)
        }
        const content = await ctx.attachments.admitPromptContent(params.content)
        const message = createUserMessage({ content: content as ContentBlock[], source: { kind: 'user' } })
        const delivery = params.mode === 'auto' ? agent.status === 'running' ? 'steer' : 'queue' : params.mode
        if (delivery === 'steer') agent.steer(message)
        else if (delivery === 'queue') agent.followup(message)
        else throw new Error('invalid DSH input mode')
        return { messageId: message.id }
      }
      // Node fetch attaches a non-enumerable stack accessor to a mutable abort
      // reason. DSH persists this exact cause and requires lossless JSON.
      case 'session/cancel': live().cancel(Object.freeze({ kind: 'user' as const }), { keepInbox: true }); return {}
      case 'question/answer': {
        const pending = questions.get(params.id)
        if (!pending) throw new Error('DSH question no longer pending')
        if (params.error) pending.reject(new Error(String(params.error)))
        else pending.resolve({ answers: params.answers })
        questions.delete(params.id)
        return {}
      }
      case 'session/compact': {
        const agent = live()
        if (agent.status !== 'idle') throw new Error('DSH compaction requires an idle session')
        const result = await ctx.compaction.compactNow(agent, new AbortController().signal)
        await ctx.sessionPersistence.flush()
        return result
      }
      case 'shutdown': {
        closing = true
        lifecycle.abort(Object.freeze({ kind: 'disposed' as const }))
        if (opening) {
          try { await opening }
          catch (error) { process.stderr.write(`lodestar-dsh: initialization cancelled during shutdown: ${String(error)}\n`) }
        }
        for (const pending of questions.values()) pending.reject(new Error('DSH shutdown'))
        questions.clear()
        if (root) {
          for (const agent of ctx.agents.list()) {
            if (agent === root.agent || ctx.agents.isOwnedBy(agent.id, root.agent)) {
              agent.cancel(Object.freeze({ kind: 'disposed' as const }))
            }
          }
          await root.dispose()
        }
        await settling
        await ctx.sessionPersistence.flush()
        return {}
      }
      default: throw new Error(`unknown Lodestar DSH method: ${method}`)
    }
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', line => {
    let request: any
    try {
      request = JSON.parse(line)
      if (request.jsonrpc !== '2.0' || typeof request.id !== 'number' || typeof request.method !== 'string') {
        throw new Error('invalid Lodestar DSH request envelope')
      }
    } catch (error) { fail(error); return }
    void dispatch(request.method, request.params).then(
      result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'),
      error => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }) + '\n'),
    )
  })
  ctx.effect(() => () => { lines.close() })
  // Deliberately no model loop here: DSH owns tools, scheduling and persistence.
}
