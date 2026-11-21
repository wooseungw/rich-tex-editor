/**
 * Collects the user's macro definitions from a LaTeX source in the shape KaTeX's `macros`
 * option takes: `{ '\\R': '\\mathbb{R}', '\\norm': '\\left\\|#1\\right\\|' }`.
 *
 * KaTeX infers a macro's arity from the highest `#n` in its body, so only the body is kept.
 * Optional-argument defaults (`\newcommand{\x}[2][d]{..}`) have no KaTeX equivalent and are
 * dropped. The scan never throws: whatever was collected before a malformed definition is kept.
 */
export type MacroMap = Record<string, string>

const BACKSLASH = 92
const PERCENT = 37
const LBRACE = 123
const RBRACE = 125
const LBRACKET = 91
const RBRACKET = 93
const NEWLINE = 10

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 64 // @

const DEFINERS = new Set([
  'newcommand',
  'renewcommand',
  'providecommand',
  'DeclareRobustCommand',
  'def',
  'gdef',
  'edef',
  'xdef',
  'let',
  'DeclareMathOperator',
  'NewDocumentCommand',
  'RenewDocumentCommand',
  'ProvideDocumentCommand',
  'DeclareDocumentCommand'
])

class MacroScanner {
  pos = 0
  readonly macros: MacroMap = {}

  /** For each `{`, the offset of its matching `}` (or -1), found in one pass, so an unclosed
   *  brace costs one lookup instead of a scan to the end of the file. */
  private readonly closer: Int32Array

  constructor(private readonly s: string) {
    this.closer = matchBraces(s)
  }

  run(): void {
    const s = this.s
    const n = s.length
    let p = -1
    while (this.pos < n) {
      const i = s.indexOf('\\', this.pos)
      if (p !== Infinity && p < this.pos) {
        p = s.indexOf('%', this.pos)
        if (p === -1) p = Infinity
      }
      if (p !== Infinity && (i === -1 || p < i)) {
        // An unescaped `%` (escaped ones are consumed with their backslash below).
        this.pos = this.lineEnd(p)
        continue
      }
      if (i === -1) return
      const name = this.controlSequence(i)
      this.pos = i + 1 + name.length
      if (name.length > 0 && DEFINERS.has(name)) {
        const start = this.pos
        try {
          this.definition(name)
        } catch {
          // Malformed definition: skip it.
        }
        if (this.pos <= start) this.pos = start
      } else if (name.length === 0) {
        this.pos = i + 1
      }
    }
  }

  /** Name of the control sequence whose backslash is at `i` (letters, or one other character). */
  private controlSequence(i: number): string {
    const s = this.s
    let j = i + 1
    if (j >= s.length) return ''
    if (!isLetter(s.charCodeAt(j))) return s[j]
    while (j < s.length && isLetter(s.charCodeAt(j))) j++
    return s.slice(i + 1, j)
  }

  private lineEnd(p: number): number {
    const nl = this.s.indexOf('\n', p)
    return nl === -1 ? this.s.length : nl + 1
  }

