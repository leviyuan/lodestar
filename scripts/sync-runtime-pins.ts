/** 从 Bun 已锁定的版本生成 npm 消费者也会遵循的 DSH/安全依赖声明。 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const root = join(import.meta.dir, '..')
const manifestPath = join(root, 'package.json')
const original = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(original)
const parsed = ts.parseConfigFileTextToJson('bun.lock', readFileSync(join(root, 'bun.lock'), 'utf8'))
if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'))
const expected = manifest.dependencies['@deepseek-ai/dsh']
const pins = new Map<string, string>()
for (const entry of Object.values(parsed.config.packages) as any[]) {
  const spec = entry[0] as string
  const split = spec.lastIndexOf('@')
  const name = spec.slice(0, split)
  const version = spec.slice(split + 1)
  if (!name.startsWith('@deepseek-ai/dsh')) continue
  assert.equal(version, expected, `DSH 运行时版本混用：${spec}`)
  pins.set(name, version)
}
assert.ok(pins.size > 0, 'Bun 锁文件未包含 DSH 运行时')
for (const name of Object.keys(manifest.dependencies)) {
  if (name.startsWith('@deepseek-ai/dsh')) delete manifest.dependencies[name]
}
for (const [name, version] of pins) manifest.dependencies[name] = version
for (const [name, version] of Object.entries(manifest.overrides)) {
  assert.equal(typeof version, 'string', `安全依赖必须使用显式版本：${name}`)
  manifest.dependencies[name] = version
}
manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).sort(([a], [b]) => a.localeCompare(b)))
const output = JSON.stringify(manifest, null, 2) + '\n'
if (process.argv.includes('--check')) assert.equal(output, original, '请运行 bun scripts/sync-runtime-pins.ts 并同步 bun.lock')
else writeFileSync(manifestPath, output)
console.log(`${process.argv.includes('--check') ? '已核验' : '已同步'} ${pins.size} 个 DSH 运行时包及 ${Object.keys(manifest.overrides).length} 个安全依赖的精确版本`)
