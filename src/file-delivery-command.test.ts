import { expect, test } from 'bun:test'
import { runFileDeliveryCommand } from './file-delivery-command'
import type { GroupFileDeliverySettings } from './file-delivery-types'

test('files commands expose per-group on/off/status without starting an Agent or deleting history', async () => {
  let settings: GroupFileDeliverySettings = { enabled: false }
  const actions: string[] = []
  const cards: object[] = []
  const deps = {
    get: (chatId: string) => { expect(chatId).toBe('chat'); return settings },
    enable: async (chatId: string, owner: string) => {
      expect([chatId, owner]).toEqual(['chat', 'user']); actions.push('on')
      return settings = { enabled: true, folder: { token: 'folder', url: 'https://example.feishu.cn/drive/folder/folder', name: '群名' } }
    },
    disable: async () => { actions.push('off'); return settings = { ...settings, enabled: false } },
    sendCard: async (card: object) => { cards.push(card); return 'message' },
    reportError: async (message: string) => { throw new Error(message) },
  }
  for (const argument of ['', 'ON', 'off', 'status', 'unknown']) await runFileDeliveryCommand('chat', '群名', 'user', argument, deps)
  expect(actions).toEqual(['on', 'off'])
  expect(cards).toHaveLength(5)
  expect(JSON.stringify(cards[0])).toContain('聊天附件（默认）')
  expect(JSON.stringify(cards[1])).toContain('云空间交付')
  expect(JSON.stringify(cards[2])).toContain('历史文件保留')
  expect(JSON.stringify(cards[3])).toContain('管理群文件')
  expect(JSON.stringify(cards[4])).toContain('用法：files、files on、files off')
  expect(settings.folder?.token).toBe('folder')
})

test('failed enabling shows the actual unchanged mode and missing permission', async () => {
  let rendered: object | undefined
  await runFileDeliveryCommand('chat', '群名', 'user', 'on', {
    get: () => ({ enabled: false }),
    enable: async () => { throw new Error('drive:drive not granted') },
    disable: async () => { throw new Error('unexpected off') },
    sendCard: async card => { rendered = card; return 'message' },
    reportError: async message => { throw new Error(message) },
  })
  expect(JSON.stringify(rendered)).toContain('drive:drive not granted')
  expect(JSON.stringify(rendered)).toContain('聊天附件（默认）')
})
