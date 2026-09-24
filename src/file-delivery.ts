import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { DeliveredFile, DeliveryFolder, FileDeliveryContext, FileDeliveryEntry, FileDeliveryHandle, FileDeliverySnapshot } from './file-delivery-types'
import { formatFeishuError } from './feishu-errors'

export interface FileDeliveryDeps {
  resolveFolder(context: FileDeliveryContext, signal: AbortSignal): Promise<DeliveryFolder>
  uploadFile(path: string, folder: DeliveryFolder, onUploaded: (file: DeliveredFile) => void, signal: AbortSignal): Promise<DeliveredFile>
  sendCard(snapshot: FileDeliverySnapshot, onFailure?: (error: unknown) => void): Promise<string | null>
  persist(snapshot: FileDeliverySnapshot): void
  reportError(message: string): Promise<void>
}

export class FileDeliveryBatch implements FileDeliveryHandle {
  readonly snapshot: FileDeliverySnapshot
  private queue: Promise<void> = Promise.resolve()
  private folderPromise?: Promise<DeliveryFolder>
  private finishPromise?: Promise<string[]>
  private persistenceError?: string
  private readonly abort = new AbortController()

  constructor(context: FileDeliveryContext, private readonly deps: FileDeliveryDeps) {
    if (!context.chatId.trim() || !context.managerOpenId.trim()) throw new Error('无法确认交付群或本次交付发起人')
    this.snapshot = { ...context, version: 1, id: randomUUID(), folderAccessReady: false, files: [] }
  }

  add(path: string): void {
    if (this.finishPromise) throw new Error('本次文件交付已结束')
    this.abort.signal.throwIfAborted()
    if (this.snapshot.files.some(file => file.path === path)) return
    const entry: FileDeliveryEntry = { id: randomUUID(), path, name: basename(path), status: 'pending' }
    this.snapshot.files.push(entry)
    try { this.save() } catch (error) {
      entry.status = 'failed'
      entry.error = error instanceof Error ? error.message : String(error)
      throw error
    }
    this.queue = this.queue.then(async () => {
      try {
        this.abort.signal.throwIfAborted()
        if (this.persistenceError) throw new Error(this.persistenceError)
        const folder = await this.getFolder()
        const file = await this.deps.uploadFile(path, folder, uploaded => {
          entry.file = { ...uploaded }
          entry.bytes = uploaded.bytes
          this.save()
        }, this.abort.signal)
        entry.file = file
        entry.bytes = file.bytes
        entry.status = 'ready'
        this.save()
      } catch (error) {
        entry.status = 'failed'
        entry.error = `${entry.file ? '文件已上传，后续处理失败：' : ''}${error instanceof Error ? error.message : String(error)}`
        try { this.save() } catch (persistError) {
          this.snapshot.error = persistError instanceof Error ? persistError.message : String(persistError)
        }
        if (!this.abort.signal.aborted) {
          try { await this.deps.reportError(`❌ 文件交付失败：${entry.name}\n${entry.error}`) }
          catch (noticeError) { this.snapshot.error = `错误提示发送失败：${String(noticeError)}` }
        }
      }
    })
  }

  finish(): Promise<string[]> {
    this.finishPromise ??= this.publish()
    return this.finishPromise
  }

  cancel(reason: string): boolean {
    if (this.abort.signal.aborted || !this.snapshot.files.some(file => file.status === 'pending')) return false
    this.snapshot.error = `未完成的文件上传已取消：${reason}`
    this.abort.abort(new DOMException(reason, 'AbortError'))
    return true
  }

  private save(): void {
    try { this.deps.persist(this.snapshot) }
    catch (error) {
      this.persistenceError = `保存文件交付记录失败：${error instanceof Error ? error.message : String(error)}`
      throw new Error(this.persistenceError)
    }
  }

  private getFolder(): Promise<DeliveryFolder> {
    this.folderPromise ??= (async () => {
      const folder = await this.deps.resolveFolder(this.snapshot, this.abort.signal)
      this.snapshot.folder = folder
      this.snapshot.folderAccessReady = true
      this.save()
      return folder
    })()
    return this.folderPromise
  }

  private async publish(): Promise<string[]> {
    await this.queue
    if (!this.snapshot.files.length) return []
    this.snapshot.completedAt = Date.now()
    try { this.save() } catch (error) {
      this.snapshot.error = error instanceof Error ? error.message : String(error)
    }
    let messageId: string | null
    try {
      let sendFailure: unknown
      messageId = await this.deps.sendCard(this.snapshot, error => { sendFailure = error })
      if (!messageId) throw new Error(`飞书未返回交付卡消息 ID：${formatFeishuError(sendFailure)}`)
    } catch (error) {
      const message = `交付卡发送失败：${error instanceof Error ? error.message : String(error)}`
      this.snapshot.error = message
      try { this.save() } catch (persistError) { this.snapshot.error += `；${String(persistError)}` }
      await this.deps.reportError(`❌ ${this.snapshot.error}${this.snapshot.folderAccessReady ? `\n已上传文件所在文件夹：${this.snapshot.folder!.url}` : ''}`)
      return []
    }
    this.snapshot.messageId = messageId
    try { this.save() } catch (error) { await this.deps.reportError(`❌ 交付卡已发送，但${String(error)}`) }
    return this.snapshot.files.filter(file => file.status === 'ready').map(file => file.path)
  }
}
