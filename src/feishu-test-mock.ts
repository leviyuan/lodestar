/**
 * 共享的 ./feishu 测试替身(仅供 *.test.ts import)。
 *
 * bun 的 mock.module 是进程级注册:多个测试文件各自 mock('./feishu')
 * 时,后加载的会就地覆盖先加载的 —— cardkit.test.ts 的窄 mock(只有
 * getTenantToken)曾把 session.test.ts 的全量 mock 顶掉,导致
 * `bun test src/` 单进程全跑时 Session 构造函数炸
 * getSessionModelSelection。收敛为这一个模块后,模块缓存保证
 * mock.module 只注册一次,加载顺序不再影响结果。
 *
 * 捕获数组是共享可变状态,测试文件在 beforeEach 里调 resetFeishuMock()。
 */
import { mock } from 'bun:test'
import type { TurnAnchor } from './feishu'
import type { ConversationBranchBase, PendingConversationLaunch } from './conversation'
import type { ProjectProfile } from './config'
import { profileForWorkspace, resolveWorkspaceDir } from './workspace'
import { SESSION_NAME_MAX, mainSessionName, normalizeTempRole, stripTempSuffix, tempProjectName, tempRoleChatName } from './session-name'

export const sentCards: object[] = []
export const chatTailMessages = new Map<string, string>()
export const sentTexts: string[] = []
export const sentRawTexts: string[] = []
export const sentImages: Array<[string, string]> = []
export const uploadedImages: string[] = []
export const sentLocalFiles: Array<[string, string]> = []
let imageUploadHandler: ((path: string) => Promise<string | null>) | null = null
export function setImageUploadHandler(handler: ((path: string) => Promise<string | null>) | null): void { imageUploadHandler = handler }
export const updatedCards: Array<[string, object]> = []
export const addedReactions: Array<[string, string]> = []
export const deletedReactions: Array<[string, string]> = []
export const boundResumes: Array<[string, string, string | undefined]> = []
export const clearedResumes: Array<[string, string | undefined]> = []
export const urgentPushes: Array<[string, string[]]> = []
/** session-temp fork/back 测试使用的内存 turn-map 及 mutation 记录。 */
export const turnAnchorsBySession = new Map<string, TurnAnchor[]>()
export const clearedTurnAnchorSessions: string[] = []
export const seededTurnAnchors: Array<[string, TurnAnchor[]]> = []
export const branchBaseBySession = new Map<string, ConversationBranchBase>()
export const pendingConversationLaunchBySession = new Map<string, PendingConversationLaunch>()
/** 群成员 open_id 替身(bye 按「最后一人」解散的判断依据)。 */
export const chatMembersById = new Map<string, string[]>()
export function setChatMembers(chatId: string, memberIds: string[]): void {
  chatMembersById.set(chatId, memberIds.slice())
}
let chatMembersError: Error | null = null
export function setChatMembersError(error: Error | null): void { chatMembersError = error }
/** 群名 -> chat_id 列表（worktree 清理、按名解散用）。 */
export const chatIdsByName = new Map<string, string[]>()
export const disbandedChats: string[] = []
/** 加入者 bye 的自助退群记录。 */
export const leftChats: Array<[string, string]> = []
let leaveChatError: Error | null = null
export function setLeaveChatError(error: Error | null): void { leaveChatError = error }
/** 外部群的 bye / 补偿：机器人自己退群的记录（chat_id）。 */
export const botLeftChats: string[] = []
let leaveChatAsBotError: Error | null = null
export function setLeaveChatAsBotError(error: Error | null): void { leaveChatAsBotError = error }
/** `isExternalChat` 替身：标记为外部群的 chat_id；查询记录与失败注入。 */
export const externalChatIds = new Set<string>()
export const externalChatChecks: string[] = []
let externalChatError: Error | null = null
export function setExternalChat(chatId: string, external = true): void {
  if (external) externalChatIds.add(chatId)
  else externalChatIds.delete(chatId)
}
export function setExternalChatError(error: Error | null): void { externalChatError = error }
/** 单聊面板：`listChatOwners` 返回的群与群主、失败注入；`isChatMember` 按 `chatMembersById` 判断，
 * 记录每次查询，可按群注入失败。 */
