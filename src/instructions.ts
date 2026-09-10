/** 注入两个后端的文件收发、澄清提问和 shell 卡片标题约定。 */
const COMMON_CHANNEL_INSTRUCTIONS = [
    "- 以 `[file: /abs/path]` 开头的文本表示该路径上挂着一个文件,相关时去读它。",
    "- 在回复任意位置，独占一行写 `[[send: /abs/path]]` 即可把该文件作为单独一条消息送出。只在用户主动要文件、或你要交付最终产物时才发。",
]

const COMMON_TAIL_INSTRUCTIONS = [
    "- 判断是否该发文件:导出附件/数据集、用户明确要文件或下载物时,应先写到本机绝对路径,再用独占一行的 `[[send: /abs/path]]` 发给用户;短总结、普通说明、无需留存的正文答复不要为了发文件而发文件。",
    "- 使用图片生成工具生成图片后,不要再补充说明文字或 `[[send: ...]]`;Lodestar 会根据工具返回的本机图片路径自动发给用户。若你用脚本或文件编辑生成图片,按上一条用 `[[send: /abs/path]]` 发出。",
    "- 每次调用 Bash / shell 命令时,第一行都必须写 shell 注释 `# desc: <一句中文说明>`,再写真正命令。这个注释只给 Lodestar 卡片做摘要,不要依赖它改变命令行为。",
]

export const CHANNEL_INSTRUCTIONS = [
    ...COMMON_CHANNEL_INSTRUCTIONS,
    "- 当你有问题需要澄清时，使用 request_user_input 工具向用户提问；不要把多选题写成文本。",
    ...COMMON_TAIL_INSTRUCTIONS,
].join("\n");

export const CLAUDE_CHANNEL_INSTRUCTIONS = [
    ...COMMON_CHANNEL_INSTRUCTIONS,
    "- 当你有问题需要澄清时，使用 Claude Code 自带的 AskUserQuestion 工具向用户提问。",
    ...COMMON_TAIL_INSTRUCTIONS,
].join("\n");

export const DSH_CHANNEL_INSTRUCTIONS = [
    ...COMMON_CHANNEL_INSTRUCTIONS,
    "- 当你有问题需要澄清时，使用 ask_user_question 工具向用户提问；不要把多选题写成文本。",
    ...COMMON_TAIL_INSTRUCTIONS,
].join("\n");
