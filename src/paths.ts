/**
 * 配置和状态路径：Unix 遵循 XDG，Windows 使用 APPDATA/LOCALAPPDATA。
 * LODESTAR_CONFIG_DIR、LODESTAR_DATA_DIR 优先于 XDG 和平台默认目录；
 * LODESTAR_CONFIG 可单独指定配置文件。运行状态统一放在 DATA_DIR。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const IS_WIN = process.platform === 'win32'

function pickDir(envOverride: string | undefined, xdgVar: string | undefined, fallback: string): string {
  if (envOverride) return envOverride
  if (xdgVar) return join(xdgVar, 'lodestar')
  return fallback
}

/** Default config dir: %APPDATA%\Lodestar on Windows, XDG path on
 * unix. APPDATA is set on every modern Windows session; manual
 * fallback covers the edge case where it's been stripped. */
function defaultConfigDir(): string {
  if (IS_WIN) return join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'Lodestar')
  return join(HOME, '.config', 'lodestar')
}

/** Default data dir: %LOCALAPPDATA%\Lodestar on Windows (machine-
 * local, non-roaming; the standard place for app state/logs/cache),
 * XDG path on unix. */
function defaultDataDir(): string {
  if (IS_WIN) return join(process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'), 'Lodestar')
  return join(HOME, '.local', 'share', 'lodestar')
}

export const CONFIG_DIR = pickDir(
  process.env.LODESTAR_CONFIG_DIR,
  process.env.XDG_CONFIG_HOME,
  defaultConfigDir(),
)

export const DATA_DIR = pickDir(
  process.env.LODESTAR_DATA_DIR,
  process.env.XDG_DATA_HOME,
  defaultDataDir(),
)

export const CONFIG_FILE = process.env.LODESTAR_CONFIG ?? join(CONFIG_DIR, 'config.toml')
export const PID_FILE = join(DATA_DIR, 'daemon.pid')
/** Legacy 单文件日志(append-only)。启动时 `src/log.ts` 把它一次性迁移
 * 成按日文件 `daemon-YYYY-MM-DD.log`(按本地日期,保留近 7 天),之后
 * 新日志只写按日文件;本路径仅作迁移源存在。 */
export const LOG_FILE = join(DATA_DIR, 'daemon.log')
export const SESSION_CHAT_MAP_FILE = join(DATA_DIR, 'session-chat-map.json')
export const SESSION_RESUME_MAP_FILE = join(DATA_DIR, 'session-resume-map.json')
/** Per-session branch baseline + backend-native turn checkpoints + durable pending Claude fork。
 *  fk/bk 用它列"用户输入前的分界点"；rs 历史由各 backend 自己发现。
 *  key = sessionName(主群名或 <project>*MMDD-HHMM 临时群名)。 */
export const SESSION_TURNS_MAP_FILE = join(DATA_DIR, 'session-turns-map.json')
export const SESSION_MODEL_MAP_FILE = join(DATA_DIR, 'session-model-map.json')
/** Exact chats created by the temporary-session runtime; required before `bye` may delete. */
export const TEMP_SESSION_LEASES_FILE = join(DATA_DIR, 'temp-session-leases.json')
export const TASKLIST_MAP_FILE = join(DATA_DIR, 'tasklist-map.json')
/** Durable delegated-agent runs. Every state transition is written so completed
 * native sessions remain follow-up capable across daemon restarts. */
export const AGENT_RUNS_DIR = join(DATA_DIR, 'agent-runs')
/** Provider-native session ids created by delegated agents. Main-session
 * history pickers exclude these ids so background work never pollutes rs/fk. */
export const AGENT_SESSION_IDS_FILE = join(DATA_DIR, 'agent-session-ids.json')
/** Daemon-owned Claude Agent SDK plugin. It mirrors every managed Skill so
 * injected TokenSources can load them without enabling user settings/env. */
export const MANAGED_CLAUDE_PLUGIN_DIR = join(DATA_DIR, 'managed-claude-plugin')
/** Private Harness profiles, skills and native session persistence. */
export const DSH_HOME_DIR = join(DATA_DIR, 'dsh')
/** Named Codex credentials and per-group selections; the default account stays in native CODEX_HOME. */
export const CODEX_ACCOUNTS_DIR = join(DATA_DIR, 'codex-accounts')
export const CODEX_ACCOUNTS_FILE = join(DATA_DIR, 'codex-accounts.json')
export const CODEX_QUOTA_BLOCKS_FILE = join(DATA_DIR, 'codex-quota-blocks.json')
/** Automatically updated, immutable Agent runtime installations and status. */
export const AGENT_RUNTIMES_DIR = join(DATA_DIR, 'agent-runtimes')
/** 真实窗口观测缓存:key = `<sourceId>:<model>`(如 `glm:GLM-5.3`),value = 窗口
 *  token 数(200000 / 1000000)。来源 = 每轮真实 turn 的 SDK modelUsage.contextWindow
 *  (CLI 按 [1m] 后缀记 1M)。仅使用 SDK 明确上报的数值，错误文本不构成容量观测。 */
export const CONTEXT_WINDOW_CACHE_FILE = join(DATA_DIR, 'context-window-cache.json')
/** Persisted registrations for `/notify` cards that carry interactive
 * buttons. Each entry binds a `notify_id` → caller-supplied loopback
 * callback URL + the original card params (so a click can rebuild the
 * card into a resolved state). Survives daemon restarts so a card the
 * user taps hours later still routes. Pruned to 7 days on load. */
export const NOTIFY_CALLBACKS_FILE = join(DATA_DIR, 'notify-callbacks.json')
/** Marker file written at shutdown listing the session names that
 * were still alive. The next daemon boot reads it
 * to auto-revive those sessions via `restart(true)` — bridges the
 * gap between systemctl-restart killing every child Codex process and
 * Lodestar's "you have to send a message to re-spawn it" default.
 * The daemon also refreshes it on session lifecycle changes so rapid
 * repeated restarts do not lose the revive list. */
export const ALIVE_MARKER_FILE = join(DATA_DIR, 'alive-on-shutdown.json')
export const INBOX_DIR = join(DATA_DIR, 'inbox')
/** One private receipt per cloud-file delivery; remote files are managed in their Feishu folder. */
export const FILE_DELIVERIES_DIR = join(DATA_DIR, 'file-deliveries')
/** Per-chat opt-in and stable group Drive folder binding. Native chat attachments are the default. */
export const FILE_DELIVERY_GROUPS_FILE = join(DATA_DIR, 'file-delivery-groups.json')
/** Unix-socket endpoint the daemon listens on for debug message
 * injection (see scripts/test-inject.ts). A real Feishu user sends
 * a `[DEBUG]…` text once to seed `DEBUG_CTX_FILE` with chat_id +
 * sender_open_id; the injector then POSTs `{text}` here and the
 * daemon replays it through `handleMessage` as if WS had delivered
 * it. File mode 0600 — daemon-private, never network-exposed. */
export const DEBUG_SOCK_FILE = join(DATA_DIR, 'debug.sock')
export const DEBUG_CTX_FILE = join(DATA_DIR, 'debug-context.json')
