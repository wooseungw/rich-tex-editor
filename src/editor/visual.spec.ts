import { EditorSelection, EditorState } from '@codemirror/state'
import type { Decoration } from '@codemirror/view'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analysisField } from './analysis'
import { fillTemplate } from './commands'
import {
  atomicRangesFor,
  boundaryMarkers,
  backspaceInPlace,
  deleteInPlace,
  enterInPlace,
  focusedForTest,
  focusTracking,
  visualDecorationsFor
} from './visual'
import { BoundaryWidget, EnvTitleWidget, MathWidget, PreambleWidget, TableWidget, TextWidget } from './widgets'

interface Seen {
  from: number
  to: number
  kind: 'replace' | 'mark' | 'line' | 'widget'
  cls: string
  widget: unknown
  block: boolean
}

/** Decorations for `doc` with the cursor at `|` (removed from the text), in a focused editor
 *  unless `focused` is false. */
function decorations(docWithCursor: string, focused = true): { doc: string; seen: Seen[] } {
  const at = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(at < 0 ? doc.length : at),
    extensions: [analysisField, focusTracking]
  }).update({ effects: focusedForTest(focused) }).state
  const seen: Seen[] = []
  visualDecorationsFor(state).between(0, doc.length, (from, to, value: Decoration) => {
    const spec = value.spec as { widget?: unknown; class?: string; block?: boolean }
    const kind = from === to && !spec.widget && spec.class !== undefined ? 'line' : value.point ? (from === to ? 'widget' : 'replace') : 'mark'
    seen.push({ from, to, kind: spec.widget && from === to ? 'widget' : kind, cls: spec.class ?? '', widget: spec.widget, block: !!spec.block })
  })
  return { doc, seen }
}

const replaced = (r: { doc: string; seen: Seen[] }) =>
  r.seen.filter((s) => s.kind === 'replace').map((s) => r.doc.slice(s.from, s.to))

test('inline math renders unless the cursor is in it', () => {
  const away = decorations('|Energy $E=mc^2$ here.')
  const math = away.seen.find((s) => s.widget instanceof MathWidget)
  assert.ok(math)
  assert.equal(away.doc.slice(math.from, math.to), '$E=mc^2$')
  assert.equal((math.widget as MathWidget).tex.trim(), 'E=mc^2')

  const inside = decorations('Energy $E=|mc^2$ here.')
  assert.ok(!inside.seen.some((s) => s.widget instanceof MathWidget))
  assert.ok(inside.seen.some((s) => s.kind === 'mark' && s.cls === 'cm-rt-math-source'))
})

test('display math on its own lines becomes one block covering them', () => {
  const r = decorations('|Text\n  \\[\n  x^2\n  \\]\nmore')
  const block = r.seen.find((s) => s.widget instanceof MathWidget)
  assert.ok(block)
  assert.equal(block.block, true)
  assert.equal(r.doc.slice(block.from, block.to), '  \\[\n  x^2\n  \\]')
})

test('editing display math shows its source and a rendering under it', () => {
  const r = decorations('Text\n\\[\n  x^|2\n\\]\nmore')
  const preview = r.seen.find((s) => s.widget instanceof MathWidget)
  assert.ok(preview)
  assert.equal((preview.widget as MathWidget).placement, 'preview')
  assert.equal(preview.block, true)
})

test('headings hide their command and show the number', () => {
  const r = decorations('\\section{Intro} text|\n')
  const number = r.seen.find((s) => s.widget instanceof TextWidget)
  assert.ok(number)
  assert.equal((number.widget as TextWidget).text, '1')
  assert.deepEqual(replaced(r), ['\\section{', '}'])
  assert.ok(r.seen.some((s) => s.kind === 'line' && s.cls.includes('cm-rt-section')))
})

test('a heading stays rendered while its text is edited', () => {
  const r = decorations('\\section{In|tro}\n')
  assert.deepEqual(replaced(r), ['\\section{', '}'])
})

test('a caption stays rendered while its text is edited', () => {
  const r = decorations('\\begin{figure}\n\\caption{A pl|ot}\\label{fig:a}\n\\end{figure}\nx')
  const label = r.seen.find((s) => s.widget instanceof TextWidget && (s.widget as TextWidget).className === 'cm-rt-caption-label')
  assert.ok(label)
  assert.equal((label.widget as TextWidget).text, 'Figure 1:')
  assert.ok(r.seen.some((s) => s.kind === 'line' && s.cls === 'cm-rt-caption-line'))
  // The label beside it is plain, quiet source, not a chip.
  assert.ok(r.seen.some((s) => s.kind === 'mark' && s.cls === 'cm-rt-quiet' && r.doc.slice(s.from, s.to) === '\\label{fig:a}'))
})

test('typing right after a formula or a reference leaves it rendered', () => {
  const math = decorations('Energy $E=mc^2$| here.')
  assert.ok(math.seen.some((s) => s.widget instanceof MathWidget))
  const isRef = (s: Seen) => s.widget instanceof TextWidget && (s.widget as TextWidget).className.includes('cm-rt-ref')
  const ref = decorations('\\section{A}\\label{a}\nSee \\ref{a}|.')
  assert.ok(ref.seen.some(isRef))
  const open = decorations('\\section{A}\\label{a}\nSee \\ref{|a}.')
  assert.ok(!open.seen.some(isRef))
})

