import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { codexAccounts } from './codex-accounts'
import { CODEX_REASONING_EFFORTS, type CodexReasoningEffort } from './codex-process'
import { codexQuotaMeter, rankCodexQuota, unusedCodexWeek } from './codex-quota'
import { networkFetch } from './network'
import type { TokenSource } from './token-source'
import { AppServerOnce, invalidateCodexUsage, refreshUsageFromConnection, requestCodexControlWithRetry,
  snapshotFromReadResponse, type UsageSnapshot } from './usage'

// Standard-speed credit rates: https://learn.chatgpt.com/docs/pricing#token-rates (2026-09-27).
// Require the cheapest model explicitly; never silently substitute a more expensive model.
export const CODEX_ACTIVATION_MODEL = 'gpt-6-luna'
export type CodexActivationUsage = Extract<UsageSnapshot, { state: 'ok' }>
type Client = Pick<AppServerOnce, 'initialize' | 'request' | 'close'>
interface Credentials { accessToken: string; accountId: string }

export function activationEffort(source: TokenSource | undefined): CodexReasoningEffort {
  if (!source?.enabled || source.kind !== 'codex-subscription' || source.modelCatalogState?.status !== 'ready') {
    throw new Error(`后台激活模型目录 MISS：${source?.modelCatalogState?.error ?? '订阅目录未就绪'}`)
  }
  const entry = (source.modelSelection?.availableModels ?? source.models)
    .find(model => model.model === CODEX_ACTIVATION_MODEL && model.origin !== 'custom')
  if (!entry || entry.unavailableReason) throw new Error(`后台激活需要 ${CODEX_ACTIVATION_MODEL}：${entry?.unavailableReason ?? '原生目录未提供'}`)
  const effort = CODEX_REASONING_EFFORTS.find(value => entry.efforts.includes(value))
  if (!effort) throw new Error(`${CODEX_ACTIVATION_MODEL} 推理档位 MISS`)
  return effort
}

/** No conversation, tools, project instructions, session headers or service-tier inheritance. */
export function activationBody(effort: CodexReasoningEffort) {
  return { model: CODEX_ACTIVATION_MODEL, instructions: '', store: false, stream: true,
    input: [{ role: 'user', content: [{ type: 'input_text', text: '你好，只回复“你好”。' }] }],
    tools: [], tool_choice: 'none', parallel_tool_calls: false,
    reasoning: { effort }, text: { verbosity: 'low' }, service_tier: 'default' }
}

export function isUnusedMainWeek(usage: CodexActivationUsage): boolean {
  const rank = rankCodexQuota(usage, '')
  return !!usage.defaultLimitId
    && (usage.fiveHour === null || usage.fiveHour.percent === 0)
    && unusedCodexWeek(usage, '')
    && rank.state === 'ready' && rank.funding !== 'credits'
}

async function credentialsFromNativeFile(accountId: string): Promise<Credentials> {
  let raw: string
  try { raw = await readFile(join(codexAccounts.home(accountId), 'auth.json'), 'utf8') }
  catch (error) { throw new Error(`后台激活无法读取原生 auth.json：${(error as NodeJS.ErrnoException).code ?? '读取失败'}`) }
  let auth: any
  try { auth = JSON.parse(raw) }
  catch { throw new Error('后台激活的原生 auth.json 不是有效 JSON') }
  if (auth?.auth_mode !== 'chatgpt' || typeof auth.tokens?.access_token !== 'string' || !auth.tokens.access_token
    || typeof auth.tokens.account_id !== 'string' || !auth.tokens.account_id) {
    throw new Error('后台激活的原生 ChatGPT 文件登录态无效')
  }
  return { accessToken: auth.tokens.access_token, accountId: auth.tokens.account_id }
}

