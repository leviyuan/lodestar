import { networkFetch } from './network'
import { fetchGlmAnthropicModelIds, GLM_ANTHROPIC_BASE_URL } from './glm-models'
/**
 * lodestar-setup 交互向导；cli.ts 首次启动且配置缺失时也可调用。
 * 配置 Claude Code、可选 GLM API key 和 Codex、飞书应用及项目目录。
 * GLM key 写入本机 Claude settings，由 daemon 的 Token Source 检测并加载。
 */

import { execFileSync, spawn } from 'node:child_process'
import { spawn as spawnCommand } from 'cross-spawn'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { CONFIG_DIR, CONFIG_FILE } from './paths'
import { writeStateFileAtomic } from './state-store'
import { agentBin, updateAgentRuntime } from './agent-updates'
import feishuPermissions from '../docs/feishu-permissions.json'

const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  cyan:  '\x1b[36m',
  red:   '\x1b[31m',
}

const rl = createInterface({ input: process.stdin, output: process.stdout })

// ── prompts ────────────────────────────────────────────────────────
async function ask(prompt: string, opts: { required?: boolean; default?: string } = {}): Promise<string> {
  while (true) {
    const def = opts.default ? `${C.dim} [${opts.default}]${C.reset}` : ''
    const answer = (await rl.question(`${C.cyan}? ${C.reset}${prompt}${def}\n${C.green}>${C.reset} `)).trim()
    if (!answer && opts.default !== undefined) return opts.default
    if (!answer && opts.required) {
      console.log(`${C.red}必填,请重新输入${C.reset}`)
      continue
    }
    return answer
  }
}

function header(title: string): void {
  const line = '═'.repeat(58)
  console.log(`\n${C.bold}${C.cyan}╔${line}╗${C.reset}`)
  console.log(`${C.bold}${C.cyan}║  ${title.padEnd(54)}  ║${C.reset}`)
  console.log(`${C.bold}${C.cyan}╚${line}╝${C.reset}\n`)
}

function step(n: number, total: number, title: string): void {
  console.log(`\n${C.bold}${C.yellow}[${n}/${total}] ${title}${C.reset}\n`)
}

function escapeTomlString(s: string): string {
  // Mirrors the unescape in src/config.ts parseToml — \ → \\, " → \".
  // Windows paths (C:\Users\...) round-trip correctly through both.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ── Codex CLI (optional second backend) ────────────────────────────
function isCodexChatGPTLoggedIn(codexBin: string): boolean {
  try {
    const out = execFileSync(codexBin, ['login', 'status'], { timeout: 10_000, shell: process.platform === 'win32' }).toString()
    return /Logged in using ChatGPT/i.test(out)
  } catch { return false }
}

async function runCodexLogin(codexBin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawnCommand(codexBin, ['login'], {
      stdio: 'inherit',
      shell: false,
    })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

// ── Claude Code settings.json (GLM route) ──────────────────────────
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** 安装前校验模型目录；认证、网络和响应错误必须交给用户处理，不能保存后报成功。 */
async function fetchGlmSetupSlots(glmKey: string): Promise<Record<string, string>> {
  const ids = await fetchGlmAnthropicModelIds(GLM_ANTHROPIC_BASE_URL, glmKey)
  // 版本号排序(取 "GLM-5.2" 的 5.2;无版本的排最后)。Turbo/Air 变体不进 slots。
  const versionOf = (id: string): number => {
    const m = id.match(/(\d+(?:\.\d+)?)/)
    return m ? Number(m[1]) : -1
  }
  const plain = ids.filter(id => !/-Turbo|-Air/i.test(id))
  const sorted = [...plain].sort((a, b) => versionOf(b) - versionOf(a))
  const top = sorted[0]
  const bottom = sorted[sorted.length - 1]
  if (!top) throw new Error('GLM 模型目录中没有可用于 Claude Code slots 的模型')
  const out: Record<string, string> = {
    ANTHROPIC_DEFAULT_OPUS_MODEL: `${top}[1m]`,
    ANTHROPIC_DEFAULT_SONNET_MODEL: `${top}[1m]`,
  }
  if (bottom && bottom !== top) out.ANTHROPIC_DEFAULT_HAIKU_MODEL = bottom
  return out
}

/** 把 GLM Coding Plan 路由 merge 进 ~/.claude/settings.json 的 env 段。
 *  真相源与 docs/claude-agent-backend.md / glm-usage.ts 一致; 保留用户
 *  已有字段 (permissions / hooks / plugins …), 只覆盖 GLM 相关 env key。
 *  settings.json 存在但 JSON 解析失败时绝不静默覆盖 —— surface 出来。 */
export async function writeClaudeGlmEnv(glmKey: string): Promise<{ path: string } | { error: string }> {
  try {
    const dir = claudeConfigDir()
    mkdirSync(dir, { recursive: true })
    const settingsPath = join(dir, 'settings.json')

    let settings: Record<string, unknown> = {}
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, 'utf8')
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { error: `${settingsPath} 内容不是 JSON 对象, 拒绝覆盖, 请手动检查` }
        }
        settings = parsed as Record<string, unknown>
      } catch {
        return { error: `${settingsPath} 解析失败 (JSON 语法错), 拒绝覆盖, 请手动修复后重跑` }
      }
    }

    const prevEnv = (settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env))
      ? settings.env as Record<string, string>
      : {}
    // 先确认凭据可读取有效目录，再写入路由；失败保留已有配置。
    const slots = await fetchGlmSetupSlots(glmKey)
    // ANTHROPIC_AUTH_TOKEN 裸 token, 不带 Bearer。
    const glmEnv: Record<string, string> = {
      ANTHROPIC_AUTH_TOKEN: glmKey,
      ANTHROPIC_BASE_URL: GLM_ANTHROPIC_BASE_URL,
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }
    Object.assign(glmEnv, slots)
    settings.env = { ...prevEnv, ...glmEnv }

    writeStateFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    return { path: settingsPath }
  } catch (e: any) {
    return { error: e?.message ?? String(e) }
  }
}

