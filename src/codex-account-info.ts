import { codexAccounts } from './codex-accounts'

const emails = new Map<string, { revision: string; email: string | null; error?: string }>()

/** Native model/quota refreshes share their account/read result; readers never spawn a probe. */
export function observeCodexAccountEmail(accountId: string, account: any, revision: string): void {
  if (!codexAccounts.list().some(entry => entry.id === accountId) || codexAccounts.revision(accountId) !== revision) return
  const email = account?.type === 'chatgpt' && typeof account.email === 'string' ? account.email.trim() : ''
  emails.set(accountId, { revision, email: email || null,
    ...(!email ? { error: account?.type === 'chatgpt' ? '原生账号未提供邮箱' : '该账号未登录 ChatGPT' } : {}) })
}

export function peekCodexAccountEmail(accountId: string) {
  const value = emails.get(accountId)
  return value?.revision === codexAccounts.revision(accountId) ? value : undefined
}
