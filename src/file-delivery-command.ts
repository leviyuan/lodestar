import type { GroupFileDeliverySettings } from './file-delivery-types'
import { fileDeliverySettingsCard } from './cards/files'
import { formatFeishuError } from './feishu-errors'

export interface FileDeliveryCommandDeps {
  get(chatId: string): GroupFileDeliverySettings
  enable(chatId: string, managerOpenId: string): Promise<GroupFileDeliverySettings>
  disable(chatId: string): Promise<GroupFileDeliverySettings>
  sendCard(card: object, onFailure?: (error: unknown) => void): Promise<string | null>
  reportError(message: string): Promise<void>
}

export async function runFileDeliveryCommand(
  chatId: string, groupName: string, managerOpenId: string, argument: string, deps: FileDeliveryCommandDeps,
  workDir: string,
): Promise<void> {
  let settings: GroupFileDeliverySettings | undefined
  let notice = ''
  let error = ''
  try {
    switch (argument.trim().toLowerCase()) {
      case '': case 'status': settings = deps.get(chatId); break
      case 'on':
        settings = await deps.enable(chatId, managerOpenId)
        notice = '已开启此工作目录的云空间交付；同目录各群从下一轮任务生效。'
        break
      case 'off':
        settings = await deps.disable(chatId)
        notice = '此工作目录已恢复直接发送聊天附件；同目录各群从下一轮任务生效，云空间中的历史文件保留。'
        break
      default: throw new Error('用法：files、files on、files off')
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
    try { settings = deps.get(chatId) } catch { settings = undefined }
  }
  const card = fileDeliverySettingsCard({ groupName, workDir, settings, notice, error })
  let sendFailure: unknown
  if (!await deps.sendCard(card, failure => { sendFailure = failure })) {
    await deps.reportError(`❌ 文件交付设置卡发送失败：${formatFeishuError(sendFailure)}${error ? `\n设置失败：${error}` : ''}`)
  }
}
