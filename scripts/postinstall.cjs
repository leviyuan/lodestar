#!/usr/bin/env node
// Postinstall banner — 只告诉用户下一步跑什么, 不在这里拉起向导。
//
// 为什么不自动拉向导: npm 7+ pipe 了 postinstall 的 stdio, 自动拉向导只能
// 靠接管 /dev/tty 把终端塞给子进程 —— 这套机制脆弱 (作者原注 "Tricky")。
// 实测在部分 mac 环境 /dev/tty 接管失败时, 向导的 readline 拿不到输入死等,
// 而父进程 npm 又 wait 在向导退出上 → npm 和向导互相卡死, 终端冻住 (文件
// 其实早装好了); 杀掉还会触发 npm 回滚删文件。
//
// 稳的做法是 trigger-on-first-run: 用户在真终端首跑 lodestar-daemon 时,
// cli.ts 发现没 config + isTTY 就自动进入向导 (真 TTY, readline 一定正常)。
// 所以这里只打个提示就 process.exit(0), 不 spawn 任何子进程, 永不卡死。

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

termWrite('\n  \x1b[1m\x1b[36m✓ Lodestar 已安装\x1b[0m\n')
termWrite('\n  \x1b[2m下一步: 在终端跑 \x1b[32mlodestar-daemon\x1b[0m\x1b[2m 进入配置向导\x1b[0m')
termWrite('\n  \x1b[2m(首次运行会自动拉起向导; 也可直接跑 \x1b[32mlodestar-setup\x1b[0m\x1b[2m)\x1b[0m\n\n')
termWrite('  启动时不检查或更新 Agent，自动更新默认关闭。\n')
termWrite('  安装/更新 Agent: lodestar-update --agents-only；定期更新可在 [runtime.agent_auto_update] 中分别开启 codex、claude、dsh。\n\n')

process.exit(0)
