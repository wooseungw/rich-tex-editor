import { openSearchPanel } from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import { analysisField } from '../editor/analysis'
import {
  formatAt,
  headingAt,
  insertBlock,
  insertDisplayMath,
  insertInlineMath,
  insertLink,
  insertList,
  insertSnippet,
  setHeading,
  toggleFormat
} from '../editor/commands'
import { type Mode, redo, undo } from '../editor/setup'
import { icon } from './icons'

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const mod = isMac ? '⌘' : 'Ctrl+'

export interface ToolbarHost {
  getView(): EditorView
  getMode(): Mode
  setMode(mode: Mode): void
  exportHtml(): void
  /** Opens a file picker and inserts the chosen image as a figure. */
  insertImage(): void
  getBoundaries(): boolean
  setBoundaries(on: boolean): void
  /** Drawing TikZ and other TeX-only pictures with the person's TeX; `problem` says why it cannot. */
  getPictures(): { on: boolean; problem: string | null }
  setPictures(on: boolean): void
}

interface FormatButton {
  el: HTMLButtonElement
  cmd: string
}

const HEADINGS: Array<[string, string]> = [
  ['', 'Text'],
  ['part', 'Part'],
  ['chapter', 'Chapter'],
  ['section', 'Section'],
  ['subsection', 'Subsection'],
  ['subsubsection', 'Subsubsection'],
  ['paragraph', 'Paragraph']
]

const INSERTS: Array<{ label: string; run: (view: EditorView) => boolean }> = [
  { label: 'Numbered equation', run: (v) => insertBlock(v, '\\begin{equation}\n  #{selection}\n  \\label{eq:#{key}}\n\\end{equation}') },
  { label: 'Aligned equations', run: (v) => insertBlock(v, '\\begin{align}\n  #{a} &= #{b} \\\\\n  #{c} &= #{d}\n\\end{align}') },
  {
    label: 'Figure',
    run: (v) =>
      insertBlock(
        v,
        '\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{#{file}}\n  \\caption{#{caption}}\n  \\label{fig:#{key}}\n\\end{figure}'
      )
  },
  {
    label: 'Table',
    run: (v) =>
      insertBlock(
        v,
        '\\begin{table}[htbp]\n  \\centering\n  \\caption{#{caption}}\n  \\label{tab:#{key}}\n  \\begin{tabular}{lcr}\n    \\hline\n    #{a} & #{b} & #{c} \\\\\n    \\hline\n  \\end{tabular}\n\\end{table}'
      )
  },
  { label: 'Theorem', run: (v) => insertBlock(v, '\\begin{theorem}\n  #{selection}\n\\end{theorem}') },
  { label: 'Proof', run: (v) => insertBlock(v, '\\begin{proof}\n  #{selection}\n\\end{proof}') },
  { label: 'Quote', run: (v) => insertBlock(v, '\\begin{quote}\n  #{selection}\n\\end{quote}') },
  { label: 'Code listing', run: (v) => insertBlock(v, '\\begin{verbatim}\n#{selection}\n\\end{verbatim}') },
  { label: 'Footnote', run: (v) => insertSnippet(v, '\\footnote{#{}}') },
  { label: 'Citation', run: (v) => insertSnippet(v, '\\cite{#{key}}') },
  { label: 'Cross-reference', run: (v) => insertSnippet(v, '\\ref{#{key}}') },
  { label: 'Label', run: (v) => insertSnippet(v, '\\label{#{key}}') }
]

