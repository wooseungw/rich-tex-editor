import {
  type EditorState,
  type Extension,
  Facet,
  findClusterBreak,
  Prec,
  type Range,
  type StateCommand,
  StateEffect,
  StateField,
  type Text
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, hoverTooltip, keymap, showTooltip, type Tooltip } from '@codemirror/view'
import type { Construct, EnvConstruct, FormatConstruct, HeadingConstruct, RefConstruct } from '../latex/scan'
import { plainText, todayText } from '../latex/scan'
import { type Analysis, analysisField } from './analysis'
import { renderFragment } from './fragment'
import { imageLoader, refreshImages } from './image-loader'
import { renderMath } from './math-render'
import {
  BoundaryWidget,
  EnvTitleWidget,
  ImageWidget,
  LogoWidget,
  MathWidget,
  PreambleWidget,
  TableWidget,
  TextWidget,
  TitleWidget
} from './widgets'

/**
 * The visual mode: LaTeX stays the document, but it reads like the typeset page.
 *
 * - Text with markup around it (headings, `\textbf`, `\emph`, captions, links) is edited in
 *   place: the markup stays hidden and the cursor steps over it, so typing in a caption or a
 *   heading never changes how the line looks. Shortcuts, the toolbar and the split view change
 *   the markup itself.
 * - Things drawn in place of their source (math, references, tables, images, symbols) open
 *   their source when you click them or move the cursor into them, and close when you leave.
 *   Resting the cursor next to one does not open it, so typing beside a formula stays calm.
 * - `\label` and other bookkeeping show as plain, quiet source.
 * - Lines that only arrange the page (`\begin{itemize}`, `\centering`) fold to a thin gap and
 *   open when the cursor arrives on them; the preamble folds to one summary line.
 */

const hide = Decoration.replace({})
const markup = Decoration.mark({ class: 'cm-rt-markup' })
const mathSource = Decoration.mark({ class: 'cm-rt-math-source' })
const comment = Decoration.mark({ class: 'cm-rt-comment' })
const monoMark = Decoration.mark({ class: 'cm-rt-mono' })
const preambleLine = Decoration.line({ class: 'cm-rt-preamble' })
const codeLine = Decoration.line({ class: 'cm-rt-code-line' })
const foldedLine = Decoration.line({ class: 'cm-rt-folded' })
const captionLine = Decoration.line({ class: 'cm-rt-caption-line' })
const quietSource = Decoration.mark({ class: 'cm-rt-quiet' })
const boundaryLine = Decoration.line({ class: 'cm-rt-boundary-line' })
const indentLines = Array.from({ length: 8 }, (_, depth) =>
  Decoration.line({ class: `cm-rt-indent cm-rt-indent-${depth}` })
)
const formatMarks = new Map<string, Decoration>()
const formatMark = (style: string, color?: string) => {
  const key = `${style}|${color ?? ''}`
  let mark = formatMarks.get(key)
  if (!mark) {
    mark = Decoration.mark({
      class: `cm-rt-${style}`,
      attributes: color ? { style: `color: ${color}` } : undefined
    })
    formatMarks.set(key, mark)
  }
  return mark
}

const SAFE_URL = /^(https?:|mailto:)/i

/** Environments whose begin and end lines only arrange the page; they fold to a thin gap. */
const FOLDED_ENVIRONMENTS = new Set([
  'document',
  'itemize',
  'enumerate',
  'description',
  'center',
  'flushleft',
  'flushright',
  'figure',
  'figure*',
  'table',
  'table*',
  'wrapfigure',
  'wraptable',
  'subfigure',
  'subtable',
  'minipage',
  'multicols',
  'quote',
  'quotation',
  'verse',
  'abstract',
  'thebibliography',
  'appendices',
  'subequations'
])

/** Whether `[from, to)` is alone on its lines, apart from whitespace. */
function ownsLines(doc: Text, from: number, to: number): boolean {
  const first = doc.lineAt(from)
  const last = doc.lineAt(to)
  return doc.sliceString(first.from, from).trim() === '' && doc.sliceString(to, last.to).trim() === ''
}

const REF_KIND_NAMES: Record<string, string> = {
  section: 'Section',
  figure: 'Figure',
  table: 'Table',
  equation: 'Equation',
  item: 'Item',
  theorem: 'Theorem',
  other: ''
}

