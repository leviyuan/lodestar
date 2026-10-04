import { spawn } from 'cross-spawn'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { log } from './log'

/** Native Codex registers these tools from model metadata, independently of
 * tools.experimental_request_user_input.enabled. Restrict only the per-process
 * catalog; keep the selected model, native Code Mode and every other field. */
const USER_INTERACTION_TOOLS = new Set([
  'request_user_input', 'request_user_input_async',
  'send_user_message_async', 'send_message_to_user_async',
])

export function restrictCodexInputTools(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Codex raw model catalog is not an object')
  const catalog = structuredClone(raw) as Record<string, unknown>
  if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error('Codex raw model catalog has no models')
  for (const model of catalog.models) {
    if (!model || typeof model !== 'object' || typeof model.slug !== 'string' || !model.slug) {
      throw new Error('Codex raw model catalog contains an invalid model')
    }
    if (!Array.isArray(model.experimental_supported_tools)
      || model.experimental_supported_tools.some((tool: unknown) => typeof tool !== 'string')) {
      throw new Error(`Codex raw model ${model.slug} has invalid experimental_supported_tools`)
    }
    model.experimental_supported_tools = model.experimental_supported_tools.filter((tool: string) => !USER_INTERACTION_TOOLS.has(tool))
  }
  return catalog
}

export interface CodexInputPolicyCatalog {
  path: string
  disabledFeatures: string[]
  dispose(): Promise<void>
}

interface NativePolicyOptions {
  binary: string
  configArgs: string[]
  workDir: string
  env: Record<string, string | undefined>
  signal: AbortSignal
}

export function codexInputFeaturesToDisable(output: string): string[] {
  const names: string[] = []
  const lines = output.trim().split('\n')
  for (const line of lines) {
    const match = /^([a-z0-9_.]+)\s+(.+?)\s+(true|false)\s*$/.exec(line)
    if (!match) throw new Error('Codex feature catalog returned an invalid row')
    if (match[2] !== 'removed' && ['send_message_to_user_async', 'send_async_message'].includes(match[1]!)) names.push(match[1]!)
  }
  return names
}

async function runNativePolicyQuery(options: NativePolicyOptions, command: string[]): Promise<string> {
  options.signal.throwIfAborted()
  const operation = `Codex ${command.join(' ')}`
  const child = spawn(options.binary, [...command, ...options.configArgs], {
    cwd: options.workDir, env: options.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let bytes = 0
  let failure: Error | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const stop = (error: Error) => {
    if (failure) return
    failure ??= error
    if (child.pid) {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { child.kill('SIGKILL') }, 3000)
    }
  }
  const abort = () => stop(options.signal.reason instanceof Error ? options.signal.reason : new Error('Codex model catalog preparation cancelled'))
  options.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => stop(new Error(`${operation} exceeded 30 seconds`)), 30_000)
  const closed = new Promise<number | null>(resolve => {
    child.on('error', error => { failure ??= error })
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 32 * 1024 * 1024) stop(new Error('Codex raw model catalog exceeds 32 MiB'))
      else stdout.push(chunk)
    })
    child.stderr!.on('data', (chunk: Buffer) => { stderr.push(chunk) })
    child.once('close', code => resolve(code))
  })
  if (options.signal.aborted) abort()
  let code: number | null
  try { code = await closed }
  finally { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); options.signal.removeEventListener('abort', abort) }
  const diagnostic = Buffer.concat(stderr).toString('utf8').trim()
  if (diagnostic) log(`${operation}[stderr]: ${diagnostic}`)
  if (failure) throw failure
  if (code !== 0) throw new Error(`${operation} failed (exit ${code}): ${diagnostic || 'no diagnostic'}`)
  // Native catalog refresh can log a failure and still exit with a bundled
  // substitute. A service policy must not silently use that substitute.
  if (/ERROR[^\n]*(?:models_manager|model_catalog)|(?:models_manager|model_catalog)[^\n]*(?:failed|error)/i.test(diagnostic)) {
    throw new Error(`Codex model catalog export reported an upstream failure: ${diagnostic}`)
  }
  options.signal.throwIfAborted()
  return Buffer.concat(stdout).toString('utf8')
}

export async function prepareCodexInputPolicyCatalog(options: NativePolicyOptions): Promise<CodexInputPolicyCatalog> {
  // Export the effective catalog using the same native binary, account,
  // provider and configuration as the worker. --bundled would lose live model
  // metadata or a user-supplied catalog and is deliberately not used here.
  const queries = await Promise.allSettled([
    runNativePolicyQuery(options, ['debug', 'models']),
    runNativePolicyQuery(options, ['features', 'list']),
  ])
  const failures = queries.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), failures.map(result => String(result.reason)).join('; '))
  const [rawCatalog, rawFeatures] = queries.map(result => (result as PromiseFulfilledResult<string>).value)
  const catalog = restrictCodexInputTools(JSON.parse(rawCatalog!))
  const disabledFeatures = codexInputFeaturesToDisable(rawFeatures!)
  const dir = await mkdtemp(join(tmpdir(), 'lodestar-codex-input-policy-'))
  const path = join(dir, 'models.json')
  try {
    await writeFile(path, JSON.stringify(catalog), { mode: 0o600 })
    options.signal.throwIfAborted()
    return { path, disabledFeatures, dispose: () => rm(dir, { recursive: true, force: true }) }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}
