/**
 * AskUserQuestion flow split out of session.ts. Codex and Claude both
 * route AskUserQuestion through can_use_tool, so the "answered" state
 * lives across two SDK control messages — option clicks/custom text
 * land via Feishu callbacks first, then can_use_tool arrives and we
 * finalize with `updatedInput.answers`.
 */

import type { Session } from './session'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'
import { findPendingReply } from './notify-callbacks'

function currentAsk(s: Session) {
  return [...s.pendingAsks.entries()].find(([, pending]) => pending.currentIdx !== undefined)
}

export function askBlockReason(s: Session, toolUseId: string): string | null {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending || pending.currentIdx === undefined) return null
  if (findPendingReply(s.chatId)) return '请先完成或取消通知回复，再回答 Agent 的提问'
  if (currentAsk(s)?.[0] !== toolUseId) return '请先回答当前问题，再回答排队中的提问'
  return null
}

export function askRenderState(s: Session, toolUseId: string): cards.AskState {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending) throw new Error(`missing pending ask: ${toolUseId}`)
  const waitingFor = pending.currentIdx === undefined ? undefined
    : findPendingReply(s.chatId) ? 'notification' as const
    : currentAsk(s)?.[0] !== toolUseId ? 'question' as const : undefined
  return { currentIdx: pending.currentIdx, answered: pending.answered, waitingFor }
}

/** Alert only for the single question currently eligible for an answer. */
export function announceAsk(s: Session, toolUseId: string): void {
  const pending = s.pendingAsks.get(toolUseId)
  const turn = s.currentTurn
  if (!pending || pending.currentIdx === undefined || pending.announced || askBlockReason(s, toolUseId)
    || !turn?.userOpenId || !turn.messageId) return
  pending.announced = true
  const announcementVersion = (pending.announcementVersion ?? 0) + 1
  pending.announcementVersion = announcementVersion
  const question = pending.questions[pending.currentIdx]?.question.trim() ?? ''
  const preview = question.length > 40 ? question.slice(0, 40) + '…' : question
  const summary = pending.questions.length > 1
    ? `❓ 待回答 ${pending.questions.length} 题${preview ? `: ${preview}` : ''}`
    : preview ? `❓ ${preview}` : '❓ 等你回答问题'
  void (async () => {
    cardkit.cancelSummary(turn.cardId)
    await cardkit.patchSettings(turn.cardId, { config: { summary: { content: summary } } })
    if (s.currentTurn !== turn || s.pendingAsks.get(toolUseId) !== pending
      || pending.announcementVersion !== announcementVersion || pending.currentIdx === undefined
      || askBlockReason(s, toolUseId)) return
    await feishu.urgentApp(turn.messageId, [turn.userOpenId])
  })().catch(error => log(`session "${s.sessionName}": question notification failed: ${error}`))
}

/** Repaint after a reply opens/closes or the current question completes.
 * Pending tool calls remain parked for their original backend handshake. */
export function refreshPendingAsks(s: Session): void {
  const turn = s.currentTurn
  if (!turn) return
  for (const [toolUseId, pending] of s.pendingAsks) {
    const meta = turn.toolByUseId.get(toolUseId)
    if (!meta || pending.currentIdx === undefined) continue
    const state = askRenderState(s, toolUseId)
    if (state.waitingFor) {
      pending.announced = false
      pending.announcementVersion = (pending.announcementVersion ?? 0) + 1
    }
    void cardkit.replaceElement(turn.cardId, cards.ELEMENTS.tool(meta.i),
      cards.askUserQuestionElement(meta.i, toolUseId, pending.questions, '🤔', state))
    announceAsk(s, toolUseId)
  }
}

/** True iff there's at least one open AskUserQuestion awaiting an
 * answer in this session. `daemon.handleMessage` uses this to
 * decide whether an inbound chat message should be a custom answer
 * (routed to onAskMessageAnswer) instead of opening a new turn. */
export function hasPendingAsk(s: Session): boolean {
  return currentAsk(s) !== undefined
}

/** Funnel an arbitrary chat message into the *current* question
 * of the oldest pending ask as a `customText` answer. Multi-
 * question semantics: from the user's perspective, the chat
 * input always answers whatever question is on screen right now
 * (`pending.currentIdx`), and a new question slides in after. */
export async function onAskMessageAnswer(s: Session, text: string, user: string, msgId: string): Promise<void> {
  const active = currentAsk(s)
  if (!active) {
    log(`session "${s.sessionName}": no unanswered question; routing text to Agent`)
    await s.onUserMessage(text, [], user, msgId)
    return
  }
  const [toolUseId, pending] = active
  const blocked = askBlockReason(s, toolUseId)
  if (blocked) {
    const notice = `${blocked}。这条文字未提交，请稍后重新发送。`
    if (!await feishu.sendText(s.chatId, notice)) throw new Error(`提问等待提示发送失败: ${notice}`)
    return
  }
  const consumed = await onAskCustomAnswer(s, toolUseId, pending.currentIdx!, text, user)
  if (consumed && msgId) void feishu.addReaction(msgId, 'CheckMark')
}

/** Click handler for an option button. The click must target the
 * question currently on screen (`pending.currentIdx`); a stale
 * click (e.g. user clicked an older render before it swapped in
 * the next question) is logged and dropped — better than double-
 * answering. */
