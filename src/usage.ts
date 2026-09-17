/**
 * ChatGPT/Codex usage snapshot for the `hi` console panel.
 *
 * Source: Codex app-server `account/read` + `account/rateLimits/read`.
 * This stays on the same auth path as the daemon itself: the user's
 * local `codex login` ChatGPT session.
 */

import type { ChildProcessByStdio } from 'node:child_process'
import { spawn } from 'cross-spawn'
import type { Readable, Writable } from 'node:stream'
import { resolveCodexBin } from './codex-process'
import { log } from './log'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { createHash } from 'node:crypto'
import { config } from './config'
import { bindProcessCodexAccount, codexAccounts, DEFAULT_CODEX_ACCOUNT } from './codex-accounts'
import { plusFiveHourWindow } from './codex-quota'
import { UsageReadCache, USAGE_FRESH_MS, isUsageRateLimitError } from './usage-cache'

const API_TIMEOUT_MS = 10_000

export interface UsageWindow {
  percent: number | null
  resetsAt: Date | null
  durationMins?: number | null
  /** Successful Plus response omitted 5h; full window per the configured product rule, reset time unknown. */
  unreportedFull?: boolean
}

/** 额度快照里单个计量桶(read 端点 rateLimitsByLimitId 的一个条目)。 */
export interface UsageBucket {
  limitId: string
  limitName: string | null
  fiveHour: UsageWindow | null
  weekly: UsageWindow | null
  normalModelSlug?: string | null
  rateLimitReachedType?: string | null
  spendControlReached?: boolean | null
}

export type UsageSnapshot =
  | { state: 'no_credentials' }
  | { state: 'auth_failed' }
  | { state: 'rate_limited' }
  | { state: 'network'; reason?: string }
  | {
      state: 'ok'
      subscriptionType?: string
      /** Native account identity, hashed before it enters scheduling/state. Supports OS keyring auth. */
      accountFingerprint?: string
      ordinaryUsageAllowed?: boolean
      rateLimitReachedType?: string | null
      spendControlReached?: boolean | null
      fiveHour: UsageWindow | null
      weekly: UsageWindow | null
      /** read 端点全量桶 map(按服务端 limitId 键控)。权威状态,每次 read 整体替换。 */
      buckets?: UsageBucket[]
      /** 服务端在 read 响应里指定的默认桶 limitId(顶层 rateLimits 指针)。 */
      defaultLimitId?: string
      /** 账号可用的额度重置卡次数；null 表示接口没有返回有效数值。 */
      resetCredits?: number | null
      fetchedAt: number
    }

const caches = new Map<string, UsageSnapshot>()
// Startup and footer displays may use the last successful read.
// Keep it separate from the latest result so live quota queries still report failures.
const successfulCaches = new Map<string, Extract<UsageSnapshot, { state: 'ok' }>>()
const usageReads = new UsageReadCache<UsageSnapshot>()

function cacheUsage(accountId: string, snapshot: UsageSnapshot): void {
  caches.set(accountId, snapshot)
  if (snapshot.state === 'ok') successfulCaches.set(accountId, snapshot)
  else if (snapshot.state === 'no_credentials' || snapshot.state === 'auth_failed') successfulCaches.delete(accountId)
}

export type CodexResetOutcome = 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit'
export interface CodexResetResult {
  outcome: CodexResetOutcome
  usage: UsageSnapshot
  cleanupError?: string
}
type CodexResetClient = Pick<AppServerOnce, 'initialize' | 'request' | 'close'>
const resetInFlights = new Map<string, { key: string; promise: Promise<CodexResetResult> }>()

