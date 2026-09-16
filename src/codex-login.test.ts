import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { CodexLogins, requireDefaultCodexLogin } from './codex-login'
import { DEFAULT_CODEX_ACCOUNT, reserveCodexLogin } from './codex-accounts'

class Client extends EventEmitter {
  alive = true
  calls: Array<[string, any]> = []
  closeError: Error | null = null
  early = false
  malformed = false
  initError: Error | null = null
  accountError: Error | null = null
  initialAuthUpdate = false
  account: any = { type: 'chatgpt', email: 'test@example.test', planType: 'pro' }
  async initialize() {
    if (this.initError) throw this.initError
    if (this.initialAuthUpdate) this.emit('notification', 'account/updated', { authMode: 'chatgpt', planType: 'pro' })
  }
  async request(method: string, params: any) {
    this.calls.push([method, params])
    if (method === 'account/login/start') {
      if (this.early) {
        this.emit('notification', 'account/login/completed', { loginId: 'login-1', success: true })
        this.emit('notification', 'account/updated', { authMode: 'chatgpt', planType: 'pro' })
      }
      return this.malformed ? {} : { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE' }
    }
    if (method === 'account/read') {
      if (this.accountError) throw this.accountError
      return { account: this.account }
    }
    if (method === 'account/login/cancel') {
      this.emit('notification', 'account/login/completed', { loginId: 'login-1', success: false, error: 'canceled' })
      return { status: 'canceled' }
    }
    throw new Error(`unexpected method ${method}`)
  }
  async close() { if (this.closeError) throw this.closeError; this.alive = false }
  isAlive() { return this.alive }
}
const owner = { chatId: 'chat-test', userOpenId: 'user-test' }

describe('default account prerequisite for named login', () => {
  test('accepts native ChatGPT auth without requiring files, quota or models', async () => {
    const client = new Client()
    await requireDefaultCodexLogin(id => { expect(id).toBe(DEFAULT_CODEX_ACCOUNT); return client })
    expect(client.calls).toEqual([['account/read', { refreshToken: false }]])
    expect(client.alive).toBe(false)
  })

  test('signed-out and API-key defaults require an unqualified codex-login first', async () => {
    for (const account of [null, { type: 'apiKey' }]) {
      const client = new Client(); client.account = account
      await expect(requireDefaultCodexLogin(() => client)).rejects.toThrow('请先发送不带备注的 codex-login')
      expect(client.calls).toEqual([['account/read', { refreshToken: false }]])
      expect(client.alive).toBe(false)
    }
  })

  test('a default login in progress is rejected before creating a probe', async () => {
    const release = reserveCodexLogin(DEFAULT_CODEX_ACCOUNT)
    let created = false
    try {
      await expect(requireDefaultCodexLogin(() => { created = true; return new Client() })).rejects.toThrow('默认账号正在登录')
      expect(created).toBe(false)
    } finally { release() }
  })

  test('probe failures and invalid responses remain errors rather than a signed-out diagnosis', async () => {
    for (const mode of ['initialize', 'request', 'invalid']) {
      const client = new Client()
      if (mode === 'initialize') client.initError = new Error('native initialize failed')
      else if (mode === 'request') client.accountError = new Error('native account read rejected')
      else client.account = undefined
      const message = mode === 'initialize' ? 'native initialize failed' : mode === 'request' ? 'native account read rejected' : '账号状态无效'
      await expect(requireDefaultCodexLogin(() => client)).rejects.toThrow(message)
      expect(client.alive).toBe(false)
      expect(client.calls.every(([method]) => method === 'account/read')).toBe(true)
    }
    await expect(requireDefaultCodexLogin(() => { throw new Error('Codex executable unavailable') }))
      .rejects.toThrow('默认账号登录检查失败：Codex executable unavailable')
  })

  test('a failed probe shutdown rejects successful auth and preserves prior errors', async () => {
    for (const signedOut of [false, true]) {
      const client = new Client(); client.closeError = new Error('SIGTERM rejected')
      if (signedOut) client.account = null
      const error = await requireDefaultCodexLogin(() => client).then(() => null, error => error as Error)
      expect(error?.message).toContain('默认账号检查进程关闭失败：SIGTERM rejected')
      if (signedOut) expect(error?.message).toContain('请先发送不带备注的 codex-login')
      expect(client.alive).toBe(true)
    }
  })
})

describe('Codex device-code login controller', () => {
  test('returns instructions promptly and waits for the matching completion before registering auth', async () => {
    const client = new Client()
    const saved: string[] = []
    const manager = new CodexLogins(id => { expect(id).toBe('named'); return client }, 1000, id => saved.push(id))
    const handle = await manager.start('named', owner)
    expect(handle.userCode).toBe('TEST-CODE')
    expect(client.calls[0]).toEqual(['account/login/start', { type: 'chatgptDeviceCode' }])
    expect(saved).toEqual([])
    client.emit('notification', 'account/login/completed', { loginId: 'someone-else', success: true })
    expect(saved).toEqual([])
    client.emit('notification', 'account/login/completed', { loginId: 'login-1', success: true })
    expect(client.calls.some(([method]) => method === 'account/read')).toBe(false)
    client.emit('notification', 'account/updated', { authMode: 'chatgpt', planType: 'pro' })
    expect(await handle.done).toMatchObject({ email: 'test@example.test', planType: 'pro' })
    expect(saved).toEqual(['named'])
    expect(client.alive).toBe(false)
    expect(manager.pending(owner)).toEqual([])
  })

  test('handles completion arriving before the start response', async () => {
    const client = new Client(); client.early = true
    const manager = new CodexLogins(() => client, 1000, () => {})
    const handle = await manager.start('default', owner)
    expect((await handle.done).type).toBe('chatgpt')
    expect(client.alive).toBe(false)
  })

  test('Plus login waits for the refreshed auth state instead of reading the cached null account', async () => {
    const client = new Client()
    client.account = null
    client.initialAuthUpdate = true // A pre-login notification must not satisfy this login's barrier.
    const saved: any[] = []
    const manager = new CodexLogins(() => client, 1000, (_id, account) => saved.push(account))
    const handle = await manager.start('plus-account', owner)
    client.emit('notification', 'account/login/completed', { loginId: 'login-1', success: true })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(client.calls.filter(([method]) => method === 'account/read')).toHaveLength(0)
    expect(client.alive).toBe(true)
    expect(saved).toEqual([])
    client.account = { type: 'chatgpt', email: 'plus@example.test', planType: 'plus' }
    client.emit('notification', 'account/updated', { authMode: 'chatgpt', planType: 'plus' })
    expect(await handle.done).toMatchObject({ type: 'chatgpt', planType: 'plus' })
    expect(saved).toEqual([client.account])
    expect(client.calls).toContainEqual(['account/read', { refreshToken: false }])
  })

  test('an auth update can precede completion, but cannot register a login on its own', async () => {
    const client = new Client()
    const saved: any[] = []
    const manager = new CodexLogins(() => client, 1000, (_id, account) => saved.push(account))
    const handle = await manager.start('a', owner)
    client.emit('notification', 'account/updated', { authMode: 'chatgpt', planType: 'pro' })
    expect(saved).toEqual([])
    expect(client.calls.some(([method]) => method === 'account/read')).toBe(false)
    client.emit('notification', 'account/login/completed', { loginId: 'login-1', success: true })
    await handle.done
    expect(saved).toHaveLength(1)
  })

  test('missing updates and inconsistent account reads fail visibly without discarding credentials', async () => {
    const client = new Client()
    const saved: any[] = []
    const manager = new CodexLogins(() => client, 1000, (_id, account) => saved.push(account), 5)
    const handle = await manager.start('a', owner)
    client.emit('notification', 'account/login/completed', { loginId: 'login-1', success: true })
    await expect(handle.done).rejects.toThrow('认证文件已保留')
    expect(saved).toEqual([])
    expect(client.alive).toBe(false)
    expect(client.calls.some(([method]) => method === 'account/logout')).toBe(false)

    const invalid = new Client(); invalid.account = { type: 'apiKey' }
    const invalidManager = new CodexLogins(() => invalid, 1000, () => { throw new Error('must not register') })
    const invalidHandle = await invalidManager.start('b', owner)
    invalid.emit('notification', 'account/login/completed', { loginId: 'login-1', success: true })
    invalid.emit('notification', 'account/updated', { authMode: 'chatgpt', planType: 'plus' })
    await expect(invalidHandle.done).rejects.toThrow('account/read.type=apiKey')
    expect(invalid.alive).toBe(false)
  })

  test('duplicates and foreign cancellation cannot take over a pending login', async () => {
    const client = new Client()
    const manager = new CodexLogins(() => client, 1000, () => {})
    const handle = await manager.start('named', owner)
    await expect(manager.start('named', owner)).rejects.toThrow('已有登录任务')
    await expect(manager.cancel('named', { ...owner, userOpenId: 'other' })).rejects.toThrow('只有发起')
    expect(client.calls).toHaveLength(1)
    await manager.cancel('named', owner)
    await expect(handle.done).rejects.toThrow('已取消')
    expect(client.calls).toContainEqual(['account/login/cancel', { loginId: 'login-1' }])
    expect(manager.pending(owner)).toEqual([])
  })

  test('failure, timeout and shutdown close the client and keep the actual error', async () => {
    const failed = new Client()
    const manager = new CodexLogins(() => failed, 1000, () => { throw new Error('must not save failed login') })
    const handle = await manager.start('a', owner)
    failed.emit('notification', 'account/login/completed', { loginId: 'login-1', success: false, error: 'device auth disabled' })
    await expect(handle.done).rejects.toThrow('device auth disabled')
    expect(failed.alive).toBe(false)

    const timed = new Client()
    const timeout = new CodexLogins(() => timed, 5, () => {})
    const timedHandle = await timeout.start('b', owner)
    await expect(timedHandle.done).rejects.toThrow('等待超过')
    expect(timed.alive).toBe(false)

    const closing = new Client()
    const shutdown = new CodexLogins(() => closing, 1000, () => {})
    const closingHandle = await shutdown.start('c', owner)
    await shutdown.shutdown()
    await expect(closingHandle.done).rejects.toThrow('服务退出')
    await expect(shutdown.start('d', owner)).rejects.toThrow('服务正在退出')
  })

  test('malformed responses and initialization failures clean up their exact client', async () => {
    for (const mode of ['malformed', 'initialize']) {
      const client = new Client()
      if (mode === 'malformed') client.malformed = true
      else client.initError = new Error('initialize failed')
      const manager = new CodexLogins(() => client, 1000, () => {})
      await expect(manager.start('a', owner)).rejects.toThrow(mode === 'malformed' ? '响应不完整' : 'initialize failed')
      expect(client.alive).toBe(false)
      expect(manager.pending(owner)).toEqual([])
    }
  })

  test('failed cleanup remains visible and blocks another credential writer', async () => {
    const client = new Client(); client.closeError = new Error('process still alive')
    const manager = new CodexLogins(() => client, 1000, () => {})
    const handle = await manager.start('a', owner)
    client.emit('notification', 'account/login/completed', { loginId: 'login-1', success: false, error: 'denied' })
    await expect(handle.done).rejects.toThrow('process still alive')
    await expect(manager.start('a', owner)).rejects.toThrow('已有登录任务')
    client.closeError = null
    await manager.shutdown()
    expect(client.alive).toBe(false)
  })
})