export async function onAskAnswer(
  s: Session,
  toolUseId: string,
  questionIdx: number,
  optionIdx: number,
  user: string,
): Promise<boolean> {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending) { log(`session "${s.sessionName}": stray ask answer for ${toolUseId}`); return false }
  if (questionIdx !== pending.currentIdx) {
    log(`session "${s.sessionName}": stale ask click q=${questionIdx} current=${pending.currentIdx}`)
    return false
  }
  return advanceAsk(s, toolUseId, { optionIdx, user })
}

/** Custom-text branch. Same staleness rule as onAskAnswer; empty
 * input is silently ignored (panel stays pending). Returns true iff
 * the text was actually recorded as the answer to the current
 * question — onAskMessageAnswer uses this to decide whether to stamp
 * the ✅ "answer received" reaction on the chat message. Stray /
 * empty / stale inputs return false and earn no ✅. (Card-action
 * callers ignore the return — they have their own toast.) */
export async function onAskCustomAnswer(
  s: Session,
  toolUseId: string,
  questionIdx: number,
  customText: string,
  user: string,
): Promise<boolean> {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending) { log(`session "${s.sessionName}": stray ask custom for ${toolUseId}`); return false }
  const trimmed = (customText ?? '').trim()
  if (!trimmed) { log(`session "${s.sessionName}": empty custom answer, ignoring`); return false }
  if (questionIdx !== pending.currentIdx) {
    log(`session "${s.sessionName}": stale ask custom q=${questionIdx} current=${pending.currentIdx}`)
    return false
  }
  return advanceAsk(s, toolUseId, { customText: trimmed, user })
}

/** Record an answer for the current question, advance the state
 * machine, repaint. If every question is now answered, finalize
 * (or defer the finalize until can_use_tool lands — the race is
 * handled by renderPermission). */
export function advanceAsk(
  s: Session,
  toolUseId: string,
  answer: { optionIdx?: number; customText?: string; user: string },
): boolean {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending || pending.currentIdx === undefined) return false
  const blocked = askBlockReason(s, toolUseId)
  if (blocked) { log(`session "${s.sessionName}": ask ${toolUseId} waiting: ${blocked}`); return false }
  const cur = pending.currentIdx
  const q = pending.questions[cur]
  if (!q) { log(`session "${s.sessionName}": advanceAsk currentIdx=${cur} out of range`); return false }
  // Resolve the literal answer value — custom text wins if both set.
  let value: string
  if (answer.customText !== undefined) {
    value = answer.customText
  } else if (answer.optionIdx !== undefined) {
    const opt = q.options?.[answer.optionIdx]
    if (!opt) { log(`session "${s.sessionName}": advanceAsk option ${answer.optionIdx} out of range`); return false }
    value = opt.label
  } else {
    log(`session "${s.sessionName}": advanceAsk with neither customText nor optionIdx`)
    return false
  }
  pending.answers[q.question] = value
  pending.answered.set(cur, {
    optionIdx: answer.optionIdx,
    customText: answer.customText,
    user: answer.user,
  })
  // Next unanswered idx — linear from cur+1. Implementation
  // always moves forward; we don't currently let users revisit a
  // previous question (would need richer UI affordance for that).
  const total = pending.questions.length
  let nextIdx: number | undefined = undefined
  for (let i = cur + 1; i < total; i++) {
    if (!pending.answered.has(i)) { nextIdx = i; break }
  }
  pending.currentIdx = nextIdx

  const turn = s.currentTurn
  const meta = turn?.toolByUseId.get(toolUseId)
  if (turn && meta) {
    const el = cards.askUserQuestionElement(
      meta.i, toolUseId, pending.questions,
      nextIdx === undefined ? '✅' : '🤔',
      { currentIdx: nextIdx, answered: pending.answered },
    )
    void cardkit.replaceElement(turn.cardId, cards.ELEMENTS.tool(meta.i), el)
  }

  if (nextIdx === undefined) {
    // All done. Finalize iff we have the permission request id;
    // otherwise renderPermission will pick it up when it arrives.
    if (pending.requestId) finalizeAsk(s, toolUseId)
    else {
      log(`session "${s.sessionName}": ask ${toolUseId} all answered, waiting for can_use_tool`)
      refreshPendingAsks(s)
    }
  }
  return true
}

/** Settle a fully-answered AskUserQuestion: emit the SDK allow
 * with the full `answers` record folded into `updatedInput`,
 * drop bookkeeping, restore status. The terminal panel paint was
 * already done by the final advanceAsk; this is just protocol. */
export function finalizeAsk(s: Session, toolUseId: string): void {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending || !pending.requestId) return
  const meta = s.currentTurn?.toolByUseId.get(toolUseId)
  const originalInput = meta?.input ?? {}
  s.proc?.sendPermissionResponse(pending.requestId, 'allow', {
    updatedInput: { ...originalInput, answers: pending.answers },
  })
  s.pendingPermissions.delete(pending.requestId)
  if (meta) {
    meta.output = JSON.stringify({ answers: pending.answers })
    meta.isError = false
  }
  s.pendingAsks.delete(toolUseId)
  refreshPendingAsks(s)
  if (s.pendingPermissions.size === 0 && s.status === 'awaiting_permission') {
    s.status = 'working'
  }
  // 用户答完 → 球踢回 SDK,期望模型基于 answers 推理出后续动作。
}
