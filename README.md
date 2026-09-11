<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

AI 不是帮手，是倍率。它放大的不是体力，是你 —— 你的直觉、判断和品味，每一样都被乘以一个你以前不敢想的系数。

夜航星让这件事真正发生：在你思考的地方接住想法，在你转身之后继续推向终点。

---

## 项目特色

- **发条消息，就能开工**：在飞书里把任务交给 Codex、Claude Code 或 DeepSeek Harness，让 Agent 在你的项目里读代码、改文件、跑命令。
- **一个群，一个项目**：工作目录和对话跟着项目走；手头几个项目来回切换，回到群里就能接着上次的思路继续。
- **进展看得见，问题直接答**：回复、工具调用、图片和后台进展都在卡片里，需要你补充信息时，就在群里回答。
- **趁手的模型，自己选**：Codex 订阅、GLM Coding Plan、DeepSeek、OpenRouter 和 Claude native 都能接入；在群里切换[账号、模型与推理档位](docs/models.md)，每个项目记住自己的选择。

## 快速开始

```bash
npm i -g @leviyuan/lodestar
lodestar-setup
```

按向导完成配置，把机器人拉进以项目目录命名的群，发消息即可开始工作。[安装要求与详细配置](docs/configuration.md)

## 常用指令

在群内直接发送，不加斜杠，大小写不敏感。

| 完整指令 | 缩写 / 别名 | 作用 |
| --- | --- | --- |
| `hi` | — | 打开控制台，查看会话与额度 |
| `model` | `md` | 选择账号、模型和推理档位 |
| `kill` | `kl` | 关闭当前 Agent 进程，保留会话记录 |

完整指令、参数与会话分支说明见[群内使用指南](docs/usage.md)。

## 附加能力

- [多模型协作](docs/usage.md#多模型任务)：将任务交给一个或多个模型执行，支持并发协作与后续追问。
- [飞书任务清单](docs/usage.md#飞书任务清单)：在项目群创建、绑定和删除任务清单。
- [脚本通知](docs/usage.md#本机通知)：让本机脚本向群里推送通知，支持图片、交互按钮和文字回复。

## 详细文档

| 文档 | 内容 |
| --- | --- |
| [安装与配置](docs/configuration.md) | 安装要求、CLI、配置、自动更新与源码开发 |
| [群内使用指南](docs/usage.md) | 完整命令、会话恢复、worktree、多模型任务、文件及通知 |
| [账号与模型](docs/models.md) | 账号接入、模型选择、推理档位与额度 |
| [后端与路由](docs/claude-agent-backend.md) | 运行机制、接口差异和维护说明 |

[MIT License](LICENSE)
