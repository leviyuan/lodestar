/**
 * Read config.toml — minimal hand-rolled parser sufficient for the
 * scalar-value-only schema we expect:
 *
 *   [feishu]
 *   app_id = "cli_..."
 *   app_secret = "..."
 *
 *   [runtime]
 *   projects_root = "~/"      # optional, defaults to $HOME
 *   live_elapsed = "bucket"   # optional: "bucket"(default) | "second"
 *
 *   [runtime.agent_auto_update] # opt in per Agent; never checks at boot
 *   codex = false
 *   claude = false
 *   dsh = false
 *
 *   [notify]                  # all optional
 *   bind = "127.0.0.1"        # default 127.0.0.1 (loopback only)
 *   port = 9876               # default 9876
 *
 * Loaded synchronously at import time; downstream modules read the
 * exported `config` object directly.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { CONFIG_FILE } from './paths'

/** 活跃 footer / 后台卡 header 耗时展示模式(config `[runtime].live_elapsed`)。 */
export type LiveElapsedMode = 'bucket' | 'second'

export interface LodestarConfig {
  feishu: {
    app_id: string
    app_secret: string
  }
  runtime: {
    projects_root: string
    /** Opt-in periodic Agent updates. Startup never checks or installs versions. */
    agent_auto_update: Record<'codex' | 'claude' | 'dsh', boolean>
    /**
     * 活跃 footer / 后台卡 header 的耗时展示。
     * - `bucket`(默认):粗档位,只在档位边界 push,省飞书配额
     * - `second`:按时长选择单位,每秒刷新；长时间运行后降低刷新频率
     */
    live_elapsed: LiveElapsedMode
  }
  notify: {
    bind: string
    port: number
  }
  /** Env vars injected into the spawned `codex app-server` subprocess.
   * Empty record = no injection; Codex uses the user's ChatGPT login. */
  codex: {
    env: Record<string, string>
  }
  /** Env vars injected into the Claude Code subprocess used by
   * `@anthropic-ai/claude-agent-sdk`. Empty record = inherit the user's
   * local Claude Code configuration. */
  claude: {
    /** 显式指定 SDK spawn 的 Claude Code 可执行文件或参数透传包装器。
     * 未设置时使用 SDK 默认入口。 */
    bin?: string
    env: Record<string, string>
    models: Record<string, ClaudeModelConfig>
  }
  /** Per-project launch profiles keyed by session name (= group name).
   * Empty record ⇒ every project runs with Lodestar defaults. */
  projects: Record<string, ProjectProfile>
  /** [token_source.<id>] 账号配置；群内启用和补录会更新对应节。 */
  token_sources: Record<string, TokenSourceConfig>
}

export interface ClaudeModelConfig {
  model?: string
}

/** Token source 配置(一个账号)。parseToml 只支持标量,故 models/slots 用复合字符串。
 *  agent       — 'codex' | 'claude' | 'dsh'(协议强制)
 *  auth        — 'chatgpt-login'(codex 订阅)
 *  base_url + auth_token / api_key — claude 第三方(GLM/DeepSeek/中转)
 *  bin         — Claude 包装器，或 DeepSeek Harness 使用的 Node 可执行文件
 *  model       — 默认模型 slug(codex 下发 gpt-5.6-sol;claude 真实模型走 slots)
 *  effort      — 默认 effort
 *  models      — OpenRouter/Packy 显式可选列表；GLM/DeepSeek 经验证的补录模型
 *  hidden_models — 非 OpenRouter 来源从接口目录中隐藏的模型(逗号分隔)
 *  custom_models — 所有来源的列表外补录记录(逗号分隔，不代表已验证可运行)
 *  slots       — claude 槽位映射 'opus=X,sonnet=Y,haiku=Z'
 *  usage       — 额度查询策略 'codex-rate-limit' | 'glm-coding-plan' | 'none' */
export interface TokenSourceConfig {
  agent?: string
  /** Claude Code 订阅的 Lodestar 开关；省略时保持自动识别本机登录。 */
  enabled?: boolean
  display?: string
  auth?: string
  base_url?: string
  auth_token?: string
  api_key?: string
  /** 独立的账户余额凭据，绝不传入模型进程。 */
  management_token?: string
  management_user_id?: string
  management_url?: string
  /** 只复用指定来源的余额账号，不复用它的模型 Key。 */
  billing_source?: string
  bin?: string
  model?: string
  effort?: string
  models?: string
  hidden_models?: string
  custom_models?: string
  slots?: string
  usage?: string
  default?: boolean
}

/** [projects.<name>] 主会话启动配置。cwd 用于两个后端，其余字段用于 Claude。
 * Token Source 指定的 settingSources 优先于项目配置。 */
