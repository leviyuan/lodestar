import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { addedReactions, resetFeishuMock } from './feishu-test-mock'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  __setStoreFileForTest, register, get, loadCallbacks, buildNotifyResult, findPendingReply, pendingRepliesForChat, beginCallbackDispatch,
  type NotifyRegistration, type NotifyTextResponse, type DispatchResult,
} from './notify-callbacks'
import { handleNotifyRequest } from './notify'
import { createNotifyReplyRuntime, type NotifyReplyMessage } from './notify-replies'
import { PerKeyActor } from './card-action-runtime'
import { consumePendingTextInput } from './inbound-message'
import * as sessionAsk from './session-ask'
import * as cards from './cards'
import type { Session } from './session'

let dir: string
let file: string
beforeEach(() => {
  resetFeishuMock()
  dir = mkdtempSync(join(tmpdir(), 'lodestar-notify-replies-'))
  file = join(dir, 'callbacks.json')
  __setStoreFileForTest(file)
})
afterEach(() => { __setStoreFileForTest(file); rmSync(dir, { recursive: true, force: true }) })

function registration(overrides: Partial<NotifyRegistration> = {}): NotifyRegistration {
  return {
    notifyId: 'nf_reply', callbackUrl: 'http://127.0.0.1:9999/hook',
    chatId: 'oc_group', messageId: 'om_notification', project: 'ops', title: '部署时间',
    text: '请填写部署时间', level: 'info', imageKeys: [], buttons: [], allowReply: true,
    createdAt: Date.now(), ...overrides,
  }
}

function incoming(overrides: Partial<NotifyReplyMessage> = {}): NotifyReplyMessage {
  return { chatId: 'oc_group', openId: 'ou_owner', messageId: 'om_input', text: '明天十点', createTime: Date.now(), ...overrides }
}

function harness() {
  const sent: Array<{ chatId: string; messageId: string; card: any }> = []
  const updated: Array<{ messageId: string; card: any }> = []
  const notices: string[] = []
  const uploads: string[] = []
  const delivered: Array<{ notifyId: string; response: NotifyTextResponse; openId: string }> = []
  const controls = {
    send: async (): Promise<boolean> => true,
    update: async (_messageId: string): Promise<void> => {},
    dispatch: async (): Promise<DispatchResult> => ({ ok: true, detail: '200', reply: '已安排部署' }),
    waitingChanged: (_chatId: string): void => {},
  }
  const io = {
    sendCard: async (chatId: string, card: object) => {
      if (!await controls.send()) return null
      const messageId = `om_card_${sent.length + 1}`
      sent.push({ chatId, messageId, card })
      return messageId
    },
    updateCard: async (messageId: string, card: object) => {
      updated.push({ messageId, card })
      await controls.update(messageId)
    },
    sendText: async (_chatId: string, text: string) => { notices.push(text); return 'om_error' },
    dispatch: async (reg: NotifyRegistration, response: NotifyTextResponse, openId: string) => {
      delivered.push({ notifyId: reg.notifyId, response, openId })
      return controls.dispatch()
    },
    log: (_text: string) => {},
    onWaitingChanged: (chatId: string) => controls.waitingChanged(chatId),
  }
  const runtime = createNotifyReplyRuntime(io)
  const open = (notifyId = 'nf_reply', openId = 'ou_owner', chatId = 'oc_group') => runtime.open(notifyId, chatId, openId)
  const request = async (body?: object, path = '/notify') => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage
    req.method = body === undefined ? 'GET' : 'POST'
    req.url = path
    req.headers = { host: 'localhost' }
    let raw = ''
    const res = { statusCode: 200, setHeader: () => {}, end: (text: string) => { raw = text } } as unknown as ServerResponse
    await handleNotifyRequest(req, res, {
      ...io, sanitizeSessionName: name => name, chatIdForSession: () => 'oc_group',
      uploadImageKey: async path => { uploads.push(path); return 'img_test' },
    })
    return { status: res.statusCode, raw }
  }
  return { ...io, runtime, open, sent, updated, notices, uploads, delivered, controls, request }
}

