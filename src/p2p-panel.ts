/**
 * 单聊（1:1）只读面板。单聊不对应任何项目：不建 Session、不写状态、不启动进程、没有按钮，
 * 所有操作都留在项目群里，方便大家看到发生了什么。任何类型和内容的单聊消息都回同一张面板。
 *
 * 活跃项目只列发起人看得到的运行中会话：发起人是会话所在群的成员（实时查询），或是某个群的群主、
 * 该群正是其群名对应项目已保存绑定的群（按 chat_id 锚定，同名、撞名或改名后留下的群不算），且会话就在这个群里，
 * 或是它的 `名*` 临时群、`名[` wt 群及其临时群。群主与成员关系只在本次请求里用于比较，不缓存、不记录，
 * 日志只有固定事件名；查询失败或超时都隐藏受影响的会话，并在卡片上说明。
 * 不能确认发送者与机器人同属一个企业时按外部联系人显示：没有账号名、主机和全部账号额度。
 *
 * 依赖全部注入且只读（daemon 负责接线），模块本身只引用类型和纯函数，没有建会话、写状态或启动进程的途径。
 */
import type { AccountUsage } from './account-usage'
import type { ConsoleOpts } from './cards/console'
import { p2pConsoleCard } from './cards/p2p'
import type { SessionWorkload } from './cards/task-kind'
import type { ChatOwner } from './feishu'
import { feishuErrorDetails, formatFeishuError, redactMemberIds } from './feishu-errors'
import { logDiagnostic, logError } from './log'
import { sanitizeSessionName } from './session-name'
import type { SysInfo } from './sysinfo'

type ConsolePeer = NonNullable<ConsoleOpts['peers']>[number]

/** 单聊面板读取的运行中会话字段；`Session` 满足这个结构。 */
export interface P2pPanelSession {
  readonly sessionName: string
  readonly chatId: string
  peerSnapshot(): Omit<ConsolePeer, 'isCurrent' | 'workload'>
  workload(): Promise<SessionWorkload>
}

/** 单聊面板的全部依赖，只有读取和发消息。 */
export interface P2pPanelDeps {
  /** 当前运行中的会话，与群里 `hi` 的活跃项目同源。 */
  runningSessions(): readonly P2pPanelSession[]
  /** 机器人所在的群及群主（一次分页 `im.chat.list`）；到了 `deadlineAt` 中止请求、不再翻页。 */
  listChatOwners(deadlineAt: number): Promise<ChatOwner[]>
  /** 发起人当前是否在群里（实时分页 `chatMembers.get`）；期限同上。 */
  isChatMember(chatId: string, openId: string, deadlineAt: number): Promise<boolean>
  /** 会话名（项目名）已保存的群绑定；没有绑定为 null，不按缓存群名猜测。 */
  boundChatIdForSession(sessionName: string): string | null
  readAllAccountUsage(): Promise<AccountUsage[]>
  readSysInfo(): Promise<SysInfo>
  sendCard(chatId: string, card: object, onFailure?: (error: unknown) => void): Promise<string | null>
  sendTextRaw(chatId: string, text: string): Promise<string | null>
  /** 整张面板的读取期限，缺省 `P2P_PANEL_DEADLINE_MS`。 */
  deadlineMs?: number
}

/** 成员查询逐群发请求；同一套依赖（daemon 里所有单聊共用一套）同时最多这么多个，避免打满飞书限流。
 * 超时被放弃的读取还在路上时，下一条单聊的查询也算在里面。 */
export const P2P_MEMBERSHIP_CONCURRENCY = 4
/** 整张面板的读取期限：卡住的查询不能一直占着这个单聊的消息队列。到期后不再发起任何读取，不重试。 */
export const P2P_PANEL_DEADLINE_MS = 20_000
export const P2P_LOOKUP_FAILED_NOTE = '⚠️ 部分项目读取失败，已隐藏'

/** `chatMembers.get` 的这几种拒绝说明群已不在或机器人已不在群里：chat_id 无效、群已解散、操作者不在群里。 */
const CHAT_GONE_CODES = new Set(['232006', '232009', '232011'])

