import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import * as feishu from './feishu'
import { feishuDrive } from './feishu-drive'
import { FileDeliveryBatch } from './file-delivery'
import { fileDeliveryCard } from './cards/files'
import { FILE_DELIVERIES_DIR, FILE_DELIVERY_GROUPS_FILE } from './paths'
import { writeJsonStateAtomic } from './state-store'
import { log } from './log'
import type { FileDeliveryContext, FileDeliveryHandle } from './file-delivery-types'
import { GroupFileDelivery } from './group-file-delivery'
import { workspaceKey } from './workspace'

export const groupFileDelivery = new GroupFileDelivery({
  read: () => {
    try { return readFileSync(FILE_DELIVERY_GROUPS_FILE, 'utf8') }
    catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error }
  },
  write: value => writeJsonStateAtomic(FILE_DELIVERY_GROUPS_FILE, value),
  workDirForChat: chatId => {
    const names = [...feishu.preferredChatForSession].filter(([, id]) => id === chatId).map(([name]) => name)
    const cachedName = feishu.chatNameCache.get(chatId)
    if (!names.length && cachedName) names.push(cachedName)
    const dirs = new Set(names.map(name => workspaceKey(feishu.resolveProjectDir(name))))
    if (dirs.size > 1) throw new Error(`旧文件交付群绑定了多个工作目录: ${chatId}`)
    return dirs.values().next().value
  },
  getChatName: (chatId, signal) => feishuDrive.getChatName(chatId, signal),
  createFolder: (name, signal) => feishuDrive.createFolder(name, signal),
  getFolder: (folder, signal) => feishuDrive.getFolder(folder, signal),
  renameFolder: (folder, name, signal) => feishuDrive.renameFolder(folder, name, signal),
  grantFolderAccess: (folder, chatId, managerOpenId, signal) => feishuDrive.grantFolderAccess(folder, chatId, managerOpenId, signal),
})

export function createFileDelivery(context: FileDeliveryContext): FileDeliveryHandle {
  return new FileDeliveryBatch(context, {
    resolveFolder: (context, signal) => groupFileDelivery.resolveFolder(context, signal),
    uploadFile: (path, folder, onUploaded, signal) => feishuDrive.uploadFile(path, folder, onUploaded, signal),
    sendCard: (snapshot, onFailure) => feishu.sendCard(context.chatId, fileDeliveryCard(snapshot), onFailure),
    persist: snapshot => writeJsonStateAtomic(join(FILE_DELIVERIES_DIR, `${snapshot.id}.json`), snapshot),
    reportError: async message => {
      log(`file delivery ${context.projectName}: ${message}`)
      if (!await feishu.sendText(context.chatId, message)) throw new Error(message)
    },
  })
}
