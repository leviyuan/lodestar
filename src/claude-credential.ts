/** Claude 订阅登录凭据的到期时刻：只经原生 `claude auth status --json` 读取 `loginExpiresAt`。
 * 它与钥匙串中的 refreshTokenExpiresAt 是同一时刻，但 Lodestar 不读取钥匙串、凭据文件或令牌。 */
import { spawn } from 'cross-spawn'
import { execFile, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { logError } from './log'

type Env = Record<string, string | undefined>
const DAY_MS = 86_400_000
const TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 256 * 1024
/** The stored date is the latest end; native Claude Code shows the real end as up to 3 days earlier. */
export const CLAUDE_LOGIN_EARLY_END_MS = 3 * DAY_MS
/** Native Claude Code starts warning this long before the stored date. */
export const CLAUDE_LOGIN_WARNING_MS = 10 * DAY_MS
/** A comfortably valid date only changes on a new sign-in; it is re-read at most this often. */
const SETTLED_REREAD_MS = 5 * 60_000

/** The native CLI ran but its answer is unusable (incompatible version, missing config, garbage).
 * Unlike a timeout or a busy account, this is not transient: an older date must not stand in for it. */
export class ClaudeAuthStatusFormatError extends Error {}

/** Epoch ms of `loginExpiresAt`; null when not logged in or the native CLI knows no date. */
export function parseClaudeAuthStatus(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ClaudeAuthStatusFormatError('Claude auth status 输出格式无效')
  const status = raw as Record<string, unknown>
  if (status.loggedIn === false) return null
  if (status.loggedIn !== true) throw new ClaudeAuthStatusFormatError('Claude auth status 缺少 loggedIn')
  if (!Object.hasOwn(status, 'loginExpiresAt')) throw new ClaudeAuthStatusFormatError('Claude auth status 未返回 loginExpiresAt')
  if (status.loginExpiresAt === null) return null
  const time = typeof status.loginExpiresAt === 'string' ? Date.parse(status.loginExpiresAt) : NaN
  if (!Number.isFinite(time)) throw new ClaudeAuthStatusFormatError('Claude auth status 的 loginExpiresAt 无效')
  return time
}

/** A Windows `.cmd` shim leaves the real Claude Code running when only the shell is killed. */
function terminate(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 },
      error => { if (error) child.kill() })
  } else child.kill('SIGKILL')
}

/**
 * Run the native status command once. `settings` are the same process-level settings a session
 * passes (`--settings`, a global option that must precede the subcommand), so user settings such as
 * an apiKeyHelper cannot make the status describe another credential. `onExit` runs exactly once,
 * after the process itself is gone.
 */
export function readClaudeAuthStatus(executable: string, env: Env,
  options: { settings?: object; timeoutMs?: number; onExit?(): void } = {}): Promise<number | null> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  let exited = false
  const exit = () => { if (!exited) { exited = true; options.onExit?.() } }
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
      const args = [...options.settings ? ['--settings', JSON.stringify(options.settings)] : [], 'auth', 'status', '--json']
      child = spawn(executable, args, { cwd: homedir(), env: childEnv,
        stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true })
    } catch (error) { exit(); reject(error); return }
    const chunks: Buffer[] = []
    let size = 0, settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error: unknown, value: number | null = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    // Only a live, started process is signalled: an exited one's PID may already belong to another
    // program (Windows), and Node signals pid 0 — the daemon's own process group — for a failed spawn.
    const stop = () => { if (!exited && child.pid !== undefined) terminate(child) }
    // Listeners first: a failed spawn reports through 'error', and may leave no stdout at all.
    // 'exit' marks the process itself; 'close' can wait for descendants still holding stdout.
    child.once('exit', exit)
    child.once('error', error => { exit(); finish(error) })
    child.once('close', code => {
      exit()
      // Not logged in exits 1 but still prints the full status: the JSON decides, not the exit code.
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) { finish(new ClaudeAuthStatusFormatError(`Claude auth status 无输出（退出码 ${code ?? 'MISS'}）`)); return }
      let raw: unknown
      try { raw = JSON.parse(text) }
      catch { finish(new ClaudeAuthStatusFormatError('Claude auth status 输出不是有效 JSON')); return }
      try { finish(null, parseClaudeAuthStatus(raw)) }
      catch (error) { finish(error) }
    })
    timer = setTimeout(() => {
      stop()
      finish(new Error(`Claude auth status 超时（${timeoutMs / 1000}s）`))
    }, timeoutMs)
    if (!child.stdout) {
      // Only a failed spawn has no stdout: nothing runs, and its queued 'error' event reports the exit.
      finish(new Error('Claude auth status 无法读取输出'))
      return
    }
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk)
      else if (!settled) {
        stop()
        finish(new ClaudeAuthStatusFormatError('Claude auth status 输出过大'))
      }
    })
  })
}

