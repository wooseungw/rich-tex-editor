/**
 * A fast, forgiving scan of LaTeX source into the ranges the visual editor decorates: math,
 * headings, inline formatting, references, environments, list items, symbols and comments.
 *
 * It never throws and never reads past a construct it cannot close: an unterminated `$`, an
 * argument cut off by a blank line, or a `\begin{equation}` with no `\end` while the person is
 * still typing simply produce no construct, so the text shows as source until it is complete.
 * All offsets are UTF-16 indexes into the scanned text.
 */

import { matchBraces } from './macros'

export type FormatStyle =
  | 'bold'
  | 'italic'
  | 'emph'
  | 'underline'
  | 'strike'
  | 'mono'
  | 'smallcaps'
  | 'sans'
  | 'serif'
  | 'slanted'
  | 'upright'
  | 'super'
  | 'sub'
  | 'footnote'
  | 'link'
  | 'caption'
  | 'color'

interface Span {
  from: number
  to: number
}

export interface CommentConstruct extends Span {
  kind: 'comment'
}
export interface MathConstruct extends Span {
  kind: 'math'
  display: boolean
  /** The environment for `\begin{align}`-style math, `null` for `$`, `$$`, `\(` and `\[`. */
  env: string | null
  bodyFrom: number
  bodyTo: number
}
export interface HeadingConstruct extends Span {
  kind: 'heading'
  cmd: string
  level: number
  starred: boolean
  /** `1.2`, `A.1`; null when starred or below the numbering depth. */
  number: string | null
  argFrom: number
  argTo: number
}
export interface FormatConstruct extends Span {
  kind: 'format'
  cmd: string
  style: FormatStyle
  argFrom: number
  argTo: number
  /** `\href` and `\url` targets. */
  url?: string
  /** `\textcolor` colour (a name or `#rrggbb`). */
  color?: string
  /** `\caption`: `Figure 2`. `\footnote`: its number. */
  prefix?: string
}
export interface RefConstruct extends Span {
  kind: 'ref'
  cmd: string
  keys: string[]
}
export interface EnvConstruct extends Span {
  kind: 'env'
  name: string
  begin: boolean
  /** Optional argument text such as a theorem name or figure placement. */
  option: string | null
  /** Theorem-like environments: what LaTeX prints, `Theorem 2`, `Proof`. */
  heading?: string
}
export interface ItemConstruct extends Span {
  kind: 'item'
  list: ListKind
  depth: number
  /** What the item shows: `•`, `1.`, `(a)` or the `\item[label]` text. */
  marker: string
  custom: boolean
}
export interface SymbolConstruct extends Span {
  kind: 'symbol'
  text: string
}
export interface LogoConstruct extends Span {
  kind: 'logo'
  name: 'TeX' | 'LaTeX' | 'LaTeXe'
}
export interface ImageConstruct extends Span {
  kind: 'image'
  file: string
  /** `width=0.6\linewidth` as a fraction of the line, when the options say so. */
  width: number | null
}
export interface MakeTitleConstruct extends Span {
  kind: 'maketitle'
}
export interface VerbatimConstruct extends Span {
  kind: 'verbatim'
  /** The environment, or `null` for `\verb`. */
  env: string | null
  bodyFrom: number
  bodyTo: number
}

/** A `tabular`-like environment, from `\begin` to its `\end`, drawn as a table. */
export interface TableConstruct extends Span {
  kind: 'table'
  env: string
}
/** `\centering`, `\vspace{..}` and friends: page layout with nothing to show in the editor. */
export interface LayoutConstruct extends Span {
  kind: 'layout'
}
/** `\bibitem[label]{key}`, numbered in order. */
export interface BibitemConstruct extends Span {
  kind: 'bibitem'
  key: string
  number: number
  /** What citations of it print: `\bibitem[Kn84]{key}` gives `Kn84`, otherwise its number. */
  label: string
}

export type Construct =
  | TableConstruct
  | LayoutConstruct
  | BibitemConstruct
  | CommentConstruct
  | MathConstruct
  | HeadingConstruct
  | FormatConstruct
  | RefConstruct
  | EnvConstruct
  | ItemConstruct
  | SymbolConstruct
  | LogoConstruct
  | ImageConstruct
  | MakeTitleConstruct
  | VerbatimConstruct

export type ListKind = 'itemize' | 'enumerate' | 'description'

export type BlockStyle = 'abstract' | 'plain' | 'definition' | 'remark' | 'proof'

/** The body of an abstract or a theorem-like environment, for styling its lines. */
export interface BlockRange extends Span {
  name: string
  style: BlockStyle
}

export interface ListRange extends Span {
  list: ListKind
  depth: number
}

export interface LabelTarget {
  /** What `\ref` prints: `2.1`, `3`. */
  number: string
  kind: 'section' | 'figure' | 'table' | 'equation' | 'item' | 'theorem' | 'other'
}

export interface ScanResult {
  constructs: Construct[]
  /** Offset of `\begin{document}`, or null when the file has none (a fragment or an \input). */
  documentStart: number | null
  lists: ListRange[]
  /** Labels outside math; math labels are numbered by the math layer. */
  labels: Map<string, LabelTarget>
  /** `\bibitem` keys in order, for numbering citations. */
  bibitems: string[]
  title: string | null
  author: string | null
  date: string | null
  /** Folders from `\graphicspath{{a/}{b/}}`, as written. */
  graphicsPath: string[]
  blocks: BlockRange[]
}

