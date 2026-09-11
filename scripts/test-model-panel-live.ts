/** 正在运行的 daemon 模型面板 smoke；只使用已有本机 debug socket。
 * 必须显式指定目标群和临时添加模型，不启动/重启 daemon，不创建旁路 Session。
 * bun scripts/test-model-panel-live.ts --chat-id oc_xxx --extra-model anthropic/claude-sonnet-4.6
 * 单独验证其他运行路由：追加 --routes-only --test-source dsh-glm --test-model glm-5.3 --test-effort high。
 */
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEBUG_CTX_FILE, DEBUG_SOCK_FILE, SESSION_MODEL_MAP_FILE } from '../src/paths'
import { client } from '../src/feishu'
import { injectDebugMessage } from './debug-client'
import { OPENROUTER_DEFAULT_MODELS } from '../src/openrouter-defaults'
import type { DebugModelSnapshot } from '../src/debug-model'

const args = process.argv.slice(2)
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const chatId = option('--chat-id')
const extraModel = option('--extra-model')
if (!chatId?.startsWith('oc_') || !extraModel) throw new Error('需要 --chat-id 和 --extra-model')
const context = JSON.parse(readFileSync(DEBUG_CTX_FILE, 'utf8'))
if (context.chat_id !== chatId) throw new Error('目标群与已设置的 debug context 不一致')
const reportDir = mkdtempSync(join(tmpdir(), 'lodestar-md-live-'))
console.log(JSON.stringify({ phase: 'started', reportDir }))
const checks: string[] = []
const sourceId = 'openrouter'
const routesOnly = args.includes('--routes-only')
const testSource = option('--test-source') ?? sourceId
const testModel = option('--test-model') ?? 'xiaomi/mimo-v2.5-pro'
const testEffort = option('--test-effort') ?? 'default'

function call<T>(method: string, path: string, body?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined
    const req = request({ socketPath: DEBUG_SOCK_FILE, method, path,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('error', reject)
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 300) { reject(new Error(`debug HTTP ${res.statusCode}: ${text}`)); return }
        try { resolve(JSON.parse(text) as T) } catch (error) { reject(error) }
      })
    })
    req.setTimeout(30_000, () => req.destroy(new Error('debug request timeout')))
    req.on('error', reject)
    req.end(payload)
  })
}
const state = () => call<DebugModelSnapshot>('GET', `/model-state?chat_id=${encodeURIComponent(chatId)}`)
type Panel = DebugModelSnapshot['panels'][number]
async function openPanel(): Promise<{ snapshot: DebugModelSnapshot; panel: Panel }> {
  await injectDebugMessage('md', chatId, true)
  const snapshot = await state()
  const panel = snapshot.panels.at(-1)
  assert.ok(panel?.message_id, 'MD 面板没有关联到真实消息')
  return { snapshot, panel }
}
async function action(panel: Panel, kind: string, values: Record<string, string | number> = {}): Promise<DebugModelSnapshot> {
  const response = await call<{ state: DebugModelSnapshot }>('POST', '/model-action', {
    chat_id: chatId, message_id: panel.message_id,
    value: { kind, panel_id: panel.panel_id, source_id: sourceId, ...values },
  })
  return response.state
}
function panelFrom(snapshot: DebugModelSnapshot, id: string): Panel {
  const panel = snapshot.panels.find(panel => panel.panel_id === id)
  assert.ok(panel, '模型面板意外失效')
  return panel
}
async function rawCard(messageId: string): Promise<any> {
  const response = await client.im.v1.message.get({ path: { message_id: messageId }, params: { card_msg_content_type: 'raw_card_content' } })
  assert.equal(response.code, 0, response.msg)
  const content = response.data?.items?.[0]?.body?.content
  assert.ok(content, '卡片正文缺失')
  const envelope = JSON.parse(content)
  assert.equal(typeof envelope.json_card, 'string', '未返回原始卡片结构')
  const card = JSON.parse(envelope.json_card)
  const modelPanel = card.body?.property?.elements?.find((element: any) => element.id === 'model_panel')
  if (modelPanel) {
    const visit = (element: any): void => {
      if (!element || typeof element !== 'object') return
      if (element.tag === 'button') {
        const label = texts(element).join('')
        const wideLabels = ['补录模型', '显示模型', '返回模型列表', '上一页', '下一页', '取消']
        assert.ok(wideLabels.includes(label) || /^\p{Script=Han}$/u.test(label), `模型行按钮不是单字或宽按钮文案不完整：${label}`)
      }
      for (const child of Object.values(element)) visit(child)
    }
    visit(modelPanel)
  }
  return card
}
function texts(value: any): string[] {
  if (!value || typeof value !== 'object') return []
  return [...(typeof value.property?.content === 'string' ? [value.property.content] : []),
    ...Object.values(value).flatMap(child => typeof child === 'object' ? texts(child) : [])]
}
function assistantTexts(value: any): string[] {
  if (!value || typeof value !== 'object') return []
  if (typeof value.id === 'string' && value.id.startsWith('assistant_')) return texts(value)
  return Object.values(value).flatMap(assistantTexts)
}

