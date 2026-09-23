# 卡片模板

本目录生成 Feishu Card Kit schema 2.0 JSON 和展示文本。模板保持纯函数，网络、文件、进程状态和持久化由调用方处理。

- 共享 `element_id` 从 `ELEMENTS` 取；动态 ID 稳定、同卡唯一，与替换、删除和换卡逻辑一致。
- 空 Markdown 使用占位，终态关闭 streaming；缺失值显示 `MISS`/`—`。模型行右侧窄按钮用单字（选、显、隐、删），宽按钮保留完整文案（补录模型、显示模型、返回模型列表、上一页、下一页、取消）。模型行之间加分隔线，文字和按钮垂直居中，不重复显示相同的模型名与 ID。
- 模型面板首页用独立的展开式折叠面板承载 `claude`、`codex`、`dsh` 各组：浅蓝标题背景、边框和 `Agent · Claude Code/Codex/DeepSeek Harness` 标题，Token Source 行放在组内，不能将两层名称平铺成同级粗体。再进入模型 → effort；action 携带 `panel_id`、`source_id`，拒绝过期 panel。
- 所有来源区分两类动作：接口项显示/隐藏（`model_add` / `model_remove`），列表外记录补录/删除（`model_custom_prompt` / `model_custom_remove`）。`origin` 决定行按钮，`custom_models` 持久化补录；补录成功后可直接选择使用；有多个 effort 档位才展示选择卡，单档位（含原生 default）直接应用，不能因目录未收录而设为空档位或仅显示 MISS。OpenRouter 默认十项（榜单八项加字节、美团两家，默认不含 Claude），其他来源跟随接口目录。删除仍被会话选用的补录项时拒绝操作；过期来源版本和跨页动作同样拒绝。
- footer 模型标识固定为 `agent · 模型名/effort`（agent 小写）。窗口额度沿用 `4.1h·7%·[6.9d·17%]` 的紧凑倒计时格式，不改成“额度 5h 已用…”或加入月度工具明细；余额显示 `余额 $…` / `余额 ¥…`。失败显示 MISS；Codex footer 刷新失败、进程已退出或换号时可按原格式直接展示本条回复所属账号的成功缓存，不加缓存或刷新失败标注，无缓存或认证失败仍 MISS。不附加套餐、累计消费或解释性括号。
- Codex `request_user_input` 和 Claude `AskUserQuestion` 共用问答卡，保留各自回包语义、历史回答和自定义输入入口。
- `tool.ts` 生成工具摘要，`shell-command.ts` 解析 Bash、PowerShell 及引号包装后的首行 `# desc:`。Claude TaskCreate/Update/List/Get 在 `task-board.ts` 中累积为完整任务板。
- 生图工具默认收起，完整提示词放在折叠体内，图片以结构化 `img` 子组件展示并允许点击预览。不要把提示词塞进标题，也不要把已嵌入的图片再单独发送。图片上传由 Session helper 处理，模板只接收 image key。
- `hi` 的额度区用展开式浅蓝面板，全局所有账号各占一行、notation 字号、2px 行间距，无进度条和底部解释。Codex 按账号备注分行，只显示主额度及“重置 N”，排除 Spark/gpt-reserve；DeepSeek、GLM 的跨 Agent 入口合为一行；GLM 月工具只显示百分比。统一额度摘要与 footer 不附带重置次数。活跃项目行尾显示实际 Codex 进程的账号备注；账号未知时省略整个备注，不显示账号 MISS。账号列表每页附完整 Codex 账号命令说明，底部「Codex 命令」面板默认折叠。
- Codex 的 `hi`、footer 和账号额度只显示主额度；保留主额度自身的短时窗口、周窗口，不展示 GPT-5.3-Codex-Spark 等模型的附加额度。
- `codex-accounts` 每项标题标注“备注”，正文显示“实际邮箱”；调用方逐个账号读取原生 `account/read`，被额度去重的记录也独立查询和显示。邮箱失败显示 MISS 及查询错误，不用备注或旧登录记录代替。
- Claude 订阅 footer 同时保留 5 小时与周额度，周额度按该条回复的模型选择专属窗口或总窗口；已返回的专属窗口缺数据时显示 MISS。hi 仍列出全部额度窗口。
- `background.ts` 累积 Claude `task_*`、Codex collab 和 DSH 子 Agent 事件；子 Agent 直接展示，普通前台命令留在 pending。任务行与委派共用 `agent-cards.ts`：默认折叠，标题明确标出“委派任务 / 子 Agent / 后台进程”类别、状态与最多 40 字说明，详情只保留任务说明短摘要，结果在卡片安全上限内完整展示，超限明确截断，具体类型、错误和最近三步动作仍保留；完成后显示实际耗时，运行中不放需要定时刷新的计时。禁止恢复独立后台卡和游标迁移。
- 临时会话选择卡只携带 `panel_id`、opaque `choice_id`。provider、cwd、source、owner、launch 保存在 Session 短期状态，不能信任回调传入的可执行 id、数组下标或路径。
- 公式段使用固定 id 的单个顶层 `column_set`，按源码顺序替换内部 markdown/image。小图可用 `crop_center` 和精确 `size`；宽图用 `fit_horizontal`，不传 `size`，由容器缩放。
- Card action 立即换卡返回 `{ card: { type: 'raw', data: card } }`。异步更新先返回 toast ACK，再调用 `feishu.updateCard()`；不用 callback-token 的 `/interactive/v1/card/update`，该端点会让 schema 2.0 卡片空白。`notify_callback` 在 Session 存在性检查前分流。

## 验证

- 模板、问答、工具和 IDs：`bun test src/cards/turn.test.ts src/cards/elements.test.ts src/cards/shell-command.test.ts`。
- 统一委派面板与后台任务：`bun test src/agent-cards.test.ts src/cards/agents.test.ts src/cards/task-board.test.ts src/cards/background.test.ts src/session.test.ts`。
- 公式事务：`bun test src/math-render.test.ts src/cardkit.test.ts src/session.test.ts src/cards/elements.test.ts`。
- Card action：`bun test src/card-action.test.ts src/card-action-runtime.test.ts src/notify-callbacks.test.ts`。真实交互需要明确授权的目标群。