export const HEADING_LEVELS: Readonly<Record<string, number>> = {
  part: -1,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5
}

export const MATH_ENVIRONMENTS: ReadonlySet<string> = new Set(
  [
    'equation',
    'align',
    'gather',
    'multline',
    'flalign',
    'alignat',
    'eqnarray',
    'displaymath',
    'math',
    'dmath',
    'IEEEeqnarray'
  ].flatMap((name) => [name, `${name}*`])
)

const VERBATIM_ENVIRONMENTS = new Set([
  'verbatim',
  'verbatim*',
  'Verbatim',
  'lstlisting',
  'minted',
  'comment',
  'filecontents',
  'filecontents*'
])

const FORMAT_COMMANDS: Readonly<Record<string, FormatStyle>> = {
  textbf: 'bold',
  textit: 'italic',
  emph: 'emph',
  underline: 'underline',
  uline: 'underline',
  sout: 'strike',
  st: 'strike',
  texttt: 'mono',
  textsc: 'smallcaps',
  textsf: 'sans',
  textrm: 'serif',
  textsl: 'slanted',
  textup: 'upright',
  textmd: 'upright',
  textnormal: 'upright',
  textsuperscript: 'super',
  textsubscript: 'sub',
  footnote: 'footnote',
  caption: 'caption'
}

const REF_COMMANDS = new Set([
  'ref',
  'eqref',
  'autoref',
  'Autoref',
  'cref',
  'Cref',
  'pageref',
  'nameref',
  'label',
  'cite',
  'citep',
  'citet',
  'citealp',
  'citeauthor',
  'citeyear',
  'parencite',
  'textcite',
  'autocite',
  'footcite',
  'nocite',
  'input',
  'include'
])

const SYMBOL_COMMANDS: Readonly<Record<string, string>> = {
  ldots: '…',
  dots: '…',
  textellipsis: '…',
  textbackslash: '\\',
  S: '§',
  P: '¶',
  copyright: '©',
  textcopyright: '©',
  textregistered: '®',
  texttrademark: '™',
  textdegree: '°',
  pounds: '£',
  textsterling: '£',
  euro: '€',
  texteuro: '€',
  textendash: '–',
  textemdash: '—',
  textbullet: '•',
  dag: '†',
  ddag: '‡',
  textdagger: '†',
  textdaggerdbl: '‡',
  ss: 'ß',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  aa: 'å',
  AA: 'Å',
  o: 'ø',
  O: 'Ø',
  l: 'ł',
  L: 'Ł',
  i: 'ı',
  j: 'ȷ',
  textquotedblleft: '“',
  textquotedblright: '”',
  textquoteleft: '‘',
  textquoteright: '’',
  textless: '<',
  textgreater: '>',
  textbar: '|',
  textasciitilde: '~',
  textasciicircum: '^',
  textunderscore: '_'
}

/** Accent commands and the combining mark each adds. */
const ACCENTS: Readonly<Record<string, string>> = {
  "'": '́',
  '`': '̀',
  '^': '̂',
  '"': '̈',
  '~': '̃',
  '=': '̄',
  '.': '̇',
  u: '̆',
  v: '̌',
  H: '̋',
  c: '̧',
  k: '̨',
  r: '̊',
  d: '̣',
  b: '̱'
}

const ESCAPED_CHARS = new Set(['%', '&', '$', '#', '_', '{', '}'])

const LIST_ENVIRONMENTS = new Set<string>(['itemize', 'enumerate', 'description'])

/** How many `{...}` arguments an environment's `\begin` takes after its options. */
const ENVIRONMENT_ARGUMENTS: Readonly<Record<string, number>> = {
  thebibliography: 1,
  minipage: 1,
  multicols: 1,
  'multicols*': 1,
  wrapfigure: 2,
  wraptable: 2,
  subfigure: 1,
  subtable: 1,
  tabular: 1,
  'tabular*': 2,
  tabularx: 2,
  tabulary: 2,
  longtable: 1,
  'longtable*': 1,
  description: 0
}

export const TABLE_ENVIRONMENTS: ReadonlySet<string> = new Set([
  'tabular',
  'tabular*',
  'tabularx',
  'tabulary',
  'longtable',
  'longtable*'
])

const LAYOUT_COMMANDS = new Set([
  'centering',
  'raggedright',
  'raggedleft',
  'noindent',
  'indent',
  'smallskip',
  'medskip',
  'bigskip',
  'vfill',
  'hfill',
  'newpage',
  'clearpage',
  'cleardoublepage',
  'pagebreak',
  'nopagebreak',
  'FloatBarrier',
  'vspace',
  'hspace',
  'addvspace'
])

interface TheoremKind {
  title: string
  style: BlockStyle
  /** The counter it numbers with (its own name, or the one it shares). */
  counter: string
  /** `section` or `chapter` when numbers restart there, as `\newtheorem{x}{X}[section]`. */
  within: string | null
  numbered: boolean
}

