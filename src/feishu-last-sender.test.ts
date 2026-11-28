import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// A subprocess avoids the shared ./feishu mock and exercises the real wrapper
// against a local SDK stub; no Feishu request or message is sent.
test('lastUserMessageSender reads the newest human message from the real chat tail', async () => {
  const proc = Bun.spawn([process.execPath, '--eval', `
    import assert from 'node:assert/strict'
    assert.equal(process.env.NODE_ENV, 'test')
    assert.ok(process.env.LODESTAR_CONFIG, 'the subprocess must inherit the isolated test config')
    const feishu = await import('./src/feishu')
    globalThis.fetch = async () => { throw new Error('unexpected network request') }
    const pages = []
    const requested = []
    feishu.client.im.message.list = async args => {
      requested.push(args.params)
      return pages.shift() ?? { code: 0, data: { items: [] } }
    }

    // App messages and deleted user messages never become the recipient.
    pages.push({ code: 0, data: { has_more: false, items: [
      { message_id: 'om_bot', sender: { id: 'cli_x', id_type: 'app_id', sender_type: 'app' } },
      { message_id: 'om_deleted', deleted: true, sender: { id: 'ou_deleted', id_type: 'open_id', sender_type: 'user' } },
    ] } })
    assert.equal(await feishu.lastUserMessageSender('oc_chat'), null)

    // The newest human message wins across pages; the older one does not.
    pages.push({ code: 0, data: { has_more: true, page_token: 'page_2', items: [
      { message_id: 'om_bot_2', sender: { id: 'cli_x', id_type: 'app_id', sender_type: 'app' } },
    ] } })
    pages.push({ code: 0, data: { has_more: false, items: [
      { message_id: 'om_user', sender: { id: 'ou_new', id_type: 'open_id', sender_type: 'user' } },
      { message_id: 'om_user_older', sender: { id: 'ou_old', id_type: 'open_id', sender_type: 'user' } },
    ] } })
    assert.equal(await feishu.lastUserMessageSender('oc_chat'), 'ou_new')
    assert.deepEqual(requested.map(params => [
      params.container_id_type, params.container_id, params.sort_type, params.page_size, params.page_token,
    ]), [
      ['chat', 'oc_chat', 'ByCreateTimeDesc', 50, undefined],
      ['chat', 'oc_chat', 'ByCreateTimeDesc', 50, undefined],
      ['chat', 'oc_chat', 'ByCreateTimeDesc', 50, 'page_2'],
    ])

    // A malformed page or an upstream rejection is an error, never a guessed person.
    pages.push({ code: 0, data: {} })
    await assert.rejects(feishu.lastUserMessageSender('oc_chat'))
    pages.push({ code: 230027, msg: 'no permission' })
    await assert.rejects(feishu.lastUserMessageSender('oc_chat'))
    await assert.rejects(feishu.lastUserMessageSender(''), /without chat_id/)
  `], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    // Bun's default spawn environment does not include preload mutations.
    env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  expect(code, stderr).toBe(0)
})

// Spec: at most 5 pages, all inside one shared 20-second read window (src/AGENTS.md).
test('lastUserMessageSender stops after five pages and keeps every page inside one 20-second window', async () => {
  const proc = Bun.spawn([process.execPath, '--eval', `
    import assert from 'node:assert/strict'
    assert.equal(process.env.NODE_ENV, 'test')
    const lark = await import('@larksuiteoapi/node-sdk')
    // Only requests answered by an in-process adapter may pass the SDK transport.
    const transport = lark.defaultHttpInstance.request.bind(lark.defaultHttpInstance)
    lark.defaultHttpInstance.request = async options => {
      if (typeof options?.adapter !== 'function') throw new Error('unexpected SDK network request')
      return await transport(options)
    }
    globalThis.fetch = async () => { throw new Error('unexpected network request') }
    const feishu = await import('./src/feishu')
    const botPage = n => ({ code: 0, data: { has_more: true, page_token: 'page_' + (n + 1), items: [
      { message_id: 'om_bot_' + n, sender: { id: 'cli_x', id_type: 'app_id', sender_type: 'app' } },
    ] } })

    // A tail of nothing but bot messages is read for five pages, then reported as unknown.
    let listed = 0
    feishu.client.im.message.list = async () => botPage(++listed)
    assert.equal(await feishu.lastUserMessageSender('oc_chat'), null)
    assert.equal(listed, 5)

    // Each page goes through the real SDK transport, which gets what is left of the one window
    // (capped at 15s per request). Pages that take 8s each run the window out on the fourth page.
    let now = Date.now()
    Date.now = () => now
    const timeouts = []
    let served = 0
    feishu.client.im.message.list = async () => feishu.client.httpInstance.request({
      url: 'https://example.invalid/open-apis/im/v1/messages',
      method: 'GET',
      adapter: async config => {
        timeouts.push(config.timeout)
        now += 8_000
        return { data: botPage(++served), status: 200, statusText: 'OK', headers: {}, config, request: {} }
      },
    })
    const failure = await feishu.lastUserMessageSender('oc_chat').then(() => null, error => error)
    assert.equal(failure?.name, 'TimeoutError')
    assert.equal(served, 3)
    assert.deepEqual(timeouts, [15_000, 12_000, 4_000])

    // The next lookup gets a fresh window of its own.
    served = 0
    timeouts.length = 0
    const again = await feishu.lastUserMessageSender('oc_chat').then(() => null, error => error)
    assert.equal(again?.name, 'TimeoutError')
    assert.deepEqual(timeouts, [15_000, 12_000, 4_000])
  `], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: '', all_proxy: '',
      NO_PROXY: '*', no_proxy: '*',
    },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  expect(code, stderr).toBe(0)
})
