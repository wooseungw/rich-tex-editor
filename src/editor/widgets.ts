import { type EditorView, WidgetType } from '@codemirror/view'
import type { MacroMap } from '../latex/macros'
import { renderFragment } from './fragment'
import { imageLoader, type LoadedImage } from './image-loader'
import type { FailedPicture } from '../protocol'
import { pictureRenderer, type PictureView, type ShownPicture } from './picture-spec'
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

/**
 * A picture TeX drew (TikZ, pgfplots, tikz-cd…), or where it stands until it is drawn.
 * `block` and `inline` replace the source; `preview` shows under the source while it is edited;
 * `status` says, under the source, that it is being drawn or why it could not be.
 */
export type PicturePlacement = 'block' | 'inline' | 'preview' | 'status'

export class PictureWidget extends RevealWidget {
  constructor(
    readonly view: PictureView,
    readonly placement: PicturePlacement,
    reveal: number,
    /** Document position of each line of the picture's source, for links to an error's line. */
    readonly lineStarts: readonly number[],
    readonly retry: (() => void) | null = null
  ) {
    super(reveal)
  }

  /** What is drawn: a widget with the same identity is kept, so a redraw does not flicker. */
  private get identity(): string {
    const v = this.view
    const shown = (p: ShownPicture | null) => (p ? p.url : '')
    switch (v.state) {
      case 'off':
        return `off|${v.message ?? ''}`
      case 'drawn':
        return `drawn|${v.picture.url}`
      case 'pending':
        return `pending|${shown(v.previous)}`
      case 'failed':
        return `failed|${v.error.key}|${v.error.message}|${v.error.line}|${shown(v.previous)}`
    }
  }

  override eq(other: PictureWidget): boolean {
    return other.placement === this.placement && other.reveal === this.reveal && other.identity === this.identity && other.lineStarts.join() === this.lineStarts.join()
  }

  override toDOM(editor: EditorView): HTMLElement {
    const inline = this.placement === 'inline'
    const el = document.createElement(inline ? 'span' : 'div')
    el.className = `cm-rt-picture cm-rt-picture-${this.placement}`
    const v = this.view
    const picture = v.state === 'drawn' ? v.picture : v.state === 'pending' || v.state === 'failed' ? v.previous : null
    if (picture && this.placement !== 'status') {
      el.append(this.image(editor, picture, v.state !== 'drawn'))
      // What was set aside to draw it here (a package not installed on this computer…).
      const setAside = picture.notes.filter((n) => /not installed|skipped|reduced|no preamble/.test(n))
      if (setAside.length && this.placement !== 'inline') {
        const caption = document.createElement('div')
        caption.className = 'cm-rt-picture-caption'
        caption.textContent = setAside.join(' · ')
        el.append(caption)
      }
      if (picture.wantsLua && this.placement !== 'inline') {
        const lua = this.luaChoice(editor)
        if (lua) el.append(lua)
      }
    }
    if (v.state === 'pending' && this.placement !== 'inline') {
      const note = document.createElement('div')
      note.className = 'cm-rt-picture-note cm-rt-picture-working'
      note.textContent = picture ? 'Redrawing with TeX…' : 'Drawing with TeX…'
      el.append(note)
    } else if (v.state === 'failed' && this.placement !== 'inline') {
      el.append(this.failure(editor, v.error))
    } else if (v.state === 'off' && v.message) {
      const note = document.createElement('div')
      note.className = 'cm-rt-picture-note'
      note.textContent = `Not drawn: ${v.message}`
      el.append(note)
    }
    if (v.state === 'failed') el.classList.add('cm-rt-picture-failed')
    if (this.placement === 'block' || this.placement === 'inline') {
      el.title = picture ? `${picture.label}${picture.notes.length ? `\n${picture.notes.join('\n')}` : ''}\nClick to edit` : 'Click to edit'
      return this.mark(el)
    }
    return el
  }

  private image(editor: EditorView, picture: ShownPicture, dim: boolean): HTMLElement {
    const renderer = editor.state.facet(pictureRenderer)
    const fontPx = parseFloat(getComputedStyle(editor.contentDOM).fontSize) || 16
    const scale = renderer ? renderer.scale(picture, fontPx) : 1.33
    const img = document.createElement('img')
    img.className = 'cm-rt-picture-img'
    img.alt = 'Picture drawn by TeX'
    img.draggable = false
    img.src = picture.url
    img.style.width = `${(picture.width * scale).toFixed(2)}px`
    img.style.aspectRatio = `${picture.width} / ${picture.height}`
    if (this.placement === 'inline') img.style.verticalAlign = `${(-picture.depth * scale).toFixed(2)}px`
    if (dim) img.classList.add('cm-rt-picture-stale')
    if (picture.notes.some((n) => /not installed|skipped|reduced|no preamble/.test(n))) img.classList.add('cm-rt-picture-noted')
    return img
  }

