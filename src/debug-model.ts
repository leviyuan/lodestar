/** 本机 debug socket 的模型测试边界；不创建 Session，不暴露凭据或通用方法调用。 */
import { randomUUID } from 'node:crypto'
import type { Session } from './session'
import { isAgentProvider } from './agent-process'
import { listTokenSources } from './token-source'
import { codexAccounts, processCodexAccount } from './codex-accounts'

const MODEL_ACTIONS = new Set(['provider_select', 'model_select', 'model_effort_select',
  'model_page', 'model_list_open', 'model_add', 'model_remove', 'model_custom_remove', 'model_custom_prompt', 'model_panel_cancel'])
const ACTION_FIELDS = new Set(['kind', 'panel_id', 'source_id', 'model', 'effort', 'provider', 'page', 'mode'])

export interface DebugContext { chat_id: string; sender_open_id: string }
export interface DebugCardMessage {
  message_id?: string; chat_id?: string; msg_type?: string
  sender?: { id?: string; sender_type?: string }
}

export function debugModelState(session: Session) {
  return {
    session_name: session.sessionName, chat_id: session.chatId, status: session.status,
    running: session.isRunning(),
    native_session_id: session.proc?.sessionId ?? null,
    codex_account: session.proc?.provider === 'codex' && session.proc.isAlive() ? {
      name: codexAccounts.get(processCodexAccount(session.proc)).name,
      mode: session.proc.codexAccountSelectionMode?.() ?? 'native',
      policy: 'highest-score-plus-5h-ultra-pro-0.5',
    } : null,
    busy: !!(session.currentTurn || session.openingTurn || session.pendingUserMessageCount || session.pendingMidTurnMsgs.length),
    awaiting_model_input: !!session.modelCustomPrompt,
    last_result: session.proc ? { anchor: session.proc.lastAssistantUuid,
      subtype: session.proc.lastResult.subtype, is_error: session.proc.lastResult.is_error } : null,
    selection: { provider: session.selectedProvider, source_id: session.selectedTokenSourceId,
      model: session.selectedModel, effort: session.selectedEffort },
    panels: [...session.modelPanels].map(([id, panel]) => ({
      panel_id: id, message_id: panel.messageId, source_id: panel.sourceId,
      mode: panel.mode, editable: panel.editable, total_models: panel.catalog?.length,
      page: panel.page, total_pages: panel.totalPages,
      models: panel.models.map(model => ({ model: model.model, provider: model.provider,
        source_id: model.sourceId, efforts: model.efforts.map(e => e.effort), origin: model.origin })),
    })),
    sources: listTokenSources().map(source => ({
      id: source.id, display: source.display, agent: source.agent, enabled: source.enabled,
      validates_custom_model: !!source.verifyModel,
      status: source.modelCatalogState?.status, error: source.modelCatalogState?.error,
      models: source.models.map(model => ({ model: model.model, efforts: model.efforts,
        default_effort: model.defaultEffort, unavailable_reason: model.unavailableReason, origin: model.origin })),
    })),
  }
}

export type DebugModelSnapshot = ReturnType<typeof debugModelState>

/** 消息必须属于目标群、本应用和当前面板。操作用户固定来自已验证的 debug context。 */
export function debugModelActionEvent(
  body: unknown, context: DebugContext, message: DebugCardMessage | undefined,
  appId: string, panelMessageId: string | undefined,
): object {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad action body')
  const input = body as Record<string, unknown>
  if (!context.chat_id.startsWith('oc_') || !context.sender_open_id.startsWith('ou_')) throw new Error('invalid debug context')
  if (input.chat_id !== context.chat_id) throw new Error('debug chat mismatch')
  if (typeof input.message_id !== 'string' || !input.message_id.startsWith('om_')) throw new Error('message_id required')
  if (!panelMessageId || input.message_id !== panelMessageId) throw new Error('stale or mismatched model panel')
  if (!message || message.message_id !== input.message_id || message.chat_id !== context.chat_id
    || message.msg_type !== 'interactive' || message.sender?.sender_type !== 'app' || message.sender.id !== appId) {
    throw new Error('model card must belong to this app and debug chat')
  }
  if (!input.value || typeof input.value !== 'object' || Array.isArray(input.value)) throw new Error('action value required')
  const value: Record<string, string | number> = {}
  for (const [key, field] of Object.entries(input.value)) {
    if (!ACTION_FIELDS.has(key)) throw new Error(`unsupported model action field: ${key}`)
    if (key === 'page') {
      if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) throw new Error('invalid page')
      value.page = field
    } else {
      if (typeof field !== 'string' || !field.trim() || field.length > 1024) throw new Error(`invalid ${key}`)
      value[key] = field.trim()
    }
  }
  if (!MODEL_ACTIONS.has(String(value.kind))) throw new Error('only model panel actions are supported')
  for (const field of ['panel_id', 'source_id']) if (!value[field]) throw new Error(`${field} required`)
  if (['model_select', 'model_effort_select', 'model_add', 'model_remove', 'model_custom_remove'].includes(String(value.kind)) && !value.model) throw new Error('model required')
  if (value.kind === 'model_effort_select' && !value.effort) throw new Error('effort required')
  if (value.kind === 'model_page' && value.page === undefined) throw new Error('page required')
  if (value.kind === 'model_list_open' && value.mode !== 'select' && value.mode !== 'add') throw new Error('invalid model list mode')
  if (value.provider !== undefined && !isAgentProvider(value.provider)) throw new Error('invalid provider')
  return {
    event_id: `debug-model-${randomUUID()}`,
    operator: { open_id: context.sender_open_id },
    context: { open_chat_id: context.chat_id, open_message_id: input.message_id },
    action: { tag: 'button', value },
  }
}