function refChip(c: RefConstruct, a: Analysis): { text: string; className: string; title: string } {
  const key = c.keys[0] ?? ''
  const all = c.keys.join(', ')
  switch (c.cmd) {
    case 'label':
      return { text: key, className: 'cm-rt-chip cm-rt-label', title: `\\label{${key}}` }
    case 'input':
    case 'include':
      return { text: key, className: 'cm-rt-chip cm-rt-input', title: `\\${c.cmd}{${key}}` }
    case 'cite':
    case 'citep':
    case 'citet':
    case 'citealp':
    case 'citeauthor':
    case 'citeyear':
    case 'parencite':
    case 'textcite':
    case 'autocite':
    case 'footcite':
    case 'nocite': {
      const shown = c.keys.map((k) => a.citations.get(k) ?? k).join(', ')
      return { text: `[${shown}]`, className: 'cm-rt-chip cm-rt-cite', title: `\\${c.cmd}{${all}}` }
    }
    default: {
      const target = a.labels.get(key)
      const number = target?.number ?? '??'
      let text = number
      if (c.cmd === 'eqref') text = `(${number})`
      else if (c.cmd === 'autoref' || c.cmd === 'Autoref' || c.cmd === 'cref' || c.cmd === 'Cref') {
        const kind = target ? REF_KIND_NAMES[target.kind] : ''
        const name = c.cmd === 'cref' ? kind.toLowerCase() : kind
        text = target?.kind === 'equation' ? `${name} (${number})` : `${name} ${number}`.trim()
      } else if (c.cmd === 'pageref') text = `p. ${number}`
      else if (c.cmd === 'nameref') text = key
      return {
        text,
        className: `cm-rt-chip cm-rt-ref${target ? '' : ' cm-rt-ref-missing'}`,
        title: `\\${c.cmd}{${all}}${target ? '' : ' — no such label'}`
      }
    }
  }
}

/** `article · 4 packages · 3 macros` for the folded preamble. */
function preambleSummary(preamble: string, a: Analysis): string {
  const parts: string[] = []
  const docClass = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/.exec(preamble)?.[1]?.trim()
  if (docClass) parts.push(docClass)
  let packages = 0
  for (const m of preamble.matchAll(/^[^%\n]*\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/gm)) {
    packages += m[1].split(',').filter((p) => p.trim()).length
  }
  if (packages) parts.push(`${packages} ${packages === 1 ? 'package' : 'packages'}`)
  const macros = Object.keys(a.macros).length
  if (macros) parts.push(`${macros} ${macros === 1 ? 'macro' : 'macros'}`)
  return parts.join(' · ')
}

/**
 * Whether the person has started editing. Until the editor is first focused everything shows
 * rendered (the cursor's starting place would otherwise open its source). After that it stays
 * set: flipping the whole document between source and rendering on every blur and focus (a
 * toolbar menu, another pane) makes the page flash.
 */
const setFocus = StateEffect.define<boolean>()
const focusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFocus)) value = value || effect.value
    return value
  }
})
const focusTracker = EditorView.focusChangeEffect.of((state, focusing) =>
  focusing && !state.field(focusField, false) ? setFocus.of(true) : null
)

/**
 * Whether environments show where they begin and end (`itemize ───`, `end itemize ───`) or fold
 * those lines to a thin gap. A view option, set from the toolbar.
 */
export const boundaryMarkers = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean)
})

/** A line-sized piece the visual mode may fold away, or hide inline when its line has text. */
interface Foldable {
  from: number
  to: number
}

/**
 * Where the selection is, for deciding what opens. `inside`: a selection reaches into the range
 * or the cursor sits strictly within it; resting on either edge does not count. `within`: the
 * cursor anywhere from one edge to the other, edges included.
 */
interface Reveal {
  inside(from: number, to: number): boolean
  within(from: number, to: number): boolean
}

function revealFor(state: EditorState): Reveal {
  if (!state.field(focusField, false)) return { inside: () => false, within: () => false }
  const ranges = state.selection.ranges
  return {
    inside: (from, to) => ranges.some((r) => (r.empty ? r.from > from && r.from < to : r.from < to && r.to > from)),
    within: (from, to) => ranges.some((r) => r.from <= to && r.to >= from)
  }
}

/** Decorations, plus the replaced ranges the cursor steps over in one move. */
interface Built {
  decorations: DecorationSet
  atomic: DecorationSet
}

