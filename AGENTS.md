# Lodestar 项目指引

Lodestar 是 Bun/TypeScript daemon：从飞书 WebSocket 接收消息，每个群对应一个 `Session`，通过 Codex app-server、Claude Agent SDK 或 DeepSeek Harness 执行任务，以 Feishu Card Kit schema 2.0 展示结果。

维护说明以 `AGENTS.md` 为入口。Codex、Claude、GLM、DeepSeek、OpenRouter 和 Claude native 都是受支持能力；文档清理、缺少本机凭据或维护工具选择不构成删除后端的理由。

## 目录

| 路径 | 职责 | 修改前阅读 |
| --- | --- | --- |
| `cli.ts`、`daemon.ts` | 首次配置、PID guard；WS、Session registry、Card action、本机通知 | 本文件 |
| `src/` | 会话、后端进程、账号、飞书 API、持久化、worktree | `src/AGENTS.md` |
| `src/cards/` | 卡片模板与展示文本 | `src/AGENTS.md`、`src/cards/AGENTS.md` |
| `scripts/` | 安装脚本、真实飞书探针和人工 smoke | `scripts/AGENTS.md` |
| `docs/` | 安装、群内用法、账号模型及后端说明 | `docs/AGENTS.md` |

## 开发规则

- 源码运行使用 `bun daemon.ts` 或 `bun run start`；`bun run build` 生成 Node.js ≥ 18.15 的发布入口。
- `config.ts` 在 import 时同步读取配置，缺失时报错。首次安装的延迟导入只放在 `cli.ts`。
- 配置默认位于 `~/.config/lodestar/config.toml`，状态位于 `~/.local/share/lodestar/`。新增持久状态通过 `src/paths.ts` 定义，遵循 XDG 和 Windows 路径约定。
- 凭据、本机配置、聊天成员、debug context 和 `~/.codex`、`~/.claude` 内容不得写入跟踪文件。
- API、模型目录、额度、上传和进程启动失败必须记录并向调用方显示；缺失数据用 `MISS`，不能伪造成功或偷偷更换来源。仅允许对已知瞬态错误有限重试。
- 保留已有改动。依赖变化用 Bun 同步 `bun.lock`，不手改锁文件。
- 禁止在 daemon 启动时检查、安装或更新 Agent，自动更新默认关闭。手动或显式开启的定期更新选择上游 `latest`，不等待 Lodestar 发版，不设置兼容版本白名单或旧版本上限。用户接受新版可能不兼容；发生不兼容时明确报错，由后续 Lodestar 更新适配，不能为规避适配而锁旧、降级、回退或恢复“先兼容验收才更新”的门槛。开发锁文件只记录测试依赖快照，不限制生产 Agent 更新。
- 工具卡片中的 shell 命令首行写 `# desc: <中文摘要>`，供 `src/cards/shell-command.ts` 提取标题。
- Card action `kind`、共享 `element_id`、群命令、持久化格式和 Token Source id 是协议。改名时同步分发、迁移与测试。

## 模块边界

