import { describe, expect, test } from 'bun:test'
import { GroupFileDelivery, type GroupFileDeliveryDeps } from './group-file-delivery'
import { FileDeliveryBatch } from './file-delivery'
import type { FileDeliverySnapshot, GroupDeliveryFolder } from './file-delivery-types'

function fixture() {
  let stored: string | undefined
  const names = new Map([['chat-a', '项目群'], ['chat-b', '项目群']])
  const remote = new Map<string, GroupDeliveryFolder>()
  const created: string[] = []
  const renamed: string[] = []
  let denyPermission = false
  const deps: GroupFileDeliveryDeps = {
    read: () => stored,
    write: value => { stored = JSON.stringify(value) },
    getChatName: async chatId => {
      const name = names.get(chatId)
      if (!name) throw new Error('群不存在')
      return name
    },
    createFolder: async name => {
      created.push(name)
      const folder = { token: `folder-${created.length}`, url: `https://example.feishu.cn/drive/folder/folder-${created.length}`, name }
      remote.set(folder.token, folder)
      return folder
    },
    getFolder: async folder => {
      const item = remote.get(folder.token)
      if (!item) throw new Error('folder not found')
      return { ...item }
    },
    renameFolder: async (folder, name) => {
      renamed.push(name)
      const next = { ...folder, name }; remote.set(folder.token, next); return next
    },
    grantFolderAccess: async () => { if (denyPermission) throw new Error('permission denied') },
  }
  return {
    registry: new GroupFileDelivery(deps), deps, names, remote, created, renamed,
    restart: () => new GroupFileDelivery(deps),
    deny: (value: boolean) => { denyPermission = value },
    setStored: (value: string) => { stored = value },
  }
}
const signal = () => new AbortController().signal
const context = { chatId: 'chat-a', managerOpenId: 'user', projectName: 'session-alias', createdAt: 123 }

describe('per-group file delivery preferences', () => {
  test('defaults to chat attachments, persists a group-only switch, and reuses its folder after off and restart', async () => {
    const f = fixture()
    expect(f.registry.mode('chat-a')).toBe('chat')
    expect(f.created).toEqual([])
    const enabled = await f.registry.enable('chat-a', 'user')
    expect(f.created).toEqual(['项目群'])
    expect(f.registry.mode('chat-a')).toBe('drive')
    expect(f.registry.mode('chat-b')).toBe('chat')
    await f.registry.disable('chat-a')
    expect(f.registry.get('chat-a').folder).toEqual(enabled.folder)
    const restarted = f.restart()
    expect(restarted.mode('chat-a')).toBe('chat')
    expect((await restarted.enable('chat-a', 'user')).folder).toEqual(enabled.folder)
    expect(f.created).toHaveLength(1)
  })

  test('concurrent enabling creates one folder per chat, even when different chats have identical names', async () => {
    const f = fixture()
    const [a, again, b] = await Promise.all([
      f.registry.enable('chat-a', 'user'), f.registry.enable('chat-a', 'user'), f.registry.enable('chat-b', 'user'),
    ])
    expect(a.folder?.token).toBe(again.folder?.token)
    expect(a.folder?.token).not.toBe(b.folder?.token)
    expect(a.folder?.name).toBe('项目群')
    expect(b.folder?.name).toBe('项目群')
    expect(f.created).toHaveLength(2)
  })

  test('all turns share the group directory while each receipt lists only that turn’s files', async () => {
    const f = fixture()
    await f.registry.enable('chat-a', 'user')
    const cards: FileDeliverySnapshot[] = []
    const destinations: string[] = []
    for (const name of ['first.pdf', 'second.mp4']) {
      const batch = new FileDeliveryBatch(context, {
        resolveFolder: (ctx, signal) => f.registry.resolveFolder(ctx, signal),
        uploadFile: async (_path, folder, save) => {
          destinations.push(folder.token)
          const file = { token: name, name, bytes: 99, url: `https://example.feishu.cn/file/${name}` }
          save(file); return file
        },
        sendCard: async snapshot => { cards.push(structuredClone(snapshot)); return `message-${name}` },
        persist: () => {}, reportError: async error => { throw new Error(error) },
      })
      batch.add(`/tmp/${name}`)
      expect(await batch.finish()).toEqual([`/tmp/${name}`])
    }
    expect(new Set(destinations).size).toBe(1)
    expect(f.created).toHaveLength(1)
    expect(cards.map(card => card.files.map(file => file.name))).toEqual([['first.pdf'], ['second.mp4']])
    expect(cards[0].folder?.url).toBe(cards[1].folder?.url)
  })

  test('keeps the folder identity when the group is renamed and does not mix up session aliases', async () => {
    const f = fixture()
    const original = await f.registry.enable('chat-a', 'user')
    f.names.set('chat-a', '新的群名称')
    const updated = await f.registry.resolveFolder({ ...context, projectName: 'old-session' }, signal())
    expect(updated.token).toBe(original.folder!.token)
    expect(updated.name).toBe('新的群名称')
    expect(f.renamed).toEqual(['新的群名称'])
    expect(f.registry.get('chat-a').folder?.name).toBe('新的群名称')
  })

  test('does not replace a missing bound folder with an empty directory', async () => {
    const f = fixture()
    const setting = await f.registry.enable('chat-a', 'user')
    f.remote.delete(setting.folder!.token)
    await expect(f.registry.resolveFolder(context, signal())).rejects.toThrow('folder not found')
    expect(f.created).toHaveLength(1)
    expect(f.registry.mode('chat-a')).toBe('drive')
  })

  test('retains a failed setup’s folder binding but does not enable cloud mode until permissions succeed', async () => {
    const f = fixture()
    f.deny(true)
    await expect(f.registry.enable('chat-a', 'user')).rejects.toThrow('permission denied')
    expect(f.registry.mode('chat-a')).toBe('chat')
    expect(f.registry.get('chat-a').folder?.name).toBe('项目群')
    f.deny(false)
    await f.registry.enable('chat-a', 'user')
    expect(f.created).toHaveLength(1)
    expect(f.registry.mode('chat-a')).toBe('drive')
  })

  test('an already admitted cloud batch can finish after off without re-enabling the group', async () => {
    const f = fixture()
    await f.registry.enable('chat-a', 'user')
    await f.registry.disable('chat-a')
    expect((await f.registry.resolveFolder(context, signal())).name).toBe('项目群')
    expect(f.registry.mode('chat-a')).toBe('chat')
  })

  test('can explicitly bind existing deliverables without enabling cloud mode or creating duplicates', async () => {
    const f = fixture()
    const existing = { token: 'demo', url: 'https://example.feishu.cn/drive/folder/demo', name: '旧演示目录' }
    f.remote.set(existing.token, existing)
    const result = await f.registry.bindExisting('chat-a', 'user', existing)
    expect(result.enabled).toBe(false)
    expect(result.folder?.token).toBe('demo')
    expect(result.folder?.name).toBe('项目群')
    expect(f.created).toEqual([])
  })

  test('corrupt persisted settings fail visibly instead of silently reverting the group to chat mode', () => {
    const f = fixture()
    f.setStored('{broken')
    expect(() => f.registry.mode('chat-a')).toThrow()
    f.setStored(JSON.stringify({ version: 1, groups: { 'chat-a': { enabled: true } } }))
    expect(() => f.restart().mode('chat-a')).toThrow('缺少文件夹绑定')
  })
})
