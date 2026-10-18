import { describe, expect, test } from 'bun:test'
import { channelInstructions } from './instructions'

describe('channel instructions', () => {
  test('uses the approved Chinese wording verbatim by default', () => {
    expect(channelInstructions()).toBe(`你现在通过飞书通道插件与用户协作，需要遵守以下约定
- 收到的消息中，\`[file: /abs/path]\` 表示附件，有需要可以直接读取
- 需要交付文件时，检查文件后独占一行输出 \`[[send: /实际绝对路径]]\`
- Bash / shell 命令首行写 \`# desc: <一句中文说明>\`
- 所有飞书相关的内容由通道插件处理，除了以上约定，你不需要做任何额外的事情`)
    expect(channelInstructions()).toBe(channelInstructions('zh'))
  })

  test('the English version keeps the same channel contract without extra policies', () => {
    const instructions = channelInstructions('en')
    expect(instructions).not.toMatch(/\p{Script=Han}/u)
    expect(instructions.split('\n')).toHaveLength(5)
    expect(instructions).toContain('Feishu channel plugin')
    expect(instructions).toContain('`[file: /abs/path]`')
    expect(instructions).toContain('`[[send: /absolute/path]]`')
    expect(instructions).toContain('# desc: <brief description>')
    expect(instructions).toContain('Beyond these conventions, you do not need to do anything else.')
    expect(instructions).not.toMatch(/Lodestar|30 MB|AskUserQuestion|request_user_input|ask_user_question|files on|image generation|permissions|credentials/)
  })
})
