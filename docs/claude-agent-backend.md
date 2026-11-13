# 后端与模型路由

[返回首页](../README.md) · [账号与模型](models.md) · [安装与配置](configuration.md)

Lodestar 通过 `AgentProcess` 接口连接 Codex app-server、Claude Agent SDK 和 DeepSeek Harness。`Session` 负责群会话、消息排队和卡片；具体进程类负责协议转换。主会话和委派 Agent 共用 `agent-launch.ts` 的启动入口。

## 进程与会话

| 行为 | Codex | Claude Code（含 reclaude、GLM、DeepSeek、OpenRouter、中转站） | DeepSeek Harness |
| --- | --- | --- | --- |
| 进程 | `codex app-server --listen stdio://`，通过 JSON-RPC 通信 | SDK `query()`，通过 `AsyncIterable<SDKUserMessage>` 连续输入 | Node 子进程，通过 Cordis stdio 桥接 |
| 初始化 | 等待初始化和 thread 启动事务完成 | 首条输入才触发 `system/init`；启动时只检查早期错误 | `session/open` 完成原生会话创建或恢复并落盘 |
| 恢复与分叉 | `thread/list`、`thread/fork(lastTurnId)` | 同目录 transcript、`forkSession`、`resumeSessionAt` | 原生持久化服务，以事件序号作为 checkpoint |
| 澄清提问 | `item/tool/requestUserInput` | `canUseTool` 中处理 `AskUserQuestion` | `user-questions/request` |
| 主动压缩 | `thread/compact/start` | 向 streaming input 发送 `/compact`，等待 `compact_boundary` | 原生 compaction 服务与事件 |
| 后台任务 | app-server collab 子 Agent 事件 | SDK `task_*` 事件 | 原生子 Agent 与工具事件 |

会话引用包含 provider、原生 session id 和 cwd。各后端分别保存恢复记录，切换后端不会共用同一段上下文。Claude fork 在首条输入前持久保存启动意图，获得新 session id 后才清除；历史会话通过原生 fork 接入新群，避免两个群写同一个会话。

