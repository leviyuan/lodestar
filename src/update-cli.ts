/**
 * CLI entry for `lodestar-update` bin.
 *
 * 更新 Lodestar 与实际使用的 Agent runtimes；--agents-only 仅立即更新 Agent。
 * daemon 自身的服务生命周期仍由用户控制。
 */

import { runLodestarUpdate, UPDATE_ERROR_PREFIX } from './update-run'

runLodestarUpdate(process.argv.slice(2)).then(code => {
  if (code !== 0) process.exit(code)
}, (e: any) => {
  console.error(`${UPDATE_ERROR_PREFIX} ${e?.message ?? e}`)
  process.exit(1)
})
