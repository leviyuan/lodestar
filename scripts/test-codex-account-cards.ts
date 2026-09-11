import { networkFetch } from '../src/network'
/** Card Kit schema/transaction acceptance. Creates one unsent card under the configured app; never sends an IM message. */
import assert from 'node:assert/strict'
import * as feishu from '../src/feishu'
import * as cardkit from '../src/cardkit'
import { CodexAccountCard } from '../src/codex-account-card'
import { aggregateCodexUsage } from '../src/codex-account-usage'
import type { CodexAccountCardView } from '../src/cards/codex-account'
import { rankCodexQuota } from '../src/codex-quota'

if (!process.argv.includes('--unsent')) throw new Error('显式传入 --unsent：创建未发送的 Card Kit 验收对象，不向任何群发消息')
const total = aggregateCodexUsage(Array.from({ length: 5 }, (_, i) => ({
  account: { id: `test-${i}`, name: `验收账号 ${i + 1}` }, fingerprint: `test-${i}`,
  usage: { state: 'ok' as const, fiveHour: { percent: i * 20, resetsAt: new Date(Date.now() + 4 * 3600_000) },
    weekly: { percent: i * 25, resetsAt: new Date(Date.now() + 6 * 86400_000) },
    resetCredits: 0, subscriptionType: 'plus', fetchedAt: Date.now() },
})))
const frames: CodexAccountCardView[] = [
  { phase: 'waiting', flow: 'login', name: '验收', verification: { code: 'TEST-0000', url: 'https://auth.openai.com/codex/device' }, hint: '取消：codex-login-cancel 验收' },
  { phase: 'checking', flow: 'login', name: '验收', message: '授权完成，正在读取模型…' },
  { phase: 'selected', name: '验收 B', current: '默认', selected: '验收 B', hint: '发送 restart 生效' },
  { phase: 'accounts', total, currentId: 'test-0', selectedId: 'test-1' },
  { phase: 'accounts', total, page: 2 },
  ...([false, true] as const).map(ultra => ({ phase: 'accounts' as const, total,
    scheduling: { ultra, candidates: total.entries.map(entry => ({ ...entry, identity: entry.fingerprint!,
      ...rankCodexQuota(entry.usage, 'gpt-6-astra', Date.now(), ultra ? 'ultra' : 'max') })) } })),
  { phase: 'cancelled', name: '验收', message: '登录已取消' },
  { phase: 'expired', name: '验收', message: '等待授权超时' },
  { phase: 'error', name: '验收', message: '连接失败', details: 'HTTP 503\n验收用错误详情，未使用真实账号。' },
]
let created = ''
const card = await CodexAccountCard.open('UNSENT', { phase: 'connecting', flow: 'login', name: '验收' }, {
  sendCard: async (_chatId, json) => {
    const token = await feishu.getTenantToken()
    const response = await networkFetch('https://open.feishu.cn/open-apis/cardkit/v1/cards', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'card_json', data: JSON.stringify(json) }),
    })
    const body: any = await response.json()
    assert.equal(body.code, 0, JSON.stringify(body))
    created = body.data.card_id
    return created
  },
  // This acceptance adapter uses an unsent Card Kit id, so no IM id conversion or message send is performed.
  convertMessageToCard: async id => id,
  recordCardCreated: cardkit.recordCardCreated,
  replaceElementChecked: cardkit.replaceElementChecked,
  patchSettingsChecked: cardkit.patchSettingsChecked,
  dispose: cardkit.dispose,
})
try {
  for (const frame of frames) {
    await card.update(frame)
    console.log(JSON.stringify({ phase: frame.phase, page: frame.page, result: 'accepted' }))
  }
  await card.finish({ phase: 'success', flow: 'login', name: '验收', plan: 'plus', hint: '验收完成 · 未发送群消息' })
  console.log(JSON.stringify({ result: 'passed', frames: frames.length + 2, sentMessages: 0 }))
} finally {
  if (!cardkit.isDisposed(created)) {
    const closed = await cardkit.patchSettingsChecked(created, { config: { streaming_mode: false } })
    if (closed) await cardkit.dispose(created)
    else throw new Error('未发送的验收卡片无法关闭流式状态')
  }
}
