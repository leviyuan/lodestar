import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishVerifiedPackage, readNpmPackageLifecycle } from './publish-verified-package.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-publish-'))
  roots.push(root)
  const data = Buffer.from('synthetic-package-bytes')
  const integrity = `sha512-${createHash('sha512').update(data).digest('base64')}`
  const filename = 'leviyuan-lodestar-1.2.3.tgz'
  writeFileSync(join(root, filename), data)
  const manifest = join(root, 'pack.json')
  writeFileSync(manifest, JSON.stringify([{ name: '@leviyuan/lodestar', version: '1.2.3', filename, integrity }]))
  return { root, manifest, integrity, filename }
}
const missing = { status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }), stderr: '' }
const ok = { status: 0, stdout: '', stderr: '' }

test.each(['https://registry.npmjs.org', 'https://npm.pkg.github.com'])('publishes and verifies exactly the audited bytes to %s', async registry => {
  const f = fixture(), calls: string[][] = []
  let lifecycleReads = 0
  const responses = [missing, ok, { ...ok, stdout: JSON.stringify(f.integrity) }]
  await publishVerifiedPackage(f.manifest, f.root, registry, (_cmd: string, args: string[]) => {
    calls.push(args); return responses.shift()!
  }, { readLifecycle: async () => { lifecycleReads++; return null } })
  expect(calls).toHaveLength(3)
  expect(calls.filter(args => args[0] === 'view').every(args => args.includes('--prefer-online'))).toBe(true)
  expect(lifecycleReads).toBe(registry === 'https://registry.npmjs.org' ? 1 : 0)
  expect(calls[1]).toEqual(['publish', join(f.root, f.filename), `--registry=${registry}`, '--access=public', '--ignore-scripts'])
})
test('a repeated run verifies an identical upload without republishing or requiring lifecycle access', async () => {
  const f = fixture(), calls: string[][] = []
  await publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', (_cmd: string, args: string[]) => {
    calls.push(args); return { ...ok, stdout: JSON.stringify(f.integrity) }
  }, { readLifecycle: async () => { throw new Error('must not query lifecycle') } })
  expect(calls).toHaveLength(1)
})
test('an existing different package blocks publishing', async () => {
  const f = fixture()
  await expect(publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', () => ({ ...ok, stdout: '"different"' })))
    .rejects.toThrow('远端已存在不同内容')
})
test.each(['E401', 'E403', 'E503'])('remote %s is not mistaken for a missing version', async code => {
  const f = fixture(), calls: string[][] = []
  await expect(publishVerifiedPackage(f.manifest, f.root, 'https://npm.pkg.github.com', (_cmd: string, args: string[]) => {
    calls.push(args); return { status: 1, stdout: JSON.stringify({ error: { code } }), stderr: code }
  })).rejects.toThrow('未尝试发布')
  expect(calls).toHaveLength(1)
})
test('an uncertain upload is reported without a second publish attempt', async () => {
  const f = fixture(), calls: string[][] = []
  await expect(publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', (_cmd: string, args: string[]) => {
    calls.push(args); return calls.length === 1 ? missing : { status: 1, stdout: '', stderr: 'connection reset' }
  }, { readLifecycle: async () => null })).rejects.toThrow('不自动重试')
  expect(calls).toHaveLength(2)
})
test('local artifact tampering and unapproved destinations are rejected before any command', async () => {
  const f = fixture()
  let count = 0
  const execute = () => { count++; return ok }
  writeFileSync(join(f.root, f.filename), 'changed')
  await expect(publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', execute)).rejects.toThrow('验收清单不一致')
  await expect(publishVerifiedPackage(f.manifest, f.root, 'https://example.test', execute)).rejects.toThrow('不支持的包仓库')
  expect(count).toBe(0)
})

function waiting() {
  let clock = 0
  const delays: number[] = []
  return { delays, now: () => clock, waitTimeoutMs: 30, pollIntervalMs: 10,
    sleep: async (milliseconds: number) => { delays.push(milliseconds); clock += milliseconds } }
}

test.each(['validating', 'published'])('an existing npm %s version is only read until matching metadata appears', async status => {
  const f = fixture(), calls: string[][] = [], timer = waiting()
  const responses = [missing, missing, { ...ok, stdout: JSON.stringify(f.integrity) }]
  await publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', (_cmd, args) => {
    calls.push(args); return responses.shift()!
  }, { ...timer, readLifecycle: async () => status })
  expect(calls.every(args => args[0] === 'view')).toBe(true)
  expect(timer.delays).toEqual([10])
})

test('a single accepted upload waits through validation and transient metadata absence without uploading again', async () => {
  const f = fixture(), calls: string[][] = [], timer = waiting()
  const responses = [missing, ok, missing, missing, { ...ok, stdout: JSON.stringify(f.integrity) }]
  const lifecycle: Array<string | null> = [null, 'validating', 'published']
  await publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', (_cmd, args) => {
    calls.push(args); return responses.shift()!
  }, { ...timer, readLifecycle: async () => lifecycle.shift()! })
  expect(calls.filter(args => args[0] === 'publish')).toHaveLength(1)
  expect(timer.delays).toEqual([10, 10])
})

