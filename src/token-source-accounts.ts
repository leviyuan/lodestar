import type { TokenSourceConfig } from './config'
import { glmAnthropicBaseUrl } from './glm-models'

type Configs = Record<string, TokenSourceConfig>
const SHARED_ACCOUNTS = [
  { id: 'deepseek', other: 'deepseek-harness', base: 'https://api.deepseek.com/anthropic' },
  { id: 'glm', other: 'dsh-glm', base: 'https://open.bigmodel.cn/api/anthropic' },
] as const
type SharedAccount = typeof SHARED_ACCOUNTS[number]

export function sharedAccountId(sourceId: string): string {
  return SHARED_ACCOUNTS.find(group => group.other === sourceId)?.id ?? sourceId
}

export function sharedAccountSourceIds(sourceId: string): string[] {
  const group = SHARED_ACCOUNTS.find(group => group.id === sourceId || group.other === sourceId)
  return group ? [group.id, group.other] : [sourceId]
}

function credential(config: TokenSourceConfig): string | undefined {
  const api = config.api_key?.trim(), auth = config.auth_token?.trim()
  if (api && auth && api !== auth) throw new Error('同一账号的 api_key 与 auth_token 不一致，请重新配置')
  return api || auth
}

/** Canonical config retains the Claude endpoint; the Harness view derives its protocol endpoint. */
function accountBase(group: SharedAccount, raw: string): string {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${group.id} 接口地址必须是无凭据、查询参数和 fragment 的 HTTP(S) 地址`)
  }
  if (group.id === 'glm') return glmAnthropicBaseUrl(`${url.origin}/api/anthropic`)
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (url.hostname === 'api.deepseek.com' && ['/', '/v1'].includes(url.pathname)) url.pathname = '/anthropic'
  return url.toString().replace(/\/+$/, '')
}

function accountEndpoint(group: SharedAccount, raw: string): string {
  const base = accountBase(group, raw)
  return group.id === 'deepseek' ? base.replace(/\/anthropic$/, '') : base
}

function withoutCredentials(config: TokenSourceConfig): TokenSourceConfig {
  const { api_key: _api, auth_token: _auth, base_url: _base, ...rest } = config
  return rest
}

function accountCredentials(group: SharedAccount, configs: Configs, detected: Configs = {}): { key?: string; base: string } {
  const primary = configs[group.id] ?? {}, other = configs[group.other] ?? {}
  const primaryKey = credential(primary), otherKey = credential(other)
  const primaryBase = primary.base_url?.trim(), otherBase = other.base_url?.trim()
  if ((primaryKey && otherKey && primaryKey !== otherKey)
    || (primaryBase && otherBase && accountEndpoint(group, primaryBase) !== accountEndpoint(group, otherBase))) {
    throw new Error(`${group.id} 与 ${group.other} 的旧账号配置冲突；请用 ${group.id}-setup 重新设置共享账号`)
  }
  if (primaryKey || otherKey) return { key: primaryKey || otherKey, base: accountBase(group, primaryBase || otherBase || group.base) }
  const imported = detected[group.id] ?? detected[group.other] ?? {}
  if (credential(imported) && (primaryBase || otherBase) && imported.base_url
    && accountEndpoint(group, primaryBase || otherBase!) !== accountEndpoint(group, imported.base_url)) {
    throw new Error(`${group.id} 的平台地址与本机识别的账号不一致，请用 ${group.id}-setup 配置 Key`)
  }
  return { key: credential(imported), base: accountBase(group, primaryBase || otherBase || imported.base_url || group.base) }
}

/** Both Agent views share credentials; model, effort, visibility and runtime settings stay per Agent. */
export function sharedTokenSourceConfigs(configs: Configs, detected: Configs = {}): Configs {
  const result = { ...configs }
  for (const group of SHARED_ACCOUNTS) {
    const { key, base } = accountCredentials(group, configs, detected)
    result[group.id] = { ...withoutCredentials(configs[group.id] ?? {}), base_url: base,
      ...(group.id === 'glm' ? { auth_token: key ?? '' } : { api_key: key ?? '' }) }
    result[group.other] = { ...withoutCredentials(configs[group.other] ?? {}), api_key: key ?? '',
      base_url: group.id === 'glm' ? `${new URL(base).origin}/api/coding/paas/v4` : base.replace(/\/anthropic$/, '') }
  }
  return result
}

/** One atomic config edit stores a shared credential once, including edits via legacy setup aliases. */
export function tokenSourceConfigUpdates(configs: Configs, id: string, update: TokenSourceConfig): Configs {
  const incoming = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined))
  const next = { ...configs, [id]: { ...configs[id], ...incoming } }
  const group = SHARED_ACCOUNTS.find(group => group.id === id || group.other === id)
  if (!group) return { [id]: next[id] }
  const editingKey = update.api_key !== undefined || update.auth_token !== undefined
  const editingBase = update.base_url !== undefined
  if (editingKey || editingBase) {
    const old = configs[id] ?? {}, primary = configs[group.id] ?? {}, other = configs[group.other] ?? {}
    const key = editingKey ? credential(update) : accountCredentials(group, configs).key
    const base = accountBase(group, update.base_url?.trim() || old.base_url || primary.base_url || other.base_url || group.base)
    next[group.id] = { ...withoutCredentials(next[group.id] ?? {}), base_url: base,
      ...(group.id === 'glm' ? { auth_token: key ?? '' } : { api_key: key ?? '' }) }
    next[group.other] = withoutCredentials(next[group.other] ?? {})
  } else {
    const { key, base } = accountCredentials(group, next)
    next[group.id] = { ...withoutCredentials(next[group.id] ?? {}), base_url: base,
      ...(group.id === 'glm' ? { auth_token: key ?? '' } : { api_key: key ?? '' }) }
    next[group.other] = withoutCredentials(next[group.other] ?? {})
  }
  return { [group.id]: next[group.id], [group.other]: next[group.other] }
}
