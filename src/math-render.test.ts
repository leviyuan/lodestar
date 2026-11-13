import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

import {
  __test,
  hasMathSpans,
  renderMathInText,
  renderTeXToPNG,
  type FormulaUploader,
} from './math-render.ts'

const { findMathSpans, renderTeXToSVG } = __test

afterEach(() => __test.resetUploadStateForTests())

describe('findMathSpans', () => {
  test('识别 display、括号 inline 与有数学特征的单美元公式', () => {
    const spans = findMathSpans('A $$S=E_{net}$$ B \\[a+b\\] C \\(x\\) D $y^2+1$ E $S$')
    expect(spans.map(span => [span.tex, span.display])).toEqual([
      ['S=E_{net}', true],
      ['a+b', true],
      ['x', false],
      ['y^2+1', false],
      ['S', false],
    ])
  })

  test('货币文本与无数学特征的单美元内容不误伤', () => {
    expect(findMathSpans('价格 $5 和 $10，套餐 $USD$')).toHaveLength(0)
    expect(hasMathSpans('价格 $5 和 $10')).toBe(false)
  })

  test('真实 fenced code、tilde fence 与 inline code 都保持字面量', () => {
    const text = [
      '外部 $$ok$$',
      '```tex',
      '$$fenced$$',
      '\\(also_fenced\\)',
      '```',
      '~~~md',
      '$single^2$',
      '~~~',
      '行内 `\\(inline_code\\)` 与 ``$$code2$$``',
    ].join('\n')
    expect(findMathSpans(text).map(span => span.tex)).toEqual(['ok'])
  })

  test('空公式跳过', () => {
    expect(findMathSpans('$$$$')).toHaveLength(0)
    expect(findMathSpans('\\(\\)')).toHaveLength(0)
  })
})

describe('renderTeXToPNG native CJK', () => {
  test('真实长中文 cases 直接由 MathJax text + Noto 渲染', () => {
    const first = '两腿OI和剩余容量都足够'
    const second = '任意一腿OI或容量不足'
    const third = '必要数据尚未准备好'
    const tex = [
      'S_{\\text{final}}=',
      '\\begin{cases}',
      `S_{\\text{economic}}, & ${first}\\\\`,
      `0, & ${second}\\\\`,
      `\\text{MISS}, & ${third}`,
      '\\end{cases}',
    ].join('\n')
    const svg = renderTeXToSVG(tex)
    expect(svg).not.toBeNull()
    const textContent = svg!.svg.replace(/<[^>]+>/g, '')
    // 裸 OI 在 math mode 下由 MathJax 轮廓 path 表示；中文仍是原生 text。
    expect(textContent).toContain(first.replace('OI', ''))
    expect(textContent).toContain(second.replace('OI', ''))
    expect(textContent).toContain(third)
    expect(svg!.svg).toContain('data-c="1D442"') // italic O
    expect(svg!.svg).toContain('data-c="1D43C"') // italic I
    const result = renderTeXToPNG(tex)
    expect(result).not.toBeNull()
    expect(result!.png.length).toBeGreaterThan(1_000)
    expect(result!.width).toBeLessThanOrEqual(__test.constants.MAX_IMAGE_WIDTH)
    expect(result!.height).toBeGreaterThan(40)
  })

  test('原变量 q 与超过 26 个 CJK 字符互不碰撞', () => {
    const cjk = '这是超过二十六个中文字的长公式说明用于验证变量不会被替换错位以及渲染稳定'
    const tex = `q + \\text{${cjk}}`
    const svg = renderTeXToSVG(tex)
    expect(svg).not.toBeNull()
    expect(svg!.svg.replace(/<[^>]+>/g, '')).toContain(cjk)
    // 数学斜体 q 仍是 MathJax 自己的轮廓；中文走原生 text。
    expect(svg!.svg).toContain('data-c="1D45E"')
    expect(renderTeXToPNG(tex)).not.toBeNull()
  })

  test('cases 最长中文行会为末字保留完整字形宽度', () => {
    const tex = [
      'S_{\\mathrm{final}}=',
      '\\begin{cases}',
      'S_{\\mathrm{economic}}, & \\text{两腿 OI 门槛通过且剩余容量足够}\\\\',
      '0, & \\text{任意一腿 OI 或剩余容量不足}\\\\',
      '\\mathrm{MISS}, & \\text{必要数据尚未准备好}',
      '\\end{cases}',
    ].join('\n')
    const svg = renderTeXToSVG(tex)
    const png = renderTeXToPNG(tex)
    expect(svg).not.toBeNull()
    expect(png).not.toBeNull()
    expect(svg!.svg).toContain('<text')
    // 修复前该样例宽 615px，第一行末字 origin 已贴住 viewBox 右缘而被裁。
    expect(svg!.width).toBeGreaterThan(630)
    expect(png!.width).toBe(svg!.width)
  })

  test('复杂公式与矩阵正常，MathJax merror 显式失败', () => {
    expect(renderTeXToPNG('S=\\sum_{i=1}^{n} w_i \\cdot \\frac{x_i-\\mu}{\\sigma}')).not.toBeNull()
    expect(renderTeXToPNG('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}')).not.toBeNull()
    expect(renderTeXToPNG('\\begin{nope}')).toBeNull()
  })

  test('不含原生文字的公式不加载系统字体，输出与加载系统字体时逐字节一致', () => {
    const { Resvg } = createRequire(import.meta.url)('@resvg/resvg-js') as typeof import('@resvg/resvg-js')
    const withSystemFonts = (svg: string) => Buffer.from(new Resvg(svg, {
      background: __test.constants.PAPER, fitTo: { mode: 'original' }, shapeRendering: 2, textRendering: 1,
      font: { loadSystemFonts: true, serifFamily: __test.constants.CJK_FONT_FAMILY, sansSerifFamily: __test.constants.CJK_FONT_FAMILY },
    }).render().asPng())
    for (const tex of [
      'E = mc^2', '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}', '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
      '\\text{hello world} + \\mathrm{abc} + \\mathbf{X} + \\mathcal{L}', 'x \\in \\mathbb{R}^n, \\quad \\forall \\epsilon > 0',
      '\\begin{aligned} a &= b + c \\\\ d &= e \\times f \\end{aligned}',
    ]) {
      const svg = renderTeXToSVG(tex)
      expect(svg).not.toBeNull()
      // MathJax 把自带字形输出为 path；没有 <text> 就不依赖任何系统字体。
      expect(svg!.svg).not.toMatch(/<text\b/)
      expect(Buffer.compare(Buffer.from(renderTeXToPNG(tex)!.png), withSystemFonts(svg!.svg))).toBe(0)
    }
    // 含 CJK 的公式仍以原生 <text> 输出，继续走系统字体。
    expect(renderTeXToSVG('\\text{速度} = v')!.svg).toMatch(/<text\b/)
  })

  test('浅色不透明画布、padding 与 PNG 尺寸一致', () => {
    const svg = renderTeXToSVG('x+y')
    const png = renderTeXToPNG('x+y')
    expect(svg).not.toBeNull()
    expect(png).not.toBeNull()
    expect(svg!.svg).toContain(`<rect x="0" y="0" width="${svg!.width}" height="${svg!.height}"`)
    expect(svg!.svg).toContain(`fill="${__test.constants.PAPER}"`)
    expect(svg!.width).toBeGreaterThan(__test.constants.PAD_X * 2)
    expect(svg!.height).toBeGreaterThan(__test.constants.PAD_Y * 2)
    expect([png!.width, png!.height]).toEqual([svg!.width, svg!.height])
    expect(png!.png[0]).toBe(0x89)
    expect(String.fromCharCode(png!.png[1], png!.png[2], png!.png[3])).toBe('PNG')
  })

  test('超长公式缩放后不可读时显式保留原文', () => {
    const tex = Array.from({ length: 80 }, (_, index) => `x_{${index}}`).join('+')
    const result = renderTeXToPNG(tex)
    expect(result).toBeNull()
  })
})

