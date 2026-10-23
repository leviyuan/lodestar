import { fetchGlmAnthropicModelIds } from './glm-models'
/**
 * Token source 模型列表拉取 —— 动态获取订阅真实模型,零写死。
 *
 * codex 订阅:app-server `model/list`(per-model effort、过滤 hidden)。
 * glm Coding Plan:anthropic 端点 `/v1/models`(返回 display_name + id + created_at)。
 * 失败都抛错 —— 调用方(refreshModels)按 MISS 留空 models,绝不假数据。
 */

import { AppServerOnce, requestCodexControlWithRetry } from './usage'
import type { TokenSourceModel } from './token-source'
import type { AgentReasoningEffort } from './agent-process'
import { homedir } from 'node:os'
import { logError } from './log'
import type { ClaudeSpawnOpts } from './claude-agent-process'
import { observeCodexAccountEmail } from './codex-account-info'
import { codexAccounts } from './codex-accounts'

const TIMEOUT_MS = 10_000

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
function codexEffort(e: unknown): AgentReasoningEffort | null {
  return typeof e === 'string' && (CODEX_EFFORTS as string[]).includes(e)
    ? e as AgentReasoningEffort
    : null
}

export const CLAUDE_EFFORTS: AgentReasoningEffort[] = ['max', 'xhigh', 'high', 'medium', 'low']

type NativeClaudeModelOptions = Pick<ClaudeSpawnOpts,
  'settingSources' | 'settings' | 'transformEnv' | 'validateAccount' | 'tokenSourceId'> & { acquireUse?(): () => void }

/** SDK 控制接口不发送用户输入；目录读取后关闭这个独立查询进程。 */
export async function fetchNativeClaudeModels(options: NativeClaudeModelOptions = {}): Promise<TokenSourceModel[]> {
  const { ClaudeAgentProcess } = await import('./claude-agent-process')
  const { acquireUse, ...spawn } = options
  const release = acquireUse?.()
  let proc: InstanceType<typeof ClaudeAgentProcess>
  try { proc = new ClaudeAgentProcess({ workDir: homedir(), effort: 'high',
    settingSources: ['user'], profile: { loadProjectMcp: false }, ...spawn, controlOnly: true }) }
  catch (error) { release?.(); throw error }
  if (release) proc.once('exit', release)
  proc.on('error', error => logError('claude model catalog failed', error))
  try {
    const catalog = await withTimeout(proc.listModels())
    if (!catalog.length) throw new Error('Claude SDK model catalog is empty')
    return catalog.map(model => ({ model: model.model.replace(/^claude:/, ''), display: model.displayName,
      efforts: model.supportedReasoningEfforts.map(item => item.reasoningEffort as AgentReasoningEffort),
      defaultEffort: model.defaultReasoningEffort as AgentReasoningEffort }))
  } finally {
    try { await proc.kill() }
    finally { if (!proc.isAlive()) release?.() }
  }
}

/** codex 订阅可用模型(app-server model/list),过滤 hidden,effort 用 per-model。 */
export async function fetchCodexModels(accountId = 'default'): Promise<TokenSourceModel[]> {
  const revision = codexAccounts.revision(accountId)
  const app = new AppServerOnce({ accountId })
  try {
    await app.initialize('lodestar-models')
    const account = await requestCodexControlWithRetry(() => app.request('account/read', { refreshToken: false }), '账号查询')
    observeCodexAccountEmail(accountId, account?.account, revision)
    if (account?.account?.type !== 'chatgpt') throw Object.assign(new Error('Codex 订阅未登录；发送 codex-login 或 codex-login 备注完成授权'), { code: 'CODEX_AUTH_MISSING' })
    const out: TokenSourceModel[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    do {
      const res = await requestCodexControlWithRetry(() => app.request('model/list', {
        cursor, limit: 100, includeHidden: false,
      }), '模型查询')
      if (!Array.isArray(res?.data)) throw new Error('Codex model/list 缺少 data 数组')
      for (const m of res.data) {
        if (!m || m.hidden || !m.id) continue
        const efforts = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
          .map((e: any) => codexEffort(e?.reasoningEffort))
          .filter((e: AgentReasoningEffort | null): e is AgentReasoningEffort => e !== null)
        if (!efforts.length) continue
        const defaultEffort = codexEffort(m.defaultReasoningEffort) ?? efforts[0]
        out.push({
          model: String(m.id),
          display: typeof m.displayName === 'string' && m.displayName ? String(m.displayName) : String(m.id),
          efforts,
          defaultEffort,
        })
      }
      const nextCursor = res.nextCursor
      if (nextCursor !== null && typeof nextCursor !== 'string') throw new Error('Codex model/list 返回无效 nextCursor')
      cursor = nextCursor || null
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error('Codex model/list 返回重复 nextCursor')
        seenCursors.add(cursor)
      }
    } while (cursor)
    if (!out.length) throw new Error('Codex model/list 未返回可用模型')
    return out
  } finally {
    await app.close()
  }
}

/** glm Coding Plan 可用模型(anthropic 端点 /v1/models)。用 display_name(端点接受的大写形式)。 */
export async function fetchGlmModels(baseUrl: string, token: string): Promise<TokenSourceModel[]> {
  const ids = await fetchGlmAnthropicModelIds(baseUrl, token)
  return ids.map(id => ({ model: id, display: id, efforts: CLAUDE_EFFORTS, defaultEffort: 'max' }))
}
