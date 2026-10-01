import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { activateCodexAccount, activationBody, activationEffort, CODEX_ACTIVATION_MODEL, isUnusedMainWeek,
  readActivationResponse, type ActivationRequestDeps, type ActivationRequestOptions } from './codex-activation-request'
import { snapshotFromReadResponse, type UsageSnapshot } from './usage'
import type { TokenSource } from './token-source'

const upstreamId = 'test-subscription'
const identity = createHash('sha256').update(upstreamId).digest('hex')
const token = 'test-private-credential'
const rawUsage = (used = 0) => ({ accountId: upstreamId, ordinaryUsageAllowed: true,
  rateLimits: { limitId: 'codex', planType: 'pro', primary: { usedPercent: used,
    windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 7 * 86400 } } })
const terminal = (extra = {}) => ({ type: 'response.completed', response: {
  status: 'completed', usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 }, ...extra } })
function sse(events: unknown[], split = false): Response {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join(''))
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3))
    else controller.enqueue(bytes)
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream' } })
}
function harness() {
  const calls: string[] = []
  const posts: Array<{ url: string; init: RequestInit }> = []
  const state = { raw: rawUsage(), store: 'file', quotaError: null as Error | null,
    response: () => sse([terminal()], true), refresh: snapshotFromReadResponse(rawUsage(0.1)) as UsageSnapshot,
    closeError: null as Error | null, eligible: true }
  const client = {
    async initialize(name: string) { calls.push(name) },
    async request(method: string, params: any) {
      calls.push(method)
      if (method === 'config/read') return { config: { cli_auth_credentials_store: state.store, chatgpt_base_url: 'https://chatgpt.com/backend-api/' } }
      if (method === 'account/read') {
        expect(params).toEqual({ refreshToken: true })
        return { account: { type: 'chatgpt', planType: 'pro' } }
      }
      if (method === 'account/rateLimits/read') { if (state.quotaError) throw state.quotaError; return state.raw }
      throw new Error(`unexpected method ${method}`)
    },
    async close() { calls.push('close'); if (state.closeError) throw state.closeError },
  }
  const deps: ActivationRequestDeps = {
    createClient: id => { expect(id).toBe('named'); return client },
    credentials: async id => { expect(id).toBe('named'); calls.push('credentials'); return { accessToken: token, accountId: upstreamId } },
    fetch: async (url, init = {}) => { calls.push('POST'); posts.push({ url: String(url), init }); return state.response() },
    refresh: async (app, id) => { expect(app).toBe(client); expect(id).toBe('named'); calls.push('refresh'); return state.refresh },
  }
  const controller = new AbortController()
  const opts: ActivationRequestOptions = { accountId: 'named', identity, effort: 'low', signal: controller.signal,
    eligible: () => state.eligible, used: (_usage, tokens) => { expect(tokens).toBe(11); calls.push('used') } }
  return { calls, posts, state, deps, opts, controller }
}

