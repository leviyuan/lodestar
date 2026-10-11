import { describe, expect, test } from 'bun:test'
import { channelInstructions, fileDeliveryAgentContext, fileDeliveryInstructions } from './instructions'

describe('host instruction languages', () => {
  test('keeps Chinese as the default for existing callers', () => {
    expect(channelInstructions('claude', 'chat')).toBe(channelInstructions('claude', 'chat', 'zh'))
    expect(fileDeliveryInstructions('drive')).toBe(fileDeliveryInstructions('drive', 'zh'))
    expect(fileDeliveryAgentContext('chat')).toBe(fileDeliveryAgentContext('chat', 'zh'))
    expect(channelInstructions('claude', 'chat')).toContain('# desc: <一句中文说明>')
  })

  test('English instructions retain the host identity, file protocol, and native questions', () => {
    const instructions = channelInstructions('claude', 'chat', 'en')
    expect(instructions).not.toMatch(/\p{Script=Han}/u)
    expect(instructions).toContain('Lodestar handles uploads, permissions, and cards')
    expect(instructions).toContain('`[file: /abs/path]`')
    expect(instructions).toContain('`[[send: /abs/path]]`')
    expect(instructions).toContain('`files`, `files on`, and `files off`')
    expect(instructions).toContain('AskUserQuestion')
    expect(instructions).toContain('# desc: <brief description>')
    expect(instructions).toContain('it does not prove that the upload succeeded')
    expect(instructions).toContain('must not call these Feishu APIs directly')
  })

  test('the attachment limit applies only to chat in both languages and live updates', () => {
    for (const language of ['zh', 'en'] as const) {
      for (const render of [fileDeliveryInstructions, fileDeliveryAgentContext]) {
        expect(render('chat', language)).toContain('30 MB')
        expect(render('drive', language)).not.toContain('30 MB')
      }
      expect(channelInstructions('claude', 'chat', language)).toContain('30 MB')
      expect(channelInstructions('claude', 'drive', language)).not.toContain('30 MB')
    }
    const update = fileDeliveryAgentContext('drive', 'en')
    expect(update).not.toMatch(/\p{Script=Han}/u)
    expect(update).toContain('[Lodestar File delivery instructions update]')
    expect(update).toContain('fully replace the previous file delivery instructions')
    expect(update).toContain('`[[send: /abs/path]]`')
  })

  test('English instructions preserve each provider question tool', () => {
    expect(channelInstructions('codex', 'drive', 'en')).toContain('request_user_input')
    expect(channelInstructions('dsh', 'drive', 'en')).toContain('ask_user_question')
  })
})
