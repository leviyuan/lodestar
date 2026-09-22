import { EventEmitter } from 'node:events'
import { fileDeliveryAgentContext } from './instructions'
import { FileDeliveryBatch } from './file-delivery'
import { GroupFileDelivery } from './group-file-delivery'
import type { FileDeliverySnapshot } from './file-delivery-types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  boundResumes, branchBaseBySession, clearedResumes, deletedReactions, projectProfiles, resetFeishuMock,
  modelSelections, sentCards, sentRawTexts, sentTexts, updatedCards, urgentPushes,
  setResumeWriteError, setTurnAnchorWriteError,
  turnAnchorsBySession, resumeRefs, pendingConversationLaunchBySession,
  sentImages, uploadedImages, sentLocalFiles, setImageUploadHandler,
} from './feishu-test-mock'

const { Session } = await import('./session')
const sessionTools = await import('./session-tools')
const { CodexRpcResponseError } = await import('./codex-process')
const { ClaudeAgentProcess } = await import('./claude-agent-process')
const cardkit = await import('./cardkit')
const feishu = await import('./feishu')
const mathRender = await import('./math-render')
const { config } = await import('./config')
const { groupFileDelivery } = await import('./file-delivery-runtime')
const { getTokenSource, listTokenSources, registerTokenSource, refreshAllTokenSourceModels, resetTokenSourceRegistry, tokenSourceProcessRevision } = await import('./token-source')
const { buildTokenSourcesFromConfig } = await import('./token-source-builtins')
const { peekUsage, refreshUsageFromConnection, invalidateCodexUsage } = await import('./usage')

const DETERMINISTIC_FOOTER_HANDLE = 0xdeadbeef as unknown as ReturnType<typeof setTimeout>

interface FetchCall {
  method: string
  path: string
  body: any
}

const originalFetch = globalThis.fetch
let calls: FetchCall[] = []

