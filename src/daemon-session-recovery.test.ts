import { describe, expect, test } from 'bun:test'
import { PerKeyActor, createPerChatAdmission } from './card-action-runtime'
import { DaemonSessionRecovery, type RecoverableSession } from './daemon-session-recovery'
import { drainDynamicWork } from './inflight-work'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function harness(initialNames: string[]) {
  let marker = [...initialNames]
  const writes: string[][] = []
  const logs: string[] = []
  const actor = new PerKeyActor()
  const sessions = new Map<string, RecoverableSession>()
  let shuttingDown = false
  const deps = {
    readMarker: () => [...marker],
    writeMarker: (names: string[]) => { marker = [...names]; writes.push([...names]) },
    sessions: () => sessions.values(),
    chatIdForSession: (name: string): string | null => `chat-${name}`,
    sessionFor: (chatId: string, _name: string): RecoverableSession => {
      const session = sessions.get(chatId)
      if (!session) throw new Error(`missing test session ${chatId}`)
      return session
    },
    actor,
    isShuttingDown: () => shuttingDown,
    log: (message: string) => { logs.push(message) },
  }
  const recovery = new DaemonSessionRecovery(deps)
  return { deps, actor, sessions, recovery, writes, logs, marker: () => marker,
    shutdown: () => { shuttingDown = true; actor.close() } }
}

