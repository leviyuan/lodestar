# Codex 重置公告监控

每五分钟独立读取 Codex Resets 公开接口和 Telegram `codexreset` 频道。GLM-5.3-Flash 只分类 JSON；按原规则过滤猜测和重复公告、保留明确公告的补发策略后，通过本机 Lodestar `/notify` 发到 `feishu` 绑定群。双来源连续失败超过两小时只告警一次，恢复后重新计时。读取、模型或通知失败保留错误及待处理队列，不重建状态、不更换来源或模型。

源码属于当前项目；去重状态默认位于 `~/.local/share/codex-reset-rss/state.json`，遵循 `XDG_DATA_HOME`，也可显式指定 `CODEX_RESET_STATE_PATH`。状态必须从旧服务迁入，缺失或格式错误会退出。迁移时先停旧定时器并等当前运行结束，再复制最终状态，最后启动新服务。

Python 3.9+ 只使用标准库（依赖 Unix 的 `fcntl`，支持 macOS/Linux）。`CODEX_RESET_BUN` 指定 Bun 的绝对路径。分类器直接读取本机 Lodestar 已配置的 GLM 平台和共享凭据，复用项目网络适配及实时模型目录，调用该平台的 Anthropic 兼容 Messages API；不启动 Agent、不创建额外会话或任务卡，不复制账号配置。新调用审计保留模型标识、目录摘要、请求 ID 与用量，不记录凭据；原状态中的历史判断审计保持原样。

```bash
# desc: 读取真实来源并核对增量但不产生业务副作用
python3 scripts/codex-reset-monitor/monitor.py --dry-run
```

`--dry-run` 不写状态或锁文件、不调用模型、不推送；`--check-source` 只读公开来源，`--status` 显示状态。模型目录预检用 `bun scripts/codex-reset-monitor/glm_judge.ts --check-runtime`，也不创建模型请求或通知。普通运行会处理真实业务事件。

Mac 使用独立 LaunchAgent `com.leviyuan.codex-reset-monitor`，将 `launchd.plist.in` 中占位符替换为实际绝对路径后安装至 `~/Library/LaunchAgents/`。`RunAtLoad` 启动时执行一次，`StartInterval=300` 后续每五分钟执行，单次进程正常退出；因此闲置状态并不表示服务故障。状态目录需 0700、状态文件 0600。`launchctl print gui/$(id -u)/com.leviyuan.codex-reset-monitor` 查看运行次数和退出码，stdout/stderr 日志在状态目录。该服务不控制 Lodestar daemon。

状态写入使用同目录的私有临时文件后原子替换，即使手动运行也保持文件权限 0600。本机安装后的 plist、状态和日志不纳入版本控制。此脚本随源码管理，不包含在 npm 发布包中。

离线回归用 `bun test scripts/codex-reset-monitor`，也可直接运行 `python3 -B scripts/codex-reset-monitor/test_monitor.py`。测试覆盖故障恢复、通知重试、跨来源和历史去重兼容、状态权限与限流冷却；来源、模型和通知均被隔离替代，不操作真实服务。
