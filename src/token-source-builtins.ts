/** 加载各 Token Source factory，按配置和本机 Claude settings 构建账号目录。 */

import { createHash } from 'node:crypto'
import { config, type TokenSourceConfig } from './config'
import {
  registerTokenSource,
  resetTokenSourceRegistry,
  setDefaultTokenSource,
  tokenSourceFactories,
  listTokenSources,
} from './token-source'
import { readClaudeSettingsEnv } from './glm-usage'
import { withModelVisibility } from './token-source-visibility'
import { sharedTokenSourceConfigs } from './token-source-accounts'
import { cachedTokenSource, disposeCachedTokenSource } from './token-source-cache'

// provider 模块 —— import 即登记到 factory registry(副作用)。
import './token-source-codex'
import './token-source-glm'
import './token-source-native'
import './token-source-claude'
import './token-source-deepseek'
import './token-source-openrouter'
import './token-source-packy'
import './token-source-dsh'
import './token-source-dsh-glm'

/** 遍历已登记 factory 构建 source 实例,注册到 instance registry。
 *  daemon 启动调;飞书改 token source 配置后也可重调(热更新)。 */
export function buildTokenSourcesFromConfig(): number {
  const settingsEnv = readClaudeSettingsEnv()
  const detectedConfigs = Object.fromEntries(tokenSourceFactories().flatMap(def => {
    const detected = def.detect?.fromSettingsEnv(settingsEnv)
    return def.configSectionId && detected ? [[def.configSectionId, detected]] : []
  }))
  const sharedConfigs = sharedTokenSourceConfigs(config.token_sources ?? {}, detectedConfigs)
  const previous = new Map(listTokenSources().map(source => [source.id, source]))
  const definitions = tokenSourceFactories().map(def => {
    // config.token_sources ?? {}：防御 test 环境 mock.module('./config') 跨文件污染
    // (claude-agent-process.test mock 的 config 无 token_sources);生产 loadConfig 总返 record。
    const cfg = def.configSectionId ? (sharedConfigs[def.configSectionId] ?? {}) : {}
    // config.toml 没配时,若本机 settings.json 命中本 source 的 detect host,自动启用(凭据从 settings.json 取)
    const detected = def.configSectionId ? detectedConfigs[def.configSectionId] ?? null : null
    const create = () => {
      const source = withModelVisibility(def.build(cfg, detected), cfg)
      source.spawnRevision = tokenSourceSpawnRevision(def.kind, cfg, detected)
      return source
    }
    return { cfg, detected, create, initial: create() }
  })
  // native 的旧激活规则只看第三方来源；新增订阅探测不能改变本机配置通路。
  const hasClaudeSource = definitions.some(({ initial: s }) => s.agent === 'claude' && s.enabled
      && s.kind !== 'claude-native' && s.kind !== 'claude-subscription')
  const sources = definitions.map(({ cfg, detected, create, initial }) => {
    const build = () => {
      const source = create()
      if (source.kind === 'claude-native') {
        source.enabled = !hasClaudeSource
        source.modelCatalogState = { status: source.enabled ? 'idle' : 'disabled', updatedAt: Date.now() }
      }
      return source
    }
    const routing = (value: Partial<TokenSourceConfig> | null) => {
      const { display, model, effort, models, hidden_models, custom_models, slots, default: _default, ...identity } = value ?? {}
      return identity
    }
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex')
    const nativeEnabled = initial.kind === 'claude-native' ? !hasClaudeSource : undefined
    return cachedTokenSource(build, cfg,
      hash([initial.id, routing(cfg), routing(detected), nativeEnabled]),
      hash([cfg, detected, nativeEnabled]), previous.get(initial.id))
  })
  resetTokenSourceRegistry()
  for (const s of sources) registerTokenSource(s)
  for (const old of previous.values()) if (!sources.includes(old)) disposeCachedTokenSource(old)
  const configuredDefault = sources.find(s => s.enabled && config.token_sources?.[s.id]?.default === true)
  const defaultSource = configuredDefault ?? sources.find(s => s.enabled)
  if (defaultSource) setDefaultTokenSource(defaultSource.id)
  return sources.length
}

export function tokenSourceSpawnRevision(
  kind: string,
  cfg: TokenSourceConfig,
  detected: Partial<TokenSourceConfig> | null,
): string {
  // Display/catalog/usage changes do not alter child routing. Everything
  // below can affect credentials, endpoint, executable, model aliases or
  // provider selection and therefore belongs to the process identity.
  const pick = (value: Partial<TokenSourceConfig> | null): Record<string, unknown> => ({
    agent: value?.agent,
    auth: value?.auth,
    base_url: value?.base_url,
    auth_token: value?.auth_token,
    api_key: value?.api_key,
    bin: value?.bin,
    model: value?.model,
    effort: value?.effort,
    slots: value?.slots,
  })
  return createHash('sha256')
    .update(JSON.stringify({ kind, configured: pick(cfg), detected: pick(detected) }))
    .digest('hex')
}
