import { type EditorView, WidgetType } from '@codemirror/view'
import type { MacroMap } from '../latex/macros'
import { renderFragment } from './fragment'
import { imageLoader, type LoadedImage } from './image-loader'
import { renderMath } from './math-render'

/**
 * Widgets mark themselves with `data-rt-reveal` (offset from the widget's start where the cursor
 * goes when it is clicked), so a click on rendered math or a chip opens its source for editing.
 */
abstract class RevealWidget extends WidgetType {
  constructor(readonly reveal: number) {
    super()
  }
  protected mark(el: HTMLElement): HTMLElement {
    el.dataset.rtReveal = String(this.reveal)
    return el
  }
  override ignoreEvent(event: Event): boolean {
    // Let our own mousedown handler see clicks; everything else stays out of the editor.
    return event.type !== 'mousedown'
  }
}

export type MathPlacement = 'inline' | 'block' | 'preview'

export class MathWidget extends RevealWidget {
  constructor(
    readonly tex: string,
    readonly displayMode: boolean,
    readonly macros: MacroMap,
    readonly macrosKey: string,
    readonly placement: MathPlacement,
    reveal: number
  ) {
    super(reveal)
  }
  override eq(other: MathWidget): boolean {
    return (
      other.tex === this.tex &&
      other.displayMode === this.displayMode &&
      other.macrosKey === this.macrosKey &&
      other.placement === this.placement &&
      other.reveal === this.reveal
    )
  }
  override toDOM(): HTMLElement {
    const el = document.createElement(this.placement === 'inline' ? 'span' : 'div')
    el.className = `cm-rt-math cm-rt-math-${this.placement}${this.displayMode ? ' cm-rt-math-display' : ''}`
    this.paint(el)
    if (this.placement === 'preview') {
      el.setAttribute('aria-hidden', 'true')
      return el
    }
    return this.mark(el)
  }
  /** The live preview under math being edited redraws in place, keystroke by keystroke. */
  override updateDOM(dom: HTMLElement): boolean {
    if (this.placement !== 'preview' || !dom.classList.contains('cm-rt-math-preview')) return false
    this.paint(dom)
    return true
  }
  /**
   * Draws the formula. While it is being edited, a formula that does not parse yet (`\fr` on the
   * way to `\frac`) keeps its last good rendering, dimmed, instead of flashing an error.
   */
  private paint(el: HTMLElement): void {
    const rendered = renderMath(this.tex, this.displayMode, this.macros, this.macrosKey)
    if (rendered.error && this.placement === 'preview' && el.dataset.rtGood === '1') {
      el.classList.add('cm-rt-math-stale')
      el.title = rendered.error
      return
    }
    el.classList.toggle('cm-rt-math-error', rendered.error !== null)
    el.classList.remove('cm-rt-math-stale')
    el.title = rendered.error ?? ''
    el.innerHTML = rendered.html
    if (!rendered.error) el.dataset.rtGood = '1'
  }
  override get estimatedHeight(): number {
    return this.placement === 'inline' ? -1 : 48
  }
  override ignoreEvent(event: Event): boolean {
    return this.placement === 'preview' ? true : super.ignoreEvent(event)
  }
}

/** Plain text in place of source: a section number, `–` for `--`, a list bullet. */
export class TextWidget extends RevealWidget {
  constructor(
    readonly text: string,
    readonly className: string,
    reveal = 0,
    readonly title: string | null = null
  ) {
    super(reveal)
  }
  override eq(other: TextWidget): boolean {
    return other.text === this.text && other.className === this.className && other.reveal === this.reveal && other.title === this.title
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = this.className
    el.textContent = this.text
    if (this.title) el.title = this.title
    return this.mark(el)
  }
}

export class LogoWidget extends RevealWidget {
  constructor(readonly name: 'TeX' | 'LaTeX' | 'LaTeXe') {
    super(1)
  }
  override eq(other: LogoWidget): boolean {
    return other.name === this.name
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-rt-logo'
    const parts: Array<[string, string | null]> =
      this.name === 'TeX'
        ? [['T', null], ['e', 'e'], ['X', null]]
        : [['L', null], ['a', 'a'], ['T', null], ['e', 'e'], ['X', null]]
    for (const [text, cls] of parts) {
      const part = document.createElement('span')
      part.textContent = text.toUpperCase()
      if (cls) part.className = `cm-rt-logo-${cls}`
      el.append(part)
    }
    if (this.name === 'LaTeXe') el.append('2', Object.assign(document.createElement('span'), { className: 'cm-rt-logo-eps', textContent: 'ε' }))
    el.setAttribute('aria-label', this.name)
    return this.mark(el)
  }
}

