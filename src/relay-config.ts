import { readFileSync } from 'node:fs'
import { CONFIG_FILE } from './paths'
import { writeStateFileAtomic } from './state-store'
import { config, loadConfig, reloadTokenSources, type RelayConfig } from './config'
import { buildTokenSourcesFromConfig } from './token-source-builtins'
import { fetchRelayModels, relayApiRoot } from './relay-api'
import { listTokenSources, type TokenSource } from './token-source'

function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
}

function relayToToml(id: string, value: RelayConfig): string {
  const lines = [`[relay.${id}]`]
  const push = (key: string, item?: string) => { if (item !== undefined) lines.push(`${key} = "${esc(item)}"`) }
  if (value.enabled !== undefined) lines.push(`enabled = ${value.enabled}`)
  push('display', value.display)
  push('api_key', value.api_key)
  push('base_url', value.base_url)
  push('protocol', value.protocol)
  push('balance_script', value.balance_script)
  push('models', value.models)
  push('shown_models', value.shown_models)
  push('hidden_models', value.hidden_models)
  push('custom_models', value.custom_models)
  return lines.join('\n')
}

/** Persist one relay section while preserving every unrelated config section. */
export function saveRelayConfig(id: string, value: RelayConfig): void {
  if (!/^[\w.-]+$/.test(id)) throw new Error('中转站标识只能包含字母、数字、下划线、短横线和点')
  const existing = readFileSync(CONFIG_FILE, 'utf8')
  const lines = existing.split('\n')
  const header = `[relay.${id}]`
  let inSection = false
  const kept: string[] = []
  for (const line of lines) {
    const section = line.match(/^\s*(\[[^\]]+\])\s*(?:#.*)?$/)?.[1]
    if (section) inSection = section === header
    if (!inSection) kept.push(line)
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop()
  writeStateFileAtomic(CONFIG_FILE, kept.join('\n') + '\n\n' + relayToToml(id, value) + '\n')
}

/** Validate a relay endpoint without changing config or the live registry. */
export async function testRelay(value: RelayConfig) {
  const protocol = value.protocol?.trim().toLowerCase()
  if (protocol !== 'anthropic' && protocol !== 'openai') throw new Error('中转站类型必须是 anthropic 或 openai')
  if (!value.api_key?.trim()) throw new Error('中转站 API Key 不能为空')
  const base = relayApiRoot(value.base_url?.trim() ?? '')
  const models = await fetchRelayModels(base, value.api_key, protocol)
  return { base_url: base, protocol, models }
}

/** Validate a relay endpoint before writing its API key to disk. */
export async function configureRelay(id: string, value: RelayConfig): Promise<void> {
  const tested = await testRelay(value)
  const current = loadConfig().relays
  saveRelayConfig(id, { ...current[id], ...value, base_url: tested.base_url, protocol: tested.protocol })
  reloadTokenSources()
  buildTokenSourcesFromConfig()
}

export interface RelayReloadEntry {
  id: string
  siteId: string
  agent: string
  display: string
  enabled: boolean
  status: string
  models: string[]
  error?: string
}

function relayStatus(source: TokenSource): RelayReloadEntry {
  return {
    id: source.id, siteId: source.relaySiteId ?? '', agent: source.agent,
    display: source.display, enabled: source.enabled,
    status: source.modelCatalogState?.status ?? 'idle',
    models: source.models.map(model => model.model),
    ...(source.modelCatalogState?.error ? { error: source.modelCatalogState.error } : {}),
  }
}

/** Rebuild the in-memory registry and refresh only the requested relay views.
 * This is the no-daemon-restart path used by setup commands and Agent API. */
export async function reloadRelays(siteId?: string): Promise<RelayReloadEntry[]> {
  reloadTokenSources()
  buildTokenSourcesFromConfig()
  const sources = listTokenSources().filter(source => source.relaySiteId && (!siteId || source.relaySiteId === siteId))
  await Promise.allSettled(sources.map(source => source.refreshModels()))
  return sources.map(relayStatus)
}

export function configureRelayBalance(id: string, script: string): void {
  const current = loadConfig().relays
  const relay = current[id]
  if (!relay) throw new Error(`中转站不存在：${id}`)
  if (!script.trim()) throw new Error('余额脚本路径不能为空')
  saveRelayConfig(id, { ...relay, balance_script: script.trim() })
  reloadTokenSources()
  buildTokenSourcesFromConfig()
}

export function relayConfigs(): Record<string, RelayConfig> {
  return config.relays ?? {}
}
