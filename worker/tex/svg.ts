// The SVG a picture becomes: its size and baseline read, a little room added around it (TikZ's
// bounding box leaves out half of each border's line width), and anything active stripped. The
// editor shows it through <img>, where scripts never run; stripping is a second fence.

/** Room added on every side, in big points. */
export const PAD_BP = 1.5

export interface Drawn {
  svg: string
  /** Size of the padded drawing and the depth below its baseline, in big points (1/72 in). */
  width: number
  height: number
  depth: number
}

const num = (s: string | undefined) => (s === undefined ? NaN : Number(s))

/** Elements dvisvgm and pdftocairo write: everything else (script, foreignObject, feImage,
 *  any prefixed name such as svg:script) is dropped with its content. */
const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'image', 'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'stop',
  'marker', 'title', 'desc', 'style', 'a', 'filter', 'feColorMatrix', 'feComposite', 'feFlood',
  'feGaussianBlur', 'feOffset', 'feMerge', 'feMergeNode', 'feBlend', 'feComponentTransfer', 'feFuncA',
  'feFuncR', 'feFuncG', 'feFuncB'
])
/** Prefixed attributes that are kept; other prefixed ones (`x:href`) are dropped. */
const PREFIXED = new Set(['xlink:href', 'xmlns:xlink', 'xml:space'])

/** A link that stays inside the drawing, or an embedded bitmap. */
const safeRef = (value: string) => /^#[\w.:-]*$/.test(value.trim()) || /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i.test(value.trim())

/** CSS or attribute text that names nothing outside the drawing: `url(#clip1)` only, no escapes. */
function safeStyle(value: string): boolean {
  if (value.includes('\\') || /@import|expression\s*\(|javascript:/i.test(value)) return false
  // Character references (`u&#x72;l(`) would be decoded by the SVG reader after this check.
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) return false
  const lower = value.toLowerCase()
  for (let at = lower.indexOf('url('); at !== -1; at = lower.indexOf('url(', at + 4)) {
    let i = at + 4
    while (value[i] === ' ' || value[i] === '"' || value[i] === "'") i++
    if (value[i] !== '#') return false
  }
  return true
}