test('the cursor steps over hidden markup', () => {
  const doc = 'A \\textbf{bold} word'
  const state = EditorState.create({ doc, extensions: [analysisField, focusTracking] })
  const atomic: string[] = []
  atomicRangesFor(state).between(0, doc.length, (from, to) => {
    atomic.push(doc.slice(from, to))
  })
  assert.deepEqual(atomic, ['\\textbf{', '}'])
})

/** Runs a command on `doc` with the cursor at `|`; answers the text and cursor after it. */
function run(command: typeof backspaceInPlace, docWithCursor: string): string | null {
  const at = docWithCursor.indexOf('|')
  let state = EditorState.create({
    doc: docWithCursor.replace('|', ''),
    selection: EditorSelection.cursor(at),
    extensions: [analysisField]
  })
  const handled = command({ state, dispatch: (tr) => (state = tr.state) })
  if (!handled) return null
  const head = state.selection.main.head
  return state.doc.sliceString(0, head) + '|' + state.doc.sliceString(head)
}

test('backspace at the start of formatted text deletes the character before it', () => {
  assert.equal(run(backspaceInPlace, 'ab \\textbf{|cd}'), 'ab\\textbf{|cd}')
  assert.equal(run(backspaceInPlace, 'ab \\textbf{\\emph{|cd}}'), 'ab\\textbf{\\emph{|cd}}')
  assert.equal(run(backspaceInPlace, 'ab \\textbf{c|d}'), null)
})

test('backspace at the start of a heading turns it into text; a caption stays whole', () => {
  assert.equal(run(backspaceInPlace, 'x\n\\section{|Intro}\n'), 'x\n|Intro\n')
  assert.equal(run(backspaceInPlace, '\\begin{figure}\\caption{|Cap}\\end{figure}'), '\\begin{figure}\\caption{|Cap}\\end{figure}')
})

test('delete at the end of formatted text deletes the character after it', () => {
  assert.equal(run(deleteInPlace, '\\textbf{cd|} ef'), '\\textbf{cd|}ef')
})

test('enter in a heading starts a new line after it', () => {
  assert.equal(run(enterInPlace, '\\section{In|tro}\nText'), '\\section{Intro}\n|\nText')
  assert.equal(run(enterInPlace, 'A \\textbf{bold|} word'), 'A \\textbf{bold}\n| word')
  assert.equal(run(enterInPlace, 'A \\textbf{bo|ld} word'), null)
})

test('bold text hides its markup', () => {
  const r = decorations('|A \\textbf{bold} word')
  assert.deepEqual(replaced(r), ['\\textbf{', '}'])
  assert.ok(r.seen.some((s) => s.kind === 'mark' && s.cls === 'cm-rt-bold' && r.doc.slice(s.from, s.to) === 'bold'))
})

test('references resolve to numbers', () => {
  const r = decorations(
    '|\\section{A}\\label{sec:a}\n\\begin{equation}x\\label{eq:x}\\end{equation}\nSee \\ref{sec:a} and \\eqref{eq:x} and \\ref{nope}.'
  )
  const chips = r.seen
    .filter((s) => s.widget instanceof TextWidget && (s.widget as TextWidget).className.includes('cm-rt-ref'))
    .map((s) => (s.widget as TextWidget).text)
  assert.deepEqual(chips, ['1', '(1)', '??'])
})

test('the preamble folds to a summary until the cursor is in it', () => {
  const src = '\\documentclass{article}\n\\usepackage{amsmath,graphicx}\n\\newcommand{\\R}{\\mathbb{R}}\n\\begin{document}\n$\\R$ x|\n\\end{document}'
  const folded = decorations(src)
  const fold = folded.seen.find((s) => s.widget instanceof PreambleWidget)
  assert.ok(fold)
  assert.equal(fold.block, true)
  assert.equal((fold.widget as PreambleWidget).summary, 'article · 2 packages · 1 macro')
  assert.equal((fold.widget as PreambleWidget).lines, 3)

  const editing = decorations('\\documentclass{article}|\n\\begin{document}\nx\n\\end{document}')
  assert.ok(!editing.seen.some((s) => s.widget instanceof PreambleWidget))
  assert.equal(editing.seen.filter((s) => s.kind === 'line' && s.cls === 'cm-rt-preamble').length, 1)
})

test('preamble macros reach the math in the body', () => {
  const r = decorations('\\documentclass{article}\n\\newcommand{\\R}{\\mathbb{R}}\n\\begin{document}\n$\\R$ x|\n\\end{document}')
  const math = r.seen.find((s) => s.widget instanceof MathWidget)
  assert.ok(math)
  assert.equal((math.widget as MathWidget).macros['\\R'], '\\mathbb{R}')
})

