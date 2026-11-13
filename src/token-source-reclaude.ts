/**
 * reclaude：经第三方启动器运行 Claude Code。登录态、组织绑定和网络路由都由 reclaude 管理，
 * Lodestar 只负责经它启动进程，不读取也不保存它的凭据。
 *
 * 启用 = 本机找得到 reclaude 命令（或 [token_source.reclaude].bin）；
 * 组织 = 配置的 org，省略时跟随 `reclaude org use` 的当前组织；
 * 模型与额度 = 每次目录刷新经 reclaude 起一个控制进程一并读取。
 */
import { existsSync } from 'node:fs'
import { isClaudeReasoningEffort } from './agent-process'
import { claudeUsageSnapshot } from './claude-usage'
import { findReclaude, readReclaudeStatus, reclaudePath, selectReclaudeBinding, RECLAUDE_DIAGNOSTIC_PREFIX, type ReclaudeBinding, type ReclaudeStatus } from './reclaude'
import { registerTokenSourceFactory, scrubAnthropicEnv, type TokenSource, type UsageSnapshotUnified } from './token-source'
import { defaultOpus } from './token-source-claude'
import { fetchNativeClaudeModels } from './token-source-models'
import { modelList } from './token-source-visibility'
import { isUsageAuthError, isUsageRateLimitError } from './usage-cache'

const CONTROL_TIMEOUT_MS = 30_000
const DISABLED_REASON = 'reclaude 已在 Lodestar 中禁用；将 [token_source.reclaude] 的 enabled 改为 true 或删除该行后启用'
const MISSING_REASON = '未检测到 reclaude 命令；在运行 Lodestar 的本机安装并登录 reclaude 后自动启用，也可在 [token_source.reclaude] 用 bin 指定路径'
const PENDING_USAGE: UsageSnapshotUnified = { state: 'network', windows: [], reason: '额度缓存尚未就绪，后台刷新中' }

/** 测试替换命令查找、状态查询和原生目录读取，不启动真实 reclaude。 */
export const reclaudeRuntime = {
  // 测试进程不探测开发机上装的 reclaude，否则用例会去启动真实命令。
  find: (bin: string | undefined) => process.env.NODE_ENV === 'test' ? null : findReclaude(bin),
  status: (bin: string): Promise<ReclaudeStatus> => readReclaudeStatus(bin),
  bindingReady: (binding: ReclaudeBinding) => existsSync(binding.configDir),
  models: fetchNativeClaudeModels,
}

/** 一次成功刷新得到的启动状态，按命令与组织配置记忆。目录刷新之间重建来源实例时
 * （例如改了模型显隐）沿用它：否则新实例顶着缓存的「就绪」目录却没有绑定，启动必然失败。 */
const lastReady = new Map<string, { binding: ReclaudeBinding; usage: UsageSnapshotUnified }>()

