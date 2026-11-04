import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function runFresh(work: string, leases?: object) {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-temp-lease-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  if (leases) writeFileSync(join(dataDir, 'temp-session-leases.json'), JSON.stringify(leases))
  const configFile = join(root, 'config.toml')
  writeFileSync(configFile, '[feishu]\napp_id = "t"\napp_secret = "t"\n')
  const feishuModule = pathToFileURL(join(import.meta.dir, 'feishu.ts')).href
  const script = `
    import {
      bindSessionToChat,
      clearSessionConversationState,
      hasTempSessionLease,
      loadTempSessionLeases,
      mainChatIdForSession,
      mainSessionName,
      registerTempSessionLease,
      tempChatName,
      tempProjectName,
    } from ${JSON.stringify(feishuModule)}
    import { readFileSync } from 'node:fs'
    import { join } from 'node:path'
    const dataDir = ${JSON.stringify(dataDir)}
    const out = value => process.stdout.write('@@@' + JSON.stringify(value) + '@@@')
    ${work}
  `
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      env: { ...process.env, LODESTAR_DATA_DIR: dataDir, LODESTAR_CONFIG: configFile },
    })
    const stdout = result.stdout.toString()
    const marker = stdout.match(/@@@([\s\S]*?)@@@/)
    if (!marker) throw new Error(`missing result marker\nstdout=${stdout}\nstderr=${result.stderr.toString()}`)
    return { exitCode: result.exitCode, value: JSON.parse(marker[1]), stderr: result.stderr.toString() }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('temporary-session leases', () => {
  test('maps main, WT, BTW and BTW-from-WT sessions back to the main group', () => {
    const result = runFresh(`
      bindSessionToChat('project', 'oc_main')
      out({
        names: [
          mainSessionName('project'),
          mainSessionName('project*0821-1337'),
          mainSessionName('project[feature]'),
          mainSessionName('project[feature]*0821-1337'),
        ],
        chats: [
          mainChatIdForSession('project', 'oc_current'),
          mainChatIdForSession('project*0821-1337', 'oc_temp'),
          mainChatIdForSession('project[feature]', 'oc_worktree'),
          mainChatIdForSession('project[feature]*0821-1337', 'oc_temp_worktree'),
        ],
      })
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.value).toEqual({
      names: ['project', 'project', 'project', 'project'],
      chats: ['oc_main', 'oc_main', 'oc_main', 'oc_main'],
    })
  })

  test('resolves role-named BTW sessions back to their main project and group', () => {
    const result = runFresh(`
      bindSessionToChat('project', 'oc_main')
      registerTempSessionLease('project*修复登录', 'oc_temp')
      loadTempSessionLeases()
      out({
        projects: [
          tempProjectName('project*修复登录'),
          tempProjectName('project*修复登录-2'),
          tempProjectName('project[feature]*修复登录'),
        ],
        names: [
          mainSessionName('project*修复登录'),
          mainSessionName('project*修复登录-2'),
          mainSessionName('project[feature]*修复登录'),
        ],
        chats: [
          mainChatIdForSession('project*修复登录', 'oc_temp'),
          mainChatIdForSession('project[feature]*修复登录', 'oc_temp_worktree'),
        ],
        leased: hasTempSessionLease('project*修复登录', 'oc_temp'),
      })
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.value).toEqual({
      projects: ['project', 'project', 'project[feature]'],
      names: ['project', 'project', 'project'],
      chats: ['oc_main', 'oc_main'],
      leased: true,
    })
  })

  test('builds role-based names and keeps time-stamped defaults', () => {
    const result = runFresh(`
      const first = tempChatName('project', [], '修复 登录')
      const second = tempChatName('project', [first], '修复 登录')
      out({ first, second, legacy: tempChatName('project') })
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.value.first).toBe('project*修复_登录')
    expect(result.value.second).toBe('project*修复_登录-2')
    expect(result.value.legacy).toMatch(/^project\*\d{4}-\d{4}$/)
  })

  test('persists and reloads exact chat/name ownership', () => {
    const result = runFresh(`
      registerTempSessionLease('project*0821-1337', 'oc_temp')
      loadTempSessionLeases()
      out({
        leased: hasTempSessionLease('project*0821-1337', 'oc_temp'),
        wrongChat: hasTempSessionLease('project*0821-1337', 'oc_other'),
        persisted: JSON.parse(readFileSync(join(dataDir, 'temp-session-leases.json'), 'utf8')),
      })
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.value.leased).toBe(true)
    expect(result.value.wrongChat).toBe(false)
    expect(result.value.persisted.oc_temp).toMatchObject({
      sessionName: 'project*0821-1337', chatId: 'oc_temp',
    })
  })

  test('permanent session cleanup removes the exact persisted lease', () => {
    const result = runFresh(`
      loadTempSessionLeases()
      clearSessionConversationState('project*0821-1337')
      out({
        leased: hasTempSessionLease('project*0821-1337', 'oc_temp'),
        persisted: JSON.parse(readFileSync(join(dataDir, 'temp-session-leases.json'), 'utf8')),
      })
    `, {
      oc_temp: { sessionName: 'project*0821-1337', chatId: 'oc_temp', createdAt: 1 },
    })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.value).toEqual({ leased: false, persisted: {} })
  })

  test('rejects ordinary groups that merely look temporary', () => {
    const result = runFresh(`
      let error = ''
      try { registerTempSessionLease('ordinary-project', 'oc_normal') }
      catch (value) { error = value instanceof Error ? value.message : String(value) }
      out({ error, leased: hasTempSessionLease('ordinary-project', 'oc_normal') })
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.value.error).toContain('non-temporary')
    expect(result.value.leased).toBe(false)
  })
})
