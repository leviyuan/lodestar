/** `lodestar update` 的实现：输出走 CliIo，错误交给分发器映射退出码。 */

import type { CliIo } from './cli-output'
import { runLodestarUpdate } from './update-run'

export async function runUpdate(argv: string[], io: CliIo): Promise<number> {
  return runLodestarUpdate(argv, { print: line => io.out(`${line ?? ''}\n`) })
}