- 一个群只有一个 Session 和一个当前主进程。Codex 使用 app-server JSON-RPC，Claude/GLM/DeepSeek/native 使用 Agent SDK streaming input，DSH 使用独立 Node 子进程和 Cordis stdio 桥接；不引入 tmux、JSONL 队列或旁路进程控制。
- DSH 的 `deepseek-harness` 与 Claude 兼容的 `deepseek` 共用 DeepSeek 凭据和平台地址；`dsh-glm` 与 `glm` 共用 GLM Coding Plan 账号，前者通过原生 pi-ai 适配器接入。共享凭据只存一份，模型、effort 和可见性按 Agent 保留；旧配置冲突必须明确报错，任一 setup 入口均更新共享账号。运行时经更新器选择 latest，子进程需要 Node 22.19+（22.x）或 24+；`src/dsh-bridge.ts` 仅在该子进程加载。
- `agent-updates.ts` 按 `[runtime.agent_auto_update]` 的 `codex`、`claude`、`dsh` 三个独立开关每 6 小时更新对应 Agent，首次检查也在 6 小时后；三项默认关闭，各自防止重叠执行，失败互不阻塞。旧布尔总开关按原值兼容转换并提示迁移，不与新表混用。`lodestar-update --agents-only` 可立即安装/更新。实际程序和 SDK 从独立版本目录加载；安装成功直接启用，新进程使用新版，已有进程保留其运行目录。Windows 不覆盖或删除使用中的 EXE/DLL；安装取消按精确 PID 终止安装器进程树，未确认退出不得清理其临时目录。文件占用有限重试，最终错误必须显示。安装或查询失败记录并向后续调用方报错；禁止用旧安装掩盖失败。自动更新 Agent 不重启 daemon。
- Token Source 统一管理账号、凭据、模型目录、启动环境和额度。Claude Code 订阅（`claude-sub`）独立复用本机原生登录态，可与第三方来源共存。模型与 Agent 身份动态读取该目录，沿用目录声明的 effort；来源禁用或刷新失败显示 `MISS`。新增来源通过 factory 注册。
- MD 首页按 Claude Code、Codex、DeepSeek Harness 分组，底层 Agent id 仍为 `claude`、`codex`、`dsh`。模型行右侧窄按钮用单字（选、显、隐、删），补录模型、显示模型、返回和翻页等宽按钮保留完整文案；模型行之间加分隔线，文字和按钮垂直居中；只有一个 effort 档位（含原生 default）时直接应用，多个档位才进入选择；两个 DeepSeek 来源都显示为 DeepSeek。OpenRouter 默认十二项，包含 Claude Opus 5、Fable 5.1、其余榜单八项及字节和美团；蚂蚁和阶跃不列为默认，其他来源默认展示接口列表。接口项用隐藏/显示，列表外记录用补录/删除；所有来源支持 `custom_models`，补录后可选请求档位并直接使用，不能因目录未收录而清空 effort 或禁止选择。隐藏不改运行模型，删除补录项须保护正在选用的会话并清理悬空配置。footer 固定为 `agent · 模型名/effort`；所有来源额度按账号和平台共享 60 秒惰性缓存及并发请求；失败冷却依次为 1、2、4、5 分钟，遵守上游更长 Retry-After，不立即重试额度 API；回复 footer 最终刷新失败可按原格式直接展示同账号成功缓存，不加缓存或刷新失败标注，无缓存或认证失败仍 MISS；主动额度查询仍显示实时失败；窗口额度保留原紧凑倒计时格式 `4.1h·7%·[6.9d·17%]`，余额显示 `余额 $…` / `余额 ¥…`。OpenRouter 用 `/credits` 查账户余额，以实际响应判断权限。
- `AgentService` 的委派进程与主会话共用启动入口。委派仅一层：主 Agent 可并行派工、续跑与输入回填；被委派的 Agent 不得通过 Lodestar 或原生 Agent 工具继续委派。具体生命周期约束见 `src/AGENTS.md`。
- `managed-skills.ts` 同源生成 Codex/Claude standalone Skill 和 Claude 本地插件。GLM/DeepSeek 通过插件加载 Skill，不为此重新引入 user settings 和凭据。
- 同 provider/source 调用 `setModelSettings`；Claude 后续 turn 生效，Codex 持久设置在重启后生效。跨 provider/source 只在空闲时换进程，resume id 按 provider 隔离。
- 保留 Claude 的原生 resume/fork、提问、project profile、MCP/Skill、主动压缩和 SDK 后台任务；保留 Codex 的权限、提问、plan/goal、compaction、usage 和 collab 事件。共享接口须表达后端差异。
- `cardkit.ts` 独占生产卡的队列、sequence、TTL 重开、元素计数和写入失败状态。正文按完整 block 插入静态元素，footer 用 replace；模板和 Session 不直调 Card Kit HTTP。
- `worktree.ts` 管理 `work/*` 分支和同级 `<project>[name]` 工作区。飞书任务清单只提供绑定与删除，不启动自动规划、执行、审核或合并 worker。
- `[[send: /abs/path]]` 默认走原生聊天附件及其 30 MB 上限；`files on/off` 按群开启/关闭云空间，`files` 查看设置。主 Agent 启动时按群设置动态注入交付标记，只有附件模式附加大小约束；文件交付不提供独立 Skill，不让 Agent 查接口或配置。`group-file-delivery.ts` 按 chat_id 持久绑定唯一目录，目录名与实时群名一致，跨轮次和重启复用；关闭保留目录与文件。同名群不能混用目录，失效绑定不得自动重建空目录。云空间卡只列本轮文件，管理按钮打开本群全部历史交付文件的原生飞书目录；开启者和交付发起人获 full_access、群获 view，不转移所有权或开放公网分享。超过 20 MB 分片上传，限额由上游判断，失败不自动切换通道。原附件/图片通道保留，旧聊天附件不删除、不自动迁移。交付方式在本轮输入交给 Agent 时固定，开关改变从下一轮用户任务更新提示词，不重复普通输入或重启进程；记录由 paths.ts 定义，远端文件不自动清理，模板不读取文件。
- Codex 生图的提示词和图片默认放在同一个折叠面板，提示词包含完成事件补回的内容，不在折叠标题中展开。图片成功嵌入后不再单发；无法嵌入时按用户要求单独发图。关闭或换卡前等待所属图片上传和写入完成。
- `hi` 展示 Codex 账号可用的重置卡次数，来源为 `account/rateLimits/read` 的 `rateLimitResetCredits.availableCount`；hi 展示全部已配置账号，一账号一行；DeepSeek、GLM 不按 Agent 重复展示。Codex 只显示主额度，不显示 Spark/gpt-reserve；重置卡简写为“重置”，GLM 月工具只显示百分比，无底部说明。这不是飞书换卡计数，也不加入回复 footer。
- `codex-reset [备注]` 显式使用一次账号重置卡；省略备注只取当前运行账号，账号未知时要求指定。调用原生 `account/rateLimitResetCredit/consume`，同一消息及其网络重试复用幂等标识；按四种原生 outcome 展示结果，之后重新读额度，不能推算卡数或掩盖已扣卡后的刷新/关闭失败。

