import {
  appendFileSync, mkdirSync, readdirSync, unlinkSync,
  existsSync, statSync, renameSync, readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { LOG_FILE, DATA_DIR } from './paths'

/** 测试进程(bun test 固定设 NODE_ENV=test)禁止碰生产 DATA_DIR:
 * 不落盘、不迁移旧日志、不清理 —— 否则跑一遍测试就往真实
 * daemon-*.log 里塞 session "probe" 噪音,排障时被当成线上故障。 */
export function fileLoggingEnabled(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv !== 'test'
}

if (fileLoggingEnabled()) {
  try { mkdirSync(DATA_DIR, { recursive: true }) } catch {}
}

/** 按日日志保留天数(含今天);超过即清理。 */
const LOG_RETENTION_DAYS = 7
const LOG_PREFIX = 'daemon-'
const LOG_SUFFIX = '.log'

/** 本地日期 → YYYY-MM-DD 文件名片段。用本地时区(用户看"今天的日志"
 * 按本地日历算),日志行内的时间戳仍是 UTC ISO(带 Z),两者互补。 */
export function localDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 某一天的日志文件绝对路径(默认 DATA_DIR)。 */
export function logFileForDate(d: Date, dir: string = DATA_DIR): string {
  return join(dir, `${LOG_PREFIX}${localDayKey(d)}${LOG_SUFFIX}`)
}

/** 从按日日志文件名解析其日期;非日志文件或格式不符返回 null。 */
export function parseLogFileDate(filename: string): Date | null {
  if (!filename.startsWith(LOG_PREFIX) || !filename.endsWith(LOG_SUFFIX)) return null
  const key = filename.slice(LOG_PREFIX.length, filename.length - LOG_SUFFIX.length)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

/** 删除超过 maxDays 的按日日志文件,返回删除数。未来文件(ageDays<0)
 * 与非日志文件不动。 */
export function pruneOldLogs(
  dir: string,
  now: Date = new Date(),
  maxDays: number = LOG_RETENTION_DAYS,
): number {
  let names: string[]
  try { names = readdirSync(dir) } catch { return 0 }
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let removed = 0
  for (const name of names) {
    const fileDate = parseLogFileDate(name)
    if (!fileDate) continue
    const ageDays = Math.round((todayMidnight.getTime() - fileDate.getTime()) / 86_400_000)
    if (ageDays < maxDays) continue
    try { unlinkSync(join(dir, name)); removed++ } catch {}
  }
  return removed
}

/** 一次性迁移:老的 append-only daemon.log(无日期后缀)rename 成按其
 * mtime 日期命名的按日文件,纳入 7 天保留管辖。同分区 rename 原子且 O(1)。
 * 若当天按日文件已存在(迁移中途崩溃重启的罕见情况),内容追加合并后删源。 */
function migrateLegacyLogFile(): void {
  try {
    if (!existsSync(LOG_FILE)) return
    const st = statSync(LOG_FILE)
    if (!st.isFile() || st.size === 0) return
    const target = logFileForDate(st.mtime)
    if (existsSync(target)) {
      appendFileSync(target, readFileSync(LOG_FILE))
      unlinkSync(LOG_FILE)
      return
    }
    renameSync(LOG_FILE, target)
  } catch {}
}

let lastDayKey: string | null = null

type DiagnosticFields = Record<string, string | number | boolean | null | undefined>

// Log entries describe operations, never their owner. In particular, do not
// replace user/chat/session identifiers with hashes: those still reveal the
// number of distinct people using a deployment. Free-form upstream messages,
// stack traces and request/response bodies belong only in the caller's error.
const ERROR_CODES = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOSPC', 'EMFILE', 'ENFILE', 'EIO',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'ABORT_ERR', 'ERR_CANCELED', 'ERR_NETWORK', 'ConnectionRefused',
])
const NUMERIC_FIELDS = new Set(['code', 'status', 'attempt', 'retryInMs', 'durationMs', 'timeoutMs', 'bytes'])
const ENUM_VALUES: Record<string, ReadonlySet<string>> = {
  provider: new Set(['codex', 'claude', 'dsh']),
  method: new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  reason: new Set([...ERROR_CODES, 'cancelled', 'timeout', 'authentication', 'permission', 'rate_limit',
    'capacity', 'network', 'not_found', 'conflict', 'invalid_data', 'unavailable', 'server_error', 'unknown',
    'not_logged_in', 'not_available', 'no_data', 'SIGINT', 'SIGTERM']),
  phase: new Set(['start', 'end', 'retry', 'recovered', 'failed']),
}
const recentDiagnostics = new Map<string, number>()
const DIAGNOSTIC_INTERVAL_MS = 10 * 60_000
const MAX_DIAGNOSTICS = 256

/** Extract only non-identifying failure categories and machine codes. Never
 * stringify an error object: SDK errors can embed credentials and chat bodies. */