export interface ProjectProfile {
  /** Absolute working directory. Falls back to `PROJECTS_ROOT/<name>`. */
  cwd?: string
  /** Comma-separated setting sources, e.g. `"project"` or `"user,project"`. */
  settingSources?: string
  /** Only use MCP servers loaded via `loadProjectMcp`; ignore user/global MCP. */
  strictMcp?: boolean
  /** Comma-separated built-in tool allow-list, e.g. `"Read,Write,Edit,Bash,Glob,Grep"`. */
  tools?: string
  /** Read `<cwd>/.mcp.json` and pass its servers to the SDK. Default true
   * (parity with bare `claude`, which discovers project .mcp.json). */
  loadProjectMcp?: boolean
}

function expandTilde(v: string): string {
  return v.replace(/^~(?=\/|$)/, homedir())
}

function parseToml(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = { _: {} }
  let section = '_'
  for (const raw of text.split('\n')) {
    const line = stripTomlComment(raw).trim()
    if (!line) continue
    const sec = line.match(/^\[([^\]]+)\]$/)
    if (sec) {
      section = sec[1].trim()
      out[section] ??= {}
      continue
    }
    const kv = line.match(/^([\w.-]+)\s*=\s*(.+)$/)
    if (kv) {
      let v = kv[2].trim()
      const dq = v.startsWith('"') && v.endsWith('"')
      const sq = v.startsWith("'") && v.endsWith("'")
      if (dq || sq) {
        v = v.slice(1, -1)
        // TOML basic strings (double-quoted) get \\, \" unescaped;
        // single-quoted literal strings stay raw per TOML spec.
        // Mirror escapeTomlString() in src/setup.ts.
        if (dq) v = v.replace(/\\([\\"])/g, '$1')
      }
      out[section][kv[1]] = v
    }
  }
  return out
}

/** Remove a TOML comment marker only when it appears outside quoted strings.
 * App secrets, tokens and URLs may legitimately contain `#`; the old regex
 * truncated those values before credential validation. */
function stripTomlComment(raw: string): string {
  let quote: 'single' | 'double' | null = null
  let escaped = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote === 'double') {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') quote = null
      continue
    }
    if (quote === 'single') {
      if (ch === "'") quote = null
      continue
    }
    if (ch === '"') quote = 'double'
    else if (ch === "'") quote = 'single'
    else if (ch === '#') return raw.slice(0, i)
  }
  return raw
}

