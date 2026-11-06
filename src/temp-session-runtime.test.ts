import { describe, expect, test } from 'bun:test'
import type { ConversationLaunch, ConversationRouting } from './conversation'
import {
  createTempSessionRuntime,
  type CreateTempSessionOptions,
  type TempSessionHandle,
} from './temp-session-runtime'

const routing: ConversationRouting = {
  provider: 'codex',
  tokenSourceId: 'codex-sub',
  model: 'gpt-5.6-sol',
  effort: 'high',
}

function createOptions(launch: ConversationLaunch = { kind: 'fresh' }): CreateTempSessionOptions {
  return {
    chatName: 'project*0821-1200',
    userOpenId: 'user-1',
    workDir: '/repo',
    routing,
    launch,
    branchBase: launch.kind === 'resume' ? null : launch,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

class FakeSession implements TempSessionHandle {
  readonly sessionName = 'project*0821-1200'
  workDir = '/repo'
  running = false
  startResult = true
  forkResult = true
  startError: unknown = null
  stopError: unknown = null
  appliedRouting: ConversationRouting | null = null
  forkLaunch: Extract<ConversationLaunch, { kind: 'fork' }> | null = null

  constructor(private readonly events: string[]) {}

  isRunning(): boolean { return this.running }

  applyConversationRouting(next: ConversationRouting): void {
    this.events.push(`routing:${next.provider}`)
    this.appliedRouting = next
  }

  async start(): Promise<boolean> {
    this.events.push('start:fresh')
    if (this.startError) throw this.startError
    return this.startResult
  }

  async startForked(
    launch: Extract<ConversationLaunch, { kind: 'fork' }>,
  ): Promise<boolean> {
    this.events.push('start:fork')
    this.forkLaunch = launch
    return this.forkResult
  }

  backendLabel(): string { return 'Codex' }

  async stop(): Promise<void> {
    this.events.push('stop')
    if (this.stopError) throw this.stopError
  }

  dispose(): void { this.events.push('dispose') }
}

interface HarnessOverrides {
  ensured?: { chatId: string; created: boolean; joined: boolean }
  chatId?: string | null
  disband?: (sessionName: string, chatId: string) => Promise<{ chatId: string | null; disbanded: boolean }>
  leased?: boolean
}

function harness(overrides: HarnessOverrides = {}) {
  const events: string[] = []
  const logs: string[] = []
  const stateClears: string[] = []
  const modes: string[] = []
  const leases: Array<[string, string]> = []
  const sessions = new Map<string, FakeSession>()
  const session = new FakeSession(events)
  const ensured = overrides.ensured ?? { chatId: 'chat-1', created: true, joined: true }
  const registry = {
    get(chatId: string) { return sessions.get(chatId) },
    set(chatId: string, value: FakeSession) {
      events.push(`registry:set:${chatId}`)
      sessions.set(chatId, value)
    },
    delete(chatId: string) {
      events.push(`registry:delete:${chatId}`)
      return sessions.delete(chatId)
    },
  }
  const runtime = createTempSessionRuntime({
    registry,
    createSession: (_sessionName, chatId) => {
      events.push(`factory:${chatId}`)
      return session
    },
    ensureChatForSession: async (_sessionName, _userOpenId, mode) => {
      events.push('ensure')
      modes.push(mode)
      return ensured
    },
    disbandChatForSessionExact: overrides.disband ?? (async () => {
      events.push('delete')
      return { chatId: ensured.chatId, disbanded: true }
    }),
    chatIdForSession: () => overrides.chatId === undefined ? ensured.chatId : overrides.chatId,
    clearSessionConversationState: sessionName => {
      events.push('state:clear')
      stateClears.push(sessionName)
    },
    registerTempSessionLease: (sessionName, chatId) => {
      leases.push([sessionName, chatId])
    },
    hasTempSessionLease: () => overrides.leased ?? true,
    replaceTurnAnchors: (_sessionName, _anchors, base) => { events.push(`anchors:${base?.kind ?? 'unknown'}`) },
    runExclusive: async (_chatId, task) => await task(),
    log: message => logs.push(message),
  })
  return { runtime, session, sessions, events, logs, stateClears, modes, leases }
}

describe('temporary session creation transaction', () => {
  test('starts a fresh conversation with inherited routing', async () => {
    const h = harness()

    await expect(h.runtime.createTempSession(createOptions())).resolves.toEqual({
      ok: true,
      chatId: 'chat-1',
    })
    expect(h.session.appliedRouting).toEqual(routing)
    expect(h.leases).toEqual([['project*0821-1200', 'chat-1']])
    expect(h.events).toEqual([
      'ensure',
      'factory:chat-1',
      'registry:set:chat-1',
      'routing:codex',
      'start:fresh',
      'anchors:fresh',
    ])
  })

  test('starts a backend-native fork instead of a fresh conversation', async () => {
    const h = harness()
    const launch: Extract<ConversationLaunch, { kind: 'fork' }> = {
      kind: 'fork',
      source: { provider: 'codex', sessionId: 'thread-source', cwd: '/repo' },
      through: {
        provider: 'codex',
        kind: 'turn',
        id: 'turn-7',
        source: { provider: 'codex', sessionId: 'thread-source', cwd: '/repo' },
      },
    }

    await expect(h.runtime.createTempSession(createOptions(launch))).resolves.toEqual({
      ok: true,
      chatId: 'chat-1',
    })
    expect(h.session.forkLaunch).toEqual(launch)
    expect(h.events.slice(-2)).toEqual(['start:fork', 'anchors:fork'])
    expect(h.events).not.toContain('start:fresh')
  })

  test('rejects a cwd mismatch and preserves ownership when cleanup delete fails', async () => {
    const h = harness({ disband: async () => { throw new Error('delete unavailable') } })
    h.session.workDir = '/other-repo'

    const result = await h.runtime.createTempSession(createOptions())

    expect(result.ok).toBe(false)
    expect(result.error).toContain('cwd 不匹配')
    expect(result.error).toContain('仍保留')
    expect(h.sessions.get('chat-1')).toBe(h.session)
    expect(h.events).not.toContain('delete')
    expect(h.stateClears).toEqual([])
  })

  test('rejects a provider mismatch before creating or looking up a group', async () => {
    const h = harness()
    const result = await h.runtime.createTempSession(createOptions({
      kind: 'fork',
      source: { provider: 'claude', sessionId: 'claude-source', cwd: '/repo' },
    }))

    expect(result.ok).toBe(false)
    expect(result.error).toContain('provider mismatch')
    expect(h.events).toEqual([])
    expect(h.sessions.size).toBe(0)
  })

  test('never joins, starts, or deletes an existing group in create mode', async () => {
    const h = harness({ ensured: { chatId: 'chat-1', created: false, joined: true } })
    h.session.startResult = false

    const result = await h.runtime.createTempSession(createOptions())

    expect(result.ok).toBe(false)
    expect(result.error).toContain('既有群保留')
    expect(h.sessions.size).toBe(0)
    expect(h.events).toEqual(['ensure'])
    expect(h.events).not.toContain('delete')
    expect(h.events).not.toContain('registry:delete:chat-1')
    expect(h.events).not.toContain('dispose')
    expect(h.stateClears).toEqual([])
  })

  test('reuse mode only adds the sender to an existing group and touches no session state', async () => {
    const h = harness({ ensured: { chatId: 'chat-1', created: false, joined: true } })

    const result = await h.runtime.createTempSession({ ...createOptions(), groupMode: 'reuse' })

    expect(result).toEqual({ ok: true, chatId: 'chat-1', join: 'added' })
    expect(h.modes).toEqual(['reuse'])
    expect(h.sessions.size).toBe(0)
    expect(h.events).toEqual(['ensure'])
    expect(h.events).not.toContain('start:fresh')
    expect(h.events).not.toContain('routing:codex')
    expect(h.events).not.toContain('delete')
    expect(h.stateClears).toEqual([])
  })

  test('reuse mode reports an already-present member without claiming a new join', async () => {
    const h = harness({ ensured: { chatId: 'chat-1', created: false, joined: false } })

    const result = await h.runtime.createTempSession({ ...createOptions(), groupMode: 'reuse' })

    expect(result).toEqual({ ok: true, chatId: 'chat-1', join: 'present' })
    expect(h.sessions.size).toBe(0)
    expect(h.events).toEqual(['ensure'])
  })

  test('reuse mode still creates and starts a group when the name is free', async () => {
    const h = harness()

    const result = await h.runtime.createTempSession({ ...createOptions(), groupMode: 'reuse' })

    expect(result).toEqual({ ok: true, chatId: 'chat-1' })
    expect(h.modes).toEqual(['reuse'])
    expect(h.events).toContain('start:fresh')
  })

  test('clears registry and state only after a newly-created group is confirmed deleted', async () => {
    const deleteStarted = deferred<void>()
    const allowDelete = deferred<void>()
    let events!: string[]
    const h = harness({
      disband: async () => {
        events.push('delete:start')
        deleteStarted.resolve()
        await allowDelete.promise
        events.push('delete:confirmed')
        return { chatId: 'chat-1', disbanded: true }
      },
    })
    events = h.events
    h.session.startResult = false

    const pending = h.runtime.createTempSession(createOptions())
    await deleteStarted.promise
    expect(h.sessions.get('chat-1')).toBe(h.session)
    expect(h.events).not.toContain('registry:delete:chat-1')
    expect(h.stateClears).toEqual([])

    allowDelete.resolve()
    const result = await pending
    expect(result.error).toContain('已确认解散')
    expect(h.sessions.has('chat-1')).toBe(false)
    expect(h.stateClears).toEqual(['project*0821-1200'])
    expect(h.events.slice(-4)).toEqual([
      'delete:confirmed',
      'registry:delete:chat-1',
      'dispose',
      'state:clear',
    ])
  })

  test('keeps the new group, Session, and state when compensating delete fails', async () => {
    let events!: string[]
    const h = harness({
      disband: async () => {
        events.push('delete')
        throw new Error('chat.delete unavailable')
      },
    })
    events = h.events
    h.session.startResult = false

    const result = await h.runtime.createTempSession(createOptions())

    expect(result.ok).toBe(false)
    expect(result.chatId).toBe('chat-1')
    expect(result.error).toContain('仍保留')
    expect(result.error).toContain('chat.delete unavailable')
    expect(h.sessions.get('chat-1')).toBe(h.session)
    expect(h.events).not.toContain('registry:delete:chat-1')
    expect(h.events).not.toContain('dispose')
    expect(h.stateClears).toEqual([])
  })
})

describe('temporary session disband transaction', () => {
  test('commits in stop → delete → registry/state order', async () => {
    const h = harness()
    h.sessions.set('chat-1', h.session)

    await expect(h.runtime.disbandTempSession('project*0821-1200', 'chat-1')).resolves.toEqual({ ok: true })
    expect(h.events).toEqual([
      'stop',
      'delete',
      'registry:delete:chat-1',
      'dispose',
      'state:clear',
    ])
    expect(h.sessions.has('chat-1')).toBe(false)
  })

  test('does not attempt delete when stopping the Session fails', async () => {
    const h = harness()
    h.sessions.set('chat-1', h.session)
    h.session.stopError = new Error('process still alive')

    const result = await h.runtime.disbandTempSession('project*0821-1200', 'chat-1')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('未执行删群')
    expect(h.events).toEqual(['stop'])
    expect(h.sessions.get('chat-1')).toBe(h.session)
    expect(h.stateClears).toEqual([])
  })

  test('refuses bye for a suffix-looking group without a persisted lease', async () => {
    const h = harness({ leased: false })
    h.sessions.set('chat-1', h.session)

    const result = await h.runtime.disbandTempSession('project*0821-1200', 'chat-1')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('没有 Lodestar 临时会话 lease')
    expect(h.events).toEqual([])
    expect(h.sessions.get('chat-1')).toBe(h.session)
  })

  test('refuses bye when the caller chat id differs from the bound lease target', async () => {
    const h = harness()
    h.sessions.set('chat-1', h.session)

    const result = await h.runtime.disbandTempSession('project*0821-1200', 'chat-other')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('chat_id 已变化')
    expect(h.events).toEqual([])
  })

  test('does not drop registry or state before a successful delete', async () => {
    let events!: string[]
    const h = harness({
      disband: async () => {
        events.push('delete')
        throw new Error('chat.delete denied')
      },
    })
    events = h.events
    h.sessions.set('chat-1', h.session)

    const result = await h.runtime.disbandTempSession('project*0821-1200', 'chat-1')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('仍保留')
    expect(h.events).toEqual(['stop', 'delete'])
    expect(h.sessions.get('chat-1')).toBe(h.session)
    expect(h.events).not.toContain('dispose')
    expect(h.stateClears).toEqual([])
  })

  test('treats an unconfirmed delete result as failure and preserves local ownership', async () => {
    let events!: string[]
    const h = harness({
      disband: async () => {
        events.push('delete:unconfirmed')
        return { chatId: null, disbanded: false }
      },
    })
    events = h.events
    h.sessions.set('chat-1', h.session)

    const result = await h.runtime.disbandTempSession('project*0821-1200', 'chat-1')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('未确认删除')
    expect(h.events).toEqual(['stop', 'delete:unconfirmed'])
    expect(h.sessions.get('chat-1')).toBe(h.session)
    expect(h.stateClears).toEqual([])
  })
})
