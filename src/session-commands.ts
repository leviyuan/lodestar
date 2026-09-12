import type { Session } from './session'
import * as feishu from './feishu'
import { log } from './log'
import { diagnosticIdLabel, messageOf } from './session-util'

type ControlCommand = 'hi' | 'stop' | 'kill' | 'restart' | 'clear' | 'compact' | 'model'

const CONTROL_COMMAND_ALIASES = new Map<string, ControlCommand>([
  ['hi', 'hi'],
  ['stop', 'stop'], ['st', 'stop'],
  ['kill', 'kill'], ['kl', 'kill'],
  ['restart', 'restart'], ['rs', 'restart'],
  ['clear', 'clear'], ['cl', 'clear'],
  ['compact', 'compact'], ['cm', 'compact'],
  ['model', 'model'], ['md', 'model'],
])

/** Run a bare-text control command (`hi`, `stop`, `kill`, `restart`, `clear`, `compact`, `model`, `task`)
 * plus their two-letter aliases where applicable.
 * Returns true if the command was consumed (don't forward to Codex).
 * Exact match, case-insensitive, ignores trailing whitespace.
 *
 * Trade-off (user-confirmed 2026-05-15): these words are reserved
 * globally — typing "hi" as a literal greeting will show the console
 * card instead of reaching Codex. The ergonomic win (no slash, no
 * shift key, one-handed phone use) outweighs the collision in this
 * product's private-bot use case. `stop` was added 2026-05-15 once
 * auto-interrupt on mid-turn user messages was removed (matching
 * Codex's native type-ahead behavior) — explicit barge-out
 * needed a knob and `kill` (full subprocess teardown) is too heavy. */
