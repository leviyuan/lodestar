import type { ModelRefusalNotice } from '../agent-process'
import { escapeInlineMarkdown } from './account-usage'

/** `claude-opus-5-5` → `Opus 5.5`；带日期或 `[1m]` 后缀同样处理，认不出的模型 ID 原样返回。 */
export function claudeModelDisplayName(model: string | null | undefined): string {
  const id = model?.trim().replace(/^claude:/i, '').replace(/\[1m\]$/i, '')
  if (!id) return 'MISS'
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(id)
  if (!match) return id
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase()
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ''}`
}

/** 卡片标题与群列表预览共用的一句话（纯文本）。 */
export function modelRefusalNoticeTitle(notice: ModelRefusalNotice): string {
  if (notice.kind === 'no_fallback') return '⚠️ 安全拦截 · 本轮已终止'
  const fallback = claudeModelDisplayName(notice.fallbackModel)
  return notice.scope === 'session'
    ? `⚠️ 安全拦截 · 已降级为 ${fallback}`
    : `⚠️ 安全拦截 · 子 Agent 改用 ${fallback}`
}

interface Format {
  /** 上游给的文字（模型名、类别、说明）。 */
  value(text: string): string
  bold(text: string): string
  code(text: string): string
}

const MARKDOWN: Format = {
  value: escapeInlineMarkdown,
  bold: text => `**${text}**`,
  code: text => `\`${text}\``,
}
const PLAIN: Format = { value: text => text, bold: text => text, code: text => text }

function noticeLines(notice: ModelRefusalNotice, f: Format): string[] {
  const original = f.value(claudeModelDisplayName(notice.originalModel))
  const fallback = f.value(claudeModelDisplayName(notice.fallbackModel))
  const category = notice.category ? `（类别 ${f.value(notice.category)}）` : ''
  if (notice.kind === 'no_fallback') {
    return [
      f.bold(`${original} 的安全分类器拦下了本轮回复${category}，没有可用的降级模型，本轮没有完成。`),
      `拦截可能是误判：可以换个说法重发，或发 ${f.code('md')} 换模型。`,
    ]
  }
  if (notice.scope === 'local') {
    return [
      f.bold(`子 Agent 或旁支提问的一次回复被 ${original} 的安全分类器拦下${category}，这次回复改由 ${fallback} 完成。`),
      `会话模型不变，仍是 ${original}。`,
    ]
  }
  return [
    f.bold(`${original} 的安全分类器拦下了本轮回复${category}，Claude Code 已改由 ${fallback} 接着回答，不用重发。`),
    `之后每一轮都会继续用 ${fallback}，直到重新选择模型。`,
    `拦截可能是误判。要切回 ${original}：发 ${f.code('md')} 重新选择 ${original}（下一轮生效），或发 ${f.code('restart')}；再被拦截时还会收到这张提醒。`,
  ]
}

/** Claude 原生安全分类器拦截后单独发到群里的提醒卡；不进本轮对话卡，没有按钮。 */
export function modelRefusalNoticeCard(notice: ModelRefusalNotice): object {
  const elements: object[] = [{ tag: 'markdown', content: noticeLines(notice, MARKDOWN).join('\n') }]
  if (notice.explanation) {
    elements.push({
      tag: 'markdown',
      text_size: 'notation',
      content: `<font color='grey'>原生说明：${escapeInlineMarkdown(notice.explanation)}</font>`,
    })
  }
  const title = modelRefusalNoticeTitle(notice)
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title } },
    header: {
      title: { tag: 'plain_text', content: title },
      template: notice.kind === 'fallback' && notice.scope === 'local' ? 'yellow' : 'orange',
    },
    body: { elements },
  }
}

/** 卡片发送失败时的纯文本兜底，文案与卡片相同。 */
export function modelRefusalNoticeText(notice: ModelRefusalNotice): string {
  return [
    modelRefusalNoticeTitle(notice),
    ...noticeLines(notice, PLAIN),
    ...(notice.explanation ? [`原生说明：${notice.explanation}`] : []),
  ].join('\n')
}