/** Match the native ChatGPT base URL; never switch an unavailable route to another host. */
function responsesUrl(base: unknown): string {
  if (typeof base !== 'string' || !base) throw new Error('原生 chatgpt_base_url MISS')
  const url = new URL(base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('原生 chatgpt_base_url 格式无效')
  }
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/codex/responses') ? path : path.endsWith('/codex') ? `${path}/responses` : `${path}/codex/responses`
  return url.href
}

/** A completed response with actual billed tokens is required; EOF, [DONE] and HTTP 200 aren't success. */
export async function readActivationResponse(response: Response, onUsage?: (tokens: number) => void): Promise<number> {
  if (!response.ok) throw new Error(`后台激活 HTTP ${response.status}：${await response.text()}`)
  if (!response.body) throw new Error('后台激活响应缺少事件流')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', event = ''
  let failure: unknown
  const parseEvent = (): number | undefined => {
    const data = event; event = ''
    if (!data || data.trim() === '[DONE]') return
    let value: any
    try { value = JSON.parse(data) } catch { throw new Error('后台激活返回无效 JSON 事件') }
    if (value.type === 'error' || ['response.failed', 'response.incomplete'].includes(value.type)) {
      throw new Error(`后台激活失败：${value.error?.message ?? value.response?.error?.message ?? value.message ?? value.type}`)
    }
    if (!['response.completed', 'response.done'].includes(value.type)) return
    if (value.response?.status !== 'completed') throw new Error(`后台激活终态异常：${value.response?.status ?? 'MISS'}`)
    const tokens = value.response?.usage?.total_tokens
    if (!Number.isFinite(tokens) || tokens <= 0) throw new Error('后台激活已结束，但真实 token 用量 MISS')
    return tokens
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (buffer.length + event.length > 1_000_000) throw new Error('后台激活响应事件超过大小限制')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) event += `${line.slice(5).trimStart()}\n`
        else if (!line) {
          const tokens = parseEvent()
          if (tokens !== undefined) { onUsage?.(tokens); return tokens }
        }
      }
      if (done) throw new Error('后台激活连接在确认成功前结束')
    }
  } catch (error) { failure = error; throw error }
  finally {
    try { await reader.cancel() }
    catch (error) {
      if (failure) throw new AggregateError([failure, error], `${String(failure)}；响应流关闭失败：${error}`)
      throw error
    } finally { reader.releaseLock() }
  }
}

export interface ActivationRequestOptions {
  accountId: string
  identity: string
  effort: CodexReasoningEffort
  signal: AbortSignal
  /** Recheck local account revision and real foreground usage immediately before the POST. */
  eligible(usage: CodexActivationUsage): boolean
  used(usage: CodexActivationUsage, tokens: number): void
}
export interface ActivationRequestDeps {
  createClient(id: string): Client
  credentials(id: string): Promise<Credentials>
  fetch: typeof networkFetch
  refresh(client: Client, id: string): Promise<UsageSnapshot | null>
}
const ownedClients = new Map<string, AppServerOnce>()

/** Failed closes remain owned and prevent another activation process for that account. */
export async function closeCodexActivationClients(): Promise<void> {
  const results = await Promise.allSettled([...ownedClients.values()].map(client => client.close()))
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
  if (errors.length) throw new AggregateError(errors, `后台激活连接未全部退出：${errors.map(String).join('；')}`)
}

const defaults: ActivationRequestDeps = {
  createClient: id => {
    if (ownedClients.has(id)) throw new Error('该账号上次后台激活连接尚未退出')
    const client = new AppServerOnce({ accountId: id })
    ownedClients.set(id, client)
    client.once('exit', () => { if (ownedClients.get(id) === client) ownedClients.delete(id) })
    return client
  }, credentials: credentialsFromNativeFile, fetch: networkFetch,
  refresh: (client, id) => {
    invalidateCodexUsage(id)
    return refreshUsageFromConnection((method, params) => client.request(method, params), id)
  },
}