class Sink {
  readonly ranges: Range<Decoration>[] = []
  readonly atomic: Range<Decoration>[] = []
  add(range: Range<Decoration>): void {
    this.ranges.push(range)
  }
  /** A replaced range the cursor treats as one unit. */
  replace(deco: Decoration, from: number, to: number): void {
    const range = deco.range(from, to)
    this.ranges.push(range)
    if (to > from) this.atomic.push(range)
  }
}

function buildDecorations(state: EditorState): Built {
  const a = state.field(analysisField)
  const s = a.scan
  const doc = state.doc
  const sink = new Sink()
  const reveal = revealFor(state)
  const bodyStart = s.documentStart ?? 0

  // The preamble folds to one summary line until the cursor arrives in it.
  if (s.documentStart !== null && s.documentStart > 0) {
    const lastLine = doc.lineAt(s.documentStart).number - 1
    if (lastLine >= 1) {
      const end = doc.line(lastLine).to
      if (reveal.within(0, end)) {
        for (let n = 1; n <= lastLine; n++) sink.add(preambleLine.range(doc.line(n).from))
      } else {
        const preamble = doc.sliceString(0, end)
        const widget = new PreambleWidget(preambleSummary(preamble, a), lastLine)
        sink.add(Decoration.replace({ widget, block: true }).range(0, end))
      }
    }
  }

  if (s.lists.length > 0) {
    const depthByLine = new Map<number, number>()
    const raise = (line: number, depth: number) => {
      if (depth > (depthByLine.get(line) ?? 0)) depthByLine.set(line, depth)
    }
    for (const list of s.lists) {
      const first = doc.lineAt(list.from).number
      const last = doc.lineAt(Math.min(list.to, doc.length)).number
      raise(first, list.depth - 1)
      raise(last, list.depth - 1)
      for (let n = first + 1; n < last; n++) raise(n, list.depth)
    }
    for (const [line, depth] of depthByLine) {
      if (depth > 0) sink.add(indentLines[Math.min(depth, indentLines.length - 1)].range(doc.line(line).from))
    }
  }

  for (const block of s.blocks) {
    if (block.from < bodyStart) continue
    const first = doc.lineAt(block.from).number
    const last = doc.lineAt(Math.min(block.to, doc.length)).number
    const line = Decoration.line({ class: `cm-rt-block cm-rt-block-${block.style}` })
    for (let n = first; n <= last; n++) sink.add(line.range(doc.line(n).from))
  }

  const blockNames = new Set(s.blocks.map((b) => b.name))
  const foldables: Foldable[] = []
  let hiddenUntil = -1
  for (const c of s.constructs) {
    if (c.kind === 'comment') {
      if (c.to > c.from && c.from >= hiddenUntil) sink.add(comment.range(c.from, c.to))
      continue
    }
    if (c.from < bodyStart || c.from < hiddenUntil) continue
    const covered = decorate(c, a, state, reveal, sink, foldables, blockNames)
    if (covered > hiddenUntil) hiddenUntil = covered
  }

  foldLines(foldables, doc, reveal, sink)
  return { decorations: Decoration.set(sink.ranges, true), atomic: Decoration.set(sink.atomic, true) }
}

/**
 * Lines made only of foldable pieces (and whitespace) fold to a thin gap, opening when the cursor
 * arrives on them; elsewhere each piece is hidden in place and opens when the cursor goes into it.
 */
function foldLines(foldables: Foldable[], doc: Text, reveal: Reveal, sink: Sink): void {
  const byLine = new Map<number, Foldable[]>()
  for (const f of foldables) {
    const line = doc.lineAt(f.from).number
    if (doc.lineAt(f.to).number !== line) continue
    const list = byLine.get(line)
    if (list) list.push(f)
    else byLine.set(line, [f])
  }
  for (const [number, pieces] of byLine) {
    const line = doc.line(number)
    let rest = line.text
    for (const p of [...pieces].sort((x, y) => y.from - x.from)) {
      rest = rest.slice(0, p.from - line.from) + rest.slice(p.to - line.from)
    }
    if (rest.trim() === '') {
      if (reveal.within(line.from, line.to)) continue
      sink.add(foldedLine.range(line.from))
      // Not atomic: moving up or down lands on the line, which opens it.
      if (line.to > line.from) sink.add(hide.range(line.from, line.to))
      continue
    }
    for (const p of pieces) if (!reveal.inside(p.from, p.to)) sink.replace(hide, p.from, p.to)
  }
}

