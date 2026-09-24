import type { DeliveryFolder, FileDeliveryContext, FileDeliveryMode, GroupDeliveryFolder, GroupFileDeliverySettings } from './file-delivery-types'
import { workspaceKey } from './workspace'

interface GroupFolderBinding {
  folder?: GroupDeliveryFolder
  /** Unmigrated v1 preferences whose chat may no longer have a local name binding. */
  legacyEnabled?: boolean
}

export interface FileDeliverySettingsState {
  version: 2
  workspaces: Record<string, { enabled: boolean }>
  groups: Record<string, GroupFolderBinding>
}

export interface GroupFileDeliveryDeps {
  read(): string | undefined
  write(value: FileDeliverySettingsState): void
  workDirForChat(chatId: string): string | undefined
  getChatName(chatId: string, signal?: AbortSignal): Promise<string>
  createFolder(name: string, signal?: AbortSignal): Promise<DeliveryFolder>
  getFolder(folder: DeliveryFolder, signal?: AbortSignal): Promise<GroupDeliveryFolder>
  renameFolder(folder: DeliveryFolder, name: string, signal?: AbortSignal): Promise<GroupDeliveryFolder>
  grantFolderAccess(folder: DeliveryFolder, chatId: string, managerOpenId: string, signal?: AbortSignal): Promise<void>
}

/** Preferences belong to a working directory. Remote folders and access remain per chat. */
export class GroupFileDelivery {
  private state?: FileDeliverySettingsState
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly deps: GroupFileDeliveryDeps) {}

  get(chatId: string, workDir: string): GroupFileDeliverySettings {
    const key = workspaceKey(workDir)
    const state = this.load()
    let enabled = state.workspaces[key]?.enabled
    if (enabled === undefined) {
      const values = new Set(this.legacyChats(chatId, key).map(id => state.groups[id].legacyEnabled!))
      if (values.size > 1) throw new Error('同一工作目录的旧群文件交付设置冲突，请发送 files on 或 files off 统一设置')
      if (values.size) {
        enabled = values.values().next().value!
        this.commitMode(chatId, key, enabled)
      }
    }
    const folder = this.load().groups[chatId]?.folder
    return { enabled: enabled ?? false, ...(folder ? { folder: structuredClone(folder) } : {}) }
  }

  mode(chatId: string, workDir: string): FileDeliveryMode { return this.get(chatId, workDir).enabled ? 'drive' : 'chat' }

  enable(chatId: string, workDir: string, managerOpenId: string): Promise<GroupFileDeliverySettings> {
    const key = workspaceKey(workDir)
    return this.exclusive(`workspace:${key}`, () => this.exclusive(`chat:${chatId}`, async () => {
      await this.prepare(chatId, managerOpenId, true)
      this.commitMode(chatId, key, true)
      return this.get(chatId, workDir)
    }))
  }

  disable(chatId: string, workDir: string): Promise<GroupFileDeliverySettings> {
    const key = workspaceKey(workDir)
    return this.exclusive(`workspace:${key}`, async () => {
      this.commitMode(chatId, key, false)
      return this.get(chatId, workDir)
    })
  }

  /** An admitted cloud batch can create its chat's first folder even after files off. */
  resolveFolder(context: FileDeliveryContext, signal: AbortSignal): Promise<GroupDeliveryFolder> {
    return this.exclusive(`chat:${context.chatId}`, () => this.prepare(context.chatId, context.managerOpenId, true, signal))
  }

  /** Explicit adoption for known existing deliverables; never searches or merges folders by name. */
  bindExisting(chatId: string, workDir: string, managerOpenId: string, existing: DeliveryFolder): Promise<GroupFileDeliverySettings> {
    return this.exclusive(`chat:${chatId}`, async () => {
      const current = this.load().groups[chatId]
      if (current?.folder && current.folder.token !== existing.token) throw new Error('本群已经绑定其他文件夹')
      const folder = await this.deps.getFolder(existing)
      this.commitFolder(chatId, folder)
      await this.prepare(chatId, managerOpenId, false)
      return this.get(chatId, workDir)
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

  private load(): FileDeliverySettingsState {
    if (this.state) return this.state
    const raw = this.deps.read()
    if (raw === undefined) return this.state = { version: 2, workspaces: {}, groups: {} }
    const parsed = JSON.parse(raw)
    if (![1, 2].includes(parsed?.version) || !record(parsed.groups)
      || (parsed.version === 2 && !record(parsed.workspaces))) throw new Error('文件交付设置格式无效')
    const state: FileDeliverySettingsState = { version: 2, workspaces: {}, groups: {} }
    for (const [key, value] of Object.entries(parsed.workspaces ?? {})) {
      if (!record(value) || typeof value.enabled !== 'boolean' || workspaceKey(key) !== key) throw new Error('工作目录文件交付开关无效')
      state.workspaces[key] = { enabled: value.enabled }
    }
    for (const [chatId, value] of Object.entries(parsed.groups)) {
      if (!chatId || !record(value)) throw new Error('群文件夹绑定无效')
      const legacyEnabled = parsed.version === 1 ? value.enabled : value.legacyEnabled
      if ((parsed.version === 1 || legacyEnabled !== undefined) && typeof legacyEnabled !== 'boolean') throw new Error('群文件交付开关无效')
      if (legacyEnabled && !value.folder) throw new Error('已启用的旧群缺少文件夹绑定')
      if (value.folder !== undefined) validateFolder(value.folder)
      state.groups[chatId] = {
        ...(value.folder ? { folder: structuredClone(value.folder) as GroupDeliveryFolder } : {}),
        ...(legacyEnabled === undefined ? {} : { legacyEnabled }),
      }
    }
    const owners = new Map<string, string>()
    for (const [chatId, group] of Object.entries(state.groups)) {
      if (!group.folder) continue
      const owner = owners.get(group.folder.token)
      if (owner !== undefined) throw new Error(`云空间文件夹重复绑定到多个群：${owner} / ${chatId}`)
      owners.set(group.folder.token, chatId)
    }
    return this.state = state
  }

  private legacyChats(chatId: string, key: string): string[] {
    return Object.entries(this.load().groups).filter(([id, group]) => {
      if (group.legacyEnabled === undefined) return false
      if (id === chatId) return true
      const dir = this.deps.workDirForChat(id)
      return dir !== undefined && workspaceKey(dir) === key
    }).map(([id]) => id)
  }

  private commitMode(chatId: string, key: string, enabled: boolean): void {
    const next = structuredClone(this.load())
    next.workspaces[key] = { enabled }
    for (const id of this.legacyChats(chatId, key)) delete next.groups[id].legacyEnabled
    this.commit(next)
  }

  private commitFolder(chatId: string, folder: GroupDeliveryFolder): void {
    for (const [owner, group] of Object.entries(this.load().groups)) {
      if (owner !== chatId && group.folder?.token === folder.token) {
        throw new Error('云空间文件夹已绑定其他群，不能共用交付目录')
      }
    }
    const next = structuredClone(this.load())
    next.groups[chatId] = { ...next.groups[chatId], folder }
    this.commit(next)
  }

  private commit(next: FileDeliverySettingsState): void {
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
