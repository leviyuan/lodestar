// The path is trimmed after matching. Optional-padding groups around the lazy capture
// overlapped it, so an unterminated `[[send:` followed by blanks backtracked cubically
// and stalled the event loop on every streamed delta.
const SEND_MARKER_RE = /\[\[send:([^\n]*?)\]\]/g

export function extractSendMarkerPaths(text: string): string[] {
  const paths: string[] = []
  for (const m of text.matchAll(SEND_MARKER_RE)) {
    const path = m[1]?.trim()
    if (path) paths.push(path)
  }
  return paths
}

const MSYS_DRIVE_PREFIX_RE = /^\/([a-zA-Z])\//

/** Normalize an outbound file path so the daemon can actually read it.
 * On Windows, MSYS / Git Bash emit drive paths as `/c/Users/...`
 * (= `C:\Users\...`); Node's fs treats a leading `/` as "root of the
 * current drive" and stats `C:\c\Users\...` instead, so the upload
 * fails with ENOENT. Rewrite the MSYS drive prefix to a native
 * `C:\...` path. No-op on non-Windows (where `/c/...` is a legit
 * absolute path) and on anything that doesn't match the single-letter
 * drive prefix (`/home`, `/tmp`, `C:\...`, `C:/...`). `platform` is a
 * parameter so the Windows branch can be exercised from Linux tests. */
export function normalizeOutboundPath(p: string, platform: string = process.platform): string {
  if (platform !== 'win32') return p
  const m = MSYS_DRIVE_PREFIX_RE.exec(p)
  if (!m) return p
  return `${m[1].toUpperCase()}:\\` + p.slice(m[0].length).replace(/\//g, '\\')
}
