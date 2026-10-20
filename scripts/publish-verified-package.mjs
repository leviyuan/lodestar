/** Publish an already audited tarball, or verify an identical completed upload on a resumed run. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const NPM_REGISTRY = 'https://registry.npmjs.org'
class LifecycleQueryError extends Error {}
const redact = value => {
  const text = String(value)
  const token = process.env.NODE_AUTH_TOKEN?.trim()
  return token ? text.replaceAll(token, '[REDACTED]') : text
}

/** Official npm lifecycle read. A 404 is deliberately ambiguous: missing version or no read access. */
export async function readNpmPackageLifecycle(packageName, version, options = {}) {
  const token = (options.token ?? process.env.NODE_AUTH_TOKEN)?.trim()
  if (!token) throw new LifecycleQueryError('缺少 NODE_AUTH_TOKEN，无法确认 npm 生命周期；未继续发布')
  const timeoutMs = options.timeoutMs ?? 30_000
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, '生命周期查询超时必须为正数')
  const controller = new AbortController()
  let timer
  const read = async () => {
    const escapedName = encodeURIComponent(packageName).replace(/^%40/, '@')
    const response = await (options.fetch ?? fetch)(`${NPM_REGISTRY}/-/package/${escapedName}/version/${encodeURIComponent(version)}/status`, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Cache-Control': 'no-cache' },
    })
    if (response.status === 404) return null
    if (response.status !== 200) throw new LifecycleQueryError(`npm 生命周期查询返回 HTTP ${response.status}，已停止；不会据此再次上传`)
    let value
    try { value = await response.json() }
    catch { throw new LifecycleQueryError('npm 生命周期响应不是有效 JSON，已停止') }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.status !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.status)
      || value.packageName !== undefined && value.packageName !== packageName
      || value.version !== undefined && value.version !== version) {
      throw new LifecycleQueryError('npm 生命周期响应缺失状态或指向其他版本，已停止')
    }
    return value.status
  }
  try {
    return await Promise.race([read(), new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new LifecycleQueryError(`npm 生命周期查询超时（${timeoutMs}ms），已停止`))
      }, timeoutMs)
    })])
  } catch (error) {
    if (error instanceof LifecycleQueryError) throw error
    // Do not echo fetch errors or response bodies; they may include authenticated request details.
    throw new LifecycleQueryError('npm 生命周期查询失败（网络或重定向错误），已停止')
  } finally { clearTimeout(timer) }
}

export async function publishVerifiedPackage(manifestFile, packageDirectory, registry, execute = spawnSync, options = {}) {
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
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const readLifecycle = options.readLifecycle ?? ((name, version, settings) => readNpmPackageLifecycle(name, version, settings))
  const waitTimeoutMs = options.waitTimeoutMs ?? 15 * 60_000
  const pollIntervalMs = options.pollIntervalMs ?? 15_000
  const lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? 30_000
  for (const value of [waitTimeoutMs, pollIntervalMs, lifecycleTimeoutMs]) {
    assert.ok(Number.isFinite(value) && value > 0, '发布等待与查询间隔必须为正数')
  }
  const run = (args, timeout = 120_000) => {
    let result
    try { result = execute('npm', args, { encoding: 'utf8', timeout, env: process.env }) }
    catch (error) { throw new Error(redact(error instanceof Error ? error.message : error)) }
    if (result.error) throw new Error(redact(result.error.message))
    if (result.signal) throw new Error(`npm 命令被终止：${result.signal}`)
    return result
  }
  const inspect = timeout => run(['view', spec, 'dist.integrity', '--json', '--prefer-online', `--registry=${registry}`], timeout)
  const isMissing = result => {
    try { return JSON.parse(result.stdout).error?.code === 'E404' } catch { return false }
  }
  const verify = (result, message) => {
    let remote
    try { remote = JSON.parse(result.stdout) }
    catch { throw new Error('远端完整性响应不是有效 JSON，已停止') }
    if (remote !== integrity) throw new Error(message)
  }
  const requireWaitingStatus = status => {
    if (status !== 'validating' && status !== 'published') {
      throw new Error(`npm 版本状态为 ${redact(status)}，需要人工处理；不会重新上传`)
    }
  }
  const before = inspect()
  if (before.status === 0) {
    verify(before, '远端已存在不同内容的同版本，拒绝继续发布')
    console.log(`${registry} 已有相同发布包：${spec}`)
    return
  }
  if (!isMissing(before)) throw new Error(`检查远端版本失败，未尝试发布：${redact(`${before.stdout}\n${before.stderr}`)}`)
  let lifecycle = registry === NPM_REGISTRY ? await readLifecycle(entry.name, entry.version, { timeoutMs: lifecycleTimeoutMs }) : null
  if (lifecycle !== null) {
    requireWaitingStatus(lifecycle)
    console.log(`npm 已接受 ${spec}，当前状态 ${lifecycle}；仅等待完整性确认，不会重新上传`)
  } else {
    let published
    try { published = run(['publish', tarball, `--registry=${registry}`, '--access=public', '--ignore-scripts']) }
    catch (error) { throw new Error(`发布未确认，不自动重试：${redact(error.message)}`) }
    if (published.status !== 0) throw new Error(`发布未确认，不自动重试：${redact(`${published.stdout}\n${published.stderr}`)}`)
    console.log(`${registry} 已接受上传：${spec}；等待远端完整性确认，不会重复上传`)
  }
  const deadline = now() + waitTimeoutMs
  for (;;) {
    const remaining = deadline - now()
    if (remaining <= 0) throw new Error(`等待 ${spec} 远端完整性确认超过 ${waitTimeoutMs}ms；上传已被接受，未重复上传，可稍后使用同一制品续查`)
    const after = inspect(Math.min(120_000, remaining))
    if (after.status === 0) {
      verify(after, '远端发布包完整性不一致')
      console.log(`${registry} 发布并核验成功：${spec}`)
      return
    }
    if (!isMissing(after)) throw new Error(`上传已被接受，远端版本查询失败，未重复上传：${redact(`${after.stdout}\n${after.stderr}`)}`)
    if (registry === NPM_REGISTRY) {
      const budget = deadline - now()
      if (budget <= 0) continue
      lifecycle = await readLifecycle(entry.name, entry.version, { timeoutMs: Math.min(lifecycleTimeoutMs, budget) })
      if (lifecycle !== null) requireWaitingStatus(lifecycle)
      console.log(`npm ${spec} 状态：${lifecycle ?? '暂不可见'}；继续只读等待完整性（剩余 ${Math.max(0, Math.ceil((deadline - now()) / 1000))}s）`)
    }
    const delay = Math.min(pollIntervalMs, deadline - now())
    if (delay > 0) await sleep(delay)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await publishVerifiedPackage(...process.argv.slice(2)) }
  catch (error) { console.error(redact(error.message)); process.exitCode = 1 }
}
