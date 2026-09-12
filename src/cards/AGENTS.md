# 卡片模板

本目录生成 Feishu Card Kit schema 2.0 JSON 和展示文本。模板保持纯函数，网络、文件、进程状态和持久化由调用方处理。

- 共享 `element_id` 从 `ELEMENTS` 取；动态 ID 稳定、同卡唯一，与替换、删除和换卡逻辑一致。
- 空 Markdown 使用占位，终态关闭 streaming；缺失值显示 `MISS`/`—`。模型行右侧窄按钮用单字（选、显、隐、删），宽按钮保留完整文案（补录模型、显示模型、返回模型列表、上一页、下一页、取消）。模型行之间加分隔线，文字和按钮垂直居中，不重复显示相同的模型名与 ID。
- 模型面板首页用独立的展开式折叠面板承载 `claude`、`codex`、`dsh` 各组：浅蓝标题背景、边框和 `Agent · Claude Code/Codex/DeepSeek Harness` 标题，Token Source 行放在组内，不能将两层名称平铺成同级粗体。再进入模型 → effort；action 携带 `panel_id`、`source_id`，拒绝过期 panel。
- 所有来源区分两类动作：接口项显示/隐藏（`model_add` / `model_remove`），列表外记录补录/删除（`model_custom_prompt` / `model_custom_remove`）。`origin` 决定行按钮，`custom_models` 持久化补录；补录成功后可直接选择使用；有多个 effort 档位才展示选择卡，单档位（含原生 default）直接应用，不能因目录未收录而设为空档位或仅显示 MISS。OpenRouter 默认十一项（榜单九项加字节、美团两家），其他来源跟随接口目录。删除仍被会话选用的补录项时拒绝操作；过期来源版本和跨页动作同样拒绝。
- footer 模型标识固定为 `agent · 模型名/effort`（agent 小写）。窗口额度沿用 `4.1h·7%·[6.9d·17%]` 的紧凑倒计时格式，不改成“额度 5h 已用…”或加入月度工具明细；余额显示 `余额 $…` / `余额 ¥…`。失败显示 MISS，不附加套餐、累计消费或解释性括号。
- Codex `request_user_input` 和 Claude `AskUserQuestion` 共用问答卡，保留各自回包语义、历史回答和自定义输入入口。
- `tool.ts` 生成工具摘要，`shell-command.ts` 解析 Bash、PowerShell 及引号包装后的首行 `# desc:`。Claude TaskCreate/Update/List/Get 在 `task-board.ts` 中累积为完整任务板。
- 生图工具默认收起，完整提示词放在折叠体内，图片以结构化 `img` 子组件展示并允许点击预览。不要把提示词塞进标题，也不要把已嵌入的图片再单独发送。图片上传由 Session helper 处理，模板只接收 image key。
- `hi` 的额度区用展开式浅蓝面板，与 `codex-accounts` 共用 `usage.ts` 的六格彩色进度条和重置倒计时；各窗口纵向分行，重置卡另起一行只展示 Codex 账号的可用次数，统一额度摘要与 footer 不附带它。活跃项目行尾显示实际 Codex 进程的账号备注；账号未知时省略整个备注，不显示账号 MISS。账号列表每页附完整 Codex 账号命令说明。
- `background.ts` 消费 Claude `task_*` 和 Codex collab 事件。子 Agent 细节进入 active/pending 后台状态，终态历史卡停止计时刷新。
- 临时会话选择卡只携带 `panel_id`、opaque `choice_id`。provider、cwd、source、owner、launch 保存在 Session 短期状态，不能信任回调传入的可执行 id、数组下标或路径。
- 公式段使用固定 id 的单个顶层 `column_set`，按源码顺序替换内部 markdown/image。小图可用 `crop_center` 和精确 `size`；宽图用 `fit_horizontal`，不传 `size`，由容器缩放。
- Card action 立即换卡返回 `{ card: { type: 'raw', data: card } }`。异步更新先返回 toast ACK，再调用 `feishu.updateCard()`；不用 callback-token 的 `/interactive/v1/card/update`，该端点会让 schema 2.0 卡片空白。`notify_callback` 在 Session 存在性检查前分流。

## 验证

- 模板、问答、工具和 IDs：`bun test src/cards/turn.test.ts src/cards/elements.test.ts src/cards/shell-command.test.ts`。
- 后台任务：`bun test src/cards/task-board.test.ts src/cards/background.test.ts src/session.test.ts`。
- 公式事务：`bun test src/math-render.test.ts src/cardkit.test.ts src/session.test.ts src/cards/elements.test.ts`。
- Card action：`bun test src/card-action.test.ts src/card-action-runtime.test.ts src/notify-callbacks.test.ts`。真实交互需要明确授权的目标群。
