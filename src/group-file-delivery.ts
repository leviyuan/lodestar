import type { DeliveryFolder, FileDeliveryContext, GroupDeliveryFolder } from './file-delivery-types'

interface GroupFolderBinding {
  folder: GroupDeliveryFolder
}

export interface FileDeliveryGroupsState {
  version: 3
  groups: Record<string, GroupFolderBinding>
}

export interface GroupFileDeliveryDeps {
  read(): string | undefined
  write(value: FileDeliveryGroupsState): void
  getChatName(chatId: string, signal?: AbortSignal): Promise<string>
  createFolder(name: string, signal?: AbortSignal): Promise<DeliveryFolder>
  getFolder(folder: DeliveryFolder, signal?: AbortSignal): Promise<GroupDeliveryFolder>
  renameFolder(folder: DeliveryFolder, name: string, signal?: AbortSignal): Promise<GroupDeliveryFolder>
  grantFolderAccess(folder: DeliveryFolder, chatId: string, managerOpenId: string, signal?: AbortSignal): Promise<void>
}

/** Persistent remote folders and access remain per chat, independent of file routing. */
export class GroupFileDelivery {
  private state?: FileDeliveryGroupsState
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly deps: GroupFileDeliveryDeps) {}

  get(chatId: string): GroupDeliveryFolder | undefined {
    const folder = this.load().groups[chatId]?.folder
    return folder ? structuredClone(folder) : undefined
  }

  /** The first oversized file creates its chat's folder; later deliveries reuse it. */
  resolveFolder(context: FileDeliveryContext, signal: AbortSignal): Promise<GroupDeliveryFolder> {
    return this.exclusive(`chat:${context.chatId}`, () => this.prepare(context.chatId, context.managerOpenId, true, signal))
  }

  /** Explicit adoption for known existing deliverables; never searches or merges folders by name. */
  bindExisting(chatId: string, managerOpenId: string, existing: DeliveryFolder): Promise<GroupDeliveryFolder> {
    return this.exclusive(`chat:${chatId}`, async () => {
      const current = this.load().groups[chatId]
      if (current?.folder && current.folder.token !== existing.token) throw new Error('本群已经绑定其他文件夹')
      const folder = await this.deps.getFolder(existing)
      this.commitFolder(chatId, folder)
      return this.prepare(chatId, managerOpenId, false)
    })
  }

  private async prepare(chatId: string, managerOpenId: string, create: boolean, signal?: AbortSignal): Promise<GroupDeliveryFolder> {
    signal?.throwIfAborted()
    if (!chatId.trim() || !managerOpenId.trim()) throw new Error('无法确认交付群或管理权限接收人')
    const name = await this.deps.getChatName(chatId, signal)
    if (!name.trim()) throw new Error('群名称 MISS')
    let folder = this.load().groups[chatId]?.folder
    if (!folder) {
      if (!create) throw new Error('本群尚未绑定云空间文件夹')
      folder = { ...await this.deps.createFolder(name, signal), name }
      // Save the remote identity before granting access; a retry must reuse this exact folder.
      this.commitFolder(chatId, folder)
    }
    const remote = await this.deps.getFolder(folder, signal)
    if (remote.token !== folder.token) throw new Error('云空间返回的文件夹与本群绑定不一致')
    folder = remote.name === name ? remote : await this.deps.renameFolder(remote, name, signal)
    if (folder.name !== name) throw new Error('文件夹名称尚未与群名同步')
    this.commitFolder(chatId, folder)
    await this.deps.grantFolderAccess(folder, chatId, managerOpenId, signal)
    return folder
  }

  private exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const result = previous.then(action)
    const settled = result.then(() => {}, () => {})
    this.locks.set(key, settled)
    void settled.then(() => { if (this.locks.get(key) === settled) this.locks.delete(key) })
    return result
  }

  private load(): FileDeliveryGroupsState {
    if (this.state) return this.state
    const raw = this.deps.read()
    if (raw === undefined) return this.state = { version: 3, groups: {} }
    const parsed = JSON.parse(raw)
    if (![1, 2, 3].includes(parsed?.version) || !record(parsed.groups)) throw new Error('文件交付目录记录格式无效')
    const state: FileDeliveryGroupsState = { version: 3, groups: {} }
    for (const [chatId, value] of Object.entries(parsed.groups)) {
      if (!chatId || !record(value)) throw new Error('群文件夹绑定无效')
      // Legacy switches no longer affect delivery. Keep every bound folder, including
      // disabled or unresolvable old chats; entries with only a switch can be dropped.
      if (value.folder === undefined && parsed.version !== 3) continue
      validateFolder(value.folder)
      state.groups[chatId] = { folder: structuredClone(value.folder) }
    }
    const owners = new Map<string, string>()
    for (const [chatId, group] of Object.entries(state.groups)) {
      const owner = owners.get(group.folder.token)
      if (owner !== undefined) throw new Error(`云空间文件夹重复绑定到多个群：${owner} / ${chatId}`)
      owners.set(group.folder.token, chatId)
    }
    if (parsed.version !== 3) this.deps.write(state)
    return this.state = state
  }

  private commitFolder(chatId: string, folder: GroupDeliveryFolder): void {
    for (const [owner, group] of Object.entries(this.load().groups)) {
      if (owner !== chatId && group.folder?.token === folder.token) {
        throw new Error('云空间文件夹已绑定其他群，不能共用交付目录')
      }
    }
    const next = structuredClone(this.load())
    next.groups[chatId] = { folder }
    this.commit(next)
  }

  private commit(next: FileDeliveryGroupsState): void {
    this.deps.write(next)
    this.state = next
  }
}

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validateFolder(folder: unknown): asserts folder is GroupDeliveryFolder {
  if (!record(folder) || typeof folder.token !== 'string' || !folder.token.trim()
    || typeof folder.name !== 'string' || !folder.name.trim() || typeof folder.url !== 'string') throw new Error('群文件夹绑定无效')
  const url = new URL(folder.url)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('群文件夹链接无效')
}
