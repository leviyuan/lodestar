import { isAgentProvider, isDshReasoningEffort, ModelSettingsUpdateError, type AgentProcess } from './agent-process'
import { randomUUID } from 'node:crypto'

import { Session } from './session'
import { listTokenSources, type TokenSource } from './token-source'
import { editTokenSourceModels, registerCustomTokenSourceModel, removeCustomTokenSourceModel } from './token-source-config'
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
import { messageOf, type ModelActionResult } from './session-util'
import { formatFeishuError } from './feishu-errors'

export interface ModelPanelState {
  models: cards.ModelChoice[]
  messageId?: string
  catalog?: cards.ModelChoice[]
  sourceId?: string
  mode?: 'select' | 'add'
  editable?: boolean
  sourceRevision?: string
  page?: number
  totalPages?: number
}

export const MODEL_PAGE_SIZE = 20

export type ModelSettingsOutcome = { ok: true } | { ok: false; error: unknown }
export interface ModelSettingsChange {
  proc: AgentProcess
  provider: AgentProvider
  model: string
  effort: AgentReasoningEffort
  sourceId?: string
  panelId: string
  phase: 'pending' | 'failed'
  confirmedModel: string | null
  confirmedEffort: AgentReasoningEffort | null
  error?: string
  cancelled?: string
  cancel(reason: string): void
}

function modelChangeFailure(s: Session, message: string): ModelActionResult {
  return { ok: false, message, card: cards.modelChangeStatusCard(s.sessionName, false, message) }
}

/** Called under the lifecycle mutex, including late acknowledgements. */
export async function finishModelSettingsChange(
  s: Session, change: ModelSettingsChange, outcome: ModelSettingsOutcome,
): Promise<ModelActionResult> {
  if (change.cancelled || s.modelSettingsChange !== change || s.proc !== change.proc || !change.proc.isAlive()) {
    return modelChangeFailure(s, `本次模型切换未保存：${change.cancelled ?? '原进程已退出或更换'}${outcome.ok ? '' : `；${messageOf(outcome.error)}`}`)
  }
  change.confirmedModel = outcome.ok || outcome.error instanceof ModelSettingsUpdateError && outcome.error.confirmedModel !== null
    ? change.model : null
  change.confirmedEffort = outcome.ok ? change.effort : null
  let error: string | null = outcome.ok ? null : messageOf(outcome.error)
  if (outcome.ok) {
    try {
      if (s.modelSelectionNeedsProcessStop(change.provider, change.sourceId ?? s.selectedTokenSourceId, change.model, change.effort)) {
        throw new Error('等待期间进程账号配置已变化，请 stop 后重新选择')
      }
      await s.applyModelSelectionUnlocked(change.provider, change.model, change.effort, change.sourceId)
    } catch (cause) {
      error = `模型和思考档位已应用，但保存选择失败：${messageOf(cause)}`
    }
  }
  if (error !== null) {
    change.phase = 'failed'
    change.error = `${error}。本次完整设置未保存，后续输入暂停；请重新发送 md 完成选择，或 restart 恢复已保存的设置。`
    log(`session "${s.sessionName}": model settings incomplete: ${change.error}`)
    return modelChangeFailure(s, change.error)
  }
  s.modelSettingsChange = null
  s.modelPanels.delete(change.panelId)
  s.resumeInputAfterModelSettingsChange()
  return {
    ok: true,
    message: `已选择 ${agentProviderLabel(change.provider)} · ${change.model} / ${change.effort}`,
    card: cards.modelResultCard({ sessionName: s.sessionName, provider: change.provider,
      model: change.model, effort: change.effort, scope: modelSelectionScope(s, change.provider) }),
  }
}

async function changeLiveModelSettings(
  s: Session, proc: AgentProcess, model: string, processModel: string, effort: AgentReasoningEffort,
  panelId: string, sourceId?: string,
): Promise<ModelActionResult> {
  let cancel!: (outcome: ModelSettingsOutcome) => void
  const cancelled = new Promise<ModelSettingsOutcome>(resolve => { cancel = resolve })
  const change: ModelSettingsChange = {
    proc, provider: proc.provider, model, effort, sourceId, panelId, phase: 'pending',
    confirmedModel: null, confirmedEffort: null,
    cancel(reason) { change.cancelled = reason; cancel({ ok: false, error: new Error(reason) }) },
  }
  s.modelSettingsChange = change
  const applying = Promise.resolve().then(() => proc.setModelSettings(processModel, effort))
    .then<ModelSettingsOutcome, ModelSettingsOutcome>(() => ({ ok: true }), error => ({ ok: false, error }))
  const completion = Promise.race([applying, cancelled])
  const waiting = Symbol('model-settings-pending')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([completion, new Promise<typeof waiting>(resolve => {
      timer = setTimeout(() => resolve(waiting), 20_000)
    })])
    if (outcome !== waiting) return await finishModelSettingsChange(s, change, outcome)
    const message = `正在等待 ${agentProviderLabel(proc.provider)} 确认 ${model} / ${effort}，尚不能判断切换结果。确认后会更新本卡；仍可回答 Agent 提问或用 stop 打断任务，取消本次切换请发 kill 或 restart。`
    return {
      ok: false, pending: true, message,
      card: cards.modelChangeStatusCard(s.sessionName, true, message),
      completion: completion.then(result => s.finishModelSettingsChange(change, result)),
    }
  } finally {
    clearTimeout(timer)
  }
}

