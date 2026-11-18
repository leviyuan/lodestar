import { describe, expect, test } from 'bun:test'
import type { ModelRefusalNotice } from '../agent-process'
import {
  claudeModelDisplayName,
  modelRefusalNoticeCard,
  modelRefusalNoticeText,
  modelRefusalNoticeTitle,
} from './model-refusal'

const sessionFallback: ModelRefusalNotice = {
  kind: 'fallback', scope: 'session', originalModel: 'claude-opus-5-5', fallbackModel: 'claude-opus-4-8',
  category: 'cyber', explanation: 'Cyber safeguards flagged this message.',
}

function body(card: any): string {
  return card.body.elements.map((element: any) => element.content).join('\n')
}

describe('Claude model display names', () => {
  test.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-opus-4-8', 'Opus 4.8'],
    ['claude:claude-opus-5-5[1m]', 'Opus 5.5'],
    ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
    ['claude-opus-4-20250514', 'Opus 4'],
    ['claude-fable-5-2', 'Fable 5.2'],
    ['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20241022'],
    ['GLM-5.2', 'GLM-5.2'],
    [null, 'MISS'],
    ['  ', 'MISS'],
  ])('%p → %p', (model, label) => {
    expect(claudeModelDisplayName(model)).toBe(label)
  })
})

describe('model refusal notice card', () => {
  test('a session fallback says who answers now, that it sticks, and how to switch back', () => {
    const card = modelRefusalNoticeCard(sessionFallback) as any
    expect(card.header).toEqual({ title: { tag: 'plain_text', content: '⚠️ 安全拦截 · 已降级为 Opus 4.8' }, template: 'orange' })
    expect(card.config.summary.content).toBe('⚠️ 安全拦截 · 已降级为 Opus 4.8')
    const text = body(card)
    expect(text).toContain('**Opus 5.5 的安全分类器拦下了本轮回复（类别 cyber），Claude Code 已改由 Opus 4.8 接着回答，不用重发。**')
    expect(text).toContain('之后每一轮都会继续用 Opus 4.8，直到重新选择模型。')
    expect(text).toContain('发 `md` 重新选择 Opus 5.5（下一轮生效），或发 `restart`')
    expect(card.body.elements[1]).toEqual({ tag: 'markdown', text_size: 'notation',
      content: "<font color='grey'>原生说明：Cyber safeguards flagged this message.</font>" })
    // No buttons: the card is a reminder only.
    expect(JSON.stringify(card)).not.toContain('callback')
  })

  test('a local fallback keeps the session model and uses a lighter colour', () => {
    const card = modelRefusalNoticeCard({ ...sessionFallback, scope: 'local', explanation: null }) as any
    expect(card.header.title.content).toBe('⚠️ 安全拦截 · 子 Agent 改用 Opus 4.8')
    expect(card.header.template).toBe('yellow')
    expect(body(card)).toContain('会话模型不变，仍是 Opus 5.5。')
    expect(card.body.elements).toHaveLength(1)
  })

  test('a refusal without a fallback says the turn did not finish', () => {
    const notice: ModelRefusalNotice = { kind: 'no_fallback', scope: 'session', originalModel: 'claude-opus-5-5',
      fallbackModel: null, category: null, explanation: null }
    const card = modelRefusalNoticeCard(notice) as any
    expect(card.header.title.content).toBe('⚠️ 安全拦截 · 本轮已终止')
    expect(body(card)).toContain('**Opus 5.5 的安全分类器拦下了本轮回复，没有可用的降级模型，本轮没有完成。**')
    expect(body(card)).not.toContain('MISS')
  })

  test('upstream text is escaped in the markdown body but the plain-text title stays literal', () => {
    const notice: ModelRefusalNotice = { ...sessionFallback, fallbackModel: 'relay_model*x', category: 'a_b',
      explanation: 'see <tag> [x](y)' }
    const card = modelRefusalNoticeCard(notice) as any
    expect(modelRefusalNoticeTitle(notice)).toBe('⚠️ 安全拦截 · 已降级为 relay_model*x')
    expect(card.header.title.content).toBe('⚠️ 安全拦截 · 已降级为 relay_model*x')
    expect(body(card)).toContain('relay&#95;model&#42;x')
    expect(body(card)).toContain('类别 a&#95;b')
    expect(body(card)).toContain('see &#60;tag&#62; &#91;x&#93;(y)')
  })

  test('the text fallback carries the same wording without markdown', () => {
    expect(modelRefusalNoticeText(sessionFallback)).toBe([
      '⚠️ 安全拦截 · 已降级为 Opus 4.8',
      'Opus 5.5 的安全分类器拦下了本轮回复（类别 cyber），Claude Code 已改由 Opus 4.8 接着回答，不用重发。',
      '之后每一轮都会继续用 Opus 4.8，直到重新选择模型。',
      '拦截可能是误判。要切回 Opus 5.5：发 md 重新选择 Opus 5.5（下一轮生效），或发 restart；再被拦截时还会收到这张提醒。',
      '原生说明：Cyber safeguards flagged this message.',
    ].join('\n'))
  })
})
