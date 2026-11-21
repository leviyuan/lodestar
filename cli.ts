/**
 * Lodestar 发布包入口 `lodestar`（dist/lodestar.js）。
 *
 * 该文件同时是 daemon 的运行入口：`lodestar` / `lodestar start` 会导入
 * daemon-entry 并常驻。统一入口让 `--help` / `--version` 在任何副作用之前
 * 返回。
 *
 * 首次安装的延迟导入只留在 daemon-entry 与分发器里：daemon.ts 同步导入
 * config，缺少配置时必须在导入它之前进入向导。
 */

import { runCli } from './src/cli-main'
import { ConfigError } from './src/config-error'
import { logError } from './src/log'

runCli(process.argv.slice(2)).then(
  code => { if (code !== 0) process.exitCode = code },
  (error: unknown) => {
    if (error instanceof ConfigError) process.stderr.write(`${error.message}\n`)
    logError('lodestar: startup failed', error)
    process.exit(1)
  },
)
