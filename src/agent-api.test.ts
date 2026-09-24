import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createServer, request, type Server } from 'node:http'
import { handleAgentRequest } from './agent-api'
import { buildAgentIdentityCatalog } from './agent-identities'
import { listTokenSources, registerTokenSource, resetTokenSourceRegistry, type TokenSource, type UsageSnapshotUnified } from './token-source'

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
        runId: 'agent_1', sessionName: 'project', chatId: 'chat', workDir: request.workDir ?? '/repo', description: request.description, prompt: request.prompt,
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
  test('preserves Chinese task input split inside a UTF-8 character', async () => {
    const requests: any[] = []
    const base = await serve(value => requests.push(value))
    const body = Buffer.from(JSON.stringify({ description: '任务说明', identity_ids: ['agent:a'], prompt: '处理中文 🎉' }))
    const boundary = body.indexOf(Buffer.from('任务')) + 1
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/agents/runs`, { method: 'POST', headers: {
        authorization: 'Bearer secret', 'content-type': 'application/json',
      } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
      req.on('error', reject)
      req.write(body.subarray(0, boundary))
      setTimeout(() => req.end(body.subarray(boundary)), 10)
    })
    expect(status).toBe(202)
    expect(requests).toMatchObject([{ description: '任务说明', prompt: '处理中文 🎉' }])
  })

  test('requires a live capability', async () => {
    const base = await serve()
    expect((await fetch(`${base}/agents/identities`)).status).toBe(401)
    expect((await fetch(`${base}/agents/identities`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(403)
  })

  test('passes work_dir to the service and reports the selected directory in run and status responses', async () => {
    const requests: any[] = []
    const base = await serve(request => requests.push(request))
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    const response = await fetch(`${base}/agents/runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ description: '指定目录', identity_ids: ['agent:a'], prompt: 'work', work_dir: '/repo/packages/app' }),
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ run_id: 'agent_1', work_dir: '/repo/packages/app' })
    expect(requests[0]).toMatchObject({ workDir: '/repo/packages/app' })
    const status = await fetch(`${base}/agents/runs/agent_1`, { headers })
    expect(await status.json()).toMatchObject({ work_dir: '/repo/packages/app' })
    const invalid = await fetch(`${base}/agents/runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ description: '目录非法', identity_ids: ['agent:a'], prompt: 'work', work_dir: '' }),
    })
    expect(invalid.status).toBe(409)
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining('work_dir') })
    expect(requests).toHaveLength(1)
  })

  test('skill discovery reflects the latest cached subscription status without a separate TTL', async () => {
    const previousSources = listTokenSources()
    let checks = 0
    let usage: UsageSnapshotUnified = { state: 'network', windows: [], reason: 'Claude 原生额度接口未返回 rate_limits 数据' }
    const subscription: TokenSource = {
      id: 'claude-sub', kind: 'claude-subscription', agent: 'claude', display: 'Claude Code 订阅', enabled: true,
      models: [{ model: 'sonnet', display: 'Sonnet', efforts: ['high'], defaultEffort: 'high' }],
      defaultModel: 'sonnet', modelCatalogState: { status: 'ready', updatedAt: 1 },
      refreshModels: async () => {}, spawnEnv: env => env, resolveSpawnModel: model => model,
      readUsage: async () => { checks++; return usage },
    }
    resetTokenSourceRegistry()
    registerTokenSource(subscription)
    const start = Date.now()
    const time = spyOn(Date, 'now').mockReturnValue(start)
    try {
      const before = buildAgentIdentityCatalog([subscription])
      const base = await serve()
      const headers = { authorization: 'Bearer secret' }
      const failed = await fetch(`${base}/agents/identities`, { headers })
      expect(failed.status).toBe(200)
      const failedCatalog = await failed.json() as any
      expect(failedCatalog.identities).toEqual([])
      expect(failedCatalog.source_failures).toEqual([{
        token_source_id: 'claude-sub', display: 'Claude Code 订阅', status: 'failed', reason: usage.reason,
      }])
      expect(buildAgentIdentityCatalog([subscription])).toEqual(before)

      usage = { state: 'ok', windows: [{ kind: 'fiveHour', label: '5h 窗口', percent: 0, resetsAt: null }] }
      time.mockReturnValue(start + 30 * 60 * 1000 - 1)
      const cached = await fetch(`${base}/agents/identities`, { headers })
      expect(cached.status).toBe(200)
      expect((await cached.json() as any).identities).toHaveLength(1)
      expect(checks).toBe(2)

      time.mockReturnValue(start + 30 * 60 * 1000)
      const recovered = await fetch(`${base}/agents/identities`, { headers })
      expect(recovered.status).toBe(200)
      const readyCatalog = await recovered.json() as any
      expect(readyCatalog.identities).toMatchObject([{
        token_source_id: 'claude-sub', model: 'sonnet', default_effort: 'high', status: 'ready',
      }])
      expect(readyCatalog.source_failures).toEqual([])
      expect(readyCatalog.catalog_generation).not.toBe(failedCatalog.catalog_generation)
      expect(checks).toBe(3)
    } finally {
      time.mockRestore()
      resetTokenSourceRegistry()
      for (const source of previousSources) registerTokenSource(source)
    }
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
