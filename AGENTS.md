# Lodestar 项目指引

Lodestar 是 Bun/TypeScript daemon：从飞书 WebSocket 接收消息，每个群对应一个 `Session`，通过 Codex app-server、Claude Agent SDK 或 DeepSeek Harness 执行任务，以 Feishu Card Kit schema 2.0 展示结果。

维护说明以 `AGENTS.md` 为入口。Codex、Claude、GLM、DeepSeek 和 Claude native 都是受支持能力；文档清理、缺少本机凭据或维护工具选择不构成删除后端的理由。

## 目录

| 路径 | 职责 | 修改前阅读 |
| --- | --- | --- |
| `cli.ts`、`daemon.ts` | 首次配置、PID guard；WS、Session registry、Card action、本机通知 | 本文件 |
| `src/` | 会话、后端进程、账号、飞书 API、持久化、worktree | `src/AGENTS.md` |
| `src/cards/` | 卡片模板与展示文本 | `src/AGENTS.md`、`src/cards/AGENTS.md` |
| `scripts/` | 安装脚本、真实飞书探针和人工 smoke | `scripts/AGENTS.md` |
| `docs/` | 后端与模型路由说明 | `docs/AGENTS.md` |

## 开发规则

- 源码运行使用 `bun daemon.ts` 或 `bun run start`；`bun run build` 生成 Node.js ≥ 18.15 的发布入口。
- `config.ts` 在 import 时同步读取配置，缺失时报错。首次安装的延迟导入只放在 `cli.ts`。
- 配置默认位于 `~/.config/lodestar/config.toml`，状态位于 `~/.local/share/lodestar/`。新增持久状态通过 `src/paths.ts` 定义，遵循 XDG 和 Windows 路径约定。
- 凭据、本机配置、聊天成员、debug context 和 `~/.codex`、`~/.claude` 内容不得写入跟踪文件。
- API、模型目录、额度、上传和进程启动失败必须记录并向调用方显示；缺失数据用 `MISS`，不能伪造成功或偷偷更换来源。仅允许对已知瞬态错误有限重试。
- 保留已有改动。依赖变化用 Bun 同步 `bun.lock`，不手改锁文件。
- 工具卡片中的 shell 命令首行写 `# desc: <中文摘要>`，供 `src/cards/shell-command.ts` 提取标题。
- Card action `kind`、共享 `element_id`、群命令、持久化格式和 Token Source id 是协议。改名时同步分发、迁移与测试。

## 模块边界

- 一个群只有一个 Session 和一个当前主进程。Codex 使用 app-server JSON-RPC，Claude/GLM/DeepSeek/native 使用 Agent SDK streaming input，DSH 使用独立 Node 子进程和 Cordis stdio 桥接；不引入 tmux、JSONL 队列或旁路进程控制。
- DSH 的 `deepseek-harness` 来源独立于 Claude 兼容的 `deepseek`。运行时锁定版本，子进程需要 Node 22.19+（22.x）或 24+；`src/dsh-bridge.ts` 仅在该子进程加载。
- Token Source 统一管理账号、凭据、模型目录、启动环境和额度。模型与 Agent 身份动态读取该目录，沿用目录声明的 effort；来源禁用或刷新失败显示 `MISS`。新增来源通过 factory 注册。
- `AgentService` 的委派进程与主会话共用启动入口。委派仅一层：主 Agent 可并行派工、续跑与输入回填；被委派的 Agent 不得通过 Lodestar 或原生 Agent 工具继续委派。具体生命周期约束见 `src/AGENTS.md`。
- `managed-skills.ts` 同源生成 Codex/Claude standalone Skill 和 Claude 本地插件。GLM/DeepSeek 通过插件加载 Skill，不为此重新引入 user settings 和凭据。
- 同 provider/source 调用 `setModelSettings`；Claude 后续 turn 生效，Codex 持久设置在重启后生效。跨 provider/source 只在空闲时换进程，resume id 按 provider 隔离。
- 保留 Claude 的原生 resume/fork、提问、project profile、MCP/Skill、主动压缩和 SDK 后台任务；保留 Codex 的权限、提问、plan/goal、compaction、usage 和 collab 事件。共享接口须表达后端差异。
- `cardkit.ts` 独占生产卡的队列、sequence、TTL 重开、元素计数和写入失败状态。正文按完整 block 插入静态元素，footer 用 replace；模板和 Session 不直调 Card Kit HTTP。
- `worktree.ts` 管理 `work/*` 分支和同级 `<project>[name]` 工作区。飞书任务清单只提供绑定与删除，不启动自动规划、执行、审核或合并 worker。
- 出站文件由 `[[send: /abs/path]]` 解析流程发送为独立文件消息，正文保留标记作为回执；卡片模板不读取文件。

## 运行中的 daemon

- 接收时已晚到超过 30 秒的消息应丢弃，避免用户重发后重复执行；排队耗时不参与该判断。这是明确的产品规则。
- WebSocket 恢复必须彻底关闭旧 client 并创建新的 `WSClient`，该方式已在实际环境反复验证；不能仅凭 SDK 显示 connected 就取消完整重建。
- 修改代码不授权 stop、restart、reload、切换服务或接管。只有当前用户消息明确要求对应操作时才能执行；授权不跨消息、中断恢复或上下文压缩继承。
- “测试”“预览”“发张卡看看”不授权停止、重启、shadow、并行启动 daemon 或改 service 指向。不能无扰验证时说明影响，等待明确许可。
- 重启前只读确认实际 unit，比较 `systemctl --user show <unit> -p ActiveEnterTimestamp` 与源码 mtime。运行代码不落后则不重启，不用 commit 时间代替启动时间。
- 终止进程前列出 PID 和完整命令，只操作精确 PID 或 unit；禁止 `pkill -f`、`killall` 和宽泛 systemd、Docker、tmux 目标。
- restart 会终止当前对话宿主。命令只执行一次重启，不在同一命令中 sleep 后验证；恢复后用新 PID、启动时间和 journal 核实。同一用户消息最多重启一次。
- 常驻进程交给 user systemd；不使用裸 `&`、`nohup` 或临时工具 session 代替服务管理。

## 验证与发布

- 源码变更运行 `bun run typecheck` 和 `bun test`。构建入口、CLI、依赖或发布路径变更再运行 `bun run build`。
- 共享 Session、Card Kit、飞书协议和持久状态变更最终跑全量测试。双后端接口变更覆盖 Codex、Claude、provider/source 切换和共享卡片。
- 真实飞书、Agent 登录、Card action、建群/解散和 worktree smoke 需要明确目标群、账号及副作用；涉及 live daemon 仍按上节授权。
- 发布前通过 `bun test` 与 `bun run build`。未指定 minor/major 时只升 patch；同一版本发布 npm 和 GitHub Packages，推送 `main` 和 tag，创建 GitHub Release。
- `mathjax-full` 随包附带修复后的传递依赖。发布前实际安装 tarball 并运行 `npm audit --omit=dev`，不能只检查源码目录的 overrides 和 Bun 锁文件。
- 没有 `gh` 时使用 GitHub REST，临时认证文件用后删除。Release 标题、功能说明和验证结果使用中文，模型名与代码标识符可保留原文；发布前检查没有整段英文说明。