export async function runCommand(s: Session, raw: string, userOpenId = ''): Promise<boolean> {
  const namedHi = raw.trim().match(/^hi[ \t]+([^\r\n]+)$/i)
  if (namedHi) {
    const { runCodexNamedHi } = await import('./session-codex-accounts')
    await runCodexNamedHi(s, namedHi[1].trim())
    return true
  }
  const accountCommand = raw.trim().match(/^codex-(login-cancel|login|accounts|account-delete|account|auto)(?:[ \t]+([^\r\n]+))?$/i)
  if (accountCommand) {
    const { runCodexAccountCommand } = await import('./session-codex-accounts')
    await runCodexAccountCommand(s, accountCommand[1].toLowerCase(), (accountCommand[2] ?? '').trim(), userOpenId)
    return true
  }
  const wt = raw.trim().match(/^(?:wt|worktree)(?:\s+(.+))?$/i)
  if (wt) {
    await s.runWorktreeCommand((wt[1] ?? '').trim(), userOpenId)
    return true
  }
  // btw = 开临时会话(同目录,自动启动);bye = 散临时群;fk/fork = 列当前会话 turn 分叉;
  // bk/back = 列 turn；点选并通过 stale/owner 校验后才终止并切到新分支。
  if (raw.trim().match(/^btw$/i)) {
    await s.runBtwCommand(userOpenId)
    return true
  }
  if (raw.trim().match(/^bye$/i)) {
    await s.runByeCommand()
    return true
  }
  if (raw.trim().match(/^(?:fk|fork)$/i)) {
    await s.showForkList(userOpenId)
    return true
  }
  if (raw.trim().match(/^(?:bk|back)$/i)) {
    // 只展示选择卡；真正的 stop→fork 在点击具体锚点并通过 owner/provider/cwd
    // 校验之后发生，避免用户看完不点也被提前终止。
    await s.showBackList(userOpenId)
    return true
  }
  if (raw.trim().toLowerCase() === 'task') {
    await s.showTasklistPanel()
    return true
  }
  if (raw.trim().match(/^(?:agents|agent)$/i)) {
    await s.showAgentIdentityPanel(userOpenId)
    return true
  }
  // <source>-setup <args> —— 启用某 token source(generic:路由到 source factory 的 setup.parseArgs,
  // 加新 source 不改本文件 —— 在 token-source-<name>.ts 声明 setup 字段即自动接入)。
  const tsSetup = raw.trim().match(/^([\w-]+)-setup(?:\s+([\s\S]+))?$/i)
  if (tsSetup) {
    const { runTokenSourceSetup } = await import('./token-source-setup')
    await runTokenSourceSetup(s, tsSetup[1].trim().toLowerCase(), (tsSetup[2] ?? '').trim())
    return true
  }
  const command = CONTROL_COMMAND_ALIASES.get(raw.trim().toLowerCase())
  if (!command) return false
  switch (command) {
    case 'model':
      await s.showModelPanel()
      return true
    case 'compact':
      await s.runCompactCommand()
      return true
    case 'hi':
      {
        const needsStart = !s.isRunning()
        const backend = s.backendLabel()
        const statusCard = needsStart
          ? await s.openStatusCard('hi', s.withModel(`🚀 启动 ${backend}`))
          : null
        let lastStatus = s.withModel(`🚀 启动 ${backend}`)
        const ok = needsStart
          ? await s.start({
              announce: !statusCard,
              onStatus: status => {
                lastStatus = status
                s.setStatusCard(statusCard, status)
              },
            })
          : true
        if (!ok) {
          await s.closeStatusCard(statusCard, lastStatus.startsWith('❌') ? lastStatus : '❌ 启动失败')
          return true
        }
        if (s.proc?.turnRetry?.reason === 'quota') {
          const waiting = '⏳ 等待额度恢复 · 可用后自动启动，stop 可取消'
          if (statusCard) await s.closeStatusCard(statusCard, waiting)
          else {
            const { codexAccountCard } = await import('./cards/codex-account')
            if (!await feishu.sendCard(s.chatId, codexAccountCard({ phase: 'checking', title: '等待额度', message: waiting }))) {
              throw new Error('额度等待卡片发送失败')
            }
          }
          return true
        }
        if (statusCard) {
          await s.replaceStatusCardWithConsole(
            statusCard,
            s.withModel(s.withWorktreeInstructionNotice(`✅ ${s.backendLabel()} 已就绪`)),
          )
          return true
        }
        if (needsStart) {
          await s.closeStatusCard(
            statusCard,
            s.withModel(s.withWorktreeInstructionNotice(`✅ ${s.backendLabel()} 已就绪`)),
          )
        }
      }
      await s.showConsole()
      return true
    case 'stop':
      await s.cancelAgentRuns('stop command')
      if (s.proc?.turnRetry?.reason === 'quota') {
        const card = await s.openStatusCard('stop', '🛑 停止额度等待')
        try {
          await s.stop('已取消额度恢复', { announce: !card, onStatus: value => s.setStatusCard(card, value) })
          await s.closeStatusCard(card, '🛑 已取消额度恢复')
        } catch (error) { await s.closeStatusCard(card, `❌ ${messageOf(error)}`); throw error }
        return true
      }
      // Soft barge-out: interrupt the current turn (if any) AND drop
      // the pending-message count so a stack of type-ahead doesn't
      // refire after the interrupt. Subprocess stays alive. Note: the
      // SDK keeps its OWN internal queue of the user-text frames we
      // already sendText'd — interrupt should also flush that side,
      // but the daemon can't reach into it directly; in practice the
      // sendInterrupt() control_request causes the SDK to discard
      // queued input alongside the in-flight call.
      s.clearStaleIdleQueueState('stop')
      s.clearMultiMsgBuffer('stop command')
      if (!s.currentTurn && s.pendingUserMessageCount === 0 && s.pendingMidTurnMsgs.length === 0) {
        const statusCard = await s.openStatusCard('stop', '⚪ 当前没有正在执行的 turn', 'grey')
        if (statusCard) {
          await s.closeStatusCard(statusCard, '⚪ 无正在执行的 turn')
        } else {
          await feishu.sendText(s.chatId, '⚪ 当前没有正在执行的 turn')
        }
        return true
      }
      log(`session "${s.sessionName}": stop command — interrupt + drop count=${s.pendingUserMessageCount} midBuffer=${s.pendingMidTurnMsgs.length}`)
      // Cancelled queued msgs: remove the OneSecond (no longer waiting)
      // and stamp a CrossMark (explicit cancelled state, distinct from
      // a natural release where reactions just disappear). Cancelled
      // mid-batch msgs get the same treatment.
      // 用 `seen` Set 去重 —— mid-turn buffer 跟 pendingReactionIds 的
      // msgId 重叠(onUserMessage 进 buffer 时同时 trackReaction),
      // 两次 addReaction(CrossMark) 会在飞书侧渲染两个 ❌ (P0-1)。
      const seen = new Set<string>()
      for (const [msgId, rid] of [
        ...s.pendingReactionIds.entries(),
        ...s.currentBatchReactionIds.entries(),
      ]) {
        if (rid) void feishu.deleteReaction(msgId, rid)
        void feishu.addReaction(msgId, 'CrossMark')
        seen.add(msgId)
      }
      // Mid-turn buffer never reached SDK — cancel those too.
      for (const msg of s.pendingMidTurnMsgs) {
        if (msg.msgId && !seen.has(msg.msgId)) void feishu.addReaction(msg.msgId, 'CrossMark')
      }
      s.pendingUserMessageCount = 0
      s.pendingMidTurnMsgs = []
      s.pendingTurnInputs = []
      s.lastUserOpenId = ''
      s.pendingReactionIds = new Map()
      s.currentBatchReactionIds = new Map()
      // Tag the imminent SDK `result` so the result handler does not
      // repaint the footer after this stop path already closed the card.
      // Must be set BEFORE sendInterrupt — the result can land next tick.
      s.userInterrupted = true
      s.interrupt()
      // 主动封口,把 footer 改成 🛑 打断、停止 footer 状态计时、把 streaming_mode
      // 翻回 false,否则卡片会僵在运行中状态。SDK 的 post-interrupt
      // result 也会进 closeTurnCard,但 currentTurn 已被这里置空,那条
      // 路径会 early-return,不会重画 footer。
      await s.closeTurnCard('🛑 打断')
      return true
    case 'kill':
      {
        const wasRunning = s.isRunning()
        const backend = s.backendLabel(s.proc?.provider ?? s.currentProvider())
        const initialStatus = wasRunning ? `🛑 停止 ${backend}` : '⚪ session 当前未运行'
        const statusCard = await s.openStatusCard('kill', initialStatus, wasRunning ? 'red' : 'grey')
        let stopError: unknown = null
        let finalStatus = wasRunning ? `✅ ${backend} 已终止` : `⚪ ${backend} 未运行`
        try {
          await s.stop('已终止', {
            announce: !statusCard,
            onStatus: status => {
              s.setStatusCard(statusCard, status)
            },
          })
        } catch (e) {
          stopError = e
          finalStatus = s.isRunning()
            ? `❌ ${backend} 未确认终止: ${messageOf(e)}；会话已阻断，请重试 kill/restart 或等待旧进程退出`
            : `❌ ${backend} 停止收尾失败: ${messageOf(e)}`
        } finally {
          try {
            await s.closeStatusCard(statusCard, finalStatus)
          } catch (e) {
            log(`session "${s.sessionName}": kill status card close failed: ${messageOf(e)}`)
            await feishu.sendTextRaw(s.chatId, `${finalStatus}\n⚠️ kill 状态卡片终态写入失败: ${messageOf(e)}`)
          }
        }
        // openStatusCard already provides the visible failure when present. If
        // card creation failed, stop() had no chance to announce after throwing,
        // so preserve error transparency with a raw text receipt.
        if (stopError && !statusCard) await feishu.sendTextRaw(s.chatId, finalStatus)
      }
      return true
    case 'restart':
      // 进程已停:双后端都列同 cwd 历史并从所选会话创建独立 fork。
      // 进程存活:保持原有 restart(true) 语义，打断并恢复当前绑定。
      if (!s.isRunning()) {
        await s.showResumeList(userOpenId)
        return true
      }
      // 进行中 / codex 空闲:resume the prior conversation — kills the current proc and
      // spawns a new one with `--resume <lastSessionId>`(放弃后台进程)。
      {
        const resumeThreadLabel = s.lastSessionId ? diagnosticIdLabel(s.lastSessionId) : ''
        const backend = s.backendLabel(s.proc?.provider ?? s.currentProvider())
        const initialStatus = s.isRunning()
          ? s.withModel(`🔁 重启 ${backend}`)
          : resumeThreadLabel
            ? s.withModel(`🔁 恢复上一会话 thread=${resumeThreadLabel}`)
            : s.withModel(`🔁 启动 ${backend}`)
        const statusCard = await s.openStatusCard('restart', initialStatus)
        let lastStatus = initialStatus
        const ok = await s.restart(true, {
          announce: !statusCard,
          onStatus: status => {
            lastStatus = status
            s.setStatusCard(statusCard, status)
          },
        })
        const finalStatus = ok
          ? (
              lastStatus.startsWith('✅')
                ? lastStatus
                : s.withWorktreeInstructionNotice(resumeThreadLabel ? '✅ 已恢复上一会话' : `✅ ${s.backendLabel()} 已就绪`)
            )
          : (lastStatus.startsWith('❌') ? lastStatus : '❌ 重启失败')
        await s.closeStatusCard(statusCard, ok ? s.withModel(finalStatus) : finalStatus)
      }
      return true
    case 'clear':
      // "throw away current conversation, start a new one". By design
      // this only makes sense when there IS a current conversation:
      // calling clear from stopped state is a no-op (user-confirmed
      // 2026-05-16) — we don't want a stray `clear` to silently spawn
      // a fresh session the user didn't ask for. To start from cold,
      // use `hi`.
      if (!s.isRunning()) {
        s.status = 'stopped'
        s.opts.onLifecycleChange?.()
        const statusCard = await s.openStatusCard('clear', '⚪ session 当前未运行', 'grey')
        if (statusCard) {
          await s.closeStatusCard(statusCard, `⚪ ${s.backendLabel()} 未运行，clear 无效`)
        } else {
          await feishu.sendText(s.chatId, `⚪ session "${s.sessionName}" 当前未运行,clear 无效;用 \`hi\` 启动或 \`restart\` 恢复上一会话`)
        }
        return true
      }
      {
        const statusCard = await s.openStatusCard('clear', '🧹 清空并启动新会话', 'orange')
        let lastStatus = '🧹 清空并启动新会话'
        const ok = await s.restart(false, {
          announce: !statusCard,
          onStatus: status => {
            lastStatus = status
            s.setStatusCard(statusCard, status)
          },
        })
        await s.closeStatusCard(
          statusCard,
          ok
            ? s.withModel(s.withWorktreeInstructionNotice('✅ 已清空并启动新会话'))
            : (lastStatus.startsWith('❌') ? lastStatus : '❌ 清空失败'),
        )
      }
      return true
  }
}
