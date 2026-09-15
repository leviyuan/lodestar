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
- Agent 更新锁内的 PID 必须原子写入，避免并发更新读取到空文件；写入失败清理本次取得的锁，清理失败同时报告。
- DSH 通过 `dsh-runtime.ts` 启动当前安装的 Node runtime，`dsh-bridge.ts` 与该运行时从同一依赖树加载，只校验 Lodestar 自有通信协议，不硬编码上游版本。它直接调用原生 Agent/持久化/提问服务。恢复点与结果分别经过 flush；只以真实结束原因结算。取消原因须保持不可变，避免 Node fetch 附加 stack 后被原生日志拒绝。
- DSH 模型能力和 effort 使用原生 LLM 服务解析，目录外模型也调用 `resolveModelInfo/resolveCallConfig`，不另设目录白名单。`dsh-glm` 将账号模型与补录项一起配置给 pi-ai，显式传递用户所选 reasoning_effort，不以安装时目录是否收录作为可用性门槛。同轮请求固定路由，`LODESTAR_DSH_*` 由选定来源注入，不能串用 DeepSeek/GLM 凭据。`DSH_LODESTAR_AGENT_CONTEXT` 由 ShellEnv 仅注入运行时根 Agent，原生子 Agent 不能继承主会话 capability 或继续委派。
- DSH/SDK 子工具的返回值可能是内容块数组，后台卡须先规范成文本摘要。图片编码按字节判断，不能信任飞书下载文件的 `.png` 后缀。桥接致命错误不得伪装成预期退出。
- Token Source factory 管理 enabled、模型刷新、spawn env、模型解析、settings 来源和额度。GLM/DeepSeek/OpenRouter 清除冲突 Anthropic env 后注入凭据，默认读取 project/local；native 读取 user。Claude Code 订阅 `claude-sub` 独立共存，通过 SDK `accountInfo` 确认第一方订阅；清除冲突环境并用进程级 settings 覆盖路由，保留 user/project/local 的其他设置；认证确认前不得发送用户输入。跨 source 必须换进程。OpenRouter 默认十二模型（Claude Opus 5、Fable 5.1、榜单其余八项及字节、美团），排除 OpenAI/GLM/DeepSeek，MD 可增删且空列表必须持久化；账户余额取 `/credits` 的 `total_credits - total_usage`，不改用 `/key` 的限额或用量。`default` effort 表示不发该参数，需按 `modelEnvironmentRevision` 比较启动环境，不能简化为省略 SDK 选项或原进程直接改环境。
- 主会话 MD 按 Agent 分组 source，再进入 model → effort；只有一个档位时跳过 effort 卡并复用持有生命周期锁的正常选择流程，空档位仍报错。`withModelVisibility` 区分接口项和补录项：接口项显示/隐藏；所有来源的 `custom_models` 支持补录/删除。补录项使用原生解析或 Agent 请求档位，不能只保存不可选择的 MISS 记录；上游收录同名模型后按接口项管理。OpenRouter 维护默认十二项起步的显式列表，其余来源跟随接口目录并过滤 `hidden_models`。隐藏不改运行配置；删除补录项须保护正在选用的会话，并清理悬空默认/slots。同源设置走 `setModelSettings`；跨 provider/source 或 Claude profile 的切换在 turn、开卡或排队期间拒绝，空闲时终止不匹配进程。
- `md` 先等待目录刷新再生成账号卡，刷新失败显示 MISS，不能将加载中清空的数组显示为零模型。`debug-model.ts` 仅为本机模型测试提供白名单事件与脱敏状态；实际动作仍经过 daemon 的正常 Card action 队列。
- `claude-sub [on|off]` 查询或更新 `[token_source.claude-sub].enabled`，仅控制 Lodestar 的订阅来源，全群共用且持久化；不改本机登录或其他来源。禁用时跳过模型/额度查询，MD 刷新不能重新启用；已有任务继续，主会话在接收与实际提交新输入前检查来源，未提交的排队消息明确报错。开启开关仍受原生登录验证及 ReClaude 互斥约束。
- `claude-usage.ts` 通过 Claude SDK 原生 `/usage` 控制接口读取订阅额度，沿用 `claude-sub` 的认证隔离，不发送模型对话、不扫描历史 transcript。`utilization` 已是 0–100 百分比，不能套用流式事件的 0–1 比例。hi 展示主窗口及模型专属周窗口；footer 同时显示 5h 与周额度，按该条回复的 `turn.model` 选择匹配的模型专属周窗口，没有专属窗口时才使用总周额度。已返回的专属窗口缺数值时仍 MISS，模型未知或匹配歧义时也 MISS。查询结束关闭控制进程，失败显示 MISS，不缓存旧额度或改用其他数据源。
- ReClaude 来源复用官方客户端管理的本机 Claude 登录与 HTTP 代理，保持 SDK 默认入口；`sk-rec-` 设备 key 不能作为 `CLAUDE_CODE_OAUTH_TOKEN` 注入。启动前核对设备与本机凭据、后台进程、端口和 CA；Lodestar 不安装或启动客户端。启用后停用重复的 `claude-sub` 来源。`rck_` 个人 key 仅查询 `org_id` 指定组织的拼车 5 小时用量，不进入模型环境，不当余额展示；失败显示 MISS，未返回的重置时间保持未知。
- `fk`、`bk` 和进程停止后的 `rs` 使用原生会话能力：Claude transcript + `forkSession/resumeSessionAt`，Codex `thread/list` + `thread/fork(lastTurnId)`。checkpoint 包含 provider、源会话、cwd 和原生锚点。Claude fork 在首条输入前保存 pending launch，得到新 session id 后才清除。不得扫描或复制 Codex rollout，也不能把 fork 失败当成 resume。

