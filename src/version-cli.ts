/** Report the actual managed runtimes, not unrelated global CLI installations. */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AGENTS, agentRuntimeState } from './agent-updates'

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
console.log(`Lodestar v${manifest.version}`)
for (const agent of AGENTS) {
  try {
    const state = agentRuntimeState(agent)
    if (!state?.directory) { console.log(`${agent}: MISS（尚未安装）`); continue }
    if (!existsSync(state.directory)) throw new Error(`安装目录不存在: ${state.directory}`)
    const names = agent === 'dsh' ? ['@deepseek-ai/dsh'] : Object.keys(state.versions ?? {})
    console.log(`${agent}: ${names.map(name => `${name}@${state.versions?.[name] ?? 'MISS'}`).join(', ')}`)
    console.log(`  ${state.directory}`)
  } catch (error) { console.error(`${agent}: MISS（${error}）`); process.exitCode = 1 }
}
console.log(`Runtime: ${process.version} (${process.platform}-${process.arch})`)
