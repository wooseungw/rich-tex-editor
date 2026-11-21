/**
 * Turns one LaTeX math region into a formula KaTeX accepts, with document-wide equation numbers.
 *
 * KaTeX numbers `equation`/`align`/`gather` itself, restarting at (1) in every render, and has no
 * `\label`, `multline`, `eqnarray` or `flalign`. So numbered environments become their starred
 * KaTeX counterparts with an explicit `\tag{n}` per numbered row (`n` from the caller's counter),
 * `\label`s are lifted out and reported with the tag of their row, and the unsupported
 * environments are mapped onto ones KaTeX renders.
 */

export interface MathRegion {
  /** null for `$..$`, `\(..\)`, `\[..\]`, `$$..$$`; otherwise the environment name incl. `*`. */
  env: string | null
  /** The text between the delimiters (or between `\begin{env}` and `\end{env}`). */
  body: string
  display: boolean
}

export interface PreparedMath {
  tex: string
  displayMode: boolean
  /** The tag shown on each tagged row/equation, in order: automatic numbers and explicit `\tag`s. */
  tags: string[]
  /** Every `\label` in the region, with the tag of its row (null when that row has none). */
  labels: Array<{ key: string; tag: string | null }>
}

/** Every environment `prepareMath` accepts (`math` is the inline one). */
export const DISPLAY_MATH_ENVS: ReadonlySet<string> = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'eqnarray',
  'eqnarray*',
  'flalign',
  'flalign*',
  'alignat',
  'alignat*',
  'xalignat',
  'xalignat*',
  'xxalignat',
  'dmath',
  'dmath*',
  'displaymath',
  'math'
])

type Kind = 'single' | 'rows'

interface EnvShape {
  kind: Kind
  numbered: boolean
  /** KaTeX environment the rows are emitted in (`rows` only). */
  target?: 'align*' | 'gather*' | 'alignat*'
  /** `multline`: one number, on the last row. */
  oneNumber?: boolean
  /** `eqnarray`: `a & = & b` rows, re-cut into align's `a &= b`. */
  eqnarray?: boolean
}

const SHAPES: Record<string, EnvShape> = {
  equation: { kind: 'single', numbered: true },
  dmath: { kind: 'single', numbered: true },
  displaymath: { kind: 'single', numbered: false },
  align: { kind: 'rows', numbered: true, target: 'align*' },
  flalign: { kind: 'rows', numbered: true, target: 'align*' },
  gather: { kind: 'rows', numbered: true, target: 'gather*' },
  multline: { kind: 'rows', numbered: true, target: 'gather*', oneNumber: true },
  eqnarray: { kind: 'rows', numbered: true, target: 'align*', eqnarray: true },
  alignat: { kind: 'rows', numbered: true, target: 'alignat*' },
  xalignat: { kind: 'rows', numbered: true, target: 'alignat*' },
  xxalignat: { kind: 'rows', numbered: false, target: 'alignat*' }
}

/** Removes `%` comments (keeping `\%` and the line breaks). */
export function stripMathComments(tex: string): string {
  if (tex.indexOf('%') === -1) return tex
  let out = ''
  let from = 0
  for (let i = 0; i < tex.length; i++) {
    const c = tex.charCodeAt(i)
    if (c === 92) {
      i++
    } else if (c === 37) {
      out += tex.slice(from, i)
      const nl = tex.indexOf('\n', i)
      if (nl === -1) return out
      from = nl
      i = nl - 1
    }
  }
  return out + tex.slice(from)
}

