import type { Session } from './session'
import {
  type CodexUsage,
  type ContextCompactedNotification,
  type TokenUsageUpdated,
} from './codex-process'
import type { AgentProcess } from './agent-process'
import { NothingToCompactError } from './agent-process'
import * as feishu from './feishu'
import {
  contextLimitFromAppServer,
  contextTokenRatioLabel,
  contextTokensFromUsage,
  rawContextPercentLabel,
} from './context-window'
import { diagnosticIdLabel, messageOf } from './session-util'

const CONTEXT_USAGE_AFTER_COMPACT_WAIT_MS = 1500

type ManualCompactionWatch = {
  promise: Promise<ContextCompactedNotification>
  cancel(): void
}

type ContextUsageSnapshot = {
  usage: CodexUsage | null
  contextWindow: number | null
  threadId?: string
  turnId?: string
}

type ManualCompactionUsageWatch = {
  waitFor(notice: ContextCompactedNotification, timeoutMs: number): Promise<ContextUsageSnapshot | null>
  cancel(): void
}

function watchManualCompaction(proc: AgentProcess): ManualCompactionWatch {
  let settled = false
  let resolvePromise: (notice: ContextCompactedNotification) => void = () => {}
  let rejectPromise: (e: Error) => void = () => {}
  const threadId = proc.sessionId
  const cleanup = () => {
    proc.off('context_compacted', onCompacted)
    proc.off('exit', onExit)
    proc.off('error', onError)
  }
  const finish = (notice: ContextCompactedNotification) => {
    if (settled) return
    settled = true
    cleanup()
    resolvePromise(notice)
  }
  const fail = (e: Error) => {
    if (settled) return
    settled = true
    cleanup()
    rejectPromise(e)
  }
  const onCompacted = (notice: ContextCompactedNotification) => {
    if (notice.phase === 'start') return
    if (notice.threadId && threadId && notice.threadId !== threadId) return
    finish(notice)
  }
  const onExit = () => fail(new Error(`${proc.provider} process exited before context compaction completed`))
  const onError = (e: unknown) => fail(e instanceof Error ? e : new Error(String(e)))
  const promise = new Promise<ContextCompactedNotification>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  // The process can exit while the caller still awaits compactThread(); that failure is
  // reported there, and this watch must not surface as an unhandled rejection, which
  // would shut the daemon down.
  promise.catch(() => {})
  // 大上下文压缩不设固定时限；等待完成通知，进程退出或报错时失败。
  proc.on('context_compacted', onCompacted)
  proc.once('exit', onExit)
  proc.once('error', onError)
  return {
    promise,
    cancel() {
      if (settled) return
      settled = true
      cleanup()
    },
  }
}

function watchManualCompactionUsage(proc: AgentProcess, threadId: string | null): ManualCompactionUsageWatch {
  const snapshots: ContextUsageSnapshot[] = []
  const waiters = new Set<{
    notice: ContextCompactedNotification
    finish: (snapshot: ContextUsageSnapshot | null) => void
  }>()
  const matches = (snapshot: ContextUsageSnapshot, notice: ContextCompactedNotification): boolean => {
    const targetThreadId = notice.threadId ?? threadId
    if (targetThreadId && snapshot.threadId && snapshot.threadId !== targetThreadId) return false
    if (notice.turnId) return snapshot.turnId === notice.turnId
    return true
  }
  const latestMatching = (notice: ContextCompactedNotification): ContextUsageSnapshot | null => {
    for (let i = snapshots.length - 1; i >= 0; i--) {
      const snapshot = snapshots[i]
      if (snapshot && matches(snapshot, notice)) return snapshot
    }
    return null
  }
  const onUsage = (update: TokenUsageUpdated) => {
    if (threadId && update.threadId && update.threadId !== threadId) return
    const snapshot: ContextUsageSnapshot = {
      usage: update.usage,
      contextWindow: update.contextWindow,
      threadId: update.threadId,
      turnId: update.turnId,
    }
    snapshots.push(snapshot)
    for (const waiter of [...waiters]) {
      if (matches(snapshot, waiter.notice)) waiter.finish(snapshot)
    }
  }
  proc.on('token_usage', onUsage)
  return {
    waitFor(notice: ContextCompactedNotification, timeoutMs: number): Promise<ContextUsageSnapshot | null> {
      const existing = latestMatching(notice)
      if (existing) return Promise.resolve(existing)
      return new Promise(resolve => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const waiter = {
          notice,
          finish: (snapshot: ContextUsageSnapshot | null) => {
            if (timer) clearTimeout(timer)
            waiters.delete(waiter)
            resolve(snapshot)
          },
        }
        timer = setTimeout(() => waiter.finish(null), timeoutMs)
        waiters.add(waiter)
      })
    },
    cancel() {
      proc.off('token_usage', onUsage)
      for (const waiter of [...waiters]) waiter.finish(null)
    },
  }
}

