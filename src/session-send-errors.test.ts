import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { resetFeishuMock, sentRawTexts } from './feishu-test-mock'
import * as feishu from './feishu'
import * as tasklist from './tasklist'
import * as worktree from './worktree'
import { codexLogins } from './codex-login'
import { showTasklistPanel } from './session-tasklist'
import { showAgentIdentityPanel } from './session-agent-identities'
import { runCodexAccountCommand } from './session-codex-accounts'
import { runCommand } from './session-commands'
import { runWorktreeCommand } from './session-worktree'
import type { Session } from './session'

const diagnostics = 'code=230001 message=invalid card content log_id=session-send-log'
const failure = {
  message: 'Request failed with status code 400',
  response: { data: { code: 230001, msg: 'invalid card content', error: { log_id: 'session-send-log' } } },
}
const spies: Array<{ mockRestore(): void }> = []

beforeEach(() => {
  resetFeishuMock()
  spies.push(spyOn(feishu, 'sendCard').mockImplementation(async (_chatId, _card, onFailure) => {
    onFailure?.(failure)
    return null
  }))
})
afterEach(() => { for (const spy of spies.splice(0).reverse()) spy.mockRestore() })

describe('session card delivery diagnostics', () => {
  test('task panel failure retains the existing notice and includes API details', async () => {
    spies.push(spyOn(tasklist, 'getTasklistBinding').mockReturnValue(null))
    await showTasklistPanel({ chatId: 'oc_diag', worktreeProjectName: () => 'diag' } as unknown as Session)
    expect(sentRawTexts).toEqual([`❌ task 面板发送失败\n${diagnostics}`])
  })

  test('agents panel failure includes API details in the existing notice', async () => {
    await showAgentIdentityPanel({ chatId: 'oc_diag', codexAccountId: () => 'default' } as unknown as Session, 'ou_owner')
    expect(sentRawTexts).toEqual([`❌ agents 面板发送失败\n${diagnostics}`])
  })

  test('Codex error-card failure continues to reject with API details', async () => {
    spies.push(spyOn(codexLogins, 'pending').mockReturnValue([]))
    await expect(runCodexAccountCommand({ chatId: 'oc_diag' } as Session, 'login-cancel', '', 'ou_owner'))
      .rejects.toThrow(`Codex 错误卡片发送失败\n${diagnostics}`)
    expect(sentRawTexts).toHaveLength(0)
  })

  test('quota-wait card failure continues to reject with API details', async () => {
    const s = {
      chatId: 'oc_diag', isRunning: () => true, backendLabel: () => 'Codex', withModel: (text: string) => text,
      proc: { turnRetry: { reason: 'quota' } },
    } as unknown as Session
    await expect(runCommand(s, 'hi', 'ou_owner')).rejects.toThrow(`额度等待卡片发送失败\n${diagnostics}`)
    expect(sentRawTexts).toHaveLength(0)
  })

  test('worktree parent and child notice failures keep their respective API diagnostics', async () => {
    spies.push(spyOn(worktree, 'withProjectWorktreeLock').mockImplementation(async (_projectDir, run) => run()))
    spies.push(spyOn(worktree, 'ensureProjectWorktree').mockReturnValue({
      slug: 'diag', worktreePath: '/tmp/project[diag]', chatName: 'project[diag]',
      branch: 'work/diag', createdBranch: true, createdWorktree: true,
    }))
    await runWorktreeCommand({ chatId: 'oc_parent', sessionName: 'project' } as Session, 'diag', 'ou_owner')
    expect(sentRawTexts).toEqual([
      `❌ wt 卡片失败: diag\n${diagnostics}`,
      `❌ wt 卡片失败: diag\n${diagnostics}`,
    ])
  })
})