/** One bounded request using native-refreshed subscription auth. No thread/turn is created. */
export async function activateCodexAccount(opts: ActivationRequestOptions, deps = defaults): Promise<'sent' | 'skipped'> {
  opts.signal.throwIfAborted()
  const app = deps.createClient(opts.accountId)
  const controller = new AbortController()
  const abort = () => controller.abort(opts.signal.reason)
  opts.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('后台激活请求超过 60 秒')), 60_000)
  let token: string | undefined
  let failure: unknown
  let confirmed = false
  try {
    await app.initialize('lodestar-codex-activation')
    const config = (await app.request('config/read', {}))?.config
    // Keyring tokens cannot be exported through the native protocol. Do not copy credentials or change its store.
    if (config?.cli_auth_credentials_store !== 'file') {
      throw new Error('零上下文后台激活需要原生文件登录态；当前凭据存储不支持，普通 Codex 会话仍可使用')
    }
    const url = responsesUrl(config.chatgpt_base_url)
    const account = (await app.request('account/read', { refreshToken: true }))?.account
    if (account?.type !== 'chatgpt') throw new Error('后台激活账号未登录 ChatGPT 订阅')
    const credentials = await deps.credentials(opts.accountId)
    token = credentials.accessToken
    controller.signal.throwIfAborted()
    // This deliberately bypasses the one-minute quota cache, including other in-flight reads.
    let readStartedAt = 0
    const raw = await requestCodexControlWithRetry(() => {
      controller.signal.throwIfAborted()
      readStartedAt = Date.now()
      return app.request('account/rateLimits/read', {})
    }, '激活前额度确认')
    const usage = snapshotFromReadResponse(raw, account.planType, readStartedAt)
    if (usage.state !== 'ok') throw new Error(`激活前额度 MISS：${usage.state === 'network' ? usage.reason : usage.state}`)
    const credentialIdentity = createHash('sha256').update(credentials.accountId).digest('hex')
    if (!usage.accountFingerprint || usage.accountFingerprint !== opts.identity || usage.accountFingerprint !== credentialIdentity) {
      throw new Error('后台激活账号身份与最新额度不一致')
    }
    controller.signal.throwIfAborted()
    if (isUnusedMainWeek(usage) && opts.eligible(usage)) {
      if (codexQuotaMeter(usage, CODEX_ACTIVATION_MODEL) !== usage.defaultLimitId) {
        throw new Error(`${CODEX_ACTIVATION_MODEL} 被分配到独立额度，不能用于激活主额度`)
      }
      const response = await deps.fetch(url, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, 'chatgpt-account-id': credentials.accountId,
          'content-type': 'application/json', accept: 'text/event-stream', 'OpenAI-Beta': 'responses=experimental',
          originator: 'lodestar', 'user-agent': 'lodestar-codex-activation' },
        body: JSON.stringify(activationBody(opts.effort)) })
      // Preserve confirmed use even when the subsequent quota refresh or process close fails.
      await readActivationResponse(response, tokens => { confirmed = true; opts.used(usage, tokens) })
      controller.signal.throwIfAborted()
      const refreshed = await deps.refresh(app, opts.accountId)
      if (refreshed?.state !== 'ok') throw new Error(`额度复核 MISS：${refreshed?.state === 'network' ? refreshed.reason : refreshed?.state ?? '读取失败'}`)
    }
  } catch (error) {
    // An upstream/proxy error may echo request data. Tokens never enter logs or UI.
    const message = error instanceof Error ? error.message : String(error)
    const redacted = token ? message.split(token).join('[REDACTED]') : message
    failure = new Error(`${confirmed ? '后台激活请求已成功；' : ''}${redacted.slice(0, 2000)}`)
  }
  clearTimeout(timer)
  opts.signal.removeEventListener('abort', abort)
  try { await app.close() }
  catch (error) { failure = new AggregateError(failure ? [failure, error] : [error], `${failure ? `${String(failure)}；` : confirmed ? '后台激活请求已成功；' : ''}后台激活控制连接关闭失败：${error}`) }
  if (failure) throw failure
  return confirmed ? 'sent' : 'skipped'
}
