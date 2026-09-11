import type { Session } from './session'
import * as feishu from './feishu'
import { codexAccounts, codexAccountInUse } from './codex-accounts'
import { codexLogins } from './codex-login'
import { getTokenSourceForAccount, waitForTokenSourceModelRefresh } from './token-source'
import { aggregateCodexUsage } from './codex-account-usage'
import { codexAccountScheduler } from './codex-account-scheduler'
import { CodexAccountCard } from './codex-account-card'
import { codexAccountCard, type CodexAccountCardView } from './cards/codex-account'
import { log } from './log'

const loginReceipts = new Map<string, Promise<void>>()

function errorView(error: unknown, name?: string): CodexAccountCardView {
  const message = error instanceof Error ? error.message : String(error)
  const cancelled = !/失败|未完全退出/.test(message) && /登录已取消|服务退出/.test(message)
  const expired = /过期|等待超过|expired/i.test(message)
  const summary = message.split(/[\n；]/)[0]
  return { phase: cancelled ? 'cancelled' : expired ? 'expired' : 'error', name,
    message: summary.length > 80 ? summary.slice(0, 77) + '…' : summary,
    ...(message !== summary || summary.length > 80 ? { details: message } : {}) }
}

async function sendErrorCard(s: Session, error: unknown): Promise<void> {
  if (!await feishu.sendCard(s.chatId, codexAccountCard(errorView(error)))) throw new Error('Codex 错误卡片发送失败')
}

/** Explicit account selection bypasses quota/model catalog gates; uses the regular Session lifecycle. */
export async function runCodexNamedHi(s: Session, name: string): Promise<void> {
  const card = await CodexAccountCard.open(s.chatId, { phase: 'checking', name, message: '正在启动指定账号…' })
  try {
    const account = codexAccounts.find(name)
    let status = ''
    const ok = await s.startWithCodexAccount(account.id, { announce: false, onStatus: value => { status = value } })
    if (!ok) throw new Error(status || '指定账号启动失败')
    await card.finish({ phase: 'current', name: account.name, current: account.name,
      title: '已指定账号', hint: '本次手动指定 · 不参与自动排序' })
    await s.showConsole()
  } catch (error) { await card.finish(errorView(error, name)) }
}

/** Login receipts finish before daemon exit; authorization itself is cancelled by CodexLogins.shutdown first. */
export async function settleCodexAccountCards(): Promise<void> {
  const results = await Promise.allSettled([...loginReceipts.values()])
  const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason)
  if (errors.length) throw new AggregateError(errors, 'Codex 账号卡片未全部写入')
}

