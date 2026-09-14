import { describe, expect, test } from 'bun:test'
import { fileDeliveryCard, FILE_DELIVERY_CARD_ROWS } from './files'
import type { FileDeliverySnapshot } from '../file-delivery-types'

function snapshot(): FileDeliverySnapshot {
  return {
    version: 1, id: 'batch', chatId: 'private-chat', managerOpenId: 'private-user', projectName: 'demo', createdAt: 1,
    folderAccessReady: true, folder: { token: 'folder', url: 'https://example.feishu.cn/drive/folder/test' },
    files: [{ id: 'file', path: '/private/local.pdf', name: '报告.pdf', bytes: 1721119, status: 'ready', file: {
      token: 'token', name: '报告.pdf', bytes: 1721119, url: 'https://example.feishu.cn/file/test',
    } }],
  }
}

describe('independent file cards', () => {
  test('opens files directly and uses native Drive management without exposing local identities', () => {
    const result = fileDeliveryCard(snapshot()) as any
    const serialized = JSON.stringify(result)
    expect(result.schema).toBe('2.0')
    expect(serialized).toContain('[报告.pdf](https://example.feishu.cn/file/test)')
    expect(serialized).toContain('1.6 MB')
    const button = result.body.elements.find((element: any) => element.tag === 'button')
    expect(button.text.content).toBe('管理群文件')
    expect(button.behaviors).toEqual([{ type: 'open_url', default_url: 'https://example.feishu.cn/drive/folder/test' }])
    for (const privateValue of ['private-chat', 'private-user', '/private/local.pdf']) expect(serialized).not.toContain(privateValue)
    expect(serialized).not.toContain('callback')
  })

  test('does not expose management or file links before access and upload succeed', () => {
    const state = snapshot()
    state.folderAccessReady = false
    state.files[0].status = 'failed'
    state.files[0].error = '权限未开通'
    const card = fileDeliveryCard(state) as any
    expect(card.body.elements.some((element: any) => element.tag === 'button')).toBe(false)
    expect(JSON.stringify(card)).not.toContain(state.files[0].file!.url)
    expect(JSON.stringify(card)).toContain('权限未开通')
    expect(JSON.stringify(card)).toContain('1 个未完成')
  })

  test('treats Markdown and HTML in filenames as literal text and rejects unsafe URLs', () => {
    const state = snapshot()
    state.files[0].name = '![](img_attacker) <at id=all> & [x](https://evil.test)'
    let result = JSON.stringify(fileDeliveryCard(state))
    expect(result).not.toContain('![](')
    expect(result).not.toContain('<at ')
    expect(result).toContain('&#33;')
    state.files[0].file!.url = 'javascript:alert(1)'
    expect(() => fileDeliveryCard(state)).toThrow('文件链接无效')
  })

  test('bounds the receipt size while keeping a native folder entry for the entire batch', () => {
    const state = snapshot()
    state.files = Array.from({ length: 100 }, (_, index) => ({ ...state.files[0], id: String(index), name: `file-${index}.pdf` }))
    const result = JSON.stringify(fileDeliveryCard(state))
    expect(result).toContain(`其余 ${100 - FILE_DELIVERY_CARD_ROWS} 个文件`)
    expect(result).toContain('100 个文件')
    expect(result).toContain(state.folder!.url)
    expect(result.length).toBeLessThan(12000)
  })
})