const SYMBOLS: Array<[string, string]> = [
  ['\\alpha', 'α'], ['\\beta', 'β'], ['\\gamma', 'γ'], ['\\delta', 'δ'], ['\\epsilon', 'ε'], ['\\zeta', 'ζ'],
  ['\\eta', 'η'], ['\\theta', 'θ'], ['\\lambda', 'λ'], ['\\mu', 'μ'], ['\\pi', 'π'], ['\\rho', 'ρ'],
  ['\\sigma', 'σ'], ['\\tau', 'τ'], ['\\phi', 'φ'], ['\\chi', 'χ'], ['\\psi', 'ψ'], ['\\omega', 'ω'],
  ['\\Gamma', 'Γ'], ['\\Delta', 'Δ'], ['\\Theta', 'Θ'], ['\\Lambda', 'Λ'], ['\\Sigma', 'Σ'], ['\\Phi', 'Φ'],
  ['\\Psi', 'Ψ'], ['\\Omega', 'Ω'], ['\\infty', '∞'], ['\\partial', '∂'], ['\\nabla', '∇'], ['\\pm', '±'],
  ['\\times', '×'], ['\\cdot', '·'], ['\\leq', '≤'], ['\\geq', '≥'], ['\\neq', '≠'], ['\\approx', '≈'],
  ['\\equiv', '≡'], ['\\in', '∈'], ['\\subseteq', '⊆'], ['\\cup', '∪'], ['\\cap', '∩'], ['\\emptyset', '∅'],
  ['\\forall', '∀'], ['\\exists', '∃'], ['\\to', '→'], ['\\Rightarrow', '⇒'], ['\\iff', '⇔'], ['\\mapsto', '↦'],
  ['\\sum', '∑'], ['\\prod', '∏'], ['\\int', '∫'], ['\\oint', '∮'], ['\\sqrt{}', '√'], ['\\frac{}{}', '½']
]

function button(label: string, title: string, iconName?: Parameters<typeof icon>[0]): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'rt-btn'
  el.title = title
  el.setAttribute('aria-label', title)
  if (iconName) el.innerHTML = icon(iconName)
  else el.textContent = label
  return el
}

function group(...children: HTMLElement[]): HTMLElement {
  const el = document.createElement('div')
  el.className = 'rt-group'
  el.append(...children)
  return el
}

export class Toolbar {
  readonly el: HTMLElement
  private readonly modeButtons = new Map<Mode, HTMLButtonElement>()
  private readonly formats: FormatButton[] = []
  private readonly editing: HTMLElement[] = []
  private readonly heading: HTMLSelectElement
  private readonly words: HTMLElement
  private readonly undoBtn: HTMLButtonElement
  private readonly redoBtn: HTMLButtonElement
  private readonly symbols: HTMLElement
  private readonly boundaryBtn: HTMLButtonElement
  private readonly picturesBtn: HTMLButtonElement
  private readOnly = false

