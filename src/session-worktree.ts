import type { Session } from './session'
import type { AgentProvider } from './agent-process'
import { channelInstructions } from './instructions'
import type { FileDeliveryMode } from './file-delivery-types'
import * as cards from './cards'
import * as feishu from './feishu'
import { formatFeishuError } from './feishu-errors'
import { log } from './log'
import * as worktree from './worktree'
import { messageOf, type WorktreeActionResult } from './session-util'

export function worktreeProjectName(s: Session): string {
  return worktree.projectNameFromSessionName(feishu.tempProjectName(s.sessionName) ?? s.sessionName)
}

export function worktreeProjectDir(s: Session): string {
  return feishu.resolveProjectDir(worktreeProjectName(s))
}

export function worktreeSessionDir(s: Session): string {
  return feishu.resolveProjectDir(s.sessionName)
}

export function spawnDeveloperInstructions(s: Session, mode: FileDeliveryMode, provider: AgentProvider = s.currentProvider()): string {
  const base = channelInstructions(provider, mode)
  const extra = worktreeExtraInstruction(s)
  return extra ? `${base}\n${extra}` : base
}

/** Delegated agents do not write directly to the Feishu channel, so they must
 * not inherit channel marker protocols. Worktree-specific project policy still
 * applies and is the only host-appended instruction. */
export function delegatedAgentDeveloperInstructions(s: Session, _provider: AgentProvider): string {
  return worktreeExtraInstruction(s) ?? ''
}

export function worktreeInstructionLoadedNotice(s: Session): string | null {
  return worktreeExtraInstruction(s) ? '已载入wt特殊约定' : null
}

export function withWorktreeInstructionNotice(s: Session, text: string): string {
  const notice = worktreeInstructionLoadedNotice(s)
  return notice ? `${text}\n${notice}` : text
}

export function worktreeExtraInstruction(s: Session): string | null {
  const projectName = worktreeProjectName(s)
  const instructions = worktree.readWorktreeInstructionsForManagedBranch(
    s.workDir,
    worktreeProjectDir(s),
    projectName,
  )
  if (!instructions) return null
  return [
    `你要把下面这份额外的工作树约定视为和AGENTS.md一样重要。来源文件：${instructions.path}`,
    '',
    `# Additional AGENTS.md instructions for ${s.workDir}`,
    '',
    '<INSTRUCTIONS>',
    instructions.content,
    '</INSTRUCTIONS>',
  ].join('\n')
}

export async function runWorktreeCommand(s: Session, arg: string, userOpenId: string): Promise<void> {
  if (!arg) {
    await showWorktrees(s)
    return
  }
  const slug = worktree.normalizeWorktreeSlug(arg)
  if (!slug) {
    await feishu.sendText(s.chatId, '❌ 名称无效。用英文/数字/._-，最长 63。')
    return
  }
  if (!userOpenId) {
    await feishu.sendText(s.chatId, '❌ 找不到发起人，不能拉群。')
    return
  }

  const projectName = worktreeProjectName(s)
  const projectDir = worktreeProjectDir(s)
  try {
    await worktree.withProjectWorktreeLock(projectDir, async () => {
      let ensured: worktree.EnsureWorktreeResult
      try {
        ensured = worktree.ensureProjectWorktree(projectDir, projectName, slug)
      } catch (e) {
        await feishu.sendText(s.chatId, `❌ wt 失败: ${messageOf(e)}`)
        return
      }

      try {
        const chat = await feishu.ensureChatForSession(ensured.chatName, userOpenId)
        const action = chat.created ? '已创建' : (chat.joined ? '已加入' : '已在群内')
        let parentFailure: unknown
        const parentMsg = await feishu.sendCard(s.chatId, cards.worktreeNoticeCard({
          slug,
          branch: ensured.branch,
          status: action,
        }), error => { parentFailure = error })
        if (!parentMsg) await feishu.sendTextRaw(s.chatId, `❌ wt 卡片失败: ${slug}\n${formatFeishuError(parentFailure)}`)
        let childFailure: unknown
        const childMsg = await feishu.sendCard(chat.chatId, cards.worktreeNoticeCard({
          slug,
          branch: ensured.branch,
          status: '就绪',
          body: '开始吧。',
        }), error => { childFailure = error })
        if (!childMsg) await feishu.sendTextRaw(chat.chatId, `❌ wt 卡片失败: ${slug}\n${formatFeishuError(childFailure)}`)
      } catch (e) {
        await feishu.sendText(s.chatId, `❌ wt 已建，拉群失败: ${messageOf(e)}`)
      }
    })
  } catch (e) {
    await feishu.sendText(s.chatId, `❌ wt 失败: ${messageOf(e)}`)
  }
}

