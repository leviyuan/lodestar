# 账号、模型与 effort

[返回首页](../README.md) · [安装与配置](configuration.md) · [群内用法](usage.md)

账号配置使用 `[token_source.glm]`、`[token_source.deepseek]` 等节。GLM、DeepSeek 和 OpenRouter 也可以从本机 Claude settings 中识别；识别后由对应 Token Source 注入凭据，避免不同账号的环境变量串用。项目的工具限制只作用于主会话，委派 Agent 使用完整工具集。

## 配置 API Key

GLM Key 可在首次安装时跳过，之后用群命令添加或更换。以下命令先返回回执，后台向对应平台校验凭据，通过后才保存；认证、网络或响应错误均保留原配置并给出原因。校验无需调用付费模型，也不要求先安装对应 Agent。

| 账号 | 群命令 |
| --- | --- |
| 智谱 GLM（两个 Agent 共用） | `glm-setup <api_key>` |
| Z.ai GLM（两个 Agent 共用） | `glm-setup https://api.z.ai/api/anthropic <api_key>` |
| DeepSeek（两个 Agent 共用） | `deepseek-setup [base_url] <api_key>` |
| OpenRouter | `openrouter-setup [base_url] <api_key>` |
| 通用中转站 | `relay-setup <site_id> <anthropic|openai> <base_url> <api_key>` |
| 中转站余额脚本 | `relay-balance-setup <site_id> <script_path>` |
| DeepSeek 旧命令，同样更新共享账号 | `deepseek-harness-setup [base_url] <api_key>` |
| GLM 旧命令，同样更新共享账号 | `dsh-glm-setup [base_url] <api_key>` |

`[base_url]` 表示可选参数，命令中不输入方括号；API Key 只填原值，不加 `Bearer`。`glm-setup <base_url> <api_key>` 的原有格式仍可使用，GLM 的 Key 与平台地址必须对应。保存后发送 `md` 选择模型。账号配置由本机所有群共用，更新 Key 保留已有模型、档位和可见性设置。

凭据校验通过后会明确返回“配置已保存”，模型目录和额度随后在后台加载；若 Agent 未安装或目录刷新失败，`md` 显示具体错误。处理后等待后台刷新即可。认证失败会提示核对 Key，网络失败会提示检查连接和代理，不会将错误正文误报为“缺少 data 数组”。

## 选择与管理模型

发送 `model`（`md`），在 Claude Code、Codex、DeepSeek Harness 分组下选择账号，再选择模型。首页直接使用缓存；手动点开账号模型列表时立即发起目录查询，卡片显示刷新状态，完成后呈现目录。有多个推理档位（effort）时继续选择档位，只有一个档位时直接应用。

Codex 订阅的模型目录和额度主动轮询均为每 2 小时；其他来源仍为模型目录每 5 分钟、额度每 60 秒。daemon 启动时完成首次预热。`md` 首页、`hi`、账号列表、Agent 身份目录、自动选号和回复页脚都直接读取已提交缓存。手动进入账号模型列表会额外查询，但不会占住其他交互；翻页和显隐后的列表重绘复用快照。Codex 邮箱复用后台原生账号查询的结果。

这些周期和主动查询流量预算仅约束 Lodestar 的定时轮询。常驻 Codex 自身刷新、用户手动拉取模型列表属于允许额外消耗的被动刷新，不受主动周期限制。同账号有运行中的 Codex 进程时，额度复用已有连接，每分钟兜底刷新，并在额度通知和回合结束时及时回读。无运行进程、也没有用户按需操作时，其他地方的消费变化可能到下次主动查询才显示。

同一来源和账号的并发刷新会合并，刷新完成后一次更新缓存。网络或限流失败保留成功快照，错误写入日志，目录刷新错误也会显示在模型面板；Codex 订阅失败后至少等待对应正常刷新间隔；其他来源按 1、2、4、5 分钟退避，均遵守平台更长的限流冷却。没有缓存或认证已失效时立即显示加载中或 `MISS`。修改凭据会隔离并清除受影响账号的缓存，旧请求结果不能覆盖新配置；其他账号继续可用。

