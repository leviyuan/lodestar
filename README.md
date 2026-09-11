<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

在飞书群里使用 Codex、Claude Code 和 DeepSeek Harness。每个群对应一个项目目录和会话，回复、工具调用、图片、提问及后台任务通过卡片展示。

支持 Codex 订阅、GLM Coding Plan、DeepSeek、OpenRouter 和 Claude native；账号、模型与 effort 可在群里切换并保存。

## 快速开始

需要 Node.js ≥ 18.15，支持 Windows、macOS 和 Linux。使用 DSH 时，其子进程需要 Node 22.19+（22.x）或 24+。

```bash
npm i -g @leviyuan/lodestar
lodestar-setup
```

完成向导后，把机器人拉进群，将群名设为项目目录名。发送消息开始工作，发送 `md` 选择账号和模型。

Agent 默认自动跟随上游 `latest`，在 daemon 启动时及每 6 小时检查更新；也可用 `lodestar-update --agents-only` 立即更新。

| 常用指令 | 作用 |
| --- | --- |
| `hi` | 查看会话、额度和 Codex 重置卡余量 |
| `md` | 按 Agent 分组选账号、模型和 effort；支持补录及隐藏 |
| `stop` | 打断当前回复 |
| `rs` / `cl` | 恢复会话 / 开始新会话 |
| `cm` | 压缩上下文 |
| `wt` / `btw` | 创建独立工作区 / 临时会话 |

单个发送文件不超过 **30 MB**。Codex 生图的提示词和图片默认折叠展示。

## 详细文档

| 文档 | 内容 |
| --- | --- |
| [安装与配置](docs/configuration.md) | CLI、配置文件、服务运行、Agent 自动更新 |
| [群内使用指南](docs/usage.md) | 完整命令、会话恢复、worktree、多模型任务、文件及通知 |
| [账号与模型](docs/models.md) | Token Source、effort、OpenRouter 默认模型、DSH 与 GLM 接入 |
| [后端与路由](docs/claude-agent-backend.md) | 运行机制、接口差异和维护说明 |
| [DSH 测试记录](docs/dsh-testing-report.md) | 原生工具、会话和飞书实测记录 |

## 开发

```bash
bun install
bun run typecheck
bun test
bun run build
```

源码运行：`bun run start`。真实飞书探针使用前请阅读[脚本说明](scripts/AGENTS.md)。

[MIT License](LICENSE)
