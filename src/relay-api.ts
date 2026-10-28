import { networkFetch } from './network'
import { tokenSourceErrorMessage } from './token-source-errors'

export type RelayProtocol = 'anthropic' | 'openai'

export interface RelayModelRecord {
  id: string
  display: string
  efforts?: string[]
  defaultEffort?: string
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function relayApiRoot(raw: string): string {
  let url: URL
  try { url = new URL(raw) }
  catch { throw new Error('中转站地址必须是无凭据、查询参数和 fragment 的 HTTP(S) 根地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('中转站地址必须是无凭据、查询参数和 fragment 的 HTTP(S) 根地址')
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  return url.toString().replace(/\/$/, '')
}

function modelRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (object(payload) && Array.isArray(payload.data)) return payload.data
  if (object(payload) && Array.isArray(payload.models)) return payload.models
  throw new Error('中转站模型目录缺少 data/models 数组')
}

function effortRows(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim()) as string[]
  if (object(value) && Array.isArray(value.supported_efforts)) {
    return value.supported_efforts.filter(item => typeof item === 'string' && item.trim()) as string[]
  }
  return undefined
}

/** Read an OpenAI/Anthropic-compatible model catalog. The selected protocol
 * controls only the address normalization; model ids are preserved verbatim. */
export async function fetchRelayModels(base: string, key: string, protocol: RelayProtocol): Promise<RelayModelRecord[]> {
  if (!key.trim()) throw new Error('中转站 API Key 缺失')
  const root = relayApiRoot(base)
  const response = await networkFetch(`${root}/v1/models`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  let payload: unknown
  try { payload = JSON.parse(text) }
  catch { throw new Error(`中转站 ${protocol} 模型目录 HTTP ${response.status}: 响应不是有效 JSON`) }
  if (!response.ok) {
    const message = object(payload) && typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`
    throw new Error(tokenSourceErrorMessage(new Error(message), [key]))
  }
  const rows = modelRows(payload)
  const seen = new Set<string>()
  const out: RelayModelRecord[] = []
  for (const row of rows) {
    if (!object(row) || typeof row.id !== 'string' || !row.id.trim()) throw new Error('中转站模型目录含无效模型 id')
    if (seen.has(row.id)) throw new Error(`中转站模型目录含重复模型: ${row.id}`)
    seen.add(row.id)
    const reasoning = object(row.reasoning) ? row.reasoning : undefined
    const efforts = effortRows(reasoning?.supported_efforts ?? row.supported_reasoning_efforts ?? row.reasoning_efforts)
    const defaultEffort = typeof reasoning?.default_effort === 'string' ? reasoning.default_effort
      : typeof row.default_reasoning_effort === 'string' ? row.default_reasoning_effort : undefined
    out.push({ id: row.id, display: typeof row.name === 'string' && row.name ? row.name
      : typeof row.display_name === 'string' && row.display_name ? row.display_name : row.id,
      ...(efforts ? { efforts: [...new Set(efforts)] } : {}), ...(defaultEffort ? { defaultEffort } : {}) })
  }
  if (!out.length) throw new Error('中转站模型目录为空')
  return out
}
