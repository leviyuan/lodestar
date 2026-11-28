import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import {
  chatWasDissolved,
  createChatDisbandRuntime,
  disbandedChatId,
  notifyChatGone,
  setGoneChatHandler,
  type ChatDisbandDeps,
  type ChatGoneKind,
} from './chat-disband'

class FakeSession {
  stops: Array<{ reason: string; announce: boolean }> = []
  disposed = 0
  stopError: Error | null = null
  /** Runs while stop is still killing the process (it can take seconds). */
  duringStop: (() => Promise<void> | void) | null = null
  constructor(readonly sessionName: string) {}
  async stop(reason: string, opts: { announce: boolean }): Promise<void> {
    this.stops.push({ reason, announce: opts.announce })
    await this.duringStop?.()
    if (this.stopError) throw this.stopError
  }
  dispose(): void { this.disposed++ }
}

function harness(options: {
  sessions?: Record<string, FakeSession>
  bindings?: Record<string, string>
  runExclusive?: ChatDisbandDeps<FakeSession>['runExclusive']
  onClear?: (sessionName: string, bindings: Map<string, string>) => void
} = {}) {
  const registry = new Map(Object.entries(options.sessions ?? {}))
  const bindings = new Map(Object.entries(options.bindings ?? {}))
  const cleared: Array<[string, string]> = []
  const forgotten: string[] = []
  const logs: string[] = []
  const errors: string[] = []
  const exclusive: string[] = []
  let persisted = 0
  const failures: { clear?: Error; forget?: Error; persist?: Error } = {}
  const deps: ChatDisbandDeps<FakeSession> = {
    registry,
    bindings,
    // Same as feishu.clearSessionConversationState: the chat_id is only a hint, the binding
    // (with resume, model and turns) goes by name whichever group it points at.
    clearSessionConversationState: (sessionName, chatId) => {
      if (failures.clear) throw failures.clear
      cleared.push([sessionName, chatId])
      options.onClear?.(sessionName, bindings)
      bindings.delete(sessionName)
    },
    forgetChatState: chatId => {
      if (failures.forget) throw failures.forget
      forgotten.push(chatId)
    },
    persistRecovery: () => {
      if (failures.persist) throw failures.persist
      persisted++
    },
    runExclusive: options.runExclusive ?? (async (chatId, task) => {
      exclusive.push(chatId)
      return await task()
    }),
    log: event => { logs.push(event) },
    logError: event => { errors.push(event) },
  }
  return {
    runtime: createChatDisbandRuntime(deps),
    registry, bindings, cleared, forgotten, logs, errors, exclusive, failures,
    persisted: () => persisted,
  }
}

