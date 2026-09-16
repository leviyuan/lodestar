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
| `lodestar-agent` | 由主 Agent 调用已配置模型执行任务，也支持与自身相同的模型 |

daemon 启动时不检查 Agent 版本，也不安装或更新 Agent。自动更新默认关闭；首次安装缺少运行文件或需要更新时，运行 `lodestar-update --agents-only`。手动更新和显式开启的自动更新都选择上游 `latest`，独立于 Lodestar 发版，不设置兼容版本白名单。

Codex、Claude、DSH 在 `[runtime.agent_auto_update]` 下分别设置 `codex`、`claude`、`dsh` 开关，未设置的项均为 `false`。设为 `true` 的 Agent 在 daemon 运行满 6 小时后首次检查，之后每 6 小时独立检查，启动阶段仍不检查；一个 Agent 更新较慢或失败不阻塞其他 Agent。旧版布尔总开关按原值兼容映射为三项并提示迁移，不可与新配置表混用。

运行文件放在 Lodestar 数据目录的 `agent-runtimes/` 下，每个版本使用独立目录；更新只切换新进程所用的目录，保留正在运行任务的程序和 SDK。Windows 下也不覆盖、重命名或删除正在使用的旧版 EXE/DLL。取消安装时按安装器 PID 终止其进程树，并等待退出；若无法确认终止，保留可能被占用的临时目录并报告错误。

查询或安装失败会明确报错，`lodestar-version` 可查看错误；不会静默改用旧安装。文件占用只做有限重试，最终失败仍显示。显式配置的 `[claude].bin` 按该路径执行。

长期运行可交给 Linux `systemd --user`、macOS `launchd` 或 Windows 任务计划程序。daemon 重启后会恢复上次活跃的会话。

## 飞书应用权限

创建自建应用并添加机器人能力后，在飞书开放平台的“权限管理 → 批量导入/导出权限”中，导入完整的 [应用身份权限 JSON](feishu-permissions.json)。安装向导会显示同一份清单，账号信息、消息、卡片和文件交付权限可一次开齐。使用应用身份，不需要用户授权登录，也不依赖飞书 CLI。

云空间交付需要同时包含以下权限：

| 应用身份权限 | 用途 |
| --- | --- |
| `drive:drive` | 上传与查看文件、创建文件夹、授予协作者权限，以及关闭并核对文件链接分享 |
| `drive:file:upload` | 文件夹标题更新接口单独要求的权限，用于保持文件夹名与群名一致 |
| `im:chat` | 读取实际群名和群信息 |

清单还包括原生附件的 `im:resource`、机器人发消息的 `im:message:send_as_bot`、Card Kit 权限，以及排障时读取租户和认证信息的权限。需要审批的权限应完成审批，再创建并发布飞书应用版本。取得应用访问凭据不代表业务权限已生效。

升级已有应用时也应补齐清单并发布应用版本。开通权限不会改变群设置：文件默认直接作为聊天附件发送，只有群内执行 `files on` 才启用云空间，`files off` 恢复附件。文件夹权限与实际文件的分享入口会分别处理，具体行为见[文件与生图](usage.md#文件与生图)。

## 本机配置

默认配置文件是 `~/.config/lodestar/config.toml`，可通过 `LODESTAR_CONFIG` 指定文件。日志和会话状态位于 `~/.local/share/lodestar/`；Windows 使用相应的应用数据目录。完整路径定义见 [src/paths.ts](../src/paths.ts)。

```toml
[runtime]
projects_root = "/abs/projects"
live_elapsed = "bucket"      # bucket 按档位刷新耗时；second 按秒刷新

[runtime.agent_auto_update] # 三项独立，默认关闭；启动时不检查
codex = false
claude = false
dsh = false

[projects.calculator]
cwd = "/abs/projects/calculator"  # 对所有后端均生效
setting_sources = "project"       # Claude 后端；仅未绑定 Token Source 时使用
strict_mcp = "true"               # Claude 主会话
load_project_mcp = "true"         # Claude / DSH 主会话
tools = "Read,Write,Edit,Bash,Glob,Grep"  # Claude / DSH 主会话

[claude]
bin = "/abs/path/to/claude-wrapper"  # 可选的 Claude 可执行文件
```

账号配置、OpenRouter 默认模型和 DSH 接入见[模型与账号](models.md)。手动修改配置后需重启 daemon；群内设置自行保存。

## HTTP 代理

OpenRouter 的模型目录与余额查询，以及 Lodestar 自己发出的其他 HTTP 请求，共用相同的代理选择。无需开启 TUN，也不需要给每个 Token Source 单独配置代理。

对每个目标地址，优先使用对应的 `HTTP_PROXY` / `HTTPS_PROXY`，未设置时使用 `ALL_PROXY`，都未设置时读取当前运行用户的系统代理。小写变量优先于大写，空值视为未设置。支持 HTTP 和 HTTPS 代理及 URL 中的用户名、密码；不要把凭据写入仓库。

系统设置支持 Windows 当前用户的手动代理、macOS 网络代理，以及 Linux 的 GNOME/KDE 手动代理；最多缓存 30 秒。Linux 没有对应桌面设置时使用环境变量。PAC、自动发现、SOCKS 和 KDE 反向例外列表尚不支持，遇到这些配置会明确报错；系统设置读取失败或代理连接失败也不会自动直连。可用明确的 HTTP(S) 代理环境变量覆盖系统设置。

`NO_PROXY` 支持逗号、空白或分号分隔的域名、子域名、端口、IPv4/IPv6 CIDR 和 `*`。回环地址始终直连，内部通知与 Agent capability 请求还会拒绝跳转到外网。外部请求重定向后重新判断代理，并在跨 origin 时清除认证信息。

服务进程读取它自己的环境及运行用户的设置。在终端里 `export HTTPS_PROXY=...` 不会修改已经运行的 systemd/launchd/Windows 服务；应在对应服务的环境中设置。代理设置只作用于 Lodestar 自有 HTTP：Codex、Claude、DSH 与 npm 的网络继续遵循各自应用配置，飞书 SDK 的 HTTP/WebSocket 也保留其原生配置方式。`[claude.env]`、`[codex.env]` 不是 daemon 的全局代理设置。

## 源码开发

安装 Bun，在仓库根目录运行：

```bash
bun install
bun run typecheck
bun test
bun run build
```

完成配置后用 `bun run start` 从源码启动。维护规则见[项目指引](../AGENTS.md)；真实飞书探针会操作目标群，使用前阅读[脚本说明](../scripts/AGENTS.md)。
