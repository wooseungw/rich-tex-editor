import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorState, type Extension, Text, Transaction } from '@codemirror/state'
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { analysisField } from './analysis'
import { insertDisplayMath, insertInlineMath, insertLink, toggleFormat } from './commands'
import { latexCompletionSources } from './completions'
import { crlfOf, outsideChanges } from './outside'
import { boundaryMarkers, focusTracking, visualMode } from './visual'

export type Mode = 'visual' | 'split'

/** Marks changes that came from outside (Orca's document), so they are not sent back. */
export const fromOutside = Annotation.define<boolean>()

const latex = StreamLanguage.define(stex)

const highlight = HighlightStyle.define([
  { tag: tags.keyword, class: 'tok-command' },
  { tag: tags.tagName, class: 'tok-env' },
  { tag: tags.comment, class: 'tok-comment' },
  { tag: tags.bracket, class: 'tok-bracket' },
  { tag: tags.atom, class: 'tok-atom' },
  { tag: tags.number, class: 'tok-number' },
  { tag: tags.special(tags.variableName), class: 'tok-math' },
  { tag: tags.invalid, class: 'tok-error' }
])

const formattingKeymap = keymap.of([
  { key: 'Mod-b', run: toggleFormat('textbf') },
  { key: 'Mod-i', run: toggleFormat('textit') },
  { key: 'Mod-u', run: toggleFormat('underline'), preventDefault: true },
  { key: 'Mod-e', run: toggleFormat('emph') },
  { key: 'Mod-m', run: insertInlineMath },
  { key: 'Mod-Shift-m', run: insertDisplayMath },
  { key: 'Mod-k', run: insertLink }
])

const modes = new Compartment()
const boundaries = new Compartment()
const editable = new Compartment()

function modeExtensions(mode: Mode): Extension {
  return mode === 'visual'
    ? visualMode()
    : [lineNumbers(), highlightActiveLineGutter(), EditorView.editorAttributes.of({ class: 'cm-rt-source' })]
}

function editableExtensions(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}

export interface EditorOptions {
  parent: HTMLElement
  text: string
  readOnly: boolean
  mode: Mode
  /** Show where environments begin and end in the visual mode. */
  boundaries: boolean
  /** Called with the whole text after each local change. */
  onChange: (text: string) => void
  /** Called after any update that may change what the toolbar shows. */
  onUpdate: (view: EditorView) => void
  /** More extensions, such as image loading and drop handling. */
  extensions?: Extension
}

/** Where the cursor starts: the end of the `\begin{document}` line, so focusing the editor does
 *  not unfold the preamble. */
function initialCursor(text: string): number {
  const at = text.search(/^[^%\n]*\\begin\s*\{document\}/m)
  if (at < 0) return 0
  const eol = text.indexOf('\n', at)
  return eol < 0 ? text.length : eol
}

/**
 * A CRLF document. CodeMirror then splits inserted text only at `\r\n`, so text pasted or
 * dropped with `\n` breaks would stay inside one line and be saved with mixed line breaks: each
 * lone `\n` or `\r` that lands inside a line becomes a line break too. Positions do not move,
 * since one character becomes one line break.
 */
export const crlfLineBreaks: Extension = [
  EditorState.lineSeparator.of('\r\n'),
  EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr
    const breaks: { from: number; to: number; insert: string }[] = []
    tr.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
      let pos = fromB
      for (let lines = inserted.iterLines(); !lines.next().done; ) {
        for (const m of lines.value.matchAll(/[\r\n]/g)) breaks.push({ from: pos + m.index, to: pos + m.index + 1, insert: '\r\n' })
        pos += lines.value.length + 1
      }
    })
    return breaks.length === 0 ? tr : [tr, { changes: breaks, sequential: true }]
  })
]

/**
 * The document as the editor holds it, split at any line break (`\r\n` counts as one position),
 * the line break it is saved with, and where the cursor starts.
 */
export function openingOf(text: string): { doc: Text; crlf: boolean; cursor: number } {
  const doc = Text.of(text.split(/\r\n?|\n/))
  // Found in the text as split, not in `text`, whose `\r\n` would count twice.
  return { doc, crlf: crlfOf(text) !== null, cursor: initialCursor(doc.toString()) }
}

export function createEditor(options: EditorOptions): EditorView {
  const { doc, crlf, cursor } = openingOf(options.text)
  return new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        // Keep a CRLF file CRLF: positions still count each line break as one character.
        crlf ? crlfLineBreaks : [],
        options.extensions ?? [],
        analysisField,
        focusTracking,
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        bracketMatching(),
        closeBrackets(),
        indentUnit.of('  '),
        EditorState.tabSize.of(2),
        EditorState.allowMultipleSelections.of(true),
        latex,
        EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{'] } }]),
        syntaxHighlighting(highlight),
        autocompletion({ override: latexCompletionSources, icons: false, activateOnTypingDelay: 60 }),
        search({ top: true }),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'LaTeX document' }),
        placeholder('Start writing LaTeX…'),
        formattingKeymap,
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab
        ]),
        modes.of(modeExtensions(options.mode)),
        boundaries.of(boundaryMarkers.of(options.boundaries)),
        editable.of(editableExtensions(options.readOnly)),
        EditorView.updateListener.of((update) => {
          const local = update.docChanged && !update.transactions.some((tr) => tr.annotation(fromOutside))
          if (local) options.onChange(update.state.sliceDoc())
          if (update.docChanged || update.selectionSet || update.focusChanged) options.onUpdate(update.view)
        })
      ]
    })
  })
}

export function setMode(view: EditorView, mode: Mode): void {
  view.dispatch({ effects: modes.reconfigure(modeExtensions(mode)) })
}

export function setBoundaries(view: EditorView, on: boolean): void {
  view.dispatch({ effects: boundaries.reconfigure(boundaryMarkers.of(on)) })
}

export function setReadOnly(view: EditorView, readOnly: boolean): void {
  view.dispatch({ effects: editable.reconfigure(editableExtensions(readOnly)) })
}

/**
 * Applies an outside version of the file, one change per run of changed lines, so the cursor,
 * the scroll position and the person's undo history stay with the text that did not change.
 * The change itself stays out of the undo history.
 */
export function replaceText(view: EditorView, text: string): void {
  const { state } = view
  // Diff in CodeMirror's own terms (`\n`, one position per line break), then write inserted
  // text with the document's line break.
  const changes = outsideChanges(state.doc.toString(), text.replace(/\r\n/g, '\n')).map((c) => ({
    ...c,
    insert: state.lineBreak === '\n' ? c.insert : c.insert.replace(/\n/g, state.lineBreak)
  }))
  if (changes.length === 0) return
  view.dispatch({
    changes,
    annotations: [fromOutside.of(true), Transaction.addToHistory.of(false)],
    userEvent: 'outside'
  })
}

export { redo, undo }
