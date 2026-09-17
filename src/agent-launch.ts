import type { ProjectProfile } from './config'
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

export interface AgentLaunchOptions {
  provider: AgentProvider
  workDir: string
  tokenSourceId: string | null
  codexAccountId?: string
  /** null = automatic; an id = explicit first choice. Undefined is a raw control/test launch. */
  codexAccountPreference?: string | null
  /** Internal raw launch: user explicitly chose this account; let native Codex validate it. */
  codexManualAccount?: boolean
  model?: string
  effort?: AgentReasoningEffort
  launch?: ConversationLaunch
  developerInstructions?: string
  /** Only delegated workers disable delegation; main Sessions keep native capabilities. */
  allowDelegation?: boolean
  profile?: ProjectProfile
  managedSkillPluginPath?: string
  hostEnv?: Record<string, string | undefined>
  serviceName?: string
}

export interface CreatedAgentProcess {
  process: AgentProcess
  sourceRevision: string | null
}

/** Single source of truth for both the Feishu main Session and delegated
 * agents. Workers use the same coding tools, with further delegation disabled
 * according to the user's single-level delegation policy. */
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
  const accountId = opts.codexAccountId ?? DEFAULT_CODEX_ACCOUNT
  const source = getTokenSourceForAccount(opts.tokenSourceId, accountId)
  const manual = opts.provider === 'codex' && opts.tokenSourceId === 'codex-sub' && opts.codexManualAccount === true
  if (opts.tokenSourceId && !source) throw new Error(`token source not found: ${opts.tokenSourceId}`)
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
    return {
      process: new ClaudeAgentProcess({
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
        ...(opts.allowDelegation === false ? { allowDelegation: false } : {}),
        ...(opts.profile ? { profile: opts.profile } : {}),
        ...(source ? { settingSources: source.settingSources ?? ['project', 'local'] } : {}),
        ...(source?.claudeSettings ? { settings: source.claudeSettings } : {}),
        ...(source?.validateClaudeAccount ? { validateAccount: source.validateClaudeAccount } : {}),
        ...(opts.managedSkillPluginPath ? { managedSkillPluginPath: opts.managedSkillPluginPath } : {}),
        tokenSourceId: source?.id ?? null,
        transformEnv,
        hostEnv: opts.hostEnv,
      }),
      sourceRevision,
    }
  }

  if (opts.effort !== undefined && !isCodexReasoningEffort(opts.effort)) throw new Error(`invalid Codex effort: ${opts.effort}`)
  const process = new CodexProcess({
    workDir: opts.workDir,
    model,
    effort: opts.effort,
    launch: opts.launch,
    ...(opts.developerInstructions ? { appendSystemPrompt: opts.developerInstructions } : {}),
    ...(opts.allowDelegation === false ? { allowDelegation: false } : {}),
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