主动压缩没有固定完成时限，以完成事件为准，进程退出或报错时失败。Claude 只有原生 `compact_boundary` 算压缩成功，普通 `result` 事件不能代替完成通知；其他原生结果都会结束等待：`Not enough messages to compact` 或 `No messages to compact` 视为无需压缩，原生返回的取消、跳过或失败文本按失败显示，等待期间的错误 `result` 和进程退出立即失败。压缩期间收到的 `stop`、`kill`、`restart`、`clear` 会先中断压缩，用户可见行为见[群内命令](usage.md#群内命令)。

## 账号和模型

Token Source 管理账号凭据、模型目录、启动环境、默认模型、effort 和额度。内置来源如下：

| 来源 | 配置和模型目录 |
| --- | --- |
| Codex subscription | 使用 Codex 登录态，模型来自 app-server `model/list` |
| Claude Code 订阅 | `claude-sub` 复用本机原生订阅登录态；通过 SDK `accountInfo()` 确认账号，`supportedModels()` 读取模型和 effort，与第三方来源独立共存 |
| reclaude | 本机找到 `reclaude` 命令即启用，`[token_source.reclaude]` 可选；登录与组织由 reclaude 管理，每次目录刷新经 reclaude 启动 control-only 进程，同时读取原生模型目录和 `/usage` 额度 |
| GLM Coding Plan | `[token_source.glm]` 或本机 Claude settings；模型来自兼容端点，可补录已验证模型 |
| DeepSeek | `[token_source.deepseek]` 或本机 Claude settings；模型来自兼容端点，可补录已验证模型 |
| OpenRouter | `[token_source.openrouter]` 或本机 Claude settings；默认精选六个家族最新版（含 Gemini Flash、MiMo Pro），账号目录验证能力，MD 面板维护显隐 |
| 通用中转站 | `[relay.<site_id>]`；`anthropic` 站点用于 Claude Code，`openai` 站点提供 Codex 和 DeepSeek Harness 两个来源视图 |
| DeepSeek Harness | `[token_source.deepseek-harness]`；模型、effort 与上下文容量来自当前安装的 DSH 原生目录 |
| DSH GLM Coding Plan | `[token_source.dsh-glm]` 或复用 `glm`；账号接口返回模型，DSH 原生适配器提供能力和推理档位 |

Claude 订阅统一由 `claude-sub` 管理登录验证、模型目录和额度，在 `md` 中选择“Claude Code 订阅”。

`claude-accounts.ts` 管理默认及按 `hi 备注` 首次收录的账号元数据，原生登录由用户手动完成；来源内部使用独立账号视图、模型目录和额度缓存。MD 汇总可用账号目录，启动时再校验实际选中的账号；默认账号未登录不会遮住已收录的可用账号。`claude-account-selection.ts` 只在启动时选号，不负责耗尽轮换。主会话首次提交输入前完成原生身份验证，账号实际变化会使旧模型/额度缓存失效。

新增备注账号持久化经过 `authenticating`、`syncing`，首次 Skills/插件同步及共享历史准备完成后才进入 `ready`。认证后保留同一个 control-only 进程等待同步，最长 120 秒；普通模型、额度查询和任务启动只接受 ready 账号，已有默认账号会话继续运行。失败记录为 `sync_failed`，保留原因和重试时间，用户通过 `hi 备注` 显式重试；不随每分钟额度刷新重启同步进程。中断后保留未完成状态，旧版 `enrolling` 记录仍可通过显式收录恢复。原生控制查询不提交用户输入，但初始化仍会触发云同步，因此不能在首次认证完成后立即关闭进程。

`claude-sync-warmup.ts` 核对原生身份对应的账号桶，要求 Skills 和插件各自有成功轮次标记、清单所列文件落地、待处理项和暂存目录清空，且连续两次间隔至少 5 秒的检查保持一致。原生复用此前成功轮次时，允许认证桶与启动前已完成快照完全一致；空远端集合有成功标记即可完成，不要求与默认账号技能集合相同。用户设置或本次启动设置显式关闭相应云同步时跳过该通道；缺目录、服务端未开放同步或未知文件格式不能推断为关闭，缺少完成证据仍超时报错。当前 SDK 无公开同步完成事件，检测依赖原生落盘标记，后续原生格式变化需适配。

`session-activity.ts` 按实际存活的 Claude 订阅进程与账号绑定统计会话：执行中或最近 30 分钟收到用户消息即为活跃，启动、等待回答、排队和后台任务也计入；同群去重，当前待启动群排除后再加一。消息时间持久化，重启后可恢复近期活跃判断，不保存消息内容。

`claude-quota.ts` 以完整 5h 额度为一份，所有账号统一：普通完整周窗口、OAuth 及模型专属周窗口为 10 份，Fable 专属周窗口为 5 份（总周的一半）。接口返回 `five_hour: null`（或没有该字段，且聚合 `limits[]` 没有 `session` 桶）表示这个账号已经取消 5 小时限额，按周额度单窗口处理，不补 0%、不补窗口时间，也不显示 `MISS`；`limits[]` 明确列出 `session` 时仍按缺值 `MISS`。5h、总周及实际返回的 OAuth、当前模型专属窗口均参与约束；缺值、重复、无效或过期重置时间均为 `MISS`，Fable 模型缺少唯一专属周也不参与选号。账号余量取这些窗口中最小的剩余份数。Fable 与其他模型分开分配：Fable 模型同时受总周和专属周约束；其他模型在距总周重置超过 2 天时，总周剩余中相当于 Fable 尚未使用份额的部分只按四分之一计入余量和节奏（`own = max(0, 剩余 − 预留)`，`room = own + 0.25 × (剩余 − own)`），距重置不超过 2 天释放预留。预留只依据接口实际返回的唯一 Fable 专属周窗口，缺失时不猜测；仍在预留期但专属周重复或数值无效时同样按 `MISS` 排除，专属周已用完时不再预留。折价只会降低排名，随余量连续变化、不分档，预留也不会使账号耗尽。任一适用窗口已用满才是真实耗尽，不参与正常选号，同时给出 `recoversAt`：全部用光窗口中最晚的重置时间（缓存里已过期的时间照用），任一缺失则为 `null`。通过模型和档位校验的账号全部真实耗尽时，`claude-account-selection.ts` 沿用恢复会话的原账号（须在耗尽账号中），否则选 `recoversAt` 最早的耗尽账号，`null` 排最后，同值按账号列表顺序（默认账号在前）。

令已有活跃负载单位为 `N`（每个活跃会话算一份，会话里运行中的原生子 Agent 每个再算一份）。每个适用窗口的节奏为 `room / span`，`span` 取距重置小时数且至少 1 小时（请求是突发的，快重置的窗口仍须撑一小时）：5h 窗口 `span = clamp(小时数, 1, 5)`，跟上节奏（已用比例不超过已过时间比例，也不超过 80%）的窗口都与满窗同分；尚未启动的窗口（`claudeFiveHourUnstarted` 识别读取时的估算）按 `span = 5`、到期时间为当前时间加 5 小时计，不因快照变旧而显得紧迫；有 5h 窗口的账号逐窗花周额度，周类窗口 `span = clamp(小时数, 1, 24)`，周额度须够按满窗节奏撑过一天或撑到重置，距重置一天以上时剩不到 4.8 份即降权，5h 窗口有余量、周额度够用时这类账号一般排在只有周额度的账号之前；没有 5h 窗口的账号周类窗口 `span = max(小时数, 1)`，离重置远或快用完的周额度节奏低。账号节奏 `pace` 取各窗口最小值，`score = min(pace, 0.2) / (N+1)`：每次启动最多按每 5 小时一个满窗计，因为会话在窗口或周重置后仍留在原账号继续消耗，快作废的额度最多与满窗并列，不能把新任务都吸走。`compareClaudeQuota` 依次比较：分数降序、活跃负载升序、`pace` 降序（额度更需要尽快花掉的优先）、到期时间升序（有 5h 窗口取其重置时间，否则取该模型实际生效的周额度重置时间）、余量降序，其余保持账号列表顺序；不按有无 5h 窗口、重置先后或是否动用 Fable 预留整组排队。这里不预测任务用量，也不设 `fits`/`pressure`（Fable 预留按距总周重置不超过 2 天释放）；计算不改真实额度，显式指定账号不经过这套自动排序。

各账号共享默认目录下的 `projects`、`tasks`、`file-history`、`plans`，凭据与账号设置各自独立。`claude-session-lease.ts` 按共享历史真实路径和原生 session ID 管理 daemon 内的写入互斥：新会话和分叉先分配原生 UUID，恢复沿用原 ID，分叉在原生初始化完成前还保护源会话。只有确认原生进程退出才释放写入权；纯账号/模型/额度控制查询不取得写入权，不允许提交用户任务。历史路径按实际 cwd 归一化，兼容长路径编码及原生项目目录名覆盖。

`model` 按 Claude Code、Codex、DeepSeek Harness 分组，组 ID 由 `ELEMENTS.modelAgentGroup` 生成。两个 Agent 下的 DeepSeek 来源都显示为 DeepSeek，协议 id 保持不变。选账号后进入模型列表；多个档位才展示 effort 卡，只有一个档位时直接应用，获取失败显示 `MISS`。同 provider/source 的切换调用 `setModelSettings`：Claude 和 DSH 从后续 turn 使用，Codex 保存选择并在重启进程后应用。跨 provider/source 或需要变更项目启动配置时，只能在空闲状态更换进程。

OpenRouter 保持自己的精选模型规则。通用中转站只按站点协议读取 `/v1/models`，每个站点按其协议生成可用 Agent 来源；`openai` 站点的 Codex 与 DSH 视图共享 Key 和地址，但分别使用 Responses 与 OpenAI Completions。

`tokenSourceRuntimeModel(s)` 使用完整能力目录，隐藏不修改会话、`model`、`effort`、slots 或启动配置指纹。`model_custom_remove` 只删除补录项，拒绝删接口项；删除前要求会话不再选用该项，并清理默认模型和 slots 的悬空引用。补录/删除和显示/隐藏均串行写配置，旧面板失效。

大模型目录每页 20 项，`model_page` 回调携带 `panel_id`、`source_id`、`page`，只使用服务端保存的目录快照并校验页码。切页后只接受当前页的模型选择；过期面板拒绝操作。

`md` 等待模型目录刷新完成后生成账号卡。刷新开始会清空能力数据，不能先取此时的空数组生成“0 个模型”卡片；失败状态显示 `MISS`，用户明确清空的就绪列表才显示零项。面板记录实际 `message_id`，在模型列表、添加目录和分页间保持一致。

活跃、续卡和结束 footer 的模型标识共用 `footerModelLabel`，固定为 `agent · 模型名/effort`，Agent id 小写，模型名剥除 `claude:`、`[1m]`；模型或 effort 缺失时显示对应的 `MISS`。footer 的窗口额度保留原格式 `4.1h·7%·[6.9d·17%]`，即重置倒计时与已用百分比，周窗口放在方括号中；Claude 订阅账号没有 5h 窗口时省略该段，只显示 `[6.9d·17%]`，不补 `MISS`。不添加“额度 5h 已用”等标签或月度工具明细。结构化余额通过 `unifiedUsageSummary` 显示 `余额 $…` / `余额 ¥…`，控制台仍可展示完整窗口明细。失败明确显示 MISS。

`[claude.models.<name>].model` 保留旧 `claude:<name>` 路由的解析。账号、显示名和模型目录由 Token Source 管理；Claude 槽位映射使用账号的 `slots`。

## Claude 启动配置

GLM、DeepSeek、OpenRouter 等来源先清除冲突的 Anthropic 环境变量（含模型角色、OAuth 和云供应商选择），再注入各自凭据；默认读取 `project`、`local` settings。Claude Code 订阅读取 `user`、`project`、`local`，通过进程级 `settings` 覆盖冲突路由和 API key helper，不改本机文件；SDK `accountInfo()` 确认第一方订阅后才向 streaming input 放行用户输入。Token Source 指定的 settings 来源优先；未绑定 Token Source 时才使用项目 `setting_sources`。给注入凭据的来源加上 `user` 会重新引入本机 settings 中的路由。

`[projects.<name>]` 的 `cwd` 对所有后端生效；`setting_sources`、`strict_mcp` 用于 Claude，`tools`、`load_project_mcp` 用于 Claude 和 DSH 主会话。Claude 主会话默认发现项目 `.mcp.json`。排除 user settings 的 Claude 会话通过 SDK 本地插件加载 daemon 管理的 Skill，安装内容统一由 `managed-skills.ts` 生成。

`[claude].bin` 可指定包装器，路径无效时启动失败；Windows `.cmd`/`.bat` 通过 shell shim 启动。未指定时使用独立运行目录中的 Claude Agent SDK 默认入口及其自带程序。

### reclaude 启动器

reclaude 来源（用户说明见[账号与模型](models.md#reclaude)）不直接启动 Claude Code，而是通过 SDK 的 `spawnClaudeCodeProcess` 改写启动命令（`src/claude-launcher.ts`），主会话、目录与额度查询共用同一启动器：

- 命令为 `reclaude --org <组织 ID> cli <Claude Code 参数>`。组织 ID 取自最近一次目录刷新选定的绑定，显式传入，避免两次刷新之间切换默认组织导致进程与记录的目录不一致。
- SDK 选定的 Claude Code 可执行文件所在目录被放在 `PATH` 最前，reclaude 因此启动的是 SDK 期望的那份受管运行时，而不是本机另一份安装。SDK 入口不是名为 `claude` 的可执行文件（例如 `[claude].bin` 指向脚本入口）时拒绝启动。
- 环境先清除其他来源的 `ANTHROPIC_*` 变量，`CLAUDE_CONFIG_DIR` 设为 reclaude 数据目录中该组织绑定的配置目录，transcript、`rs` 历史、恢复和上下文用量都读取进程实际写入的位置。组织绑定（设备号）计入进程环境版本，绑定变化后空闲进程在下一轮前替换。
- settings 来源与其他第三方来源相同，为 `project`、`local`，Lodestar 管理的 Skill 通过本地插件加载；目录与额度查询的 control-only 进程使用 `user`。
- 启动器的 stderr 只保留以 `reclaude:` 开头的诊断行（最多 4 行），其余原生 stderr 丢弃，因为交接后它可能包含提示词、路径和账号信息。reclaude 在交给 Claude Code 之前失败时，SDK 只报退出码，Lodestar 把这些诊断行附在显示给用户的错误后面。
- reclaude 与 `claude-sub` 一样按订阅使用处理，在 Agent 身份目录和委派新建/续跑入口中按来源类型排除（`src/agent-identities.ts`）。
- 测试环境（`NODE_ENV=test`）不探测本机真实的 reclaude。

Claude 使用 `permissionMode: default`：普通工具在 `canUseTool` 中放行，`AskUserQuestion` 等待用户回答。不能改成 `bypassPermissions`，否则 SDK 会绕开提问回调。

Lodestar 每次启动 Claude SDK 子进程时自动设置 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`，让新版 Claude 及第三方模型继续提供任务清单工具。安装或升级后无需手动修改配置，已有进程需重新启动后生效。任务创建和状态更新显示在会话卡片中，是否使用清单由 Agent 判断，项目 `tools` 限制仍生效。

## OpenRouter

- 来源 id 为 `openrouter`，通过 factory 注册 `openrouter-setup`。默认根地址 `https://openrouter.ai/api`，粘贴的 `/api/v1` 会规范成 SDK 根地址。API key 注入 `ANTHROPIC_AUTH_TOKEN`，`ANTHROPIC_API_KEY` 显式置空，模型 slug 完整透传，不自动追加 `[1m]`。
- 主会话和委派共用 `agent-launch.ts`，将所选模型传给 `spawnEnv`。辅助角色在进程启动时绑定所选模型，可用 `slots` 配置 opus/sonnet/haiku；主模型后续切换不改动进程启动时的辅助角色。
- 默认家族及版本筛选由 `src/openrouter-defaults.ts` 定义，共六个家族，详见[账号与模型](models.md#openrouter)。每 5 分钟目录刷新时按数字版本、发布日期选择最新模型，保留接口 ID；Hy 允许 preview 且同版本优先正式版，其他家族不自动纳入 preview。free、thinking、Flash Lite、ultraspeed 等变体须显式显示。账号目录来自 `GET /api/v1/models/user`，遵循账号供应商、隐私和 guardrail 设置；过滤 OpenAI、GLM、DeepSeek 等被排除厂商、自动路由、非文本输出、无 tools 和 `:batch` 模型。厂商排除也在启动路由和 slot 校验中执行。
- `modelSelection` 保存可见模型 id 和完整允许候选；`models` 只暴露面板可见项。`model_list_open` / `model_add` / `model_remove` 对应接口项显示/隐藏，服务端校验当前页、模式与配置版本。`model_custom_remove` 删除补录记录，不能用于接口项；厂商排除也应用于手动补录。
- `models` 未配置时使用六家族自动精选；显隐以 `shown_models` / `hidden_models` 保存增量，自动精选项同时记录 `family:` 家族键与当前 ID，保持后续版本和已隐藏旧默认的隐藏状态；手动显示的旧版本仍按 ID 管理。已有 `models` 是固定列表，空字符串表示用户主动清空，不能当作未配置。默认模型、effort、slots、Key 及相邻配置节保留；启动和 slots 按完整允许目录验证。上游不再返回的已选项显示 `unavailableReason`，不能启动，但可以删除。
- effort 来自 `reasoning.supported_efforts`，仅暴露 Claude SDK 支持的档位；显式 `null` 表示全部网关档位。没有 effort 选择器的模型使用 `default`，含义是请求不携带 `output_config.effort`，不代表关闭推理，选择模型后直接应用并跳过 effort 卡。其他缺失的默认档位保留 `null`，要求用户明确选择。自动精选家族沿用明确的默认档位偏好；新版本仍需上游声明支持该档位，否则保留 `null`，不自动降档。
- `default` 用显式启动档位配合子进程环境中的 `CLAUDE_CODE_EFFORT_LEVEL=unset`，避免 CLI 为请求补上 effort。`settings.env` 不能替代真实环境，单纯省略 SDK 选项也不成立。显式 `max` 通过 `effortLevel: 'max'` 下发，不能映射成 `ultracode`。
- `modelEnvironmentRevision` 参与进程配置比较。`default` 与显式档位之间切换需要新进程环境，Session 在空闲时保存并恢复原生 session；相同模式继续走 `setModelSettings`。slots 不能混合两种参数模式，避免辅助任务继承不适用的环境。模型切换不触发 daemon 重启。
- 余额直接来自 `GET /api/v1/credits`：`total_credits - total_usage`，USD。权限以实际 HTTP 结果为准；失败显示 `余额 MISS`，不能改用 `/key` 限额、单 Key 累计用量或旧余额。
- HTTP、网络、畸形响应及无效显式配置均报告失败；目录刷新失败后清空旧能力数据，不改用公开目录或另一模型。Claude 进程禁用模型 fallback。`thinking_tokens` 转为实时估计进度，不计入真实 token 用量；空工具名记录诊断并显示 `MISS`。

接口依据：[Claude Code 接入](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration)、[账号模型目录](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails)、[推理档位](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)、[账户余额接口](https://openrouter.ai/docs/api/api-reference/credits/get-credits)。官方兼容保证限于 Anthropic 第一方供应商，其他模型需另做真实 Agent 会话验证。

## DeepSeek Harness 原生后端

`DshProcess` 使用当前安装的运行目录启动 Node DSH 子进程，以 `sdk` profile 加载 `dsh-bridge` Cordis 插件，替换默认 SDK JSON-RPC server。启动补丁先读取所装 `@deepseek-ai/dsh-sdk-app/cordis.patch.yml`：profile 已自带 ask-user 工具时不再插入同插件（重复注册会让 DSH 启动失败），读取不到时保留插入以兼容旧版。0.2.2 起模型接入链需要的 credentials 服务保持启用，凭据仍只由 Lodestar 注入的环境变量提供，不写登录态。Lodestar 的 stdio 协议只承载控制和事件；Agent 循环、工具执行、持久化及子 Agent 由 DSH 管理。

Agent 运行依赖由 `src/agent-updates.ts` 独立安装，更新命令、自动更新开关、版本目录和失败处理见[安装与配置](configuration.md#agent-更新)。DSH 子包的 dist-tag 可能不同步，因此从主包最新版本递归读取 dependencies/peerDependencies/optionalDependencies，整族安装该次动态选中的版本。不存在兼容版本白名单；不兼容直接报告并后续适配。`dsh-bridge` 被放入选中运行目录，从同一依赖树加载，握手版本来自实际 package.json。开发依赖和 Bun 锁文件只是本地测试快照，不限制生产更新。普通安全 overrides 同时用于独立运行目录，tarball 验收真实执行更新器、包审计和原生查询。

- `session/open` 完成原生 create/resume/fork 并 flush 后才公布恢复点。`rs` 通过原生持久化服务列出同工作目录会话；`fk/bk` 使用 `turn/end` 的事件序号作为 checkpoint，原生日志验证并加载分叉历史。
- 实时文本来自 `agent/assistant-stream`，工具和计划来自会话事件。进入 idle 后等待持久化完成，再用真实 `turn/end` 原因结算；认证失败、token 耗尽及驱动异常均向调用方报告。
- 模型给出的工具参数不是合法 JSON 对象时不结束会话：工具输入按 `{ raw: <原文> }` 展示，由 DSH 返回自身的工具错误，本轮继续。启动失败时删除已创建的临时启动目录。
- 子工具返回的内容块数组先转换为委派面板内的步骤摘要；不能按字符串直接处理。致命桥接错误会把未结束的子任务标记失败，并将进程退出作为异常向用户报告。
- 提问通过 `user-questions/request` 停驻，复用飞书问答卡；回答按原始 question id 返回。主动和自动压缩使用 DSH compaction 服务与事件。
- 模型与 effort 更新在下一轮应用，同一轮的工具续跑保持当前路由。`off` 是 DSH 原生推理选项。
- `dsh-glm` 接入 Coding Plan 的 `/api/coding/paas/v4/models` 与 `/chat/completions`。显式配置优先，否则复用已有 GLM 账号；凭据变化参与 `spawnRevision`。`dsh-runtime` 通过私有 composition patch 启用原生 `llm-pi-ai` 的 `zai-coding-cn` / `zai` 路由并关闭 DeepSeek 适配器，patch 仅记录环境变量名，不写明文 Key。
- GLM 可选列表来自账号接口并合并手动补录，通过 pi-ai models 配置提供请求档位，`supportsReasoningEffort` 明确启用所选档位的传递；本地安装目录未收录的新模型也能使用。`LODESTAR_DSH_*` 控制路由，跨来源先清除冲突环境，不能复用旧的 DeepSeek 凭据或默认模型。
- 每个进程默认读取项目 `.mcp.json` 的 stdio/HTTP MCP，并加载 `.agents/skills`、`.dsh/skills` 和 Lodestar 管理的 Skill。项目 `tools` 和 `load_project_mcp` 对 DSH 生效。
- 图片 MIME 由文件字节识别。飞书下载的 JPEG 可能使用 `.png` 文件名，不能据扩展名声明编码；无法识别的图片明确报错。
- 运行状态保存在 `src/paths.ts` 的 `DSH_HOME_DIR`。不读取用户 DSH settings 或凭据文件；`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL` 由选定账号显式注入。默认 telemetry 插件不加载。
- 委派 worker 与原生子 Agent 均保留继续派工能力。Lodestar 调用上下文通过原生 ShellEnv 传给当前 Agent 及其后代，Agent CLI 使用它保留项目、对话 ID（`chat_id`）和任务归属。
- 中断使用不可变原因对象，避免 Node fetch 附加 `stack` 属性后破坏 DSH 的无损 JSON 日志校验。关闭先回收 Agent，再通过协议、stdin EOF 与精确子进程终止确认退出。

需要 Node 22.19+（22.x）或 Node 24+；`[token_source.deepseek-harness].bin` 指定 Node 路径。DSH 是开发者预览版，升级依赖时须同步检查桥接协议并运行原生集成测试。`src/dsh-process.test.ts` 使用真实运行时和本地模拟模型/MCP，不连接飞书或付费 API。

接口依据：[GLM Coding Plan 快速开始](https://docs.bigmodel.cn/cn/coding-plan/quick-start)、[DSH 模型供应商配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)。

## 共享事件和委派

各进程类将原生文本、工具、结果、用量、压缩和后台任务转换成 `AgentProcess` 事件。共享事件由 Session 和卡片消费，保留各后端在初始化、上下文和后台任务上的差异。

主 Agent、委派 Agent 和原生子 Agent 均可继续派工，不设置 Lodestar 委派层数上限，也不禁用各后端原生委派工具。Lodestar Agent 不支持调用 Claude 订阅，遵守 Claude 用户协议；中转站等第三方来源的 Claude 模型仍可调用。限制仅按来源 ID 与类型判断，不按模型名称或显示名判断，主会话的 Claude 订阅能力不受影响。Skill、worker 提示词和运行时入口保持一致；项目调用的非交互要求及调用方负责交付的规则沿委派链继承。Lodestar 后续任务记录当前调用方作为父任务，续跑来源单独记录，取消沿父子关系传播。运行状态原子落盘，大段输入输出单独存放；委派会话登记后从主会话的历史列表中排除。

委派、原生子 Agent 和后台任务由同一个 `AgentCards` 实例展示。每项仅显示状态和一句说明，类型、进度、任务正文、结果、待回答问题及失败原因放在折叠体内，动作只展示最近三步。原生子 Agent 启动即展示，普通前台命令仍在观察池中；启动工具和 SDK task id 关联后只保留一项。

按对话 ID 定位消息尾部的委派卡，复用至容量用满或出现新消息。发新主卡和中途换卡时，先把旧卡上的未完成任务行清走（已完成行留作历史），新卡落地后再在末尾重建一张委派卡；之后的任务进度只写这张新卡。Card Kit 生命周期由共享卡片统一结算，停止主进程只结算其所属任务，不关闭仍有委派执行的共享卡；不展示 depth、session id 或 request id。

## 源码与验证

- 启动与协议：`src/agent-launch.ts`、`src/agent-process.ts`、`src/codex-process.ts`、`src/claude-agent-process.ts`、`src/dsh-process.ts`、`src/dsh-runtime.ts`、`src/dsh-bridge.ts`。
- 路由与配置：`src/token-source*.ts`、`src/session-model.ts`、`src/config.ts`、`src/claude-models.ts`。
- 会话分支：`src/conversation.ts`、`src/session-temp.ts`、`src/temp-session-runtime.ts`、`src/feishu.ts`。
- 委派：`src/agent-service.ts`、`src/agent-runner.ts`、`src/agent-session-registry.ts`。

本地检查使用 `bun run typecheck`、`bun test` 和 `bun run build`。真实后端与飞书交互使用以下探针，运行前阅读[脚本说明](../scripts/AGENTS.md)，明确账号、目标群和允许的副作用。

| 脚本 | 验证内容与运行条件 |
| --- | --- |
| [test-openrouter.ts](../scripts/test-openrouter.ts) | 真实 API/SDK 工具调用、model/effort 参数与原生 resume；显式提供私有凭据、输出目录和 `--agent-runtimes`，不连接飞书 |
| [test-dsh-glm.ts](../scripts/test-dsh-glm.ts) | 使用已配置的 GLM Coding Plan 验证 DSH 工具调用与原生 resume，只操作私有临时目录，不连接飞书 |
| [test-model-panel-live.ts](../scripts/test-model-panel-live.ts) | 在指定群和已有 daemon 上验证模型面板回调、显示/隐藏、补录/删除及回复；发送测试消息并临时修改模型设置，结束后恢复 |

模型面板探针覆盖服务端回调与真实飞书消息更新；客户端点击手势需另外验证。校验卡片时读取 `raw_card_content`，并等待同一回复卡的最终 footer；布局或协议变更后需在加载新代码的 daemon 上重新验证。