/** `im.message.receive_v1` 的单聊消息。 */
export function isP2pMessage(message: unknown): boolean {
  return (message as { chat_type?: unknown } | null | undefined)?.chat_type === 'p2p'
}

type TenantFields = {
  tenant_key?: unknown
  header?: { tenant_key?: unknown }
  sender?: { tenant_key?: unknown }
  event?: { sender?: { tenant_key?: unknown } }
}

/**
 * 单聊面板是否按外部联系人显示：事件里发送者与机器人的租户字段都在且相同才算本企业成员，
 * 任一缺失或不同都按外部处理。只用于单聊面板；`RequesterTenant`（缺失按内部）不受影响。
 */
export function p2pViewerRestricted(event: unknown): boolean {
  const data = (event ?? {}) as TenantFields
  const sender = data.sender?.tenant_key ?? data.event?.sender?.tenant_key
  const app = data.tenant_key ?? data.header?.tenant_key
  return !(typeof sender === 'string' && sender.trim() !== '' && sender === app)
}

/** 发起人当群主、并且就是其群名对应项目已保存绑定的那个群。 */
export interface AnchoredGroup {
  readonly chatId: string
  /** 群名按会话名规则转换后的结果。 */
  readonly sessionName: string
}

/**
 * 纯函数：发起人当群主的群里，只保留「群名转成的会话名已保存的绑定正是这个群」的群，
 * 同名、撞名（`foo bar`/`foo.bar`、假名、截断）或改名后留下的群都不算。`boundChatIdForSession`
 * 只能给已保存的绑定，不能按缓存群名猜测。
 */
export function anchoredOwnedGroups(
  groups: readonly ChatOwner[],
  requesterOpenId: string,
  boundChatIdForSession: (sessionName: string) => string | null,
): AnchoredGroup[] {
  if (!requesterOpenId) return []
  return groups.flatMap(group => {
    if (group.ownerOpenId !== requesterOpenId) return []
    const sessionName = sanitizeSessionName(group.name)
    return sessionName && boundChatIdForSession(sessionName) === group.chatId ? [{ chatId: group.chatId, sessionName }] : []
  })
}

/** 群派生的会话名：`<群>*…` 临时群、`<群>[…` wt 群及其临时群。`foo-bar` 不属于 `foo`。 */
export function isDerivedSessionName(sessionName: string, groupSessionName: string): boolean {
  return groupSessionName !== ''
    && (sessionName.startsWith(`${groupSessionName}*`) || sessionName.startsWith(`${groupSessionName}[`))
}

/**
 * 单聊可见性（纯函数）：发起人是会话所在群的成员；或者经锚定的自有群 G 可见——同名会话还须就在 G 里，
 * `G*…`、`G[…` 会话经 G 可见。
 */
export function p2pSessionVisible(
  session: { readonly sessionName: string; readonly chatId: string },
  anchoredGroups: readonly AnchoredGroup[],
  member: boolean,
): boolean {
  if (member) return true
  return anchoredGroups.some(group => session.sessionName === group.sessionName
    ? session.chatId === group.chatId
    : isDerivedSessionName(session.sessionName, group.sessionName))
}

function chatGone(error: unknown): boolean {
  return CHAT_GONE_CODES.has(String(feishuErrorDetails(error).code ?? ''))
}

/** 一次面板构建的期限：`at` 交给飞书查询当截止时间，`signal` 在回复已定（超时或完成）时中止。 */
export interface PanelDeadline {
  readonly at: number
  readonly signal: AbortSignal
}

/** 期限已到：放弃的构建不再发起读取，手里的数据随之丢弃。 */
class PanelDeadlineExpired extends Error {
  constructor() {
    super('p2p panel deadline expired')
    this.name = 'PanelDeadlineExpired'
  }
}

function checkDeadline(deadline: PanelDeadline): void {
  if (deadline.signal.aborted) throw new PanelDeadlineExpired()
}

interface MembershipSlots {
  active: number
  readonly waiters: Set<() => void>
}

