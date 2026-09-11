/** 群内账号启用和模型补录的配置写入；重建账号目录并等待模型刷新。 */

import { readFileSync } from 'node:fs'
import { CONFIG_FILE } from './paths'
import { config, loadConfig, reloadTokenSources, type TokenSourceConfig } from './config'
import { buildTokenSourcesFromConfig } from './token-source-builtins'
import { getTokenSource, refreshAllTokenSourceModels } from './token-source'
import { writeStateFileAtomic } from './state-store'
import { modelList } from './token-source-visibility'

/** TOML 基本字符串转义(与 setup.ts escapeTomlString / config.ts parseToml 反转义对称) */
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
}

function cfgToToml(id: string, cfg: TokenSourceConfig): string {
  const lines = [`[token_source.${id}]`]
  const push = (k: string, v?: string) => { if (v !== undefined) lines.push(`${k} = "${esc(v)}"`) }
  push('agent', cfg.agent)
  push('display', cfg.display)
  push('auth', cfg.auth)
  push('base_url', cfg.base_url)
  push('auth_token', cfg.auth_token)
  push('api_key', cfg.api_key)
  push('bin', cfg.bin)
  push('model', cfg.model)
  push('effort', cfg.effort)
  push('models', cfg.models)
  push('hidden_models', cfg.hidden_models)
  push('custom_models', cfg.custom_models)
  push('slots', cfg.slots)
  push('usage', cfg.usage)
  if (cfg.default !== undefined) lines.push(`default = "${cfg.default}"`)
  return lines.join('\n')
}

/** 新增/覆盖一个 token source:追加 [token_source.<id>] 节到 config.toml。
 * 已存在则与新 cfg 字段级合并(新值优先,旧键保留)—— 重跑 <source>-setup
 * 只更新凭据,不洗掉 models/slots/usage 等既有配置。写完热更新 registry。 */
