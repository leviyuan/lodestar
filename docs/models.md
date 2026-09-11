# 账号、模型与 effort

[返回首页](../README.md) · [安装与配置](configuration.md) · [群内用法](usage.md)

账号配置使用 `[token_source.glm]`、`[token_source.deepseek]` 等节。GLM、DeepSeek 和 OpenRouter 也可以从本机 Claude settings 中识别；识别后由对应 Token Source 注入凭据，避免不同账号的环境变量串用。项目的工具限制只作用于主会话，委派 Agent 使用完整工具集。

`md` / `model` 首页用独立分组展示 Claude Code、Codex、DeepSeek Harness：每组都有浅蓝标题栏、边框和 `Agent · 名称` 标题，默认展开，Token Source 行放在组内。模型行之间有分隔线，右侧窄按钮使用单字「选 / 隐 / 显 / 删」，补录、返回和翻页等宽按钮保留完整文案。选账号后进入模型选择；有多个 effort 档位时再选择档位，只有一个档位（包括原生默认）时直接应用。除 OpenRouter 的默认列表外，各来源默认显示接口目录。接口中的模型使用「隐藏 / 显示」，只调整面板可见性，接口新增模型仍会出现。

所有 Token Source 都提供「补录模型」按钮，补录接口列表外的模型；「删」删除补录记录。记录保存在 `custom_models`；支持端点验证的来源会先验证，补录后即可选择 effort 并使用：DSH 调用原生模型解析，其他来源提供 Agent 的请求档位。目录未收录不会阻止选择，实际不支持的请求由后端报告错误。接口后来收录同名模型时自动转为接口项，不重复显示。删除补录记录需要先切换仍选用它的会话；默认模型和辅助模型中指向已删除补录项的配置也会清理。

所有对话卡的模型标识固定为 `claude · 模型名/effort`、`codex · 模型名/effort` 或 `dsh · 模型名/effort`。窗口额度沿用原来的紧凑格式，如 `4.1h·7%·[6.9d·17%]`（重置倒计时与已用百分比）；余额显示 `余额 $12.34` 或 `余额 ¥12.34`。Codex 额度接口短暂网络失败会有限重试；最终读取失败才显示 `MISS`。`hi` 中的额度标题、各个额度窗口与 Codex 重置卡次数分别换行。

## OpenRouter

OpenRouter 通过 Claude Agent SDK 运行。在群内发送 `openrouter-setup <api_key>`，再通过 `model` 面板选择模型和 effort；自建兼容端点用 `openrouter-setup <base_url> <api_key>`。也可在配置文件中添加：

```toml
[token_source.openrouter]
agent = "claude"
api_key = "填写自己的 OpenRouter API key"
# base_url = "https://openrouter.ai/api" # SDK 自动追加 /v1/messages
# model = "anthropic/claude-fable-5.1"   # 可选：默认运行模型，须获账号目录确认
# effort = "max"                       # 可选：仅覆盖默认运行模型的档位
# models = "anthropic/claude-fable-5.1,moonshotai/kimi-k3" # 可选：自定义可选列表
# slots = "haiku=anthropic/claude-fable-5.1" # 可选：辅助任务模型，须获账号目录确认且使用相同的 effort 参数模式
```