/** One logical redemption keeps its key across transport retries. Never infer the new quota. */
export function consumeCodexResetCredit(
  accountId: string,
  idempotencyKey: string,
  createClient: (accountId: string) => CodexResetClient = id => new AppServerOnce({ accountId: id }),
): Promise<CodexResetResult> {
  if (!accountId || !idempotencyKey.trim()) return Promise.reject(new Error('重置卡请求缺少账号或幂等标识'))
  const pending = resetInFlights.get(accountId)
  if (pending) return pending.key === idempotencyKey ? pending.promise
    : Promise.reject(new Error('该账号正在使用重置卡，请等待结果后再操作'))
  const promise = Promise.resolve().then(async () => {
    const app = createClient(accountId)
    let result: CodexResetResult | undefined
    let failure: unknown
    try {
      await app.initialize('lodestar-codex-reset')
      const account = (await app.request('account/read', {}))?.account
      if (!account || account.type !== 'chatgpt') throw new Error('该账号未登录 ChatGPT 订阅，不能使用重置卡')
      invalidateCodexUsage(accountId)
      let response: any
      try {
        response = await requestCodexControlWithRetry(() => app.request('account/rateLimitResetCredit/consume', { idempotencyKey }), '重置卡请求')
      } catch (error) {
        throw new Error(`重置卡请求未确认结果：${error instanceof Error ? error.message : String(error)}；请用 codex-accounts 核对额度与重置卡次数`, { cause: error })
      } finally {
        // A quota read started during redemption must not restore the pre-reset cache.
        invalidateCodexUsage(accountId)
      }
      if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(response?.outcome)) {
        throw new Error(`Codex 重置卡返回未知结果：${JSON.stringify(response)}；请用 codex-accounts 核对后再操作`)
      }
      const generation = usageGenerations.get(accountId)
      let usage: UsageSnapshot
      try {
        usage = await usageReads.read(accountId, async () => snapshotFromReadResponse(
          await withTimeout(app.request('account/rateLimits/read', {}), API_TIMEOUT_MS), account.planType))
      } catch (error) {
        usage = { state: 'network', reason: error instanceof Error ? error.message : String(error) }
      }
      if (usageGenerations.get(accountId) !== generation) usage = { state: 'auth_failed' }
      else cacheUsage(accountId, usage)
      if (usage.state !== 'ok') log(`codex-reset: ${accountId} quota refresh failed: ${usage.state === 'network' ? usage.reason : usage.state}`)
      result = { outcome: response.outcome, usage }
    } catch (error) {
      failure = error
      log(`codex-reset: ${accountId}: ${error}`)
    }
    try { await app.close() }
    catch (error) {
      const message = `控制连接关闭失败：${error instanceof Error ? error.message : String(error)}`
      log(`codex-reset: ${accountId}: ${message}`)
      // Preserve a confirmed redemption even if cleanup fails, so the receipt cannot suggest using another card.
      if (result) result.cleanupError = message
      else throw new AggregateError([failure, error], `${String(failure)}；${message}`)
    }
    if (!result) throw failure
    return result
  }).finally(() => { if (resetInFlights.get(accountId)?.promise === promise) resetInFlights.delete(accountId) })
  resetInFlights.set(accountId, { key: idempotencyKey, promise })
  return promise
}

