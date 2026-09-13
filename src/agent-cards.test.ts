import { describe, expect, test } from 'bun:test'
import { AgentCards, type AgentCardsDeps } from './agent-cards'
import { agentRunElementId } from './cards/agents'
import type { AgentRunSnapshot } from './agent-run-types'
import type { CardWriteResult } from './cardkit'
import { withChatMessageOrder } from './chat-message-order'

function run(id: string, chatId = 'chat'): AgentRunSnapshot {
  return {
    runId: id, chatId, sessionName: chatId, workDir: '/repo', description: `检查 ${id}`, prompt: '完整任务内容',
    depth: 0, status: 'running', createdAt: '2026-09-13T00:00:00Z', workers: [{
      identityId: 'same-agent', identityName: 'Agent A', tokenSourceId: 'glm', provider: 'claude',
      model: 'model', effort: 'max', status: 'running', output: '', steps: [],
    }],
  }
}

function terminal(value: AgentRunSnapshot): void {
  value.status = 'completed'
  value.workers[0]!.status = 'completed'
  value.workers[0]!.output = `结果 ${value.runId}`
}

function failure(code: number, message = 'card over max size'): CardWriteResult {
  return { landed: false, failure: { cardId: 'card', operation: 'write', code, message } }
}

function harness() {
  const tails = new Map<string, string>()
  const sent: Array<{ messageId: string; chatId: string; card: any }> = []
  const elements = new Map<string, Map<string, any>>()
  const settings = new Map<string, any>()
  const disposed = new Set<string>()
  const deps: AgentCardsDeps = {
    async sendCard(chatId, card) {
      const messageId = `message-${sent.length + 1}`
      sent.push({ messageId, chatId, card: structuredClone(card) })
      tails.set(chatId, messageId)
      elements.set(messageId, new Map((card as any).body.elements.map((e: any) => [e.element_id, structuredClone(e)])))
      return messageId
    },
    getChatTailMessageId: async chatId => tails.get(chatId) ?? null,
    convertMessageToCard: async id => id,
    recordCardCreated: () => {},
    getElementCount: id => elements.get(id)!.size,
    async addElementResult(id, element) {
      expect(disposed.has(id)).toBe(false)
      const key = (element as any).element_id
      expect(elements.get(id)!.has(key)).toBe(false)
      elements.get(id)!.set(key, structuredClone(element))
      return { landed: true }
    },
    async replaceElementResult(id, key, element) {
      expect(disposed.has(id)).toBe(false)
      expect(elements.get(id)!.has(key)).toBe(true)
      elements.get(id)!.set(key, structuredClone(element))
      return { landed: true }
    },
    async deleteElementChecked(id, key) { return elements.get(id)!.delete(key) },
    cancelSummary: () => {},
    async patchSettingsChecked(id, value) {
      expect(disposed.has(id)).toBe(false)
      settings.set(id, structuredClone(value))
      return true
    },
    async dispose(id) { disposed.add(id) },
  }
  const cards = new AgentCards(deps)
  return { cards, deps, tails, sent, elements, settings, disposed }
}