function footerTexts(value: any): string[] {
  if (!value || typeof value !== 'object') return []
  if (value.id === 'footer') return texts(value)
  return Object.values(value).flatMap(footerTexts)
}

/** SDK 结果先到，卡片还要异步查余额和写入；等同一张卡的最终 footer。 */
async function settledCard(messageId: string): Promise<any> {
  const deadline = Date.now() + 30_000
  while (true) {
    const card = await rawCard(messageId)
    if (footerTexts(card).join('').startsWith('✅')) return card
    if (Date.now() >= deadline) throw new Error('SDK 已完成，但卡片 footer 未完成结算')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

async function findModelPage(panel: Panel, source: string, model: string): Promise<Panel> {
  for (let page = 1; !panel.models.some(entry => entry.model === model) && page < (panel.total_pages ?? 1); page++) {
    const snapshot = await action(panel, 'model_page', { source_id: source, page })
    panel = panelFrom(snapshot, panel.panel_id)
  }
  assert.ok(panel.models.some(entry => entry.model === model), `目录缺少 ${source}/${model}`)
  return panel
}

async function checkCatalogVisibility(source: DebugModelSnapshot['sources'][number]): Promise<void> {
  const baseline = source.models.map(model => model.model)
  const model = baseline[0]!
  const opened = await openPanel()
  const before = opened.snapshot.selection
  let panel = panelFrom(await action(opened.panel, 'provider_select', { source_id: source.id }), opened.panel.panel_id)
  let failure: unknown
  let attempted = false
  try {
    attempted = true
    const hidden = await action(panel, 'model_remove', { source_id: source.id, model })
    assert.deepEqual(hidden.selection, before, '隐藏模型改变了当前会话设置')
    assert.deepEqual(hidden.sources.find(item => item.id === source.id)?.models.map(item => item.model), baseline.slice(1))
    const refreshed = await openPanel()
    assert.deepEqual(refreshed.snapshot.sources.find(item => item.id === source.id)?.models.map(item => item.model), baseline.slice(1), '刷新后隐藏项重新出现')
  } catch (error) { failure = error }
  finally {
    try {
      const current = await state()
      if (attempted && !current.sources.find(item => item.id === source.id)?.models.some(item => item.model === model)) {
        const fresh = await openPanel()
        panel = panelFrom(await action(fresh.panel, 'provider_select', { source_id: source.id }), fresh.panel.panel_id)
        panel = panelFrom(await action(panel, 'model_list_open', { source_id: source.id, mode: 'add' }), panel.panel_id)
        panel = await findModelPage(panel, source.id, model)
        await action(panel, 'model_add', { source_id: source.id, model })
      }
      const restored = await state()
      assert.deepEqual(restored.sources.find(item => item.id === source.id)?.models.map(item => item.model), baseline)
      assert.deepEqual(restored.selection, before)
    } catch (error) { failure = failure ? new AggregateError([failure, error], `${source.id} 测试和恢复失败`) : error }
  }
  if (failure) throw failure
  checks.push(`${source.id} 隐藏、刷新、重新添加，模型设置保持不变`)
}

async function checkCustomRecord(source: DebugModelSnapshot['sources'][number]): Promise<void> {
  const custom = `lodestar-test/custom-${randomUUID()}`
  const opened = await openPanel()
  const original = opened.snapshot.selection
  let panel = panelFrom(await action(opened.panel, 'provider_select', { source_id: source.id }), opened.panel.panel_id)
  let failure: unknown
  try {
    const pending = await action(panel, 'model_custom_prompt', { source_id: source.id })
    assert.equal(pending.awaiting_model_input, true, '未进入补录输入状态')
    await injectDebugMessage(custom, chatId, true)
    let snapshot = await state()
    const entry = snapshot.sources.find(item => item.id === source.id)?.models.find(item => item.model === custom)
    assert.equal(entry?.origin, 'custom', '未保存独立补录记录')
    assert.ok(!entry.unavailable_reason && entry.efforts.length > 0, '补录模型未提供可选的请求档位')
    assert.deepEqual(snapshot.selection, original)
    assert.ok(texts(await rawCard(panel.message_id!)).join('').includes('effort'), '补录后未进入 effort 选择')
    const refreshed = await openPanel()
    snapshot = await action(refreshed.panel, 'provider_select', { source_id: source.id })
    panel = await findModelPage(panelFrom(snapshot, refreshed.panel.panel_id), source.id, custom)
    await action(panel, 'model_custom_remove', { source_id: source.id, model: custom })
    assert.ok(!(await state()).sources.find(item => item.id === source.id)?.models.some(item => item.model === custom))
  } catch (error) { failure = error }
  finally {
    try {
      let snapshot = await state()
      if (snapshot.awaiting_model_input) await action(panel, 'model_panel_cancel', { source_id: source.id })
      if (snapshot.sources.find(item => item.id === source.id)?.models.some(item => item.model === custom)) {
        const fresh = await openPanel()
        snapshot = await action(fresh.panel, 'provider_select', { source_id: source.id })
        panel = await findModelPage(panelFrom(snapshot, fresh.panel.panel_id), source.id, custom)
        await action(panel, 'model_custom_remove', { source_id: source.id, model: custom })
      }
      assert.deepEqual((await state()).selection, original)
    } catch (error) { failure = failure ? new AggregateError([failure, error], '补录测试及恢复失败') : error }
  }
  if (failure) throw failure
  checks.push(`${source.id} 列表外补录、持久化、effort 选择和删除`)
}

async function checkRejectedRegistration(source: DebugModelSnapshot['sources'][number]): Promise<void> {
  const invalid = `lodestar-invalid-${randomUUID()}`
  const opened = await openPanel()
  const before = opened.snapshot.selection
  let panel = panelFrom(await action(opened.panel, 'provider_select', { source_id: source.id }), opened.panel.panel_id)
  let failure: unknown
  try {
    assert.equal((await action(panel, 'model_custom_prompt', { source_id: source.id })).awaiting_model_input, true)
    await injectDebugMessage(invalid, chatId, true)
    const snapshot = await state()
    assert.ok(!snapshot.sources.find(item => item.id === source.id)?.models.some(item => item.model === invalid), '无效模型被意外补录')
    assert.ok(texts(await rawCard(panel.message_id!)).join('').includes('未加入'), '未在卡片上呈现补录失败')
    assert.deepEqual(snapshot.selection, before)
  } catch (error) { failure = error }
  finally {
    try {
      const current = await state()
      if (current.awaiting_model_input) await action(panel, 'model_panel_cancel', { source_id: source.id })
      if (current.sources.find(item => item.id === source.id)?.models.some(item => item.model === invalid)) {
        const fresh = await openPanel()
        const snapshot = await action(fresh.panel, 'provider_select', { source_id: source.id })
        panel = await findModelPage(panelFrom(snapshot, fresh.panel.panel_id), source.id, invalid)
        await action(panel, 'model_custom_remove', { source_id: source.id, model: invalid })
      }
    } catch (error) { failure = failure ? new AggregateError([failure, error], '补录拒绝测试及清理失败') : error }
  }
  if (failure) throw failure
  checks.push(`${source.id} 无效补录被拒绝并显示错误，配置未增加记录`)
}
async function selectModel(source: string, model: string, effort: string): Promise<DebugModelSnapshot> {
  const opened = await openPanel()
  let snapshot = await action(opened.panel, 'provider_select', { source_id: source })
  let panel = panelFrom(snapshot, opened.panel.panel_id)
  for (let page = 1; !panel.models.some(entry => entry.model === model) && page < (panel.total_pages ?? 1); page++) {
    snapshot = await action(panel, 'model_page', { source_id: source, page })
    panel = panelFrom(snapshot, panel.panel_id)
  }
  const choice = panel.models.find(entry => entry.model === model)
  assert.ok(choice?.provider && choice.efforts.includes(effort), '模型/档位不在当前目录中')
  snapshot = await action(panel, 'model_select', { source_id: source, provider: choice.provider, model })
  const effortPanel = texts(await rawCard(panel.message_id!)).join('').includes('选择 effort')
  if (choice.efforts.length > 1) {
    assert.ok(effortPanel, '飞书卡片未进入档位选择')
    snapshot = await action(panel, 'model_effort_select', { source_id: source, provider: choice.provider, model, effort })
  } else {
    assert.equal(effortPanel, false, '无档位选择的模型没有跳过 effort 卡')
  }
  assert.equal(snapshot.selection.source_id, source)
  assert.equal(snapshot.selection.model, model)
  assert.equal(snapshot.selection.effort, effort)
  const saved = JSON.parse(readFileSync(SESSION_MODEL_MAP_FILE, 'utf8'))[snapshot.session_name]
  assert.equal(saved.tokenSourceId, source)
  assert.equal(saved.model, model)
  assert.equal(saved.effort, effort)
  return snapshot
}

let original: DebugModelSnapshot['selection'] | undefined
let baseline: string[] = []
let additionAttempted = false
let selectionAttempted = false
let failure: unknown
try {
  let { snapshot, panel } = await openPanel()
  assert.ok(!snapshot.busy && !snapshot.awaiting_model_input && snapshot.status !== 'awaiting_permission', '目标群不空闲')
  original = snapshot.selection
  assert.ok(original.source_id && original.model && original.effort, '目标群需有完整的原模型设置，才能验证后恢复')
  const source = snapshot.sources.find(source => source.id === sourceId)
  assert.equal(source?.status, 'ready')
  baseline = source.models.map(model => model.model)
  assert.deepEqual(baseline, OPENROUTER_DEFAULT_MODELS.map(entry => entry.model))
  assert.ok(!baseline.includes(extraModel), '临时模型已在列表中，请指定另一个')
  const tree = await rawCard(panel.message_id!)
  const rows = tree.body?.property?.elements?.[0]?.property?.elements ?? []
  const groups = rows.filter((row: any) => row.tag === 'collapsible_panel' && /^model_agent_/.test(row.id))
  assert.deepEqual(groups.map((group: any) => group.id), ['model_agent_claude', 'model_agent_codex', 'model_agent_dsh'], 'MD 首页没有独立的 Agent 分组')
  for (const [i, name] of ['Claude Code', 'Codex', 'DeepSeek Harness'].entries()) {
    assert.ok(texts(groups[i].property.header).join('').includes(name), `Agent 分组标题不正确：${name}`)
  }
  assert.equal(snapshot.sources.find(source => source.id === 'deepseek')?.display, 'DeepSeek')
  assert.equal(snapshot.sources.find(source => source.id === 'deepseek-harness')?.display, 'DeepSeek')
  const sourceRows = groups.flatMap((group: any) => group.property?.elements ?? [])
  const row = sourceRows.find((row: any) => row.tag === 'column_set' && texts(row).includes(source.display))
  assert.ok(row && texts(row).join('').includes(`${baseline.length} 个模型`), '真实 MD 卡片没有显示正确模型数量')
  checks.push(`真实账号卡显示 ${baseline.length} 个模型`)
  checks.push('MD 首页按 claude / codex / dsh 分组')
  checks.push('模型行按钮为单字、宽按钮保留完整文字，两组 DeepSeek 来源名称一致')

  if (!routesOnly) {
    snapshot = await action(panel, 'provider_select')
    panel = panelFrom(snapshot, panel.panel_id)
    const modelCardText = texts(await rawCard(panel.message_id!)).join('')
    for (const model of baseline) assert.ok(modelCardText.includes(model), `卡片缺少 ${model}`)
    assert.ok(modelCardText.includes('补录模型') && modelCardText.includes('显示模型'), '宽按钮缺少完整说明')
    const modelRows = (await rawCard(panel.message_id!)).body.property.elements[0].property.elements
    assert.equal(modelRows.filter((row: any) => row.tag === 'hr').length, panel.models.length - 1, '模型行之间缺少分隔线')
    snapshot = await action(panel, 'model_list_open', { mode: 'add' })
    panel = panelFrom(snapshot, panel.panel_id)
    if ((panel.total_pages ?? 1) > 1) {
      snapshot = await action(panel, 'model_page', { page: 1 })
      assert.equal(panelFrom(snapshot, panel.panel_id).page, 1)
      snapshot = await action(panel, 'model_page', { page: 0 })
      panel = panelFrom(snapshot, panel.panel_id)
      checks.push('添加目录往返翻页')
    }
    for (let page = 1; !panel.models.some(model => model.model === extraModel) && page < (panel.total_pages ?? 1); page++) {
      snapshot = await action(panel, 'model_page', { page })
      panel = panelFrom(snapshot, panel.panel_id)
    }
    assert.ok(panel.models.some(model => model.model === extraModel), '临时模型不在允许添加目录中')
    additionAttempted = true
    snapshot = await action(panel, 'model_add', { model: extraModel })
    panel = panelFrom(snapshot, panel.panel_id)
    assert.equal(snapshot.sources.find(source => source.id === sourceId)?.models.length, baseline.length + 1)
    assert.ok(texts(await rawCard(panel.message_id!)).join('').includes(extraModel), '新增模型未呈现在飞书卡片上')
    snapshot = await action(panel, 'model_remove', { model: extraModel })
    assert.deepEqual(snapshot.sources.find(source => source.id === sourceId)?.models.map(model => model.model), baseline)
    additionAttempted = false
    checks.push('真实回调添加/删除模型，恢复默认列表')

    for (const catalog of snapshot.sources.filter(item => item.enabled && item.id !== sourceId)) {
      assert.equal(catalog.status, 'ready', `${catalog.id} 目录未就绪`)
      assert.ok(catalog.models.length, `${catalog.id} 列表为空，无法验证隐藏`)
      await checkCatalogVisibility(catalog)
    }
    for (const catalog of snapshot.sources.filter(item => item.enabled && !item.validates_custom_model)) {
      await checkCustomRecord(catalog)
    }
    for (const catalog of snapshot.sources.filter(item => item.enabled && item.validates_custom_model)) {
      await checkRejectedRegistration(catalog)
    }
  }

  selectionAttempted = true
  snapshot = await selectModel(testSource, testModel, testEffort)
  checks.push(`${testSource} 选择 ${testModel}/${testEffort} 并持久化`)
  const testProvider = snapshot.selection.provider
  const priorAnchor = snapshot.last_result?.anchor
  const marker = `MD-SMOKE-${randomUUID()}`
  await injectDebugMessage(`自动化验证：不要调用工具，也不要修改文件。请只回复：${marker}`, chatId, true)
  const deadline = Date.now() + 90_000
  while (true) {
    snapshot = await state()
    if (!snapshot.busy && snapshot.last_result?.is_error) throw new Error(`真实回复失败：${snapshot.last_result.subtype}`)
    const completed = testProvider === 'dsh' ? snapshot.last_result?.subtype === 'completed'
      : snapshot.last_result?.subtype === 'success' && snapshot.last_result.anchor && snapshot.last_result.anchor !== priorAnchor
    if (!snapshot.busy && completed) break
    if (!snapshot.running && !snapshot.busy) throw new Error('测试模型进程未保持运行')
    if (Date.now() >= deadline) throw new Error('真实回复等待超时')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const messages = await client.im.v1.message.list({ params: { container_id_type: 'chat', container_id: chatId, page_size: 8, sort_type: 'ByCreateTimeDesc' } })
  assert.equal(messages.code, 0, messages.msg)
  let foundReply = false
  for (const message of messages.data?.items ?? []) {
    if (message.msg_type !== 'interactive' || !message.message_id) continue
    let card = await rawCard(message.message_id)
    if (assistantTexts(card).join('').includes(marker)) {
      card = await settledCard(message.message_id)
      assert.ok(footerTexts(card).join('').includes(`${testProvider} · ${testModel}/${testEffort}`), '真实回复卡的 footer 模型格式不一致')
      const usageLine = footerTexts(card).at(-1) ?? ''
      const balanceSource = ['openrouter', 'deepseek', 'deepseek-harness'].includes(testSource)
      assert.ok(balanceSource ? /余额 [\$¥]/.test(usageLine)
        : /\|\s+\[?(?:[\d.]+[smhd]·)?\d+%/.test(usageLine), '真实回复卡未显示余额或紧凑额度')
      assert.ok(!texts(card).join('').includes('非账户余额'), '真实回复卡保留了额外余额说明')
      foundReply = true; break
    }
  }
  assert.ok(foundReply, '飞书回复正文未找到测试标记')
  checks.push(`${testSource} 真实群回复、模型/effort 与最终余额/额度 footer 均正确`)
} catch (error) { failure = error }
finally {
  try {
    let snapshot = await state()
    const source = snapshot.sources.find(source => source.id === sourceId)
    if (additionAttempted && !baseline.includes(extraModel) && source?.models.some(model => model.model === extraModel)) {
      const opened = await openPanel()
      const selected = await action(opened.panel, 'provider_select')
      await action(panelFrom(selected, opened.panel.panel_id), 'model_remove', { model: extraModel })
    }
    snapshot = await state()
    const changed = original && (snapshot.selection.source_id !== original.source_id
      || snapshot.selection.model !== original.model || snapshot.selection.effort !== original.effort)
    if (selectionAttempted && changed && original?.source_id && original.model && original.effort) {
      assert.ok(!snapshot.busy, '目标群仍忙，保留现场，不能恢复模型')
      assert.ok(snapshot.selection.source_id === testSource && snapshot.selection.model === testModel
        && snapshot.selection.effort === testEffort, '模型已被其他操作改动，保留当前设置')
      await selectModel(original.source_id, original.model, original.effort)
      checks.push('恢复测试群原模型设置')
    }
    const restored = await state()
    if (baseline.length) assert.deepEqual(restored.sources.find(source => source.id === sourceId)?.models.map(model => model.model), baseline)
  } catch (error) { failure = failure ? new AggregateError([failure, error], '测试及清理失败') : error }
  writeFileSync(join(reportDir, 'result.json'), JSON.stringify({ checks, error: failure ? String(failure) : null }, null, 2), { mode: 0o600 })
}
console.log(JSON.stringify({ checks, reportDir, ok: !failure }, null, 2))
if (failure) throw failure
