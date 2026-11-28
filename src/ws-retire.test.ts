import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { clientEventDispatcher, createWsRetirement, type WsRetireTimers } from './ws-retire'

function fakeTimers() {
  let next = 1
  const pending = new Map<number, { fn: () => void; ms: number }>()
  const timers: WsRetireTimers<number> = {
    set(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id },
    clear(id) { pending.delete(id) },
  }
  const fireAll = () => {
    const due = [...pending]
    pending.clear()
    for (const [, timer] of due) timer.fn()
  }
  return { timers, pending, fireAll }
}

function harness(checks = 2) {
  const closes: string[] = []
  const errors: unknown[] = []
  const clock = fakeTimers()
  let failClose = false
  const retirement = createWsRetirement<string, number>({
    close: client => { closes.push(client); if (failClose) throw new Error('close failed') },
    onCloseError: error => errors.push(error),
    timers: clock.timers,
    checkIntervalMs: 30_000,
    checks,
  })
  return { retirement, closes, errors, clock, setFailClose: (value: boolean) => { failClose = value } }
}

describe('WebSocket client retirement', () => {
  test('closes immediately and again on each later check, then forgets the client', () => {
    const h = harness(2)
    h.retirement.retire('old')
    expect(h.closes).toEqual(['old'])
    expect([...h.clock.pending.values()].map(timer => timer.ms)).toEqual([30_000])
    h.clock.fireAll()
    expect(h.closes).toEqual(['old', 'old'])
    expect(h.retirement.size).toBe(1)
    h.clock.fireAll()
    expect(h.closes).toEqual(['old', 'old', 'old'])
    expect(h.retirement.size).toBe(0)
    expect(h.clock.pending.size).toBe(0)
  })

  test('a late connect that completes after close() is closed by the next check', () => {
    // Model of the SDK: close() cannot cancel an in-flight attempt; the socket
    // opens afterwards and stays open until close() runs again.
    let open = false
    let inFlight = true
    const clock = fakeTimers()
    const retirement = createWsRetirement<object, number>({
      close: () => { open = false; inFlight = false },
      onCloseError: () => {},
      timers: clock.timers,
    })
    const client = {}
    retirement.retire(client)
    expect(inFlight).toBe(false)
    open = true
    clock.fireAll()
    expect(open).toBe(false)
  })

  test('retiring again restarts the window without duplicating timers', () => {
    const h = harness(2)
    h.retirement.retire('old')
    h.clock.fireAll()
    h.retirement.retire('old')
    expect(h.clock.pending.size).toBe(1)
    h.clock.fireAll()
    h.clock.fireAll()
    expect(h.closes).toEqual(['old', 'old', 'old', 'old', 'old'])
    expect(h.retirement.size).toBe(0)
  })

  test('closeAll closes every retired client, cancels checks and stops scheduling', () => {
    const h = harness(5)
    h.retirement.retire('a')
    h.retirement.retire('b')
    h.retirement.closeAll()
    expect(h.closes).toEqual(['a', 'b', 'a', 'b'])
    expect(h.clock.pending.size).toBe(0)
    expect(h.retirement.size).toBe(0)
    h.retirement.retire('c')
    expect(h.closes.at(-1)).toBe('c')
    expect(h.clock.pending.size).toBe(0)
  })

  test('close failures are reported and do not stop later checks', () => {
    const h = harness(2)
    h.setFailClose(true)
    h.retirement.retire('old')
    expect(h.errors).toHaveLength(1)
    h.clock.fireAll()
    expect(h.errors).toHaveLength(2)
    expect(h.clock.pending.size).toBe(1)
  })
})

test('an event counts as proof of life only when the current client delivered it, and is handled either way', async () => {
  const handled: unknown[] = []
  const shared = { invoke: async (data: unknown, params?: unknown) => { handled.push([data, params]); return 'ack' } }
  let current = 'new'
  let proofs = 0
  const retired = clientEventDispatcher(shared, () => current === 'old', () => { proofs++ })
  const live = clientEventDispatcher(shared, () => current === 'new', () => { proofs++ })

  expect(await retired.invoke({ id: 1 }, { needCheck: false })).toBe('ack')
  expect(proofs).toBe(0)
  expect(await live.invoke({ id: 2 }, { needCheck: false })).toBe('ack')
  expect(proofs).toBe(1)
  expect(handled).toEqual([[{ id: 1 }, { needCheck: false }], [{ id: 2 }, { needCheck: false }]])

  // After the next rebuild the same wrapper belongs to a retired client.
  current = 'newer'
  await live.invoke({ id: 3 })
  expect(proofs).toBe(1)
  expect(handled).toHaveLength(3)
})

