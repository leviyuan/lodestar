/** Publish an already audited tarball, or verify an identical completed upload on a resumed run. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function publishVerifiedPackage(manifestFile, packageDirectory, registry, execute = spawnSync) {
  assert.ok(['https://registry.npmjs.org', 'https://npm.pkg.github.com'].includes(registry), '不支持的包仓库')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  assert.equal(manifest.length, 1, '必须只有一个已验收发布包')
  const entry = manifest[0]
  assert.equal(entry.name, '@leviyuan/lodestar')
  assert.match(entry.version, /^\d+\.\d+\.\d+$/)
  assert.equal(entry.filename, basename(entry.filename), '发布包文件名不能包含目录')
  const tarball = join(packageDirectory, entry.filename)
  const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
  assert.equal(integrity, entry.integrity, '发布包与验收清单不一致')
  const spec = `${entry.name}@${entry.version}`
  const run = args => {
    const result = execute('npm', args, { encoding: 'utf8', timeout: 120_000, env: process.env })
    if (result.error) throw result.error
    if (result.signal) throw new Error(`npm 命令被终止：${result.signal}`)
    return result
  }
  const inspect = () => run(['view', spec, 'dist.integrity', '--json', `--registry=${registry}`])
  const before = inspect()
  if (before.status === 0) {
    assert.equal(JSON.parse(before.stdout), integrity, '远端已存在不同内容的同版本，拒绝继续发布')
    console.log(`${registry} 已有相同发布包：${spec}`)
    return
  }
  const diagnostic = `${before.stdout}\n${before.stderr}`
  let missing = false
  try { missing = JSON.parse(before.stdout).error?.code === 'E404' } catch {}
  if (!missing) throw new Error(`检查远端版本失败，未尝试发布：${diagnostic}`)
  const published = run(['publish', tarball, `--registry=${registry}`, '--access=public', '--ignore-scripts'])
  if (published.status !== 0) throw new Error(`发布未确认，不自动重试：${published.stdout}\n${published.stderr}`)
  const after = inspect()
  assert.equal(after.status, 0, `发布后的版本查询失败：${after.stderr}`)
  assert.equal(JSON.parse(after.stdout), integrity, '远端发布包完整性不一致')
  console.log(`${registry} 发布并核验成功：${spec}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { publishVerifiedPackage(...process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
