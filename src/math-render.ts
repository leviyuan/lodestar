/**
 * Assistant Markdown 公式管线。
 *
 * - 代码围栏/行内代码保持字面量，不参与公式识别。
 * - 简单 inline 公式转成 Unicode 文本，复杂 inline 与 display 公式渲染成图。
 * - 返回严格按源码顺序排列的 markdown/image blocks，调用方可原位插入卡片。
 * - 任何渲染或上传失败都在原位置保留完整 LaTeX，并写明错误日志。
 *
 * MathJax 会把缺少内置轮廓的 CJK 直接输出为 SVG <text>；Resvg 加载当前
 * 平台的系统 CJK 字体链。不要再用字符占位/路径替换：那会与真实变量
 * 冲突，也会在长中文公式中生成非法 TeX。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { log, logError } from './log.ts'
import { findMarkdownCodeRanges } from './markdown-code.ts'

const require_ = createRequire(import.meta.url)

const EX_RATIO = 0.5
const DISPLAY_EM = 22
const INK = '#1F2329'
const PAPER = '#F7F8FA'
const PAD_X = 12
const PAD_Y = 8
const MAX_IMAGE_WIDTH = 720
const MIN_CONTENT_HEIGHT = 14
/** 飞书历史 custom_width/compact_width 的移动端安全宽度是 278px。小图
 * 保持原尺寸；更宽的图交给 fit_horizontal 按实际卡片容器响应式缩小。 */
const MAX_FIXED_FORMULA_WIDTH = 278
const CACHE_VERSION = 'v4-native-cjk-tail-pad'
/** MathJax 的 CJK <text> advance 是 1000 SVG unit，但根 viewBox 会停在
 * 最后一个字的 origin，未计入该字实际轮廓。预留略大于一个 advance，防
 * 最长一行的末字在 nested SVG 内部被裁掉。 */
const NATIVE_TEXT_TAIL_UNITS = 1100
const CJK_FONT_FAMILY = process.platform === 'win32'
  ? 'Microsoft YaHei'
  : process.platform === 'darwin'
    ? 'PingFang SC'
    : 'Noto Sans CJK SC'
const CJK_FONT_FALLBACKS = 'Noto Sans CJK SC, Noto Sans CJK JP, Microsoft YaHei, PingFang SC, Arial Unicode MS, sans-serif'

type MathJaxRuntime = {
  adaptor: ReturnType<typeof import('mathjax-full/js/adaptors/liteAdaptor.js')['liteAdaptor']>
  doc: ReturnType<typeof import('mathjax-full/js/mathjax.js')['mathjax']['document']>
}

const mjxByEm = new Map<number, MathJaxRuntime>()

function mathjaxRuntime(em: number): MathJaxRuntime {
  const existing = mjxByEm.get(em)
  if (existing) return existing

  const { liteAdaptor } = require_('mathjax-full/js/adaptors/liteAdaptor.js')
  const { RegisterHTMLHandler } = require_('mathjax-full/js/handlers/html.js')
  const { mathjax } = require_('mathjax-full/js/mathjax.js')
  const { TeX } = require_('mathjax-full/js/input/tex.js')
  const { AllPackages } = require_('mathjax-full/js/input/tex/AllPackages.js')
  const { SVG } = require_('mathjax-full/js/output/svg.js')
  const adaptor = liteAdaptor({ fontSize: em })
  RegisterHTMLHandler(adaptor)
  const doc = mathjax.document('', {
    InputJax: new TeX({ packages: AllPackages }),
    OutputJax: new SVG({ fontCache: 'none' }),
  })
  const runtime = { adaptor, doc }
  mjxByEm.set(em, runtime)
  return runtime
}

interface FormulaSvg {
  svg: string
  width: number
  height: number
}

