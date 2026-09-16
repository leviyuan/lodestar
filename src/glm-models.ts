import { fetchApiModelData } from './token-source-model-api'

export const GLM_ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'

export function glmAnthropicBaseUrl(raw: string): string {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('GLM 接口地址无效，请使用 https://open.bigmodel.cn/api/anthropic 或 https://api.z.ai/api/anthropic') }
  if (url.protocol !== 'https:' || !['open.bigmodel.cn', 'dev.bigmodel.cn', 'api.z.ai'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '/api/anthropic') {
    throw new Error('GLM Claude Code 需要智谱或 Z.ai 的 /api/anthropic HTTPS 端点；Key 须与平台一致')
  }
  return url.toString().replace(/\/+$/, '')
}

/** 与运行时共用校验，安装向导不依赖 config.ts 或任何 Agent runtime。 */
export async function fetchGlmAnthropicModelIds(baseUrl: string, token: string): Promise<string[]> {
  const data = await fetchApiModelData(`${glmAnthropicBaseUrl(baseUrl)}/v1/models`, token, 'GLM models')
  return data.map(entry => {
    const id = typeof entry.display_name === 'string' && entry.display_name ? entry.display_name : entry.id
    if (typeof id !== 'string' || !id.trim()) throw new Error('GLM models 模型 id 无效')
    return id
  })
}