export const chatOwners: Array<{ chatId: string; name: string; ownerOpenId: string | null }> = []
let chatOwnersError: Error | null = null
export function setChatOwners(owners: Array<{ chatId: string; name: string; ownerOpenId: string | null }>): void {
  chatOwners.splice(0, chatOwners.length, ...owners.map(owner => ({ ...owner })))
}
export function setChatOwnersError(error: Error | null): void { chatOwnersError = error }
export const chatMemberChecks: Array<[string, string]> = []
const chatMemberCheckErrors = new Map<string, Error>()
export function setChatMemberCheckError(chatId: string, error: Error | null): void {
  if (error) chatMemberCheckErrors.set(chatId, error)
  else chatMemberCheckErrors.delete(chatId)
}
/** 外部联系人临时群的群主解析：调用参数 [来源群, 发起人, 机器人租户]，结果或失败可注入。 */
export const resolvedTempGroupOwners: Array<[string, string, string]> = []
const DEFAULT_TEMP_GROUP_OWNER = 'ou_group_owner'
let tempGroupOwner: string | Error = DEFAULT_TEMP_GROUP_OWNER
export function setTempGroupOwner(result: string | Error): void { tempGroupOwner = result }
/** 建群 / 拉人入口的调用记录；`tempChatResult`、`tempChatError` 同时作用于三个入口。 */
export const ensuredChats: Array<{ sessionName: string; userOpenId: string; ownerOpenId?: string }> = []
export const ensuredTempChats: Array<{
  sessionName: string
  userOpenId: string
  mode: 'create' | 'reuse'
  ownerOpenId?: string
  externalRequester?: boolean
}> = []
export const createdTempChats: Array<{
  sessionName: string
  userOpenId: string
  ownerOpenId?: string
  externalRequester?: boolean
}> = []
/** `ensureWorktreeChatForSession` 替身的调用记录（wt 建群 / 拉人），结果同样取 `tempChatResult`、`tempChatError`。 */
export const ensuredWorktreeChats: Array<{
  sessionName: string
  userOpenId: string
  ownerOpenId?: string
  externalRequester?: boolean
}> = []
/** `findNormalChatIdByName` 替身：按 `chatIdsByName` 查同名群（重名时报错），记录查询并可注入失败。 */
export const normalChatLookups: string[] = []
let normalChatLookupError: Error | null = null
export function setNormalChatLookupError(error: Error | null): void { normalChatLookupError = error }
let tempChatResult: { chatId: string; created: boolean; joined: boolean } | null = null
let tempChatError: Error | null = null
export function setTempChatResult(result: { chatId: string; created: boolean; joined: boolean } | null): void {
  tempChatResult = result
}
export function setTempChatError(error: Error | null): void { tempChatError = error }
function tempChatOutcome(sessionName: string): { chatId: string; created: boolean; joined: boolean } {
  if (tempChatError) throw tempChatError
  return tempChatResult ? { ...tempChatResult } : { chatId: `oc_${sessionName}`, created: true, joined: true }
}
/** `disbandChatForSessionExact` 替身：缺省确认解散；外部群可注入 `{ disbanded: false, left: true }`。 */
export const exactDisbands: Array<[string, string]> = []
let exactDisbandResult: { chatId: string | null; disbanded: boolean; left?: boolean } | null = null
let exactDisbandError: Error | null = null
export function setExactDisbandResult(result: { chatId: string | null; disbanded: boolean; left?: boolean } | null): void {
  exactDisbandResult = result
}
export function setExactDisbandError(error: Error | null): void { exactDisbandError = error }
let resumeWriteError: Error | null = null
export function setResumeWriteError(error: Error | null): void { resumeWriteError = error }
let turnAnchorWriteError: Error | null = null
export function setTurnAnchorWriteError(error: Error | null): void { turnAnchorWriteError = error }
let updateCardHandler: ((messageId: string, card: object) => Promise<void>) | null = null
export function setUpdateCardHandler(handler: ((messageId: string, card: object) => Promise<void>) | null): void {
  updateCardHandler = handler
}
export const modelSelections = new Map<string, {
  provider: 'codex' | 'claude' | 'dsh'
  model: string | null
  effort: string | null
  tokenSourceId?: string | null
}>()
export const resumeRefs = new Map<string, { provider: 'codex' | 'claude' | 'dsh'; sessionId: string; cwd: string | null }>()
export const preferredChatForSession = new Map<string, string>()
/** `bl` 列表读取的临时会话租约替身。 */
export const tempSessionLeases: Array<{ sessionName: string; chatId: string; createdAt: number }> = []
/** [projects.<name>] 项目 profile 替身,测试往里 set 后 Session 构造时可查到。 */
export const projectProfiles = new Map<string, ProjectProfile>()

