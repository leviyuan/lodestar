/**
 * Session-name suffix rules shared by the Feishu bridge and workspace
 * resolution.
 *
 * `*` marks a temporary (BTW/fork) session: Lodestar creates
 * `<project>*MMDD-HHMM` by default and `<project>*<role>` when the user passes
 * a note to `btw`. `*` is therefore reserved for this suffix; worktrees use a
 * `[...]` suffix instead.
 */
/** 飞书群名/会话名的统一上限，和 `sanitizeSessionName` 的截断保持一致。 */
export const SESSION_NAME_MAX = 64
const TEMP_SUFFIX_RE = /\*[^*]+$/
const WORKTREE_SUFFIX_RE = /^(.+)\[[^\[\]]+\]$/
/** Keeps `project*role` within the 64-character session-name cap for normal project names. */
const TEMP_ROLE_MAX = 32

/** Remove a `*<suffix>` temporary-session suffix when one is present. */
export function stripTempSuffix(name: string): string {
  return name.replace(TEMP_SUFFIX_RE, '')
}

/** Return the project name without its `*<suffix>`, or null for a non-temp session. */
export function tempProjectName(sessionName: string): string | null {
  return TEMP_SUFFIX_RE.test(sessionName) ? stripTempSuffix(sessionName) : null
}

/** Resolve the canonical main-session name for main, BTW, WT and BTW-from-WT sessions. */
export function mainSessionName(sessionName: string): string {
  const base = stripTempSuffix(sessionName)
  return base.match(WORKTREE_SUFFIX_RE)?.[1] ?? base
}

/**
 * Normalize a `btw` note so the Feishu group name survives
 * `sanitizeSessionName` unchanged. `*` and `[]` stay reserved for naming
 * suffixes; other unsupported characters (including whitespace) become `_`.
 * Returns an empty string when no usable name remains.
 */
export function normalizeTempRole(raw: string): string {
  return raw
    .trim()
    .replace(/[^\w一-鿿-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, TEMP_ROLE_MAX)
    .replace(/[_-]+$/, '')
}

/**
 * 备注临时群名：`<基名>*<备注>`，不做 `-2` 去重 —— 同一个备注就是同一个群，
 * 后到的成员加入既有群。基名可以是 `<项目>` 或 `<项目>[<分支>]`。
 * 备注超过群名上限时报错，避免创建出会被 `sanitizeSessionName` 截断的群名。
 */
export function tempRoleChatName(projectName: string, role: string): string {
  const suffix = normalizeTempRole(role)
  if (!suffix) throw new Error('temporary role requires at least one letter, digit or CJK character')
  const name = `${projectName}*${suffix}`
  if (name.length > SESSION_NAME_MAX) {
    const room = Math.max(SESSION_NAME_MAX - projectName.length - 1, 0)
    throw new Error(`备注太长：${projectName} 之后最多 ${room} 个字符，当前 ${suffix.length} 个`)
  }
  return name
}
