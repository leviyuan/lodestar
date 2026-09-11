import { describe, expect, test } from 'bun:test'
import { CodexAccountCard, type CodexAccountCardDeps } from './codex-account-card'

function harness() {
  const calls: Array<{ operation: string; value?: any }> = []
  const control = { replace: true, settings: true, send: true }
  const deps: CodexAccountCardDeps = {
    sendCard: async (_chat, card) => { calls.push({ operation: 'send', value: card }); return control.send ? 'message' : null },
    convertMessageToCard: async () => 'card',
    recordCardCreated: (_id, count) => { calls.push({ operation: 'register', value: count }) },
    replaceElementChecked: async (_id, _element, value) => { calls.push({ operation: 'replace', value }); return control.replace },
    patchSettingsChecked: async (_id, value) => { calls.push({ operation: 'settings', value }); return control.settings },
    dispose: async () => { calls.push({ operation: 'dispose' }) },
  }
  return { calls, deps, control }
}
describe('Codex account card lifecycle', () => {
  test('updates one registered card and finalizes it exactly once', async () => {
    const { calls, deps } = harness()
    const card = await CodexAccountCard.open('chat', { phase: 'connecting' }, deps)
    await card.update({ phase: 'waiting', verification: { code: 'ABC-123', url: 'https://auth.openai.com/codex/device' } })
    const final = card.finish({ phase: 'success', name: '工作', plan: 'plus' })
    expect(card.finish({ phase: 'error' })).toBe(final)
    await final
    await expect(card.update({ phase: 'waiting' })).rejects.toThrow('已结束')
    expect(calls.filter(c => c.operation === 'send')).toHaveLength(1)
    expect(calls.filter(c => c.operation === 'dispose')).toHaveLength(1)
    const frames = calls.filter(c => c.operation === 'replace')
    expect(JSON.stringify(frames[0])).toContain('ABC-123')
    expect(JSON.stringify(frames.at(-1))).not.toContain('ABC-123')
    expect(calls.filter(c => c.operation === 'settings').at(-1)?.value.config.streaming_mode).toBe(false)
  })
  test('failed writes are rejected and never marked disposed or successful', async () => {
    for (const failure of ['replace', 'settings'] as const) {
      const { calls, deps, control } = harness()
      const card = await CodexAccountCard.open('chat', { phase: 'connecting' }, deps)
      control[failure] = false
      await expect(card.finish({ phase: 'success' })).rejects.toThrow('更新失败')
      expect(calls.some(c => c.operation === 'dispose')).toBe(false)
    }
  })
  test('failed card creation starts no bookkeeping, and invalid final content can still render an error', async () => {
    const { deps, calls, control } = harness()
    control.send = false
    await expect(CodexAccountCard.open('chat', { phase: 'connecting' }, deps)).rejects.toThrow('发送失败')
    expect(calls.some(c => c.operation === 'register')).toBe(false)
    control.send = true
    const card = await CodexAccountCard.open('chat', { phase: 'checking' }, deps)
    expect(() => card.finish({ phase: 'waiting', verification: { code: 'BAD CODE', url: 'https://example.test' } })).toThrow()
    await card.finish({ phase: 'error', message: '验证码格式无效' })
    expect(calls.some(c => c.operation === 'dispose')).toBe(true)
  })
})
