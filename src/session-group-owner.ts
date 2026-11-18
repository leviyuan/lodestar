/**
 * 新群（btw / fk 临时群、wt 分支群）的群类型与群主。外部成员只能进外部群，群的内外类型建好后
 * 不能再改，机器人也不能当外部群的群主，所以由这里在建群前决定：
 * - 本企业成员在内部群里发起：返回空对象，请求里既没有 `ownerOpenId` 也没有 `externalRequester`，
 *   与原行为一致（机器人当群主的内部群）。
 * - 本企业成员在外部群里发起：同样建外部群，群主就是发起人，之后外部成员也能加入；不给外部联系人的提示。
 * - 外部联系人发起：群主取当前群的群主（须为本企业成员）；同名群已存在时只加入，不需要群主。
 * 检查之后才出现的同名群同样只加入，群主不被使用。查询失败记固定事件名的日志（不含 ID），
 * 再抛给调用方在群里显示，不建群。
 */
import type { Session } from './session'
import * as feishu from './feishu'
import { logError } from './log'
import type { RequesterTenant } from './requester-tenant'
import { messageOf } from './session-util'

export type NewGroupFields = { ownerOpenId?: string; externalRequester?: boolean }

/** 入口：决定日志事件名（须为字面量）与报错里的群称呼。 */
export type NewGroupKind = 'temp' | 'worktree'

/** `reuseChatName` 是会复用的同名群（带备注的 btw、wt）；只有外部联系人需要先查它，以免为加入白找群主。 */
export async function newGroupFields(
  s: Session,
  userOpenId: string,
  requester: RequesterTenant,
  reuseChatName: string | null,
  kind: NewGroupKind,
): Promise<NewGroupFields> {
  if (!requester.external) {
    let sourceExternal: boolean
    try {
      sourceExternal = await feishu.isExternalChat(s.chatId)
    } catch (error) {
      logError(kind === 'temp'
        ? 'session-temp: source group type lookup failed'
        : 'session-worktree: source group type lookup failed', error)
      throw new Error(`读取当前群类型失败: ${messageOf(error)}`)
    }
    return sourceExternal ? { ownerOpenId: userOpenId, externalRequester: false } : {}
  }
  if (reuseChatName) {
    let existing: string | null
    try {
      existing = await feishu.findNormalChatIdByName(reuseChatName)
    } catch (error) {
      logError(kind === 'temp'
        ? 'session-temp: same-name temp group lookup failed'
        : 'session-worktree: same-name wt group lookup failed', error)
      throw new Error(`查找同名${kind === 'temp' ? '临时群' : 'WT 群'}失败: ${messageOf(error)}`)
    }
    if (existing) return { externalRequester: true }
  }
  try {
    const ownerOpenId = await feishu.resolveTempGroupOwner(s.chatId, userOpenId, requester.appTenantKey)
    return { ownerOpenId, externalRequester: true }
  } catch (error) {
    logError(kind === 'temp'
      ? 'session-temp: temp group owner lookup failed'
      : 'session-worktree: wt group owner lookup failed', error)
    throw error
  }
}
