/** Claude Code 订阅：由原生 SDK 读取本机登录态，与第三方来源独立共存。 */
import type { AccountInfo, Settings } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config'
import { isClaudeReasoningEffort } from './agent-process'
import { ANTHROPIC_ENV_KEYS, registerTokenSourceFactory, scrubAnthropicEnv, type TokenSource, type UsageSnapshotUnified } from './token-source'
import { fetchNativeClaudeModels } from './token-source-models'
import { fetchClaudeSubscriptionUsage } from './claude-usage'
import { modelList, withModelVisibility } from './token-source-visibility'
import { claudeAccounts, DEFAULT_CLAUDE_ACCOUNT } from './claude-accounts'
import { invalidateClaudeSubscriptionUsage } from './claude-usage'
import { isUsageAuthError } from './usage-cache'

/** 覆盖 settings.env，防止 user/project/local settings 重新注入其他账号的路由。 */
export function claudeSubscriptionSettings(accountEnv: Record<string, string | undefined> = {}): Settings {
  const env = Object.fromEntries(ANTHROPIC_ENV_KEYS.map(key => [key, '']))
  env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
  env.CLAUDE_CODE_NO_MODEL_FALLBACK = '1'
  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) {
    if (accountEnv[key] !== undefined) env[key] = accountEnv[key]!
  }
  return { env, apiKeyHelper: '', forceLoginMethod: 'claudeai' }
}

