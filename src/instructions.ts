import type { AgentProvider } from './agent-process'
import type { FileDeliveryMode } from './file-delivery-types'

/** 注入各后端的文件收发、澄清提问和 shell 卡片标题约定。 */
export const FILE_DELIVERY_SKILL_NAME = 'lodestar-files'

const FILE_HANDOFF = '生成并检查本地文件后，在回复正文中独占一行输出 `[[send: /abs/path]]` 提交交付，路径必须替换成实际存在的绝对路径。只在用户要文件或交付最终产物时使用。'
const FILE_TRANSPORT_OWNER = '交付本地任务产物时，上传、权限和卡片均由 Lodestar 处理。Agent 不直接调用这些飞书接口，不为交付读取凭据或查找 token，也不依赖飞书 CLI。被委派的 Agent 只返回文件路径和说明，由主 Agent 提交交付。'
const FILE_DELIVERY_RESULT = '交付标记只表示提交，不能据此声称上传成功。以 Lodestar 实际发出的附件、交付卡或错误提示为准，不编造云空间链接，不用其他工具重复发送。'
const FILE_DELIVERY_SWITCH = '`files`、`files on`、`files off` 是用户在群里输入的管理命令，不是 Shell 命令；不要擅自切换交付方式或改写群配置。'

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
    '- 文件交付约定由 Lodestar 按群设置生成；后续收到宿主注入的“文件交付约定更新”时，用其完整替换此前的文件交付约定。',
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

/** The Skill and mandatory per-backend instructions share the same delivery contract. */
export function fileDeliverySkillBody(): string {
  const description = '在 Lodestar 飞书会话中交付本地生成或已有的报告、PDF、视频等任务文件。主 Agent 用交付标记交给宿主发送，委派 Agent 返回文件路径；不用于搜索或编辑用户指定的已有云文档。'
  return [
    '---',
    `name: ${FILE_DELIVERY_SKILL_NAME}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    '# Lodestar 文件交付',
    '',
    '仅用于 Lodestar 托管的会话。交付标记需要宿主处理，不能在普通终端或其他聊天环境里把它当作上传命令。',
    '',
    FILE_HANDOFF,
    '',
    '交付前完成文件生成与必要检查，确认文件存在、可读取。多个文件各写一行交付标记；把下面的示例路径替换成真实文件路径，不要在说明中原样发送示例标记。',
    '标记写在主 Agent 的回复正文里，不写进脚本的标准输出、文件内容或仅放在工具返回值里。',
    '',
    '```text',
    '[[send: /abs/path/report.pdf]]',
    '[[send: /abs/path/video.mp4]]',
    '```',
    '',
    FILE_TRANSPORT_OWNER,
    '',
    '## 交付要求',
    '',
    '以 Lodestar 启动 Agent 时注入的文件交付约定及后续约定更新为准。只有约定明确给出文件大小上限时，才按该上限检查和处理；不自行查询配置、推断限制或按账号认证状态决定交付方式。',
    '',
    FILE_DELIVERY_SWITCH,
    '',
    '## 宿主负责的结果',
    '',
    '云空间模式下，Lodestar 把本群各轮文件放进与群名一致的固定文件夹。独立卡片只列本轮文件，“管理群文件”打开本群所有历史云空间交付文件。目录复用、上传与重试、授权和发卡都由后台实现；这里不需要上传脚本或接口步骤。',
    '',
    FILE_DELIVERY_RESULT,
    '',
    '系统报告交付失败时，向用户说明实际错误；不要换上传工具、身份或存储来源掩盖失败。用户另行要求管理已有云文档时，按该请求的实际范围处理，不把它混入本地产物交付。',
    '',
    '图像生成工具的图片沿用 Lodestar 自动展示规则，不再重复提交交付标记。',
    '',
  ].join('\n')
}