| 操作 | 作用 |
| --- | --- |
| 选 | 使用该模型，按需继续选择推理档位 |
| 隐 / 显 | 隐藏或显示接口目录中的模型，不改变当前运行模型 |
| 补录模型 | 添加接口目录外的模型，可选择推理档位并使用 |
| 删 | 删除补录记录；仍有会话选用时需先切换模型 |

OpenRouter 保持自己的精选和模型管理规则。通用中转站按站点协议读取 `/v1/models`，不绑定具体厂商；`anthropic` 站点提供 Claude Code，`openai` 站点同时提供 Codex 和 DeepSeek Harness。模型选择为“中转站 → 站点 → 模型 → effort”。

同账号切换 Claude 或 DSH 模型从后续回复生效；Codex 的持久设置需重启会话生效。跨账号或后端切换只允许在空闲时进行。来源禁用或目录获取失败显示 `MISS`。

模型设置超过 20 秒仍未收到后端确认时，面板显示“确认中”，最终结果回到原卡；等待期间仍可回答 Agent 提问或用 `stop` 打断任务，取消切换需发 `kill` 或 `restart`。模型和思考档位全部确认后才保存选择。若只有模型切换成功，或后端已应用但保存失败，会分别显示实际结果和错误，未确认的值显示 `MISS`；后续输入暂停，重新发送 `md` 完成选择后再继续。已有排队消息保留，设置确认后再提交。

## 额度

发送 `hi` 查看全部已配置账号的额度，一账号一行。Codex 按备注展示主额度窗口及“重置”次数，不展示 Spark、gpt-reserve；Claude 订阅保留主窗口和模型专属周额度；GLM 月工具仅显示已用百分比，DeepSeek、OpenRouter 显示余额。DeepSeek、GLM 的两个 Agent 入口各合并为一行。

所有群、Agent、`hi`、账号列表、页脚和自动选号共用账号级缓存。Codex 订阅模型目录和额度均每 2 小时主动刷新，其他来源仍为 5 分钟和 60 秒；普通交互只读已提交缓存，手动打开模型列表允许立即额外查询，同账号并发刷新合并。启动首次预热及显式首次收录账号可以等待查询完成。用户任务启动或真实耗尽换号若没有可选缓存，可立即按需回读一次；已知真实重置时间到达时可再确认一次，普通等待循环不额外冷查询。Codex 订阅主动查询失败后至少等待 2 小时；运行连接的被动额度刷新使用共享的 1、2、4、5 分钟失败冷却；其他来源失败后冷却 1 分钟，连续失败依次延长为 2、4、5 分钟。上游提供更长的 `Retry-After` 时遵守其等待时间。Codex 额度查询遇到瞬态连接错误时，在同一次共享查询内最多尝试 3 次，间隔 1 秒、4 秒；真实限频、认证失败及无效响应不立即重试，最终失败后进入冷却，冷却期间返回已有错误。重新登录、删除 Codex 账号或显式使用重置卡会使对应缓存失效；使用重置卡后重新查询实际额度。

回复底部显示 `agent · 模型名/effort`，其中 Agent 为 `claude`、`codex` 或 `dsh`。窗口额度如 `4.1h·7%·[6.9d·17%]`，分别表示重置倒计时与已用百分比，方括号内为周窗口；余额显示 `余额 $12.34` 或 `余额 ¥12.34`。Codex 刷新失败或进程已退出时，回复底部按原格式保留同账号上次成功的额度。没有成功缓存、登录认证失败或缓存已被重新登录、删除账号、额度重置操作清除时显示 `MISS`。Codex 的 `hi`、`codex-accounts` 额度区域在网络或限流导致刷新失败时也保留成功缓存，账号列表仍展示本次调度失败原因。

Codex 启动和换号优先使用最近一次成功的额度缓存；能选出账号就直接启动，不等待其他账号刷新；没有可用缓存时明确显示 MISS，后台继续刷新。其他账号未参与选号的诊断保留在日志和 `codex-accounts` 中，不主动发送“部分账号 MISS”警告。只有无法启动或继续任务时，才主动展示相应失败或等待状态。

## Claude Code 订阅