## 运行中的 daemon

- 启动的第一次 await 前加载恢复名单；开放 WS/调试入口前，按群把恢复任务排入消息与卡片共用的 actor。停机先关闭入口并排空已接收命令，再冻结恢复名单；停止进程时的生命周期回调不得覆盖该名单。恢复失败保留恢复意图和错误，普通消息不得隐式新建会话。
- 接收时已晚到超过 30 秒的消息应丢弃，避免用户重发后重复执行；排队耗时不参与该判断。这是明确的产品规则。
- WebSocket 恢复必须彻底关闭旧 client 并创建新的 `WSClient`，该方式已在实际环境反复验证；不能仅凭 SDK 显示 connected 就取消完整重建。
- 修改代码不授权 stop、restart、reload、切换服务或接管。只有当前用户消息明确要求对应操作时才能执行；授权不跨消息、中断恢复或上下文压缩继承。
- “测试”“预览”“发张卡看看”不授权停止、重启、shadow、并行启动 daemon 或改 service 指向。不能无扰验证时说明影响，等待明确许可。
- 重启前只读确认实际 unit，比较 `systemctl --user show <unit> -p ActiveEnterTimestamp` 与源码 mtime。运行代码不落后则不重启，不用 commit 时间代替启动时间。
- 终止进程前列出 PID 和完整命令，只操作精确 PID 或 unit；禁止 `pkill -f`、`killall` 和宽泛 systemd、Docker、tmux 目标。
- restart 会终止当前对话宿主。命令只执行一次重启，不在同一命令中 sleep 后验证；恢复后用新 PID、启动时间和 journal 核实。同一用户消息最多重启一次。
- 常驻进程交给 user systemd；不使用裸 `&`、`nohup` 或临时工具 session 代替服务管理。

## 验证与发布

- Agent 功能的真实调用、续跑和 smoke 测试默认选 GLM Flash；每次先查询实时身份目录，选择 `ready` 项并沿用目录默认 effort。用户明确指定其他模型时按该次要求；GLM Flash 不可用时报告问题，不自动换模型。
- 源码变更运行 `bun run typecheck` 和 `bun test`。构建入口、CLI、依赖或发布路径变更再运行 `bun run build`。
- 共享 Session、Card Kit、飞书协议和持久状态变更最终跑全量测试。双后端接口变更覆盖 Codex、Claude、provider/source 切换和共享卡片。
- 真实飞书、Agent 登录、Card action、建群/解散和 worktree smoke 需要明确目标群、账号及副作用；涉及 live daemon 仍按上节授权。
- 发布前通过 `bun test` 与 `bun run build`。未指定 minor/major 时只升 patch；同一版本发布 npm 和 GitHub Packages，推送 `main` 和 tag，创建 GitHub Release。
- `mathjax-full` 随包附带修复后的传递依赖。发布前实际安装 tarball 并运行 `npm audit --omit=dev`，不能只检查源码目录的 overrides 和 Bun 锁文件。
- Agent 包仅为开发和类型测试依赖，发布运行时由自动更新器安装。DSH 根据每次获取的 latest 递归解析同版本包族，安装快照中的精确版本用于避免包族混装，不构成兼容限制。普通安全依赖用 `bun scripts/sync-security-deps.ts` 同步，Agent 运行目录也应用这些安全修复。tarball 验收实际安装 Agent 并查询原生目录，不断言其版本等于 Lodestar 构建时版本。
- 没有 `gh` 时使用 GitHub REST，临时认证文件用后删除。Release 标题、功能说明和验证结果使用中文，模型名与代码标识符可保留原文；发布前检查没有整段英文说明。