/** Index just past the `{..}` group opening at `open` (balanced, escape-aware), or -1. */
function groupEnd(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 92) i++
    else if (c === 123) depth++
    else if (c === 125) {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

interface Extracted {
  tex: string
  args: string[]
  starred: boolean[]
}

/**
 * Removes every `\name{arg}` / `\name*{arg}` (at any depth) and returns the arguments.
 * `keepGroup` keeps the argument's braces in place of the command (for `\shoveleft{x}`).
 */
function extractCommand(tex: string, name: string, keepGroup = false): Extracted {
  const needle = '\\' + name
  const result: Extracted = { tex, args: [], starred: [] }
  if (tex.indexOf(needle) === -1) return result
  let out = ''
  let from = 0
  let i = tex.indexOf(needle)
  while (i !== -1) {
    // Make sure `\` is not itself escaped and the name is complete.
    let backslashes = 0
    for (let k = i - 1; k >= 0 && tex.charCodeAt(k) === 92; k--) backslashes++
    const after = i + needle.length
    const next = tex.charCodeAt(after)
    const complete = !((next >= 65 && next <= 90) || (next >= 97 && next <= 122))
    if (backslashes % 2 === 0 && complete) {
      let j = after
      let star = false
      if (tex[j] === '*') {
        star = true
        j++
      }
      while (j < tex.length && /\s/.test(tex[j])) j++
      if (tex[j] === '{') {
        const end = groupEnd(tex, j)
        const close = end === -1 ? tex.length : end
        const inner = tex.slice(j + 1, end === -1 ? tex.length : end - 1)
        out += tex.slice(from, i) + (keepGroup ? '{' + inner + '}' : '')
        result.args.push(inner)
        result.starred.push(star)
        from = close
        i = tex.indexOf(needle, close)
        continue
      }
    }
    i = tex.indexOf(needle, after)
  }
  result.tex = out + tex.slice(from)
  return result
}

/** Removes argument-less commands such as `\nonumber`; reports whether any was present. */
function removeWords(tex: string, re: RegExp): { tex: string; found: boolean } {
  let found = false
  const out = tex.replace(re, () => {
    found = true
    return ''
  })
  return { tex: out, found }
}

const NONUMBER = /\\(?:nonumber|notag)(?![a-zA-Z])/g
const NOISE = /\\(?:qedhere|allowdisplaybreaks|displaybreak|nopagebreak|pagebreak|vadjust)(?![a-zA-Z])(?:\s*\[[^\]]*\])?/g

interface Row {
  tex: string
  labels: string[]
  tag: { text: string; star: boolean } | null
  nonumber: boolean
  /** An `\intertext` row: never numbered. */
  text?: boolean
}

function analyseRow(raw: string): Row {
  let tex = raw
  const labels = extractCommand(tex, 'label')
  tex = labels.tex
  const tags = extractCommand(tex, 'tag')
  tex = tags.tex
  const nonumber = removeWords(tex, NONUMBER)
  tex = nonumber.tex.replace(NOISE, '')
  tex = extractCommand(tex, 'shoveleft', true).tex
  tex = extractCommand(tex, 'shoveright', true).tex
  return {
    tex,
    labels: labels.args.map((k) => k.trim()).filter((k) => k.length > 0),
    tag: tags.args.length > 0 ? { text: tags.args[0], star: tags.starred[0] } : null,
    nonumber: nonumber.found
  }
}

/** Splits at top-level `\\` (outside braces and nested environments), dropping `[len]`/`*`. */
function splitRows(tex: string): string[] {
  const rows: string[] = []
  let depth = 0
  let envDepth = 0
  let from = 0
  for (let i = 0; i < tex.length; i++) {
    const c = tex.charCodeAt(i)
    if (c === 123) depth++
    else if (c === 125) depth = Math.max(0, depth - 1)
    else if (c === 92) {
      const n = tex.charCodeAt(i + 1)
      if (n === 92) {
        if (depth === 0 && envDepth === 0) {
          rows.push(tex.slice(from, i))
          let j = i + 2
          if (tex[j] === '*') j++
          if (tex[j] === '[') {
            const close = tex.indexOf(']', j)
            if (close !== -1) j = close + 1
          }
          from = j
          i = j - 1
        } else {
          i++
        }
      } else if ((n >= 65 && n <= 90) || (n >= 97 && n <= 122)) {
        let j = i + 1
        while (j < tex.length && /[a-zA-Z]/.test(tex[j])) j++
        const word = tex.slice(i + 1, j)
        if (word === 'begin') envDepth++
        else if (word === 'end') envDepth = Math.max(0, envDepth - 1)
        i = j - 1
      } else {
        i++
      }
    }
  }
  rows.push(tex.slice(from))
  return rows
}

