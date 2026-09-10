import { isAgentProvider, isDshReasoningEffort } from './agent-process'
import { randomUUID } from 'node:crypto'

import type { Session } from './session'
import { config } from './config'
import { listTokenSources, getTokenSource, refreshAllTokenSourceModels, type TokenSource } from './token-source'
import { addTokenSource } from './token-source-config'
import { isCodexReasoningEffort } from './codex-process'
import {
  agentProviderLabel,
  isClaudeReasoningEffort,
  providerFromModel,
  type AgentProvider,
  type AgentReasoningEffort,
} from './agent-process'
import * as cards from './cards'
import * as cardkit from './cardkit'
import * as feishu from './feishu'
import { log } from './log'
import { messageOf, withTimeout, type ModelActionResult } from './session-util'

export interface ModelPanelState {
  models: cards.ModelChoice[]
}

// ── 第1级:账号(provider)选项 —— 每个 token source 一项 ─────
function providerChoices(s: Session): cards.ProviderChoice[] {
  const cur = s.currentTokenSource()
  return listTokenSources()
    // native 是兜底项:仅在 enabled 时露面(本机未命中 Pro provider → 作为默认通路);
    // disabled 说明本机已用 GLM,此时它没意义,不显示灰项干扰选择。
    .filter(ts => ts.enabled || ts.kind !== 'claude-native')
    .map(ts => ({
      provider: ts.agent as AgentProvider,
      sourceId: ts.id,
      display: ts.display,
      enabled: ts.enabled,
      modelCount: ts.models.length,
      selected: cur?.id === ts.id,
    }))
}

// ── 第2级:某账号下的具体模型(点 provider 后展示) ──────────
function modelChoicesFor(s: Session, ts: TokenSource): cards.ModelChoice[] {
  const curModel = s.currentModelLabel()
  const curEffort = s.currentEffortLabel()
  const isCurrent = s.currentTokenSource()?.id === ts.id
  return ts.models.map(m => {
    const selected = isCurrent && curModel === m.model
    return {
      provider: ts.agent as AgentProvider,
      sourceId: ts.id,
      model: m.model,
      displayName: m.display,
      description: ts.display,
      enabled: true,
      isDefault: false,
      selected,
      efforts: m.efforts.map(e => ({
        effort: e,
        description: '',
        isDefault: e === m.defaultEffort,
        selected: selected && curEffort === e,
      })),
    }
  })
}

/** model 命令:发第1级面板(选账号)。点账号 → onProviderSelect 发第2级(该账号模型)。
 *  打开即后台刷新各 source models(上游新模型上线后面板即时报出,不等 daemon 重启;
 *  失败 MISS 留旧列表,面板先用当前缓存渲染,不阻塞)。 */
export async function showModelPanel(s: Session): Promise<void> {
  void refreshAllTokenSourceModels()
  const panelId = randomUUID()
  const providers = providerChoices(s)
  s.modelPanels.set(panelId, { models: [] })  // 第1级;第2级 onProviderSelect 填 models
  const messageId = await feishu.sendCard(s.chatId, cards.providerSelectionCard({
    sessionName: s.sessionName,
    panelId,
    currentDisplay: s.currentTokenSource()?.display ?? s.currentModelLabel(),
    providers,
  }))
  if (!messageId) {
    s.modelPanels.delete(panelId)
    await feishu.sendTextRaw(s.chatId, '❌ 模型面板发送失败')
  }
}

/** 第1级点账号 → 发第2级(该账号的模型列表)。返回第2级卡替换当前卡。 */
export async function onProviderSelect(
  s: Session,
  sourceIdRaw: string,
  panelIdRaw = '',
): Promise<ModelActionResult> {
  const sourceId = sourceIdRaw.trim()
  const ts = getTokenSource(sourceId)
  if (!ts) return { ok: false, message: `未知账号: ${sourceId}` }
  if (!ts.enabled) return { ok: false, message: `${ts.display} 未配置,请先点「启用」` }
  const panelId = panelIdRaw.trim()
  const models = modelChoicesFor(s, ts)
  s.modelPanels.set(panelId, { models })
  return {
    ok: true,
    message: '',
    card: cards.modelSelectionCard({
      sessionName: s.sessionName,
      panelId,
      currentModel: s.currentModelLabel(),
      currentEffort: s.currentEffortLabel(),
      models,
    }),
  }
}