describe('dissolved group cleanup', () => {
  test('dissolving an old same-name group leaves the live group, its binding and name-level state alone', async () => {
    const oldGroup = new FakeSession('proj')
    const newGroup = new FakeSession('proj')
    // handleMessage binds the name to whichever group spoke last: the new one.
    const h = harness({ sessions: { oc_old: oldGroup, oc_new: newGroup }, bindings: { proj: 'oc_new' } })

    await h.runtime.handleDisbandedEvent({ chat_id: 'oc_old' })

    expect(h.exclusive).toEqual(['oc_old'])
    expect(oldGroup.stops).toEqual([{ reason: '群已解散', announce: false }])
    expect(oldGroup.disposed).toBe(1)
    expect([...h.registry.keys()]).toEqual(['oc_new'])
    expect(newGroup.stops).toEqual([])
    expect(newGroup.disposed).toBe(0)
    // Name-level state belongs to the group the binding points at, which is still alive.
    expect(h.cleared).toEqual([])
    expect([...h.bindings]).toEqual([['proj', 'oc_new']])
    // Only the dissolved chat's own state goes.
    expect(h.forgotten).toEqual(['oc_old'])
    expect(h.persisted()).toBe(1)
    expect(h.logs).toEqual(['daemon.chat.disbanded'])
    expect(h.errors).toEqual([])
  })

  test('dissolving the group the name is bound to clears that name-level state as well', async () => {
    const session = new FakeSession('proj')
    const h = harness({ sessions: { oc_proj: session }, bindings: { proj: 'oc_proj', other: 'oc_other' } })

    await h.runtime.handleDisbandedEvent({ chat_id: 'oc_proj' })

    expect(session.stops).toEqual([{ reason: '群已解散', announce: false }])
    expect(h.registry.size).toBe(0)
    expect(h.cleared).toEqual([['proj', 'oc_proj']])
    expect(h.forgotten).toEqual(['oc_proj'])
    expect([...h.bindings]).toEqual([['other', 'oc_other']])
    expect(h.logs).toEqual(['daemon.chat.disbanded'])
  })

  test('a binding without a live Session is still cleaned, and every name bound to the group is cleared', async () => {
    // A rename leaves the previous name bound to the same chat until the next message.
    const h = harness({ bindings: { proj: 'oc_x', 'proj-renamed': 'oc_x', other: 'oc_y' } })

    await h.runtime.handleDisbandedEvent({ event: { chat_id: ' oc_x ' } })

    expect(h.cleared).toEqual([['proj', 'oc_x'], ['proj-renamed', 'oc_x']])
    expect(h.forgotten).toEqual(['oc_x'])
    expect([...h.bindings]).toEqual([['other', 'oc_y']])
    expect(h.persisted()).toBe(1)
  })

  test('the binding is read when the queued cleanup runs, not when the event arrives', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const h = harness({
      sessions: { oc_old: new FakeSession('proj') },
      bindings: { proj: 'oc_old' },
      runExclusive: async (_chatId, task) => { await gate; return await task() },
    })

    const pending = h.runtime.handleDisbandedEvent({ chat_id: 'oc_old' })
    // A message from the new same-name group lands while the cleanup is still queued.
    h.bindings.set('proj', 'oc_new')
    release()
    await pending

    expect(h.cleared).toEqual([])
    expect([...h.bindings]).toEqual([['proj', 'oc_new']])
    expect(h.forgotten).toEqual(['oc_old'])
  })

  test('a same-name group that takes the binding while the stop is still running keeps its name-level state', async () => {
    const oldGroup = new FakeSession('proj')
    const h = harness({ sessions: { oc_old: oldGroup }, bindings: { proj: 'oc_old', other: 'oc_old' } })
    // Killing the process takes a while; meanwhile the new same-name group (another chat, another
    // actor key) sends a message and handleMessage rebinds the name to it.
    oldGroup.duringStop = async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      h.bindings.set('proj', 'oc_new')
    }

    await h.runtime.handleDisbandedEvent({ chat_id: 'oc_old' })

    expect(oldGroup.stops).toEqual([{ reason: '群已解散', announce: false }])
    expect(oldGroup.disposed).toBe(1)
    // Only the name still bound to the dissolved chat after the stop is cleared.
    expect(h.cleared).toEqual([['other', 'oc_old']])
    expect([...h.bindings]).toEqual([['proj', 'oc_new']])
    expect(h.forgotten).toEqual(['oc_old'])
    expect(h.logs).toEqual(['daemon.chat.disbanded'])
  })

  test('each name is checked again right before it is cleared', async () => {
    // Whatever moves a binding between two clears, a stale list must not clear the moved name.
    const h = harness({
      bindings: { a: 'oc_x', b: 'oc_x' },
      onClear: (sessionName, bindings) => { if (sessionName === 'a') bindings.set('b', 'oc_y') },
    })

    await h.runtime.handleDisbandedEvent({ chat_id: 'oc_x' })

    expect(h.cleared).toEqual([['a', 'oc_x']])
    expect([...h.bindings]).toEqual([['b', 'oc_y']])
  })

  test('an unrelated group only drops its per-chat leftovers; an event without chat_id is ignored', async () => {
    const h = harness({ bindings: { proj: 'oc_proj' } })

    await h.runtime.handleDisbandedEvent({ chat_id: 'oc_unrelated' })
    expect(h.forgotten).toEqual(['oc_unrelated'])
    expect(h.cleared).toEqual([])
    expect(h.persisted()).toBe(0)
    expect(h.logs).toEqual(['daemon.chat.disbanded_ignored'])

    await h.runtime.handleDisbandedEvent({})
    await h.runtime.handleDisbandedEvent(null)
    expect(h.exclusive).toEqual(['oc_unrelated'])
    expect(h.logs).toEqual(['daemon.chat.disbanded_ignored', 'daemon.chat.disbanded_ignored', 'daemon.chat.disbanded_ignored'])
  })

  test('each failing step is logged with a fixed event name and the remaining steps still run', async () => {
    const session = new FakeSession('proj')
    session.stopError = new Error('stop failed')
    const h = harness({ sessions: { oc_proj: session }, bindings: { proj: 'oc_proj' } })
    h.failures.clear = new Error('disk full')
    h.failures.forget = new Error('disk full')
    h.failures.persist = new Error('disk full')

    await h.runtime.handleDisbandedEvent({ chat_id: 'oc_proj' })

    expect(session.disposed).toBe(1)
    expect(h.registry.size).toBe(0)
    expect(h.errors).toEqual([
      'daemon.chat.disbanded_stop_failed',
      'daemon.chat.disbanded_cleanup_failed',
      'daemon.chat.disbanded_cleanup_failed',
      'daemon.chat.disbanded_marker_failed',
    ])
    expect(h.logs).toEqual(['daemon.chat.disbanded'])
  })

  test('a closed chat actor is logged instead of rejecting into the event dispatcher', async () => {
    const h = harness({
      bindings: { proj: 'oc_proj' },
      runExclusive: () => Promise.reject(new Error('per-key actor closed')),
    })
    const outcome = await h.runtime.handleDisbandedEvent({ chat_id: 'oc_proj' }).then(() => 'resolved', () => 'rejected')
    expect(outcome).toBe('resolved')
    expect(h.errors).toEqual(['daemon.chat.disbanded_failed'])
  })

  test('a group the bot left is released the same way, with its own stop reason and log event', async () => {
    const session = new FakeSession('proj[ext]')
    const h = harness({ sessions: { oc_ext_wt: session } })

    await h.runtime.forgetGoneChat('oc_ext_wt', 'left')

    expect(session.stops).toEqual([{ reason: '机器人已退群', announce: false }])
    expect(session.disposed).toBe(1)
    expect(h.registry.size).toBe(0)
    expect(h.forgotten).toEqual(['oc_ext_wt'])
    expect(h.logs).toEqual(['daemon.chat.left'])
    await h.runtime.forgetGoneChat('', 'left')
    expect(h.exclusive).toEqual(['oc_ext_wt'])
  })

  test('startup reconciliation probes each bound group once and cleans only the dissolved ones', async () => {
    const h = harness({
      sessions: { oc_1: new FakeSession('a') },
      bindings: { a: 'oc_1', b: 'oc_1', c: 'oc_2', d: 'oc_3' },
    })
    const probed: string[] = []

    await h.runtime.reconcileDissolvedChats(async chatId => {
      probed.push(chatId)
      return chatId !== 'oc_2'
    })

    expect(probed.sort()).toEqual(['oc_1', 'oc_2', 'oc_3'])
    expect(h.cleared.sort()).toEqual([['a', 'oc_1'], ['b', 'oc_1'], ['d', 'oc_3']])
    expect(h.forgotten.sort()).toEqual(['oc_1', 'oc_3'])
    expect([...h.bindings]).toEqual([['c', 'oc_2']])
    expect(h.logs.at(-1)).toBe('daemon.chat.reconciled')
  })

  test('event payloads are read from the flattened shape first, then the legacy event wrapper', () => {
    expect(disbandedChatId({ chat_id: 'oc_a', event: { chat_id: 'oc_b' } })).toBe('oc_a')
    expect(disbandedChatId({ event: { chat_id: 'oc_b' } })).toBe('oc_b')
    expect(disbandedChatId({ chat_id: '  ' })).toBe('')
    expect(disbandedChatId(undefined)).toBe('')
  })
})