/** The end of a tag starting at `<` (the index of its `>`), quotes respected; -1 if unclosed. */
function tagEnd(svg: string, from: number): number {
  let quote = ''
  for (let i = from + 1; i < svg.length; i++) {
    const c = svg[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

/** The tag's attributes, kept only when harmless, rebuilt with double quotes. */
function cleanAttributes(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++
    const nameStart = i
    while (i < text.length && !/[\s=/>]/.test(text[i])) i++
    const name = text.slice(nameStart, i)
    if (!name) {
      i++
      continue
    }
    while (i < text.length && /\s/.test(text[i])) i++
    let value: string | null = null
    if (text[i] === '=') {
      i++
      while (i < text.length && /\s/.test(text[i])) i++
      const q = text[i]
      if (q === '"' || q === "'") {
        const close = text.indexOf(q, i + 1)
        if (close === -1) break
        value = text.slice(i + 1, close)
        i = close + 1
      } else {
        const valueStart = i
        while (i < text.length && !/[\s>]/.test(text[i])) i++
        value = text.slice(valueStart, i)
      }
    }
    const lower = name.toLowerCase()
    if (lower.startsWith('on')) continue
    if (name.includes(':') && !PREFIXED.has(lower)) continue
    if (lower === 'href' || lower === 'xlink:href') {
      if (value === null || !safeRef(value)) continue
    } else if (value !== null && !safeStyle(value)) continue
    out += value === null ? ` ${name}` : ` ${name}="${value.replace(/"/g, '&quot;')}"`
  }
  return out
}

/**
 * Keeps what a drawing needs and nothing that reaches outside it: only known SVG elements (an
 * unknown one goes with all it contains), no handlers, no links but to the drawing's own parts
 * or embedded bitmaps, no CSS that loads anything. One pass: each character is looked at a
 * bounded number of times, whatever the input.
 */
export function sanitizeSvg(svg: string): string {
  const out: string[] = []
  let i = 0
  /** Depth inside a dropped element; 0 when copying. */
  let skipping = 0
  /** Where an open <style>'s text begins in `out`, to empty a style sheet that loads anything. */
  let styleAt = -1
  while (i < svg.length) {
    const lt = svg.indexOf('<', i)
    if (lt === -1) {
      if (!skipping) out.push(svg.slice(i))
      break
    }
    if (!skipping && lt > i) out.push(svg.slice(i, lt))
    if (svg.startsWith('<!--', lt)) {
      const close = svg.indexOf('-->', lt + 4)
      i = close === -1 ? svg.length : close + 3
      continue
    }
    if (svg.startsWith('<![CDATA[', lt)) {
      const close = svg.indexOf(']]>', lt + 9)
      const body = svg.slice(lt + 9, close === -1 ? svg.length : close)
      // Style sheets may wrap their rules in CDATA; kept only when they load nothing.
      if (!skipping && safeStyle(body) && !body.includes('<')) out.push(body.replace(/&/g, '&amp;').replace(/>/g, '&gt;'))
      i = close === -1 ? svg.length : close + 3
      continue
    }
    const end = tagEnd(svg, lt)
    if (end === -1) break
    const tag = svg.slice(lt + 1, end)
    i = end + 1
    if (tag.startsWith('?') || tag.startsWith('!')) continue
    const closing = tag.startsWith('/')
    const selfClosing = tag.endsWith('/')
    const name = /^\/?\s*([A-Za-z][\w:.-]*)/.exec(tag)?.[1] ?? ''
    if (skipping) {
      if (closing) skipping--
      else if (!selfClosing) skipping++
      continue
    }
    if (!ELEMENTS.has(name)) {
      if (!closing && !selfClosing) skipping = 1
      continue
    }
    if (closing) {
      if (name === 'style' && styleAt >= 0) {
        if (!safeStyle(out.slice(styleAt).join(''))) out.length = styleAt
        styleAt = -1
      }
      out.push(`</${name}>`)
      continue
    }
    const attrs = cleanAttributes(tag.slice(tag.indexOf(name) + name.length, selfClosing ? -1 : undefined))
    out.push(`<${name}${attrs}${selfClosing ? '/>' : '>'}`)
    if (name === 'style' && !selfClosing) styleAt = out.length
  }
  return out.join('')
}

/**
 * Pads a dvisvgm or pdftocairo SVG and finds its baseline: from the marker the DVI route leaves
 * (`<g class='rte-base' data-y='…'/>`), or else from the box depth TeX reported.
 */
export function finishSvg(raw: string, depthPt: number | null): Drawn | null {
  const open = /<svg\b[^>]*>/i.exec(raw)
  if (!open) return null
  const tag = open[0]
  const vb = /viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)\s*["']/.exec(tag)
  if (!vb) return null
  let [x, y, w, h] = [num(vb[1]), num(vb[2]), num(vb[3]), num(vb[4])]
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null
  let svg = raw
  let baseline: number | null = null
  const marker = /<g\s+class=['"]rte-base['"]\s+data-y=['"]([-\d.eE]+)['"]\s*\/>/.exec(svg)
  if (marker) {
    baseline = num(marker[1])
    svg = svg.replace(marker[0], '')
  }
  if (baseline === null || !Number.isFinite(baseline)) {
    const depthBp = depthPt === null ? 0 : (depthPt * 72) / 72.27
    baseline = y + h - depthBp
  }
  const depth = Math.max(0, y + h - baseline)
  x -= PAD_BP
  y -= PAD_BP
  w += 2 * PAD_BP
  h += 2 * PAD_BP
  const round = (v: number) => Math.round(v * 1000) / 1000
  const newTag = tag
    .replace(/\s(?:width|height|viewBox)\s*=\s*(["'])[^"']*\1/gi, '')
    .replace(/<svg\b/i, `<svg width='${round(w)}' height='${round(h)}' viewBox='${round(x)} ${round(y)} ${round(w)} ${round(h)}'`)
  svg = sanitizeSvg(svg.replace(tag, newTag))
  return { svg, width: round(w), height: round(h), depth: round(depth + PAD_BP) }
}
