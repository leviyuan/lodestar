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