/** 「➕ 补录模型」按钮回调:进补录应答态 —— 下一条群消息(裸词命令除外)
 *  作为模型名消费。ACK 换出提示卡;等待态记住这张卡的 messageId,回复后
 *  原位更新它(通过 → effort 选择卡;失败 → 卡上红字),不单发消息。 */
export async function onModelCustomPrompt(
  s: Session,
  sourceIdRaw: string,
  panelIdRaw: string,
  cardMessageId = '',
): Promise<ModelActionResult> {
  const ts = getTokenSource(sourceIdRaw.trim())
  if (!ts) return { ok: false, message: `未知账号: ${sourceIdRaw}` }
  if (!ts.enabled) return { ok: false, message: `${ts.display} 未配置` }
  if (ts.agent !== 'claude' || !ts.verifyModel) {
    return { ok: false, message: `${ts.display} 不支持手动补录模型` }
  }
  const panelId = panelIdRaw.trim()
  if (!panelId) return { ok: false, message: '补录面板缺少 panel_id，请重新发送 model' }
  s.modelCustomPrompt = { sourceId: ts.id, panelId, cardMessageId }
  return {
    ok: true,
    message: '等待模型名',
    card: cards.modelCustomPromptCard(s.sessionName, ts.display, panelId),
  }
}

/** 补录应答态消费一条群消息(daemon 在裸词命令之后、开新 turn 之前调)。
 *  返回 true = 消息被当模型名消费,false = 不是补录态,消息走正常流程。
 *  结果一律原位更新补录卡(等待态存的 messageId):通过 → effort 选择卡
 *  (与点列表模型完全同路径);失败/已存在 → 卡上红字。正常落地不单发群消息;
 *  只有原位更新失败时才发 raw fallback，避免结果静默丢失。 */