在运行 Lodestar 的本机通过 `claude auth login` 登录 Claude 订阅后，发送 `md` → Claude Code → **Claude Code 订阅**。来源 id 为 `claude-sub`，可与 GLM、DeepSeek、OpenRouter 同时使用；无需复制登录凭据或填写 API key。

额外账号由用户自行登录，目录固定为 `~/.claude-accounts/备注名`。例如：

```bash
# desc: 手动登录备注为工作号的 Claude 订阅
lodestar-claude 工作号 auth login
```

`lodestar-claude <备注> [原生参数...]` 选择对应账号目录并将其余参数传给原生 Claude Code。上例的账号目录与 `CLAUDE_CONFIG_DIR="$HOME/.claude-accounts/工作号" claude auth login` 一致。命令本身不收录账号；首次登录前会准备共享配置，已有目录的非登录内容会替换为全局共享配置。登录后仍需在群内发送 `hi 工作号`。

该入口仅供用户本机终端使用，受管 Agent 上下文中拒绝启动；使用 Lodestar 当前选中的已安装 Claude 运行时，缺失时报错，不自动安装或回退。它保留终端的 `HOME` 和工作目录；`default` 保留终端 `CLAUDE_CONFIG_DIR` 的未设置状态或原始路径，不读取 `[claude.env]`。

在 Claude Code 会话发送 `hi 工作号`，Lodestar 只检查这个备注对应的目录。新增备注账号通过原生订阅身份验证后，卡片显示“已登录，正在完成首次同步”，保留认证进程等待 Skills 和插件云同步完成，再收录并启动；不会扫描其他目录或代办登录。首次同步最长等待 120 秒，期间不查询该账号的模型或额度、不参与自动选号，也不能启动任务或切换到该账号。失败保留账号和原因，按提示稍后再次发送 `hi 工作号` 重试；连续失败的重试间隔依次为 1、2、4、5 分钟，不由后台额度轮询自动重试。`hi default` 指定原生默认账号。指定账号只影响本次启动；同号正在运行时显示状态，忙碌时不能切换其他号，空闲时可用 `hi 另一备注` 切换并恢复原会话。

不指定账号时，启动从默认及已收录账号的模型和额度缓存中选择。5 小时、总周以及接口实际返回的 OAuth 应用周窗口、当前模型专属窗口都必须可用：已用百分比须在 `0%` 到 `100%` 之间（不含 `100%`），重置时间须有效且尚未到期。缺值、无效或已过期的重置时间，以及同模型匹配多个专属周窗口，都按 `MISS` 排除；任一适用窗口耗尽的账号不参与正常选号。若所有通过模型和档位校验的账号都已明确耗尽，自动启动回退到设备默认账号，不因自动选号失败阻断启动或 `rs` 恢复。

所有账号使用同一套调度模型，不区分账号类型：一个完整 5 小时额度算一份，普通完整周窗口算 10 份。Fable 的总周算 5 份、专属周算 10 份，分别受各自重置时间约束；有效周比例仍是 `min(总周剩余比例 × 50%, Fable 专属周剩余比例)`。缺少 Fable 专属窗口时按 `MISS` 排除，其他模型专属仅兼容接口实际返回的窗口。

选号同时考虑同一账号正在承载的会话。存活的 Claude 订阅会话只要仍在执行任务，或最近 30 分钟收到过用户消息，就计为活跃；等待回答、排队和后台任务也计入，同群不重复计算。每个活跃会话预计未来一小时使用完整 5 小时额度的 `10%`，选号再为本次启动加入一份同样的需求。例如账号已有两个活跃会话，新会话加入后，一小时预计共用 `30%` 的完整 5 小时额度。

每个额度窗口独立预留预计用量；一小时内重置的窗口按重置前后分段计算，不把未来恢复的额度当作当前余额。预计能承载所有需求的账号优先，再比较预留后的剩余分配速率。若所有真实可用账号都预计不足，继续按“预计需求 ÷ 可用额度”的压力从低到高分摊；这是调度估计，认证失败或 `MISS` 的账号仍不会入选，真实耗尽账号不参与正常选号，全部耗尽时按上一条规则回退默认账号。各项相同时优先活跃会话更少、5 小时余量更多的账号，最后保持默认账号及收录顺序。预留不修改真实额度，也没有临期绝对优先。自动选择只发生在启动时，运行中不会因额度耗尽自动轮换。

