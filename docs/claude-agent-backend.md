# 后端与模型路由

Lodestar 通过 `AgentProcess` 接口连接 Codex app-server、Claude Agent SDK 和 DeepSeek Harness。`Session` 负责群会话、消息排队和卡片；具体进程类负责协议转换。主会话和委派 Agent 共用 `agent-launch.ts` 的启动入口。

## 进程与会话

| 行为 | Codex | Claude、GLM、DeepSeek |
| --- | --- | --- |
| 进程 | `codex app-server --listen stdio://`，通过 JSON-RPC 通信 | SDK `query()`，通过 `AsyncIterable<SDKUserMessage>` 连续输入 |
| 初始化 | 等待初始化和 thread 启动事务完成 | 首条输入才触发 `system/init`；启动时只检查早期错误 |
| 恢复与分叉 | `thread/list`、`thread/fork(lastTurnId)` | 同目录 transcript、`forkSession`、`resumeSessionAt` |
| 澄清提问 | `item/tool/requestUserInput` | `canUseTool` 中处理 `AskUserQuestion` |
| 主动压缩 | `thread/compact/start` | 向 streaming input 发送 `/compact`，等待 `compact_boundary` |
| 后台任务 | app-server collab 子 Agent 事件 | SDK `task_*` 事件 |

会话引用包含 provider、原生 session id 和 cwd。各后端分别保存恢复记录，切换后端不会共用同一段上下文。Claude fork 在首条输入前持久保存启动意图，获得新 session id 后才清除；历史会话通过原生 fork 接入新群，避免两个群写同一个会话。

主动压缩没有固定完成时限，以完成事件为准，进程退出或报错时失败。Claude 明确返回 `Not enough messages to compact` 时视为无需压缩，普通 `result` 事件不能代替完成通知。

## 账号和模型

Token Source 管理账号凭据、模型目录、启动环境、默认模型、effort 和额度。内置来源如下：

| 来源 | 配置和模型目录 |
| --- | --- |
| Codex subscription | 使用 Codex 登录态，模型来自 app-server `model/list` |
| GLM Coding Plan | `[token_source.glm]` 或本机 Claude settings；模型来自兼容端点，可补录已验证模型 |
| DeepSeek | `[token_source.deepseek]` 或本机 Claude settings；模型来自兼容端点，可补录已验证模型 |
| DeepSeek Harness | `[token_source.deepseek-harness]`；模型、effort 与上下文容量来自锁定版本的 DSH 原生目录 |
| Claude native | 沿用本机 Claude 配置，提供 SDK aliases；有其他已启用的 Claude 侧来源时让位 |

`model` 面板按账号 → 模型 → effort 展示，获取失败显示 `MISS`。同 provider/source 的切换调用 `setModelSettings`：Claude 和 DSH 从后续 turn 使用，Codex 保存选择并在重启进程后应用。跨 provider/source 或需要变更项目启动配置时，只能在空闲状态更换进程。

`[claude.models.<name>].model` 保留旧 `claude:<name>` 路由的解析。账号、显示名和模型目录由 Token Source 管理；Claude 槽位映射使用账号的 `slots`。

## Claude 启动配置

GLM、DeepSeek 等来源先清除冲突的 Anthropic 环境变量，再注入各自凭据；默认读取 `project`、`local` settings。Claude native 沿用本机环境并读取 `user`、`project`、`local`。Token Source 指定的 settings 来源优先；未绑定 Token Source 时才使用项目 `setting_sources`。给注入凭据的来源加上 `user` 会重新引入本机 settings 中的路由。

`[projects.<name>]` 的 `cwd` 对两个后端生效；`tools`、`setting_sources`、`strict_mcp`、`load_project_mcp` 用于 Claude。主会话默认发现项目 `.mcp.json`。排除 user settings 的 Claude 会话通过 SDK 本地插件加载 daemon 管理的 Skill，安装内容统一由 `managed-skills.ts` 生成。

`[claude].bin` 可指定包装器，路径无效时启动失败。未指定时由 `resolveClaudeExecutableConfig()` 查找本机 Claude 或 SDK native binary，Windows `.cmd`/`.bat` 通过 shell shim 启动。

Claude 使用 `permissionMode: default`：普通工具在 `canUseTool` 中放行，`AskUserQuestion` 等待用户回答。不能改成 `bypassPermissions`，否则 SDK 会绕开提问回调。

## DeepSeek Harness 原生后端