export async function consumeModelCustomMessage(
  s: Session,
  text: string,
  user: string,
): Promise<boolean> {
  const pending = s.modelCustomPrompt
  if (!pending) return false
  s.modelCustomPrompt = null  // 一次性:无论成败,应答态结束
  const model = text.trim()
  const ts = getTokenSource(pending.sourceId)
  // 更新补录卡的 panel(失败提示/成功转 effort);id_convert 失败如实 log,
  // 状态机照常走(卡片更新是呈现,不是数据路径)。
  const updateCard = async (panel: object): Promise<boolean> => {
    if (!pending.cardMessageId) return false
    let cardId = ''
    let replaced = false
    let closed = false
    try {
      cardId = await cardkit.convertMessageToCard(pending.cardMessageId)
      // Static model cards are converted only for this one-shot mutation.
      // Register a short lifecycle so a test/client that reuses a card id does
      // not inherit an older disposed tombstone, and so finally can always
      // release the bookkeeping deterministically.
      cardkit.recordCardCreated(cardId, 1)
      replaced = await cardkit.replaceElementChecked(
        cardId,
        cards.ELEMENTS.modelPanel,
        panel,
        { notifyCardFailure: false },
      )
      if (!replaced) throw new Error('model panel replace rejected')
      closed = await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })
      if (!closed) throw new Error('model panel streaming-off rejected')
    } catch (e: any) {
      log(`model-custom: card update MISS (${e?.message ?? e})`)
    } finally {
      if (cardId) {
        // A failed replace can happen after CardKit reopened an expired static
        // card. Always make one checked close attempt, but only tombstone the
        // local state after streaming-off is confirmed.
        if (!closed) {
          try { closed = await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } }) }
          catch (e: any) { log(`model-custom: streaming-off retry MISS (${e?.message ?? e})`) }
        }
        if (replaced && closed) {
          try { await cardkit.dispose(cardId) }
          catch (e: any) { log(`model-custom: card dispose MISS (${e?.message ?? e})`) }
        } else {
          log(`model-custom: retain card state after checked MISS mutation=${replaced} streamingOff=${closed} card=${cardId.slice(0, 12)}`)
        }
      }
    }
    return replaced && closed
  }
  const updateCardOrFallback = async (panel: object, result: string): Promise<boolean> => {
    const landed = await updateCard(panel)
    if (landed) return true
    const fallback = `⚠️ 模型补录结果未能写回原卡。${result}\n请重新发送 model 打开面板。`
    const sent = await feishu.sendTextRaw(s.chatId, fallback)
    if (!sent) log(`model-custom: visible fallback send MISS (${result})`)
    return false
  }
  const failCard = (reason: string) => updateCardOrFallback(
    cards.modelCustomResultPanelElement(false, model, reason),
    `❌ ${model ? `模型 ${model}` : '模型名'} 未加入：${reason}。`,
  )
  if (!ts || !ts.enabled || !ts.verifyModel) {
    await failCard('账号不可用')
    return true
  }
  if (!model) {
    await failCard('模型名为空')
    return true
  }
  if (ts.models.some(m => m.model.toLowerCase() === model.toLowerCase())) {
    await updateCardOrFallback(
      cards.modelCustomResultPanelElement(false, model, '已在列表中'),
      `ℹ️ 模型 ${model} 已在列表中，未重复加入。`,
    )
    return true
  }
  const verdict = await ts.verifyModel(model)
  if (verdict === 'not_found') {
    await failCard('端点确认不存在')
    return true
  }
  if (verdict === 'no_verdict') {
    await failCard('无法校验(端点无响应或凭据问题)')
    return true
  }
  // 配置写入会重建全部账号；等待统一刷新后只读取新实例。
  const cfgModels = [...readSourceModelsConfig(ts.id), model].join(',')
  try {
    await withTimeout(addTokenSource(ts.id, { models: cfgModels }), 15_000, 'refreshModels')
  } catch (error) {
    log(`model-custom: config/refresh MISS (${messageOf(error)})`)
    await failCard(`配置写入或模型刷新失败：${messageOf(error)}`)
    return true
  }
  log(`model-custom: ${ts.id} 补录 ${model} by ${user}(端点校验通过,已持久化)`)
  const fresh = getTokenSource(ts.id)
  if (!fresh || fresh.modelCatalogState?.status !== 'ready') {
    await failCard(fresh?.modelCatalogState?.error ?? '刷新后的账号目录不可用')
    return true
  }
  const models = modelChoicesFor(s, fresh)
  const selected = models.find(m => m.model === model)
  if (!selected) {
    await failCard('模型已验证，但刷新后的模型列表未返回该项')
    return true
  }
  s.modelPanels.set(pending.panelId, { models })
  await updateCardOrFallback(
    cards.modelEffortSelectionPanelElement({
      sessionName: s.sessionName,
      panelId: pending.panelId,
      currentModel: s.currentModelLabel(),
      currentEffort: s.currentEffortLabel(),
      model: selected,
    }),
    `✅ 模型 ${model} 已补录成功。`,
  )
  return true
}

/** 读 config 里某 source 的 models 键现值(合并写入用,addTokenSource 是覆盖语义)。 */
function readSourceModelsConfig(sourceId: string): string[] {
  const raw = config.token_sources[sourceId]?.models
  return (raw ?? '').split(',').map(x => x.trim()).filter(Boolean)
}

/** 取消按钮(补录等待态专用):清补录态、卡收成「已取消」。普通选择面板
 *  不设取消 —— 它们不拦群消息,扔着不管无代价。幂等:无等待态也收尾卡。 */
