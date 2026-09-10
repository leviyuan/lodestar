import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { resetFeishuMock, urgentPushes } from './feishu-test-mock'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as cardkit from './cardkit'
import { ELEMENTS } from './cards'
import { addTool } from './session-tools'
import { renderPermission } from './session-permission'
import { onAskAnswer, refreshPendingAsks } from './session-ask'
import { __setStoreFileForTest, get, register, setReplyState } from './notify-callbacks'
import type { Session } from './session'

let dir: string
let panels: Map<string, any>
let restore: Array<() => void>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lodestar-ask-priority-'))
  __setStoreFileForTest(join(dir, 'callbacks.json'))
  resetFeishuMock()
  panels = new Map()
  const add = spyOn(cardkit, 'addElement').mockImplementation(async (_id, element) => {
    panels.set((element as any).element_id, element)
  })
  const replace = spyOn(cardkit, 'replaceElement').mockImplementation(async (_id, elementId, element) => {
    panels.set(elementId, element)
  })
  const settings = spyOn(cardkit, 'patchSettings').mockResolvedValue(undefined)
  const summary = spyOn(cardkit, 'cancelSummary').mockImplementation(() => {})
  restore = [() => add.mockRestore(), () => replace.mockRestore(), () => settings.mockRestore(), () => summary.mockRestore()]
})
afterEach(async () => {
  await new Promise<void>(resolve => setImmediate(resolve))
  for (const undo of restore.reverse()) undo()
  __setStoreFileForTest(join(dir, 'callbacks.json'))
  rmSync(dir, { recursive: true, force: true })
})

function harness(provider: 'codex' | 'claude' | 'dsh') {
  const answers: Array<{ requestId: string; decision: string; options: any }> = []
  const s = {
    chatId: 'oc_ask', sessionName: 'ask-priority', status: 'working',
    pendingAsks: new Map(), pendingPermissions: new Map(),
    currentTurn: {
      cardId: 'card_ask', messageId: 'om_turn', userOpenId: 'ou_owner', provider,
      toolCount: 0, toolByUseId: new Map(), toolBatches: new Map(), openBatchI: null,
    },
    maybeMidTurnRotate: () => {}, startWorkingFooter: () => {},
    proc: { provider, sendPermissionResponse: (requestId: string, decision: string, options: any) => {
      answers.push({ requestId, decision, options })
    } },
  } as unknown as Session
  const add = (id: string, text: string) => {
    const input = { questions: [{ question: text, options: [{ label: 'A' }, { label: 'B' }] }] }
    addTool(s, id, 'AskUserQuestion', input)
    renderPermission(s, { request_id: `permission_${id}`, tool_use_id: id, tool_name: 'AskUserQuestion', input })
  }
  return { s, answers, add }
}

function startReply() {
  register({
    notifyId: 'nf_ask_priority', callbackUrl: '', chatId: 'oc_ask', messageId: 'om_notify',
    project: 'ops', title: '回复', text: '请输入', level: 'info', imageKeys: [], buttons: [], allowReply: true,
    createdAt: Date.now(), replyState: {
      id: 'reply', openId: 'ou_owner', promptMessageId: 'om_prompt', openedAt: Date.now(), status: 'waiting',
    },
  })
}

function endReply() {
  setReplyState('nf_ask_priority', { ...get('nf_ask_priority')!.replyState!, status: 'cancelled' })
}

const flushAnnouncements = () => new Promise<void>(resolve => setImmediate(resolve))

describe('question presentation and backend handshakes', () => {
  for (const provider of ['codex', 'claude', 'dsh'] as const) {
    test(`${provider}: notification input defers question controls and alerts; completion activates one question at a time`, async () => {
      const h = harness(provider)
      startReply()
      h.add('first', '先选择区域')
      h.add('second', '再选择环境')
      await flushAnnouncements()
      expect(panels.get(ELEMENTS.tool(0)).header.title.content).toBe('⏳ 等待通知回复完成')
      expect(JSON.stringify([...panels.values()])).not.toContain('interactive_container')
      expect(urgentPushes).toHaveLength(0)
      expect(await onAskAnswer(h.s, 'first', 0, 0, 'ou_owner')).toBe(false)
      expect(h.answers).toHaveLength(0)

      endReply()
      refreshPendingAsks(h.s)
      await flushAnnouncements()
      expect(JSON.stringify(panels.get(ELEMENTS.tool(0)))).toContain('interactive_container')
      expect(panels.get(ELEMENTS.tool(1)).header.title.content).toBe('⏳ 提问排队中')
      expect(urgentPushes).toHaveLength(1)
      expect(await onAskAnswer(h.s, 'second', 0, 1, 'ou_owner')).toBe(false)

      expect(await onAskAnswer(h.s, 'first', 0, 0, 'ou_owner')).toBe(true)
      await flushAnnouncements()
      expect(panels.get(ELEMENTS.tool(0)).header.title.content).toBe('✅ 已回答 · 1/1')
      expect(JSON.stringify(panels.get(ELEMENTS.tool(1)))).toContain('interactive_container')
      expect(urgentPushes).toHaveLength(2)
      expect(h.answers[0]).toMatchObject({ requestId: 'permission_first', decision: 'allow', options: {
        updatedInput: { questions: [{ question: '先选择区域' }], answers: { '先选择区域': 'A' } },
      } })
    })
  }

  test('opening a reply suspends an already visible question and later restores it', async () => {
    const h = harness('codex')
    h.add('first', '继续吗')
    await flushAnnouncements()
    expect(urgentPushes).toHaveLength(1)
    startReply()
    refreshPendingAsks(h.s)
    expect(panels.get(ELEMENTS.tool(0)).header.title.content).toBe('⏳ 等待通知回复完成')
    endReply()
    refreshPendingAsks(h.s)
    await flushAnnouncements()
    expect(JSON.stringify(panels.get(ELEMENTS.tool(0)))).toContain('interactive_container')
    expect(urgentPushes).toHaveLength(2)
  })

  test('a delayed question alert cannot overtake a reply or duplicate the resumed alert', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    spyOn(cardkit, 'patchSettings').mockImplementation(async () => { await gate })
    const h = harness('codex')
    h.add('first', '继续吗')
    startReply()
    refreshPendingAsks(h.s)
    endReply()
    refreshPendingAsks(h.s)
    release()
    await flushAnnouncements()
    expect(urgentPushes).toHaveLength(1)
  })
})
