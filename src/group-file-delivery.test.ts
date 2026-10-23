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
  const grants: Array<{ token: string; chatId: string; managerOpenId: string }> = []
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
    grantFolderAccess: async (folder, chatId, managerOpenId) => {
      if (denyPermission) throw new Error('permission denied')
      grants.push({ token: folder.token, chatId, managerOpenId })
    },
  }
  return {
    registry: new GroupFileDelivery(deps), deps, names, remote, created, renamed, grants,
    restart: () => new GroupFileDelivery(deps),
    deny: (value: boolean) => { denyPermission = value },
    setStored: (value: string) => { stored = value },
    stored: () => JSON.parse(stored!),
  }
}
const signal = () => new AbortController().signal
const context = { chatId: 'chat-a', managerOpenId: 'user', projectName: 'session-alias', createdAt: 123 }
const oldFolder = { token: 'old', name: '项目群', url: 'https://example.feishu.cn/drive/folder/old' }

describe('automatic file delivery per-group folders', () => {
  test('creates lazily and reuses the folder across turns and restart', async () => {
    const f = fixture()
    expect(f.registry.get('chat-a')).toBeUndefined()
    expect(f.created).toEqual([])
    const first = await f.registry.resolveFolder(context, signal())
    expect(f.created).toEqual(['项目群'])
    expect(f.registry.get('chat-a')).toEqual(first)
    expect(f.registry.get('chat-b')).toBeUndefined()
    const restarted = f.restart()
    expect(await restarted.resolveFolder(context, signal())).toEqual(first)
    expect(f.created).toHaveLength(1)
    expect(f.stored()).toEqual({ version: 3, groups: { 'chat-a': { folder: first } } })
  })

  test('temporary groups get separate folders and grant each delivery initiator access', async () => {
    const f = fixture()
    f.names.set('chat-temp', '项目*0917-1234')
    const main = await f.registry.resolveFolder(context, signal())
    const first = await f.registry.resolveFolder({ ...context, chatId: 'chat-temp', managerOpenId: 'second-user' }, signal())
    expect(first.token).not.toBe(main.token)
    expect(first.name).toBe('项目*0917-1234')
    const second = await f.registry.resolveFolder({ ...context, chatId: 'chat-temp', managerOpenId: 'third-user' }, signal())
    expect(second.token).toBe(first.token)
    expect(f.grants.map(grant => [grant.chatId, grant.managerOpenId])).toEqual([
      ['chat-a', 'user'], ['chat-temp', 'second-user'], ['chat-temp', 'third-user'],
    ])
    expect(f.created).toHaveLength(2)
  })

  for (const version of [1, 2]) {
    test(`migrates v${version} folders and ignores all legacy switches`, async () => {
      const f = fixture()
      f.remote.set(oldFolder.token, oldFolder)
      f.setStored(JSON.stringify({ version, workspaces: { '/workspace/a': { enabled: false } }, groups: {
        'chat-a': { folder: oldFolder, enabled: false, legacyEnabled: true },
        'chat-temp': { enabled: true, legacyEnabled: false },
        orphan: { folder: { ...oldFolder, token: 'orphan', url: 'https://example.feishu.cn/drive/folder/orphan' }, enabled: false },
      } }))
      expect(f.registry.get('chat-a')).toEqual(oldFolder)
      expect(f.stored().version).toBe(3)
      expect(f.stored().workspaces).toBeUndefined()
      expect(f.stored().groups['chat-a']).toEqual({ folder: oldFolder })
      expect(f.stored().groups['chat-temp']).toBeUndefined()
      expect(f.stored().groups.orphan.folder.token).toBe('orphan')
      expect(await f.restart().resolveFolder(context, signal())).toEqual(oldFolder)
      expect(f.created).toEqual([])
      expect(f.grants).toEqual([{ token: 'old', chatId: 'chat-a', managerOpenId: 'user' }])
    })
  }

  test('migration write failures leave the old state intact and can be retried', () => {
    const f = fixture()
    const previous = { version: 1, groups: { 'chat-a': { enabled: false, folder: oldFolder } } }
    f.setStored(JSON.stringify(previous))
    const write = f.deps.write
    f.deps.write = () => { throw new Error('disk full') }
    expect(() => f.registry.get('chat-a')).toThrow('disk full')
    expect(f.stored()).toEqual(previous)
    f.deps.write = write
    expect(f.registry.get('chat-a')).toEqual(oldFolder)
    expect(f.stored().version).toBe(3)
  })

  test('reading current bindings does not write state or create remote resources', () => {
    const f = fixture()
    f.setStored(JSON.stringify({ version: 3, groups: { 'chat-a': { folder: oldFolder } } }))
    f.deps.write = () => { throw new Error('unexpected write') }
    const returned = f.registry.get('chat-a')!
    returned.name = 'mutated'
    expect(f.registry.get('chat-a')).toEqual(oldFolder)
    expect(f.created).toEqual([])
    expect(f.grants).toEqual([])
  })

  test('concurrent deliveries create one folder per chat even when different chats have identical names', async () => {
    const f = fixture()
    const [a, again, b] = await Promise.all([
      f.registry.resolveFolder(context, signal()), f.registry.resolveFolder(context, signal()),
      f.registry.resolveFolder({ ...context, chatId: 'chat-b' }, signal()),
    ])
    expect(a.token).toBe(again.token)
    expect(a.token).not.toBe(b.token)
    expect(a.name).toBe('项目群')
    expect(b.name).toBe('项目群')
    expect(f.created).toHaveLength(2)
  })

  test('all turns share the group directory while each receipt lists only that turn’s files', async () => {
    const f = fixture()
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
    const original = await f.registry.resolveFolder(context, signal())
    f.names.set('chat-a', '新的群名称')
    const updated = await f.registry.resolveFolder({ ...context, projectName: 'old-session' }, signal())
    expect(updated.token).toBe(original.token)
    expect(updated.name).toBe('新的群名称')
    expect(f.renamed).toEqual(['新的群名称'])
    expect(f.registry.get('chat-a')?.name).toBe('新的群名称')
  })

  test('does not replace a missing bound folder with an empty directory', async () => {
    const f = fixture()
    const folder = await f.registry.resolveFolder(context, signal())
    f.remote.delete(folder.token)
    await expect(f.registry.resolveFolder(context, signal())).rejects.toThrow('folder not found')
    expect(f.created).toHaveLength(1)
    expect(f.registry.get('chat-a')).toEqual(folder)
  })

  test('retains a failed setup’s folder binding and retries access without creating duplicates', async () => {
    const f = fixture()
    f.deny(true)
    await expect(f.registry.resolveFolder(context, signal())).rejects.toThrow('permission denied')
    expect(f.registry.get('chat-a')?.name).toBe('项目群')
    f.deny(false)
    await f.restart().resolveFolder(context, signal())
    expect(f.created).toHaveLength(1)
    expect(f.grants).toHaveLength(1)
  })

  test('does not grant access after failing to persist a new folder binding', async () => {
    const f = fixture()
    f.deps.write = () => { throw new Error('disk full') }
    await expect(f.registry.resolveFolder(context, signal())).rejects.toThrow('disk full')
    expect(f.registry.get('chat-a')).toBeUndefined()
    expect(f.grants).toEqual([])
  })

  test('can explicitly bind existing deliverables without creating duplicates', async () => {
    const f = fixture()
    const existing = { token: 'demo', url: 'https://example.feishu.cn/drive/folder/demo', name: '旧演示目录' }
    f.remote.set(existing.token, existing)
    const result = await f.registry.bindExisting('chat-a', 'user', existing)
    expect(result.token).toBe('demo')
    expect(result.name).toBe('项目群')
    expect(f.created).toEqual([])
  })

  test('rejects concurrent adoption of one folder by different chats before granting access to the second chat', async () => {
    const f = fixture()
    const existing = { token: 'shared', url: 'https://example.feishu.cn/drive/folder/shared', name: '项目群' }
    f.remote.set(existing.token, existing)
    const results = await Promise.allSettled([
      f.registry.bindExisting('chat-a', 'user', existing),
      f.registry.bindExisting('chat-b', 'user', existing),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(failure.reason.message).toContain('已绑定其他群')
    expect(f.grants).toHaveLength(1)
    expect(Object.values(f.stored().groups)).toHaveLength(1)
  })

  test('rejects persisted cross-chat folder aliases instead of continuing shared access', () => {
    const f = fixture()
    const folder = { token: 'shared', url: 'https://example.feishu.cn/drive/folder/shared', name: '项目群' }
    for (const version of [1, 2, 3]) {
      f.setStored(JSON.stringify({ version, workspaces: {}, groups: {
        'chat-a': { folder, ...(version === 1 ? { enabled: true } : {}) },
        'chat-b': { folder, ...(version === 1 ? { enabled: true } : {}) },
      } }))
      expect(() => f.restart().get('chat-a')).toThrow('重复绑定到多个群')
    }
  })

  test('corrupt persisted folders fail visibly instead of silently creating a new directory', async () => {
    const f = fixture()
    f.setStored('{broken')
    expect(() => f.registry.get('chat-a')).toThrow()
    for (const data of [
      { version: 3, groups: { 'chat-a': {} } },
      { version: 2, groups: { 'chat-a': { folder: { ...oldFolder, token: '' } } } },
      { version: 1, groups: { 'chat-a': { folder: { ...oldFolder, url: 'http://example.com' } } } },
    ]) {
      f.setStored(JSON.stringify(data))
      await expect(f.restart().resolveFolder(context, signal())).rejects.toThrow()
    }
    expect(f.created).toEqual([])
  })

  test('cancels a waiting resolution before creating or granting access', async () => {
    const f = fixture()
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    await expect(f.registry.resolveFolder(context, aborted.signal)).rejects.toThrow('cancelled')
    expect(f.created).toEqual([])
    expect(f.grants).toEqual([])
  })
})
