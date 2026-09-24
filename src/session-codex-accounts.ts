import type { Session } from './session'
import { createHash } from 'node:crypto'
import * as feishu from './feishu'
import { codexAccounts, codexAccountInUse, processCodexAccount } from './codex-accounts'
import { codexLogins, requireDefaultCodexLogin } from './codex-login'
import { getTokenSourceForAccount, waitForTokenSourceModelRefresh } from './token-source'
import { aggregateCodexUsage, readAllCodexUsage, readCodexAccountEmails } from './codex-account-usage'
import { codexAccountScheduler } from './codex-account-scheduler'
import { CodexAccountCard } from './codex-account-card'
import { codexAccountCard, type CodexAccountCardView } from './cards/codex-account'
import { log } from './log'
import { consumeCodexResetCredit, invalidateCodexUsage, peekSuccessfulUsage, type CodexResetOutcome } from './usage'

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
export async function runCodexAccountCommand(s: Session, command: string, argument: string, userOpenId: string, messageId?: string): Promise<void> {
  if (command === 'reset') {
    await runCodexResetCommand(s, argument, messageId)
    return
  }
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

  const name = command === 'login' ? argument || '默认' : command === 'account' || command === 'account-delete' ? argument || undefined : undefined
  const namedLogin = command === 'login' && !!argument.trim() && !['default', '默认'].includes(argument.normalize('NFC').trim().toLowerCase())
  const card = await CodexAccountCard.open(s.chatId, { phase: command === 'login' ? 'connecting' : 'checking', name,
    ...(command === 'login' ? { flow: 'login' as const } : {}),
    message: command === 'accounts' ? '正在读取各账号邮箱与额度…' : namedLogin ? '正在检查默认账号登录状态…'
      : command === 'login' ? '正在获取设备码…' : '正在核对账号…' })
  try {
    if (command === 'account-delete') {
      if (!argument) throw new Error('请指定要删除的账号；使用 codex-account-delete 备注')
      const account = codexAccounts.find(argument)
      if (loginReceipts.has(account.id)) throw new Error('账号登录或结果更新尚未结束；请先完成或取消登录后重试')
      const { clearedSelections } = codexAccounts.remove(account.id)
      invalidateCodexUsage(account.id)
      await card.finish({ phase: 'deleted', name: account.name,
        message: '已删除本地账号记录与独立凭据，共享会话历史保留。',
        hint: clearedSelections ? `已清除 ${clearedSelections} 个群的指定，下次启动自动选号 · codex-accounts 查看` : 'codex-accounts 查看剩余账号' })
      return
    }
    if (command === 'accounts') {
      if (argument && !/^[1-9]\d*$/.test(argument)) throw new Error('页码无效；使用 codex-accounts [页码]')
      const page = argument ? Number(argument) : 1
      await waitForTokenSourceModelRefresh()
      const accountId = s.codexAccountId()
      const source = getTokenSourceForAccount('codex-sub', accountId)
      const modelLabel = () => s.currentProvider() === 'codex' ? s.currentModelLabel() : source?.defaultModel
      let model = modelLabel()
      let catalogError: string | undefined
      if (!model) {
        try {
          if (!source) throw new Error('Codex 订阅来源尚未初始化')
          await source.refreshModels()
          model = modelLabel()
          if (!model) throw new Error(source.modelCatalogState?.error ?? 'Codex 模型目录未提供可用的默认模型')
        } catch (error) { catalogError = `${codexAccounts.get(accountId).name}：${error instanceof Error ? error.message : String(error)}` }
      }
      // Account/usage reads do not require a model. An uninitialized default
      // account must not hide a successfully authenticated named account.
      const effort = s.currentProvider() === 'codex' ? s.currentEffortLabel() ?? undefined : undefined
      const decision = model ? await codexAccountScheduler.choose({ model, effort }) : null
      // The scheduler still receives the live failure and must not rank from
      // stale data; only the account panel gets the last successful rows.
      const total = decision ? aggregateCodexUsage(decision.candidates.flatMap(c => {
        const stale = c.usage?.state === 'network' || c.usage?.state === 'rate_limited'
          ? peekSuccessfulUsage(c.account.id) : null
        const usage = stale ?? c.usage
        return usage ? [{ account: c.account, usage, fingerprint: c.identity.startsWith('record:') ? null : c.identity }] : []
      })) : await readAllCodexUsage()
      if (catalogError) log(`codex-accounts: scheduling MISS: ${catalogError}`)
      await card.finish({ phase: 'accounts', total: await readCodexAccountEmails(total), currentId: accountId,
        ...(codexAccounts.preferred(s.sessionName) ? { selectedId: codexAccounts.selected(s.sessionName) } : {}), page,
        ...(decision ? { scheduling: { candidates: decision.candidates, ultra: effort === 'ultra' } }
          : { message: '⚠️ 调度顺序 MISS：尚未确定 Codex 模型', details: catalogError,
            hint: '可用 hi 备注指定已登录账号，或通过 md 检查模型目录' }) })
      return
    }
    if (command === 'auto') {
      if (argument) throw new Error('codex-auto 不需要备注')
      codexAccounts.selectAuto(s.sessionName)
      await card.finish({ phase: 'selected', name: '自动选择', current: codexAccounts.get(s.codexAccountId()).name,
        selected: '自动 · 未使用 / 临期 / 评分', hint: 'Ultra：Pro 且周余量 ≥ 0.5 份' })
      return
    }
    if (command === 'account') {
      if (!argument) {
        await card.finish({ phase: 'current', current: codexAccounts.get(s.codexAccountId()).name,
          selected: codexAccounts.preferred(s.sessionName) === null ? '自动 · 未使用 / 临期 / 评分' : codexAccounts.get(codexAccounts.selected(s.sessionName)).name,
          hint: '周剩余份额 ÷（重置小时 − 5）· codex-auto' })
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
    if (namedLogin) {
      await requireDefaultCodexLogin()
      await card.update({ phase: 'connecting', flow: 'login', name, message: '正在获取设备码…' })
    }
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
  } catch (error) {
    log(`codex-${command}: ${error}`)
    await card.finish(errorView(error, name))
  }
}

const RESET_MESSAGES: Record<CodexResetOutcome, { phase: CodexAccountCardView['phase']; title: string; message: string }> = {
  reset: { phase: 'success', title: '额度已重置', message: '已使用 1 次重置卡。' },
  alreadyRedeemed: { phase: 'success', title: '本次重置已完成', message: '本次请求此前已处理，没有重复使用重置卡。' },
  nothingToReset: { phase: 'current', title: '无需重置', message: '当前没有符合条件的额度窗口，未使用重置卡。' },
  noCredit: { phase: 'warning', title: '没有可用重置卡', message: '该账号没有可用的重置卡，额度未重置。' },
}

async function runCodexResetCommand(s: Session, argument: string, messageId?: string): Promise<void> {
  let account
  try {
    if (!messageId?.trim()) throw new Error('缺少消息 ID，未使用重置卡；请在群内发送 codex-reset [备注]')
    if (!argument && (!s.proc?.isAlive() || s.proc.provider !== 'codex'
      || s.proc.codexAccountSelectionMode?.() === null
      || (s.proc.turnRetry?.reason === 'quota' && s.proc.turnRetry.phase === 'waiting'))) {
      throw new Error('当前没有正在使用的 Codex 账号；请用 codex-reset 备注，或 codex-reset default 指定默认账号')
    }
    // Capture the actual account before the first await; a queued preference is not the active account.
    account = argument ? codexAccounts.find(argument) : codexAccounts.get(processCodexAccount(s.proc))
  } catch (error) { log(`codex-reset: ${error}`); await sendErrorCard(s, error); return }
  const card = await CodexAccountCard.open(s.chatId, { phase: 'checking', name: account.name,
    title: '正在使用重置卡', message: '正在提交重置请求…' })
  let result
  try {
    const idempotencyKey = createHash('sha256').update(JSON.stringify(['lodestar-codex-reset', s.chatId, messageId])).digest('hex')
    result = await consumeCodexResetCredit(account.id, idempotencyKey)
  } catch (error) { log(`codex-reset: ${error}`); await card.finish(errorView(error, account.name)); return }
  const view = RESET_MESSAGES[result.outcome]
  const usageError = result.usage.state === 'ok' ? undefined
    : `额度刷新失败：${result.usage.state === 'network' ? result.usage.reason ?? 'MISS' : result.usage.state}`
  const details = [usageError, result.cleanupError].filter(Boolean).join('\n')
  // A failed receipt write must not replace a confirmed redemption with a generic failure card.
  await card.finish({ ...view, name: account.name, resetUsage: result.usage,
    ...(details ? { phase: 'warning', details } : {}), hint: 'codex-accounts 查看各账号额度' })
}
