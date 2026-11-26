import { Facet, StateEffect } from '@codemirror/state'
import type { DrawnPicture, FailedPicture, SnippetMode } from '../protocol'
import { needsTex, PICTURE_FILE, scalingBoxAround, TEX_PICTURES, type Construct, type ScanResult } from '../latex/scan'

export { needsTex, TEX_PICTURES }

/**
 * Pictures only TeX can draw (TikZ, pgfplots, tikz-cd, xy-pic, circuitikz, forest, PSTricks),
 * found in a scanned document. The visual view, the preview and the store share this list, so a
 * picture is the same source text, hence the same drawing, wherever it shows.
 */

export interface PictureSpec {
  /** What is drawn in place of: the picture, with a \resizebox or \scalebox around it. */
  from: number
  to: number
  /** Where the construct begins (the preview marks pictures by it). */
  start: number
  snippet: string
  mode: SnippetMode
  /** The picture's place among the document's pictures: a redraw shows the last drawing there. */
  slot: number
}

const cache = new WeakMap<ScanResult, PictureSpec[]>()

function specOf(c: Construct, text: string): Omit<PictureSpec, 'slot'> | null {
  if (c.kind === 'verbatim' && c.env !== null && TEX_PICTURES.has(c.env)) {
    const box = scalingBoxAround(text, c.from, c.to)
    const from = box?.from ?? c.from
    const to = box?.to ?? c.to
    return { from, to, start: c.from, snippet: text.slice(from, to), mode: 'block' }
  }
  if (c.kind === 'picture') return { from: c.from, to: c.to, start: c.from, snippet: text.slice(c.from, c.to), mode: 'inline' }
  // `\input{figures/loss.pgf}`: TeX reads the file next to the document (on this computer).
  if (c.kind === 'ref' && (c.cmd === 'input' || c.cmd === 'include') && PICTURE_FILE.test(c.keys[0] ?? '')) {
    return { from: c.from, to: c.to, start: c.from, snippet: text.slice(c.from, c.to).replace(/^\\include\b/, '\\input'), mode: 'block' }
  }
  if (c.kind === 'math' && needsTex(text.slice(c.bodyFrom, c.bodyTo))) {
    const body = text.slice(c.bodyFrom, c.bodyTo)
    // The body is drawn as math in a box; align's `&` columns go in `aligned` (same lines, so an
    // error's line number still points at the document).
    const aligned = c.env !== null && /^(?:align|alignat|flalign|eqnarray|split)\*?$/.test(c.env)
    const snippet = aligned ? `\\begin{aligned}${body}\\end{aligned}` : body
    const mode: SnippetMode = c.display ? 'display-math' : 'inline-math'
    return { from: c.from, to: c.to, start: c.from, snippet, mode }
  }
  return null
}

/** The document's pictures in order. */
export function pictureSpecs(scan: ScanResult, text: string): PictureSpec[] {
  const known = cache.get(scan)
  if (known) return known
  const out: PictureSpec[] = []
  for (const c of scan.constructs) {
    const spec = specOf(c, text)
    if (spec) out.push({ ...spec, slot: out.length })
  }
  cache.set(scan, out)
  return out
}

/** The picture a construct is, if it is one. */
export function pictureAt(scan: ScanResult, text: string, start: number): PictureSpec | null {
  return pictureSpecs(scan, text).find((p) => p.start === start) ?? null
}

/**
 * What the worker needs besides the picture: the text before \begin{document}, or for a section
 * file without one its leading comment lines (`% !TEX root = …`, `% !TEX program = …`).
 */
export function headOf(text: string, documentStart: number | null): string {
  if (documentStart !== null) return text.slice(0, documentStart)
  const lines: string[] = []
  for (const line of text.split('\n', 40)) {
    if (!line.trim().startsWith('%') && line.trim() !== '') break
    lines.push(line)
  }
  return lines.join('\n')
}

/** A drawing ready to show: a `blob:` URL of its SVG, and its size in big points. */
export interface ShownPicture extends Omit<DrawnPicture, 'svg' | 'status'> {
  url: string
}

export type PictureView =
  /** Drawing turned off, or this computer has no TeX: the source shows as code. */
  | { state: 'off'; message: string | null }
  | { state: 'drawn'; picture: ShownPicture }
  /** Being drawn; `previous` is the last drawing in this place, shown dimmed meanwhile. */
  | { state: 'pending'; previous: ShownPicture | null }
  | { state: 'failed'; error: FailedPicture; previous: ShownPicture | null }

/** Draws pictures with the person's TeX (through the worker) and remembers the drawings. */
export interface PictureRenderer {
  /** Rises when any view changes, so decorations are rebuilt. */
  readonly generation: number
  /** The state of a picture now; asking starts drawing it when needed. `head` is headOf(). */
  view(spec: PictureSpec, head: string): PictureView
  /** Draws it again, ignoring what is cached (after the person installs a package, say). */
  redraw(spec: PictureSpec, head: string): void
  /** CSS pixels per big point at this font size, so TeX's \normalsize matches `fontPx`. */
  scale(picture: ShownPicture, fontPx: number): number
  /** LuaLaTeX can be allowed for this document (it is found on this computer). */
  canAllowLua(): boolean
  /** Allows LuaLaTeX for this document from now on: it runs the document's Lua code. */
  allowLua(): void
}

/** Dispatched when a drawing arrives or fails, so the visual view decorates again. */
export const refreshPictures = StateEffect.define<null>()

export const pictureRenderer = Facet.define<PictureRenderer, PictureRenderer | null>({
  combine: (values) => values[0] ?? null
})
