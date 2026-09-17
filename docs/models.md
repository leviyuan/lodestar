# 账号、模型与 effort

[返回首页](../README.md) · [安装与配置](configuration.md) · [群内用法](usage.md)

账号配置使用 `[token_source.glm]`、`[token_source.deepseek]` 等节。GLM、DeepSeek 和 OpenRouter 也可以从本机 Claude settings 中识别；识别后由对应 Token Source 注入凭据，避免不同账号的环境变量串用。项目的工具限制只作用于主会话，委派 Agent 使用完整工具集。

## 配置 API Key

GLM Key 可在首次安装时跳过，之后用群命令添加或更换。以下命令先向对应平台校验凭据和模型目录，通过后才保存；认证、网络或响应错误均保留原配置并给出原因。校验无需调用付费模型，也不要求先安装对应 Agent。

| 账号 | 群命令 |
| --- | --- |
| 智谱 GLM（两个 Agent 共用） | `glm-setup <api_key>` |
| Z.ai GLM（两个 Agent 共用） | `glm-setup https://api.z.ai/api/anthropic <api_key>` |
| DeepSeek（两个 Agent 共用） | `deepseek-setup [base_url] <api_key>` |
| OpenRouter | `openrouter-setup [base_url] <api_key>` |
| DeepSeek 旧命令，同样更新共享账号 | `deepseek-harness-setup [base_url] <api_key>` |
| GLM 旧命令，同样更新共享账号 | `dsh-glm-setup [base_url] <api_key>` |

`[base_url]` 表示可选参数，命令中不输入方括号；API Key 只填原值，不加 `Bearer`。`glm-setup <base_url> <api_key>` 的原有格式仍可使用，GLM 的 Key 与平台地址必须对应。保存后发送 `md` 选择模型。账号配置由本机所有群共用，更新 Key 保留已有模型、档位和可见性设置。

如果凭据校验通过，但保存后的模型加载因 Agent 未安装等原因失败，会明确提示“配置已保存，但暂不可用”；按提示处理后发送 `md` 刷新。认证失败会提示核对 Key，网络失败会提示检查连接和代理，不会将错误正文误报为“缺少 data 数组”。

## 选择与管理模型

发送 `model`（`md`），在 Claude Code、Codex、DeepSeek Harness 分组下选择账号，再选择模型。有多个推理档位（effort）时继续选择档位，只有一个档位时直接应用。

| 操作 | 作用 |
| --- | --- |
| 选 | 使用该模型，按需继续选择推理档位 |
| 隐 / 显 | 隐藏或显示接口目录中的模型，不改变当前运行模型 |
| 补录模型 | 添加接口目录外的模型，可选择推理档位并使用 |
| 删 | 删除补录记录；仍有会话选用时需先切换模型 |

除 OpenRouter 使用内置默认列表外，各来源默认显示接口目录中的模型，新模型会随目录刷新出现。所有来源都支持补录，记录保存在 `custom_models`；支持端点验证的来源会先验证。目录未收录不会阻止选择，实际不支持的请求由后端报告错误。接口后来收录同名模型时自动转为接口项，不重复显示。删除补录记录也会清理默认模型和辅助模型中的相关引用。

同账号切换 Claude 或 DSH 模型从后续回复生效；Codex 的持久设置需重启会话生效。跨账号或后端切换只允许在空闲时进行。来源禁用或目录获取失败显示 `MISS`。

模型设置超过 20 秒仍未收到后端确认时，面板显示“确认中”，最终结果回到原卡；等待期间仍可回答 Agent 提问或用 `stop` 打断任务，取消切换需发 `kill` 或 `restart`。模型和思考档位全部确认后才保存选择。若只有模型切换成功，或后端已应用但保存失败，会分别显示实际结果和错误，未确认的值显示 `MISS`；后续输入暂停，重新发送 `md` 完成选择后再继续。已有排队消息保留，设置确认后再提交。

## 额度

发送 `hi` 查看全部已配置账号的额度，一账号一行。Codex 按备注展示主额度窗口及“重置”次数，不展示 Spark、gpt-reserve；Claude 订阅保留主窗口和模型专属周额度；GLM 月工具仅显示已用百分比，DeepSeek、OpenRouter 显示余额。DeepSeek、GLM 的两个 Agent 入口各合并为一行。

所有群、Agent、`hi`、账号列表、页脚和自动选号共用账号级惰性缓存：一分钟内直接复用，过期后有查询需求才请求，并发查询只发送一次。失败后冷却 1 分钟，连续失败依次延长为 2、4、5 分钟；上游提供更长的 `Retry-After` 时遵守其等待时间。额度请求不在一次失败后紧接着重试，冷却期间返回已有错误。重新登录、删除 Codex 账号或显式使用重置卡会使对应缓存失效；使用重置卡后重新查询实际额度。

回复底部显示 `agent · 模型名/effort`，其中 Agent 为 `claude`、`codex` 或 `dsh`。窗口额度如 `4.1h·7%·[6.9d·17%]`，分别表示重置倒计时与已用百分比，方括号内为周窗口；余额显示 `余额 $12.34` 或 `余额 ¥12.34`。Codex 刷新失败或进程已退出时，回复底部按原格式保留同账号上次成功的额度。没有成功缓存、登录认证失败或缓存已被重新登录、删除账号、额度重置操作清除时显示 `MISS`。`hi`、`codex-accounts` 和其他来源的过期刷新失败仍显示 `MISS`。

## Claude Code 订阅