function questionsFor(h: ReturnType<typeof harness>) {
  const permissionReplies: Array<{ id: string; answers: Record<string, string> }> = []
  const agentInputs: string[] = []
  const s = {
    sessionName: 'ops', chatId: 'oc_group', currentTurn: null, status: 'working',
    pendingAsks: new Map(), pendingPermissions: new Map(),
    proc: { sendPermissionResponse: (id: string, _decision: string, options: any) => {
      permissionReplies.push({ id, answers: options.updatedInput.answers })
    } },
    onUserMessage: async (text: string) => { agentInputs.push(text) },
  } as unknown as Session
  const add = (id: string, questionTexts: string[], requestId: string | null = `permission_${id}`) => {
    s.pendingAsks.set(id, {
      i: s.pendingAsks.size,
      questions: questionTexts.map(question => ({ question, options: [{ label: 'A' }, { label: 'B' }] })),
      answers: {}, answered: new Map(), currentIdx: 0,
      ...(requestId ? { requestId } : {}),
    })
    if (requestId) s.pendingPermissions.set(requestId, { toolUseId: id })
  }
  const panel = (id: string) => {
    const ask = s.pendingAsks.get(id)!
    return cards.askUserQuestionElement(ask.i, id, ask.questions, '🤔', sessionAsk.askRenderState(s, id)) as any
  }
  const route = async (message: NotifyReplyMessage) => {
    const consumed = await consumePendingTextInput({
      reply: () => h.runtime.consume(message),
      hasQuestion: () => sessionAsk.hasPendingAsk(s),
      answerQuestion: () => sessionAsk.onAskMessageAnswer(s, message.text, message.openId, message.messageId),
    })
    if (!consumed) await s.onUserMessage(message.text, [], message.openId, message.messageId)
  }
  h.controls.waitingChanged = () => sessionAsk.refreshPendingAsks(s)
  return { s, add, panel, route, permissionReplies, agentInputs }
}

