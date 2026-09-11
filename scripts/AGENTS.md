# 脚本使用

这里包含安装脚本、真实飞书探针和人工 smoke。多数脚本会加载生产配置与 XDG 状态；`Session` 按群保存的选择启动后端。

| 脚本 | 副作用 |
| --- | --- |
| `smoke.ts`、`test-all.ts` | 在真实群发送文本、卡片、reaction 和文件，自行创建 Session |
| `test-inject.ts` | 向 debug context 指定的群发送可见消息，再注入正在运行的 daemon |
| `test-mid-turn-rotation.ts` | 通过 debug socket 发送 `kill` 和长任务，读取日志 |
| `cardkit-probe.ts` | 发多张测试卡，直调 Card Kit API |
| `test-codex-account-cards.ts --unsent` | 当前应用下创建一个未发送的 Card Kit 对象，验收账号卡片各状态，关闭流式状态；不发群消息 |
| `test-codex-multi-account.ts` | 私有默认/额外账号目录与 localhost 模型，验证三种 SQLite 配置下原生跨账号 resume；不使用真实凭据 |
| `test-codex-quota-recovery.ts` | 私有目录、模拟额度与 localhost 模型，真实 Codex 执行一次文件追加后连续两次额度耗尽，验证自动换号、同 thread 续跑和操作不重复；不接触真实账号或 daemon |
| `seed-debug-ctx.ts` | 查询群成员，将指定成员写入本机 debug context |
| `test-openrouter.ts` | 使用明确提供的私有 Key 和 `--agent-runtimes` 目录做付费 API/SDK Read 实测；不连接飞书或 daemon，支持请求参数核验与原生 resume 序列 |
| `test-dsh-glm.ts` | 使用已配置 GLM Coding Plan 做 DSH Read 与原生 resume 实测，只操作私有临时目录；不连接飞书或控制 daemon |
| `test-model-panel-live.ts` | 使用现有 daemon，在明确目标群验证分组、隐藏/显示、补录/删除、无效补录拒绝及真实回复；等待最终 footer 后检查模型/effort 与余额/额度，恢复原设置。`--routes-only` 可单测指定模型路由；不自行创建 Session 或控制 daemon |
| `postinstall.cjs` | 提示安装步骤和 Agent 自动更新机制；不安装锁定的 Agent 副本 |
| `test-generated-image-card.ts` | 向明确的测试群发送一张图片折叠测试卡，使用指定的已有图片；检查提示词、卡内图片及预览。不会调用生图模型、单发图片或启动 Session |
| `sync-security-deps.ts` | 同步普通安全依赖的发布版本声明，随后需用 Bun 同步锁文件；不锁定 Agent 版本 |
| `check-installed-package.ts` | 在明确的 npm prefix 验收 tarball、自动安装的最新 Agent、命令链接及原生目录，使用私有临时目录，不连接飞书或模型 API |

`smoke-session.ts` 共用账号、持久状态加载和完成检查；`debug-client.ts` 共用注入请求。它们不作为独立命令运行。

- 真实 smoke 需要明确账号、目标群和副作用。自行创建 Session 的脚本要求目标群的 live daemon 已停止；停止 daemon 仍需当前消息单独授权。
- 探针必须显式指定目标，不使用硬编码群或 `test1` 默认值。凭据、成员和 debug context 不写进仓库。
- 复用 `src/feishu.ts`、`src/session.ts` 和 `src/paths.ts`，不复制生产 API、账号路由和状态路径。覆盖说明与实际 provider 一致。
- 模型回调探针走 debug socket 的 `/model-state` 与 `/model-action`；显式 `chat_id` 必须匹配 debug context，动作还要绑定本应用的真实卡片和当前面板。它复用正常回调处理，不代表真实客户端手势已验证。测试记录写私有临时目录。
- npm lifecycle 不启动交互向导；首次向导由 `cli.ts` 在 TTY 中触发。native binary 不可用时由启动路径明确报错。
- Agent 更新跟随 latest，不以构建时版本或预先通过兼容测试作为用户更新的门槛；测试发现不兼容时修复适配，不能改回旧版本策略。
- 修改后先运行相关单元测试。npm lifecycle、native 依赖、构建引用或跨平台入口有变动时运行 `bun run build`。真实 smoke 完成后报告发送内容和本地状态变化。