- Codex 多账号对外仍为 `codex-sub`，账号命令为 `codex-login [备注]`、`codex-login-cancel [备注]`、`codex-accounts`、`codex-account [备注]`、`codex-account-delete 备注`、`codex-auto`、`codex-reset [备注]`。删除只针对额外账号，清理独立目录、额度缓存与各群指定；保护默认账号和共享路径，被会话、委派、额度/模型查询或登录占用时拒绝。默认账号就是设备原生 CODEX_HOME；额外账号通过 `codex-accounts.ts` 管理独立认证与共享会话路径，禁止复制或覆盖默认认证。设备码登录交给原生 app-server，完成通知按 loginId 关联；同时收到登录成功和 account/updated(chatgpt) 后才读取账号，避免读到登录前的缓存空值。取消按发起者校验，停机收回登录进程。回复用原地更新的简洁卡片，终态移除验证码，取消复用原登录卡；同账号登录与新进程启动互斥。查询失败显示 MISS；列表按原生身份去重，hi 和 footer 仅显示实际进程所用账号，footer 保留原紧凑格式。
- `codex-quota.ts` 按 Plus/prolite/pro 的 1/5/20 份周额度计算周剩余/距重置小时；Plus 的 5h 满窗是 0.15 份，分数取周速率和短窗速率较小值。所有模式降序选择，同分比较当前可连续使用额度。成功 Plus 响应缺短窗按满窗 0.15/5 计算，标记 `unreportedFull`，不造重置日期；请求失败或已返回窗口畸形仍 MISS。自动 Ultra 排除 Plus，要求周剩余至少 0.5 份；不足是 waiting，不是耗尽，普通模式仍可用。主会话与委派共用 `agent-launch.ts` → `CodexAccountProcess`。
- 手动指定最高优先：`hi 备注` 通过 Session 生命周期只覆盖这次启动，已有其他账号则重启并 resume；`codex-account` 持久指定、`codex-auto` 清除。手动路径不读额度、不检查套餐、Ultra 门槛或本地模型目录；保留账号存在性、认证文件隔离、原生进程退出与登录写入互斥这些结构约束，真实错误交由 Codex 返回。自动路径仍检查模型与全部实际限额、身份、登录租约。启动及换号优先用 daemon 内上次成功额度缓存，能选出账号就不查询额度，也不等其他账号补缓存；无可用缓存才刷新。网络刷新失败保留这份启动缓存，实时查询和 footer 仍报 MISS；重新登录清空两份缓存。旧缓存不得清除原生耗尽记录，主动查额度和耗尽等待轮询仍读实时接口。运行中耗尽后转自动选择，手动原生默认模型在恢复时必须原样传给新进程，不能变成另一账号的默认模型。
- 原生 `usageLimitExceeded` 只在主 turn 终态失败或明确 `turn/start` 拒绝后触发换号。`codex-account-process.ts` 保持同一逻辑任务，等待原生落盘与真实退出再替换子进程、resume 同一 thread；已接受任务只续跑，不重放输入。耗尽状态由 `codex-account-scheduler.ts` 原子保存，接口确认窗口恢复后解除；全部耗尽自动等待且可取消。初次等待通过显式 `quotaWaitPromise` 释放 Session actor，不能伪造 init 或占住 stop。网络、认证、普通 HTTP 429 不切号。委派分别记录实际账号；换号保留模型、effort、host capability、权限和工具入口，旧后台任务显式结算，旧进程迟到事件不得关闭新任务。
- Codex 额度查询遇到已知网络瞬态错误时重试同一接口，最多 3 次，间隔 1s、4s；最终失败保留原始错误并显示实际尝试次数。自动选号区分账号检查失败（MISS）、未配置账号和不符合条件，不能将额度查询失败笼统显示为没有可用账号。

