/**
 * 发起人是否外部联系人（另一飞书租户的用户）。只在事件到达时比较事件自带的两个租户字段，
 * 结果随调用链显式传递；不记录、不缓存任何用户，也不写日志。
 */

/** 内部成员（含租户信息缺失）；外部联系人另带机器人所在租户，供核对群主所属企业。 */
export type RequesterTenant =
  | { readonly external: false }
  | { readonly external: true; readonly appTenantKey: string }

export const INTERNAL_REQUESTER: RequesterTenant = Object.freeze({ external: false as const })

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** 两个租户字段都存在且不同才算外部联系人；任一缺失按内部成员处理，与原行为一致。 */
export function requesterTenant(senderTenantKey: unknown, appTenantKey: unknown): RequesterTenant {
  if (!nonEmpty(senderTenantKey) || !nonEmpty(appTenantKey) || senderTenantKey === appTenantKey) {
    return INTERNAL_REQUESTER
  }
  return { external: true, appTenantKey }
}

/** `im.message.receive_v1`：SDK 展平后发送者租户在 `sender.tenant_key`，机器人所在租户在 `tenant_key`。 */
export function messageRequesterTenant(data: any): RequesterTenant {
  return requesterTenant(
    data?.sender?.tenant_key ?? data?.event?.sender?.tenant_key,
    data?.tenant_key ?? data?.header?.tenant_key,
  )
}

/** `card.action.trigger`（schema 2.0，SDK 展平）：操作者租户在 `operator.tenant_key`。 */
export function cardActionRequesterTenant(data: any): RequesterTenant {
  return requesterTenant(
    data?.operator?.tenant_key ?? data?.event?.operator?.tenant_key,
    data?.tenant_key ?? data?.header?.tenant_key,
  )
}

/** `[DEBUG]` 前缀的消息会把发送者 open_id 写进本机调试上下文；外部联系人的消息不写，按普通文本处理。 */
export function shouldSeedDebugContext(requester: RequesterTenant, text: unknown): text is string {
  return !requester.external && typeof text === 'string' && text.startsWith('[DEBUG]')
}