test('lifecycle 404 after acceptance never authorizes a second upload', async () => {
  const f = fixture(), calls: string[][] = [], timer = waiting()
  const responses = [missing, ok, missing, { ...ok, stdout: JSON.stringify(f.integrity) }]
  await publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', (_cmd, args) => {
    calls.push(args); return responses.shift()!
  }, { ...timer, readLifecycle: async () => null })
  expect(calls.filter(args => args[0] === 'publish')).toHaveLength(1)
})

test.each(['unknown', 'manual', 'rejected'])('npm lifecycle %s blocks instead of republishing or guessing approval', async status => {
  const f = fixture(), calls: string[][] = []
  await expect(publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', (_cmd, args) => {
    calls.push(args); return missing
  }, { readLifecycle: async () => status })).rejects.toThrow(`状态为 ${status}`)
  expect(calls.map(args => args[0])).toEqual(['view'])
})

test('a version rejected after an accepted upload stops without a second publish', async () => {
  const f = fixture(), calls: string[][] = []
  const responses = [missing, ok, missing]
  const lifecycle: Array<string | null> = [null, 'rejected']
  await expect(publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', (_cmd, args) => {
    calls.push(args); return responses.shift()!
  }, { readLifecycle: async () => lifecycle.shift()! })).rejects.toThrow('需要人工处理')
  expect(calls.filter(args => args[0] === 'publish')).toHaveLength(1)
})

test('waiting has a bounded deadline and keeps each metadata read within its remaining budget', async () => {
  const f = fixture(), calls: Array<{ args: string[]; timeout: number }> = [], timer = waiting()
  await expect(publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', (_cmd, args, options) => {
    calls.push({ args, timeout: options.timeout }); return missing
  }, { ...timer, readLifecycle: async () => 'validating' })).rejects.toThrow('超过 30ms')
  expect(timer.delays).toEqual([10, 10, 10])
  expect(calls.map(call => call.timeout)).toEqual([120_000, 30, 20, 10])
  expect(calls.every(call => call.args[0] === 'view')).toBe(true)
})

test('metadata appearing after validation must still match the original audited artifact', async () => {
  const f = fixture(), calls: string[][] = []
  const responses = [missing, { ...ok, stdout: '"wrong-integrity"' }]
  await expect(publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', (_cmd, args) => {
    calls.push(args); return responses.shift()!
  }, { readLifecycle: async () => 'validating' })).rejects.toThrow('完整性不一致')
  expect(calls.every(args => args[0] === 'view')).toBe(true)
})

test('official lifecycle lookup is an authenticated GET to the fixed registry and refuses redirects', async () => {
  let count = 0
  const status = await readNpmPackageLifecycle('@leviyuan/lodestar', '1.2.3', { token: 'synthetic-token',
    fetch: async (url, options) => {
      count++
      expect(url).toBe('https://registry.npmjs.org/-/package/@leviyuan%2Flodestar/version/1.2.3/status')
      expect(options.method).toBe('GET'); expect(options.redirect).toBe('error')
      expect(new Headers(options.headers).get('Authorization')).toBe('Bearer synthetic-token')
      expect(options.signal).toBeInstanceOf(AbortSignal)
      return new Response(JSON.stringify({ packageName: '@leviyuan/lodestar', version: '1.2.3', status: 'validating' }))
    } })
  expect(status).toBe('validating'); expect(count).toBe(1)
  expect(await readNpmPackageLifecycle('@leviyuan/lodestar', '1.2.3', { token: 'synthetic-token',
    fetch: async () => new Response('', { status: 404 }) })).toBeNull()
})

test.each([401, 403, 429, 503])('lifecycle HTTP %s is a visible failure, not permission to upload', async status => {
  await expect(readNpmPackageLifecycle('@leviyuan/lodestar', '1.2.3', { token: 'synthetic-token',
    fetch: async () => new Response('private-response-body', { status }) })).rejects.toThrow(`HTTP ${status}`)
  const f = fixture(), calls: string[][] = []
  await expect(publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', (_cmd, args) => {
    calls.push(args); return missing
  }, { readLifecycle: async () => { throw new Error(`HTTP ${status}`) } })).rejects.toThrow(`HTTP ${status}`)
  expect(calls.map(args => args[0])).toEqual(['view'])
})

test('lifecycle timeout and malformed responses are reported without leaking request or response details', async () => {
  await expect(readNpmPackageLifecycle('@leviyuan/lodestar', '1.2.3', { token: 'synthetic-token', timeoutMs: 2,
    fetch: async () => new Promise(() => {}) })).rejects.toThrow('查询超时')
  await expect(readNpmPackageLifecycle('@leviyuan/lodestar', '1.2.3', { token: 'synthetic-token',
    fetch: async () => { throw new Error('Bearer synthetic-token') } })).rejects.toThrow('网络或重定向错误')
  await expect(readNpmPackageLifecycle('@leviyuan/lodestar', '1.2.3', { token: 'synthetic-token',
    fetch: async () => new Response('private-response-body') })).rejects.toThrow('不是有效 JSON')
})
