import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// A subprocess avoids the shared ./feishu mock and exercises the real wrappers
// with an entirely local SDK stub; no Feishu messages or requests are sent.
test('Feishu sends participate in message ordering and tail reads reject incomplete responses', async () => {
  const proc = Bun.spawn([process.execPath, '--eval', `
    import assert from 'node:assert/strict'
    import { withChatMessageOrder } from './src/chat-message-order'
    assert.equal(process.env.NODE_ENV, 'test')
    assert.ok(process.env.LODESTAR_CONFIG, 'the subprocess must inherit the isolated test config')
    const feishu = await import('./src/feishu')
    const { config } = await import('./src/config')
    assert.equal(config.feishu.app_id, 'cli_test')
    globalThis.fetch = async () => { throw new Error('unexpected network request') }
    const events = []
    let listResponse = { code: 0, data: { items: [{ message_id: 'user-or-app-message' }] } }
    feishu.client.im.message.list = async args => {
      assert.deepEqual(args.params, { container_id_type: 'chat', container_id: 'chat', sort_type: 'ByCreateTimeDesc', page_size: 1 })
      return listResponse
    }
    assert.equal(await feishu.getChatTailMessageId('chat'), 'user-or-app-message')
    listResponse = { code: 0, data: { items: [] } }
    assert.equal(await feishu.getChatTailMessageId('chat'), null)
    for (const response of [{ code: 999, msg: 'permission denied' }, { code: 0, data: {} }, { code: 0, data: { items: [{}] } }, { code: 0, data: { items: [{ message_id: 42 }] } }]) {
      listResponse = response
      await assert.rejects(feishu.getChatTailMessageId('chat'))
    }
    feishu.client.im.message.create = async args => {
      events.push(args.data.msg_type)
      return { code: 0, data: { message_id: 'message-' + events.length } }
    }
    let release
    const gate = new Promise(resolve => { release = resolve })
    const placement = withChatMessageOrder('chat', async () => {
      await gate
      await feishu.sendCard('chat', { schema: '2.0', body: { elements: [] } })
    })
    const text = feishu.sendText('chat', 'main output')
    const image = feishu.sendImage('chat', 'image-key')
    const file = feishu.sendFile('chat', 'file-key')
    await Promise.resolve()
    assert.deepEqual(events, [])
    release()
    await Promise.all([placement, text, image, file])
    assert.deepEqual(events, ['interactive', 'text', 'image', 'file'])
  `], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    // Bun's default spawn environment does not include preload mutations.
    env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  expect(code, stderr).toBe(0)
})
