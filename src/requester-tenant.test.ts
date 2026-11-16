import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  INTERNAL_REQUESTER,
  cardActionRequesterTenant,
  messageRequesterTenant,
  requesterTenant,
  shouldSeedDebugContext,
} from './requester-tenant'

describe('requester tenant', () => {
  test('only a known sender tenant that differs from the app tenant is external', () => {
    expect(requesterTenant('tenant_other', 'tenant_app')).toEqual({ external: true, appTenantKey: 'tenant_app' })
    expect(requesterTenant('tenant_app', 'tenant_app')).toEqual({ external: false })
  })

  test('a missing, empty or non-string tenant keeps the internal behavior', () => {
    for (const [sender, app] of [
      [undefined, 'tenant_app'],
      ['tenant_other', undefined],
      ['', 'tenant_app'],
      ['tenant_other', '  '],
      [42, 'tenant_app'],
      ['tenant_other', { key: 'tenant_app' }],
      [null, null],
    ] as const) {
      expect(requesterTenant(sender, app)).toBe(INTERNAL_REQUESTER)
    }
    expect(INTERNAL_REQUESTER).toEqual({ external: false })
    expect(Object.isFrozen(INTERNAL_REQUESTER)).toBe(true)
  })

  test('message events compare the sender tenant with the app tenant of the same event', () => {
    // SDK 展平后的 im.message.receive_v1：header 字段与 event 字段同级。
    const flattened = {
      tenant_key: 'tenant_app',
      sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user', tenant_key: 'tenant_other' },
      message: { chat_id: 'oc_chat' },
    }
    expect(messageRequesterTenant(flattened)).toEqual({ external: true, appTenantKey: 'tenant_app' })
    expect(messageRequesterTenant({ ...flattened, sender: { ...flattened.sender, tenant_key: 'tenant_app' } }))
      .toEqual({ external: false })
    // 未展平的原始 schema 2.0 事件同样可读。
    expect(messageRequesterTenant({
      header: { tenant_key: 'tenant_app' },
      event: { sender: { tenant_key: 'tenant_other' }, message: {} },
    })).toEqual({ external: true, appTenantKey: 'tenant_app' })
    expect(messageRequesterTenant({ message: { chat_id: 'oc_chat' } })).toBe(INTERNAL_REQUESTER)
    expect(messageRequesterTenant(undefined)).toBe(INTERNAL_REQUESTER)
  })

  test('card callbacks compare the operator tenant with the app tenant', () => {
    const callback = {
      tenant_key: 'tenant_app',
      operator: { open_id: 'ou_operator', tenant_key: 'tenant_other' },
      action: { value: { kind: 'temp_fork_select' } },
    }
    expect(cardActionRequesterTenant(callback)).toEqual({ external: true, appTenantKey: 'tenant_app' })
    expect(cardActionRequesterTenant({ ...callback, operator: { open_id: 'ou_operator', tenant_key: 'tenant_app' } }))
      .toEqual({ external: false })
    expect(cardActionRequesterTenant({ ...callback, tenant_key: undefined })).toBe(INTERNAL_REQUESTER)
    expect(cardActionRequesterTenant({ operator: { open_id: 'ou_operator' } })).toBe(INTERNAL_REQUESTER)
  })

  test('the result carries no requester identity', () => {
    const result = messageRequesterTenant({
      tenant_key: 'tenant_app',
      sender: { sender_id: { open_id: 'ou_sender', user_id: 'u_sender' }, tenant_key: 'tenant_other' },
    })
    expect(JSON.stringify(result)).not.toContain('sender')
    expect(JSON.stringify(result)).not.toContain('tenant_other')
  })
})

describe('debug context seeding', () => {
  const external = requesterTenant('tenant_other', 'tenant_app')

  test('only an internal [DEBUG] text message seeds the debug context', () => {
    expect(shouldSeedDebugContext(INTERNAL_REQUESTER, '[DEBUG]hi')).toBe(true)
    expect(shouldSeedDebugContext(INTERNAL_REQUESTER, '[DEBUG]')).toBe(true)
    expect(shouldSeedDebugContext(external, '[DEBUG]hi')).toBe(false)
    expect(shouldSeedDebugContext(INTERNAL_REQUESTER, 'hi [DEBUG]')).toBe(false)
    expect(shouldSeedDebugContext(INTERNAL_REQUESTER, '[debug]hi')).toBe(false)
    expect(shouldSeedDebugContext(INTERNAL_REQUESTER, '')).toBe(false)
    expect(shouldSeedDebugContext(INTERNAL_REQUESTER, { text: '[DEBUG]' })).toBe(false)
    expect(shouldSeedDebugContext(INTERNAL_REQUESTER, undefined)).toBe(false)
  })
})

describe('daemon requester wiring', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const source = ts.createSourceFile('daemon.ts', readFileSync(join(root, 'daemon.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  // daemon.ts boots the service on import, so the wiring is checked structurally.
  const handler = (name: string) => {
    const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    expect(declaration?.body).toBeDefined()
    return declaration!.body!
  }
  const calls = (node: ts.Node): ts.CallExpression[] => {
    const found: ts.CallExpression[] = []
    const visit = (child: ts.Node) => {
      if (ts.isCallExpression(child)) found.push(child)
      ts.forEachChild(child, visit)
    }
    visit(node)
    return found
  }

  test('messages compute the requester once per event and gate the debug context with it', () => {
    const statements = [...handler('handleMessage').statements]
    const index = (pattern: RegExp) => statements.findIndex(statement => pattern.test(statement.getText(source)))
    const requester = index(/^const requester = messageRequesterTenant\(data\)$/)
    expect(requester).toBeGreaterThan(-1)
    const seeding = statements.findIndex(statement => ts.isIfStatement(statement)
      && statement.expression.getText(source) === 'shouldSeedDebugContext(requester, debugTextRaw)')
    expect(seeding).toBeGreaterThan(requester)
    // The debug context write only happens inside that guarded branch.
    const writes = statements.filter(statement => /DEBUG_CTX_FILE/.test(statement.getText(source)))
    expect(writes).toEqual([statements[seeding]])
  })

  test('commands and fork selections receive the requester computed from their own event', () => {
    const commands = calls(handler('handleMessage'))
      .filter(call => call.expression.getText(source) === 'session.runCommand')
      .map(call => call.arguments.map(argument => argument.getText(source)))
    expect(commands).toEqual([['text', 'userOpenId', 'msgId', 'requester']])
    const forks = calls(handler('handleCardAction'))
      .filter(call => call.expression.getText(source) === 'session.onForkSelect')
      .map(call => call.arguments.map(argument => argument.getText(source)))
    expect(forks).toEqual([[
      "String(value.panel_id ?? '')", "String(value.choice_id ?? '')", 'userId', 'cardActionRequesterTenant(data)',
    ]])
  })

  test('the generic inbound failure notice drops member IDs', () => {
    const notices = calls(source)
      .filter(call => call.expression.getText(source) === 'feishu.sendTextRaw'
        && /消息处理出错/.test(call.arguments[1]?.getText(source) ?? ''))
    expect(notices).toHaveLength(1)
    expect(notices[0]!.arguments[1]!.getText(source)).toContain('redactMemberIds(')
  })
})
