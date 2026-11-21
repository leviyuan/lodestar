/**
 * CLI 输出约定：颜色只在 TTY 且未显式关闭时启用，`NO_COLOR` 与 `--no-color` 都生效。
 *
 * `C` 是惰性代理：现有代码里的 `C.red` 写法不变，但取值时才判断是否着色，
 * 所以分发器解析完 `--no-color` 后再输出也能正确关闭。
 */

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
} as const

export type ColorName = keyof typeof CODES

/** 显式关闭（`--no-color`）或测试用的强制开关；undefined 表示按 TTY 判断。 */
let forced: boolean | undefined
let disabled = false

export function disableColor(): void {
  disabled = true
}

/** 测试辅助：true/false 强制开/关，undefined 恢复按 TTY 与 NO_COLOR 判断。 */
export function forceColor(enabled: boolean | undefined): void {
  forced = enabled
  if (enabled !== undefined) disabled = false
}

export function colorEnabled(): boolean {
  if (disabled) return false
  if (forced !== undefined) return forced
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.TERM === 'dumb') return false
  return process.stdout.isTTY === true
}

export const C = new Proxy({} as Record<ColorName, string>, {
  get(_target, key: string) {
    return colorEnabled() ? CODES[key as ColorName] ?? '' : ''
  },
})

/** 命令读写入口；测试替换成内存流。 */
export interface CliIo {
  out: (text: string) => void
  err: (text: string) => void
}

export const processIo: CliIo = {
  out: text => { process.stdout.write(text) },
  err: text => { process.stderr.write(text) },
}