// ── browser launcher (best-effort, never throws) ───────────────────
function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn(process.env.ComSpec ?? 'cmd.exe', ['/c', 'start', '""', url], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {
    // 终端环境 / 无浏览器, 静默, 用户照着控制台 URL 手动开就行
  }
}

// ── Feishu credential check ────────────────────────────────────────
async function testFeishuCreds(appId: string, appSecret: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await networkFetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json() as { code?: number; msg?: string; tenant_access_token?: string }
    if (data.tenant_access_token) return { ok: true }
    return { ok: false, error: `飞书拒绝: code=${data.code} msg=${data.msg ?? '(no msg)'}` }
  } catch (e: any) {
    return { ok: false, error: `网络错误: ${e?.message ?? String(e)}` }
  }
}

// ── daemon auto-start ──────────────────────────────────────────────
function spawnDaemonDetached(): { pid?: number; error?: string } {
  // 入口是 dist/lodestar-setup.js, daemon 是同目录的 dist/lodestar.js。
  // 用 process.execPath (= 当前 node) 跑那个 bundle, 避开 Windows .cmd
  // shim 的 spawn 引号坑 —— 这样 detached + stdio:'ignore' 行为在
  // 三个平台一致。
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const daemonBundle = join(here, 'lodestar.js')
    if (!existsSync(daemonBundle)) {
      return { error: `找不到 daemon bundle: ${daemonBundle}` }
    }
    const child = spawn(process.execPath, [daemonBundle], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return { pid: child.pid }
  } catch (e: any) {
    return { error: e?.message ?? String(e) }
  }
}