export class AppServerOnce extends EventEmitter {
  private proc: ChildProcessByStdio<Writable, Readable, Readable>
  private buf = ''
  private decoder = new StringDecoder('utf8')
  private nextId = 1
  private alive = true
  private exitPromise: Promise<void>
  private resolveExit!: () => void
  private pending = new Map<number, {
    resolve: (v: any) => void
    reject: (e: Error) => void
    method: string
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(opts: { accountId?: string; env?: Record<string, string | undefined>; args?: string[]; bin?: string; login?: boolean; cwd?: string } = {}) {
    super()
    const accountId = opts.accountId ?? DEFAULT_CODEX_ACCOUNT
    this.proc = spawn(opts.bin ?? resolveCodexBin(), ['app-server', '--listen', 'stdio://', ...(opts.args ?? codexAccounts.cliArgs(accountId))], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      cwd: opts.cwd,
      env: opts.env ?? codexAccounts.env(accountId, { ...process.env, ...config.codex.env }, true, opts.login),
    }) as ChildProcessByStdio<Writable, Readable, Readable>
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve })
    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.proc.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString().trim()
      if (s) log(`usage[codex stderr]: ${s}`)
    })
    const finish = (error: Error) => {
      if (!this.alive) return
      this.alive = false
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`${error.message}; pending ${p.method} id=${id}`))
      }
      this.pending.clear()
      this.resolveExit()
      this.emit('exit')
      this.emit('closed', error)
    }
    this.proc.on('error', error => finish(new Error(`codex app-server spawn failed: ${error.message}`)))
    this.proc.stdin.on('error', error => {
      log(`usage: codex stdin failed: ${error.message}`)
      this.emit('protocolError', error)
    })
    // Drain stdout before rejecting requests; exit can precede buffered JSON-RPC responses.
    this.proc.on('close', (code, signal) => {
      finish(new Error(`codex app-server exited code=${code} signal=${signal}`))
    })
    // Quota/model probes can refresh auth too; deletion must wait for their native process to close.
    bindProcessCodexAccount(this, accountId)
  }

  private onStdout(chunk: Buffer): void {
    this.buf += this.decoder.write(chunk)
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: any
      try { msg = JSON.parse(line) } catch { this.emit('protocolError', new Error('Codex app-server returned invalid JSON')); continue }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        this.emit('protocolError', new Error('Codex app-server returned invalid RPC object'))
        continue
      }
      const hasId = Object.prototype.hasOwnProperty.call(msg, 'id')
      if (typeof msg.method === 'string') {
        if (!hasId) this.emit('notification', msg.method, msg.params)
        else {
          // Server request IDs are a different namespace. Never consume a pending client read with the same ID.
          log(`usage: unsupported Codex server request: ${msg.method}`)
          this.proc.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: `Unsupported server request: ${msg.method}` } }) + '\n')
        }
        continue
      }
      if (!hasId || (!Object.prototype.hasOwnProperty.call(msg, 'result') && !Object.prototype.hasOwnProperty.call(msg, 'error'))) {
        this.emit('protocolError', new Error('Codex app-server returned an incomplete RPC response'))
        continue
      }
      const pending = this.pending.get(msg.id)
      if (!pending) continue
      this.pending.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)))
      else pending.resolve(msg.result)
    }
  }

  async initialize(name: string): Promise<void> {
    await this.request('initialize', { clientInfo: { name, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false } })
    await new Promise<void>((resolve, reject) => {
      this.proc.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n', error => error ? reject(error) : resolve())
    })
  }

  isAlive(): boolean { return this.alive }

  request(method: string, params: any, timeoutMs = API_TIMEOUT_MS): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (!this.alive) {
        reject(new Error(`codex app-server is not alive; cannot request ${method}`))
        return
      }
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`codex app-server ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, method, timer })
      try {
        this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
          if (!error) return
          const pending = this.pending.get(id)
          if (!pending) return
          this.pending.delete(id)
          clearTimeout(pending.timer)
          pending.reject(new Error(`codex app-server write failed for ${method}: ${error.message}`))
        })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async close(timeoutMs = 2000): Promise<void> {
    if (!this.alive) return
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
      if (!await this.waitForExit(timeoutMs)) throw new Error('codex app-server stdio did not close after exit')
      return
    }
    if (!this.proc.kill('SIGTERM')) throw new Error('codex app-server rejected SIGTERM')
    const exited = await this.waitForExit(timeoutMs)
    if (exited) return
    if (!this.proc.kill('SIGKILL')) throw new Error('codex app-server rejected SIGKILL')
    const killed = await this.waitForExit(timeoutMs)
    if (!killed) throw new Error(`codex app-server did not exit after SIGKILL (${timeoutMs}ms)`)
  }
  private async waitForExit(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([this.exitPromise.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })])
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
  })
}

function clampPct(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, v)) : null
}

function windowFromRateLimit(w: any): UsageWindow | null {
  if (!w) return null
  return {
    percent: clampPct(w.usedPercent),
    resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000) : null,
    durationMins: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
  }
}

/** 窗口归类:按 windowDurationMins 真实时长归类(短窗→5h 档,周量级→weekly),
 * 位置只作 fallback。不硬编码"当前套餐必然 300/10080"——只把时长最接近
 * 5h 量级的认作 fiveHour,其余(含缺失时长)按 primary/secondary 位置。 */
function classifyWindows(limits: any): { fiveHour: UsageWindow | null; weekly: UsageWindow | null } {
  const primary = windowFromRateLimit(limits?.primary)
  const secondary = windowFromRateLimit(limits?.secondary)
  const isShort = (w: UsageWindow | null): boolean =>
    w?.durationMins != null && w.durationMins > 0 && w.durationMins <= 720
  const isLong = (w: UsageWindow | null): boolean =>
    w?.durationMins != null && w.durationMins > 720
  if (isShort(primary) && isLong(secondary)) return { fiveHour: primary, weekly: secondary }
  if (isShort(secondary) && isLong(primary)) return { fiveHour: secondary, weekly: primary }
  if (isLong(primary) && !secondary) return { fiveHour: null, weekly: primary }
  if (isLong(secondary) && !primary) return { fiveHour: null, weekly: secondary }
  // 时长缺失或均为短窗:按位置(primary=5h 档,secondary=周)
  return { fiveHour: primary, weekly: secondary }
}

/** read 端点响应 → 桶列表。空形态(has neither window)跳过,保持 map 干净。 */
function bucketsFromReadResponse(limitsRes: any): { buckets: UsageBucket[]; defaultLimitId: string | undefined } {
  const byId = limitsRes?.rateLimitsByLimitId
  const entryList: [string, any][] = byId && typeof byId === 'object'
    ? Object.entries(byId)
    : limitsRes?.rateLimits ? [[limitsRes.rateLimits.limitId ?? 'codex', limitsRes.rateLimits]] : []
  const buckets: UsageBucket[] = []
  for (const [id, raw] of entryList) {
    const { fiveHour, weekly } = classifyWindows(raw)
    if (!fiveHour && !weekly) continue
    buckets.push({ limitId: id, limitName: raw?.limitName ?? null, fiveHour, weekly,
      normalModelSlug: raw?.normalModelSlug ?? null,
      rateLimitReachedType: raw?.rateLimitReachedType ?? null,
      spendControlReached: raw?.spendControlReached ?? null })
  }
  return { buckets, defaultLimitId: limitsRes?.rateLimits?.limitId ?? undefined }
}

/** 通知负载的形态签名,只用于日志(归属判断不可信,2026-08-20 源码核实:
 * 上游 SSE/WS 事件缺 metered_limit_name 时客户端解析器把 limitId 强补
 * "codex" —— Spark 桶的内容会被贴上主桶标签)。 */
function describeNotification(rateLimits: any): string {
  if (!rateLimits) return 'empty'
  const w = (x: any): string => x ? `${x.usedPercent ?? '?'}%/${x.windowDurationMins ?? '?'}m` : 'null'
  return `limitId=${rateLimits.limitId ?? 'null'} name=${rateLimits.limitName ?? 'null'} primary=${w(rateLimits.primary)} secondary=${w(rateLimits.secondary)}`
}

/** rolling 通知的观察日志:记录通知形态,并和 cache 里已知桶对比。通知
 * limitId 与内容可能错标(见 describeNotification),只用于异常可见性,
 * 不写 cache —— 权威状态只来自 readUsage 的 read 端点(整体替换)。 */
export function observeRateLimitsNotification(rateLimits: any, accountId = DEFAULT_CODEX_ACCOUNT): void {
  const desc = describeNotification(rateLimits)
  const cache = caches.get(accountId)
  const known = cache?.state === 'ok' ? (cache.buckets ?? []) : []
  const matches = known.filter(b =>
    windowsEqual(b.fiveHour, windowFromRateLimit(rateLimits?.primary))
    && windowsEqual(b.weekly, windowFromRateLimit(rateLimits?.secondary)))
  if (known.length > 0 && matches.length === 0) {
    log(`usage: rate-limit notification matches NO known bucket — possible relabel or new bucket, will resolve on next read. (${desc})`)
  } else if (rateLimits?.limitId && matches.length === 1 && matches[0].limitId !== rateLimits.limitId) {
    log(`usage: rate-limit notification labeled limitId=${rateLimits.limitId} but content matches bucket ${matches[0].limitId} (known codex parser fallback relabels; ignoring notification payload)`)
  }
}

function windowsEqual(a: UsageWindow | null, b: UsageWindow | null): boolean {
  if (!a || !b) return !a && !b
  return a.percent === b.percent && a.durationMins === b.durationMins
    && a.resetsAt?.getTime() === b.resetsAt?.getTime()
}

async function fetchUsage(accountId: string): Promise<UsageSnapshot> {
  const app = new AppServerOnce({ accountId })
  try {
    await app.initialize('lodestar-usage')

    const accountRes = await withTimeout(app.request('account/read', {}), API_TIMEOUT_MS)
    const account = accountRes?.account
    if (!account) return { state: 'no_credentials' }
    if (account.type !== 'chatgpt') return { state: 'auth_failed' }

    const limitsRes = await app.request('account/rateLimits/read', {})
    return snapshotFromReadResponse(limitsRes, account.planType)
  } catch (e: any) {
    log(`usage: codex app-server usage failed: ${e?.message ?? e}`)
    if (isUsageAuthError(e)) return { state: 'auth_failed' }
    if (isUsageRateLimitError(e)) return { state: 'rate_limited' }
    return { state: 'network', reason: e?.message ?? String(e) }
  } finally {
    await app.close()
  }
}

/** read 端点响应 → 权威快照。默认桶跟随服务端顶层 rateLimits 指针;
 * 桶 map 整体替换(OpenAI 加/删桶自动跟上)。 */
export function snapshotFromReadResponse(limitsRes: any, planType?: string | null): UsageSnapshot {
  const { buckets, defaultLimitId } = bucketsFromReadResponse(limitsRes)
  const def = buckets.find(b => b.limitId === defaultLimitId) ?? buckets[0]
  if (!def) return { state: 'network', reason: 'empty rate limit response' }
  const subscriptionType = planType ?? limitsRes?.rateLimits?.planType ?? undefined
  def.fiveHour = plusFiveHourWindow(subscriptionType, def.fiveHour)
  return {
    state: 'ok',
    subscriptionType,
    ...(typeof limitsRes?.accountId === 'string' && limitsRes.accountId
      ? { accountFingerprint: createHash('sha256').update(limitsRes.accountId).digest('hex') } : {}),
    ...(typeof limitsRes?.ordinaryUsageAllowed === 'boolean' ? { ordinaryUsageAllowed: limitsRes.ordinaryUsageAllowed } : {}),
    rateLimitReachedType: def.rateLimitReachedType,
    spendControlReached: def.spendControlReached,
    fiveHour: def.fiveHour,
    weekly: def.weekly,
    buckets,
    defaultLimitId: def.limitId,
    resetCredits: Number.isInteger(limitsRes?.rateLimitResetCredits?.availableCount) && limitsRes.rateLimitResetCredits.availableCount >= 0
      ? limitsRes.rateLimitResetCredits.availableCount : null,
    fetchedAt: Date.now(),
  }
}

/** 最近一次查询结果；保留失败语义，不用成功缓存替换。 */
export function peekUsage(accountId = DEFAULT_CODEX_ACCOUNT): UsageSnapshot | null {
  return caches.get(accountId) ?? null
}

/** Last successful read for startup scheduling and footer displays. */
export function peekSuccessfulUsage(accountId = DEFAULT_CODEX_ACCOUNT): Extract<UsageSnapshot, { state: 'ok' }> | null {
  return successfulCaches.get(accountId) ?? null
}

export function peekFreshUsage(accountId = DEFAULT_CODEX_ACCOUNT): Extract<UsageSnapshot, { state: 'ok' }> | null {
  const snapshot = peekSuccessfulUsage(accountId)
  return snapshot && Date.now() >= snapshot.fetchedAt && Date.now() - snapshot.fetchedAt < USAGE_FRESH_MS ? snapshot : null
}

/** Bind a closing footer to its account; login, deletion or quota reset invalidates the reader. */
export function captureCodexUsageCache(accountId = DEFAULT_CODEX_ACCOUNT) {
  const generation = usageGenerations.get(accountId) ?? 0
  return {
    accountId,
    read: () => (usageGenerations.get(accountId) ?? 0) === generation ? peekSuccessfulUsage(accountId) : null,
  }
}

export function readUsage(accountId = DEFAULT_CODEX_ACCOUNT): Promise<UsageSnapshot> {
  const generation = usageGenerations.get(accountId) ?? 0
  return usageReads.read(accountId, async () => {
    try { return await fetchUsage(accountId) }
    catch (error) { log(`usage: ${accountId} fetch failed: ${error}`); throw error }
  })
    .catch((e): UsageSnapshot => {
      if (isUsageAuthError(e)) return { state: 'auth_failed' }
      if (isUsageRateLimitError(e)) return { state: 'rate_limited' }
      return { state: 'network', reason: String(e) }
    }).then((snapshot): UsageSnapshot => {
      if ((usageGenerations.get(accountId) ?? 0) !== generation) return { state: 'auth_failed' }
      cacheUsage(accountId, snapshot)
      return snapshot
    })
}

/** 用现有连接刷新额度；请求失败返回 null 并记录原始错误。
 * 成功快照另存供启动与页脚使用，页脚沿用原额度格式。 */
export function refreshUsageFromConnection(request: (method: string, params: any) => Promise<any>, accountId = DEFAULT_CODEX_ACCOUNT): Promise<UsageSnapshot | null> {
  const generation = usageGenerations.get(accountId) ?? 0
  return usageReads.read(accountId, async () => {
    try {
      const snap = snapshotFromReadResponse(await withTimeout(request('account/rateLimits/read', {}), API_TIMEOUT_MS))
      if (snap.state !== 'ok') log(`usage: refresh from connection: ${snap.state === 'network' ? snap.reason : snap.state}`)
      return snap
    } catch (error) {
      log(`usage: refresh from connection failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }).then((snap) => {
      if ((usageGenerations.get(accountId) ?? 0) !== generation) return null
      if ((usageGenerations.get(accountId) ?? 0) === generation) cacheUsage(accountId, snap)
      return snap
    })
    .catch((e: any) => {
      if ((usageGenerations.get(accountId) ?? 0) === generation) {
        caches.delete(accountId)
        if (isUsageAuthError(e)) successfulCaches.delete(accountId)
      }
      return null
    })
}

