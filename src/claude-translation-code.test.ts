import { describe, expect, test } from 'bun:test'
import { findMarkdownCodeRanges, findMarkdownFencedCodeRanges } from './claude-translation-code'
import { findMarkdownCodeRanges as findSharedCodeRanges } from './markdown-code'

describe('Claude translation code boundaries', () => {
  test('translation parsing does not change shared card or formula code boundaries', () => {
    const inline = '```$$literal$$``` $$x+y$$'
    expect(findSharedCodeRanges(inline).map(range => inline.slice(range.start, range.end))).toEqual([inline])
    expect(findMarkdownCodeRanges(inline).map(range => inline.slice(range.start, range.end))).toEqual(['```$$literal$$```'])
    const multiline = 'Use `line1\n$x+y$` now.'
    expect(findSharedCodeRanges(multiline)).toEqual([])
    expect(findMarkdownCodeRanges(multiline).map(range => multiline.slice(range.start, range.end))).toEqual(['`line1\n$x+y$`'])
  })

  test('fenced-only extraction retains inline identifiers and exact nested block bytes', () => {
    const nested = '````md\n```ts\nconst 原值 = 1\n```\n仍是代码\n````\n'
    const tilde = '  ~~~json\n{"原值": true}\n  ~~~\n'
    const text = `检查 \`charge\` 与 src/配置.ts。\n${nested}继续检查。\n${tilde}完成。`
    const fenced = findMarkdownFencedCodeRanges(text)
    expect(fenced.map(range => text.slice(range.start, range.end))).toEqual([nested, tilde])
    expect(findMarkdownCodeRanges(text).map(range => text.slice(range.start, range.end)))
      .toEqual(['`charge`', nested, tilde])
  })

  test('line-start inline spans are not fences and unclosed fences extend to the end', () => {
    const text = '```变量``` 后文需要翻译。\n\n```ts\nPRIVATE_FILE_CONTENT'
    expect(findMarkdownFencedCodeRanges(text).map(range => text.slice(range.start, range.end)))
      .toEqual(['```ts\nPRIVATE_FILE_CONTENT'])
    expect(findMarkdownCodeRanges(text).map(range => text.slice(range.start, range.end)))
      .toEqual(['```变量```', '```ts\nPRIVATE_FILE_CONTENT'])
  })

  test('inline-only paragraphs do not become fenced code or affect later calls', () => {
    const text = 'Use ``charge `q` ``.\n\nA ` symbol\n\n另一个 ` 符号。'
    expect(findMarkdownFencedCodeRanges(text)).toEqual([])
    expect(findMarkdownCodeRanges(text).map(range => text.slice(range.start, range.end)))
      .toEqual(['``charge `q` ``'])
    expect(findMarkdownFencedCodeRanges('```ts\nx\n```')).toEqual([{ start: 0, end: 11 }])
    expect(findMarkdownFencedCodeRanges(text)).toEqual([])
  })
})