`DshProcess` 启动锁定版本 `0.1.5-alpha.2` 的 Node DSH 子进程，以 `sdk` profile 加载 `dsh-bridge` Cordis 插件，替换默认 SDK JSON-RPC server。Lodestar 的 stdio 协议只承载控制和事件；Agent 循环、工具执行、持久化及子 Agent 由 DSH 管理。

- `session/open` 完成原生 create/resume/fork 并 flush 后才公布恢复点。`rs` 通过原生持久化服务列出同工作目录会话；`fk/bk` 使用 `turn/end` 的事件序号作为 checkpoint，原生日志验证并加载分叉历史。
- 实时文本来自 `agent/assistant-stream`，工具和计划来自会话事件。进入 idle 后等待持久化完成，再用真实 `turn/end` 原因结算；认证失败、token 耗尽及驱动异常均向调用方报告。
- 子工具返回的内容块数组先转换为后台卡摘要；不能按字符串直接处理。致命桥接错误会把未结束的子任务标记失败，并将进程退出作为异常向用户报告。
- 提问通过 `user-questions/request` 停驻，复用飞书问答卡；回答按原始 question id 返回。主动和自动压缩使用 DSH compaction 服务与事件。
- 模型与 effort 更新在下一轮应用，同一轮的工具续跑保持当前路由。`off` 是 DSH 原生推理选项。
- 每个进程默认读取项目 `.mcp.json` 的 stdio/HTTP MCP，并加载 `.agents/skills`、`.dsh/skills` 和 Lodestar 管理的 Skill。项目 `tools` 和 `load_project_mcp` 对 DSH 生效。
- 图片 MIME 由文件字节识别。飞书下载的 JPEG 可能使用 `.png` 文件名，不能据扩展名声明编码；无法识别的图片明确报错。
- 运行状态保存在 `src/paths.ts` 的 `DSH_HOME_DIR`。不读取用户 DSH settings 或凭据文件；`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL` 由选定账号显式注入。默认 telemetry 插件不加载。
- 委派 worker 与原生子 Agent 均禁止继续派工。主 Agent 的 Lodestar capability 通过原生 ShellEnv 按执行者注入，子 Agent 的 shell 不继承它；Agent CLI 识别这一专用上下文。
- 中断使用不可变原因对象，避免 Node fetch 附加 `stack` 属性后破坏 DSH 的无损 JSON 日志校验。关闭先回收 Agent，再通过协议、stdin EOF 与精确子进程终止确认退出。

需要 Node 22.19+（22.x）或 Node 24+；`[token_source.deepseek-harness].bin` 指定 Node 路径。DSH 是开发者预览版，升级依赖时须同步检查桥接协议并运行原生集成测试。`src/dsh-process.test.ts` 使用真实运行时和本地模拟模型/MCP，不连接飞书或付费 API。

## 共享事件和委派

`claude-agent-process.ts` 将 SDK 文本、工具、结果、用量、压缩和后台任务转换成 `AgentProcess` 事件。共享事件由 Session 和卡片消费，保留两种后端在初始化、上下文和后台任务上的差异。

委派只有一层：主 Agent 可以并行派工、回答问题和续跑原生会话，被委派的 Agent 不得继续调用其他 Agent。Skill、worker 提示词及运行时入口共同遵循该规则；worker 关闭 Codex `multi_agent` 或 Claude `Agent`/`Task`，保留其余代码工具、项目 MCP 和独立调用凭据。历史父子记录仍保留以便读取与清理。运行状态原子落盘，大段输入输出单独存放；委派会话登记后从主群的历史列表中排除。

委派卡片将整体进度放在顶部，按执行者展示结果、待回答问题和失败原因。单个 Agent 的完成结果默认展开，多个 Agent 的结果分别折叠；不展示 depth、session id 或 request id。

## 源码与验证

- 启动与协议：`src/agent-launch.ts`、`src/agent-process.ts`、`src/codex-process.ts`、`src/claude-agent-process.ts`、`src/dsh-process.ts`、`src/dsh-runtime.ts`、`src/dsh-bridge.ts`。
- 路由与配置：`src/token-source*.ts`、`src/session-model.ts`、`src/config.ts`、`src/claude-models.ts`。
- 会话分支：`src/conversation.ts`、`src/session-temp.ts`、`src/temp-session-runtime.ts`、`src/feishu.ts`。
- 委派：`src/agent-service.ts`、`src/agent-runner.ts`、`src/agent-session-registry.ts`。

本地检查使用 `bun run typecheck`、`bun test` 和 `bun run build`。真实后端与飞书交互需要单独指定账号、目标群和允许的副作用；历史探针结果不代表当前版本已完成线上验证。
