/**
 * 发布前对 dist/ 的打包产物做轻度混淆：在 bun --minify 之上再隐藏字符串字面量并重命名标识符，
 * 让发布的 npm 包不便直接阅读。只对 dist 顶层的 .js 打包文件生效；随包的 .cjs 插件（postinstall
 * 及其依赖）保持明文，避免安装期和源码运行的 daemon 跑混淆代码。
 *
 * 刻意只用安全变换："狠"的选项（控制流扁平化、死代码注入、自我保护、调试保护、renameGlobals）全部关闭；
 * renameProperties 必须关闭——飞书等接口的对象键（chat_id、open_id…）按字符串使用，改名会直接破坏请求。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JavaScriptObfuscator from 'javascript-obfuscator'

const distDir = join(import.meta.dirname, '..', 'dist')

/** 轻度、面向 Node 的安全配置。 */
const OPTIONS = {
  target: 'node',
  compact: true,
  simplify: true,
  // 标识符重命名（minify 已给短名，这里再换成十六进制）。全局名与属性名都保留，避免破坏外部引用与接口字段。
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  renameProperties: false,
  // 字符串隐藏：把提示词、消息、接口路径等移进 base64 数组，直接 grep 看不到——这是“不便阅读”的主要来源。
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ['base64'],
  stringArrayWrappersCount: 1,
  stringArrayWrappersType: 'variable',
  splitStrings: false,
  // 下列“狠”的变换一律关闭：破坏调试、增加体积与运行开销，也更容易触发偶发运行期故障。
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  selfDefending: false,
  disableConsoleOutput: false,
  numbersToExpressions: false,
  unicodeEscapeSequence: false,
  sourceMap: false,
}

let count = 0
for (const name of readdirSync(distDir)) {
  if (!name.endsWith('.js')) continue
  const path = join(distDir, name)
  const source = readFileSync(path, 'utf8')
  // CLI 产物带 `#!/usr/bin/env node`；混淆器不认 shebang，先摘掉、混淆后原样放回。
  const shebang = source.match(/^#![^\n]*\n/)?.[0] ?? ''
  const body = source.slice(shebang.length)
  const obfuscated = JavaScriptObfuscator.obfuscate(body, OPTIONS).getObfuscatedCode()
  const output = shebang + obfuscated
  writeFileSync(path, output)
  count++
  console.log(`obfuscated dist/${name}: ${source.length} → ${output.length} bytes`)
}
if (count === 0) throw new Error('obfuscate-dist: no dist/*.js bundles found; run the bundle steps first')
console.log(`obfuscate-dist: ${count} bundle(s) done`)