/** Bare codex-* commands own one compact card. Account selection never mutates the live process. */
export async function runCodexAccountCommand(s: Session, command: string, argument: string, userOpenId: string): Promise<void> {
  const owner = { chatId: s.chatId, userOpenId }
  if (command === 'login-cancel') {
    try {
      const pending = codexLogins.pending(owner)
      if (!argument && pending.length !== 1) throw new Error(pending.length ? '有多个登录任务；请指定 codex-login-cancel 备注' : '本群没有你的登录任务')
      const id = argument ? codexAccounts.find(argument).id : pending[0]
      await codexLogins.cancel(id, owner)
      await loginReceipts.get(id)
    } catch (error) { await sendErrorCard(s, error) }
    return
  }

  const name = command === 'login' ? argument || '默认' : command === 'account' ? argument || undefined : undefined
  const card = await CodexAccountCard.open(s.chatId, { phase: command === 'login' ? 'connecting' : 'checking', name,
    ...(command === 'login' ? { flow: 'login' as const } : {}),
    message: command === 'accounts' ? '正在读取各账号额度…' : command === 'login' ? '正在获取设备码…' : '正在核对账号…' })
  try {
    if (command === 'accounts') {
      if (argument && !/^[1-9]\d*$/.test(argument)) throw new Error('页码无效；使用 codex-accounts [页码]')
      const page = argument ? Number(argument) : 1
      const model = s.currentProvider() === 'codex' ? s.currentModelLabel() : getTokenSourceForAccount('codex-sub')?.defaultModel
      if (!model) throw new Error('Codex 模型 MISS，无法计算调度顺序')
      const effort = s.currentProvider() === 'codex' ? s.currentEffortLabel() ?? undefined : undefined
      const decision = await codexAccountScheduler.choose({ model, effort })
      const total = aggregateCodexUsage(decision.candidates.flatMap(c => c.usage ? [{ account: c.account, usage: c.usage,
        fingerprint: c.identity.startsWith('record:') ? null : c.identity }] : []))
      await card.finish({ phase: 'accounts', total, currentId: s.codexAccountId(),
        ...(codexAccounts.preferred(s.sessionName) ? { selectedId: codexAccounts.selected(s.sessionName) } : {}), page,
        scheduling: { candidates: decision.candidates, ultra: effort === 'ultra' },
        hint: '最高分优先 · hi 备注可直接指定账号' })
      return
    }
    if (command === 'auto') {
      if (argument) throw new Error('codex-auto 不需要备注')
      codexAccounts.selectAuto(s.sessionName)
      await card.finish({ phase: 'selected', name: '自动选择', current: codexAccounts.get(s.codexAccountId()).name,
        selected: '自动 · 最高分优先', hint: 'Ultra：Pro 且周余量 ≥ 0.5 份' })
      return
    }
    if (command === 'account') {
      if (!argument) {
        await card.finish({ phase: 'current', current: codexAccounts.get(s.codexAccountId()).name,
          selected: codexAccounts.preferred(s.sessionName) === null ? '自动 · 最高分优先' : codexAccounts.get(codexAccounts.selected(s.sessionName)).name,
          hint: '周剩余份额 ÷ 重置小时 · codex-auto' })
        return
      }
      const account = codexAccounts.find(argument)
      const model = s.currentProvider() === 'codex' ? s.currentModelLabel() : null
      const effort = s.currentProvider() === 'codex' ? s.currentEffortLabel() : null
      const current = codexAccounts.get(s.codexAccountId()).name
      if (s.currentProvider() === 'codex') feishu.bindSessionModelChecked(s.sessionName, 'codex', model, effort, 'codex-sub')
      codexAccounts.select(s.sessionName, account.id)
      if (s.currentProvider() === 'codex') {
        s.selectedModel = model
        s.selectedEffort = effort
        s.selectedTokenSourceId = 'codex-sub'
      }
      await card.finish({ phase: 'selected', name: account.name, current, selected: account.name, hint: 'restart 直接使用 · 不检查调度门槛' })
      return
    }
    if (command !== 'login') throw new Error('未知 Codex 账号命令')
    if (!userOpenId) throw new Error('无法确认登录发起者')
    const account = codexAccounts.ensure(argument)
    if (codexAccountInUse(account.id)) throw new Error('账号正在使用中；重新登录前先 kill 使用该账号的会话，或用新备注添加账号')
    if (loginReceipts.has(account.id)) throw new Error('登录结果正在更新，请稍等')
    const handle = await codexLogins.start(account.id, owner)
    try {
      await card.update({ phase: 'waiting', flow: 'login', name: account.name, verification: { url: handle.verificationUrl, code: handle.userCode },
        hint: `取消：codex-login-cancel${argument ? ` ${account.name}` : ''}` })
    } catch (error) {
      await codexLogins.cancel(account.id, owner)
      throw error
    }
    const receipt = (async () => {
      let info
      try { info = await handle.done }
      catch (error) { await card.finish(errorView(error, account.name)); return }
      await card.update({ phase: 'checking', flow: 'login', name: account.name, message: '授权完成，正在读取模型…' })
      let catalogError: string | undefined
      try {
        await waitForTokenSourceModelRefresh()
        const source = getTokenSourceForAccount('codex-sub', account.id)
        if (!source) throw new Error('Codex 订阅来源尚未初始化')
        await source.refreshModels()
        if (source.modelCatalogState?.status !== 'ready') throw new Error(source.modelCatalogState?.error ?? '模型目录未就绪')
      } catch (error) { catalogError = error instanceof Error ? error.message : String(error) }
      await card.finish({ phase: catalogError ? 'warning' : 'success', flow: 'login', name: account.name, email: info.email, plan: info.planType,
        ...(catalogError ? { title: '已登录 · 目录 MISS', details: catalogError } : {}),
        hint: `已加入自动选择 · 优先使用：codex-account ${account.id === 'default' ? 'default' : account.name}` })
    })()
    loginReceipts.set(account.id, receipt)
    const release = () => { if (loginReceipts.get(account.id) === receipt) loginReceipts.delete(account.id) }
    void receipt.then(release, error => { log(`codex-login: terminal card write failed: ${error}`); release() })
  } catch (error) { await card.finish(errorView(error, name)) }
}
