# 安装与配置

[返回首页](../README.md) · [模型与账号](models.md)

## 安装与运行

支持 Windows、macOS 和 Linux，需要 Node.js ≥ 18.15。Bun 用于源码开发和构建。

DeepSeek Harness 子进程另需 Node 22.19+（22.x）或 Node 24+；可通过其账号配置的 `bin` 指定 Node 可执行文件。

```bash
npm i -g @leviyuan/lodestar
lodestar-setup
```

向导会配置 Claude Code、可选的 GLM API key、飞书应用和项目目录，并启动 daemon；也可以同时配置 Codex 登录。Claude 按 API key 方式配置。

把机器人拉进群，群名设为 `projects_root` 下的目录名。目录不存在时会自动创建。首次消息默认使用 Claude 侧已配置的账号；发 `model` 可切换到其他账号。

安装后提供以下命令：

| 命令 | 作用 |
| --- | --- |
| `lodestar-setup` | 配置向导 |
| `lodestar-daemon` | 启动 daemon |
| `lodestar-stop` | 停止 daemon |
| `lodestar-update` | 升级 Lodestar 及实际使用的 Codex、Claude Code/SDK、DSH；`--agents-only` 仅立即更新 Agent |
| `lodestar-version` | 查看 Lodestar、实际 Agent 版本、运行目录及更新错误 |
| `lodestar-agent` | 由会话中的 Agent 调用其他模型执行任务 |

Codex、Claude Code/Agent SDK、DSH 默认自动跟随上游 `latest`：daemon 启动时检查一次，之后每 6 小时检查并更新。运行文件放在 Lodestar 数据目录的 `agent-runtimes/` 下，更新完成后新进程使用新版，已有任务继续使用自己的版本目录。可用 `lodestar-update --agents-only` 立即检查并更新。Agent 更新独立于 Lodestar 发版，不需要先通过兼容性验收；新版不兼容时明确报错，后续更新 Lodestar 适配。查询或安装失败不会静默使用旧安装，`lodestar-version` 可查看错误。显式配置的 `[claude].bin` 仍按该路径执行。

长期运行可交给 Linux `systemd --user`、macOS `launchd` 或 Windows 任务计划程序。daemon 重启后会恢复上次活跃的会话。

## 本机配置

默认配置文件是 `~/.config/lodestar/config.toml`，可通过 `LODESTAR_CONFIG` 指定文件。日志和会话状态位于 `~/.local/share/lodestar/`；Windows 使用相应的应用数据目录。完整路径定义见 [src/paths.ts](../src/paths.ts)。

```toml
[runtime]
projects_root = "/abs/projects"
live_elapsed = "bucket"      # bucket 按档位刷新耗时；second 按秒刷新

[projects.calculator]
cwd = "/abs/projects/calculator"  # 对两个后端均生效
setting_sources = "project"       # Claude 后端；仅未绑定 Token Source 时使用
strict_mcp = "true"               # 以下字段用于 Claude 主会话
load_project_mcp = "true"
tools = "Read,Write,Edit,Bash,Glob,Grep"

[claude]
bin = "/abs/path/to/claude-wrapper"  # 可选的 Claude 可执行文件
```

账号配置、OpenRouter 默认模型和 DSH 接入见[模型与账号](models.md)。手动修改配置后需重启 daemon；群内设置自行保存。
