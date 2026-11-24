import { snippet } from '@codemirror/autocomplete'
import { EditorSelection, type EditorState, type StateCommand, Text, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { FormatConstruct, HeadingConstruct } from '../latex/scan'
import { analysisField } from './analysis'


/** The innermost `\cmd{...}` whose argument holds `[from, to]`. */
export function formatAt(state: EditorState, cmd: string, from: number, to: number): FormatConstruct | null {
  let found: FormatConstruct | null = null
  for (const c of state.field(analysisField).scan.constructs) {
    if (c.from > from) break
    if (c.kind === 'format' && c.cmd === cmd && c.argFrom <= from && to <= c.argTo) found = c
  }
  return found
}

export function headingAt(state: EditorState, pos: number): HeadingConstruct | null {
  const line = state.doc.lineAt(pos)
  for (const c of state.field(analysisField).scan.constructs) {
    if (c.from > line.to) break
    if (c.kind === 'heading' && c.from >= line.from) return c
  }
  return null
}

/** Wraps each selection in `\cmd{...}`, or unwraps it when it already is. */
export function toggleFormat(cmd: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const open = `\\${cmd}{`
    const spec = state.changeByRange((range) => {
      const hit = formatAt(state, cmd, range.from, range.to)
      if (hit) {
        const shift = hit.argFrom - hit.from
        return {
          changes: [
            { from: hit.from, to: hit.argFrom },
            { from: hit.argTo, to: hit.to }
          ],
          range: EditorSelection.range(range.anchor - shift, range.head - shift)
        }
      }
      if (range.empty) {
        return { changes: { from: range.from, insert: `${open}}` }, range: EditorSelection.cursor(range.from + open.length) }
      }
      return {
        changes: [
          { from: range.from, insert: open },
          { from: range.to, insert: '}' }
        ],
        range: EditorSelection.range(range.anchor + open.length, range.head + open.length)
      }
    })
    dispatch(state.update(spec, { scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

export const HEADING_COMMANDS = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph'] as const

/** Turns the cursor's line into `\cmd{...}`, changes its heading level, or (null) back to text. */
export function setHeading(cmd: string | null): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const head = state.selection.main.head
    const line = state.doc.lineAt(head)
    const existing = headingAt(state, head)
    if (existing) {
      if (cmd === null || cmd === existing.cmd) {
        const shift = existing.argFrom - existing.from
        dispatch(
          state.update({
            changes: [
              { from: existing.from, to: existing.argFrom },
              { from: existing.argTo, to: existing.to }
            ],
            selection: { anchor: Math.max(existing.from, head - shift) },
            userEvent: 'input.format'
          })
        )
        return true
      }
      const nameFrom = existing.from + 1
      const nameTo = nameFrom + existing.cmd.length
      const delta = cmd.length - existing.cmd.length
      dispatch(
        state.update({
          changes: { from: nameFrom, to: nameTo, insert: cmd },
          selection: { anchor: Math.max(nameFrom, head + delta) },
          userEvent: 'input.format'
        })
      )
      return true
    }
    if (cmd === null) return false
    const text = line.text
    const indent = /^\s*/.exec(text)?.[0] ?? ''
    // A trailing `% comment` stays after the closing brace, or it would swallow it.
    const comment = /(^|[^\\])%/.exec(text.slice(indent.length))
    const bodyEnd = comment ? indent.length + comment.index + comment[1].length : text.length
    const body = text.slice(indent.length, bodyEnd).trimEnd()
    const open = `\\${cmd}{`
    dispatch(
      state.update({
        changes: { from: line.from + indent.length, to: line.from + indent.length + body.length, insert: `${open}${body}}` },
        selection: { anchor: line.from + indent.length + open.length + body.length },
        scrollIntoView: true,
        userEvent: 'input.format'
      })
    )
    return true
  }
}

/** Inserts a snippet with `#{field}` tab stops over the main selection. */
export function insertSnippet(view: EditorView, template: string): boolean {
  if (view.state.readOnly) return false
  const { from, to } = view.state.selection.main
  snippet(template)(view, null, from, to)
  view.focus()
  return true
}

/**
 * A template with its `#{field}`s replaced by their placeholder text and `#{selection}` by
 * `selection`, taken as it is (no snippet parsing, so backslashes, braces, `$` and indentation
 * in the person's text survive). Also answers where the first other field landed.
 */
export function fillTemplate(template: string, selection: string): { text: string; field: [number, number] | null } {
  let text = ''
  let field: [number, number] | null = null
  let at = 0
  for (const m of template.matchAll(/#\{([^{}]*)\}/g)) {
    text += template.slice(at, m.index)
    const value = m[1] === 'selection' ? selection : m[1]
    if (field === null && m[1] !== 'selection') field = [text.length, text.length + value.length]
    text += value
    at = m.index + m[0].length
  }
  return { text: text + template.slice(at), field }
}

/** Puts `block` on lines of its own at the cursor, replacing an empty line. */
export function insertBlock(view: EditorView, template: string): boolean {
  const { state } = view
  if (state.readOnly) return false
  const main = state.selection.main
  const line = state.doc.lineAt(main.head)
  const wraps = template.includes('#{selection}')
  if (main.empty || !wraps) {
    // Nothing of the person's goes through the snippet parser here.
    const filled = template.replace('#{selection}', () => '#{}')
    if (main.empty && line.text.trim() === '') {
      snippet(filled)(view, null, line.from, line.to)
    } else {
      // A block that does not wrap the selection goes after it, never over it.
      const end = state.doc.lineAt(main.to).to
      snippet(`\n${filled}`)(view, null, end, end)
    }
    view.focus()
    return true
  }
  view.dispatch(wrapSelection(state, template))
  view.focus()
  return true
}

/** Puts the main selection into `template` at `#{selection}`, on lines of its own, and selects
 *  the template's first other field (or puts the cursor after the block). */
export function wrapSelection(state: EditorState, template: string): TransactionSpec {
  const main = state.selection.main
  const lead = state.doc.lineAt(main.from)
  const tail = state.doc.lineAt(main.to)
  const before = lead.text.slice(0, main.from - lead.from).trim() !== '' ? '\n' : ''
  const after = tail.text.slice(main.to - tail.from).trim() !== '' ? '\n' : ''
  // Worked out with `\n` breaks, one position each as in the document, and inserted as lines,
  // so a CRLF document gets its own line breaks.
  const { text, field } = fillTemplate(template, state.doc.sliceString(main.from, main.to))
  const block = `${before}${text}${after}`
  const shift = (n: number) => main.from + before.length + n
  return {
    changes: { from: main.from, to: main.to, insert: Text.of(block.split('\n')) },
    selection: field ? { anchor: shift(field[0]), head: shift(field[1]) } : { anchor: main.from + block.length },
    userEvent: 'input.format',
    scrollIntoView: true
  }
}

/** Wraps the selected lines as list items, or starts a list with one empty item. */
export function insertList(view: EditorView, env: 'itemize' | 'enumerate'): boolean {
  const { state } = view
  if (state.readOnly) return false
  const main = state.selection.main
  if (!main.empty) {
    const first = state.doc.lineAt(main.from)
    const last = state.doc.lineAt(main.to)
    const selected = state.doc.sliceString(first.from, last.to)
    // Lines that hold environments of their own stay together as one item.
    const items = /\\(begin|end)\s*\{/.test(selected)
      ? `  \\item ${selected.trim()}`
      : selected
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => `  \\item ${l.trim().replace(/^\\item\s*/, '')}`)
          .join('\n')
    const insert = Text.of(`\\begin{${env}}\n${items}\n\\end{${env}}`.split('\n'))
    view.dispatch({
      changes: { from: first.from, to: last.to, insert },
      userEvent: 'input.format',
      scrollIntoView: true
    })
    view.focus()
    return true
  }
  return insertBlock(view, `\\begin{${env}}\n  \\item #{}\n\\end{${env}}`)
}

/** `$...$` around the selection, or an empty one to type into. */
export function insertInlineMath(view: EditorView): boolean {
  const { state } = view
  if (state.readOnly) return false
  const main = state.selection.main
  if (main.empty) return insertSnippet(view, '$#{}$')
  view.dispatch({
    changes: [
      { from: main.from, insert: '$' },
      { from: main.to, insert: '$' }
    ],
    selection: { anchor: main.from + 1, head: main.to + 1 },
    userEvent: 'input.format'
  })
  view.focus()
  return true
}

export function insertDisplayMath(view: EditorView): boolean {
  return insertBlock(view, '\\[\n  #{selection}\n\\]')
}

export function insertLink(view: EditorView): boolean {
  const { state } = view
  if (state.readOnly) return false
  const main = state.selection.main
  if (main.empty) return insertSnippet(view, '\\href{#{https://}}{#{text}}')
  // Wrap the selected text as it is and select the address to type over.
  const open = '\\href{https://}{'
  view.dispatch({
    changes: [
      { from: main.from, insert: open },
      { from: main.to, insert: '}' }
    ],
    selection: { anchor: main.from + 6, head: main.from + 6 + 'https://'.length },
    userEvent: 'input.format'
  })
  view.focus()
  return true
}
