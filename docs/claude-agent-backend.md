# 后端与模型路由

Lodestar 通过 `AgentProcess` 接口连接 Codex app-server、Claude Agent SDK 和 DeepSeek Harness。`Session` 负责群会话、消息排队和卡片；具体进程类负责协议转换。主会话和委派 Agent 共用 `agent-launch.ts` 的启动入口。

## 进程与会话

| 行为 | Codex | Claude、GLM、DeepSeek、OpenRouter |
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
| OpenRouter | `[token_source.openrouter]` 或本机 Claude settings；默认十一家各一模型，账号目录验证能力，MD 面板维护增删 |
| DeepSeek Harness | `[token_source.deepseek-harness]`；模型、effort 与上下文容量来自当前自动更新的 DSH 原生目录 |
| DSH GLM Coding Plan | `[token_source.dsh-glm]` 或复用 `glm`；账号接口返回模型，DSH 原生适配器提供能力和推理档位 |
| Claude native | 沿用本机 Claude 配置，目录来自 SDK `supportedModels()`；有其他已启用的 Claude 侧来源时让位 |

`model` 首页用独立的展开式折叠面板展示 Claude Code、Codex、DeepSeek Harness，模型行右侧窄按钮用单字，补录、返回和翻页等宽按钮保留完整文字。两个 Agent 下的 DeepSeek 来源都显示为 DeepSeek，协议 id 保持不变。每组使用浅蓝标题背景、蓝色边框及 `Agent · 名称` 标题，Token Source 行放在组内，避免两层名称混成同级列表；组 ID 由 `ELEMENTS.modelAgentGroup` 生成。选择账号后进入模型列表，行间加分隔线；多个档位才展示 effort 卡，只有一个档位（含原生默认）直接应用，获取失败显示 `MISS`。同 provider/source 的切换调用 `setModelSettings`：Claude 和 DSH 从后续 turn 使用，Codex 保存选择并在重启进程后应用。跨 provider/source 或需要变更项目启动配置时，只能在空闲状态更换进程。

2026-09-10 已在授权测试群验证该分组样式的真实卡片：原始结构保留 `blue-50` 标题背景、粗体 Agent 名称和 `blue-100` 边框，原有账号选择回调正常，当前模型设置未改变。

除 OpenRouter 保留默认十一项的显式列表外，所有来源由 `withModelVisibility` 在真实接口目录上应用 `hidden_models`。接口项通过显示/隐藏调整可见性，新增上游模型自动进入列表。所有来源都支持用 `custom_models` 补录列表外模型，`origin` 区分接口项和补录项；GLM / DeepSeek 会先做端点验证，补录模型可直接选择请求档位使用，DSH 原生解析目录外模型，其余来源使用 Agent 请求档位；不能用目录白名单挡住用户补录。接口收录同名模型后按接口项管理，不重复展示。

`tokenSourceRuntimeModel(s)` 使用完整能力目录，隐藏不修改会话、`model`、`effort`、slots 或启动配置指纹。`model_custom_remove` 只删除补录项，拒绝删接口项；删除前要求会话不再选用该项，并清理默认模型和 slots 的悬空引用。补录/删除和显示/隐藏均串行写配置，旧面板失效。

大模型目录每页 20 项，`model_page` 回调携带 `panel_id`、`source_id`、`page`，只使用服务端保存的目录快照并校验页码。切页后只接受当前页的模型选择；过期面板拒绝操作。

`md` 等待模型目录刷新完成后生成账号卡。刷新开始会清空能力数据，不能先取此时的空数组生成“0 个模型”卡片；失败状态显示 `MISS`，用户明确清空的就绪列表才显示零项。面板记录实际 `message_id`，在模型列表、添加目录和分页间保持一致。

活跃、续卡和结束 footer 的模型标识共用 `footerModelLabel`，固定为 `agent · 模型名/effort`，Agent id 小写，模型名剥除 `claude:`、`[1m]`；模型或 effort 缺失时显示对应的 `MISS`。footer 的窗口额度保留原格式 `4.1h·7%·[6.9d·17%]`，即重置倒计时与已用百分比，周窗口放在方括号中；不添加“额度 5h 已用”等标签或月度工具明细。结构化余额通过 `unifiedUsageSummary` 显示 `余额 $…` / `余额 ¥…`，控制台仍可展示完整窗口明细。失败明确显示 MISS。

`[claude.models.<name>].model` 保留旧 `claude:<name>` 路由的解析。账号、显示名和模型目录由 Token Source 管理；Claude 槽位映射使用账号的 `slots`。

## Claude 启动配置

GLM、DeepSeek、OpenRouter 等来源先清除冲突的 Anthropic 环境变量（含模型角色、OAuth 和云供应商选择），再注入各自凭据；默认读取 `project`、`local` settings。Claude native 沿用本机环境并读取 `user`、`project`、`local`。Token Source 指定的 settings 来源优先；未绑定 Token Source 时才使用项目 `setting_sources`。给注入凭据的来源加上 `user` 会重新引入本机 settings 中的路由。

