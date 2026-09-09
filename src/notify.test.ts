import { describe, expect, test } from 'bun:test'
// Register the shared ./feishu mock so importing ./notify doesn't drag
// in real config.toml / tenant-token code (keeps this test hermetic).
import './feishu-test-mock'

import { buildNotifyCard, parseButtons, parseCallbackUrl } from './notify'

function cardBody(card: any): any[] {
  return (card as any).body.elements as any[]
}
function findButtonValues(card: any): any[] {
  const out: any[] = []
  for (const el of cardBody(card)) {
    if (el.tag === 'column_set') {
      for (const col of el.columns) {
        for (const e of col.elements) {
          if (e.tag === 'button') out.push(e)
        }
      }
    }
  }
  return out
}

describe('buildNotifyCard', () => {
  test('plain card has no button row and empty config', () => {
    const card: any = buildNotifyCard({ title: 'ops', text: 'hi', level: 'info' })
    expect(card.schema).toBe('2.0')
    expect(card.config).toEqual({})
    expect(card.header.template).toBe('blue')
    expect(findButtonValues(card)).toHaveLength(0)
    const tags = cardBody(card).map((e: any) => e.tag)
    expect(tags).toContain('markdown')
    expect(tags).toContain('hr')
  })

  test('level drives template/emoji', () => {
    const err = buildNotifyCard({ title: 't', text: 'x', level: 'error' }) as any
    expect(err.header.template).toBe('red')
    expect(err.header.title.content).toContain('❌')
    const warn = buildNotifyCard({ title: 't', text: 'x', level: 'warn' }) as any
    expect(warn.header.template).toBe('yellow')
  })

  test('buttons stack one-per-row (single full-width column) with routing value + update_multi', () => {
    const card: any = buildNotifyCard({
      title: 'ops', text: 'approve?', level: 'info',
      notifyId: 'nf_abc',
      buttons: [
        { id: 'approve', text: '✅ 通过本次部署并继续', type: 'primary' },
        { id: 'reject', text: '❌ 拒绝并打回', type: 'danger' },
      ],
    })
    expect(card.config).toEqual({ update_multi: true })
    // Exactly one column_set with exactly one full-width column → every
    // button owns its own row, however many there are.
    const columnSets = cardBody(card).filter((e: any) => e.tag === 'column_set')
    expect(columnSets).toHaveLength(1)
    expect(columnSets[0].columns).toHaveLength(1)
    expect(columnSets[0].columns[0].width).toBe('weighted')
    const btns = columnSets[0].columns[0].elements
    expect(btns).toHaveLength(2)
    expect(btns[0].type).toBe('primary')
    expect(btns[0].text.content).toBe('✅ 通过本次部署并继续')
    expect(btns[0].behaviors[0].value).toEqual({
      kind: 'notify_callback', notify_id: 'nf_abc', button_id: 'approve',
    })
    expect(btns[1].behaviors[0].value).toEqual({
      kind: 'notify_callback', notify_id: 'nf_abc', button_id: 'reject',
    })
  })

  test('many buttons (8) all stack — no count cap', () => {
    const card: any = buildNotifyCard({
      title: 'ops', text: 'pick one', level: 'info',
      notifyId: 'nf_many',
      buttons: Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, text: `opt${i}`, type: 'default' as const })),
    })
    const cs = cardBody(card).filter((e: any) => e.tag === 'column_set')[0]
    expect(cs.columns[0].elements).toHaveLength(8)
  })

  test('text-reply cards have only a fixed reply control below the footer, removed on completion', () => {
    const opts = {
      title: 'ops', text: 'type your reply', level: 'info' as const, notifyId: 'nf_reply', allowReply: true,
    }
    const card: any = buildNotifyCard(opts)
    expect(findButtonValues(card).map(button => button.text.content)).toEqual(['回复'])
    expect(cardBody(card).at(-1).columns[0].elements[0].behaviors[0].value.kind).toBe('notify_reply')
    const done = buildNotifyCard({ ...opts, resolution: {
      status: 'delivered', kind: 'text', text: '晚点', operatorOpenId: 'ou_owner',
    } })
    expect(findButtonValues(done)).toHaveLength(0)
    expect(JSON.stringify(done)).toContain('已回复')
  })

  test('renderer rejects mixed selection and text-reply cards', () => {
    expect(() => buildNotifyCard({
      title: 'ops', text: 'invalid', level: 'info', notifyId: 'nf_mixed', allowReply: true,
      buttons: [{ id: 'yes', text: '可以', type: 'default' }],
    })).toThrow('mutually exclusive')
  })

  test('buttons without notifyId are silently dropped (no dead value)', () => {
    const card: any = buildNotifyCard({
      title: 'ops', text: 'x', level: 'info',
      buttons: [{ id: 'a', text: 'A', type: 'default' }],
      // notifyId intentionally omitted
    })
    expect(card.config).toEqual({})
    expect(findButtonValues(card)).toHaveLength(0)
  })

  test('only retryable failed resolution keeps buttons; the other 4 states remove them', () => {
    const base = {
      title: 'ops', text: 'approve?', level: 'info' as const,
      notifyId: 'nf_abc',
      buttons: [{ id: 'approve', text: '✅ 通过', type: 'primary' as const }],
    }
    const states = [
      { status: 'processing' as const, want: /⏳/, color: 'blue' },
      { status: 'delivered' as const, want: /反馈已送达/, color: 'green' },
      { status: 'failed' as const, want: /回调失败:nope/, color: 'red', detail: 'nope' },
      { status: 'unknown' as const, want: /确认状态未知，禁止自动重试/, color: 'red' },
      { status: 'done' as const, want: /已选择/, color: 'green' },
    ]
    for (const s of states) {
      const card: any = buildNotifyCard({
        ...base,
        resolution: {
          status: s.status, buttonId: 'approve', text: '✅ 通过',
          operatorOpenId: 'ou_x', ...(s.detail ? { detail: s.detail } : {}),
        },
      })
      expect(findButtonValues(card)).toHaveLength(s.status === 'failed' ? 1 : 0)
      const marker: any = cardBody(card).find(
        (e: any) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('已选'),
      )
      expect(marker).toBeTruthy()
      expect(marker.content).toMatch(s.want)
      expect(marker.content).toContain(s.color)
    }
  })

  test('delivered with caller reply renders the reply as its own line', () => {
    const card: any = buildNotifyCard({
      title: 'ops', text: 'approve?', level: 'info',
      notifyId: 'nf_abc',
      buttons: [{ id: 'ship', text: '🚢 发布', type: 'primary' }],
      resolution: {
        status: 'delivered', buttonId: 'ship', text: '🚢 发布',
        operatorOpenId: 'ou_x', reply: '已发布 **v1.2.3** · 提交 `abc123`',
      },
    })
    const md = cardBody(card).filter((e: any) => e.tag === 'markdown').map((e: any) => e.content)
    expect(md.some((c: string) => c.includes('反馈已送达'))).toBe(true)
    expect(md.some((c: string) => c === '已发布 **v1.2.3** · 提交 `abc123`')).toBe(true)
  })

  test('failed image upload surfaces inline in red, never dropped', () => {
    const card: any = buildNotifyCard({
      title: 't', text: 'x', level: 'info',
      images: [{ key: '', src: '/abs/missing.png' }],
    })
    const err = cardBody(card).find(
      (e: any) => e.tag === 'markdown' && e.content.includes('图片上传失败'),
    )
    expect(err).toBeTruthy()
    expect(err.content).toContain('red')
    expect(err.content).toContain('/abs/missing.png')
  })
})