export function saveTokenSourceConfig(id: string, cfg: TokenSourceConfig): void {
  const existing = readFileSync(CONFIG_FILE, 'utf8')
  // 逐行状态机找节:节边界 = 行首 [xxx](值里可含 '[',如 slots = "opus=GLM-5.2[1m]",
  // regex 硬截断会吞值,故不用正则切多行节体)。
  const header = `[token_source.${id}]`
  const lines = existing.split('\n')
  let inSection = false
  const prev = loadConfig().token_sources[id] ?? {}
  const kept: string[] = []
  for (const line of lines) {
    const section = line.match(/^\s*(\[[^\]]+\])\s*(?:#.*)?$/)?.[1]
    if (section) inSection = section === header
    if (!inSection) kept.push(line)
  }
  // undefined 才表示不改字段；空列表、空默认模型和 false 必须可以持久化。
  type ConfigScalar = string | boolean | undefined
  const combined: Record<string, ConfigScalar> = { ...prev }
  const incoming: Record<string, ConfigScalar> = { ...cfg }
  for (const k of Object.keys(incoming)) if (incoming[k] !== undefined) combined[k] = incoming[k]
  const merged = combined as TokenSourceConfig
  // 去掉 kept 尾部空行再拼新节,保持节间一个空行的布局。
  while (kept.length && kept[kept.length - 1] === '') kept.pop()
  writeStateFileAtomic(CONFIG_FILE, kept.join('\n') + '\n\n' + cfgToToml(id, merged) + '\n')
}

let configUpdateTail: Promise<void> = Promise.resolve()
function serializeConfigUpdate<T>(work: () => Promise<T>): Promise<T> {
  const result = configUpdateTail.then(work)
  // 仅释放队列；原始拒绝仍由返回的 result 向调用方传播。
  configUpdateTail = result.then(() => {}, () => {})
  return result
}

async function applyTokenSourceConfig(id: string, cfg: TokenSourceConfig): Promise<void> {
  saveTokenSourceConfig(id, cfg)
  reloadTokenSources()
  buildTokenSourcesFromConfig()
  // 重建会清空各账号的目录；所有调用方共用这次刷新。
  await refreshAllTokenSourceModels()
}

export function addTokenSource(id: string, cfg: TokenSourceConfig): Promise<void> {
  return serializeConfigUpdate(() => applyTokenSourceConfig(id, cfg))
}

/** 所有群共用同一账号的列表；在队列内部读取最新列表，避免并发增删互相覆盖。 */
export function editTokenSourceModels(id: string, model: string, action: 'add' | 'remove'): Promise<void> {
  return serializeConfigUpdate(async () => {
    const source = getTokenSource(id)
    if (!source?.enabled || !source.modelSelection) throw new Error('此账号不支持维护可选模型列表')
    const selected = source.modelSelection.modelIds.filter(id => source.models.find(entry => entry.model === id)?.origin !== 'custom')
    if (action === 'add') {
      if (source.modelCatalogState?.status !== 'ready') throw new Error(source.modelCatalogState?.error ?? '模型目录未就绪')
      const candidate = source.modelSelection.availableModels.find(entry => entry.model === model)
      if (candidate?.origin === 'custom') throw new Error('补录模型请使用删除操作')
      if (!candidate || (source.modelSelection.mode !== 'catalog' && (candidate.unavailableReason || !candidate.efforts.length))) {
        throw new Error('模型不在允许添加的账号目录中')
      }
      if (selected.includes(model)) throw new Error('模型已在可选列表中')
    } else if (!selected.includes(model)) throw new Error('模型已不在可选列表中')
    const models = action === 'add' ? [...selected, model] : selected.filter(value => value !== model)
    const cfg = config.token_sources[id]
    const isCatalog = source.modelSelection.mode === 'catalog'
    const hidden = modelList(cfg?.hidden_models)
    const update: TokenSourceConfig = isCatalog
      ? { hidden_models: (action === 'remove' ? [...new Set([...hidden, model])] : hidden.filter(id => id !== model)).join(',') }
      : { models: models.join(',') }
    await applyTokenSourceConfig(id, update)
    const fresh = getTokenSource(id)
    if (fresh?.modelCatalogState?.status !== 'ready') throw new Error(`配置已保存，但目录刷新失败：${fresh?.modelCatalogState?.error ?? 'MISS'}`)
  })
}

/** 补录接口外的模型；保留已有端点验证，并允许选择请求档位直接使用。 */
export function registerCustomTokenSourceModel(id: string, raw: string): Promise<void> {
  return serializeConfigUpdate(async () => {
    const model = raw.trim()
    if (!model || model.length > 256 || /[\s,`<>\\\u0000-\u001f]/.test(model)) throw new Error('模型 ID 无效，请只填写一个完整模型名')
    const source = getTokenSource(id)
    if (!source?.enabled) throw new Error('账号不可用')
    source.validateCustomModelId?.(model)
    const catalog = source.modelSelection?.availableModels ?? source.models
    if (catalog.some(entry => entry.model.toLowerCase() === model.toLowerCase())) throw new Error('模型已在目录或补录记录中；隐藏项请使用“显示”')
    if (source.modelCatalogState?.status !== 'ready') throw new Error(source.modelCatalogState?.error ?? '模型目录未就绪')
    if (source.verifyModel) {
      const verdict = await source.verifyModel(model)
      if (verdict !== 'exists') throw new Error(verdict === 'not_found' ? '端点确认不存在' : '无法校验模型：端点无响应或凭据问题')
    }
    const cfg = config.token_sources[id]
    await applyTokenSourceConfig(id, { custom_models: [...modelList(cfg?.custom_models), model].join(',') })
    const fresh = getTokenSource(id)
    if (fresh?.modelCatalogState?.status !== 'ready') throw new Error(`补录已保存，但目录刷新失败：${fresh?.modelCatalogState?.error ?? 'MISS'}`)
  })
}

export function removeCustomTokenSourceModel(id: string, model: string): Promise<void> {
  return serializeConfigUpdate(async () => {
    const source = getTokenSource(id)
    const entry = source?.modelSelection?.availableModels.find(entry => entry.model === model)
    if (!source?.enabled || entry?.origin !== 'custom') throw new Error('此模型不是补录项，请使用隐藏操作')
    const cfg = config.token_sources[id] ?? {}
    const refers = (value: string | undefined) => value?.trim().replace(/\[1m\]$/, '') === model.replace(/\[1m\]$/, '')
    const update: TokenSourceConfig = {
      custom_models: modelList(cfg.custom_models).filter(id => !refers(id)).join(','),
      hidden_models: modelList(cfg.hidden_models).filter(id => !refers(id)).join(','),
      ...(cfg.models !== undefined ? { models: modelList(cfg.models).filter(id => !refers(id)).join(',') } : {}),
      ...(refers(cfg.model) ? { model: '', effort: '' } : {}),
      ...(cfg.slots ? { slots: cfg.slots.split(',').filter(slot => !refers(slot.slice(slot.indexOf('=') + 1))).join(',') } : {}),
    }
    await applyTokenSourceConfig(id, update)
    const fresh = getTokenSource(id)
    if (fresh?.modelCatalogState?.status !== 'ready') throw new Error(`补录已删除，但目录刷新失败：${fresh?.modelCatalogState?.error ?? 'MISS'}`)
  })
}
