/** Persist SDK-reported context windows by source/model. Request failures do
 * not supply a capacity number and must not overwrite these observations. */

import { existsSync, readFileSync } from 'node:fs'
import { CONTEXT_WINDOW_CACHE_FILE as CACHE_FILE_CONST } from './paths'
import { logError } from './log'
import { writeJsonStateAtomic } from './state-store'

/** 惰性取缓存路径:paths 常量是 import 时按当时 LODESTAR_DATA_DIR 求值的,
 *  测试套件里晚设的 env 要能生效(单跑/全量一致)。生产路径不变。 */
function cacheFile(): string {
  return process.env.LODESTAR_DATA_DIR
    ? `${process.env.LODESTAR_DATA_DIR.replace(/\/+$/, '')}/context-window-cache.json`
    : CACHE_FILE_CONST
}

/** 1M 判定阈值:观测窗口 ≥ 此值视为 1M 能力(实际值只有 200000/1000000 两档)。 */
export const CONTEXT_1M_THRESHOLD = 1_000_000

type WindowCache = Record<string, number>

let cache: WindowCache | null = null

function loadCache(): WindowCache {
  if (cache !== null) return cache
  try {
    cache = existsSync(cacheFile())
      ? JSON.parse(readFileSync(cacheFile(), 'utf8'))
      : {}
  } catch (e: any) {
    logError('context-window-observe: cache read failed', e)
    cache = {}
  }
  return cache ?? {}
}

function saveCache(): void {
  try {
    writeJsonStateAtomic(cacheFile(), loadCache())
  } catch (e: any) {
    logError('context-window-observe: cache write failed', e)
  }
}

function keyOf(sourceId: string, model: string): string {
  return `${sourceId}:${model.replace(/\[1m\]$/, '')}`
}

/** 观测上报:真实 turn 的 contextWindow写入缓存。
 *  单调不降?不 —— 新的 SDK 上报可以纠正旧值,但同值幂等。 */
export function observeContextWindow(sourceId: string, model: string, window: number): void {
  if (!Number.isFinite(window) || window <= 0) return
  const key = keyOf(sourceId, model)
  const prev = loadCache()[key]
  if (prev === window) return
  loadCache()[key] = window
  saveCache()
}

/** spawn 决策:观测到 1M → 加 [1m];观测 <1M → 裸名;未观测 → 默认 [1m]
 *  (保持已有模型路由约定)。已带后缀 pass-through，不因请求报错更改。
 *  空模型(端点拉取 MISS 且 config 无 model 键)→ undefined:不下发垃圾串,
 *  spawn 侧走 SDK 默认 alias 路径,失败如实暴露。 */
export function resolveModelWithWindow(sourceId: string, model: string): string | undefined {
  if (!model) return undefined
  if (model.endsWith('[1m]')) return model
  const observed = loadCache()[keyOf(sourceId, model)]
  return observed != null && observed < CONTEXT_1M_THRESHOLD ? model : `${model}[1m]`
}

/** 面板显示用:观测到的窗口(未观测 = undefined,显示侧如实 MISS,不猜)。 */
export function observedContextWindow(sourceId: string, model: string): number | undefined {
  return loadCache()[keyOf(sourceId, model)]
}

/** 仅供测试重置内存缓存。 */
export function resetContextWindowCache(): void {
  cache = null
}