export function resetFeishuMock(): void {
  for (const arr of [
    sentCards, sentTexts, sentRawTexts, updatedCards, addedReactions, deletedReactions, boundResumes, clearedResumes, urgentPushes,
    clearedTurnAnchorSessions, seededTurnAnchors, sentImages, uploadedImages, sentLocalFiles, leftChats,
  ]) {
    arr.length = 0
  }
  projectProfiles.clear()
  tempSessionLeases.length = 0
  chatTailMessages.clear()
  modelSelections.clear()
  resumeRefs.clear()
  preferredChatForSession.clear()
  turnAnchorsBySession.clear()
  resumeWriteError = null
  turnAnchorWriteError = null
  updateCardHandler = null
  imageUploadHandler = null
  leaveChatError = null
  branchBaseBySession.clear()
  pendingConversationLaunchBySession.clear()
  chatMembersById.clear()
  chatMembersError = null
  chatIdsByName.clear()
  disbandedChats.length = 0
  for (const arr of [
    botLeftChats, externalChatChecks, resolvedTempGroupOwners, ensuredChats, ensuredTempChats, createdTempChats, exactDisbands,
    normalChatLookups, ensuredWorktreeChats,
  ]) {
    arr.length = 0
  }
  normalChatLookupError = null
  leaveChatAsBotError = null
  externalChatIds.clear()
  externalChatError = null
  chatOwners.length = 0
  chatOwnersError = null
  chatMemberChecks.length = 0
  chatMemberCheckErrors.clear()
  tempGroupOwner = DEFAULT_TEMP_GROUP_OWNER
  tempChatResult = null
  tempChatError = null
  exactDisbandResult = null
  exactDisbandError = null
}

