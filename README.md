<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

AI 不是帮手，是倍率。它放大的不是体力，是你 —— 你的直觉、判断和品味，每一样都被乘以一个你以前不敢想的系数。

夜航星让这件事真正发生：在你思考的地方接住想法，在你转身之后继续推向终点。

---

在飞书群里使用 Codex、Claude Code 和 DeepSeek Harness。每个群对应一个项目目录和会话，回复、工具调用、图片、提问及后台任务通过卡片展示。

支持 Codex 订阅、GLM Coding Plan、DeepSeek、OpenRouter 和 Claude native；[账号、模型与推理档位](docs/models.md)可在群里切换并保存。

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
| `stop` | `st` | 打断当前回复，取消排队消息 |
| `kill` | `kl` | 关闭当前 Agent 进程，保留会话记录 |
| `restart` | `rs` | 恢复当前会话；进程已停止时选择历史会话 |
| `clear` | `cl` | 清空当前对话，开始新会话 |
| `compact` | `cm` | 压缩上下文 |
| `worktree [名称]` | `wt [名称]` | 查看工作区；带名称时创建或加入独立工作区 |
| `btw` | — | 新建临时群与会话，共享当前工作目录 |
| `fork` | `fk` | 从选定输入之前分叉，在临时群中继续 |
| `back` | `bk` | 从选定输入之前分叉，在当前群中继续 |
| `bye` | — | 停止会话并解散当前临时群 |
| `agents` | `agent` | 查看可调用的 Agent 身份 |
| `task` | — | 管理飞书任务清单绑定 |

参数、使用条件和会话分支说明见[群内使用指南](docs/usage.md)。

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