// ── 第1级:账号(provider)选项 —— 每个 token source 一项 ─────
function providerChoices(s: Session): cards.ProviderChoice[] {
  const cur = s.currentTokenSource()
  return listTokenSources().map(source => s.tokenSource(source.id)!)
    // native 是兜底项:仅在 enabled 时露面(本机未命中 Pro provider → 作为默认通路);
    // disabled 说明本机已用 GLM,此时它没意义,不显示灰项干扰选择。
    .filter(ts => ts.enabled || ts.kind !== 'claude-native')
    .map(ts => ({
      provider: ts.agent as AgentProvider,
      sourceId: ts.id,
      display: ts.display,
      enabled: ts.enabled,
      modelCount: ts.models.length,
      catalogStatus: ts.modelCatalogState?.status,
      catalogError: ts.modelCatalogState?.error,
      selected: cur?.id === ts.id,
    }))
}

// ── 第2级:某账号下的具体模型(点 provider 后展示) ──────────
function modelChoicesFor(s: Session, ts: TokenSource, entries = ts.models): cards.ModelChoice[] {
  const curModel = s.currentModelLabel()
  const curEffort = s.currentEffortLabel()
  const isCurrent = s.currentTokenSource()?.id === ts.id
  return entries.map(m => {
    const selected = isCurrent && curModel === m.model
    return {
      provider: ts.agent as AgentProvider,
      sourceId: ts.id,
      model: m.model,
      displayName: m.display,
      description: m.unavailableReason ?? (m.efforts.length ? '' : 'effort MISS：上游未声明该后端支持的推理档位'),
      unavailableReason: m.unavailableReason,
      origin: m.origin,
      enabled: true,
      isDefault: false,
      selected,
      efforts: m.efforts.map(e => ({
        effort: e,
        description: e === 'default' ? '模型未提供 effort 档位，使用模型原生行为。' : '',
        isDefault: e === m.defaultEffort,
        selected: selected && curEffort === e,
      })),
    }
  })
}

/** Interactive reads use the committed catalog; background I/O never gates this card. */
export async function showModelPanel(s: Session): Promise<void> {
  const panelId = randomUUID()
  const providers = providerChoices(s)
  s.modelPanels.set(panelId, { models: [] })  // 第1级;第2级 onProviderSelect 填 models
  let sendFailure: unknown
  const messageId = await feishu.sendCard(s.chatId, cards.providerSelectionCard({
    sessionName: s.sessionName,
    panelId,
    currentDisplay: s.currentTokenSource()?.display ?? s.currentModelLabel(),
    providers,
  }), failure => { sendFailure = failure })
  if (!messageId) {
    s.modelPanels.delete(panelId)
    await feishu.sendTextRaw(s.chatId, `❌ 模型面板发送失败：${formatFeishuError(sendFailure)}`)
  } else {
    const panel = s.modelPanels.get(panelId)
    if (panel) panel.messageId = messageId
  }
}

/** 第1级点账号 → 发第2级(该账号的模型列表)。返回第2级卡替换当前卡。 */
export async function onProviderSelect(
  s: Session,
  sourceIdRaw: string,
  panelIdRaw = '',
): Promise<ModelActionResult> {
  const sourceId = sourceIdRaw.trim()
  const ts = s.tokenSource(sourceId)
  if (!ts) return { ok: false, message: `未知账号: ${sourceId}` }
  if (!ts.enabled) return { ok: false, message: ts.modelCatalogState?.error ?? `${ts.display} 未配置,请先点「启用」` }
  const panelId = panelIdRaw.trim()
  if (!s.modelPanels.has(panelId)) return { ok: false, message: '模型面板已失效，请重新发送 model' }
  if (ts.modelCatalogState?.status === 'failed') {
    return { ok: false, message: `模型目录 MISS：${ts.modelCatalogState.error ?? '刷新失败'}` }
  }
  if (ts.modelCatalogState?.status === 'idle' || ts.modelCatalogState?.status === 'loading') {
    return { ok: false, message: '模型目录缓存尚未就绪，后台刷新中' }
  }
  const catalog = modelChoicesFor(s, ts)
  const messageId = s.modelPanels.get(panelId)?.messageId
  s.modelPanels.set(panelId, { models: [], catalog, sourceId, messageId, mode: 'select', editable: !!ts.modelSelection,
    sourceRevision: ts.spawnRevision })
  return onModelPage(s, panelId, sourceId, 0)
}

