import type { Session } from './session'
import * as cards from './cards'
import * as feishu from './feishu'
import { formatFeishuError } from './feishu-errors'
import { log } from './log'
import * as tasklist from './tasklist'
import { messageOf, type TasklistActionResult } from './session-util'

function tasklistPanel(
  s: Session,
  notice?: cards.TasklistPanelNotice,
  confirmDelete = false,
): object {
  const projectName = s.worktreeProjectName()
  return cards.tasklistPanelCard({
    projectName,
    tasklistName: tasklist.tasklistNameForProject(projectName),
    binding: tasklist.getTasklistBinding(projectName),
    notice,
    confirmDelete,
  })
}

export async function showTasklistPanel(s: Session): Promise<void> {
  let failure: unknown
  const messageId = await feishu.sendCard(s.chatId, tasklistPanel(s), error => { failure = error })
  if (!messageId) await feishu.sendTextRaw(s.chatId, `❌ task 面板发送失败\n${formatFeishuError(failure)}`)
}

export async function onTasklistEnable(s: Session): Promise<TasklistActionResult> {
  const projectName = s.worktreeProjectName()
  try {
    const existing = tasklist.getTasklistBinding(projectName)
    const binding = await tasklist.enableTasklist(projectName, s.chatId)
    const message = existing ? '已启用' : `已启用 ${binding.name}`
    return {
      ok: true,
      message,
      card: tasklistPanel(s, { type: 'success', content: `✅ ${message}` }),
    }
  } catch (e) {
    const message = `启用失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": tasklist enable failed: ${messageOf(e)}`)
    return {
      ok: false,
      message,
      card: tasklistPanel(s, { type: 'error', content: `❌ ${message}` }),
    }
  }
}

export function onTasklistDeletePrompt(s: Session, guidRaw: string): TasklistActionResult {
  const projectName = s.worktreeProjectName()
  const binding = tasklist.getTasklistBinding(projectName)
  const guid = guidRaw.trim()
  if (!binding) {
    return {
      ok: false,
      message: '未启用',
      card: tasklistPanel(s, { type: 'error', content: '❌ 未启用' }),
    }
  }
  if (binding.guid !== guid) {
    return {
      ok: false,
      message: '清单绑定已变化',
      card: tasklistPanel(s, { type: 'error', content: '❌ 清单绑定已变化，请重新打开 task 面板' }),
    }
  }
  return {
    ok: true,
    message: '请再次确认删除',
    card: tasklistPanel(s, { type: 'error', content: '⚠️ 删除会删除所有清单内任务' }, true),
  }
}

export async function onTasklistDeleteConfirm(s: Session, guidRaw: string): Promise<TasklistActionResult> {
  const projectName = s.worktreeProjectName()
  const guid = guidRaw.trim()
  try {
    const deleted = await tasklist.deleteTasklist(projectName, guid)
    const message = `已删除 ${deleted.name}`
    return {
      ok: true,
      message,
      card: tasklistPanel(s, { type: 'success', content: `✅ ${message}` }),
    }
  } catch (e) {
    const message = `删除失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": tasklist delete failed: ${messageOf(e)}`)
    return {
      ok: false,
      message,
      card: tasklistPanel(s, { type: 'error', content: `❌ ${message}` }),
    }
  }
}