test('list items get markers and indentation', () => {
  const r = decorations('\\begin{enumerate}\n\\item one\n\\item two\n\\end{enumerate}\nAfter|')
  const markers = r.seen.filter((s) => s.widget instanceof TextWidget && (s.widget as TextWidget).className.includes('cm-rt-item'))
  assert.deepEqual(markers.map((m) => (m.widget as TextWidget).text), ['1.', '2.'])
  assert.equal(r.seen.filter((s) => s.kind === 'line' && s.cls.includes('cm-rt-indent-1')).length, 2)
  // The begin and end lines fold to a thin gap.
  assert.equal(r.seen.filter((s) => s.kind === 'line' && s.cls === 'cm-rt-folded').length, 2)
})

test('an unfocused editor shows everything rendered, even under the cursor', () => {
  const r = decorations('Energy $E=|mc^2$ here.', false)
  assert.ok(r.seen.some((s) => s.widget instanceof MathWidget))
})

test('a footnote folds to its number', () => {
  const r = decorations('Text\\footnote{A note with $x$.} more|')
  const mark = r.seen.find((s) => s.widget instanceof TextWidget && (s.widget as TextWidget).className === 'cm-rt-fnmark')
  assert.ok(mark)
  assert.equal(r.doc.slice(mark.from, mark.to), '\\footnote{A note with $x$.}')
  assert.equal((mark.widget as TextWidget).text, '1')
  // The math inside is covered by the mark, not drawn separately.
  assert.ok(!r.seen.some((s) => s.widget instanceof MathWidget))
})

test('a tabular on its own lines is drawn as a table', () => {
  const r = decorations('Before|\n\\begin{tabular}{lc}\na & $b$ \\\\\n\\end{tabular}\nAfter')
  const table = r.seen.find((s) => s.widget instanceof TableWidget)
  assert.ok(table)
  assert.equal(table.block, true)
  assert.ok(r.doc.slice(table.from, table.to).startsWith('\\begin{tabular}'))
  assert.ok(!r.seen.some((s) => s.widget instanceof MathWidget))
})

test('theorems get their numbered title, proofs end with a box', () => {
  const r = decorations('|x\n\\begin{theorem}[Main]\nBody.\n\\end{theorem}\n\\begin{proof}\nEasy.\n\\end{proof}')
  const titles = r.seen.filter((s) => s.widget instanceof EnvTitleWidget).map((s) => (s.widget as EnvTitleWidget).title)
  assert.deepEqual(titles, ['Theorem 1', 'Proof', '∎'])
  assert.ok(r.seen.some((s) => s.kind === 'line' && s.cls.includes('cm-rt-block-plain')))
})

test('layout-only lines fold, layout commands inside text hide', () => {
  const r = decorations('|x\n\\begin{figure}[h]\n  \\centering\n  \\caption{C}\n\\end{figure}\n\\noindent Text')
  assert.equal(r.seen.filter((s) => s.kind === 'line' && s.cls === 'cm-rt-folded').length, 3)
  assert.ok(replaced(r).includes('\\noindent'))
})

test('equations are numbered in document order', () => {
  const r = decorations('|\\begin{equation}a\\end{equation}\n\\begin{equation*}b\\end{equation*}\n\\begin{equation}c\\end{equation}')
  const tex = r.seen.filter((s) => s.widget instanceof MathWidget).map((s) => (s.widget as MathWidget).tex)
  assert.ok(tex[0].includes('\\tag{1}'))
  assert.ok(!tex[1].includes('\\tag'))
  assert.ok(tex[2].includes('\\tag{2}'))
})

test('wrapping a selection keeps its dollars, backslashes and indentation exactly', () => {
  for (const selected of ['$$a+b$$', "$a$&$b$ and $' $`", 'C:\\ and \\{x\\}', '\tint main() {\n\t\treturn 0;\n\t}']) {
    const { text } = fillTemplate('\\[\n  #{selection}\n\\]', selected)
    assert.equal(text, `\\[\n  ${selected}\n\\]`)
  }
  const { text, field } = fillTemplate('\\begin{equation}\n  #{selection}\n  \\label{eq:#{key}}\n\\end{equation}', 'x')
  assert.ok(field)
  assert.equal(text.slice(field[0], field[1]), 'key')
})

test('with boundary markers on, environments show where they begin and end', () => {
  const doc = '\\begin{itemize}\n\\item one\n\\end{itemize}\n\\begin{figure}[h]\n\\centering\n\\end{figure}\nAfter'
  const state = EditorState.create({ doc, extensions: [analysisField, focusTracking, boundaryMarkers.of(true)] })
  const markers: string[] = []
  let folded = 0
  visualDecorationsFor(state).between(0, doc.length, (_from, _to, value) => {
    const spec = value.spec as { widget?: unknown; class?: string }
    if (spec.widget instanceof BoundaryWidget) markers.push(`${spec.widget.begin ? 'begin' : 'end'} ${spec.widget.label}`)
    if (spec.class === 'cm-rt-folded') folded++
  })
  assert.deepEqual(markers, ['begin itemize', 'end itemize', 'begin figure [h]', 'end figure'])
  // \centering is layout, not an environment: it still folds.
  assert.equal(folded, 1)
})
