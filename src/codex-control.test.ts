import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { AppServerOnce } from './usage'

test('server requests cannot masquerade as a matching account/read response', () => {
  const app: any = Object.create(AppServerOnce.prototype)
  EventEmitter.call(app)
  const writes: any[] = []
  const results: any[] = []
  const notifications: string[] = []
  app.buf = ''; app.decoder = new StringDecoder('utf8')
  app.proc = { stdin: { write: (value: string) => writes.push(JSON.parse(value)) } }
  const timer = setTimeout(() => {}, 1000)
  app.pending = new Map([[7, { resolve: (value: any) => results.push(value), reject: () => {}, method: 'account/read', timer }]])
  app.on('notification', (method: string) => notifications.push(method))
  try {
    app.onStdout(Buffer.from(JSON.stringify({ id: 7, method: 'attestation/generate', params: {} }) + '\n'))
    expect(results).toEqual([])
    expect(app.pending.has(7)).toBe(true)
    expect(writes[0]).toMatchObject({ id: 7, error: { code: -32601 } })
    app.onStdout(Buffer.from(JSON.stringify({ method: 'account/updated', params: { authMode: 'chatgpt' } }) + '\n'))
    app.onStdout(Buffer.from(JSON.stringify({ id: 7, result: { account: { type: 'chatgpt', planType: 'plus' } } }) + '\n'))
    expect(results).toEqual([{ account: { type: 'chatgpt', planType: 'plus' } }])
    expect(notifications).toEqual(['account/updated'])
    expect(app.pending.has(7)).toBe(false)
  } finally { clearTimeout(timer) }
})

test('incomplete RPC frames produce a protocol error instead of an undefined successful result', () => {
  const app: any = Object.create(AppServerOnce.prototype)
  EventEmitter.call(app)
  app.buf = ''; app.decoder = new StringDecoder('utf8'); app.pending = new Map()
  const errors: Error[] = []
  app.on('protocolError', (error: Error) => errors.push(error))
  app.onStdout(Buffer.from('null\n{"id":1}\nnot json\n'))
  expect(errors).toHaveLength(3)
})
