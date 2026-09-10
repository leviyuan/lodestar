import { expect, test } from 'bun:test'
import { debugModelActionEvent, debugModelState } from './debug-model'
import type { Session } from './session'

const context = { chat_id: 'oc_test', sender_open_id: 'ou_test_user' }
const message = { message_id: 'om_card', chat_id: 'oc_test', msg_type: 'interactive',
  sender: { id: 'cli_app', sender_type: 'app' } }
const body = () => ({ chat_id: 'oc_test', message_id: 'om_card',
  value: { kind: 'model_add', panel_id: 'panel', source_id: 'openrouter', model: 'qwen/test' } })

test('debug model actions use the seeded operator and the real panel message', () => {
  const event = debugModelActionEvent({ ...body(), operator: { open_id: 'ou_forged' } }, context, message, 'cli_app', 'om_card') as any
  expect(event.operator).toEqual({ open_id: 'ou_test_user' })
  expect(event.context).toEqual({ open_chat_id: 'oc_test', open_message_id: 'om_card' })
  expect(event.action.value).toEqual(body().value)
  expect(event.event_id).toStartWith('debug-model-')
})

test('debug model actions reject other chats, apps, stale panels and non-model operations', () => {
  expect(() => debugModelActionEvent({ ...body(), chat_id: 'oc_other' }, context, message, 'cli_app', 'om_card')).toThrow('chat mismatch')
  expect(() => debugModelActionEvent(body(), context, { ...message, chat_id: 'oc_other' }, 'cli_app', 'om_card')).toThrow('belong')
  expect(() => debugModelActionEvent(body(), context, message, 'cli_other', 'om_card')).toThrow('belong')
  expect(() => debugModelActionEvent(body(), context, message, 'cli_app', 'om_old')).toThrow('mismatched')
  expect(() => debugModelActionEvent(body(), context, { ...message, msg_type: 'text' }, 'cli_app', 'om_card')).toThrow('belong')
  for (const kind of ['kill', 'permission', 'token_source_enable', 'notify_callback']) {
    expect(() => debugModelActionEvent({ ...body(), value: { ...body().value, kind } }, context, message, 'cli_app', 'om_card')).toThrow('only model')
  }
  expect(() => debugModelActionEvent({ ...body(), value: { ...body().value, command: 'kill' } }, context, message, 'cli_app', 'om_card')).toThrow('unsupported')
})

test('debug model state publishes selected models and panel ids without session internals', () => {
  const session = { sessionName: 'test', chatId: 'oc_test', status: 'stopped', isRunning: () => false,
    currentTurn: null, openingTurn: false, pendingUserMessageCount: 0, pendingMidTurnMsgs: [],
    selectedProvider: 'claude', selectedTokenSourceId: 'openrouter', selectedModel: 'qwen/test', selectedEffort: 'high',
    agentCapability: 'PRIVATE_CAPABILITY', lastSessionId: 'PRIVATE_NATIVE_SESSION',
    modelPanels: new Map([['panel', { models: [{ model: 'qwen/test', provider: 'claude', sourceId: 'openrouter', efforts: [{ effort: 'high' }] }], messageId: 'om_card' }]]),
  } as unknown as Session
  const state = debugModelState(session) as any
  expect(state.selection).toEqual({ provider: 'claude', source_id: 'openrouter', model: 'qwen/test', effort: 'high' })
  expect(state.panels[0].message_id).toBe('om_card')
  expect(JSON.stringify(state)).not.toContain('PRIVATE_')
})