/** Decorates one construct; returns the end of a range it replaced whole (children skipped). */
function decorate(
  c: Exclude<Construct, { kind: 'comment' }>,
  a: Analysis,
  state: EditorState,
  reveal: Reveal,
  sink: Sink,
  foldables: Foldable[],
  blockNames: ReadonlySet<string>
): number {
  const doc = state.doc
  switch (c.kind) {
    case 'math': {
      const prepared = a.math.get(c)
      if (!prepared) return -1
      const block = c.display && ownsLines(doc, c.from, c.to)
      const from = block ? doc.lineAt(c.from).from : c.from
      const to = block ? doc.lineAt(c.to).to : c.to
      if (reveal.inside(from, to)) {
        sink.add(mathSource.range(c.from, c.to))
        if (c.display) {
          const widget = new MathWidget(prepared.tex, prepared.displayMode, a.macros, a.macrosKey, 'preview', 0)
          sink.add(Decoration.widget({ widget, block: true, side: 1 }).range(doc.lineAt(c.to).to))
        }
        return -1
      }
      const widget = new MathWidget(prepared.tex, prepared.displayMode, a.macros, a.macrosKey, block ? 'block' : 'inline', c.bodyFrom - from)
      sink.replace(Decoration.replace({ widget, block }), from, to)
      return to
    }
    case 'heading':
      decorateHeading(c, doc, sink)
      return -1
    case 'format':
      return decorateFormat(c, state, reveal, sink)
    case 'ref': {
      if (c.cmd === 'label' || c.cmd === 'input' || c.cmd === 'include') {
        sink.add(quietSource.range(c.from, c.to))
        return c.to
      }
      if (reveal.inside(c.from, c.to)) return -1
      const chip = refChip(c, a)
      const open = Math.max(1, doc.sliceString(c.from, c.to).lastIndexOf('{') + 1)
      sink.replace(Decoration.replace({ widget: new TextWidget(chip.text, chip.className, open, chip.title) }), c.from, c.to)
      return c.to
    }
    case 'env':
      decorateEnvironment(c, doc, reveal, sink, foldables, blockNames, state.facet(boundaryMarkers))
      return -1
    case 'layout':
      foldables.push({ from: c.from, to: c.to })
      return -1
    case 'table': {
      if (!ownsLines(doc, c.from, c.to)) return -1
      const from = doc.lineAt(c.from).from
      const to = doc.lineAt(c.to).to
      if (reveal.inside(from, to)) return -1
      const s = a.scan
      const preamble = s.documentStart !== null ? doc.sliceString(0, s.documentStart) : ''
      const widget = new TableWidget(doc.sliceString(c.from, c.to), preamble, c.from - from + 7)
      sink.replace(Decoration.replace({ widget, block: true }), from, to)
      return to
    }
    case 'bibitem': {
      if (reveal.inside(c.from, c.to)) return -1
      const open = Math.max(1, doc.sliceString(c.from, c.to).lastIndexOf('{') + 1)
      sink.replace(Decoration.replace({ widget: new TextWidget(`[${c.label}]`, 'cm-rt-bibnum', open, `\\bibitem{${c.key}}`) }), c.from, c.to)
      return c.to
    }
    case 'item': {
      if (reveal.inside(c.from, c.to)) {
        sink.add(markup.range(c.from, c.to))
        return -1
      }
      const cls = `cm-rt-item cm-rt-item-${c.list}${c.custom ? ' cm-rt-item-custom' : ''}`
      sink.replace(Decoration.replace({ widget: new TextWidget(c.marker, cls, 1) }), c.from, c.to)
      return c.to
    }
    case 'symbol': {
      if (reveal.inside(c.from, c.to)) return -1
      const open = c.to - c.from > 1 ? 1 : 0
      sink.replace(Decoration.replace({ widget: new TextWidget(c.text, 'cm-rt-symbol', open) }), c.from, c.to)
      return c.to
    }
    case 'logo': {
      if (reveal.inside(c.from, c.to)) return -1
      sink.replace(Decoration.replace({ widget: new LogoWidget(c.name) }), c.from, c.to)
      return c.to
    }
    case 'image': {
      const block = ownsLines(doc, c.from, c.to)
      const from = block ? doc.lineAt(c.from).from : c.from
      const to = block ? doc.lineAt(c.to).to : c.to
      if (reveal.inside(from, to)) return -1
      const open = c.from - from + Math.max(1, doc.sliceString(c.from, c.to).lastIndexOf('{') + 1)
      const generation = state.facet(imageLoader)?.generation ?? 0
      sink.replace(Decoration.replace({ widget: new ImageWidget(c.file, c.width, block, open, generation), block }), from, to)
      return to
    }
    case 'maketitle': {
      const block = ownsLines(doc, c.from, c.to)
      const from = block ? doc.lineAt(c.from).from : c.from
      const to = block ? doc.lineAt(c.to).to : c.to
      if (reveal.inside(from, to)) return -1
      const s = a.scan
      const authors = s.author ? s.author.split(/\\and\b/).map(plainText).filter(Boolean).join(' · ') : ''
      const date = s.date === null ? '' : plainText(s.date.replace(/\\today\b/, todayText()))
      const widget = new TitleWidget(plainText(s.title ?? ''), authors, date, block)
      sink.replace(Decoration.replace({ widget, block }), from, to)
      return to
    }
    case 'verbatim': {
      if (c.env === null) {
        if (c.bodyTo > c.bodyFrom) sink.add(monoMark.range(c.bodyFrom, c.bodyTo))
        if (reveal.inside(c.from, c.to) || c.bodyTo === c.bodyFrom) {
          sink.add(markup.range(c.from, c.bodyFrom))
          sink.add(markup.range(c.bodyTo, c.to))
        } else {
          sink.replace(hide, c.from, c.bodyFrom)
          sink.replace(hide, c.bodyTo, c.to)
        }
        return -1
      }
      const first = doc.lineAt(c.from).number
      const last = doc.lineAt(c.to).number
      for (let n = first; n <= last; n++) sink.add(codeLine.range(doc.line(n).from))
      return -1
    }
  }
}

