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

export const sentCards: object[] = []
export const sentTexts: string[] = []
export const sentRawTexts: string[] = []
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
export const projectProfiles = new Map<string, { cwd?: string }>()

export function resetFeishuMock(): void {
  for (const arr of [
    sentCards, sentTexts, sentRawTexts, updatedCards, addedReactions, deletedReactions, boundResumes, clearedResumes, urgentPushes,
    clearedTurnAnchorSessions, seededTurnAnchors,
  ]) {
    arr.length = 0
  }
  projectProfiles.clear()
  modelSelections.clear()
  resumeRefs.clear()
  turnAnchorsBySession.clear()
  resumeWriteError = null
  turnAnchorWriteError = null
  updateCardHandler = null
  branchBaseBySession.clear()
  pendingConversationLaunchBySession.clear()
}

mock.module('./feishu', () => ({
  PROJECTS_ROOT: '/tmp/lodestar-projects',
  resolveProjectDir: (name: string) => projectProfiles.get(name)?.cwd?.trim() || `/tmp/lodestar-projects/${name}`,
  getSessionResumeRef: (sessionName: string, provider = 'codex') => {
    const ref = resumeRefs.get(`${sessionName}:${provider}`)
    return ref ? { ...ref } : null
  },
  getSessionModelSelection: (sessionName: string) => modelSelections.get(sessionName) ?? null,
  getTenantToken: async () => 'tenant-token',
  preferredChatForSession: new Map(),
  sendCard: async (_chatId: string, card: object) => {
    sentCards.push(card)
    return `om_status_${sentCards.length}`
  },
  sendText: async (_chatId: string, text: string) => {
    sentTexts.push(text)
    return 'om_text'
  },
  sendTextRaw: async (_chatId: string, text: string) => {
    sentRawTexts.push(text)
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