describe('unicodeMathify', () => {
  test('希腊字母、运算符、文本与上下标转写', () => {
    expect(__test.unicodeMathify('\\beta = 0.25')).toBe('β = 0.25')
    expect(__test.unicodeMathify('a \\times b \\cdot c')).toBe('a × b · c')
    expect(__test.unicodeMathify('\\text{评分} = S_{net}')).toBe('评分 = S_(net)')
    expect(__test.unicodeMathify('E^{2}')).toBe('E^2')
    expect(__test.unicodeMathify('\\left(1 + \\beta\\right)')).toBe('(1 + β)')
    expect(__test.unicodeMathify('x^{a+b}')).toBe('x^(a+b)')
  })

  test('复杂或未消费的 TeX 转义提级为图片', () => {
    expect(__test.unicodeMathify('\\frac{a}{b}')).toBeNull()
    expect(__test.unicodeMathify('x\\,y')).toBeNull()
  })
})

describe('renderMathInText ordered blocks', () => {
  test('简单 inline 留在同一个 markdown block，不调用 uploader', async () => {
    let uploads = 0
    const uploader: FormulaUploader = async () => { uploads++; return 'img_v2_unused' }
    const result = await renderMathInText(
      '其中 \\(S\\) 是评分，\\(\\beta = 0.25\\) 是系数，$x^2+1$ 是单美元公式',
      { uploader },
    )
    expect(result).toEqual({
      blocks: [{ type: 'markdown', text: '其中 S 是评分，β = 0.25 是系数，x^2+1 是单美元公式' }],
      formulaCount: 3,
      renderedImageCount: 0,
    })
    expect(uploads).toBe(0)
  })

  test('A→公式x→B→公式y→C 严格按源码交错', async () => {
    const uploader: FormulaUploader = async (_path, meta) => `img_v2_${meta.tex}`
    const result = await renderMathInText('A $$x$$ B \\[y\\] C', { uploader })
    expect(result.blocks.map(block => block.type)).toEqual(['markdown', 'image', 'markdown', 'image', 'markdown'])
    expect(result.blocks.map(block => block.type === 'markdown' ? block.text.trim() : block.tex)).toEqual([
      'A', 'x', 'B', 'y', 'C',
    ])
    expect(result.renderedImageCount).toBe(2)
  })

  test('宽公式使用 fit_horizontal 响应式完整展示，小公式保留精确尺寸', async () => {
    const uploader: FormulaUploader = async (_path, meta) => `img_v2_${meta.width}`
    const small = await renderMathInText('$$x$$', { uploader })
    const wide = await renderMathInText(
      '$$S_{\\mathrm{final}}=\\begin{cases}' +
      'S_{\\mathrm{economic}}, & \\text{两腿 OI 门槛通过且剩余容量足够}\\\\' +
      '0, & \\text{任意一腿 OI 或剩余容量不足}' +
      '\\end{cases}$$',
      { uploader },
    )
    const smallImage = small.blocks.find(block => block.type === 'image')
    const wideImage = wide.blocks.find(block => block.type === 'image')
    expect(smallImage?.type === 'image' ? smallImage.element : null).toMatchObject({
      scale_type: 'crop_center',
      size: expect.any(String),
    })
    expect(wideImage?.type === 'image' ? wideImage.element : null).toMatchObject({
      scale_type: 'fit_horizontal',
    })
    expect(wideImage?.type === 'image' ? 'size' in wideImage.element : true).toBe(false)
  })

  test('复杂 inline 原位提级成图片', async () => {
    const uploader: FormulaUploader = async () => 'img_v2_frac'
    const result = await renderMathInText('前 \\(\\frac{a}{b}\\) 后', { uploader })
    expect(result.blocks.map(block => block.type)).toEqual(['markdown', 'image', 'markdown'])
    expect(result.blocks[1]).toMatchObject({ type: 'image', tex: '\\frac{a}{b}' })
  })

  test('上传失败时在原位置保留完整 LaTeX，其他成功公式顺序不变', async () => {
    const uploader: FormulaUploader = async (_path, meta) => meta.tex === 'x' ? 'img_v2_x' : null
    const result = await renderMathInText('A $$x$$ B \\[y\\] C', { uploader })
    expect(result.blocks.map(block => block.type)).toEqual(['markdown', 'image', 'markdown'])
    expect(result.blocks[0]).toEqual({ type: 'markdown', text: 'A ' })
    expect(result.blocks[1]).toMatchObject({ type: 'image', tex: 'x' })
    expect(result.blocks[2]).toEqual({ type: 'markdown', text: ' B \\[y\\] C' })
    expect(result.renderedImageCount).toBe(1)
  })

  test('代码中的公式不会触发 uploader，原文逐字保留', async () => {
    let uploads = 0
    const uploader: FormulaUploader = async () => { uploads++; return 'img_v2_bad' }
    const text = '```tex\n$$x$$\n``` 与 `\\(y\\)`'
    const result = await renderMathInText(text, { uploader })
    expect(result.blocks).toEqual([{ type: 'markdown', text }])
    expect(result.formulaCount).toBe(0)
    expect(uploads).toBe(0)
  })
})