export class TitleWidget extends RevealWidget {
  constructor(
    readonly title: string,
    readonly author: string,
    readonly date: string,
    readonly block: boolean
  ) {
    super(1)
  }
  override eq(other: TitleWidget): boolean {
    return other.title === this.title && other.author === this.author && other.date === this.date && other.block === this.block
  }
  override toDOM(): HTMLElement {
    const el = document.createElement(this.block ? 'div' : 'span')
    el.className = 'cm-rt-titleblock'
    const add = (cls: string, text: string) => {
      if (!text) return
      const part = document.createElement('div')
      part.className = cls
      part.textContent = text
      el.append(part)
    }
    add('cm-rt-titleblock-title', this.title || 'Untitled')
    add('cm-rt-titleblock-author', this.author)
    add('cm-rt-titleblock-date', this.date)
    return this.mark(el)
  }
}

/** `Theorem 2 (Name).`, `Proof.`, `Abstract`, `References` on an environment's first line. */
export class EnvTitleWidget extends RevealWidget {
  constructor(
    readonly title: string,
    readonly note: string | null,
    readonly className: string,
    reveal: number
  ) {
    super(reveal)
  }
  override eq(other: EnvTitleWidget): boolean {
    return other.title === this.title && other.note === this.note && other.className === this.className && other.reveal === this.reveal
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = this.className
    const title = document.createElement('span')
    title.className = 'cm-rt-envtitle-name'
    title.textContent = this.title
    el.append(title)
    if (this.note) el.append(` (${this.note})`)
    if (this.className.includes('cm-rt-theorem-label')) el.append('.')
    return this.mark(el)
  }
}

/** The preamble folded to one line: `Preamble · article · 4 packages · 3 macros`. */
export class PreambleWidget extends RevealWidget {
  constructor(
    readonly summary: string,
    readonly lines: number
  ) {
    super(0)
  }
  override eq(other: PreambleWidget): boolean {
    return other.summary === this.summary && other.lines === this.lines
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-rt-preamble-fold'
    el.title = 'Click to edit the preamble'
    const label = document.createElement('span')
    label.className = 'cm-rt-preamble-fold-label'
    label.textContent = 'Preamble'
    const summary = document.createElement('span')
    summary.className = 'cm-rt-preamble-fold-summary'
    summary.textContent = this.summary
    const count = document.createElement('span')
    count.className = 'cm-rt-preamble-fold-count'
    count.textContent = `${this.lines} ${this.lines === 1 ? 'line' : 'lines'}`
    el.append(label, summary, count)
    return this.mark(el)
  }
  override get estimatedHeight(): number {
    return 34
  }
}

/** A `tabular` drawn as a table by the preview renderer. */
export class TableWidget extends RevealWidget {
  constructor(
    readonly source: string,
    readonly preamble: string,
    reveal: number
  ) {
    super(reveal)
  }
  override eq(other: TableWidget): boolean {
    return other.source === this.source && other.preamble === this.preamble && other.reveal === this.reveal
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-rt-table rt-preview rt-embed'
    // The renderer escapes every piece of source text it puts in its HTML.
    el.innerHTML = renderFragment(this.source, this.preamble)
    return this.mark(el)
  }
  override get estimatedHeight(): number {
    return 24 * (this.source.split('\\\\').length + 1)
  }
}

/** An image from `\includegraphics`, loaded from disk by the worker. */
export class ImageWidget extends RevealWidget {
  constructor(
    readonly file: string,
    readonly width: number | null,
    readonly block: boolean,
    reveal: number,
    readonly generation: number
  ) {
    super(reveal)
  }
  override eq(other: ImageWidget): boolean {
    return (
      other.file === this.file &&
      other.width === this.width &&
      other.block === this.block &&
      other.reveal === this.reveal &&
      other.generation === this.generation
    )
  }
  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.block ? 'div' : 'span')
    el.className = `cm-rt-image ${this.block ? 'cm-rt-image-block' : 'cm-rt-image-inline'}`
    el.title = `\\includegraphics{${this.file}}`
    const name = document.createElement('span')
    name.className = 'cm-rt-image-name'
    name.textContent = this.file
    el.append(name)
    const loader = view.state.facet(imageLoader)
    if (!loader || !this.file) {
      el.classList.add('cm-rt-image-missing')
      return this.mark(el)
    }
    const show = (image: LoadedImage | null) => {
      if (!image) {
        el.classList.add('cm-rt-image-missing')
        el.classList.remove('cm-rt-image-loading')
        name.textContent = `${this.file} (not found)`
        return
      }
      const img = document.createElement('img')
      img.alt = this.file
      img.draggable = false
      if (this.width !== null) img.style.width = `${Math.round(this.width * 100)}%`
      // Hold the image's shape before it decodes, so the text below does not jump.
      if (image.width && image.height) img.style.aspectRatio = `${image.width} / ${image.height}`
      img.addEventListener(
        'load',
        () => {
          image.width = img.naturalWidth
          image.height = img.naturalHeight
          view.requestMeasure()
        },
        { once: true }
      )
      img.src = image.url
      el.classList.remove('cm-rt-image-loading')
      name.remove()
      el.append(img)
    }
    const cached = loader.cached(this.file)
    if (cached !== undefined) {
      show(cached)
    } else {
      el.classList.add('cm-rt-image-loading')
      loader.load(this.file).then(show, () => show(null))
    }
    return this.mark(el)
  }
  override get estimatedHeight(): number {
    return this.block ? 240 : -1
  }
}
