import type { GroupFileDeliverySettings } from './file-delivery-types'
import { fileDeliverySettingsCard } from './cards/files'

export interface FileDeliveryCommandDeps {
  get(chatId: string): GroupFileDeliverySettings
  enable(chatId: string, managerOpenId: string): Promise<GroupFileDeliverySettings>
  disable(chatId: string): Promise<GroupFileDeliverySettings>
  sendCard(card: object): Promise<string | null>
  reportError(message: string): Promise<void>
}

export async function runFileDeliveryCommand(
  chatId: string, groupName: string, managerOpenId: string, argument: string, deps: FileDeliveryCommandDeps,
): Promise<void> {
  let settings: GroupFileDeliverySettings | undefined
  let notice = ''
  let error = ''
  try {
    settings = deps.get(chatId)
    switch (argument.trim().toLowerCase()) {
      case '': case 'status': break
      case 'on':
        settings = await deps.enable(chatId, managerOpenId)
        notice = '已开启本群云空间交付；之后新开始的交付使用此模式。'
        break
      case 'off':
        settings = await deps.disable(chatId)
        notice = '已恢复直接发送聊天附件；云空间中的历史文件保留。'
        break
      default: throw new Error('用法：files、files on、files off')
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
    try { settings = deps.get(chatId) } catch { settings = undefined }
  }
  const card = fileDeliverySettingsCard({ groupName, settings, notice, error })
  if (!await deps.sendCard(card)) await deps.reportError(`❌ 文件交付设置卡发送失败${error ? `：${error}` : ''}`)
}
