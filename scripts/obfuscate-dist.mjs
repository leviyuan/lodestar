/**
 * 发布前对 dist/ 的打包产物做轻度混淆：在 bun --minify 之上再隐藏字符串字面量并重命名标识符，
 * 让发布的 npm 包不便直接阅读。只处理 package.json 各 `build:*` 脚本 `--outfile=dist/*.js` 声明的
 * 打包产物；dist 顶层出现其他 .js（旧版本遗留等）直接报错，免得被一起混淆、打进发布包。随包的
 * .cjs 插件（postinstall 及其依赖）保持明文，避免安装期和源码运行的 daemon 跑混淆代码。
 *
 * 刻意只用安全变换："狠"的选项（控制流扁平化、死代码注入、自我保护、调试保护、renameGlobals）全部关闭；
 * renameProperties 必须关闭——飞书等接口的对象键（chat_id、open_id…）按字符串使用，改名会直接破坏请求。
 * 随机种子取包版本，同一版本的同一份打包产物每次混淆结果相同，可以从标签重建核对。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JavaScriptObfuscator from 'javascript-obfuscator'

const root = join(import.meta.dirname, '..')
const distDir = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
/** 已混淆产物的首行标记（shebang 之后），防止重复混淆。 */
const MARKER = '/* lodestar:obfuscated */\n'

/** 轻度、面向 Node 的安全配置。 */
const OPTIONS = {
  target: 'node',
  compact: true,
  simplify: true,
  seed: `lodestar@${pkg.version}`,
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

const expected = new Set(Object.values(pkg.scripts ?? {})
  .flatMap(script => [...String(script).matchAll(/--outfile=dist\/([\w.-]+\.js)(?=\s|$)/g)].map(match => match[1])))
if (expected.size === 0) throw new Error('obfuscate-dist: package.json 的 build 脚本没有声明 dist/*.js 产物')
const present = readdirSync(distDir).filter(name => name.endsWith('.js'))
const unexpected = present.filter(name => !expected.has(name))
if (unexpected.length) {
  throw new Error(`obfuscate-dist: dist/ 里有 build 脚本之外的 .js（${unexpected.join(', ')}），清空 dist/ 后重新 bun run build`)
}
const missing = [...expected].filter(name => !present.includes(name))
if (missing.length) throw new Error(`obfuscate-dist: 缺少打包产物 ${missing.join(', ')}，先运行打包步骤`)

for (const name of [...expected].sort()) {
  const path = join(distDir, name)
  const source = readFileSync(path, 'utf8')
  // CLI 产物带 `#!/usr/bin/env node`；混淆器不认 shebang，先摘掉、混淆后原样放回。
  const shebang = source.match(/^#![^\n]*\n/)?.[0] ?? ''
  const body = source.slice(shebang.length)
  if (body.startsWith(MARKER)) throw new Error(`obfuscate-dist: dist/${name} 已经混淆过，先重新运行打包步骤`)
  const obfuscated = JavaScriptObfuscator.obfuscate(body, OPTIONS).getObfuscatedCode()
  const output = shebang + MARKER + obfuscated
  writeFileSync(path, output)
  console.log(`obfuscated dist/${name}: ${Buffer.byteLength(source)} → ${Buffer.byteLength(output)} bytes`)
}
console.log(`obfuscate-dist: ${expected.size} bundle(s) done`)