OpenRouter 默认可选列表按 [Arena Agent Labs 榜单](https://arena.ai/leaderboard/agent?rankBy=labs) 的 2026-09-08 快照设置：前 12 家各取排名最高的模型，排除 OpenAI、Z.ai / GLM、DeepSeek，保留以下 9 项。

| Labs 排名 | 厂商 | OpenRouter 模型 | 默认档位 |
| --- | --- | --- | --- |
| 1 | Anthropic | `anthropic/claude-fable-5.1` | max |
| 3 | Moonshot | `moonshotai/kimi-k3` | max |
| 4 | Tencent | `tencent/hy4-preview` | high |
| 7 | Google | `google/gemini-3.8-flash` | high |
| 8 | SpaceXAI | `x-ai/grok-4.5` | high |
| 9 | Alibaba | `qwen/qwen3.8-max-0902` | xhigh |
| 10 | Meta | `meta/muse-spark-1.2` | xhigh |
| 11 | Xiaomi | `xiaomi/mimo-v2.5-pro` | 模型默认 |
| 12 | MiniMax | `minimax/minimax-m3` | 模型默认 |

2026-09-11 进一步补齐国内厂商，默认列表共 **11 项**。原榜单顺序不变，后面追加以下两项；这些追加项不代表 Arena 前十二名排名。蚂蚁和阶跃星辰不列为默认。

| 厂商 | OpenRouter 模型 | 默认档位 |
| --- | --- | --- |
| 字节跳动 | [Seed 2.1 Turbo](https://openrouter.ai/bytedance-seed/seed-2-1-turbo) · `bytedance-seed/seed-2-1-turbo` | 模型默认 |
| 美团 | [LongCat 2.0](https://openrouter.ai/meituan/longcat-2.0) · `meituan/longcat-2.0` | 模型默认 |

同日核查百度：[CoBuddy](https://openrouter.ai/baidu/cobuddy) 和 ERNIE 4.5 300B 的端点目录为空，实际调用返回 `404 No endpoints found`；账号目录中可见的 ERNIE 4.5 VL 424B 未声明工具调用支持，因此暂不加入 Agent 默认列表。快手 [KAT-Coder-Pro V2.5](https://openrouter.ai/kwaipilot/kat-coder-pro-v2.5) 虽在账号目录中，但原生 Chat Completions 和 Anthropic Messages 实测均返回 AtlasCloud 上游 `400 bad request`，暂不列为默认，仍可从目录手动显示。账号目录中也没有找到华为、讯飞、商汤的可用工具模型。阿里、腾讯、小米、月之暗面、MiniMax 已在原九项中；OpenAI、GLM、DeepSeek 继续排除。

在 `md` / `model` → claude → OpenRouter 中，点「显示模型」进入账号目录，再点行右侧「显」加入列表，点每行「隐」移出面板列表。可见性自动持久化，不改当前运行模型；全部隐藏后也能继续显示或补录。未配置 `models` 时才使用上述十一项；`models = ""` 明确表示没有已显示的接口模型，刷新或重启不会补回默认项。榜单变化不会覆盖用户维护的列表。

候选目录来自 `/api/v1/models/user`，按账号供应商和隐私设置筛选，仅纳入支持文本和工具调用的交互模型；OpenAI、GLM、DeepSeek 及无法保证厂商范围的自动路由不会出现在添加候选中。目录刷新失败显示 `MISS`。显式配置但已下线的模型保留为可删除的 `MISS` 项。

effort 按上游声明提供。小米、MiniMax、字节等没有 effort 选择器的模型直接选用原生默认行为，跳过 effort 卡，实际请求不携带 effort 参数。两种参数模式之间切换时，空闲进程会保存原生会话并在下一轮用新环境恢复；相同模式下继续使用 SDK 热切换。未配置 `model` 时需要通过面板明确选择运行模型。

OpenRouter 余额来自 `/api/v1/credits`，按 `total_credits - total_usage` 计算，卡片仅显示 `余额 $…`，不附加 Key 限额或累计消费。现有 Key 已实测返回 200；接口权限和错误以实际响应为准。SDK 使用 Bearer token，并显式清空 `ANTHROPIC_API_KEY`。OpenRouter 官方的兼容保证限于 Anthropic 第一方供应商；工具调用、模型与档位参数的验证范围见 [后端说明](claude-agent-backend.md)。

## DeepSeek Harness

DeepSeek Harness 使用独立的 `[token_source.deepseek-harness]` 账号与原生会话。在群内发送 `deepseek-harness-setup <api_key>`，再通过 `model` 面板选择该来源即可启用。自建端点用 `deepseek-harness-setup <base_url> <api_key>`；这里使用原生 API 根地址，不带 `/anthropic`。

## DSH 的 GLM Coding Plan

DSH 也支持 GLM Coding Plan：已有 `[token_source.glm]` 时自动复用该账号，在 `md` → dsh → GLM Coding Plan 中选择模型。独立凭据用 `dsh-glm-setup [base_url] <api_key>`，配置节为 `[token_source.dsh-glm]`。它调用 Coding Plan 的 OpenAI 端点，复用 GLM 额度查询；不经过 OpenRouter 或 Claude SDK。账号接口模型和补录模型一起交给原生适配器，均可选择请求档位；接口项用「隐 / 显」，补录项用「删」。

```toml
[token_source.deepseek-harness]
agent = "dsh"
api_key = "填写自己的 API key"
# bin = "/abs/path/to/node"  # 可选：运行 DSH 的 Node 可执行文件
# model = "deepseek-v4-pro" # 可选：默认模型
# effort = "high"          # 可选：默认请求档位
```

手动修改配置后需重启 daemon；群内账号启用和模型补录会自行重载相关配置。模型路由、配置优先级和后端差异见 [后端说明](claude-agent-backend.md)。
