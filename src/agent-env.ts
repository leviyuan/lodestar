/**
 * Host environment scrubbing for backend Agent subprocesses.
 *
 * Both Codex and Claude derive their spawn environment from the daemon's
 * `process.env`; DSH does the same before its own deletions. The daemon
 * environment can contain Lodestar-internal paths (`LODESTAR_CONFIG`,
 * `LODESTAR_DATA_DIR`), the restart-continuation conversation id
 * (`LODESTAR_RESTART_CONTINUE_CHAT_ID`) and the Feishu app credentials when
 * the service is configured through the environment. None of that belongs in
 * an Agent process: the channel only needs its own delegation protocol.
 *
 * Keep the allowlist narrow and explicit. Source-specific routing variables
 * (`LODESTAR_DSH_*`, `LODESTAR_RELAY_*`) and the Agent protocol
 * (`LODESTAR_AGENT_*`) are the only `LODESTAR_*` values an Agent may see.
 */

/** Exact keys that identify the host process or its private state. */
const DROPPED_EXACT = new Set([
  'LODESTAR_CONFIG',
  'LODESTAR_CONFIG_DIR',
  'LODESTAR_DATA_DIR',
  'LODESTAR_ATTACHMENT_DIR',
  'LODESTAR_RESTART_CONTINUE_CHAT_ID',
  'LODESTAR_DISABLE_SKILL_SYNC',
  'LODESTAR_TEST_AGENT_RUNTIME_ROOT',
  // Removed from the protocol entirely; drop it defensively in case an older
  // producer or a wrapper still sets it.
  'LODESTAR_AGENT_SESSION',
  // A DSH delegation context present in the host (a daemon started from a
  // managed DSH shell) belongs to that earlier task. `dsh-runtime.ts` derives
  // the context of each DSH launch from its own LODESTAR_AGENT_URL/CAPABILITY
  // after scrubbing, so the ShellEnv chain to native descendants is unaffected.
  'DSH_LODESTAR_AGENT_CONTEXT',
])

/** Prefixes that are part of the Agent protocol or the selected token source. */
const KEPT_PREFIXES = ['LODESTAR_AGENT_', 'LODESTAR_DSH_', 'LODESTAR_RELAY_']

/** The name a rule compares: Windows environment names are case-insensitive, so
 * `feishu_app_secret` there is the same variable as `FEISHU_APP_SECRET`. Other
 * platforms keep exact names. */
export function envRuleName(key: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? key.toUpperCase() : key
}

export function scrubAgentHostEnv(
  env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env }
  for (const key of Object.keys(out)) {
    const name = envRuleName(key, platform)
    if (name.startsWith('FEISHU_') || DROPPED_EXACT.has(name)) {
      delete out[key]
      continue
    }
    if (!name.startsWith('LODESTAR_')) continue
    if (KEPT_PREFIXES.some(prefix => name.startsWith(prefix))) continue
    delete out[key]
  }
  return out
}
