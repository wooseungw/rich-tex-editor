/**
 * Line-based three-way merge for the document session. When the file changes outside the editor
 * (an agent, git, another editor) while the person has edits Orca has not accepted yet, Orca
 * hands us the common ancestor, the outside version and ours; we keep both sides' changes.
 *
 * Changes that touch different lines merge cleanly. Changes to the same lines keep both versions
 * between `%` comment markers, which TeX ignores, so the file still compiles and nothing is lost.
 */

/** `a[aStart, aEnd)` was replaced by `b[bStart, bEnd)`. */
export interface Hunk {
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
}

export const CONFLICT_OUTSIDE = '% <<<<<<< Rich TeX: this part changed outside the editor'
export const CONFLICT_MINE = '% ======= your unsaved edits'
export const CONFLICT_END = '% >>>>>>> end of merge conflict'

/** Past this many edits the diff stops looking and treats the changed middle as one hunk. */
const MAX_EDIT_DISTANCE = 2000

/** The hunks that turn `a` into `b`, in order and non-overlapping (Myers' O(ND) diff). */
export function diffLines(a: readonly string[], b: readonly string[]): Hunk[] {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }
  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  return myers(midA, midB).map((h) => ({
    aStart: h.aStart + prefix,
    aEnd: h.aEnd + prefix,
    bStart: h.bStart + prefix,
    bEnd: h.bEnd + prefix
  }))
}

function myers(a: readonly string[], b: readonly string[]): Hunk[] {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if (n === 0 || m === 0) return [{ aStart: 0, aEnd: n, bStart: 0, bEnd: m }]

  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d] holds v[-d..d] as it was when step d began, for walking the path back.
  const trace: Int32Array[] = []
  const limit = Math.min(max, MAX_EDIT_DISTANCE)

  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d, offset + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]
      } else {
        x = v[offset + k - 1] + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        return hunksFromMatches(backtrack(trace, d, n, m), n, m)
      }
    }
  }
  return [{ aStart: 0, aEnd: n, bStart: 0, bEnd: m }]
}

/** The matched (a, b) line pairs on the shortest edit path, in order. */
function backtrack(trace: Int32Array[], depth: number, n: number, m: number): Array<[number, number]> {
  const matches: Array<[number, number]> = []
  let x = n
  let y = m
  for (let d = depth; d > 0; d--) {
    const snap = trace[d]
    const at = (k: number) => snap[k + d]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      matches.push([x - 1, y - 1])
      x--
      y--
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    matches.push([x - 1, y - 1])
    x--
    y--
  }
  return matches.reverse()
}

function hunksFromMatches(matches: Array<[number, number]>, n: number, m: number): Hunk[] {
  const hunks: Hunk[] = []
  let a = 0
  let b = 0
  for (const [i, j] of matches) {
    if (i > a || j > b) hunks.push({ aStart: a, aEnd: i, bStart: b, bEnd: j })
    a = i + 1
    b = j + 1
  }
  if (a < n || b < m) hunks.push({ aStart: a, aEnd: n, bStart: b, bEnd: m })
  return hunks
}

/**
 * Whether `h` belongs to the group over base lines `[start, end)`. Hunks arrive sorted, so
 * `h.aStart >= start`: it overlaps when it starts inside the range, or at the same line (two
 * insertions at one point have no order, so they conflict too).
 */
function touches(start: number, end: number, h: Hunk): boolean {
  return h.aStart === start || h.aStart < end
}

/** One side's text for base lines `[start, end)`, given that side's hunks inside the range. */
function sideText(base: readonly string[], side: readonly string[], hunks: readonly Hunk[], start: number, end: number): string[] {
  const out: string[] = []
  let at = start
  for (const h of hunks) {
    for (let i = at; i < h.aStart; i++) out.push(base[i])
    for (let i = h.bStart; i < h.bEnd; i++) out.push(side[i])
    at = h.aEnd
  }
  for (let i = at; i < end; i++) out.push(base[i])
  return out
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i])
}

/** Merges `outside` and `mine`, both made from `base`. */
export function mergeText(base: string, outside: string, mine: string): string {
  if (mine === base || outside === mine) return outside
  if (outside === base) return mine

  const b = base.split('\n')
  const o = outside.split('\n')
  const m = mine.split('\n')
  const ho = diffLines(b, o)
  const hm = diffLines(b, m)

  const out: string[] = []
  let pos = 0
  let i = 0
  let j = 0
  while (i < ho.length || j < hm.length) {
    const takeOutside = j >= hm.length || (i < ho.length && ho[i].aStart <= hm[j].aStart)
    const first = takeOutside ? ho[i++] : hm[j++]
    const groupO: Hunk[] = takeOutside ? [first] : []
    const groupM: Hunk[] = takeOutside ? [] : [first]
    const start = first.aStart
    let end = first.aEnd
    let grew = true
    while (grew) {
      grew = false
      if (i < ho.length && touches(start, end, ho[i])) {
        end = Math.max(end, ho[i].aEnd)
        groupO.push(ho[i++])
        grew = true
      }
      if (j < hm.length && touches(start, end, hm[j])) {
        end = Math.max(end, hm[j].aEnd)
        groupM.push(hm[j++])
        grew = true
      }
    }

    for (let k = pos; k < start; k++) out.push(b[k])
    if (groupM.length === 0) {
      out.push(...sideText(b, o, groupO, start, end))
    } else if (groupO.length === 0) {
      out.push(...sideText(b, m, groupM, start, end))
    } else {
      const fromOutside = sideText(b, o, groupO, start, end)
      const fromMine = sideText(b, m, groupM, start, end)
      if (sameLines(fromOutside, fromMine)) {
        out.push(...fromOutside)
      } else {
        out.push(CONFLICT_OUTSIDE, ...fromOutside, CONFLICT_MINE, ...fromMine, CONFLICT_END)
      }
    }
    pos = end
  }
  for (let k = pos; k < b.length; k++) out.push(b[k])
  return out.join('\n')
}