首次收录会清理额外账号自己的旧 `projects`、`tasks`、`file-history`、`plans`，并将这四个目录接到默认账号的共享存储；默认历史和配置、各账号登录凭据保留。重复收录只检查历史共享链接，不再次清理历史。账号初始化中断后可在下次 `hi 备注` 重试；未完成的账号不参与自动选择。同项目各账号共用原生历史、任务、文件回退和计划，切换账号后可以恢复或分叉；Lodestar 内同一原生会话禁止同时续写。自行在终端打开同一会话时，也应先结束原进程。

备注账号除登录状态外，统一使用默认配置目录（通常为 `~/.claude`）中的内容。`CLAUDE.md`、规则、Skill、自定义命令、子 Agent、工作流、插件、hooks、记忆、`settings.json`、快捷键及普通缓存都链接到全局；全局现有的其他文件和目录也自动接入。全局内容优先，备注账号原来的非登录内容会被替换，不保留同名覆盖或另做备份。首次收录、后续启动和 `lodestar-claude` 首次登录及打开已有账号目录时都会处理；升级前已收录的账号无需重新登录。全局文件修改通过链接直接生效，新增顶层项目在下次启动时补齐。

登录凭据、认证锁、账号/组织策略缓存和含账号身份的备份保持独立。原生 `~/.claude.json`（显式配置目录下为 `.claude.json`）及旧 `.config.json` 同时存登录身份和普通配置，不能整文件共享：启动时保留备注账号自己的认证字段，用全局 MCP、项目设置及其他普通字段覆盖备注配置。这些混合文件仍是各账号的独立文件，其余共享项使用链接。

默认账号保留原生配置目录的“未设置”状态或原始路径；不要把默认登录改成显式 `CLAUDE_CONFIG_DIR=~/.claude` 来代替，macOS 上这可能对应不同的钥匙串登录项。登录和续期由原生 Claude Code 管理，Lodestar 不读取或复制凭据文件。`hi` 按备注显示每个账号的额度，回复页脚使用实际执行该轮任务的账号。

发送 `claude-sub` 查看开关和可用状态，`claude-sub on` 启用，`claude-sub off` 禁用。开关对这台 Lodestar 的所有群生效并持久保存，只控制「Claude Code 订阅」来源，保留本机登录态及其他来源。禁用后不查询订阅模型和额度、不接受新任务；尚未送入 Agent 的排队消息会提示重发，已经在执行的任务继续完成。再次启用后仍须有有效订阅登录。

账号和模型目录通过 Claude Code 原生 SDK 查询，模型与 effort 随目录更新；未登录会显示启用引导，查询失败显示 `MISS`。可选配置节为 `[token_source.claude-sub]`，支持 `enabled`、`display`、`model`、`effort`、`hidden_models` 和 `custom_models`。`enabled = false` 禁用，`enabled = true` 或省略时沿用本机登录检测；群命令更新该字段。

订阅额度通过原生 `/usage` 控制接口读取，无需发送模型对话；每次实际查询仍会启动一个独立的 control-only Claude Code 进程，并执行原生启动初始化，查询后关闭。首次同步完成前不会为新增备注账号启动这些短命查询进程。`hi` 展示 5 小时、总周额度和接口返回的模型专属周额度及重置倒计时。回复底部同时显示 5 小时额度与周额度：本轮所选模型有专属周额度时显示该模型的额度，否则显示总周额度，沿用紧凑格式。后台瞬态查询失败保留成功缓存；没有缓存、认证失效或专属窗口缺数值时显示 `MISS`，不将缺失的专属额度改成总额度。此 SDK 查询接口仍属实验接口，版本不支持或接口变化时明确报错。

订阅进程保留本机和项目的 Claude 设置，并在进程内清除其他来源的 API key、模型映射和中转路由。发送任务前会再次核对实际账号是否为第一方订阅。Claude 订阅统一使用“Claude Code 订阅”来源，`md`、`hi` 和回复底部共用该来源的账号与额度。