  private skipSpace(): void {
    const s = this.s
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos)
      if (c === 32 || c === 9 || c === 13 || c === NEWLINE) this.pos++
      else if (c === PERCENT) this.pos = this.lineEnd(this.pos)
      else break
    }
  }

  private star(): boolean {
    this.skipSpace()
    if (this.s[this.pos] === '*') {
      this.pos++
      return true
    }
    return false
  }

  /** Content of a balanced `{..}` group at the cursor (comments removed), or null. */
  private group(): string | null {
    this.skipSpace()
    const s = this.s
    if (s.charCodeAt(this.pos) !== LBRACE) return null
    if (this.closer[this.pos] < 0) {
      // Unbalanced: not a usable definition; keep scanning right after the brace.
      this.pos += 1
      return null
    }
    let depth = 0
    let out = ''
    let from = this.pos + 1
    let i = this.pos
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c === BACKSLASH) {
        i++
      } else if (c === LBRACE) {
        depth++
      } else if (c === RBRACE) {
        depth--
        if (depth === 0) {
          out += s.slice(from, i)
          this.pos = i + 1
          return out
        }
      } else if (c === PERCENT) {
        out += s.slice(from, i)
        const nl = s.indexOf('\n', i)
        if (nl === -1) break
        // TeX drops the end of line and the next line's leading blanks.
        let j = nl + 1
        while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++
        from = j
        i = j - 1
      }
    }
    // Unbalanced: not a usable definition; keep scanning right after the brace.
    this.pos += 1
    return null
  }

  /** Content of a `[..]` group at the cursor (brace-aware), or null when there is none. */
  private optional(): string | null {
    this.skipSpace()
    const s = this.s
    if (s.charCodeAt(this.pos) !== LBRACKET) return null
    let depth = 0
    for (let i = this.pos + 1; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c === BACKSLASH) i++
      else if (c === LBRACE) depth++
      else if (c === RBRACE) depth--
      else if (c === RBRACKET && depth <= 0) {
        const value = s.slice(this.pos + 1, i)
        this.pos = i + 1
        return value
      } else if (c === NEWLINE && /^\n[ \t]*\n/.test(s.slice(i, i + 64))) break
    }
    return null
  }

  /** `\name` either bare or wrapped in braces (`{\name}`). */
  private macroName(): string | null {
    this.skipSpace()
    const s = this.s
    if (s.charCodeAt(this.pos) === BACKSLASH) {
      const name = this.controlSequence(this.pos)
      if (!name) return null
      this.pos += 1 + name.length
      return '\\' + name
    }
    const g = this.group()
    if (g === null) return null
    const m = /^\s*\\([a-zA-Z@]+|[^a-zA-Z@\s])\s*$/.exec(g)
    return m ? '\\' + m[1] : null
  }

  /** A body: a group, or (as TeX allows) a single control sequence or character. */
  private body(): string | null {
    this.skipSpace()
    const s = this.s
    const c = s.charCodeAt(this.pos)
    if (c === LBRACE) return this.group()
    if (c === BACKSLASH) {
      const name = this.controlSequence(this.pos)
      if (!name) return null
      this.pos += 1 + name.length
      return '\\' + name
    }
    if (this.pos < s.length && c !== RBRACE) return s[this.pos++]
    return null
  }

  private definition(kind: string): void {
    const macros = this.macros
    switch (kind) {
      case 'newcommand':
      case 'renewcommand':
      case 'providecommand':
      case 'DeclareRobustCommand': {
        this.star()
        const name = this.macroName()
        if (!name) return
        this.optional() // arity: KaTeX infers it from the body
        this.optional() // default of the optional first argument: unsupported, dropped
        const body = this.body()
        if (body === null) return
        if (kind === 'providecommand' && name in macros) return
        macros[name] = body
        return
      }
      case 'def':
      case 'gdef':
      case 'edef':
      case 'xdef': {
        const s = this.s
        this.skipSpace()
        if (s.charCodeAt(this.pos) !== BACKSLASH) return
        const name = this.controlSequence(this.pos)
        if (!name) return
        this.pos += 1 + name.length
        // Parameter text (`#1#2`, or delimited forms) runs up to the body's brace.
        const open = s.indexOf('{', this.pos)
        if (open === -1) return
        const params = s.slice(this.pos, open)
        if (/[\\%\n]\s*\n/.test(params) || params.length > 80) return
        this.pos = open
        const body = this.group()
        if (body === null) return
        macros['\\' + name] = body
        return
      }
      case 'let': {
        const name = this.macroName()
        if (!name) return
        this.skipSpace()
        if (this.s[this.pos] === '=') this.pos++
        const target = this.body()
        if (target === null || target === name) return
        macros[name] = target
        return
      }
      case 'DeclareMathOperator': {
        const starred = this.star()
        const name = this.macroName()
        if (!name) return
        const text = this.group()
        if (text === null) return
        macros[name] = `\\operatorname${starred ? '*' : ''}{${text}}`
        return
      }
      default: {
        // xparse: \NewDocumentCommand{\name}{arg spec}{body}
        const name = this.macroName()
        if (!name) return
        if (this.group() === null) return
        const body = this.group()
        if (body === null) return
        if (kind === 'ProvideDocumentCommand' && name in macros) return
        macros[name] = body
      }
    }
  }
}

export function extractMacros(source: string): MacroMap {
  const scanner = new MacroScanner(typeof source === 'string' ? source : '')
  try {
    scanner.run()
  } catch {
    // Keep what was collected.
  }
  return scanner.macros
}

/**
 * Pairs braces the way the scanners read them: `\x` escapes the next character and `%` comments
 * run to the end of the line. Answers, for each offset holding `{`, its matching `}` or -1.
 */
export function matchBraces(s: string): Int32Array {
  const closer = new Int32Array(s.length).fill(-1)
  const open: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === BACKSLASH) {
      i++
    } else if (c === PERCENT) {
      const nl = s.indexOf('\n', i)
      if (nl === -1) break
      i = nl
    } else if (c === LBRACE) {
      open.push(i)
    } else if (c === RBRACE) {
      const at = open.pop()
      if (at !== undefined) closer[at] = i
    }
  }
  return closer
}
