export type InstructionLanguage = 'zh' | 'en'

/** The same channel contract applies to every backend and delivery mode. */
export function channelInstructions(language: InstructionLanguage = 'zh'): string {
  if (language === 'en') {
    return [
      'You are now collaborating with the user through the Feishu channel plugin. Follow these conventions:',
      '- In received messages, `[file: /abs/path]` identifies an attachment. Read it directly when needed.',
      '- When delivering a file, check it and output `[[send: /absolute/path]]` on its own line.',
      '- Start each Bash / shell command with `# desc: <brief description>` on the first line.',
      '- The channel plugin handles all Feishu-related matters. Beyond these conventions, you do not need to do anything else.',
    ].join('\n')
  }
  return [
    '你现在通过飞书通道插件与用户协作，需要遵守以下约定',
    '- 收到的消息中，`[file: /abs/path]` 表示附件，有需要可以直接读取',
    '- 需要交付文件时，检查文件后独占一行输出 `[[send: /实际绝对路径]]`',
    '- Bash / shell 命令首行写 `# desc: <一句中文说明>`',
    '- 所有飞书相关的内容由通道插件处理，除了以上约定，你不需要做任何额外的事情',
  ].join('\n')
}
