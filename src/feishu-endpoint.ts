/**
 * Feishu (mainland) vs Lark (international) Open Platform endpoints.
 *
 * `[feishu].domain` selects the cloud: omitted/`feishu` keeps the mainland
 * host (the historical default and byte-identical URLs), `lark` switches to
 * `open.larksuite.com`, and an `https://…` origin supports private/custom
 * deployments. This module deliberately has no dependencies so the setup
 * wizard can use it before `config.ts` exists.
 */

export const FEISHU_API_BASE = 'https://open.feishu.cn'
export const LARK_API_BASE = 'https://open.larksuite.com'

/**
 * Validate and normalize a configured domain. `undefined` means the default
 * 飞书 host; named regions stay as-is; custom values must be a bare https origin.
 */
export function normalizeDomain(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const raw = value.trim()
  if (!raw) {
    throw new Error('lodestar: [feishu].domain must be "feishu", "lark" or an https base URL such as "https://open.feishu.cn"')
  }
  if (raw === 'feishu' || raw === 'lark') return raw
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`lodestar: [feishu].domain is not a valid URL: "${raw}"`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`lodestar: [feishu].domain must be an https origin without path, credentials, query or fragment: "${raw}"`)
  }
  return url.origin
}

/** Open Platform host (no `/open-apis` suffix). */
export function apiBaseFor(domain: string | undefined): string {
  if (domain === 'lark') return LARK_API_BASE
  if (domain && domain !== 'feishu') return domain
  return FEISHU_API_BASE
}

/** Base for REST calls: `https://open.feishu.cn/open-apis`. */
export function openApiBaseFor(domain: string | undefined): string {
  return `${apiBaseFor(domain)}/open-apis`
}

/** Developer console for the install guide. Custom origins fall back to 飞书. */
export function consoleBaseFor(domain: string | undefined): string {
  return apiBaseFor(domain)
}
