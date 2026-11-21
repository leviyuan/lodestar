/** CLI 错误分类：分发器按类型映射退出码，避免每个入口各写一套。 */

/** 用法错误（未知命令/选项、缺参数）：统一退出码 2。 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** 子命令内部的 `--help`：由分发器写到 stdout 并以 0 退出，不产生副作用。 */
export class HelpRequest extends Error {
  constructor(readonly text: string) {
    super(text)
    this.name = 'HelpRequest'
  }
}
