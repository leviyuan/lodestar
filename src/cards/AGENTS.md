# 卡片模板

本目录生成 Feishu Card Kit schema 2.0 JSON 和展示文本。模板保持纯函数，网络、文件、进程状态和持久化由调用方处理。

- 共享 `element_id` 从 `ELEMENTS` 取；动态 ID 稳定、同卡唯一，与替换、删除和换卡逻辑一致。
- 空 Markdown 使用占位，终态关闭 streaming；缺失值显示 `MISS`/`—`。模型行右侧窄按钮用单字（选、显、隐、删），宽按钮保留完整文案（补录模型、显示模型、返回模型列表、上一页、下一页、取消）。模型行之间加分隔线，文字和按钮垂直居中，不重复显示相同的模型名与 ID。
- 模型面板首页用独立的展开式折叠面板承载 `claude`、`codex`、`dsh` 各组：浅蓝标题背景、边框和 `Agent · Claude Code/Codex/DeepSeek Harness` 标题，Token Source 行放在组内，不能将两层名称平铺成同级粗体。再进入模型 → effort；action 携带 `panel_id`、`source_id`，拒绝过期 panel。
- 可编辑来源区分两类动作：接口项显示/隐藏（`model_add` / `model_remove`），列表外记录补录/删除（`model_custom_prompt` / `model_custom_remove`）。`origin` 决定行按钮，`custom_models` 持久化补录；补录成功后可直接选择使用；有多个 effort 档位才展示选择卡，单档位（含原生 default）直接应用，不能因目录未收录而设为空档位或仅显示 MISS。OpenRouter 默认按六个家族各取账号目录中的最新版本（家族见根 `AGENTS.md`），其他来源跟随接口目录。中转站在首页每组只有一行「中转站」虚拟入口，点开后列出站点；站点模型面板不显示显隐与补录按钮（`allowCustom` 为 false）。删除仍被会话选用的补录项时拒绝操作；过期来源版本和跨页动作同样拒绝。
- 执行中追加消息使用 `user_steering` 续卡：新卡顶部显示连续原生输入区段内全部「📥 追加」及原任务轮次，逐条消费回执不各自生成卡片，不显示容量超限说明；Session 按原生消费事件切分正文，边界之前的内容留旧卡，之后的内容写新卡；运行中的工具随卡迁移，旧卡标记已续至下一张。
- footer 模型标识固定为 `agent · 模型名/effort`（agent 小写）。token 明细统一口径：`入` = 新增输入（Codex 的 `input_tokens` 扣除缓存命中；Claude/DSH 的 `input_tokens` 并入缓存写入）、`缓` = 缓存命中、`出` = 输出，三项相加等于本轮总量。窗口额度沿用 `4.1h·7%·[6.9d·17%]` 的紧凑倒计时格式，不改成“额度 5h 已用…”或加入月度工具明细；余额显示 `余额 $…` / `余额 ¥…`。失败显示 MISS；Codex footer 刷新失败、进程已退出或换号时可按原格式直接展示本条回复所属账号的成功缓存，不加缓存或刷新失败标注，无缓存或认证失败仍 MISS。Codex 有消费积分时在窗口后追加 `积分 62.5k`；所有消费积分统一用小写 `k` / `m` 缩写千和百万，最多一位小数、去除尾零；未知显示 `积分 MISS`、确认没有则省略；不附加套餐、累计消费或解释性括号。
- Codex `request_user_input` 和 Claude `AskUserQuestion` 共用问答卡，保留各自回包语义、历史回答和自定义输入入口。
- `tool.ts` 生成工具摘要，`shell-command.ts` 解析 Bash、PowerShell 及引号包装后的首行 `# desc:`。Claude TaskCreate/Update/List/Get 在 `task-board.ts` 中累积为完整任务板。按字符上限截断 Markdown 时闭合未结束的代码围栏（`src/markdown-code.ts` 的 `closeOpenMarkdownFence`），避免截断提示和后续分区被渲染成代码；字面量内容用 `fencedCodeBlock` 包裹，围栏长于内容中的任何反引号串。`writeLogCard` 的文件内容同样按字面量展示，超过卡片大小上限时按顺序截断并注明未显示的变更数。
- 生图工具默认收起，完整提示词放在折叠体内；不超过 30 MB 的图片以结构化 `img` 子组件展示并允许点击预览，超过的图片由交付层转云空间。不要把提示词塞进标题，也不要把已嵌入的图片再单独发送。图片上传由 Session helper 处理，模板只接收 image key。
- `hi` 的额度区用展开式浅蓝面板，全局所有账号各占一行、notation 字号、2px 行间距，无进度条和底部解释。各来源同一套写法（`account-usage.ts`）：`**账号**　项 · 项`，窗口为“名称 已用%/距重置”，距重置与 Claude 凭据共用 `fmtCountdown`；每个事实只写一次——整窗未知只写 `5h MISS`，模型专属周额度（`modelWeekly:*`、Opus/Sonnet/OAuth）只写模型名，已用已知且距重置的显示文案与总周相同时省略，任一方缺失照写，所以 `名称 MISS` 只表示整窗未知；其他来源未登记的周额度仍写“名称周”；中转站脚本的日期是未解析的字符串，只认 `Date`，其余按 MISS，不能让整个额度区出错；百分比颜色按四舍五入后的显示值（80% 橙、100% 红）；积分、重置卡确认为零时省略、未知写 MISS；金额符号紧贴数字，令牌额度（`quota`）写 `剩余 X / 上限`，免得在「已用/距重置」标题下读反，与 footer 的 `unifiedUsageSummary` 一致。单账号来源只写短名（`GLM`），多账号来源写“来源·备注”。Codex 按账号备注分行，只显示主额度、消费积分及“重置 N”，排除 Spark/gpt-reserve；DeepSeek、GLM 的跨 Agent 入口合为一行；GLM 月工具只显示百分比。统一额度摘要与 footer 不附带重置次数。活跃项目行尾显示实际 Codex 进程的账号备注；账号未知时省略整个备注，不显示账号 MISS。hi 卡片其余区块沿用同一套写法：运行时长与服务时长用 `console.ts` 的 `fmtUptime`（不足 1 分钟按秒，其余同 `fmtCountdown`：`40m`、`2.1h`、`3.0d`）；活跃项目行「当前」紧跟项目名（同 bl 的「本群」），实际账号写成与额度区行名相同的 `Claude·备注` / `Codex·备注`（`escapeInlineMarkdown` 转义，不用行内代码）；默认折叠的面板标题带上要处理的摘要——活跃项目附等审批、工作中的数量（`🗂 活跃项目 (5) · 等审批 1 · 工作中 2`），主机附失败服务数（`· ❌2`）；服务行不再重复英文状态，运行、停止、失败由圆点与「已运行 / 已停 / 已挂」表达并排在最前，其余状态照写。活跃项目与 `bl` 行在状态后用 `sessionWorkloadLabel` 追加运行中的子 Agent 与后台进程数（`闲 · 子Agent2·后台1`，种类顺序与短标签沿用任务卡预览的 `agentCardTaskKindShortLabel`），0 省略、无工作时行文不变，读不到后台集合显示 `后台MISS`；模板只渲染调用方给的计数，不查询进程。账号列表每页附完整 Codex 账号命令说明，底部「Codex 命令」面板默认折叠。
- `p2p.ts` 的 `p2pConsoleCard` 是单聊只读面板，只用 `console.ts` 已导出的活跃项目、主机与额度元素拼成，不改群里的 `hi` 模板：标题只有 `🌟 Lodestar`，没有当前模型、「当前」标记和按钮，可选提示在最上，活跃项目默认展开，底部 notation 一行 `P2P_CONSOLE_HINT`。受限（外部联系人）时模板自己去掉账号名，不放主机与额度。模板只渲染调用方给的行，不判断可见性。
- Codex 的 `hi`、footer 和账号额度只显示主额度；只渲染接口实际返回的短时窗口、周窗口，缺少整个窗口时不补零或满窗，已返回窗口缺字段仍显示 MISS；不展示 GPT-5.3-Codex-Spark 等模型的附加额度。
- `codex-accounts` 去掉记录数和调度汇总行，按调度顺序排序后分页；每项标题为 `#1·备注「0.111/h」 · 重置 N`，重置次数取该账号额度缓存，保留零、缺失用 MISS；临期直接优先时用「临期优先」，仅剩消费积分时用「积分」且不伪造小时分数，无排名或分数用 MISS。正文首行为“邮箱：…”，随后按接口实际返回显示周、5h 窗口，各占一行，以六格进度条、已用百分比和「5.2d」真实倒计时显示，有消费积分时另加 `积分 62.5k`，未知显示 `积分 MISS`、确认没有则省略，不附加套餐或重置卡数；暂不可用保留可展开的具体原因，完整命令区保持默认折叠。调用方只读取账号邮箱缓存；后台模型/额度查询复用原生 `account/read` 发布邮箱，被额度去重的记录也保留各自账号信息。邮箱、额度及调度失败保留 MISS 和可展开的错误，不用备注或旧登录记录代替。后台激活错误由调用方传入 `activationErrors`，在对应账号下显示可展开的「后台激活 MISS」，模板不查询激活状态。
- Claude 订阅 footer 同时保留 5 小时与周额度（账号没有 5h 窗口时省略该段，不补 MISS），周额度按该条回复的模型选择专属窗口或总窗口；已返回的专属窗口缺数据时显示 MISS。hi 仍列出全部额度窗口。MD 和 hi 只使用 `claude-sub` 表示 Claude 订阅，不另设本机配置入口。reclaude 的 footer 额度沿用同一规则。
- Claude 订阅多账号在 hi 各占一行并使用账号备注；活跃项目显示实际运行的 Claude 账号。footer 捕获本轮真实账号的缓存视图，不随下一轮选号变化，不从聚合模型目录借用其他账号额度。
- `background.ts` 累积 Claude `task_*`、Codex collab 和 DSH 子 Agent 事件；子 Agent 直接展示，普通前台命令留在 pending。任务行与委派共用 `agent-cards.ts`：默认折叠，标题明确标出“委派任务 / 子 Agent / 后台进程”类别、状态与最多 40 字说明，详情只保留任务说明短摘要，结果在卡片安全上限内完整展示，超限明确截断，具体类型、错误和最近三步动作仍保留；完成后显示实际耗时，运行中不放需要定时刷新的计时。禁止恢复独立后台卡；共享卡必须留在群尾，新主卡发送前清掉旧卡未完成项并留迁移说明，新卡落地后在末尾重建，已完成项留作历史。任务行标题使用任务自身的说明（Claude `task_started.description`、Codex 子 Agent 名、DSH `subagent/descriptor` 的 label），进度/`task_updated` 只能补空标题，不能用最后一步操作顶掉任务说明。共享卡摘要即群列表预览（约 15 字），按运行/结束显示类别计数，例如 `⏳ 子Agent1·后台1`、`✅ 后台1`、`❌ 1失败·2完成`、`❓ 待回答1`；三类并存时用 `⏳ 3项进行中`，不得再拼“运行任务 · 已结束 0/2”长句。
- 临时会话选择卡只携带 `panel_id`、opaque `choice_id`。provider、cwd、source、owner、launch 保存在 Session 短期状态，不能信任回调传入的可执行 id、数组下标或路径。rs 历史列表可额外展示会话短标签（`…` + 末 6 位，与状态卡和结果卡一致）、首句（🚩）和最后一条用户输入（🏁，只取用户消息，缺失时省略）；结果卡的「所选历史」同样显示首/末句。这些字段仅供人眼区分，不进入回调。
- 公式段使用固定 id 的单个顶层 `column_set`，按源码顺序替换内部 markdown/image。小图可用 `crop_center` 和精确 `size`；宽图用 `fit_horizontal`，不传 `size`，由容器缩放。
- Card action 立即换卡返回 `{ card: { type: 'raw', data: card } }`。异步更新先返回 toast ACK，再调用 `feishu.updateCard()`；不用 callback-token 的 `/interactive/v1/card/update`，该端点会让 schema 2.0 卡片空白。`notify_callback` 在 Session 存在性检查前分流。
- 项目独立 Agent 调用在 `agent-cards.ts` 使用专属卡，一次 run 一张，不复用共享群尾卡；模板显示“项目任务”；项目调用不支持交互提问，不提供调用方回答指引。取消按钮通过 `agent_project_cancel` 路由，不依赖活跃 Session。

## 验证

- 模板、问答、工具和 IDs：`bun test src/cards/turn.test.ts src/cards/elements.test.ts src/cards/shell-command.test.ts`。
- 统一委派面板与后台任务：`bun test src/agent-cards.test.ts src/cards/agents.test.ts src/cards/task-board.test.ts src/cards/background.test.ts src/session.test.ts`。
- 公式事务：`bun test src/math-render.test.ts src/cardkit.test.ts src/session.test.ts src/cards/elements.test.ts`。
- Card action：`bun test src/card-action.test.ts src/card-action-runtime.test.ts src/notify-callbacks.test.ts`。真实交互需要明确授权的目标群。