describe('notification text reply workflow', () => {
  test('HTTP send → fixed reply button → waiting card → user text → callback receipt → GET result', async () => {
    const h = harness()
    const res = await h.request({ project: 'ops', text: '填写时间', images: ['/abs/schedule.png'], allow_reply: true, callback: 'http://localhost:9999/hook' })
    expect(res.status).toBe(200)
    const { notify_id, message_id } = JSON.parse(res.raw)
    expect(notify_id).toStartWith('nf_')
    const bottom = h.sent[0].card.body.elements.at(-1)
    expect(bottom.columns[0].elements[0].text.content).toBe('回复')
    expect(bottom.columns[0].elements[0].behaviors[0].value).toEqual({ kind: 'notify_reply', notify_id })
    expect((await h.open(notify_id)).ok).toBe(true)
    const prompt = h.sent[1]
    expect(prompt.card.header.title.content).toBe('等待用户输入')
    expect(JSON.stringify(prompt.card)).toContain('ou_owner')
    expect(h.delivered).toHaveLength(0)
    const text = '明天 **十点**\n<at id=all>所有人</at>'
    expect(await h.runtime.consume(incoming({ text }))).toBe(true)
    expect(h.delivered).toEqual([{
      notifyId: notify_id, openId: 'ou_owner',
      response: { text, message_id: 'om_input', prompt_message_id: prompt.messageId },
    }])
    expect(h.updated[0].messageId).toBe(prompt.messageId)
    expect(h.updated[0].card.header.title.content).toBe('正在发送回复')
    expect(h.updated[1].messageId).toBe(prompt.messageId)
    expect(h.updated[1].card.header.title.content).toBe('回复已送达')
    expect(JSON.stringify(h.updated[1].card)).toContain('已安排部署')
    expect(JSON.stringify(h.updated[1].card)).not.toContain('<at id=all>')
    expect(h.updated[2].messageId).toBe(message_id)
    expect(h.updated[2].card.body.elements).toContainEqual({ tag: 'img', img_key: 'img_test', alt: { tag: 'plain_text', content: 'screenshot' } })
    expect(h.uploads).toEqual(['/abs/schedule.png'])
    expect(JSON.stringify(h.updated[2].card)).not.toContain('notify_reply"')
    const result = JSON.parse((await h.request(undefined, `/notify/result/${notify_id}`)).raw)
    expect(result.resolved).toBe(true)
    expect(result.response).toEqual({ type: 'text', ...h.delivered[0].response })
    expect(result.button).toBeUndefined()
    expect(result.resolved_by).toBe('ou_owner')
    expect(result.reply.status).toBe('resolved')
  })

  test('HTTP validates allow_reply and keeps ordinary notifications noninteractive', async () => {
    const h = harness()
    for (const allow_reply of ['true', 1, null, {}]) {
      expect((await h.request({ project: 'ops', text: 'text', allow_reply })).status).toBe(400)
    }
    expect(h.sent).toHaveLength(0)
    const plain = await h.request({ project: 'ops', text: 'text', allow_reply: false })
    expect(JSON.parse(plain.raw).notify_id).toBeUndefined()
    expect(JSON.stringify(h.sent[0].card)).not.toContain('notify_reply')
  })

  test('all three HTTP card types retain image and markdown content with distinct controls', async () => {
    const h = harness()
    const cases = [
      { fields: {}, labels: [], interactive: false },
      { fields: { buttons: [{ id: 'approve', text: '通过' }] }, labels: ['通过'], interactive: true },
      { fields: { allow_reply: true }, labels: ['回复'], interactive: true },
    ]
    for (const entry of cases) {
      const result = await h.request({ project: 'ops', text: '**图文通知**', images: ['/abs/report.png'], ...entry.fields })
      expect(result.status).toBe(200)
      expect(!!JSON.parse(result.raw).notify_id).toBe(entry.interactive)
      const card = h.sent.at(-1)!.card
      const elements = card.body.elements as any[]
      expect(elements).toContainEqual({ tag: 'img', img_key: 'img_test', alt: { tag: 'plain_text', content: 'screenshot' } })
      expect(elements).toContainEqual({ tag: 'markdown', content: '**图文通知**' })
      const buttons = elements.filter(el => el.tag === 'column_set')
        .flatMap(el => el.columns.flatMap((column: any) => column.elements))
        .filter(el => el.tag === 'button')
      expect(buttons.map(button => button.text.content)).toEqual(entry.labels)
    }
    expect(h.uploads).toEqual(['/abs/report.png', '/abs/report.png', '/abs/report.png'])
  })

  test('HTTP rejects combining choice buttons and custom replies before uploading or sending', async () => {
    const h = harness()
    const result = await h.request({
      project: 'ops', text: '混合模式', images: ['/abs/report.png'], allow_reply: true,
      buttons: [{ id: 'yes', text: '可以' }],
    })
    expect(result.status).toBe(400)
    expect(result.raw).toContain('mutually exclusive')
    expect(h.uploads).toHaveLength(0)
    expect(h.sent).toHaveLength(0)
  })

  test('pull mode records text without invoking a callback', async () => {
    register(registration({ callbackUrl: '' }))
    const h = harness()
    await h.open()
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(0)
    expect(h.updated[1].card.header.title.content).toBe('回复已记录')
    expect(buildNotifyResult(get('nf_reply')!)).toMatchObject({ resolved: true, response: { type: 'text', text: '明天十点' } })
  })

  test('only the clicker in this chat is captured; no pending prompt means normal routing', async () => {
    register(registration())
    const h = harness()
    expect(await h.runtime.consume(incoming())).toBe(false)
    await h.open()
    expect(await h.runtime.consume(incoming({ openId: 'ou_other' }))).toBe(false)
    expect(await h.runtime.consume(incoming({ chatId: 'oc_other' }))).toBe(false)
    expect(await h.runtime.consume(incoming({ text: '   ' }))).toBe(false)
    expect(await h.runtime.consume(incoming({ messageId: '' }))).toBe(false)
    expect(h.delivered).toHaveLength(0)
    expect(await h.runtime.consume(incoming())).toBe(true)
  })

  test('messages older than the prompt are not captured, while quoted messages still follow reply priority', async () => {
    register(registration())
    const h = harness()
    await h.open()
    const state = get('nf_reply')!.replyState!
    expect(await h.runtime.consume(incoming({ createTime: state.openedAt - 1 }))).toBe(false)
    expect(await h.runtime.consume(incoming({ parentId: 'om_agent_question' }))).toBe(true)
    expect(h.delivered[0].notifyId).toBe('nf_reply')
  })

  test('the latest reply replaces the old one for the entire chat, including another clicker', async () => {
    register(registration())
    register(registration({ notifyId: 'nf_other' }))
    const h = harness()
    const [one, duplicate] = await Promise.all([h.open(), h.open()])
    expect(one.ok).toBe(true)
    expect(duplicate.ok).toBe(false)
    expect((await h.open()).ok).toBe(false)
    expect((await h.open('nf_reply', 'ou_other')).ok).toBe(false)
    expect((await h.open('nf_other', 'ou_other')).ok).toBe(true)
    expect(h.sent).toHaveLength(2)
    expect(get('nf_reply')?.replyState?.status).toBe('cancelled')
    expect(JSON.stringify(h.updated[0].card)).toContain('本次回复已放弃')
    expect(pendingRepliesForChat('oc_group').map(reg => reg.notifyId)).toEqual(['nf_other'])
    expect(findPendingReply('oc_group', 'ou_owner')).toBeUndefined()
    expect(await h.runtime.consume(incoming())).toBe(false)
    expect(await h.runtime.consume(incoming({ openId: 'ou_other' }))).toBe(true)
    expect(h.delivered[0].notifyId).toBe('nf_other')
    expect(h.delivered).toHaveLength(1)
  })

  test('switch failure leaves the old reply abandoned and never silently restores it', async () => {
    register(registration())
    register(registration({ notifyId: 'nf_other' }))
    const h = harness()
    await h.open()
    const old = get('nf_reply')!.replyState!
    h.controls.send = async () => false
    expect((await h.open('nf_other')).ok).toBe(false)
    expect(buildNotifyResult(get('nf_reply')!)).toMatchObject({
      resolved: false, reply: { status: 'cancelled', cancel_reason: 'switched' },
    })
    expect(pendingRepliesForChat('oc_group')).toHaveLength(0)
    expect(h.delivered).toHaveLength(0)
    expect((await h.runtime.cancel('nf_reply', old.id, 'oc_group', 'ou_owner')).ok).toBe(false)
  })

  test('failed cancellation persistence prevents the new prompt from opening', async () => {
    register(registration())
    register(registration({ notifyId: 'nf_other' }))
    const h = harness()
    await h.open()
    __setStoreFileForTest(join(file, 'bad.json'), false)
    await expect(h.open('nf_other')).rejects.toThrow()
    expect(h.sent).toHaveLength(1)
    expect(pendingRepliesForChat('oc_group').map(reg => reg.notifyId)).toEqual(['nf_reply'])
  })

  test('a question arriving during a reply waits; successive texts go to reply, question, then Agent exactly once', async () => {
    register(registration())
    const h = harness()
    const q = questionsFor(h)
    await h.open()
    q.add('ask', ['选择部署区域'])
    expect(q.panel('ask').header.title.content).toBe('⏳ 等待通知回复完成')
    expect(JSON.stringify(q.panel('ask'))).not.toContain('interactive_container')
    expect(await sessionAsk.onAskAnswer(q.s, 'ask', 0, 0, 'ou_owner')).toBe(false)

    await q.route(incoming({ text: '通知的回复' }))
    expect(h.delivered[0].response.text).toBe('通知的回复')
    expect(q.permissionReplies).toHaveLength(0)
    expect(q.s.pendingAsks.get('ask')!.answers).toEqual({})
    expect(JSON.stringify(q.panel('ask'))).toContain('interactive_container')

    await q.route(incoming({ messageId: 'om_question_answer', text: '上海' }))
    expect(q.permissionReplies).toEqual([{ id: 'permission_ask', answers: { '选择部署区域': '上海' } }])
    expect(addedReactions).toEqual([['om_question_answer', 'CheckMark']])
    expect(q.agentInputs).toHaveLength(0)
    await q.route(incoming({ messageId: 'om_agent_input', text: '继续执行' }))
    expect(q.agentInputs).toEqual(['继续执行'])
    expect(h.delivered).toHaveLength(1)
  })

  test('switching reply targets keeps a queued question intact and never submits the abandoned reply', async () => {
    register(registration())
    register(registration({ notifyId: 'nf_other' }))
    const h = harness()
    const q = questionsFor(h)
    q.add('ask', ['部署哪一个服务'])
    await h.open()
    const previous = get('nf_reply')!.replyState!
    await h.open('nf_other')
    expect((await h.runtime.cancel('nf_reply', previous.id, 'oc_group', 'ou_owner')).ok).toBe(false)
    expect(q.panel('ask').header.title.content).toBe('⏳ 等待通知回复完成')
    await q.route(incoming({ text: '只回复最新通知', parentId: previous.promptMessageId }))
    expect(h.delivered.map(result => result.notifyId)).toEqual(['nf_other'])
    expect(q.permissionReplies).toHaveLength(0)
    await q.route(incoming({ messageId: 'om_ask', text: 'API 服务' }))
    expect(q.permissionReplies[0].answers).toEqual({ '部署哪一个服务': 'API 服务' })
  })

  test('cancelling notification input resumes the pending question immediately', async () => {
    register(registration())
    const h = harness()
    const q = questionsFor(h)
    q.add('ask', ['继续吗'])
    await h.open()
    expect(sessionAsk.askBlockReason(q.s, 'ask')).toContain('通知回复')
    await h.runtime.cancel('nf_reply', get('nf_reply')!.replyState!.id, 'oc_group', 'ou_owner')
    expect(sessionAsk.askBlockReason(q.s, 'ask')).toBeNull()
    await q.route(incoming({ text: '继续' }))
    expect(q.permissionReplies[0].answers).toEqual({ '继续吗': '继续' })
    expect(h.delivered).toHaveLength(0)
  })

  test('only one question is answerable, including multiple questions within one tool call', async () => {
    const h = harness()
    const q = questionsFor(h)
    q.add('first', ['第一题', '第二题'])
    q.add('second', ['第三题'])
    expect(q.panel('second').header.title.content).toBe('⏳ 提问排队中')
    expect(await sessionAsk.onAskAnswer(q.s, 'second', 0, 0, 'ou_owner')).toBe(false)
    await q.route(incoming({ messageId: 'om_q1', text: '答一' }))
    expect(q.s.pendingAsks.get('first')!.currentIdx).toBe(1)
    expect(sessionAsk.askBlockReason(q.s, 'second')).toContain('当前问题')
    await q.route(incoming({ messageId: 'om_q2', text: '答二' }))
    expect(sessionAsk.askBlockReason(q.s, 'second')).toBeNull()
    expect(JSON.stringify(q.panel('second'))).toContain('interactive_container')
    await q.route(incoming({ messageId: 'om_q3', text: '答三' }))
    expect(q.permissionReplies).toEqual([
      { id: 'permission_first', answers: { '第一题': '答一', '第二题': '答二' } },
      { id: 'permission_second', answers: { '第三题': '答三' } },
    ])
    expect(sessionAsk.hasPendingAsk(q.s)).toBe(false)
  })

  test('an answered question waiting for its backend handshake does not capture later input', async () => {
    const h = harness()
    const q = questionsFor(h)
    q.add('first', ['先回答'], null)
    q.add('second', ['再回答'])
    await q.route(incoming({ messageId: 'om_first', text: '第一份答案' }))
    expect(q.s.pendingAsks.has('first')).toBe(true)
    expect(sessionAsk.askBlockReason(q.s, 'second')).toBeNull()
    await q.route(incoming({ messageId: 'om_second', text: '第二份答案' }))
    expect(sessionAsk.hasPendingAsk(q.s)).toBe(false)
    await q.route(incoming({ messageId: 'om_next', text: '下一条指令' }))
    expect(q.agentInputs).toEqual(['下一条指令'])
    q.s.pendingAsks.get('first')!.requestId = 'late_permission'
    sessionAsk.finalizeAsk(q.s, 'first')
    expect(q.permissionReplies.at(-1)).toEqual({ id: 'late_permission', answers: { '先回答': '第一份答案' } })
  })

  test('owner can cancel and reopen; old cancel actions cannot close the new prompt', async () => {
    register(registration())
    const h = harness()
    await h.open()
    const previous = get('nf_reply')!.replyState!
    expect((await h.runtime.cancel('nf_reply', previous.id, 'oc_group', 'ou_other')).ok).toBe(false)
    expect((await h.runtime.cancel('nf_reply', previous.id, 'oc_group', 'ou_owner')).ok).toBe(true)
    expect(h.updated.at(-1)!.card.header.title.content).toBe('已取消回复')
    expect(await h.runtime.consume(incoming())).toBe(false)
    expect((await h.open()).ok).toBe(true)
    expect((await h.runtime.cancel('nf_reply', previous.id, 'oc_group', 'ou_owner')).ok).toBe(false)
    expect(findPendingReply('oc_group', 'ou_owner')?.replyState?.id).not.toBe(previous.id)
  })

  test('waiting input survives reload; a completed input remains deduplicated after reload', async () => {
    register(registration())
    const h = harness()
    await h.open()
    __setStoreFileForTest(file)
    loadCallbacks()
    expect((await h.open()).ok).toBe(false)
    expect(await h.runtime.consume(incoming())).toBe(true)
    __setStoreFileForTest(file)
    loadCallbacks()
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(1)
    expect((await h.open()).ok).toBe(false)
  })

  test('send failure does not reserve input', async () => {
    register(registration())
    const h = harness()
    h.controls.send = async () => false
    expect((await h.open()).ok).toBe(false)
    expect(findPendingReply('oc_group', 'ou_owner')).toBeUndefined()
    expect(await h.runtime.consume(incoming())).toBe(false)
  })

  test('failure to persist a new prompt marks its visible card as failed without capturing input', async () => {
    register(registration())
    const h = harness()
    __setStoreFileForTest(join(file, 'bad.json'), false)
    expect((await h.open()).ok).toBe(false)
    expect(h.updated[0].card.header.title.content).toBe('回复发送失败')
    expect(findPendingReply('oc_group', 'ou_owner')).toBeUndefined()
    expect(await h.runtime.consume(incoming())).toBe(false)
    expect(h.delivered).toHaveLength(0)
  })

  test('input persistence failure is visible and never dispatches', async () => {
    register(registration())
    const h = harness()
    await h.open()
    __setStoreFileForTest(join(file, 'bad.json'), false)
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.notices[0]).toContain('保存失败，尚未回传')
    expect(get('nf_reply')!.replyState!.status).toBe('waiting')
    expect(h.delivered).toHaveLength(0)
  })

  test('callback failure is visible, releases input and requires an explicit new reply attempt', async () => {
    register(registration())
    const h = harness()
    await h.open()
    h.controls.dispatch = async () => ({ ok: false, detail: 'HTTP 503 unavailable' })
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.updated[1].card.header.title.content).toBe('回复发送失败')
    expect(JSON.stringify(h.updated[1].card)).toContain('HTTP 503 unavailable')
    expect(findPendingReply('oc_group', 'ou_owner')).toBeUndefined()
    expect(buildNotifyResult(get('nf_reply')!)).toMatchObject({ resolved: false, reply: { status: 'failed', error: 'HTTP 503 unavailable' } })
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(1)
    expect((await h.open()).ok).toBe(true)
    // Reopening must not forget the prior input's durable dedupe identity.
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(1)
    h.controls.dispatch = async () => ({ ok: true, detail: '200' })
    expect(await h.runtime.consume(incoming({ messageId: 'om_second' }))).toBe(true)
    expect(h.delivered).toHaveLength(2)
    expect(get('nf_reply')!.resolvedAt).toBeDefined()
  })

  test('failure to update the input receipt before POST does not dispatch', async () => {
    register(registration())
    const h = harness()
    await h.open()
    h.controls.update = async () => { throw new Error('Feishu unavailable') }
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(h.delivered).toHaveLength(0)
    expect(h.notices.join('\n')).toContain('Feishu unavailable')
    expect(get('nf_reply')!.replyState!.status).toBe('failed')
  })

  test('presentation failure after callback success stays resolved, reports error and never resends', async () => {
    register(registration())
    const h = harness()
    await h.open()
    h.controls.dispatch = async () => {
      h.controls.update = async () => { throw new Error('patch rejected') }
      return { ok: true, detail: '200' }
    }
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(get('nf_reply')!.resolvedAt).toBeDefined()
    expect(h.notices.join('\n')).toContain('回复已送达，卡片更新失败')
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect((await h.open()).ok).toBe(false)
    expect(h.delivered).toHaveLength(1)
  })

  test('successful callback with persistence failure is unknown and stays nonretryable after reload', async () => {
    register(registration())
    const h = harness()
    await h.open()
    h.controls.dispatch = async () => {
      __setStoreFileForTest(join(file, 'bad.json'), false)
      return { ok: true, detail: '200' }
    }
    expect(await h.runtime.consume(incoming())).toBe(true)
    expect(get('nf_reply')!.unknownAt).toBeDefined()
    expect(h.updated[1].card.header.title.content).toBe('回复送达状态未知')
    expect((await h.open()).ok).toBe(false)
    __setStoreFileForTest(file)
    const interrupted = loadCallbacks()
    expect(interrupted).toHaveLength(1)
    await h.runtime.recover(interrupted[0])
    expect(h.updated.at(-2)!.card.header.title.content).toBe('回复送达状态未知')
    expect(buildNotifyResult(get('nf_reply')!)).toMatchObject({ resolved: false, unknown: true, response: { text: '明天十点' } })
    expect((await h.open()).ok).toBe(false)
    expect(h.delivered).toHaveLength(1)
  })

  test('recovery freezes an interrupted button callback without claiming delivery or dispatching again', async () => {
    register(registration({ allowReply: false, buttons: [{ id: 'approve', text: '通过', type: 'primary' }] }))
    beginCallbackDispatch('nf_reply', 'approve', 'ou_owner')
    __setStoreFileForTest(file)
    const interrupted = loadCallbacks()
    const h = harness()
    await h.runtime.recover(interrupted[0])
    expect(h.updated).toHaveLength(1)
    expect(h.updated[0].messageId).toBe('om_notification')
    const card = JSON.stringify(h.updated[0].card)
    expect(card).toContain('送达状态未知，禁止自动重试')
    expect(card).not.toContain('已成功')
    expect(card).not.toContain('notify_callback')
    expect(h.delivered).toEqual([])
  })

  test('unsupported, wrong-chat and anonymous reply actions do not send waiting cards', async () => {
    register(registration({ allowReply: false }))
    const h = harness()
    expect((await h.open()).ok).toBe(false)
    register(registration())
    expect((await h.open('nf_reply', 'ou_owner', 'oc_wrong')).ok).toBe(false)
    expect((await h.open('nf_reply', '')).ok).toBe(false)
    expect((await h.open('missing')).ok).toBe(false)
    expect(h.sent).toHaveLength(0)
  })

  test('shared actor keeps an incoming answer behind prompt creation', async () => {
    register(registration())
    const h = harness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    h.controls.send = async () => { await gate; return true }
    const actor = new PerKeyActor()
    const prompt = actor.enqueue('oc_group', () => h.open())
    const answer = actor.enqueue('oc_group', () => h.runtime.consume(incoming()))
    expect(h.delivered).toHaveLength(0)
    release()
    expect((await prompt).ok).toBe(true)
    expect(await answer).toBe(true)
    expect(h.delivered).toHaveLength(1)
  })
})