mock.module('./feishu', () => ({
  PROJECTS_ROOT: '/tmp/lodestar-projects',
  resolveProjectDir: (name: string) => resolveWorkspaceDir(name, '/tmp/lodestar-projects', Object.fromEntries(projectProfiles)),
  projectProfileForDirectory: (workDir: string) => profileForWorkspace(workDir, '/tmp/lodestar-projects', Object.fromEntries(projectProfiles)),
  getSessionResumeRef: (sessionName: string, provider = 'codex') => {
    const ref = resumeRefs.get(`${sessionName}:${provider}`)
    return ref ? { ...ref } : null
  },
  getSessionModelSelection: (sessionName: string) => modelSelections.get(sessionName) ?? null,
  getTenantToken: async () => 'tenant-token',
  uploadImageKey: async (path: string) => {
    uploadedImages.push(path)
    return imageUploadHandler ? imageUploadHandler(path) : 'img_generated'
  },
  sendImage: async (chatId: string, key: string) => { sentImages.push([chatId, key]); return `om_image_${sentImages.length}` },
  MAX_UPLOAD_BYTES: 30 * 1024 * 1024,
  uploadAndSend: async (chatId: string, path: string) => { sentLocalFiles.push([chatId, path]); return true },
  preferredChatForSession,
  chatNameCache: new Map(),
  getChatTailMessageId: async (chatId: string) => chatTailMessages.get(chatId) ?? null,
  sendCard: async (chatId: string, card: object) => {
    sentCards.push(card)
    const id = `om_status_${sentCards.length}`
    chatTailMessages.set(chatId, id)
    return id
  },
  sendText: async (chatId: string, text: string) => {
    sentTexts.push(text)
    chatTailMessages.set(chatId, 'om_text')
    return 'om_text'
  },
  sendTextRaw: async (chatId: string, text: string) => {
    sentRawTexts.push(text)
    chatTailMessages.set(chatId, 'om_raw')
    return 'om_raw'
  },
  updateCard: async (messageId: string, card: object) => {
    updatedCards.push([messageId, card])
    if (updateCardHandler) await updateCardHandler(messageId, card)
  },
  addReaction: async (messageId: string, emojiType: string) => {
    addedReactions.push([messageId, emojiType])
    return `reaction_${addedReactions.length}`
  },
  deleteReaction: async (messageId: string, reactionId: string) => {
    deletedReactions.push([messageId, reactionId])
  },
  urgentApp: async (messageId: string, openIds: string[]) => {
    urgentPushes.push([messageId, openIds])
  },
  bindSessionResumeChecked: (sessionName: string, sessionIdOrRef: string | { sessionId: string; provider: string }, provider?: string) => {
    if (resumeWriteError) throw resumeWriteError
    const normalized = typeof sessionIdOrRef === 'string'
      ? { sessionId: sessionIdOrRef, provider: provider ?? 'codex', cwd: null }
      : sessionIdOrRef
    boundResumes.push([sessionName, normalized.sessionId, normalized.provider])
    resumeRefs.set(`${sessionName}:${normalized.provider}`, normalized as any)
  },
  clearSessionResumeChecked: (sessionName: string, provider?: string) => {
    if (resumeWriteError) throw resumeWriteError
    clearedResumes.push([sessionName, provider])
    if (provider) resumeRefs.delete(`${sessionName}:${provider}`)
  },
  bindSessionModel: () => {},
  bindSessionModelChecked: () => {},
  isOpenAIChatGPTAuthenticated: () => true,
  provisionProject: () => {},
  projectProfile: (name: string) => projectProfiles.get(name),
  // 临时群 / fork / back / rs 恢复相关 stub。
  tempProjectName,
  mainSessionName,
  normalizeTempRole,
  stripTempSuffix,
  mainChatIdForSession: (name: string, fallback?: string) => {
    const main = mainSessionName(name)
    return preferredChatForSession.get(main) ?? (main === name ? fallback ?? null : null)
  },
  tempChatName: (project: string, additionallyUsed: Iterable<string> = [], role = '') => {
    const used = new Set(additionallyUsed)
    const base = `${project}*${normalizeTempRole(role) || '0000-0000'}`
    let name = base
    for (let seq = 2; used.has(name); seq++) name = `${base}-${seq}`
    return name
  },
  SESSION_NAME_MAX,
  tempRoleChatName,
  listTempSessionLeases: () => tempSessionLeases.map(lease => ({ ...lease })),
  appendTurnAnchorChecked: (sessionName: string, anchor: TurnAnchor) => {
    if (turnAnchorWriteError) throw turnAnchorWriteError
    const current = turnAnchorsBySession.get(sessionName) ?? []
    turnAnchorsBySession.set(sessionName, [...current, anchor])
  },
  getTurnAnchors: (sessionName: string) => turnAnchorsBySession.get(sessionName) ?? [],
  getSessionBranchBase: (sessionName: string) => branchBaseBySession.get(sessionName) ?? null,
  getPendingConversationLaunch: (sessionName: string) => pendingConversationLaunchBySession.get(sessionName) ?? null,
  setPendingConversationLaunchChecked: (sessionName: string, pending: PendingConversationLaunch | null) => {
    if (turnAnchorWriteError) throw turnAnchorWriteError
    if (pending) pendingConversationLaunchBySession.set(sessionName, pending)
    else pendingConversationLaunchBySession.delete(sessionName)
  },
  replaceTurnAnchors: (
    sessionName: string,
    anchors: TurnAnchor[],
    base: ConversationBranchBase,
    pending?: PendingConversationLaunch | null,
  ) => {
    if (turnAnchorWriteError) throw turnAnchorWriteError
    clearedTurnAnchorSessions.push(sessionName)
    const copied = anchors.slice()
    seededTurnAnchors.push([sessionName, copied])
    turnAnchorsBySession.set(sessionName, copied)
    branchBaseBySession.set(sessionName, base)
    if (pending !== undefined) {
      if (pending) pendingConversationLaunchBySession.set(sessionName, pending)
      else pendingConversationLaunchBySession.delete(sessionName)
    }
  },
  ensureChatForSession: async (sessionName: string, userOpenId: string, ownerOpenId?: string) => {
    ensuredChats.push({ sessionName, userOpenId, ...(ownerOpenId === undefined ? {} : { ownerOpenId }) })
    return tempChatOutcome(sessionName)
  },
  createTempChatForSession: async (
    sessionName: string,
    userOpenId: string,
    ownerOpenId?: string,
    externalRequester = ownerOpenId !== undefined,
  ) => {
    createdTempChats.push({
      sessionName, userOpenId, ...(ownerOpenId === undefined ? {} : { ownerOpenId }), ...(externalRequester ? { externalRequester } : {}),
    })
    return tempChatOutcome(sessionName)
  },
  ensureTempChatForSession: async (
    sessionName: string,
    userOpenId: string,
    mode: 'create' | 'reuse' = 'create',
    ownerOpenId?: string,
    externalRequester = ownerOpenId !== undefined,
  ) => {
    ensuredTempChats.push({
      sessionName, userOpenId, mode,
      ...(ownerOpenId === undefined ? {} : { ownerOpenId }), ...(externalRequester ? { externalRequester } : {}),
    })
    return tempChatOutcome(sessionName)
  },
  ensureWorktreeChatForSession: async (
    sessionName: string,
    userOpenId: string,
    ownerOpenId?: string,
    externalRequester = false,
  ) => {
    ensuredWorktreeChats.push({
      sessionName, userOpenId, ...(ownerOpenId === undefined ? {} : { ownerOpenId }), ...(externalRequester ? { externalRequester } : {}),
    })
    return tempChatOutcome(sessionName)
  },
  findNormalChatIdByName: async (sessionName: string) => {
    normalChatLookups.push(sessionName)
    if (normalChatLookupError) throw normalChatLookupError
    const ids = chatIdsByName.get(sessionName) ?? []
    if (ids.length > 1) throw new Error(`multiple Feishu groups named "${sessionName}": ${ids.join(', ')}`)
    return ids[0] ?? null
  },
  chatIdForSession: (sessionName: string) => preferredChatForSession.get(sessionName) ?? null,
  disbandChatForSessionExact: async (sessionName: string, chatId: string) => {
    exactDisbands.push([sessionName, chatId])
    if (exactDisbandError) throw exactDisbandError
    return exactDisbandResult ? { ...exactDisbandResult } : { chatId, disbanded: true }
  },
  resolveTempGroupOwner: async (sourceChatId: string, requesterOpenId: string, appTenantKey: string) => {
    resolvedTempGroupOwners.push([sourceChatId, requesterOpenId, appTenantKey])
    if (tempGroupOwner instanceof Error) throw tempGroupOwner
    return tempGroupOwner
  },
  isExternalChat: async (chatId: string) => {
    externalChatChecks.push(chatId)
    if (externalChatError) throw externalChatError
    return externalChatIds.has(chatId)
  },
  listChatOwners: async () => {
    if (chatOwnersError) throw chatOwnersError
    return chatOwners.map(owner => ({ ...owner }))
  },
  isChatMember: async (chatId: string, openId: string) => {
    chatMemberChecks.push([chatId, openId])
    const error = chatMemberCheckErrors.get(chatId)
    if (error) throw error
    return (chatMembersById.get(chatId) ?? []).includes(openId)
  },
  /** 只看已保存的绑定，与 `chatIdForSession` 替身共用 `preferredChatForSession`。 */
  boundChatIdForSession: (sessionName: string) => preferredChatForSession.get(sessionName) ?? null,
  leaveChatAsBot: async (chatId: string) => {
    if (leaveChatAsBotError) throw leaveChatAsBotError
    botLeftChats.push(chatId)
    return { left: true as const }
  },
  listNormalChatIdsByName: async () => new Map([...chatIdsByName].map(([name, ids]) => [name, ids.slice()])),
  disbandChatForSession: async (sessionName: string) => {
    const chatId = chatIdsByName.get(sessionName)?.[0] ?? null
    // 外部群：机器人只能退群，与 feishu.ts 一致。
    if (chatId && externalChatIds.has(chatId)) {
      botLeftChats.push(chatId)
      return { chatId, disbanded: false, left: true }
    }
    disbandedChats.push(sessionName)
    return { chatId, disbanded: true }
  },
  chatMemberOpenIds: async (chatId: string) => {
    if (chatMembersError) throw chatMembersError
    return (chatMembersById.get(chatId) ?? []).slice()
  },
  leaveChatForMember: async (chatId: string, openId: string) => {
    if (leaveChatError) throw leaveChatError
    leftChats.push([chatId, openId])
    chatMembersById.set(chatId, (chatMembersById.get(chatId) ?? []).filter(id => id !== openId))
    return { left: true }
  },
}))

// 随机顺序可能先加载 AgentService，令默认卡片依赖保存真实函数的副本。
// mock.module 只更新模块导出；同步替换这两份已捕获的引用，避免测试访问飞书。
const { agentCardsDeps } = await import('./agent-cards-runtime')
const mockedFeishu = await import('./feishu')
agentCardsDeps.sendCard = mockedFeishu.sendCard
agentCardsDeps.getChatTailMessageId = mockedFeishu.getChatTailMessageId