async function buildWorktreeListCard(s: Session, notice?: { type: 'success' | 'error' | 'info'; content: string }): Promise<object> {
  const projectName = worktreeProjectName(s)
  const projectDir = worktreeProjectDir(s)
  return await worktree.withProjectWorktreeLock(projectDir, async () => {
    return await buildWorktreeListCardUnlocked(projectName, projectDir, notice)
  })
}

async function buildWorktreeListCardUnlocked(
  projectName: string,
  projectDir: string,
  notice?: { type: 'success' | 'error' | 'info'; content: string },
): Promise<object> {
  const entries = worktree.listProjectWorktrees(projectDir, projectName)
  const hiddenMergedUnmountedCount = entries.filter(
    entry => entry.state === 'merged' && !entry.mounted,
  ).length
  const visibleEntries = entries.filter(entry => entry.state !== 'merged' || entry.mounted)
  const chatIndex = await feishu.listNormalChatIdsByName()
  return cards.worktreeListCard({
    projectName,
    projectDir,
    hiddenMergedUnmountedCount,
    notice,
    entries: visibleEntries.map(entry => {
      const ids = chatIndex.get(entry.chatName) ?? []
      const preferred = feishu.preferredChatForSession.get(entry.chatName)
      const chatId = preferred && ids.includes(preferred)
        ? preferred
        : ids.length === 1
          ? ids[0]
          : null
      return {
        slug: entry.slug,
        chatName: entry.chatName,
        branch: entry.branch,
        state: entry.state,
        path: entry.worktreePath ?? entry.expectedPath,
        mounted: entry.mounted,
        dirtyCount: entry.dirtyCount,
        statusLine: entry.statusLine,
        error: entry.error,
        chatId,
        duplicateChatCount: ids.length,
      }
    }),
  })
}

export async function showWorktrees(s: Session): Promise<void> {
  try {
    const card = await buildWorktreeListCard(s)
    let failure: unknown
    const messageId = await feishu.sendCard(s.chatId, card, error => { failure = error })
    if (!messageId) await feishu.sendTextRaw(s.chatId, `❌ wt 列表失败\n${formatFeishuError(failure)}`)
  } catch (e) {
    await feishu.sendText(s.chatId, `❌ wt 列表失败: ${messageOf(e)}`)
  }
}

async function worktreeActionResult(
  s: Session,
  ok: boolean,
  message: string,
  type: 'success' | 'error' | 'info',
): Promise<WorktreeActionResult> {
  try {
    return { ok, message, card: await buildWorktreeListCard(s, { type, content: message }) }
  } catch (e) {
    const listError = `列表刷新失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": wt action panel refresh failed: ${messageOf(e)}`)
    return {
      ok: false,
      message: `${message}\n${listError}`,
      card: cards.worktreeNoticeCard({
        slug: 'wt',
        branch: 'work/*',
        status: message,
        body: listError,
        template: 'red',
      }),
    }
  }
}

export async function onWorktreeDisband(s: Session, slugRaw: string): Promise<WorktreeActionResult> {
  const slug = worktree.normalizeWorktreeSlug(slugRaw)
  if (!slug) return worktreeActionResult(s, false, '❌ 名称无效', 'error')
  const projectName = worktreeProjectName(s)
  const projectDir = worktreeProjectDir(s)
  let outcome: { ok: boolean; message: string; type: 'success' | 'error' | 'info' }
  try {
    outcome = await worktree.withProjectWorktreeLock(projectDir, async () => {
      const chatName = worktree.worktreeChatName(projectName, slug)
      if (s.hasRunningPeerSession(chatName)) {
        const message = `❌ 解散 ${slug} 失败: Codex 正在运行，请先在 ${chatName} 群里 stop 或 kill。`
        return { ok: false, message, type: 'error' as const }
      }
      worktree.assertProjectWorktreeClean(projectDir, projectName, slug)
      const disbanded = await feishu.disbandChatForSession(chatName)
      const removed = worktree.removeProjectWorktreeIfClean(projectDir, projectName, slug)
      const message = [
        `✅ ${slug} 已解散`,
        removed.removedWorktree ? 'dir removed' : 'dir missing',
        disbanded.disbanded ? 'group removed' : 'group missing',
        removed.branch,
      ].join('\n')
      return { ok: true, message, type: 'success' as const }
    })
  } catch (e) {
    const message = `❌ 解散 ${slug} 失败: ${messageOf(e)}`
    outcome = { ok: false, message, type: 'error' }
  }
  return worktreeActionResult(s, outcome.ok, outcome.message, outcome.type)
}