export async function onModelPanelCancel(
  s: Session,
  panelIdRaw = '',
): Promise<ModelActionResult> {
  const panelId = panelIdRaw.trim()
  const pending = s.modelCustomPrompt
  if (!panelId || !pending || pending.panelId !== panelId) {
    return {
      ok: false,
      message: '此补录面板已失效',
      card: cards.modelCancelledCard(s.sessionName, 'stale'),
    }
  }
  s.modelCustomPrompt = null
  return {
    ok: true,
    message: '已取消',
    card: cards.modelCancelledCard(s.sessionName),
  }
}

/** 取消按钮(旧副本删除:见上方带补录态清理的版本)。 */
function actionProvider(model: string, raw: any): AgentProvider {
  return isAgentProvider(raw?.provider)
    ? raw.provider
    : providerFromModel(model)
}

function modelSelectionScope(s: Session, provider: AgentProvider): string {
  if (s.currentTurn) return '当前 turn 不变,后续新 turn 使用。'
  if (s.proc?.isAlive() && s.proc.provider === provider) {
    // codex 热切换 setModelSettings no-op(thread/settings/update 踩坑避),需重启进程生效;
    // claude 冷热都靠 env slots + SDK model,下一轮即生效。
    return provider === 'codex' ? 'Codex 需重启进程生效(发 restart)。' : '下一轮开始使用。'
  }
  return `下次启动 ${agentProviderLabel(provider)} 时使用。`
}

/** 第2级点模型 → 第3级 effort 列表。 */
export async function onModelSelect(
  s: Session,
  modelRaw: string,
  panelIdRaw = '',
  _userOpenId = '',
  actionValue: any = null,
): Promise<ModelActionResult> {
  const model = modelRaw.trim()
  if (!model) {
    const message = '模型为空'
    await feishu.sendText(s.chatId, `❌ ${message}`)
    return { ok: false, message }
  }
  const provider = actionProvider(model, actionValue)
  const choice = s.modelPanels.get(panelIdRaw.trim())?.models
    .find(m => m.model === model && (m.provider ?? 'codex') === provider)
  if (!choice) {
    return { ok: false, message: '模型不在当前选项中,请重新发送 model' }
  }
  if (choice.enabled === false) {
    return { ok: false, message: `${choice.displayName} 未配置,请先点「启用」` }
  }
  if (choice.efforts.length === 0) return { ok: false, message: '模型未返回 effort' }
  return {
    ok: true,
    message: '',
    card: cards.modelEffortSelectionCard({
      sessionName: s.sessionName,
      panelId: panelIdRaw.trim(),
      currentModel: s.currentModelLabel(),
      currentEffort: s.currentEffortLabel(),
      model: choice,
    }),
  }
}

