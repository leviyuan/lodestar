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
/** [projects.<name>] 项目 profile 替身,测试往里 set 后 Session 构造时可查到。 */
export const projectProfiles = new Map<string, ProjectProfile>()

export function resetFeishuMock(): void {
  for (const arr of [
    sentCards, sentTexts, sentRawTexts, updatedCards, addedReactions, deletedReactions, boundResumes, clearedResumes, urgentPushes,
    clearedTurnAnchorSessions, seededTurnAnchors, sentImages, uploadedImages, sentLocalFiles,
  ]) {
    arr.length = 0
  }
  projectProfiles.clear()
  chatTailMessages.clear()
  modelSelections.clear()
  resumeRefs.clear()
  turnAnchorsBySession.clear()
  resumeWriteError = null
  turnAnchorWriteError = null
  updateCardHandler = null
  imageUploadHandler = null
  branchBaseBySession.clear()
  pendingConversationLaunchBySession.clear()
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
  uploadAndSend: async (chatId: string, path: string) => { sentLocalFiles.push([chatId, path]); return true },
  preferredChatForSession: new Map(),
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
  tempProjectName: (name: string) => /\*[0-9]{4}-[0-9]{4}(?:-[0-9]+)?$/.test(name)
    ? name.replace(/\*[0-9]{4}-[0-9]{4}(?:-[0-9]+)?$/, '')
    : null,
  tempChatName: (project: string, additionallyUsed: Iterable<string> = []) => {
    const used = new Set(additionallyUsed)
    let name = `${project}*0000-0000`
    for (let seq = 2; used.has(name); seq++) name = `${project}*0000-0000-${seq}`
    return name
  },
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
  ensureChatForSession: async (chatName: string) => ({ chatId: `oc_${chatName}`, created: true, joined: true }),
  disbandChatForSession: async () => ({ chatId: null, disbanded: true }),
}))

// 随机顺序可能先加载 AgentService，令默认卡片依赖保存真实函数的副本。
// mock.module 只更新模块导出；同步替换这两份已捕获的引用，避免测试访问飞书。
const { agentCardsDeps } = await import('./agent-cards-runtime')
const mockedFeishu = await import('./feishu')
agentCardsDeps.sendCard = mockedFeishu.sendCard
agentCardsDeps.getChatTailMessageId = mockedFeishu.getChatTailMessageId
