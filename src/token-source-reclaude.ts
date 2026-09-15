import type { Settings } from '@anthropic-ai/claude-agent-sdk'
import type { TokenSourceConfig } from './config'
import { isClaudeReasoningEffort } from './agent-process'
import { log } from './log'
import { ANTHROPIC_ENV_KEYS, registerTokenSourceFactory, scrubAnthropicEnv, type TokenSource,
  type UsageSnapshotUnified } from './token-source'
import { fetchNativeClaudeModels } from './token-source-models'
import { modelList } from './token-source-visibility'
import { readReclaudeRuntime, type ReclaudeRuntime } from './reclaude-runtime'
import { fetchReclaudeUsage } from './reclaude-usage'

function runtimeSettings(runtime: ReclaudeRuntime): Settings {
  return {
    apiKeyHelper: '',
    forceLoginMethod: 'claudeai',
    env: {
      ...Object.fromEntries(ANTHROPIC_ENV_KEYS.map(key => [key, ''])),
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      // 使用客户端管理的原生登录文件；sk-rec 不是 Claude 的环境变量 OAuth token。
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
      HTTPS_PROXY: runtime.proxyUrl, HTTP_PROXY: runtime.proxyUrl,
      https_proxy: runtime.proxyUrl, http_proxy: runtime.proxyUrl,
      ALL_PROXY: '', all_proxy: '',
      NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
      NODE_EXTRA_CA_CERTS: runtime.caFile,
    },
  }
}

/** ReClaude 官方客户端提供认证和本机代理，模型进程继续使用 SDK 原生入口。 */
export function createReclaudeSource(cfg: TokenSourceConfig, readRuntime = readReclaudeRuntime): TokenSource {
  const enabled = cfg.auth === 'reclaude-login'
  const configuredModel = cfg.model?.trim() || undefined
  let usageRequest: Promise<UsageSnapshotUnified> | undefined
  const source: TokenSource = {
    id: 'reclaude', kind: 'reclaude', agent: 'claude',
    display: cfg.display?.trim() || 'ReClaude', enabled, models: [], defaultModel: configuredModel ?? '',
    modelCatalogState: { status: enabled ? 'idle' : 'disabled', updatedAt: Date.now() },
    settingSources: ['project', 'local'],
    get claudeSettings() { return runtimeSettings(readRuntime()) },
    spawnEnv(base) { return { ...scrubAnthropicEnv(base), ...runtimeSettings(readRuntime()).env } },
    resolveSpawnModel(model) { return model },
    async refreshModels() {
      source.models = []
      if (!enabled) { source.modelCatalogState = { status: 'disabled', updatedAt: Date.now() }; return }
      source.modelCatalogState = { status: 'loading', updatedAt: null }
      try {
        const runtime = readRuntime()
        const settings = runtimeSettings(runtime)
        const models = await fetchNativeClaudeModels({
          settingSources: [], settings,
          transformEnv: base => ({ ...scrubAnthropicEnv(base), ...settings.env }),
          tokenSourceId: source.id,
        })
        if (!models.length) throw new Error('ReClaude 模型目录为空')
        const custom = [...modelList(cfg.custom_models), ...modelList(cfg.models)]
        if (configuredModel && !models.some(model => model.model === configuredModel) && !custom.includes(configuredModel)) {
          throw new Error(`ReClaude 默认模型不在目录中且未补录：${configuredModel}`)
        }
        if (cfg.effort) {
          const entry = models.find(model => model.model === (configuredModel ?? models[0]!.model))
          if (!isClaudeReasoningEffort(cfg.effort) || (entry && !entry.efforts.includes(cfg.effort))) {
            throw new Error(`ReClaude 默认模型不支持 effort：${cfg.effort}`)
          }
          if (entry) entry.defaultEffort = cfg.effort
        }
        source.defaultModel = configuredModel ?? models[0]!.model
        source.models = models
        source.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        log(`reclaude refreshModels MISS: ${reason}`)
        source.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: reason }
      }
    },
    readUsage() {
      usageRequest ??= fetchReclaudeUsage(cfg.api_key, cfg.org_id).then(snapshot => {
        if (snapshot.state !== 'ok') log(`reclaude readUsage MISS: ${snapshot.reason ?? snapshot.state}`)
        return snapshot
      }).finally(() => { usageRequest = undefined })
      return usageRequest
    },
  }
  return source
}

registerTokenSourceFactory({
  kind: 'reclaude', configSectionId: 'reclaude', build: cfg => createReclaudeSource(cfg),
  setup: {
    commandSuffix: 'reclaude',
    hint: () => '在本机安装 ReClaude，执行 reclaude login 和 reclaude daemon --detach；然后发送 reclaude-setup <拼车组织 ID> [个人只读 API key]。客户端会接管本机 Claude 登录。',
    parseArgs(args) {
      const parts = args.trim().split(/\s+/)
      if (parts.length > 2 || !/^[1-9]\d*$/.test(parts[0] ?? '') || (parts[1] && !/^rck_[\w-]+$/.test(parts[1]))) {
        return { error: '用法：reclaude-setup <拼车组织 ID> [rck_ 个人只读 API key]；先在本机完成 reclaude login。' }
      }
      return { config: { agent: 'claude', auth: 'reclaude-login', org_id: parts[0], api_key: parts[1] } }
    },
  },
})