// ── main flow ──────────────────────────────────────────────────────
export async function runSetup(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(`${C.red}lodestar-setup: stdin 不是 TTY,无法交互式输入。${C.reset}`)
    console.error('请直接在 cmd / PowerShell / Terminal 里跑,不要 pipe 或重定向 stdin。')
    process.exit(1)
  }

  if (existsSync(CONFIG_FILE)) {
    console.log(`${C.yellow}发现已有配置: ${CONFIG_FILE}${C.reset}`)
    const overwrite = await ask('覆盖? (y/N)', { default: 'n' })
    if (overwrite.toLowerCase() !== 'y') {
      console.log('已取消')
      rl.close()
      return
    }
  }

  header('Lodestar 安装向导')
  console.log('Lodestar 把 Feishu (飞书) 群聊接到 AI agent。')
  console.log('默认后端是 Claude Code; Codex 是可选第二后端, 群里发 model 一键切换。')
  console.log('每个群对应一个项目目录, agent 在那里跑、能读写文件。')
  console.log()
  console.log('支持本机已登录的 Claude Code 订阅，也可配置 GLM Coding Plan 或 Anthropic API key。')
  console.log('Claude Code 订阅与第三方来源可在 model 面板中分别选择。')
  console.log()
  console.log('本向导依次做 4 件事:')
  console.log(`  ${C.dim}1) 确保 Claude Code CLI 已装好${C.reset}`)
  console.log(`  ${C.dim}2) GLM Coding Plan API key (推荐, 可选) + Codex (可选)${C.reset}`)
  console.log(`  ${C.dim}3) Feishu 自建应用 (含权限 / 事件 / 发版 + 凭据测试)${C.reset}`)
  console.log(`  ${C.dim}4) 工作目录, 自动启动 daemon${C.reset}`)
  console.log()
  await rl.question(`${C.dim}按 Enter 开始 (Ctrl+C 退出)...${C.reset}`)

  // ── Step 1/4 ──────────────────────────────────────────────────
  step(1, 4, '准备 Claude Code CLI')
  await updateAgentRuntime('claude', { report: message => console.log(message) })
  console.log(`${C.green}✓ Claude Code / SDK 已更新${C.reset}: ${C.dim}${agentBin('claude', 'claude')}${C.reset}`)
  console.log()
  console.log(`${C.dim}下一步可选配 GLM Coding Plan 自动写入路由; 不配则用本机 Claude Code 现有配置。${C.reset}`)
  console.log(`${C.dim}使用 Claude 订阅时，在本机运行 \`claude auth login\`；完成后在 model 面板选择 Claude Code 订阅。${C.reset}`)

  // ── Step 2/4 ──────────────────────────────────────────────────
  step(2, 4, 'GLM Coding Plan (推荐, 可选)')
  console.log('GLM Coding Plan 给 Claude Code 接 GLM 系列模型 (支持 1M token 上下文, 中文友好)。')
  console.log('订阅后在智谱开放平台拿一个 API key, 粘到下面 —— 向导自动写进 ~/.claude/settings.json。')
  console.log(`  ${C.dim}拿 key: https://open.bigmodel.cn → 控制台 → API Keys${C.reset}`)
  console.log(`  ${C.dim}此项可选，直接回车跳过；以后可在群内发送 glm-setup <api_key> 补配。${C.reset}`)
  console.log(`  ${C.dim}使用本机 Claude Code 或 Codex 订阅不需要 GLM Key。此处填写智谱国内站 Key；Z.ai 请之后用 glm-setup 指定对应地址。${C.reset}`)
  console.log()

  while (true) {
    const glmKey = await ask('GLM API key (直接回车跳过)', {})
    if (!glmKey) {
      console.log(`${C.dim}已跳过 GLM, 以本机 Claude Code 现有配置启动。${C.reset}`)
      break
    }
    const r = await writeClaudeGlmEnv(glmKey)
    if ('path' in r) {
      console.log(`${C.green}✓ GLM 路由已写入${C.reset}: ${C.dim}${r.path}${C.reset}`)
      console.log(`${C.dim}模型 slots 按端点当前列表自动选取(最新一代 opus/sonnet, 1M ctx)${C.reset}`)
      break
    } else {
      console.log(`${C.red}✗ GLM 配置失败:${C.reset} ${r.error}`)
      console.log(`${C.dim}请按错误提示处理后重新输入；直接回车可跳过，之后用群命令补配。${C.reset}`)
    }
  }

  // ── Codex (可选第二后端) ──────────────────────────────────────
  console.log()
  console.log(`${C.bold}Codex (可选第二后端)${C.reset}`)
  console.log(`  ${C.dim}想用 Codex 的话, 登录 ChatGPT 订阅即可, 模型/effort 走 ~/.codex/config.toml, 群里发 model 切换。${C.reset}`)
  const wantCodex = await ask('现在顺便配置 Codex 后端吗?', { default: 'n' })
  if (wantCodex.toLowerCase() === 'y') {
    await updateAgentRuntime('codex', { report: message => console.log(message) })
    const codexBin = agentBin('codex', 'codex')
    if (isCodexChatGPTLoggedIn(codexBin)) {
      console.log(`${C.green}✓ Codex 已登录 ChatGPT${C.reset}`)
    } else {
      console.log(`${C.dim}启动 \`codex login\`...${C.reset}`)
      const ok = await runCodexLogin(codexBin)
      if (ok && isCodexChatGPTLoggedIn(codexBin)) {
        console.log(`${C.green}✓ Codex 已登录 ChatGPT${C.reset}`)
      } else {
        console.log(`${C.yellow}Codex 登录未完成 — 不影响默认 Claude 后端; 需要时随时跑 codex login。${C.reset}`)
      }
    }
  } else {
    console.log(`${C.dim}已跳过 Codex (需要时随时跑 codex login, 群里发 model 切)。${C.reset}`)
  }

  // ── Step 3/4 ──────────────────────────────────────────────────
  step(3, 4, 'Feishu 自建应用')
  const feishuUrl = 'https://open.feishu.cn/app'
  console.log('打开飞书开放平台 (浏览器):')
  console.log(`  ${C.cyan}${feishuUrl}${C.reset}`)
  openBrowser(feishuUrl)
  console.log(`${C.dim}(如果浏览器没自动开, 复制上面 URL 粘到浏览器)${C.reset}`)
  console.log()
  console.log(`${C.bold}详细操作步骤:${C.reset}`)
  console.log()
  console.log(`  ${C.bold}① 创建应用${C.reset}`)
  console.log(`     点 "创建企业自建应用", 填名字 (如 ${C.dim}Lodestar${C.reset}), logo 随意。`)
  console.log()
  console.log(`  ${C.bold}② 添加机器人能力${C.reset}`)
  console.log(`     左侧菜单 "${C.cyan}添加应用能力${C.reset}" → 找到 "机器人" → 点 "${C.bold}添加${C.reset}" 按钮。`)
  console.log()
  console.log(`  ${C.bold}③ 申请权限 (左侧 "${C.cyan}权限管理${C.reset}" → "${C.bold}批量导入/导出权限${C.reset}")${C.reset}`)
  console.log(`     ${C.yellow}选择应用身份权限，复制下方完整 JSON 批量导入，一次开齐账号信息、消息、卡片和云空间能力。${C.reset}`)
  console.log(JSON.stringify(feishuPermissions, null, 2))
  console.log(`     ${C.dim}无需用户身份权限或飞书 CLI 登录。权限申请后须完成审批，并在步骤 ⑤ 发布飞书应用版本。${C.reset}`)
  console.log(`     ${C.dim}清单包含以下用途；也可按名称逐项开通:${C.reset}`)
  console.log(`     ${C.dim}账号与认证信息 (排障):${C.reset}`)
  console.log(`       • ${C.bold}verification:verification_information:readonly${C.reset} ${C.dim}# 查看账号主体认证状态${C.reset}`)
  console.log(`       • ${C.bold}tenant:tenant:readonly${C.reset}             ${C.dim}# 查看租户基本信息${C.reset}`)
  console.log(`     ${C.dim}消息类:${C.reset}`)
  console.log(`       • ${C.bold}im:message:send_as_bot${C.reset}            ${C.dim}# 以机器人身份发消息${C.reset}`)
  console.log(`       • ${C.bold}im:message${C.reset}                        ${C.dim}# 接收/操作消息 (核心)${C.reset}`)
  console.log(`       • ${C.bold}im:chat${C.reset}                           ${C.dim}# 读/写群信息 (匹配群名 ↔ 项目目录)${C.reset}`)
  console.log(`       • ${C.bold}im:chat:create${C.reset}                    ${C.dim}# wt: 自动创建 worktree 群${C.reset}`)
  console.log(`       • ${C.bold}im:chat:delete${C.reset}                    ${C.dim}# wt: 解散 worktree 群${C.reset}`)
  console.log(`       • ${C.bold}im:chat.members:read${C.reset}              ${C.dim}# wt: 判断发起人是否已在群内${C.reset}`)
  console.log(`       • ${C.bold}im:chat.members:write_only${C.reset}        ${C.dim}# wt: 把发起人拉进已有 worktree 群${C.reset}`)
  console.log(`       • ${C.bold}im:resource${C.reset}                       ${C.dim}# 上传/下载附件 (图文双向)${C.reset}`)
  console.log(`       • ${C.bold}im:message.urgent${C.reset}                 ${C.dim}# 加急推送 (锁屏通知 / Ask)${C.reset}`)
  console.log(`       • ${C.bold}im:message.group_msg${C.reset}              ${C.dim}# 敏感: 接收群里所有消息${C.reset}`)
  console.log(`         ${C.dim}└ 关键: 没它机器人只收 @ 自己的消息, 拿不到群里其他对话, 一定要开${C.reset}`)
  console.log(`         ${C.dim}└ 敏感权限要走审批: 申请时填用途, 个人开发者通常秒过${C.reset}`)
  console.log(`       • ${C.bold}im:message.group_at_msg:readonly${C.reset}  ${C.dim}# 读 @ 机器人消息 (兜底)${C.reset}`)
  console.log(`     ${C.dim}卡片类 (Card Kit):${C.reset}`)
  console.log(`       • ${C.bold}cardkit:card:read${C.reset}                 ${C.dim}# 读卡片状态${C.reset}`)
  console.log(`       • ${C.bold}cardkit:card:write${C.reset}                ${C.dim}# 创建/更新卡片 (流式渲染核心)${C.reset}`)
  console.log(`     ${C.dim}云空间交付 (权限预先开通，功能仍按群开启):${C.reset}`)
  console.log(`       • ${C.bold}drive:drive${C.reset}                       ${C.dim}# 上传、创建目录、协作者授权、关闭并核对文件链接分享${C.reset}`)
  console.log(`       • ${C.bold}drive:file:upload${C.reset}                 ${C.dim}# 文件夹改名接口单独要求此权限${C.reset}`)
  console.log(`     ${C.dim}默认仍直接发聊天附件；在指定群发送 files on 开启云空间，files off 恢复附件。${C.reset}`)
  console.log(`     ${C.yellow}只取得 tenant_access_token 不代表以上权限已生效；缺少权限时群内命令会明确报错。${C.reset}`)
  console.log()
  console.log(`  ${C.bold}④ 订阅事件 (左侧 "${C.cyan}事件与回调${C.reset}", 拆两个子页:)${C.reset}`)
  console.log(`     ${C.dim}a)${C.reset} ${C.bold}事件配置${C.reset} 页:`)
  console.log(`        ${C.yellow}• "订阅方式" → 选 "长连接" → 点保存${C.reset}`)
  console.log(`        • 添加事件: ${C.bold}im.message.receive_v1${C.reset}   ${C.dim}# 收群消息${C.reset}`)
  console.log(`     ${C.dim}b)${C.reset} ${C.bold}回调配置${C.reset} 页:`)
  console.log(`        ${C.yellow}• "订阅方式" → 选 "长连接" → 点保存${C.reset}`)
  console.log(`        • 添加事件: ${C.bold}card.action.trigger${C.reset}     ${C.dim}# 卡片按钮点击回调${C.reset}`)
  console.log()
  console.log(`  ${C.bold}⑤ 发布版本${C.reset}`)
  console.log(`     页面顶部 "${C.bold}创建版本${C.reset}" → 滚到底点 "${C.bold}保存${C.reset}" → 弹框点 "${C.bold}发布${C.reset}"。`)
  console.log(`     ${C.yellow}没发版的应用收不到任何事件 — 这步九成新手会忘!${C.reset}`)
  console.log()
  console.log(`  ${C.bold}⑥ 拿凭据${C.reset}`)
  console.log(`     左侧 "凭证与基础信息" → 顶部 ${C.bold}App ID${C.reset} (${C.dim}cli_...${C.reset}) 和 ${C.bold}App Secret${C.reset}, 待会粘到下面。`)
  console.log()
  console.log(`  ${C.bold}⑦ 把机器人拉进群${C.reset}`)
  console.log(`     想用的飞书群 → 群设置 → 群机器人 → 添加机器人 → 选你的应用。`)
  console.log(`     ${C.yellow}群名要等于 projects_root 下的项目目录名${C.reset} (下一步设, 默认是用户主目录)。`)
  console.log()

  let appId = '', appSecret = ''
  while (true) {
    appId = await ask('App ID (以 cli_ 开头)', { required: true })
    appSecret = await ask('App Secret', { required: true })
    console.log(`${C.dim}测试中... (调 tenant_access_token endpoint)${C.reset}`)
    const test = await testFeishuCreds(appId, appSecret)
    if (test.ok) {
      console.log(`${C.green}✓ Feishu 凭据测试通过${C.reset}`)
      break
    }
    console.log(`${C.red}✗ 测试失败:${C.reset} ${(test as { ok: false; error: string }).error}`)
    console.log(`${C.dim}最常见原因: app_id / app_secret 抄错, 或应用还没 "发布上线" (步骤 ⑤)。${C.reset}`)
    console.log()
    const retry = await ask('重新填? (Y/n)', { default: 'y' })
    if (retry.toLowerCase() === 'n') {
      console.log(`${C.yellow}已取消, 配置未写盘。${C.reset}`)
      rl.close()
      process.exit(1)
    }
  }

  // ── Step 4/4 ──────────────────────────────────────────────────
  step(4, 4, '工作目录 + 启动')
  console.log('每个 Feishu 群对应 projects_root 下同名的目录。')
  console.log()
  const defaultRoot = process.platform === 'win32'
    ? (process.env.USERPROFILE ?? 'C:\\Users\\Default')
    : (process.env.HOME ?? '/root')
  const projectsRoot = await ask('projects_root', { default: defaultRoot })

  // ── Write config.toml ─────────────────────────────────────────
  mkdirSync(CONFIG_DIR, { recursive: true })
  const toml: string[] = [
    '# Lodestar config — generated by `lodestar-setup`',
    '# Edit by hand or re-run setup to overwrite.',
    '',
    '[feishu]',
    `app_id = "${escapeTomlString(appId)}"`,
    `app_secret = "${escapeTomlString(appSecret)}"`,
    '',
    '[runtime]',
    `projects_root = "${escapeTomlString(projectsRoot)}"`,
    '',
    '[runtime.agent_auto_update]',
    'codex = false',
    'claude = false',
    'dsh = false',
    '',
  ]
  // Claude / GLM 路由由 ~/.claude/settings.json 管 (向导已写入或沿用你的
  // 现有配置); Codex 登录态由 codex CLI 管。config.toml 只保存 Feishu 和
  // Lodestar runtime; 高级用户可手写 [codex.env] / [claude.env] 注入子进程
  // 环境 (escape hatch, 通常不需要)。
  writeStateFileAtomic(CONFIG_FILE, toml.join('\n'))

  console.log(`\n${C.green}${C.bold}✓ 配置已写入${C.reset}`)
  console.log(`  ${C.cyan}${CONFIG_FILE}${C.reset}`)

  // ── Auto-start daemon ─────────────────────────────────────────
  console.log(`\n${C.bold}启动 daemon...${C.reset}`)
  const r = spawnDaemonDetached()
  const sep = process.platform === 'win32' ? '\\' : '/'
  const logPath = process.platform === 'win32'
    ? `${process.env.LOCALAPPDATA ?? '%LOCALAPPDATA%'}\\Lodestar\\daemon-YYYY-MM-DD.log`
    : `${process.env.HOME ?? '~'}/.local/share/lodestar/daemon-YYYY-MM-DD.log`

  if (r.pid) {
    console.log(`${C.green}✓ daemon 已在后台启动${C.reset} (pid ${r.pid})`)
    console.log()
    console.log(`${C.bold}最后一步: 在 Feishu 验证${C.reset}`)
    console.log(`  ① 把机器人拉进任意飞书群`)
    console.log(`  ② 群名 = ${C.cyan}${projectsRoot}${sep}<群名>${C.reset} 下的目录名 (新群第一条消息会自动建)`)
    console.log(`  ③ 在群里发任意一条消息, 默认由 Claude 接管`)
    console.log(`     ${C.dim}(群里发 model 可选择已配置账号、动态模型和 effort)${C.reset}`)
    console.log()
    console.log(`日志 (按日滚动, 保留近 7 天):`)
    console.log(`  ${C.cyan}${logPath}${C.reset}`)
    console.log()
    console.log(`${C.dim}若长期跑后台, Linux 配 systemd --user,macOS 配 launchd,Windows 配任务计划程序。${C.reset}`)
  } else {
    console.log(`${C.yellow}启动失败: ${r.error}${C.reset}`)
    console.log(`手动运行: ${C.cyan}lodestar-daemon${C.reset}`)
  }
  console.log()

  rl.close()
}