## 委派 Agent

- `agent-*` 提供单层模型委派。只有主 Agent 能发起任务或续跑；同一任务的多个身份放在一个 run 内并发。被委派的 Agent 自行完成任务，需要额外派工时报告主 Agent。
- `lodestar-agent identities` / `GET /agents/identities` 通过原生订阅额度接口校验 Claude 订阅，成功和失败结论均缓存 30 分钟；首次查询或到期后的下一次取列表才刷新，并发请求共用一次校验。刷新失败替换旧结论，身份不进入 Skill 返回列表，原因保留在 `source_failures`；后续刷新确认恢复时重新列出。只缓存校验结论，配置重建后的来源重新校验，不修改 MD 的来源、模型目录和启用状态。
- 共用 `agent-launch.ts` 的 coding-agent 启动入口。主会话保留原生能力；委派进程只关闭继续委派的工具（Codex `multi_agent`、Claude `Agent`/`Task`），其余代码工具、MCP、Skill、模型与 effort 保持不变。
- 每个 worker 获得独立、可撤销的 `LODESTAR_AGENT_*` capability，运行时拒绝其再次发起任务或续跑；Skill 与 worker 提示词同步声明禁止继续委派。历史父子记录仍可读取和清理。
- 委派任务按全局 8 个并发槽和 Token Source 上限排队并显示原因；OpenRouter 在同一 daemon 的所有项目、模型间共用 2 个委派名额，这是本地策略而非上游额度。满额来源不得堵住其他来源。取消未确认的进程必须继续保留 handle 与槽位，失败向 Session 传播，不能标成已取消后丢掉控制权。
- 提问进入 `needs_input`，answer 后恢复；非输入权限请求放行。委派任务不设整轮时长上限，不截断返回正文，结束由后端终态或用户取消决定；follow-up 复用 provider 原生 session。
- `run --session <session_id>` / `POST /agents/runs` 的 `session_id` 从本群同工作目录的委派历史选择最新一轮，复用原身份及上一轮 effort；每轮新建 run，原生 session 不变。续跑必须等原任务终态和进程退出；同一 provider/session 在开卡、排队及执行期间禁止重叠续跑，不能把恢复失败转为新会话。
- `run` / `follow-up` 必填单行 `description`（CLI `--description`，最多 60 字）。委派、原生子 Agent、后台任务共用 `agent-cards.ts` 的同一实例；一项一个默认收起的面板，标题仅状态与说明，详情保留类型、结果、错误及最近三步动作。子 Agent 启动即展示，普通前台命令仍先观察；原生启动工具与 SDK task id 回填复用同一项。按群尾实际消息复用委派卡，满卡或新消息后新任务开新卡，原任务留在原卡更新，不再迁移后台游标。共享卡的 streaming/dispose 统一结算，单项终态不得关闭同卡其他任务；停止进程先排空已接收写入，再结算所属任务。群内出站消息与委派追加通过 `chat-message-order.ts` 排序；读取群尾或写卡失败须报错，不能猜测位置。
- 每次状态转换原子落盘；大 prompt/输出单独存入私有 artifact，快照不重复内嵌。委派 session id 单独登记，从主会话 `rs`/`fk` 历史排除。
- 委派历史索引和父子关系不能按缓存数量删除；仅淘汰已完成、已落盘且进程退出的旧正文缓存。`status` 按原 artifact 读取完整正文，读取失败报错；续接保留原生 session、最新一轮 effort 和群/目录边界。
- 父 run 取消、Session stop/kill/restart 和 daemon shutdown 在首次 await 前关闭新建入口、吊销 capability，并递归回收后代进程。
- Skill 内容由 `managed-skills.ts` 同源同步至 Codex/Claude standalone 目录和 Claude 本地插件。排除 user settings 的主会话显式加载插件，不能为发现 Skill 混入 user env。
- `lodestar-files` Skill 与各后端交付指令共用 `instructions.ts`，`file-delivery-skill.ts` 通过既有受管 Skill 管线同步。`channelInstructions(provider, mode)` 在主 Agent 启动时按群设置生成，只有聊天附件模式在交付标记旁注入 30 MB 约束；云空间提示词和共享 Skill 不提这个数字。Skill 仅在宿主明确提供上限时要求检查大小，不让 Agent 查接口/配置来推断。Agent 只生成/检查本地文件并提交标记，不承担上传、分片、授权或发卡接口；委派 Agent 返回路径给主 Agent。群开关由用户操作，不能让 Agent 为交付读取凭据或修改配置。

