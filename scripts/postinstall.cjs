#!/usr/bin/env node
// 迁移账号插件缓存、清理废弃的受管 Skill 并提示下一步，不启动 Agent 或 daemon。
//
// 为什么不自动拉向导: npm 7+ pipe 了 postinstall 的 stdio, 自动拉向导只能
// 靠接管 /dev/tty 把终端塞给子进程 —— 这套机制脆弱 (作者原注 "Tricky")。
// 实测在部分 mac 环境 /dev/tty 接管失败时, 向导的 readline 拿不到输入死等,
// 而父进程 npm 又 wait 在向导退出上 → npm 和向导互相卡死, 终端冻住 (文件
// 其实早装好了); 杀掉还会触发 npm 回滚删文件。
//
// 稳的做法是 trigger-on-first-run: 用户在真终端首跑 lodestar 时,
// 统一入口发现没 config + isTTY 就自动进入向导 (真 TTY, readline 一定正常)。
// 迁移与清理仅操作本地插件和 Skill 文件，不读凭据，也不启动子进程。

const fs = require('fs')

function termWrite (msg) {
  try {
    if (process.platform === 'win32') {
      const fd = fs.openSync('\\\\.\\CONOUT$', 'w')
      fs.writeSync(fd, msg)
      fs.closeSync(fd)
    } else {
      fs.writeFileSync('/dev/tty', msg)
    }
  } catch {
    // No controlling tty (CI / pipe) — best-effort stdout, npm 多半会吞掉。
    try { process.stdout.write(msg) } catch {}
  }
}

// 0.25 起只有一个 lodestar 命令。0.22–0.24 的 lodestar-update 装好新包后会重新执行
// 自己的旧入口（已不存在）来更新 Agent，必然失败；按旧文档配置的系统服务仍指向 lodestar-daemon。
// 安装脚本看不到升级前的版本，所以每次都提示。
const LEGACY_COMMANDS = [
  ['lodestar-daemon', 'lodestar start'],
  ['lodestar-setup', 'lodestar setup'],
  ['lodestar-stop', 'lodestar stop'],
  ['lodestar-update', 'lodestar update'],
  ['lodestar-version', 'lodestar version'],
  ['lodestar-agent', 'lodestar agent'],
  ['lodestar-claude', 'lodestar claude'],
]

function installMessage () {
  return [
    '\n  \x1b[1m\x1b[36m✓ Lodestar 已安装\x1b[0m\n',
    '\n  \x1b[2m下一步: 在终端跑 \x1b[32mlodestar\x1b[0m\x1b[2m 进入配置向导\x1b[0m',
    '\n  \x1b[2m(首次运行会自动拉起向导; 也可直接跑 \x1b[32mlodestar setup\x1b[0m\x1b[2m)\x1b[0m\n\n',
    '  启动时不检查或更新 Agent，自动更新默认关闭。\n',
    '  安装/更新 Agent: lodestar update --agents-only；定期更新可在 [runtime.agent_auto_update] 中分别开启 codex、claude、dsh。\n\n',
    '  从 0.24 及更早版本升级:\n',
    '    · 旧版 lodestar-update 会在装好新包后报 Agent 更新失败（旧入口已移除），请再运行一次 lodestar update --agents-only。\n',
    '    · 系统服务（systemd / launchd / 任务计划）里的 lodestar-daemon 改为 lodestar start，再由服务管理器重启。\n',
    `    · 旧命令已移除: ${LEGACY_COMMANDS.map(([legacy, current]) => `${legacy} → ${current}`).join('；')}\n\n`,
  ].join('')
}

async function main () {
  const { migrateCodexPluginCaches } = require('../src/codex-plugin-cache.cjs')
  migrateCodexPluginCaches()
  const { removeManagedSkill } = require('../src/managed-skill-cleanup.cjs')
  removeManagedSkill('lodestar-files')

  termWrite(installMessage())
}

if (require.main === module) {
  main().catch(error => {
    console.error('Lodestar 安装清理失败:', error)
    process.exitCode = 1
  })
}

module.exports = { installMessage, LEGACY_COMMANDS }