/** Headings are edited in place: the command stays hidden, the number shows before the title. */
function decorateHeading(c: HeadingConstruct, doc: Text, sink: Sink): void {
  sink.add(Decoration.line({ class: `cm-rt-heading cm-rt-${c.cmd}` }).range(doc.lineAt(c.from).from))
  if (c.argFrom === c.argTo) {
    sink.add(markup.range(c.from, c.argFrom))
    sink.add(markup.range(c.argTo, c.to))
    return
  }
  const number = c.number ? new TextWidget(c.number, 'cm-rt-secnum', c.argFrom - c.from) : undefined
  sink.replace(Decoration.replace({ widget: number }), c.from, c.argFrom)
  sink.replace(hide, c.argTo, c.to)
}

/**
 * Formatted text (bold, captions, links, footnotes…) is edited in place with its markup hidden.
 * A footnote shows only its mark until the cursor goes into its text.
 */
function decorateFormat(c: FormatConstruct, state: EditorState, reveal: Reveal, sink: Sink): number {
  const doc = state.doc
  const editing = reveal.within(c.argFrom, c.argTo)
  if (c.style === 'footnote') {
    const mark = new TextWidget(c.prefix ?? '*', 'cm-rt-fnmark', c.argFrom - c.from, null)
    if (!editing) {
      sink.replace(Decoration.replace({ widget: mark }), c.from, c.to)
      return c.to
    }
    sink.replace(Decoration.replace({ widget: mark }), c.from, c.argFrom)
    sink.replace(hide, c.argTo, c.to)
    if (c.argTo > c.argFrom) sink.add(formatMark('footnote').range(c.argFrom, c.argTo))
    return -1
  }
  if (c.style === 'caption' && c.prefix) {
    const line = doc.lineAt(c.from)
    if (doc.sliceString(line.from, c.from).trim() === '') sink.add(captionLine.range(line.from))
  }
  if (c.argFrom === c.argTo && !editing) {
    // Nothing to edit in place: show the empty command so it is not lost from sight.
    sink.add(markup.range(c.from, c.to))
    return -1
  }
  if (c.argTo > c.argFrom) sink.add(formatMark(c.style, c.color).range(c.argFrom, c.argTo))
  if (c.style === 'link' && c.url && SAFE_URL.test(c.url) && c.argTo > c.argFrom) {
    sink.add(Decoration.mark({ attributes: { 'data-rt-url': c.url, title: `${c.url} — ⌘-click to open` } }).range(c.argFrom, c.argTo))
  }
  const open = c.style === 'caption' && c.prefix ? new TextWidget(`${c.prefix}:`, 'cm-rt-caption-label', c.argFrom - c.from) : undefined
  sink.replace(Decoration.replace({ widget: open }), c.from, c.argFrom)
  sink.replace(hide, c.argTo, c.to)
  return -1
}