旧版“Claude”本机配置入口已移除；使用该入口的用户升级后请通过 `md` 选择“Claude Code 订阅”及模型。

## OpenRouter

OpenRouter 通过 Claude Agent SDK 运行。在群内发送 `openrouter-setup <api_key>`，再通过 `model` 面板选择模型和 effort；自建兼容端点用 `openrouter-setup <base_url> <api_key>`。也可在配置文件中添加：

```toml
[token_source.openrouter]
agent = "claude"
api_key = "填写自己的 OpenRouter API key"
# base_url = "https://openrouter.ai/api" # SDK 自动追加 /v1/messages
# model = "moonshotai/kimi-k3"   # 可选：默认运行模型，须获账号目录确认
# effort = "max"                       # 可选：仅覆盖默认运行模型的档位
# models = "moonshotai/kimi-k3,google/gemini-3.8-flash" # 可选：固定列表，停止自动追新
# shown_models = "moonshotai/kimi-k3" # 可选：在自动精选之外显示指定接口模型
# slots = "haiku=moonshotai/kimi-k3" # 可选：辅助任务模型，须获账号目录确认且使用相同的 effort 参数模式
```

默认从账号目录为以下 **6 个家族**各选最新数字版本，定义见[默认模型配置](../src/openrouter-defaults.ts)。精选随每 5 分钟目录刷新更新，保留接口原始 ID；其他兼容模型仍可从账号目录显示或补录。

| 厂商 | 自动精选家族 | 默认档位 |
| --- | --- | --- |
| Tencent | Hy | high |
| Google | Gemini Flash | high |
| Meta | Muse Spark | xhigh |
| Xiaomi | MiMo Pro | 模型默认 |
| 字节跳动 | Seed Turbo | 模型默认 |
| 美团 | LongCat | 模型默认 |

版本逐段按数字比较，同版本再比较发布日期。腾讯 Hy 沿用 preview 候选，同版本优先正式版；其他家族不自动纳入 preview。Flash Lite、Pro（Gemini）、Flash（MiMo）、ultraspeed、thinking、free 等独立变体不会混入对应精选家族，仍可手动显示。家族默认档位必须在上游声明中受支持，否则保留缺失状态，要求明确选择。

在 `md` → Claude Code → OpenRouter 中，点「显示模型」进入账号目录，再点「显」加入列表，点「隐」移出面板列表。自动精选项隐藏后，同家族后续版本保持隐藏；手动显示的旧版本按 ID 独立显隐。显隐增量保存为 `shown_models` 和 `hidden_models`（自动精选项同时记录 `family:` 家族键与当前 ID），不会冻结整个精选列表。当前运行模型、已配置的 `model` 和 `custom_models` 保持不变；全部隐藏后也能继续显示或补录。

未配置 `models` 时使用自动精选；已有 `models` 仍是固定列表，`models = ""` 表示没有已显示的接口模型，刷新或重启不会补回默认项。已有固定列表要启用自动追新，需删除该来源的 `models` 字段；额外显示或隐藏的选择使用上述增量字段保存。

候选目录来自 `/api/v1/models/user`，按账号供应商和隐私设置筛选，仅纳入支持文本和工具调用的交互模型；OpenAI、GLM、DeepSeek 及无法保证厂商范围的自动路由不会出现在添加候选中。目录刷新失败显示 `MISS`。显式配置但已下线的模型保留为可删除的 `MISS` 项。

effort 按上游声明提供。小米、MiniMax、字节等没有 effort 选择器的模型直接选用原生默认行为，跳过 effort 卡，实际请求不携带 effort 参数。两种参数模式之间切换时，空闲进程会保存原生会话并在下一轮用新环境恢复；相同模式下继续使用 SDK 热切换。未配置 `model` 时需要通过面板明确选择运行模型。