function compactContextWindowLabel(snapshot: ContextUsageSnapshot | null): string {
  if (!snapshot) return ' · 🧠 MISS'
  const tokens = contextTokensFromUsage(snapshot.usage)
  if (tokens == null) return ' · 🧠 MISS'
  const limit = contextLimitFromAppServer(snapshot.contextWindow)
  return ` · 🧠 ${rawContextPercentLabel(tokens, limit)} (${contextTokenRatioLabel(tokens, limit)})`
}

export async function runCompactCommand(s: Session): Promise<void> {
  s.clearStaleIdleQueueState('compact')
  const noActiveTurn = !s.currentTurn && s.pendingUserMessageCount === 0 && s.pendingMidTurnMsgs.length === 0 && !s.openingTurn
  if (!s.isRunning() || !s.proc) {
    s.status = 'stopped'
    s.opts.onLifecycleChange?.()
    const statusCard = await s.openStatusCard('compact', '⚪ session 当前未运行', 'grey')
    if (statusCard) {
      await s.closeStatusCard(statusCard, '⚪ 后端未运行，compact 无效')
    } else {
      await feishu.sendText(s.chatId, `⚪ session "${s.sessionName}" 当前未运行,compact 无效;用 \`hi\` 启动或 \`restart\` 恢复上一会话`)
    }
    return
  }
  if (!noActiveTurn) {
    const statusCard = await s.openStatusCard('compact', '⚠️ 当前 turn 正在执行', 'grey')
    if (statusCard) {
      await s.closeStatusCard(statusCard, '⚠️ 先 stop 当前 turn，再 compact')
    } else {
      await feishu.sendText(s.chatId, '⚠️ 当前 turn 正在执行,先 `stop` 后再 `compact`。')
    }
    return
  }
  if (s.manualContextCompactionPending) {
    const statusCard = await s.openStatusCard('compact', '⏳ 上下文压缩已在进行中', 'grey')
    if (statusCard) await s.closeStatusCard(statusCard, '⏳ 上下文压缩已在进行中')
    else await feishu.sendText(s.chatId, '⏳ 上下文压缩已在进行中。')
    return
  }

  const proc = s.proc
  const threadLabel = proc.sessionId ? diagnosticIdLabel(proc.sessionId) : ''
  const initialStatus = s.withModel(threadLabel ? `🧠 压缩上下文 thread=${threadLabel}` : '🧠 压缩上下文…')
  const statusCard = await s.openStatusCard('compact', initialStatus, 'orange')
  const finishStatus = async (status: string) => {
    if (statusCard) await s.closeStatusCard(statusCard, status)
    else await feishu.sendText(s.chatId, status)
  }
  const watch = watchManualCompaction(proc)
  const usageWatch = watchManualCompactionUsage(proc, proc.sessionId)
  s.manualContextCompactionPending = true
  try {
    s.setStatusCard(statusCard, s.withModel('🧠 发起上下文压缩'))
    await proc.compactThread()
    s.setStatusCard(statusCard, s.withModel('⏳ 等待压缩完成事件'))
    const notice = await watch.promise
    const contextSnapshot = await usageWatch.waitFor(notice, CONTEXT_USAGE_AFTER_COMPACT_WAIT_MS)
    const doneThread = notice.threadId ? ` thread=${diagnosticIdLabel(notice.threadId)}` : ''
    await finishStatus(s.withModel(`✅ 上下文已压缩${doneThread}${compactContextWindowLabel(contextSnapshot)}`))
  } catch (e) {
    watch.cancel()
    if (e instanceof NothingToCompactError) {
      await finishStatus(s.withModel(`ⓘ ${e.message}`))
    } else {
      await finishStatus(`❌ 上下文压缩失败: ${messageOf(e)}`)
    }
  } finally {
    usageWatch.cancel()
    s.manualContextCompactionPending = false
  }
}
