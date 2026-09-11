# 核心实现

`Session` 管理生命周期，`AgentProcess` 定义共享后端事件，具体进程类转换协议，`cardkit.ts` 串行写卡。

## 会话与后端

- 命令、模型、权限、工具、临时会话、worktree、Agent 身份和任务清单放在对应 `session-*.ts` helper；这些模块可协作访问 Session 的内部字段。
- 修改 `AgentProcess` 时检查 Codex、Claude、Session 消费方和卡片。单端能力用明确分支或 capability 表达。
- Codex 通过 app-server JSON-RPC 管理 thread、turn、权限、提问、plan/goal、usage、compaction 和 collab 子 Agent。未知或畸形 payload 要记录。
- Codex 会话落盘确认的 `thread/read` 最多等 10 分钟，Session 初始化总保护为 12 分钟，覆盖两个 30 秒控制请求及本地处理。daemon 恢复使用 `restoreAfterDaemonRestart` 保留失败意图，成功恢复或用户明确启动/停止后才解除；不得让排队消息在恢复失败后清空原会话。
- Codex 的 `Selected model is at capacity` 按用户要求持续退避重试（5s 起、60s 封顶），保留当前任务和模型，直到成功或用户停止；等待状态需显示。仅在 `turn/completed` 确认失败或 `turn/start` 明确拒绝后重试，已接受的输入通过原 thread 续跑，不重放原任务；其他错误仍正常结算。
- Claude 使用 `query()` streaming input。`permissionMode: default` 下普通工具由 `canUseTool` 放行，`AskUserQuestion` 等待回答；保留 `task_*`、`compact_boundary`、resume/fork 和项目配置。
- daemon 启动不得检查、安装或更新 Agent；`[runtime.agent_auto_update]` 的 `codex`、`claude`、`dsh` 三项默认 false，显式开启的 Agent 各自每 6 小时检查，独立防重叠和取消。旧布尔配置按原值迁移为三项并提示更新配置，禁止与新表混用。手动或定期更新选择 upstream latest，接受新版暂时不兼容并后续适配，不设兼容白名单。`agent-updates.ts` 管理独立版本目录与失败状态；实际 CLI/SDK 必须从选中目录加载，使用中的目录不覆盖、不移动、不删除。`agent-install.ts` 在 Windows 取消安装时终止精确 npm PID 的进程树并等待退出；未确认退出保留临时目录，文件占用只有限重试并报告最终失败。
- DSH 通过 `dsh-runtime.ts` 启动当前安装的 Node runtime，`dsh-bridge.ts` 与该运行时从同一依赖树加载，只校验 Lodestar 自有通信协议，不硬编码上游版本。它直接调用原生 Agent/持久化/提问服务。恢复点与结果分别经过 flush；只以真实结束原因结算。取消原因须保持不可变，避免 Node fetch 附加 stack 后被原生日志拒绝。
- DSH 模型能力和 effort 使用原生 LLM 服务解析，目录外模型也调用 `resolveModelInfo/resolveCallConfig`，不另设目录白名单。`dsh-glm` 将账号模型与补录项一起配置给 pi-ai，显式传递用户所选 reasoning_effort，不以安装时目录是否收录作为可用性门槛。同轮请求固定路由，`LODESTAR_DSH_*` 由选定来源注入，不能串用 DeepSeek/GLM 凭据。`DSH_LODESTAR_AGENT_CONTEXT` 由 ShellEnv 仅注入运行时根 Agent，原生子 Agent 不能继承主会话 capability 或继续委派。
- DSH/SDK 子工具的返回值可能是内容块数组，后台卡须先规范成文本摘要。图片编码按字节判断，不能信任飞书下载文件的 `.png` 后缀。桥接致命错误不得伪装成预期退出。
- Token Source factory 管理 enabled、模型刷新、spawn env、模型解析、settings 来源和额度。GLM/DeepSeek/OpenRouter 清除冲突 Anthropic env 后注入凭据，默认读取 project/local；native 读取 user。跨 source 必须换进程。OpenRouter 默认十一模型（榜单九项加字节、美团两家），排除 OpenAI/GLM/DeepSeek，MD 可增删且空列表必须持久化；账户余额取 `/credits` 的 `total_credits - total_usage`，不改用 `/key` 的限额或用量。`default` effort 表示不发该参数，需按 `modelEnvironmentRevision` 比较启动环境，不能简化为省略 SDK 选项或原进程直接改环境。
- 主会话 MD 按 Agent 分组 source，再进入 model → effort；只有一个档位时跳过 effort 卡并复用持有生命周期锁的正常选择流程，空档位仍报错。`withModelVisibility` 区分接口项和补录项：接口项显示/隐藏；所有来源的 `custom_models` 支持补录/删除。补录项使用原生解析或 Agent 请求档位，不能只保存不可选择的 MISS 记录；上游收录同名模型后按接口项管理。OpenRouter 维护默认十一项起步的显式列表，其余来源跟随接口目录并过滤 `hidden_models`。隐藏不改运行配置；删除补录项须保护正在选用的会话，并清理悬空默认/slots。同源设置走 `setModelSettings`；跨 provider/source 或 Claude profile 的切换在 turn、开卡或排队期间拒绝，空闲时终止不匹配进程。
- `md` 先等待目录刷新再生成账号卡，刷新失败显示 MISS，不能将加载中清空的数组显示为零模型。`debug-model.ts` 仅为本机模型测试提供白名单事件与脱敏状态；实际动作仍经过 daemon 的正常 Card action 队列。
- `fk`、`bk` 和进程停止后的 `rs` 使用原生会话能力：Claude transcript + `forkSession/resumeSessionAt`，Codex `thread/list` + `thread/fork(lastTurnId)`。checkpoint 包含 provider、源会话、cwd 和原生锚点。Claude fork 在首条输入前保存 pending launch，得到新 session id 后才清除。不得扫描或复制 Codex rollout，也不能把 fork 失败当成 resume。

