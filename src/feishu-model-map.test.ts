import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

interface FreshResult { exitCode: number; stdout: string; stderr: string }

/** 在隔离子进程里跑 model map 操作(独立 LODESTAR_DATA_DIR + LODESTAR_CONFIG,
 *  不碰真实档案)。模式参照 config.test.ts 的 loadFreshModelMap。子进程里
 *  feishu 的 log() 会往 stdout 打日志,故结果用 @@@ 标记包裹,提取时无视噪音。 */
function runFreshModelMap(work: string): FreshResult {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-mmap-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const configFile = join(root, 'config.toml')
  writeFileSync(configFile, '[feishu]\napp_id = "t"\napp_secret = "t"\n')
  const feishuModule = pathToFileURL(join(import.meta.dir, 'feishu.ts')).href
  const script =
    `import { bindSessionModel, getSessionModelSelection } from ${JSON.stringify(feishuModule)}\n` +
    `const __out = o => process.stdout.write('@@@' + JSON.stringify(o) + '@@@')\n` +
    work
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      env: { ...process.env, LODESTAR_DATA_DIR: dataDir, LODESTAR_CONFIG: configFile },
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** 从子进程 stdout 里提 @@@...@@@ 标记包裹的 JSON,忽略 feishu log 噪音。 */
function extract(r: FreshResult): any {
  const m = r.stdout.match(/@@@([\s\S]*?)@@@/)
  if (!m) throw new Error(`no @@@ marker (exitCode=${r.exitCode})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
  return JSON.parse(m[1])
}

// 临时群创建时保存独立 routing 快照，之后各自修改；旧临时群尚无快照时
// 按 tempProjectName 读取来源会话选择，保持升级兼容。
describe('getSessionModelSelection — 临时群转发继承主群', () => {
  test('临时群名(*MMDD-HHMM)转发查到主群档位', () => {
    const r = runFreshModelMap(`
      bindSessionModel('strategy-zp', 'codex', 'gpt-5.6-sol', 'xhigh', 'codex-sub')
      __out({
        inherited: getSessionModelSelection('strategy-zp*0730-1530'),
        direct: getSessionModelSelection('strategy-zp'),
      })
    `)
    expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0)
    const { inherited, direct } = extract(r)
    expect(inherited).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', tokenSourceId: 'codex-sub' })
    expect(direct).toEqual(inherited)
  })

  test('去重后缀(*MMDD-HHMM-2)也能转发主群', () => {
    const r = runFreshModelMap(`
      bindSessionModel('p', 'claude', 'claude:opus', 'max', 'glm')
      __out(getSessionModelSelection('p*0730-1530-2'))
    `)
    expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0)
    expect(extract(r)).toEqual({ provider: 'claude', model: 'claude:opus', effort: 'max', tokenSourceId: 'glm' })
  })

  test('临时群自己被显式选过则优先自己,不转发主群', () => {
    const r = runFreshModelMap(`
      bindSessionModel('p', 'claude', 'claude:opus', 'max', 'glm')
      bindSessionModel('p*0730-1530', 'codex', 'gpt-5.5', 'xhigh', 'codex-sub')
      __out(getSessionModelSelection('p*0730-1530'))
    `)
    expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0)
    expect(extract(r).provider).toBe('codex')
  })

  test('主群无记录 → 临时群和非临时群都返回 null', () => {
    const r = runFreshModelMap(`
      __out({
        a: getSessionModelSelection('nope'),
        b: getSessionModelSelection('nope*0730-1530'),
      })
    `)
    expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0)
    const { a, b } = extract(r)
    expect(a).toBeNull()
    expect(b).toBeNull()
  })
})
