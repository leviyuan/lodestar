/** Code boundaries used only by the Claude translation layer. */
export interface TextRange { start: number; end: number }

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whole fenced-code blocks only; inline identifiers remain part of prose. */
export function findMarkdownFencedCodeRanges(text: string): TextRange[] {
  const fenced: TextRange[] = []
  const opener = /^(?: {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/gm
  let cursor = 0
  while (cursor < text.length) {
    opener.lastIndex = cursor
    const match = opener.exec(text)
    if (!match) break
    const marker = match[1]
    // Backtick fences cannot contain backticks in their info string. A line
    // such as ```value``` followed by prose is an inline span, not an opener.
    if (marker[0] === '`' && match[0].trimStart().slice(marker.length).includes('`')) {
      cursor = match.index + match[0].length
      continue
    }
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
  return fenced
}

/** Markdown fenced-code and inline-code ranges, preserving variable fence lengths. */
export function findMarkdownCodeRanges(text: string): TextRange[] {
  const fenced = findMarkdownFencedCodeRanges(text)
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
    let position = gap.start
    // Inline parsing stops at paragraph boundaries. Two unmatched backticks in
    // separate paragraphs must not turn all intervening prose into code.
    for (const paragraph of prose.split(/(\r?\n[ \t]*\r?\n)/)) {
      const offset = position
      position += paragraph.length
      const runs = [...paragraph.matchAll(/`+/g)]
      const nextByLength = new Map<number, number>()
      const closingRuns: Array<number | undefined> = []
      for (let index = runs.length - 1; index >= 0; index--) {
        const length = runs[index]![0].length
        closingRuns[index] = nextByLength.get(length)
        nextByLength.set(length, index)
      }
      for (let index = 0; index < runs.length; index++) {
        const closingIndex = closingRuns[index]
        if (closingIndex === undefined) continue
        const opening = runs[index]!, closing = runs[closingIndex]!
        ranges.push({
          start: offset + opening.index,
          end: offset + closing.index + closing[0].length,
        })
        index = closingIndex
      }
    }
  }
  return ranges.sort((a, b) => a.start - b.start)
}