OpenRouter 余额来自 `/api/v1/credits`，按 `total_credits - total_usage` 计算；接口权限和错误以实际响应为准。账号目录可见不代表所有工具和请求都能成功，上游拒绝或路由不可用会明确报错。兼容接口、模型与档位的处理见[后端说明](claude-agent-backend.md#openrouter)。

## 通用中转站（覆盖 Packy）

中转站不绑定具体厂商，只配置站点标识、API Key、地址和协议类型。Packy 的旧 `[token_source.packy]`、`packy-secondary`、`packy-codex` 配置不再读取，需要按新格式重新配置。

```toml
[relay.packy]
display = "Packy"
api_key = "填写 API Key"
base_url = "https://gateway.example"
protocol = "anthropic"        # Claude Code；OpenAI 类型同时提供 Codex 和 DSH
# balance_script = "/abs/path/relay-balance"
```

协议类型为 `anthropic` 或 `openai`：

- `anthropic`：在 Claude Code → 中转站下显示，使用 Anthropic Messages。
- `openai`：同时在 Codex → 中转站和 DeepSeek Harness → 中转站下显示；Codex 使用 Responses，DSH 使用 OpenAI Completions。

发送 `relay-setup <site_id> <anthropic|openai> <base_url> <api_key>` 可校验模型目录并保存站点。模型面板路径为“中转站 → 站点 → 模型 → effort”。模型目录读取站点的 `/v1/models`，模型 ID 和显示名称按上游返回保留；未声明 effort 时按当前 Agent 提供可用档位。

余额查询是可选的。发送 `relay-balance-setup <site_id> <script_path>` 绑定脚本。脚本通过 stdin 接收 JSON：

```json
{"site_id":"packy","base_url":"https://gateway.example","protocol":"anthropic","api_key":"..."}
```

stdout 返回统一额度快照，例如：

```json
{"state":"ok","kind":"balance","balance":{"remaining":12.34,"currency":"USD"},"windows":[]}
```

没有余额脚本时显示“余额 —”；脚本超时、退出失败或返回无效 JSON 时显示 `MISS`。脚本通过直接可执行文件启动，Key 不放在命令行参数中。

受管 Agent 不需要重启 Lodestar：使用继承的 `LODESTAR_AGENT_URL` 与 `LODESTAR_AGENT_CAPABILITY` 调用 `POST /agents/relays/test`（只读验证）、`POST /agents/relays/configure`（保存并刷新单个站点）或 `POST /agents/relays/reload`（重新读取并刷新站点）。项目绑定的 Agent 不允许修改全局 relay 配置。

OpenRouter 保持独立来源，不纳入通用中转站。

## DeepSeek Harness

DeepSeek Harness 与 Claude Code 共用 `[token_source.deepseek]` 中的 DeepSeek Key 和平台地址。发送 `deepseek-setup <api_key>` 后，两边都可在 `model` 面板中选择；旧命令 `deepseek-harness-setup` 也更新同一共享账号。两个 Agent 保留各自的原生会话、默认模型、effort 和模型可见性。

```toml
[token_source.deepseek]
api_key = "填写自己的 API key"
[token_source.deepseek-harness]
agent = "dsh"
# bin = "/abs/path/to/node"  # 可选：运行 DSH 的 Node 可执行文件
# model = "deepseek-v4-pro" # 可选：默认模型
# effort = "high"          # 可选：默认请求档位
```

### GLM Coding Plan

DSH 与 Claude Code 共用 `[token_source.glm]` 中的 GLM Coding Plan Key 和平台地址，在 `md` → DeepSeek Harness → GLM Coding Plan 中选择模型。`glm-setup` 与旧命令 `dsh-glm-setup` 都会更新两边，`[token_source.dsh-glm]` 只保留 DSH 的模型、effort、可见性等设置。两边分别使用 Anthropic 与 Coding Plan OpenAI 端点，并共享同一额度缓存。账号接口模型和补录模型一起交给原生适配器，均可选择请求档位；接口项用「隐 / 显」，补录项用「删」。

只有旧 Harness 配置时，会读取它的账号供两边共用；下次保存该来源配置时，凭据归并到上述共享配置节。两边旧配置的 Key 或平台不一致时明确报配置冲突，不自动挑选账号；重新执行对应 `setup` 命令可统一为指定的新配置。

手动修改配置后需重启 daemon；群内账号启用和模型补录会自行重载相关配置。模型路由、配置优先级和后端差异见 [后端说明](claude-agent-backend.md)。