export function loadConfig(): LodestarConfig {
  let raw: string
  try {
    raw = readFileSync(CONFIG_FILE, 'utf8')
  } catch (e) {
    process.stderr.write(
      `lodestar: cannot read config at ${CONFIG_FILE}\n` +
      `  → 运行 \`lodestar-setup\` 走交互式向导生成 (Feishu / Codex / 工作目录)\n` +
      `  → 或手写: 设 LODESTAR_CONFIG=/path/to/config.toml 覆盖默认路径\n` +
      `    [feishu]\n    app_id = "cli_xxx"\n    app_secret = "xxx"\n\n`,
    )
    throw e
  }
  const t = parseToml(raw)
  const appId = t.feishu?.app_id
  const appSecret = t.feishu?.app_secret
  if (!appId || !appSecret) {
    throw new Error(`lodestar: ${CONFIG_FILE} is missing [feishu].app_id / [feishu].app_secret`)
  }
  const projectsRoot = expandTilde(t.runtime?.projects_root ?? homedir())
  const agentAutoUpdate: LodestarConfig['runtime']['agent_auto_update'] = { codex: false, claude: false, dsh: false }
  const agentAutoUpdateSection = t['runtime.agent_auto_update']
  const legacyAgentAutoUpdate = t.runtime?.agent_auto_update
  if (legacyAgentAutoUpdate !== undefined) {
    if (agentAutoUpdateSection) {
      throw new Error('lodestar: legacy [runtime].agent_auto_update cannot be combined with [runtime.agent_auto_update]')
    }
    if (legacyAgentAutoUpdate !== 'true' && legacyAgentAutoUpdate !== 'false') {
      throw new Error(`lodestar: [runtime].agent_auto_update must be true or false, got "${legacyAgentAutoUpdate}"`)
    }
    // Migrate the previous boolean without changing an explicit update choice.
    for (const agent of ['codex', 'claude', 'dsh'] as const) agentAutoUpdate[agent] = legacyAgentAutoUpdate === 'true'
    process.stderr.write('lodestar: 旧 agent_auto_update 总开关已按原值映射为三个开关；请改用 [runtime.agent_auto_update] 的 codex、claude、dsh 配置。\n')
  } else if (agentAutoUpdateSection) {
    for (const [agent, value] of Object.entries(agentAutoUpdateSection)) {
      if (agent !== 'codex' && agent !== 'claude' && agent !== 'dsh') {
        throw new Error(`lodestar: unknown [runtime.agent_auto_update] Agent "${agent}"`)
      }
      if (value !== 'true' && value !== 'false') {
        throw new Error(`lodestar: [runtime.agent_auto_update].${agent} must be true or false, got "${value}"`)
      }
      agentAutoUpdate[agent] = value === 'true'
    }
  }
  const liveElapsedRaw = (t.runtime?.live_elapsed ?? 'bucket').trim().toLowerCase()
  if (liveElapsedRaw !== 'bucket' && liveElapsedRaw !== 'second') {
    throw new Error(
      `lodestar: [runtime].live_elapsed must be "bucket" or "second", got "${t.runtime?.live_elapsed}"`,
    )
  }
  const liveElapsed: LiveElapsedMode = liveElapsedRaw
  const notifyBind = t.notify?.bind ?? '127.0.0.1'
  const notifyPortRaw = t.notify?.port ?? '9876'
  if (!/^\d+$/.test(notifyPortRaw.trim())) {
    throw new Error(`lodestar: [notify].port must be an integer, got "${notifyPortRaw}"`)
  }
  const notifyPort = Number.parseInt(notifyPortRaw, 10)
  if (!Number.isFinite(notifyPort) || notifyPort <= 0 || notifyPort > 65535) {
    throw new Error(`lodestar: [notify].port must be 1..65535, got "${notifyPortRaw}"`)
  }
  const envSection = (name: string): Record<string, string> => {
    const section = t[name] ?? {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(section)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v
    }
    return out
  }
  const claudeModelSections = (): Record<string, ClaudeModelConfig> => {
    const out: Record<string, ClaudeModelConfig> = {}
    for (const [sectionName, section] of Object.entries(t)) {
      const prefix = 'claude.models.'
      if (!sectionName.startsWith(prefix)) continue
      const key = sectionName.slice(prefix.length).trim()
      if (!key) continue
      const profile: ClaudeModelConfig = {}
      for (const [rawKey, value] of Object.entries(section)) {
        if (typeof value !== 'string' || value.length === 0) continue
        const field = rawKey.trim()
        if (field === 'model') profile.model = value
      }
      out[key] = profile
    }
    return out
  }
  const projectSections = (): Record<string, ProjectProfile> => {
    const out: Record<string, ProjectProfile> = {}
    const prefix = 'projects.'
    for (const [sectionName, section] of Object.entries(t)) {
      if (!sectionName.startsWith(prefix)) continue
      const name = sectionName.slice(prefix.length).trim()
      if (!name) continue
      const profile: ProjectProfile = {}
      for (const [rawKey, value] of Object.entries(section)) {
        if (typeof value !== 'string' || value.length === 0) continue
        switch (rawKey.trim()) {
          case 'cwd': profile.cwd = value; break
          case 'setting_sources': profile.settingSources = value; break
          case 'strict_mcp': profile.strictMcp = value === 'true'; break
          case 'tools': profile.tools = value; break
          case 'load_project_mcp': profile.loadProjectMcp = value === 'true'; break
        }
      }
      out[name] = profile
    }
    return out
  }
  // [token_source.<id>] 节 —— 每节一个账号(凭据 + 模型 + 额度查询)。
  const tokenSourceSections = (): Record<string, TokenSourceConfig> => {
    const out: Record<string, TokenSourceConfig> = {}
    const prefix = 'token_source.'
    for (const [sectionName, section] of Object.entries(t)) {
      if (!sectionName.startsWith(prefix)) continue
      const id = sectionName.slice(prefix.length).trim()
      if (!id) continue
      const cfg: TokenSourceConfig = {}
      for (const [rawKey, value] of Object.entries(section)) {
        if (typeof value !== 'string') continue
        const field = rawKey.trim()
        if (field === 'enabled') {
          if (value !== 'true' && value !== 'false') throw new Error(`[${sectionName}].enabled 必须为 true 或 false`)
          cfg.enabled = value === 'true'
        } else if (field === 'default') {
          cfg.default = value === 'true'
        } else if (
          field === 'agent' || field === 'display' || field === 'auth' ||
          field === 'base_url' || field === 'auth_token' || field === 'api_key' ||
          field === 'management_token' || field === 'management_user_id' || field === 'management_url' || field === 'billing_source' ||
          field === 'bin' || field === 'model' || field === 'effort' ||
          field === 'models' || field === 'hidden_models' || field === 'custom_models' || field === 'slots' || field === 'usage'
        ) {
          ;(cfg as Record<string, string>)[field] = value
        }
      }
      out[id] = cfg
    }
    return out
  }
  // [codex.env] / [claude.env] 节可选 —— 空 record 就维持各 CLI 自己的登录态。
  const codexEnv = envSection('codex.env')
  const claudeEnv = envSection('claude.env')
  const claudeBin = t.claude?.bin ? expandTilde(t.claude.bin) : undefined
  return {
    feishu: { app_id: appId, app_secret: appSecret },
    runtime: { projects_root: projectsRoot, live_elapsed: liveElapsed, agent_auto_update: agentAutoUpdate },
    notify: { bind: notifyBind, port: notifyPort },
    codex: { env: codexEnv },
    claude: { bin: claudeBin, env: claudeEnv, models: claudeModelSections() },
    projects: projectSections(),
    token_sources: tokenSourceSections(),
  }
}

export const config = loadConfig()

/** 账号配置写入后仅重载 token_sources，由调用方重建目录。 */
export function reloadTokenSources(): void {
  config.token_sources = loadConfig().token_sources
}