/** 仅供测试清空上面的记忆。 */
export function resetReclaudeState(): void { lastReady.clear() }

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${CONTROL_TIMEOUT_MS / 1000}s）`)), CONTROL_TIMEOUT_MS)
  })]).finally(() => clearTimeout(timer))
}

registerTokenSourceFactory({
  kind: 'reclaude',
  configSectionId: 'reclaude',
  build(cfg): TokenSource {
    let bin: string | null = null
    let unavailable: string | undefined
    if (cfg.enabled === false) unavailable = DISABLED_REASON
    else {
      try {
        bin = reclaudeRuntime.find(cfg.bin)
        if (!bin) unavailable = MISSING_REASON
      } catch (error) { unavailable = error instanceof Error ? error.message : String(error) }
    }
    const org = cfg.org?.trim() || undefined
    const configuredModel = cfg.model?.trim() || undefined
    const stateKey = JSON.stringify([bin, org ?? null])
    const remembered = bin ? lastReady.get(stateKey) : undefined
    let binding: ReclaudeBinding | null = remembered?.binding ?? null
    let usage = remembered?.usage ?? PENDING_USAGE
    const launcherFor = (command: string, selected: ReclaudeBinding) =>
      // 显式带上组织：默认组织在两次刷新之间被切换时，新进程仍与这里记录的目录一致。
      ({ command, args: ['--org', selected.orgId, 'cli'], diagnosticPrefix: RECLAUDE_DIAGNOSTIC_PREFIX })
    const source: TokenSource = {
      id: 'reclaude', kind: 'reclaude', agent: 'claude',
      display: cfg.display?.trim() || 'reclaude',
      enabled: bin !== null, models: [], defaultModel: configuredModel ?? '',
      modelCatalogState: bin ? { status: 'idle', updatedAt: Date.now() } : { status: 'disabled', updatedAt: Date.now(), error: unavailable },
      ...(bin && binding ? { claudeLauncher: launcherFor(bin, binding), claudeHistoryDir: binding.configDir } : {}),
      // 换组织即换登录态与会话目录：空闲进程须按新绑定重启。
      modelEnvironmentRevision: () => binding?.deviceId ?? '',
      spawnEnv(base) {
        if (!binding) throw new Error('reclaude 组织绑定尚未就绪，后台刷新中')
        const env = scrubAnthropicEnv(base)
        delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR
        // reclaude 自己也会设置该目录；这里写明是为了让会话记录、租约与进程使用同一路径。
        env.CLAUDE_CONFIG_DIR = binding.configDir
        if (process.platform !== 'win32') env.PATH = reclaudePath(env.PATH)
        return env
      },
      resolveSpawnModel(model) { return model },
      async refreshModels() {
        source.models = []
        if (!bin) {
          source.enabled = false
          source.modelCatalogState = { status: 'disabled', updatedAt: Date.now(), error: unavailable }
          return
        }
        source.modelCatalogState = { status: 'loading', updatedAt: null }
        try {
          const selected = selectReclaudeBinding(await reclaudeRuntime.status(bin), org)
          if (!reclaudeRuntime.bindingReady(selected)) {
            throw new Error('reclaude 组织绑定的配置目录不存在；请在本机运行一次 reclaude 完成初始化')
          }
          binding = selected
          source.claudeHistoryDir = selected.configDir
          source.claudeLauncher = launcherFor(bin, selected)
          let nextUsage: UsageSnapshotUnified = PENDING_USAGE
          const models = await reclaudeRuntime.models({
            settingSources: ['user'], transformEnv: source.spawnEnv, tokenSourceId: source.id,
            launcher: source.claudeLauncher, timeoutMs: CONTROL_TIMEOUT_MS,
            async afterCatalog(proc) {
              // 额度失败不影响模型目录；按 MISS 展示原因。
              try { nextUsage = claudeUsageSnapshot(await withTimeout(proc.readSubscriptionUsage(), 'reclaude 额度查询')) }
              catch (error) {
                nextUsage = { state: isUsageRateLimitError(error) ? 'rate_limited' : 'network', windows: [],
                  reason: error instanceof Error ? error.message : String(error) }
              }
            },
          })
          usage = nextUsage
          if (!models.length) throw new Error('reclaude 模型目录为空')
          const customIds = [...modelList(cfg.custom_models), ...modelList(cfg.models)]
          if (configuredModel && !models.some(model => model.model === configuredModel) && !customIds.includes(configuredModel)) {
            throw new Error(`reclaude 默认模型不在目录中且未补录: ${configuredModel}`)
          }
          const defaultModel = configuredModel ?? defaultOpus(models)
          if (cfg.effort) {
            const defaultEntry = models.find(model => model.model === defaultModel)
            if (!isClaudeReasoningEffort(cfg.effort) || (defaultEntry && !defaultEntry.efforts.includes(cfg.effort))) {
              throw new Error(`reclaude 默认模型不支持 effort: ${cfg.effort}`)
            }
            // 补录项的请求档位由 withModelVisibility 处理。
            if (defaultEntry) defaultEntry.defaultEffort = cfg.effort
          }
          source.defaultModel = defaultModel
          source.models = models
          source.modelCatalogState = { status: 'ready', updatedAt: Date.now(),
            ...(!defaultModel ? { error: 'Claude Opus 默认模型 MISS；请通过 md 明确选择账号目录中的模型' } : {}) }
          lastReady.set(stateKey, { binding: selected, usage })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          source.models = []
          source.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: reason }
          // 额度随目录一起读取：目录失败时额度同样缺失，原因如实给出，不停留在「尚未就绪」。
          usage = { state: isUsageAuthError(error) ? 'no_credentials' : 'network', windows: [], reason }
        }
      },
      async readUsage() {
        if (!bin) return { state: 'not_applicable', windows: [], reason: unavailable }
        return usage
      },
    }
    return source
  },
})
