import { networkFetch } from './network'
/**
 * 模型存在性校验 —— 用户面板输入列表外模型名时验证真伪,零猜测。
 *
 * 判别(anthropic 兼容端点实测):小请求(max_tokens=1)打 /v1/messages,
 *   存在   → HTTP 200(模型在服务端真实可用)
 *   不存在 → HTTP 400 + code 1214「modelCode不存在」
 * 其余状态码(401 凭据问题 / 5xx / 网络失败)= 无结论,如实返回 'no_verdict',
 * 调用方不猜。校验通过的模型由调用方补进列表并持久化(config models 键)。
 */

import { log } from './log'

const VERIFY_TIMEOUT_MS = 15_000

export type ModelExistence = 'exists' | 'not_found' | 'no_verdict'

/** 从 base_url 拼 messages 端点(沿 base path 前缀,不硬编码 host 布局)。 */
function messagesUrl(baseUrl: string): string {
  const u = new URL(baseUrl)
  const path = u.pathname.replace(/\/+$/, '')
  return `${u.protocol}//${u.host}${path}/v1/messages`
}

/** 校验模型存在性。authHeader 调用方给(GLM Bearer / deepseek x-api-key 不同)。 */
export async function verifyModelExists(
  baseUrl: string,
  authHeaders: Record<string, string>,
  model: string,
): Promise<ModelExistence> {
  try {
    const res = await networkFetch(messagesUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
    if (res.ok) return 'exists'
    if (res.status === 400) {
      const text = await res.text()
      return text.includes('1214') || text.includes('不存在') || text.includes('not exist')
        ? 'not_found'
        : 'no_verdict'
    }
    log(`model-existence: ${model} HTTP ${res.status}, no verdict`)
    return 'no_verdict'
  } catch (e: any) {
    log(`model-existence: ${model} MISS (${e?.message ?? e})`)
    return 'no_verdict'
  }
}