describe('parseButtons', () => {
  test('absent / empty array ⇒ no buttons', () => {
    expect(parseButtons(undefined).buttons).toEqual([])
    expect(parseButtons(null).buttons).toEqual([])
    expect(parseButtons([]).buttons).toEqual([])
  })

  test('happy path with type normalization', () => {
    const r = parseButtons([
      { id: 'a', text: 'A' },                    // type defaults
      { id: 'b', text: 'B', type: 'PRIMARY' },   // case-insensitive
      { id: 'c', text: 'C', type: 'danger' },
    ])
    expect(r.error).toBeUndefined()
    expect(r.buttons).toEqual([
      { id: 'a', text: 'A', type: 'default' },
      { id: 'b', text: 'B', type: 'primary' },
      { id: 'c', text: 'C', type: 'danger' },
    ])
  })

  test('rejects bad id, empty text, dup id, too long text, non-array; no count cap', () => {
    expect(parseButtons('nope').error).toMatch(/array/)
    expect(parseButtons([{ id: 'bad id!', text: 'x' }]).error).toMatch(/invalid/)
    expect(parseButtons([{ id: 'ok', text: '   ' }]).error).toMatch(/missing text/)
    expect(parseButtons([{ id: 'a', text: 'A' }, { id: 'a', text: 'B' }]).error).toMatch(/duplicated/)
    expect(parseButtons([{ id: 'a', text: 'x'.repeat(65) }]).error).toMatch(/> 64/)
    // 8 buttons is fine now (was capped at 5).
    expect(parseButtons(Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, text: 'x' }))).error).toBeUndefined()
    expect(parseButtons([{ id: 'a', text: 'A', type: 'laser' }]).buttons?.[0].type).toBe('default')
  })
})

describe('parseCallbackUrl', () => {
  test('absent / empty ⇒ no url, no error', () => {
    expect(parseCallbackUrl(undefined)).toEqual({})
    expect(parseCallbackUrl('')).toEqual({})
  })

  test('loopback accepted', () => {
    for (const u of [
      'http://127.0.0.1:9999/hook',
      'http://localhost:9999/hook',
      'http://[::1]:9999/hook',
    ]) {
      expect(parseCallbackUrl(u)).toEqual({ url: u })
    }
  })

  test('non-loopback / https / garbage rejected with reason', () => {
    expect(parseCallbackUrl('http://10.0.0.5:9999/hook').error).toMatch(/loopback/)
    expect(parseCallbackUrl('http://example.com/h').error).toMatch(/loopback/)
    expect(parseCallbackUrl('https://127.0.0.1:9999/h').error).toMatch(/http/)
    expect(parseCallbackUrl('not a url').error).toMatch(/bad URL/)
  })
})
