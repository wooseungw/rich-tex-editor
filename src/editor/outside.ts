import { diffLines } from '../merge'

export interface TextChange {
  from: number
  to: number
  insert: string
}

/** Splits text into lines that keep their trailing `\n`, so joining them gives the text back. */
function lineUnits(text: string): string[] {
  const units = text.split('\n')
  return units.map((line, i) => (i < units.length - 1 ? `${line}\n` : line)).filter((u, i, all) => u !== '' || i < all.length - 1)
}

/**
 * The changes that turn `current` into `next`, one per run of changed lines (both `\n`-separated),
 * so text the outside write did not touch keeps its place: the cursor, the selection and the
 * person's undo history map through it untouched.
 */
export function outsideChanges(current: string, next: string): TextChange[] {
  if (current === next) return []
  const a = lineUnits(current)
  const b = lineUnits(next)
  const offsets = [0]
  for (const unit of a) offsets.push(offsets[offsets.length - 1] + unit.length)
  return diffLines(a, b).map((h) => ({
    from: offsets[h.aStart],
    to: offsets[h.aEnd],
    insert: b.slice(h.bStart, h.bEnd).join('')
  }))
}

/** `\r\n` when the file uses it throughout; otherwise null (CodeMirror's `\n` default). */
export function crlfOf(text: string): '\r\n' | null {
  return text.includes('\r\n') && !/(^|[^\r])\n/.test(text) ? '\r\n' : null
}
