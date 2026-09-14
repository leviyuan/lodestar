import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { networkFetch } from './network'
import { getTenantToken } from './feishu'
import { FeishuRequestError, readFeishuResponse, withFeishuRetry } from './feishu-retry'
import type { DeliveredFile, DeliveryFolder, GroupDeliveryFolder } from './file-delivery-types'

const DRIVE_SINGLE_UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_CHUNK_BYTES = 20 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 60_000

export function requireDriveUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('云空间链接 MISS')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('云空间链接无效')
  return url.href
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} MISS`)
  return value
}

export interface FeishuDriveDeps {
  fetch(input: string, init: RequestInit): Promise<Response>
  getToken(): Promise<string>
  retry<T>(label: string, operation: () => Promise<T>): Promise<T>
  wait(ms: number): Promise<void>
  intervalMs: number
}

/** Requests are serialized because Drive upload/folder APIs disallow concurrent calls. */
export class FeishuDriveClient {
  private queue: Promise<void> = Promise.resolve()
  private lastStartedAt = 0

  constructor(private readonly deps: FeishuDriveDeps = {
    fetch: networkFetch,
    getToken: getTenantToken,
    retry: withFeishuRetry,
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    intervalMs: 250,
  }) {}

  private request(label: string, path: string, method = 'GET', body?: () => object | FormData, cancelled?: AbortSignal): Promise<any> {
    const run = this.queue.then(() => this.deps.retry(label, async () => {
      cancelled?.throwIfAborted()
      const token = await this.deps.getToken()
      const data = body?.()
      const multipart = data instanceof FormData
      const delay = this.deps.intervalMs - (Date.now() - this.lastStartedAt)
      if (delay > 0) await this.deps.wait(delay)
      cancelled?.throwIfAborted()
      this.lastStartedAt = Date.now()
      const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const controller = new AbortController()
      const timeout = () => controller.abort(deadline.reason)
      const cancel = () => controller.abort(cancelled!.reason)
      deadline.addEventListener('abort', timeout, { once: true })
      cancelled?.addEventListener('abort', cancel, { once: true })
      const signal = controller.signal
      try {
        const response = await this.deps.fetch(`https://open.feishu.cn/open-apis${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(!multipart && data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          ...(data !== undefined ? { body: multipart ? data : JSON.stringify(data) } : {}),
          signal,
        })
        return (await readFeishuResponse(response, label)).data
      } catch (error) {
        if (signal.aborted && signal.reason?.name === 'TimeoutError') throw signal.reason
        throw error
      } finally {
        deadline.removeEventListener('abort', timeout)
        cancelled?.removeEventListener('abort', cancel)
      }
    }))
    // Release the queue on failure without changing the result seen by this caller.
    this.queue = run.then(() => {}, () => {})
    return run
  }

  async createFolder(name: string, signal?: AbortSignal): Promise<DeliveryFolder> {
    const result = await this.request('创建交付文件夹', '/drive/v1/files/create_folder', 'POST', () => ({ name, folder_token: '' }), signal)
    return { token: requiredString(result?.token, '交付文件夹'), url: requireDriveUrl(result?.url) }
  }

  async getChatName(chatId: string, signal?: AbortSignal): Promise<string> {
    const result = await this.request('读取群名称', `/im/v1/chats/${encodeURIComponent(chatId)}`, 'GET', undefined, signal)
    return requiredString(result?.name, '群名称')
  }

  async getFolder(folder: DeliveryFolder, signal?: AbortSignal): Promise<GroupDeliveryFolder> {
    const result = await this.request('读取群文件夹', `/drive/explorer/v2/folder/${encodeURIComponent(folder.token)}/meta`, 'GET', undefined, signal)
    const token = requiredString(result?.token, '群文件夹')
    if (token !== folder.token) throw new Error('群文件夹返回了不同的标识')
    return { token, url: requireDriveUrl(folder.url), name: requiredString(result?.name, '群文件夹名称') }
  }

  async renameFolder(folder: DeliveryFolder, name: string, signal?: AbortSignal): Promise<GroupDeliveryFolder> {
    try {
      await this.request('同步群文件夹名称', `/drive/v1/files/${encodeURIComponent(folder.token)}?type=folder`, 'PATCH', () => ({ new_title: name }), signal)
    } catch (error) {
      if (error instanceof FeishuRequestError && error.code === 99991672) {
        throw new FeishuRequestError('同步群文件夹名称需要应用身份权限 drive:file:upload（飞书错误码 99991672）', error.status, error.code)
      }
      throw error
    }
    const updated = await this.getFolder(folder, signal)
    if (updated.name !== name) throw new Error('群文件夹名称更新未生效')
    return updated
  }

  async grantFolderAccess(folder: DeliveryFolder, chatId: string, managerOpenId: string, signal?: AbortSignal): Promise<void> {
    requiredString(chatId, '交付群')
    requiredString(managerOpenId, '交付发起人')
    const path = `/drive/v1/permissions/${encodeURIComponent(folder.token)}/members?type=folder`
    for (const member of [
      { member_type: 'openid', member_id: managerOpenId, perm: 'full_access', type: 'user' },
      { member_type: 'openchat', member_id: chatId, perm: 'view', type: 'chat' },
    ]) await this.request('设置交付文件夹权限', path, 'POST', () => member, signal)
    const result = await this.request('核对交付文件夹权限', path, 'GET', undefined, signal)
    if (!Array.isArray(result?.items)) throw new Error('交付文件夹权限列表 MISS')
    for (const [memberType, id, permission] of [['openid', managerOpenId, 'full_access'], ['openchat', chatId, 'view']]) {
      const found = result.items.find((item: any) => item.member_type === memberType && item.member_id === id)
      if (found?.perm !== permission) throw new Error(`交付文件夹权限未生效：${memberType} / ${permission}`)
    }
  }

  /** File uploads can default to tenant_readable even inside a closed folder.
   * Disable link-based access before publishing; existing collaborators keep their access. */
  async closeFileLinkSharing(fileToken: string, signal?: AbortSignal): Promise<void> {
    requiredString(fileToken, '交付文件')
    const path = `/drive/v2/permissions/${encodeURIComponent(fileToken)}/public?type=file`
    await this.request('关闭交付文件链接分享', path, 'PATCH', () => ({ link_share_entity: 'closed' }), signal)
    const settings = await this.request('核对交付文件链接分享', path, 'GET', undefined, signal)
    if (settings?.permission_public?.link_share_entity !== 'closed') {
      throw new Error('交付文件链接分享未关闭，不能发布交付链接')
    }
  }

  async uploadFile(filePath: string, folder: DeliveryFolder, onUploaded: (file: DeliveredFile) => void, signal?: AbortSignal): Promise<DeliveredFile> {
    signal?.throwIfAborted()
    const handle = await open(filePath, 'r')
    try {
      const initial = await handle.stat()
      if (!initial.isFile()) throw new Error('交付路径不是普通文件')
      if (!Number.isSafeInteger(initial.size) || initial.size <= 0) throw new Error('不能上传空文件或无效大小的文件')
      const name = basename(filePath)
      const metadata = { file_name: name, parent_type: 'explorer', parent_node: folder.token, size: initial.size }
      let result: any
      if (initial.size <= DRIVE_SINGLE_UPLOAD_BYTES) {
        const bytes = await handle.readFile()
        const current = await handle.stat()
        if (bytes.length !== initial.size || current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs) {
          throw new Error('交付文件在读取时发生变化')
        }
        result = await this.request('上传交付文件', '/drive/v1/files/upload_all', 'POST', () => {
          const form = new FormData()
          for (const [key, value] of Object.entries(metadata)) form.append(key, String(value))
          form.append('file', new Blob([Uint8Array.from(bytes)]), name)
          return form
        }, signal)
      } else {
        const prepared = await this.request('准备上传交付文件', '/drive/v1/files/upload_prepare', 'POST', () => metadata, signal)
        const uploadId = requiredString(prepared?.upload_id, '分片上传事务')
        const blockSize = prepared?.block_size
        const blockCount = prepared?.block_num
        if (!Number.isSafeInteger(blockSize) || blockSize <= 0 || blockSize > MAX_CHUNK_BYTES
          || !Number.isSafeInteger(blockCount) || blockCount !== Math.ceil(initial.size / blockSize)) {
          throw new Error('云空间返回的分片策略无效')
        }
        for (let seq = 0; seq < blockCount; seq++) {
          signal?.throwIfAborted()
          const size = Math.min(blockSize, initial.size - seq * blockSize)
          const bytes = Buffer.alloc(size)
          let read = 0
          while (read < size) {
            const chunk = await handle.read(bytes, read, size - read, seq * blockSize + read)
            if (!chunk.bytesRead) throw new Error('交付文件在分片读取时发生变化')
            read += chunk.bytesRead
          }
          await this.request('上传交付文件分片', '/drive/v1/files/upload_part', 'POST', () => {
            const form = new FormData()
            form.append('upload_id', uploadId); form.append('seq', String(seq)); form.append('size', String(size))
            form.append('file', new Blob([Uint8Array.from(bytes)]), name)
            return form
          }, signal)
        }
        const current = await handle.stat()
        if (current.size !== initial.size || current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs) {
          throw new Error('交付文件在上传期间被修改，未完成上传')
        }
        result = await this.request('完成交付文件上传', '/drive/v1/files/upload_finish', 'POST', () => ({ upload_id: uploadId, block_num: blockCount }), signal)
      }
      const fileToken = requiredString(result?.file_token, '已上传文件')
      // Retain the identity before permission/URL checks so any failure remains manageable.
      const uploaded = { token: fileToken, url: '', name, bytes: initial.size }
      onUploaded(uploaded)
      await this.closeFileLinkSharing(fileToken, signal)
      const meta = await this.request('读取交付文件链接', '/drive/v1/metas/batch_query', 'POST', () => ({
        request_docs: [{ doc_token: fileToken, doc_type: 'file' }], with_url: true,
      }), signal)
      const entry = meta?.metas?.find((item: any) => item.doc_token === fileToken && item.doc_type === 'file')
      if (meta?.failed_list?.length || !entry) throw new Error('已上传文件的元数据 MISS')
      const file = { ...uploaded, url: requireDriveUrl(entry.url) }
      onUploaded(file)
      return file
    } finally { await handle.close() }
  }
}

export const feishuDrive = new FeishuDriveClient()
