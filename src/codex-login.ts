import { AppServerOnce, invalidateCodexUsage, requestCodexControlWithRetry } from './usage'
import { codexAccounts, DEFAULT_CODEX_ACCOUNT, isCodexLoginPending, reserveCodexLogin } from './codex-accounts'
import { log } from './log'

export interface CodexLoginClient {
  initialize(name: string): Promise<void>
  request(method: string, params: any, timeoutMs?: number): Promise<any>
  close(): Promise<void>
  isAlive(): boolean
  on(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
}
export interface CodexLoginOwner { chatId: string; userOpenId: string }
export interface CodexLoginAccount { type: 'chatgpt'; email: string | null; planType: string }

/** Check native auth before creating a named account; the default may use an OS keyring. */
export async function requireDefaultCodexLogin(
  createClient: (accountId: string) => CodexLoginClient = accountId => new AppServerOnce({ accountId }),
): Promise<void> {
  if (isCodexLoginPending(DEFAULT_CODEX_ACCOUNT)) throw new Error('默认账号正在登录，请先完成默认账号授权，再添加额外账号。')
  let client: CodexLoginClient | undefined
  let failure: Error | undefined
  let response: any
  try {
    client = createClient(DEFAULT_CODEX_ACCOUNT)
    await client.initialize('lodestar-login-check')
    response = await requestCodexControlWithRetry(() => client!.request('account/read', { refreshToken: false }), '默认账号登录检查')
  } catch (error) {
    failure = new Error(`默认账号登录检查失败：${asError(error).message}`, { cause: error })
  }
  if (!failure) {
    if (response?.account === null || response?.account?.type === 'apiKey') {
      failure = new Error('默认账号未登录 ChatGPT，请先发送不带备注的 codex-login 完成登录，再添加额外账号。')
    } else if (response?.account?.type !== 'chatgpt') {
      failure = new Error('默认账号登录检查失败：account/read 返回的账号状态无效')
    }
  }
  if (client) {
    try {
      await client.close()
      if (client.isAlive()) throw new Error('检查进程仍未退出')
    } catch (error) {
      failure = new Error([failure?.message, `默认账号检查进程关闭失败：${asError(error).message}`].filter(Boolean).join('；'), { cause: error })
    }
  }
  if (failure) throw failure
}

export interface CodexLoginHandle {
  accountId: string
  loginId: string
  verificationUrl: string
  userCode: string
  done: Promise<CodexLoginAccount>
}
interface Attempt {
  owner: CodexLoginOwner
  client: CodexLoginClient
  accountId: string
  loginId: string | null
  loginRequested: boolean
  loginSucceeded: boolean
  authUpdated: boolean
  finishing: boolean
  done: Promise<CodexLoginAccount>
  resolve: (account: CodexLoginAccount) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  notification: (method: string, params: any) => void
  closed: (error: Error) => void
  early: any[]
  releaseAuth: () => void
}

/** Managed device-code auth. Codex polls OpenAI and persists/refreshes credentials itself. */
export class CodexLogins {
  private attempts = new Map<string, Attempt>()
  private stopping = false
  constructor(
    private createClient: (accountId: string) => CodexLoginClient = accountId => new AppServerOnce({ accountId, login: true }),
    private waitMs = 15 * 60_000,
    private recordLogin = (id: string, account: CodexLoginAccount) => {
      codexAccounts.recordLogin(id, account)
      invalidateCodexUsage(id)
    },
    private stateWaitMs = 10_000,
  ) {}

  async start(accountId: string, owner: CodexLoginOwner): Promise<CodexLoginHandle> {
    if (this.stopping) throw new Error('服务正在退出，无法开始登录')
    if (!owner.userOpenId) throw new Error('无法确认登录发起者')
    if (this.attempts.has(accountId)) throw new Error('该账号已有登录任务；使用 codex-login-cancel 取消后再登录')
    const releaseAuth = reserveCodexLogin(accountId)
    let client: CodexLoginClient
    try { client = this.createClient(accountId) }
    catch (error) { releaseAuth(); throw error }
    let resolve!: Attempt['resolve']
    let reject!: Attempt['reject']
    const done = new Promise<CodexLoginAccount>((yes, no) => { resolve = yes; reject = no })
    // The command attaches its visible receipt after sending the instructions. Keep early failure observable there.
    void done.catch(() => {})
    const attempt: Attempt = { owner, client, accountId, loginId: null, loginRequested: false,
      loginSucceeded: false, authUpdated: false, finishing: false, done, resolve, reject,
      timer: null, notification: () => {}, closed: () => {}, early: [], releaseAuth }
    attempt.notification = (method, params) => {
      if (attempt.finishing || !attempt.loginRequested) return
      if (method === 'account/updated') {
        if (params?.authMode === 'chatgpt') {
          attempt.authUpdated = true
          if (attempt.loginSucceeded) void this.finish(attempt)
        }
        return
      }
      if (method !== 'account/login/completed') return
      if (!attempt.loginId) { attempt.early.push(params); return }
      if (params?.loginId !== attempt.loginId) return
      if (params?.success !== true) {
        void this.finish(attempt, new Error(typeof params?.error === 'string' ? params.error : 'Codex 登录未成功'))
        return
      }
      if (attempt.loginSucceeded) return
      attempt.loginSucceeded = true
      log(`codex-login: authorization completed account=${accountId} authUpdated=${attempt.authUpdated}`)
      if (attempt.timer) clearTimeout(attempt.timer)
      // Completion reports the OAuth flow; account/updated is the app-server's auth-state barrier.
      // Reading immediately on completion can still see the pre-login cached null account.
      if (attempt.authUpdated) void this.finish(attempt)
      else attempt.timer = setTimeout(() => {
        void this.finish(attempt, new Error('设备码授权已完成，但 Codex 未及时更新账号状态；认证文件已保留，可用 codex-accounts 检查'))
      }, this.stateWaitMs)
    }
    attempt.closed = error => { void this.finish(attempt, error) }
    client.on('notification', attempt.notification)
    client.on('closed', attempt.closed)
    client.on('protocolError', attempt.closed)
    this.attempts.set(accountId, attempt)
    try {
      await client.initialize('lodestar-login')
      attempt.loginRequested = true
      const result = await client.request('account/login/start', { type: 'chatgptDeviceCode' }, 30_000)
      if (result?.type !== 'chatgptDeviceCode' || typeof result.loginId !== 'string' || !result.loginId
        || typeof result.userCode !== 'string' || !result.userCode || typeof result.verificationUrl !== 'string'
        || new URL(result.verificationUrl).protocol !== 'https:') throw new Error('Codex 设备码登录响应不完整')
      attempt.loginId = result.loginId
      if (attempt.finishing) { await done; throw new Error('登录已结束') }
      attempt.timer = setTimeout(() => { void this.cancelAttempt(attempt, '登录等待超过 15 分钟，请重新发送 codex-login [备注]').catch(() => {}) }, this.waitMs)
      for (const params of attempt.early) attempt.notification('account/login/completed', params)
      attempt.early.length = 0
      return { accountId, loginId: result.loginId, verificationUrl: result.verificationUrl, userCode: result.userCode, done }
    } catch (error) {
      await this.finish(attempt, asError(error))
      return await done as never
    }
  }