describe('Session-side hook for a WT group the bot removed', () => {
  afterEach(() => setGoneChatHandler(null))

  test('reaches the handler the daemon installed, and is a no-op without one', async () => {
    await notifyChatGone('oc_wt', 'left')
    const calls: Array<[string, ChatGoneKind]> = []
    setGoneChatHandler(async (chatId, kind) => { calls.push([chatId, kind]) })
    await notifyChatGone('oc_wt', 'left')
    await notifyChatGone('oc_wt2', 'disbanded')
    await notifyChatGone('', 'left')
    expect(calls).toEqual([['oc_wt', 'left'], ['oc_wt2', 'disbanded']])
  })
})

describe('chatWasDissolved', () => {
  const probe = (getChat: () => Promise<unknown>, timeoutMs?: number) => chatWasDissolved('oc_x', {
    getChat,
    errorCode: error => (error as { code?: unknown }).code,
    timeoutMs,
  })

  test('only a successful read of a dissolved status, or a gone-chat rejection, counts as dissolved', async () => {
    expect(await probe(async () => ({ code: 0, data: { chat_status: 'dissolved' } }))).toBe(true)
    // 飞书 chat_status 的“已解散（保留）”同样是已解散。
    expect(await probe(async () => ({ code: 0, data: { chat_status: 'dissolved_save' } }))).toBe(true)
    expect(await probe(async () => ({ code: 0, data: { chat_status: 'normal' } }))).toBe(false)
    expect(await probe(async () => ({ code: 0, data: {} }))).toBe(false)
    expect(await probe(async () => ({ code: 99991400, data: { chat_status: 'dissolved' } }))).toBe(false)
    expect(await probe(async () => { throw Object.assign(new Error('gone'), { code: 232009 }) })).toBe(true)
    expect(await probe(async () => { throw Object.assign(new Error('dissolved'), { code: 232006 }) })).toBe(true)
    expect(await probe(async () => { throw Object.assign(new Error('no permission'), { code: 232011 }) })).toBe(false)
  })

  test('a read that never answers is treated as not dissolved once the timeout passes', async () => {
    expect(await probe(() => new Promise(() => {}), 5)).toBe(false)
  })
})