/** 在服务端保存的目录快照中翻页；只允许选择当前页上的模型。 */
export async function onModelPage(s: Session, panelId: string, sourceId: string, page: number): Promise<ModelActionResult> {
  const panel = s.modelPanels.get(panelId)
  if (!panel?.catalog || panel.sourceId !== sourceId) return { ok: false, message: '模型面板已失效，请重新发送 model' }
  const totalPages = Math.max(1, Math.ceil(panel.catalog.length / MODEL_PAGE_SIZE))
  if (!Number.isInteger(page) || page < 0 || page >= totalPages) return { ok: false, message: '模型页码无效' }
  panel.models = panel.catalog.slice(page * MODEL_PAGE_SIZE, (page + 1) * MODEL_PAGE_SIZE)
  panel.page = page
  panel.totalPages = totalPages
  return {
    ok: true,
    message: '',
    card: cards.modelSelectionCard({
      sessionName: s.sessionName,
      panelId,
      currentModel: s.currentModelLabel(),
      currentEffort: s.currentEffortLabel(),
      models: panel.models,
      sourceId,
      editable: panel.editable,
      allowCustom: true,
      mode: panel.mode,
      ...(totalPages > 1 ? { pagination: { sourceId, page, totalPages } } : {}),
    }),
  }
}

/** 可编辑来源的完整候选目录；不接受回调自行传入候选项或来源。 */
export async function onModelAddOpen(s: Session, panelId: string, sourceId: string): Promise<ModelActionResult> {
  const panel = s.modelPanels.get(panelId)
  const source = s.tokenSource(sourceId)
  if (!panel || panel.sourceId !== sourceId || !source?.enabled || !source.modelSelection) {
    return { ok: false, message: '模型管理面板已失效，请重新发送 md' }
  }
  if (source.modelCatalogState?.status !== 'ready') return { ok: false, message: source.modelCatalogState?.error ?? '目录未就绪' }
  const candidates = source.modelSelection.availableModels.filter(model =>
    model.origin !== 'custom' && !source.modelSelection!.modelIds.includes(model.model)
      && (source.modelSelection!.mode === 'catalog' || (!model.unavailableReason && model.efforts.length > 0)))
  s.modelPanels.set(panelId, { models: [], catalog: modelChoicesFor(s, source, candidates), sourceId,
    messageId: panel.messageId, mode: 'add', editable: true, sourceRevision: source.spawnRevision })
  return onModelPage(s, panelId, sourceId, 0)
}

