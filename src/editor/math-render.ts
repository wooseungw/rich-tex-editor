import katex from 'katex'
import type { MacroMap } from '../latex/macros'

export interface RenderedMath {
  html: string
  /** KaTeX's message when the formula does not parse; `html` then shows the escaped source. */
  error: string | null
}

const MAX_CACHED = 800
const cache = new Map<string, RenderedMath>()
let cachedMacros = ''

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** KaTeX output for one formula, cached by its source while the document's macros stay the same. */
export function renderMath(tex: string, displayMode: boolean, macros: MacroMap, macrosKey: string): RenderedMath {
  if (macrosKey !== cachedMacros) {
    cache.clear()
    cachedMacros = macrosKey
  }
  const key = `${displayMode ? 'D' : 'I'}${tex}`
  const hit = cache.get(key)
  if (hit) {
    // Refresh its place in the LRU order.
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  let result: RenderedMath
  try {
    result = {
      html: katex.renderToString(tex, {
        displayMode,
        // KaTeX writes `\gdef`s into the object it is given: hand it a copy.
        macros: { ...macros },
        throwOnError: true,
        strict: 'ignore',
        trust: false,
        output: 'htmlAndMathml'
      }),
      error: null
    }
  } catch (err) {
    const message = err instanceof Error ? err.message.replace(/^KaTeX parse error: /, '') : String(err)
    result = { html: `<code class="rt-math-error-src">${escapeHtml(tex.trim() || '(empty)')}</code>`, error: message }
  }
  cache.set(key, result)
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return result
}

/** For the preview renderer, which catches errors itself. */
export function renderMathOrThrow(tex: string, displayMode: boolean, macros: MacroMap): string {
  return katex.renderToString(tex, {
    displayMode,
    macros: { ...macros },
    throwOnError: true,
    strict: 'ignore',
    trust: false,
    output: 'htmlAndMathml'
  })
}
