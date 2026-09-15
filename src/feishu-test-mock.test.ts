import { expect, test } from 'bun:test'

test('Feishu test isolation replaces card dependencies captured before the mock loads', () => {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', `
    import assert from 'node:assert/strict'
    const { agentCardsDeps } = await import('./src/agent-cards-runtime')
    const originalSend = agentCardsDeps.sendCard
    const { sentCards, chatTailMessages } = await import('./src/feishu-test-mock')
    const feishu = await import('./src/feishu')
    assert.notEqual(originalSend, feishu.sendCard)
    // 在调用前确认真实网络入口已被替换，回归失败时不能实际向飞书发请求。
    assert.equal(agentCardsDeps.sendCard, feishu.sendCard)
    assert.equal(agentCardsDeps.getChatTailMessageId, feishu.getChatTailMessageId)
    const card = { schema: '2.0', body: { elements: [] } }
    const message = await agentCardsDeps.sendCard('isolated-chat', card)
    assert.deepEqual(sentCards, [card])
    assert.equal(await agentCardsDeps.getChatTailMessageId('isolated-chat'), message)
    assert.equal(chatTailMessages.get('isolated-chat'), message)
  `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 20_000 })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