export interface ClaudeCredentialProbe {
  env: Env
  /** The account's session-level settings override, passed as `--settings`. */
  settings?: object
  /** Account directory lease, held until the native process has exited. */
  acquireUse?(): () => void
}

const reads = new Map<string, { revision: string; expiresAt: number | null; readAt: number }>()
const pending = new Map<string, { revision: string; token: object; promise: Promise<number | null> }>()

export function invalidateClaudeCredentialExpiry(accountId: string): void {
  reads.delete(accountId)
  pending.delete(accountId)
}

/**
 * Called by the account's background usage refresh only; interactive panels read the committed snapshot.
 * A date more than the warning window away is re-read at most every 5 minutes; closer, expired or unknown
 * dates are re-read on every refresh so a new sign-in shows up promptly. A transient failure (timeout,
 * busy account, spawn error) keeps the last value of the same account revision; an unusable native answer
 * is recorded as unknown, so it shows MISS instead of an older date. Resolves undefined when nothing may
 * be run: tests never start the machine's real Claude Code, like reclaude probing.
 */
export function claudeCredentialExpiry(binding: { accountId: string; revision: string },
  probe: () => ClaudeCredentialProbe,
  options: { executable?: () => string; timeoutMs?: number } = {}): Promise<number | null | undefined> {
  if (!options.executable && process.env.NODE_ENV === 'test') return Promise.resolve(undefined)
  const { accountId, revision } = binding
  const now = Date.now()
  const known = reads.get(accountId)
  if (known?.revision === revision && known.expiresAt !== null && known.expiresAt - now > CLAUDE_LOGIN_WARNING_MS
    && now - known.readAt < SETTLED_REREAD_MS) return Promise.resolve(known.expiresAt)
  const running = pending.get(accountId)
  if (running?.revision === revision) return running.promise
  // Invalidation or a newer revision replaces this entry; a late result must not overwrite it.
  const token = {}
  const current = () => pending.get(accountId)?.token === token
  const read = async (): Promise<number | null> => {
    try {
      const { env, settings, acquireUse } = probe()
      const executable = options.executable?.()
        ?? (await import('./agent-updates')).agentBin('claude', 'claude')
      const release = acquireUse?.()
      const expiresAt = await readClaudeAuthStatus(executable, env, { settings, timeoutMs: options.timeoutMs, onExit: release })
      if (current()) reads.set(accountId, { revision, expiresAt, readAt: Date.now() })
      return expiresAt
    } catch (error) {
      logError('claude credential expiry read failed', error)
      if (error instanceof ClaudeAuthStatusFormatError) {
        if (current()) reads.set(accountId, { revision, expiresAt: null, readAt: Date.now() })
        return null
      }
      const last = reads.get(accountId)
      return last?.revision === revision ? last.expiresAt : null
    }
  }
  const promise = read().finally(() => { if (current()) pending.delete(accountId) })
  pending.set(accountId, { revision, token, promise })
  return promise
}