describe('upload lifecycle', () => {
  test('同 uploader 的同公式并发只渲染上传一次', async () => {
    let calls = 0
    const paths: string[] = []
    const uploader: FormulaUploader = async (filePath) => {
      calls++
      paths.push(filePath)
      expect(existsSync(filePath)).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 20))
      return 'img_v2_shared'
    }
    const [first, second] = await Promise.all([
      renderMathInText('$$same$$', { uploader }),
      renderMathInText('$$same$$', { uploader }),
    ])
    expect(calls).toBe(1)
    expect(paths).toHaveLength(1)
    expect(existsSync(paths[0])).toBe(false)
    expect(first.blocks).toEqual(second.blocks)
  })

  test('不同公式并发使用唯一临时路径并全部清理', async () => {
    const paths: string[] = []
    const uploader: FormulaUploader = async (filePath, meta) => {
      paths.push(filePath)
      expect(existsSync(filePath)).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 10))
      return `img_v2_${meta.tex}`
    }
    await Promise.all([
      renderMathInText('$$x_1$$', { uploader }),
      renderMathInText('$$x_2$$', { uploader }),
    ])
    expect(new Set(paths).size).toBe(2)
    expect(paths.every(path => !existsSync(path))).toBe(true)
  })

  test('uploader 抛错会保留原 LaTeX，失败路径也清理临时文件', async () => {
    let tempPath = ''
    const uploader: FormulaUploader = async (filePath) => {
      tempPath = filePath
      expect(existsSync(filePath)).toBe(true)
      throw new Error('forced upload failure')
    }
    const source = '前 $$x+y$$ 后'
    const result = await renderMathInText(source, { uploader })
    expect(result.blocks).toEqual([{ type: 'markdown', text: source }])
    expect(result.renderedImageCount).toBe(0)
    expect(tempPath).not.toBe('')
    expect(existsSync(tempPath)).toBe(false)
  })
})
