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
])

/** Prefixes that are part of the Agent protocol or the selected token source. */
const KEPT_PREFIXES = ['LODESTAR_AGENT_', 'LODESTAR_DSH_', 'LODESTAR_RELAY_']

export function scrubAgentHostEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env }
  for (const key of Object.keys(out)) {
    if (key.startsWith('FEISHU_')) {
      delete out[key]
      continue
    }
    if (!key.startsWith('LODESTAR_')) continue
    if (DROPPED_EXACT.has(key)) {
      delete out[key]
      continue
    }
    if (KEPT_PREFIXES.some(prefix => key.startsWith(prefix))) continue
    delete out[key]
  }
  return out
}
