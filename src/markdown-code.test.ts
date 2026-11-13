import { describe, expect, test } from 'bun:test'
import { closeOpenMarkdownFence, fencedCodeBlock, findMarkdownCodeRanges, sliceWholeCharacters } from './markdown-code'
import { boundedResultContent } from './cards/task-content'

/** Whether `needle` lies inside a code range of `content`, as the project's own parser sees it. */
function insideCode(content: string, needle: string): boolean {
  const at = content.indexOf(needle)
  expect(at).toBeGreaterThanOrEqual(0)
  return findMarkdownCodeRanges(content).some(range => range.start <= at && at < range.end)
}

describe('fencedCodeBlock', () => {
  test('uses a fence the content cannot close, so literal text never becomes markup', () => {
    const literal = '说明\n```json\n{"a":1}\n```\n<at id=all></at> 之后 **加粗**\n````\nx'
    const block = fencedCodeBlock(literal)
    expect(block.startsWith('`````\n')).toBe(true)
    expect(block.endsWith('\n`````')).toBe(true)
    expect(findMarkdownCodeRanges(block)).toEqual([{ start: 0, end: block.length }])
    expect(fencedCodeBlock('plain', 'ts')).toBe('```ts\nplain\n```')
  })
})

describe('closeOpenMarkdownFence', () => {
  test('closes only a fence the text leaves open, with the same marker', () => {
    expect(closeOpenMarkdownFence('text\n```ts\nconst x = 1')).toBe('text\n```ts\nconst x = 1\n```')
    expect(closeOpenMarkdownFence('text\n~~~~\ncode\n')).toBe('text\n~~~~\ncode\n~~~~')
    // A longer inner run does not close a shorter... nor a shorter one a longer fence.
    expect(closeOpenMarkdownFence('````\na\n```\nb')).toBe('````\na\n```\nb\n````')
    for (const balanced of ['plain text', '```\ncode\n```\nafter', 'a `inline` b', '```\na\n```\n\n~~~\nb\n~~~',
      // Backticks later on the line make it inline code, not an opening fence.
      '```js``` is inline\ntext', '```npm test```']) {
      expect(closeOpenMarkdownFence(balanced)).toBe(balanced)
    }
  })

  test('a result cut inside a code block keeps the notice and later sections outside it', () => {
    const output = '说明\n```ts\n' + 'const x = 1 // 填充\n'.repeat(600) + '```\n结论:完成'
    const bounded = boundedResultContent(output, 2000)
    const card = `${bounded}\n\n**最近动作**\n- ✓ done`
    expect(bounded.length).toBeLessThan(2100)
    expect(insideCode(card, '_结果超过卡片安全上限，已截断。_')).toBe(false)
    expect(insideCode(card, '**最近动作**')).toBe(false)
    // Short results and cuts outside a fence are unchanged in shape.
    expect(boundedResultContent('short')).toBe('short')
    expect(boundedResultContent('字'.repeat(3000), 2000)).toMatch(/^字+…\n\n_结果超过卡片安全上限，已截断。_$/)
  })
})

describe('sliceWholeCharacters', () => {
  test('never ends between the halves of a surrogate pair', () => {
    expect(sliceWholeCharacters('ab🚀cd', 3)).toBe('ab')
    expect(sliceWholeCharacters('ab🚀cd', 4)).toBe('ab🚀')
    expect(sliceWholeCharacters('abc', 10)).toBe('abc')
    expect(sliceWholeCharacters('中文内容', 2)).toBe('中文')
  })
})