beforeEach(() => {
  calls = []
  resetFeishuMock()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/open-apis/cardkit/v1', '')
    calls.push({
      method: String(init?.method ?? 'GET'),
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    const data = path === '/cards/id_convert'
      ? { card_id: `card_status_${calls.length}` }
      : {}
    return new Response(JSON.stringify({ code: 0, data }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
})

describe('Session delegated-agent capability', () => {
  test('API Codex starts without ChatGPT login and uses its own quota in the footer', async () => {
    const session = new Session('packy-api-start', 'chat_id') as any
    const source = {
      id: 'packy-api-test', kind: 'packy-api-test', agent: 'codex', display: 'Packy', enabled: true,
      models: [{ model: 'kimi-k3', display: 'Kimi', efforts: ['medium'], defaultEffort: 'medium' }],
      defaultModel: 'kimi-k3', modelCatalogState: { status: 'ready', updatedAt: 1 },
      codexApiProvider: { id: 'packy', name: 'Packy', baseUrl: 'https://cf.api.fan/v1', envKey: 'PACKY_KEY' },
      readUsage: async () => ({ state: 'ok', kind: 'quota', windows: [], quota: { remaining: 2, limit: 5, currency: 'USD' } }),
    }
    const proc = new FakeAgentProc('codex', 'packy-native-thread') as any
    proc.tokenSourceId = source.id
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    proc.initializationPromise = () => Promise.resolve()
    proc.sendInitialize = () => proc.emit('init', { session_id: proc.sessionId })
    proc.readRateLimits = () => { throw new Error('must not read subscription limits') }
    session.selectedProvider = 'codex'
    session.selectedTokenSourceId = source.id
    session.selectedModel = 'kimi-k3'
    session.selectedEffort = 'medium'
    session.currentTokenSource = () => source
    session.spawnAgent = () => proc
    Object.defineProperty(session, 'workDir', { value: process.cwd() })
    const auth = spyOn(feishu, 'isOpenAIChatGPTAuthenticated').mockImplementation(() => { throw new Error('must not check ChatGPT auth') })
    try {
      expect(await session.start({ announce: false })).toBe(true)
      expect(auth).not.toHaveBeenCalled()
      expect(session.peerSnapshot().codexAccountName).toBeUndefined()
      expect(await session.footerUsageSuffix('codex', proc, source.id, source, null, 'kimi-k3')).toBe('  |  额度 $2.00 / $5.00')
      expect(session.conversationRouting().codexAccountId).toBeUndefined()
      expect(session.conversationRouting().codexAccountAutomatic).toBeUndefined()
    } finally {
      auth.mockRestore()
      await session.stop('API source test complete', { announce: false })
    }
  })

  test('accepts only the live process capability and delegates cancellation', async () => {
    const cancellations: Array<[string, string]> = []
    const session = new Session('agent-capability', 'chat_id', {
      onCancelAgentRuns: async (name: string, _chatId: string, reason: string) => { cancellations.push([name, reason]) },
    }) as any
    session.proc = { isAlive: () => true }
    session.agentCapability = 'secret-capability'

    expect(session.acceptsAgentCapability('secret-capability')).toBe(true)
    expect(session.acceptsAgentCapability('wrong')).toBe(false)
    session.proc = { isAlive: () => false }
    expect(session.acceptsAgentCapability('secret-capability')).toBe(false)

    await session.cancelAgentRuns('stop')
    expect(cancellations).toEqual([['agent-capability', 'stop']])
  })

  test('routes the global agents command to the identity panel', async () => {
    const session = new Session('agents-command', 'chat_id') as any
    let owner = ''
    session.showAgentIdentityPanel = async (userOpenId: string) => { owner = userOpenId }
    expect(await session.runCommand('agents', 'ou_owner')).toBe(true)
    expect(owner).toBe('ou_owner')
  })

  test('keeps the legacy no-source Codex effort delegated to config.toml', () => {
    const session = new Session('legacy-codex-effort', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.selectedTokenSourceId = null
    session.currentTokenSource = () => undefined
    expect(session.effortForSpawn()).toBeUndefined()
  })
})

class FakeAgentProc extends EventEmitter {
  lastAssistantUuid = null
  lastModel: string | null = null
  lastEffort: string | null = null
  lastUsage: any = null
  lastTotalUsage: any = null
  lastResult: any = {
    cost_usd: null,
    cost_delta_usd: null,
    duration_ms: null,
    num_turns: null,
    usage: null,
    subtype: null,
    is_error: false,
  }
  lastContextWindow = null
  sentTexts: string[] = []
  killCalls = 0
  setModelSettingsCalls: Array<[string, string]> = []
  alive = true
  launchKind: 'fresh' | 'resume' | 'fork' | undefined
  conversationResumable = true
  initialization: Promise<void> = Promise.resolve()
  materializationBarrier: Promise<void> | null = null

  constructor(
    readonly provider: 'codex' | 'claude' | 'dsh',
    public sessionId: string | null = null,
    readonly tokenSourceId: string | null = null,
  ) {
    super()
  }

  sendInitialize(): void {}

  initializationPromise(): Promise<void> {
    return this.initialization
  }

  isConversationResumable(): boolean {
    return this.conversationResumable
  }

  conversationMaterializationBarrier(): Promise<void> | null {
    return this.materializationBarrier
  }

  sendUserText(text: string): void {
    this.sentTexts.push(text)
  }

  sendInterrupt(): void {}
  sendPermissionResponse(): void {}
  sendHookResponse(): void {}

  isAlive(): boolean {
    return this.alive
  }

  async kill(): Promise<void> {
    this.killCalls++
    this.alive = false
    this.emit('exit', { code: 0, signal: null, expected: true })
  }

  async listModels(): Promise<any[]> {
    return []
  }

  async setModelSettings(model: string, effort: string): Promise<void> {
    this.setModelSettingsCalls.push([model, effort])
  }
  async compactThread(): Promise<void> {}
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

function turnState(cardId = 'card_session_turn'): any {
  return {
    cardId,
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    messageId: 'om_session_turn',
    userOpenId: 'ou_user',
    trigger: 'user_message',
    toolCount: 0,
    toolByUseId: new Map(),
    planSteps: [],
    planExplanation: null,
    planUpdateCount: 0,
    goalUpdateCount: 0,
    contextCompactCount: 0,
    contextCompactionPending: new Map(),
    contextCompactionCompleted: new Set(),
    contextCompactionCompleting: new Set(),
    contextCompactionEndOnly: new Map(),
    lastContextCompactionCompletedAt: 0,
    lastContextCompactionWasAnonymous: false,
    toolBatches: new Map(),
    openBatchI: null,
    taskCreateI: null,
    taskUpdateI: null,
    taskBoardResetThisTurn: false,
    taskLiveInserted: false,
    planLiveInserted: false,
    assistantSegmentCount: 0,
    currentAssistantSegmentId: null,
    currentAssistantText: '',
    segmentTexts: new Map(),
    startedAt: Date.now(),
    footerStatusHandle: null,
    footerStatusStartedAt: 0,
    footerStatusLabel: null,
    rotating: null,
    rotateCount: 0,
    failureRotateCount: 0,
    cardCapacityFailures: new Map(),
    cardWriteFailureNotices: new Set(),
    cardRotationFailed: false,
    outboundSeenPaths: new Set(),
    outboundSentPaths: new Set(),
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

describe('Session cloud file receipts', () => {
  for (const provider of ['codex', 'claude', 'dsh'] as const) {
    test(`${provider} BTW uses its workspace mode and updates on the next input while WT stays separate`, async () => {
      const registry = new GroupFileDelivery({
        read: () => undefined, write: () => {}, workDirForChat: () => undefined,
        getChatName: async id => id,
        createFolder: async name => ({ token: name, url: `https://example.com/${name}` }),
        getFolder: async folder => ({ ...folder, name: folder.token }),
        renameFolder: async (folder, name) => ({ ...folder, name }),
        grantFolderAccess: async () => {},
      })
      const mode = spyOn(groupFileDelivery, 'mode').mockImplementation((chatId, workDir) => registry.mode(chatId, workDir))
      const main = new Session('workspace-modes', 'main')
      const btw = new Session('workspace-modes*0917-1234', 'btw') as any
      const wt = new Session('workspace-modes[feature]', 'wt')
      try {
        await registry.enable(main.chatId, main.workDir, 'user')
        expect(btw.getFileDeliveryMode()).toBe('drive')
        expect(wt.getFileDeliveryMode()).toBe('chat')
        const proc = new FakeAgentProc(provider)
        btw.procFileDeliveryModes.set(proc, 'drive')
        btw.sendClaimedUserText(proc, 'first')
        await registry.disable(main.chatId, main.workDir)
        btw.sendClaimedUserText(proc, 'second')
        btw.sendClaimedUserText(proc, 'third')
        expect(proc.sentTexts).toEqual(['first', `${fileDeliveryAgentContext('chat')}\n\nsecond`, 'third'])
      } finally { mode.mockRestore(); main.dispose(); btw.dispose(); wt.dispose() }
    })
  }

  test('keeps ordinary file and image messages as the default with no cloud card or upload', () => {
    const session = new Session('native-files', 'unconfigured-chat') as any
    const turn = turnState()
    session.currentTurn = turn
    session.createFileDeliveryForTurn = () => { throw new Error('cloud delivery must not be used by default') }
    expect(session.getFileDeliveryMode()).toBe('chat')
    session.sendOutboundPath('/tmp/report.pdf', 'send marker')
    session.sendOutboundPath('/tmp/image.png', 'send marker')
    expect(sentLocalFiles).toEqual([['unconfigured-chat', '/tmp/report.pdf'], ['unconfigured-chat', '/tmp/image.png']])
    expect(turn.fileDelivery).toBeUndefined()
    expect(turn.fileDeliveryMode).toBe('chat')
    expect(sentCards).toHaveLength(0)
  })

  test('switches only newly admitted batches, so one turn never mixes attachment and cloud delivery', () => {
    const session = new Session('file-mode-switch', 'chat') as any
    let mode = 'chat'
    const cloudPaths: string[] = []
    session.getFileDeliveryMode = () => mode
    session.createFileDeliveryForTurn = () => ({ add: (path: string) => cloudPaths.push(path), finish: async () => cloudPaths, cancel: () => false })
    session.currentTurn = turnState()
    session.sendOutboundPath('/tmp/first.pdf', 'send marker')
    mode = 'drive'
    session.sendOutboundPath('/tmp/second.pdf', 'send marker')
    expect(sentLocalFiles.map(([, path]) => path)).toEqual(['/tmp/first.pdf', '/tmp/second.pdf'])
    expect(cloudPaths).toEqual([])
    session.currentTurn = turnState()
    session.sendOutboundPath('/tmp/third.pdf', 'send marker')
    expect(cloudPaths).toEqual(['/tmp/third.pdf'])
  })

  test('updates delivery rules only when the group mode changes, without repeating startup rules', () => {
    const session = new Session('file-mode-context', 'chat') as any
    const proc = new FakeAgentProc('codex')
    let mode = 'drive'
    session.getFileDeliveryMode = () => mode
    session.procFileDeliveryModes.set(proc, mode)
    session.sendClaimedUserText(proc, '生成大文件')
    mode = 'chat'
    session.sendClaimedUserText(proc, '继续交付')
    session.sendClaimedUserText(proc, '生成报告')
    mode = 'drive'
    session.sendClaimedUserText(proc, '生成视频')
    expect(proc.sentTexts).toEqual([
      '生成大文件',
      `${fileDeliveryAgentContext('chat')}\n\n继续交付`,
      '生成报告',
      `${fileDeliveryAgentContext('drive')}\n\n生成视频`,
    ])
    expect(proc.sentTexts[3]).not.toMatch(/30|大小|压缩|分卷/)
  })

  test('freezes delivery before file generation so changing the group switch cannot invalidate the prepared file', () => {
    const session = new Session('file-mode-preparation', 'chat') as any
    const proc = new FakeAgentProc('codex')
    session.proc = proc
    let mode = 'drive'
    session.getFileDeliveryMode = () => mode
    session.procFileDeliveryModes.set(proc, mode)
    const cloudPaths: string[] = []
    session.createFileDeliveryForTurn = () => ({ add: (path: string) => cloudPaths.push(path), finish: async () => cloudPaths, cancel: () => false })
    session.currentTurn = turnState()
    session.sendClaimedUserText(proc, '生成视频')
    mode = 'chat'
    session.sendOutboundPath('/tmp/video.mp4', 'send marker')
    expect(cloudPaths).toEqual(['/tmp/video.mp4'])
    expect(sentLocalFiles).toEqual([])
    session.currentTurn = turnState()
    session.sendClaimedUserText(proc, '生成报告')
    session.sendOutboundPath('/tmp/report.pdf', 'send marker')
    expect(sentLocalFiles).toEqual([['chat', '/tmp/report.pdf']])
    expect(proc.sentTexts).toEqual(['生成视频', `${fileDeliveryAgentContext('chat')}\n\n生成报告`])
  })

  test('keeps the injected delivery mode if the backend opens its card after the group switch changed', () => {
    const session = new Session('file-mode-late-card', 'chat') as any
    const proc = new FakeAgentProc('codex')
    session.proc = proc
    let mode = 'drive'
    session.getFileDeliveryMode = () => mode
    session.procFileDeliveryModes.set(proc, mode)
    const cloudPaths: string[] = []
    session.createFileDeliveryForTurn = () => ({ add: (path: string) => cloudPaths.push(path), finish: async () => cloudPaths, cancel: () => false })
    session.sendClaimedUserText(proc, '生成视频')
    mode = 'chat'
    session.currentTurn = turnState()
    session.sendOutboundPath('/tmp/late-video.mp4', 'send marker')
    expect(cloudPaths).toEqual(['/tmp/late-video.mp4'])
    expect(sentLocalFiles).toEqual([])
  })

  test('retries a delivery-rule update after the backend rejects its input write', () => {
    const session = new Session('file-mode-write-error', 'chat') as any
    const proc = new FakeAgentProc('codex')
    session.procFileDeliveryModes.set(proc, 'drive')
    session.getFileDeliveryMode = () => 'chat'
    const send = proc.sendUserText.bind(proc)
    proc.sendUserText = () => { throw new Error('input closed') }
    expect(() => session.sendClaimedUserText(proc, '生成报告')).toThrow('input closed')
    expect(session.pendingUserMessageCount).toBe(0)
    expect(session.procFileDeliveryModes.get(proc)).toBe('drive')
    proc.sendUserText = send
    session.sendClaimedUserText(proc, '生成报告')
    expect(proc.sentTexts).toEqual([`${fileDeliveryAgentContext('chat')}\n\n生成报告`])
  })

  test('routes files commands to the current group settings without forwarding them to an Agent', async () => {
    const session = new Session('file-commands', 'chat') as any
    const calls: unknown[][] = []
    session.runFileDeliveryCommand = async (...args: unknown[]) => { calls.push(args) }
    for (const command of ['files', 'files on', 'FILES OFF']) expect(await session.runCommand(command, 'ou_user')).toBe(true)
    expect(calls).toEqual([['', 'ou_user'], ['on', 'ou_user'], ['OFF', 'ou_user']])
  })

  test('keeps one delivery across rotations, deduplicates markers, and waits for final publication', async () => {
    const session = new Session('files', 'chat_id') as any
    const turn = turnState('card_file_receipt')
    turn.fileDeliveryMode = 'drive'
    cardkit.recordCardCreated(turn.cardId, 1)
    session.currentTurn = turn
    const admitted: string[] = []
    let release!: (paths: string[]) => void
    let finishStarted = false
    const publication = new Promise<string[]>(resolve => { release = resolve })
    let factories = 0
    session.createFileDeliveryForTurn = (captured: any) => {
      expect(captured.userOpenId).toBe('ou_user')
      factories++
      return { add: (path: string) => { admitted.push(path) }, finish: () => { finishStarted = true; return publication } }
    }
    session.sendOutboundPath('/tmp/large.mp4', 'send marker')
    session.sendOutboundPath('/tmp/large.mp4', 'duplicate marker')
    session.sendOutboundPath('/tmp/report.pdf', 'send marker after rotation')
    expect(factories).toBe(1)
    expect(admitted).toEqual(['/tmp/large.mp4', '/tmp/report.pdf'])
    expect(turn.outboundSentPaths.size).toBe(0)
    expect(sentLocalFiles).toHaveLength(0)
    const closed = session.closeTurnCard()
    await waitUntil(() => finishStarted)
    expect(cardkit.isDisposed(turn.cardId)).toBe(false)
    release(['/tmp/large.mp4'])
    await closed
    expect(turn.outboundSentPaths.has('/tmp/large.mp4')).toBe(true)
    expect(turn.outboundSentPaths.has('/tmp/report.pdf')).toBe(false)
    expect(cardkit.isDisposed(turn.cardId)).toBe(true)
  })

  test.each([
    ['codex', 'success'], ['claude', 'success'], ['dsh', 'success'],
    ['codex', 'error_during_execution'], ['claude', 'error_during_execution'], ['dsh', 'error_during_execution'],
  ] as const)('%s keeps an upload running when a result hands queued input to a new card (result=%s)', async (provider, subtype) => {
    const isError = subtype !== 'success'
    const session = new Session('file-handoff', 'chat_id') as any
    const proc = new FakeAgentProc(provider)
    session.proc = proc
    session.selectedProvider = provider
    session.selectedEffort = 'high'
    session.getFileDeliveryMode = () => 'drive'
    session.procFileDeliveryModes.set(proc, 'drive')
    session.wireProc(proc)
    const turn = turnState(`card_file_handoff_${provider}_${isError}`)
    turn.provider = provider
    turn.fileDeliveryMode = 'drive'
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    const receipts: FileDeliverySnapshot[] = []
    const errors: string[] = []
    let uploadSignal: AbortSignal | undefined
    let release!: () => void
    const delivery = new FileDeliveryBatch({
      chatId: 'chat_id', managerOpenId: 'ou_user', projectName: 'file-handoff', createdAt: turn.startedAt,
    }, {
      resolveFolder: async () => ({ token: 'folder', url: 'https://example.feishu.cn/drive/folder/folder' }),
      uploadFile: async (path, _folder, onUploaded, signal) => {
        uploadSignal = signal
        await new Promise<void>((resolve, reject) => {
          release = resolve
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        const file = { token: 'video', name: path, bytes: 40 * 1024 * 1024, url: 'https://example.feishu.cn/file/video' }
        onUploaded(file)
        return file
      },
      sendCard: async snapshot => { receipts.push(structuredClone(snapshot)); return 'om_receipt' },
      persist: () => {},
      reportError: async message => { errors.push(message) },
    })
    session.createFileDeliveryForTurn = () => delivery
    session.sendOutboundPath('/tmp/preview.mp4', 'send marker')
    await waitUntil(() => uploadSignal !== undefined)
    try {
      session.pendingMidTurnMsgs = [{
        text: '继续下一步', wireText: '继续下一步', userOpenId: 'ou_user', msgId: 'om_followup',
      }]
      proc.lastResult = { ...proc.lastResult, subtype, is_error: isError }
      proc.emit('result', { is_error: isError })
      await waitUntil(() => proc.sentTexts.includes('继续下一步'))
      const nextTurn = session.currentTurn
      expect(nextTurn).not.toBeNull()
      expect(nextTurn).not.toBe(turn)
      expect(uploadSignal!.aborted).toBe(false)
      expect(delivery.snapshot.files[0].status).toBe('pending')
      expect(receipts).toHaveLength(0)
      expect(cardkit.isDisposed(turn.cardId)).toBe(false)
      expect(session.fileDeliveries.has(delivery)).toBe(true)

      release()
      await session.waitForTurnCloses()
      expect(receipts).toHaveLength(1)
      expect(receipts[0].files.map(file => file.status)).toEqual(['ready'])
      expect(receipts[0].error).toBeUndefined()
      expect(errors).toEqual([])
      expect(turn.outboundSentPaths.has('/tmp/preview.mp4')).toBe(true)
      expect(cardkit.isDisposed(turn.cardId)).toBe(true)
      expect(session.fileDeliveries.size).toBe(0)
      expect(session.currentTurn).toBe(nextTurn)
      expect(nextTurn.outboundSentPaths.size).toBe(0)
      const footer = calls.find(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
      expect(JSON.stringify(footer?.body)).toContain(isError ? '用户已介入' : '📨 转交新卡')
    } finally {
      release()
      await session.waitForTurnCloses()
      if (session.currentTurn) await session.closeTurnCard()
    }
  })

  test.each(['hard', 'soft'])('%s stop cancels file delivery after the agent finished and its turn was captured', async mode => {
    const session = new Session('closing-files', 'chat_id') as any
    const turn = turnState('card_closing_files')
    turn.fileDeliveryMode = 'drive'
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    let finishStarted = false
    let cancelled = ''
    let release!: (paths: string[]) => void
    const published = new Promise<string[]>(resolve => { release = resolve })
    session.createFileDeliveryForTurn = () => ({
      add: () => {},
      finish: () => { finishStarted = true; return published },
      cancel: (reason: string) => { cancelled = reason; release([]); return true },
    })
    session.sendOutboundPath('/tmp/large.mp4', 'send marker')
    const close = session.closeTurnCard()
    await waitUntil(() => finishStarted)
    expect(session.currentTurn).toBeNull()
    if (mode === 'hard') await session.stop('取消尚未完成的交付', { announce: false })
    else await session.runCommand('stop', 'ou_user')
    await close
    expect(cancelled).toBe(mode === 'hard' ? '取消尚未完成的交付' : '用户停止了任务')
    expect(cardkit.isDisposed(turn.cardId)).toBe(true)
    expect(session.fileDeliveries.size).toBe(0)
  })
})

describe('generated image delivery', () => {
  test('card rotation waits for the generated image on the old tool card', async () => {
    const session = new Session('image-rotation', 'chat_id') as any
    const oldCardId = 'card_image_rotation_old'
    const turn = turnState(oldCardId)
    session.currentTurn = turn
    cardkit.recordCardCreated(oldCardId, 1)
    let release!: (key: string) => void
    setImageUploadHandler(() => new Promise(resolve => { release = resolve }))
    try {
      sessionTools.addTool(session, 'image-call', 'ImageGeneration', { revisedPrompt: 'Prompt before rotation' })
      sessionTools.completeTool(session, 'image-call', '/tmp/rotated-image.png', false)
      await cardkit.flush(oldCardId)
      session.startMidTurnRotate(turn)
      await waitUntil(() => turn.cardId !== oldCardId)
      const rotating = turn.rotating
      expect(rotating).not.toBeNull()
      release('img_before_rotation')
      await rotating
      expect(calls.some(call => call.path === `/cards/${oldCardId}/elements/tool_0` && String(call.body?.element).includes('img_before_rotation'))).toBe(true)
      expect(sentImages).toEqual([])
      expect(turn.outboundSentPaths.has('/tmp/rotated-image.png')).toBe(true)
    } finally {
      release?.('img_before_rotation')
      if (turn.rotating) await turn.rotating
      session.stopFooterStatus(turn)
      await cardkit.dispose(oldCardId); await cardkit.dispose(turn.cardId); session.dispose()
    }
  })

  test('renders the completed prompt and picture in the tool fold without a separate image message', async () => {
    const session = new Session('image-fold', 'chat_id') as any
    const turn = turnState('card_image_fold')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    try {
      sessionTools.addTool(session, 'image-call', 'ImageGeneration', { status: 'inProgress', prompt: 'Original prompt' })
      sessionTools.completeTool(session, 'image-call', '/tmp/generated.png', false, { status: 'completed', revisedPrompt: 'Actual image prompt' })
      await sessionTools.waitForImageDeliveries(turn)
      await cardkit.flush(turn.cardId)
      const update = calls.filter(call => call.method === 'PUT' && call.path.endsWith('/elements/tool_0')).at(-1)!
      const element = JSON.parse(update.body.element)
      expect(element.expanded).toBe(false)
      expect(element.header.title.content).not.toContain('Actual image prompt')
      expect(element.elements[0].content).toContain('Original prompt')
      expect(element.elements[0].content).toContain('Actual image prompt')
      expect(element.elements[1]).toMatchObject({ tag: 'img', img_key: 'img_generated', preview: true })
      expect(uploadedImages).toEqual(['/tmp/generated.png'])
      expect(sentImages).toEqual([])
      expect(turn.outboundSentPaths.has('/tmp/generated.png')).toBe(true)
      session.sendOutboundPath('/tmp/generated.png', 'duplicate marker')
      expect(sentLocalFiles).toEqual([])
    } finally { session.stopFooterStatus(turn); await cardkit.dispose(turn.cardId); session.dispose() }
  })

  test('a rejected inline image uses the already uploaded image as one standalone message', async () => {
    const session = new Session('image-separate', 'chat_id') as any
    const turn = turnState('card_image_separate')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    const normalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT' && String(init.body).includes('img_generated')) {
        return Response.json({ code: 200570, msg: 'inline image rejected' })
      }
      return normalFetch(input, init)
    }) as typeof fetch
    try {
      sessionTools.addTool(session, 'image-call', 'ImageGeneration', { revisedPrompt: 'Prompt stays folded' })
      sessionTools.completeTool(session, 'image-call', '/tmp/generated.png', false)
      await sessionTools.waitForImageDeliveries(turn)
      expect(sentImages).toEqual([['chat_id', 'img_generated']])
      expect(uploadedImages).toHaveLength(1)
      expect(sentLocalFiles).toEqual([])
      const update = calls.filter(call => call.method === 'PUT' && call.path.endsWith('/elements/tool_0')).at(-1)!
      expect(JSON.parse(update.body.element).elements[0].content).toContain('图片已单独发送')
    } finally { globalThis.fetch = normalFetch; session.stopFooterStatus(turn); await cardkit.dispose(turn.cardId); session.dispose() }
  })

  test('turn close waits for image delivery before retiring its card', async () => {
    const session = new Session('image-close', 'chat_id') as any
    const turn = turnState('card_image_close')
    turn.userOpenId = ''
    session.currentTurn = turn
    session.selectedProvider = 'codex'; session.selectedTokenSourceId = null
    session.currentTokenSource = () => undefined
    cardkit.recordCardCreated(turn.cardId, 1)
    let release!: (key: string) => void
    setImageUploadHandler(() => new Promise(resolve => { release = resolve }))
    try {
      sessionTools.addTool(session, 'image-call', 'ImageGeneration', { revisedPrompt: 'Delayed image' })
      sessionTools.completeTool(session, 'image-call', '/tmp/delayed.png', false)
      let closed = false
      const close = session.closeTurnCard().then(() => { closed = true })
      await Bun.sleep(10)
      expect(closed).toBe(false)
      release('img_delayed')
      await close
      expect(closed).toBe(true)
      expect(turn.outboundSentPaths.has('/tmp/delayed.png')).toBe(true)
      expect(calls.some(call => call.method === 'PUT' && String(call.body?.element).includes('img_delayed'))).toBe(true)
      expect(sentImages).toEqual([])
    } finally { release?.('img_delayed'); await sessionTools.waitForImageDeliveries(turn); session.stopFooterStatus(turn); await cardkit.dispose(turn.cardId); session.dispose() }
  })
})

describe('Session fresh conversation state', () => {
  for (const provider of ['codex', 'claude'] as const) {
    test(`${provider} shows the backend's concrete error in the final card`, async () => {
      const session = new Session('backend-error-detail', 'chat_id') as any
      const proc = new FakeAgentProc(provider, 'error-session')
      const turn = turnState(`card_error_detail_${provider}`)
      turn.provider = provider
      turn.userOpenId = ''
      session.proc = proc
      session.currentTurn = turn
      session.footerUsageSuffix = async () => ''
      session.wireProc(proc)
      cardkit.recordCardCreated(turn.cardId, 1)
      proc.lastResult = { ...proc.lastResult, is_error: true, subtype: 'error_during_execution' }
      try {
        proc.emit('result', { is_error: true, error: 'Account quota exceeded: request was rejected' })
        await session.waitForTurnCloses()
        const footer = calls.find(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
        expect(footer?.body.element).toContain('Account quota exceeded: request was rejected')
      } finally {
        session.stopFooterStatus(turn)
        await cardkit.dispose(turn.cardId)
      }
    })
  }

  test('resets visible turn numbering and per-conversation counters', () => {
    const session = new Session('probe', 'chat_id') as any
    session.turnCounter = 7
    session.currentGoal = { objective: 'old goal', status: 'in_progress' }
    session.cumStats = { tokens: 123, costUsd: 1.25, turns: 4 }
    session.lastTurnDelta = { tokens: 12, costUsd: 0.25, durationMs: 900 }
    session.currentTurnUsageBaseline = { total_tokens: 100 }
    session.currentTurnUsageBaselineKnown = true
    session.lastTurnUsage = { total_tokens: 120 }
    session.usageTotalsSeedUnknown = true

    session.resetFreshConversationState()

    expect(session.turnCounter).toBe(0)
    expect(session.currentGoal).toBeNull()
    expect(session.cumStats).toEqual({ tokens: 0, costUsd: 0, turns: 0 })
    expect(session.lastTurnDelta).toBeNull()
    expect(session.currentTurnUsageBaseline).toBeNull()
    expect(session.currentTurnUsageBaselineKnown).toBe(false)
    expect(session.lastTurnUsage).toBeNull()
    expect(session.usageTotalsSeedUnknown).toBe(false)
  })
})

describe('Session token accounting', () => {
  test('uses Claude result usage when resumed totals baseline is unknown', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.currentTurnUsageBaseline = null
    session.currentTurnUsageBaselineKnown = false
    session.usageTotalsSeedUnknown = true
    proc.lastResult = {
      cost_usd: 0.03,
      cost_delta_usd: 0.03,
      duration_ms: 1200,
      num_turns: 1,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        total_tokens: 15,
      },
      subtype: 'success',
      is_error: false,
    }
    proc.lastTotalUsage = {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      total_tokens: 150,
    }

    session.accumulateResultStats()

    expect(session.lastTurnUsage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      total_tokens: 15,
    })
    expect(session.lastTurnDelta).toEqual({
      tokens: 12,
      costUsd: 0,
      durationMs: 1200,
    })
    expect(session.cumStats).toEqual({
      tokens: 12,
      costUsd: 0,
      turns: 1,
    })
  })
})

describe('Session assistant rendering', () => {
  test('capacity backoff keeps the card open, survives footer refreshes and preserves usage before the retry', async () => {
    const session = new Session('capacity-card', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'capacity-thread') as any
    const turn = turnState('card_capacity')
    session.proc = proc
    session.currentTurn = turn
    session.status = 'working'
    session.wireProc(proc)
    cardkit.recordCardCreated(turn.cardId, 1)
    try {
      proc.lastTotalUsage = { total_tokens: 100, input_tokens: 80, output_tokens: 20 }
      proc.emit('turn_started', { turn_id: 'original-turn' })
      proc.lastTotalUsage = { total_tokens: 150, input_tokens: 110, output_tokens: 40 }
      proc.turnRetry = { phase: 'waiting', attempt: 2, delayMs: 10_000, message: 'Selected model is at capacity' }
      proc.emit('turn_retry', proc.turnRetry)
      session.startWorkingFooter(turn)
      await cardkit.flush(turn.cardId)
      expect(session.status).toBe('working')
      expect(session.currentTurn).toBe(turn)
      expect(turn.footerStatusLabel).toBe('⏳ 模型满载 · 10s 后重试 #2')
      expect(calls.some(call => call.method === 'PUT' && JSON.stringify(call.body).includes('10s 后重试 #2'))).toBe(true)

      proc.turnRetry = null
      proc.emit('turn_started', { turn_id: 'retry-turn', retry: true })
      expect(turn.footerStatusLabel).not.toContain('满载')
      proc.lastTotalUsage = { total_tokens: 200, input_tokens: 140, output_tokens: 60 }
      session.accumulateResultStats()
      expect(session.lastTurnUsage).toMatchObject({ total_tokens: 100, input_tokens: 60, output_tokens: 40 })
      expect(session.cumStats.turns).toBe(1)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('a card opened after capacity failure reads the current retry state', async () => {
    const session = new Session('capacity-card-opening', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'capacity-thread') as any
    session.proc = proc
    session.wireProc(proc)
    proc.turnRetry = { phase: 'waiting', attempt: 1, delayMs: 5_000, message: 'Selected model is at capacity' }
    proc.emit('turn_retry', proc.turnRetry)
    const turn = turnState('card_capacity_opening')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    try {
      session.startThinkingFooter(turn)
      expect(turn.footerStatusLabel).toBe('⏳ 模型满载 · 5s 后重试 #1')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('buffers assistant deltas and inserts one completed markdown element without content streaming', async () => {
    // 本测断言 bucket 档位文案；显式钉死模式，隔离本机配置差异。
    const cfg = config as any
    const previousRuntime = cfg.runtime
    cfg.runtime = { ...(previousRuntime ?? {}), live_elapsed: 'bucket' }
    const session = new Session('probe', 'chat_id') as any
    const turn = turnState()
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.appendAssistant('Hello')
      session.appendAssistant(', world')
      await cardkit.flush(turn.cardId)

      expect(calls.some(call => call.path.endsWith('/content'))).toBe(false)
      expect(calls.some(call => call.method === 'POST' && call.path === `/cards/${turn.cardId}/elements`)).toBe(false)

      session.finalizeCurrentAssistantSegment()
      await cardkit.flush(turn.cardId)

      const assistantAdd = calls.find(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements`
      )
      expect(JSON.parse(assistantAdd?.body.elements ?? '[]')).toEqual([{
        tag: 'markdown',
        element_id: 'assistant_0',
        content: 'Hello, world',
      }])

      const footerWrites = calls
        .filter(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
        .map(call => JSON.parse(call.body.element).content as string)
      // cc13607:footer 计时改相对档位(0s → <30s 档),不再是秒数
      expect(footerWrites.some(content => content.startsWith('Writing... (<30s)'))).toBe(true)
      expect(footerWrites.some(content => content.startsWith('Working... (<30s)'))).toBe(true)
      expect(calls.some(call => call.path.endsWith('/content'))).toBe(false)
    } finally {
      session.stopFooterStatus(turn)
      if (previousRuntime === undefined) delete cfg.runtime
      else cfg.runtime = previousRuntime
      await cardkit.dispose(turn.cardId)
    }
  })

  test('passes assistant text through unmodified without the askusr marker protocol', async () => {
    const session = new Session('probe', 'chat_id') as any
    const turn = turnState()
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.appendAssistant('Before [[askusr: {"questions":[{"question":"Pick?","options":["A","B"]}]}]] after')
      session.finalizeCurrentAssistantSegment()
      await cardkit.flush(turn.cardId)

      // askusr marker 协议已退役:正文原样上卡,不再剥离/替换/建独立问答卡。
      expect(sentCards.length).toBe(0)
      const assistantAdd = calls.find(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements`
      )
      const elements = JSON.parse(assistantAdd?.body.elements ?? '[]')
      expect(elements[0]?.content).toContain('[[askusr:')
      expect(elements[0]?.content).not.toContain('已发起澄清问题')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

describe('Session ordered formula rendering across providers', () => {
  const renderedBlocks = {
    blocks: [
      { type: 'markdown' as const, text: '前文' },
      {
        type: 'image' as const,
        element: {
          tag: 'img', img_key: 'img_v2_formula_x',
          alt: { tag: 'plain_text', content: 'x' }, size: '40px 20px',
        },
      },
      { type: 'markdown' as const, text: '中段' },
      {
        type: 'image' as const,
        element: {
          tag: 'img', img_key: 'img_v2_formula_y',
          alt: { tag: 'plain_text', content: 'y' }, size: '42px 20px',
        },
      },
      { type: 'markdown' as const, text: '后文' },
    ],
    formulaCount: 2,
    renderedImageCount: 2,
  }

  test('raw and rendered states keep one column_set element on both backends', async () => {
    const session = new Session('math-order', 'chat_id') as any
    const renderSpy = spyOn(mathRender, 'renderMathInText').mockResolvedValue(renderedBlocks as any)
    const replaceSpy = spyOn(cardkit, 'replaceElementChecked').mockResolvedValue(true)

    try {
      for (const provider of ['codex', 'claude'] as const) {
        const turn = turnState(`card_math_${provider}`)
        turn.provider = provider
        const raw = session.completedAssistantElement('assistant_0', '前文 $$x$$ 后文')
        expect(raw.tag).toBe('column_set')
        expect(raw.element_id).toBe('assistant_0')

        await session.replaceSegmentWithMathImgs(
          turn, turn.cardId, 'assistant_0', '前文 $$x$$ 中段 $$y$$ 后文',
        )
        const replacement = replaceSpy.mock.calls.at(-1)?.[2] as any
        expect(replacement.tag).toBe('column_set')
        expect(replacement.element_id).toBe('assistant_0')
        expect(replacement.columns[0].elements.map((element: any) => element.tag)).toEqual([
          'markdown', 'img', 'markdown', 'img', 'markdown',
        ])
        expect(replaceSpy.mock.calls.at(-1)?.[3]).toEqual({ notifyCardFailure: false })
        expect(turn.mathRendered.get(turn.cardId).has('assistant_0')).toBe(true)
      }
    } finally {
      renderSpy.mockRestore()
      replaceSpy.mockRestore()
    }
  })

  test('keeps visible raw LaTeX when the atomic formula enhancement fails', async () => {
    const session = new Session('math-raw', 'chat_id') as any
    const turn = turnState('card_math_raw')
    turn.provider = 'claude'
    const renderSpy = spyOn(mathRender, 'renderMathInText').mockResolvedValue(renderedBlocks as any)
    const replaceSpy = spyOn(cardkit, 'replaceElementChecked').mockResolvedValue(false)

    try {
      await session.replaceSegmentWithMathImgs(
        turn, turn.cardId, 'assistant_0', '前文 $$x$$ 中段 $$y$$ 后文',
      )
      expect(replaceSpy).toHaveBeenCalledTimes(1)
      expect(turn.mathRendered?.get(turn.cardId)?.has('assistant_0')).not.toBe(true)
    } finally {
      renderSpy.mockRestore()
      replaceSpy.mockRestore()
    }
  })

  test('preserves the complete reply if the final formula container was never created', async () => {
    const session = new Session('math-close-fallback', 'chat_id') as any
    const turn = turnState('card_math_close_fallback')
    const rawReply = '前文\n\n$$x^2+y^2=z^2$$\n\n后文'
    turn.provider = 'claude'
    turn.userOpenId = ''
    turn.currentAssistantSegmentId = 'assistant_0'
    turn.currentAssistantText = rawReply
    turn.segmentTexts.set('assistant_0', rawReply)
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      const failedBodyAdd = method === 'POST' && path === `/cards/${turn.cardId}/elements`
      return new Response(JSON.stringify(failedBodyAdd
        ? { code: 300308, msg: 'card element rejected' }
        : { code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    await session.closeTurnCard(undefined, { hasFreshResult: false })

    expect(sentTexts).toHaveLength(1)
    expect(sentTexts[0]).toContain('对话卡片正文写入失败')
    expect(sentTexts[0]).toContain(rawReply)
    expect(sentRawTexts).toHaveLength(0)
  })
})

describe('Session compact command', () => {
  test('clears stale idle pending count before rejecting active turns', async () => {
    class FakeProc extends EventEmitter {
      sessionId = 'thread_stale_pending'
      turnId = 'turn_compact'
      compactCalls = 0

      isAlive(): boolean {
        return true
      }

      async compactThread(): Promise<void> {
        this.compactCalls++
        queueMicrotask(() => {
          this.emit('token_usage', {
            usage: { total_tokens: 5_361 },
            totalUsage: { total_tokens: 5_361 },
            contextWindow: 258_000,
            threadId: this.sessionId,
            turnId: this.turnId,
          })
          this.emit('context_compacted', {
            phase: 'end',
            threadId: this.sessionId,
            turnId: this.turnId,
          })
        })
      }
    }

    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeProc()
    session.proc = proc
    session.status = 'idle'
    session.initCount = 1
    session.pendingUserMessageCount = 1
    session.pendingReactionIds = new Map([['om_user_msg', 'reaction_one_second']])

    await expect(session.runCommand('cm')).resolves.toBe(true)

    expect(proc.compactCalls).toBe(1)
    expect(session.pendingUserMessageCount).toBe(0)
    expect(deletedReactions).toEqual([['om_user_msg', 'reaction_one_second']])
    expect(sentTexts.some(text => text.includes('先 `stop`'))).toBe(false)
    expect(sentRawTexts.some(text => text.includes('先 `stop`'))).toBe(false)
    const footerWrites = calls
      .filter(call => call.method === 'PUT' && call.path.endsWith('/elements/footer'))
      .map(call => JSON.parse(call.body.element).content as string)
    expect(footerWrites.some(content =>
      content.includes('✅ 上下文已压缩') && content.includes('🧠 2% (5.4K/258K)')
    )).toBe(true)
  })
})

describe('Session automatic context compaction events', () => {
  test('deduplicates repeated completion for the same compaction item', async () => {
    const session = new Session('compact-dedupe', 'chat_id') as any
    const turn = turnState('card_compact_dedupe')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    const start = {
      phase: 'start', threadId: 'thread_1', turnId: 'turn_1', itemId: 'compact_1',
    }
    const end = {
      phase: 'end', threadId: 'thread_1', turnId: 'turn_1', itemId: 'compact_1',
    }

    try {
      session.handleContextCompacted(start)
      session.handleContextCompacted(end)
      session.handleContextCompacted({ ...end, sourceMethod: 'rawResponseItem/completed' })
      // Same physical completion through a turn-only surface, then an
      // anonymous legacy surface, must both be coalesced even before the
      // first Card Kit write has landed.
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_1', turnId: 'turn_1',
      })
      session.handleContextCompacted({ phase: 'event' })
      await cardkit.flush(turn.cardId)
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_1'))

      expect(turn.contextCompactCount).toBe(1)
      expect(turn.contextCompactionPending.size).toBe(0)
      expect(turn.contextCompactionCompleted.has('compact_1')).toBe(true)
      const compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id === 'context_compact_0'
      )
      const compactReplaces = calls.filter(call =>
        call.method === 'PUT' &&
        call.path === `/cards/${turn.cardId}/elements/context_compact_0`
      )
      expect(compactAdds).toHaveLength(1)
      expect(compactReplaces).toHaveLength(1)
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('treats a completion delivered after card close as a logged lifecycle event', () => {
    const session = new Session('compact-after-close', 'chat_id') as any

    session.handleContextCompacted({
      phase: 'end', threadId: 'thread_closed', turnId: 'turn_closed', itemId: 'compact_closed',
    })

    expect(sentRawTexts).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('deduplicates generic-turn completion followed by an item completion', async () => {
    const session = new Session('compact-alias-order', 'chat_id') as any
    const turn = turnState('card_compact_alias_order')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_alias', turnId: 'turn_alias',
      })
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_alias', turnId: 'turn_alias', itemId: 'compact_alias',
      })
      await cardkit.flush(turn.cardId)
      await waitUntil(() => turn.contextCompactionCompleted.has('turn_alias'))

      expect(turn.contextCompactCount).toBe(1)
      let compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )
      expect(compactAdds).toHaveLength(1)
      // Once compact_alias claimed the generic turn receipt, a different
      // explicit item in the same turn must remain a new compaction.
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_alias', turnId: 'turn_alias', itemId: 'compact_alias_b',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_alias_b'))
      compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )
      expect(compactAdds).toHaveLength(2)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('deduplicates an anonymous completion followed by an identified alias', async () => {
    const session = new Session('compact-anonymous-alias', 'chat_id') as any
    const turn = turnState('card_compact_anonymous_alias')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted({ phase: 'event' })
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_anon', turnId: 'turn_anon', itemId: 'compact_anon',
      })
      await cardkit.flush(turn.cardId)
      await waitUntil(() => turn.lastContextCompactionWasAnonymous)

      expect(turn.contextCompactCount).toBe(1)
      const compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )
      expect(compactAdds).toHaveLength(1)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('a distinct explicit item in the same backend turn is not swallowed by the turn alias', async () => {
    const session = new Session('compact-distinct-items', 'chat_id') as any
    const turn = turnState('card_compact_distinct_items')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_shared', turnId: 'turn_shared', itemId: 'compact_item_a',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_item_a'))
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_shared', turnId: 'turn_shared', itemId: 'compact_item_b',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_item_b'))

      expect(turn.contextCompactCount).toBe(2)
      const compactAdds = calls.filter(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements` &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )
      expect(compactAdds).toHaveLength(2)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('an explicit unmatched item completion does not consume another pending item', async () => {
    const session = new Session('compact-item-owner', 'chat_id') as any
    const turn = turnState('card_compact_item_owner')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted({
        phase: 'start', threadId: 'thread_items', turnId: 'turn_items', itemId: 'compact_a',
      })
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_items', turnId: 'turn_items', itemId: 'compact_b',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_b'))

      expect(turn.contextCompactionPending.has('compact_a')).toBe(true)
      expect(turn.contextCompactCount).toBe(2)
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_items', turnId: 'turn_items', itemId: 'compact_a',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_a'))
      expect(turn.contextCompactionPending.size).toBe(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('does not attach an old turn compaction completion to a newer turn', async () => {
    const session = new Session('compact-owner', 'chat_id') as any
    const oldTurn = turnState('card_compact_owner_old')
    oldTurn.userOpenId = ''
    session.currentTurn = oldTurn
    cardkit.recordCardCreated(oldTurn.cardId, 1)
    session.handleContextCompacted({
      phase: 'start', threadId: 'thread_owner', turnId: 'turn_old', itemId: 'compact_owner',
    })
    await cardkit.flush(oldTurn.cardId)

    const newTurn = turnState('card_compact_owner_new')
    newTurn.userOpenId = ''
    session.currentTurn = newTurn
    cardkit.recordCardCreated(newTurn.cardId, 1)

    try {
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_owner', turnId: 'turn_old', itemId: 'compact_owner',
      })
      await cardkit.flush(newTurn.cardId)

      expect(newTurn.contextCompactCount).toBe(0)
      expect(newTurn.contextCompactionPending.size).toBe(0)
      expect(calls.some(call =>
        call.path === `/cards/${newTurn.cardId}/elements` &&
        call.method === 'POST' &&
        JSON.parse(call.body.elements)[0]?.element_id?.startsWith('context_compact_')
      )).toBe(false)
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      session.stopFooterStatus(oldTurn)
      session.stopFooterStatus(newTurn)
      await cardkit.dispose(oldTurn.cardId)
      await cardkit.dispose(newTurn.cardId)
    }
  })

  test('buffers compaction events while the conversation card is opening', async () => {
    const session = new Session('compact-open-window', 'chat_id') as any
    session.pendingTurnInputs = ['hello']
    const owner = session.beginTurnOpen(null, 0, true)
    let signalConvertStarted: () => void = () => {}
    const convertStarted = new Promise<void>(resolve => { signalConvertStarted = resolve })
    let releaseConvert: () => void = () => {}
    const convertGate = new Promise<void>(resolve => { releaseConvert = resolve })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        signalConvertStarted()
        await convertGate
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_compact_opened' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const opening = session.openTurnCard(owner, '', 'user_message')
    await convertStarted
    session.handleContextCompacted({
      phase: 'start', threadId: 'thread_open', turnId: 'turn_open', itemId: 'compact_open',
    })
    session.handleContextCompacted({
      phase: 'end', threadId: 'thread_open', turnId: 'turn_open', itemId: 'compact_open',
    })
    expect(owner.pendingCompactions).toHaveLength(2)

    let turn: any = null
    try {
      releaseConvert()
      turn = await opening
      expect(turn?.cardId).toBe('card_compact_opened')
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_open'))
      expect(turn.contextCompactCount).toBe(1)
      expect(sentRawTexts).toHaveLength(0)
    } finally {
      releaseConvert()
      session.releaseTurnOpen(owner)
      if (turn) {
        session.stopFooterStatus(turn)
        await cardkit.dispose(turn.cardId)
      }
    }
  })

  test('an eager pre-input card open does not claim a late prior-turn compaction', () => {
    const session = new Session('compact-eager-open', 'chat_id') as any
    const owner = session.beginTurnOpen(null, 0, false)

    session.handleContextCompacted({
      phase: 'end', threadId: 'thread_prior', turnId: 'turn_prior', itemId: 'compact_prior',
    })

    expect(owner.pendingCompactions).toHaveLength(0)
    expect(sentRawTexts).toHaveLength(0)
    session.releaseTurnOpen(owner)
  })

  test('manual compact completion never leaks into a newly opened turn', async () => {
    const session = new Session('compact-manual-owner', 'chat_id') as any
    const turn = turnState('card_compact_manual_owner')
    session.currentTurn = turn
    session.manualContextCompactionPending = true
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_manual', turnId: 'turn_manual', itemId: 'compact_manual',
      })
      session.manualContextCompactionPending = false
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_manual', turnId: 'turn_manual',
      })
      session.handleContextCompacted({ phase: 'event' })

      expect(turn.contextCompactCount).toBe(0)
      expect(turn.contextCompactionPending.size).toBe(0)
      expect(calls).toHaveLength(0)
    } finally {
      session.manualContextCompactionPending = false
      await cardkit.dispose(turn.cardId)
    }
  })

  test('an anonymous manual completion tombstones an immediate identified alias', async () => {
    const session = new Session('compact-manual-anonymous', 'chat_id') as any
    const turn = turnState('card_compact_manual_anonymous')
    session.currentTurn = turn
    session.manualContextCompactionPending = true
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.handleContextCompacted({ phase: 'event' })
      session.manualContextCompactionPending = false
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_manual_alias', turnId: 'turn_manual_alias', itemId: 'compact_manual_alias',
      })
      expect(turn.contextCompactCount).toBe(0)
      expect(calls).toHaveLength(0)
    } finally {
      session.manualContextCompactionPending = false
      await cardkit.dispose(turn.cardId)
    }
  })

  test('moves an in-progress compaction panel to the replacement card', async () => {
    const session = new Session('compact-rotate', 'chat_id') as any
    const turn = turnState('card_compact_old')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      const data = path === '/cards/id_convert' ? { card_id: 'card_compact_new' } : {}
      return new Response(JSON.stringify({ code: 0, data }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.handleContextCompacted({
        phase: 'start', threadId: 'thread_2', turnId: 'turn_2', itemId: 'compact_2',
      })
      await cardkit.flush(turn.cardId)
      session.startMidTurnRotate(turn)
      await turn.rotating

      expect(turn.cardId).toBe('card_compact_new')
      expect(turn.contextCompactionPending.get('compact_2')?.cardId).toBe('card_compact_new')
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_2', turnId: 'turn_2', itemId: 'compact_2',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_2'))
      await cardkit.flush(turn.cardId)

      expect(calls.some(call =>
        call.method === 'POST' &&
        call.path === '/cards/card_compact_new/elements' &&
        JSON.parse(call.body.elements)[0]?.element_id === 'context_compact_0'
      )).toBe(true)
      expect(calls.some(call =>
        call.method === 'PUT' &&
        call.path === '/cards/card_compact_new/elements/context_compact_0'
      )).toBe(true)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('commits completion receipts only after Card Kit lands and allows retry after MISS', async () => {
    const session = new Session('compact-write-retry', 'chat_id') as any
    const turn = turnState('card_compact_write_retry')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure(turn, turn.cardId, code, failure)
    })
    let rejectCompletion = true
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (
        rejectCompletion &&
        method === 'PUT' &&
        path === `/cards/${turn.cardId}/elements/context_compact_0`
      ) {
        return new Response(JSON.stringify({ code: 300308, msg: 'temporary replace reject' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    const start = {
      phase: 'start', threadId: 'thread_retry', turnId: 'turn_retry', itemId: 'compact_retry',
    }
    const end = {
      phase: 'end', threadId: 'thread_retry', turnId: 'turn_retry', itemId: 'compact_retry',
    }

    try {
      session.handleContextCompacted(start)
      session.handleContextCompacted(end)
      await waitUntil(() => !turn.contextCompactionCompleting.has('compact_retry'))
      expect(turn.contextCompactionPending.has('compact_retry')).toBe(true)
      expect(turn.contextCompactionCompleted.has('compact_retry')).toBe(false)

      rejectCompletion = false
      session.handleContextCompacted(end)
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_retry'))
      expect(turn.contextCompactionPending.size).toBe(0)
      const completionPuts = calls.filter(call =>
        call.method === 'PUT' &&
        call.path === `/cards/${turn.cardId}/elements/context_compact_0`
      )
      expect(completionPuts).toHaveLength(2)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('a capacity failure while completing automatically retries on the replacement card', async () => {
    const session = new Session('compact-capacity-rotate', 'chat_id') as any
    const turn = turnState('card_compact_capacity_old')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure(turn, turn.cardId, code, failure)
    })
    let rejectOldCompletion = true
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_compact_capacity_new' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (
        rejectOldCompletion &&
        method === 'PUT' &&
        path === '/cards/card_compact_capacity_old/elements/context_compact_0'
      ) {
        rejectOldCompletion = false
        return new Response(JSON.stringify({ code: 300305, msg: 'number of card components exceeds 200' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.handleContextCompacted({
        phase: 'start', threadId: 'thread_capacity', turnId: 'turn_capacity', itemId: 'compact_capacity',
      })
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_capacity', turnId: 'turn_capacity', itemId: 'compact_capacity',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_capacity'))

      expect(turn.cardId).toBe('card_compact_capacity_new')
      expect(turn.rotateCount).toBe(1)
      expect(turn.failureRotateCount).toBe(1)
      expect(calls.some(call =>
        call.method === 'PUT' &&
        call.path === '/cards/card_compact_capacity_new/elements/context_compact_0'
      )).toBe(true)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  for (const withStart of [false, true]) {
    test(`an oversized compaction completion stops retrying unchanged content without blocking later output (start=${withStart})`, async () => {
      const session = new Session('compact-oversized', 'chat_id') as any
      const turn = turnState('card_compact_oversized_0')
      turn.userOpenId = ''
      session.currentTurn = turn
      let replacementCount = 0
      cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
        session.onCardWriteFailure(turn, 'card_compact_oversized_0', code, failure)
      })
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ method: String(init?.method ?? 'GET'), path, body })
        const response = path === '/cards/id_convert'
          ? { code: 0, data: { card_id: `card_compact_oversized_${++replacementCount}` } }
          : String(body?.element ?? body?.elements).includes('✅ 🚨 上下文压缩')
            ? { code: 200860, msg: 'card over max size' }
            : { code: 0, data: {} }
        return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch
      const notice = { threadId: 'thread_oversized', turnId: 'turn_oversized', itemId: 'compact_oversized' }
      try {
        if (withStart) session.handleContextCompacted({ ...notice, phase: 'start' })
        session.handleContextCompacted({ ...notice, phase: 'end' })
        await waitUntil(() => !turn.contextCompactionCompleting.has('compact_oversized') && !turn.rotating)
        expect(replacementCount).toBe(1)
        expect(turn.contextCompactionCompleted.has('compact_oversized')).toBe(false)
        expect(turn.cardRotationFailed).toBe(false)
        expect(sentRawTexts).toHaveLength(1)
        expect(sentRawTexts[0]).toContain('换卡后仍超出飞书容量，写入失败')
        expect(await cardkit.addElementChecked(turn.cardId, {
          tag: 'markdown', element_id: 'later_output', content: '后续回复仍可写入',
        })).toBe(true)
      } finally {
        if (turn.rotating) await turn.rotating
        session.stopFooterStatus(turn)
        for (let i = 0; i <= replacementCount; i++) await cardkit.dispose(`card_compact_oversized_${i}`)
      }
    })
  }

  test('a duplicate start-panel add reconciles with a terminal replace', async () => {
    const session = new Session('compact-start-add-retry', 'chat_id') as any
    const turn = turnState('card_compact_start_add_retry')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure(turn, turn.cardId, code, failure)
    })
    let compactAddAttempt = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      const addedElement = method === 'POST' && path === `/cards/${turn.cardId}/elements`
        ? JSON.parse(calls.at(-1)?.body.elements ?? '[]')[0]
        : null
      if (addedElement?.element_id === 'context_compact_0' && ++compactAddAttempt === 1) {
        return new Response(JSON.stringify({ code: 300315, msg: 'Duplicate ID; code: 300301' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.handleContextCompacted({
        phase: 'start', threadId: 'thread_add_retry', turnId: 'turn_add_retry', itemId: 'compact_add_retry',
      })
      session.handleContextCompacted({
        phase: 'end', threadId: 'thread_add_retry', turnId: 'turn_add_retry', itemId: 'compact_add_retry',
      })
      await waitUntil(() => turn.contextCompactionCompleted.has('compact_add_retry'))

      expect(compactAddAttempt).toBe(1)
      expect(calls.some(call =>
        call.method === 'PUT' &&
        call.path.endsWith('/elements/context_compact_0')
      )).toBe(true)
      expect(turn.contextCompactionPending.size).toBe(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

describe('Session model settings completion', () => {
  let previousSources: ReturnType<typeof listTokenSources>
  beforeEach(() => { previousSources = listTokenSources() })
  afterEach(() => {
    resetTokenSourceRegistry()
    for (const source of previousSources) registerTokenSource(source)
  })

  function setup(provider: 'claude' | 'dsh' | 'codex' = 'claude') {
    const sourceId = `settings-${provider}`
    registerTokenSource({ id: sourceId, kind: 'test', agent: provider, display: sourceId, enabled: true,
      models: ['review-before', 'review-after'].map(model => ({ model, display: model,
        efforts: ['high', 'max'], defaultEffort: 'high' })),
      defaultModel: 'review-before', modelCatalogState: { status: 'ready', updatedAt: 1 },
      refreshModels: async () => {}, spawnEnv: env => env, resolveSpawnModel: model => model,
      readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    })
    const session = new Session(`settings-${provider}`, 'chat_id') as any
    const proc = new FakeAgentProc(provider, 'settings-session', sourceId)
    proc.lastModel = 'review-before'; proc.lastEffort = 'high'
    Object.assign(session, { proc, selectedProvider: provider, selectedTokenSourceId: sourceId,
      selectedModel: 'review-before', selectedEffort: 'high', initCount: 1 })
    session.modelPanels.set('settings', { models: ['review-before', 'review-after'].map(model => ({
      provider, sourceId, model, displayName: model, efforts: [{ effort: 'high' }, { effort: 'max' }],
    })) })
    return { session, proc, sourceId }
  }

  function deferUpdate(proc: FakeAgentProc) {
    let release!: () => void
    let reject!: (error: Error) => void
    const gate = new Promise<void>((resolve, fail) => { release = resolve; reject = fail })
    proc.setModelSettings = async (model, effort) => {
      proc.setModelSettingsCalls.push([model, effort])
      await gate
      proc.lastModel = model; proc.lastEffort = effort
    }
    const original = globalThis.setTimeout
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: any, ms: number, ...args: any[]) =>
      original(callback, ms === 20_000 ? 5 : ms, ...args)) as any)
    return { release, reject, restore: () => { timer.mockRestore(); release() } }
  }

  test.each(['claude', 'dsh'] as const)('busy %s keeps the late acknowledgement and prevents overlapping selections', async provider => {
    const { session, proc } = setup(provider)
    session.currentTurn = { ...turnState(), provider }
    const deferred = deferUpdate(proc)
    const save = spyOn(feishu, 'bindSessionModelChecked')
    const model = provider === 'claude' ? 'review-before' : 'review-after'
    try {
      const pending = await session.onModelEffortSelect(model, 'max', 'settings', '', provider)
      expect(pending.pending).toBe(true)
      expect(pending.message).toContain('尚不能判断')
      expect(JSON.stringify(pending.card)).not.toContain('选择已保存')
      expect(save).not.toHaveBeenCalled()
      expect(session.selectedEffort).toBe('high')
      expect((await session.onModelEffortSelect('review-before', 'high', 'settings', '', provider)).message).toContain('本次选择未执行')
      await session.onUserMessage('new input while settings are unknown')
      expect(proc.sentTexts).toEqual([])
      expect(sentTexts.join('\n')).toContain('本条消息未送给 Agent')
      deferred.release()
      expect((await pending.completion).ok).toBe(true)
      expect(session.selectedModel).toBe(model)
      expect(session.selectedEffort).toBe('max')
      expect(save).toHaveBeenCalledTimes(1)
      expect(session.modelSettingsChange).toBeNull()
      expect(proc.setModelSettingsCalls).toHaveLength(1)
    } finally { deferred.restore(); save.mockRestore(); session.dispose() }
  })

  test('soft stop interrupts the task without claiming an uncancellable model update was cancelled', async () => {
    const { session, proc } = setup('dsh')
    session.currentTurn = { ...turnState(), provider: 'dsh' }
    const interrupt = spyOn(proc, 'sendInterrupt')
    const deferred = deferUpdate(proc)
    try {
      const pending = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'dsh')
      expect(await session.runCommand('stop')).toBe(true)
      expect(interrupt).toHaveBeenCalledTimes(1)
      expect(proc.isAlive()).toBe(true)
      expect(session.modelSettingsChange.phase).toBe('pending')
      expect(session.selectedModel).toBe('review-before')
      deferred.release()
      expect((await pending.completion).ok).toBe(true)
      expect(session.selectedModel).toBe('review-after')
    } finally { deferred.restore(); interrupt.mockRestore(); session.dispose() }
  })

  test('process stop cancels the pending selection and ignores an old process acknowledgement', async () => {
    const { session, proc } = setup()
    const deferred = deferUpdate(proc)
    const save = spyOn(feishu, 'bindSessionModelChecked')
    try {
      const pending = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      expect(pending.pending).toBe(true)
      await session.stop('test stop', { announce: false })
      const replacement = new FakeAgentProc('claude', 'new-session', proc.tokenSourceId)
      session.proc = replacement
      deferred.release()
      const result = await pending.completion
      expect(result.ok).toBe(false)
      expect(result.message).toContain('原进程正在停止')
      expect(save).not.toHaveBeenCalled()
      expect(session.selectedModel).toBe('review-before')
      expect(session.proc).toBe(replacement)
    } finally { deferred.restore(); save.mockRestore(); session.dispose() }
  })

  test('shutdown settles an unanswered model update before draining card actions', async () => {
    const { session, proc } = setup()
    const deferred = deferUpdate(proc)
    try {
      const pending = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      session.closeModelSettingsChanges()
      expect((await pending.completion).message).toContain('daemon 正在停止')
      expect(session.selectedModel).toBe('review-before')
      expect((await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')).message).toContain('本次模型选择未执行')
      expect(proc.setModelSettingsCalls).toHaveLength(1)
    } finally { deferred.restore(); session.dispose() }
  })

  test('a late rejection remains visible and reselecting the saved model actually reapplies it', async () => {
    const { session, proc } = setup()
    const deferred = deferUpdate(proc)
    try {
      const pending = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      deferred.reject(new Error('backend control rejected'))
      const result = await pending.completion
      expect(result.ok).toBe(false)
      expect(result.message).toContain('backend control rejected')
      expect(session.currentModelLabel()).toBeNull()
      expect(session.currentEffortLabel()).toBeNull()
      await session.onUserMessage('must not reach an unconfirmed model')
      expect(proc.sentTexts).toEqual([])
      proc.setModelSettings = FakeAgentProc.prototype.setModelSettings.bind(proc)
      const retry = await session.onModelEffortSelect('review-before', 'high', 'settings', '', 'claude')
      expect(retry.ok).toBe(true)
      expect(retry.message).not.toContain('当前已是')
      expect(proc.setModelSettingsCalls.at(-1)).toEqual(['review-before', 'high'])
      expect(session.modelSettingsChange).toBeNull()
    } finally { deferred.restore(); session.dispose() }
  })

  test('partial Claude success shows the confirmed model and MISS effort until a successful retry', async () => {
    const { session, sourceId } = setup()
    const proc = new ClaudeAgentProcess({ workDir: session.workDir, tokenSourceId: sourceId,
      model: 'review-before', effort: 'high' }) as any
    session.proc = proc
    proc.started = true
    let actualModel = 'review-before'
    proc.query = { setModel: async (model: string) => { actualModel = model },
      applyFlagSettings: async () => { throw new Error('flag settings rejected') } }
    const save = spyOn(feishu, 'bindSessionModelChecked')
    try {
      const failed = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      expect(failed.ok).toBe(false)
      expect(failed.message).toContain('模型已切换为 review-after')
      expect(failed.message).toContain('思考档位未确认')
      expect(failed.message).toContain('flag settings rejected')
      expect(actualModel).toBe('review-after')
      expect(session.currentModelLabel()).toBe('review-after')
      expect(session.currentEffortLabel()).toBeNull()
      expect(session.runtimeModelSelection()).toEqual({ provider: 'claude', model: 'review-after', effort: null })
      expect(save).not.toHaveBeenCalled()
      expect(session.selectedModel).toBe('review-before')
      proc.query.applyFlagSettings = async () => {}
      const retry = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      expect(retry.ok).toBe(true)
      expect(session.currentEffortLabel()).toBe('max')
      expect(session.selectedModel).toBe('review-after')
      expect(save).toHaveBeenCalledTimes(1)
    } finally { save.mockRestore(); session.dispose() }
  })

  test('persistence failure after backend success preserves the confirmed runtime settings', async () => {
    const { session, proc } = setup()
    proc.setModelSettings = async (model, effort) => { proc.lastModel = model; proc.lastEffort = effort }
    const save = spyOn(feishu, 'bindSessionModelChecked').mockImplementation(() => { throw new Error('model fsync failed') })
    try {
      const result = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      expect(result.ok).toBe(false)
      expect(result.message).toContain('模型和思考档位已应用，但保存选择失败')
      expect(result.message).toContain('model fsync failed')
      expect(session.selectedModel).toBe('review-before')
      expect(session.runtimeModelSelection()).toEqual({ provider: 'claude', model: 'review-after', effort: 'max' })
      save.mockImplementation(() => {})
      expect((await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')).ok).toBe(true)
      expect(session.selectedModel).toBe('review-after')
      expect(session.modelSettingsChange).toBeNull()
    } finally { save.mockRestore(); session.dispose() }
  })

  test('source configuration changes during confirmation cannot silently stop a process or save a stale selection', async () => {
    const { session, proc, sourceId } = setup()
    const source = getTokenSource(sourceId)!
    source.spawnRevision = 'before'
    session.procSourceRevisions.set(proc, tokenSourceProcessRevision(source, 'review-before'))
    const deferred = deferUpdate(proc)
    const save = spyOn(feishu, 'bindSessionModelChecked')
    try {
      const pending = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'claude')
      source.spawnRevision = 'changed'
      deferred.release()
      const result = await pending.completion
      expect(result.ok).toBe(false)
      expect(result.message).toContain('进程账号配置已变化')
      expect(proc.killCalls).toBe(0)
      expect(save).not.toHaveBeenCalled()
      expect(session.selectedModel).toBe('review-before')
      expect(session.currentModelLabel()).toBe('review-after')
    } finally { deferred.restore(); save.mockRestore(); session.dispose() }
  })

  test('queued input waits for model confirmation and resumes once using the selected model', async () => {
    const { session, proc } = setup('dsh')
    const deferred = deferUpdate(proc)
    session.currentTurn = { ...turnState(), provider: 'dsh' }
    session.pendingMidTurnMsgs.push({ text: 'queued request', wireText: 'queued request', userOpenId: 'ou_user', msgId: '' })
    try {
      const pending = await session.onModelEffortSelect('review-after', 'max', 'settings', '', 'dsh')
      session.currentTurn = null
      await session.drainMidTurnAndOpen()
      expect(session.pendingMidTurnMsgs).toHaveLength(1)
      expect(proc.sentTexts).toEqual([])
      deferred.release()
      expect((await pending.completion).ok).toBe(true)
      await waitUntil(() => proc.sentTexts.length === 1)
      expect(proc.sentTexts[0]).toContain('queued request')
      expect(session.currentTurn.model).toBe('review-after')
      expect(session.pendingMidTurnMsgs).toEqual([])
    } finally {
      deferred.restore()
      if (session.currentTurn) await session.closeTurnCard()
      session.dispose()
    }
  })

  test('busy Codex selection accurately says restart is required', async () => {
    const { session } = setup('codex')
    session.currentTurn = turnState()
    try {
      const result = await session.onModelEffortSelect('review-after', 'high', 'settings', '', 'codex')
      expect(result.ok).toBe(true)
      expect(JSON.stringify(result.card)).toContain('需重启进程生效')
      expect(JSON.stringify(result.card)).not.toContain('后续新 turn 使用')
    } finally { session.dispose() }
  })

  test('Codex persistence failure cannot claim that the running model was already changed', async () => {
    const { session } = setup('codex')
    session.currentTurn = turnState()
    const save = spyOn(feishu, 'bindSessionModelChecked').mockImplementation(() => { throw new Error('model fsync failed') })
    try {
      const result = await session.onModelEffortSelect('review-after', 'high', 'settings', '', 'codex')
      expect(result).toMatchObject({ ok: false, message: '模型切换失败: model fsync failed' })
      expect(session.selectedModel).toBe('review-before')
      expect(session.runtimeModelSelection()).toEqual({ provider: 'codex', model: 'review-before', effort: 'high' })
      expect(session.modelSettingsChange).toBeNull()
    } finally { save.mockRestore(); session.dispose() }
  })
})

describe('Session provider switching', () => {
  beforeAll(() => {
    buildTokenSourcesFromConfig()
    // 切换用例从目录刷新成功后开始；只准备测试数据，不访问真实账号。
    const glm = getTokenSource('glm')!
    glm.enabled = true
    glm.models = [{ model: 'GLM-5.2', display: 'GLM-5.2', efforts: ['max'], defaultEffort: 'max' }]
    glm.defaultModel = 'GLM-5.2'
    glm.modelCatalogState = { status: 'ready', updatedAt: 1 }
    const deepseek = getTokenSource('deepseek')!
    deepseek.enabled = true
    deepseek.models = [{ model: 'deepseek-v4-pro', display: 'DeepSeek V4 Pro', efforts: ['high'], defaultEffort: 'high' }]
    deepseek.defaultModel = 'deepseek-v4-pro'
    deepseek.modelCatalogState = { status: 'ready', updatedAt: 1 }
  })
  afterAll(() => resetTokenSourceRegistry())

  test('uses provider-specific ask instructions', () => {
    const session = new Session('probe', 'chat_id') as any

    session.selectedProvider = 'codex'
    expect(session.spawnDeveloperInstructions()).toContain('request_user_input')

    session.selectedProvider = 'claude'
    const instructions = session.spawnDeveloperInstructions()
    expect(instructions).toContain('AskUserQuestion')
    expect(instructions).not.toContain('request_user_input')
  })

  test('keeps selected provider resume id from being overwritten by stale backend events', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.lastSessionId = 'claude-session-1'

    session.persistResumableSessionId()

    expect(boundResumes).toEqual([['probe', 'codex-thread-1', 'codex']])
    expect(session.lastSessionId).toBe('claude-session-1')
  })

  test('fresh Codex init clears the old binding but never persists its unmaterialized thread id', () => {
    const session = new Session('codex-fresh-init', 'chat_id') as any
    const oldRef = { provider: 'codex' as const, sessionId: 'old-thread', cwd: session.workDir }
    resumeRefs.set(`${session.sessionName}:codex`, oldRef)
    session.selectedProvider = 'codex'
    session.lastSessionRef = oldRef
    session.lastSessionId = oldRef.sessionId
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc

    session.wireProc(proc)
    proc.emit('init', { session_id: proc.sessionId })

    expect(boundResumes).toEqual([])
    expect(clearedResumes).toContainEqual([session.sessionName, 'codex'])
    expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)
    expect(session.lastSessionRef).toBeNull()
    expect(session.lastSessionId).toBeNull()
  })

  test('fresh Codex response-level turn_started stays unbound until materialization is confirmed', () => {
    const session = new Session('codex-materialized', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc
    session.wireProc(proc)

    proc.emit('init', { session_id: proc.sessionId })
    proc.emit('turn_started', { turn_id: 'turn-1', thread_id: proc.sessionId })
    expect(boundResumes).toEqual([])

    proc.conversationResumable = true
    proc.emit('conversation_materialized', {
      session_id: proc.sessionId,
      source: 'turn/started notification',
    })
    expect(boundResumes).toEqual([[session.sessionName, 'fresh-thread', 'codex']])
    expect(session.lastSessionId).toBe('fresh-thread')
  })

  test('failed Codex materialization verification is visible and never writes a resume point', () => {
    const session = new Session('codex-materialize-fails', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc
    session.wireProc(proc)
    proc.emit('init', { session_id: proc.sessionId })

    proc.emit('conversation_materialization_failed', {
      session_id: proc.sessionId,
      path: '/rollouts/rollout-fresh-thread.jsonl',
      source: 'turn/started notification',
      error: new Error('thread/read says not materialized'),
    })

    expect(boundResumes).toEqual([])
    expect(session.lastSessionId).toBeNull()
    expect(sentRawTexts.join('\n')).toContain('Codex 会话落盘确认失败，未写恢复点')
    expect(sentRawTexts.join('\n')).toContain('thread/read says not materialized')
  })

  test('a fast Codex result defers then commits its fork checkpoint after materialization', () => {
    const session = new Session('codex-fast-checkpoint', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc
    session.wireProc(proc)
    session.lastTurnUserPreview = 'fast input'
    const checkpoint = {
      provider: 'codex' as const,
      kind: 'turn' as const,
      id: 'turn-fast',
      source: { provider: 'codex' as const, sessionId: 'fresh-thread', cwd: session.workDir },
    }

    proc.emit('result', { is_error: false, checkpoint })
    expect(turnAnchorsBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingCodexTurnAnchors).toHaveLength(1)

    proc.conversationResumable = true
    proc.emit('conversation_materialized', {
      session_id: proc.sessionId,
      source: 'turn/started notification',
    })

    expect(session.pendingCodexTurnAnchors).toHaveLength(0)
    expect(turnAnchorsBySession.get(session.sessionName)).toEqual([{
      checkpoint,
      preview: 'fast input',
      ts: expect.any(Number),
      writes: [],
    }])
  })

  test('resumed Codex init can persist because the source rollout already exists', () => {
    const session = new Session('codex-resume-init', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'resumed-thread')
    proc.launchKind = 'resume'
    proc.conversationResumable = true
    session.proc = proc
    session.wireProc(proc)

    proc.emit('init', { session_id: proc.sessionId })

    expect(boundResumes).toEqual([[session.sessionName, 'resumed-thread', 'codex']])
  })

  test('fresh Codex init fails visibly when clearing the old resume binding cannot fsync', async () => {
    const session = new Session('codex-fresh-clear-fails', 'chat_id') as any
    const oldRef = { provider: 'codex' as const, sessionId: 'old-thread', cwd: session.workDir }
    resumeRefs.set(`${session.sessionName}:codex`, oldRef)
    session.selectedProvider = 'codex'
    session.lastSessionRef = oldRef
    session.lastSessionId = oldRef.sessionId
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    proc.sendInitialize = () => {
      proc.emit('init', { session_id: proc.sessionId })
    }
    session.spawnAgent = () => proc
    setResumeWriteError(new Error('resume-map clear fsync failed'))
    const statuses: string[] = []

    try {
      const ok = await session.start({
        announce: false,
        onStatus: (status: string) => statuses.push(status),
      })
      expect(ok).toBe(false)
      expect(proc.killCalls).toBe(1)
      expect(statuses.join('\n')).toContain('resume-map clear fsync failed')
      expect(resumeRefs.get(`${session.sessionName}:codex`)).toEqual(oldRef)
      expect(session.lastSessionId).toBe('old-thread')
    } finally {
      setResumeWriteError(null)
    }
  })

  test('persists selected Claude resume id from init before a turn boundary', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-init')
    session.proc = proc
    session.selectedProvider = 'claude'

    session.wireProc(proc)
    proc.emit('init', { session_id: 'claude-session-init' })

    expect(boundResumes).toEqual([['probe', 'claude-session-init', 'claude']])
    expect(session.lastSessionId).toBe('claude-session-init')
  })

  test('persists selected Claude resume id from result if turn_started was missed', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-result')
    session.proc = proc
    session.selectedProvider = 'claude'

    session.wireProc(proc)
    proc.emit('result', {})

    expect(boundResumes).toEqual([['probe', 'claude-session-result', 'claude']])
    expect(session.lastSessionId).toBe('claude-session-result')
  })

  test('footer follows the actual Claude process while the persisted target points to Codex', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    proc.lastModel = 'claude:GLM-5.2[1m]'
    proc.lastEffort = 'max'
    session.proc = proc
    session.selectedProvider = 'codex'
    session.selectedTokenSourceId = 'codex-sub'
    session.selectedModel = 'gpt-5.6-sol'
    session.selectedEffort = 'xhigh'

    const footer = session.withModel('Thinking(1s)')

    expect(footer).toContain('claude · GLM-5.2/max')
    expect(footer).not.toContain('gpt-5.6-sol')
  })

  test('footer keeps the turn snapshot after the persisted target changes', () => {
    const session = new Session('probe', 'chat_id') as any
    session.currentTurn = {
      ...turnState(),
      provider: 'claude',
      model: 'claude:GLM-5.2[1m]',
      effort: 'max',
    }
    session.selectedProvider = 'codex'
    session.selectedModel = 'gpt-5.6-sol'
    session.selectedEffort = 'xhigh'

    const footer = session.withModel('Writing(2s)')

    expect(footer).toContain('claude · GLM-5.2/max')
    expect(footer).not.toContain('gpt-5.6-sol')
  })

  test('consumes hyphenated DSH setup commands before they can reach the model', async () => {
    const session = new Session('probe', 'chat_id') as any
    expect(await session.runCommand('deepseek-harness-setup')).toBe(true)
    expect(await session.runCommand('DEEPSEEK-HARNESS-SETUP one two three')).toBe(true)
    expect(sentTexts.filter(text => text.includes('deepseek-harness-setup')).length).toBe(2)
  })

  test('OpenRouter setup is routed to the registered source without sending credentials to an Agent', async () => {
    const session = new Session('probe', 'chat_id') as any
    expect(await session.runCommand('openrouter-setup')).toBe(true)
    expect(sentTexts.some(text => text.includes('openrouter-setup <api_key>'))).toBe(true)
    expect(session.isRunning()).toBe(false)
  })

  test.each(['stopped', 'idle', 'working'])('disabled Claude subscription rejects new input while %s without stopping the process', async state => {
    const session = new Session('subscription-off', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'existing-conversation', 'claude-sub')
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'claude-sub'
    session.selectedModel = 'sonnet'
    session.selectedEffort = 'high'
    session.proc = state === 'stopped' ? null : proc
    session.currentTurn = state === 'working' ? turnState('running-subscription') : null
    session.status = state
    const turn = session.currentTurn
    session.tokenSource = () => ({ id: 'claude-sub', kind: 'claude-subscription', enabled: false,
      modelCatalogState: { status: 'disabled', error: 'Claude Code 订阅已禁用；发送 claude-sub on 启用' } })
    try {
      await session.onUserMessage('new task', [], 'ou_user', 'om_new')
      expect(sentTexts.at(-1)).toContain('claude-sub on')
      expect(sentTexts.at(-1)).toContain('消息未送给 Agent')
      expect(proc.sentTexts).toEqual([])
      expect(proc.killCalls).toBe(0)
      expect(session.currentTurn).toBe(turn)
      expect(session.pendingMidTurnMsgs).toEqual([])
      expect(session.status).toBe(state)
    } finally { session.currentTurn = null; session.dispose() }
  })

  test.each([false, true])('Claude subscription rechecks the switch after opening an input card (queued=%s)', async queued => {
    const session = new Session('subscription-race', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'existing-conversation', 'claude-sub')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'claude-sub'
    session.selectedModel = 'sonnet'
    session.selectedEffort = 'high'
    session.initCount = 1
    const source = { id: 'claude-sub', kind: 'claude-subscription', agent: 'claude', enabled: true,
      modelCatalogState: { status: 'ready', error: 'Claude Code 订阅已禁用；发送 claude-sub on 启用' } }
    session.tokenSource = () => source
    const statuses: string[] = []
    session.openTurnCard = async () => {
      source.enabled = false
      const turn = turnState('switch-during-card-open')
      session.currentTurn = turn
      session.pendingTurnInputs = []
      return turn
    }
    session.closeTurnCard = async (status: string) => { statuses.push(status); session.currentTurn = null }
    try {
      if (queued) {
        session.pendingMidTurnMsgs = [{ text: 'queued task', wireText: 'queued task', userOpenId: '', msgId: '' }]
        await session.drainMidTurnAndOpen()
      } else await session.onUserMessage('new task')
      expect(proc.sentTexts).toEqual([])
      expect(proc.killCalls).toBe(0)
      expect(statuses.join('\n')).toContain('消息未送给 Agent')
      expect(session.pendingUserMessageCount).toBe(0)
      expect(session.pendingMidTurnMsgs).toEqual([])
      expect(session.currentTurn).toBeNull()
      expect(session.status).toBe('idle')
      source.enabled = true
      expect(await session.sendClaimedUserText(proc, 'enabled again')).toBe(true)
      expect(proc.sentTexts).toHaveLength(1)
      expect(proc.sentTexts[0]).toContain('enabled again')
      expect(proc.killCalls).toBe(0)
    } finally { session.dispose() }
  })

  test('MD waits for the source refresh instead of sending a zero-model snapshot', async () => {
    const previous = listTokenSources()
    resetTokenSourceRegistry()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const models = Array.from({ length: 9 }, (_, i) => ({ model: `vendor/model-${i}`, display: `Model ${i}`, efforts: ['high' as const], defaultEffort: 'high' as const }))
    const source = { id: 'md-refresh', kind: 'test', agent: 'claude' as const, display: 'OpenRouter', enabled: true,
      models, defaultModel: models[0].model,
      modelCatalogState: { status: 'ready' as 'ready' | 'loading' | 'failed', updatedAt: 1, error: undefined as string | undefined },
      async refreshModels() { source.models = []; source.modelCatalogState.status = 'loading'; await pending; source.models = models; source.modelCatalogState.status = 'ready' },
      spawnEnv: (env: Record<string, string | undefined>) => env, resolveSpawnModel: (model: string) => model,
      readUsage: async () => ({ state: 'not_applicable' as const, windows: [] }),
    }
    registerTokenSource(source)
    const session = new Session('md-refresh-test', 'chat_id')
    try {
      const opening = session.showModelPanel()
      await Promise.resolve()
      expect(sentCards).toHaveLength(0)
      release()
      await opening
      expect(JSON.stringify(sentCards[0])).toContain('9 个模型')
      expect(JSON.stringify(sentCards[0])).not.toContain('0 个模型')
      const panelId = [...session.modelPanels.keys()][0]
      expect(session.modelPanels.get(panelId)?.messageId).toBe('om_status_1')
      await session.onProviderSelect(source.id, panelId)
      expect(session.modelPanels.get(panelId)?.messageId).toBe('om_status_1')
      source.refreshModels = async () => { source.models = []; source.modelCatalogState.status = 'failed'; source.modelCatalogState.error = 'HTTP 503' }
      await session.showModelPanel()
      expect(JSON.stringify(sentCards.at(-1))).toContain('模型目录 MISS')
      expect(JSON.stringify(sentCards.at(-1))).toContain('HTTP 503')
      expect(JSON.stringify(sentCards.at(-1))).not.toContain('0 个模型')
    } finally {
      release(); session.dispose(); resetTokenSourceRegistry()
      for (const entry of previous) registerTokenSource(entry)
    }
  })

  test('large model catalogs page through a snapshot and reject stale or cross-page choices', async () => {
    const previous = listTokenSources()
    const source = {
      id: 'openrouter', kind: 'openrouter', agent: 'claude' as const, display: 'OpenRouter', enabled: true,
      models: Array.from({ length: 45 }, (_, i) => ({ model: `vendor/model-${i}`, display: `Model ${i}`,
        efforts: ['high' as const], defaultEffort: 'high' as const })),
      defaultModel: '', modelCatalogState: { status: 'ready' as const, updatedAt: Date.now() },
      refreshModels: async () => {}, spawnEnv: (env: Record<string, string | undefined>) => env,
      resolveSpawnModel: (model: string) => model,
      readUsage: async () => ({ state: 'not_applicable' as const, windows: [] }),
    }
    registerTokenSource(source)
    try {
      const session = new Session('probe', 'chat_id') as any
      session.modelPanels.set('openrouter-page', { models: [] })
      const first = await session.onProviderSelect('openrouter', 'openrouter-page')
      expect(first.ok).toBe(true)
      expect(session.modelPanels.get('openrouter-page').models).toHaveLength(20)
      expect(JSON.stringify(first.card)).toContain('第 1 / 3 页')
      expect(JSON.stringify(first.card)).not.toContain('vendor/model-20')
      // 刷新后仍按本面板快照翻页，避免数组下标指到另一模型。
      source.models = []
      const last = await session.onModelPage('openrouter-page', 'openrouter', 2)
      expect(last.ok).toBe(true)
      expect(session.modelPanels.get('openrouter-page').models).toHaveLength(5)
      expect(JSON.stringify(last.card)).toContain('vendor/model-44')
      expect(JSON.stringify(last.card)).not.toContain('vendor/model-0')
      expect((await session.onModelSelect('vendor/model-0', 'openrouter-page', '', { provider: 'claude' })).ok).toBe(false)
      // 单档位会直接应用，因此也必须检查刷新后的真实目录，不能应用旧快照。
      expect((await session.onModelSelect('vendor/model-44', 'openrouter-page', '', { provider: 'claude' })).ok).toBe(false)
      expect((await session.onModelEffortSelect('vendor/model-44', 'high', 'openrouter-page', '', 'claude')).ok).toBe(false)
      for (const page of [-1, 3, 0.5, NaN]) expect((await session.onModelPage('openrouter-page', 'openrouter', page)).ok).toBe(false)
      expect((await session.onModelPage('openrouter-page', 'glm', 0)).ok).toBe(false)
      expect((await session.onModelPage('stale', 'openrouter', 0)).ok).toBe(false)
      expect((await session.onProviderSelect('openrouter', 'stale')).ok).toBe(false)
    } finally {
      resetTokenSourceRegistry()
      for (const item of previous) registerTokenSource(item)
    }
  })

  test('Claude source default efforts are authoritative and missing defaults are not replaced by max', () => {
    const previous = listTokenSources()
    registerTokenSource({ id: 'openrouter', kind: 'openrouter', agent: 'claude', display: 'OpenRouter', enabled: true,
      models: [{ model: 'vendor/known', display: 'Known', efforts: ['medium'], defaultEffort: 'medium' },
        { model: 'vendor/missing', display: 'Missing', efforts: ['high'], defaultEffort: null }],
      defaultModel: 'vendor/known', refreshModels: async () => {}, spawnEnv: env => env, resolveSpawnModel: model => model,
      readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    })
    try {
      const session = new Session('probe', 'chat_id') as any
      session.selectedProvider = 'claude'
      session.selectedTokenSourceId = 'openrouter'
      session.selectedModel = 'vendor/known'
      session.selectedEffort = null
      expect(session.claudeEffortForSpawn()).toBe('medium')
      expect(session.currentEffortLabel()).toBe('medium')
      session.selectedModel = 'vendor/missing'
      expect(session.currentEffortLabel()).toBeNull()
      expect(session.withModel('ready')).toContain('claude · vendor/missing/MISS')
      expect(() => session.claudeEffortForSpawn()).toThrow('MISS')
    } finally {
      resetTokenSourceRegistry()
      for (const item of previous) registerTokenSource(item)
    }
  })

  test('selecting a native-default model skips effort and replaces only the idle process while preserving its resume id', async () => {
    const previous = listTokenSources()
    const source = { id: 'openrouter-env', kind: 'openrouter', agent: 'claude' as const, display: 'OpenRouter', enabled: true,
      spawnRevision: 'account', modelEnvironmentRevision: (model: string) => model === 'vendor/default' ? 'unset' : 'level',
      models: [{ model: 'vendor/level', display: 'Level', efforts: ['high' as const], defaultEffort: 'high' as const },
        { model: 'vendor/default', display: 'Default', efforts: ['default' as const], defaultEffort: 'default' as const }],
      defaultModel: '', modelCatalogState: { status: 'ready' as const, updatedAt: 1 },
      refreshModels: async () => {}, spawnEnv: (env: Record<string, string | undefined>) => env,
      resolveSpawnModel: (model: string) => model, readUsage: async () => ({ state: 'not_applicable' as const, windows: [] }),
    }
    registerTokenSource(source)
    const session = new Session('openrouter-env-switch', 'chat_id') as any
    try {
      const proc = new FakeAgentProc('claude', 'preserved-session', source.id)
      session.proc = proc
      session.procSourceRevisions.set(proc, tokenSourceProcessRevision(source, 'vendor/level'))
      session.selectedProvider = 'claude'; session.selectedTokenSourceId = source.id
      session.selectedModel = 'vendor/level'; session.selectedEffort = 'high'
      session.modelPanels.set('mode-panel', { models: [{ provider: 'claude', sourceId: source.id, model: 'vendor/default',
        displayName: 'Default', efforts: [{ effort: 'default' }] }] })
      const result = await session.onModelSelect('vendor/default', 'mode-panel', '', { provider: 'claude' })
      expect(result.ok).toBe(true)
      expect(JSON.stringify(result.card)).not.toContain('选择 effort')
      expect(session.selectedModel).toBe('vendor/default')
      expect(session.selectedTokenSourceId).toBe(source.id)
      expect(session.modelPanels.has('mode-panel')).toBe(false)
      expect(proc.setModelSettingsCalls).toEqual([])
      expect(proc.killCalls).toBe(1)
      expect(session.selectedEffort).toBe('default')
      expect(boundResumes).toContainEqual([session.sessionName, 'preserved-session', 'claude'])
    } finally {
      session.dispose()
      resetTokenSourceRegistry()
      for (const entry of previous) registerTokenSource(entry)
    }
  })

  test('selecting a newly registered DSH GLM model loads its new configuration and retains native history', async () => {
    const previous = listTokenSources()
    let catalogRevision = 'before-registration'
    const source = { id: 'dsh-glm-new-model', kind: 'dsh-glm', agent: 'dsh' as const, display: 'GLM Coding Plan', enabled: true,
      spawnRevision: 'account', modelEnvironmentRevision: () => catalogRevision,
      models: ['glm-5.3', 'glm-manual'].map(model => ({ model, display: model, efforts: ['high' as const], defaultEffort: 'high' as const })),
      defaultModel: 'glm-5.3', modelCatalogState: { status: 'ready' as const, updatedAt: 1 },
      refreshModels: async () => {}, spawnEnv: (env: Record<string, string | undefined>) => env,
      resolveSpawnModel: (model: string) => model, readUsage: async () => ({ state: 'not_applicable' as const, windows: [] }),
    }
    registerTokenSource(source)
    const session = new Session('dsh-glm-new-model', 'chat_id') as any
    try {
      const proc = new FakeAgentProc('dsh', 'preserved-dsh-session', source.id)
      session.proc = proc
      session.procSourceRevisions.set(proc, tokenSourceProcessRevision(source, 'glm-5.3'))
      session.selectedProvider = 'dsh'; session.selectedTokenSourceId = source.id
      session.selectedModel = 'glm-5.3'; session.selectedEffort = 'high'
      catalogRevision = 'after-registration'
      session.modelPanels.set('custom-model-panel', { models: [{ provider: 'dsh', sourceId: source.id, model: 'glm-manual',
        displayName: 'Manual', efforts: [{ effort: 'high' }] }] })
      const result = await session.onModelEffortSelect('glm-manual', 'high', 'custom-model-panel', '', 'dsh')
      expect(result.ok).toBe(true)
      expect(proc.setModelSettingsCalls).toEqual([])
      expect(proc.killCalls).toBe(1)
      expect(session.selectedModel).toBe('glm-manual')
      expect(boundResumes).toContainEqual([session.sessionName, 'preserved-dsh-session', 'dsh'])
    } finally {
      session.dispose()
      resetTokenSourceRegistry()
      for (const entry of previous) registerTokenSource(entry)
    }
  })

  test('the same Packy model can change default effort mode only by replacing its idle process', async () => {
    const previous = listTokenSources()
    const source = { id: 'packy-effort-test', kind: 'packy', agent: 'claude' as const, display: 'Packy', enabled: true,
      models: [{ model: 'mimo-v2.5-pro', display: 'MiMo', efforts: ['default' as const, 'high' as const], defaultEffort: 'default' as const }],
      defaultModel: 'mimo-v2.5-pro', modelCatalogState: { status: 'ready' as const, updatedAt: 1 },
      refreshModels: async () => {}, spawnEnv: (env: Record<string, string | undefined>) => env,
      resolveSpawnModel: (model: string) => model, readUsage: async () => ({ state: 'not_applicable' as const, windows: [] }),
    }
    registerTokenSource(source)
    const session = new Session('packy-effort-mode', 'chat_id') as any
    try {
      const proc = new FakeAgentProc('claude', 'packy-effort-session', source.id)
      session.proc = proc
      session.selectedProvider = 'claude'; session.selectedTokenSourceId = source.id
      session.selectedModel = 'mimo-v2.5-pro'; session.selectedEffort = 'default'
      proc.lastEffort = 'default'
      session.modelPanels.set('packy-effort-panel', { models: [{ provider: 'claude', sourceId: source.id,
        model: 'mimo-v2.5-pro', displayName: 'MiMo', efforts: [{ effort: 'default' }, { effort: 'high' }] }] })
      const result = await session.onModelEffortSelect('mimo-v2.5-pro', 'high', 'packy-effort-panel', '', 'claude')
      expect(result.ok).toBe(true)
      expect(proc.setModelSettingsCalls).toEqual([])
      expect(proc.killCalls).toBe(1)
      expect(session.selectedEffort).toBe('high')
      expect(boundResumes).toContainEqual([session.sessionName, 'packy-effort-session', 'claude'])
    } finally {
      session.dispose()
      resetTokenSourceRegistry()
      for (const entry of previous) registerTokenSource(entry)
    }
  })

  test('DSH model panel accepts off effort and updates the same native process', async () => {
    const previous = listTokenSources()
    registerTokenSource({ id: 'deepseek-harness', kind: 'deepseek-harness', agent: 'dsh', display: 'DeepSeek Harness', enabled: true,
      models: [{ model: 'deepseek-v4-flash', display: 'Flash', efforts: ['off', 'high'], defaultEffort: 'high' }],
      defaultModel: 'deepseek-v4-flash', modelCatalogState: { status: 'ready', updatedAt: Date.now() },
      refreshModels: async () => {}, spawnEnv: env => env, resolveSpawnModel: model => model,
      readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    })
    try {
      const session = new Session('probe', 'chat_id') as any
      const proc = new FakeAgentProc('dsh', 'dsh-session', 'deepseek-harness')
      session.proc = proc
      session.selectedProvider = 'dsh'
      session.selectedTokenSourceId = 'deepseek-harness'
      session.selectedModel = 'deepseek-v4-flash'
      session.selectedEffort = 'high'
      session.modelPanels.set('panel-dsh', { models: [{ provider: 'dsh', sourceId: 'deepseek-harness', model: 'deepseek-v4-flash',
        displayName: 'Flash', efforts: [{ effort: 'off', isDefault: false }, { effort: 'high', isDefault: true }] }] })
      const result = await session.onModelEffortSelect('deepseek-v4-flash', 'off', 'panel-dsh', 'ou_user', 'dsh')
      expect(result.ok).toBe(true)
      expect(proc.setModelSettingsCalls).toEqual([['deepseek-v4-flash', 'off']])
      expect(proc.killCalls).toBe(0)
      expect(session.selectedProvider).toBe('dsh')
      expect(session.selectedEffort).toBe('off')
      expect(JSON.stringify(result.card)).toContain('DeepSeek Harness')
    } finally {
      resetTokenSourceRegistry()
      for (const source of previous) registerTokenSource(source)
    }
  })

  test('DSH cannot replace a busy Claude process', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session', 'glm')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'glm'
    session.currentTurn = { ...turnState(), provider: 'claude' }
    session.modelPanels.set('panel-dsh', { models: [{ provider: 'dsh', sourceId: 'deepseek-harness', model: 'deepseek-v4-flash',
      displayName: 'Flash', efforts: [{ effort: 'off', isDefault: true }] }] })
    const result = await session.onModelEffortSelect('deepseek-v4-flash', 'off', 'panel-dsh', 'ou_user', 'dsh')
    expect(result.ok).toBe(false)
    expect(proc.killCalls).toBe(0)
    expect(session.selectedProvider).toBe('claude')
  })

  test('rejects cross-provider model switch while a turn is active', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('codex', 'codex-thread-1')
    session.selectedProvider = 'codex'
    session.currentTurn = turnState()
    session.modelPanels.set('panel-glm', { models: [{
      provider: 'claude', sourceId: 'glm', model: 'GLM-5.2', displayName: 'GLM-5.2',
      efforts: [{ effort: 'max', isDefault: true }],
    }] })

    const result = await session.onModelEffortSelect('GLM-5.2', 'max', 'panel-glm', 'ou_user', 'claude')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('正在执行或排队')
    expect(boundResumes).toEqual([])
    expect(session.selectedProvider).toBe('codex')
  })

  test('keeps idle Claude process, hot-swaps model via setModelSettings (no respawn)', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1', 'glm')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-4.7'
    session.selectedEffort = 'max'
    session.modelPanels.set('panel-glm', { models: [{
      provider: 'claude', sourceId: 'glm', model: 'GLM-5.2', displayName: 'GLM-5.2',
      efforts: [{ effort: 'max', isDefault: true }],
    }] })

    const result = await session.onModelEffortSelect('GLM-5.2', 'max', 'panel-glm', 'ou_user', 'claude')

    expect(result.ok).toBe(true)
    expect(session.selectedModel).toBe('GLM-5.2')
    expect(session.selectedTokenSourceId).toBe('glm')
    // 不重启 agent(保持之前体验):热切换 setModelSettings,不 kill、proc 还在
    expect(proc.killCalls).toBe(0)
    expect(session.proc).toBe(proc)
    expect(proc.setModelSettingsCalls).toEqual([['GLM-5.2[1m]', 'max']])  // 未观测默认 [1m](客户端记账 1M)
    expect(result.card ? JSON.stringify(result.card) : '').toContain('下一轮')
  })

  test('GLM→DeepSeek (same provider, different token source) respawns to swap base_url/env', async () => {
    // 跨 token source 切换(GLM↔DeepSeek↔native,同 provider='claude')env(base_url/凭据)不同,
    // 必须杀进程重启换 env —— setModelSettings 只改 model 不重注入 env,留着旧进程会拿
    // deepseek 模型名打到 GLM 端点(base URL 错)。故 onModelEffortSelect 跳过热切换,
    // applyModelSelection→stopIdleMismatchedProcess 据 proc.tokenSourceId 判 mismatch 并杀。
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1', 'glm')   // 进程是 GLM spawn 的
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'
    session.selectedEffort = 'max'
    session.modelPanels.set('panel-ds', { models: [{
      provider: 'claude', sourceId: 'deepseek', model: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro',
      efforts: [{ effort: 'high', isDefault: true }],
    }] })

    const result = await session.onModelEffortSelect('deepseek-v4-pro', 'high', 'panel-ds', 'ou_user', 'claude')

    expect(result.ok).toBe(true)
    expect(session.selectedTokenSourceId).toBe('deepseek')
    // 跨 source → 不热切换(避免给将死的进程做无意义 RPC),直接杀进程重启换 env:
    expect(proc.setModelSettingsCalls).toEqual([])
    expect(proc.killCalls).toBe(1)
    expect(session.proc).not.toBe(proc)   // 旧进程已杀;下轮 start 用 deepseek 的 base_url 重 spawn
  })

  test('model switching waits through Claude SDK cleanup before committing the new selection', async () => {
    const session = new Session('model-sdk-cleanup', 'chat_id') as any
    const previous = { provider: 'claude' as const, tokenSourceId: 'glm', model: 'GLM-5.2', effort: 'max' }
    Object.assign(session, { selectedProvider: previous.provider, selectedTokenSourceId: previous.tokenSourceId,
      selectedModel: previous.model, selectedEffort: previous.effort })
    const proc = new ClaudeAgentProcess({ workDir: session.workDir, effort: 'max', tokenSourceId: 'glm' }) as any
    proc.sessionId = 'claude-before-switch'
    proc.started = true
    let signalClose!: () => void
    const closing = new Promise<void>(resolve => { signalClose = resolve })
    proc.query = {
      close: signalClose,
      async *[Symbol.asyncIterator]() {
        await closing
        // SDK cleanup can spend about 2 s waiting for stdin EOF to finish.
        await new Promise(resolve => setTimeout(resolve, 1200))
      },
    }
    const readLoop = proc.readLoop(proc.query)
    session.proc = proc
    session.wireProc(proc)
    session.modelPanels.set('switch', { models: [{ provider: 'claude', sourceId: 'deepseek',
      model: 'deepseek-v4-pro', displayName: 'DeepSeek', efforts: [{ effort: 'high' }] }] })
    const save = spyOn(feishu, 'bindSessionModelChecked')
    try {
      const switching = session.onModelEffortSelect('deepseek-v4-pro', 'high', 'switch', '', 'claude')
      await closing
      const duringClose = session.conversationRouting()
      const writesDuringClose = save.mock.calls.length
      const result = await switching

      expect(duringClose).toMatchObject(previous)
      expect(writesDuringClose).toBe(0)
      expect(result.ok).toBe(true)
      expect(proc.isAlive()).toBe(false)
      expect(session.proc).toBeNull()
      expect(save).toHaveBeenCalledWith(session.sessionName, 'claude', 'deepseek-v4-pro', 'high', 'deepseek')
      expect(resumeRefs.get(`${session.sessionName}:claude`)?.sessionId).toBe('claude-before-switch')
    } finally {
      await readLoop
      save.mockRestore()
      session.dispose()
    }
  })

  test.each([
    { provider: 'codex' as const, sourceId: 'codex-sub', model: 'gpt-6-astra', effort: 'max' as const },
    { provider: 'claude' as const, sourceId: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' as const },
  ])('failed switch to $sourceId keeps the old selection and retries without duplicate error messages', async target => {
    const source = getTokenSource(target.sourceId)!
    const sourceBefore = { enabled: source.enabled, models: source.models, modelCatalogState: source.modelCatalogState }
    source.enabled = true
    source.models = [{ model: target.model, display: target.model, efforts: [target.effort], defaultEffort: target.effort }]
    source.modelCatalogState = { status: 'ready', updatedAt: 1 }
    const session = new Session(`model-failed-${target.sourceId}`, 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-before-switch', 'glm')
    session.proc = proc
    session.selectedProvider = 'claude'; session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'; session.selectedEffort = 'max'
    session.modelPanels.set('switch', { models: [{ ...target, displayName: target.model,
      efforts: [{ effort: target.effort }] }] })
    const save = spyOn(feishu, 'bindSessionModelChecked')
    let attempts = 0
    proc.kill = async () => { attempts++; throw new Error('SDK close timeout') }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await session.onModelEffortSelect(target.model, target.effort, 'switch', '', target.provider)
        expect(result).toMatchObject({ ok: false, message: '模型切换失败: SDK close timeout' })
        expect(session.conversationRouting()).toMatchObject({ provider: 'claude', tokenSourceId: 'glm',
          model: 'GLM-5.2', effort: 'max' })
        expect(session.proc).toBe(proc)
        expect(session.blockedProc).toBe(proc)
        expect(session.modelPanels.has('switch')).toBe(true)
      }
      expect(attempts).toBe(2)
      expect(save).not.toHaveBeenCalled()
      expect(sentTexts).toEqual([]) // The card-action dispatcher owns the visible failure receipt.

      proc.kill = FakeAgentProc.prototype.kill.bind(proc)
      const retry = await session.onModelEffortSelect(target.model, target.effort, 'switch', '', target.provider)
      expect(retry.ok).toBe(true)
      expect(session.proc).toBeNull()
      expect(save).toHaveBeenCalledTimes(1)
    } finally {
      Object.assign(source, sourceBefore)
      save.mockRestore()
      session.dispose()
    }
  })

  test('reselecting a previously saved target still stops the mismatched process', async () => {
    const session = new Session('model-stale-selection', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-before-switch', 'glm')
    session.proc = proc
    session.selectedProvider = 'claude'; session.selectedTokenSourceId = 'deepseek'
    session.selectedModel = 'deepseek-v4-pro'; session.selectedEffort = 'high'
    session.modelPanels.set('switch', { models: [{ provider: 'claude', sourceId: 'deepseek',
      model: 'deepseek-v4-pro', displayName: 'DeepSeek', efforts: [{ effort: 'high' }] }] })
    try {
      const result = await session.onModelEffortSelect('deepseek-v4-pro', 'high', 'switch', '', 'claude')
      expect(result.ok).toBe(true)
      expect(result.message).not.toContain('当前已是')
      expect(proc.killCalls).toBe(1)
      expect(proc.setModelSettingsCalls).toEqual([])
      expect(session.proc).toBeNull()
    } finally { session.dispose() }
  })

  test('reselecting the old model after an unconfirmed stop cannot report an unchanged healthy process', async () => {
    const session = new Session('model-blocked-selection', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-stopping', 'glm')
    session.proc = proc
    session.blockedProc = proc
    session.blockedProcReason = 'SDK close timeout'
    session.selectedProvider = 'claude'; session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'; session.selectedEffort = 'max'
    session.modelPanels.set('switch', { models: [{ provider: 'claude', sourceId: 'glm',
      model: 'GLM-5.2', displayName: 'GLM', efforts: [{ effort: 'max' }] }] })
    proc.kill = async () => { throw new Error('SDK close timeout') }
    try {
      const result = await session.onModelEffortSelect('GLM-5.2', 'max', 'switch', '', 'claude')
      expect(result).toMatchObject({ ok: false, message: '模型切换失败: SDK close timeout' })
      expect(proc.setModelSettingsCalls).toEqual([])
    } finally { session.dispose() }
  })

  test('model selection write failure remains visible and does not change in-memory routing', async () => {
    const session = new Session('model-write-failure', 'chat_id') as any
    session.selectedProvider = 'claude'; session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'; session.selectedEffort = 'max'
    session.modelPanels.set('switch', { models: [{ provider: 'claude', sourceId: 'deepseek',
      model: 'deepseek-v4-pro', displayName: 'DeepSeek', efforts: [{ effort: 'high' }] }] })
    const save = spyOn(feishu, 'bindSessionModelChecked').mockImplementation(() => { throw new Error('model map fsync failed') })
    try {
      const result = await session.onModelEffortSelect('deepseek-v4-pro', 'high', 'switch', '', 'claude')
      expect(result).toMatchObject({ ok: false, message: '模型切换失败: model map fsync failed' })
      expect(session.conversationRouting()).toMatchObject({ provider: 'claude', tokenSourceId: 'glm',
        model: 'GLM-5.2', effort: 'max' })
      expect(session.modelPanels.has('switch')).toBe(true)
    } finally {
      save.mockRestore()
      session.dispose()
    }
  })

  test.each([false, true])('provider switch preserves pending conversation state on write failure (restore failure: %s)', async restoreFails => {
    const session = new Session('model-pending-write-failure', 'chat_id') as any
    session.selectedProvider = 'claude'; session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'; session.selectedEffort = 'max'
    const pending = { launch: { kind: 'fork' as const, source: {
      provider: 'claude' as const, sessionId: 'fork-source', cwd: session.workDir,
    } }, previousSessionId: 'previous-session' }
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    branchBaseBySession.set(session.sessionName, { kind: 'fresh' })
    const save = spyOn(feishu, 'bindSessionModelChecked').mockImplementation(() => {
      if (restoreFails) setTurnAnchorWriteError(new Error('turn state restore failed'))
      throw new Error('model map fsync failed')
    })
    try {
      const switching = session.applyModelSelection('codex', 'gpt-6-astra', 'max', 'codex-sub')
      await expect(switching).rejects.toThrow(restoreFails
        ? 'model selection write failed: model map fsync failed; conversation state restore failed: turn state restore failed'
        : 'model map fsync failed')
      expect(session.selectedProvider).toBe('claude')
      expect(session.pendingConversationMaterialization).toBe(pending)
      if (!restoreFails) {
        expect(pendingConversationLaunchBySession.get(session.sessionName)).toEqual(pending)
        expect(branchBaseBySession.get(session.sessionName)).toEqual({ kind: 'fresh' })
      }
    } finally {
      setTurnAnchorWriteError(null)
      save.mockRestore()
      session.dispose()
    }
  })

  test('a confirmed process exit does not hide an SDK close error or commit the target model', async () => {
    const session = new Session('model-close-error', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-before-switch', 'glm')
    session.proc = proc
    session.selectedProvider = 'claude'; session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'; session.selectedEffort = 'max'
    proc.kill = async () => { proc.alive = false; throw new Error('SDK close failed') }
    try {
      await expect(session.applyModelSelection('claude', 'deepseek-v4-pro', 'high', 'deepseek'))
        .rejects.toThrow('SDK close failed')
      expect(session.proc).toBeNull()
      expect(session.selectedTokenSourceId).toBe('glm')
      expect(session.selectedModel).toBe('GLM-5.2')
    } finally { session.dispose() }
  })

  test('reselecting the active GLM model and max effort is idempotent', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1', 'glm')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'
    session.selectedEffort = 'max'
    session.modelPanels.set('panel-glm', { models: [{
      provider: 'claude', sourceId: 'glm', model: 'GLM-5.2', displayName: 'GLM-5.2',
      efforts: [{ effort: 'max', isDefault: true, selected: true }],
    }] })

    const result = await session.onModelEffortSelect('GLM-5.2', 'max', 'panel-glm', 'ou_user', 'claude')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('当前已是')
    expect(proc.setModelSettingsCalls).toEqual([])
    expect(proc.killCalls).toBe(0)
    expect(session.proc).toBe(proc)
  })

  test('selecting a model opens the third-level effort card without applying settings', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.2'
    session.selectedEffort = 'max'
    session.modelPanels.set('panel-glm', { models: [{
      provider: 'claude', sourceId: 'glm', model: 'GLM-5.2', displayName: 'GLM-5.2',
      efforts: [{ effort: 'high' }, { effort: 'max', isDefault: true }],
    }] })

    const result = await session.onModelSelect('GLM-5.2', 'panel-glm', 'ou_user', { provider: 'claude' })

    expect(result.ok).toBe(true)
    expect(result.card ? JSON.stringify(result.card) : '').toContain('选择 effort')
    expect(session.selectedModel).toBe('GLM-5.2')
    expect(session.selectedEffort).toBe('max')
  })

  test('one real effort applies directly, while an empty effort catalog cannot change the selection', async () => {
    const session = new Session('single-effort', 'chat_id') as any
    try {
      session.selectedProvider = 'codex'; session.selectedTokenSourceId = 'codex-sub'
      session.selectedModel = 'gpt-6-astra'; session.selectedEffort = 'max'
      session.modelPanels.set('single', { models: [{ provider: 'claude', sourceId: 'glm', model: 'GLM-5.2',
        displayName: 'GLM-5.2', efforts: [{ effort: 'max' }] }] })
      const selected = await session.onModelSelect('GLM-5.2', 'single', '', { provider: 'claude' })
      expect(selected.ok).toBe(true)
      expect(session.selectedEffort).toBe('max')
      expect(JSON.stringify(selected.card)).not.toContain('选择 effort')
      session.modelPanels.set('empty', { models: [{ provider: 'claude', sourceId: 'glm', model: 'GLM-unknown',
        displayName: 'GLM-unknown', efforts: [] }] })
      const missing = await session.onModelSelect('GLM-unknown', 'empty', '', { provider: 'claude' })
      expect(missing).toMatchObject({ ok: false, message: '模型未返回 effort' })
      expect(session.selectedModel).toBe('GLM-5.2')
      expect(session.selectedEffort).toBe('max')
    } finally { session.dispose() }
  })

  test('preserves a persisted GLM-5.2 slug instead of rewriting it to a legacy profile key', () => {
    modelSelections.set('persisted-glm', {
      provider: 'claude', model: 'GLM-5.2', effort: 'max', tokenSourceId: 'glm',
    })

    const session = new Session('persisted-glm', 'chat_id') as any

    expect(session.selectedProvider).toBe('claude')
    expect(session.selectedTokenSourceId).toBe('glm')
    expect(session.selectedModel).toBe('GLM-5.2')
    expect(session.selectedEffort).toBe('max')
  })

  test('keeps an explicit unavailable source and fails closed instead of switching accounts', () => {
    modelSelections.set('missing-source', {
      provider: 'claude', model: 'model-x', effort: 'high', tokenSourceId: 'removed-account',
    })
    const session = new Session('missing-source', 'chat_id') as any

    expect(session.selectedTokenSourceId).toBe('removed-account')
    expect(() => session.spawnAgent()).toThrow('token source "removed-account" 不可用')
  })

  test('replaces an idle process when the same source id gets new spawn credentials', async () => {
    const source = getTokenSource('glm')!
    const prevEnabled = source.enabled
    const prevRevision = source.spawnRevision
    source.enabled = true
    source.spawnRevision = 'new-credentials'
    try {
      const session = new Session('probe', 'chat_id') as any
      const proc = new FakeAgentProc('claude', 'claude-session-1', 'glm')
      session.proc = proc
      session.selectedProvider = 'claude'
      session.selectedTokenSourceId = 'glm'
      session.procSourceRevisions.set(proc, 'old-credentials')

      await session.stopIdleMismatchedProcess()

      expect(proc.killCalls).toBe(1)
      expect(session.proc).toBeNull()
    } finally {
      source.enabled = prevEnabled
      source.spawnRevision = prevRevision
    }
  })

  test('idle provider switch settles Codex materialization and deferred checkpoint before kill', async () => {
    const session = new Session('idle-switch-materialize', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.selectedProvider = 'codex'
    session.proc = proc
    session.wireProc(proc)
    const checkpoint = {
      provider: 'codex' as const,
      kind: 'turn' as const,
      id: 'turn-fast',
      source: { provider: 'codex' as const, sessionId: 'fresh-thread', cwd: session.workDir },
    }
    proc.emit('result', { is_error: false, checkpoint })
    expect(session.pendingCodexTurnAnchors).toHaveLength(1)
    let releaseVerification: () => void = () => {}
    proc.materializationBarrier = new Promise<void>(resolve => { releaseVerification = resolve })
    session.selectedProvider = 'claude'

    const stopping = session.stopIdleMismatchedProcess()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(proc.killCalls).toBe(0)
    proc.conversationResumable = true
    releaseVerification()
    await stopping

    expect(proc.killCalls).toBe(1)
    expect(session.pendingCodexTurnAnchors).toHaveLength(0)
    expect(resumeRefs.get(`${session.sessionName}:codex`)?.sessionId).toBe('fresh-thread')
    expect(turnAnchorsBySession.get(session.sessionName)?.[0]?.checkpoint).toEqual(checkpoint)
  })

  test('rejects non-fixed Claude model outside the two fixed choices', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedModel = 'claude:default'

    const result = await session.onModelEffortSelect('claude:deepseek', 'high', '', 'ou_user', 'claude')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('不在选项中')
    expect(session.selectedModel).toBe('claude:default')
    expect(proc.killCalls).toBe(0)
  })

  test('catches synchronous Claude init failure before reporting ready', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', null)
    const statuses: string[] = []
    session.selectedProvider = 'claude'
    session.spawnAgent = () => proc
    proc.sendInitialize = () => {
      proc.emit('error', new Error('Claude auth failed'))
    }

    const ok = await session.start({
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(statuses).toContain('❌ Claude 启动失败: Claude auth failed')
    expect(proc.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.status).toBe('stopped')
  })

  test('does not require Claude stream init before reporting ready', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', null)
    const statuses: string[] = []
    let initializeCalls = 0
    session.selectedProvider = 'claude'
    session.spawnAgent = () => proc
    proc.sendInitialize = () => {
      initializeCalls++
    }

    const ok = await session.start({
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(true)
    expect(initializeCalls).toBe(1)
    expect(statuses.some(s => s.includes('✅ Claude 已就绪'))).toBe(true)
    expect(proc.killCalls).toBe(0)
    expect(session.proc).toBe(proc)
    expect(session.status).toBe('idle')
  })

  test('sends cold-start Claude user text before stream init exists', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', null)
    session.selectedProvider = 'claude'
    session.spawnAgent = () => proc

    try {
      await session.startColdUserTurn('hello', 'hello', 'ou_user')

      expect(proc.sentTexts).toEqual([`${fileDeliveryAgentContext('chat')}\n\nhello`])
      expect(session.currentTurn).not.toBeNull()
      expect(session.status).toBe('working')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      if (session.currentTurn) await cardkit.dispose(session.currentTurn.cardId)
    }
  })

})

describe('Session waits for its model catalog', () => {
  for (const resume of [false, true]) {
    test(`${resume ? 'resume' : 'fresh start'} waits for models and keeps the selected model and effort`, async () => {
      const previousSources = listTokenSources()
      resetTokenSourceRegistry()
      let releaseModels!: () => void
      const modelsGate = new Promise<void>(resolve => { releaseModels = resolve })
      const source: import('./token-source').TokenSource = {
        id: 'catalog-test', kind: 'test', agent: 'codex', display: 'Test Codex', enabled: true,
        models: [], defaultModel: '', modelCatalogState: { status: 'idle', updatedAt: null },
        async refreshModels() {
          source.modelCatalogState = { status: 'loading', updatedAt: null }
          await modelsGate
          source.models = [{ model: 'gpt-6-astra', display: 'Astra', efforts: ['max', 'ultra'], defaultEffort: 'max' }]
          source.defaultModel = 'gpt-6-astra'
          source.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
        },
        spawnEnv: env => env,
        resolveSpawnModel: model => model,
        readUsage: async () => ({ state: 'not_applicable', windows: [] }),
      }
      registerTokenSource(source)
      const refresh = refreshAllTokenSourceModels()
      const name = resume ? 'catalog-resume' : 'catalog-start'
      modelSelections.set(name, { provider: 'codex', model: 'gpt-6-astra', effort: 'ultra', tokenSourceId: source.id })
      const savedRef = { provider: 'codex' as const, sessionId: 'original-session', cwd: `/tmp/lodestar-projects/${name}` }
      if (resume) resumeRefs.set(`${name}:codex`, savedRef)
      const session = new Session(name, 'chat_id') as any
      const proc = new FakeAgentProc('codex', resume ? savedRef.sessionId : 'new-session', source.id)
      let spawns = 0
      session.spawnAgent = (ref?: typeof savedRef) => {
        spawns++
        expect(source.modelCatalogState?.status).toBe('ready')
        expect(session.selectedModel).toBe('gpt-6-astra')
        expect(session.selectedEffort).toBe('ultra')
        expect(ref).toEqual(resume ? savedRef : undefined)
        return proc
      }
      const opts = { announce: false, onStatus: () => {} }
      const starting = resume ? session.restart(true, opts) : session.start(opts)
      try {
        await waitUntil(() => session.status === 'starting')
        expect(spawns).toBe(0)
        expect(session.proc).toBeNull()
        releaseModels()
        expect(await starting).toBe(true)
        expect(spawns).toBe(1)
        expect(session.proc).toBe(proc)
        if (resume) expect(session.lastSessionId).toBe(savedRef.sessionId)
      } finally {
        releaseModels()
        await refresh
        await starting
        await session.stop('test cleanup', { announce: false })
        resetTokenSourceRegistry()
        for (const item of previousSources) registerTokenSource(item)
      }
    })
  }
})

describe('Session turn close vs mid-turn rotation race', () => {
  const renderedFormula = {
    blocks: [
      { type: 'markdown' as const, text: '前文' },
      {
        type: 'image' as const,
        tex: 'x^2',
        index: 0,
        element: {
          tag: 'img', img_key: 'img_rotation_formula',
          alt: { tag: 'plain_text', content: 'x^2' },
          scale_type: 'crop_center', size: '48px 24px', preview: false,
        },
      },
      { type: 'markdown' as const, text: '后文' },
    ],
    formulaCount: 1,
    renderedImageCount: 1,
  }

  test('closeTurnCard awaits in-flight rotation so the swap-restarted footer interval is cleared (no orphan timer)', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-session-1')
    const turn = turnState('card_old')
    turn.userOpenId = '' // 跳过 closeTurnCard 末尾 urgentApp(feishu mock 无此方法)
    session.currentTurn = turn
    cardkit.recordCardCreated('card_old', 1)

    // 复现竞态:result 在 startMidTurnRotate 的 sendCard/id_convert await 窗口
    // 里抢先到达 → closeTurnCard 先跑;swap 随后才落定,切 turn.cardId 到新卡
    // 并 startWritingFooter 重启一个 footer 计时 interval。修复前这个 interval
    // 再没有路径会 stop(closeTurnCard 只跑一次;stop/kill/exit 的
    // stopFooterStatus(this.currentTurn) 拿到 null),新卡 footer 一直计时
    // (2026-06-26 turn=1 计时不止)。
    let swapRan = false
    let releaseSwap: () => void = () => {}
    turn.rotating = new Promise<void>(r => { releaseSwap = r }).then(() => {
      // swap 同步块(真实代码 startMidTurnRotate 1927/1932/1949)
      cardkit.recordCardCreated('card_new', 2)
      turn.cardId = 'card_new'
      session.startWritingFooter(turn)
      swapRan = true
    })

    try {
      const closed = session.closeTurnCard(undefined, { hasFreshResult: false })
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      releaseSwap() // rotation 的 swap 现在落定
      await closed

      expect(swapRan).toBe(true)
      // swap 重启的 interval 必须被清掉,否则新卡 footer 一直计时
      expect(turn.footerStatusHandle).toBeNull()
      // 终态 footer 写到 swap 切换后的新卡,不是旧卡
      const newCardFooter = calls.filter(c => c.method === 'PUT' && c.path === '/cards/card_new/elements/footer')
      expect(newCardFooter.length).toBeGreaterThan(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('drains a pending old-card raw write before deciding which failed formula segment to migrate', async () => {
    const session = new Session('rotate-raw-failure', 'chat_id') as any
    const turn = turnState('card_rotate_raw_old')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    let signalOldPostStarted: () => void = () => {}
    const oldPostStarted = new Promise<void>(resolve => { signalOldPostStarted = resolve })
    let releaseOldPost: () => void = () => {}
    const oldPostGate = new Promise<void>(resolve => { releaseOldPost = resolve })
    const renderSpy = spyOn(mathRender, 'renderMathInText').mockResolvedValue(renderedFormula as any)
    let rotation: Promise<void> | null = null

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_rotate_raw_new' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'POST' && path === '/cards/card_rotate_raw_old/elements') {
        signalOldPostStarted()
        await oldPostGate
        return new Response(JSON.stringify({ code: 300308, msg: 'old raw rejected' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.appendAssistant('前文 $$x^2$$ 后文')
      session.finalizeCurrentAssistantSegment()
      await oldPostStarted

      session.startMidTurnRotate(turn)
      rotation = turn.rotating
      expect(rotation).not.toBeNull()
      releaseOldPost()
      await rotation

      const newInflight = turn.mathRenderInflight?.get('card_rotate_raw_new')
      if (newInflight?.size) await Promise.allSettled([...newInflight])
      await cardkit.flush('card_rotate_raw_new')

      const migratedAdd = calls.find(call =>
        call.method === 'POST' && call.path === '/cards/card_rotate_raw_new/elements',
      )
      expect(migratedAdd).toBeDefined()
      const migrated = JSON.parse(migratedAdd!.body.elements)[0]
      expect(migrated.tag).toBe('column_set')
      expect(JSON.stringify(migrated)).toContain('前文')
      expect(JSON.stringify(migrated)).toContain('x^2')
      expect(JSON.stringify(migrated)).toContain('后文')
      expect(turn.cardId).toBe('card_rotate_raw_new')
      expect(cardkit.isDeadElement('card_rotate_raw_new', 'assistant_0')).toBe(false)
    } finally {
      releaseOldPost()
      if (rotation) await rotation.catch(() => {})
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
      renderSpy.mockRestore()
    }
  })

  test('rechecks completed tools after the old-card add queue settles', async () => {
    const session = new Session('rotate-late-tool-add', 'chat_id') as any
    const turn = turnState('card_tool_old')
    turn.userOpenId = ''
    turn.toolByUseId.set('tool_use_1', {
      i: 0,
      name: 'Read',
      input: { file_path: '/tmp/a.txt' },
      output: 'done',
      isError: false,
    })
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure(turn, 'card_tool_old', code, failure)
    })

    let signalOldAddStarted: () => void = () => {}
    const oldAddStarted = new Promise<void>(resolve => { signalOldAddStarted = resolve })
    let releaseOldAdd: () => void = () => {}
    const oldAddGate = new Promise<void>(resolve => { releaseOldAdd = resolve })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_tool_new' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'POST' && path === '/cards/card_tool_old/elements') {
        signalOldAddStarted()
        await oldAddGate
        return new Response(JSON.stringify({ code: 300305, msg: 'component count exceeds limit' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const oldAdd = cardkit.addElement(turn.cardId, {
      tag: 'collapsible_panel',
      element_id: 'tool_0',
      header: { title: { tag: 'plain_text', content: 'done' } },
      elements: [{ tag: 'markdown', content: 'done' }],
    })
    await oldAddStarted
    let rotation: Promise<void> | null = null
    try {
      session.startMidTurnRotate(turn)
      rotation = turn.rotating
      await waitUntil(() => turn.cardId === 'card_tool_new')
      expect(turn.toolByUseId.has('tool_use_1')).toBe(false)

      releaseOldAdd()
      await oldAdd
      await rotation
      await cardkit.flush('card_tool_new')

      expect(turn.toolByUseId.has('tool_use_1')).toBe(true)
      expect(calls.some(call =>
        call.method === 'POST' &&
        call.path === '/cards/card_tool_new/elements' &&
        JSON.parse(call.body.elements)[0]?.element_id === 'tool_0'
      )).toBe(true)
      expect(turn.rotateCount).toBe(1)
      expect(turn.failureRotateCount).toBe(0)
    } finally {
      releaseOldAdd()
      if (rotation) await rotation.catch(() => {})
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('the second tool rebuild pass is idempotent for unfinished regular and batch tools', async () => {
    for (const kind of ['regular', 'batch'] as const) {
      calls = []
      resetFeishuMock()
      const session = new Session(`rotate-idempotent-${kind}`, 'chat_id') as any
      const turn = turnState(`card_${kind}_old`)
      turn.userOpenId = ''
      const useId = `tool_${kind}_use`
      const input = { file_path: `/tmp/${kind}.txt` }
      turn.toolByUseId.set(useId, {
        i: 0,
        name: 'Read',
        input,
        ...(kind === 'batch' ? { batchSlot: 0 } : {}),
      })
      if (kind === 'batch') {
        turn.toolBatches.set(0, {
          kind: 'read',
          items: [{ toolUseId: useId, input, output: null, isError: false }],
        })
      }
      session.currentTurn = turn
      cardkit.recordCardCreated(turn.cardId, 1)
      const newCardId = `card_${kind}_new`
      globalThis.fetch = (async (inputArg: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(inputArg))
        const path = url.pathname.replace('/open-apis/cardkit/v1', '')
        const method = String(init?.method ?? 'GET')
        calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
        const data = path === '/cards/id_convert' ? { card_id: newCardId } : {}
        return new Response(JSON.stringify({ code: 0, data }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        session.startMidTurnRotate(turn)
        await turn.rotating
        await cardkit.flush(newCardId)

        const newToolAdds = calls.filter(call =>
          call.method === 'POST' &&
          call.path === `/cards/${newCardId}/elements` &&
          JSON.parse(call.body.elements)[0]?.element_id?.startsWith('tool_')
        )
        expect(newToolAdds).toHaveLength(1)
        expect(turn.toolByUseId.size).toBe(1)
        expect(turn.toolCount).toBe(1)
      } finally {
        session.stopFooterStatus(turn)
        await cardkit.dispose(turn.cardId)
      }
    }
  })

  test('waits for formula rendering registered by a successful pending raw write before closing the old card', async () => {
    const session = new Session('rotate-slow-formula', 'chat_id') as any
    const turn = turnState('card_rotate_formula_old')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    let signalOldPostStarted: () => void = () => {}
    const oldPostStarted = new Promise<void>(resolve => { signalOldPostStarted = resolve })
    let releaseOldPost: () => void = () => {}
    const oldPostGate = new Promise<void>(resolve => { releaseOldPost = resolve })
    let signalRenderStarted: () => void = () => {}
    const renderStarted = new Promise<void>(resolve => { signalRenderStarted = resolve })
    let releaseRender: () => void = () => {}
    const renderGate = new Promise<typeof renderedFormula>(resolve => {
      releaseRender = () => resolve(renderedFormula)
    })
    const renderSpy = spyOn(mathRender, 'renderMathInText').mockImplementation(async () => {
      signalRenderStarted()
      return renderGate as any
    })
    let rotation: Promise<void> | null = null

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_rotate_formula_new' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'POST' && path === '/cards/card_rotate_formula_old/elements') {
        signalOldPostStarted()
        await oldPostGate
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.appendAssistant('前文 $$x^2$$ 后文')
      session.finalizeCurrentAssistantSegment()
      await oldPostStarted

      session.startMidTurnRotate(turn)
      rotation = turn.rotating
      expect(rotation).not.toBeNull()
      let rotationDone = false
      void rotation!.then(() => { rotationDone = true })
      releaseOldPost()
      await renderStarted
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(rotationDone).toBe(false)
      expect(cardkit.isDisposed('card_rotate_formula_old')).toBe(false)

      releaseRender()
      await rotation

      const formulaPutIndex = calls.findIndex(call =>
        call.method === 'PUT' && call.path === '/cards/card_rotate_formula_old/elements/assistant_0',
      )
      const closePatchIndex = calls.findIndex(call =>
        call.method === 'PATCH' && call.path === '/cards/card_rotate_formula_old/settings',
      )
      expect(formulaPutIndex).toBeGreaterThanOrEqual(0)
      expect(closePatchIndex).toBeGreaterThan(formulaPutIndex)
      expect(cardkit.isDisposed('card_rotate_formula_old')).toBe(true)
      expect(turn.cardId).toBe('card_rotate_formula_new')
    } finally {
      releaseOldPost()
      releaseRender()
      if (rotation) await rotation.catch(() => {})
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
      renderSpy.mockRestore()
    }
  })

  test('does not replay a deterministic migration failure onto a third card', async () => {
    const session = new Session('rotate-deferred-retry', 'chat_id') as any
    const turn = turnState('card_deferred_old')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure(turn, 'card_deferred_old', code, failure)
    })

    let signalFirstConvert: () => void = () => {}
    const firstConvertStarted = new Promise<void>(resolve => { signalFirstConvert = resolve })
    let convertCount = 0
    const renderSpy = spyOn(mathRender, 'renderMathInText').mockResolvedValue(renderedFormula as any)

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        convertCount++
        if (convertCount === 1) {
          signalFirstConvert()
          return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_deferred_second' } }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
        throw new Error('a deterministic payload failure must not open a third card')
      }
      if (method === 'POST' && path === '/cards/card_deferred_old/elements') {
        return new Response(JSON.stringify({
          code: 300305,
          msg: 'The number of card components exceeds 200',
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (method === 'POST' && path === '/cards/card_deferred_second/elements') {
        return new Response(JSON.stringify({
          code: 300315,
          msg: 'Duplicate ID; inner code: 300301',
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    let firstRotation: Promise<void> | null = null
    try {
      session.appendAssistant('前文 $$x^2$$ 后文')
      session.finalizeCurrentAssistantSegment()
      await firstConvertStarted
      firstRotation = turn.rotating
      expect(firstRotation).not.toBeNull()
      await firstRotation

      expect(convertCount).toBe(1)
      expect(turn.rotateCount).toBe(1)
      expect(turn.failureRotateCount).toBe(1)
      expect(turn.cardId).toBe('card_deferred_second')
      expect(turn.rotating).toBeNull()
      expect(sentRawTexts).toHaveLength(1)
      expect(sentRawTexts[0]).toContain('未识别为卡片容量超限')
      expect(sentTexts).toEqual([])
    } finally {
      if (firstRotation) await firstRotation.catch(() => {})
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
      renderSpy.mockRestore()
    }
  })

  test('does not start a deferred retry when close captures the turn during migration failure', async () => {
    const session = new Session('rotate-deferred-close', 'chat_id') as any
    const turn = turnState('card_deferred_close_old')
    const rawReply = '前文 $$x^2$$ 后文'
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure(turn, 'card_deferred_close_old', code, failure)
    })

    let signalMigrationPost: () => void = () => {}
    const migrationPostStarted = new Promise<void>(resolve => { signalMigrationPost = resolve })
    let releaseMigrationPost: () => void = () => {}
    const migrationPostGate = new Promise<void>(resolve => { releaseMigrationPost = resolve })
    let convertCount = 0
    const renderSpy = spyOn(mathRender, 'renderMathInText').mockResolvedValue(renderedFormula as any)

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === '/cards/id_convert') {
        convertCount++
        return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_deferred_close_new' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'POST' && path === '/cards/card_deferred_close_old/elements') {
        return new Response(JSON.stringify({ code: 300305, msg: 'component count exceeds limit' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'POST' && path === '/cards/card_deferred_close_new/elements') {
        signalMigrationPost()
        await migrationPostGate
        return new Response(JSON.stringify({ code: 300315, msg: 'Duplicate ID; inner code: 300301' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    let close: Promise<void> | null = null
    try {
      session.appendAssistant(rawReply)
      session.finalizeCurrentAssistantSegment()
      await migrationPostStarted
      expect(turn.rotating).not.toBeNull()
      expect(turn.cardId).toBe('card_deferred_close_new')

      close = session.closeTurnCard(undefined, { hasFreshResult: false })
      expect(session.currentTurn).toBeNull()
      releaseMigrationPost()
      await close

      expect(convertCount).toBe(1)
      expect(turn.rotateCount).toBe(1)
      expect(turn.failureRotateCount).toBe(1)
      expect(turn.rotating).toBeNull()
      expect(session.currentTurn).toBeNull()
      expect(renderSpy).not.toHaveBeenCalled()
      expect(sentTexts).toHaveLength(1)
      expect(sentTexts[0]).toContain(rawReply)
    } finally {
      releaseMigrationPost()
      if (close) await close.catch(() => {})
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
      renderSpy.mockRestore()
    }
  })
})

describe('Session card size capacity', () => {
  for (const provider of ['codex', 'claude'] as const) {
    test(`${provider} preserves live deltas and whitespace while earlier paragraphs migrate`, async () => {
      const session = new Session('rotate-live-buffer', 'chat_id') as any
      const turn = turnState('card_live_buffer_old')
      turn.provider = provider
      turn.userOpenId = ''
      session.proc = new FakeAgentProc(provider, 'buffer-session')
      session.currentTurn = turn
      let migrationStarted!: () => void
      let releaseMigration!: () => void
      const started = new Promise<void>(resolve => { migrationStarted = resolve })
      const gate = new Promise<void>(resolve => { releaseMigration = resolve })
      cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
        session.onCardWriteFailure(turn, 'card_live_buffer_old', code, failure)
      })
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
        const method = String(init?.method ?? 'GET')
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ method, path, body })
        if (method === 'POST' && path === '/cards/card_live_buffer_new/elements'
          && String(body.elements).includes('earlier paragraph')) {
          migrationStarted()
          await gate
        }
        const response = method === 'POST' && path === '/cards/card_live_buffer_old/elements'
          ? { code: 200860, msg: 'card over max size' }
          : { code: 0, data: path === '/cards/id_convert' ? { card_id: 'card_live_buffer_new' } : {} }
        return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch
      try {
        session.appendAssistant('earlier paragraph')
        session.finalizeCurrentAssistantSegment()
        session.appendAssistant('hello ')
        await started
        session.appendAssistant('world')
        session.finalizeCurrentAssistantSegment()
        releaseMigration()
        await turn.rotating
        await session.closeTurnCard(undefined, { hasFreshResult: false })
        const paragraphs = calls.filter(call => call.method === 'POST' && call.path === '/cards/card_live_buffer_new/elements')
          .map(call => JSON.parse(call.body.elements)[0].content)
        expect(paragraphs).toEqual(['earlier paragraph', 'hello world'])
        expect(sentTexts).toEqual([])
      } finally {
        releaseMigration()
        if (turn.rotating) await turn.rotating
        session.stopFooterStatus(turn)
        await cardkit.dispose('card_live_buffer_old')
        await cardkit.dispose(turn.cardId)
      }
    })
  }

  for (const provider of ['codex', 'claude'] as const) {
    for (const operation of ['addElement', 'replaceElement', 'footer'] as const) {
      test(`${provider} preserves tool output when ${operation} exceeds card size below the element count limit`, async () => {
        const session = new Session('card-size', 'chat_id') as any
        const oldCardId = `card_size_${provider}_${operation}_old`
        const newCardId = `card_size_${provider}_${operation}_new`
        const turn = turnState(oldCardId)
        turn.provider = provider
        turn.userOpenId = ''
        turn.toolByUseId.set('tool_use_size', {
          i: 0, name: 'Bash', input: { command: '# desc: 查看结果\nprintf result' },
          ...(operation !== 'footer' ? { output: 'retained tool result', isError: false } : {}),
        })
        session.proc = new FakeAgentProc(provider, 'native-session')
        session.currentTurn = turn
        let rotation: Promise<void> | null = null
        cardkit.recordCardCreated(oldCardId, 2, (code, failure) => {
          session.onCardWriteFailure(turn, oldCardId, code, failure)
          rotation = turn.rotating
        })
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
          const method = String(init?.method ?? 'GET')
          calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
          const rejected = operation === 'addElement'
            ? method === 'POST' && path === `/cards/${oldCardId}/elements`
            : method === 'PUT' && path === `/cards/${oldCardId}/elements/${operation === 'footer' ? 'footer' : 'tool_0'}`
          return new Response(JSON.stringify(rejected
            ? { code: 200860, msg: 'ErrMsg: card over max size;' }
            : { code: 0, data: path === '/cards/id_convert' ? { card_id: newCardId } : {} }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }) as typeof fetch

        try {
          const landed = operation === 'addElement'
            ? await cardkit.addElementChecked(oldCardId, {
                tag: 'markdown', element_id: 'tool_0', content: 'retained tool result',
              }, { type: 'insert_before', targetElementId: 'footer' })
            : await cardkit.replaceElementChecked(oldCardId, operation === 'footer' ? 'footer' : 'tool_0', {
                tag: 'markdown', element_id: operation === 'footer' ? 'footer' : 'tool_0', content: 'retained tool result',
              })
          expect(landed).toBe(false)
          expect(rotation).not.toBeNull()
          await rotation
          if (operation === 'footer') sessionTools.completeTool(session, 'tool_use_size', 'retained tool result', false)
          await cardkit.flush(newCardId)

          expect(turn.cardId).toBe(newCardId)
          expect(turn.rotateCount).toBe(1)
          expect(turn.failureRotateCount).toBe(1)
          expect(turn.cardRotationFailed).toBe(false)
          expect(sentCards).toHaveLength(1)
          const migrated = calls.filter(call => call.path.startsWith(`/cards/${newCardId}/elements`))
          expect(JSON.stringify(migrated)).toContain('retained tool result')
          expect(turn.toolByUseId.has('tool_use_size')).toBe(true)
          expect(sentRawTexts.join('\n')).not.toContain('未识别为卡片容量超限')
          expect(calls.filter(call => call.method === 'POST' && call.path === `/cards/${newCardId}/elements`)).toHaveLength(1)
        } finally {
          if (rotation) await rotation
          session.stopFooterStatus(turn)
          await cardkit.dispose(oldCardId)
          await cardkit.dispose(newCardId)
        }
      })
    }
  }

  test('an unchanged oversized tool reports its failure while later output stays writable', async () => {
    const session = new Session('card-size-persistent', 'chat_id') as any
    const turn = turnState('card_size_persistent_0')
    turn.userOpenId = ''
    session.currentTurn = turn
    let replacementCount = 0
    cardkit.recordCardCreated(turn.cardId, 2, (code, failure) => {
      session.onCardWriteFailure(turn, 'card_size_persistent_0', code, failure)
    })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      const response = path === '/cards/id_convert'
        ? { code: 0, data: { card_id: `card_size_persistent_${++replacementCount}` } }
        : method === 'POST' && path.endsWith('/elements') && String(init?.body).includes('超大工具结果')
          ? { code: 200860, msg: 'ErrMsg: card over max size;' }
          : { code: 0, data: {} }
      return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      sessionTools.addTool(session, 'oversized-tool', 'Bash', { command: '# desc: 超大工具结果\nprintf result' })
      await cardkit.flush('card_size_persistent_0')
      await waitUntil(() => replacementCount > 0 && !turn.rotating)
      expect(replacementCount).toBe(1)
      expect(turn.cardRotationFailed).toBe(false)
      expect(turn.failureRotateCount).toBe(1)
      expect(turn.footerStatusHandle).not.toBeNull()
      expect(sentRawTexts).toHaveLength(1)
      expect(sentRawTexts[0]).toContain('换卡后仍超出飞书容量，写入失败')
      expect(sentRawTexts[0]).toContain('其余输出继续处理')
      expect(await cardkit.addElementChecked(turn.cardId, {
        tag: 'markdown', element_id: 'after_failure', content: '后续正文',
      })).toBe(true)
      sessionTools.addTool(session, 'later-tool', 'Bash', { command: '# desc: 后续工具\nprintf ok' })
      await cardkit.flush(turn.cardId)
      sessionTools.completeTool(session, 'later-tool', '后续工具结果', false)
      await cardkit.flush(turn.cardId)
      expect(JSON.stringify(calls.filter(call => call.path.startsWith(`/cards/${turn.cardId}/elements`))))
        .toContain('后续工具结果')
      expect(replacementCount).toBe(1)
    } finally {
      if (turn.rotating) await turn.rotating
      session.stopFooterStatus(turn)
      for (let i = 0; i <= replacementCount; i++) await cardkit.dispose(`card_size_persistent_${i}`)
    }
  })
})

describe('Session project tasklist', () => {
  test('main, multiple worktrees and temporary groups share the project tasklist throughout its lifecycle', async () => {
    const tasklist = await import('./tasklist')
    const projectName = 'task-project'
    const shared = {
      projectName, guid: 'shared-tasklist', name: `${projectName}[lodestar]`,
      url: 'https://example.com/tasks/shared', ownerOpenId: 'owner',
    }
    let enabled = false
    let creations = 0
    const reads: string[] = []
    const enableCalls: Array<[string, string]> = []
    const deleteCalls: Array<[string, string]> = []
    const get = spyOn(tasklist, 'getTasklistBinding').mockImplementation(name => {
      reads.push(name)
      return name === projectName && enabled ? shared : null
    })
    const enable = spyOn(tasklist, 'enableTasklist').mockImplementation(async (name, chatId) => {
      enableCalls.push([name, chatId])
      if (name !== projectName) throw new Error('unexpected project')
      if (!enabled) creations++
      enabled = true
      return shared
    })
    const remove = spyOn(tasklist, 'deleteTasklist').mockImplementation(async (name, guid) => {
      deleteCalls.push([name, guid])
      if (name !== projectName || guid !== shared.guid) throw new Error('unexpected tasklist')
      enabled = false
      return shared
    })
    const sessions = [
      'task-project', 'task-project[feature-a]', 'task-project[feature-b]',
      'task-project*0917-1234', 'task-project[feature-b]*0917-1234',
    ].map((name, index) => new Session(name, `task-chat-${index}`))
    try {
      expect(new Set(sessions.map(session => session.workDir)).size).toBe(3)
      // Creating from WT must attach to the project's shared list as well.
      expect((await sessions[1].onTasklistEnable()).ok).toBe(true)
      for (const session of sessions) {
        expect((await session.onTasklistEnable()).ok).toBe(true)
        await session.runCommand('task')
        expect(session.onTasklistDeletePrompt(shared.guid).ok).toBe(true)
      }
      expect(creations).toBe(1)
      expect(enableCalls.map(([name]) => name)).toEqual(Array(6).fill(projectName))
      expect((await sessions[4].onTasklistDeleteConfirm(shared.guid)).ok).toBe(true)
      expect(deleteCalls).toEqual([[projectName, shared.guid]])
      for (const session of sessions) {
        expect(session.onTasklistDeletePrompt(shared.guid).ok).toBe(false)
      }
      expect([...new Set(reads)]).toEqual([projectName])
    } finally {
      get.mockRestore(); enable.mockRestore(); remove.mockRestore()
      for (const session of sessions) session.dispose()
    }
  })
})

describe('Session workDir project profile override', () => {
  test('uses profile cwd when present', () => {
    projectProfiles.set('withoverride', { cwd: '/abs/custom/dir' })
    const session = new Session('withoverride', 'oc_test_override')
    expect(session.workDir).toBe('/abs/custom/dir')
  })

  test('derives a worktree child session beside the profiled project root', () => {
    projectProfiles.set('withoverride', { cwd: '/abs/custom/dir' })
    const session = new Session('withoverride[feature-x]', 'oc_test_worktree_override')
    expect(session.workDir).toBe('/abs/custom/withoverride[feature-x]')
  })

  test('keeps a temporary session created from a worktree in that worktree cwd', () => {
    projectProfiles.set('withoverride', { cwd: '/abs/custom/dir' })
    const session = new Session('withoverride[feature-x]*0821-1337', 'oc_test_temp_worktree')
    expect(session.workDir).toBe('/abs/custom/withoverride[feature-x]')
  })

  test('refuses a persisted resume ref after the project profile cwd changes', () => {
    modelSelections.set('moved-project', { provider: 'codex', model: null, effort: null })
    resumeRefs.set('moved-project:codex', {
      provider: 'codex', sessionId: 'thread-from-old-cwd', cwd: '/abs/old/project',
    })
    projectProfiles.set('moved-project', { cwd: '/abs/new/project' })
    const session = new Session('moved-project', 'oc_moved_project') as any

    expect(() => session.spawnAgent(session.lastSessionRef)).toThrow('conversation launch cwd mismatch')
  })

  test('falls back to PROJECTS_ROOT/<name> without profile', () => {
    const session = new Session('plainproject', 'oc_test_plain')
    expect(session.workDir).toBe('/tmp/lodestar-projects/plainproject')
  })

  test('ignores a blank cwd override', () => {
    projectProfiles.set('blankcwd', { cwd: '   ' })
    const session = new Session('blankcwd', 'oc_test_blank')
    expect(session.workDir).toBe('/tmp/lodestar-projects/blankcwd')
  })
})

describe('Session card pagination', () => {
  for (const provider of ['codex', 'claude'] as const) {
    for (const code of [200860, 300305]) {
      test(`${provider} keeps identical tool results and the final reply visible after more than five capacity rotations (${code})`, async () => {
        const session = new Session('unlimited-pagination', 'chat_id') as any
        const turn = turnState('card_unlimited_0')
        turn.provider = provider
        turn.userOpenId = ''
        session.proc = new FakeAgentProc(provider, 'native-session')
        session.currentTurn = turn
        let replacementCount = 0
        const accepted = new Map<string, Set<string>>()
        cardkit.recordCardCreated(turn.cardId, 1, (failureCode, failure) => {
          session.onCardWriteFailure(turn, 'card_unlimited_0', failureCode, failure)
        })
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
          const method = String(init?.method ?? 'GET')
          const body = init?.body ? JSON.parse(String(init.body)) : null
          calls.push({ method, path, body })
          let response: any = { code: 0, data: {} }
          if (path === '/cards/id_convert') {
            response.data = { card_id: `card_unlimited_${++replacementCount}` }
          } else if (method === 'POST' && path.endsWith('/elements')) {
            const ids = accepted.get(path) ?? new Set<string>()
            if (ids.size >= 1) response = { code, msg: 'card capacity exceeded' }
            else {
              ids.add(JSON.parse(body.elements)[0].element_id)
              accepted.set(path, ids)
            }
          }
          return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } })
        }) as typeof fetch

        try {
          // Every page contains the same text; successful pagination must not
          // mistake a later, distinct tool call for a failed migration loop.
          for (let i = 0; i < 10; i++) {
            sessionTools.addTool(session, `tool_use_${i}`, 'Bash', { command: '# desc: 查看结果\nprintf result' })
            await cardkit.flush(turn.cardId)
            await waitUntil(() => !turn.rotating)
            sessionTools.completeTool(session, `tool_use_${i}`, '相同的工具结果', false)
            await cardkit.flush(turn.cardId)
          }
          expect(replacementCount).toBe(9)
          expect(turn.failureRotateCount).toBe(9)
          expect(turn.cardRotationFailed).toBe(false)
          session.appendAssistant('完整的最终回复')
          session.finalizeCurrentAssistantSegment()
          await cardkit.flush(turn.cardId)
          await waitUntil(() => !turn.rotating)
          await session.closeTurnCard(undefined, { hasFreshResult: false })
          expect(replacementCount).toBe(10)
          expect(sentRawTexts).toEqual([])
          expect(JSON.stringify(calls.filter(call => call.path === '/cards/card_unlimited_10/elements')))
            .toContain('完整的最终回复')
          const toolResults = calls.filter(call => call.method === 'PUT' && call.path.endsWith('/tool_0'))
          expect(toolResults).toHaveLength(10)
          expect(toolResults.every(call => call.body.element.includes('相同的工具结果'))).toBe(true)
        } finally {
          if (turn.rotating) await turn.rotating
          session.stopFooterStatus(turn)
          for (let i = 0; i <= replacementCount; i++) await cardkit.dispose(`card_unlimited_${i}`)
        }
      })
    }
  }

  test('proactive full-card rotations do not count as capacity failures', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-session-1')
    const turn = turnState('card_old')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated('card_old', 1)
    turn.rotateCount = 5 // 5 次主动满卡轮转已发生,但从未因写失败换过卡

    try {
      session.onCardWriteFailure(turn, 'card_old', 300305, {
        cardId: 'card_old',
        operation: 'addElement',
        code: 300305,
        message: 'component count exceeds limit',
      })

      expect(turn.cardRotationFailed).toBe(false)
      expect(turn.rotating).not.toBeNull()
      await turn.rotating
      expect(turn.cardId).not.toBe('card_old') // 真的换到了新卡
      expect(turn.failureRotateCount).toBe(1)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('replacement-card send failure pauses the footer without poisoning the current card', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-session-1')
    const turn = turnState('card_dead')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated('card_dead', 50)
    const sendSpy = spyOn(feishu, 'sendCard').mockResolvedValue(null)

    try {
      session.startWritingFooter(turn)
      expect(turn.footerStatusHandle).not.toBeNull()

      session.onCardWriteFailure(turn, 'card_dead', 300305, {
        cardId: 'card_dead',
        operation: 'addElement',
        code: 300305,
        message: 'component count exceeds limit',
      })
      await turn.rotating

      expect(turn.cardRotationFailed).toBe(true)
      expect(turn.rotating).toBeNull() // 不再尝试换卡
      // 续卡失败时暂停 footer 定时刷新，真实输出到达后再恢复。
      expect(turn.footerStatusHandle).toBeNull()
      session.startWorkingFooter(turn)
      expect(turn.footerStatusHandle).toBeNull()
      // 续卡发送失败不证明旧卡全部不可写；新内容仍按实际写入结果处理。
      // 网络路由解析是异步的，先等待 startWritingFooter 已排入的写入完成。
      await cardkit.flush('card_dead')
      const before = calls.length
      await cardkit.replaceElement('card_dead', 'footer', { tag: 'markdown', element_id: 'footer', content: 'x' })
      await cardkit.addElement('card_dead', { tag: 'markdown', element_id: 'e_new', content: 'x' })
      expect(calls.length).toBe(before + 2)
      expect(sentRawTexts.length).toBe(1)
      expect(sentRawTexts[0]).toContain('续卡发送失败')
      expect(sentRawTexts[0]).toContain('后续内容到达时会再次尝试')
      expect(sentRawTexts[0]).not.toContain('连续 5 次写入失败')
    } finally {
      sendSpy.mockRestore()
      session.stopFooterStatus(turn)
      await cardkit.dispose('card_dead')
    }
  })

  for (const provider of ['codex', 'claude'] as const) {
    for (const trigger of ['tool_result', 'turn_close'] as const) {
      test(`${provider} recovers a failed replacement card on ${trigger}`, async () => {
        const session = new Session('rotate-send-retry', 'chat_id') as any
        const turn = turnState('card_rotate_send_retry')
        turn.provider = provider
        turn.userOpenId = ''
        session.proc = new FakeAgentProc(provider, 'native-session')
        session.currentTurn = turn
        turn.toolByUseId.set('running-tool', {
          i: 0, name: 'Bash', input: { command: '# desc: 运行任务\nprintf work' },
        })
        cardkit.recordCardCreated(turn.cardId, 50)
        const sendSpy = spyOn(feishu, 'sendCard').mockResolvedValueOnce(null).mockResolvedValue('om_retry')
        try {
          session.maybeMidTurnRotate()
          await turn.rotating
          expect(turn.cardRotationFailed).toBe(true)
          expect(turn.footerStatusHandle).toBeNull()
          expect(sentRawTexts).toHaveLength(1)
          if (trigger === 'tool_result') {
            sessionTools.completeTool(session, 'running-tool', '恢复后完整的工具结果', false)
            await turn.rotating
            await cardkit.flush(turn.cardId)
            expect(turn.cardRotationFailed).toBe(false)
            expect(JSON.stringify(calls)).toContain('恢复后完整的工具结果')
          } else {
            turn.currentAssistantSegmentId = 'assistant_0'
            turn.currentAssistantText = '完整的最终回复'
            turn.segmentTexts.set('assistant_0', '完整的最终回复')
            await session.closeTurnCard(undefined, { hasFreshResult: false })
            expect(turn.cardRotationFailed).toBe(false)
            expect(JSON.stringify(calls.filter(call => call.path.startsWith(`/cards/${turn.cardId}/elements`))))
              .toContain('完整的最终回复')
            expect(sentTexts).toEqual([])
          }
          expect(sendSpy).toHaveBeenCalledTimes(2)
          expect(sentRawTexts).toHaveLength(1)
        } finally {
          if (turn.rotating) await turn.rotating
          sendSpy.mockRestore()
          session.stopFooterStatus(turn)
          await cardkit.dispose('card_rotate_send_retry')
          await cardkit.dispose(turn.cardId)
        }
      })
    }
  }

  test('distinct validation/content failures stay on the current card and are each reported', async () => {
    const session = new Session('validation-no-rotate', 'chat_id') as any
    const turn = turnState('card_validation')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 2, (code, failure) => {
      session.onCardWriteFailure(turn, turn.cardId, code, failure)
    })
    let attempt = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      attempt++
      return new Response(JSON.stringify(attempt === 1
        ? {
            code: 300315,
            msg: 'elementID format error. It must start with an alphabet and not exceed 20 characters; code: 300301',
          }
        : { code: 200570, msg: 'invalid image keys; ErrorValue: image key img_key' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      await cardkit.addElement(turn.cardId, {
        tag: 'markdown', element_id: 'bad_element_1', content: 'x',
      })
      await cardkit.addElement(turn.cardId, {
        tag: 'markdown', element_id: 'bad_element_2', content: 'x',
      })

      expect(attempt).toBe(2)
      expect(turn.rotating).toBeNull()
      expect(turn.rotateCount).toBe(0)
      expect(turn.failureRotateCount).toBe(0)
      expect(turn.cardRotationFailed).toBe(false)
      expect(sentCards).toHaveLength(0)
      expect(calls.some(call => call.path === '/cards/id_convert')).toBe(false)
      expect(sentRawTexts).toHaveLength(2)
      expect(sentRawTexts[0]).toContain('未识别为卡片容量超限')
    } finally {
      await cardkit.dispose(turn.cardId)
    }
  })

  test('a late failure owned by an old turn cannot rotate the current turn', () => {
    const session = new Session('stale-card-owner', 'chat_id') as any
    const oldTurn = turnState('card_old_owner')
    const currentTurn = turnState('card_current_owner')
    session.currentTurn = currentTurn
    cardkit.recordCardCreated(currentTurn.cardId, 2)

    session.onCardWriteFailure(oldTurn, oldTurn.cardId, 300305, {
      cardId: oldTurn.cardId,
      operation: 'addElement',
      code: 300305,
      message: 'component count exceeds limit',
    })

    expect(session.currentTurn).toBe(currentTurn)
    expect(currentTurn.cardId).toBe('card_current_owner')
    expect(currentTurn.rotateCount).toBe(0)
    expect(currentTurn.failureRotateCount).toBe(0)
    expect(sentCards).toHaveLength(0)
    expect(sentRawTexts).toHaveLength(0)
  })
})

describe('Session SDK-initiated bg-task resume turns', () => {
  // 2026-07-04 事故:reviewer 后台 agent 完成 → SDK 自发恢复轮(init 无用户
  // 消息)合并出终报告,但 init handler 因 pendingUserMessageCount=0 不开卡,
  // appendAssistant 无 currentTurn 直接丢字 —— 6.6KB 终报告只存在于
  // transcript,飞书全程无痕。恢复轮必须开卡;开不了卡也必须纯文本兜底。
  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const t0 = Date.now()
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('waitFor timeout')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  function emitClaudeResult(proc: any): void {
    proc.lastResult = {
      cost_usd: null,
      cost_delta_usd: null,
      duration_ms: 1000,
      num_turns: 1,
      usage: null,
      subtype: 'success',
      is_error: false,
    }
    proc.emit('result', {})
  }

  function wiredClaudeSession(): { session: any; proc: any } {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.lastUserOpenId = 'ou_user'
    session.wireProc(proc)
    proc.emit('init', { session_id: 'claude-session-1' }) // boot init,无用户批次,不开卡
    return { session, proc }
  }

  test('an init already owned by an eager-open card consumes its SDK input claim without creating a later empty user turn', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.lastUserOpenId = 'ou_user'
    session.wireProc(proc)
    session.currentTurn = turnState('card_eager_user')
    session.pendingUserMessageCount = 1
    session.pendingReactionIds = new Map([['om_later_buffered', 'reaction_later']])

    proc.emit('init', { session_id: 'claude-session-1' })

    expect(session.pendingUserMessageCount).toBe(0)
    expect(session.pendingReactionIds).toEqual(new Map([['om_later_buffered', 'reaction_later']]))
    expect(session.currentBatchReactionIds.size).toBe(0)

    session.currentTurn = null
    proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' })
    await waitFor(() => session.currentTurn !== null)

    try {
      expect(session.currentTurn.trigger).toBe('bg_task_resume')
      expect(session.currentTurn.trigger).not.toBe('user_message')
    } finally {
      if (session.currentTurn) await session.closeTurnCard('测试收尾')
    }
  })

  test('defensive init owner conflict stays inside the Session and preserves the unclaimed input', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.wireProc(proc)
    session.pendingUserMessageCount = 1
    session.pendingTurnInputs = ['still pending']
    session.beginTurnOpen = () => { throw new Error('forced owner conflict') }

    expect(() => proc.emit('init', { session_id: 'claude-session-1' })).not.toThrow()
    expect(proc.isAlive()).toBe(true)
    expect(session.pendingUserMessageCount).toBe(1)
    expect(session.pendingTurnInputs).toEqual(['still pending'])
    expect(sentCards).toHaveLength(0)
  })

  test('defensive drain owner conflict leaves the user batch and reactions queued', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.pendingMidTurnMsgs = [{
      text: 'must survive', wireText: 'must survive', userOpenId: 'ou_user', msgId: 'om_survive',
    }]
    session.pendingReactionIds = new Map([['om_survive', 'reaction_survive']])
    session.beginTurnOpen = () => { throw new Error('forced owner conflict') }

    await session.drainMidTurnAndOpen()

    expect(session.pendingMidTurnMsgs.map((msg: any) => msg.text)).toEqual(['must survive'])
    expect(session.pendingReactionIds).toEqual(new Map([['om_survive', 'reaction_survive']]))
    expect(proc.sentTexts).toEqual([])
  })

  test('settle 后的自发 init 开 bg_task_resume 卡,终报告落卡、正常收尾并加急推送', async () => {
    const { session, proc } = wiredClaudeSession()
    expect(session.currentTurn).toBeNull()

    proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' }) // SDK 自发恢复轮
    await waitFor(() => session.currentTurn !== null)

    try {
      expect(session.currentTurn.trigger).toBe('bg_task_resume')
      expect(session.status).toBe('working')

      proc.emit('assistant_text', { text: '双盲 review 合并终报告', parentToolUseId: null })
      proc.emit('assistant_block_stop', { parentToolUseId: null })
      emitClaudeResult(proc)
      await waitFor(() => session.currentTurn === null)
      // closeTurnCard 是 fire-and-forget:等终态 settings patch 落地再断言
      await waitFor(() => calls.some(c => c.method === 'PATCH' && c.path.includes('/settings')))

      const wroteReport = calls.some(c =>
        c.method === 'POST' &&
        /\/cards\/[^/]+\/elements$/.test(c.path) &&
        String(c.body?.elements ?? '').includes('终报告'),
      )
      expect(wroteReport).toBe(true)
      expect(session.status).toBe('idle')
      expect(urgentPushes.length).toBe(1)
      expect(sentTexts).toEqual([]) // 走了卡,不该触发纯文本兜底
    } finally {
      if (session.currentTurn) {
        session.stopFooterStatus(session.currentTurn)
        await cardkit.dispose(session.currentTurn.cardId)
      }
    }
  })

  test('Cron scheduled input arriving after an empty init opens its own card and renders the report', async () => {
    const { session, proc } = wiredClaudeSession()

    proc.emit('init', { session_id: 'claude-session-1' })
    expect(session.currentTurn).toBeNull()
    proc.emit('scheduled_turn_input', {
      text: '【CrossEX 半小时运行巡检】检查服务并汇报。',
      promptId: 'cron-prompt-1',
    })
    await waitFor(() => session.currentTurn !== null)

    try {
      expect(session.currentTurn.trigger).toBe('scheduled_wakeup')
      expect(JSON.stringify(sentCards.at(-1))).toContain('定时任务触发')
      expect(JSON.stringify(sentCards.at(-1))).not.toContain('CrossEX 半小时运行巡检')

      proc.emit('assistant_text', { text: '**巡检 10:13**：服务正常，零异常。', parentToolUseId: null })
      proc.emit('assistant_block_stop', { index: 'assistant-cron-1', parentToolUseId: null })
      emitClaudeResult(proc)
      await waitFor(() => session.currentTurn === null)
      await cardkit.flush('card_status_1')

      expect(calls.some(call =>
        call.method === 'POST' &&
        /\/cards\/[^/]+\/elements$/.test(call.path) &&
        String(call.body?.elements ?? '').includes('巡检 10:13')
      )).toBe(true)
      expect(sentTexts.some(text => text.includes('后台轮输出'))).toBe(false)
    } finally {
      if (session.currentTurn) await session.closeTurnCard('测试收尾')
    }
  })

  test('开卡窗口期先到的 assistant 文本并入新卡,不丢', async () => {
    const { session, proc } = wiredClaudeSession()

    proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' })
    // openTurnCard 还在 await sendCard/id_convert,文本已经开始流 —— 事故里
    // 55ms 后模型就开写。这些字必须并入随后落地的卡。
    proc.emit('assistant_text', { text: '窗口期先到的段落', parentToolUseId: null })
    proc.emit('assistant_block_stop', { parentToolUseId: null })
    await waitFor(() => session.currentTurn !== null)

    try {
      emitClaudeResult(proc)
      await waitFor(() => session.currentTurn === null)
      await waitFor(() => calls.some(c => c.method === 'PATCH' && c.path.includes('/settings')))

      const wrote = calls.some(c =>
        c.method === 'POST' &&
        /\/cards\/[^/]+\/elements$/.test(c.path) &&
        String(c.body?.elements ?? '').includes('窗口期先到的段落'),
      )
      expect(wrote).toBe(true)
    } finally {
      if (session.currentTurn) {
        session.stopFooterStatus(session.currentTurn)
        await cardkit.dispose(session.currentTurn.cardId)
      }
    }
  })

  test('没有 settle 的空 init 不开卡(probe/模型切换等场景不受影响)', async () => {
    const { session, proc } = wiredClaudeSession()

    proc.emit('init', { session_id: 'claude-session-1' }) // 无 settle、无用户批次
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(session.currentTurn).toBeNull()
    expect(sentCards.length).toBe(0)
  })

  test('恢复轮开卡失败(id_convert 报错)时,输出纯文本兜底不丢', async () => {
    const { session, proc } = wiredClaudeSession()
    // 让本轮 id_convert 报错 → openTurnCard 拿不到 cardId → 开卡失败。
    const base = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cards/id_convert')) {
        return new Response(JSON.stringify({ code: 99, msg: 'boom' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return base(input, init)
    }) as typeof fetch

    try {
      proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
      proc.emit('init', { session_id: 'claude-session-1' })
      // 开卡在 await 中就会失败;这些字必须仍被兜住(开卡窗口 + cardless 续窗)。
      proc.emit('assistant_text', { text: '孤儿终报告内容', parentToolUseId: null })
      proc.emit('assistant_block_stop', { parentToolUseId: null })
      await waitFor(() => session.bgResumeCardless === true || session.currentTurn !== null)
      emitClaudeResult(proc)
      await waitFor(() => sentTexts.length > 0)

      expect(sentTexts.join('\n')).toContain('孤儿终报告内容')
      expect(session.currentTurn).toBeNull()
    } finally {
      globalThis.fetch = base
    }
  })

  test('用户打断后,残留的 post-interrupt 正文被丢弃,不推送 📄 兜底消息', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.wireProc(proc)
    const turn = turnState('card_live')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated('card_live', 1)

    try {
      // 模拟软停止:置 userInterrupted、封口卡片(currentTurn 置空)。
      session.userInterrupted = true
      await session.closeTurnCard('🛑 打断')
      expect(session.currentTurn).toBeNull()

      // interrupt 落地前 SDK 仍在流式:这些 delta 到达时已无卡。旧行为是
      // 静默丢弃 —— 修复后必须仍然丢弃,不能变成 📄 纯文本兜底。
      proc.emit('assistant_text', { text: '被取消的轮次尾巴', parentToolUseId: null })
      proc.emit('assistant_block_stop', { parentToolUseId: null })
      emitClaudeResult(proc)
      await new Promise(resolve => setTimeout(resolve, 30))

      expect(sentTexts.join('\n')).not.toContain('被取消的轮次尾巴')
      expect(sentTexts.some(t => t.includes('📄'))).toBe(false)
      expect(session.status).toBe('idle')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose('card_live')
    }
  })

  test('result 抢在 bg-resume 开卡 await 窗口内到达:不重复兜底,卡片正常收尾,不卡在 working', async () => {
    const { session, proc } = wiredClaudeSession()

    proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' }) // 开始开卡(await sendCard/id_convert)
    proc.emit('assistant_text', { text: '短恢复轮输出', parentToolUseId: null })
    proc.emit('assistant_block_stop', { parentToolUseId: null })
    // 开卡还没落地(openingTurn 仍 true)就来 result —— 竞态窗口。
    emitClaudeResult(proc)

    await waitFor(() => session.currentTurn === null && session.openingTurn === false)
    await waitFor(() => calls.some(c => c.method === 'PATCH' && c.path.includes('/settings')))

    // 文本进了卡(不是纯文本兜底),且只出现一次。
    expect(sentTexts.some(t => t.includes('📄'))).toBe(false)
    const inCard = calls.some(c =>
      c.method === 'POST' &&
      /\/cards\/[^/]+\/elements$/.test(c.path) &&
      String(c.body?.elements ?? '').includes('短恢复轮输出'),
    )
    expect(inCard).toBe(true)
    // 卡片已收尾(有终态 settings patch),session 不卡在 working。
    expect(session.status).toBe('idle')
  })

  test('用户消息撞上 bg-resume 开卡时排队等待,不抢 owner、不重复开卡、不把后台正文塞进用户卡', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.lastUserOpenId = 'ou_user'
    session.wireProc(proc)
    proc.emit('init', { session_id: 'claude-session-1' })

    let releaseOpen!: () => void
    const gate = new Promise<void>(resolve => { releaseOpen = resolve })
    const originalConvert = cardkit.convertMessageToCard
    let openCalls = 0
    const convert = spyOn(cardkit, 'convertMessageToCard').mockImplementation(async (messageId: string) => {
      openCalls++
      if (openCalls === 1) await gate
      return originalConvert(messageId)
    })

    try {
      session.bgResumePending = true
      proc.emit('init', { session_id: 'claude-session-1' })
      await waitFor(() => openCalls === 1 && session.openingTurn)

      proc.emit('assistant_text', { text: '上一轮后台结果', parentToolUseId: null })
      proc.emit('assistant_block_stop', { index: 'assistant_bg', parentToolUseId: null })
      await session.onUserMessage('请只讲直接结论', [], 'ou_user', '')
      expect(session.pendingMidTurnMsgs.map((msg: any) => msg.text)).toEqual(['请只讲直接结论'])

      emitClaudeResult(proc)
      await new Promise(resolve => setTimeout(resolve, 10))
      // result handler 只能等待既有 bg-resume owner；不能 beginTurnOpen 覆盖它，
      // 更不能让两条 openTurnCard 协程同时创建主卡。
      expect(openCalls).toBe(1)

      releaseOpen()
      await waitFor(() => session.currentTurn?.trigger === 'user_message' && !session.openingTurn)
      const userCardId = session.currentTurn.cardId
      await cardkit.flush(userCardId)

      expect(proc.sentTexts).toEqual([`${fileDeliveryAgentContext('chat')}\n\n请只讲直接结论`])
      expect(sentTexts.some(text => text.includes('后台轮输出'))).toBe(false)
      expect(calls.some(call =>
        call.path === `/cards/${userCardId}/elements` &&
        String(call.body?.elements ?? '').includes('上一轮后台结果')
      )).toBe(false)
      expect(calls.some(call =>
        call.method === 'POST' &&
        /\/cards\/[^/]+\/elements$/.test(call.path) &&
        String(call.body?.elements ?? '').includes('上一轮后台结果')
      )).toBe(true)
    } finally {
      releaseOpen()
      if (session.currentTurn) await session.closeTurnCard('测试收尾')
      convert.mockRestore()
    }
  })

  test('切换 provider 停旧进程时清掉 bgResumePending,新进程 boot init 不误开恢复卡', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'codex' // 与 proc.provider 不一致 → 视为 idle mismatched
    session.bgResumePending = true

    await session.stopIdleMismatchedProcess()

    expect(session.bgResumePending).toBe(false)
    expect(session.proc).toBeNull()
  })

  test('非开卡/非恢复窗口的游离正文被丢弃,不进孤儿缓冲', () => {
    const session = new Session('probe', 'chat_id') as any
    // 无 currentTurn、无 openingTurn、无 bgResumeCardless:任何游离 delta 都该丢。
    session.appendAssistant('进程 kill 窗口的残字')
    session.finalizeCurrentAssistantSegment()

    expect(session.orphanAssistantSegments).toEqual([])
    expect(session.orphanAssistantCurrent).toBe('')
  })
})

describe('Session claude subagent tool calls stay off the main card', () => {
  // 2026-08-18 对齐 codex 侧 isSubagentThread 分流(cf41941):claude 子 agent 的
  // 工具调用按 parent_tool_use_id 归属后台 task,只累积 steps,不上主卡面板 ——
  // 主卡只承载主 agent,多 agent 时面板数不爆表。
  test('子 agent tool_use/tool_result 只进 bg steps,不 addTool/completeTool', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_subagent_iso')
    cardkit.recordCardCreated('card_subagent_iso', 1)

    try {
      // 主线程 Task tool_use 触发子 agent → bg task 建立(toolUseId 关联)
      proc.emit('tool_use', { id: 'task_main_1', name: 'Task', input: { description: 'review' }, parentToolUseId: null })
      proc.emit('bg_task_started', { task_id: 't1', tool_use_id: 'task_main_1', description: 'review' })
      // 子 agent 内的工具调用:parentToolUseId 指向主线程 Task
      proc.emit('tool_use', { id: 'sub_read_1', name: 'Read', input: { file_path: '/tmp/a.ts' }, parentToolUseId: 'task_main_1' })
      proc.emit('tool_result', { tool_use_id: 'sub_read_1', content: 'file body', is_error: false, parentToolUseId: 'task_main_1' })

      // steps 已累积(含结果回填)
      const t1 = session.backgroundTasks.concat(session.pendingBgTasks).find((t: any) => t.id === 't1')
      expect(t1).toBeDefined()
      expect(t1.steps.length).toBe(1)
      expect(t1.steps[0].tool).toBe('Read')
      expect(t1.steps[0].brief).toContain('→ file body')
      // 主卡 toolByUseId 不含子 agent 工具 —— 没走 addTool/completeTool
      expect(session.currentTurn.toolByUseId.has('sub_read_1')).toBe(false)
      // 启动工具也归入委派面板，SDK task id 回填后仍然只有一项。
      expect(session.currentTurn.toolByUseId.has('task_main_1')).toBe(false)
      expect(session.backgroundTasks).toHaveLength(1)
      await cardkit.flush('card_subagent_iso')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await session.resetBackgroundTasks()
      await session.agentCards.closeChat('chat_id')
      await cardkit.dispose('card_subagent_iso')
    }
  })

  test('DSH 子工具返回内容块时不抛异常，也不写入主对话卡', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('dsh', 'dsh-session')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_dsh_child_blocks')
    cardkit.recordCardCreated('card_dsh_child_blocks', 1)
    try {
      proc.emit('bg_task_started', { task_id: 'child', tool_use_id: 'child', description: 'DSH child', task_type: 'agent' })
      proc.emit('tool_use', { id: 'child-bash', name: 'Bash', input: { command: 'echo child' }, parentToolUseId: 'child' })
      expect(() => proc.emit('tool_result', { tool_use_id: 'child-bash', content: [{ type: 'text', text: 'started background job bash-1' }],
        is_error: false, parentToolUseId: 'child' })).not.toThrow()
      const child = [...session.backgroundTasks, ...session.pendingBgTasks].find((entry: any) => entry.id === 'child')
      expect(child.steps[0].brief).toContain('started background job bash-1')
      expect(session.currentTurn.toolByUseId.has('child-bash')).toBe(false)
      expect(proc.isAlive()).toBe(true)
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await session.resetBackgroundTasks()
      await session.agentCards.closeChat('chat_id')
      await cardkit.dispose('card_dsh_child_blocks')
    }
  })

  test('子 agent assistant text/block_stop 不进入主卡,主 agent 正文仍正常渲染', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_subagent_text_iso')
    cardkit.recordCardCreated('card_subagent_text_iso', 1)

    try {
      proc.emit('assistant_text', {
        text: '我将并行开展多轮搜索来收集证据。',
        parentToolUseId: 'task_main_1',
      })
      proc.emit('assistant_block_stop', {
        index: 'assistant_child_1',
        parentToolUseId: 'task_main_1',
      })

      expect(session.currentTurn.assistantSegmentCount).toBe(0)
      expect(session.currentTurn.segmentTexts.size).toBe(0)

      proc.emit('assistant_text', { text: '这是主 Agent 的结论。', parentToolUseId: null })
      proc.emit('assistant_block_stop', { index: 'assistant_main_1', parentToolUseId: null })
      await cardkit.flush('card_subagent_text_iso')

      expect(session.currentTurn.assistantSegmentCount).toBe(1)
      expect([...session.currentTurn.segmentTexts.values()]).toEqual(['这是主 Agent 的结论。'])
      expect(calls.some(call =>
        call.method === 'POST' &&
        call.path === '/cards/card_subagent_text_iso/elements' &&
        String(call.body?.elements ?? '').includes('我将并行开展多轮搜索')
      )).toBe(false)
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await cardkit.dispose('card_subagent_text_iso')
    }
  })

  test('parentToolUseId 无归属 task 的 tool_use(如合成 AskUserQuestion)仍走主卡', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_subagent_orphan')
    cardkit.recordCardCreated('card_subagent_orphan', 1)

    try {
      proc.emit('tool_use', { id: 'orphan_1', name: 'Bash', input: { command: 'echo hi' }, parentToolUseId: 'unknown_parent' })
      expect(session.currentTurn.toolByUseId.has('orphan_1')).toBe(true)
      await cardkit.flush('card_subagent_orphan')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await cardkit.dispose('card_subagent_orphan')
    }
  })
})

describe('Session usage cache cross-backend isolation', () => {
  test('a completed card retains the successful account cache when the latest query failed and the process exited', async () => {
    const { bindProcessCodexAccount } = await import('./codex-accounts')
    const accountId = 'closed-footer-cache'
    const session = new Session('closed-footer-cache', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'quota-session')
    bindProcessCodexAccount(proc, accountId)
    session.proc = proc
    session.selectedTokenSourceId = null
    const turn = { ...turnState('card_closed_footer_cache'), provider: 'codex', model: 'shared-model', effort: 'high', userOpenId: '' }
    session.currentTurn = turn
    session.lastTurnUsage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
    cardkit.recordCardCreated(turn.cardId, 1)
    let quotaNow = Date.now()
    const quotaClock = spyOn(Date, 'now').mockImplementation(() => quotaNow)
    try {
      await refreshUsageFromConnection(async () => ({ rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300 },
        secondary: { usedPercent: 34, windowDurationMins: 10080 },
      } }), accountId)
      quotaNow += 60_000
      await refreshUsageFromConnection(async () => { throw new Error('quota read failed') }, accountId)
      expect(peekUsage(accountId)).toBeTruthy()
      proc.alive = false
      await session.closeTurnCard(undefined, { hasFreshResult: true })
      const footer = calls.find(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
      const content = JSON.parse(footer?.body.element ?? '{}').content as string
      expect(content).toContain('12%·[34%]')
      expect(content).not.toContain('缓存')
      expect(content).not.toContain('刷新失败')
      expect(content).not.toContain('MISS')
    } finally {
      quotaClock.mockRestore()
      invalidateCodexUsage(accountId)
      proc.emit('exit')
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('claude 的 rate_limit_event payload 不触碰 codex 用量缓存', async () => {
    // 用 read 端点形状经真实 cache 写入路径(refresh)播种缓存(模块级单例)。
    const seeded = await refreshUsageFromConnection(async () => ({
      rateLimits: {
        limitId: 'codex', planType: 'plus',
        primary: { usedPercent: 42, resetsAt: 1_700_000_000, windowDurationMins: 300 },
        secondary: null,
      },
    }))
    expect(seeded?.state).toBe('ok')

    const session = new Session('probe', 'chat_id') as any
    const claudeProc = new FakeAgentProc('claude')
    session.wireProc(claudeProc)
    // claude 的 rate_limit_info 形状(无 planType/primary/secondary):truthy 但
    // 与 codex 完全不同。新架构下通知一律不写 cache(rolling limitId 不可信),
    // claude 事件更不能。
    claudeProc.emit('rate_limits_updated', { status: 'allowed', unified_status: 'allowed' })

    // 缓存对象必须原封不动(恒等,而非结构相等)。
    expect(peekUsage()).toBe(seeded)
  })

  test('codex 的 rate_limits_updated 只观察不写缓存(权威在 read 端点)', () => {
    const session = new Session('probe', 'chat_id') as any
    const codexProc = new FakeAgentProc('codex')
    session.wireProc(codexProc)
    codexProc.emit('rate_limits_updated', {
      planType: 'pro',
      primary: { usedPercent: 7, resetsAt: 1_700_000_000, windowDurationMins: 300 },
    })

    // rolling 通知不再驱动 cache —— 2026-08-20 源码核实 codex 解析器在
    // 上游缺 metered_limit_name 时把 limitId 强补 "codex",通知归属不可信;
    // turn 收尾由 closeTurnCard 在现有连接 read 端点整体刷新。
    const snap = peekUsage() as any
    expect(snap?.fiveHour?.percent).not.toBe(7)
  })

  test('额度后缀保留原紧凑倒计时与百分比格式，缺失值显示 MISS', () => {
    const session = new Session('probe', 'chat_id') as any
    const h = (ms: number) => new Date(Date.now() + ms)
    // 4.1h 后重置 5h 额度、已用 7%;6.9d 后重置周额度、已用 17%。
    const fiveHour = { percent: 7, resetsAt: h(4.1 * 3600_000) }
    const weekly = { percent: 17, resetsAt: h(6.9 * 24 * 3600_000) }
    expect(session.fmtDualWindowSuffix(fiveHour, weekly)).toBe('  |  4.1h·7%·[6.9d·17%]')
    expect(session.fmtDualWindowSuffix(fiveHour, null)).toBe('  |  4.1h·7%')
    expect(session.fmtDualWindowSuffix({ percent: null, resetsAt: h(3600_000) }, weekly)).toBe('  |  MISS·[6.9d·17%]')
    expect(session.fmtDualWindowSuffix(null, weekly)).toBe('  |  [6.9d·17%]')
    expect(session.fmtDualWindowSuffix({ percent: 7, resetsAt: new Date(Date.now() - 1000) }, weekly)).toBe('  |  7%·[6.9d·17%]')
    expect(session.fmtDualWindowSuffix(null, null)).toBe('  |  额度 MISS')
  })

  test('Claude 的 hi 展示全部窗口，footer 按当前模型选择周额度并保留 5h', async () => {
    const { claudeUsageSnapshot } = await import('./claude-usage')
    const accountUsage = await import('./account-usage')
    const session = new Session('claude-quota', 'chat_id') as any
    let snapshot = claudeUsageSnapshot({ subscription_type: 'max', rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 7, resets_at: new Date(Date.now() + 4.1 * 3600_000).toISOString() },
      seven_day: { utilization: 17, resets_at: new Date(Date.now() + 6.9 * 86400_000).toISOString() },
      model_scoped: [{ display_name: 'Fable', utilization: 42, resets_at: null }],
    } })
    const source = { id: 'claude-sub', kind: 'claude-subscription', agent: 'claude', enabled: true, readUsage: async () => snapshot }
    session.selectedTokenSourceId = source.id
    session.currentTokenSource = () => source
    session.buildConsoleOpts = async () => ({ sessionName: 'claude-quota', status: 'idle', provider: 'claude' })
    const replaceSpy = spyOn(cardkit, 'replaceElementChecked').mockResolvedValue(true)
    const readAllSpy = spyOn(accountUsage, 'readAllAccountUsage').mockImplementation(async () => [
      { id: source.id, label: 'Claude 订阅', usage: snapshot },
    ])
    try {
      await session.patchConsoleUsage('quota-card')
      const panel = replaceSpy.mock.calls.at(-1)?.[2] as any
      expect(panel.element_id).toBe('console_usage')
      expect(panel.elements).toHaveLength(1)
      expect(panel.elements[0].content).toBe('**Claude 订阅**　5h 7%/4.1h · 周 17%/6.9d · Fable周 42%/MISS')
      expect(await session.footerUsageSuffix('claude', null, source.id, source, null, 'opus')).toBe('  |  4.1h·7%·[6.9d·17%]')
      expect(await session.footerUsageSuffix('claude', null, source.id, source, null, 'default')).toBe('  |  4.1h·7%·[6.9d·17%]')
      expect(await session.footerUsageSuffix('claude', null, source.id, source, null, 'claude-fable-5-1[1m]')).toBe('  |  4.1h·7%·[42%]')
      snapshot.windows.find(window => window.kind === 'modelWeekly:Fable')!.percent = null
      expect(await session.footerUsageSuffix('claude', null, source.id, source, null, 'fable')).toBe('  |  4.1h·7%·[MISS]')
      expect(await session.footerUsageSuffix('claude', null, source.id, source, null, null)).toBe('  |  4.1h·7%·[MISS]')
      snapshot = { state: 'network', windows: [], reason: 'query failed' }
      await session.patchConsoleUsage('quota-card')
      expect((replaceSpy.mock.calls.at(-1)?.[2] as any).elements[0].content).toContain('MISS · query failed')
      expect(await session.footerUsageSuffix('claude', null, source.id, source, null)).toBe('  |  额度 MISS')
      expect(await session.footerUsageSuffix('codex', null, source.id, source, null)).toBe('  |  额度 MISS')
      expect(await session.footerUsageSuffix('claude', null, 'other-source', undefined, null)).toBe('  |  额度 MISS')
    } finally { replaceSpy.mockRestore(); readAllSpy.mockRestore() }
  })

  test('Claude 收尾查询等待期间切换模型，不改变旧回复的专属周额度', async () => {
    const { claudeUsageSnapshot } = await import('./claude-usage')
    const snapshot = claudeUsageSnapshot({ subscription_type: 'max', rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 7, resets_at: null },
      seven_day: { utilization: 17, resets_at: null },
      model_scoped: [{ display_name: 'Fable', utilization: 42, resets_at: null }],
    } })
    const session = new Session('claude-quota-snapshot', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'quota-session', 'claude-sub')
    proc.lastModel = 'claude:fable'
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'claude-sub'
    session.selectedModel = 'fable'
    const turn = { ...turnState('card_quota_snapshot'), provider: 'claude', model: 'fable', effort: 'high', userOpenId: '' }
    session.currentTurn = turn
    session.lastTurnUsage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const source = { id: 'claude-sub', kind: 'claude-subscription', agent: 'claude', enabled: true,
      readUsage: async () => { signalStarted(); await gate; return snapshot } }
    session.currentTokenSource = () => source
    cardkit.recordCardCreated(turn.cardId, 1)
    const closing = session.closeTurnCard(undefined, { hasFreshResult: true })
    try {
      await started
      session.selectedModel = 'sonnet'
      proc.lastModel = 'claude:sonnet'
      release()
      await closing
      const footer = calls.find(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
      const content = JSON.parse(footer?.body.element ?? '{}').content as string
      expect(content).toContain('claude · fable/high')
      expect(content).toContain('7%·[42%]')
      expect(content).not.toContain('17%')
    } finally {
      release()
      await closing
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

describe('Session background tasks in shared delegation cards', () => {
  function makeRunningTask(id: string): any {
    return { id, type: 'shell', description: `bg ${id}`, status: 'running', startedAt: Date.now() - 5000, steps: [] }
  }

  test('stop drains visible tasks as killed and drops ordinary foreground commands', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.backgroundTasks = [makeRunningTask('t1'), makeRunningTask('t2')]
    session.pendingBgTasks = [makeRunningTask('foreground')]
    await session.refreshBackgroundCardFull()
    session.scheduleBackgroundRefresh()

    await session.stop('已终止', { announce: false })

    expect(proc.killCalls).toBe(1)
    expect(session.backgroundTasks).toEqual([])
    expect(session.pendingBgTasks).toEqual([])
    expect(session.backgroundSync).toBeNull()
    expect(session.backgroundRefreshTimer).toBeNull()
    expect(sentCards).toHaveLength(1)
    const writes = calls.filter(call => call.method === 'PUT').map(call => String(call.body.element)).join('\n')
    expect(writes).toContain('已终止')
    expect(writes).not.toContain('foreground')
    expect(updatedCards).toHaveLength(0)
    const settings = calls.filter(call => call.path.endsWith('/settings')).at(-1)!
    expect(JSON.parse(settings.body.settings).config.streaming_mode).toBe(false)
    await session.agentCards.closeChat('chat_id')
  })

  test('a main message leaves running work in its original panel', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.backgroundTasks = [makeRunningTask('running')]
    await session.refreshBackgroundCardFull()
    await feishu.sendCard('chat_id', { schema: '2.0', body: { elements: [] } })
    session.backgroundTasks = [{ ...session.backgroundTasks[0], summary: '检查中' }]
    await session.refreshBackgroundCardFull()
    expect(sentCards).toHaveLength(2)
    expect(updatedCards).toHaveLength(0)
    expect(calls.some(call => call.method === 'PUT' && String(call.body.element).includes('检查中'))).toBe(true)
    await session.resetBackgroundTasks()
    await session.agentCards.closeChat('chat_id')
  })

  test('stop waits for an admitted open, settles it, and namespaces a later process', async () => {
    const session = new Session('background-open-generation', 'chat_id') as any
    session.backgroundTasks = [makeRunningTask('same-id')]
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const baseFetch = globalThis.fetch
    let converting = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith('/cards/id_convert')) {
        converting = true
        await gate
      }
      return baseFetch(input, init)
    }) as typeof fetch
    try {
      const opening = session.refreshBackgroundCardFull()
      await waitUntil(() => converting)
      let resetDone = false
      const resetting = session.resetBackgroundTasks().then(() => { resetDone = true })
      await Promise.resolve()
      expect(resetDone).toBe(false)
      release()
      await Promise.all([opening, resetting])
      expect(session.backgroundTasks).toEqual([])
      session.backgroundTasks = [makeRunningTask('same-id')]
      await session.refreshBackgroundCardFull()
      expect(sentCards).toHaveLength(1)
      const appended = calls.filter(call => call.method === 'POST' && call.path.endsWith('/elements'))
      expect(appended).toHaveLength(1)
      const initialId = (sentCards[0] as any).body.elements[0].element_id
      expect(JSON.parse(appended[0]!.body.elements)[0].element_id).not.toBe(initialId)
    } finally {
      release()
      await session.resetBackgroundTasks()
      await session.agentCards.closeChat('chat_id')
      globalThis.fetch = baseFetch
    }
  })

  test('a failed terminal update remains visible and can be retried without duplicate rows', async () => {
    const session = new Session('background-update-failure', 'chat_id') as any
    session.backgroundTasks = [makeRunningTask('running')]
    await session.refreshBackgroundCardFull()
    const patch = spyOn(session.agentCards.deps, 'patchSettingsChecked').mockResolvedValue(false)
    try {
      await expect(session.resetBackgroundTasks()).rejects.toThrow('settings update MISS')
      expect(session.backgroundTasks[0].status).toBe('killed')
    } finally { patch.mockRestore() }
    await session.resetBackgroundTasks()
    expect(session.backgroundTasks).toEqual([])
    expect(sentCards).toHaveLength(1)
    await session.agentCards.closeChat('chat_id')
  })

  test('a failed launch is visible in the delegation panel without a main tool panel', async () => {
    const session = new Session('native-launch-failure', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_failed_child')
    cardkit.recordCardCreated('card_failed_child', 1)
    try {
      proc.emit('tool_use', { id: 'agent-tool', name: 'Agent', input: { description: '检查接口' }, parentToolUseId: null })
      proc.emit('tool_result', { tool_use_id: 'agent-tool', content: '无法启动子 Agent', is_error: true, parentToolUseId: null })
      await session.backgroundSync
      expect(session.currentTurn.toolByUseId.size).toBe(0)
      expect(session.backgroundTasks).toHaveLength(1)
      expect(session.backgroundTasks[0].status).toBe('failed')
      const rendered = calls.filter(call => call.method === 'PUT').map(call => String(call.body.element)).join('\n')
      expect(rendered).toContain('子 Agent失败')
      expect(rendered).toContain('无法启动子 Agent')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await session.resetBackgroundTasks()
      await session.agentCards.closeChat('chat_id')
      await cardkit.dispose('card_failed_child')
    }
  })

  test('a successful async launch receipt leaves the child running until its native result', async () => {
    const session = new Session('native-background-receipt', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_async_child')
    cardkit.recordCardCreated('card_async_child', 1)
    try {
      proc.emit('tool_use', { id: 'agent-tool', name: 'Agent', input: { description: '检查接口', run_in_background: true }, parentToolUseId: null })
      expect(session.currentTurn.footerStatusLabel).toBe('Working...')
      proc.emit('tool_result', { tool_use_id: 'agent-tool', content: 'Agent launched', is_error: false, parentToolUseId: null })
      expect(session.currentTurn.footerStatusLabel).toBe('Thinking...')
      expect(session.backgroundTasks[0].status).toBe('running')
      proc.emit('bg_task_started', { task_id: 'native-id', tool_use_id: 'agent-tool', description: '检查接口', task_type: 'local_agent' })
      proc.emit('bg_task_settled', { task_id: 'native-id', status: 'completed', summary: '接口正常' })
      await session.backgroundSync
      expect(session.backgroundTasks).toHaveLength(1)
      expect(session.backgroundTasks[0].status).toBe('completed')
      expect(session.currentTurn.toolByUseId.size).toBe(0)
      expect(sentCards).toHaveLength(1)
      expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/elements'))).toHaveLength(0)
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await session.resetBackgroundTasks()
      await session.agentCards.closeChat('chat_id')
      await cardkit.dispose('card_async_child')
    }
  })
})

describe('Session Claude task live panel (task_board_live)', () => {
  test('native SDK task calls render creation and every status update in one live panel', async () => {
    const session = new Session('claude-tasks', 'chat_id') as any
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'max' }) as any
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_claude_tasks')
    cardkit.recordCardCreated('card_claude_tasks', 1)
    let index = 0
    const task = async (name: string, input: any, content: string) => {
      const id = `task-call-${index++}`
      proc.handleMessage({ type: 'assistant', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id, name, input }] } })
      proc.handleMessage({ type: 'user', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })
      await cardkit.flush('card_claude_tasks')
      const writes = calls.filter(call => call.method === 'PUT'
        && call.path === '/cards/card_claude_tasks/elements/task_board_live')
      return JSON.parse(writes.at(-1)!.body.element)
    }
    try {
      await task('TaskCreate', { subject: '验证任务创建' }, 'Task #1 created successfully: 验证任务创建')
      const created = await task('TaskCreate', { subject: '验证任务完成' }, 'Task #2 created successfully: 验证任务完成')
      expect(created.expanded).toBe(true)
      expect(created.elements[0].content).toContain('- ⬜ 验证任务创建')
      expect(created.elements[0].content).toContain('- ⬜ 验证任务完成')

      const running = await task('TaskUpdate', { taskId: '1', status: 'in_progress' }, 'Updated task #1 status')
      expect(running.elements[0].content).toContain('- 🔄 验证任务创建')
      await task('TaskList', {}, '#1 [in_progress] 验证任务创建\n#2 [pending] 验证任务完成')
      await task('TaskUpdate', { taskId: '1', status: 'completed' }, 'Updated task #1 status')
      await task('TaskUpdate', { taskId: '2', status: 'in_progress' }, 'Updated task #2 status')
      const completed = await task('TaskUpdate', { taskId: '2', status: 'completed' }, 'Updated task #2 status')
      expect(completed.elements[0].content).toContain('- ✅ 验证任务创建')
      expect(completed.elements[0].content).toContain('- ✅ 验证任务完成')
      expect(session.taskBoard.map((entry: any) => entry.status)).toEqual(['completed', 'completed'])
      const liveAdds = calls.filter(call => call.method === 'POST'
        && call.path === '/cards/card_claude_tasks/elements'
        && String(call.body?.elements).includes('"task_board_live"'))
      expect(liveAdds).toHaveLength(1)
      expect(liveAdds[0].body.target_element_id).toBe('footer')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await cardkit.dispose('card_claude_tasks')
    }
  })
})

describe('Session codex plan live panel (plan_live)', () => {
  test('turn/plan/updated 首次建立 plan_live,后续原地 replace,最新计划始终在卡末', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-session-1')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_plan_live')
    session.currentTurn.planLiveInserted = false
    cardkit.recordCardCreated('card_plan_live', 1)

    try {
      const plan1 = { explanation: '第一版', plan: [{ step: '探查', status: 'inProgress' }] }
      proc.emit('turn_plan_updated', plan1)
      await cardkit.flush('card_plan_live')

      // 首次:建立 plan_live(insert_before footer)+ timeline 快照 plan_update_0
      const addLive = calls.find(c =>
        c.method === 'POST' && c.path === '/cards/card_plan_live/elements' &&
        String(c.body?.elements ?? '').includes('"plan_live"'))
      expect(addLive).toBeDefined()
      expect(addLive?.body.target_element_id).toBe('footer')
      expect(session.currentTurn.planLiveInserted).toBe(true)

      const plan2 = { explanation: '第二版', plan: [
        { step: '探查', status: 'completed' },
        { step: '接入', status: 'inProgress' },
      ] }
      proc.emit('turn_plan_updated', plan2)
      await cardkit.flush('card_plan_live')

      // 后续:PUT 原地 replace plan_live,内容是最新的第二版
      const putLive = calls.filter(c =>
        c.method === 'PUT' && c.path === '/cards/card_plan_live/elements/plan_live')
      expect(putLive.length).toBe(1)
      const replaced = JSON.parse(putLive[0].body.element)
      expect(replaced.expanded).toBe(true)
      expect(replaced.elements[0].content).toContain('- ✅ 探查')
      expect(replaced.elements[0].content).toContain('- 🔄 接入')
      expect(replaced.header.title.content).toBe('📋 当前计划 · 2 项 · 1 进行中 · 1 完成')

      // timeline 快照照旧累积(过程记录),且 insert_before plan_live(不被顶走)
      const snapshotAdds = calls.filter(c =>
        c.method === 'POST' && c.path === '/cards/card_plan_live/elements' &&
        String(c.body?.elements ?? '').includes('plan_update_'))
      expect(snapshotAdds).toHaveLength(2)
      expect(snapshotAdds.every(c => c.body.target_element_id === 'plan_live')).toBe(true)
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await cardkit.dispose('card_plan_live')
    }
  })

  test('plan_live 建立后锚点指向 plan_live,任务总览仍紧贴 footer', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-session-1')
    session.proc = proc
    session.wireProc(proc)
    const turn = turnState('card_anchor')
    turn.planLiveInserted = true
    turn.taskLiveInserted = true
    session.currentTurn = turn
    cardkit.recordCardCreated('card_anchor', 1)

    try {
      proc.emit('turn_plan_updated', { explanation: null, plan: [{ step: 'x', status: 'pending' }] })
      await cardkit.flush('card_anchor')
      // 已建立 → replace 路径,timeline 快照 insert_before plan_live
      const snapshotAdd = calls.find(c =>
        c.method === 'POST' && c.path === '/cards/card_anchor/elements' &&
        String(c.body?.elements ?? '').includes('plan_update_'))
      expect(snapshotAdd?.body.target_element_id).toBe('plan_live')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose('card_anchor')
    }
  })

  test('空 plan 数组不建立 live 面板,也不把已建立的刷成占位', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-session-1')
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_plan_empty')
    cardkit.recordCardCreated('card_plan_empty', 1)

    try {
      // 首次就是空数组 → 不建立
      proc.emit('turn_plan_updated', { explanation: null, plan: [] })
      await cardkit.flush('card_plan_empty')
      expect(session.currentTurn.planLiveInserted).toBe(false)
      expect(calls.some(c =>
        c.method === 'POST' && c.path === '/cards/card_plan_empty/elements' &&
        String(c.body?.elements ?? '').includes('plan_live'))).toBe(false)

      // 空数组首次 → 未建立;有效更新 → 此时才建立(POST add,内容含有效步骤)
      proc.emit('turn_plan_updated', { explanation: '有效', plan: [{ step: '有效步骤', status: 'inProgress' }] })
      await cardkit.flush('card_plan_empty')
      expect(session.currentTurn.planLiveInserted).toBe(true)
      const addLive = calls.filter(c =>
        c.method === 'POST' && c.path === '/cards/card_plan_empty/elements' &&
        String(c.body?.elements ?? '').includes('plan_live'))
      expect(addLive).toHaveLength(1)
      expect(addLive[0].body.elements).toContain('有效步骤')

      // 建立后再来空更新 → 不 replace,上次有效计划保留(0 条 PUT)
      proc.emit('turn_plan_updated', { explanation: null, plan: [] })
      await cardkit.flush('card_plan_empty')
      const putLive = calls.filter(c =>
        c.method === 'PUT' && c.path === '/cards/card_plan_empty/elements/plan_live')
      expect(putLive).toHaveLength(0)
    } finally {
      session.stopFooterStatus(session.currentTurn)
      await cardkit.dispose('card_plan_empty')
    }
  })
})

describe('Session live_elapsed second mode', () => {  test('second live_elapsed mode updates the main footer without background clock timers', async () => {
    // 显式钉死 second 模式，隔离本机配置差异。
    const cfg = config as any
    const previousRuntime = cfg.runtime
    cfg.runtime = { ...(previousRuntime ?? {}), live_elapsed: 'second' }
    const session = new Session('second-scheduling', 'chat_id') as any
    const turn = turnState('card_second_scheduling')
    cardkit.recordCardCreated(turn.cardId, 1)
    const delays: number[] = []
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation((
      (_callback: (...args: any[]) => void, delay?: number) => {
        delays.push(Number(delay ?? 0))
        return DETERMINISTIC_FOOTER_HANDLE
      }
    ) as typeof setTimeout)

    try {
      session.startThinkingFooter(turn)
      expect(delays).toHaveLength(1)
      expect(delays[0]).toBe(1000)
      session.stopFooterStatus(turn)

      // startFooterStatus 先 Date.now() 记 startedAt,再 Date.now() 算 elapsed。
      // 第一次返回 base,后续返回 base+45s → 文案 Writing... (45s)。
      session.stopFooterStatus(turn)
      const base = Date.now()
      let nowCalls = 0
      const nowSpy = spyOn(Date, 'now').mockImplementation(() => {
        nowCalls += 1
        return nowCalls === 1 ? base : base + 45_000
      })
      try {
        session.startWritingFooter(turn)
      } finally {
        nowSpy.mockRestore()
      }
      await cardkit.flush(turn.cardId)
      const footerWrites = calls
        .filter(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
        .map(call => JSON.parse(call.body.element).content as string)
      expect(footerWrites.at(-1)).toContain('Writing... (45s)')
    } finally {
      session.stopFooterStatus(turn)
      timeoutSpy.mockRestore()
      if (previousRuntime === undefined) delete cfg.runtime
      else cfg.runtime = previousRuntime
      await cardkit.dispose(turn.cardId)
    }
  })

  test('a transient live footer MISS stays log-only and the next refresh still lands', async () => {
    const session = new Session('footer-transient-miss', 'chat_id') as any
    const turn = turnState('card_footer_transient_miss')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1, (code, failure) => {
      session.onCardWriteFailure(turn, turn.cardId, code, failure)
    })
    let footerAttempts = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (method === 'PUT' && path === `/cards/${turn.cardId}/elements/footer`) {
        footerAttempts++
        if (footerAttempts === 1) {
          return new Response(JSON.stringify({ code: 300308, msg: 'temporary footer reject' }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      session.startThinkingFooter(turn)
      await cardkit.flush(turn.cardId)
      expect(footerAttempts).toBe(1)
      expect(sentRawTexts).toHaveLength(0)
      expect(turn.cardWriteFailureNotices.size).toBe(0)

      session.startWritingFooter(turn)
      await cardkit.flush(turn.cardId)
      expect(footerAttempts).toBe(2)
      expect(sentRawTexts).toHaveLength(0)
      expect(turn.cardWriteFailureNotices.size).toBe(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

describe('Session lifecycle reliability', () => {
  test('daemon recovery finishes the saved thread initialization before delivering a queued message', async () => {
    const session = new Session('daemon-restore-input', 'chat_id') as any
    const ref = { provider: 'codex' as const, sessionId: 'saved-thread', cwd: session.workDir }
    session.selectedProvider = 'codex'
    // Match the source-less fake process, independently of registry test order.
    session.selectedTokenSourceId = null
    session.lastSessionRef = ref
    session.lastSessionId = ref.sessionId
    let releaseInit!: () => void
    let spawned!: () => void
    const spawnReady = new Promise<void>(resolve => { spawned = resolve })
    const proc = new FakeAgentProc('codex', ref.sessionId)
    proc.launchKind = 'resume'
    proc.initialization = new Promise<void>(resolve => { releaseInit = resolve })
    let spawnCount = 0
    session.spawnAgent = (source: unknown) => {
      expect(source).toEqual(ref)
      spawnCount++
      spawned()
      return proc
    }

    const restoration = session.restoreAfterDaemonRestart()
    await spawnReady
    const message = session.onUserMessage('重启期间收到的消息')
    await Promise.resolve()
    expect(proc.sentTexts).toEqual([])
    expect(session.shouldRevive()).toBe(true)
    proc.emit('init', { session_id: ref.sessionId })
    releaseInit()
    try {
      expect(await restoration).toBe(true)
      await message
      expect(spawnCount).toBe(1)
      expect(proc.killCalls).toBe(0)
      expect(proc.sentTexts).toEqual([`${fileDeliveryAgentContext('chat')}\n\n重启期间收到的消息`])
      expect(session.lastSessionId).toBe(ref.sessionId)
    } finally {
      await session.stop('测试收尾', { announce: false })
    }
  })

  test.each(['codex', 'claude', 'dsh'] as const)('failed %s daemon recovery blocks queued input and preserves the resume point until an explicit retry', async provider => {
    const session = new Session(`daemon-restore-failure-${provider}`, 'chat_id') as any
    const ref = { provider, sessionId: 'saved-thread', cwd: session.workDir }
    session.selectedProvider = provider
    if (provider === 'dsh') session.selectedEffort = 'off'
    session.lastSessionRef = ref
    session.lastSessionId = ref.sessionId
    resumeRefs.set(`${session.sessionName}:${provider}`, ref)
    let fail = true
    let spawnCount = 0
    session.spawnAgent = () => { spawnCount++; return new FakeAgentProc(provider, ref.sessionId) }
    const init = async () => fail
      ? { state: 'error', error: new Error('resume transport failed') }
      : { state: 'init' }
    session.waitForCodexInitialization = init
    session.waitForProcEarlyFailure = init

    expect(await session.restoreAfterDaemonRestart()).toBe(false)
    expect(session.shouldRevive()).toBe(true)
    await session.onUserMessage('不得开启新会话')
    expect(spawnCount).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.lastSessionId).toBe(ref.sessionId)
    expect(resumeRefs.get(`${session.sessionName}:${provider}`)).toEqual(ref)
    expect(sentTexts.join('\n')).toContain('这条消息未送给 Agent')
    expect(clearedResumes).toEqual([])

    fail = false
    expect(await session.restart(true, { announce: false })).toBe(true)
    expect(session.daemonRestoreRequired).toBe(false)
    expect(session.lastSessionId).toBe(ref.sessionId)
    await session.stop('测试收尾', { announce: false })
    expect(session.shouldRevive()).toBe(false)
  })

  test('daemon recovery without a resume point never creates a fresh conversation implicitly', async () => {
    const session = new Session('daemon-restore-missing', 'chat_id') as any
    let spawns = 0
    session.spawnAgent = () => { spawns++; return new FakeAgentProc('codex') }
    expect(await session.restoreAfterDaemonRestart()).toBe(false)
    await session.onUserMessage('不得创建新会话')
    expect(spawns).toBe(0)
    expect(session.shouldRevive()).toBe(true)
    await session.stop('用户明确停止', { announce: false })
    expect(session.shouldRevive()).toBe(false)
  })

  test('explicit fresh start clears a failed daemon recovery guard', async () => {
    const session = new Session('daemon-restore-fresh', 'chat_id') as any
    session.selectedProvider = 'codex'
    expect(await session.restoreAfterDaemonRestart()).toBe(false)
    const proc = new FakeAgentProc('codex', 'new-thread')
    proc.launchKind = 'fresh'
    session.spawnAgent = () => proc
    expect(await session.start({ announce: false })).toBe(true)
    expect(session.daemonRestoreRequired).toBe(false)
    await session.stop('测试收尾', { announce: false })
  })

  test('the outer initialization guard allows a ten-minute materialization read to finish', async () => {
    const session = new Session('daemon-restore-slow', 'chat_id') as any
    let now = 0
    let nextId = 1
    const timers = new Map<number, { due: number; callback: () => void }>()
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
      const id = nextId++
      timers.set(id, { due: now + delay, callback })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => { timers.delete(id) }) as typeof clearTimeout)
    let ready!: () => void
    const initialization = new Promise<void>(resolve => { ready = resolve })
    let outcome: unknown = null
    let notices = 0
    try {
      const waiting = session.waitForCodexInitialization(initialization, () => { notices++ })
      void waiting.then((result: unknown) => { outcome = result })
      for (const elapsed of [120_000, 660_000]) {
        now = elapsed
        for (const [id, timer] of timers) {
          if (timer.due > now) continue
          timers.delete(id)
          timer.callback()
        }
        await Promise.resolve()
        expect(outcome).toBeNull()
      }
      ready()
      expect(await waiting).toEqual({ state: 'init', error: undefined })
      expect(notices).toBe(1)
      expect(timers.size).toBe(0)
    } finally {
      timeout.mockRestore()
      clear.mockRestore()
    }
  })

  test('Codex init timeout is a failed start and never reports ready', async () => {
    const session = new Session('codex-timeout', 'chat_id') as any
    const proc = new FakeAgentProc('codex', null)
    const statuses: string[] = []
    session.selectedProvider = 'codex'
    session.spawnAgent = () => proc
    session.waitForCodexInitialization = async () => ({ state: 'timeout' })

    const ok = await session.start({
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(proc.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.status).toBe('stopped')
    expect(statuses.some(status => status.includes('启动超时'))).toBe(true)
    expect(statuses.some(status => status.includes('720 秒'))).toBe(true)
    expect(statuses.some(status => status.includes('已就绪'))).toBe(false)
  })

  test('Codex initialization rejection surfaces the method-specific error instead of the outer timeout', async () => {
    const session = new Session('codex-init-error', 'chat_id') as any
    const proc = new FakeAgentProc('codex', null)
    proc.initialization = Promise.reject(new Error(
      'codex app-server thread/start request timed out after 30000ms (id=2)',
    ))
    const statuses: string[] = []
    session.selectedProvider = 'codex'
    session.spawnAgent = () => proc

    const ok = await session.start({
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(proc.killCalls).toBe(1)
    expect(statuses.join('\n')).toContain('thread/start request timed out after 30000ms (id=2)')
    expect(statuses.join('\n')).not.toContain('启动超时')
    expect(statuses.join('\n')).not.toContain('已就绪')
  })

  test('Codex init failure also exposes an unconfirmed process termination', async () => {
    const session = new Session('codex-init-kill-fails', 'chat_id') as any
    const proc = new FakeAgentProc('codex', null)
    proc.initialization = Promise.reject(new Error('thread/start transport failed'))
    proc.kill = async () => {
      proc.killCalls++
      throw new Error('kill timeout')
    }
    session.selectedProvider = 'codex'
    session.spawnAgent = () => proc
    const statuses: string[] = []

    const ok = await session.start({
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(session.blockedProc).toBe(proc)
    expect(statuses.join('\n')).toContain('thread/start transport failed')
    expect(statuses.join('\n')).toContain('进程终止未确认: kill timeout')

    proc.alive = false
    proc.emit('exit', { code: null, signal: 'SIGKILL', expected: true })
  })

  test('confirmed no-rollout resume failure invalidates only the matching legacy ghost binding', async () => {
    const session = new Session('codex-ghost-resume', 'chat_id') as any
    const ghostId = '0198d6fa-1234-7000-8000-000000000001'
    const ghostRef = { provider: 'codex' as const, sessionId: ghostId, cwd: session.workDir }
    session.selectedProvider = 'codex'
    session.lastSessionRef = ghostRef
    session.lastSessionId = ghostRef.sessionId
    resumeRefs.set(`${session.sessionName}:codex`, ghostRef)
    const proc = new FakeAgentProc('codex', null)
    proc.launchKind = 'resume'
    proc.initialization = Promise.reject(new CodexRpcResponseError(
      'thread/resume', 2, -32600, `no rollout found for thread id ${ghostId}`,
    ))
    session.spawnAgent = () => proc
    const statuses: string[] = []

    const ok = await session.restart(true, {
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(proc.killCalls).toBe(1)
    expect(clearedResumes).toContainEqual([session.sessionName, 'codex'])
    expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)
    expect(session.lastSessionRef).toBeNull()
    expect(session.lastSessionId).toBeNull()
    expect(statuses.join('\n')).toContain(`no rollout found for thread id ${ghostId}`)
    expect(statuses.join('\n')).toContain('已作废无 rollout 的恢复点')
  })

  test('unrelated or mismatched Codex resume errors never clear a binding', () => {
    const session = new Session('codex-resume-keep', 'chat_id') as any
    const currentId = '0198d6fa-1234-7000-8000-000000000010'
    const olderId = '0198d6fa-1234-7000-8000-000000000011'
    const ref = { provider: 'codex' as const, sessionId: currentId, cwd: session.workDir }
    session.selectedProvider = 'codex'
    session.lastSessionRef = ref
    session.lastSessionId = ref.sessionId
    resumeRefs.set(`${session.sessionName}:codex`, ref)

    expect(session.invalidateMissingCodexResume(
      ref.sessionId,
      new Error('codex app-server thread/resume failed: account unavailable'),
    )).toBeNull()
    expect(session.invalidateMissingCodexResume(
      ref.sessionId,
      new CodexRpcResponseError(
        'thread/resume', 2, -32600, `no rollout found for thread id ${olderId}`,
      ),
    )).toBeNull()
    expect(session.invalidateMissingCodexResume(
      ref.sessionId,
      new CodexRpcResponseError(
        'thread/resume', 3, -32000, `no rollout found for thread id ${currentId}`,
      ),
    )).toBeNull()
    expect(session.invalidateMissingCodexResume(
      ref.sessionId,
      new CodexRpcResponseError(
        'thread/resume', 4, -32600, `prefix: no rollout found for thread id ${currentId}`,
      ),
    )).toBeNull()

    expect(clearedResumes).toEqual([])
    expect(resumeRefs.get(`${session.sessionName}:codex`)).toEqual(ref)
    expect(session.lastSessionId).toBe(ref.sessionId)
  })

  test('legacy cwd-null ghost binding is invalidated during thread/read migration', async () => {
    const session = new Session('codex-legacy-ghost', 'chat_id') as any
    const ghostId = '0198d6fa-1234-7000-8000-000000000099'
    const ghostRef = { provider: 'codex' as const, sessionId: ghostId, cwd: null }
    session.selectedProvider = 'codex'
    session.lastSessionRef = ghostRef
    session.lastSessionId = ghostId
    resumeRefs.set(`${session.sessionName}:codex`, ghostRef)
    session.resolveLegacyResumeRef = async () => {
      const readError = new CodexRpcResponseError(
        'thread/read', 2, -32600, `no rollout found for thread id ${ghostId}`,
      )
      const cleanupError = new Error('catalog kill timeout')
      throw new AggregateError(
        [readError, cleanupError],
        `Codex legacy resume lookup and cleanup failed: read=${readError.message}; cleanup=${cleanupError.message}`,
      )
    }
    let spawnCalls = 0
    session.spawnAgent = () => { spawnCalls++; return new FakeAgentProc('codex') }
    const statuses: string[] = []

    const ok = await session.restart(true, {
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(spawnCalls).toBe(0)
    expect(clearedResumes).toContainEqual([session.sessionName, 'codex'])
    expect(session.lastSessionRef).toBeNull()
    expect(session.lastSessionId).toBeNull()
    expect(statuses.join('\n')).toContain('旧会话不可恢复')
    expect(statuses.join('\n')).toContain('已作废无 rollout 的恢复点')
    expect(statuses.join('\n')).toContain('catalog kill timeout')
  })

  test('serializes concurrent restarts so a kill completes before either replacement spawn', async () => {
    const session = new Session('restart-race', 'chat_id') as any
    const initial = new FakeAgentProc('claude', 'session-initial')
    session.proc = initial
    session.selectedProvider = 'claude'
    session.waitForProcEarlyFailure = async () => ({ state: 'ready' })

    let releaseInitialKill: () => void = () => {}
    const initialKillGate = new Promise<void>(resolve => { releaseInitialKill = resolve })
    initial.kill = async () => {
      initial.killCalls++
      await initialKillGate
      initial.alive = false
      initial.emit('exit', { code: 0, signal: null, expected: true })
    }

    const spawned: FakeAgentProc[] = []
    const aliveAtSpawn: number[] = []
    session.spawnAgent = () => {
      aliveAtSpawn.push([initial, ...spawned].filter(proc => proc.alive).length)
      const proc = new FakeAgentProc('claude', `session-${spawned.length + 1}`)
      spawned.push(proc)
      return proc
    }

    const first = session.restart(false, { announce: false })
    const second = session.restart(false, { announce: false })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(initial.killCalls).toBe(1)
    expect(spawned).toHaveLength(0)
    releaseInitialKill()

    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(aliveAtSpawn).toEqual([0, 0])
    expect(spawned).toHaveLength(2)
    expect(spawned[0].killCalls).toBe(1)
    expect(spawned.filter(proc => proc.alive)).toEqual([spawned[1]])
    expect(session.proc).toBe(spawned[1])

    await session.stop('测试收尾', { announce: false })
  })

  test('restart freezes a Codex conversation that materializes while the old process is stopping', async () => {
    const session = new Session('restart-materialize-race', 'chat_id') as any
    session.selectedProvider = 'codex'
    const oldProc = new FakeAgentProc('codex', 'materialized-thread')
    oldProc.launchKind = 'fresh'
    oldProc.conversationResumable = false
    session.proc = oldProc
    session.wireProc(oldProc)
    oldProc.kill = async () => {
      oldProc.killCalls++
      oldProc.conversationResumable = true
      oldProc.emit('conversation_materialized', {
        session_id: oldProc.sessionId,
        source: 'turn/started notification',
      })
      oldProc.alive = false
      oldProc.emit('exit', { code: 0, signal: null, expected: true })
    }
    let resumedRef: any = null
    session.spawnAgent = (ref: any) => {
      resumedRef = ref
      const replacement = new FakeAgentProc('codex', ref?.sessionId ?? null)
      replacement.launchKind = 'resume'
      replacement.conversationResumable = true
      return replacement
    }

    const ok = await session.restart(true, { announce: false })

    expect(ok).toBe(true)
    expect(resumedRef).toEqual({
      provider: 'codex', sessionId: 'materialized-thread', cwd: session.workDir,
    })
    expect(session.lastSessionId).toBe('materialized-thread')
    expect(resumeRefs.get(`${session.sessionName}:codex`)?.sessionId).toBe('materialized-thread')
    await session.stop('测试收尾', { announce: false })
  })

  test('restart waits an in-flight Codex materialization verification before killing its owner', async () => {
    const session = new Session('restart-materialize-barrier', 'chat_id') as any
    session.selectedProvider = 'codex'
    const oldProc = new FakeAgentProc('codex', 'verified-thread')
    oldProc.launchKind = 'fresh'
    oldProc.conversationResumable = false
    let releaseVerification: () => void = () => {}
    oldProc.materializationBarrier = new Promise<void>(resolve => { releaseVerification = resolve })
    session.proc = oldProc
    session.wireProc(oldProc)
    let resumedRef: any = null
    session.spawnAgent = (ref: any) => {
      resumedRef = ref
      const replacement = new FakeAgentProc('codex', ref?.sessionId ?? null)
      replacement.launchKind = 'resume'
      return replacement
    }

    const restarting = session.restart(true, { announce: false })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(oldProc.killCalls).toBe(0)
    session.pendingMidTurnMsgs = [{
      text: 'must not drain', wireText: 'must not drain', userOpenId: '', msgId: '',
    }]
    oldProc.emit('result', { is_error: false, checkpoint: null })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(oldProc.sentTexts).toEqual([])
    expect(session.pendingMidTurnMsgs).toHaveLength(1)

    oldProc.conversationResumable = true
    releaseVerification()
    expect(await restarting).toBe(true)
    expect(oldProc.killCalls).toBe(1)
    expect(resumedRef?.sessionId).toBe('verified-thread')
    await session.stop('测试收尾', { announce: false })
  })

  test('restart preserves an idle fresh Codex process when its only resume point cannot be verified', async () => {
    const session = new Session('restart-materialize-fails-safe', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.status = 'idle'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    proc.materializationBarrier = Promise.reject(new Error('thread/read materialization timeout'))
    session.proc = proc
    session.wireProc(proc)
    let spawnCalls = 0
    session.spawnAgent = () => { spawnCalls++; return new FakeAgentProc('codex') }
    const statuses: string[] = []

    const ok = await session.restart(true, {
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(proc.killCalls).toBe(0)
    expect(spawnCalls).toBe(0)
    expect(session.proc).toBe(proc)
    expect(session.stoppingProc).toBeNull()
    expect(session.status).toBe('idle')
    expect(statuses.join('\n')).toContain('已保留当前进程')
    proc.materializationBarrier = null
    await session.stop('测试收尾', { announce: false })
  })

  test('stop persists a verified Codex materialization that lands during SIGTERM', async () => {
    const session = new Session('stop-materialize-race', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'materialized-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc
    session.wireProc(proc)
    proc.kill = async () => {
      proc.killCalls++
      proc.conversationResumable = true
      proc.emit('conversation_materialized', {
        session_id: proc.sessionId,
        source: 'turn/started notification',
      })
      proc.alive = false
      proc.emit('exit', { code: 0, signal: null, expected: true })
    }

    await session.stop('测试停止', { announce: false })

    expect(session.lastSessionId).toBe('materialized-thread')
    expect(resumeRefs.get(`${session.sessionName}:codex`)?.sessionId).toBe('materialized-thread')
  })

  test('stop fails transparently when the final materialized Codex resume point cannot fsync', async () => {
    const session = new Session('stop-materialize-fsync-fails', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'materialized-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc
    session.wireProc(proc)
    proc.kill = async () => {
      proc.killCalls++
      proc.conversationResumable = true
      proc.alive = false
      proc.emit('exit', { code: 0, signal: null, expected: true })
    }
    setResumeWriteError(new Error('final resume-map fsync failed'))

    try {
      await expect(session.stop('测试停止', { announce: false })).rejects.toThrow(
        'final resume-map fsync failed',
      )
      expect(session.status).toBe('stopped')
      expect(session.proc).toBeNull()
      expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)
      expect(sentRawTexts.some(text => text.includes('当前进程可继续'))).toBe(false)
    } finally {
      setResumeWriteError(null)
    }
  })

  test('a blocked Codex process that materializes before its late exit still commits resume and checkpoint', async () => {
    const session = new Session('blocked-late-materialize', 'chat_id') as any
    session.selectedProvider = 'codex'
    const proc = new FakeAgentProc('codex', 'fresh-thread')
    proc.launchKind = 'fresh'
    proc.conversationResumable = false
    session.proc = proc
    session.wireProc(proc)
    const checkpoint = {
      provider: 'codex' as const,
      kind: 'turn' as const,
      id: 'turn-fast',
      source: { provider: 'codex' as const, sessionId: 'fresh-thread', cwd: session.workDir },
    }
    proc.emit('result', { is_error: false, checkpoint })
    proc.kill = async () => {
      proc.killCalls++
      throw new Error('kill timeout')
    }

    await expect(session.stop('测试停止', { announce: false })).rejects.toThrow('kill timeout')
    expect(session.blockedProc).toBe(proc)
    proc.conversationResumable = true
    proc.alive = false
    proc.emit('exit', { code: null, signal: 'SIGKILL', expected: true })

    expect(session.proc).toBeNull()
    expect(resumeRefs.get(`${session.sessionName}:codex`)?.sessionId).toBe('fresh-thread')
    expect(turnAnchorsBySession.get(session.sessionName)?.[0]?.checkpoint).toEqual(checkpoint)
  })

  test('ignores late events from a replaced process generation', async () => {
    const session = new Session('stale-events', 'chat_id') as any
    const oldProc = new FakeAgentProc('claude', 'old-session')
    const currentProc = new FakeAgentProc('claude', 'current-session')
    session.attachProc(oldProc)
    session.attachProc(currentProc)
    session.initCount = 0

    oldProc.emit('init', { session_id: 'old-session' })
    oldProc.emit('assistant_text', { text: 'stale output', parentToolUseId: null })
    oldProc.emit('exit', { code: 0, signal: 'SIGTERM', expected: false })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(session.proc).toBe(currentProc)
    expect(session.initCount).toBe(0)
    expect(session.orphanAssistantCurrent).toBe('')
    expect(sentTexts.some(text => text.includes('异常退出'))).toBe(false)

    await session.stop('测试收尾', { announce: false })
  })

  test('an obsolete main-card open cannot replace a newer process turn or clear its opening owner', async () => {
    const session = new Session('stale-main-open', 'chat_id') as any
    const oldProc = new FakeAgentProc('claude', 'old-session')
    const newProc = new FakeAgentProc('claude', 'new-session')
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = null

    let releaseOldConvert: () => void = () => {}
    const oldConvertGate = new Promise<void>(resolve => { releaseOldConvert = resolve })
    let releaseNewConvert: () => void = () => {}
    const newConvertGate = new Promise<void>(resolve => { releaseNewConvert = resolve })
    let convertCount = 0
    const baseFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cards/id_convert')) {
        const n = ++convertCount
        if (n === 1) await oldConvertGate
        if (n === 2) await newConvertGate
        return new Response(JSON.stringify({ code: 0, data: { card_id: n === 1 ? 'card_old_open' : 'card_new_open' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return baseFetch(input, init)
    }) as typeof fetch

    try {
      session.attachProc(oldProc)
      session.pendingUserMessageCount = 1
      session.pendingTurnInputs = ['old input']
      oldProc.emit('init', { session_id: 'old-session' })
      await waitUntil(() => convertCount === 1)

      session.attachProc(newProc)
      session.pendingUserMessageCount = 1
      session.pendingTurnInputs = ['new input']
      newProc.emit('init', { session_id: 'new-session' })
      await waitUntil(() => convertCount === 2)

      releaseOldConvert()
      await waitUntil(() => calls.some(call =>
        call.method === 'PATCH' && call.path === '/cards/card_old_open/settings'
      ))
      expect(session.currentTurn).toBeNull()
      expect(session.openingTurn).toBe(true)

      releaseNewConvert()
      await waitUntil(() => session.currentTurn?.cardId === 'card_new_open' && !session.openingTurn)
      expect(session.currentTurn.cardId).toBe('card_new_open')
      expect(session.proc).toBe(newProc)
    } finally {
      releaseOldConvert()
      releaseNewConvert()
      if (session.currentTurn) await session.closeTurnCard('测试收尾')
      globalThis.fetch = baseFetch
    }
  })

  test('cold reset failure never leaves a main-card opening owner behind', async () => {
    const session = new Session('cold-reset-failure', 'chat_id') as any
    session.resetFreshConversationState = () => { throw new Error('reset failed') }

    await expect(session.startColdUserTurn('hello', 'hello', 'ou_user')).rejects.toThrow('reset failed')

    expect(session.openingTurn).toBe(false)
    expect(session.openingTurnOwner).toBeNull()
    expect(sentCards).toHaveLength(0)
  })

  test('opens a mid-turn card before feeding the buffered batch and drops input on card init failure', async () => {
    const session = new Session('midturn-card-first', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.pendingMidTurnMsgs = [{
      text: 'queued input', wireText: 'queued input', userOpenId: 'ou_user', msgId: 'om_queued',
    }]
    session.pendingReactionIds = new Map([['om_queued', 'reaction_waiting']])

    const baseFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cards/id_convert')) {
        return new Response(JSON.stringify({ code: 99, msg: 'convert failed' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return baseFetch(input, init)
    }) as typeof fetch

    try {
      await session.drainMidTurnAndOpen()

      expect(proc.sentTexts).toEqual([])
      expect(session.currentTurn).toBeNull()
      expect(session.status).toBe('idle')
      expect(sentRawTexts.join('\n')).toContain('尚未送给 Claude')
      expect(deletedReactions).toContainEqual(['om_queued', 'reaction_waiting'])
    } finally {
      globalThis.fetch = baseFetch
    }
  })

  test('unexpected exit terminalizes the main card, settles tasks, and alerts even for code=0 SIGTERM', async () => {
    const session = new Session('unexpected-exit', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    const turn = turnState('card_unexpected_exit')
    turn.userOpenId = ''
    session.currentTurn = turn
    session.backgroundTasks = [{
      id: 'bg-1', type: 'shell', description: 'still running', status: 'running',
      startedAt: Date.now(), steps: [],
    }]
    cardkit.recordCardCreated(turn.cardId, 1)
    session.attachProc(proc)

    proc.emit('exit', { code: 0, signal: 'SIGTERM', expected: false })
    await session.lifecycleTail

    expect(session.proc).toBeNull()
    expect(session.currentTurn).toBeNull()
    expect(session.backgroundTasks).toEqual([])
    expect(session.status).toBe('stopped')
    expect(sentTexts.some(text =>
      text.includes('异常退出') && text.includes('code=0') && text.includes('SIGTERM')
    )).toBe(true)
    const footerWrites = calls.filter(call =>
      call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`
    )
    expect(footerWrites.some(call => JSON.parse(call.body.element).content.includes('异常退出'))).toBe(true)
    expect(calls.some(call =>
      call.method === 'PATCH' && call.path === `/cards/${turn.cardId}/settings`
    )).toBe(true)
  })

  test('a three-hour turn uses hours in both the final footer and chat-list preview', async () => {
    const session = new Session('long-turn-duration', 'chat_id') as any
    const turn = turnState('card_long_turn_duration')
    turn.startedAt = Date.now() - 10_800_000
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    try {
      await session.closeTurnCard(undefined, { hasFreshResult: false })
      const footer = calls.find(call =>
        call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`
      )
      expect(JSON.parse(footer?.body.element ?? '{}').content).toContain('✅ ⏱ 3h')
      const settings = calls.find(call =>
        call.method === 'PATCH' && call.path === `/cards/${turn.cardId}/settings`
      )
      expect(JSON.parse(settings?.body.settings ?? '{}').config.summary.content).toBe('✅ · ⏱ 3h')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
      session.dispose()
    }
  })

  test('keeps CardKit state and sends fallback when the terminal footer transaction misses', async () => {
    const session = new Session('terminal-miss', 'chat_id') as any
    const turn = turnState('card_terminal_miss')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    const baseFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      if (method === 'PUT' && path === `/cards/${turn.cardId}/elements/footer`) {
        calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
        return new Response(JSON.stringify({ code: 300308, msg: 'footer rejected' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return baseFetch(input, init)
    }) as typeof fetch

    try {
      await session.closeTurnCard()

      expect(sentRawTexts.join('\n')).toContain('终态写入失败')
      expect(sentRawTexts.join('\n')).toContain('footer=MISS')
      // A disposed card returns false immediately. A successful repair PATCH
      // proves closeTurnCard deliberately retained the state after the miss.
      expect(await cardkit.patchSettingsChecked(turn.cardId, { config: { streaming_mode: false } })).toBe(true)
    } finally {
      globalThis.fetch = baseFetch
      await cardkit.dispose(turn.cardId)
    }
  })

  test('an old close snapshots usage and reactions without clearing the next turn', async () => {
    const session = new Session('close-snapshot', 'chat_id') as any
    const oldProc = new FakeAgentProc('codex', 'old-session')
    oldProc.lastUsage = { input_tokens: 100, output_tokens: 11, total_tokens: 111 }
    ;(oldProc as any).lastContextWindow = 1000
    session.proc = oldProc
    session.selectedProvider = 'codex'
    session.selectedTokenSourceId = null
    const oldTurn = turnState('card_close_snapshot_old')
    oldTurn.userOpenId = ''
    session.currentTurn = oldTurn
    session.lastTurnUsage = { input_tokens: 100, output_tokens: 11, total_tokens: 111 }
    session.lastTurnDelta = { tokens: 111, costUsd: 1.234, durationMs: 1000 }
    session.currentBatchReactionIds = new Map([['om_old_batch', 'rid_old_batch']])
    session.pendingReactionIds = new Map([['om_old_pending', 'rid_old_pending']])
    cardkit.recordCardCreated(oldTurn.cardId, 1)

    let signalFlushStarted: () => void = () => {}
    const flushStarted = new Promise<void>(resolve => { signalFlushStarted = resolve })
    let releaseFlush: () => void = () => {}
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
    const realFlush = cardkit.flush
    const flushSpy = spyOn(cardkit, 'flush').mockImplementation(async (cardId: string) => {
      if (cardId === oldTurn.cardId) {
        signalFlushStarted()
        await flushGate
      }
      await realFlush(cardId)
    })

    try {
      const closing = session.closeTurnCard(undefined, { hasFreshResult: true })
      await flushStarted

      const newProc = new FakeAgentProc('codex', 'new-session')
      newProc.lastUsage = { input_tokens: 9000, output_tokens: 999, total_tokens: 9999 }
      session.attachProc(newProc)
      const newTurn = turnState('card_close_snapshot_new')
      session.currentTurn = newTurn
      session.lastTurnUsage = { input_tokens: 9000, output_tokens: 999, total_tokens: 9999 }
      session.lastTurnDelta = { tokens: 9999, costUsd: 9.999, durationMs: 9000 }
      session.currentBatchReactionIds = new Map([['om_new_batch', 'rid_new_batch']])
      session.pendingReactionIds = new Map([['om_new_pending', 'rid_new_pending']])

      releaseFlush()
      await closing

      expect(session.currentTurn).toBe(newTurn)
      expect([...session.currentBatchReactionIds.entries()]).toEqual([['om_new_batch', 'rid_new_batch']])
      expect([...session.pendingReactionIds.entries()]).toEqual([['om_new_pending', 'rid_new_pending']])
      expect(deletedReactions).toContainEqual(['om_old_batch', 'rid_old_batch'])
      expect(deletedReactions).toContainEqual(['om_old_pending', 'rid_old_pending'])
      expect(deletedReactions).not.toContainEqual(['om_new_batch', 'rid_new_batch'])

      const footer = calls.find(call =>
        call.method === 'PUT' && call.path === `/cards/${oldTurn.cardId}/elements/footer`
      )
      const footerContent = JSON.parse(footer?.body.element ?? '{}').content as string
      expect(footerContent).toContain('$1.234')
      expect(footerContent).not.toContain('$9.999')
      const settingsCall = calls.find(call =>
        call.method === 'PATCH' && call.path === `/cards/${oldTurn.cardId}/settings`
      )
      const settings = JSON.parse(settingsCall?.body.settings ?? '{}')
      expect(settings.config.summary.content).toContain('📶 11')
      expect(settings.config.summary.content).not.toContain('999')
    } finally {
      releaseFlush()
      flushSpy.mockRestore()
      if (session.currentTurn) session.stopFooterStatus(session.currentTurn)
      session.currentTurn = null
      await cardkit.dispose(oldTurn.cardId)
    }
  })

  test('restart waits for a close that already removed currentTurn before spawning', async () => {
    const session = new Session('restart-close-owner', 'chat_id') as any
    const oldProc = new FakeAgentProc('claude', 'old-session')
    const oldTurn = turnState('card_restart_close_owner')
    oldTurn.provider = 'claude'
    oldTurn.userOpenId = ''
    session.proc = oldProc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = null
    session.currentTurn = oldTurn
    cardkit.recordCardCreated(oldTurn.cardId, 1)

    let signalFlushStarted: () => void = () => {}
    const flushStarted = new Promise<void>(resolve => { signalFlushStarted = resolve })
    let releaseFlush: () => void = () => {}
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
    const realFlush = cardkit.flush
    const flushSpy = spyOn(cardkit, 'flush').mockImplementation(async (cardId: string) => {
      if (cardId === oldTurn.cardId) {
        signalFlushStarted()
        await flushGate
      }
      await realFlush(cardId)
    })
    const spawned: FakeAgentProc[] = []
    session.spawnAgent = () => {
      const proc = new FakeAgentProc('claude', `new-session-${spawned.length + 1}`)
      spawned.push(proc)
      return proc
    }
    session.waitForProcEarlyFailure = async () => ({ state: 'ready' })

    try {
      const oldClose = session.closeTurnCard('旧轮收尾')
      await flushStarted
      expect(session.currentTurn).toBeNull()

      const restarting = session.restart(false, { announce: false })
      await waitUntil(() => oldProc.killCalls === 1)
      expect(spawned).toHaveLength(0)

      releaseFlush()
      await oldClose
      expect(await restarting).toBe(true)
      expect(spawned).toHaveLength(1)
      expect(session.proc).toBe(spawned[0])
    } finally {
      releaseFlush()
      flushSpy.mockRestore()
      if (session.proc?.isAlive()) await session.stop('测试收尾', { announce: false })
      await cardkit.dispose(oldTurn.cardId)
    }
  })

  test('Claude pending precommit failure leaves the old binding untouched and never starts replacement', async () => {
    const session = new Session('rollback-anchor-commit', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = null
    session.lastSessionId = 'old-session'
    session.lastSessionRef = { provider: 'claude', sessionId: 'old-session', cwd: session.workDir }
    const oldAnchor = {
      checkpoint: {
        provider: 'claude', kind: 'assistant-message', id: 'assistant-old',
        source: { provider: 'claude', sessionId: 'old-session', cwd: session.workDir },
      },
      preview: 'old input', ts: 1, writes: [],
    } as any
    const nextAnchor = {
      checkpoint: {
        provider: 'claude', kind: 'assistant-message', id: 'assistant-next',
        source: { provider: 'claude', sessionId: 'source-session', cwd: session.workDir },
      },
      preview: 'next input', ts: 2, writes: [],
    } as any
    turnAnchorsBySession.set(session.sessionName, [oldAnchor])
    branchBaseBySession.set(session.sessionName, { kind: 'fresh' })

    const replacement = new FakeAgentProc('claude', 'replacement-session')
    session.restartUnlocked = async () => {
      session.proc = replacement
      session.lastSessionId = 'replacement-session'
      session.lastSessionRef = { provider: 'claude', sessionId: 'replacement-session', cwd: session.workDir }
      session.status = 'idle'
      return true
    }
    const realReplace = feishu.replaceTurnAnchors
    let replaceCalls = 0
    const replaceSpy = spyOn(feishu, 'replaceTurnAnchors').mockImplementation((sessionName, anchors, base) => {
      replaceCalls++
      if (replaceCalls === 1) throw new Error('turn-map fsync failed')
      return realReplace(sessionName, anchors, base)
    })

    try {
      await expect(session.rollbackTo(
        {
          kind: 'fork',
          source: { provider: 'claude', sessionId: 'source-session', cwd: session.workDir },
          through: nextAnchor.checkpoint,
        },
        { anchors: [nextAnchor], base: { kind: 'fresh' } },
        { announce: false },
      )).rejects.toThrow('turn-map fsync failed')

      expect(replacement.killCalls).toBe(0)
      expect(session.proc).toBeNull()
      expect(session.status).toBe('stopped')
      expect(session.lastSessionId).toBe('old-session')
      expect(turnAnchorsBySession.get(session.sessionName)).toEqual([oldAnchor])
      expect(branchBaseBySession.get(session.sessionName)).toEqual({ kind: 'fresh' })
      expect(boundResumes).not.toContainEqual([session.sessionName, 'old-session', 'claude'])
      expect(replaceCalls).toBe(1)
    } finally {
      replaceSpy.mockRestore()
    }
  })

  test('Codex rollback stops replacement and restores state when post-start branch commit fails', async () => {
    const session = new Session('codex-rollback-anchor-commit', 'chat_id') as any
    session.selectedProvider = 'codex'
    session.selectedTokenSourceId = null
    session.lastSessionId = 'old-thread'
    session.lastSessionRef = { provider: 'codex', sessionId: 'old-thread', cwd: session.workDir }
    const oldAnchor = {
      checkpoint: {
        provider: 'codex', kind: 'turn', id: 'turn-old',
        source: { provider: 'codex', sessionId: 'old-thread', cwd: session.workDir },
      },
      preview: 'old input', ts: 1, writes: [],
    } as any
    const nextAnchor = {
      checkpoint: {
        provider: 'codex', kind: 'turn', id: 'turn-next',
        source: { provider: 'codex', sessionId: 'source-thread', cwd: session.workDir },
      },
      preview: 'next input', ts: 2, writes: [],
    } as any
    turnAnchorsBySession.set(session.sessionName, [oldAnchor])
    branchBaseBySession.set(session.sessionName, { kind: 'fresh' })

    const replacement = new FakeAgentProc('codex', 'replacement-thread')
    session.restartUnlocked = async () => {
      session.proc = replacement
      session.lastSessionId = 'replacement-thread'
      session.lastSessionRef = { provider: 'codex', sessionId: 'replacement-thread', cwd: session.workDir }
      session.status = 'idle'
      return true
    }
    const realReplace = feishu.replaceTurnAnchors
    let replaceCalls = 0
    const replaceSpy = spyOn(feishu, 'replaceTurnAnchors').mockImplementation((sessionName, anchors, base, pending) => {
      replaceCalls++
      if (replaceCalls === 1) throw new Error('turn-map fsync failed')
      return realReplace(sessionName, anchors, base, pending)
    })

    try {
      await expect(session.rollbackTo(
        {
          kind: 'fork',
          source: { provider: 'codex', sessionId: 'source-thread', cwd: session.workDir },
          through: nextAnchor.checkpoint,
        },
        { anchors: [nextAnchor], base: { kind: 'fresh' } },
        { announce: false },
      )).rejects.toThrow('turn-map fsync failed')

      expect(replacement.killCalls).toBe(1)
      expect(session.proc).toBeNull()
      expect(session.status).toBe('stopped')
      expect(session.lastSessionId).toBe('old-thread')
      expect(turnAnchorsBySession.get(session.sessionName)).toEqual([oldAnchor])
      expect(branchBaseBySession.get(session.sessionName)).toEqual({ kind: 'fresh' })
      expect(boundResumes).toContainEqual([session.sessionName, 'old-thread', 'codex'])
      expect(replaceCalls).toBe(2)
    } finally {
      replaceSpy.mockRestore()
    }
  })

  test('rollback never resurrects a previous Codex binding that app-server confirmed has no rollout', async () => {
    const session = new Session('codex-rollback-ghost', 'chat_id') as any
    const ghostId = '0198d6fa-1234-7000-8000-000000000077'
    const ghostRef = { provider: 'codex' as const, sessionId: ghostId, cwd: session.workDir }
    session.selectedProvider = 'codex'
    session.selectedTokenSourceId = null
    session.lastSessionId = ghostId
    session.lastSessionRef = ghostRef
    resumeRefs.set(`${session.sessionName}:codex`, ghostRef)
    const oldAnchor = {
      checkpoint: {
        provider: 'codex', kind: 'turn', id: 'turn-old', source: ghostRef,
      },
      preview: 'old input', ts: 1, writes: [],
    } as any
    turnAnchorsBySession.set(session.sessionName, [oldAnchor])
    branchBaseBySession.set(session.sessionName, { kind: 'fresh' })
    const replacement = new FakeAgentProc('codex', null)
    replacement.launchKind = 'fork'
    replacement.initialization = Promise.reject(new CodexRpcResponseError(
      'thread/fork', 2, -32600, `no rollout found for thread id ${ghostId}`,
    ))
    session.spawnAgent = () => replacement

    const ok = await session.rollbackTo(
      { kind: 'fork', source: ghostRef },
      { anchors: [], base: { kind: 'fork', source: ghostRef } },
      { announce: false },
    )

    expect(ok).toBe(false)
    expect(replacement.killCalls).toBe(1)
    expect(resumeRefs.has(`${session.sessionName}:codex`)).toBe(false)
    expect(session.lastSessionRef).toBeNull()
    expect(session.lastSessionId).toBeNull()
    expect(turnAnchorsBySession.get(session.sessionName)).toEqual([oldAnchor])
    expect(branchBaseBySession.get(session.sessionName)).toEqual({ kind: 'fresh' })
  })

  test('rollback retains the prior binding when confirmed-ghost cleanup itself fails', async () => {
    const session = new Session('codex-rollback-ghost-clear-fails', 'chat_id') as any
    const ghostId = '0198d6fa-1234-7000-8000-000000000078'
    const ghostRef = { provider: 'codex' as const, sessionId: ghostId, cwd: session.workDir }
    session.selectedProvider = 'codex'
    session.selectedTokenSourceId = null
    session.lastSessionId = ghostId
    session.lastSessionRef = ghostRef
    resumeRefs.set(`${session.sessionName}:codex`, ghostRef)
    const replacement = new FakeAgentProc('codex', null)
    replacement.launchKind = 'fork'
    replacement.initialization = Promise.reject(new CodexRpcResponseError(
      'thread/fork', 2, -32600, `no rollout found for thread id ${ghostId}`,
    ))
    session.spawnAgent = () => replacement
    const clearSpy = spyOn(feishu, 'clearSessionResumeChecked').mockImplementation(() => {
      throw new Error('ghost cleanup fsync failed')
    })

    try {
      const ok = await session.rollbackTo(
        { kind: 'fork', source: ghostRef },
        { anchors: [], base: { kind: 'fork', source: ghostRef } },
        { announce: false },
      )

      expect(ok).toBe(false)
      expect(session.lastSessionRef).toEqual(ghostRef)
      expect(session.lastSessionId).toBe(ghostId)
      expect(resumeRefs.get(`${session.sessionName}:codex`)).toEqual(ghostRef)
    } finally {
      clearSpy.mockRestore()
    }
  })

  test('rollback stops an attached replacement when restart throws after it became ready', async () => {
    const session = new Session('rollback-ready-throw', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = null
    session.lastSessionId = 'old-session'
    session.lastSessionRef = { provider: 'claude', sessionId: 'old-session', cwd: session.workDir }
    const oldAnchor = {
      checkpoint: {
        provider: 'claude', kind: 'assistant-message', id: 'assistant-old',
        source: { provider: 'claude', sessionId: 'old-session', cwd: session.workDir },
      },
      preview: 'old input', ts: 1, writes: [],
    } as any
    turnAnchorsBySession.set(session.sessionName, [oldAnchor])
    branchBaseBySession.set(session.sessionName, { kind: 'fresh' })
    const replacement = new FakeAgentProc('claude', 'replacement-session')
    session.restartUnlocked = async () => {
      session.proc = replacement
      session.lastSessionId = 'replacement-session'
      session.lastSessionRef = { provider: 'claude', sessionId: 'replacement-session', cwd: session.workDir }
      session.status = 'idle'
      throw new Error('ready callback failed')
    }

    await expect(session.rollbackTo({
      kind: 'resume',
      source: { provider: 'claude', sessionId: 'source-session', cwd: session.workDir },
    })).rejects.toThrow('ready callback failed')

    expect(replacement.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.status).toBe('stopped')
    expect(session.lastSessionId).toBe('old-session')
    expect(turnAnchorsBySession.get(session.sessionName)).toEqual([oldAnchor])
    expect(branchBaseBySession.get(session.sessionName)).toEqual({ kind: 'fresh' })
  })

  test('Claude rs precommits pending fork intent before restart and restores it on failure', async () => {
    const session = new Session('pending-rollback', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = 'previous-session'
    session.lastSessionRef = {
      provider: 'claude', sessionId: 'previous-session', cwd: session.workDir,
    }
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    let sawPrecommit = false
    session.restartUnlocked = async () => {
      sawPrecommit = pendingConversationLaunchBySession.get(session.sessionName)?.launch.source.sessionId === 'source-session'
      return false
    }

    const ok = await session.rollbackTo(launch, {
      anchors: [], base: launch,
    })

    expect(ok).toBe(false)
    expect(sawPrecommit).toBe(true)
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingConversationMaterialization).toBeNull()
  })

  test('Claude startForked persists pending intent before startup grace', async () => {
    const session = new Session('pending-start-forked', 'chat_id') as any
    session.selectedProvider = 'claude'
    session.lastSessionId = null
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    let sawPrecommit = false
    session.startUnlocked = async () => {
      sawPrecommit = pendingConversationLaunchBySession.has(session.sessionName)
      return true
    }

    expect(await session.startForked(launch)).toBe(true)
    expect(sawPrecommit).toBe(true)
    expect(pendingConversationLaunchBySession.get(session.sessionName)).toEqual({
      launch,
      previousSessionId: null,
    })
  })

  test('constructor restores pending fork or materialized resume without silent fresh start', () => {
    const pendingName = 'pending-reload'
    const pendingCwd = `/tmp/lodestar-projects/${pendingName}`
    const pending = {
      launch: {
        kind: 'fork' as const,
        source: { provider: 'claude' as const, sessionId: 'source-session', cwd: pendingCwd },
      },
      previousSessionId: 'previous-session',
    }
    modelSelections.set(pendingName, {
      provider: 'claude', model: 'claude-opus-4-6', effort: 'high', tokenSourceId: 'claude-native',
    })
    resumeRefs.set(`${pendingName}:claude`, {
      provider: 'claude', sessionId: 'previous-session', cwd: pendingCwd,
    })
    pendingConversationLaunchBySession.set(pendingName, pending)
    const beforeInit = new Session(pendingName, 'chat_pending') as any
    expect(beforeInit.pendingMaterializationLaunch()).toEqual(pending.launch)

    const materializedName = 'pending-materialized-reload'
    const materializedCwd = `/tmp/lodestar-projects/${materializedName}`
    const materializedPending = {
      launch: {
        kind: 'fork' as const,
        source: { provider: 'claude' as const, sessionId: 'source-session', cwd: materializedCwd },
      },
      previousSessionId: 'previous-session',
    }
    modelSelections.set(materializedName, {
      provider: 'claude', model: 'claude-opus-4-6', effort: 'high', tokenSourceId: 'claude-native',
    })
    resumeRefs.set(`${materializedName}:claude`, {
      provider: 'claude', sessionId: 'new-materialized-session', cwd: materializedCwd,
    })
    pendingConversationLaunchBySession.set(materializedName, materializedPending)
    const afterInit = new Session(materializedName, 'chat_materialized') as any
    expect(afterInit.pendingMaterializationLaunch()).toEqual({
      kind: 'resume',
      source: {
        provider: 'claude', sessionId: 'new-materialized-session', cwd: materializedCwd,
      },
    })
  })

  test('Claude init binds the new id and first result consumes the durable pending marker', () => {
    const session = new Session('pending-materialize', 'chat_id') as any
    session.selectedProvider = 'claude'
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    const pending = { launch, previousSessionId: 'previous-session' }
    session.lastSessionId = 'previous-session'
    session.lastSessionRef = {
      provider: 'claude', sessionId: 'previous-session', cwd: session.workDir,
    }
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    session.proc = new FakeAgentProc('claude', 'new-session')

    expect(session.persistResumableSessionId(true)).toBeNull()
    expect(resumeRefs.get(`${session.sessionName}:claude`)?.sessionId).toBe('new-session')
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(true)
    expect(session.pendingMaterializationLaunch()).toEqual({
      kind: 'resume',
      source: { provider: 'claude', sessionId: 'new-session', cwd: session.workDir },
    })

    expect(session.consumePendingConversationMaterialization()).toBeNull()
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingConversationMaterialization).toBeNull()
  })

  test('Claude init rejects a fork that reuses source or previous session id', () => {
    const session = new Session('pending-same-id', 'chat_id') as any
    session.selectedProvider = 'claude'
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    const pending = { launch, previousSessionId: 'source-session' }
    session.lastSessionId = 'source-session'
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    session.proc = new FakeAgentProc('claude', 'source-session')

    expect(() => session.persistResumableSessionId(true)).toThrow('did not materialize an independent session id')
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(true)
  })

  test('Claude result without a session id keeps the durable fork intent', () => {
    const session = new Session('pending-missing-session-id', 'chat_id') as any
    session.selectedProvider = 'claude'
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    const pending = { launch, previousSessionId: 'previous-session' }
    session.lastSessionId = 'previous-session'
    session.lastSessionRef = {
      provider: 'claude', sessionId: 'previous-session', cwd: session.workDir,
    }
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    session.proc = new FakeAgentProc('claude', null)

    expect(session.persistResumableSessionId()).toContain('did not provide a materialized session id')
    expect(session.consumePendingConversationMaterialization()).toContain('保留 pending marker')
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(true)
  })

  test('Codex constructor clears stale Claude pending before validating its old cwd', () => {
    const sessionName = 'codex-clears-stale-claude-pending'
    modelSelections.set(sessionName, {
      provider: 'codex', model: 'gpt-5.6-sol', effort: 'low', tokenSourceId: 'codex-sub',
    })
    pendingConversationLaunchBySession.set(sessionName, {
      launch: {
        kind: 'fork',
        source: { provider: 'claude', sessionId: 'source-session', cwd: '/srv/old-claude-project' },
      },
      previousSessionId: null,
    })

    expect(() => new Session(sessionName, 'chat_id')).not.toThrow()
    expect(pendingConversationLaunchBySession.has(sessionName)).toBe(false)
  })

  test('explicit fresh and provider switch clear pending intent before changing routing', async () => {
    const session = new Session('pending-clear', 'chat_id') as any
    session.selectedProvider = 'claude'
    const launch = {
      kind: 'fork' as const,
      source: { provider: 'claude' as const, sessionId: 'source-session', cwd: session.workDir },
    }
    const pending = { launch, previousSessionId: null }
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    session.startUnlocked = async () => true

    expect(await session.restartUnlocked(false, { announce: false })).toBe(true)
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(false)
    expect(session.pendingConversationMaterialization).toBeNull()

    session.selectedProvider = 'claude'
    session.pendingConversationMaterialization = pending
    pendingConversationLaunchBySession.set(session.sessionName, pending)
    setTurnAnchorWriteError(new Error('turn state fsync failed'))
    await expect(session.applyModelSelectionUnlocked('codex', 'gpt-5.6-sol', 'low', 'codex-sub'))
      .rejects.toThrow('turn state fsync failed')
    expect(session.selectedProvider).toBe('claude')
    expect(pendingConversationLaunchBySession.has(session.sessionName)).toBe(true)
    setTurnAnchorWriteError(null)
  })

  test('result still terminalizes the turn when resume-map persistence fails', async () => {
    const session = new Session('resume-write-result', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-current')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.wireProc(proc)
    const turn = turnState('card_resume_write_result')
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)
    proc.lastResult = {
      cost_usd: null, cost_delta_usd: null, duration_ms: 1, num_turns: 1,
      usage: null, subtype: 'success', is_error: false,
    }
    setResumeWriteError(new Error('resume-map fsync failed'))

    proc.emit('result', {
      subtype: 'success', is_error: false, duration_ms: 1, usage: null,
      checkpoint: {
        provider: 'codex', kind: 'turn', id: 'turn-1',
        source: { provider: 'codex', sessionId: 'thread-current', cwd: session.workDir },
      },
    })

    await waitUntil(() => session.currentTurn === null)
    expect(session.status).toBe('idle')
    expect(session.lastSessionId).toBe('thread-current')
    expect(sentRawTexts.some(text => text.includes('resume-map fsync failed'))).toBe(true)
    setResumeWriteError(null)
  })

  test('result exposes checkpoint persistence failure and does not retain an in-memory-only anchor', async () => {
    const session = new Session('anchor-write-result', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-current')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.wireProc(proc)
    proc.lastResult = {
      cost_usd: null, cost_delta_usd: null, duration_ms: 1, num_turns: 1,
      usage: null, subtype: 'success', is_error: false,
    }
    setTurnAnchorWriteError(new Error('turn-map fsync failed'))

    proc.emit('result', {
      subtype: 'success', is_error: false, duration_ms: 1, usage: null,
      checkpoint: {
        provider: 'codex', kind: 'turn', id: 'turn-1',
        source: { provider: 'codex', sessionId: 'thread-current', cwd: session.workDir },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(session.status).toBe('idle')
    expect(turnAnchorsBySession.has(session.sessionName)).toBe(false)
    expect(sentRawTexts.some(text => text.includes('turn-map fsync failed'))).toBe(true)
    setTurnAnchorWriteError(null)
  })

  test('result racing card open carries checkpoint persistence failure into deferred close', () => {
    const session = new Session('anchor-write-open-race', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'thread-current')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.wireProc(proc)
    proc.lastResult = {
      cost_usd: null, cost_delta_usd: null, duration_ms: 1, num_turns: 1,
      usage: null, subtype: 'success', is_error: false,
    }
    const owner = session.beginTurnOpen(proc, session.procEpoch)
    setTurnAnchorWriteError(new Error('turn-map race failed'))

    proc.emit('result', {
      subtype: 'success', is_error: false, duration_ms: 1, usage: null,
      checkpoint: {
        provider: 'codex', kind: 'turn', id: 'turn-race',
        source: { provider: 'codex', sessionId: 'thread-current', cwd: session.workDir },
      },
    })

    expect(owner.sawResult).toBe(true)
    expect(owner.terminalSuffix).toContain('turn-map race failed')
    expect(owner.terminalForcePush).toBe(true)
    session.releaseTurnOpen(owner)
    setTurnAnchorWriteError(null)
  })

  test('stop clears visible state but keeps an unconfirmed process blocked until its real exit', async () => {
    const session = new Session('stop-kill-failure', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    const lifecycleSnapshots: Array<{ shouldRevive: boolean; status: string }> = []
    session.opts.onLifecycleChange = () => {
      lifecycleSnapshots.push({ shouldRevive: session.shouldRevive(), status: session.status })
    }
    proc.kill = async () => {
      // The persisted alive marker callback must run before the first kill
      // await, while the explicit stop intent already excludes this process.
      expect(lifecycleSnapshots[0]).toEqual({ shouldRevive: false, status: 'stopped' })
      throw new Error('kill timeout')
    }
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_stop_kill_failure')
    session.pendingMidTurnMsgs = [{ text: 'queued', wireText: 'queued', userOpenId: '', msgId: '' }]
    session.backgroundTasks = [{
      id: 'bg', type: 'shell', description: 'running', status: 'running', startedAt: Date.now(), steps: [],
    }]

    await expect(session.stop('测试', { announce: false })).rejects.toThrow('kill timeout')
    expect(session.proc).toBe(proc)
    expect(session.blockedProc).toBe(proc)
    expect(session.shouldRevive()).toBe(false)
    expect(session.currentTurn).toBeNull()
    expect(session.pendingMidTurnMsgs).toEqual([])
    expect(session.backgroundTasks).toEqual([])
    expect(session.status).toBe('stopped')
    expect(lifecycleSnapshots.length).toBeGreaterThanOrEqual(2)
    await session.onUserMessage('must not spawn or feed')
    expect(proc.sentTexts).toEqual([])
    expect(sentTexts.some(text => text.includes('会话已阻断'))).toBe(true)

    proc.alive = false
    proc.emit('exit', { code: 0, signal: 'SIGKILL', expected: true })
    expect(session.proc).toBeNull()
    expect(session.blockedProc).toBeNull()
  })

  test('restart does not spawn after kill failure and still clears stale lifecycle state', async () => {
    const session = new Session('restart-kill-failure', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    proc.kill = async () => { throw new Error('kill timeout') }
    let spawnCalls = 0
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turnState('card_restart_kill_failure')
    session.pendingUserMessageCount = 1
    session.spawnAgent = () => { spawnCalls++; return new FakeAgentProc('claude') }

    expect(await session.restart(false, { announce: false })).toBe(false)
    expect(spawnCalls).toBe(0)
    expect(session.proc).toBe(proc)
    expect(session.blockedProc).toBe(proc)
    expect(session.currentTurn).toBeNull()
    expect(session.pendingUserMessageCount).toBe(0)
    expect(session.status).toBe('stopped')

    expect(await session.start({ announce: false })).toBe(false)
    expect(spawnCalls).toBe(0)
    proc.alive = false
    proc.emit('exit', { code: 0, signal: 'SIGKILL', expected: true })
    expect(session.proc).toBeNull()
  })

  test('legacy resume cwd verification fails before an existing process is killed', async () => {
    const session = new Session('legacy-resume-cwd', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'running-thread')
    session.selectedProvider = 'codex'
    session.proc = proc
    session.status = 'idle'
    session.lastSessionId = 'legacy-thread'
    session.lastSessionRef = { provider: 'codex', sessionId: 'legacy-thread', cwd: null }
    session.resolveLegacyResumeRef = async () => { throw new Error('stored cwd mismatch') }

    expect(await session.restart(true, { announce: false })).toBe(false)
    expect(proc.killCalls).toBe(0)
    expect(session.proc).toBe(proc)
    expect(session.status).toBe('idle')
  })

  test('process ownership still becomes blocked when kill and terminal cleanup both fail', async () => {
    const session = new Session('stop-double-failure', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    proc.kill = async () => { throw new Error('kill timeout') }
    session.proc = proc
    session.wireProc(proc)
    session.resetBackgroundTasks = async () => { throw new Error('background cleanup failed') }

    await expect(session.stop('测试', { announce: false })).rejects.toThrow(
      /stop failed: kill timeout; background cleanup failed/,
    )

    expect(session.proc).toBe(proc)
    expect(session.stoppingProc).toBeNull()
    expect(session.blockedProc).toBe(proc)
    expect(session.shouldRevive()).toBe(false)
    await session.onUserMessage('must remain blocked')
    expect(proc.sentTexts).toEqual([])

    proc.alive = false
    proc.emit('exit', { code: 0, signal: 'SIGKILL', expected: true })
  })

  test('restart surfaces cleanup separately and never spawns after a failed stop transaction', async () => {
    const session = new Session('restart-double-failure', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    const statuses: string[] = []
    let spawnCalls = 0
    proc.kill = async () => { throw new Error('kill timeout') }
    session.proc = proc
    session.wireProc(proc)
    session.resetBackgroundTasks = async () => { throw new Error('background cleanup failed') }
    session.spawnAgent = () => { spawnCalls++; return new FakeAgentProc('claude') }

    expect(await session.restart(false, {
      announce: false,
      onStatus: (status: string) => statuses.push(status),
    })).toBe(false)

    expect(spawnCalls).toBe(0)
    expect(session.blockedProc).toBe(proc)
    expect(statuses.join('\n')).toContain('kill=kill timeout')
    expect(statuses.join('\n')).toContain('cleanup=background cleanup failed')

    proc.alive = false
    proc.emit('exit', { code: 0, signal: 'SIGKILL', expected: true })
  })

  test('kill command terminalizes its status card with the blocked-process failure', async () => {
    const session = new Session('kill-command-failure', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    proc.kill = async () => { throw new Error('kill timeout') }
    session.proc = proc
    session.wireProc(proc)

    await expect(session.runCommand('kill')).resolves.toBe(true)

    const footerContents = calls
      .filter(call => call.method === 'PUT' && call.path.includes('/elements/footer'))
      .map(call => JSON.parse(call.body.element).content as string)
    expect(footerContents.some(content =>
      content.includes('未确认终止') && content.includes('会话已阻断') && content.includes('kill timeout')
    )).toBe(true)
    const terminalSettings = calls
      .filter(call => call.method === 'PATCH' && call.path.endsWith('/settings'))
      .map(call => JSON.parse(call.body.settings))
    expect(terminalSettings.some(settings => settings?.config?.streaming_mode === false)).toBe(true)

    proc.alive = false
    proc.emit('exit', { code: 0, signal: 'SIGKILL', expected: true })
  })

  test('retains static card state when mutation reopens streaming and close also fails', async () => {
    const session = new Session('static-card-miss', 'chat_id') as any
    const cardId = 'card_static_miss'
    cardkit.recordCardCreated(cardId, 1)
    const baseFetch = globalThis.fetch
    let replaceAttempts = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/open-apis/cardkit/v1', '')
      const method = String(init?.method ?? 'GET')
      if (method === 'PUT' && path.includes('/elements/')) {
        replaceAttempts++
        return new Response(JSON.stringify(replaceAttempts === 1
          ? { code: 300309, msg: 'stream closed' }
          : { code: 300308, msg: 'replace rejected' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'PATCH' && path.endsWith('/settings')) {
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        const settings = JSON.parse(String(body.settings ?? '{}'))
        const reopening = settings?.config?.streaming_mode === true
        return new Response(JSON.stringify(reopening
          ? { code: 0, data: {} }
          : { code: 300308, msg: 'close rejected' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return baseFetch(input, init)
    }) as typeof fetch

    try {
      const landed = await session.mutateStaticCard(cardId, 'test static', async () => {
        const replaced = await cardkit.replaceElementChecked(cardId, 'panel', {
          tag: 'markdown', element_id: 'panel', content: 'new',
        }, { notifyCardFailure: false })
        if (!replaced) throw new Error('replace failed')
      })
      expect(landed).toBe(false)
    } finally {
      globalThis.fetch = baseFetch
    }
    // A disposed/tombstoned card would return false without an HTTP call.
    expect(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })).toBe(true)
    await cardkit.dispose(cardId)
  })

  test('retains static card state when the checked mutation misses even if streaming-off lands', async () => {
    const session = new Session('static-mutation-miss', 'chat_id') as any
    const cardId = 'card_static_mutation_miss'
    cardkit.recordCardCreated(cardId, 1)

    expect(await session.mutateStaticCard(cardId, 'test static', async () => {
      throw new Error('mutation MISS')
    })).toBe(false)

    // A disposed card returns false immediately; true proves the failed
    // mutation retained repairable CardKit state.
    expect(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })).toBe(true)
    await cardkit.dispose(cardId)
  })

  test('hard stop terminalizes an active main card before releasing lifecycle ownership', async () => {
    const session = new Session('stop-active-card', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    const turn = turnState('card_stop_active')
    turn.userOpenId = ''
    session.proc = proc
    session.wireProc(proc)
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    await session.stop('测试停止', { announce: false })

    const footer = calls.find(call =>
      call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`
    )
    expect(JSON.parse(footer?.body.element ?? '{}').content).toContain('🛑 测试停止')
    expect(calls.some(call =>
      call.method === 'PATCH' && call.path === `/cards/${turn.cardId}/settings`
    )).toBe(true)
  })

  test('a user message owns the lifecycle mutex before a subsequently queued restart', async () => {
    const session = new Session('message-lifecycle-mutex', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = null
    session.initCount = 1
    session.status = 'idle'

    let signalOpenStarted: () => void = () => {}
    const openStarted = new Promise<void>(resolve => { signalOpenStarted = resolve })
    let releaseOpen: () => void = () => {}
    const openGate = new Promise<void>(resolve => { releaseOpen = resolve })
    session.openTurnCard = async () => {
      signalOpenStarted()
      await openGate
      const turn = turnState('card_message_mutex')
      turn.userOpenId = ''
      session.currentTurn = turn
      cardkit.recordCardCreated(turn.cardId, 1)
      return turn
    }
    const spawned: FakeAgentProc[] = []
    session.spawnAgent = () => {
      const next = new FakeAgentProc('claude', `session-next-${spawned.length}`)
      spawned.push(next)
      return next
    }
    session.waitForProcEarlyFailure = async () => ({ state: 'ready' })

    const message = session.onUserMessage('first')
    await openStarted
    const restart = session.restart(false, { announce: false })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(proc.killCalls).toBe(0)

    releaseOpen()
    await message
    expect(proc.sentTexts).toEqual([`${fileDeliveryAgentContext('chat')}\n\nfirst`])
    expect(await restart).toBe(true)
    expect(proc.killCalls).toBe(1)
    expect(session.proc).toBe(spawned[0])
    await session.stop('测试收尾', { announce: false })
  })

  test('persisted model selection cannot mutate Session state while a user message owns lifecycle', async () => {
    const session = new Session('model-lifecycle-mutex', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = null
    session.initCount = 1

    let signalOpenStarted: () => void = () => {}
    const openStarted = new Promise<void>(resolve => { signalOpenStarted = resolve })
    let releaseOpen: () => void = () => {}
    const openGate = new Promise<void>(resolve => { releaseOpen = resolve })
    session.openTurnCard = async () => {
      signalOpenStarted()
      await openGate
      const turn = turnState('card_model_mutex')
      turn.userOpenId = ''
      session.currentTurn = turn
      cardkit.recordCardCreated(turn.cardId, 1)
      return turn
    }

    const message = session.onUserMessage('first')
    await openStarted
    const selection = session.applyModelSelection('codex', 'gpt-5.6-sol', 'xhigh', 'codex-sub')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(session.selectedProvider).toBe('claude')

    releaseOpen()
    await message
    await selection
    expect(session.selectedProvider).toBe('codex')
    await session.stop('测试收尾', { announce: false })
  })

  test('card action helpers report stale, invalid, and internal failures explicitly', async () => {
    const session = new Session('action-outcomes', 'chat_id') as any

    expect(await session.onPermissionDecision('missing', 'allow', 'ou_user')).toEqual({
      ok: false,
      message: '此权限请求已失效或已处理',
    })
    const proc = new FakeAgentProc('claude', 'session-1')
    proc.sendPermissionResponse = () => { throw new Error('pipe closed') }
    session.proc = proc
    session.pendingPermissions.set('perm-1', { toolUseId: 'tool-1' })
    const failedPermission = await session.onPermissionDecision('perm-1', 'allow', 'ou_user')
    expect(failedPermission.ok).toBe(false)
    expect(failedPermission.message).toContain('pipe closed')
    expect(session.pendingPermissions.has('perm-1')).toBe(true)

    expect(await session.onAskAnswer('missing', 0, 0, 'ou_user')).toBe(false)
    session.pendingAsks.set('ask-1', {
      questions: [{ question: 'Pick?', options: [{ label: 'A' }] }],
      i: 0,
      answers: {},
      answered: new Map(),
      currentIdx: 0,
    })
    expect(await session.onAskAnswer('ask-1', 1, 0, 'ou_user')).toBe(false)
    expect(await session.onAskAnswer('ask-1', 0, 9, 'ou_user')).toBe(false)
    expect(await session.onAskAnswer('ask-1', 0, 0, 'ou_user')).toBe(true)

    session.selectedProvider = 'codex'
    expect((await session.onForkSelect(0, 'ou_user')).ok).toBe(false)
    expect((await session.onBackSelect(0)).ok).toBe(false)
    expect((await session.onResumeSelect('session-1')).ok).toBe(false)
  })
})
