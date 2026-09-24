/** Text replies to local notifications. Called through the daemon's shared
 * per-chat actor, so prompt creation and incoming messages retain FIFO order. */
import { randomUUID } from 'node:crypto'
import {
  get, findPendingReply, pendingRepliesForChat, hasReplyMessage, setReplyState, markResolved, markUnknown,
  recordCallbackSuccess, isDispatching, setDispatching, clearDispatching,
  type NotifyRegistration, type NotifyReplyState, type NotifyTextResponse, type DispatchResult,
} from './notify-callbacks'
import { buildNotifyCardFromReg, buildNotifyReplyCard, type NotifyResolution } from './notify'
import { formatFeishuError } from './feishu-errors'

interface ReplyActionResult {
  ok: boolean
  message: string
  presented?: boolean
}

export interface NotifyReplyMessage {
  chatId: string
  openId: string
  messageId: string
  text: string
  createTime: number
  parentId?: string
}

export function createNotifyReplyRuntime(deps: {
  sendCard(chatId: string, card: object, onFailure?: (error: unknown) => void): Promise<string | null>
  updateCard(messageId: string, card: object): Promise<void>
  sendText(chatId: string, text: string, onFailure?: (error: unknown) => void): Promise<string | null>
  dispatch(reg: NotifyRegistration, response: NotifyTextResponse, openId: string): Promise<DispatchResult>
  onWaitingChanged(chatId: string): void
  log(text: string): void
}) {
  const detailOf = (error: unknown) => error instanceof Error ? error.message : String(error)
  const unavailable = (reg: NotifyRegistration | undefined, chatId: string, openId: string): string | null => {
    if (!reg) return '通知已过期或已移除'
    if (!openId) return '无法识别回复人，操作未执行'
    if (chatId && chatId !== reg.chatId) return '通知不属于当前群，操作未执行'
    if (!reg.allowReply) return '此通知未开启文字回复'
    if (reg.unknownAt) return `回复送达状态未知，禁止自动重试：${reg.unknownReason}`
    if (reg.resolvedAt) return '此通知已处理'
    if (isDispatching(reg.notifyId)) return '通知正在处理中'
    return null
  }
  const report = async (chatId: string, message: string) => {
    deps.log(`notify-reply: ${message}`)
    let failure: unknown
    if (!await deps.sendText(chatId, `❌ ${message}`, error => { failure = error })) {
      throw new Error(`通知回复错误提示发送失败: ${formatFeishuError(failure)}；原错误：${message}`)
    }
  }
  const update = async (reg: NotifyRegistration, messageId: string, card: object, context: string) => {
    try { await deps.updateCard(messageId, card) }
    catch (error) { await report(reg.chatId, `${context}，卡片更新失败：${formatFeishuError(error)}`) }
  }

  return {
    async recover(reg: NotifyRegistration): Promise<void> {
      if (reg.dispatchState && reg.unknownAt) {
        const state = reg.dispatchState
        const button = reg.buttons.find(button => button.id === state.buttonId)
        await update(reg, reg.messageId, buildNotifyCardFromReg(reg, {
          status: 'unknown', buttonId: state.buttonId, text: button?.text ?? state.buttonId,
          operatorOpenId: state.openId, detail: reg.unknownReason,
        }), '按钮回调送达状态未知')
        return
      }
      const state = reg.replyState
      if (!state || !reg.unknownAt) return
      const resolution: NotifyResolution = {
        kind: 'text', status: 'unknown', text: state.response?.text ?? '',
        operatorOpenId: state.openId, detail: reg.unknownReason,
      }
      await update(reg, state.promptMessageId, buildNotifyReplyCard(reg, state, resolution), '回复送达状态未知')
      await update(reg, reg.messageId, buildNotifyCardFromReg(reg, resolution), '回复送达状态未知')
    },

    async open(notifyId: string, chatId: string, openId: string): Promise<ReplyActionResult> {
      const reg = get(notifyId)
      const error = unavailable(reg, chatId, openId)
      if (error || !reg) return { ok: false, message: error! }
      if (reg.replyState?.status === 'waiting' || reg.replyState?.status === 'sending') {
        return { ok: false, message: '此通知正在等待回复，请先在群里输入或由回复人取消' }
      }
      const previousReplies = pendingRepliesForChat(reg.chatId)
      if (previousReplies.some(previous => previous.replyState?.status === 'sending' || isDispatching(previous.notifyId))) {
        return { ok: false, message: '上一条通知回复正在发送，请稍后切换' }
      }
      setDispatching(notifyId)
      try {
        // The latest explicit reply selection replaces the old one for this
        // chat. Abandoned input is never submitted or silently restored if
        // opening the new prompt fails.
        for (const previous of previousReplies) {
          const cancelled: NotifyReplyState = { ...previous.replyState!, status: 'cancelled', cancelReason: 'switched' }
          setReplyState(previous.notifyId, cancelled)
          await update(previous, cancelled.promptMessageId, buildNotifyReplyCard(previous, cancelled), '已放弃上一条回复并切换通知')
        }
        const state: NotifyReplyState = {
          id: randomUUID(), openId, promptMessageId: '', openedAt: Date.now(), status: 'waiting',
        }
        let failure: unknown
        const messageId = await deps.sendCard(reg.chatId, buildNotifyReplyCard(reg, state), error => { failure = error })
        if (!messageId) return { ok: false, message: `等待输入卡片发送失败，未开始接收回复，请重新点击「回复」\n${formatFeishuError(failure)}` }
        state.promptMessageId = messageId
        try { setReplyState(notifyId, state) }
        catch (error) {
          const message = `等待输入状态保存失败，未开始接收回复：${detailOf(error)}`
          await update(reg, messageId, buildNotifyReplyCard(reg, state, { status: 'failed', detail: message }), message)
          return { ok: false, message, presented: true }
        }
        return { ok: true, message: '等待输入卡片已发送，请在群里回复一条文字', presented: true }
      } finally {
        clearDispatching(notifyId)
        deps.onWaitingChanged(reg.chatId)
      }
    },

    async cancel(notifyId: string, replyId: string, chatId: string, openId: string): Promise<ReplyActionResult> {
      const reg = get(notifyId)
      const error = unavailable(reg, chatId, openId)
      if (error || !reg) return { ok: false, message: error! }
      const state = reg.replyState
      if (!state || state.id !== replyId || state.status !== 'waiting') {
        return { ok: false, message: '此回复已结束或正在发送，无法取消' }
      }
      if (state.openId !== openId) return { ok: false, message: '仅点击「回复」的人可以取消' }
      const cancelled = { ...state, status: 'cancelled' as const }
      setReplyState(notifyId, cancelled)
      deps.onWaitingChanged(reg.chatId)
      await update(reg, state.promptMessageId, buildNotifyReplyCard(reg, cancelled), '回复已取消')
      return { ok: true, message: '已取消回复', presented: true }
    },

    async consume(message: NotifyReplyMessage): Promise<boolean> {
      const { chatId, openId, messageId, text, createTime } = message
      if (!openId || !messageId || !text.trim()) return false
      // Durable dedupe: a replay must neither POST twice nor become an Agent
      // prompt after the reply stopped waiting (including after a restart).
      if (hasReplyMessage(chatId, messageId)) return true
      const reg = findPendingReply(chatId, openId)
      if (!reg?.replyState) return false
      const state = reg.replyState
      if (createTime > 0 && createTime < state.openedAt) return false
      // The user's latest reply-button selection owns this input even when
      // Feishu attaches an older quoted message or a later Agent question.
      if (state.status !== 'waiting' || isDispatching(reg.notifyId)) {
        await report(chatId, '上一条通知回复正在发送，这条文字未提交，请稍后重发')
        return true
      }
      const response: NotifyTextResponse = { text, message_id: messageId, prompt_message_id: state.promptMessageId }
      const sending: NotifyReplyState = { ...state, status: 'sending', response }
      setDispatching(reg.notifyId)
      try {
        try { setReplyState(reg.notifyId, sending) }
        catch (error) {
          await report(chatId, `回复保存失败，尚未回传，请重新输入：${detailOf(error)}`)
          return true
        }

        let result: DispatchResult
        try {
          // Do not POST until both the durable input and its visible receipt
          // exist. A presentation failure here is still safely retryable.
          try { await deps.updateCard(state.promptMessageId, buildNotifyReplyCard(reg, sending)) }
          catch (error) { throw new Error(formatFeishuError(error)) }
          if (reg.callbackUrl) result = await deps.dispatch(reg, response, openId)
          else {
            markResolved(reg.notifyId, undefined, openId)
            result = { ok: true, detail: '已记录' }
          }
        } catch (error) {
          result = { ok: false, detail: detailOf(error) }
        }

        let resolution: NotifyResolution
        if (result.ok) {
          const recorded = reg.callbackUrl
            ? recordCallbackSuccess(reg.notifyId, undefined, openId)
            : { state: 'complete' as const }
          resolution = {
            kind: 'text', text, operatorOpenId: openId,
            status: recorded.state === 'unknown' ? 'unknown' : reg.callbackUrl ? 'delivered' : 'done',
            ...(recorded.state === 'unknown' ? { detail: recorded.detail } : { reply: result.reply }),
          }
        } else {
          resolution = { kind: 'text', text, operatorOpenId: openId, status: 'failed', detail: result.detail }
          try { setReplyState(reg.notifyId, { ...sending, status: 'failed', error: result.detail }) }
          catch (error) {
            // The disk still says sending. Surface the uncertain local state
            // and freeze this notification instead of enabling a duplicate.
            const detail = `${result.detail}；失败状态保存失败：${detailOf(error)}`
            try { markUnknown(reg.notifyId, undefined, openId, detail) }
            catch (persistError) { deps.log(`notify-reply: UNKNOWN persistence failed: ${detailOf(persistError)}`) }
            resolution = { ...resolution, status: 'unknown', detail }
          }
        }
        const context = resolution.status === 'delivered' ? '回复已送达'
          : resolution.status === 'done' ? '回复已记录'
          : resolution.status === 'unknown' ? `回复送达状态未知：${resolution.detail}`
          : `回复未送达：${resolution.detail}`
        await update(reg, state.promptMessageId, buildNotifyReplyCard(reg, sending, resolution), context)
        await update(reg, reg.messageId, buildNotifyCardFromReg(reg, resolution), context)
        deps.log(`notify-reply: notify_id=${reg.notifyId} status=${resolution.status}`)
        return true
      } finally {
        clearDispatching(reg.notifyId)
        deps.onWaitingChanged(reg.chatId)
      }
    },
  }
}
