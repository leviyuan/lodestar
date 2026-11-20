import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export interface ProcessTreeOptions {
  /** Test seam; production reads `process.platform`. */
  platform?: NodeJS.Platform
  /** Test seam for the Windows tree kill. */
  taskkill?: (pid: number, done: (error: Error | null) => void) => void
}

function defaultTaskkill(pid: number, done: (error: Error | null) => void): void {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 },
    error => done(error ?? null))
}

/**
 * Terminate `child` and every descendant.
 *
 * The managed Codex CLI is a `.cmd` shim on Windows: cross-spawn starts it
 * through `cmd.exe`, so terminating the direct child leaves the native
 * app-server alive, holding its account state and the stdout pipe. `waitForExit`
 * then times out and the old app-server keeps running after a stop or an account
 * switch. `taskkill /T` ends the tree; `claude-credential` and `agent-install`
 * already terminate their Windows wrappers this way.
 *
 * Returns true when a tree kill was started (the caller still awaits the child's
 * `close`), false when the caller should signal the child itself (POSIX, or no
 * pid). A taskkill that fails falls back to the direct signal.
 */
export function terminateProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'> | null | undefined,
  signal: NodeJS.Signals,
  onError?: (error: Error) => void,
  options: ProcessTreeOptions = {},
): boolean {
  if (!child?.pid) return false
  if ((options.platform ?? process.platform) !== 'win32') return false
  const taskkill = options.taskkill ?? defaultTaskkill
  taskkill(child.pid, error => {
    if (!error) return
    onError?.(error)
    try { child.kill(signal) } catch {}
  })
  return true
}