function decorateEnvironment(
  c: EnvConstruct,
  doc: Text,
  reveal: Reveal,
  sink: Sink,
  foldables: Foldable[],
  blockNames: ReadonlySet<string>,
  markers: boolean
): void {
  const open = c.begin ? 7 : 5
  const alone = ownsLines(doc, c.from, c.to)
  const line = doc.lineAt(c.from)
  const from = alone ? line.from : c.from
  const to = alone ? line.to : c.to
  const titled = (title: string, note: string | null, className: string, lineClass: string) => {
    if (reveal.inside(from, to)) return
    if (alone) sink.add(Decoration.line({ class: lineClass }).range(line.from))
    sink.replace(Decoration.replace({ widget: new EnvTitleWidget(title, note, className, c.from - from + open) }), from, to)
  }

  if (c.begin && c.heading) {
    titled(c.heading, c.option, `cm-rt-theorem-label${c.name === 'proof' ? ' cm-rt-proof-label' : ''}`, 'cm-rt-theorem-line')
    return
  }
  if (!c.begin && c.name === 'proof') {
    titled('∎', null, 'cm-rt-qed', 'cm-rt-qed-line')
    return
  }
  if (c.begin && c.name === 'abstract') {
    titled('Abstract', null, 'cm-rt-envtitle', 'cm-rt-envtitle-line')
    return
  }
  if (c.begin && c.name === 'thebibliography') {
    titled('References', null, 'cm-rt-envtitle-refs', 'cm-rt-heading cm-rt-section')
    return
  }
  if (FOLDED_ENVIRONMENTS.has(c.name) || (!c.begin && blockNames.has(c.name))) {
    if (!markers) {
      foldables.push({ from: c.from, to: c.to })
      return
    }
    // A thin labelled rule where the environment begins or ends; the line opens as source when
    // the cursor arrives on it, like a folded line.
    if (!alone) {
      sink.add(quietSource.range(c.from, c.to))
      return
    }
    if (reveal.within(line.from, line.to)) return
    const label = c.option ? `${c.name} [${c.option}]` : c.name
    sink.add(boundaryLine.range(line.from))
    sink.add(Decoration.replace({ widget: new BoundaryWidget(label, c.begin, c.from - line.from + open) }).range(line.from, line.to))
    return
  }
  // Any other environment shows its own source, quietly.
  sink.add(quietSource.range(c.from, c.to))
}

const visualField = StateField.define<Built>({
  create: buildDecorations,
  update: (value, tr) =>
    tr.docChanged ||
    tr.selection ||
    tr.effects.some((e) => e.is(setFocus) || e.is(refreshImages)) ||
    tr.startState.facet(boundaryMarkers) !== tr.state.facet(boundaryMarkers)
      ? buildDecorations(tr.state)
      : value,
  provide: (field) => [
    EditorView.decorations.from(field, (built) => built.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomic)
  ]
})

/** The visual decorations for a state, for tests. */
export const visualDecorationsFor = (state: EditorState) => buildDecorations(state).decorations
/** The ranges the cursor steps over, for tests. */
export const atomicRangesFor = (state: EditorState) => buildDecorations(state).atomic
/** Marks a test state as focused, so the cursor reveals source as it does while editing. */
export const focusedForTest = (focused: boolean) => setFocus.of(focused)

/** The in-place construct (heading or formatted text) whose shown text starts or ends at `pos`. */
function inPlaceAt(state: EditorState, pos: number, edge: 'start' | 'end'): HeadingConstruct | FormatConstruct | null {
  const a = state.field(analysisField)
  const bodyStart = a.scan.documentStart ?? 0
  let found: HeadingConstruct | FormatConstruct | null = null
  for (const c of a.scan.constructs) {
    if (c.from > pos) break
    if ((c.kind !== 'heading' && c.kind !== 'format') || c.from < bodyStart || c.argTo === c.argFrom) continue
    if ((edge === 'start' ? c.argFrom : c.argTo) === pos) found = c
  }
  return found
}