// The real feishu.ts state functions, wired the way daemon.ts wires them, in a fresh
// process with an isolated data dir (feishu.ts reads its config on import).
function runWithRealState(work: string, initialFiles: Record<string, unknown>): any {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-chat-disband-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  for (const [name, value] of Object.entries(initialFiles)) {
    writeFileSync(join(dataDir, name), JSON.stringify(value, null, 2) + '\n')
  }
  const configFile = join(root, 'config.toml')
  writeFileSync(configFile, '[feishu]\napp_id = "t"\napp_secret = "t"\n')
  const script = `
    import * as feishu from ${JSON.stringify(pathToFileURL(join(import.meta.dir, 'feishu.ts')).href)}
    import { createChatDisbandRuntime } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, 'chat-disband.ts')).href)}
    import { readFileSync } from 'node:fs'
    import { join } from 'node:path'
    globalThis.fetch = async () => { throw new Error('unexpected network request') }
    const read = name => { try { return JSON.parse(readFileSync(join(${JSON.stringify(dataDir)}, name), 'utf8')) } catch { return null } }
    const out = value => process.stdout.write('@@@' + JSON.stringify(value) + '@@@')
    const sessions = new Map()
    const fakeSession = sessionName => ({ sessionName, async stop() {}, dispose() {} })
    const runtime = createChatDisbandRuntime({
      registry: sessions,
      bindings: feishu.preferredChatForSession,
      clearSessionConversationState: feishu.clearSessionConversationState,
      forgetChatState: feishu.forgetChatState,
      persistRecovery: () => {},
      runExclusive: (_chatId, task) => task(),
      log: () => {},
      logError: (event, error) => { throw new Error(event + ': ' + error) },
    })
    feishu.loadTempSessionLeases()
    feishu.loadSessionChatMap()
    feishu.loadSessionResumeMap()
    feishu.loadSessionModelMap()
    feishu.loadSessionTurnsMap()
    ${work}
  `
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      env: { ...process.env, LODESTAR_DATA_DIR: dataDir, LODESTAR_CONFIG: configFile },
    })
    const stdout = result.stdout.toString()
    const marker = stdout.match(/@@@([\s\S]*?)@@@/)
    if (!marker) throw new Error(`missing result marker exit=${result.exitCode}\n${stdout}\n${result.stderr.toString()}`)
    return JSON.parse(marker[1]!)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('dissolved group cleanup against the real conversation state', () => {
  test('an old same-name group goes without touching the new group; then the bound group clears everything', () => {
    const output = runWithRealState(`
      // refreshChatList() at boot cached both same-name groups.
      feishu.chatNameCache.set('oc_old', 'proj')
      feishu.chatNameCache.set('oc_new', 'proj')
      sessions.set('oc_old', fakeSession('proj'))
      sessions.set('oc_new', fakeSession('proj'))
      const snapshot = () => ({
        binding: feishu.preferredChatForSession.get('proj') ?? null,
        resolved: feishu.chatIdForSession('proj'),
        resume: feishu.getSessionResumeRef('proj', 'codex')?.sessionId ?? null,
        model: feishu.getSessionModelSelection('proj'),
        registry: [...sessions.keys()],
        chatMap: read('session-chat-map.json'),
        activity: read('session-activity.json'),
      })
      await runtime.handleDisbandedEvent({ chat_id: 'oc_old' })
      const afterOld = snapshot()
      await runtime.handleDisbandedEvent({ chat_id: 'oc_new' })
      out({ afterOld, afterNew: snapshot() })
    `, {
      'session-chat-map.json': { proj: 'oc_new' },
      'session-resume-map.json': { proj: { codex: { provider: 'codex', sessionId: 'thread-of-new-group', cwd: '/srv/proj' } } },
      'session-model-map.json': { proj: { provider: 'codex', model: 'gpt-5.2-codex', effort: 'high' } },
      'session-activity.json': { version: 1, chats: { oc_old: 1_700_000_000_000, oc_new: 1_700_000_100_000 } },
    })
    expect(output.afterOld).toEqual({
      binding: 'oc_new',
      resolved: 'oc_new',
      resume: 'thread-of-new-group',
      model: { provider: 'codex', model: 'gpt-5.2-codex', effort: 'high' },
      registry: ['oc_new'],
      chatMap: { proj: 'oc_new' },
      // The dissolved group's timestamp is the one removed, not the live group's.
      activity: { version: 1, chats: { oc_new: 1_700_000_100_000 } },
    })
    expect(output.afterNew).toEqual({
      binding: null,
      // The name cache no longer falls back to a dissolved group.
      resolved: null,
      resume: null,
      model: null,
      registry: [],
      chatMap: {},
      activity: { version: 1, chats: {} },
    })
  })

  test('the name cache of a dissolved group is dropped, so routing by name no longer reaches it', () => {
    const output = runWithRealState(`
      feishu.chatNameCache.set('oc_gone', 'proj')
      await runtime.handleDisbandedEvent({ chat_id: 'oc_gone' })
      const bound = feishu.chatIdForSession('proj')
      // A group the daemon never bound is still dropped from the cache.
      feishu.chatNameCache.set('oc_stranger', 'stranger')
      await runtime.handleDisbandedEvent({ chat_id: 'oc_stranger' })
      out({ bound, binding: feishu.preferredChatForSession.get('proj') ?? null, stranger: feishu.chatIdForSession('stranger') })
    `, { 'session-chat-map.json': { proj: 'oc_gone' } })
    expect(output).toEqual({ bound: null, binding: null, stranger: null })
  })

  test('a temporary-session lease goes with its own chat even when a same-name group holds the binding', () => {
    const output = runWithRealState(`
      await runtime.handleDisbandedEvent({ chat_id: 'oc_temp' })
      out({
        leased: feishu.hasTempSessionLease('proj*note', 'oc_temp'),
        leases: read('temp-session-leases.json'),
        binding: feishu.preferredChatForSession.get('proj*note') ?? null,
      })
    `, {
      'temp-session-leases.json': { oc_temp: { sessionName: 'proj*note', chatId: 'oc_temp', createdAt: 1 } },
      'session-chat-map.json': { 'proj*note': 'oc_same_name' },
    })
    expect(output).toEqual({ leased: false, leases: {}, binding: 'oc_same_name' })
  })

  test('a same-name group that speaks while the dissolved group is still stopping keeps its state', () => {
    const output = runWithRealState(`
      sessions.set('oc_old', {
        sessionName: 'proj',
        // Killing the process takes a while; the new group's message rebinds the name meanwhile.
        async stop() {
          await new Promise(resolve => setTimeout(resolve, 5))
          feishu.bindSessionToChat('proj', 'oc_new')
        },
        dispose() {},
      })
      await runtime.handleDisbandedEvent({ chat_id: 'oc_old' })
      out({
        binding: feishu.preferredChatForSession.get('proj') ?? null,
        resume: feishu.getSessionResumeRef('proj', 'codex')?.sessionId ?? null,
        model: feishu.getSessionModelSelection('proj'),
        chatMap: read('session-chat-map.json'),
        activity: read('session-activity.json'),
      })
    `, {
      'session-chat-map.json': { proj: 'oc_old' },
      'session-resume-map.json': { proj: { codex: { provider: 'codex', sessionId: 'thread-of-new-group', cwd: '/srv/proj' } } },
      'session-model-map.json': { proj: { provider: 'codex', model: 'gpt-5.2-codex', effort: 'high' } },
      'session-activity.json': { version: 1, chats: { oc_old: 1_700_000_000_000, oc_new: 1_700_000_100_000 } },
    })
    expect(output).toEqual({
      binding: 'oc_new',
      resume: 'thread-of-new-group',
      model: { provider: 'codex', model: 'gpt-5.2-codex', effort: 'high' },
      chatMap: { proj: 'oc_new' },
      activity: { version: 1, chats: { oc_new: 1_700_000_100_000 } },
    })
  })
})