## 卡片与持久化

- 已结束的共享任务卡补充正文时，Card Kit 可能重开 streaming，必须作废旧设置缓存并重新确认关闭。卡片设置更新失败须向调用方保留原始错误、code 和 log_id；委派告警显示具体错误及任务说明，完整错误仍保存在运行记录中，不能只报数量或抹去失败。

- Lodestar 自有出站 HTTP 统一使用 `network.ts` 的 `networkFetch`；本机 capability 和通知回调用 `localFetch`。`network-proxy.ts` 按协议环境变量、`ALL_PROXY`、当前用户的手动系统代理解析，统一大小写和绕过规则；系统查询失败、非法代理、未支持的 SOCKS/PAC 不得转为直连。每次重定向重新判断路由，跨 origin 清除认证，本机请求不得跳出 loopback。Agent 与飞书 SDK 自身网络由各自应用/SDK 配置，不改其全局环境。网络改动需运行真实本地代理测试，不能仅依赖 mock fetch。

- `hi` 的 Codex 重置卡次数来自额度接口 `rateLimitResetCredits.availableCount`，保留合法的零，缺失用 MISS；不推算剩余次数，也不显示在 footer。hi 的每个额度窗口独占一行，footer 继续使用紧凑格式。`codex-reset [备注]` 经 `usage.ts` 的原生控制连接使用一次重置卡，同账号并发使用互斥，同消息与有限网络重试复用幂等标识；消费后失效旧额度查询并重新读取。四种原生结果必须区分，已确认消费后发生刷新或连接关闭失败仍保留消费结果并显示错误。
- Codex 额度展示统一只用主额度的短时窗口和周窗口；`token-source-codex.ts` 不向统一展示导出 Spark（GPT-5.3）或其他模型的附加桶。全量桶继续供内部按模型调度，不能用附加桶替代缺失的主额度。
- 生图完成事件补回的 prompt/revisedPrompt 要更新工具元数据。`session-tools.ts` 上传图片并通过 Card Kit 放入折叠面板，确认落地后才标记已交付；嵌入失败按用户约定单独发图。图片任务按原卡归属登记，关闭和换卡均须等待，避免图片在卡片退役后丢失。
- 文件默认由 `feishu.ts` 直接发送聊天附件，保留 30 MB 上限。`files on/off` 通过 `group-file-delivery.ts` 按 chat_id 保存开关与固定云空间目录；目录名跟随实时群名，跨轮次/重启复用，关闭不删文件或解除绑定。`file-delivery.ts` 只收集本轮新文件，卡片只列本轮，管理入口指向该群全部历史云空间交付文件。`feishu-drive.ts` 直调 API，权限为开启者/交付发起人 full_access、群 view，失败不切回其他渠道。Session 在输入交给 Agent 时固定该轮方式，保证生成要求与实际通道一致；按进程记录已注入模式，开关切换在下一轮用户输入时更新一次，后台续跑沿用已注入规则，不能每条输入重复规则或为此重启进程。云空间收尾等待上传和独立卡，换卡及排队消息转交不重置或取消交付；卡片终态文案（含 Agent 错误）不能作为取消信号。停止/重启通过会话交付集合取消未完成上传（包括已捕获的旧轮次）。原附件、自动图片通道和旧聊天文件保留；云空间文件不自动删除。
- 文件/图片上传和所有 SDK 消息发送共用 `feishu-retry.ts`：已知网络瞬态错误、HTTP 408/429/500/502/503/504 和飞书限流码 99991400/230020 最多尝试 3 次（间隔 1s、4s，遵守不超过 60s 的 Retry-After/x-ogw-ratelimit-reset）；权限、参数、本地文件和畸形成功响应直接报错。上传重试重建 multipart 和超时信号，消息重试复用同一 UUID 与上传 key；上传成功后的发送失败也须在群里显示，不能只返回 false。
- 云空间新文件默认可能是 `tenant_readable`，不能认为文件夹关闭链接分享就覆盖了文件。`feishu-drive.ts` 在获取、发布文件链接之前通过 v2 public permission 将文件的 `link_share_entity` 设为 `closed` 并重新读取确认；失败保留已上传 token、报告错误，不得发布成功链接。协作者授权仍有效，人工转授权不属于此保证。
- 生产 Card Kit mutation 经 per-card queue，在执行时分配 sequence，并共用 `feishu-retry.ts` 的有限网络重试。一次请求的重试复用同一 UUID、sequence 和序列化内容，每次重建超时信号；TTL 重开及重开后的写入各分配新 UUID 和 sequence。重试耗尽才触发写入失败回调，不把网络错误当容量超限。需要据结果更新 rendered 或持久状态的事务使用 checked API。
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
