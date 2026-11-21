import { renderPreview } from '../latex/preview'
import { renderMathOrThrow } from './math-render'

const MAX_CACHED = 200
const cache = new Map<string, string>()

/**
 * HTML for a piece of LaTeX (a table, a footnote), rendered by the preview renderer with the
 * document's preamble so its macros and theorem definitions apply. Every piece of source text
 * in the result is escaped by the renderer.
 */
export function renderFragment(fragment: string, preamble: string): string {
  const key = `${preamble.length}:${preamble}\u0000${fragment}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const source = `${preamble}\n\\begin{document}\n${fragment}\n\\end{document}\n`
  const html = renderPreview(source, { renderMath: renderMathOrThrow }).html
  cache.set(key, html)
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return html
}
