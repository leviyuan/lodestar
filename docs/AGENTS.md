# 文档维护

`claude-agent-backend.md` 说明当前双后端、模型路由和会话行为。涉及对应模块时按需阅读，事实以源码和测试为准。

- 保留 Codex、Claude、GLM、DeepSeek、OpenRouter、DeepSeek Harness 和 Claude native 的支持说明。
- 只写已实现的行为。删除失效接口、历史方案、重复规则和无法复现的验证结论；不另建产品规范或计划。
- 不记录凭据、真实 session id、群成员或本机配置。验证结果需对应实际运行的命令，不保留过期通过数。
- 文字变更检查引用的路径、方法和命令；伴随实现变化时按对应目录指引运行测试。
