import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeTranslationTrace, ClaudeTranslationTraceError } from './claude-translation-trace'

let root: string
let directory: string
let workDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-translation-trace-'))
  directory = join(root, 'traces')
  workDir = join(root, 'project')
  mkdirSync(workDir)
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function trace(): ClaudeTranslationTrace {
  return new ClaudeTranslationTrace({ directory, workDir, sourceId: 'claude-sub' })
}

function records(value: ClaudeTranslationTrace): any[] {
  return readFileSync(value.filePath, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
}

const request = (requestId = 'request-1') => ({ event: 'request' as const, requestId, direction: 'en' as const,
  endpoint: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
  body: { model: 'glm-5.3-flash', messages: [{ role: 'system', content: 'Translate only.' },
    { role: 'user', content: JSON.stringify({ original_source: '电荷', conversation_context: [] }) }] } })

describe('private complete Claude translation traces', () => {
  test('is lazy and preserves complete request, raw HTTP response and result without truncation', () => {
    const value = trace()
    expect(existsSync(directory)).toBe(false)
    const longText = '上下文与译文\n'.repeat(30_000)
    const body = { ...request().body, source: longText, context: [{ user: '电荷', translation: 'charge' }] }
    const raw = JSON.stringify({ model: 'glm-5.3-flash', choices: [{ message: { content: longText } }] }) + '\n'
    value.append({ ...request(), body })
    value.append({ event: 'response', requestId: 'request-1', status: 200, bodyText: raw })
    value.append({ event: 'result', requestId: 'request-1', text: longText })
    const rows = records(value)
    expect(rows.map(row => row.event)).toEqual(['request', 'response', 'result'])
    expect(rows[0].body).toEqual(body)
    expect(rows[1]).toMatchObject({ status: 200, bodyText: raw })
    expect(rows[2].text).toBe(longText)
    for (const row of rows) {
      expect(row).toMatchObject({ version: 1, traceId: value.traceId, requestId: 'request-1',
        workDir, sourceId: 'claude-sub', sessionId: null })
      expect(Number.isNaN(Date.parse(row.time))).toBe(false)
    }
    expect(readdirSync(directory)).toEqual([`${value.traceId}.jsonl`])
  })

  test('binds pending records to one native session and retains batch fields in the same trace', () => {
    const value = trace()
    value.append(request())
    value.bindSession('native-session')
    value.bindSession('native-session')
    value.append({ event: 'request', requestId: 'batch-2', direction: 'zh', body: { fields: ['Charge', 'Current'] } })
    value.append({ event: 'result', requestId: 'batch-2', text: '电荷\n电流', fields: ['电荷', '电流'] })
    const rows = records(value)
    expect(rows.map(row => row.event)).toEqual(['request', 'session_bound', 'request', 'result'])
    expect(rows[0].sessionId).toBeNull()
    expect(rows[1]).toMatchObject({ requestId: null, sessionId: 'native-session' })
    expect(rows[3]).toMatchObject({ sessionId: 'native-session', requestId: 'batch-2', fields: ['电荷', '电流'] })
    expect(() => value.bindSession('other-session')).toThrow('session mismatch')
    expect(records(value)).toHaveLength(4)
    expect(trace().traceId).not.toBe(value.traceId)
  })

  test('records complete HTTP failures, rejected translations and cancellation without inventing success', () => {
    const value = trace()
    value.bindSession('native-session')
    value.append(request('http-failure'))
    value.append({ event: 'response', requestId: 'http-failure', status: 503, bodyText: 'upstream unavailable\nraw details' })
    value.append({ event: 'error', requestId: 'http-failure', message: 'HTTP 503: upstream unavailable', cancelled: false })
    value.append(request('rejected'))
    value.append({ event: 'response', requestId: 'rejected', status: 200, bodyText: '[[TRANSLATION_REJECT]] Contains a private key.' })
    value.append({ event: 'error', requestId: 'rejected', message: 'GLM rejected: Contains a private key.' })
    value.append(request('cancelled'))
    value.append({ event: 'error', requestId: 'cancelled', message: 'User stopped the task', cancelled: true })
    const rows = records(value)
    expect(rows.filter(row => row.event === 'result')).toEqual([])
    expect(rows.find(row => row.requestId === 'http-failure' && row.event === 'response').bodyText)
      .toBe('upstream unavailable\nraw details')
    expect(rows.at(-1)).toMatchObject({ event: 'error', requestId: 'cancelled', message: 'User stopped the task', cancelled: true })
  })

  test('redacts exact credentials throughout requests, responses and errors without logging request headers', () => {
    const value = trace()
    const secrets = ['sk-exact-secret-value', 'key-with-"quotes"\\slash']
    const original = { messages: [{ role: 'system', content: `Never expose ${secrets[0]}` },
      { role: 'user', content: JSON.stringify({ source: secrets[1], context: [secrets[0]] }) }],
      Authorization: 'Bearer HEADER_ONLY_SECRET', nested: { api_key: 'NESTED_KEY_SECRET', keep: 'src/配置.ts https://example.com' },
      [secrets[0]!]: 'credential used as an object key' }
    value.append({ ...request(), body: original, headers: { Authorization: 'DO_NOT_COPY_HEADERS' } } as any, secrets)
    value.append({ event: 'response', requestId: 'request-1', status: 401,
      bodyText: JSON.stringify({ error: `Invalid ${secrets[0]} / ${secrets[1]}` }) }, secrets)
    value.append({ event: 'error', requestId: 'request-1', message: `Failed: ${secrets[0]} / ${secrets[1]}` }, secrets)
    const raw = readFileSync(value.filePath, 'utf8')
    for (const secret of [...secrets, 'HEADER_ONLY_SECRET', 'NESTED_KEY_SECRET', 'DO_NOT_COPY_HEADERS']) {
      expect(raw).not.toContain(secret)
      expect(raw).not.toContain(JSON.stringify(secret).slice(1, -1))
    }
    const rows = records(value)
    expect(rows[0]).not.toHaveProperty('headers')
    expect(rows[0].body.Authorization).toBe('[REDACTED]')
    expect(rows[0].body.nested.api_key).toBe('[REDACTED]')
    expect(rows[0].body.nested.keep).toBe('src/配置.ts https://example.com')
    expect(rows[0].body['[REDACTED]']).toBe('credential used as an object key')
    expect(original.Authorization).toBe('Bearer HEADER_ONLY_SECRET')
  })

  test('uses private permissions without accepting or silently fixing existing public paths', () => {
    const value = trace()
    value.append(request())
    expect(statSync(directory).mode & 0o7777).toBe(0o700)
    expect(statSync(value.filePath).mode & 0o7777).toBe(0o600)
    const before = readFileSync(value.filePath, 'utf8')
    chmodSync(value.filePath, 0o644)
    expect(() => value.append({ event: 'result', requestId: 'request-1', text: 'charge' })).toThrow('permissions must be 600')
    expect(statSync(value.filePath).mode & 0o7777).toBe(0o644)
    expect(readFileSync(value.filePath, 'utf8')).toBe(before)

    const another = trace()
    chmodSync(directory, 0o755)
    expect(() => another.append(request())).toThrow('permissions must be 700')
    expect(existsSync(another.filePath)).toBe(false)
    expect(statSync(directory).mode & 0o7777).toBe(0o755)
  })

  test('refuses a symlink trace directory and leaves its target untouched', () => {
    const target = join(root, 'elsewhere')
    mkdirSync(target, { mode: 0o700 })
    symlinkSync(target, directory, 'dir')
    expect(() => trace().append(request())).toThrow('must not be a symlink')
    expect(readdirSync(target)).toEqual([])
  })

  test('first write is exclusive and never overwrites a pre-existing file or symlink', () => {
    mkdirSync(directory, { mode: 0o700 })
    const existing = trace()
    writeFileSync(existing.filePath, 'PRE_EXISTING_DATA', { mode: 0o600 })
    expect(() => existing.append(request())).toThrow(ClaudeTranslationTraceError)
    expect(readFileSync(existing.filePath, 'utf8')).toBe('PRE_EXISTING_DATA')
    const linked = trace()
    symlinkSync(existing.filePath, linked.filePath)
    expect(() => linked.append(request())).toThrow(ClaudeTranslationTraceError)
    expect(readFileSync(existing.filePath, 'utf8')).toBe('PRE_EXISTING_DATA')
  })

  test('append rejects deleted, replaced and hard-linked files instead of recreating or redirecting evidence', () => {
    const deleted = trace()
    deleted.append(request())
    rmSync(deleted.filePath)
    expect(() => deleted.append({ event: 'result', requestId: 'request-1', text: 'charge' })).toThrow('ENOENT')
    expect(existsSync(deleted.filePath)).toBe(false)

    const replaced = trace()
    replaced.append(request())
    renameSync(replaced.filePath, `${replaced.filePath}.original`)
    writeFileSync(replaced.filePath, 'replacement', { mode: 0o600 })
    expect(() => replaced.append({ event: 'result', requestId: 'request-1', text: 'charge' })).toThrow('Trace file changed')
    expect(readFileSync(replaced.filePath, 'utf8')).toBe('replacement')

    const hardLinked = trace()
    hardLinked.append(request())
    linkSync(hardLinked.filePath, `${hardLinked.filePath}.link`)
    expect(() => hardLinked.append({ event: 'result', requestId: 'request-1', text: 'charge' })).toThrow('must not have hard links')
  })

  test('rejects directory replacement and symlink replacement after initialization', () => {
    const value = trace()
    value.append(request())
    const moved = `${directory}.original`
    renameSync(directory, moved)
    symlinkSync(moved, directory, 'dir')
    expect(() => value.append({ event: 'result', requestId: 'request-1', text: 'charge' })).toThrow('must not be a symlink')
    expect(readFileSync(join(moved, `${value.traceId}.jsonl`), 'utf8').trimEnd().split('\n')).toHaveLength(1)
  })

  test('serialization and append failures are synchronous, sticky, and never silently disable logging', () => {
    const value = trace()
    expect(() => value.append({ ...request(), body: { toJSON() { throw null } } })).toThrow('trace write failed: null')
    expect(existsSync(value.filePath)).toBe(false)
    expect(() => value.append(request('later'))).toThrow('trace write failed: null')
    expect(() => value.bindSession('session')).toThrow('trace write failed: null')
    expect(existsSync(value.filePath)).toBe(false)
  })

  test('rejects malformed result/session metadata before writing it', () => {
    const value = trace()
    expect(() => value.bindSession('')).toThrow('sessionId is required')
    expect(() => value.append({ event: 'result', requestId: 'request-1' })).toThrow('requires text or string fields')
    expect(() => value.append({ ...request(), requestId: '' })).toThrow('requestId is required')
    expect(existsSync(directory)).toBe(false)
  })
})

test('continues redacting earlier credentials when later request context contains them', () => {
  const value = trace()
  const oldKey = 'private-old-credential', newKey = 'private-new-credential'
  value.append({ ...request('old'), body: { source: oldKey } }, [oldKey])
  value.append({ ...request('new'), body: { source: newKey, context: `Prior content ${oldKey}` } }, [newKey])
  const raw = readFileSync(value.filePath, 'utf8')
  expect(raw).not.toContain(oldKey)
  expect(raw).not.toContain(newKey)
  expect(records(value)[1].body).toEqual({ source: '[REDACTED]', context: 'Prior content [REDACTED]' })
})
