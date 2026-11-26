// Reading what TeX wrote in its .log: the first error and where it is, missing files, and the
// picture's box. Run with -file-line-error and max_print_line=1000, so lines are not wrapped.

export interface TexError {
  /** The message, without the `./file.tex:12:` prefix. */
  message: string
  /** The file TeX was reading (`snippet.tex`, or an \input file), when known. */
  file: string | null
  /** 1-based line in that file, when known. */
  line: number | null
  /** TeX's context lines after the message (what it had read when it stopped), trimmed. */
  context: string
  /** A file TeX could not find (`foo.sty`, `data.csv`), when that is the error. */
  missing: string | null
  /** The document had begun (the preamble was read) when TeX stopped. */
  afterBegin: boolean
}

export interface LogSummary {
  error: TexError | null
  /** Each picture's box: width, height and depth in TeX points. */
  boxes: Array<{ width: number; height: number; depth: number }>
  /** The document's \normalsize in points (10, 10.95, 12). */
  fontSize: number | null
}

const FILE_LINE = /^(?:\.\/|\.\\)?(.+?\.(?:tex|sty|cls|cfg|def|clo|ltx|dtx|code\.tex|tikz|pgf)):(\d+): (.*)$/

/** The file a "not found" message names, if this is one. */
function missingFile(message: string): string | null {
  const latex = /File `([^']+)' not found/.exec(message)
  if (latex) return latex[1]
  const tex = /I can't find file `([^']+)'/.exec(message)
  if (tex) return tex[1]
  const table = /[Cc]ould not read table file '([^']+)'/.exec(message)
  if (table) return table[1]
  const graphic = /File `([^']+)' not found/.exec(message)
  if (graphic) return graphic[1]
  return null
}

export function parseLog(log: string): LogSummary {
  const lines = log.split(/\r?\n/)
  const boxes: LogSummary['boxes'] = []
  let fontSize: number | null = null
  let error: TexError | null = null
  let begun = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const box = /^RTE-BOX:([\d.]+)pt:([\d.]+)pt:(-?[\d.]+)pt/.exec(line)
    if (box) {
      boxes.push({ width: Number(box[1]), height: Number(box[2]), depth: Number(box[3]) })
      continue
    }
    const size = /^RTE-FONTSIZE:([\d.]+)/.exec(line)
    if (size) {
      fontSize = Number(size[1])
      begun = true
      continue
    }
    if (error) continue
    const located = FILE_LINE.exec(line)
    const bang = line.startsWith('! ') ? line.slice(2) : null
    if (!located && bang === null) continue
    let message = located ? located[3] : (bang as string)
    // A message can go on over the next lines until a blank line or the context.
    let j = i + 1
    while (j < lines.length && lines[j] !== '' && !/^l\.\d+/.test(lines[j]) && !lines[j].startsWith('! ') && j - i < 6) {
      // TeX's own context (`<*>`, `<inserted text>`, `<argument>`) and help text end the message.
      if (/^(?:See the|Type {2}H|You're in trouble|\(|\[|<)/.test(lines[j])) break
      message += ` ${lines[j].trim()}`
      j++
    }
    let lineNo = located ? Number(located[2]) : null
    let context = ''
    for (let k = i + 1; k < Math.min(lines.length, i + 14); k++) {
      const at = /^l\.(\d+) ?(.*)$/.exec(lines[k])
      if (at) {
        lineNo ??= Number(at[1])
        // TeX shows what it had read, then on the next line, indented to match, what was left:
        // the error is where the first part ends. Kept as two lines, without the `l.N` prefix.
        const prefix = lines[k].length - at[2].length
        const rest = lines[k + 1] ?? ''
        const indent = rest.length - rest.trimStart().length
        const second = rest.trim() ? rest.slice(Math.min(prefix, indent)) : ''
        context = second ? `${at[2]}\n${second}` : at[2].trim()
        break
      }
    }
    message = message.replace(/\s+/g, ' ').trim()
    error = {
      message,
      file: located ? located[1].replace(/^.*[\\/]/, '') : null,
      line: lineNo,
      context: context.slice(0, 240),
      missing: missingFile(message),
      afterBegin: begun
    }
  }
  return { error, boxes, fontSize }
}

/** Files TeX read (from the -recorder .fls), absolute or relative to the run's folder. */
export function recordedInputs(fls: string): string[] {
  const out = new Set<string>()
  let pwd = ''
  for (const line of fls.split(/\r?\n/)) {
    if (line.startsWith('PWD ')) pwd = line.slice(4)
    else if (line.startsWith('INPUT ')) out.add(line.slice(6))
  }
  return [...out].map((p) => (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || !pwd ? p : `${pwd}/${p}`))
}