describe('daemon session recovery', () => {
  test('an interrupted early boot and a second restart preserve every unreadied session', async () => {
    const h = harness(['a', 'b'])
    h.recovery.load()
    h.shutdown()
    // Agent updates/model loading have not constructed any Session yet.
    await h.recovery.enqueue()
    h.recovery.freezeForShutdown()
    h.recovery.persist()
    expect(h.marker()).toEqual(['a', 'b'])
    const second = new DaemonSessionRecovery(h.deps)
    second.load()
    second.persist()
    expect(h.marker()).toEqual(['a', 'b'])
  })

  test('reserves recovery before messages/actions, keeps receipt time, and allows other chats to progress', async () => {
    const h = harness(['a', 'b', 'a'])
    const gate = deferred()
    const events: string[] = []
    for (const name of ['a', 'b']) {
      let alive = false
      h.sessions.set(`chat-${name}`, {
        sessionName: name,
        shouldRevive: () => alive,
        restoreAfterDaemonRestart: async () => {
          events.push(`restore-${name}`)
          if (name === 'a') await gate.promise
          alive = true
          events.push(`ready-${name}`)
          return true
        },
      })
    }
    h.recovery.load()
    const revival = h.recovery.enqueue()
    expect(h.recovery.enqueue()).toBe(revival)
    let now = 1_000
    const admission = createPerChatAdmission<string>({
      actor: h.actor, key: name => `chat-${name}`, now: () => now,
      execute: async (name, receivedAt) => {
        expect(receivedAt).toBe(1_000)
        expect(h.sessions.get(`chat-${name}`)!.shouldRevive()).toBe(true)
        events.push(`message-${name}`)
      },
    })
    const a = admission.accept('a')
    if (!a.accepted) throw new Error(a.reason)
    const action = h.actor.enqueue('chat-a', async () => { events.push('action-a') })
    const b = admission.accept('b')
    if (!b.accepted) throw new Error(b.reason)
    await b.completion
    expect(events).toEqual(['restore-a', 'restore-b', 'ready-b', 'message-b'])
    expect([...h.actor.pending()]).not.toHaveLength(0)
    // More than the 30s stale-message threshold passes in the queue.
    now = 601_000
    gate.resolve()
    await Promise.all([revival, a.completion, action])
    expect(events).toEqual(['restore-a', 'restore-b', 'ready-b', 'message-b', 'ready-a', 'message-a', 'action-a'])
    expect(h.marker().sort()).toEqual(['a', 'b'])
  })

  test('shutdown drains an active recovery and skips unstarted recoveries without losing their intent', async () => {
    const h = harness(['a', 'b'])
    const gate = deferred()
    const entered = deferred()
    let restores = 0
    let alive = false
    h.sessions.set('chat-a', {
      sessionName: 'a', shouldRevive: () => alive,
      restoreAfterDaemonRestart: async () => {
        restores++
        entered.resolve()
        await gate.promise
        alive = true
        return true
      },
    })
    const blockB = deferred()
    const blocker = h.actor.enqueue('chat-b', () => blockB.promise)
    h.recovery.load()
    const revival = h.recovery.enqueue()
    await entered.promise
    h.shutdown()
    let drained = false
    const drain = drainDynamicWork(() => h.actor.pending()).then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    blockB.resolve()
    gate.resolve()
    await Promise.all([revival, blocker, drain])
    expect(restores).toBe(1)
    h.recovery.freezeForShutdown()
    alive = false
    h.recovery.persist()
    expect(h.marker().sort()).toEqual(['a', 'b'])
  })

  test('an admitted user kill takes effect before the snapshot; daemon teardown never overwrites it', async () => {
    const h = harness([])
    let a = true
    let b = true
    for (const name of ['a', 'b']) h.sessions.set(`chat-${name}`, {
      sessionName: name, shouldRevive: () => name === 'a' ? a : b,
      restoreAfterDaemonRestart: async () => { throw new Error('not a revival') },
    })
    h.recovery.load()
    const userKill = h.actor.enqueue('chat-a', async () => { a = false; h.recovery.persist() })
    h.shutdown()
    h.recovery.persist()
    await drainDynamicWork(() => h.actor.pending())
    await userKill
    h.recovery.freezeForShutdown()
    const beforeTeardown = h.writes.length
    b = false
    h.recovery.persist()
    h.recovery.persist()
    expect(h.writes.slice(beforeTeardown)).toEqual([['b'], ['b']])
  })

  test('failed recovery remains durable until the user explicitly stops or starts that session', async () => {
    const h = harness(['a'])
    let required = false
    h.sessions.set('chat-a', {
      sessionName: 'a', shouldRevive: () => required,
      restoreAfterDaemonRestart: async () => { required = true; throw new Error('resume unavailable') },
    })
    h.recovery.load()
    await h.recovery.enqueue()
    expect(h.marker()).toEqual(['a'])
    expect(h.logs.join('\n')).toContain('resume unavailable')
    required = false
    h.recovery.persist()
    expect(h.marker()).toEqual([])
  })

  test('missing chat bindings or a failing Session constructor do not erase unattempted recovery', async () => {
    const h = harness(['missing-chat', 'broken-session'])
    h.deps.chatIdForSession = name => name === 'missing-chat' ? null : 'chat-broken'
    h.deps.sessionFor = () => { throw new Error('invalid saved model') }
    h.recovery.load()
    await h.recovery.enqueue()
    expect(h.marker()).toEqual(['missing-chat', 'broken-session'])
    expect(h.logs.join('\n')).toContain('no chatId binding')
    expect(h.logs.join('\n')).toContain('invalid saved model')
  })

  test('marker read/write errors surface and an unread marker is never replaced by cleanup', () => {
    const h = harness(['saved'])
    h.deps.readMarker = () => { throw new Error('marker EACCES') }
    expect(() => h.recovery.load()).toThrow('marker EACCES')
    h.recovery.freezeForShutdown()
    h.recovery.persist()
    expect(h.writes).toEqual([])
    expect(h.marker()).toEqual(['saved'])
    const writable = harness(['saved'])
    writable.recovery.load()
    writable.deps.writeMarker = () => { throw new Error('marker ENOSPC') }
    expect(() => writable.recovery.freezeForShutdown()).toThrow('marker ENOSPC')
  })

  test('a chat discovered after boot inherits its pending recovery and can explicitly cancel it', async () => {
    const h = harness(['late'])
    h.deps.chatIdForSession = () => null
    h.recovery.load()
    await h.recovery.enqueue()
    let required = false
    const session = {
      sessionName: 'late',
      requireDaemonRestore: () => { required = true },
      shouldRevive: () => required,
      restoreAfterDaemonRestart: async () => true,
    }
    h.recovery.transferPending(session)
    h.sessions.set('late-chat', session)
    expect(required).toBe(true)
    h.recovery.persist()
    expect(h.marker()).toEqual(['late'])
    required = false
    h.recovery.persist()
    expect(h.marker()).toEqual([])
    h.recovery.transferPending(session)
    expect(required).toBe(false)
  })
})