/** 按依赖对象记的成员查询名额，只计数、不存任何 ID。 */
const membershipSlots = new WeakMap<object, MembershipSlots>()

/** 等一个成员查询名额；期限到了就不再等，返回 null。拿到的名额必须调用返回的函数释放。 */
async function acquireMembershipSlot(deps: object, signal: AbortSignal): Promise<(() => void) | null> {
  let slots = membershipSlots.get(deps)
  if (!slots) membershipSlots.set(deps, slots = { active: 0, waiters: new Set() })
  const shared = slots
  while (shared.active >= P2P_MEMBERSHIP_CONCURRENCY) {
    if (signal.aborted) return null
    await new Promise<void>(resolve => {
      const wake = (): void => {
        shared.waiters.delete(wake)
        signal.removeEventListener('abort', wake)
        resolve()
      }
      shared.waiters.add(wake)
      signal.addEventListener('abort', wake, { once: true })
    })
  }
  if (signal.aborted) return null
  shared.active++
  let released = false
  return () => {
    if (released) return
    released = true
    shared.active--
    // 全部叫醒，各自重新检查名额；没抢到的继续等。
    for (const wake of [...shared.waiters]) wake()
  }
}

/** 最多 `limit` 个并发依次处理；期限到了不再取下一个。`run` 自己处理错误。 */
async function forEachWithLimit<T>(
  items: readonly T[], limit: number, signal: AbortSignal, run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (!signal.aborted && next < items.length) await run(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** 发起人可见的会话（保持原顺序）。查询失败时受影响的会话按不可见处理，`failed` 为 true；期限到了直接抛出。 */
async function visibleSessions(
  running: readonly P2pPanelSession[],
  requesterOpenId: string,
  deps: P2pPanelDeps,
  deadline: PanelDeadline,
): Promise<{ sessions: P2pPanelSession[]; failed: boolean }> {
  if (running.length === 0) return { sessions: [], failed: false }
  // 不知道发起人就无从比较，全部隐藏。
  if (!requesterOpenId) return { sessions: [], failed: true }
  let failed = false
  let owned: AnchoredGroup[] = []
  checkDeadline(deadline)
  try {
    const groups = await deps.listChatOwners(deadline.at)
    checkDeadline(deadline)
    owned = anchoredOwnedGroups(groups, requesterOpenId, deps.boundChatIdForSession)
  } catch (error) {
    if (deadline.signal.aborted) throw new PanelDeadlineExpired()
    // 群主列表读不到时，仍按成员关系逐个判断。
    failed = true
    logError('p2p-panel: chat owner lookup failed', error)
  }
  const visible = new Set<P2pPanelSession>()
  const unresolved: P2pPanelSession[] = []
  for (const session of running) {
    if (p2pSessionVisible(session, owned, false)) visible.add(session)
    else unresolved.push(session)
  }
  await forEachWithLimit(unresolved, P2P_MEMBERSHIP_CONCURRENCY, deadline.signal, async session => {
    const release = await acquireMembershipSlot(deps, deadline.signal)
    if (!release) return
    try {
      if (deadline.signal.aborted) return
      const member = await deps.isChatMember(session.chatId, requesterOpenId, deadline.at)
      if (member && !deadline.signal.aborted) visible.add(session)
    } catch (error) {
      // 期限已到，或群已无效、已解散、机器人已不在群里（确定不是成员）：都不算查询失败。
      if (deadline.signal.aborted || chatGone(error)) return
      failed = true
      logError('p2p-panel: membership lookup failed', error)
    } finally {
      release()
    }
  })
  checkDeadline(deadline)
  return { sessions: running.filter(session => visible.has(session)), failed }
}

async function readAccountUsage(deps: P2pPanelDeps): Promise<AccountUsage[]> {
  try {
    return await deps.readAllAccountUsage()
  } catch (error) {
    logError('p2p-panel: account usage read failed', error)
    const reason = error instanceof Error ? error.message : String(error)
    return [{ id: 'error', label: '额度', usage: { state: 'network', windows: [], reason } }]
  }
}

async function readHost(deps: P2pPanelDeps): Promise<SysInfo | undefined> {
  try {
    return await deps.readSysInfo()
  } catch (error) {
    // 主机区按缺失渲染为 MISS。
    logError('p2p-panel: sysinfo read failed', error)
    return undefined
  }
}

/** 不会中止的期限，只给飞书查询一个截止时间；`replyP2pPanel` 用自己的期限。 */
function openDeadline(deps: P2pPanelDeps): PanelDeadline {
  return { at: Date.now() + (deps.deadlineMs ?? P2P_PANEL_DEADLINE_MS), signal: new AbortController().signal }
}

/** 单聊面板卡片。内部成员另有账号名、主机与全部账号额度；受限时没有，额度与主机也不读取。
 * 期限到了在下一个检查点抛出，不再发起读取。 */
export async function buildP2pPanelCard(
  requesterOpenId: string,
  restricted: boolean,
  deps: P2pPanelDeps,
  deadline: PanelDeadline = openDeadline(deps),
): Promise<object> {
  const { sessions, failed } = await visibleSessions(deps.runningSessions(), requesterOpenId, deps, deadline)
  checkDeadline(deadline)
  const [workloads, accountUsages, sysinfo] = await Promise.all([
    Promise.all(sessions.map(session => session.workload())),
    restricted ? undefined : readAccountUsage(deps),
    restricted ? undefined : readHost(deps),
  ])
  checkDeadline(deadline)
  return p2pConsoleCard({
    // 受限时由模板去掉账号名。
    peers: sessions.map((session, index) => ({ ...session.peerSnapshot(), isCurrent: false, workload: workloads[index] })),
    restricted,
    ...(restricted ? {} : { accountUsages, sysinfo }),
    ...(failed ? { notice: P2P_LOOKUP_FAILED_NOTE } : {}),
  })
}

/**
 * 回复一条单聊消息：只发一张只读面板。整张面板超过期限就按全部隐藏回复，并中止仍在进行的构建：
 * 它不再发起读取，迟到的结果和错误都丢弃。卡片发不出去时改发纯文本，附飞书诊断并去掉成员 ID。
 * 生成失败或超时，受限读者只看到固定提示，内部成员另附原因。
 */
export async function replyP2pPanel(
  chatId: string,
  requesterOpenId: string,
  restricted: boolean,
  deps: P2pPanelDeps,
): Promise<void> {
  const deadlineMs = deps.deadlineMs ?? P2P_PANEL_DEADLINE_MS
  const controller = new AbortController()
  const deadline: PanelDeadline = { at: Date.now() + deadlineMs, signal: controller.signal }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, deadlineMs)
  })
  let card: object | null = null
  let buildFailure: { error: unknown } | null = null
  try {
    card = await Promise.race([buildP2pPanelCard(requesterOpenId, restricted, deps, deadline), expired])
  } catch (error) {
    // 期限到了才失败的构建按超时处理；其余是真实的生成失败。
    if (!controller.signal.aborted) buildFailure = { error }
  } finally {
    clearTimeout(timer)
    // 回复已定：还在进行的读取一律停下，不再发起新的查询。
    controller.abort()
  }
  if (buildFailure) {
    logError('p2p-panel: build failed', buildFailure.error)
    const { error } = buildFailure
    const reason = restricted ? '' : `：${redactMemberIds(error instanceof Error ? error.message : String(error))}`
    await deps.sendTextRaw(chatId, `❌ 面板生成失败${reason}`)
    return
  }
  if (card === null) {
    logDiagnostic('p2p-panel: build timed out')
    card = p2pConsoleCard({
      peers: [],
      restricted: true,
      notice: restricted ? P2P_LOOKUP_FAILED_NOTE : `${P2P_LOOKUP_FAILED_NOTE}：读取超时`,
    })
  }
  let failure: unknown
  let messageId: string | null = null
  try {
    messageId = await deps.sendCard(chatId, card, error => { failure = error })
  } catch (error) {
    failure = error
  }
  if (!messageId) await deps.sendTextRaw(chatId, redactMemberIds(`❌ 面板发送失败\n${formatFeishuError(failure)}`))
}
