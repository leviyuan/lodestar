# 账号、模型与 effort

[返回首页](../README.md) · [安装与配置](configuration.md) · [群内用法](usage.md)

账号配置使用 `[token_source.glm]`、`[token_source.deepseek]` 等节。GLM、DeepSeek 和 OpenRouter 也可以从本机 Claude settings 中识别；识别后由对应 Token Source 注入凭据，避免不同账号的环境变量串用。项目的工具限制只作用于主会话，委派 Agent 使用完整工具集。

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

## 额度

发送 `hi` 查看会话和账号额度。GLM 展示套餐与各窗口用量；Codex 展示额度窗口和账号可用的重置卡次数。

回复底部显示 `agent · 模型名/effort`，其中 Agent 为 `claude`、`codex` 或 `dsh`。窗口额度如 `4.1h·7%·[6.9d·17%]`，分别表示重置倒计时与已用百分比，方括号内为周窗口；余额显示 `余额 $12.34` 或 `余额 ¥12.34`。读取失败显示 `MISS`，Codex 的短暂网络失败会有限重试。

## Claude Code 订阅

在运行 Lodestar 的本机通过 `claude auth login` 登录 Claude 订阅后，发送 `md` → Claude Code → **Claude Code 订阅**。来源 id 为 `claude-sub`，可与 GLM、DeepSeek、OpenRouter 同时使用；无需复制登录凭据或填写 API key。

发送 `claude-sub` 查看开关和可用状态，`claude-sub on` 启用，`claude-sub off` 禁用。开关对这台 Lodestar 的所有群生效并持久保存，只控制「Claude Code 订阅」来源，保留本机登录态及其他来源。禁用后不查询订阅模型和额度、不接受新任务；尚未送入 Agent 的排队消息会提示重发，已经在执行的任务继续完成。再次启用后仍须有有效订阅登录；ReClaude 启用期间，订阅入口继续停用并显示原因。

账号和模型目录通过 Claude Code 原生 SDK 查询，模型与 effort 随目录更新；未登录会显示启用引导，查询失败显示 `MISS`。可选配置节为 `[token_source.claude-sub]`，支持 `enabled`、`display`、`model`、`effort`、`hidden_models` 和 `custom_models`。`enabled = false` 禁用，`enabled = true` 或省略时沿用本机登录检测；群命令更新该字段。

订阅额度通过原生 `/usage` 控制接口读取，无需发送模型对话。`hi` 展示 5 小时、总周额度和接口返回的模型专属周额度及重置倒计时。回复底部同时显示 5 小时额度与周额度：本轮所选模型有专属周额度时显示该模型的额度，否则显示总周额度，沿用紧凑格式。查询失败或缺失数据显示 `MISS`，不使用旧额度替代，也不将缺失的专属额度改成总额度。此 SDK 查询接口仍属实验接口，版本不支持或接口变化时明确报错。

订阅进程保留本机和项目的 Claude 设置，并在进程内清除其他来源的 API key、模型映射和中转路由。发送任务前会再次核对实际账号是否为第一方订阅。Claude native 继续保留为使用本机完整配置的来源。

## ReClaude 拼车

在运行 Lodestar 的本机按 [ReClaude 官方说明](https://docs.reclaude.ai/cli/install)安装客户端，执行 `reclaude login` 完成浏览器设备授权并选择拼车组织，再运行 `reclaude daemon --detach` 启动官方后台。Linux 后台由用户 systemd 管理。

**客户端会接管本机 Claude 登录**，并在账号变化时终止其管理的 Claude 进程。Lodestar 启用 ReClaude 后停用重复的「Claude Code 订阅」入口。退出 ReClaude 并恢复原生登录按官方客户端的 `reclaude logout` 流程操作。

在群内发送 `reclaude-setup <拼车组织 ID> [个人只读 API key]`，然后通过 `md` → Claude Code → **ReClaude** 选择模型。也可以在配置文件中添加：

```toml
[token_source.reclaude]
agent = "claude"
auth = "reclaude-login"
org_id = "填写拼车组织 ID"
api_key = "填写 rck_ 个人只读 API key"
# model = "opus"   # 可选；模型和 effort 来自 SDK 原生目录
# effort = "max"
```

个人 `rck_` key 仅查询指定组织的拼车 5 小时额度，不用于模型认证。组织 ID 可从个人 API 的 `GET /api/v1/orgs` 查询。未填写只读 key 不影响已登录客户端的模型调用，额度显示 `MISS`。接口里的美元金额是该窗口的用量口径，不是账户余额；重置时间未返回时保留未知，不推算周额度。

模型运行保持 Claude Agent SDK 默认入口，无需设置 `[claude].bin`。ReClaude 来源校验本机设备登录、对应 Claude 凭据、后台进程和 CA，然后只为此来源的 SDK 子进程设置官方本机代理。客户端未运行、登录不匹配、模型目录失败和网关错误均明确报错，不切换到其他账号。安装、登录和后台启动由用户管理，Lodestar 不自动安装或启动 ReClaude。

恢复检测脚本为 `bun scripts/watch-reclaude.ts --project <群项目名> --model haiku --interval-seconds 300`。它用极短的真实对话确认恢复，可能消耗拼车额度；首次成功后停止模型请求，经本机通知接口确认群消息发送成功后退出。通知失败每分钟重试，仅重试通知。状态保存在数据目录的 `reclaude-watch/`，已成功或已通知的记录在再次运行时仍有效，不会重复消耗模型额度。`--once` 只执行一轮。常驻时用 `systemd-run --user --unit=cc-<项目>-reclaude-watch -- <Bun绝对路径> <脚本绝对路径> ...` 管理；这不会重启 Lodestar。

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

DeepSeek Harness 使用独立的 `[token_source.deepseek-harness]` 账号与原生会话。在群内发送 `deepseek-harness-setup <api_key>`，再通过 `model` 面板选择该来源即可启用。自建端点用 `deepseek-harness-setup <base_url> <api_key>`；这里使用原生 API 根地址，不带 `/anthropic`。

```toml
[token_source.deepseek-harness]
agent = "dsh"
api_key = "填写自己的 API key"
# bin = "/abs/path/to/node"  # 可选：运行 DSH 的 Node 可执行文件
# model = "deepseek-v4-pro" # 可选：默认模型
# effort = "high"          # 可选：默认请求档位
```

### GLM Coding Plan

DSH 也支持 GLM Coding Plan：已有 `[token_source.glm]` 时自动复用该账号，在 `md` → DeepSeek Harness → GLM Coding Plan 中选择模型。独立凭据用 `dsh-glm-setup [base_url] <api_key>`，配置节为 `[token_source.dsh-glm]`。它调用 Coding Plan 的 OpenAI 端点，复用 GLM 额度查询；不经过 OpenRouter 或 Claude SDK。账号接口模型和补录模型一起交给原生适配器，均可选择请求档位；接口项用「隐 / 显」，补录项用「删」。

手动修改配置后需重启 daemon；群内账号启用和模型补录会自行重载相关配置。模型路由、配置优先级和后端差异见 [后端说明](claude-agent-backend.md)。
