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
 * Returns true when the caller should only await the child's `close`: a tree
 * kill was started, or the child already exited. False when the caller should
 * signal the child itself (POSIX, or no pid). A taskkill that fails falls back
 * to the direct signal.
 */
export function terminateProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill' | 'exitCode' | 'signalCode'> | null | undefined,
  signal: NodeJS.Signals,
  onError?: (error: Error) => void,
  options: ProcessTreeOptions = {},
): boolean {
  if (!child?.pid) return false
  if ((options.platform ?? process.platform) !== 'win32') return false
  // Once Node has reaped the direct child its PID may belong to another program,
  // and `/T /F` would end that program's whole tree: only a child still running
  // is targeted (a second round after a stalled `close` must not taskkill again).
  if (child.exitCode != null || child.signalCode != null) return true
  const taskkill = options.taskkill ?? defaultTaskkill
  taskkill(child.pid, error => {
    if (!error) return
    onError?.(error)
    try { child.kill(signal) } catch {}
  })
  return true
}
