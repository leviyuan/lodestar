/** Explicit proxy selection for every Lodestar-owned HTTP request, on Bun and Node. */
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { Readable } from 'node:stream'
import nodeFetch from 'node-fetch'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { isLoopback, proxyForUrl } from './network-proxy'

const directHttp = new HttpAgent({ keepAlive: true })
const directHttps = new HttpsAgent({ keepAlive: true })
let bunDirect: import('undici').Agent | undefined

function requestAgent(url: URL, proxy?: string): HttpAgent {
  if (!proxy) return url.protocol === 'https:' ? directHttps : directHttp
  return url.protocol === 'https:' ? new HttpsProxyAgent(proxy) : new HttpProxyAgent(proxy)
}

async function transport(url: URL, init: RequestInit, proxy?: string): Promise<Response> {
  if (typeof Bun !== 'undefined') {
    const key = url.protocol === 'https:' ? 'HTTPS_PROXY' : 'HTTP_PROXY'
    if (!proxy && (process.env[key.toLowerCase()] || process.env[key])) {
      // Bun 1.3.x ignores an empty proxy option and still reads the environment.
      // A direct dispatcher is required for bypasses; it never retries a failed proxy.
      // This optional Bun-only dependency requires Node 18.17, so Node 18.15 uses
      // the node-fetch transport below without loading it.
      const undici = await import('undici')
      bunDirect ??= new undici.Agent()
      return await undici.fetch(url, { ...init, redirect: 'manual', dispatcher: bunDirect } as Parameters<typeof undici.fetch>[1]) as unknown as Response
    }
    return globalThis.fetch(url.href, { ...init, redirect: 'manual', ...(proxy ? { proxy } : {}) })
  }
  // Node's native fetch only reads proxy env on newer, opt-in runtimes. Serialize native
  // FormData/Blob with Request, then use node-fetch's explicit agent on every supported Node.
  const request = new Request(url, { ...init, redirect: 'manual', duplex: 'half' } as RequestInit)
  // Request exposes even fixed-size payloads as streams, so node-fetch cannot
  // infer Content-Length. Node does not frame DELETE streams automatically;
  // explicitly frame unknown-length bodies so the server receives their bytes.
  if (request.body && !request.headers.has('content-length') && !request.headers.has('transfer-encoding')) {
    request.headers.set('transfer-encoding', 'chunked')
  }
  const response = await nodeFetch(url, {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: request.body ? Readable.fromWeb(request.body as unknown as Parameters<typeof Readable.fromWeb>[0]) : undefined,
    signal: request.signal,
    agent: requestAgent(url, proxy),
    redirect: 'manual',
  })
  const body = request.method === 'HEAD' || [204, 205, 304].includes(response.status) || !response.body
    ? null : Readable.toWeb(response.body as Readable) as unknown as ReadableStream<Uint8Array>
  return new Response(body, { status: response.status, statusText: response.statusText, headers: [...response.headers] })
}

async function request(input: string | URL, init: RequestInit, local: boolean, resolve = proxyForUrl): Promise<Response> {
  let url = new URL(input)
  let options: RequestInit = { ...init }
  for (let redirects = 0; ; redirects++) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`network: unsupported URL protocol ${url.protocol}`)
    if (local && !isLoopback(url)) throw new Error('network: local request must remain on loopback')
    options.signal?.throwIfAborted()
    const proxy = local ? undefined : await resolve(url)
    const response = await transport(url, options, proxy)
    const location = response.headers.get('location')
    if (![301, 302, 303, 307, 308].includes(response.status) || !location || init.redirect === 'manual') return response
    await response.body?.cancel()
    if (init.redirect === 'error') throw new Error('network: redirect rejected')
    if (redirects >= 20) throw new Error('network: too many redirects')
    const next = new URL(location, url)
    const headers = new Headers(options.headers)
    if (next.origin !== url.origin) {
      for (const name of ['authorization', 'proxy-authorization', 'cookie', 'host']) headers.delete(name)
    }
    const method = (options.method ?? 'GET').toUpperCase()
    if ((response.status === 303 && method !== 'HEAD') || ([301, 302].includes(response.status) && method === 'POST')) {
      options = { ...options, method: 'GET', body: undefined }
      for (const name of ['content-type', 'content-length', 'content-encoding']) headers.delete(name)
    } else if (options.body instanceof ReadableStream) {
      throw new Error('network: cannot replay a streamed body after redirect')
    }
    options.headers = headers
    url = next
  }
}

export function networkFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return request(input, init, false)
}

/** Isolated policy injection for transport acceptance, without changing the machine or process. */
export function createNetworkFetch(resolve: typeof proxyForUrl) {
  return (input: string | URL, init: RequestInit = {}) => request(input, init, false, resolve)
}

/** Owner-only callbacks/capabilities must never be sent to an external proxy or redirect. */
export function localFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return request(input, init, true)
}
