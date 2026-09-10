<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

AI 不是帮手,是倍率。它放大的不是体力,是你 —— 你的直觉、判断和品味,每一样都被乘以一个你以前不敢想的系数。

夜航星让这件事真正发生:在你思考的地方接住想法,在你转身之后继续推向终点。

---

在飞书群里使用 Codex、Claude Code 和 DeepSeek Harness。每个群对应一个项目目录和会话，回复、工具调用、提问和后台任务通过飞书卡片展示。

支持 Codex、GLM Coding Plan、DeepSeek、Claude native 和 DeepSeek Harness 原生后端。账号、模型与 effort 可在群里切换，选择按群保存。

## 安装

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
| `lodestar-update` | 升级 Lodestar、Codex CLI、Claude Code 和相关 SDK |
| `lodestar-version` | 查看 Lodestar、Claude Code、Codex CLI 和运行时版本 |
| `lodestar-agent` | 由会话中的 Agent 调用其他模型执行任务 |

长期运行可交给 Linux `systemd --user`、macOS `launchd` 或 Windows 任务计划程序。daemon 重启后会恢复上次活跃的会话。

## 群内命令

直接发送下列词语，不加斜杠，大小写不敏感。这些命令控制当前群的 Agent 会话。

| 指令 | 行为 |
| --- | --- |
| `hi` | 打开控制台；会话未运行时先启动 |
| `stop` / `st` | 打断当前回复并取消排队消息，保留进程 |
| `kill` / `kl` | 关闭当前 Agent 进程，保存可恢复的会话记录 |
| `restart` / `rs` | 进程存活时打断并恢复当前会话；已停止时列出同目录的历史会话，选择后创建独立分支 |
| `clear` / `cl` | 关闭当前进程并开始新会话；已停止时提示先启动 |
| `compact` / `cm` | 压缩当前会话的上下文 |
| `model` / `md` | 按账号 → 模型 → effort 选择并保存 |
| `agents` | 查看可调用的 Agent 身份及可用状态 |
| `task` | 创建、查看或删除绑定的飞书任务清单 |

模型列表来自各账号的模型目录，获取失败显示 `MISS`。同账号切换 Claude 模型从后续回复生效，Codex 的持久模型设置需重启会话生效；跨账号或后端切换只允许在空闲时进行。

GLM 的套餐与用量显示在 `hi` 控制台，回复底部也会显示当前窗口用量。

## Worktree 与临时会话

需要独立修改文件时，在项目主群使用 worktree：

| 指令 | 行为 |
| --- | --- |
| `wt` / `worktree` | 列出项目的 `work/*` 分支和工作区状态 |
| `wt feature-x` | 创建或加入 `<project>[feature-x]` 群和同级 worktree 目录，使用 `work/feature-x` 分支 |

已合并且未挂载的分支会折叠隐藏，再次启用时更新到主线。卡片上的“删”会检查对应群没有运行中的会话、工作区没有未提交变更，再解散群并删除 worktree；Git 分支保留。

临时会话共享当前工作目录，适合在同一项目里另开一段对话：

| 指令 | 行为 |
| --- | --- |
| `btw` | 创建 `<session>*MMDD-HHMM` 临时群，继承账号、模型和工作目录，启动新会话 |
| `bye` | 停止并解散当前临时群，仅适用于 Lodestar 创建的临时群 |
| `fk` / `fork` | 选择一条用户输入，在临时群里从这条输入之前分叉 |
| `bk` / `back` | 选择一条用户输入，让本群接到这条输入之前的新分支 |

`fk`、`bk` 和从历史记录恢复的 `rs` 都使用后端原生 fork，保留源对话。选第 N 条输入表示回到它发出之前，选中的输入不包含在新分支内。Claude 的新分支在首条输入时获得会话 id，准备状态会持久保存。

**分叉和回退只改变对话历史，不回滚文件或撤销 Shell、MCP 等外部操作。** `bk` 会附上已观察到的文件变更记录；需要目录隔离时使用 `wt`。

## 多模型任务

主 Agent 可以通过 `lodestar-agent` 查询实时身份，再把任务交给一个或多个模型。同一个任务选择多个身份时并发执行；后续追问可继续使用各模型的原生会话。

被调用的 Agent 可以编辑文件、执行命令、使用 MCP 和 Skill；委派只允许一层，被调用的 Agent 不能继续派工。它们与主 Agent 共享工作区，修改会立即可见。运行状态和结果通过卡片展示；需要用户输入时暂停，由主 Agent 回填答案后继续。委派产生的会话不会混入主群的 `rs` 历史列表。

`lodestar-agent` 只能在 Lodestar 管理的 Agent 进程里调用。命令用法见 [Agent Skill](src/agent-skill.ts)。

## 飞书任务清单

发 `task`，点“启用”可创建并绑定 `<project>[lodestar]` 任务清单。删除需要在卡片上再次确认，会删除整个清单及其中任务。该面板管理清单绑定，任务执行由用户和 Agent 安排。

## 本机通知

脚本可通过 HTTP 向项目群发送通知，支持 `info`、`warn`、`error`，以及本地图片、按钮和点击回调：

```bash
curl -sS -X POST http://127.0.0.1:9876/notify \
  -H 'Content-Type: application/json' \
  -d '{"project":"ops","level":"error","text":"构建失败，截图如下","images":["/abs/shot.png"]}'
```

按钮点击结果可以 POST 到指定的本机 `callback`，或通过 `GET /notify/result/<notify_id>` 查询。字段和协议见 [feishu-notify Skill](src/notify-skill.ts)。daemon 启动时会将该 Skill 同步到 Codex 和 Claude 的 Skill 目录。

## 配置

默认配置文件是 `~/.config/lodestar/config.toml`，可通过 `LODESTAR_CONFIG` 指定文件。日志和会话状态位于 `~/.local/share/lodestar/`；Windows 使用相应的应用数据目录。完整路径定义见 [src/paths.ts](src/paths.ts)。

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

账号配置使用 `[token_source.glm]`、`[token_source.deepseek]` 等节。GLM 和 DeepSeek 也可以从本机 Claude settings 中识别；识别后由对应 Token Source 注入凭据，避免不同账号的环境变量串用。项目的工具限制只作用于主会话，委派 Agent 使用完整工具集。

DeepSeek Harness 使用独立的 `[token_source.deepseek-harness]` 账号与原生会话。在群内发送 `deepseek-harness-setup <api_key>`，再通过 `model` 面板选择该来源即可启用。自建端点用 `deepseek-harness-setup <base_url> <api_key>`；这里使用原生 API 根地址，不带 `/anthropic`。

```toml
[token_source.deepseek-harness]
agent = "dsh"
api_key = "填写自己的 API key"
# bin = "/abs/path/to/node"  # 可选：运行 DSH 的 Node 可执行文件
# model = "deepseek-v4-pro" # 可选：必须存在于 DSH 返回的模型目录
# effort = "high"          # 可选：必须是该模型支持的推理强度
```

手动修改配置后需重启 daemon；群内账号启用和模型补录会自行重载相关配置。模型路由、配置优先级和后端差异见 [后端说明](docs/claude-agent-backend.md)。

## 开发

```bash
bun install
bun run typecheck
bun test
bun run build
```

从源码启动使用 `bun run start`。`scripts/` 中的 smoke 和探针会操作真实飞书群，使用前阅读 [脚本说明](scripts/AGENTS.md)。

## 许可

[MIT](LICENSE)
