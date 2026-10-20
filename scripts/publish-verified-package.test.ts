import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishVerifiedPackage } from './publish-verified-package.mjs'

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

test.each(['https://registry.npmjs.org', 'https://npm.pkg.github.com'])('publishes and verifies exactly the audited bytes to %s', registry => {
  const f = fixture(), calls: string[][] = []
  const responses = [missing, ok, { ...ok, stdout: JSON.stringify(f.integrity) }]
  publishVerifiedPackage(f.manifest, f.root, registry, (_cmd: string, args: string[]) => {
    calls.push(args); return responses.shift()!
  })
  expect(calls).toHaveLength(3)
  expect(calls[1]).toEqual(['publish', join(f.root, f.filename), `--registry=${registry}`, '--access=public', '--ignore-scripts'])
})
test('a repeated run verifies an identical upload without republishing', () => {
  const f = fixture(), calls: string[][] = []
  publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', (_cmd: string, args: string[]) => {
    calls.push(args); return { ...ok, stdout: JSON.stringify(f.integrity) }
  })
  expect(calls).toHaveLength(1)
})
test('an existing different package blocks publishing', () => {
  const f = fixture()
  expect(() => publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', () => ({ ...ok, stdout: '"different"' })))
    .toThrow('远端已存在不同内容')
})
test.each(['E401', 'E403', 'E503'])('remote %s is not mistaken for a missing version', code => {
  const f = fixture(), calls: string[][] = []
  expect(() => publishVerifiedPackage(f.manifest, f.root, 'https://npm.pkg.github.com', (_cmd: string, args: string[]) => {
    calls.push(args); return { status: 1, stdout: JSON.stringify({ error: { code } }), stderr: code }
  })).toThrow('未尝试发布')
  expect(calls).toHaveLength(1)
})
test('an uncertain upload is reported without a second publish attempt', () => {
  const f = fixture(), calls: string[][] = []
  expect(() => publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', (_cmd: string, args: string[]) => {
    calls.push(args); return calls.length === 1 ? missing : { status: 1, stdout: '', stderr: 'connection reset' }
  })).toThrow('不自动重试')
  expect(calls).toHaveLength(2)
})
test('local artifact tampering and unapproved destinations are rejected before any command', () => {
  const f = fixture()
  let count = 0
  const execute = () => { count++; return ok }
  writeFileSync(join(f.root, f.filename), 'changed')
  expect(() => publishVerifiedPackage(f.manifest, f.root, 'https://registry.npmjs.org', execute)).toThrow('验收清单不一致')
  expect(() => publishVerifiedPackage(f.manifest, f.root, 'https://example.test', execute)).toThrow('不支持的包仓库')
  expect(count).toBe(0)
})