const DEFAULT_THEOREMS: Readonly<Record<string, [string, BlockStyle]>> = {
  theorem: ['Theorem', 'plain'],
  lemma: ['Lemma', 'plain'],
  proposition: ['Proposition', 'plain'],
  corollary: ['Corollary', 'plain'],
  conjecture: ['Conjecture', 'plain'],
  claim: ['Claim', 'plain'],
  definition: ['Definition', 'definition'],
  example: ['Example', 'definition'],
  exercise: ['Exercise', 'definition'],
  problem: ['Problem', 'definition'],
  remark: ['Remark', 'remark'],
  note: ['Note', 'remark']
}
const FLOAT_KIND: Readonly<Record<string, 'figure' | 'table'>> = {
  figure: 'figure',
  'figure*': 'figure',
  wrapfigure: 'figure',
  subfigure: 'figure',
  table: 'table',
  'table*': 'table',
  wraptable: 'table'
}

const isLetter = (c: string | undefined) =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '@')

const toRoman = (n: number) => {
  const table: Array<[number, string]> = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i']
  ]
  let out = ''
  for (const [value, digits] of table) {
    while (n >= value) {
      out += digits
      n -= value
    }
  }
  return out
}
const toLetter = (n: number) => {
  let out = ''
  while (n > 0) {
    n--
    out = String.fromCharCode(97 + (n % 26)) + out
    n = Math.floor(n / 26)
  }
  return out
}

export function enumerateMarker(depth: number, index: number): string {
  switch ((depth - 1) % 4) {
    case 0:
      return `${index}.`
    case 1:
      return `(${toLetter(index)})`
    case 2:
      return `${toRoman(index)}.`
    default:
      return `${toLetter(index).toUpperCase()}.`
  }
}

const BULLETS = ['•', '–', '∗', '·']