export async function onModelEffortSelect(
  s: Session,
  modelRaw: string,
  effortRaw: string,
  panelIdRaw = '',
  _userOpenId = '',
  providerRaw = '',
): Promise<ModelActionResult> {
  const model = modelRaw.trim()
  const effortValue = effortRaw.trim()
  if (!model) return { ok: false, message: '模型为空' }
  const panelId = panelIdRaw.trim()
  const panel = s.modelPanels.get(panelId)
  const provider: AgentProvider = isAgentProvider(providerRaw)
    ? providerRaw
    : panel?.models.find(m => m.model === model)?.provider ?? providerFromModel(model)
  if (provider === 'dsh') {
    if (!isDshReasoningEffort(effortValue)) return { ok: false, message: 'DSH reasoning effort 无效' }
  } else if (provider === 'claude') {
    if (!isClaudeReasoningEffort(effortValue)) return { ok: false, message: 'Claude reasoning effort 无效' }
  } else if (!isCodexReasoningEffort(effortValue)) {
    return { ok: false, message: 'Codex reasoning effort 无效' }
  }
  const effort = effortValue as AgentReasoningEffort
  const choice = panel?.models.find(m => m.model === model && (m.provider ?? 'codex') === provider)
  if (!choice || !choice.efforts.some(item => item.effort === effort)) {
    return { ok: false, message: `${agentProviderLabel(provider)} · ${model}/${effort} 不在选项中` }
  }
  const sourceChanged = !!choice.sourceId && s.currentTokenSource()?.id !== choice.sourceId
  const selectionUnchanged = s.currentProvider() === provider &&
    !sourceChanged &&
    s.currentModelLabel() === model &&
    s.currentEffortLabel() === effort
  if (selectionUnchanged) {
    s.modelPanels.delete(panelId)
    return {
      ok: true,
      message: `当前已是 ${agentProviderLabel(provider)} · ${model} / ${effort}`,
      card: cards.modelResultCard({
        sessionName: s.sessionName,
        provider,
        model,
        effort,
        scope: '当前已是此设置，无需变更。',
      }),
    }
  }
  if (
    s.proc?.isAlive() &&
    s.proc.provider !== provider &&
    (s.currentTurn || s.openingTurn || s.pendingUserMessageCount > 0 || s.pendingMidTurnMsgs.length > 0)
  ) {
    return {
      ok: false,
      message: `当前 ${s.backendLabel(s.proc.provider)} turn 正在执行或排队；请等结束或 stop 后再切换到 ${agentProviderLabel(provider)}`,
    }
  }
  const modelChanged = s.currentModelLabel() !== model
  const profileChanged = modelChanged || sourceChanged
  const procBusy = !!(s.currentTurn || s.openingTurn || s.pendingUserMessageCount > 0 || s.pendingMidTurnMsgs.length > 0)
  if (
    provider === 'claude' &&
    s.proc?.isAlive() &&
    s.proc.provider === 'claude' &&
    profileChanged &&
    procBusy
  ) {
    return {
      ok: false,
      message: '当前 Claude turn 正在执行或排队；Claude 模型 profile 通过 env 生效，请等结束或 stop 后再切换',
    }
  }
  try {
    // 不重启 agent(保持之前体验):同 provider 切 model/effort 一律 setModelSettings 热切换
    // (SDK 记新 model,下轮/下次生效)。不再 stopIdle respawn —— 那基于旧 env-alias 假设,
    // 且会静默打断用户(发 model 选个模型就把 claude 进程杀了,离谱)。
    // 同 provider 且同 source 才热切换(env 没变,setModelSettings 改 model 即够);
    // 跨 source(GLM↔DeepSeek↔native,即使同 provider)env 变了 → 跳过热切换,交给
    // applyModelSelection→stopIdleMismatchedProcess 杀进程重启换 env。热切换只改 model
    // 不重注入 env,跨 source 会打到上一个 source 的 base_url(silent divergence)。
    if (s.proc?.isAlive() && s.proc.provider === provider && !sourceChanged) {
      const processModel = choice.sourceId
        ? getTokenSource(choice.sourceId)?.resolveSpawnModel(model) ?? model
        : model
      await withTimeout(s.proc.setModelSettings(processModel, effort), 20_000, 'thread/settings/update')
    }
    // The Session wrapper owns the lifecycle mutex for the whole card action
    // (validation + hot settings update + persisted selection). Calling the
    // unlocked core here avoids re-entering that same mutex.
    await s.applyModelSelectionUnlocked(provider, model, effort, choice.sourceId)
    const scope = modelSelectionScope(s, provider)
    s.modelPanels.delete(panelId)
    return {
      ok: true,
      message: `已选择 ${agentProviderLabel(provider)} · ${model} / ${effort}`,
      card: cards.modelResultCard({
        sessionName: s.sessionName,
        provider,
        model,
        effort,
        scope,
      }),
    }
  } catch (e) {
    const message = `模型切换失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": set model settings failed: ${messageOf(e)}`)
    await feishu.sendText(s.chatId, `❌ ${message}`)
    return { ok: false, message }
  }
}
