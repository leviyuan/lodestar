/** A delivery is scoped to one chat and one turn; URLs refer to persistent Drive files. */
export interface DeliveryFolder {
  token: string
  url: string
}

export type FileDeliveryMode = 'chat' | 'drive'

export interface GroupDeliveryFolder extends DeliveryFolder {
  name: string
}

export interface GroupFileDeliverySettings {
  enabled: boolean
  folder?: GroupDeliveryFolder
}

export interface DeliveredFile {
  token: string
  url: string
  name: string
  bytes: number
}

export interface FileDeliveryEntry {
  id: string
  path: string
  name: string
  bytes?: number
  status: 'pending' | 'ready' | 'failed'
  file?: DeliveredFile
  error?: string
}

export interface FileDeliverySnapshot {
  version: 1
  id: string
  chatId: string
  managerOpenId: string
  projectName: string
  createdAt: number
  folder?: DeliveryFolder
  folderAccessReady: boolean
  files: FileDeliveryEntry[]
  messageId?: string
  completedAt?: number
  error?: string
}

export interface FileDeliveryContext {
  chatId: string
  managerOpenId: string
  projectName: string
  createdAt: number
}

export interface FileDeliveryHandle {
  add(path: string): void
  cancel(reason: string): boolean
  /** Drain uploads and publish exactly one independent card. Returns delivered local paths. */
  finish(): Promise<string[]>
}
