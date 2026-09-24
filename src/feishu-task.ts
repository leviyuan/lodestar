import { client } from './feishu'
import { formatFeishuError } from './feishu-errors'

export async function fetchChatOwnerOpenId(chatId: string): Promise<string> {
  const res = await callFeishuApi('feishu chat.get', () => client.im.chat.get({
    path: { chat_id: chatId },
    params: { user_id_type: 'open_id' },
  }))
  if (res.code && res.code !== 0) throwFeishuApiError('feishu chat.get', res)
  const ownerOpenId = res.data?.owner_id
  if (!ownerOpenId) throw new Error('feishu chat.get returned no owner_id; cannot add project group owner to tasklist')
  return ownerOpenId
}

export interface CreatedTasklist {
  guid: string
  name: string
  url: string
  createdAt?: string
}

export async function createTasklistWithOwner(name: string, ownerOpenId: string): Promise<CreatedTasklist> {
  const res = await callFeishuApi('feishu tasklist.create', () => client.task.v2.tasklist.create({
    params: { user_id_type: 'open_id' },
    data: {
      name,
      members: [{ id: ownerOpenId, type: 'user', role: 'editor' }],
    },
  }))
  if (res.code && res.code !== 0) throwFeishuApiError('feishu tasklist.create', res)
  const tasklist = res.data?.tasklist
  const guid = tasklist?.guid
  if (!guid) throw new Error('feishu tasklist.create returned no guid')
  return {
    guid,
    name: tasklist?.name || name,
    url: tasklist?.url ?? '',
    createdAt: tasklist?.created_at,
  }
}

export async function deleteTasklistByGuid(guid: string): Promise<void> {
  const res = await callFeishuApi('feishu tasklist.delete', () => client.task.v2.tasklist.delete({
    path: { tasklist_guid: guid },
  }))
  if (res.code && res.code !== 0) throwFeishuApiError('feishu tasklist.delete', res)
}

export function formatFeishuApiError(api: string, raw: unknown): string {
  const data = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const responseData = data.response?.data && typeof data.response.data === 'object'
    ? data.response.data as Record<string, any>
    : data.data && typeof data.data === 'object'
      ? data.data as Record<string, any>
      : data
  const violations = responseData.error?.permission_violations
    ?? responseData.permission_violations
    ?? data.error?.permission_violations
  const scopes = Array.isArray(violations)
    ? violations.map((v: any) => v?.scope ?? v?.subject ?? v?.name ?? v).filter(Boolean).join(', ')
    : ''
  return `${api} failed ${formatFeishuError(raw)}${scopes ? ` missing_scopes=${scopes}` : ''}`
}

async function callFeishuApi<T>(api: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn() }
  catch (error) { throwFeishuApiError(api, error) }
}

function throwFeishuApiError(api: string, raw: unknown): never {
  throw new Error(formatFeishuApiError(api, raw))
}
