import { existsSync, readFileSync } from 'node:fs'
import { TASKLIST_MAP_FILE } from './paths'
import * as feishu from './feishu'
import { logError } from './log'
import { writeJsonStateAtomic } from './state-store'

export interface TasklistDeletionState {
  requestedAt: string
  lastAttemptAt?: string
  attempts: number
  lastError?: string
}

/** 项目与飞书任务清单的绑定及未完成的删除请求。 */
export interface TasklistBinding {
  guid: string
  name: string
  url: string
  projectName: string
  ownerOpenId: string
  createdAt?: string
  deleting?: TasklistDeletionState
}

const bindings = new Map<string, TasklistBinding>()
const lifecycleTails = new Map<string, Promise<void>>()

loadTasklistMap()

export function tasklistNameForProject(projectName: string): string {
  return `${projectName}[lodestar]`
}

export function getTasklistBinding(projectName: string): TasklistBinding | null {
  const binding = bindings.get(projectName)
  return binding ? cloneBinding(binding) : null
}

/** Serialize remote create/delete lifecycles per project. */
export async function withTasklistLifecycleLock<T>(projectName: string, run: () => Promise<T>): Promise<T> {
  const previous = lifecycleTails.get(projectName) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.catch(() => {}).then(() => gate)
  lifecycleTails.set(projectName, tail)
  await previous.catch(() => {})
  try {
    return await run()
  } finally {
    release()
    if (lifecycleTails.get(projectName) === tail) lifecycleTails.delete(projectName)
  }
}

export function isTasklistAlreadyDeletedError(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { code?: unknown }).code === 1470404) return true
  const message = error instanceof Error ? error.message : String(error)
  return /\bcode=1470404\b/.test(message)
}

export async function deleteTasklistRemoteIdempotently(
  guid: string,
  deleteRemote: (guid: string) => Promise<void> = feishu.deleteTasklistByGuid,
): Promise<'deleted' | 'already_deleted'> {
  try {
    await deleteRemote(guid)
    return 'deleted'
  } catch (error) {
    if (isTasklistAlreadyDeletedError(error)) return 'already_deleted'
    throw error
  }
}

export async function enableTasklist(projectName: string, chatId: string): Promise<TasklistBinding> {
  return await withTasklistLifecycleLock(projectName, async () => {
    const existing = getTasklistBinding(projectName)
    if (existing?.deleting) throw new Error(`tasklist deletion is pending for ${projectName}`)
    if (existing) return existing

    const name = tasklistNameForProject(projectName)
    if (name.length > 100) throw new Error(`tasklist name is too long (${name.length}/100): ${name}`)
    const ownerOpenId = await feishu.fetchChatOwnerOpenId(chatId)
    const tasklist = await feishu.createTasklistWithOwner(name, ownerOpenId)
    const binding: TasklistBinding = {
      guid: tasklist.guid,
      name: tasklist.name,
      url: tasklist.url,
      projectName,
      ownerOpenId,
      createdAt: tasklist.createdAt,
    }
    commitBinding(projectName, binding)
    return cloneBinding(binding)
  })
}

export async function deleteTasklist(projectName: string, expectedGuid: string): Promise<TasklistBinding> {
  return await withTasklistLifecycleLock(projectName, async () => {
    const binding = getTasklistBinding(projectName)
    if (!binding) throw new Error('tasklist is not enabled')
    if (binding.guid !== expectedGuid) {
      throw new Error(`tasklist binding changed: current=${binding.guid} requested=${expectedGuid}`)
    }
    if (!binding.deleting) {
      binding.deleting = { requestedAt: new Date().toISOString(), attempts: 0 }
      commitBinding(projectName, binding)
    }
    return await finishTasklistDeletion(projectName, expectedGuid)
  })
}

async function finishTasklistDeletion(projectName: string, expectedGuid: string): Promise<TasklistBinding> {
  const binding = getTasklistBinding(projectName)
  if (!binding || binding.guid !== expectedGuid) throw new Error(`tasklist binding changed during deletion: ${projectName}`)
  binding.deleting ??= { requestedAt: new Date().toISOString(), attempts: 0 }
  binding.deleting.attempts++
  binding.deleting.lastAttemptAt = new Date().toISOString()
  binding.deleting.lastError = undefined
  commitBinding(projectName, binding)

  try {
    const remote = await deleteTasklistRemoteIdempotently(expectedGuid)
    if (remote === 'already_deleted') {
    }
    const next = new Map(bindings)
    next.delete(projectName)
    saveTasklistMap(next)
    bindings.delete(projectName)
    return cloneBinding(binding)
  } catch (error) {
    const latest = getTasklistBinding(projectName)
    if (latest?.guid === expectedGuid && latest.deleting) {
      latest.deleting.lastError = error instanceof Error ? error.message : String(error)
      commitBinding(projectName, latest)
    }
    throw error
  }
}

/** Retry durable delete intents once at daemon boot. */
export async function reconcileTasklistDeletions(): Promise<void> {
  const pending = [...bindings.entries()]
    .filter(([, binding]) => !!binding.deleting)
    .map(([projectName, binding]) => ({ projectName, guid: binding.guid }))
  const failures: string[] = []
  for (const item of pending) {
    try {
      await withTasklistLifecycleLock(item.projectName, () => finishTasklistDeletion(item.projectName, item.guid))
    } catch (error) {
      failures.push(`${item.projectName}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length) throw new Error(`tasklist deletion reconcile failed: ${failures.join('; ')}`)
}

function loadTasklistMap(): void {
  if (!existsSync(TASKLIST_MAP_FILE)) return
  try {
    const parsed = JSON.parse(readFileSync(TASKLIST_MAP_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return
    for (const [projectName, raw] of Object.entries(parsed)) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Partial<TasklistBinding>
      if (typeof item.guid !== 'string' || !item.guid || typeof item.name !== 'string' || !item.name) continue
      const binding: TasklistBinding = {
        guid: item.guid,
        name: item.name,
        url: typeof item.url === 'string' ? item.url : '',
        projectName,
        ownerOpenId: typeof item.ownerOpenId === 'string' ? item.ownerOpenId : '',
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
        deleting: readDeleting(item.deleting),
      }
      bindings.set(projectName, binding)
    }
  } catch (error) {
    logError('tasklist: load map failed', error)
  }
}

function readDeleting(raw: unknown): TasklistDeletionState | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const item = raw as Partial<TasklistDeletionState>
  if (typeof item.requestedAt !== 'string' || !item.requestedAt) return undefined
  return {
    requestedAt: item.requestedAt,
    lastAttemptAt: typeof item.lastAttemptAt === 'string' ? item.lastAttemptAt : undefined,
    attempts: typeof item.attempts === 'number' && Number.isFinite(item.attempts) && item.attempts >= 0
      ? Math.floor(item.attempts)
      : 0,
    lastError: typeof item.lastError === 'string' ? item.lastError : undefined,
  }
}

function commitBinding(projectName: string, binding: TasklistBinding): void {
  const next = new Map(bindings)
  next.set(projectName, cloneBinding(binding))
  saveTasklistMap(next)
  bindings.set(projectName, cloneBinding(binding))
}

function saveTasklistMap(source: Map<string, TasklistBinding> = bindings): void {
  const value: Record<string, TasklistBinding> = {}
  for (const [projectName, binding] of source) value[projectName] = cloneBinding(binding)
  writeJsonStateAtomic(TASKLIST_MAP_FILE, value)
}

function cloneBinding(binding: TasklistBinding): TasklistBinding {
  return JSON.parse(JSON.stringify(binding)) as TasklistBinding
}