/** 增删只修改面板可见列表，不改当前会话、默认模型或辅助模型路由。 */
export async function onModelListEdit(
  s: Session, panelId: string, sourceId: string, model: string, action: 'add' | 'remove' | 'delete',
): Promise<ModelActionResult> {
  const panel = s.modelPanels.get(panelId)
  const source = s.tokenSource(sourceId)
  if (!panel?.editable || panel.sourceId !== sourceId || !source?.modelSelection
    || panel.sourceRevision !== source.spawnRevision || panel.mode !== (action === 'add' ? 'add' : 'select')
    || !panel.models.some(entry => entry.model === model)) {
    return { ok: false, message: '模型管理选项已失效，请重新发送 md' }
  }
  if (action === 'delete') {
    const users = [...Session.all].filter(session => session.currentTokenSource()?.id === sourceId
      && session.currentModelLabel() === model.replace(/\[1m\]$/, ''))
    if (users.length) return { ok: false, message: `补录模型仍被会话 ${users.map(session => session.sessionName).join('、')} 选用，请先切换再删除` }
  }
  try {
    if (action === 'delete') await removeCustomTokenSourceModel(sourceId, model, s.codexAccountId())
    else await editTokenSourceModels(sourceId, model, action, s.codexAccountId())
    // 其他面板的快照在列表变化后失效；不影响会话、进程和正在运行的 turn。
    for (const session of Session.all) {
      for (const [id, other] of session.modelPanels) {
        if (other.sourceId === sourceId && (session !== s || id !== panelId)) session.modelPanels.delete(id)
      }
    }
    const result = await onProviderSelect(s, sourceId, panelId)
    return { ...result, message: action === 'add' ? '模型已显示' : action === 'delete' ? '补录模型已删除' : '模型已隐藏' }
  } catch (error) {
    return { ok: false, message: `模型列表更新失败：${messageOf(error)}` }
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
  const ts = s.tokenSource(sourceIdRaw.trim())
  if (!ts) return { ok: false, message: `未知账号: ${sourceIdRaw}` }
  if (!ts.enabled) return { ok: false, message: `${ts.display} 未配置` }
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
  const ts = s.tokenSource(pending.sourceId)
  const cardFailures: string[] = []
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
      let replaceFailure: unknown
      replaced = await cardkit.replaceElementChecked(
        cardId,
        cards.ELEMENTS.modelPanel,
        panel,
        { notifyCardFailure: false, onFailure: failure => { replaceFailure = failure } },
      )
      if (!replaced) throw new Error(`model panel replace rejected: ${formatFeishuError(replaceFailure)}`)
      let settingsFailure: unknown
      closed = await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } }, failure => { settingsFailure = failure })
      if (!closed) throw new Error(`model panel streaming-off rejected: ${formatFeishuError(settingsFailure)}`)
    } catch (e: any) {
      log(`model-custom: card update MISS (${e?.message ?? e})`)
      cardFailures.push(messageOf(e))
    } finally {
      if (cardId) {
        // A failed replace can happen after CardKit reopened an expired static
        // card. Always make one checked close attempt, but only tombstone the
        // local state after streaming-off is confirmed.
        if (!closed) {
          try {
            let settingsFailure: unknown
            closed = await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } }, failure => { settingsFailure = failure })
            if (!closed) cardFailures.push(`model panel streaming-off rejected: ${formatFeishuError(settingsFailure)}`)
          } catch (e: any) {
            log(`model-custom: streaming-off retry MISS (${e?.message ?? e})`)
            cardFailures.push(formatFeishuError(e))
          }
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
    const details = [...new Set(cardFailures)].join('\n')
    const fallback = `⚠️ 模型补录结果未能写回原卡。${result}${details ? `\n${details}` : ''}\n请重新发送 model 打开面板。`
    const sent = await feishu.sendTextRaw(s.chatId, fallback)
    if (!sent) log(`model-custom: visible fallback send MISS (${result})`)
    return false
  }
  const failCard = (reason: string) => updateCardOrFallback(
    cards.modelCustomResultPanelElement(false, model, reason),
    `❌ ${model ? `模型 ${model}` : '模型名'} 未加入：${reason}。`,
  )
  if (!ts || !ts.enabled) {
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
  try {
    await registerCustomTokenSourceModel(ts.id, model, s.codexAccountId())
  } catch (error) {
    log(`model-custom: config/refresh MISS (${messageOf(error)})`)
    await failCard(`配置写入或模型刷新失败：${messageOf(error)}`)
    return true
  }
  log(`model-custom: ${ts.id} 补录 ${model} by ${user}(记录已持久化)`)
  for (const session of Session.all) {
    for (const [id, panel] of session.modelPanels) {
      if (panel.sourceId === ts.id && (session !== s || id !== pending.panelId)) session.modelPanels.delete(id)
    }
  }
  const fresh = s.tokenSource(ts.id)
  if (!fresh || fresh.modelCatalogState?.status !== 'ready') {
    await failCard(fresh?.modelCatalogState?.error ?? '刷新后的账号目录不可用')
    return true
  }
  const models = modelChoicesFor(s, fresh)
  const selected = models.find(m => m.model === model)
  if (!selected) {
    await failCard('补录已保存，但刷新后的模型列表未返回该项')
    return true
  }
  s.modelPanels.set(pending.panelId, { models, messageId: pending.cardMessageId })
  if (selected.unavailableReason || !selected.efforts.length) {
    await updateCardOrFallback(cards.modelCustomResultPanelElement(true, model,
      `**MISS**：${selected.unavailableReason ?? '后端未确认 effort'}。记录已保存，可在模型面板删除。`), `模型 ${model} 已补录，能力尚未确认。`)
    return true
  }
  if (selected.efforts.length === 1) {
    const result = await s.onModelEffortSelect(selected.model, selected.efforts[0].effort, pending.panelId, user, selected.provider)
    const present = (result: ModelActionResult) => updateCardOrFallback(result.pending
      ? cards.modelChangeStatusPanelElement(true, result.message)
      : result.ok
        ? cards.modelResultPanelElement({ sessionName: s.sessionName, provider: selected.provider,
            model: selected.model, effort: selected.efforts[0].effort,
            scope: modelSelectionScope(s, selected.provider ?? 'codex') })
        : cards.modelChangeStatusPanelElement(false, result.message), result.message)
    await present(result)
    if (result.completion) {
      void result.completion.then(present).catch(async error => {
        const message = `模型补录后的切换结果呈现失败：${messageOf(error)}`
        log(`model-custom: ${message}`)
        await feishu.sendTextRaw(s.chatId, `❌ ${message}`)
      })
    }
    return true
  }
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
  if (provider === 'codex' && s.proc?.isAlive() && s.proc.provider === provider) return 'Codex 需重启进程生效(发 restart)。'
  if (s.currentTurn) return '当前 turn 不变,后续新 turn 使用。'
  if (s.proc?.isAlive() && s.proc.provider === provider) {
    // codex 热切换 setModelSettings no-op(thread/settings/update 踩坑避),需重启进程生效;
    // claude 冷热都靠 env slots + SDK model,下一轮即生效。
    return provider === 'codex' ? 'Codex 需重启进程生效(发 restart)。' : '下一轮开始使用。'
  }
  return `下次启动 ${agentProviderLabel(provider)} 时使用。`
}