`[projects.<name>]` 的 `cwd` 对两个后端生效；`tools`、`setting_sources`、`strict_mcp`、`load_project_mcp` 用于 Claude。主会话默认发现项目 `.mcp.json`。排除 user settings 的 Claude 会话通过 SDK 本地插件加载 daemon 管理的 Skill，安装内容统一由 `managed-skills.ts` 生成。

`[claude].bin` 可指定包装器，路径无效时启动失败。未指定时由 `resolveClaudeExecutableConfig()` 查找本机 Claude 或 SDK native binary，Windows `.cmd`/`.bat` 通过 shell shim 启动。

Claude 使用 `permissionMode: default`：普通工具在 `canUseTool` 中放行，`AskUserQuestion` 等待用户回答。不能改成 `bypassPermissions`，否则 SDK 会绕开提问回调。

## OpenRouter

- 来源 id 为 `openrouter`，通过 factory 注册 `openrouter-setup`。默认根地址 `https://openrouter.ai/api`，粘贴的 `/api/v1` 会规范成 SDK 根地址。API key 注入 `ANTHROPIC_AUTH_TOKEN`，`ANTHROPIC_API_KEY` 显式置空，模型 slug 完整透传，不自动追加 `[1m]`。
- 主会话和委派共用 `agent-launch.ts`，将所选模型传给 `spawnEnv`。辅助角色在进程启动时绑定所选模型，可用 `slots` 配置 opus/sonnet/haiku；主模型后续切换不改动进程启动时的辅助角色。
- 默认列表由 `src/openrouter-defaults.ts` 固定为 Arena Agent Labs 的 2026-09-08 前 12 家代表模型，扣除 OpenAI、Z.ai / GLM、DeepSeek 后共九项，详见[账号与模型](models.md#openrouter)。账号目录来自 `GET /api/v1/models/user`，遵循账号供应商、隐私和 guardrail 设置；过滤被排除厂商、自动路由、非文本输出、无 tools 和 `:batch` 模型。厂商排除也在启动路由和 slot 校验中执行。
- `modelSelection` 保存可见模型 id 和完整允许候选；`models` 只暴露面板可见项。`model_list_open` / `model_add` / `model_remove` 对应接口项显示/隐藏，服务端校验当前页、模式与配置版本。`model_custom_remove` 删除补录记录，不能用于接口项；厂商排除也应用于手动补录。
- `models` 未配置时使用默认十一项，空字符串表示用户主动清空，不能当作未配置。默认模型、effort、slots、Key 及相邻配置节保留；启动和 slots 按完整允许目录验证。上游不再返回的已选项显示 `unavailableReason`，不能启动，但可以删除。
- effort 来自 `reasoning.supported_efforts`，仅暴露 Claude SDK 支持的档位；显式 `null` 表示全部网关档位。没有 effort 选择器的模型使用 `default`，含义是请求不携带 `output_config.effort`，不代表关闭推理，选择模型后直接应用并跳过 effort 卡。其他缺失的默认档位保留 `null`，要求用户明确选择。已选榜单代表模型使用榜单明确的档位或账号目录的默认档位。
- Claude SDK 0.3.251 的 CLI 会为省略 effort 的自定义模型补 `high`，Fable alias 还存在启动档位固定行为。`default` 用显式启动档位解除固定，同时在真实子进程环境设置 `CLAUDE_CODE_EFFORT_LEVEL=unset`；已抓取实际请求验证不发送 effort。`settings.env` 不能替代真实环境，单纯省略选项也不成立。显式 `max` 通过 `effortLevel: 'max'` 下发，不能映射成 `ultracode`。
- `modelEnvironmentRevision` 参与进程配置比较。`default` 与显式档位之间切换需要新进程环境，Session 在空闲时保存并恢复原生 session；相同模式继续走 `setModelSettings`。slots 不能混合两种参数模式，避免辅助任务继承不适用的环境。模型切换不触发 daemon 重启。
- 余额直接来自 `GET /api/v1/credits`：`total_credits - total_usage`，USD。2026-09-10 使用现有推理 Key 实测返回 200，不根据文档中的管理 Key 说明预先拒绝请求。权限以实际 HTTP 结果为准；失败显示 `余额 MISS`，不能改用 `/key` 限额、单 Key 累计用量或旧余额。
- HTTP、网络、畸形响应及无效显式配置均报告失败；目录刷新失败后清空旧能力数据，不改用公开目录或另一模型。Claude 进程禁用模型 fallback。`thinking_tokens` 转为实时估计进度，不计入真实 token 用量；空工具名记录诊断并显示 `MISS`。

接口依据：[Claude Code 接入](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration)、[账号模型目录](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails)、[推理档位](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)、[账户余额接口](https://openrouter.ai/docs/api/api-reference/credits/get-credits)。官方兼容保证限于 Anthropic 第一方供应商，其他模型需另做真实 Agent 会话验证。

### OpenRouter 验证

2026-09-10 使用真实普通 API key 验证了九个默认模型的 Anthropic Messages 工具调用往返，并通过 Claude Agent SDK 执行 `Read`，校验随机文件内容。额外捕获请求中的 model/effort，确认实际路由和面板档位一致；无档位模型不发送 effort。

小米 `default` → Kimi `max` → 小米 `default` 的三阶段测试使用原生 resume，校验 session id 不变、上一轮随机内容保留，以及每轮实际请求参数。腾讯 Hy4 测试中出现过 429，SDK 有限重试后完成；Meta 首次请求要求年龄确认，后续直接接口和 SDK 复测均通过。这些是功能验证，未覆盖长上下文压力、所有工具或所有 OpenRouter 候选模型；本次 SDK 上报的会话窗口为 200K。

最终九模型检查通过 9/9，共核验 19 次 Messages 请求。Qwen 有 1 次工具错误，修正后返回了正确文件内容；探针报告保留 `toolErrors` 和 `httpErrorsRecovered`，不抹去中间错误。

2026-09-11 曾验证字节 Seed 2.1 Turbo、美团 LongCat 2.0、蚂蚁 Ling 3.0 Flash、阶跃 Step 3.7 Flash，SDK 实测通过 4/4，核验 8 次 Messages 请求；全部执行 Read 并返回正确随机值，三次跨模型原生 resume 保留同一会话和上一轮标记。前三项不发送 effort，阶跃发送 high。最终默认列表只追加字节和美团，蚂蚁和阶跃已移出。初测发生过目录连接中断、美团漏答上一轮标记；日志保留，明示双标记要求后复测通过。百度空路由、快手上游 400 的可用性限制见[模型说明](models.md#openrouter)。

可复现实测使用 `scripts/test-openrouter.ts`：显式提供私有 JSON 凭据文件（`api_key`）、输出目录及 `--agent-runtimes` 指向的已安装 Agent 目录，`--capture-requests` 校验实际请求，`--sequence` 验证同一会话按顺序恢复。探针只在私有临时目录操作随机文件；不连接飞书、不启动或重启 daemon。传输失败保留在报告并返回错误响应，最终失败以非零退出码报告。真实密钥、请求正文和 session id 不写入跟踪文件。

`scripts/test-model-panel-live.ts` 用已有 daemon 做群内回调测试：显式指定 `--chat-id` 和 `--extra-model`，通过权限 0600 的本机 debug socket 读取模型状态并注入有限的模型面板动作。服务端绑定已设置的群和操作用户，校验真实卡片所属群、所属应用及面板消息，再交给正常的 Card action admission、去重、群队列和呈现链路；不提供通用方法执行入口。此测试覆盖服务端回调与真实飞书消息更新，客户端点击手势另需人工或 UI 自动化验证。

该脚本会发送测试消息，核验首页分组，临时增删 OpenRouter 模型，并逐一检查其他已启用来源的隐藏、刷新和恢复；选择小米的模型默认档位验证真实回复及 footer，随后恢复原模型设置和列表。失败保留记录并尽力恢复自己产生的修改，群仍忙时拒绝强行切换。原始卡片通过 `card_msg_content_type=raw_card_content` 读取，普通消息接口的兼容文案不能用来判断 schema 2.0 实际内容。布局或协议变更后需在加载新版本的 daemon 上重跑。

2026-09-10 在加载新版代码的 daemon 上完成群内测试：六个已启用来源的首页分组、接口项隐藏/显示与刷新持久化通过；Codex、OpenRouter、DeepSeek Harness、DSH GLM 的列表外补录、MISS 展示与删除通过，GLM / DeepSeek 对无法验证的补录明确拒绝且不写入记录。OpenRouter 完成真实回复，最终 footer 正确显示模型/effort 和账户余额；测试后恢复九项列表及群内原模型。Claude native 当时未启用，其管理行为由七类来源的统一回归测试覆盖。

SDK 结果到达时卡片可能还在异步查询余额，探针需等待同一回复卡的最终 footer，再校验金额与模型信息。第一次探针提前读取导致余额断言失败，原卡稍后正常显示余额；修正等待条件后完整复测通过。`--routes-only --test-source dsh-glm --test-model glm-5.3 --test-effort high` 也已实测，确认正常群回复及 `dsh · glm-5.3/high`、额度展示，并恢复原设置。

## DeepSeek Harness 原生后端

`DshProcess` 启动自动更新到上游 `latest` 的 Node DSH 子进程，以 `sdk` profile 加载 `dsh-bridge` Cordis 插件，替换默认 SDK JSON-RPC server。Lodestar 的 stdio 协议只承载控制和事件；Agent 循环、工具执行、持久化及子 Agent 由 DSH 管理。

Agent 运行依赖由 `src/agent-updates.ts` 独立安装，daemon 启动时及每 6 小时检查 upstream latest，安装成功直接启用，旧任务继续使用各自目录。DSH 子包的 dist-tag 可能不同步，因此从主包最新版本递归读取 dependencies/peerDependencies/optionalDependencies，整族安装该次动态选中的版本。不存在兼容版本白名单；不兼容直接报告并后续适配。`dsh-bridge` 被放入选中运行目录，从同一依赖树加载，握手版本来自实际 package.json。开发依赖和 Bun 锁文件只是本地测试快照，不限制生产更新。普通安全 overrides 同时用于独立运行目录，tarball 验收真实执行更新器、包审计和原生查询。

- `session/open` 完成原生 create/resume/fork 并 flush 后才公布恢复点。`rs` 通过原生持久化服务列出同工作目录会话；`fk/bk` 使用 `turn/end` 的事件序号作为 checkpoint，原生日志验证并加载分叉历史。
- 实时文本来自 `agent/assistant-stream`，工具和计划来自会话事件。进入 idle 后等待持久化完成，再用真实 `turn/end` 原因结算；认证失败、token 耗尽及驱动异常均向调用方报告。
- 子工具返回的内容块数组先转换为后台卡摘要；不能按字符串直接处理。致命桥接错误会把未结束的子任务标记失败，并将进程退出作为异常向用户报告。
- 提问通过 `user-questions/request` 停驻，复用飞书问答卡；回答按原始 question id 返回。主动和自动压缩使用 DSH compaction 服务与事件。
- 模型与 effort 更新在下一轮应用，同一轮的工具续跑保持当前路由。`off` 是 DSH 原生推理选项。
- `dsh-glm` 接入 Coding Plan 的 `/api/coding/paas/v4/models` 与 `/chat/completions`。显式配置优先，否则复用已有 GLM 账号；凭据变化参与 `spawnRevision`。`dsh-runtime` 通过私有 composition patch 启用原生 `llm-pi-ai` 的 `zai-coding-cn` / `zai` 路由并关闭 DeepSeek 适配器，patch 仅记录环境变量名，不写明文 Key。
- GLM 可选列表来自账号接口并合并手动补录，通过 pi-ai models 配置提供请求档位，`supportsReasoningEffort` 明确启用所选档位的传递；本地安装目录未收录的新模型也能使用。`LODESTAR_DSH_*` 控制路由，跨来源先清除冲突环境，不能复用旧的 DeepSeek 凭据或默认模型。
- 每个进程默认读取项目 `.mcp.json` 的 stdio/HTTP MCP，并加载 `.agents/skills`、`.dsh/skills` 和 Lodestar 管理的 Skill。项目 `tools` 和 `load_project_mcp` 对 DSH 生效。
- 图片 MIME 由文件字节识别。飞书下载的 JPEG 可能使用 `.png` 文件名，不能据扩展名声明编码；无法识别的图片明确报错。
- 运行状态保存在 `src/paths.ts` 的 `DSH_HOME_DIR`。不读取用户 DSH settings 或凭据文件；`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL` 由选定账号显式注入。默认 telemetry 插件不加载。
- 委派 worker 与原生子 Agent 均禁止继续派工。主 Agent 的 Lodestar capability 通过原生 ShellEnv 按执行者注入，子 Agent 的 shell 不继承它；Agent CLI 识别这一专用上下文。
- 中断使用不可变原因对象，避免 Node fetch 附加 `stack` 属性后破坏 DSH 的无损 JSON 日志校验。关闭先回收 Agent，再通过协议、stdin EOF 与精确子进程终止确认退出。

需要 Node 22.19+（22.x）或 Node 24+；`[token_source.deepseek-harness].bin` 指定 Node 路径。DSH 是开发者预览版，升级依赖时须同步检查桥接协议并运行原生集成测试。`src/dsh-process.test.ts` 使用真实运行时和本地模拟模型/MCP，不连接飞书或付费 API。

2026-09-10 运行 `bun scripts/test-dsh-glm.ts`，用真实 GLM Coding Plan 的 GLM-5.3 / high 完成 Read 随机文件验证，再创建新进程通过原生 resume 复述原标记，两轮均成功且无错误。测试使用私有临时目录，不连接飞书、不控制 daemon。原生集成测试另核验了 GLM 工具往返、low → max 的实际请求参数和 resume 历史。

接口依据：[GLM Coding Plan 快速开始](https://docs.bigmodel.cn/cn/coding-plan/quick-start)、[DSH 模型供应商配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)。

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