function defaultOpus(models: TokenSource['models']): string {
  const candidates = models.filter(model => /^(?:claude:)?(?:claude-)?opus(?:$|[-\[])/i.test(model.model))
  return candidates.find(model => model.model === 'opus')?.model
    ?? candidates.sort((a, b) => b.model.localeCompare(a.model, undefined, { numeric: true }))[0]?.model ?? ''
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

/** Native default uses an unset CONFIG_DIR. User settings cannot silently redirect that binding. */
export function assertClaudeDefaultSettingsEnvironment(configDir: string): void {
  let text: string
  try { text = readFileSync(join(configDir, 'settings.json'), 'utf8') }
  catch (error: any) {
    if (error?.code === 'ENOENT') return
    throw new Error('Claude 默认账号 settings.json 读取失败，无法确认认证目录')
  }
  let settings: unknown
  try { settings = JSON.parse(text) }
  catch { throw new Error('Claude 默认账号 settings.json 格式无效，无法确认认证目录') }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Claude 默认账号 settings.json 格式无效，无法确认认证目录')
  }
  const env = (settings as { env?: unknown }).env
  if (env === undefined) return
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('Claude 默认账号 settings.env 格式无效')
  if (Object.hasOwn(env, 'CLAUDE_CONFIG_DIR')) {
    throw new Error('Claude 默认账号未设置 CLAUDE_CONFIG_DIR，但用户 settings.env 重定向了该目录；请先移除此冲突配置')
  }
  if (Object.hasOwn(env, 'CLAUDE_SECURESTORAGE_CONFIG_DIR')
    && (env as Record<string, unknown>).CLAUDE_SECURESTORAGE_CONFIG_DIR !== '') {
    throw new Error('Claude 默认账号的用户 settings.env.CLAUDE_SECURESTORAGE_CONFIG_DIR 与默认认证存储冲突；请先移除此配置')
  }
}

registerTokenSourceFactory({
  kind: 'claude-subscription',
  configSectionId: 'claude-sub',
  build(cfg): TokenSource {
    claudeAccounts.configureNativeEnv({ ...process.env, ...config.claude.env })
    const configuredModel = cfg.model?.trim()
    const disabledReason = 'Claude Code 订阅已在 Lodestar 中禁用；发送 claude-sub on 启用'
    const make = (accountId: string): TokenSource => {
    const settings = claudeSubscriptionSettings(claudeAccounts.candidateEnv(claudeAccounts.get(accountId), {}))
    const revision = claudeAccounts.revision(accountId)
    let usageRequest: Promise<UsageSnapshotUnified> | undefined
    const source: TokenSource = {
      id: 'claude-sub', kind: 'claude-subscription', agent: 'claude',
      accountId,
      accountRevision: id => claudeAccounts.revision(id),
      spawnRevision: JSON.stringify([cfg.model, cfg.effort, revision]),
      usageAccount: { id: `claude:${accountId}`, label: `Claude·${claudeAccounts.get(accountId).name}` },
      display: cfg.display?.trim() || 'Claude Code 订阅',
      // 登录态可能位于系统钥匙串；原生 accountInfo 是权威来源，不扫描或复制凭据。
      enabled: cfg.enabled !== false, models: [], defaultModel: configuredModel ?? '',
      modelCatalogState: cfg.enabled === false
        ? { status: 'disabled', updatedAt: Date.now(), error: disabledReason }
        : { status: 'idle', updatedAt: Date.now() },
      settingSources: ['user', 'project', 'local'],
      claudeSettings: settings,
      validateClaudeAccount(account) {
        try {
          validateClaudeSubscriptionAccount(account)
          const next = claudeAccounts.observeIdentity(accountId, account, revision)
          if (next !== revision) invalidateClaudeSubscriptionUsage(accountId)
        } catch (error) {
          if (claudeAccounts.revision(accountId) === revision && isUsageAuthError(error)) invalidateClaudeSubscriptionUsage(accountId)
          throw error
        }
      },
      spawnEnv(base) {
        if (accountId === DEFAULT_CLAUDE_ACCOUNT && claudeAccounts.get(accountId).configDir === undefined) {
          assertClaudeDefaultSettingsEnvironment(claudeAccounts.sharedConfigDir())
        }
        return claudeAccounts.env(accountId, { ...scrubAnthropicEnv(base), ...settings.env })
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
          claudeAccounts.assertReady(accountId)
          const models = await fetchNativeClaudeModels({
            settingSources: ['user'], settings, transformEnv: source.spawnEnv,
            validateAccount: source.validateClaudeAccount, tokenSourceId: source.id,
            acquireUse: () => claudeAccounts.acquireUse(accountId),
          })
          if (!models.length) throw new Error('Claude Code 订阅模型目录为空')
          const customIds = [...modelList(cfg.custom_models), ...modelList(cfg.models)]
          if (configuredModel && !models.some(model => model.model === configuredModel) && !customIds.includes(configuredModel)) {
            throw new Error(`Claude Code 订阅默认模型不在目录中且未补录: ${configuredModel}`)
          }
          const defaultModel = configuredModel ?? defaultOpus(models)
          if (cfg.effort) {
            const defaultEntry = models.find(model => model.model === defaultModel)
            if (!isClaudeReasoningEffort(cfg.effort) || (defaultEntry && !defaultEntry.efforts.includes(cfg.effort))) {
              throw new Error(`Claude Code 订阅默认模型不支持 effort: ${cfg.effort}`)
            }
            // 补录项的请求档位由 withModelVisibility 处理。
            if (defaultEntry) defaultEntry.defaultEffort = cfg.effort
          }
          source.defaultModel = defaultModel
          source.models = models
          source.modelCatalogState = { status: 'ready', updatedAt: Date.now(),
            ...(!defaultModel ? { error: 'Claude Opus 默认模型 MISS；请通过 md 明确选择账号目录中的模型' } : {}) }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          if (claudeAccounts.revision(accountId) === revision && isUsageAuthError(error)) invalidateClaudeSubscriptionUsage(accountId)
          if ((error as { code?: string })?.code === 'CLAUDE_SUBSCRIPTION_AUTH_MISSING') source.enabled = false
          source.modelCatalogState = { status: source.enabled ? 'failed' : 'disabled', updatedAt: Date.now(), error: reason }
        }
      },
      readUsage() {
        if (!source.enabled) return Promise.resolve({ state: 'not_applicable' as const, windows: [],
          reason: source.modelCatalogState?.error ?? disabledReason })
        // A retained view must not start another short-lived process during onboarding.
        try { claudeAccounts.assertReady(accountId) }
        catch (error) { return Promise.reject(error) }
        // 并发的 hi/收尾共用本次查询；完成后下一次调用重新读取原生接口。
        const expectedRevision = revision
        usageRequest ??= fetchClaudeSubscriptionUsage({
          settingSources: ['user'], settings, transformEnv: source.spawnEnv,
          validateAccount: source.validateClaudeAccount, tokenSourceId: source.id,
        }, { accountId, revision: expectedRevision, acquireUse: () => claudeAccounts.acquireUse(accountId),
          current: () => claudeAccounts.revision(accountId) === expectedRevision })
          .finally(() => { usageRequest = undefined })
        return usageRequest
      },
    }
    return source
    }
    const root = make(DEFAULT_CLAUDE_ACCOUNT)
    root.accountId = undefined
    root.aggregateAccountCatalog = true
    root.listAccounts = () => claudeAccounts.list().map(account => ({ id: account.id, name: account.name }))
    const children = new Map<string, { revision: string; source: TokenSource }>()
    root.forAccount = accountId => {
      claudeAccounts.assertReady(accountId)
      const revision = claudeAccounts.revision(accountId)
      const current = children.get(accountId)
      if (current?.revision === revision) return current.source
      const source = withModelVisibility(make(accountId), cfg)
      children.set(accountId, { revision, source })
      return source
    }
    return root
  },
})