// daemon.ts boots the service on import, so the current/retired client split is checked structurally.
describe('daemon wiring: only the current client drives the long connection', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const source = ts.createSourceFile('daemon.ts', readFileSync(join(root, 'daemon.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const text = (node: ts.Node) => node.getText(source).replace(/\s+/g, ' ')
  const descendants = (start: ts.Node | undefined): ts.Node[] => {
    const found: ts.Node[] = []
    const walk = (node: ts.Node): void => { found.push(node); ts.forEachChild(node, walk) }
    if (start) walk(start)
    return found
  }
  const all = descendants(source)
  const variable = (name: string) => all.find((node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)?.initializer
  const assigned = (name: string) => all.find((node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(node.left) && node.left.text === name)?.right
  const statements = (fn: ts.Node | undefined): ts.Node[] => {
    expect(fn !== undefined && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))).toBe(true)
    const body = (fn as ts.ArrowFunction).body
    return ts.isBlock(body) ? [...body.statements] : [body]
  }
  const clientOptions = () => {
    const created = descendants(variable('makeWs')).find((node): node is ts.NewExpression =>
      ts.isNewExpression(node) && node.expression.getText(source) === 'lark.WSClient')
    const options = created!.arguments![0] as ts.ObjectLiteralExpression
    return new Map(options.properties.map(property => [
      property.name!.getText(source),
      ts.isPropertyAssignment(property) ? property.initializer : property,
    ]))
  }

  test('every client hands events to the shared dispatcher; only the current one proves liveness', () => {
    const wrappers = descendants(variable('startWs')).filter((node): node is ts.CallExpression =>
      ts.isCallExpression(node) && node.expression.getText(source) === 'clientEventDispatcher')
    expect(wrappers.map(text)).toEqual(['clientEventDispatcher(dispatcher, () => client === ws, markEvent)'])
    // The shared dispatcher's logger is bound to no client, so it never retires one.
    expect(text(variable('dispatcher')!)).toBe('new lark.EventDispatcher({ logger: wsLogger(), loggerLevel: lark.LoggerLevel.warn })')
  })

  test('lifecycle callbacks of a replaced client only retire it again', () => {
    expect(statements(variable('makeWs')).map(text)).toContain('const current = () => client === ws')
    const options = clientOptions()
    expect(text(options.get('logger')!)).toBe('wsLogger(() => client)')
    for (const name of ['onReady', 'onReconnecting', 'onError']) {
      const [guard] = statements(options.get(name))
      expect(guard && ts.isIfStatement(guard)).toBe(true)
      expect(text((guard as ts.IfStatement).expression)).toBe('!current()')
      expect(text((guard as ts.IfStatement).thenStatement)).toMatch(
        name === 'onReady' ? /^wsRetirement\.retire\(client\)$/ : /^\{ wsRetirement\.retire\(client\); return \}$/,
      )
    }
    expect(statements(options.get('onReconnected')).map(text)).toEqual([
      'if (current()) onReconnectedHeal(); else wsRetirement.retire(client)',
    ])
  })

  test("a replaced client's liveness warning retires it instead of rebuilding the current connection", () => {
    const warn = descendants(variable('wsLogger')).find((node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) && node.name.getText(source) === 'warn')
    const inside = descendants(warn)
    const guard = inside.findIndex(node => ts.isIfStatement(node) && text(node.expression) === 'client && client !== ws')
    const rebuild = inside.findIndex(node => ts.isCallExpression(node) && node.expression.getText(source) === 'scheduleWsRebuild')
    expect(guard).toBeGreaterThan(-1)
    expect(text((inside[guard] as ts.IfStatement).thenStatement)).toBe('{ wsRetirement.retire(client); return }')
    expect(rebuild).toBeGreaterThan(guard)
  })

  test('a rebuild retires the replaced client once the fresh one is current; shutdown closes all retired ones', () => {
    const steps = statements(assigned('rebuildWs')).map(text)
    const swap = steps.indexOf('const old = ws')
    expect(swap).toBeGreaterThan(-1)
    expect(steps.slice(swap, swap + 3)).toEqual(['const old = ws', 'ws = makeWs()', 'if (old) wsRetirement.retire(old)'])
    expect(statements(assigned('stopFeishuWs')).map(text)).toContain('wsRetirement.closeAll()')
  })
})
