import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { FeishuDriveClient, type FeishuDriveDeps } from './feishu-drive'
import { FeishuRequestError } from './feishu-retry'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function file(bytes: Buffer, name = 'report.bin') {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-drive-test-')); roots.push(root)
  const path = join(root, name); writeFileSync(path, bytes); return path
}

function deps(fetch: FeishuDriveDeps['fetch'], extra: Partial<FeishuDriveDeps> = {}): FeishuDriveDeps {
  return { fetch, getToken: async () => 'test-token', retry: async (_label, run) => run(), wait: async () => {}, intervalMs: 0, ...extra }
}
const folder = { token: 'folder', url: 'https://example.feishu.cn/drive/folder/folder' }

describe('Feishu Drive delivery transport', () => {
  test('reports the additional upload scope required by the folder rename endpoint', async () => {
    const client = new FeishuDriveClient(deps(async () => Response.json({ code: 99991672, msg: 'missing scope' }, { status: 400 })))
    await expect(client.renameFolder(folder, '群名称')).rejects.toThrow('drive:file:upload')
  })

  test('reads the live group name and updates the same folder title through the native API', async () => {
    let title = 'old title'
    const requests: Array<{ path: string; method?: string; body?: unknown }> = []
    const client = new FeishuDriveClient(deps(async (url, init) => {
      const path = new URL(url).pathname
      requests.push({ path, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined })
      if (path.includes('/im/v1/chats/')) return Response.json({ code: 0, data: { name: '群的新名字' } })
      if (init.method === 'PATCH') {
        expect(new URL(url).searchParams.get('type')).toBe('folder')
        title = JSON.parse(String(init.body)).new_title
        return Response.json({ code: 0 })
      }
      return Response.json({ code: 0, data: { token: folder.token, name: title } })
    }))
    expect(await client.getChatName('chat')).toBe('群的新名字')
    const updated = await client.renameFolder(folder, '群的新名字')
    expect(updated).toEqual({ ...folder, name: '群的新名字' })
    expect(requests[1]).toEqual({ path: '/open-apis/drive/v1/files/folder', method: 'PATCH', body: { new_title: '群的新名字' } })
    expect(requests[2].path).toBe('/open-apis/drive/explorer/v2/folder/folder/meta')
  })

  test('uploads a real file above 30 MiB in ordered chunks and retries the same immutable part', async () => {
    const source = Buffer.alloc(32 * 1024 * 1024 + 123)
    const blockSize = 4 * 1024 * 1024
    for (let offset = 0; offset < source.length; offset += blockSize) source.fill(offset / blockSize + 1, offset, Math.min(source.length, offset + blockSize))
    const path = file(source)
    const parts: Buffer[] = []
    const firstForms: FormData[] = []
    let failedOnce = false
    const phases: string[] = []
    const uploaded: any[] = []
    let linkSharing = 'tenant_readable'
    const client = new FeishuDriveClient(deps(async (url, init) => {
      const endpoint = new URL(url).pathname
      phases.push(endpoint)
      if (endpoint.endsWith('/upload_prepare')) {
        const body = JSON.parse(String(init.body))
        expect(body.size).toBe(source.length)
        expect(body.parent_node).toBe(folder.token)
        return Response.json({ code: 0, data: { upload_id: 'upload', block_size: blockSize, block_num: 9 } })
      }
      if (endpoint.endsWith('/upload_part')) {
        const form = init.body as FormData
        const seq = Number(form.get('seq'))
        const bytes = Buffer.from(await (form.get('file') as Blob).arrayBuffer())
        expect(form.get('upload_id')).toBe('upload')
        expect(Number(form.get('size'))).toBe(bytes.length)
        expect(bytes.equals(source.subarray(seq * blockSize, (seq + 1) * blockSize))).toBe(true)
        if (seq === 0) firstForms.push(form)
        if (!failedOnce) { failedOnce = true; return Response.json({ code: 1, msg: 'gateway' }, { status: 502 }) }
        expect(seq).toBe(parts.length)
        parts.push(bytes)
        return Response.json({ code: 0 })
      }
      if (endpoint.endsWith('/upload_finish')) {
        expect(parts).toHaveLength(9)
        expect(JSON.parse(String(init.body))).toEqual({ upload_id: 'upload', block_num: 9 })
        return Response.json({ code: 0, data: { file_token: 'uploaded' } })
      }
      if (endpoint.endsWith('/public')) {
        expect(new URL(url).searchParams.get('type')).toBe('file')
        if (init.method === 'PATCH') {
          expect(JSON.parse(String(init.body))).toEqual({ link_share_entity: 'closed' })
          linkSharing = 'closed'
          return Response.json({ code: 0 })
        }
        return Response.json({ code: 0, data: { permission_public: { link_share_entity: linkSharing } } })
      }
      if (endpoint.endsWith('/batch_query')) {
        expect(linkSharing).toBe('closed')
        return Response.json({ code: 0, data: { metas: [{ doc_type: 'file', doc_token: 'uploaded', url: 'https://example.feishu.cn/file/uploaded' }] } })
      }
      throw new Error(`Unexpected endpoint ${endpoint}`)
    }, { retry: async (_label, operation) => {
      try { return await operation() } catch (error) {
        if (error instanceof FeishuRequestError && error.status === 502) return operation()
        throw error
      }
    } }))
    const result = await client.uploadFile(path, folder, item => uploaded.push({ ...item }))
    expect(result.bytes).toBe(source.length)
    expect(result.url).toBe('https://example.feishu.cn/file/uploaded')
    expect(createHash('sha256').update(Buffer.concat(parts)).digest('hex')).toBe(createHash('sha256').update(source).digest('hex'))
    expect(firstForms).toHaveLength(2)
    expect(firstForms[0]).not.toBe(firstForms[1])
    expect(phases.some(phase => phase.includes('/im/'))).toBe(false)
    expect(uploaded[0]).toMatchObject({ token: 'uploaded', url: '' })
    expect(uploaded.at(-1).url).toBe(result.url)
  })

  test('uses upload_all for a small file and preserves its uploaded identity if metadata fails', async () => {
    const path = file(Buffer.from('PDF contents'), '中文.pdf')
    const identities: any[] = []
    const requests: string[] = []
    const client = new FeishuDriveClient(deps(async (url, init) => {
      requests.push(url)
      if (url.endsWith('/upload_all')) {
        const form = init.body as FormData
        expect(form.get('file_name')).toBe('中文.pdf')
        expect(await (form.get('file') as Blob).text()).toBe('PDF contents')
        return Response.json({ code: 0, data: { file_token: 'saved', url: 'https://example.feishu.cn/file/saved' } })
      }
      if (new URL(url).pathname.endsWith('/public')) return Response.json({ code: 0, data: { permission_public: { link_share_entity: 'closed' } } })
      return Response.json({ code: 1061004, msg: 'forbidden' }, { status: 403 })
    }))
    await expect(client.uploadFile(path, folder, item => identities.push({ ...item }))).rejects.toThrow('forbidden')
    expect(requests).toHaveLength(4)
    expect(identities).toEqual([{ token: 'saved', url: '', name: '中文.pdf', bytes: 12 }])
  })

  for (const failure of ['patch denied', 'still tenant readable', 'missing permission data', 'read denied']) {
    test(`does not publish an uploaded file if link isolation fails: ${failure}`, async () => {
      const path = file(Buffer.from('private report'))
      const identities: any[] = []
      let linkQueries = 0
      const client = new FeishuDriveClient(deps(async (url, init) => {
        if (url.endsWith('/upload_all')) return Response.json({ code: 0, data: { file_token: 'saved' } })
        if (new URL(url).pathname.endsWith('/public')) {
          if ((init.method === 'PATCH' && failure === 'patch denied') || (init.method === 'GET' && failure === 'read denied')) {
            return Response.json({ code: 1061004, msg: 'permission denied' }, { status: 403 })
          }
          if (init.method === 'PATCH') return Response.json({ code: 0 })
          return Response.json({ code: 0, data: failure === 'missing permission data' ? {} : { permission_public: { link_share_entity: 'tenant_readable' } } })
        }
        linkQueries++
        throw new Error('must not look up or publish the file link')
      }))
      await expect(client.uploadFile(path, folder, item => identities.push({ ...item }))).rejects.toThrow(
        failure.endsWith('denied') ? 'permission denied' : '链接分享未关闭',
      )
      expect(linkQueries).toBe(0)
      expect(identities).toEqual([{ token: 'saved', url: '', name: 'report.bin', bytes: 14 }])
    })
  }

  for (const interrupt of ['receipt write failure', 'cancellation after upload', 'cancellation during permission update']) {
    test(`closes uploaded file sharing before surfacing ${interrupt}`, async () => {
      const path = file(Buffer.from('private report'))
      const controller = new AbortController()
      const permissions: string[] = []
      let linkQueries = 0
      const client = new FeishuDriveClient(deps(async (url, init) => {
        if (url.endsWith('/upload_all')) return Response.json({ code: 0, data: { file_token: 'saved' } })
        if (new URL(url).pathname.endsWith('/public')) {
          permissions.push(init.method!)
          if (interrupt === 'cancellation during permission update' && init.method === 'PATCH') controller.abort(new DOMException('delivery cancelled', 'AbortError'))
          expect(init.signal!.aborted).toBe(false)
          return Response.json({ code: 0, data: { permission_public: { link_share_entity: 'closed' } } })
        }
        linkQueries++
        throw new Error('must not publish a cancelled or unrecorded delivery')
      }))
      await expect(client.uploadFile(path, folder, () => {
        if (interrupt === 'receipt write failure') throw new Error('receipt disk full')
        if (interrupt === 'cancellation after upload') controller.abort(new DOMException('delivery cancelled', 'AbortError'))
      }, controller.signal)).rejects.toThrow(interrupt === 'receipt write failure' ? 'receipt disk full' : 'delivery cancelled')
      expect(permissions).toEqual(['PATCH', 'GET'])
      expect(linkQueries).toBe(0)
    })
  }

  test('preserves both receipt persistence and mandatory link-closing failures', async () => {
    const path = file(Buffer.from('private report'))
    let closes = 0
    const client = new FeishuDriveClient(deps(async (url) => {
      if (url.endsWith('/upload_all')) return Response.json({ code: 0, data: { file_token: 'saved' } })
      closes++
      return Response.json({ code: 1061004, msg: 'permission denied' }, { status: 403 })
    }))
    const result = await Promise.allSettled([client.uploadFile(path, folder, () => { throw new Error('receipt disk full') })])
    expect(result[0].status).toBe('rejected')
    const error = (result[0] as PromiseRejectedResult).reason
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toContain('receipt disk full')
    expect(error.message).toContain('permission denied')
    expect(error.errors).toHaveLength(2)
    expect(closes).toBe(1)
  })

  test('does not complete multipart upload if the source changes during transmission', async () => {
    const path = file(Buffer.alloc(21 * 1024 * 1024))
    let finishes = 0
    const client = new FeishuDriveClient(deps(async (url, init) => {
      if (url.endsWith('/upload_prepare')) return Response.json({ code: 0, data: { upload_id: 'id', block_size: 4 * 1024 * 1024, block_num: 6 } })
      if (url.endsWith('/upload_part')) {
        if ((init.body as FormData).get('seq') === '0') utimesSync(path, new Date(1), new Date(1))
        return Response.json({ code: 0 })
      }
      finishes++
      throw new Error('Should not complete changed source')
    }))
    await expect(client.uploadFile(path, folder, () => {})).rejects.toThrow('上传期间被修改')
    expect(finishes).toBe(0)
  })

  test('surfaces account upload limits without switching transport', async () => {
    const path = file(Buffer.alloc(31 * 1024 * 1024))
    const requests: string[] = []
    const client = new FeishuDriveClient(deps(async url => {
      requests.push(url)
      return Response.json({ code: 1061043, msg: 'file size beyond limit' }, { status: 400 })
    }))
    await expect(client.uploadFile(path, folder, () => {})).rejects.toThrow('file size beyond limit')
    expect(requests).toEqual(['https://open.feishu.cn/open-apis/drive/v1/files/upload_prepare'])
  })

  test('checks both initiator management and group viewing permissions by a fresh read', async () => {
    const grants: any[] = []
    const client = new FeishuDriveClient(deps(async (_url, init) => {
      if (init.method === 'POST') { grants.push(JSON.parse(String(init.body))); return Response.json({ code: 0, data: {} }) }
      return Response.json({ code: 0, data: { items: grants } })
    }))
    await client.grantFolderAccess(folder, 'chat', 'initiator')
    expect(grants).toEqual([
      { member_type: 'openid', member_id: 'initiator', perm: 'full_access', type: 'user' },
      { member_type: 'openchat', member_id: 'chat', perm: 'view', type: 'chat' },
    ])
    const denied = new FeishuDriveClient(deps(async () => Response.json({ code: 0, data: { items: [] } })))
    await expect(denied.grantFolderAccess(folder, 'chat', 'initiator')).rejects.toThrow('权限未生效')
  })

  test('serializes overlapping requests and rejects malformed successful responses', async () => {
    let active = 0
    let maximum = 0
    const client = new FeishuDriveClient(deps(async () => {
      active++; maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active--
      return Response.json({ code: 0, data: folder })
    }))
    await Promise.all([client.createFolder('one'), client.createFolder('two'), client.createFolder('three')])
    expect(maximum).toBe(1)
    const broken = new FeishuDriveClient(deps(async () => Response.json({ code: 0, data: {} })))
    await expect(broken.createFolder('test')).rejects.toThrow('交付文件夹 MISS')
  })

  test('cancels an active request and prevents queued requests from reaching Feishu', async () => {
    const controller = new AbortController()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let requests = 0
    const client = new FeishuDriveClient(deps(async (_url, init) => {
      requests++; entered()
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
    }))
    const first = client.createFolder('first', controller.signal)
    const queued = client.createFolder('queued', controller.signal)
    const observed = Promise.allSettled([first, queued])
    await started
    controller.abort(new DOMException('cancel delivery', 'AbortError'))
    const results = await observed
    expect(results.every(result => result.status === 'rejected' && result.reason.name === 'AbortError')).toBe(true)
    expect(requests).toBe(1)
  })
})
