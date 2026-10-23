import { config, type ProjectProfile } from './config'
import { createClaudeTranslation } from './claude-translation'
import { ClaudeTranslationContext } from './claude-translation-context'
import { claudeTranslationModeEnabled } from './claude-translation-mode'
import type {
  AgentProcess,
  AgentProvider,
  AgentReasoningEffort,
} from './agent-process'
import { isClaudeReasoningEffort, isDshReasoningEffort } from './agent-process'
import { DshProcess } from './dsh-process'
import { ClaudeAgentProcess, assertClaudeCodeAvailable } from './claude-agent-process'
import { CodexProcess, isCodexReasoningEffort } from './codex-process'
import type { ConversationLaunch } from './conversation'
import { getTokenSourceForAccount, tokenSourceProcessRevision, tokenSourceRuntimeModel } from './token-source'
import { bindProcessCodexAccount, DEFAULT_CODEX_ACCOUNT } from './codex-accounts'
import { CodexAccountProcess } from './codex-account-process'
import { bindProcessClaudeAccount, claudeAccounts, DEFAULT_CLAUDE_ACCOUNT } from './claude-accounts'
import { selectClaudeAccount } from './claude-account-selection'

export interface AgentLaunchOptions {
  provider: AgentProvider
  workDir: string
  tokenSourceId: string | null
  codexAccountId?: string
  /** null = automatic; an id = explicit first choice. Undefined is a raw control/test launch. */
  codexAccountPreference?: string | null
  /** Internal raw launch: user explicitly chose this account; let native Codex validate it. */
  codexManualAccount?: boolean
  claudeAccountId?: string
  /** null = automatic at startup; an account id = this launch only. No mid-turn rotation. */
  claudeAccountPreference?: string | null
  /** Existing active chats, excluding the Session whose prospective launch is being ranked. */
  claudeActiveSessions?: ReadonlyMap<string, number>
  model?: string
  effort?: AgentReasoningEffort
  launch?: ConversationLaunch
  developerInstructions?: string
  /** Service/application calls cannot wait for a human or another Agent to answer. */
  allowUserInput?: boolean
  profile?: ProjectProfile
  managedSkillPluginPath?: string
  hostEnv?: Record<string, string | undefined>
  serviceName?: string
}

export interface CreatedAgentProcess {
  process: AgentProcess
  sourceRevision: string | null
}

/** Single source of truth for main Sessions and delegated agents, including
 * their native delegation capabilities. */
