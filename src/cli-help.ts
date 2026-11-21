/**
 * `lodestar` 的帮助文本。
 *
 * 这里只放纯文本，不导入任何命令实现：帮助与版本路径要快，不能因为打印
 * 用法就把 agent / daemon 等模块加载进来。
 */

const GLOBAL_FLAGS = [
  '  -h, --help       显示帮助并退出（不读配置、不启动进程）',
  '  -V, --version    只输出版本号',
  '      --no-color   关闭 ANSI 颜色；非 TTY 或设置 NO_COLOR 时同样自动关闭',
].join('\n')

const UPDATE_GUIDE = [
  '更新（已部署为系统服务）:',
  '  正确做法是“装新版本 → 由服务管理器重启 → 等待服务重新上线”，不要手动停进程。',
  '',
  '  1. 安装新版本: npm i -g @leviyuan/lodestar',
  '     只替换磁盘上的文件，正在运行的旧进程继续使用旧代码。',
  '  2. 让服务管理器重启服务（不要用 `lodestar stop` 代替）:',
  '       systemd --user  : systemctl --user restart <你的 unit>',
  '       macOS launchd   : launchctl kickstart -k gui/$(id -u)/<你的 label>',
  '       Windows 任务计划: schtasks /End /TN <任务名> && schtasks /Run /TN <任务名>',
  '  3. 等待服务重新上线后运行 `lodestar version` 确认。',
  '',
  '  误操作提醒:',
  '    · 已经交给服务管理器托管时，不要执行 `lodestar stop`，也不要 kill 进程；',
  '      它只会停掉当前进程，不会按更新流程把服务重新拉起来。',
  '    · `lodestar stop` 仅用于终端前台手动启动的 daemon；这种情况才用 `lodestar stop && lodestar start`。',
  '    · `lodestar update` 只安装新包并更新 Agent，不会重启服务；Agent 更新由下一个进程生效。',
].join('\n')

const EXIT_CODES = [
  '退出码:',
  '  0 成功   1 运行失败   2 用法错误   130 中断',
].join('\n')

export function topLevelHelp(): string {
  return [
    'lodestar — 在飞书 / Lark 里驱动 Codex、Claude Code 与 DeepSeek Harness',
    '',
    '用法:',
    '  lodestar [start]                      前台运行 daemon（无配置且为终端时进入向导）',
    '  lodestar setup                        交互式配置向导',
    '  lodestar stop                         停止本机 daemon',
    '  lodestar update [--agents-only]       安装最新 Lodestar，并更新 Agent 运行时',
    '  lodestar version [--verbose] [--json] 查看 Lodestar 与 Agent 的实际版本',
    '  lodestar agent <command> [options]    调用已配置的模型执行任务',
    '  lodestar claude <备注|default> [-- <原生参数>...]',
    '                                        使用指定账号目录运行原生 Claude Code',
    '  lodestar help [command]               查看总览或某条命令的帮助',
    '',
    '全局选项:',
    GLOBAL_FLAGS,
    '',
    EXIT_CODES,
    '',
    UPDATE_GUIDE,
  ].join('\n') + '\n'
}

const COMMAND_HELP: Record<string, string> = {
  start: [
    'lodestar start — 前台运行 daemon',
    '',
    '用法:',
    '  lodestar [start]',
    '',
    '说明:',
    '  在终端前台运行 daemon；首次运行且没有配置时自动进入配置向导。',
    '  服务化部署（systemd / launchd / 任务计划）让它执行 `lodestar`，',
    '  更新方式见 `lodestar --help` 的「更新」一节。',
    '  已在运行时不会再启动第二个实例，而是提示用 `lodestar stop` 停止。',
  ].join('\n') + '\n',

  setup: [
    'lodestar setup — 交互式配置向导',
    '',
    '用法:',
    '  lodestar setup',
    '',
    '说明:',
    '  需要在真实终端运行（stdin 必须是 TTY，不能 pipe）。',
    '  向导写入 ~/.config/lodestar/config.toml，然后以后台方式启动 daemon。',
  ].join('\n') + '\n',

  stop: [
    'lodestar stop — 停止本机 daemon',
    '',
    '用法:',
    '  lodestar stop',
    '',
    '说明:',
    '  读取 PID 记录并核对进程实际入口后发送停止信号，以进程真正退出为准；',
    '  删除 PID 文件不会被当作停止成功。daemon 未运行时不报错（退出码 0）。',
    '',
    '服务化部署注意:',
    '  不要用本命令重启或更新服务：它只停当前进程，服务管理器不会按更新流程拉起新版本。',
    '  已交给 systemd / launchd / 任务计划托管时，请用对应管理器重启服务，',
    '  更新步骤见 `lodestar --help`。本命令仅用于终端前台手动启动的 daemon。',
  ].join('\n') + '\n',

  update: [
    'lodestar update — 升级 Lodestar 与 Agent 运行时',
    '',
    '用法:',
    '  lodestar update                 安装最新 Lodestar，再由新版本更新 Agent',
    '  lodestar update --agents-only   只更新 Agent，不安装 Lodestar',
    '',
    '说明:',
    '  命令不会重启 daemon。先装新版本，再由服务管理器重启并等待它重新上线:',
    '    systemd --user  : systemctl --user restart <你的 unit>',
    '    macOS launchd   : launchctl kickstart -k gui/$(id -u)/<你的 label>',
    '    Windows 任务计划: schtasks /End /TN <任务名> && schtasks /Run /TN <任务名>',
    '  不要用 lodestar stop 代替服务重启（它只停进程，不会拉起新版本）。',
    '  前台手动运行时才用 lodestar stop && lodestar start。',
    '  重启后用 lodestar version 确认新版本已生效。',
  ].join('\n') + '\n',

  version: [
    'lodestar version — 查看 Lodestar 与 Agent 的实际版本',
    '',
    '用法:',
    '  lodestar version             人类可读输出',
    '  lodestar version --verbose   附带安装目录与 Node 运行时',
    '  lodestar version --json      机器可读输出',
    '',
    '说明:',
    '  只读取当前安装记录；Agent 未安装显示 MISS，退出码仍为 0；',
    '  安装记录与实际文件不一致时退出码为 1。',
    '  脚本只想要版本号时使用 `lodestar --version`。',
  ].join('\n') + '\n',
}

export function commandHelp(name: string): string | undefined {
  return COMMAND_HELP[name]
}
