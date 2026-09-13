import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { handleAgentRequest } from './agent-api'

let server: Server | null = null
afterEach(() => { server?.close(); server = null })

async function serve(onStart?: (request: any) => void) {
  const session = { sessionName: 'project', chatId: 'chat', workDir: '/repo', codexAccountId: () => 'default' } as any
  let current: any = null
  const service = {
    rootPrincipal: () => ({ kind: 'session', session, depth: -1 }),
    principalForCapability: () => null,
    async startRun(_principal: any, request: any) {
      onStart?.(request)
      current = {
        runId: 'agent_1', sessionName: 'project', chatId: 'chat', workDir: '/repo', description: request.description, prompt: request.prompt,
        depth: 0, status: 'running', createdAt: new Date().toISOString(), workers: [{
          identityId: 'agent:a', status: 'running', sessionId: request.sessionId, output: request.prompt, steps: [],
        }],
      }
      return current
    },
    getRun: () => current,
    async followUp(_principal: any, runId: string, request: any) {
      return { ...current, runId: 'agent_2', parentRunId: runId, parentKind: 'follow_up', description: request.description, prompt: request.prompt }
    },
    async answer() { return { ...current, status: 'running' } },
    async cancelRun() { current.status = 'cancelled'; return true },
  }
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    void handleAgentRequest(req, res, url, {
      service: service as any,
      authorizeSession: token => token === 'secret' ? session : null,
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return `http://127.0.0.1:${address.port}`
}

describe('delegated Agent HTTP API', () => {
  test('requires a live capability', async () => {
    const base = await serve()
    expect((await fetch(`${base}/agents/identities`)).status).toBe(401)
    expect((await fetch(`${base}/agents/identities`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(403)
  })

  test('creates, reads, follows up, answers, and cancels Agent runs', async () => {
    const base = await serve()
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    const created = await fetch(`${base}/agents/runs`, {
      method: 'POST', headers, body: JSON.stringify({ description: '任务说明', identity_ids: ['agent:a'], prompt: 'do it' }),
    })
    expect(created.status).toBe(202)
    expect((await created.json() as any).run_id).toBe('agent_1')
    expect((await fetch(`${base}/agents/runs/agent_1`, { headers })).status).toBe(200)

    const follow = await fetch(`${base}/agents/runs/agent_1/follow-up`, {
      method: 'POST', headers, body: JSON.stringify({ description: '继续任务', prompt: 'continue' }),
    })
    expect((await follow.json() as any)).toMatchObject({ run_id: 'agent_2', parent_kind: 'follow_up' })

    const answer = await fetch(`${base}/agents/runs/agent_1/answer`, {
      method: 'POST', headers, body: JSON.stringify({ request_id: 'r', answers: { q: 'a' } }),
    })
    expect(answer.status).toBe(200)
    expect((await fetch(`${base}/agents/runs/agent_1`, { method: 'DELETE', headers })).status).toBe(200)
  })

  test('accepts session_id plus new input and serializes the resumable session and content', async () => {
    const requests: any[] = []
    const base = await serve(request => requests.push(request))
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    const response = await fetch(`${base}/agents/runs`, {
      method: 'POST', headers, body: JSON.stringify({ description: '任务说明', session_id: 'native-sid', prompt: '  next\n' }),
    })
    expect(response.status).toBe(202)
    expect(requests).toEqual([{ description: '任务说明', identityIds: [], sessionId: 'native-sid', prompt: '  next\n' }])
    expect(await response.json()).toMatchObject({
      description: '任务说明', workers: [{ session_id: 'native-sid', output: '  next\n' }],
    })
    const invalid = await fetch(`${base}/agents/runs`, {
      method: 'POST', headers, body: JSON.stringify({ description: '任务说明', identity_ids: ['agent:a'], session_id: '', prompt: 'next' }),
    })
    expect(invalid.status).toBe(409)
    expect(requests).toHaveLength(1)
  })
})
