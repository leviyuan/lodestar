import type { DeliveryFolder, FileDeliveryContext, FileDeliveryMode, GroupDeliveryFolder, GroupFileDeliverySettings } from './file-delivery-types'

export interface GroupFileDeliveryDeps {
  read(): string | undefined
  write(value: { version: 1; groups: Record<string, GroupFileDeliverySettings> }): void
  getChatName(chatId: string, signal?: AbortSignal): Promise<string>
  createFolder(name: string, signal?: AbortSignal): Promise<DeliveryFolder>
  getFolder(folder: DeliveryFolder, signal?: AbortSignal): Promise<GroupDeliveryFolder>
  renameFolder(folder: DeliveryFolder, name: string, signal?: AbortSignal): Promise<GroupDeliveryFolder>
  grantFolderAccess(folder: DeliveryFolder, chatId: string, managerOpenId: string, signal?: AbortSignal): Promise<void>
}

/** Settings and folder identity are keyed by chat_id, independent of Session/thread lifetimes. */
export class GroupFileDelivery {
  private groups?: Map<string, GroupFileDeliverySettings>
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly deps: GroupFileDeliveryDeps) {}

  get(chatId: string): GroupFileDeliverySettings {
    return structuredClone(this.load().get(chatId) ?? { enabled: false })
  }

  mode(chatId: string): FileDeliveryMode { return this.get(chatId).enabled ? 'drive' : 'chat' }

  enable(chatId: string, managerOpenId: string): Promise<GroupFileDeliverySettings> {
    return this.exclusive(chatId, async () => {
      const folder = await this.prepare(chatId, managerOpenId, true)
      this.commit(chatId, { enabled: true, folder })
      return this.get(chatId)
    })
  }

  disable(chatId: string): Promise<GroupFileDeliverySettings> {
    return this.exclusive(chatId, async () => {
      this.commit(chatId, { ...this.get(chatId), enabled: false })
      return this.get(chatId)
    })
  }

  /** An admitted cloud batch retains its transport even if files off is sent while it uploads. */
  resolveFolder(context: FileDeliveryContext, signal: AbortSignal): Promise<GroupDeliveryFolder> {
    return this.exclusive(context.chatId, () => this.prepare(context.chatId, context.managerOpenId, false, signal))
  }

  /** Explicit adoption for known existing deliverables; never searches or merges folders by name. */
  bindExisting(chatId: string, managerOpenId: string, existing: DeliveryFolder): Promise<GroupFileDeliverySettings> {
    return this.exclusive(chatId, async () => {
      const current = this.get(chatId)
      if (current.folder && current.folder.token !== existing.token) throw new Error('本群已经绑定其他文件夹')
      const folder = await this.deps.getFolder(existing)
      this.commit(chatId, { ...current, folder })
      await this.prepare(chatId, managerOpenId, false)
      return this.get(chatId)
    })
  }

  private async prepare(chatId: string, managerOpenId: string, create: boolean, signal?: AbortSignal): Promise<GroupDeliveryFolder> {
    signal?.throwIfAborted()
    if (!chatId.trim() || !managerOpenId.trim()) throw new Error('无法确认交付群或管理权限接收人')
    const name = await this.deps.getChatName(chatId, signal)
    if (!name.trim()) throw new Error('群名称 MISS')
    const settings = this.get(chatId)
    let folder: GroupDeliveryFolder
    if (!settings.folder) {
      if (!create) throw new Error('本群尚未绑定云空间文件夹，请先发送 files on')
      folder = { ...await this.deps.createFolder(name, signal), name }
      // Save the remote identity before granting access; a later retry must reuse this exact folder.
      this.commit(chatId, { ...settings, folder })
    } else {
      folder = settings.folder
    }
    const remote = await this.deps.getFolder(folder, signal)
    if (remote.token !== folder.token) throw new Error('云空间返回的文件夹与本群绑定不一致')
    folder = remote.name === name ? remote : await this.deps.renameFolder(remote, name, signal)
    if (folder.name !== name) throw new Error('文件夹名称尚未与群名同步')
    this.commit(chatId, { ...this.get(chatId), folder })
    await this.deps.grantFolderAccess(folder, chatId, managerOpenId, signal)
    return folder
  }

  private exclusive<T>(chatId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(chatId) ?? Promise.resolve()
    const result = previous.then(action)
    const settled = result.then(() => {}, () => {})
    this.locks.set(chatId, settled)
    void settled.then(() => { if (this.locks.get(chatId) === settled) this.locks.delete(chatId) })
    return result
  }

  private load(): Map<string, GroupFileDeliverySettings> {
    if (this.groups) return this.groups
    const raw = this.deps.read()
    if (raw === undefined) { this.groups = new Map(); return this.groups }
    const parsed = JSON.parse(raw)
    if (parsed?.version !== 1 || !parsed.groups || typeof parsed.groups !== 'object' || Array.isArray(parsed.groups)) {
      throw new Error('群文件交付设置格式无效')
    }
    const groups = new Map<string, GroupFileDeliverySettings>()
    for (const [chatId, value] of Object.entries(parsed.groups)) {
      const item = value as GroupFileDeliverySettings
      if (!chatId || !item || typeof item.enabled !== 'boolean') throw new Error('群文件交付开关无效')
      if (item.enabled && !item.folder) throw new Error('已启用的群缺少文件夹绑定')
      if (item.folder) {
        if (typeof item.folder.token !== 'string' || !item.folder.token.trim() || typeof item.folder.name !== 'string' || !item.folder.name.trim()
          || typeof item.folder.url !== 'string') throw new Error('群文件夹绑定无效')
        const url = new URL(item.folder.url)
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('群文件夹链接无效')
      }
      groups.set(chatId, structuredClone(item))
    }
    this.groups = groups
    return groups
  }

  private commit(chatId: string, value: GroupFileDeliverySettings): void {
    const next = new Map(this.load())
    next.set(chatId, structuredClone(value))
    this.deps.write({ version: 1, groups: Object.fromEntries(next) })
    this.groups = next
  }
}