describe('daemon wiring for dissolved groups', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const source = ts.createSourceFile('daemon.ts', readFileSync(join(root, 'daemon.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const topLevel = (name: string) => source.statements
    .flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
    .find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name)
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)

  // daemon.ts boots the service on import, so its wiring is checked structurally.
  test('the runtime gets the live registry, the saved bindings and the real state functions', () => {
    const initializer = topLevel('chatDisband')?.initializer
    expect(initializer && ts.isCallExpression(initializer)).toBe(true)
    const call = initializer as ts.CallExpression
    expect(call.expression.getText(source)).toBe('createChatDisbandRuntime')
    const deps = call.arguments[0] as ts.ObjectLiteralExpression
    expect(Object.fromEntries(deps.properties.map(property => [
      property.name!.getText(source),
      ts.isPropertyAssignment(property) ? property.initializer.getText(source) : property.getText(source),
    ]))).toEqual({
      registry: 'sessions',
      bindings: 'feishu.preferredChatForSession',
      clearSessionConversationState: 'feishu.clearSessionConversationState',
      forgetChatState: 'feishu.forgetChatState',
      persistRecovery: '() => sessionRecovery.persist()',
      runExclusive: '(chatId, task) => chatActor.enqueue(chatId, task)',
      log: 'log',
      logError: 'logError',
    })
    expect(source.statements.some(statement => ts.isExpressionStatement(statement)
      && statement.expression.getText(source) === 'setGoneChatHandler(chatDisband.forgetGoneChat)')).toBe(true)
  })

  test('the disband event, startup reconciliation and nothing else reach the cleanup', () => {
    const register = calls.find(call => call.expression.getText(source) === 'dispatcher.register'
      && call.arguments[0]!.getText(source).includes("'im.chat.disbanded_v1'"))
    const handler = (register!.arguments[0] as ts.ObjectLiteralExpression).properties[0] as ts.PropertyAssignment
    expect(handler.initializer.getText(source)).toBe('(d: any) => { void chatDisband.handleDisbandedEvent(d) }')
    const reconcile = calls.find(call => call.expression.getText(source) === 'chatDisband.reconcileDissolvedChats')
    expect(reconcile!.arguments[0]!.getText(source).replace(/\s+/g, ' ')).toBe(
      'chatId => chatWasDissolved(chatId, { getChat: id => feishu.client.im.chat.get({ path: { chat_id: id } }), errorCode: error => feishuErrorDetails(error).code, })',
    )
    // Name-level state is never cleared directly by the daemon any more.
    expect(calls.filter(call => /clearSessionConversationState$/.test(call.expression.getText(source)))).toEqual([])
  })
})
