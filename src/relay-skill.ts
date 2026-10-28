import { syncManagedSkill } from './managed-skills'

export const RELAY_SKILL_NAME = 'relay-config'

/** Agent-facing instructions for configuring a relay through the live daemon.
 * The URL and bearer capability are inherited from the current Agent process. */
export function relaySkillBody(): string {
  const description = 'Configure and test Lodestar generic relay endpoints through the live daemon without restarting Lodestar. Use for API key, base URL, protocol, model catalog reload, and optional balance-script setup.'
  return `---
name: ${RELAY_SKILL_NAME}
description: ${JSON.stringify(description)}
---

# relay-config

配置 Lodestar 通用中转站时，使用当前 Agent 环境继承的 \`LODESTAR_AGENT_URL\` 和 \`LODESTAR_AGENT_CAPABILITY\`，不要重启 Lodestar，也不要直接改运行中的进程。

当前支持两种协议：

- \`anthropic\`：Claude Code Anthropic Messages。
- \`openai\`：同时生成 Codex Responses 和 DeepSeek Harness OpenAI Completions 两个来源。

已研究的站点仅作为起始提示，必须先调用 test 接口，不要盲信站点名称或旧教程：

- \`api.zhongzhuan.win\`：公开检测显示同时有 Claude 和 OpenAI 协议；通常根地址用于 Anthropic，Codex 地址带 \`/v1\`。公开检测样本提示 token 用量和思维签名能力存在不稳定记录。
- \`aicost.me\`：当前公开 API 文档使用 \`https://www.aicost.me\`，OpenAI/视频接口以 \`/v1\` 为前缀；站点前端为 New API，模型目录和具体可用模型以 Key 权限返回为准。
- \`yatui.cc\`：这是教程/门户，不是稳定 API 根地址；页面提示迁移到 API 新站 \`api.ai-pixel.online\`，Claude 通常用不带 \`/v1\` 的根地址，Codex 用带 \`/v1\` 的地址，最终以 Key 页面展示为准。

## 先测试，再保存

\`\`\`bash
# desc: 测试中转站地址、Key 和模型目录
python3 - <<'PY'
import json, os, urllib.request
body = json.dumps({
  "site_id": "site-id",
  "display": "站点显示名",
  "protocol": "openai",
  "base_url": "https://example.invalid",
  "api_key": "填写 Key"
}).encode()
req = urllib.request.Request(
  os.environ["LODESTAR_AGENT_URL"] + "/agents/relays/test",
  data=body,
  method="POST",
  headers={"Authorization": "Bearer " + os.environ["LODESTAR_AGENT_CAPABILITY"], "Content-Type": "application/json"},
)
print(urllib.request.urlopen(req).read().decode())
PY
\`\`\`

测试接口只读，不写配置。成功返回站点协议、规范化地址和模型目录；失败先修正地址、Key 或模型目录接口。

## 保存并热重载

把测试成功的 JSON 改为配置请求，发送到：

\`\`\`text
POST /agents/relays/configure
\`\`\`

请求字段：

\`\`\`json
{
  "site_id": "site-id",
  "display": "站点显示名",
  "protocol": "openai",
  "base_url": "https://example.invalid",
  "api_key": "填写 Key",
  "balance_script": "/abs/path/to/balance-script"
}
\`\`\`

接口会校验模型目录、原子写入 \`[relay.<site_id>]\`、重建 Token Source registry，并立即刷新该站点的 Claude/Codex/DSH 视图。成功返回 \`sources\` 及每个来源的模型状态。不要再发送 restart。

只重新读取配置并刷新已保存的站点时，使用：

\`\`\`text
POST /agents/relays/reload
body: {"site_id":"site-id"}
\`\`\`

省略 \`site_id\` 会刷新全部 relay 站点。

余额脚本是可选的；脚本只通过配置字段绑定，不要把 Key 写入命令行或日志。配置后用 reload 立即生效。

接口调用失败时，把 HTTP 状态和返回的安全错误交给调用方；不要回显完整 API Key。`
}

export function ensureRelaySkill(): void {
  syncManagedSkill({ name: RELAY_SKILL_NAME, body: relaySkillBody() })
}
