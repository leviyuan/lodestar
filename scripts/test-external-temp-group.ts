/** 在开启了「对外共享」的应用上实测：初始成员全是本企业的人时，建群请求带 `external: true` 能否建出外部群。
 * 本企业成员在外部群里发 btw / fk / wt 时，新群就是这样建的；这一步不成立就不要发版。
 *
 * bun scripts/test-external-temp-group.ts --chat-id oc_xxx [--owner ou_xxx] [--create]
 *
 * - `--chat-id`：这个应用的机器人所在的外部项目群，用来确认应用能进外部群，并取群主当测试群群主。
 * - `--owner`：改用指定的本企业成员当测试群群主（open_id 按应用区分，须是本应用下的 ID）。
 * - 不加 `--create` 只读取并打印计划；加上才真正建群。
 *
 * 副作用：加 `--create` 时建一个名为「Lodestar 外部群实测（可解散）…」的群，成员只有群主和机器人。
 * 建出的是外部群时机器人不能解散，须由群主在飞书群设置里手动解散；建成内部群（实测失败）时脚本尝试删除。
 * 输出里的 ID 均做了遮挡。
 */
import { randomUUID } from 'node:crypto'
import { client } from '../src/feishu'
import { redactMemberIds } from '../src/feishu-errors'

const args = process.argv.slice(2)
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const chatId = option('--chat-id')
const ownerOverride = option('--owner')
const create = args.includes('--create')
const mask = (id: unknown) => typeof id === 'string' && id.length > 8 ? `${id.slice(0, 5)}…${id.slice(-3)}` : String(id)
/** 飞书的拒绝原文可能列出成员 ID（如 232043 的 user ids: [...]），输出前一律去掉。 */
const text = (value: unknown) => value === undefined || value === null ? value : redactMemberIds(String(value))
const print = (phase: string, data: object) => console.log(JSON.stringify({ phase, ...data }))

/** 常见拒绝码的白话说明，帮助判断是应用配置问题还是 external 参数本身的问题。 */
const REJECTIONS: Record<string, string> = {
  '232033': '应用没有外部群权限：确认开发者后台「对外共享」已允许机器人被添加到外部群，并已发版生效',
  '232032': '群主须与应用同属一个企业：换一个本企业成员（--owner）',
  '232043': '应用看不到群主：把群主加入应用的「可用范围」，或换一个成员（--owner）',
}

function failure(error: unknown): { code?: unknown; msg?: unknown; log_id?: unknown } {
  const data = (error as any)?.response?.data ?? (error as any)?.data
  return {
    code: data?.code,
    msg: text(data?.msg ?? (error instanceof Error ? error.message : String(error))),
    log_id: data?.error?.log_id ?? (error as any)?.response?.headers?.['x-tt-logid'],
  }
}

async function main(): Promise<number> {
  if (!chatId?.startsWith('oc_')) throw new Error('需要 --chat-id oc_xxx（机器人所在的外部项目群）')
  if (ownerOverride !== undefined && !ownerOverride.startsWith('ou_')) throw new Error('--owner 须是 ou_ 开头的 open_id')

  const source = await client.im.chat.get({ path: { chat_id: chatId }, params: { user_id_type: 'open_id' } })
  if (source.code && source.code !== 0) throw new Error(`读取来源群失败 code=${source.code} message=${source.msg}`)
  const owner = ownerOverride ?? source.data?.owner_id
  print('source', { chat: mask(chatId), external: source.data?.external ?? null, owner: mask(owner), ownerType: source.data?.owner_id_type ?? null })
  if (source.data?.external !== true) print('warning', { note: '来源群不是外部群：这个应用可能没有开启对外共享，结果只能说明本应用的情况' })
  if (typeof owner !== 'string' || !owner.startsWith('ou_')) throw new Error('来源群的群主不是用户（可能是机器人）；请用 --owner 指定本企业成员')

  const name = `Lodestar 外部群实测（可解散）${new Date().toISOString().slice(5, 16).replace('T', ' ')}`
  const data = { name, owner_id: owner, user_id_list: [owner], group_message_type: 'chat' as const, external: true }
  print('plan', { name, owner: mask(owner), members: 1, external: true })
  if (!create) {
    print('dry-run', { note: '未建群；确认后加 --create 实测' })
    return 0
  }

  let created
  try {
    created = await client.im.chat.create({ params: { user_id_type: 'open_id', uuid: randomUUID() }, data })
  } catch (error) {
    const detail = failure(error)
    print('result', { verdict: 'INCONCLUSIVE', ...detail, hint: REJECTIONS[String(detail.code)] ?? '按错误码排查后重试' })
    return 1
  }
  if (created.code && created.code !== 0) {
    const detail = { code: created.code, msg: text(created.msg), log_id: (created as any).error?.log_id }
    print('result', { verdict: 'INCONCLUSIVE', ...detail, hint: REJECTIONS[String(created.code)] ?? '按错误码排查后重试' })
    return 1
  }
  const newChat = created.data?.chat_id
  if (!newChat) throw new Error('chat.create 没有返回 chat_id')
  // 群已经建好：读不回类型时不能判 FAIL，也不能去删（它可能就是外部群），只报告并留给群主核对。
  const keep = (detail: object) => {
    print('result', {
      verdict: 'INCONCLUSIVE', chat: mask(newChat), ...detail,
      note: `已建群「${name}」但读不回群类型：请在飞书里查看它是不是外部群，再由群主手动解散`,
    })
    return 1
  }
  let after
  try {
    after = await client.im.chat.get({ path: { chat_id: newChat }, params: { user_id_type: 'open_id' } })
  } catch (error) {
    return keep(failure(error))
  }
  if (after.code && after.code !== 0) return keep({ code: after.code, msg: text(after.msg), log_id: (after as any).error?.log_id })
  const external = after.data?.external
  if (typeof external !== 'boolean') return keep({ external: null })
  if (external === true) {
    print('result', {
      verdict: 'PASS', chat: mask(newChat), external,
      note: '只有本企业成员时也建出了外部群：可以发版。机器人不能解散外部群，请群主在飞书群设置里手动解散这个测试群',
    })
    return 0
  }
  print('result', { verdict: 'FAIL', chat: mask(newChat), external, note: '飞书没有按 external 建外部群：不要发版' })
  try {
    const removed = await client.im.chat.delete({ path: { chat_id: newChat } })
    print('cleanup', removed.code && removed.code !== 0
      ? { deleted: false, code: removed.code, msg: text(removed.msg), note: '请群主手动解散测试群' }
      : { deleted: true })
  } catch (error) {
    print('cleanup', { deleted: false, ...failure(error), note: '请群主手动解散测试群' })
  }
  return 1
}

main().then(code => process.exit(code), error => {
  print('error', { message: text(error instanceof Error ? error.message : String(error)) })
  process.exit(1)
})