在运行 Lodestar 的本机通过 `claude auth login` 登录 Claude 订阅后，发送 `md` → Claude Code → **Claude Code 订阅**。来源 id 为 `claude-sub`，可与 GLM、DeepSeek、OpenRouter 同时使用；无需复制登录凭据或填写 API key。

发送 `claude-sub` 查看开关和可用状态，`claude-sub on` 启用，`claude-sub off` 禁用。开关对这台 Lodestar 的所有群生效并持久保存，只控制「Claude Code 订阅」来源，保留本机登录态及其他来源。禁用后不查询订阅模型和额度、不接受新任务；尚未送入 Agent 的排队消息会提示重发，已经在执行的任务继续完成。再次启用后仍须有有效订阅登录。

账号和模型目录通过 Claude Code 原生 SDK 查询，模型与 effort 随目录更新；未登录会显示启用引导，查询失败显示 `MISS`。可选配置节为 `[token_source.claude-sub]`，支持 `enabled`、`display`、`model`、`effort`、`hidden_models` 和 `custom_models`。`enabled = false` 禁用，`enabled = true` 或省略时沿用本机登录检测；群命令更新该字段。

订阅额度通过原生 `/usage` 控制接口读取，无需发送模型对话。`hi` 展示 5 小时、总周额度和接口返回的模型专属周额度及重置倒计时。回复底部同时显示 5 小时额度与周额度：本轮所选模型有专属周额度时显示该模型的额度，否则显示总周额度，沿用紧凑格式。查询失败或缺失数据显示 `MISS`，不使用旧额度替代，也不将缺失的专属额度改成总额度。此 SDK 查询接口仍属实验接口，版本不支持或接口变化时明确报错。

订阅进程保留本机和项目的 Claude 设置，并在进程内清除其他来源的 API key、模型映射和中转路由。发送任务前会再次核对实际账号是否为第一方订阅。Claude native 继续保留为使用本机完整配置的来源。

## OpenRouter

OpenRouter 通过 Claude Agent SDK 运行。在群内发送 `openrouter-setup <api_key>`，再通过 `model` 面板选择模型和 effort；自建兼容端点用 `openrouter-setup <base_url> <api_key>`。也可在配置文件中添加：

```toml
[token_source.openrouter]
agent = "claude"
api_key = "填写自己的 OpenRouter API key"
# base_url = "https://openrouter.ai/api" # SDK 自动追加 /v1/messages
# model = "moonshotai/kimi-k3"   # 可选：默认运行模型，须获账号目录确认
# effort = "max"                       # 可选：仅覆盖默认运行模型的档位
# models = "moonshotai/kimi-k3,google/gemini-3.8-flash" # 可选：自定义可选列表
# slots = "haiku=moonshotai/kimi-k3" # 可选：辅助任务模型，须获账号目录确认且使用相同的 effort 参数模式
```

内置默认列表包含以下 **12 项**，定义见[默认模型配置](../src/openrouter-defaults.ts)。这是项目提供的初始列表，可在面板中自行调整；其中 Claude 模型通过 OpenRouter 使用，与本机 Claude Code 订阅独立。

| 厂商 | 模型 ID | 默认档位 |
| --- | --- | --- |
| Anthropic | `anthropic/claude-fable-5.1` | max |
| Anthropic | `anthropic/claude-opus-5` | max |
| Moonshot | `moonshotai/kimi-k3` | max |
| Tencent | `tencent/hy4-preview` | high |
| Google | `google/gemini-3.8-flash` | high |
| SpaceXAI | `x-ai/grok-4.5` | high |
| Alibaba | `qwen/qwen3.8-max-0902` | xhigh |
| Meta | `meta/muse-spark-1.2` | xhigh |
| Xiaomi | `xiaomi/mimo-v2.5-pro` | 模型默认 |
| MiniMax | `minimax/minimax-m3` | 模型默认 |
| 字节跳动 | `bytedance-seed/seed-2-1-turbo` | 模型默认 |
| 美团 | `meituan/longcat-2.0` | 模型默认 |

在 `md` → Claude Code → OpenRouter 中，点「显示模型」进入账号目录，再点「显」加入列表，点「隐」移出面板列表。可见性自动保存，不改当前运行模型；全部隐藏后也能继续显示或补录。未配置 `models` 时才使用上述十二项；`models = ""` 表示没有已显示的接口模型，刷新或重启不会补回默认项。内置列表更新不会覆盖用户维护的列表。

候选目录来自 `/api/v1/models/user`，按账号供应商和隐私设置筛选，仅纳入支持文本和工具调用的交互模型；OpenAI、GLM、DeepSeek 及无法保证厂商范围的自动路由不会出现在添加候选中。目录刷新失败显示 `MISS`。显式配置但已下线的模型保留为可删除的 `MISS` 项。

effort 按上游声明提供。小米、MiniMax、字节等没有 effort 选择器的模型直接选用原生默认行为，跳过 effort 卡，实际请求不携带 effort 参数。两种参数模式之间切换时，空闲进程会保存原生会话并在下一轮用新环境恢复；相同模式下继续使用 SDK 热切换。未配置 `model` 时需要通过面板明确选择运行模型。

OpenRouter 余额来自 `/api/v1/credits`，按 `total_credits - total_usage` 计算；接口权限和错误以实际响应为准。账号目录可见不代表所有工具和请求都能成功，上游拒绝或路由不可用会明确报错。兼容接口、模型与档位的处理见[后端说明](claude-agent-backend.md#openrouter)。

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
