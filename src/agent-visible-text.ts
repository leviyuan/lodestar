/**
 * Agent 可见文本的统一脱敏：`/agents` 诊断与本机 `/notify` 的错误响应都可能被任意本机进程
 * （包括后端 Agent）读取，邮箱、IM ID 与绝对路径一律替换为占位符。纯函数，不引入其他模块。
 */

const AGENT_VISIBLE_LIMIT = 300

/**
 * Absolute path starts: POSIX `/…`, `file://…`, Windows `C:\…` / `C:/…`, UNC
 * `\\server\…` / `//server/…` and `~/…`.
 *
 * A generic `/` must begin at a boundary: right after a letter or digit of any
 * script (`openai/gpt-5`, `a/b`, `1/2`, `作者/模型`) or after `</:` it is not
 * one, so `https://host/path` and `</font>` stay intact. An API path fragment at
 * a boundary (`（/v1/models …`) cannot be told apart from a host path and is
 * redacted too. Chinese text often has no space before a path, so well-known
 * root directories and `~/` only exclude ASCII words, slashes and dots before
 * them (relative `src/data/x`, URL paths): `无法读取/Users/…`, `目录/tmp/…`,
 * `配置见~/.config/…` are paths.
 */
const KNOWN_ROOTS = 'Users|home|Volumes|private|var|tmp|opt|usr|etc|mnt|media|srv|root|Library|Applications|System|data|workspace|nix|run'
const NOT_A_BOUNDARY = String.raw`\p{L}\p{M}\p{N}_.\-\/\\`
const PATH_START = new RegExp([
  String.raw`\bfile:\/\/`,
  String.raw`(?<![A-Za-z0-9_.~%+\-\/\\])\/(?:${KNOWN_ROOTS})\/`,
  String.raw`(?<![${NOT_A_BOUNDARY}~%+<:])\/\/(?=[^\s\/"'\x60])`,
  String.raw`(?<![${NOT_A_BOUNDARY}~%+<])\/(?=[^\s\/"'\x60])`,
  String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\\/]`,
  String.raw`\\\\(?=[^\\\s"'\x60])`,
  String.raw`(?<![A-Za-z0-9_.\-\/\\])~[\\\/]`,
].join('|'), 'gu')

// Paths can contain spaces, brackets and colons, so a path ends only where
// what follows cannot be part of it. This is deliberately over-eager: a
// diagnostic may lose trailing text, but must not leave a piece of the path.
//   - A newline ends it; so does the closing quote of a quoted path
//     (`open '<path>' failed`). In an unquoted path a quote is a name
//     character (`Alice's Project`).
//   - A closing bracket/quote whose opener is inside the path is part of it
//     (`【工作】合同`). Otherwise it, an ASCII `(`/`[` and an ASCII colon followed
//     by whitespace end the path only when no `/` or `\` follows before the
//     hard end (`（<path>）：请检查 Key`, `<path>: permission denied`); POSIX
//     names may contain them (`Notes : 2024/plan.md`, `proj (copy)/a.ts`).
//   - CJK opening brackets and `：` never end it (`项目（测试）`, `项目：二期`).
const QUOTES = new Set(['"', "'", '`'])
const OPENER_OF: Record<string, string> = {
  ')': '(', ']': '[', '）': '（', '】': '【', '」': '「', '』': '『', '》': '《', '〉': '〈', '”': '“',
}
const OPENERS = new Set(Object.values(OPENER_OF))

function pathEnd(text: string, start: number, from: number): number {
  const quote = QUOTES.has(text[start - 1] ?? '') ? text[start - 1] : undefined
  let hard = text.length
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\n' || text[i] === quote) { hard = i; break }
  }
  let lastSeparator = -1
  for (let i = hard - 1; i >= from; i--) {
    if (text[i] === '/' || text[i] === '\\') { lastSeparator = i; break }
  }
  const depth = new Map<string, number>()
  for (let i = from; i < hard; i++) {
    const c = text[i]!
    const opener = OPENER_OF[c]
    const open = opener === undefined ? 0 : depth.get(opener) ?? 0
    if (open > 0) { depth.set(opener!, open - 1); continue }
    const candidate = opener !== undefined || c === '(' || c === '[' || (c === ':' && /\s/.test(text[i + 1] ?? ''))
    if (candidate && lastSeparator < i) return i
    if (OPENERS.has(c)) depth.set(c, (depth.get(c) ?? 0) + 1)
  }
  return hard
}

function redactPaths(text: string): string {
  let out = ''
  let copied = 0
  PATH_START.lastIndex = 0
  for (let match = PATH_START.exec(text); match; match = PATH_START.exec(text)) {
    const end = pathEnd(text, match.index, match.index + match[0].length)
    out += `${text.slice(copied, match.index)}<path>`
    copied = end
    PATH_START.lastIndex = end
  }
  return out + text.slice(copied)
}

/** Replace emails, IM identifiers and absolute host paths; no length limit. */
export function redactAgentVisible(value: string): string {
  return redactPaths(value
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(?:ou|on|oc|om|omt)_[0-9a-z]{12,}\b/g, '<id>'))
}

/** 飞书诊断（`formatFeishuError` 的 `code=… message=… log_id=…`）：message 里的路径占位会一直吞到
 * 分隔符，在 ` log_id=` 处切开分别脱敏，排障用的 log_id 不会被一起吞掉。 */
export function redactFeishuDiagnostic(value: string): string {
  const logId = value.lastIndexOf(' log_id=')
  return logId < 0 ? redactAgentVisible(value)
    : `${redactAgentVisible(value.slice(0, logId))}${redactAgentVisible(value.slice(logId))}`
}

/** Agent-facing diagnostics may quote upstream errors. Keep them useful but
 * never hand over emails, IM identifiers or absolute host paths. */
export function agentVisibleText(value: string): string {
  const redacted = redactAgentVisible(value)
  return redacted.length > AGENT_VISIBLE_LIMIT ? `${redacted.slice(0, AGENT_VISIBLE_LIMIT)}…` : redacted
}
