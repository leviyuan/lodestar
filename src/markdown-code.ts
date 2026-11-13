export interface TextRange { start: number; end: number }

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Markdown fenced-code and inline-code ranges, preserving variable fence lengths. */
export function findMarkdownCodeRanges(text: string): TextRange[] {
  const fenced: TextRange[] = []
  const opener = /^(?: {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/gm
  let cursor = 0
  while (cursor < text.length) {
    opener.lastIndex = cursor
    const match = opener.exec(text)
    if (!match) break
    const marker = match[1]
    const close = new RegExp(
      `^(?: {0,3})${regexEscape(marker[0])}{${marker.length},}[ \\t]*(?:\\n|$)`,
      'gm',
    )
    close.lastIndex = match.index + match[0].length
    const closing = close.exec(text)
    const end = closing ? closing.index + closing[0].length : text.length
    fenced.push({ start: match.index, end })
    cursor = end
  }

  const ranges = [...fenced]
  const gaps: TextRange[] = []
  let last = 0
  for (const range of fenced) {
    if (last < range.start) gaps.push({ start: last, end: range.start })
    last = range.end
  }
  if (last < text.length) gaps.push({ start: last, end: text.length })

  for (const gap of gaps) {
    const prose = text.slice(gap.start, gap.end)
    const inline = /(`+)[^\n]*?\1/g
    let match: RegExpExecArray | null
    while ((match = inline.exec(prose)) !== null) {
      ranges.push({
        start: gap.start + match.index,
        end: gap.start + match.index + match[0].length,
      })
    }
  }
  return ranges.sort((a, b) => a.start - b.start)
}

export function transformMarkdownProse(text: string, transform: (prose: string) => string): string {
  if (!text) return text
  const ranges = findMarkdownCodeRanges(text)
  if (!ranges.length) return transform(text)
  let out = ''
  let last = 0
  for (const range of ranges) {
    if (range.start > last) out += transform(text.slice(last, range.start))
    out += text.slice(range.start, range.end)
    last = Math.max(last, range.end)
  }
  if (last < text.length) out += transform(text.slice(last))
  return out
}

/** Wrap literal text in a fence longer than any backtick run inside it, so the text can
 * never close the block early and continue as live card markup. */
export function fencedCodeBlock(text: string, lang = ''): string {
  let fence = '```'
  while (text.includes(fence)) fence += '`'
  return `${fence}${lang}\n${text}\n${fence}`
}

/** Close a fenced block that `text` leaves open, as happens when Markdown is cut at a
 * character limit. Otherwise everything appended after it renders as part of the code. */
export function closeOpenMarkdownFence(text: string): string {
  // As in CommonMark, a backtick fence's info string holds no backtick: "```js``` text"
  // is inline code, and closing it as a fence would open a block instead.
  const opener = /^(?: {0,3})(?:(`{3,})[^`\n]*|(~{3,})[^\n]*)(?:\n|$)/gm
  let cursor = 0
  while (cursor < text.length) {
    opener.lastIndex = cursor
    const match = opener.exec(text)
    if (!match) break
    const marker = (match[1] ?? match[2])!
    const close = new RegExp(
      `^(?: {0,3})${regexEscape(marker[0]!)}{${marker.length},}[ \\t]*(?:\\n|$)`,
      'gm',
    )
    close.lastIndex = match.index + match[0].length
    const closing = close.exec(text)
    if (!closing) return `${text}${text.endsWith('\n') ? '' : '\n'}${marker}`
    cursor = closing.index + closing[0].length
  }
  return text
}

/** `text.slice(0, max)` that never ends between the two halves of a surrogate pair. */
export function sliceWholeCharacters(text: string, max: number): string {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}
