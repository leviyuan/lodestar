# 文档维护

README 只保留项目介绍、快速开始和文档入口。详细内容按主题维护，事实以源码和测试为准。

- `configuration.md`：安装、CLI、运行目录、配置与 Agent 自动更新。
- `usage.md`：群内命令、会话、worktree、文件与生图、本机通知。
- `models.md`：账号、模型与 effort、OpenRouter 默认列表、DSH 与 GLM 接入。
- `claude-agent-backend.md`：后端实现、模型路由和会话行为。
- `dsh-testing-report.md`：注明版本与日期的历史测试记录。

- 保留 Codex、Claude、GLM、DeepSeek、OpenRouter、DeepSeek Harness 和 Claude native 的支持说明。
- 只写已实现的行为。删除失效接口、历史方案、重复规则和无法复现的验证结论；不另建产品规范或计划。
- 不记录凭据、真实 session id、群成员或本机配置。验证结果需对应实际运行的命令，不保留过期通过数。
- 文字变更检查引用的路径、方法和命令；伴随实现变化时按对应目录指引运行测试。