  private failure(editor: EditorView, error: FailedPicture): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-rt-picture-note cm-rt-picture-error'
    const head = document.createElement('div')
    const where = document.createElement('span')
    where.className = 'cm-rt-picture-where'
    if (error.where === 'picture' && error.line !== null) {
      const link = document.createElement('a')
      link.href = '#'
      const pos = this.lineStarts[error.line - 1]
      // The document's line number, as the person sees it in the gutter and in TeX's own log.
      link.textContent = pos !== undefined && pos <= editor.state.doc.length ? `Line ${editor.state.doc.lineAt(pos).number}` : `Line ${error.line} of the picture`
      link.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (pos === undefined || pos > editor.state.doc.length) return
        const line = editor.state.doc.lineAt(pos)
        editor.dispatch({ selection: { anchor: line.to }, scrollIntoView: true, userEvent: 'select.pointer' })
        editor.focus()
      })
      where.append(link)
    } else {
      where.textContent = error.where === 'preamble' ? 'Preamble' : error.where === 'file' ? (error.file ?? 'File') : error.label || 'TeX'
    }
    const message = document.createElement('span')
    message.className = 'cm-rt-picture-message'
    message.textContent = error.message
    head.append(where, document.createTextNode(': '), message)
    box.append(head)
    if (error.context) {
      const context = document.createElement('code')
      context.className = 'cm-rt-picture-context'
      context.textContent = error.context
      box.append(context)
    }
    const more: string[] = []
    if (error.reason === 'timeout') more.push('TeX took too long. Large plots can be compiled to an image and \\includegraphics-ed instead.')
    if (error.where === 'file' && error.file && /\.(?:csv|dat|txt|tsv|tex|tikz)$/.test(error.file)) {
      more.push('Files the picture reads are looked for next to this document; a document on an SSH host is drawn from its text alone.')
    }
    more.push(...error.notes)
    if (more.length) {
      const notes = document.createElement('div')
      notes.className = 'cm-rt-picture-notes'
      notes.textContent = more.join(' · ')
      box.append(notes)
    }
    // Trying again helps when something outside the picture changes (a package installed, a
    // slow machine); an error in the picture is fixed by editing it.
    if (error.wantsLua) {
      const lua = this.luaChoice(editor)
      if (lua) box.append(lua)
    }
    if (this.retry && error.where !== 'picture') {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'cm-rt-picture-retry'
      retry.textContent = 'Try again'
      const run = this.retry
      retry.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        run()
      })
      box.append(retry)
    }
    return box
  }

  /**
   * The document is written for LuaLaTeX, drawn with XeLaTeX instead: LuaLaTeX runs the
   * document's Lua, which can read any file, so it waits for the person's say-so.
   */
  private luaChoice(editor: EditorView): HTMLElement | null {
    const renderer = editor.state.facet(pictureRenderer)
    if (!renderer?.canAllowLua()) return null
    const line = document.createElement('div')
    line.className = 'cm-rt-picture-caption'
    line.append(document.createTextNode('Drawn with XeLaTeX. This document asks for LuaLaTeX, which runs the Lua code in it, and that code can read any file on this computer. '))
    const allow = document.createElement('button')
    allow.type = 'button'
    allow.className = 'cm-rt-picture-retry'
    allow.textContent = 'Use LuaLaTeX for this document'
    allow.title =
      'LuaLaTeX runs the Lua code written in this document, and that code can read any file on this computer. Allow it only for documents you trust.'
    allow.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      renderer.allowLua()
    })
    line.append(allow)
    return line
  }

  override get estimatedHeight(): number {
    if (this.placement === 'inline') return -1
    const v = this.view
    const picture = v.state === 'drawn' ? v.picture : v.state === 'pending' || v.state === 'failed' ? v.previous : null
    return picture ? Math.min(600, picture.height * 1.6 + 8) : 40
  }

  override ignoreEvent(event: Event): boolean {
    // Under the source, the widget keeps its clicks (its links and button handle their own).
    return this.placement === 'preview' || this.placement === 'status' ? true : super.ignoreEvent(event)
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
      el.classList.remove('cm-rt-image-loading')
      if (image.url === null) {
        // Found, but not a format the editor draws (a PDF): show where it is.
        el.classList.add('cm-rt-image-file')
        el.title = `\\includegraphics{${this.file}}: PDF figures are not drawn in the editor`
        name.textContent = image.path
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

/** Where an environment begins or ends: its name and a hairline, quiet enough to read past. */
export class BoundaryWidget extends RevealWidget {
  constructor(
    readonly label: string,
    readonly begin: boolean,
    reveal: number
  ) {
    super(reveal)
  }
  override eq(other: BoundaryWidget): boolean {
    return other.label === this.label && other.begin === this.begin && other.reveal === this.reveal
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = `cm-rt-boundary ${this.begin ? 'cm-rt-boundary-begin' : 'cm-rt-boundary-end'}`
    el.textContent = this.begin ? this.label : `end ${this.label.replace(/ \[.*\]$/, '')}`
    el.title = this.begin ? `\\begin{${this.label.replace(/ \[.*\]$/, '')}}` : `\\end{${this.label}}`
    return this.mark(el)
  }
}