  pending(owner: CodexLoginOwner): string[] {
    return [...this.attempts.values()].filter(a => a.owner.chatId === owner.chatId && a.owner.userOpenId === owner.userOpenId)
      .map(a => a.accountId)
  }
  async cancel(accountId: string, owner: CodexLoginOwner): Promise<void> {
    const attempt = this.attempts.get(accountId)
    if (!attempt) throw new Error('该账号没有等待中的登录')
    if (!owner.userOpenId || owner.chatId !== attempt.owner.chatId || owner.userOpenId !== attempt.owner.userOpenId) {
      throw new Error('只有发起登录的用户可在原群取消')
    }
    if (attempt.finishing) throw new Error('登录正在收尾，请等待结果')
    await this.cancelAttempt(attempt, '登录已取消')
  }

  private async cancelAttempt(attempt: Attempt, reason: string): Promise<void> {
    if (attempt.finishing) return
    // Mark terminal before cancel RPC: its completion notification can arrive before the response.
    attempt.finishing = true
    let failure = new Error(reason)
    if (attempt.loginId && attempt.client.isAlive()) {
      try { await attempt.client.request('account/login/cancel', { loginId: attempt.loginId }) }
      catch (error) { failure = new Error(`${reason}；取消请求失败：${asError(error).message}`) }
    }
    await this.complete(attempt, failure)
  }
  private async finish(attempt: Attempt, error?: Error): Promise<void> {
    if (attempt.finishing) return
    attempt.finishing = true
    if (attempt.timer) clearTimeout(attempt.timer)
    let account: CodexLoginAccount | undefined
    if (!error) {
      try {
        const response = await attempt.client.request('account/read', { refreshToken: false })
        if (response?.account?.type !== 'chatgpt') {
          const type = typeof response?.account?.type === 'string' ? response.account.type : 'null'
          throw new Error(`设备码授权已完成，但账号状态校验失败（account/read.type=${type}）；认证文件已保留`)
        }
        account = response.account
        this.recordLogin(attempt.accountId, account!)
      } catch (cause) { error = asError(cause) }
    }
    await this.complete(attempt, error, account)
  }
  private async complete(attempt: Attempt, error?: Error, account?: CodexLoginAccount): Promise<void> {
    if (attempt.timer) clearTimeout(attempt.timer)
    attempt.client.off('notification', attempt.notification)
    attempt.client.off('closed', attempt.closed)
    attempt.client.off('protocolError', attempt.closed)
    try { await attempt.client.close() }
    catch (cause) { error = new Error([error?.message, `登录进程关闭失败：${asError(cause).message}`].filter(Boolean).join('；')) }
    // Never permit a second writer while a failed-to-close login process is still alive.
    if (!attempt.client.isAlive()) {
      this.attempts.delete(attempt.accountId)
      attempt.releaseAuth()
    }
    if (error) attempt.reject(error)
    else if (account) attempt.resolve(account)
    else attempt.reject(new Error('登录结束但账号信息缺失'))
  }
  async shutdown(): Promise<void> {
    this.stopping = true
    const results = await Promise.allSettled([...this.attempts.values()].map(async attempt => {
      await this.cancelAttempt(attempt, '服务退出，登录已取消')
      if (attempt.client.isAlive()) await attempt.client.close()
      if (attempt.client.isAlive()) throw new Error('登录进程仍未退出')
      attempt.releaseAuth()
      this.attempts.delete(attempt.accountId)
      // The original receipt observes login errors; shutdown waits for its terminal bookkeeping.
      await attempt.done.then(() => {}, () => {})
    }))
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason)
    if (failures.length) throw new AggregateError(failures, 'Codex 登录进程未完全退出')
  }
}
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)) }
export const codexLogins = new CodexLogins()
