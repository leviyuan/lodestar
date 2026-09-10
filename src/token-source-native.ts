/**
 * 沿用本机 Claude 环境和 user settings 的账号来源。
 * 有其他已启用的 Claude 侧来源时禁用；模型目录来自 SDK，额度不适用。
 */

import { type TokenSourceConfig } from './config'
import {
  type TokenSource,
  type UsageSnapshotUnified,
  registerTokenSourceFactory,
} from './token-source'
import { fetchNativeClaudeModels } from './token-source-models'

type Env = Record<string, string | undefined>

registerTokenSourceFactory({
  kind: 'claude-native',
  configSectionId: 'claude-native',
  // enabled 由 buildTokenSourcesFromConfig 根据其他 Claude 侧来源决定。
  build: (cfg: TokenSourceConfig): TokenSource => {
    const ts: TokenSource = {
      id: 'claude-native',
      kind: 'claude-native',
      agent: 'claude',
      display: cfg.display?.trim() || 'Claude',
      enabled: false,  // buildTokenSourcesFromConfig 后处理:无 claude source 启用时置 true
      models: [],
      modelCatalogState: { status: 'disabled', updatedAt: Date.now() },
      defaultModel: cfg.model?.trim() || 'opus',
      // native 透传本机配置,需读 user settings.json(Claude Code 的 env / API key / 中转);
      // 注入 env 的 source(glm/deepseek)不设此字段 → DEFAULT(['project','local'],不读 user,spawnEnv 权威)。
      settingSources: ['user', 'project', 'local'],
      async refreshModels(): Promise<void> {
        ts.models = []
        if (!ts.enabled) { ts.modelCatalogState = { status: 'disabled', updatedAt: Date.now() }; return }
        ts.modelCatalogState = { status: 'loading', updatedAt: null }
        try {
          ts.models = await fetchNativeClaudeModels()
          if (!ts.models.some(model => model.model === ts.defaultModel)) throw new Error('Claude 默认模型不在 SDK 目录中')
          ts.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
        } catch (error) {
          ts.models = []
          ts.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
          throw error
        }
      },
      spawnEnv(base: Env): Env {
        // 透传:零注入、零 scrub —— Claude SDK 完全用本机 settings.json / 默认配置。
        return base
      },
      resolveSpawnModel(model: string): string {
        // 透传 SDK alias(opus/sonnet/haiku/fable),由 SDK + settings.json 解析具体模型。
        return model
      },
      async readUsage(): Promise<UsageSnapshotUnified> {
        // 本机配置不提供可统一查询的额度来源。
        return { state: 'not_applicable', windows: [] }
      },
    }
    return ts
  },
})