## 委派 Agent

- `agent-*` 提供单层模型委派。只有主 Agent 能发起任务或续跑；同一任务的多个身份放在一个 run 内并发。被委派的 Agent 自行完成任务，需要额外派工时报告主 Agent。
- 共用 `agent-launch.ts` 的 coding-agent 启动入口。主会话保留原生能力；委派进程只关闭继续委派的工具（Codex `multi_agent`、Claude `Agent`/`Task`），其余代码工具、MCP、Skill、模型与 effort 保持不变。
- 每个 worker 获得独立、可撤销的 `LODESTAR_AGENT_*` capability，运行时拒绝其再次发起任务或续跑；Skill 与 worker 提示词同步声明禁止继续委派。历史父子记录仍可读取和清理。
- 委派任务统一按全局并发槽排队并显示原因。取消未确认的进程必须继续保留 handle 与槽位，失败向 Session 传播，不能标成已取消后丢掉控制权。
- 提问进入 `needs_input`，answer 后恢复；非输入权限请求放行。委派任务不设整轮时长上限，不截断返回正文，结束由后端终态或用户取消决定；follow-up 复用 provider 原生 session。
- 每次状态转换原子落盘；大 prompt/输出单独存入私有 artifact，快照不重复内嵌。委派 session id 单独登记，从主会话 `rs`/`fk` 历史排除。
- 父 run 取消、Session stop/kill/restart 和 daemon shutdown 在首次 await 前关闭新建入口、吊销 capability，并递归回收后代进程。
- Skill 内容由 `managed-skills.ts` 同源同步至 Codex/Claude standalone 目录和 Claude 本地插件。排除 user settings 的主会话显式加载插件，不能为发现 Skill 混入 user env。

## 卡片与持久化

- `hi` 的 Codex 重置卡次数来自额度接口 `rateLimitResetCredits.availableCount`，保留合法的零，缺失用 MISS；不推算剩余次数，也不显示在 footer。hi 的每个额度窗口独占一行，footer 继续使用紧凑格式。
- 生图完成事件补回的 prompt/revisedPrompt 要更新工具元数据。`session-tools.ts` 上传图片并通过 Card Kit 放入折叠面板，确认落地后才标记已交付；嵌入失败按用户约定单独发图。图片任务按原卡归属登记，关闭和换卡均须等待，避免图片在卡片退役后丢失。
- `feishu.ts` 的 30 MB 上限覆盖所有出站文件和图片；`instructions.ts` 同步约束所有 Agent 的文件交付。
- 生产 Card Kit mutation 经 per-card queue，在执行时分配 sequence。需要据结果更新 rendered 或持久状态的事务使用 checked API。
- footer 模型标识共用 `footerModelLabel`：小写 `claude` / `codex` / `dsh` 加 ` · 模型名/effort`。窗口额度保留 `4.1h·7%·[6.9d·17%]` 的原紧凑格式，不增加“额度 / 已用 / 周期标签 / 月度工具”等文字；余额使用结构化快照与 `unifiedUsageSummary`。不将 `planLabel` 当金额，不附加套餐、累计消费或括号说明；失败显示 MISS。
- 卡片必须先 `recordCardCreated` 再写入；关闭后的迟到写入不能隐式重建状态。分页没有整轮次数上限；单项失败与续卡失败不能封死整轮，后续实际内容可再次写入。
- 公式在 Markdown code range 外识别：简单 inline 转 Unicode，其余经 MathJax → SVG → Resvg。中文使用 SVG `<text>` 和系统字体；不使用字符占位或 path swap。
- 含公式的段落由固定 id 的顶层 `column_set` 承载，先放原始 Markdown，渲染后以一次 checked PUT 替换有序的 markdown/image 子元素。失败保留原文，不逐图追加或触发整卡换卡。
- 关闭或轮换卡片前按 cardId 等待公式渲染，成功后才标记 rendered。临时 PNG 使用唯一 `mkdtemp(tmpdir())` 目录、异步文件 API，并在 finally 清理；并发去重、缓存有界。MathJax/Resvg 保持延迟加载以支持 Node 构建。
- `config.ts` 的 import-time 错误、`paths.ts` 的跨平台路径和 `feishu.ts` 的持久 map 是公共契约。测试隔离真实配置，使用子进程或统一 mock。

## 验证

- 双后端与账号切换：`bun test src/codex-process.test.ts src/claude-agent-process.test.ts src/session.test.ts src/token-source-glm.test.ts`。
- 公式与卡片事务：`bun test src/math-render.test.ts src/cardkit.test.ts src/session.test.ts src/cards/elements.test.ts`。
- 其他改动运行对应测试；共享路径最终运行全量 `bun test`。SDK/native 依赖、动态加载和 Node/Bun 兼容性变化再运行 `bun run build`。
- DSH 的 `bun test src/dsh-process.test.ts` 使用真实 Node runtime 和本地模拟模型/MCP；不需要付费 API key，也不接触飞书。
