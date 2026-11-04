/**
 * Session-name suffix rules shared by the Feishu bridge and workspace
 * resolution.
 *
 * `*` marks a temporary (BTW/fork) session: Lodestar creates
 * `<project>*MMDD-HHMM` by default and `<project>*<role>` when the user passes
 * a note to `btw`. `*` is therefore reserved for this suffix; worktrees use a
 * `[...]` suffix instead.
 */
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