export function errorLogFields(error: unknown): DiagnosticFields {
  const fields: DiagnosticFields = {}
  const messages: string[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || value == null || seen.has(value)) return
    seen.add(value)
    if (typeof value === 'string') { messages.push(value.slice(0, 4096)); return }
    if (typeof value !== 'object') return
    const record = value as Record<string, unknown>
    // A hostile getter must not turn logging into a new failure.
    const get = (key: string): unknown => { try { return record[key] } catch { return undefined } }
    for (const key of ['message', 'msg', 'apiMessage']) {
      const message = get(key)
      if (typeof message === 'string') messages.push(message.slice(0, 4096))
    }
    const code = get('code')
    if (typeof code === 'number' && Number.isSafeInteger(code) && Math.abs(code) <= 99_999_999) fields.code ??= code
    else if (typeof code === 'string' && /^-?\d{1,8}$/.test(code)) fields.code ??= Number(code)
    else if (typeof code === 'string' && ERROR_CODES.has(code)) fields.reason ??= code
    const status = get('status') ?? get('statusCode') ?? get('httpStatus')
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) fields.status ??= status
    const errors = get('errors')
    if (Array.isArray(errors)) for (const nested of errors.slice(0, 5)) visit(nested, depth + 1)
    for (const key of ['cause', 'error', 'response', 'data']) visit(get(key), depth + 1)
  }
  visit(error, 0)
  const text = messages.join(' ').toLowerCase()
  if (!fields.reason) {
    fields.reason = /abort|cancel|取消/.test(text) ? 'cancelled'
      : /timeout|timed out|超时/.test(text) ? 'timeout'
      : /unauthori[sz]ed|authentication|invalid.*(?:key|token)|未登录|认证/.test(text) ? 'authentication'
      : /forbidden|permission|eacces|eperm|权限/.test(text) ? 'permission'
      : /rate.?limit|too many requests|限流/.test(text) ? 'rate_limit'
      : /capacity|too large|too long|超限|容量/.test(text) ? 'capacity'
      : /network|fetch failed|connect|socket|网络/.test(text) ? 'network'
      : /not found|enoent|不存在/.test(text) ? 'not_found'
      : /duplicate|conflict|重复|冲突/.test(text) ? 'conflict'
      : /invalid|malformed|parse|json|无效|格式/.test(text) ? 'invalid_data'
      : /unavailable|overloaded|不可用/.test(text) ? 'unavailable'
      : /internal.*error|服务.*错误/.test(text) ? 'server_error'
      : 'unknown'
  }
  return fields
}

/** Field allowlist deliberately excludes IDs, names, paths, text and counts
 * of users/chats/sessions. Callers must supply fixed event labels and only
 * protocol enums or operational measurements, never caller-controlled text. */
export function formatLogDiagnostic(event: string, fields: DiagnosticFields = {}): string {
  const parts = [event]
  for (const [key, value] of Object.entries(fields)) {
    if (NUMERIC_FIELDS.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      parts.push(`${key}=${value}`)
    } else if (typeof value === 'string' && ENUM_VALUES[key]?.has(value)) {
      parts.push(`${key}=${value}`)
    }
  }
  return parts.join(' ')
}

export function formatLogError(event: string, error: unknown): string {
  return formatLogDiagnostic(event, errorLogFields(error))
}

/** Repeated failures from different users intentionally share one key. Never
 * report suppression counts, which could reveal deployment participation. */
function logDeduplicated(message: string): void {
  const now = Date.now()
  const previous = recentDiagnostics.get(message)
  if (previous !== undefined && now - previous < DIAGNOSTIC_INTERVAL_MS) return
  recentDiagnostics.delete(message)
  recentDiagnostics.set(message, now)
  if (recentDiagnostics.size > MAX_DIAGNOSTICS) recentDiagnostics.delete(recentDiagnostics.keys().next().value!)
  log(message)
}

export function logError(event: string, error: unknown): void {
  logDeduplicated(formatLogError(event, error))
}

export function logDiagnostic(event: string, fields: DiagnosticFields = {}): void {
  logDeduplicated(formatLogDiagnostic(event, fields))
}

/** 追加一行到今天的按日日志,同时打到 stderr。跨天(含进程启动后首次
 * 写入)顺带清理超过 7 天的旧日志。 */
export function log(msg: string): void {
  const now = new Date()
  const line = `[${now.toISOString()}] ${msg}\n`
  process.stderr.write(line)
  if (!fileLoggingEnabled()) return
  try {
    const key = localDayKey(now)
    if (lastDayKey !== key) {
      lastDayKey = key
      pruneOldLogs(DATA_DIR, now)
    }
    appendFileSync(logFileForDate(now), line)
  } catch {}
}

// 启动:先把老 daemon.log 迁移成按日文件,再清理过期日志。
if (fileLoggingEnabled()) {
  migrateLegacyLogFile()
  try { pruneOldLogs(DATA_DIR) } catch {}
}
