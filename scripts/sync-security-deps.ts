/** 消费者不会继承 overrides：同步普通安全依赖，Agent 独立自动更新。 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const manifestPath = join(root, 'package.json')
const original = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(original)
for (const [name, version] of Object.entries(manifest.overrides)) {
  assert.equal(typeof version, 'string', `安全依赖必须使用显式版本：${name}`)
  manifest.dependencies[name] = version
}
manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).sort(([a], [b]) => a.localeCompare(b)))
const output = JSON.stringify(manifest, null, 2) + '\n'
if (process.argv.includes('--check')) assert.equal(output, original, '请运行 bun scripts/sync-security-deps.ts 并同步 bun.lock')
else writeFileSync(manifestPath, output)
console.log(`${process.argv.includes('--check') ? '已核验' : '已同步'} ${Object.keys(manifest.overrides).length} 个安全依赖`)
