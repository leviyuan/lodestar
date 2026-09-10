/** 使用已配置的 GLM Coding Plan 实测 DSH 原生工具调用与 resume，不连接飞书或 daemon。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DshProcess } from '../src/dsh-process'
import { tokenSourceFactories } from '../src/token-source'
import { config } from '../src/config'
import { readClaudeSettingsEnv } from '../src/glm-usage'
import '../src/token-source-dsh-glm'
import type { ConversationLaunch } from '../src/conversation'

const factory = tokenSourceFactories().find(f => f.kind === 'dsh-glm')!
const source = factory.build(config.token_sources['dsh-glm'] ?? {}, factory.detect!.fromSettingsEnv(readClaudeSettingsEnv()))
assert.ok(source.enabled, 'GLM Coding Plan 未配置')
await source.refreshModels()
const model = source.models.find(model => model.model === source.defaultModel)
assert.ok(model?.defaultEffort && !model.unavailableReason, 'DSH GLM 默认模型或档位不可用')
const dir = await mkdtemp(join(tmpdir(), 'lodestar-dsh-glm-live-'))
const marker = `GLM-DSH-${randomUUID()}`
const proofFile = join(dir, 'proof.txt')
await writeFile(proofFile, marker, { mode: 0o600 })
const results: object[] = []
let launch: ConversationLaunch = { kind: 'fresh' }
let failure: unknown
try {
  for (let turn = 0; turn < 2; turn++) {
    const proc: DshProcess = new DshProcess({ workDir: dir, model: model.model, effort: model.defaultEffort as import('../src/agent-process').DshReasoningEffort,
      tokenSourceId: source.id, transformEnv: env => source.spawnEnv(env), allowDelegation: false,
      profile: { loadProjectMcp: false }, runtimeOptions: { home: join(dir, 'home') }, launch })
    let text = ''
    const tools: string[] = []
    const errors: string[] = []
    proc.on('assistant_text', event => { if (!event.parentToolUseId) text += event.text })
    proc.on('tool_use', event => { if (!event.parentToolUseId) tools.push(event.name) })
    proc.on('error', error => errors.push(error.message))
    try {
      await proc.initializationPromise()
      const expectedSession: string | null = launch.kind === 'resume' ? launch.source.sessionId : proc.sessionId
      const result = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('DSH GLM 实测超过 120 秒')), 120_000)
        proc.once('result', result => { clearTimeout(timer); resolve(result) })
        proc.once('exit', () => { clearTimeout(timer); reject(new Error('DSH 在结果前退出')) })
        proc.sendUserText(turn === 0
          ? `请调用文件读取工具读取 ${proofFile}，只回复里面的完整标记；不要修改文件。`
          : '不要调用工具。把上一轮文件里的完整验证标记原样回复。')
      })
      assert.equal(result.is_error, false, JSON.stringify({ result, errors }))
      assert.equal(proc.sessionId, expectedSession, '原生 resume 未保留同一会话')
      assert.ok(text.includes(marker), '返回内容没有正确的随机验证标记')
      if (turn === 0) assert.ok(tools.length > 0, '首轮没有调用工具')
      assert.equal(await readFile(proofFile, 'utf8'), marker, '测试文件被修改')
      results.push({ turn: turn + 1, model: proc.lastModel, effort: proc.lastEffort, tools, historyVerified: text.includes(marker), errors })
      launch = { kind: 'resume', source: { provider: 'dsh', sessionId: proc.sessionId!, cwd: dir } }
    } finally { await proc.kill() }
  }
} catch (error) { failure = error }
const report = { ok: !failure, results, error: failure ? String(failure) : null }
await writeFile(join(dir, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ ...report, reportDir: dir }, null, 2))
if (failure) throw failure
