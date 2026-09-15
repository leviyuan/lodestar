import { describe, expect, test } from 'bun:test'
import { AgentCards, type AgentCardsDeps } from './agent-cards'
import { agentRunElementId } from './cards/agents'
import type { AgentRunSnapshot } from './agent-run-types'
import type { CardWriteResult } from './cardkit'
import { withChatMessageOrder } from './chat-message-order'
import type { BgTaskEntry } from './cards/background'

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

function background(id: string, type: BgTaskEntry['type'] = 'shell'): BgTaskEntry {
  return { id, type, description: `检查 ${id}`, status: 'running', startedAt: Date.now(), steps: [] }
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
  test('delegated runs, native children and background jobs share one collapsed card', async () => {
    const h = harness()
    const delegated = run('delegated')
    const child = background('native-child', 'subagent')
    const shell = background('build')
    await Promise.all([
      h.cards.add(delegated),
      h.cards.syncBackground('chat', 'session', [child, shell]),
    ])
    expect(h.sent).toHaveLength(1)
    const rows = [...h.elements.get('message-1')!.values()]
    expect(rows).toHaveLength(3)
    expect(rows.every(row => row.tag === 'collapsible_panel' && row.expanded === false)).toBe(true)
    expect(h.settings.get('message-1').config.summary.content).toBe('🧠 委派任务 · 已结束 0/3')
    const completedChild = { ...child, status: 'completed' as const, summary: '子任务已完成', endTime: Date.now() }
    await h.cards.syncBackground('chat', 'session', [completedChild, shell])
    terminal(delegated)
    await h.cards.update(delegated, true)
    expect(h.settings.get('message-1').config.streaming_mode).toBe(true)
    expect(h.settings.get('message-1').config.summary.content).toContain('2/3')
    const failedShell = { ...shell, status: 'failed' as const, error: '构建失败', endTime: Date.now() }
    await h.cards.syncBackground('chat', 'session', [completedChild, failedShell])
    expect(h.settings.get('message-1').config.streaming_mode).toBe(false)
    expect(h.settings.get('message-1').config.summary.content).toContain('失败 1')
    expect(JSON.stringify([...h.elements.get('message-1')!.values()])).toContain('构建失败')
  })

  test('late SDK task ids keep one row; native follow-ups retain the previous result', async () => {
    const h = harness()
    const child = { ...background('tool-id', 'subagent'), toolUseId: 'tool-id' }
    await h.cards.syncBackground('chat', 'session', [child])
    const bound = { ...child, id: 'sdk-task-id' }
    await h.cards.syncBackground('chat', 'session', [bound])
    expect(h.elements.get('message-1')!.size).toBe(1)
    const completed = { ...bound, status: 'completed' as const, summary: '上一轮结果' }
    await h.cards.syncBackground('chat', 'session', [completed])
    await h.cards.syncBackground('chat', 'session', [{ ...bound, startedAt: Date.now() + 1000 }])
    expect(h.sent).toHaveLength(1)
    expect(h.elements.get('message-1')!.size).toBe(2)
    expect(JSON.stringify([...h.elements.get('message-1')!.values()])).toContain('上一轮结果')
    expect(h.settings.get('message-1').config.streaming_mode).toBe(true)
  })

  test('process owners and delegated run ids cannot collide with native task ids', async () => {
    const h = harness()
    await h.cards.add(run('same-id'))
    await h.cards.syncBackground('chat', 'process-a', [background('same-id')])
    await h.cards.syncBackground('chat', 'process-b', [background('same-id')])
    expect(h.sent).toHaveLength(1)
    expect(h.elements.get('message-1')!.size).toBe(3)
    expect([...h.elements.get('message-1')!.keys()].every(id => /^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(id))).toBe(true)
  })

  test('unchanged snapshots do not write; new messages leave existing native tasks in place', async () => {
    const h = harness()
    const child = background('child', 'subagent')
    const shell = background('shell')
    await h.cards.syncBackground('chat', 'session', [child, shell])
    const replace = h.deps.replaceElementResult
    h.deps.replaceElementResult = async () => { throw new Error('unexpected unchanged write') }
    await h.cards.syncBackground('chat', 'session', [child, shell])
    h.deps.replaceElementResult = replace
    h.tails.set('chat', 'new-user-message')
    await h.cards.add(run('later-delegation'))
    const completed = [child, shell].map(task => ({ ...task, status: 'completed' as const }))
    await h.cards.syncBackground('chat', 'session', completed)
    expect(h.sent).toHaveLength(2)
    expect(h.disposed.has('message-1')).toBe(true)
    expect(h.disposed.has('message-2')).toBe(false)
    await h.cards.syncBackground('chat', 'session', completed)
    expect(h.sent).toHaveLength(2)
  })

  test('a rejected settings update retries its existing native row without duplication', async () => {
    const h = harness()
    await h.cards.add(run('delegated'))
    const child = background('child', 'subagent')
    const patch = h.deps.patchSettingsChecked
    h.deps.patchSettingsChecked = async () => false
    await expect(h.cards.syncBackground('chat', 'session', [child])).rejects.toThrow('settings update MISS')
    h.deps.patchSettingsChecked = patch
    await h.cards.syncBackground('chat', 'session', [child])
    expect(h.sent).toHaveLength(1)
    expect(h.elements.get('message-1')!.size).toBe(2)
  })

  test('native follow-up preserves a result whose terminal settings failed', async () => {
    const h = harness()
    const child = background('child', 'subagent')
    await h.cards.syncBackground('chat', 'session', [child])
    const patch = h.deps.patchSettingsChecked
    h.deps.patchSettingsChecked = async () => false
    await expect(h.cards.syncBackground('chat', 'session', [{ ...child, status: 'completed', summary: '已完成的结果' }]))
      .rejects.toThrow('settings update MISS')
    h.deps.patchSettingsChecked = patch
    await h.cards.syncBackground('chat', 'session', [{ ...child, description: '继续检查', startedAt: child.startedAt + 1000 }])
    expect(h.elements.get('message-1')!.size).toBe(2)
    expect(h.settings.get('message-1').config.streaming_mode).toBe(true)
    expect(JSON.stringify([...h.elements.get('message-1')!.values()])).toContain('已完成的结果')
  })

  test('native terminal corrections and byte-capacity rotation preserve other delegated work', async () => {
    const h = harness()
    const delegated = run('delegated')
    const child = background('child', 'subagent')
    await h.cards.add(delegated)
    await h.cards.syncBackground('chat', 'session', [child])
    const complete = { ...child, status: 'completed' as const, summary: '结果' }
    await h.cards.syncBackground('chat', 'session', [complete])
    const replace = h.deps.replaceElementResult
    h.deps.replaceElementResult = async (id, key, element) => id === 'message-1' && key.startsWith('bg_')
      ? failure(200860) : replace(id, key, element)
    await h.cards.syncBackground('chat', 'session', [{ ...complete, status: 'failed', error: '原生终态纠正' }])
    expect(h.sent).toHaveLength(2)
    expect(h.elements.get('message-1')!.size).toBe(1)
    expect(h.settings.get('message-1').config.streaming_mode).toBe(true)
    expect(JSON.stringify([...h.elements.get('message-2')!.values()])).toContain('原生终态纠正')
    terminal(delegated)
    await h.cards.update(delegated, true)
    expect(h.disposed.has('message-1')).toBe(true)
  })

  test('late tool ownership preserves the stable task row', async () => {
    const h = harness()
    const child = { ...background('sdk-id', 'subagent'), displayId: 'sdk-id' }
    await h.cards.syncBackground('chat', 'session', [child])
    await h.cards.syncBackground('chat', 'session', [{ ...child, toolUseId: 'late-tool' }])
    expect(h.sent).toHaveLength(1)
    expect(h.elements.get('message-1')!.size).toBe(1)
  })

  test('capacity rotation can correct an entirely completed shared card before disposing it', async () => {
    const h = harness()
    const first = { ...background('first'), status: 'completed' as const }
    const second = { ...background('second'), status: 'completed' as const }
    await h.cards.syncBackground('chat', 'session', [first, second])
    const replace = h.deps.replaceElementResult
    h.deps.replaceElementResult = async (id, key, element) => id === 'message-1'
      ? failure(200860) : replace(id, key, element)
    const remove = h.deps.deleteElementChecked
    h.deps.deleteElementChecked = async (id, key) => {
      expect(h.disposed.has(id)).toBe(false)
      return remove(id, key)
    }
    await h.cards.syncBackground('chat', 'session', [{ ...first, status: 'failed', error: '原生失败结果' }, second])
    expect(h.sent).toHaveLength(2)
    expect(h.disposed.has('message-1')).toBe(true)
    expect(h.settings.get('message-2').config.streaming_mode).toBe(false)
  })

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