/** Splits a row at top-level `&`. */
function splitCells(row: string): string[] {
  const cells: string[] = []
  let depth = 0
  let envDepth = 0
  let from = 0
  for (let i = 0; i < row.length; i++) {
    const c = row.charCodeAt(i)
    if (c === 123) depth++
    else if (c === 125) depth = Math.max(0, depth - 1)
    else if (c === 92) {
      let j = i + 1
      while (j < row.length && /[a-zA-Z]/.test(row[j])) j++
      const word = row.slice(i + 1, j)
      if (word === 'begin') envDepth++
      else if (word === 'end') envDepth = Math.max(0, envDepth - 1)
      i = j > i + 1 ? j - 1 : i + 1
    } else if (c === 38 && depth === 0 && envDepth === 0) {
      cells.push(row.slice(from, i))
      from = i + 1
    }
  }
  cells.push(row.slice(from))
  return cells
}

/** `\intertext{..}` ends the current row and puts a line of text between rows. */
function expandIntertext(rows: string[]): Array<{ raw: string; text: boolean }> {
  const out: Array<{ raw: string; text: boolean }> = []
  for (const raw of rows) {
    let rest = raw
    let m: RegExpExecArray | null
    while ((m = /\\(?:short)?intertext\s*\{/.exec(rest)) !== null) {
      const open = m.index + m[0].length - 1
      const end = groupEnd(rest, open)
      const before = rest.slice(0, m.index)
      const inner = rest.slice(open + 1, end === -1 ? rest.length : end - 1)
      if (before.trim()) out.push({ raw: before, text: false })
      out.push({ raw: `\\text{${inner}}`, text: true })
      rest = end === -1 ? '' : rest.slice(end)
    }
    out.push({ raw: rest, text: false })
  }
  return out
}

function tagCommand(tag: { text: string; star: boolean }): string {
  return `\\tag${tag.star ? '*' : ''}{${tag.text}}`
}

function prepareRows(
  body: string,
  shape: EnvShape,
  numbered: boolean,
  nextNumber: () => number
): PreparedMath {
  let text = body
  let columns = ''
  if (shape.target === 'alignat*') {
    const m = /^\s*\{([^{}]*)\}/.exec(text)
    if (m) {
      columns = m[1].trim()
      text = text.slice(m[0].length)
    }
  }
  const rows: Row[] = []
  for (const piece of expandIntertext(splitRows(text))) {
    const row = analyseRow(piece.raw)
    if (piece.text) row.text = true
    rows.push(row)
  }
  // A trailing `\\` leaves an empty last row: drop it (LaTeX would number it; nobody wants that).
  while (rows.length > 1) {
    const last = rows[rows.length - 1]
    if (last.tex.trim() || last.tag || last.labels.length) break
    rows.pop()
  }

  const tags: string[] = []
  const labels: PreparedMath['labels'] = []
  const rowTags: Array<string | null> = rows.map(() => null)
  const rowTagTex: string[] = rows.map(() => '')

  if (shape.oneNumber) {
    // multline: one number for the whole display, on its last row.
    const explicit = rows.find((r) => r.tag)?.tag ?? null
    const suppressed = rows.some((r) => r.nonumber)
    let tag: string | null = null
    let tagTex = ''
    if (explicit) {
      tag = explicit.text
      tagTex = tagCommand(explicit)
    } else if (numbered && !suppressed) {
      tag = String(nextNumber())
      tagTex = `\\tag{${tag}}`
    }
    if (tag !== null) tags.push(tag)
    rowTagTex[rows.length - 1] = tagTex
    for (const r of rows) for (const key of r.labels) labels.push({ key, tag })
  } else {
    rows.forEach((r, i) => {
      let tag: string | null = null
      if (r.tag) {
        tag = r.tag.text
        rowTagTex[i] = tagCommand(r.tag)
      } else if (numbered && !r.nonumber && !r.text && r.tex.trim()) {
        tag = String(nextNumber())
        rowTagTex[i] = `\\tag{${tag}}`
      }
      rowTags[i] = tag
      if (tag !== null) tags.push(tag)
      for (const key of r.labels) labels.push({ key, tag })
    })
  }

  const lines = rows.map((r, i) => {
    let tex = r.tex
    if (shape.eqnarray) {
      // `a & = & b` → `a &= b`: align's right/left pair with the relation leading the right side.
      const cells = splitCells(tex)
      if (cells.length >= 3) {
        const rest = cells.length > 3 ? '&' + cells.slice(3).join('&') : ''
        tex = `${cells[0].replace(/\s+$/, '')} &${cells[1].trim()} ${cells[2].replace(/^\s+/, '')}${rest}`
      }
    }
    const tag = rowTagTex[i]
    return tag ? `${tex.replace(/\s+$/, '')} ${tag}` : tex
  })

  if (shape.target === 'alignat*' && !/^\d+$/.test(columns)) {
    // KaTeX insists on the column-pair count; infer it from the widest row.
    let widest = 1
    for (const line of lines) widest = Math.max(widest, splitCells(line).length)
    columns = String(Math.max(1, Math.ceil(widest / 2)))
  }
  const target = shape.target ?? 'align*'
  const open = target === 'alignat*' ? `\\begin{alignat*}{${columns}}` : `\\begin{${target}}`
  return {
    tex: `${open}${lines.join('\\\\')}\\end{${target}}`,
    displayMode: true,
    tags,
    labels
  }
}

function prepareSingle(body: string, numbered: boolean, nextNumber: () => number): PreparedMath {
  const row = analyseRow(body)
  let tag: string | null = null
  let tagTex = ''
  if (row.tag) {
    tag = row.tag.text
    tagTex = tagCommand(row.tag)
  } else if (numbered && !row.nonumber) {
    tag = String(nextNumber())
    tagTex = `\\tag{${tag}}`
  }
  const tex = tagTex ? `${row.tex.replace(/\s+$/, '')} ${tagTex}` : row.tex
  return {
    tex,
    displayMode: true,
    tags: tag === null ? [] : [tag],
    labels: row.labels.map((key) => ({ key, tag }))
  }
}

function prepareInline(body: string): PreparedMath {
  const row = analyseRow(body)
  return {
    tex: row.tex,
    displayMode: false,
    tags: [],
    labels: row.labels.map((key) => ({ key, tag: null }))
  }
}

const WRAPPED_ENV = /^\s*\\begin\s*\{([a-zA-Z]+\*?)\}([\s\S]*)\\end\s*\{\1\}\s*$/

function prepare(region: MathRegion, nextNumber: () => number, depth: number): PreparedMath {
  const body = stripMathComments(typeof region.body === 'string' ? region.body : '')
  const env = region.env
  if (env === null) {
    if (!region.display) return prepareInline(body)
    // `$$\begin{align}..\end{align}$$`: number it like the bare environment would be.
    const wrapped = depth === 0 ? WRAPPED_ENV.exec(body) : null
    if (wrapped && DISPLAY_MATH_ENVS.has(wrapped[1]) && wrapped[1] !== 'math' && wrapped[1] !== 'displaymath') {
      return prepare({ env: wrapped[1], body: wrapped[2], display: true }, nextNumber, depth + 1)
    }
    return prepareSingle(body, false, nextNumber)
  }
  if (env === 'math') return prepareInline(body)
  const starred = env.endsWith('*')
  const base = starred ? env.slice(0, -1) : env
  const shape = SHAPES[base]
  if (!shape) {
    // Not ours: hand the environment to KaTeX as written (minus labels).
    const row = analyseRow(body)
    return {
      tex: `\\begin{${env}}${row.tex}\\end{${env}}`,
      displayMode: region.display,
      tags: [],
      labels: row.labels.map((key) => ({ key, tag: null }))
    }
  }
  const numbered = shape.numbered && !starred
  if (shape.kind === 'single') return prepareSingle(body, numbered, nextNumber)
  return prepareRows(body, shape, numbered, nextNumber)
}

export function prepareMath(region: MathRegion, nextNumber: () => number): PreparedMath {
  try {
    return prepare(region, nextNumber, 0)
  } catch {
    const body = typeof region?.body === 'string' ? region.body : ''
    return { tex: body, displayMode: Boolean(region?.display), tags: [], labels: [] }
  }
}
