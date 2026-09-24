import { afterEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHILD_FLAG = 'LODESTAR_MODEL_CUSTOM_TEST_CHILD'

if (process.env[CHILD_FLAG] !== '1') {
  test('补录回复原位更新卡片:通过→effort 选择面板,失败→红字面板,不单发消息', async () => {
    // Bun 的 mock.module 是进程级的，无法在单个测试文件结束时可靠恢复。
    // 把需要模块 mock 的集成场景放进独立测试进程，避免随机文件顺序改变
    // token-source-models / model-existence 的真实导出与行为。
    const child = Bun.spawn({
      cmd: [process.execPath, 'test', import.meta.path],
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, [CHILD_FLAG]: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) {
      throw new Error(`isolated model-custom test failed\n${stdout}\n${stderr}`)
    }
    expect(exitCode).toBe(0)
  })
} else {
  const dir = mkdtempSync(join(tmpdir(), 'lodestar-card-'))
  writeFileSync(join(dir, 'config.toml'), `[feishu]
app_id = "x"
app_secret = "s"
[token_source.glm]
base_url = "https://open.bigmodel.cn/api/anthropic"
auth_token = "test-token"
`)
  process.env.LODESTAR_CONFIG = join(dir, 'config.toml')
  process.env.LODESTAR_DATA_DIR = join(dir, 'data')
  mkdirSync(join(dir, 'data'))

  let modelFetches = 0
  let rejectCatalog = false
  // 这些 module mock 只存在于上面的独立子进程，不会污染主测试进程。
  mock.module('./model-existence', () => ({
    verifyModelExists: async (_b: string, _h: Record<string, string>, model: string) =>
      ['glm-5.3', 'glm-5.4'].includes(model.toLowerCase()) ? 'exists' : 'not_found',
  }))
  mock.module('./token-source-models', () => ({
    CLAUDE_EFFORTS: ['max', 'xhigh', 'high', 'medium', 'low'],
    fetchGlmModels: async () => {
      modelFetches++
      if (rejectCatalog) throw new Error('catalog unavailable')
      return [{ model: 'GLM-5.2', display: 'GLM-5.2', efforts: ['max'], defaultEffort: 'max' }]
    },
    fetchCodexModels: async () => [],
    fetchNativeClaudeModels: async () => [],
  }))
  // 本文件只验证 Claude 补录卡，不启动其他来源的原生目录进程。
  mock.module('./token-source-dsh-glm', () => ({}))

  const elementPatches: any[] = []
  const rawFallbacks: string[] = []
  let convertedCardId = 'card_fake'
  let rejectElementPatch = false
  let rejectIdConvert = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/open-apis/cardkit/v1', '')
    if (path.endsWith('/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-token' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (path === '/cards/id_convert') {
      if (rejectIdConvert) {
        return new Response(JSON.stringify({ code: 300308, msg: 'id convert rejected', error: { log_id: 'convert-log' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: { card_id: convertedCardId } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (init?.method === 'PUT' && /\/cards\/[^/]+\/elements\//.test(path)) {
      const body = init.body ? JSON.parse(String(init.body)) : {}
      elementPatches.push(typeof body.element === 'string' ? JSON.parse(body.element) : body)
      if (rejectElementPatch) {
        return new Response(JSON.stringify({ code: 300308, msg: 'model panel rejected', error: { log_id: 'model-panel-log' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    if (url.pathname === '/open-apis/im/v1/messages') {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      const content = typeof body.content === 'string' ? JSON.parse(body.content) : {}
      rawFallbacks.push(String(content.text ?? ''))
      return new Response(JSON.stringify({ code: 0, data: { message_id: `om_raw_${rawFallbacks.length}` } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  afterEach(() => { elementPatches.length = 0 })
  process.on('exit', () => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const { buildTokenSourcesFromConfig } = await import('./token-source-builtins')
  const {
    getTokenSource,
    refreshAllTokenSourceModels,
    registerTokenSource,
    resetTokenSourceRegistry,
  } = await import('./token-source')
  const { onModelCustomPrompt, consumeModelCustomMessage, onModelPanelCancel } = await import('./session-model')
  const cardkit = await import('./cardkit')

  test('isolated model custom card flow', async () => {
    resetTokenSourceRegistry()
    buildTokenSourcesFromConfig()
    const initial = getTokenSource('glm')!
    resetTokenSourceRegistry()
    registerTokenSource(initial)
    await refreshAllTokenSourceModels()
    const glm = getTokenSource('glm')
    const fake: any = {
      chatId: 'c', sessionName: 's', modelPanels: new Map(), modelCustomPrompt: null,
      tokenSource: getTokenSource, codexAccountId: () => 'default',
      currentTokenSource: () => glm, currentModelLabel: () => 'GLM-5.2', currentEffortLabel: () => 'max', currentTurn: null,
    }

    const oldPrompt = await onModelCustomPrompt(fake, 'glm', 'panel-old', 'om_old')
    const cancelValue = (oldPrompt.card as any).body.elements[0].elements[1].behaviors[0].value
    expect(cancelValue).toEqual({ kind: 'model_panel_cancel', panel_id: 'panel-old' })
    await onModelCustomPrompt(fake, 'glm', 'panel-new', 'om_new')
    const staleCancel = await onModelPanelCancel(fake, 'panel-old')
    expect(staleCancel.ok).toBe(false)
    expect(JSON.stringify(staleCancel.card)).toContain('已失效')
    expect(fake.modelCustomPrompt?.panelId).toBe('panel-new')
    const activeCancel = await onModelPanelCancel(fake, 'panel-new')
    expect(activeCancel.ok).toBe(true)
    expect(fake.modelCustomPrompt).toBeNull()

    await onModelCustomPrompt(fake, 'glm', 'p1', 'om_card_1')
    expect(fake.modelCustomPrompt?.cardMessageId).toBe('om_card_1')

    const fetchesBeforeUpdate = modelFetches
    await consumeModelCustomMessage(fake, 'GLM-5.3', 'u')
    expect(modelFetches - fetchesBeforeUpdate).toBe(0)
    const el = elementPatches.at(-1)
    expect(el).toBeTruthy()
    expect(el.header?.title?.content).toBe('选择 effort')
    expect(JSON.stringify(el)).toContain('GLM-5.3')
    expect(fake.modelCustomPrompt).toBeNull()
    expect(fake.modelPanels.get('p1')?.models.some((m: any) => m.model === 'GLM-5.3')).toBe(true)

    fake.modelCustomPrompt = { sourceId: 'glm', panelId: 'p2', cardMessageId: 'om_card_2' }
    await consumeModelCustomMessage(fake, 'bad model', 'u')
    const el2 = elementPatches.at(-1)
    expect(JSON.stringify(el2)).toContain('未加入')
    expect(JSON.stringify(el2)).toContain('模型 ID 无效')
    expect(glm!.models.some(m => m.model === 'glm-9.9')).toBe(false)

    fake.modelCustomPrompt = { sourceId: 'glm', panelId: 'p3', cardMessageId: 'om_card_3' }
    await consumeModelCustomMessage(fake, 'GLM-5.2', 'u')
    const el3 = elementPatches.at(-1)
    expect(el3?.element_id).toBe('model_panel')
    expect(JSON.stringify(el3)).toContain('已在列表中')
    expect(el3?.schema).toBeUndefined()
    expect(rawFallbacks).toEqual([])

    convertedCardId = 'card_model_mutation_miss'
    rejectElementPatch = true
    fake.modelCustomPrompt = { sourceId: 'glm', panelId: 'p4', cardMessageId: 'om_card_4' }
    await consumeModelCustomMessage(fake, 'GLM-5.2', 'u')
    rejectElementPatch = false
    expect(rawFallbacks.at(-1)).toContain('模型 GLM-5.2 已在列表中')
    expect(rawFallbacks.at(-1)).toContain('重新发送 model')
    expect(rawFallbacks.at(-1)).toContain('code=300308 message=model panel rejected log_id=model-panel-log')

    // The element mutation missed but streaming-off landed. The one-shot
    // model-card transaction must retain CardKit state for diagnosis/repair
    // instead of tombstoning a card whose visible panel never changed.
    expect(await cardkit.patchSettingsChecked(convertedCardId, {
      config: { streaming_mode: false },
    })).toBe(true)
    await cardkit.dispose(convertedCardId)

    rejectIdConvert = true
    fake.modelCustomPrompt = { sourceId: 'glm', panelId: 'p5', cardMessageId: 'om_card_5' }
    await consumeModelCustomMessage(fake, 'GLM-5.2', 'u')
    rejectIdConvert = false
    expect(rawFallbacks.at(-1)).toContain('模型 GLM-5.2 已在列表中')
    expect(rawFallbacks.at(-1)).toContain('重新发送 model')
    expect(rawFallbacks.at(-1)).toContain('code=300308 message=id convert rejected log_id=convert-log')

    rejectCatalog = true
    convertedCardId = 'card_model_catalog_miss'
    fake.modelCustomPrompt = { sourceId: 'glm', panelId: 'p6', cardMessageId: 'om_card_6' }
    await consumeModelCustomMessage(fake, 'GLM-5.4', 'u')
    expect(JSON.stringify(elementPatches.at(-1))).toContain('GLM-5.4')
    expect(fake.modelPanels.has('p6')).toBe(true)
    expect(getTokenSource('glm')?.models.some(model => model.model === 'GLM-5.4')).toBe(true)
    await expect(getTokenSource('glm')!.refreshModels()).rejects.toThrow('catalog unavailable')
    expect(getTokenSource('glm')?.modelCatalogState).toMatchObject({ status: 'ready', error: 'catalog unavailable' })
  })
}
