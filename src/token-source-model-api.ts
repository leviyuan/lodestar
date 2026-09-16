import { networkFetch } from './network'
import { tokenSourceErrorMessage } from './token-source-errors'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fieldText(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

/** 部分兼容入口以 HTTP 200 返回业务错误，必须先检查正文再读 data。 */
export async function fetchApiModelData(url: string, token: string, label: string): Promise<Record<string, unknown>[]> {
  try {
    if (!token.trim()) throw new Error(`${label}: 请填写 API Key`)
    return await requestModelData(url, token, label)
  } catch (error) {
    throw new Error(tokenSourceErrorMessage(error, [token]))
  }
}

async function requestModelData(url: string, token: string, label: string): Promise<Record<string, unknown>[]> {
  const response = await networkFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} HTTP ${response.status}: 响应不是有效 JSON`, { cause: error })
  }
  const body = object(payload) ? payload : undefined
  const error = object(body?.error) ? body.error : undefined
  const code = fieldText(error?.code ?? error?.type ?? body?.code)
  const message = fieldText(error?.message ?? body?.msg ?? body?.message ?? body?.error)
  const failed = body?.success === false || body?.error != null
    || (code !== undefined && code !== '0' && code !== '200')
  if (!response.ok || failed) {
    const detail = [code !== undefined ? `code=${code}` : '', message].filter(Boolean).join(': ')
    const reason = `${label} HTTP ${response.status}${detail ? `: ${detail}` : ''}`
    throw new Error(token ? reason.replaceAll(token, '[redacted]') : reason)
  }
  if (!Array.isArray(body?.data)) throw new Error(`${label} 缺少 data 数组`)
  if (!body.data.length) throw new Error(`${label} 模型目录为空`)
  if (!body.data.every(object)) throw new Error(`${label} 模型目录包含无效条目`)
  return body.data
}
