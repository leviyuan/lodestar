/**
 * Permission flow split out of session.ts. The daemon merges the
 * permission ask into the existing tool element in the current turn
 * card — one continuous timeline: ⏳ pending → 🔐 awaiting approval
 * (with buttons) → ⏳ allowed / ❌ denied → ✅ with output. No
 * floating orange card.
 */

import type { Session } from './session'
import type { CanUseToolRequest } from './codex-process'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { logError, logDiagnostic } from './log'
import { finalizeAsk } from './session-ask'

export async function onPermissionDecision(
  s: Session,
  requestId: string,
  decision: 'allow' | 'allow_always' | 'deny',
  user: string,
): Promise<{ ok: boolean; message: string }> {
  const pending = s.pendingPermissions.get(requestId)
  if (!pending) {
    logDiagnostic('session-permission: stray permission')
    return { ok: false, message: '此权限请求已失效或已处理' }
  }
  const proc = s.proc
  if (!proc) {
    logDiagnostic('session-permission: permission has no active process')
    return { ok: false, message: '后端进程已退出，权限决定未送达' }
  }

  const codexDecision = decision === 'deny' ? 'deny' : 'allow'
  try {
    proc.sendPermissionResponse(requestId, codexDecision, decision === 'allow_always'
      ? { updatedPermissions: pending.permissionSuggestions }
      : undefined)
  } catch (error) {
    logError('session-permission: permission response failed', error)
    return { ok: false, message: `权限决定发送失败: ${error instanceof Error ? error.message : error}` }
  }
  // The protocol response is the commit point. Only now consume the pending
  // request and repaint the main CardKit card.
  s.pendingPermissions.delete(requestId)

  // Update the tool element in the main turn card in place — the
  // permission decision lives on the same row as the tool call.
  const turn = s.currentTurn
  const meta = turn?.toolByUseId.get(pending.toolUseId)
  if (turn && meta) {
    // Task 工具的面板由 session board 渲染(见 cards/task-board.ts),审批
    // 决策时 board 尚未因本次调用改变(deny=操作没生效;allow=等 completeTool
    // 才更新),所以这里只换 status emoji + 把审批备注塞进 resolvedNote。
    const taskName = cards.asTaskToolName(meta.name)
    if (decision === 'deny') {
      const note = `🚫 已拒绝 by ${user || '匿名'}`
      const el = taskName
        ? cards.taskBoardElement(meta.i, s.taskBoard, { name: taskName, status: '❌' }, note)
        : cards.toolCallElement(meta.i, meta.name, meta.displayInput ?? meta.input, note, '❌')
      void cardkit.replaceElement(turn.cardId, cards.ELEMENTS.tool(meta.i), el)
    } else {
      const label = decision === 'allow_always' ? '始终允许' : '已允许'
      meta.resolvedNote = `✅ **${label}** by ${user || '匿名'}`
      const el = taskName
        ? cards.taskBoardElement(meta.i, s.taskBoard, { name: taskName, status: '⏳' }, meta.resolvedNote)
        : cards.toolCallElement(meta.i, meta.name, meta.displayInput ?? meta.input, null, '⏳', meta.resolvedNote)
      void cardkit.replaceElement(turn.cardId, cards.ELEMENTS.tool(meta.i), el)
    }
  }

  if (s.pendingPermissions.size === 0 && s.status === 'awaiting_permission') {
    s.status = 'working'
  }
  return {
    ok: true,
    message: decision === 'deny' ? '已拒绝' : decision === 'allow_always' ? '已始终允许' : '已允许',
  }
}

/** Merge the permission ask into the existing tool element in the
 * current turn card. The user sees one continuous timeline: ⏳ pending
 * → 🔐 awaiting approval (with buttons) → ⏳ allowed / ❌ denied → ✅
 * with output. No floating orange card.
 *
 * `tool_use` is emitted as part of the assistant message and lands on
 * our `addTool` handler BEFORE the SDK's `can_use_tool` control_request
 * arrives — so by the time we get here, `toolByUseId` already has the
 * entry we need to replace.
 *
 * Edge cases (no current turn / missing tool_use_id / unknown id) are
 * surfaced loudly and auto-denied. We don't fall back to a standalone
 * card — per the project's no-fallbacks rule, hidden anomalies are
 * worse than visible deny errors. */
export function renderPermission(s: Session, req: CanUseToolRequest): void {
  const turn = s.currentTurn
  if (!turn) {
    s.proc?.sendPermissionResponse(req.request_id, 'deny', { denyMessage: 'no active turn' })
    return
  }
  const toolUseId = req.tool_use_id
  if (!toolUseId) {
    s.proc?.sendPermissionResponse(req.request_id, 'deny', { denyMessage: 'no tool_use_id' })
    return
  }
  const meta = turn.toolByUseId.get(toolUseId)
  if (!meta) {
    logDiagnostic('session-permission: permission requested for unknown tool')
    s.proc?.sendPermissionResponse(req.request_id, 'deny', { denyMessage: 'unknown tool_use_id' })
    return
  }
  // AskUserQuestion: SDK routes it through can_use_tool. The PAYLOAD
  // of "user has answered" is the permission
  // response itself — specifically `updatedInput.answers`. So we
  // CANNOT auto-allow here (that's the v0.1.2 bug: SDK got an empty
  // answers map and immediately synthesised a "User has answered
  // your questions: ." tool_result). Park the requestId on the
  // pendingAsk record and wait for the user to click an option;
  // onAskAnswer will then send allow + updatedInput.answers in one
  // shot. If the user already clicked between addTool and now —
  // the deferredAnswer slot — settle immediately.
  if (meta.name === 'AskUserQuestion') {
    const ask = s.pendingAsks.get(toolUseId)
    if (!ask) {
      logDiagnostic('session-permission: AskUserQuestion missing pendingAsk')
      s.proc?.sendPermissionResponse(req.request_id, 'deny', { denyMessage: 'no pending ask' })
      return
    }
    ask.requestId = req.request_id
    s.pendingPermissions.set(req.request_id, { toolUseId })
    // Fast-clicker race: the user may have answered every question
    // while we were still waiting for can_use_tool to arrive. If so,
    // advanceAsk parked the all-done state and we drain it now.
    if (ask.currentIdx === undefined) finalizeAsk(s, toolUseId)
    return
  }
  s.status = 'awaiting_permission'
  s.pendingPermissions.set(req.request_id, { toolUseId, permissionSuggestions: req.permission_suggestions })
  const el = cards.toolCallPermissionElement(meta.i, meta.name, meta.displayInput ?? meta.input, req.request_id)
  void cardkit.replaceElement(turn.cardId, cards.ELEMENTS.tool(meta.i), el)
  // Phone push — Codex is blocked until the user approves/denies.
  // Set summary to "🔐 等审批: <tool>(<input summary>)" so the lock-
  // screen notification shows which tool needs approval.
  if (turn.userOpenId && turn.messageId) {
    const inputSummary = cards.summarizeToolInput(meta.name, meta.displayInput ?? meta.input)
    const toolName = cards.displayToolName(meta.name)
    const tail = inputSummary && inputSummary.length > 30
      ? inputSummary.slice(0, 30) + '…'
      : inputSummary
    const summary = tail
      ? `🔐 等审批: ${toolName} · ${tail}`
      : `🔐 等审批: ${toolName}`
    void (async () => {
      cardkit.cancelSummary(turn.cardId)
      await cardkit.patchSettings(turn.cardId, { config: { summary: { content: summary } } })
      await feishu.urgentApp(turn.messageId, [turn.userOpenId])
    })()
  }
}