const keepsWhole = (c: HeadingConstruct | FormatConstruct) => c.kind === 'heading' || c.style === 'caption'

/**
 * Backspace at the start of text edited in place. The hidden markup would otherwise be deleted
 * as one piece and break the command: a heading turns back into plain text, a caption stays
 * whole, and formatted text deletes the character before it, as in a word processor.
 */
export const backspaceInPlace: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection
  if (sel.ranges.length > 1 || !sel.main.empty) return false
  let c = inPlaceAt(state, sel.main.head, 'start')
  if (!c) return false
  if (c.kind === 'heading') {
    dispatch(
      state.update({
        changes: [
          { from: c.from, to: c.argFrom },
          { from: c.argTo, to: c.to }
        ],
        selection: { anchor: c.from },
        userEvent: 'delete.backward'
      })
    )
    return true
  }
  // Step out of nested formatting (`\textbf{\emph{|x}}`) to the outermost start.
  for (let outer = inPlaceAt(state, c.from, 'start'); outer; outer = inPlaceAt(state, c.from, 'start')) c = outer
  if (keepsWhole(c) || c.from === 0) return true
  const line = state.doc.lineAt(c.from)
  const before = c.from === line.from ? c.from - 1 : line.from + findClusterBreak(line.text, c.from - line.from, false)
  dispatch(
    state.update({
      changes: { from: before, to: c.from },
      selection: { anchor: sel.main.head - (c.from - before) },
      userEvent: 'delete.backward',
      scrollIntoView: true
    })
  )
  return true
}

/** Delete at the end of text edited in place: removes the character after it instead. */
export const deleteInPlace: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection
  if (sel.ranges.length > 1 || !sel.main.empty) return false
  let c = inPlaceAt(state, sel.main.head, 'end')
  if (!c) return false
  for (let outer = inPlaceAt(state, c.to, 'end'); outer; outer = inPlaceAt(state, c.to, 'end')) c = outer
  if (keepsWhole(c) || c.to >= state.doc.length) return true
  const line = state.doc.lineAt(c.to)
  const after = c.to === line.to ? c.to + 1 : line.from + findClusterBreak(line.text, c.to - line.from, true)
  dispatch(state.update({ changes: { from: c.to, to: after }, userEvent: 'delete.forward', scrollIntoView: true }))
  return true
}

/** Enter in a heading or caption, or at the end of formatted text, starts a new line after it. */
export const enterInPlace: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection
  if (sel.ranges.length > 1 || !sel.main.empty) return false
  const head = sel.main.head
  const a = state.field(analysisField)
  let target: HeadingConstruct | FormatConstruct | null = null
  for (const c of a.scan.constructs) {
    if (c.from > head) break
    if (c.kind !== 'heading' && c.kind !== 'format') continue
    if (c.argFrom > head || head > c.argTo || c.argTo === c.argFrom) continue
    if (keepsWhole(c) || head === c.argTo) target = c
  }
  if (!target) return false
  for (let outer = inPlaceAt(state, target.to, 'end'); outer; outer = inPlaceAt(state, target.to, 'end')) target = outer
  dispatch(
    state.update({
      changes: { from: target.to, insert: state.lineBreak },
      selection: { anchor: target.to + 1 },
      userEvent: 'input',
      scrollIntoView: true
    })
  )
  return true
}

/** The inline formula the cursor is inside, if any. */
function inlineMathAt(state: EditorState): { from: number; tex: string } | null {
  if (!state.selection.main.empty || !state.field(focusField, false)) return null
  const a = state.field(analysisField)
  const head = state.selection.main.head
  const bodyStart = a.scan.documentStart ?? 0
  for (const c of a.scan.constructs) {
    if (c.from >= head) break
    if (c.kind !== 'math' || c.display || c.to <= head || c.from < bodyStart) continue
    const prepared = a.math.get(c)
    return prepared ? { from: c.from, tex: prepared.tex } : null
  }
  return null
}
/**
 * Inline math under the cursor shows its rendering in a tooltip while you type it. The tooltip
 * stays the same object while you edit one formula and redraws in place; a formula that does
 * not parse yet keeps its last good rendering, dimmed, instead of flashing an error.
 */
