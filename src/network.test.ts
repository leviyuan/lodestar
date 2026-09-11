import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { key, cert } from './network-test-fixture'

const root = mkdtempSync(join(tmpdir(), 'lodestar-network-'))
const worker = join(root, 'worker.mjs')
const ca = join(root, 'ca.pem')
const sockets = new Set<Socket>()
const proxyRequests: Array<{ url: string; auth?: string }> = []
const origins: Array<{ method?: string; auth?: string; body: string; type?: string }> = []
let directUrl: string
let proxyUrl: string

async function respond(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  let body = ''
  for await (const chunk of req) body += chunk.toString()
  origins.push({ method: req.method, auth: req.headers.authorization, body, type: req.headers['content-type'] })
  if (req.url === '/escape') { res.writeHead(302, { location: 'https://network.invalid/escaped' }); res.end(); return }
  res.setHeader('content-type', 'application/json')
  if (req.url?.includes('/models/user')) res.end(JSON.stringify({ data: [{ id: 'vendor/model', name: 'Test model',
    architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'], context_length: 4096 }] }))
  else if (req.url?.includes('/credits')) res.end(JSON.stringify({ data: { total_credits: 10, total_usage: 2 } }))
  else res.end(JSON.stringify({ ok: true, body, method: req.method, auth: req.headers.authorization ?? null }))
}

const direct = createServer((req, res) => { void respond(req, res) })
const tls = createTlsServer({ key, cert }, (req, res) => { void respond(req, res) })
const proxy = createServer((req, res) => {
  proxyRequests.push({ url: req.url!, auth: req.headers['proxy-authorization'] })
  if (req.url?.includes('/redirect')) { res.writeHead(302, { location: `${directUrl}/final` }); res.end(); return }
  if (req.url?.includes('/slow')) return
  void respond(req, res)
})

beforeAll(async () => {
  writeFileSync(ca, cert)
  for (const server of [direct, tls, proxy]) {
    server.on('connection', socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => {})
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  }
  directUrl = `http://127.0.0.1:${(direct.address() as import('node:net').AddressInfo).port}`
  proxyUrl = `http://127.0.0.1:${(proxy.address() as import('node:net').AddressInfo).port}`
  proxy.on('connect', (req, socket, head) => {
    proxyRequests.push({ url: req.url!, auth: req.headers['proxy-authorization'] })
    if (req.url !== 'network.invalid:443') { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return }
    const upstream = connect((tls.address() as import('node:net').AddressInfo).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    sockets.add(upstream)
    upstream.on('close', () => sockets.delete(upstream))
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  const entry = join(root, 'entry.ts')
  writeFileSync(entry, `
    import { networkFetch, localFetch, createNetworkFetch } from ${JSON.stringify(join(import.meta.dir, 'network.ts'))}
    import { createProxyResolver } from ${JSON.stringify(join(import.meta.dir, 'network-proxy.ts'))}
    import { fetchOpenRouterModels, fetchOpenRouterUsage } from ${JSON.stringify(join(import.meta.dir, 'token-source-openrouter.ts'))}
    const args = JSON.parse(process.argv[2])
    try {
      if (args.kind === 'openrouter') {
        const models = await fetchOpenRouterModels('https://network.invalid/api', 'fixture-api-key')
        const usage = await fetchOpenRouterUsage('https://network.invalid/api', 'fixture-api-key')
        console.log(JSON.stringify({ models: models.map(m => m.model), remaining: usage.balance?.remaining }))
      } else {
        const fetcher = args.kind === 'local' ? localFetch : args.kind === 'system'
          ? createNetworkFetch(createProxyResolver(async () => ({ http: args.proxy, https: args.proxy }), {})) : networkFetch
        let body
        if (args.kind === 'upload') { body = new FormData(); body.append('file', new Blob(['fixture-file-content']), 'fixture.txt') }
        const res = await fetcher(args.url, { method: body || args.post ? 'POST' : 'GET', body: body ?? args.post,
          headers: { authorization: 'Bearer private-fixture' }, signal: AbortSignal.timeout(args.timeout ?? 3000) })
        console.log(JSON.stringify({ status: res.status, value: await res.json() }))
      }
    } catch (error) { console.log(JSON.stringify({ error: error.message, code: error.code ?? error.cause?.code })); }
  `)
  const build = await Bun.build({ entrypoints: [entry], target: 'node', minify: false, outdir: root, naming: 'worker.mjs' })
  expect(build.success, build.logs.map(String).join('\n')).toBe(true)
})

afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  await Promise.all([direct, tls, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  rmSync(root, { recursive: true, force: true })
})

async function run(runtime: string, args: object, extraEnv: Record<string, string> = {}) {
  proxyRequests.length = 0
  origins.length = 0
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/proxy/i.test(name) || name === 'NODE_OPTIONS' || name === 'NODE_TLS_REJECT_UNAUTHORIZED') delete env[name]
  const binary = runtime === 'node' ? process.env.LODESTAR_TEST_NODE || runtime : runtime
  const proc = Bun.spawn([binary, worker, JSON.stringify(args)], { cwd: root,
    env: { ...env, NODE_EXTRA_CA_CERTS: ca, ...extraEnv }, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect(code, stderr).toBe(0)
  const line = stdout.trim().split('\n').reverse().find(value => value.startsWith('{'))
  expect(line, `${stdout}\n${stderr}`).toBeDefined()
  return JSON.parse(line!)
}

for (const runtime of ['bun', 'node']) describe(`${runtime} real outbound proxy transport`, () => {
  test('OpenRouter account models and credits traverse HTTPS CONNECT with their real source implementation', async () => {
    const result = await run(runtime, { kind: 'openrouter' }, { HTTPS_PROXY: proxyUrl })
    expect(result).toEqual({ models: ['vendor/model'], remaining: 8 })
    expect(proxyRequests.length).toBeGreaterThan(0)
    expect(proxyRequests.every(request => request.url === 'network.invalid:443')).toBe(true)
    expect(origins.map(request => request.auth)).toEqual(['Bearer fixture-api-key', 'Bearer fixture-api-key'])
  })

  test('discovered system proxy carries both HTTP and HTTPS without proxy environment variables', async () => {
    for (const scheme of ['http', 'https']) {
      const result = await run(runtime, { kind: 'system', proxy: proxyUrl, url: `${scheme}://network.invalid/system` })
      expect(result.status).toBe(200)
      expect(proxyRequests).toHaveLength(1)
    }
  })

  test('ALL_PROXY and encoded proxy credentials are honored', async () => {
    const address = new URL(proxyUrl)
    address.username = 'fixture-user'; address.password = 'fixture:p@ss'
    const result = await run(runtime, { url: 'https://network.invalid/auth' }, { ALL_PROXY: address.href })
    expect(result.status).toBe(200)
    expect(proxyRequests[0]?.auth).toBe(`Basic ${Buffer.from('fixture-user:fixture:p@ss').toString('base64')}`)
  })

  test('native FormData file uploads survive the proxy transport', async () => {
    const result = await run(runtime, { kind: 'upload', url: 'https://network.invalid/upload' }, { HTTPS_PROXY: proxyUrl })
    expect(result.status).toBe(200)
    expect(origins[0]?.type).toContain('multipart/form-data; boundary=')
    expect(origins[0]?.body).toContain('filename="fixture.txt"')
    expect(origins[0]?.body).toContain('fixture-file-content')
  })

  test('redirect re-evaluates bypass and strips credentials before reaching another origin', async () => {
    const result = await run(runtime, { url: 'http://network.invalid/redirect', post: 'private-body' }, { HTTP_PROXY: proxyUrl })
    expect(result.value).toMatchObject({ ok: true, auth: null, method: 'GET', body: '' })
    expect(proxyRequests).toHaveLength(1)
  })

  test('local capability requests stay direct even when native Node env proxy support is enabled', async () => {
    const result = await run(runtime, { kind: 'local', url: directUrl }, { HTTP_PROXY: proxyUrl, NODE_USE_ENV_PROXY: '1' })
    expect(result.status).toBe(200)
    expect(proxyRequests).toHaveLength(0)
    expect(origins[0]?.auth).toBe('Bearer private-fixture')
    const escaped = await run(runtime, { kind: 'local', url: `${directUrl}/escape` }, { HTTPS_PROXY: proxyUrl })
    expect(escaped.error).toContain('must remain on loopback')
    expect(proxyRequests).toHaveLength(0)
  })

  test('proxy failure, invalid configuration and abort remain errors without direct retry', async () => {
    const failed = await run(runtime, { url: 'https://network.invalid/fail' }, { HTTPS_PROXY: 'http://127.0.0.1:1' })
    expect(failed.error).toBeDefined()
    expect(origins).toHaveLength(0)
    const invalid = await run(runtime, { url: 'https://network.invalid/fail' }, { HTTPS_PROXY: 'socks5://user:secret@127.0.0.1:1080' })
    expect(invalid.error).toContain('HTTP(S)')
    expect(invalid.error).not.toContain('secret')
    const aborted = await run(runtime, { url: 'http://network.invalid/slow', timeout: 100 }, { HTTP_PROXY: proxyUrl })
    expect(aborted.error).toBeDefined()
    expect(proxyRequests).toHaveLength(1)
  })
})