/** What `\today` prints: LaTeX's English default, `November 21, 2026`. */
export function todayText(date = new Date()): string {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

/** Strips commands and braces for short labels such as a title shown in a widget. */
export function plainText(source: string): string {
  return source
    .replace(/(^|[^\\])%.*$/gm, '$1')
    .replace(/\\\\(\[[^\]]*\])?/g, ' ')
    .replace(/\\(?:thanks|footnote|label)\{[^{}]*\}/g, '')
    .replace(/\\([%&$#_{}])/g, '$1')
    .replace(/~/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

interface Frame {
  name: string
  from: number
  /** For lists: their depth and how many items so far. */
  depth: number
  index: number
}

interface Group {
  from: number
  to: number
  innerFrom: number
  innerTo: number
}

class Scanner {
  readonly constructs: Construct[] = []
  readonly lists: ListRange[] = []
  readonly labels = new Map<string, LabelTarget>()
  readonly bibitems: string[] = []
  readonly stack: Frame[] = []
  /** The open list and float environments, innermost last (a subset of `stack`), so finding
   *  the nearest one does not walk a deep stack of other environments. */
  private readonly openLists: Frame[] = []
  private readonly openFloats: Frame[] = []
  documentStart: number | null = null
  title: string | null = null
  author: string | null = null
  date: string | null = null
  graphicsPath: string[] = []
  readonly blocks: BlockRange[] = []
  private readonly theorems = new Map<string, TheoremKind>()
  private theoremStyle: BlockStyle = 'plain'
  private readonly theoremCounters = new Map<string, number>()

  private readonly hasChapters: boolean
  private appendix = false
  private counters = { part: 0, chapter: 0, section: 0, subsection: 0, subsubsection: 0 }
  private floats = { figure: 0, table: 0 }
  private footnotes = 0
  private lastTarget: LabelTarget | null = null

  /** For each `{`, its matching `}` (or -1); see matchBraces. */
  private readonly closer: Int32Array
  /** parBefore[i]: how many paragraph breaks start before offset i. */
  private readonly parBefore: Int32Array
  /** The last search for each literal: where it started and what it found. */
  private readonly searches = new Map<string, { from: number; found: number }>()

  constructor(private readonly text: string) {
    this.hasChapters = /^[^%\n]*\\chapter\*?\s*[[{]/m.test(text)
    this.closer = matchBraces(text)
    this.parBefore = new Int32Array(text.length + 1)
    for (let i = 0; i < text.length; i++) {
      this.parBefore[i + 1] = this.parBefore[i] + (text.charCodeAt(i) === 10 && this.isParBreak(i) ? 1 : 0)
    }
  }

  /** Whether a paragraph break starts strictly between `from` and `to`. */
  private parBetween(from: number, to: number): boolean {
    return this.parBefore[to] - this.parBefore[from + 1] > 0
  }

  /**
   * `text.indexOf(needle, from)`, remembering the answer: scans that start later but not past
   * the last answer get the same one, so a file full of unclosed environments stays linear.
   */
  private indexFrom(needle: string, from: number): number {
    const memo = this.searches.get(needle)
    if (memo && from >= memo.from && (memo.found < 0 || from <= memo.found)) return memo.found
    const found = this.text.indexOf(needle, from)
    this.searches.set(needle, { from, found })
    return found
  }

  /** Whether `[at, at + n)` holds a blank line (a paragraph break). */
  private isParBreak(at: number): boolean {
    if (this.text[at] !== '\n') return false
    for (let i = at + 1; i < this.text.length; i++) {
      const c = this.text[i]
      if (c === '\n') return true
      if (c !== ' ' && c !== '\t' && c !== '\r') return false
    }
    return false
  }

  private skipSpaces(at: number, end: number): number {
    while (at < end && (this.text[at] === ' ' || this.text[at] === '\t')) at++
    return at
  }

  /** A `{...}` (or `[...]`) group starting at `at` after optional spaces, or null. */
  private readGroup(at: number, end: number, open = '{', close = '}', stopAtPar = true): Group | null {
    const start = this.skipSpaces(at, end)
    if (this.text[start] !== open) return null
    if (open === '{') {
      const close = this.closer[start]
      if (close < 0 || close >= end || (stopAtPar && this.parBetween(start, close))) return null
      return { from: start, to: close + 1, innerFrom: start + 1, innerTo: close }
    }
    // Optional arguments are short: look a little way only.
    const limit = Math.min(end, start + 4096)
    let depth = 0
    for (let i = start; i < limit; i++) {
      const c = this.text[i]
      if (c === '\\') {
        i++
        continue
      }
      if (c === '%') {
        const eol = this.text.indexOf('\n', i)
        if (eol < 0 || eol >= end) return null
        i = eol - 1
        continue
      }
      if (stopAtPar && c === '\n' && this.isParBreak(i)) return null
      if (open === '[') {
        if (c === '{') depth++
        else if (c === '}') depth--
        else if (c === ']' && depth === 0) return { from: start, to: i + 1, innerFrom: start + 1, innerTo: i }
        continue
      }
      if (c === open) depth++
      else if (c === close) {
        depth--
        if (depth === 0) return { from: start, to: i + 1, innerFrom: start + 1, innerTo: i }
      }
    }
    return null
  }

  /** Skips any number of `[...]` optional arguments; returns where they end. */
  private skipOptionals(at: number, end: number, max = 2): { end: number; first: Group | null } {
    let first: Group | null = null
    let pos = at
    for (let n = 0; n < max; n++) {
      const opt = this.readGroup(pos, end, '[', ']')
      if (!opt) break
      first ??= opt
      pos = opt.to
    }
    return { end: pos, first }
  }

  private findClosingDollar(at: number, end: number, double: boolean): number {
    for (let i = at; i < end; i++) {
      const c = this.text[i]
      if (c === '\\') {
        i++
        continue
      }
      if (c === '\n' && this.isParBreak(i)) return -1
      if (c === '$') {
        if (!double) return i
        if (this.text[i + 1] === '$') return i
        return -1
      }
    }
    return -1
  }

  private readonly delimiterSearches = new Map<string, { from: number; end: number; found: number; stop: number }>()

  /**
   * The `\)` or `\]` closing math opened just before `at`, within the paragraph. Remembers the
   * last search, so a paragraph full of unclosed `\(` is scanned once rather than once each.
   */
  private findClosingDelimiter(at: number, end: number, close: ')' | ']'): number {
    const memo = this.delimiterSearches.get(close)
    if (memo && memo.end === end && at >= memo.from && at <= (memo.found >= 0 ? memo.found : memo.stop)) return memo.found
    let found = -1
    let i = at
    for (; i < end; i++) {
      const c = this.text[i]
      if (c === '\n' && this.isParBreak(i)) break
      if (c === '\\') {
        if (this.text[i + 1] === close) {
          found = i
          break
        }
        i++
      }
    }
    this.delimiterSearches.set(close, { from: at, end, found, stop: i })
    return found
  }

  private findEnd(name: string, at: number, end: number): number {
    const needle = `\\end{${name}}`
    const found = this.indexFrom(needle, at)
    return found < 0 || found + needle.length > end ? -1 : found
  }

  private nearestList(): Frame | null {
    return this.openLists[this.openLists.length - 1] ?? null
  }

  private nearestFloat(): 'figure' | 'table' | null {
    const frame = this.openFloats[this.openFloats.length - 1]
    return frame ? FLOAT_KIND[frame.name] : null
  }

  private openFrame(frame: Frame): void {
    this.stack.push(frame)
    if (LIST_ENVIRONMENTS.has(frame.name)) this.openLists.push(frame)
    if (FLOAT_KIND[frame.name]) this.openFloats.push(frame)
  }

  /** Closes the stack from index `s` up; answers the closed frames, outermost first. */
  private closeFrames(s: number): Frame[] {
    const closed = this.stack.splice(s)
    for (const frame of closed) {
      if (this.openLists[this.openLists.length - 1] === frame) this.openLists.pop()
      if (this.openFloats[this.openFloats.length - 1] === frame) this.openFloats.pop()
    }
    return closed
  }

  private headingNumber(cmd: string): string | null {
    const c = this.counters
    const letter = (n: number) => String.fromCharCode(64 + Math.min(Math.max(n, 1), 26))
    switch (cmd) {
      case 'part':
        c.part++
        return toRoman(c.part).toUpperCase()
      case 'chapter':
        c.chapter++
        c.section = c.subsection = c.subsubsection = 0
        this.floats.figure = this.floats.table = 0
        return this.appendix ? letter(c.chapter) : String(c.chapter)
      case 'section': {
        c.section++
        c.subsection = c.subsubsection = 0
        if (this.hasChapters) return `${this.appendix ? letter(c.chapter) : c.chapter}.${c.section}`
        return this.appendix ? letter(c.section) : String(c.section)
      }
      case 'subsection':
        c.subsection++
        c.subsubsection = 0
        return `${this.sectionPrefix()}.${c.subsection}`
      case 'subsubsection':
        c.subsubsection++
        return `${this.sectionPrefix()}.${c.subsection}.${c.subsubsection}`
      default:
        return null
    }
  }

  private sectionPrefix(): string {
    const c = this.counters
    const letter = (n: number) => String.fromCharCode(64 + Math.min(Math.max(n, 1), 26))
    if (this.hasChapters) return `${this.appendix ? letter(c.chapter) : c.chapter}.${c.section}`
    return this.appendix ? letter(c.section) : String(c.section)
  }

  run(): void {
    this.scanRange(0, this.text.length)
    // Lists still open at the end run to the end of the file.
    for (const frame of this.stack) {
      if (LIST_ENVIRONMENTS.has(frame.name)) {
        this.lists.push({ from: frame.from, to: this.text.length, list: frame.name as ListKind, depth: frame.depth })
      }
    }
    this.constructs.sort((a, b) => a.from - b.from || b.to - a.to)
  }

  private scanRange(from: number, to: number): void {
    const text = this.text
    let i = from
    while (i < to) {
      const c = text[i]
      if (c === '%') {
        let eol = text.indexOf('\n', i)
        if (eol < 0 || eol > to) eol = to
        this.constructs.push({ kind: 'comment', from: i, to: eol })
        i = eol
      } else if (c === '\\') {
        i = this.command(i, to)
      } else if (c === '$') {
        i = this.dollar(i, to)
      } else if (c === '-' && text[i + 1] === '-') {
        const em = text[i + 2] === '-'
        const len = em ? 3 : 2
        this.constructs.push({ kind: 'symbol', from: i, to: i + len, text: em ? '—' : '–' })
        i += len
      } else if (c === '~') {
        // A tie: a space the line never breaks at.
        this.constructs.push({ kind: 'symbol', from: i, to: i + 1, text: '\u00a0' })
        i++
      } else if (c === '`') {
        const double = text[i + 1] === '`'
        this.constructs.push({ kind: 'symbol', from: i, to: i + (double ? 2 : 1), text: double ? '“' : '‘' })
        i += double ? 2 : 1
      } else if (c === "'" && text[i + 1] === "'") {
        this.constructs.push({ kind: 'symbol', from: i, to: i + 2, text: '”' })
        i += 2
      } else {
        i++
      }
    }
  }

  private dollar(at: number, end: number): number {
    const text = this.text
    const double = text[at + 1] === '$'
    const open = double ? 2 : 1
    const close = this.findClosingDollar(at + open, end, double)
    if (close < 0 || close === at + open) return at + open
    const to = close + open
    this.constructs.push({
      kind: 'math',
      from: at,
      to,
      display: double,
      env: null,
      bodyFrom: at + open,
      bodyTo: close
    })
    return to
  }

  /** Handles the command at `at` (a backslash); returns where scanning resumes. */
  private command(at: number, end: number): number {
    const text = this.text
    const next = text[at + 1]
    if (next === undefined || at + 1 >= end) return at + 1

    if (!isLetter(next)) {
      if (next === '(' || next === '[') {
        const closer = next === '(' ? ')' : ']'
        const close = this.findClosingDelimiter(at + 2, end, closer)
        if (close < 0) return at + 2
        this.constructs.push({
          kind: 'math',
          from: at,
          to: close + 2,
          display: next === '[',
          env: null,
          bodyFrom: at + 2,
          bodyTo: close
        })
        return close + 2
      }
      if (ESCAPED_CHARS.has(next)) {
        this.constructs.push({ kind: 'symbol', from: at, to: at + 2, text: next })
        return at + 2
      }
      if (ACCENTS[next] !== undefined) return this.accent(at, next, at + 2, end)
      // `\\`, `\,`, `\ ` and friends: leave them as source.
      return at + 2
    }

    let nameEnd = at + 1
    while (nameEnd < end && isLetter(text[nameEnd])) nameEnd++
    const name = text.slice(at + 1, nameEnd)
    let pos = nameEnd

    if (name === 'begin' || name === 'end') return this.environment(at, pos, end, name === 'begin')

    if (name in HEADING_LEVELS) {
      const starred = text[pos] === '*'
      if (starred) pos++
      const { end: afterOpt } = this.skipOptionals(pos, end, 1)
      const arg = this.readGroup(afterOpt, end)
      if (!arg) return pos
      const number = starred ? null : this.headingNumber(name)
      this.constructs.push({
        kind: 'heading',
        from: at,
        to: arg.to,
        cmd: name,
        level: HEADING_LEVELS[name],
        starred,
        number,
        argFrom: arg.innerFrom,
        argTo: arg.innerTo
      })
      if (number) this.lastTarget = { number, kind: 'section' }
      if (!starred) {
        for (const kind of this.theorems.values()) {
          if (kind.within === name) this.theoremCounters.set(kind.counter, 0)
        }
      }
      this.scanRange(arg.innerFrom, arg.innerTo)
      return arg.to
    }

    const style = FORMAT_COMMANDS[name]
    if (style) {
      const { end: afterOpt } = this.skipOptionals(pos, end, 1)
      const arg = this.readGroup(afterOpt, end)
      if (!arg) return pos
      const construct: FormatConstruct = {
        kind: 'format',
        from: at,
        to: arg.to,
        cmd: name,
        style,
        argFrom: arg.innerFrom,
        argTo: arg.innerTo
      }
      if (style === 'footnote') {
        this.footnotes++
        construct.prefix = String(this.footnotes)
      } else if (style === 'caption') {
        const kind = this.nearestFloat()
        if (kind) {
          this.floats[kind]++
          const number = this.hasChapters && this.counters.chapter > 0
            ? `${this.counters.chapter}.${this.floats[kind]}`
            : String(this.floats[kind])
          construct.prefix = `${kind === 'figure' ? 'Figure' : 'Table'} ${number}`
          this.lastTarget = { number, kind }
        }
      }
      this.constructs.push(construct)
      this.scanRange(arg.innerFrom, arg.innerTo)
      return arg.to
    }

    if (name === 'href') {
      const url = this.readGroup(pos, end)
      const label = url && this.readGroup(url.to, end)
      if (!url || !label) return pos
      this.constructs.push({
        kind: 'format',
        from: at,
        to: label.to,
        cmd: name,
        style: 'link',
        argFrom: label.innerFrom,
        argTo: label.innerTo,
        url: text.slice(url.innerFrom, url.innerTo).trim()
      })
      this.scanRange(label.innerFrom, label.innerTo)
      return label.to
    }

    if (name === 'url' || name === 'nolinkurl') {
      const arg = this.readGroup(pos, end)
      if (!arg) return pos
      this.constructs.push({
        kind: 'format',
        from: at,
        to: arg.to,
        cmd: name,
        style: 'link',
        argFrom: arg.innerFrom,
        argTo: arg.innerTo,
        url: text.slice(arg.innerFrom, arg.innerTo).trim()
      })
      return arg.to
    }

    if (name === 'textcolor') {
      const color = this.readGroup(pos, end)
      const body = color && this.readGroup(color.to, end)
      if (!color || !body) return pos
      const value = text.slice(color.innerFrom, color.innerTo).trim()
      const construct: FormatConstruct = {
        kind: 'format',
        from: at,
        to: body.to,
        cmd: name,
        style: 'color',
        argFrom: body.innerFrom,
        argTo: body.innerTo
      }
      if (/^[a-zA-Z]+$/.test(value) || /^#[0-9a-fA-F]{6}$/.test(value)) construct.color = value
      this.constructs.push(construct)
      this.scanRange(body.innerFrom, body.innerTo)
      return body.to
    }

    if (REF_COMMANDS.has(name)) {
      if (text[pos] === '*') pos++
      const { end: afterOpt } = this.skipOptionals(pos, end, 2)
      const arg = this.readGroup(afterOpt, end)
      if (!arg) return pos
      const keys = text
        .slice(arg.innerFrom, arg.innerTo)
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
      this.constructs.push({ kind: 'ref', from: at, to: arg.to, cmd: name, keys })
      if (name === 'label' && keys[0] && this.lastTarget) this.labels.set(keys[0], this.lastTarget)
      return arg.to
    }

    if (name === 'item') {
      const list = this.nearestList()
      const opt = this.readGroup(pos, end, '[', ']')
      const kind = (list?.name as ListKind | undefined) ?? 'itemize'
      const depth = list?.depth ?? 1
      let marker: string
      let custom = false
      if (opt) {
        marker = plainText(text.slice(opt.innerFrom, opt.innerTo))
        custom = true
      } else if (kind === 'enumerate' && list) {
        list.index++
        marker = enumerateMarker(depth, list.index)
        this.lastTarget = { number: marker.replace(/[.()]/g, ''), kind: 'item' }
      } else if (kind === 'description') {
        marker = ''
      } else {
        marker = BULLETS[(depth - 1) % BULLETS.length]
      }
      const to = opt ? opt.to : pos
      this.constructs.push({ kind: 'item', from: at, to, list: kind, depth, marker, custom })
      return to
    }

    if (name === 'bibitem') {
      const { end: afterOpt, first } = this.skipOptionals(pos, end, 1)
      const arg = this.readGroup(afterOpt, end)
      if (!arg) return pos
      const key = text.slice(arg.innerFrom, arg.innerTo).trim()
      this.bibitems.push(key)
      const number = this.bibitems.length
      const custom = first ? plainText(text.slice(first.innerFrom, first.innerTo)) : ''
      this.constructs.push({ kind: 'bibitem', from: at, to: arg.to, key, number, label: custom || String(number) })
      return arg.to
    }

    if (name === 'graphicspath') {
      const arg = this.readGroup(pos, end)
      if (!arg) return pos
      for (const m of text.slice(arg.innerFrom, arg.innerTo).matchAll(/\{([^{}]*)\}/g)) {
        if (m[1].trim()) this.graphicsPath.push(m[1].trim())
      }
      return arg.to
    }

    if (name === 'theoremstyle') {
      const arg = this.readGroup(pos, end)
      if (!arg) return pos
      const style = text.slice(arg.innerFrom, arg.innerTo).trim()
      this.theoremStyle = style === 'definition' ? 'definition' : style === 'remark' ? 'remark' : 'plain'
      return arg.to
    }

    if (name === 'newtheorem') {
      const starred = text[pos] === '*'
      if (starred) pos++
      const env = this.readGroup(pos, end)
      if (!env) return pos
      const shared = this.readGroup(env.to, end, '[', ']')
      const title = this.readGroup(shared ? shared.to : env.to, end)
      if (!title) return env.to
      const within = shared ? null : this.readGroup(title.to, end, '[', ']')
      const envName = text.slice(env.innerFrom, env.innerTo).trim()
      this.theorems.set(envName, {
        title: plainText(text.slice(title.innerFrom, title.innerTo)),
        style: this.theoremStyle,
        counter: shared ? text.slice(shared.innerFrom, shared.innerTo).trim() : envName,
        within: within ? text.slice(within.innerFrom, within.innerTo).trim() : null,
        numbered: !starred
      })
      return (within ?? title).to
    }

    if (LAYOUT_COMMANDS.has(name)) {
      let to = pos
      if (text[to] === '*') to++
      if (name === 'vspace' || name === 'hspace' || name === 'addvspace') {
        const arg = this.readGroup(to, end)
        if (!arg) return pos
        to = arg.to
      }
      this.constructs.push({ kind: 'layout', from: at, to })
      return to
    }

    if (name === 'includegraphics') {
      if (text[pos] === '*') pos++
      const { end: afterOpt, first } = this.skipOptionals(pos, end, 2)
      const arg = this.readGroup(afterOpt, end)
      if (!arg) return pos
      const options = first ? text.slice(first.innerFrom, first.innerTo) : ''
      const m = /(?:^|,)\s*width\s*=\s*([0-9]*\.?[0-9]+)\s*\\(?:line|text|column)width/.exec(options)
      const width = m ? Math.min(1, Math.max(0.05, Number(m[1]))) : null
      this.constructs.push({ kind: 'image', from: at, to: arg.to, file: text.slice(arg.innerFrom, arg.innerTo).trim(), width })
      return arg.to
    }

    if (name === 'title' || name === 'author' || name === 'date') {
      const { end: afterOpt } = this.skipOptionals(pos, end, 1)
      const arg = this.readGroup(afterOpt, end, '{', '}', false)
      if (!arg) return pos
      this[name] = text.slice(arg.innerFrom, arg.innerTo)
      this.scanRange(arg.innerFrom, arg.innerTo)
      return arg.to
    }

    if (name === 'maketitle') {
      this.constructs.push({ kind: 'maketitle', from: at, to: pos })
      return pos
    }

    if (name === 'appendix') {
      this.appendix = true
      if (this.hasChapters) this.counters.chapter = 0
      else this.counters.section = 0
      return pos
    }

    if (name === 'TeX' || name === 'LaTeX' || name === 'LaTeXe') {
      this.constructs.push({ kind: 'logo', from: at, to: pos, name })
      return pos
    }

    if (name === 'today') {
      this.constructs.push({ kind: 'symbol', from: at, to: pos, text: todayText() })
      return pos
    }

    if (name === 'verb') {
      let open = pos
      if (text[open] === '*') open++
      const delim = text[open]
      if (!delim || delim === ' ' || delim === '\n' || isLetter(delim)) return pos
      const close = text.indexOf(delim, open + 1)
      const eol = text.indexOf('\n', open + 1)
      if (close < 0 || close >= end || (eol >= 0 && eol < close)) return pos
      this.constructs.push({ kind: 'verbatim', from: at, to: close + 1, env: null, bodyFrom: open + 1, bodyTo: close })
      return close + 1
    }

    if (ACCENTS[name] !== undefined && name.length === 1) return this.accent(at, name, pos, end)

    const symbol = SYMBOL_COMMANDS[name]
    if (symbol !== undefined) {
      // `\o` and friends are only symbols when the name ends there (`\oe` is its own command).
      let to = pos
      if (text[to] === '{' && text[to + 1] === '}') to += 2
      this.constructs.push({ kind: 'symbol', from: at, to, text: symbol })
      return to
    }

    return pos
  }

  /** `\'e`, `\'{e}`, `\c{c}`, `\"\i`. */
  private accent(at: number, accent: string, pos: number, end: number): number {
    const text = this.text
    const mark = ACCENTS[accent]
    let base: string | null = null
    let to = pos
    const group = this.readGroup(pos, end)
    const letterAccent = isLetter(accent)
    if (group) {
      const inner = text.slice(group.innerFrom, group.innerTo).trim()
      base = inner === '\\i' ? 'ı' : inner === '\\j' ? 'ȷ' : inner
      to = group.to
    } else if (!letterAccent && /[a-zA-Z]/.test(text[pos] ?? '')) {
      base = text[pos]
      to = pos + 1
    } else if (letterAccent && text[pos] === ' ' && /[a-zA-Z]/.test(text[pos + 1] ?? '')) {
      base = text[pos + 1]
      to = pos + 2
    }
    if (!base || base.length !== 1 || to > end) return pos
    this.constructs.push({ kind: 'symbol', from: at, to, text: (base + mark).normalize('NFC') })
    return to
  }

  private theoremKind(name: string): TheoremKind | null {
    const declared = this.theorems.get(name) ?? this.theorems.get(name.replace(/\*$/, ''))
    if (declared) return name.endsWith('*') ? { ...declared, numbered: false } : declared
    const base = name.replace(/\*$/, '')
    const fallback = DEFAULT_THEOREMS[base]
    if (!fallback) return null
    return { title: fallback[0], style: fallback[1], counter: base, within: null, numbered: !name.endsWith('*') }
  }

  /** `Theorem 2`, `Lemma 1.3`, `Proof`; null for other environments. */
  private theoremHeading(name: string): string | null {
    if (name === 'proof') return 'Proof'
    const kind = this.theoremKind(name)
    if (!kind) return null
    if (!kind.numbered) return kind.title
    const n = (this.theoremCounters.get(kind.counter) ?? 0) + 1
    this.theoremCounters.set(kind.counter, n)
    const prefix = kind.within === 'section' ? this.sectionPrefix() : kind.within === 'chapter' ? String(this.counters.chapter) : null
    const number = prefix ? `${prefix}.${n}` : String(n)
    this.lastTarget = { number, kind: 'theorem' }
    return `${kind.title} ${number}`
  }

  private blockStyle(name: string): BlockStyle | null {
    if (name === 'abstract') return 'abstract'
    if (name === 'proof') return 'proof'
    return this.theoremKind(name)?.style ?? null
  }

  /** The offset just past `\end{name}` that closes the `\begin{name}` before `at`, counting nesting. */
  private findMatchingEnd(name: string, at: number, end: number): number {
    const open = `\\begin{${name}}`
    const close = `\\end{${name}}`
    let depth = 1
    let pos = at
    while (pos < end) {
      const nextClose = this.indexFrom(close, pos)
      if (nextClose < 0 || nextClose >= end) return -1
      const nextOpen = this.indexFrom(open, pos)
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth++
        pos = nextOpen + open.length
        continue
      }
      depth--
      pos = nextClose + close.length
      if (depth === 0) return pos
    }
    return -1
  }

  private environment(at: number, pos: number, end: number, begin: boolean): number {
    const text = this.text
    const arg = this.readGroup(pos, end)
    if (!arg) return pos
    const name = text.slice(arg.innerFrom, arg.innerTo).trim()
    if (!/^[a-zA-Z@*]+$/.test(name)) return arg.to

    if (begin && MATH_ENVIRONMENTS.has(name)) {
      const close = this.findEnd(name, arg.to, end)
      if (close >= 0) {
        const to = close + `\\end{${name}}`.length
        this.constructs.push({
          kind: 'math',
          from: at,
          to,
          display: name !== 'math' && name !== 'math*',
          env: name,
          bodyFrom: arg.to,
          bodyTo: close
        })
        return to
      }
    }

    if (begin && VERBATIM_ENVIRONMENTS.has(name)) {
      const close = this.findEnd(name, arg.to, end)
      if (close >= 0) {
        const to = close + `\\end{${name}}`.length
        let bodyFrom = arg.to
        if (name === 'minted') bodyFrom = this.readGroup(this.skipOptionals(bodyFrom, close, 1).end, close)?.to ?? bodyFrom
        else if (name === 'lstlisting' || name === 'Verbatim') bodyFrom = this.skipOptionals(bodyFrom, close, 1).end
        this.constructs.push(
          name === 'comment'
            ? { kind: 'comment', from: at, to }
            : { kind: 'verbatim', from: at, to, env: name, bodyFrom, bodyTo: close }
        )
        return to
      }
    }

    if (begin && TABLE_ENVIRONMENTS.has(name)) {
      const close = this.findMatchingEnd(name, arg.to, end)
      if (close >= 0) this.constructs.push({ kind: 'table', from: at, to: close, env: name })
    }

    let to = arg.to
    let option: string | null = null
    if (begin) {
      const opt = this.readGroup(to, end, '[', ']')
      if (opt) {
        option = plainText(text.slice(opt.innerFrom, opt.innerTo))
        to = opt.to
      }
      // Arguments that belong to the environment's opening, such as `{9}` or `{0.5\linewidth}`.
      for (let n = ENVIRONMENT_ARGUMENTS[name] ?? 0; n > 0; n--) {
        const group = this.readGroup(to, end)
        if (!group) break
        to = group.to
      }
    }
    const construct: EnvConstruct = { kind: 'env', from: at, to, name, begin, option }
    if (begin) {
      const heading = this.theoremHeading(name)
      if (heading) construct.heading = heading
    }
    this.constructs.push(construct)

    if (begin) {
      if (name === 'document' && this.documentStart === null) this.documentStart = at
      const parent = this.nearestList()
      const depth = LIST_ENVIRONMENTS.has(name) ? (parent?.depth ?? 0) + 1 : 0
      this.openFrame({ name, from: at, depth, index: 0 })
    } else {
      // Close the nearest matching environment, and anything left open inside it.
      for (let s = this.stack.length - 1; s >= 0; s--) {
        if (this.stack[s].name !== name) continue
        for (const frame of this.closeFrames(s)) {
          if (LIST_ENVIRONMENTS.has(frame.name)) {
            this.lists.push({ from: frame.from, to, list: frame.name as ListKind, depth: frame.depth })
          }
          const style = this.blockStyle(frame.name)
          if (style) this.blocks.push({ from: frame.from, to, name: frame.name, style })
        }
        break
      }
    }
    return to
  }
}

export function scan(text: string): ScanResult {
  const scanner = new Scanner(text)
  scanner.run()
  scanner.lists.sort((a, b) => a.from - b.from)
  return {
    constructs: scanner.constructs,
    documentStart: scanner.documentStart,
    lists: scanner.lists,
    labels: scanner.labels,
    bibitems: scanner.bibitems,
    title: scanner.title,
    author: scanner.author,
    date: scanner.date,
    graphicsPath: scanner.graphicsPath,
    blocks: scanner.blocks.sort((a, b) => a.from - b.from)
  }
}
