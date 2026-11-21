/** 发布版本号：`lodestar --version` 与 `lodestar version` 共用同一份 package.json。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let cached: string | undefined

export function lodestarVersion(): string {
  if (cached) return cached
  // 源码运行时是 src/version.ts，发布包运行时是 dist/lodestar.js；
  // 两种布局的相对位置都是 package.json，故统一 ../package.json。
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  if (typeof manifest?.version !== 'string' || !manifest.version) {
    throw new Error('package.json 缺少 version')
  }
  const version: string = manifest.version
  cached = version
  return version
}