/** 有多个档位才进入第3级；只有一个档位（含模型原生 default）时直接应用。 */
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
  if (s.modelPanels.get(panelIdRaw.trim())?.mode === 'add') return { ok: false, message: '请先将模型添加到可选列表' }
  if (choice.unavailableReason) return { ok: false, message: choice.unavailableReason }
  if (choice.enabled === false) {
    return { ok: false, message: `${choice.displayName} 未配置,请先点「启用」` }
  }
  if (choice.efforts.length === 0) return { ok: false, message: '模型未返回 effort' }
  if (choice.efforts.length === 1) {
    // 复用正常选择的验证和持久化；当前调用已持有 Session 生命周期锁。
    return onModelEffortSelect(s, model, choice.efforts[0].effort, panelIdRaw, _userOpenId, provider)
  }
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
  if (s.modelSettingsChangesClosed) return { ok: false, message: 'daemon 正在停止，本次模型选择未执行' }
  if (s.modelSettingsChange?.proc === s.proc && s.modelSettingsChange?.phase === 'pending') {
    return { ok: false, message: '上一项模型设置仍在等待后端确认，本次选择未执行；请等待结果，取消切换请发 kill 或 restart。' }
  }
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
  const source = s.tokenSource(choice.sourceId)
  if (source?.modelCatalogState) {
    if (!source.enabled || source.modelCatalogState.status !== 'ready') {
      return { ok: false, message: `模型目录 MISS：${source.modelCatalogState.error ?? source.modelCatalogState.status}` }
    }
    if (!source.models.some(entry => entry.model === model && entry.efforts.includes(effort))) {
      return { ok: false, message: '模型或 effort 已不在账号目录中，请重新发送 model' }
    }
  }
  const sourceChanged = !!choice.sourceId && s.currentTokenSource()?.id !== choice.sourceId
  const environmentChanged = !s.processSourceMatches(source, model) || !!source?.modelEnvironmentRevision
    && source.modelEnvironmentRevision(s.currentModelLabel() ?? '') !== source.modelEnvironmentRevision(model)
  const processNeedsStop = s.modelSelectionNeedsProcessStop(provider, choice.sourceId ?? s.selectedTokenSourceId, model, effort)
  const selectionUnchanged = s.currentProvider() === provider &&
    !sourceChanged &&
    s.currentModelLabel() === model &&
    s.currentEffortLabel() === effort
  if (selectionUnchanged && !s.modelSettingsChange && !processNeedsStop && !environmentChanged) {
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
  if ((environmentChanged || processNeedsStop) && s.proc?.isAlive() && procBusy) {
    return { ok: false, message: '新模型需要更新进程配置，请等当前任务结束后再选择' }
  }
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
    if (s.proc?.isAlive() && s.proc.provider === provider && !sourceChanged && !environmentChanged && !processNeedsStop) {
      const processModel = choice.sourceId
        ? s.tokenSource(choice.sourceId)?.resolveSpawnModel(model) ?? model
        : model
      if (provider === 'codex') {
        // Codex only records a future launch selection; its settings method
        // does not mutate the live thread and has no late acknowledgement.
        await s.proc.setModelSettings(processModel, effort)
      } else {
        return await changeLiveModelSettings(s, s.proc, model, processModel, effort, panelId, choice.sourceId)
      }
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
    return { ok: false, message }
  }
}
