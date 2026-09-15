import { afterEach, beforeEach, expect, test } from 'bun:test'
import { resetFeishuMock, sentCards } from './feishu-test-mock'
import type { BgTaskEntry } from './cards/background'

const { createAgentCards } = await import('./agent-cards-runtime')
const cardkit = await import('./cardkit')
const originalFetch = globalThis.fetch
const cardId = 'completed_task_stream_reopen'

beforeEach(resetFeishuMock)
afterEach(async () => {
  globalThis.fetch = originalFetch
  await cardkit.dispose(cardId)
})

test('a late result on a completed task closes streaming again after Card Kit reopens it', async () => {
  let streaming = true
  const requests: Array<{ method: string; streaming?: boolean; code: number }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init?.body))
    if (url.pathname.endsWith('/id_convert')) return Response.json({ code: 0, data: { card_id: cardId } })
    const method = init?.method ?? 'GET'
    if (method === 'PATCH') {
      streaming = JSON.parse(body.settings).config.streaming_mode
      requests.push({ method, streaming, code: 0 })
      return Response.json({ code: 0 })
    }
    const code = streaming ? 0 : 300309
    requests.push({ method, code })
    return Response.json({ code, msg: code ? 'streaming mode is closed' : 'ok' })
  }) as typeof fetch
  const cards = createAgentCards()
  const task: BgTaskEntry = { id: 'native-task', type: 'subagent', description: '检查任务', status: 'running', startedAt: 1, steps: [] }
  await cards.syncBackground('stream-test-chat', 'stream-test-owner', [task])
  expect(sentCards).toHaveLength(1)
  const completed: BgTaskEntry = { ...task, status: 'completed', summary: '第一条结果', endTime: 2 }
  await cards.syncBackground('stream-test-chat', 'stream-test-owner', [completed])
  expect(streaming).toBe(false)
  await cards.syncBackground('stream-test-chat', 'stream-test-owner', [{ ...completed, summary: '补充的最终结果' }])
  expect(requests.some(request => request.code === 300309)).toBe(true)
  expect(requests.some(request => request.method === 'PATCH' && request.streaming === true)).toBe(true)
  expect(streaming).toBe(false)
  expect(requests.at(-1)).toEqual({ method: 'PATCH', streaming: false, code: 0 })
  expect(sentCards).toHaveLength(1)
})