  constructor(private readonly host: ToolbarHost) {
    this.el = document.createElement('div')
    this.el.className = 'rt-toolbar'
    this.el.setAttribute('role', 'toolbar')
    this.el.setAttribute('aria-label', 'Formatting')
    // Keep the editor's selection when pressing toolbar buttons.
    this.el.addEventListener('mousedown', (e) => {
      if (e.target instanceof Element && e.target.closest('button')) e.preventDefault()
    })

    const modes = document.createElement('div')
    modes.className = 'rt-segmented'
    modes.setAttribute('role', 'radiogroup')
    modes.setAttribute('aria-label', 'View')
    for (const [mode, label, title] of [
      ['visual', 'Visual', 'Visual: rendered as you type'],
      ['split', 'Split', 'Split: source beside a live preview']
    ] as const) {
      const b = button(label, title)
      b.innerHTML = `${icon(mode)}<span>${label}</span>`
      b.classList.add('rt-seg')
      b.setAttribute('role', 'radio')
      b.addEventListener('click', () => this.host.setMode(mode))
      this.modeButtons.set(mode, b)
      modes.append(b)
    }

    this.undoBtn = this.action(button('Undo', `Undo (${mod}Z)`, 'undo'), (v) => undo(v))
    this.redoBtn = this.action(button('Redo', `Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Y'})`, 'redo'), (v) => redo(v))

    this.heading = document.createElement('select')
    this.heading.className = 'rt-select'
    this.heading.title = 'Paragraph style'
    this.heading.setAttribute('aria-label', 'Paragraph style')
    for (const [value, label] of HEADINGS) this.heading.add(new Option(label, value))
    this.heading.addEventListener('change', () => {
      const view = this.host.getView()
      setHeading(this.heading.value || null)(view)
      view.focus()
    })
    this.editing.push(this.heading)

    const fmt = (cmd: string, title: string, iconName: Parameters<typeof icon>[0]) => {
      const el = this.action(button('', title, iconName), (v) => toggleFormat(cmd)(v))
      el.setAttribute('aria-pressed', 'false')
      this.formats.push({ el, cmd })
      return el
    }

    const inlineMath = this.action(button('$x$', `Inline math (${mod}M)`), insertInlineMath)
    inlineMath.classList.add('rt-btn-text')
    const displayMath = this.action(button('', `Display math (${isMac ? '⇧⌘M' : 'Ctrl+Shift+M'})`, 'sigma'), insertDisplayMath)

    const insert = document.createElement('select')
    insert.className = 'rt-select rt-select-insert'
    insert.title = 'Insert'
    insert.setAttribute('aria-label', 'Insert')
    insert.add(new Option('Insert…', ''))
    insert.add(new Option('Image…', 'image'))
    INSERTS.forEach((item, i) => insert.add(new Option(item.label, String(i))))
    insert.addEventListener('change', () => {
      const value = insert.value
      insert.value = ''
      if (value === 'image') {
        this.host.insertImage()
        return
      }
      const item = INSERTS[Number(value)]
      if (item) item.run(this.host.getView())
    })
    this.editing.push(insert)

    const symbolBtn = button('', 'Symbols', 'omega')
    this.editing.push(symbolBtn)
    this.symbols = this.buildSymbols()
    symbolBtn.addEventListener('click', () => this.toggleSymbols(symbolBtn))

    const find = button('', `Find and replace (${mod}F)`, 'search')
    find.addEventListener('click', () => {
      const view = this.host.getView()
      openSearchPanel(view)
    })

    this.boundaryBtn = button('', 'Show where environments begin and end', 'braces')
    this.boundaryBtn.addEventListener('click', () => {
      this.host.setBoundaries(!this.host.getBoundaries())
      this.update(this.host.getView())
    })

    this.picturesBtn = button('', 'Draw TikZ and other pictures with your TeX', 'shapes')
    this.picturesBtn.addEventListener('click', () => {
      this.host.setPictures(!this.host.getPictures().on)
      this.update(this.host.getView())
    })

    const exportBtn = button('', 'Export as HTML', 'download')
    exportBtn.addEventListener('click', () => this.host.exportHtml())

    this.words = document.createElement('span')
    this.words.className = 'rt-words'
    this.words.setAttribute('aria-live', 'polite')

    const spacer = document.createElement('div')
    spacer.className = 'rt-spacer'

    this.el.append(
      modes,
      group(this.undoBtn, this.redoBtn),
      group(this.heading),
      group(
        fmt('textbf', `Bold (${mod}B)`, 'bold'),
        fmt('textit', `Italic (${mod}I)`, 'italic'),
        fmt('underline', `Underline (${mod}U)`, 'underline'),
        fmt('texttt', 'Monospace', 'code')
      ),
      group(inlineMath, displayMath),
      group(
        this.action(button('', 'Bulleted list', 'list'), (v) => insertList(v, 'itemize')),
        this.action(button('', 'Numbered list', 'listOrdered'), (v) => insertList(v, 'enumerate')),
        this.action(button('', `Link (${mod}K)`, 'link'), insertLink),
        symbolBtn
      ),
      group(insert),
      spacer,
      this.words,
      group(this.picturesBtn, this.boundaryBtn, find, exportBtn),
      this.symbols
    )
  }

  private action(el: HTMLButtonElement, run: (view: EditorView) => boolean): HTMLButtonElement {
    el.addEventListener('click', () => {
      const view = this.host.getView()
      run(view)
      view.focus()
    })
    this.editing.push(el)
    return el
  }

