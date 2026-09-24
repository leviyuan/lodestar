/** Claude Code 订阅：由原生 SDK 读取本机登录态，与第三方来源独立共存。 */
import type { AccountInfo, Settings } from '@anthropic-ai/claude-agent-sdk'
import { isClaudeReasoningEffort } from './agent-process'
import { log } from './log'
import { ANTHROPIC_ENV_KEYS, registerTokenSourceFactory, scrubAnthropicEnv, type TokenSource, type UsageSnapshotUnified } from './token-source'
import { fetchNativeClaudeModels } from './token-source-models'
import { fetchClaudeSubscriptionUsage } from './claude-usage'
import { modelList } from './token-source-visibility'

/** 覆盖 settings.env，防止 user/project/local settings 重新注入其他账号的路由。 */
function subscriptionSettings(): Settings {
  const env = Object.fromEntries(ANTHROPIC_ENV_KEYS.map(key => [key, '']))
  env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
  env.CLAUDE_CODE_NO_MODEL_FALLBACK = '1'
  return { env, apiKeyHelper: '', forceLoginMethod: 'claudeai' }
}

export function validateClaudeSubscriptionAccount(account: AccountInfo): void {
  if (!account.subscriptionType?.trim()) {
    throw Object.assign(new Error('Claude Code 订阅未登录；请在本机运行 claude auth login，完成后等待后台刷新，发送 md 查看状态'),
      { code: 'CLAUDE_SUBSCRIPTION_AUTH_MISSING' })
  }
  if (account.apiProvider !== 'firstParty' || (account.apiKeySource && account.apiKeySource !== 'none')) {
    throw new Error('Claude Code 当前认证不是第一方订阅；请检查本机登录方式和托管设置')
  }
}

registerTokenSourceFactory({
  kind: 'claude-subscription',
  configSectionId: 'claude-sub',
  build(cfg): TokenSource {
    const settings = subscriptionSettings()
    const configuredModel = cfg.model?.trim()
    const disabledReason = 'Claude Code 订阅已在 Lodestar 中禁用；发送 claude-sub on 启用'
    let usageRequest: Promise<UsageSnapshotUnified> | undefined
    const source: TokenSource = {
      id: 'claude-sub', kind: 'claude-subscription', agent: 'claude',
      display: cfg.display?.trim() || 'Claude Code 订阅',
      // 登录态可能位于系统钥匙串；原生 accountInfo 是权威来源，不扫描或复制凭据。
      enabled: cfg.enabled !== false, models: [], defaultModel: configuredModel ?? '',
      modelCatalogState: cfg.enabled === false
        ? { status: 'disabled', updatedAt: Date.now(), error: disabledReason }
        : { status: 'idle', updatedAt: Date.now() },
      settingSources: ['user', 'project', 'local'],
      claudeSettings: settings,
      validateClaudeAccount: validateClaudeSubscriptionAccount,
      spawnEnv(base) {
        return { ...scrubAnthropicEnv(base), ...settings.env }
      },
      resolveSpawnModel(model) { return model },
      async refreshModels() {
        if (cfg.enabled === false) {
          source.enabled = false
          source.models = []
          source.modelCatalogState = { status: 'disabled', updatedAt: Date.now(), error: disabledReason }
          return
        }
        source.enabled = true
        source.models = []
        source.modelCatalogState = { status: 'loading', updatedAt: null }
        try {
          const models = await fetchNativeClaudeModels({
            settingSources: ['user'], settings, transformEnv: source.spawnEnv,
            validateAccount: source.validateClaudeAccount, tokenSourceId: source.id,
          })
          if (!models.length) throw new Error('Claude Code 订阅模型目录为空')
          const customIds = [...modelList(cfg.custom_models), ...modelList(cfg.models)]
          if (configuredModel && !models.some(model => model.model === configuredModel) && !customIds.includes(configuredModel)) {
            throw new Error(`Claude Code 订阅默认模型不在目录中且未补录: ${configuredModel}`)
          }
          if (cfg.effort) {
            const defaultEntry = models.find(model => model.model === (configuredModel ?? models[0]!.model))
            if (!isClaudeReasoningEffort(cfg.effort) || (defaultEntry && !defaultEntry.efforts.includes(cfg.effort))) {
              throw new Error(`Claude Code 订阅默认模型不支持 effort: ${cfg.effort}`)
            }
            // 补录项的请求档位由 withModelVisibility 处理。
            if (defaultEntry) defaultEntry.defaultEffort = cfg.effort
          }
          source.defaultModel = configuredModel ?? models[0]!.model
          source.models = models
          source.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          log(`claude-sub refreshModels MISS: ${reason}`)
          if ((error as { code?: string })?.code === 'CLAUDE_SUBSCRIPTION_AUTH_MISSING') source.enabled = false
          source.modelCatalogState = { status: source.enabled ? 'failed' : 'disabled', updatedAt: Date.now(), error: reason }
        }
      },
      readUsage() {
        if (!source.enabled) return Promise.resolve({ state: 'not_applicable' as const, windows: [],
          reason: source.modelCatalogState?.error ?? disabledReason })
        // 并发的 hi/收尾共用本次查询；完成后下一次调用重新读取原生接口。
        usageRequest ??= fetchClaudeSubscriptionUsage({
          settingSources: ['user'], settings, transformEnv: source.spawnEnv,
          validateAccount: source.validateClaudeAccount, tokenSourceId: source.id,
        }).finally(() => { usageRequest = undefined })
        return usageRequest
      },
    }
    return source
  },
})
