#!/usr/bin/env bun
import { networkFetch } from '../src/network'
/**
 * Probe to figure out the right CardKit + IM combo.
 *
 * Tests two paths and three IM-reference syntaxes:
 *
 *   Path A: sendCard(JSON) → id_convert → PUT element/content
 *   Path B: POST /cards → IM message {type:"card", data:{card_id}}
 *           → PUT element/content
 *
 *   Then try IM type values: "card", "card_id", "card_template"
 *
 * Prints which combo lets PUT element/content succeed.
 */

const targetName = process.argv[2]
if (!targetName) {
  console.error('usage: bun scripts/cardkit-probe.ts <chat_name|chat_id>')
  process.exit(1)
}

const feishu = await import('../src/feishu')
await feishu.refreshChatList()

const matches = [...feishu.chatNameCache].filter(([id, name]) => id === targetName || name === targetName)
if (matches.length !== 1) throw new Error(`expected one chat for ${targetName}, found ${matches.length}; use chat_id`)
const [chatId] = matches[0]

async function http(method: string, url: string, body?: object): Promise<any> {
  const token = await feishu.getTenantToken()
  const res = await networkFetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return await res.json() as any
}

const minimalCard = {
  schema: '2.0',
  config: { streaming_mode: true, streaming_config: { print_strategy: 'fast' } },
  body: {
    elements: [
      { tag: 'markdown', element_id: 'probe_md', content: 'initial' },
    ],
  },
}

console.log('\n=== PATH A: sendCard JSON + id_convert ===')
const aMsgId = await feishu.sendCard(chatId, { ...minimalCard, body: { elements: [{ tag: 'markdown', element_id: 'probeA_md', content: '[A] initial' }] } })
console.log('  msg_id:', aMsgId)
const aConv = await http('POST', 'https://open.feishu.cn/open-apis/cardkit/v1/cards/id_convert', { message_id: aMsgId })
console.log('  id_convert:', JSON.stringify(aConv))
const aCardId = aConv?.data?.card_id
if (aCardId) {
  const aPut = await http('PUT', `https://open.feishu.cn/open-apis/cardkit/v1/cards/${aCardId}/elements/probeA_md/content`, {
    content: '[A] initial 流式追加文本测试 PATH-A',
    sequence: 1,
  })
  console.log('  PUT element/content:', JSON.stringify(aPut))
}

console.log('\n=== PATH B: POST /cards ===')
const bCreate = await http('POST', 'https://open.feishu.cn/open-apis/cardkit/v1/cards', {
  type: 'card_json',
  data: JSON.stringify({ ...minimalCard, body: { elements: [{ tag: 'markdown', element_id: 'probeB_md', content: '[B] initial' }] } }),
})
console.log('  create:', JSON.stringify(bCreate))
const bCardId = bCreate?.data?.card_id

if (bCardId) {
  for (const refType of ['card', 'card_id', 'card_template']) {
    const refContent = JSON.stringify({ type: refType, data: { card_id: bCardId } })
    const sent = await http('POST', 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      receive_id: chatId,
      msg_type: 'interactive',
      content: refContent,
    })
    console.log(`  send type="${refType}":`, sent?.code, sent?.msg, sent?.data?.message_id ?? '')
  }
  const bPut = await http('PUT', `https://open.feishu.cn/open-apis/cardkit/v1/cards/${bCardId}/elements/probeB_md/content`, {
    content: '[B] initial 流式追加 PATH-B',
    sequence: 1,
  })
  console.log('  PUT element/content:', JSON.stringify(bPut))
}

// ── PATH C: reproduce smoke failure ──────────────────────────────────
// Same shape as Session.openTurnCard: card with element_id="thinking" and
// initial content="", then PUT a longer markdown body.  This is the exact
// case smoke kept failing with code 99992402.
console.log('\n=== PATH C: reproduce thinking failure ===')
const cMsgId = await feishu.sendCard(chatId, {
  schema: '2.0',
  config: { streaming_mode: true },
  body: {
    elements: [
      { tag: 'markdown', element_id: 'thinking', content: '' },
      { tag: 'markdown', element_id: 'assistant', content: '' },
      { tag: 'markdown', element_id: 'footer', content: 'working' },
    ],
  },
})
console.log('  msg_id:', cMsgId)
const cConv = await http('POST', 'https://open.feishu.cn/open-apis/cardkit/v1/cards/id_convert', { message_id: cMsgId })
const cCardId = cConv?.data?.card_id
console.log('  card_id:', cCardId)

const candidates = [
  { name: 'short ascii to thinking',   eid: 'thinking',    content: 'hello world' },
  { name: 'short ascii to assistant',  eid: 'assistant',   content: 'hello world' },
  { name: 'longer cn to thinking',     eid: 'thinking',    content: '正在分析任务步骤……' },
  { name: 'markdown header to thinking', eid: 'thinking',  content: '## step1\n- read README\n- write code' },
  { name: 'fenced code block',         eid: 'thinking',    content: '```bash\nls -la\n```' },
  { name: 'empty string',              eid: 'thinking',    content: '' },
  { name: 'starts empty + 1 char',     eid: 'thinking',    content: ' ' },
]

let seq = 1
for (const c of candidates) {
  const r = await http('PUT', `https://open.feishu.cn/open-apis/cardkit/v1/cards/${cCardId}/elements/${c.eid}/content`, {
    content: c.content,
    sequence: seq++,
  })
  console.log(`  ${c.name.padEnd(36)} eid=${c.eid.padEnd(10)} → code=${r.code} ${r.msg ?? ''}`)
}

export {}