  private buildSymbols(): HTMLElement {
    const panel = document.createElement('div')
    panel.className = 'rt-symbols'
    panel.hidden = true
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'Symbols')
    for (const [tex, glyph] of SYMBOLS) {
      const b = button(glyph, tex)
      b.classList.add('rt-symbol')
      b.addEventListener('click', () => {
        this.insertSymbol(tex)
        panel.hidden = true
      })
      panel.append(b)
    }
    document.addEventListener('mousedown', (e) => {
      if (!panel.hidden && e.target instanceof Node && !panel.contains(e.target) && !(e.target instanceof Element && e.target.closest('[aria-label="Symbols"]'))) {
        panel.hidden = true
      }
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) {
        panel.hidden = true
        this.host.getView().focus()
      }
    })
    return panel
  }

  private toggleSymbols(anchor: HTMLElement): void {
    const panel = this.symbols
    panel.hidden = !panel.hidden
    if (!panel.hidden) {
      const bar = this.el.getBoundingClientRect()
      const at = anchor.getBoundingClientRect()
      panel.style.left = `${Math.max(8, Math.min(at.left - bar.left, bar.width - 300))}px`
    }
  }

  /** Inserts a math symbol; outside math it brings its own `$...$`. */
  private insertSymbol(tex: string): void {
    const view = this.host.getView()
    const head = view.state.selection.main.head
    const inMath = view.state
      .field(analysisField)
      .scan.constructs.some((c) => c.kind === 'math' && c.bodyFrom <= head && head <= c.bodyTo)
    const body = tex.replace(/\{\}/g, '{#{}}')
    const plainEnd = /[a-zA-Z]$/.test(tex) ? ' ' : ''
    insertSnippet(view, inMath ? `${body}${body === tex ? plainEnd : ''}` : `$${body}$`)
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly
    for (const el of this.editing) (el as HTMLButtonElement).disabled = readOnly
    this.el.classList.toggle('rt-readonly', readOnly)
  }

  private wordText = ''
  private status: string | null = null
  private statusTimer: ReturnType<typeof setTimeout> | undefined

  private renderWords(): void {
    this.words.textContent = this.status ?? this.wordText
  }

  /** A short message in place of the word count, such as an image upload's progress. */
  setStatus(text: string | null, tone: 'normal' | 'error' = 'normal', clearAfterMs = 0): void {
    clearTimeout(this.statusTimer)
    this.status = text
    this.words.classList.toggle('rt-status-error', text !== null && tone === 'error')
    this.renderWords()
    if (text !== null && clearAfterMs > 0) this.statusTimer = setTimeout(() => this.setStatus(null), clearAfterMs)
  }

  setWords(count: number | null): void {
    this.wordText = count === null ? '' : `${count.toLocaleString()} ${count === 1 ? 'word' : 'words'}`
    this.renderWords()
  }

  update(view: EditorView): void {
    const mode = this.host.getMode()
    const on = this.host.getBoundaries()
    this.boundaryBtn.classList.toggle('rt-active', on)
    this.boundaryBtn.setAttribute('aria-pressed', String(on))
    // Only the visual view folds or marks environment lines.
    this.boundaryBtn.hidden = mode !== 'visual'
    const pictures = this.host.getPictures()
    this.picturesBtn.classList.toggle('rt-active', pictures.on && !pictures.problem)
    this.picturesBtn.setAttribute('aria-pressed', String(pictures.on))
    this.picturesBtn.title = pictures.problem
      ? `Pictures are shown as code: ${pictures.problem}`
      : pictures.on
        ? 'Drawing TikZ and other pictures with your TeX (click to show their code)'
        : 'Draw TikZ and other pictures with your TeX'
    for (const [m, b] of this.modeButtons) {
      b.setAttribute('aria-checked', String(m === mode))
      b.classList.toggle('rt-active', m === mode)
    }
    const { state } = view
    const main = state.selection.main
    for (const f of this.formats) {
      const on = formatAt(state, f.cmd, main.from, main.to) !== null
      f.el.setAttribute('aria-pressed', String(on))
      f.el.classList.toggle('rt-active', on)
    }
    const heading = headingAt(state, main.head)
    const value = heading?.cmd ?? ''
    if (this.heading.value !== value) this.heading.value = HEADINGS.some(([v]) => v === value) ? value : ''
    if (!this.readOnly) {
      this.undoBtn.disabled = !undo({ state, dispatch: () => undefined })
      this.redoBtn.disabled = !redo({ state, dispatch: () => undefined })
    }
  }
}
