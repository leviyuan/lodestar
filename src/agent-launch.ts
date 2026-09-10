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
import { getTokenSource } from './token-source'

export interface AgentLaunchOptions {
  provider: AgentProvider
  workDir: string
  tokenSourceId: string | null
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
  const source = opts.tokenSourceId ? getTokenSource(opts.tokenSourceId) : undefined
  if (opts.tokenSourceId && !source) throw new Error(`token source not found: ${opts.tokenSourceId}`)
  if (source && !source.enabled) throw new Error(`token source disabled: ${source.id}`)
  if (source && source.agent !== opts.provider) {
    throw new Error(`token source ${source.id} belongs to ${source.agent}, not ${opts.provider}`)
  }
  if (source?.modelCatalogState?.status === 'failed') {
    throw new Error(`model catalog refresh failed for ${source.id}: ${source.modelCatalogState.error ?? 'MISS'}`)
  }
  if (source?.modelCatalogState?.status === 'idle' || source?.modelCatalogState?.status === 'loading') {
    throw new Error(`model catalog is not ready for ${source.id}: ${source.modelCatalogState.status}`)
  }
  const requestedModel = opts.model ?? source?.defaultModel
  if (source && requestedModel && !source.models.some(entry => entry.model === requestedModel)) {
    throw new Error(`model is not present in token source ${source.id}: ${requestedModel}`)
  }
  const model = source && requestedModel
    ? source.resolveSpawnModel(requestedModel)
    : requestedModel
  if (requestedModel && !model) throw new Error(`model did not resolve: ${opts.tokenSourceId ?? 'default'}/${requestedModel}`)
  const transformEnv = source ? (base: Record<string, string | undefined>) => source.spawnEnv(base) : undefined

  if (opts.provider === 'dsh') {
    if (!source || !model || !isDshReasoningEffort(opts.effort)) throw new Error('DSH requires a configured source, model and valid effort')
    return { process: new DshProcess({ ...opts, model, effort: opts.effort,
      tokenSourceId: source.id, transformEnv }), sourceRevision: source.spawnRevision ?? null }
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
        ...(opts.managedSkillPluginPath ? { managedSkillPluginPath: opts.managedSkillPluginPath } : {}),
        tokenSourceId: source?.id ?? null,
        transformEnv,
        hostEnv: opts.hostEnv,
      }),
      sourceRevision: source?.spawnRevision ?? null,
    }
  }

  if (opts.effort !== undefined && !isCodexReasoningEffort(opts.effort)) throw new Error(`invalid Codex effort: ${opts.effort}`)
  return {
    process: new CodexProcess({
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
    }),
    sourceRevision: source?.spawnRevision ?? null,
  }
}