function parseNumber(value: string | undefined, label: string): number {
  const parsed = Number.parseFloat(value ?? '')
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`MathJax SVG missing valid ${label}`)
  }
  return parsed
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** TeX → 带浅色不透明底与 padding 的独立 SVG。 */
function renderTeXToSVG(texSrc: string, em = DISPLAY_EM, display = true): FormulaSvg | null {
  try {
    const ex = em * EX_RATIO
    const { adaptor, doc } = mathjaxRuntime(em)
    const node = doc.convert(texSrc, { display, em, ex, containerWidth: 80 * em })
    const outer = adaptor.outerHTML(node)
    if (/data-mjx-error=|mjx-merror/.test(outer)) {
      const detail = outer.match(/data-mjx-error="([^"]+)"/)?.[1] ?? 'MathJax parse error'
      throw new Error(detail)
    }

    const svgStart = outer.indexOf('<svg')
    const svgEnd = outer.lastIndexOf('</svg>')
    if (svgStart < 0 || svgEnd < 0) throw new Error('MathJax returned no SVG')
    const markup = outer.slice(svgStart, svgEnd + 6)
    const openTag = markup.match(/^<svg\b[^>]*>/)?.[0]
    if (!openTag) throw new Error('MathJax returned malformed SVG root')

    const widthEx = parseNumber(openTag.match(/\bwidth="([\d.]+)ex"/)?.[1], 'width')
    const heightEx = parseNumber(openTag.match(/\bheight="([\d.]+)ex"/)?.[1], 'height')
    const viewBox = openTag.match(/\bviewBox="([^"]+)"/)?.[1]
    if (!viewBox) throw new Error('MathJax SVG missing viewBox')
    const viewBoxParts = viewBox.trim().split(/[\s,]+/).map(Number)
    if (
      viewBoxParts.length !== 4 ||
      viewBoxParts.some(part => !Number.isFinite(part)) ||
      viewBoxParts[2] <= 0 ||
      viewBoxParts[3] <= 0
    ) {
      throw new Error('MathJax SVG has invalid viewBox')
    }
    const [viewBoxX, viewBoxY, viewBoxWidth, viewBoxHeight] = viewBoxParts
    const nativeTextTail = /<text\b/.test(markup) ? NATIVE_TEXT_TAIL_UNITS : 0
    const safeViewBox = `${viewBoxX} ${viewBoxY} ${viewBoxWidth + nativeTextTail} ${viewBoxHeight}`

    const baseNaturalWidth = widthEx * ex
    const nativeTextTailPx = nativeTextTail * (baseNaturalWidth / viewBoxWidth)
    const naturalWidth = Math.max(1, Math.ceil(baseNaturalWidth + nativeTextTailPx))
    const naturalHeight = Math.max(1, Math.ceil(heightEx * ex))
    const maxContentWidth = MAX_IMAGE_WIDTH - PAD_X * 2
    const scale = Math.min(1, maxContentWidth / naturalWidth)
    const contentWidth = Math.max(1, Math.round(naturalWidth * scale))
    const contentHeight = Math.max(1, Math.round(naturalHeight * scale))
    if (scale < 1 && contentHeight < MIN_CONTENT_HEIGHT) {
      throw new Error(`formula would be unreadable after width cap (${contentWidth}x${contentHeight})`)
    }
    const width = contentWidth + PAD_X * 2
    const height = contentHeight + PAD_Y * 2

    const body = markup.slice(openTag.length, -6)
      .replace(/currentColor/g, INK)
      .replace(/font-family="serif"/g, `font-family="${CJK_FONT_FALLBACKS}"`)
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="color:${INK}">`,
      `<rect x="0" y="0" width="${width}" height="${height}" rx="6" fill="${PAPER}"/>`,
      `<svg x="${PAD_X}" y="${PAD_Y}" width="${contentWidth}" height="${contentHeight}" viewBox="${escapeXmlAttribute(safeViewBox)}" preserveAspectRatio="xMidYMid meet">`,
      body,
      '</svg>',
      '</svg>',
    ].join('')
    return { svg, width, height }
  } catch (error) {
    logError('math-render: TeX to SVG failed', error)
    return null
  }
}

/** TeX → 跨明暗主题可读的 PNG bytes 与精确像素尺寸。 */
export function renderTeXToPNG(
  texSrc: string,
  em = DISPLAY_EM,
  display = true,
): { png: Uint8Array; width: number; height: number } | null {
  const renderedSvg = renderTeXToSVG(texSrc, em, display)
  if (!renderedSvg) return null
  try {
    const { Resvg } = require_('@resvg/resvg-js') as typeof import('@resvg/resvg-js')
    const rendered = new Resvg(renderedSvg.svg, {
      background: PAPER,
      fitTo: { mode: 'original' },
      shapeRendering: 2,
      textRendering: 1,
      font: {
        loadSystemFonts: true,
        serifFamily: CJK_FONT_FAMILY,
        sansSerifFamily: CJK_FONT_FAMILY,
      },
    }).render()
    const png = rendered.asPng()
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    if (width !== renderedSvg.width || height !== renderedSvg.height) {
      throw new Error(`PNG dimensions ${width}x${height} != SVG ${renderedSvg.width}x${renderedSvg.height}`)
    }
    return { png, width, height }
  } catch (error) {
    logError('math-render: SVG to PNG failed', error)
    return null
  }
}

// ── 代码感知公式定位 ─────────────────────────────────────────────────

export interface MathSpan {
  start: number
  end: number
  tex: string
  raw: string
  display: boolean
}

function looksLikeSingleDollarMath(tex: string): boolean {
  if (/^[A-Za-zΑ-ω]$/.test(tex)) return true
  if (/\\[A-Za-z]+|[_^=]|[{}]|[≤≥≠≈∑∫√]/.test(tex)) return true
  return /[A-Za-zΑ-ω]\s*[+\-*/<>]\s*[A-Za-zΑ-ω0-9]/.test(tex)
}

function findMathInProse(prose: string, offset: number): MathSpan[] {
  const spans: MathSpan[] = []
  const push = (match: RegExpExecArray, tex: string, display: boolean): void => {
    const raw = match[0]
    const trimmed = tex.trim()
    if (!trimmed) return
    spans.push({
      start: offset + match.index,
      end: offset + match.index + raw.length,
      tex: trimmed,
      raw,
      display,
    })
  }

  let match: RegExpExecArray | null
  const display = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|\\\[([\s\S]+?)\\\]/g
  while ((match = display.exec(prose)) !== null) {
    push(match, match[1] ?? match[2] ?? '', true)
  }

  const inlineParen = /\\\(([\s\S]+?)\\\)/g
  while ((match = inlineParen.exec(prose)) !== null) push(match, match[1] ?? '', false)

  // 两侧都不能紧邻另一个 `$`，否则 `$$display$$` 的第二/第四个 `$`
  // 会被误当成一组 single-dollar，并把后续真正的 inline 区间一起吞掉。
  const singleDollar = /(?<![\\$])\$(?!\$)([^$\n]+?)(?<![\\$])\$(?!\$)/g
  while ((match = singleDollar.exec(prose)) !== null) {
    const tex = (match[1] ?? '').trim()
    if (looksLikeSingleDollarMath(tex)) push(match, tex, false)
  }

  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const nonOverlapping: MathSpan[] = []
  let consumedUntil = -1
  for (const span of spans) {
    if (span.start < consumedUntil) continue
    nonOverlapping.push(span)
    consumedUntil = span.end
  }
  return nonOverlapping
}

function findMathSpans(text: string): MathSpan[] {
  const protectedRanges = findMarkdownCodeRanges(text)
  const spans: MathSpan[] = []
  let last = 0
  for (const range of protectedRanges) {
    if (last < range.start) spans.push(...findMathInProse(text.slice(last, range.start), last))
    last = Math.max(last, range.end)
  }
  if (last < text.length) spans.push(...findMathInProse(text.slice(last), last))
  return spans
}

// ── inline Unicode 转写 ───────────────────────────────────────────────

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ',
  Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
}

function unicodeMathify(tex: string): string | null {
  let value = tex
  value = value.replace(/\\text\{([^{}]*)\}/g, '$1')
  value = value.replace(/\\left\s*/g, '').replace(/\\right\s*/g, '')
  value = value.replace(/\\([A-Za-z]+)\b/g, (whole, name: string) => {
    if (GREEK[name]) return GREEK[name]
    if (name === 'times') return '×'
    if (name === 'cdot') return '·'
    if (name === 'div') return '÷'
    if (name === 'pm') return '±'
    if (name === 'leq' || name === 'le') return '≤'
    if (name === 'geq' || name === 'ge') return '≥'
    if (name === 'neq' || name === 'ne') return '≠'
    if (name === 'approx') return '≈'
    if (name === 'sim') return '~'
    if (name === 'infty') return '∞'
    if (name === 'partial') return '∂'
    if (name === 'nabla') return '∇'
    if (name === 'sqrt') return '√'
    if (name === 'to') return '→'
    return whole
  })
  // 任何未消费的 TeX 转义都走图片，避免把半截命令冒充 Unicode 结果。
  if (/\\/.test(value)) return null
  value = value.replace(/([_^])\{([^{}]+)\}/g, (_whole, operator: string, body: string) =>
    body.length === 1 ? `${operator}${body}` : `${operator}(${body})`)
  value = value.replace(/√\{([^{}]+)\}/g, '√($1)')
  if (/[{}]/.test(value)) return null
  return value
}

// ── PNG 上传、缓存与有序 block 输出 ─────────────────────────────────

export interface FormulaUploadMeta {
  tex: string
  width: number
  height: number
}

export type FormulaUploader = (
  filePath: string,
  meta: FormulaUploadMeta,
) => Promise<string | null>

export interface FormulaImageElement {
  tag: 'img'
  img_key: string
  alt: { tag: 'plain_text'; content: string }
  scale_type: 'crop_center' | 'fit_horizontal'
  size?: string
  preview: false
}

export type RenderedMathBlock =
  | { type: 'markdown'; text: string }
  | { type: 'image'; tex: string; index: number; element: FormulaImageElement }

export interface RenderMathResult {
  blocks: RenderedMathBlock[]
  formulaCount: number
  renderedImageCount: number
}

export interface RenderMathOptions {
  uploader?: FormulaUploader
}

interface UploadedFormula {
  key: string
  width: number
  height: number
}

const defaultUploader: FormulaUploader = async (filePath) => {
  // 延迟导入：纯解析/PNG 单测不应同步读取真实 Lodestar config 或凭据。
  const { uploadImageKey } = await import('./feishu.ts')
  return uploadImageKey(filePath)
}

let uploaderIds = new WeakMap<FormulaUploader, number>()
let nextUploaderId = 1
const uploadedCache = new Map<string, UploadedFormula>()
const uploadInflight = new Map<string, Promise<UploadedFormula | null>>()
const MAX_UPLOADED_FORMULA_CACHE = 512

function uploaderId(uploader: FormulaUploader): number {
  let id = uploaderIds.get(uploader)
  if (id !== undefined) return id
  id = nextUploaderId++
  uploaderIds.set(uploader, id)
  return id
}

function uploadCacheKey(tex: string, uploader: FormulaUploader): string {
  return `${CACHE_VERSION}\0${uploaderId(uploader)}\0${tex}`
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

async function uploadTeX(tex: string, uploader: FormulaUploader): Promise<UploadedFormula | null> {
  const cacheKey = uploadCacheKey(tex, uploader)
  const cached = uploadedCache.get(cacheKey)
  if (cached) return cached
  const running = uploadInflight.get(cacheKey)
  if (running) return running

  const task = (async (): Promise<UploadedFormula | null> => {
    const rendered = renderTeXToPNG(tex, DISPLAY_EM, true)
    if (!rendered) return null

    let tempDir: string | null = null
    try {
      tempDir = await mkdtemp(join(tmpdir(), 'lodestar-math-'))
      const filePath = join(tempDir, `formula-${fnv1a(tex)}.png`)
      await writeFile(filePath, rendered.png)
      const key = await uploader(filePath, {
        tex,
        width: rendered.width,
        height: rendered.height,
      })
      if (!key) {
        log('math-render: upload returned no image key')
        return null
      }
      const uploaded = { key, width: rendered.width, height: rendered.height }
      if (uploadedCache.has(cacheKey)) uploadedCache.delete(cacheKey)
      uploadedCache.set(cacheKey, uploaded)
      while (uploadedCache.size > MAX_UPLOADED_FORMULA_CACHE) {
        const oldest = uploadedCache.keys().next().value
        if (typeof oldest !== 'string') break
        uploadedCache.delete(oldest)
      }
      return uploaded
    } catch (error) {
      logError('math-render: upload failed', error)
      return null
    } finally {
      if (tempDir) {
        try {
          await rm(tempDir, { recursive: true, force: true })
        } catch (error) {
          logError('math-render: temporary file cleanup failed', error)
        }
      }
    }
  })()

  uploadInflight.set(cacheKey, task)
  try {
    return await task
  } finally {
    uploadInflight.delete(cacheKey)
  }
}

function imageBlock(uploaded: UploadedFormula, span: MathSpan, index: number): RenderedMathBlock {
  const fitsFixedWidth = uploaded.width <= MAX_FIXED_FORMULA_WIDTH
  return {
    type: 'image',
    tex: span.tex,
    index,
    element: {
      tag: 'img',
      img_key: uploaded.key,
      alt: {
        tag: 'plain_text',
        content: span.tex.replace(/\s+/g, ' ').slice(0, 80),
      },
      scale_type: fitsFixedWidth ? 'crop_center' : 'fit_horizontal',
      ...(fitsFixedWidth ? { size: `${uploaded.width}px ${uploaded.height}px` } : {}),
      preview: false,
    },
  }
}

/**
 * 一段 assistant Markdown → 原位有序 blocks。
 *
 * 例：`A $$x$$ B $$y$$ C` 返回
 * markdown(A), image(x), markdown(B), image(y), markdown(C)。
 */
export async function renderMathInText(
  text: string,
  options: RenderMathOptions = {},
): Promise<RenderMathResult> {
  const spans = findMathSpans(text)
  if (!spans.length) {
    return {
      blocks: [{ type: 'markdown', text }],
      formulaCount: 0,
      renderedImageCount: 0,
    }
  }

  const uploader = options.uploader ?? defaultUploader
  const resolved = await Promise.all(spans.map(async span => {
    if (!span.display) {
      const unicode = unicodeMathify(span.tex)
      if (unicode !== null) return { unicode, uploaded: null }
    }
    return { unicode: null, uploaded: await uploadTeX(span.tex, uploader) }
  }))
  const blocks: RenderedMathBlock[] = []
  let markdown = ''
  let last = 0
  let imageIndex = 0

  const flushMarkdown = (): void => {
    if (!markdown) return
    // 独立 image 元素已提供视觉间距；不要为公式两侧纯换行创建空元素。
    if (markdown.trim()) blocks.push({ type: 'markdown', text: markdown })
    markdown = ''
  }

  for (let spanIndex = 0; spanIndex < spans.length; spanIndex++) {
    const span = spans[spanIndex]
    const replacement = resolved[spanIndex]
    markdown += text.slice(last, span.start)
    if (replacement.unicode !== null) {
      markdown += replacement.unicode
      last = span.end
      continue
    }

    const uploaded = replacement.uploaded
    if (!uploaded) {
      markdown += span.raw
      last = span.end
      continue
    }

    flushMarkdown()
    blocks.push(imageBlock(uploaded, span, imageIndex++))
    last = span.end
  }

  markdown += text.slice(last)
  flushMarkdown()
  if (!blocks.length) blocks.push({ type: 'markdown', text })
  return {
    blocks,
    formulaCount: spans.length,
    renderedImageCount: imageIndex,
  }
}

export function hasMathSpans(text: string): boolean {
  return findMathSpans(text).length > 0
}

function resetUploadStateForTests(): void {
  uploadedCache.clear()
  uploadInflight.clear()
  uploaderIds = new WeakMap()
  nextUploaderId = 1
}

export const __test = {
  findCodeRanges: findMarkdownCodeRanges,
  findMathSpans,
  renderTeXToSVG,
  renderTeXToPNG,
  unicodeMathify,
  resetUploadStateForTests,
  constants: {
    INK,
    PAPER,
    PAD_X,
    PAD_Y,
    MAX_IMAGE_WIDTH,
    MIN_CONTENT_HEIGHT,
    MAX_FIXED_FORMULA_WIDTH,
    CJK_FONT_FAMILY,
    NATIVE_TEXT_TAIL_UNITS,
  },
}