describe('zero-context Codex activation', () => {
  test('native fresh quota immediately precedes the single minimal subscription POST', async () => {
    const h = harness()
    expect(await activateCodexAccount(h.opts, h.deps)).toBe('sent')
    expect(h.calls).toEqual(['lodestar-codex-activation', 'config/read', 'account/read', 'credentials',
      'account/rateLimits/read', 'POST', 'used', 'refresh', 'close'])
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0].url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(h.posts[0].init.redirect).toBe('error')
    expect(h.posts[0].init.headers).toMatchObject({ authorization: `Bearer ${token}`, 'chatgpt-account-id': upstreamId })
    expect(JSON.parse(String(h.posts[0].init.body))).toEqual({ model: 'gpt-6-luna', instructions: '', store: false, stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: '你好，只回复“你好”。' }] }], tools: [], tool_choice: 'none',
      parallel_tool_calls: false, reasoning: { effort: 'low' }, text: { verbosity: 'low' }, service_tier: 'default' })
    expect(JSON.stringify(h.posts)).not.toMatch(/AGENTS|skills|previous_response_id|conversation|session-id|threadId/)
  })
  test('another device consuming any quota or fixing the reset clock prevents sending', async () => {
    for (const change of ['usage', 'clock', 'short-window', 'included-usage', 'spend-control']) {
      const h = harness()
      if (change === 'usage') h.state.raw.rateLimits.primary.usedPercent = 0.001
      if (change === 'clock') h.state.raw.rateLimits.primary.resetsAt -= 60
      if (change === 'short-window') (h.state.raw.rateLimits as any).secondary = { usedPercent: 1, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 18000 }
      if (change === 'included-usage') h.state.raw.ordinaryUsageAllowed = false
      if (change === 'spend-control') Object.assign(h.state.raw.rateLimits, { spendControlReached: true })
      expect(await activateCodexAccount(h.opts, h.deps)).toBe('skipped')
      expect(h.posts).toHaveLength(0)
      expect(h.calls.at(-1)).toBe('close')
    }
  })
  test('credit-funded task eligibility cannot activate an unavailable included allowance', async () => {
    for (const flag of ['ordinaryUsageAllowed', 'rateLimitReachedType']) {
      const h = harness()
      Object.assign(h.state.raw.rateLimits, { credits: { hasCredits: true, unlimited: false, balance: '100' } })
      if (flag === 'ordinaryUsageAllowed') h.state.raw.ordinaryUsageAllowed = false
      else Object.assign(h.state.raw.rateLimits, { rateLimitReachedType: 'rate_limit_reached' })
      expect(await activateCodexAccount(h.opts, h.deps)).toBe('skipped')
      expect(h.posts).toHaveLength(0)
      expect(h.calls.at(-1)).toBe('close')
    }
  })
  test('a cheapest model assigned to a reserve meter is an explicit error, never another-model retry', async () => {
    const h = harness()
    ;(h.state.raw as any).rateLimitsByLimitId = { codex: h.state.raw.rateLimits,
      reserve: { ...h.state.raw.rateLimits, limitId: 'reserve', normalModelSlug: CODEX_ACTIVATION_MODEL } }
    await expect(activateCodexAccount(h.opts, h.deps)).rejects.toThrow('独立额度')
    expect(h.posts).toHaveLength(0)
  })
  test('a failed quota read cannot send from an old successful cache', async () => {
    const h = harness(); h.state.quotaError = new Error('HTTP 401 quota rejected')
    await expect(activateCodexAccount(h.opts, h.deps)).rejects.toThrow('HTTP 401 quota rejected')
    expect(h.posts).toHaveLength(0)
    expect(h.calls.at(-1)).toBe('close')
  })
  test('revision, identity and foreground-use checks remain authoritative at send time', async () => {
    const h = harness(); h.state.eligible = false
    expect(await activateCodexAccount(h.opts, h.deps)).toBe('skipped')
    expect(h.posts).toHaveLength(0)
    h.state.eligible = true; h.state.raw.accountId = 'other-account'
    await expect(activateCodexAccount(h.opts, h.deps)).rejects.toThrow('身份')
    expect(h.posts).toHaveLength(0)
  })
  test('keyring-only storage is an explicit error without modifying auth or starting an agent', async () => {
    const h = harness(); h.state.store = 'keyring'
    await expect(activateCodexAccount(h.opts, h.deps)).rejects.toThrow('文件登录态')
    expect(h.calls).toEqual(['lodestar-codex-activation', 'config/read', 'close'])
  })
  test('confirmed use survives refresh and close failures', async () => {
    const h = harness(); h.state.refresh = { state: 'network', reason: 'upstream unavailable' }
    h.state.closeError = new Error('exit unconfirmed')
    await expect(activateCodexAccount(h.opts, h.deps)).rejects.toThrow('请求已成功')
    expect(h.calls).toContain('used')
    expect(h.calls.at(-1)).toBe('close')
  })
  test('failed POST is not replayed and diagnostic redacts credentials', async () => {
    const h = harness(); h.state.response = () => new Response(`HTTP failure echoed ${token}`, { status: 503 })
    let message = ''
    try { await activateCodexAccount(h.opts, h.deps) } catch (error) { message = String(error) }
    expect(message).toContain('503'); expect(message).not.toContain(token)
    expect(h.posts).toHaveLength(1); expect(h.calls).not.toContain('used')
  })
  test('redact complete long credentials before truncating an upstream error', async () => {
    const h = harness()
    const longToken = 'private-token-'.repeat(200)
    h.deps.credentials = async () => ({ accessToken: longToken, accountId: upstreamId })
    h.state.response = () => new Response(`upstream echoed ${longToken}`, { status: 503 })
    let message = ''
    try { await activateCodexAccount(h.opts, h.deps) } catch (error) { message = String(error) }
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain('private-token-')
  })
  test('stream cleanup failure keeps already-confirmed usage and its diagnostic', async () => {
    const h = harness()
    h.state.response = () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(terminal())}\n\n`))
    }, cancel() { throw new Error('stream close rejected') } }))
    await expect(activateCodexAccount(h.opts, h.deps)).rejects.toThrow('请求已成功；stream close rejected')
    expect(h.calls).toContain('used')
    expect(h.posts).toHaveLength(1)
    expect(h.calls.at(-1)).toBe('close')
  })
  test('abort before send closes the control connection without inference', async () => {
    const h = harness()
    h.opts.eligible = () => { h.controller.abort(new Error('stop')); return false }
    expect(await activateCodexAccount(h.opts, h.deps)).toBe('skipped')
    expect(h.posts).toHaveLength(0); expect(h.calls.at(-1)).toBe('close')
  })
})

test('unclosed native activation clients remain owned until real exit and block new processes', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    import { EventEmitter } from 'node:events'
    const original = await import('./src/usage')
    const clients = []
    class Client extends EventEmitter {
      constructor() { super(); this.canClose = false; clients.push(this) }
      async initialize() { throw new Error('initialize rejected') }
      async request() { throw new Error('unexpected request') }
      async close() { if (!this.canClose) throw new Error('exit unconfirmed'); this.emit('exit') }
    }
    mock.module('./src/usage', () => ({ ...original, AppServerOnce: Client }))
    const { activateCodexAccount, closeCodexActivationClients } = await import('./src/codex-activation-request')
    const opts = { accountId: 'test', identity: 'test', effort: 'low', signal: new AbortController().signal,
      eligible: () => true, used: () => assert.fail('must not generate') }
    await assert.rejects(activateCodexAccount(opts), /initialize rejected.*exit unconfirmed/)
    await assert.rejects(activateCodexAccount(opts), /尚未退出/)
    assert.equal(clients.length, 1)
    await assert.rejects(closeCodexActivationClients(), /未全部退出/)
    clients[0].canClose = true
    await closeCodexActivationClients()
    await assert.rejects(activateCodexAccount(opts), /initialize rejected/)
    assert.equal(clients.length, 2)
    clients[1].canClose = true
    await closeCodexActivationClients()
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})

describe('activation response and model selection', () => {
  test('chunked SSE with UTF-8, comments and multiple data lines works', async () => {
    expect(await readActivationResponse(sse([{ type: 'response.output_text.delta', delta: '你好' }, terminal()], true))).toBe(11)
    expect(await readActivationResponse(new Response(': keepalive\n\ndata: {"type":"response.completed",\ndata: "response":{"status":"completed","usage":{"total_tokens":2}}}\n\n'))).toBe(2)
  })
  test('missing terminal, failed terminal or missing real usage never counts as successful activation', async () => {
    for (const events of [[], ['[DONE]'], [terminal({ usage: null })], [terminal({ usage: { total_tokens: 0 } })],
      [terminal({ status: 'failed' })], [{ type: 'response.failed', response: { error: { message: 'model unavailable' } } }], ['invalid-json']]) {
      await expect(readActivationResponse(sse(events))).rejects.toThrow()
    }
  })
  test('choose the lowest supported effort, even for a locally hidden model, without substituting models', () => {
    const model = { model: CODEX_ACTIVATION_MODEL, display: '', defaultEffort: 'max', efforts: ['max', 'low', 'medium'] }
    const source = { kind: 'codex-subscription', enabled: true, models: [], modelCatalogState: { status: 'ready' },
      modelSelection: { availableModels: [model] } } as unknown as TokenSource
    expect(activationEffort(source)).toBe('low')
    model.efforts.push('none'); expect(activationEffort(source)).toBe('none')
    expect(activationBody('none').reasoning.effort).toBe('none')
    model.model = 'gpt-6-astra'; expect(() => activationEffort(source)).toThrow('gpt-6-luna')
    expect(() => activationEffort(undefined)).toThrow('MISS')
  })
  test('a displayed zero and a rounded 7.0d are insufficient; the exact full primary week is required', () => {
    const fresh = snapshotFromReadResponse(rawUsage())
    if (fresh.state !== 'ok') throw new Error('invalid fixture')
    expect(isUnusedMainWeek(fresh)).toBe(true)
    fresh.weekly!.percent = 0.00001; expect(isUnusedMainWeek(fresh)).toBe(false)
    fresh.weekly!.percent = 0; fresh.weekly!.resetsAt = new Date(fresh.weekly!.resetsAt!.getTime() - 1000)
    expect(isUnusedMainWeek(fresh)).toBe(false)
  })
})