describe('shared delegation card lifecycle', () => {
  test('concurrent calls append unique rows and only the last task closes streaming', async () => {
    const h = harness()
    const a = run('a'), b = run('b')
    await Promise.all([h.cards.add(a), h.cards.add(b)])
    expect(h.sent).toHaveLength(1)
    expect(a.cardMessageId).toBe(b.cardMessageId)
    expect(h.elements.get('message-1')!.size).toBe(2)
    terminal(a)
    await h.cards.update(a, true)
    expect(h.settings.get('message-1').config.streaming_mode).toBe(true)
    expect(h.disposed.size).toBe(0)
    terminal(b)
    await h.cards.update(b, true)
    expect(h.settings.get('message-1').config.streaming_mode).toBe(false)
    expect(h.disposed.size).toBe(0)
    const replace = h.deps.replaceElementResult
    h.deps.replaceElementResult = async () => { throw new Error('late write after completion') }
    await h.cards.update(a)
    await h.cards.update(b, true)
    h.deps.replaceElementResult = replace
    const c = run('follow-up')
    await h.cards.add(c)
    expect(h.sent).toHaveLength(1)
    expect(h.settings.get('message-1').config.streaming_mode).toBe(true)
    expect(h.elements.get('message-1')!.size).toBe(3)
  })

  test('new main cards and user messages end reuse while older tasks continue updating', async () => {
    const h = harness()
    const a = run('a'), b = run('b'), c = run('c')
    await h.cards.add(a)
    h.tails.set('chat', 'main-conversation-card')
    await h.cards.add(b)
    expect(h.sent).toHaveLength(2)
    terminal(a)
    await h.cards.update(a, true)
    expect(h.elements.get('message-1')!.get(agentRunElementId('a')).header.title.content).toContain('完成')
    expect(h.disposed.has('message-1')).toBe(true)
    expect(h.disposed.has('message-2')).toBe(false)
    h.tails.set('chat', 'user-message')
    await h.cards.add(c)
    expect(h.sent).toHaveLength(3)
    expect(c.cardMessageId).toBe('message-3')
  })

  test('serializes main sends with the tail-read and append transaction', async () => {
    const h = harness()
    const a = run('a'), b = run('b'), c = run('c')
    await h.cards.add(a)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const getTail = h.deps.getChatTailMessageId
    h.deps.getChatTailMessageId = async chat => { await gate; return getTail(chat) }
    const append = h.cards.add(b)
    let mainSent = false
    const main = withChatMessageOrder('chat', async () => {
      mainSent = true
      h.tails.set('chat', 'main-card')
    })
    await Promise.resolve()
    expect(mainSent).toBe(false)
    release()
    await Promise.all([append, main])
    expect(b.cardMessageId).toBe('message-1')
    await h.cards.add(c)
    expect(c.cardMessageId).toBe('message-2')
  })

  test('groups from different chats remain independent', async () => {
    const h = harness()
    const a = run('a', 'chat-a'), b = run('b', 'chat-b')
    await Promise.all([h.cards.add(a), h.cards.add(b)])
    expect(h.sent).toHaveLength(2)
    expect(a.cardMessageId).not.toBe(b.cardMessageId)
  })

  test('rotates at the row limit and on a confirmed byte-capacity failure', async () => {
    const h = harness()
    for (let i = 0; i < 51; i++) await h.cards.add(run(String(i)))
    expect(h.sent).toHaveLength(2)
    expect(h.elements.get('message-1')!.size).toBe(50)
    h.deps.addElementResult = async () => failure(200860)
    await h.cards.add(run('bytes'))
    expect(h.sent).toHaveLength(3)
  })

  test('moves a growing result when its shared card fills, without losing other workers', async () => {
    const h = harness()
    const a = run('a'), b = run('b')
    await h.cards.add(a)
    await h.cards.add(b)
    const replace = h.deps.replaceElementResult
    h.deps.replaceElementResult = async (id, key, element) => id === 'message-1' && key === agentRunElementId('a')
      ? failure(200860) : replace(id, key, element)
    terminal(a)
    await h.cards.update(a, true)
    expect(a.cardMessageId).toBe('message-2')
    expect(h.elements.get('message-1')!.has(agentRunElementId('a'))).toBe(false)
    expect(h.elements.get('message-2')!.get(agentRunElementId('a')).expanded).toBe(false)
    expect(h.settings.get('message-1').config.streaming_mode).toBe(true)
    terminal(b)
    await h.cards.update(b, true)
    expect(h.disposed.has('message-1')).toBe(true)
  })

  test('does not create substitute cards after unknown tail or non-capacity write failures', async () => {
    const h = harness()
    await h.cards.add(run('a'))
    const getTail = h.deps.getChatTailMessageId
    h.deps.getChatTailMessageId = async () => { throw new Error('history permission denied') }
    await expect(h.cards.add(run('b'))).rejects.toThrow('history permission denied')
    h.deps.getChatTailMessageId = getTail
    h.deps.addElementResult = async () => failure(300315, 'invalid layout')
    await expect(h.cards.add(run('c'))).rejects.toThrow('invalid layout')
    expect(h.sent).toHaveLength(1)
  })

  test('a failed deletion after migration is reported while both cards can still settle', async () => {
    const h = harness()
    const a = run('a'), b = run('b')
    await h.cards.add(a)
    await h.cards.add(b)
    const replace = h.deps.replaceElementResult
    h.deps.replaceElementResult = async (id, key, element) => key === agentRunElementId('a')
      ? failure(200860) : replace(id, key, element)
    h.deps.deleteElementChecked = async () => false
    terminal(a)
    await expect(h.cards.update(a, true)).rejects.toThrow('deletion MISS')
    expect(h.settings.get('message-2').config.streaming_mode).toBe(false)
    terminal(b)
    await h.cards.update(b, true)
    expect(h.disposed.has('message-1')).toBe(true)
  })

  test('keeps errors visible if even a single task exceeds card capacity', async () => {
    const h = harness()
    const a = run('a')
    await h.cards.add(a)
    h.deps.replaceElementResult = async () => failure(200860)
    terminal(a)
    await expect(h.cards.update(a, true)).rejects.toThrow('card over max size')
    expect(h.sent).toHaveLength(1)
    expect(h.disposed.size).toBe(0)
  })

  test('disposes a sealed completed card, but preserves state after terminal settings fail', async () => {
    const h = harness()
    const a = run('a')
    await h.cards.add(a)
    terminal(a)
    const settings = h.deps.patchSettingsChecked
    h.deps.patchSettingsChecked = async () => false
    await expect(h.cards.update(a, true)).rejects.toThrow('settings update MISS')
    expect(h.disposed.size).toBe(0)
    h.deps.patchSettingsChecked = settings
    await h.cards.closeChat('chat')
    expect(h.disposed.has('message-1')).toBe(true)
    await h.cards.add(run('next'))
    expect(h.sent).toHaveLength(2)
  })
})