function mathTooltip(state: EditorState, previous: Tooltip | undefined): readonly Tooltip[] {
  const at = inlineMathAt(state)
  if (!at) return []
  if (previous && previous.pos === at.from) return [previous]
  return [
    {
      pos: at.from,
      above: false,
      arrow: false,
      create: (view) => {
        const dom = document.createElement('div')
        dom.className = 'cm-rt-math-tooltip'
        const body = document.createElement('div')
        const note = document.createElement('div')
        note.className = 'cm-rt-math-tooltip-error'
        dom.append(body, note)
        let good = false
        const paint = (current: EditorState) => {
          const math = inlineMathAt(current)
          if (!math) return
          const a = current.field(analysisField)
          const rendered = renderMath(math.tex, false, a.macros, a.macrosKey)
          if (rendered.error && good) {
            body.classList.add('cm-rt-math-stale')
            return
          }
          body.classList.remove('cm-rt-math-stale')
          body.innerHTML = rendered.html
          note.textContent = rendered.error ?? ''
          good = rendered.error === null
        }
        paint(view.state)
        return { dom, update: (update) => update.docChanged && paint(update.state) }
      }
    }
  ]
}

const mathTooltipField = StateField.define<readonly Tooltip[]>({
  create: (state) => mathTooltip(state, undefined),
  update: (value, tr) =>
    tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setFocus)) ? mathTooltip(tr.state, value[0]) : value,
  provide: (field) => showTooltip.computeN([field], (state) => state.field(field))
})

/** Hovering a folded footnote mark shows the footnote, rendered. */
const footnoteHover = hoverTooltip(
  (view, pos) => {
    const { state } = view
    const reveal = revealFor(state)
    const a = state.field(analysisField)
    for (const c of a.scan.constructs) {
      if (c.from > pos) break
      if (c.kind !== 'format' || c.style !== 'footnote' || c.to < pos || reveal.within(c.argFrom, c.argTo)) continue
      const text = state.sliceDoc(c.argFrom, c.argTo)
      const preamble = a.scan.documentStart !== null ? state.sliceDoc(0, a.scan.documentStart) : ''
      return {
        pos: c.from,
        end: c.to,
        above: true,
        create: () => {
          const dom = document.createElement('div')
          dom.className = 'cm-rt-footnote-tooltip'
          const number = document.createElement('span')
          number.className = 'cm-rt-footnote-tooltip-number'
          number.textContent = c.prefix ?? ''
          const body = document.createElement('div')
          body.className = 'rt-preview rt-embed'
          // The renderer escapes every piece of source text it puts in its HTML.
          body.innerHTML = renderFragment(text, preamble)
          dom.append(number, body)
          return { dom }
        }
      }
    }
    return null
  },
  { hoverTime: 200 }
)

/** Clicks on rendered widgets put the cursor in their source; ⌘/Ctrl-click opens links. */
const clickHandlers = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target instanceof Element ? event.target : null
    if (!target || event.button !== 0) return false
    const link = target.closest<HTMLElement>('[data-rt-url]')
    if (link && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      const url = link.dataset.rtUrl ?? ''
      if (SAFE_URL.test(url)) void orca.shell?.openExternal(url).catch(() => undefined)
      return true
    }
    const widget = target.closest<HTMLElement>('[data-rt-reveal]')
    if (!widget || !view.contentDOM.contains(widget)) return false
    // A press on a wide table's scrollbar scrolls it (the browser's default) instead of opening it.
    if (target.classList.contains('rt-table-wrap') && event.offsetY >= target.clientHeight) return true
    const start = view.posAtDOM(widget)
    const offset = Number(widget.dataset.rtReveal) || 0
    event.preventDefault()
    view.focus()
    view.dispatch({ selection: { anchor: Math.min(start + offset, view.state.doc.length) }, userEvent: 'select.pointer' })
    return true
  }
})

export function visualMode(): Extension {
  return [
    visualField,
    Prec.high(
      keymap.of([
        { key: 'Backspace', run: backspaceInPlace },
        { key: 'Delete', run: deleteInPlace },
        { key: 'Enter', run: enterInPlace }
      ])
    ),
    mathTooltipField,
    footnoteHover,
    clickHandlers,
    EditorView.editorAttributes.of({ class: 'cm-rt-visual' })
  ]
}

/** Focus tracking stays installed in both modes, so switching modes keeps it current. */
export const focusTracking: Extension = [focusField, focusTracker]
