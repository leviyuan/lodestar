import { describe, expect, test } from 'bun:test'
import { FileDeliveryBatch, type FileDeliveryDeps } from './file-delivery'
import type { FileDeliverySnapshot } from './file-delivery-types'

const folder = { token: 'folder', url: 'https://example.feishu.cn/drive/folder/folder' }
const context = { chatId: 'chat', managerOpenId: 'user', projectName: 'project', createdAt: 1_800_000_000_000 }

function fixture(overrides: Partial<FileDeliveryDeps> = {}) {
  const saved: FileDeliverySnapshot[] = []
  const cards: FileDeliverySnapshot[] = []
  const grants: unknown[][] = []
  const uploads: string[] = []
  const errors: string[] = []
  let folders = 0
  const deps: FileDeliveryDeps = {
    resolveFolder: async (context, signal) => {
      folders++; grants.push([folder, context.chatId, context.managerOpenId, signal]); return folder
    },
    uploadFile: async (path, _folder, onUploaded) => {
      uploads.push(path)
      const file = { token: `token-${uploads.length}`, url: `https://example.feishu.cn/file/${uploads.length}`, name: path.split('/').at(-1)!, bytes: uploads.length * 32 * 1024 * 1024 }
      onUploaded(file)
      return file
    },
    sendCard: async snapshot => { cards.push(structuredClone(snapshot)); return 'message' },
    persist: snapshot => { saved.push(structuredClone(snapshot)) },
    reportError: async message => { errors.push(message) },
    ...overrides,
  }
  return { batch: new FileDeliveryBatch(context, deps), saved, cards, grants, uploads, errors, folderCount: () => folders }
}

describe('cloud file delivery receipts', () => {
  test('one turn publishes one independent card and grants management only to its initiator', async () => {
    const f = fixture()
    f.batch.add('/tmp/report.pdf')
    f.batch.add('/tmp/video.mp4')
    f.batch.add('/tmp/report.pdf')
    const firstFinish = f.batch.finish()
    expect(f.batch.finish()).toBe(firstFinish)
    expect(await firstFinish).toEqual(['/tmp/report.pdf', '/tmp/video.mp4'])
    expect(f.folderCount()).toBe(1)
    expect(f.grants.map(args => args.slice(0, 3))).toEqual([[folder, 'chat', 'user']])
    expect(f.cards).toHaveLength(1)
    expect(f.cards[0].files.map(file => file.file?.url)).toEqual([
      'https://example.feishu.cn/file/1', 'https://example.feishu.cn/file/2',
    ])
    expect(f.saved.at(-1)?.messageId).toBe('message')
    expect(f.saved.at(-1)?.completedAt).toBeNumber()
    expect(() => f.batch.add('/tmp/late.txt')).toThrow('已结束')
  })

  test('waits for admitted uploads before publishing, including a file enqueued during another upload', async () => {
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    const f = fixture({ uploadFile: async (path, _folder, save) => {
      if (path.endsWith('.pdf')) { started(); await wait }
      const result = { token: path, name: path, bytes: 5, url: 'https://example.feishu.cn/file/test' }
      save(result); return result
    } })
    f.batch.add('/tmp/first.pdf')
    await entered
    f.batch.add('/tmp/second.txt')
    const finish = f.batch.finish()
    expect(f.cards).toHaveLength(0)
    release()
    expect(await finish).toEqual(['/tmp/first.pdf', '/tmp/second.txt'])
    expect(f.cards).toHaveLength(1)
  })

  test('shows a failed file while delivering independent successful files, retaining an already uploaded token', async () => {
    const f = fixture({ uploadFile: async (path, _folder, save) => {
      const result = { token: path, name: path, bytes: 50, url: 'https://example.feishu.cn/file/test' }
      save(result)
      if (path.endsWith('.pdf')) throw new Error('metadata request rejected')
      return result
    } })
    f.batch.add('/tmp/report.pdf'); f.batch.add('/tmp/video.mp4')
    expect(await f.batch.finish()).toEqual(['/tmp/video.mp4'])
    expect(f.cards[0].files[0].status).toBe('failed')
    expect(f.cards[0].files[0].error).toContain('文件已上传')
    expect(f.cards[0].files[0].error).toContain('metadata request rejected')
    expect(f.saved.at(-1)?.files[0].file?.token).toBe('/tmp/report.pdf')
  })

  test('permission failure never uploads files into a folder the user cannot manage', async () => {
    const f = fixture({ resolveFolder: async () => { throw new Error('permission denied') } })
    f.batch.add('/tmp/report.pdf'); f.batch.add('/tmp/video.mp4')
    expect(await f.batch.finish()).toEqual([])
    expect(f.uploads).toEqual([])
    expect(f.folderCount()).toBe(0)
    expect(f.cards[0].folderAccessReady).toBe(false)
    expect(f.cards[0].files.every(file => file.status === 'failed' && file.error?.includes('permission denied'))).toBe(true)
  })

  test('a rejected card reports the failure and the accessible folder without claiming successful delivery', async () => {
    const f = fixture({ sendCard: async () => null })
    f.batch.add('/tmp/report.pdf')
    expect(await f.batch.finish()).toEqual([])
    expect(f.errors).toHaveLength(1)
    expect(f.errors[0]).toContain('交付卡发送失败')
    expect(f.errors[0]).toContain(folder.url)
    expect(f.saved.at(-1)?.files[0].status).toBe('ready')
    expect(f.saved.at(-1)?.messageId).toBeUndefined()
  })

  test('refuses remote writes when its receipt cannot be persisted', async () => {
    const f = fixture({ persist: () => { throw new Error('disk full') } })
    expect(() => f.batch.add('/tmp/report.pdf')).toThrow('保存文件交付记录失败')
    expect(await f.batch.finish()).toEqual([])
    expect(f.folderCount()).toBe(0)
    expect(f.cards[0].files[0].status).toBe('failed')
    expect(f.cards[0].error).toContain('disk full')
  })

  test('cancels unfinished uploads and queued files while preserving completed files', async () => {
    let entered!: () => void
    const uploading = new Promise<void>(resolve => { entered = resolve })
    const started: string[] = []
    const f = fixture({ uploadFile: async (path, _folder, save, signal) => {
      started.push(path)
      if (path.endsWith('.mp4')) {
        entered()
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      }
      const result = { token: path, name: path, bytes: 100, url: 'https://example.feishu.cn/file/test' }
      save(result); return result
    } })
    f.batch.add('/tmp/complete.pdf'); f.batch.add('/tmp/cancel.mp4'); f.batch.add('/tmp/queued.zip')
    await uploading
    const complete = f.batch.finish()
    f.batch.cancel('用户停止了任务')
    expect(await complete).toEqual(['/tmp/complete.pdf'])
    expect(started).toEqual(['/tmp/complete.pdf', '/tmp/cancel.mp4'])
    expect(f.cards[0].files.map(item => item.status)).toEqual(['ready', 'failed', 'failed'])
    expect(f.cards[0].error).toContain('用户停止了任务')
  })
})
