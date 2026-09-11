/** 在明确的测试群验证生图提示词与图片折叠展示；使用已有图片，不调用模型。 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as feishu from '../src/feishu'
import * as cardkit from '../src/cardkit'
import { toolCallElement, ELEMENTS } from '../src/cards'

const chatId = process.argv[2]
const imagePath = process.argv[3]
assert.ok(chatId?.startsWith('oc_') && imagePath, '用法: bun scripts/test-generated-image-card.ts <chat_id> <已有图片路径>')
const prompt = `自动化展示验证 ${randomUUID()}：使用已有图片检查折叠面板，不代表此图片的真实生成提示词。`
const imageKey = await feishu.uploadImageKey(resolve(imagePath))
assert.ok(imageKey, '测试图片上传失败')
const card = {
  schema: '2.0', config: { update_multi: true, streaming_mode: true },
  header: { title: { tag: 'plain_text', content: '自动化测试 · 生图折叠展示' }, template: 'blue' },
  body: { elements: [
    { tag: 'markdown', content: '展开下方面板，可查看提示词和图片；点击图片可放大。配图使用仓库已有图片。' },
    toolCallElement(0, 'ImageGeneration', { status: 'inProgress' }, null),
  ] },
}
const messageId = await feishu.sendCard(chatId, card)
assert.ok(messageId, '测试卡发送失败')
console.log(JSON.stringify({ phase: 'created', messageId }))
const cardId = await cardkit.convertMessageToCard(messageId)
cardkit.recordCardCreated(cardId, 2)
try {
  assert.equal(await cardkit.replaceElementChecked(cardId, ELEMENTS.tool(0),
    toolCallElement(0, 'ImageGeneration', { status: 'completed', revisedPrompt: prompt }, resolve(imagePath), '✅', undefined, imageKey)), true)
  assert.equal(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } }), true)
  const response = await feishu.client.im.v1.message.get({ path: { message_id: messageId }, params: { card_msg_content_type: 'raw_card_content' } })
  assert.equal(response.code, 0, response.msg)
  const envelope = JSON.parse(response.data!.items![0]!.body!.content!)
  const raw = JSON.parse(envelope.json_card)
  const encoded = JSON.stringify(raw)
  assert.ok(encoded.includes(prompt), '服务端卡片没有保留提示词')
  const fold = raw.body?.property?.elements?.find((element: any) => element.id === ELEMENTS.tool(0))
  const image = fold?.property?.elements?.find((element: any) => element.tag === 'img')
  // 飞书在读取原始卡片时把上传 img_key 规范成内部 imageID。
  assert.ok(image?.property?.imageID, '服务端折叠面板没有保留图片')
  assert.equal(image.property.preview, true, '图片预览没有启用')
  assert.ok(encoded.includes('"expanded":false'), '服务端卡片未保持折叠状态')
  console.log(JSON.stringify({ ok: true, messageId, foldedPrompt: true, foldedImage: true, standaloneImageMessages: 0 }))
} finally { await cardkit.dispose(cardId) }
