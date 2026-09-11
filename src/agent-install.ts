import { execFile } from 'node:child_process'
import { spawn } from 'cross-spawn'

const REGISTRY = 'https://registry.npmjs.org'

/** Cleanup must not race an installer whose process tree may still own EXEs. */
export class AgentInstallTerminationError extends Error {}

export function terminateWindowsInstaller(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(new Error(`Invalid npm installer PID: ${pid}`))
  return new Promise((resolve, reject) => {
    // npm.cmd is a shell wrapper. Target only this installer's exact tree;
    // killing the wrapper alone leaves npm/postinstall holding native files.
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`taskkill npm installer PID ${pid} failed: ${error.message}\n${stdout}${stderr}`))
      else resolve()
    })
  })
}

export async function installAgentPackages(directory: string, signal?: AbortSignal, options: {
  platform?: NodeJS.Platform
  spawn?: typeof spawn
  terminateWindows?: (pid: number) => Promise<void>
  timeoutMs?: number
  terminationTimeoutMs?: number
} = {}): Promise<void> {
  signal?.throwIfAborted()
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? 300_000
  const terminationTimeoutMs = options.terminationTimeoutMs ?? 10_000
  return await new Promise((resolve, reject) => {
    const child = (options.spawn ?? spawn)('npm', ['install', '--prefix', directory, '--include=optional', '--no-fund', '--no-audit', `--registry=${REGISTRY}`],
      { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true })
    let output = ''
    let failure: Error | undefined
    let termination: Promise<void> | undefined
    let settled = false
    let closed = false
    let terminationTimer: ReturnType<typeof setTimeout> | undefined
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_384) }
    child.stdout!.on('data', capture)
    child.stderr!.on('data', capture)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (terminationTimer) clearTimeout(terminationTimer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const unconfirmed = (detail: string) => new AgentInstallTerminationError(
      `${failure?.message ?? 'Agent runtime install failed'}; npm installer PID ${child.pid ?? 'MISS'} termination unconfirmed: ${detail}; partial directory retained: ${directory}\n${output}`,
    )
    const cancel = (reason: string) => {
      if (settled || closed || termination) return
      failure ??= new Error(reason)
      terminationTimer = setTimeout(() => finish(unconfirmed(`stdio did not close within ${terminationTimeoutMs}ms`)), terminationTimeoutMs)
      termination = Promise.resolve().then(async () => {
        if (closed) throw new Error('installer closed before process-tree termination started')
        if (!child.pid) throw new Error('installer PID unavailable')
        if (platform === 'win32') await (options.terminateWindows ?? terminateWindowsInstaller)(child.pid)
        else if (!child.kill('SIGTERM')) throw new Error('npm installer rejected SIGTERM')
      })
      void termination.catch(error => finish(unconfirmed(error instanceof Error ? error.message : String(error))))
    }
    const onAbort = () => cancel('Agent runtime install aborted')
    const timer = setTimeout(() => cancel(`Agent runtime install timed out after ${timeoutMs}ms`), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', error => {
      failure ??= error
      if (!child.pid) finish(new Error(`${error.message}\n${output}`))
    })
    child.once('close', async (code, exitSignal) => {
      closed = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      try { await termination }
      catch (error) {
        finish(unconfirmed(error instanceof Error ? error.message : String(error)))
        return
      }
      if (failure || code !== 0) finish(new Error(`${failure?.message ?? `npm install exited code=${code} signal=${exitSignal}`}\n${output}`))
      else finish()
    })
    if (signal?.aborted) onAbort()
  })
}