export function createAgentProcess(opts: AgentLaunchOptions): CreatedAgentProcess {
  if (opts.provider === 'codex' && opts.tokenSourceId === 'codex-sub' && opts.codexAccountPreference !== undefined) {
    if (!opts.model && !opts.codexAccountPreference) throw new Error('Codex 自动选号需要明确模型')
    const process = new CodexAccountProcess({
      model: opts.model ?? '', effort: opts.effort, preferred: opts.codexAccountPreference,
      workDir: opts.workDir, launch: opts.launch ?? { kind: 'fresh' },
      create: (accountId, launch, manual, model, effort) => createAgentProcess({ ...opts, model, effort,
        codexAccountPreference: undefined, codexManualAccount: manual, codexAccountId: accountId, launch }),
    })
    return { process, sourceRevision: null }
  }
  const claudeSubscription = opts.provider === 'claude' && opts.tokenSourceId === 'claude-sub'
  if (claudeSubscription && config.token_sources?.['claude-sub']?.enabled === false) {
    throw new Error('Claude 订阅已禁用；发送 claude-sub on 启用')
  }
  const managedClaudeAccount = claudeSubscription
    && (opts.claudeAccountPreference !== undefined || opts.claudeAccountId !== undefined)
  const accountId = claudeSubscription
    ? opts.claudeAccountPreference !== undefined
      ? selectClaudeAccount({ model: opts.model ?? '', effort: opts.effort, preferred: opts.claudeAccountPreference,
        activeSessions: opts.claudeActiveSessions })
      : opts.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT
    : opts.codexAccountId ?? DEFAULT_CODEX_ACCOUNT
  const source = getTokenSourceForAccount(opts.tokenSourceId, accountId)
  const manual = opts.provider === 'codex' && opts.tokenSourceId === 'codex-sub' && opts.codexManualAccount === true
    || claudeSubscription && typeof opts.claudeAccountPreference === 'string'
  if (opts.tokenSourceId && !source) throw new Error(`token source not found: ${opts.tokenSourceId}`)
  if (opts.provider === 'claude' && !source) throw new Error('Claude 账号来源未选择，请通过 md 选择 Claude Code 订阅或已配置的第三方账号')
  if (source && !source.enabled && !manual) throw new Error(`token source disabled: ${source.id}`)
  if (source && source.agent !== opts.provider) {
    throw new Error(`token source ${source.id} belongs to ${source.agent}, not ${opts.provider}`)
  }
  if (!manual && source?.modelCatalogState?.status === 'failed') {
    throw new Error(`model catalog refresh failed for ${source.id}: ${source.modelCatalogState.error ?? 'MISS'}`)
  }
  if (!manual && (source?.modelCatalogState?.status === 'idle' || source?.modelCatalogState?.status === 'loading')) {
    throw new Error(`model catalog is not ready for ${source.id}: ${source.modelCatalogState.status}`)
  }
  const requestedModel = opts.model || source?.defaultModel || undefined
  const sourceRevision = tokenSourceProcessRevision(source, requestedModel)
  const entry = !manual && source && tokenSourceRuntimeModel(source, requestedModel)
  if (!manual && source && requestedModel && !entry) {
    throw new Error(`model is not present in token source ${source.id}: ${requestedModel}`)
  }
  if (!manual && entry && (entry.unavailableReason || !entry.efforts.length || (opts.effort !== undefined && !entry.efforts.includes(opts.effort)))) {
    throw new Error(`model effort unavailable: ${source!.id}/${requestedModel}/${opts.effort ?? 'MISS'}`)
  }
  const model = !manual && source && requestedModel
    ? source.resolveSpawnModel(requestedModel)
    : requestedModel
  if (requestedModel && !model) throw new Error(`model did not resolve: ${opts.tokenSourceId ?? 'default'}/${requestedModel}`)
  const transformEnv = source ? (base: Record<string, string | undefined>) => source.spawnEnv(base, model) : undefined

  if (opts.provider === 'dsh') {
    if (!source || !model || !isDshReasoningEffort(opts.effort)) throw new Error('DSH requires a configured source, model and valid effort')
    return { process: new DshProcess({ ...opts, model, effort: opts.effort,
      tokenSourceId: source.id, transformEnv }), sourceRevision }
  }

  if (opts.provider === 'claude') {
    assertClaudeCodeAvailable()
    if (!isClaudeReasoningEffort(opts.effort)) throw new Error(`invalid Claude effort: ${opts.effort ?? 'MISS'}`)
    const translationEnabled = claudeTranslationModeEnabled(source?.id, requestedModel)
    const translationContext = translationEnabled ? new ClaudeTranslationContext({
      workDir: opts.workDir,
      ...(opts.launch && opts.launch.kind !== 'fresh' ? {
        resumeSessionId: opts.launch.source.sessionId,
        ...(opts.launch.kind === 'fork' ? { forkSession: true } : {}),
        ...(opts.launch.kind === 'fork' && opts.launch.through?.provider === 'claude'
          ? { resumeSessionAt: opts.launch.through.id } : {}),
      } : {}),
    }) : undefined
    if (managedClaudeAccount) claudeAccounts.prepareShared(accountId)
    const releaseAccount = managedClaudeAccount ? claudeAccounts.acquireUse(accountId) : undefined
    let process: ClaudeAgentProcess
    try {
      process = new ClaudeAgentProcess({
        workDir: opts.workDir,
        model,
        effort: opts.effort,
        ...(opts.launch?.kind === 'fresh' || !opts.launch
          ? {}
          : {
              resumeSessionId: opts.launch.source.sessionId,
              ...(opts.launch.kind === 'fork' ? { forkSession: true } : {}),
              ...(opts.launch.kind === 'fork' && opts.launch.through?.provider === 'claude'
                ? { resumeSessionAt: opts.launch.through.id }
                : {}),
            }),
        ...(opts.developerInstructions ? { appendSystemPrompt: opts.developerInstructions } : {}),
        ...(opts.allowUserInput === false ? { allowUserInput: false } : {}),
        ...(opts.profile ? { profile: opts.profile } : {}),
        ...(source ? { settingSources: source.settingSources ?? ['project', 'local'] } : {}),
        ...(source?.claudeSettings ? { settings: source.claudeSettings } : {}),
        ...(source?.validateClaudeAccount ? { validateAccount: source.validateClaudeAccount } : {}),
        ...(opts.managedSkillPluginPath ? { managedSkillPluginPath: opts.managedSkillPluginPath } : {}),
        tokenSourceId: source?.id ?? null,
        ...(translationContext ? {
          translationContext,
          translation: createClaudeTranslation({ validationRules: config.claude.translation_validation_rules,
            context: () => translationContext.snapshot() }),
        } : {}),
        transformEnv,
        hostEnv: opts.hostEnv,
      })
    } catch (error) {
      releaseAccount?.()
      throw error
    }
    if (claudeSubscription) bindProcessClaudeAccount(process, accountId)
    if (releaseAccount) process.once('exit', releaseAccount)
    return { process, sourceRevision }
  }

  if (opts.effort !== undefined && !isCodexReasoningEffort(opts.effort)) throw new Error(`invalid Codex effort: ${opts.effort}`)
  const process = new CodexProcess({
    workDir: opts.workDir,
    model,
    effort: opts.effort,
    launch: opts.launch,
    ...(opts.developerInstructions ? { appendSystemPrompt: opts.developerInstructions } : {}),
    ...(opts.allowUserInput === false ? { allowUserInput: false } : {}),
    tokenSourceId: source?.id ?? null,
    transformEnv,
    hostEnv: opts.hostEnv,
    serviceName: opts.serviceName,
    codexAccountId: accountId,
    ...(source?.codexApiProvider ? { apiProvider: source.codexApiProvider } : {}),
  })
  if (!source?.codexApiProvider) bindProcessCodexAccount(process, accountId)
  return { process, sourceRevision }
}
