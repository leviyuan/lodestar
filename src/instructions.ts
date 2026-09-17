import type { AgentProvider } from './agent-process'
import type { FileDeliveryMode } from './file-delivery-types'

/** 注入各后端的文件收发、澄清提问和 shell 卡片标题约定。 */
const FILE_HANDOFF = '生成并检查本地文件后，在回复正文中独占一行输出 `[[send: /abs/path]]` 提交交付，路径必须替换成实际存在的绝对路径。只在用户要文件或交付最终产物时使用。'
const FILE_TRANSPORT_OWNER = '交付本地任务产物时，上传、权限和卡片均由 Lodestar 处理。Agent 不直接调用这些飞书接口，不为交付读取凭据或查找 token，也不依赖飞书 CLI。被委派的 Agent 只返回文件路径和说明，由主 Agent 提交交付。'
const FILE_DELIVERY_RESULT = '交付标记只表示提交，不能据此声称上传成功。以 Lodestar 实际发出的附件、交付卡或错误提示为准，不编造云空间链接，不用其他工具重复发送。'
const FILE_DELIVERY_SWITCH = '`files`、`files on`、`files off` 是用户在群里输入的管理命令，不是 Shell 命令；不要擅自切换交付方式或改写工作目录配置。'

/** Only the selected transport contributes constraints; Drive has no IM-size instruction. */
export function fileDeliveryInstructions(mode: FileDeliveryMode): string {
  return [
    `- ${FILE_HANDOFF}`,
    ...(mode === 'chat' ? ['- 本群通过聊天附件交付，交付前检查文件大小，单文件不超过 30 MB（30 × 1024 × 1024 字节）；超限先无损压缩或分卷，保持用户要求的内容。'] : []),
  ].join('\n')
}

const COMMON_TAIL_INSTRUCTIONS = [
    "- 使用图片生成工具生成图片后,不要再补充说明文字或 `[[send: ...]]`;Lodestar 会自动展示图片和提示词，支持时放进折叠面板，无法嵌入时单独发送。若你用脚本或文件编辑生成图片,按上一条用 `[[send: /abs/path]]` 发出。",
    "- 每次调用 Bash / shell 命令时,第一行都必须写 shell 注释 `# desc: <一句中文说明>`,再写真正命令。这个注释只给 Lodestar 卡片做摘要,不要依赖它改变命令行为。",
]

export function channelInstructions(provider: AgentProvider, mode: FileDeliveryMode): string {
  const questions = {
    codex: '- 当你有问题需要澄清时，使用 request_user_input 工具向用户提问；不要把多选题写成文本。',
    claude: '- 当你有问题需要澄清时，使用 Claude Code 自带的 AskUserQuestion 工具向用户提问。',
    dsh: '- 当你有问题需要澄清时，使用 ask_user_question 工具向用户提问；不要把多选题写成文本。',
  }
  return [
    '- 以 `[file: /abs/path]` 开头的文本表示该路径上挂着一个文件,相关时去读它。',
    fileDeliveryInstructions(mode),
    '- 文件交付约定由 Lodestar 按工作目录设置生成；后续收到宿主注入的“文件交付约定更新”时，用其完整替换此前的文件交付约定。',
    `- ${FILE_TRANSPORT_OWNER}`,
    `- ${FILE_DELIVERY_RESULT}`,
    `- ${FILE_DELIVERY_SWITCH}`,
    questions[provider],
    ...COMMON_TAIL_INSTRUCTIONS,
  ].join('\n')
}

/** Sent once when a live process needs new rules, never on every ordinary input. */
export function fileDeliveryAgentContext(mode: FileDeliveryMode): string {
  return `[Lodestar 文件交付约定更新]\n以下约定从本轮起完整替换此前的文件交付约定：\n${fileDeliveryInstructions(mode)}`
}