const usageGenerations = new Map<string, number>()
let usageRevision = 0
export function codexUsageCacheRevision(): number { return usageRevision }
export function invalidateCodexUsage(accountId: string): void {
  usageRevision++
  usageGenerations.set(accountId, (usageGenerations.get(accountId) ?? 0) + 1)
  caches.delete(accountId)
  successfulCaches.delete(accountId)
  usageReads.invalidate(accountId)
}

function isUsageAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(?:401|403)\b|unauthori[sz]ed|not authenticated|authentication (?:failed|required)|not logged in/i.test(message)
}

/** 网络抖动重试同一个 Codex 控制请求；仅供只读或带幂等标识的操作。 */
export async function requestCodexControlWithRetry<T>(request: () => Promise<T>, operation = '额度查询'): Promise<T> {
  const delays = [1000, 4000]
  for (let attempt = 0; ; attempt++) {
    try { return await withTimeout(request(), API_TIMEOUT_MS) }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isUsageAuthError(error)) throw error
      const transient = /error sending request|timed? ?out|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection (?:reset|closed)|\b(?:429|502|503|504)\b/i.test(message)
      if (!transient) throw error
      if (attempt >= delays.length) throw new Error(`Codex ${operation}失败（已尝试 ${attempt + 1} 次）：${message}`, { cause: error })
      log(`usage: ${operation} retry ${attempt + 1}/${delays.length} in ${delays[attempt]}ms: ${message}`)
      await new Promise(resolve => setTimeout(resolve, delays[attempt]))
    }
  }
}
