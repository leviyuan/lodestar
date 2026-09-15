import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config'
import { loadClaudeSdk } from './agent-updates'
import { localFetch } from './network'
import { RECLAUDE_WATCH_DIR } from './paths'
import { writeJsonStateAtomic } from './state-store'
import { createReclaudeSource } from './token-source-reclaude'
import type { EffortLevel, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

export interface ReclaudeProbeResult {
  output: string
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
}

interface WatchState {
  version: 1
  project: string
  model: string
  attempts: number
  lastAttemptAt?: string
  lastError?: string
  recovered?: ReclaudeProbeResult & { at: string }
  notificationError?: string
  notified?: { at: string; messageId: string }
}

export function reclaudeWatchStatePath(project: string, model: string): string {
  const id = createHash('sha256').update(JSON.stringify([project, model])).digest('hex').slice(0, 24)
  return join(RECLAUDE_WATCH_DIR, `${id}.json`)
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b(?:rck_|sk[-_])[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 2000)
}

export class ReclaudeRecoveryWatch {
  private state: WatchState

  constructor(private readonly options: {
    project: string
    model: string
    file: string
    probe: () => Promise<ReclaudeProbeResult>
    notify: (recovered: ReclaudeProbeResult & { at: string }) => Promise<string>
    log: (message: string) => void
    signal?: AbortSignal
  }) {
    if (existsSync(options.file)) {
      const saved = JSON.parse(readFileSync(options.file, 'utf8')) as WatchState
      if (saved?.version !== 1 || saved.project !== options.project || saved.model !== options.model
        || !Number.isInteger(saved.attempts) || saved.attempts < 0
        || (saved.recovered !== undefined && (!saved.recovered?.output?.trim() || !Number.isFinite(Date.parse(saved.recovered.at))))
        || (saved.notified !== undefined && (!saved.recovered || !saved.notified?.messageId?.trim()))) {
        throw new Error('ReClaude 检测状态损坏或目标不匹配，不能重新发起可能计费的探测')
      }
      this.state = saved
    } else {
      this.state = { version: 1, project: options.project, model: options.model, attempts: 0 }
    }
  }

  private save(): void { writeJsonStateAtomic(this.options.file, this.state) }

  /** 一次实际对话成功后先持久化，再通知；通知失败和进程重启都只补发通知。 */
  async step(): Promise<'waiting' | 'notify_pending' | 'done'> {
    const { options } = this
    options.signal?.throwIfAborted()
    if (this.state.notified) return 'done'
    if (!this.state.recovered) {
      this.state.attempts++
      this.state.lastAttemptAt = new Date().toISOString()
      this.save()
      let result: ReclaudeProbeResult
      try {
        result = await options.probe()
        if (!result.output.trim()) throw new Error('模型返回成功但没有正文，恢复尚未确认')
      } catch (error) {
        options.signal?.throwIfAborted()
        this.state.lastError = errorText(error)
        this.save()
        options.log(`第 ${this.state.attempts} 次检测失败：${this.state.lastError}`)
        return 'waiting'
      }
      this.state.recovered = { ...result, at: new Date().toISOString() }
      delete this.state.lastError
      this.save()
      options.log(`第 ${this.state.attempts} 次检测确认 ${this.state.model} 恢复；停止模型探测，准备通知`)
    }
    let messageId: string
    try {
      messageId = await options.notify(this.state.recovered)
      if (!messageId.trim()) throw new Error('通知未返回消息 ID')
    } catch (error) {
      this.state.notificationError = errorText(error)
      this.save()
      options.log(`恢复通知未确认：${this.state.notificationError}；后续只重试通知`)
      return 'notify_pending'
    }
    this.state.notified = { at: new Date().toISOString(), messageId }
    delete this.state.notificationError
    this.save()
    options.log(`恢复通知已发送：${messageId}；检测服务退出`)
    return 'done'
  }
}

/** 使用同一 ReClaude 来源的原生 SDK，禁用工具、MCP、历史落盘和会话标题生成。 */
export async function probeReclaudeModel(model: string, workDir: string, signal: AbortSignal): Promise<ReclaudeProbeResult> {
  signal.throwIfAborted()
  const cfg = loadConfig().token_sources.reclaude
  if (cfg?.auth !== 'reclaude-login') throw new Error('ReClaude 来源未启用')
  const source = createReclaudeSource(cfg)
  await source.refreshModels()
  signal.throwIfAborted()
  if (source.modelCatalogState?.status !== 'ready') throw new Error(source.modelCatalogState?.error ?? 'ReClaude 模型目录未就绪')
  const entry = source.models.find(item => item.model === model)
  if (!entry?.defaultEffort) throw new Error(`ReClaude 模型或默认 effort 不可用：${model}`)
  const env = source.spawnEnv({ ...process.env, CLAUDE_CODE_MAX_RETRIES: '0' })
  const settings = source.claudeSettings
  if (entry.defaultEffort === 'default') {
    env.CLAUDE_CODE_EFFORT_LEVEL = 'unset'
    if (settings?.env) settings.env.CLAUDE_CODE_EFFORT_LEVEL = 'unset'
  }
  const { query } = await loadClaudeSdk()
  signal.throwIfAborted()
  mkdirSync(workDir, { recursive: true, mode: 0o700 })
  const abortController = new AbortController()
  const onAbort = () => abortController.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => abortController.abort(new Error('ReClaude 检测请求超过 60 秒')), 60_000)
  let q: ReturnType<typeof query> | undefined
  let result: SDKResultMessage | undefined
  let failure: unknown
  try {
    q = query({ prompt: 'Reply exactly RECLAUDE_OK.', options: {
      cwd: workDir, model,
      ...(entry.defaultEffort !== 'default' ? { effort: entry.defaultEffort as EffortLevel } : {}),
      env, settings, settingSources: [], tools: [], mcpServers: {}, strictMcpConfig: true,
      systemPrompt: 'This is a connectivity check. Answer the user briefly.',
      title: 'ReClaude recovery check', persistSession: false, maxTurns: 1,
      abortController,
    } })
    for await (const message of q) if (message.type === 'result') result = message
  } catch (error) { failure = error }
  finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
    try { q?.close() }
    catch (error) { failure = new Error([failure && errorText(failure), `检测进程关闭失败：${errorText(error)}`].filter(Boolean).join('；')) }
  }
  signal.throwIfAborted()
  if (failure) throw new Error(errorText(failure))
  if (!result || result.is_error || result.subtype !== 'success') {
    throw new Error(result && 'errors' in result ? result.errors.join('；') : 'ReClaude 未返回成功的对话结果')
  }
  if (!result.result.trim()) throw new Error('ReClaude 对话结果为空')
  return {
    output: result.result.trim(),
    costUsd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
    inputTokens: Number.isFinite(result.usage.input_tokens) ? result.usage.input_tokens : null,
    outputTokens: Number.isFinite(result.usage.output_tokens) ? result.usage.output_tokens : null,
  }
}

/** feishu-notify：回执确认后才退出；绝不把通知失败解释成模型再次故障。 */
export async function notifyReclaudeRecovery(project: string, model: string,
  result: ReclaudeProbeResult & { at: string }, signal: AbortSignal): Promise<string> {
  const port = loadConfig().notify.port
  const response = await localFetch(`http://127.0.0.1:${port}/notify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, title: 'ReClaude 已恢复', level: 'info', text: [
      `**ReClaude 的 ${model} 实际对话已成功。**`,
      `检测时间：${result.at}`,
      '恢复检测可能产生少量模型用量，已停止继续探测，可以继续验证 ReClaude 的使用。',
      result.costUsd === null ? 'SDK 未提供本次用量费用。' : `本次 SDK 报告用量折算：$${result.costUsd.toFixed(6)}（实际拼车额度以 ReClaude 为准）。`,
    ].join('\n\n') }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  })
  if (!response.ok) throw new Error(`本机通知接口 HTTP ${response.status}：${(await response.text()).slice(0, 500)}`)
  const body = await response.json()
  if (body?.ok !== true || typeof body.message_id !== 'string' || !body.message_id.trim()) throw new Error('本机通知接口没有返回有效投递回执')
  return body.message_id
}
