// The .tex file a picture is compiled from: the document's own preamble (so its class, fonts,
// macros and \linewidth apply), then the picture alone, boxed and shipped as one page whose size
// is the picture's. Every line of the preamble and of the picture keeps its own line in the file,
// so an error TeX reports maps back to the line the person wrote.
import { documentClass, loadedPackages, stripComments, type Engine } from './engine'

/** How the picture is written in the document. */
export type SnippetMode = 'block' | 'inline' | 'display-math' | 'inline-math'

/** DVI (latex, platex), XDV (xelatex) or PDF (lualatex, and any engine as a fallback). */
export type Route = 'dvi' | 'xdv' | 'pdf'

/** Changes made to the preamble after an attempt failed in it. */
export interface PreambleEdits {
  /** 1-based preamble lines commented out. */
  dropLines: number[]
  /** Packages taken out of their \usepackage list (not installed here). */
  dropPackages: string[]
  /** The class is not installed here: use article with the class's size options. */
  articleClass: boolean
}

export const NO_EDITS: PreambleEdits = { dropLines: [], dropPackages: [], articleClass: false }

export interface Assembly {
  source: string
  /** 1-based line of the generated file where preamble line 1 is. */
  preambleFirst: number
  preambleCount: number
  /** 1-based line where the picture's first line is. */
  snippetFirst: number
  snippetCount: number
}

/** Pictures each environment needs a package for (beyond TikZ, which all of these load). */
const PACKAGE_FOR: Readonly<Record<string, string>> = {
  tikzcd: 'tikz-cd',
  circuitikz: 'circuitikz',
  forest: 'forest',
  pspicture: 'pstricks',
  axis: 'pgfplots',
  semilogxaxis: 'pgfplots',
  semilogyaxis: 'pgfplots',
  loglogaxis: 'pgfplots',
  polaraxis: 'pgfplots',
  ternaryaxis: 'pgfplots',
  smithchart: 'pgfplots',
  groupplot: 'pgfplots'
}

/** The packages a picture needs, read from what it uses. */
export function packagesFor(snippet: string): string[] {
  const text = stripComments(snippet)
  const needed = new Set<string>()
  if (/\\begin\s*\{(?:tikzpicture|pgfpicture|scope)\}|\\tikz\b|\\begin\s*\{tikzcd\}|\\begin\s*\{circuitikz\}|\\begin\s*\{forest\}/.test(text)) needed.add('tikz')
  for (const m of text.matchAll(/\\begin\s*\{([A-Za-z*]+)\}/g)) {
    const pkg = PACKAGE_FOR[m[1].replace(/\*$/, '')]
    if (pkg) needed.add(pkg)
  }
  if (/\\addplot\b|\\nextgroupplot\b/.test(text)) needed.add('pgfplots')
  if (/\\xymatrix\b|\\begin\s*\{xy\}|\\xygraph\b/.test(text)) needed.add('xy')
  if (/\\pstree\b|\\psline\b|\\rput\b|\\psframe\b/.test(text)) needed.add('pstricks')
  if (/\\(?:chemfig|schemestart)\b/.test(text)) needed.add('chemfig')
  return [...needed]
}

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/

export const hasHangul = (text: string) => HANGUL.test(text)

/** One top-level statement of a preamble: the lines a command and its braces span. */
export interface Statement {
  /** 1-based first and last line. */
  first: number
  last: number
  text: string
}

/** Splits a preamble into statements: a line opens one, and it runs until its braces close. */
export function statements(preamble: string): Statement[] {
  const lines = preamble.split('\n')
  const out: Statement[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (let j = 0; j < line.length; j++) {
      const c = line[j]
      if (c === '\\') j++
      else if (c === '%') break
      else if (c === '{') depth++
      else if (c === '}') depth = Math.max(0, depth - 1)
    }
    if (depth === 0) {
      out.push({ first: start + 1, last: i + 1, text: lines.slice(start, i + 1).join('\n') })
      start = i + 1
    }
  }
  if (start < lines.length) out.push({ first: start + 1, last: lines.length, text: lines.slice(start).join('\n') })
  return out
}

/** The statement holding a preamble line. */
export function statementAt(preamble: string, line: number): Statement | null {
  return statements(preamble).find((s) => s.first <= line && line <= s.last) ?? null
}

const SIZE_OPTION = /^(?:1[0-2]pt|twocolumn|onecolumn|a4paper|letterpaper|a5paper|b5paper|landscape)$/

/** `\documentclass[11pt,twocolumn]{acmart}` → `\documentclass[11pt,twocolumn]{article}`. */
function articleLine(line: string): string {
  return line.replace(/\\documentclass\s*(?:\[([^\]]*)\])?\s*\{[^}]*\}/, (_m, options: string | undefined) => {
    const kept = (options ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => SIZE_OPTION.test(o))
    return `\\documentclass${kept.length ? `[${kept.join(',')}]` : ''}{article}`
  })
}

/**
 * The preamble as it is compiled: lines that cannot work outside the real build are neutralised
 * in place (never removed, so line numbers stay), plus the edits earlier attempts asked for.
 */
export function preparePreamble(preamble: string, route: Route, edits: PreambleEdits): string {
  const cls = documentClass(preamble)
  const lines = preamble.split('\n')
  const drop = new Set(edits.dropLines)
  const dropPackages = new Set(edits.dropPackages)
  return lines
    .map((line, i) => {
      if (drop.has(i + 1)) return `%rte: skipped: ${line}`
      let out = line
      // Externalization writes and runs files: the picture is drawn here, so it is turned off.
      out = out.replace(/\\tikzexternalize(?:\s*\[[^\]]*\])?/g, '\\relax')
      out = out.replace(/\\includeonly\s*\{[^}]*\}/g, '')
      if (route !== 'pdf') out = out.replace(/\\pdfoutput\s*=?\s*1\b/g, '')
      if (/\\documentclass\b/.test(out)) {
        if (edits.articleClass || cls === 'standalone' || cls === 'subfiles') out = articleLine(out)
        else if (cls === 'beamer') out = `${articleLine(out)}\\usepackage{beamerarticle}`
        // A global option every driver-aware package reads (graphicx, xcolor, hyperref, the LaTeX
        // backend): otherwise xcolor loads dvips.def and \resizebox draws with PostScript, which
        // dvisvgm cannot run without Ghostscript.
        if (route !== 'pdf') {
          out = out.replace(/\\documentclass(\s*\[)?/, (_m, bracket: string | undefined) => (bracket ? `\\documentclass${bracket}dvisvgm,` : '\\documentclass[dvisvgm]'))
        }
      }
      if (dropPackages.size > 0) {
        out = out.replace(/\\(usepackage|RequirePackage)(\s*\[[^\]]*\])?(\s*)\{([^}]*)\}/g, (whole, cmd: string, opts: string | undefined, space: string, list: string) => {
          const kept = list.split(',').filter((name) => !dropPackages.has(name.trim()))
          if (kept.length === list.split(',').length) return whole
          return kept.length === 0 ? '' : `\\${cmd}${opts ?? ''}${space}{${kept.join(',')}}`
        })
      }
      return out
    })
    .join('\n')
}

/** What a picture always works with when the document's preamble cannot be used. */
export const COMMON_TIKZ_LIBRARIES =
  'arrows.meta,arrows,positioning,calc,shapes,shapes.geometric,shapes.misc,decorations.pathreplacing,decorations.pathmorphing,decorations.markings,patterns,fit,backgrounds,matrix,intersections,angles,quotes,3d,shadows,automata,trees,chains'

/** Statements a picture may rely on, kept when the rest of the preamble is set aside. */
const KEEP = /^\s*\\(?:usetikzlibrary|usepgfplotslibrary|pgfplotsset|tikzset|tikzstyle|tikzcdset|forestset|ctikzset|definecolor|colorlet|providecolor|newcommand|renewcommand|providecommand|DeclareMathOperator|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|def|gdef|let|newcounter|setcounter|newlength|setlength|pgfmathsetmacro|pgfkeys|SelectTips|xyoption|CompileMatrices|usepackage|RequirePackage)\b/

/** Packages the reduced preamble keeps when the document loads them and they are installed. */
const SAFE_PACKAGES = new Set([
  'amsmath', 'amssymb', 'amsfonts', 'amsthm', 'mathtools', 'bm', 'xcolor', 'color', 'siunitx', 'tikz', 'pgf',
  'pgfplots', 'pgfplotstable', 'tikz-cd', 'circuitikz', 'forest', 'xy', 'tikz-3dplot', 'tkz-euclide',
  'tikz-feynman', 'tikzpeople', 'pgfornament', 'chemfig', 'mhchem', 'stmaryrd', 'mathrsfs', 'dsfont',
  'upgreek', 'esint', 'cancel', 'graphicx', 'booktabs', 'array', 'calc', 'etoolbox', 'xparse', 'ifthen',
  'kotex', 'fontspec', 'unicode-math', 'pstricks', 'pst-node', 'pst-plot', 'tikzsymbols', 'smartdiagram',
  'neuralnetwork', 'bayesnet', 'quantikz', 'tikz-network', 'pgf-pie', 'pgf-umlsd', 'pgf-umlcd', 'mathdots'
])

/**
 * A preamble that works almost anywhere: article, the picture's packages, and from the document
 * only the libraries, styles, colours and macros a picture may use.
 */
export function reducedPreamble(original: string, snippet: string, engine: Engine, installed: (pkg: string) => boolean): string {
  const lines: string[] = []
  const options = /\\documentclass\s*\[([^\]]*)\]/.exec(stripComments(original))?.[1] ?? ''
  const size = options
    .split(',')
    .map((o) => o.trim())
    .filter((o) => /^1[0-2]pt$/.test(o))
  lines.push(`\\documentclass${size.length ? `[${size[0]}]` : ''}{article}`)
  lines.push('\\usepackage{amsmath,amssymb}')
  if (hasHangul(snippet) || hasHangul(original)) lines.push('\\usepackage{kotex}')
  for (const st of statements(stripComments(original))) {
    if (!KEEP.test(st.text)) continue
    if (/^\s*\\(?:usepackage|RequirePackage)\b/.test(st.text)) {
      const names = loadedPackages(st.text).filter((name) => SAFE_PACKAGES.has(name) && installed(name))
      // Unicode fonts only work with the engines that have them.
      const usable = names.filter((name) => (name !== 'fontspec' && name !== 'unicode-math') || engine === 'xelatex' || engine === 'lualatex')
      if (usable.length) lines.push(`\\usepackage{${usable.join(',')}}`)
      continue
    }
    lines.push(st.text)
  }
  return lines.join('\n')
}

/** The preamble for a picture whose document has none (a section file, or a file on an SSH host). */
export function defaultPreamble(snippet: string): string {
  const lines = ['\\documentclass{article}', '\\usepackage{amsmath,amssymb}']
  if (hasHangul(snippet)) lines.push('\\usepackage{kotex}')
  lines.push('\\usepackage{tikz}', `\\usetikzlibrary{${COMMON_TIKZ_LIBRARIES}}`)
  if (packagesFor(snippet).includes('pgfplots')) lines.push('\\usepackage{pgfplots}', '\\pgfplotsset{compat=newest}', '\\usepgfplotslibrary{groupplots,fillbetween}')
  return lines.join('\n')
}

/** The macros that box the picture and ship it as one page of exactly its size. */
function shipping(route: Route): string[] {
  const lines = ['\\makeatletter', '\\newsavebox\\rte@box', '\\newenvironment{rtesnippet}{\\begin{lrbox}{\\rte@box}}{\\end{lrbox}\\rte@ship}']
  if (route === 'pdf') {
    lines.push(
      '\\def\\rte@ship{\\typeout{RTE-BOX:\\the\\wd\\rte@box:\\the\\ht\\rte@box:\\the\\dp\\rte@box}%',
      '\\hoffset=-1in\\voffset=-1in\\ifdefined\\pagewidth\\pagewidth=\\wd\\rte@box\\pageheight=\\dimexpr\\ht\\rte@box+\\dp\\rte@box\\relax\\else\\pdfpagewidth=\\wd\\rte@box\\pdfpageheight=\\dimexpr\\ht\\rte@box+\\dp\\rte@box\\relax\\fi',
      '\\shipout\\vbox{\\hbox{\\usebox\\rte@box}}}'
    )
  } else {
    lines.push(
      '\\def\\rte@ship{\\typeout{RTE-BOX:\\the\\wd\\rte@box:\\the\\ht\\rte@box:\\the\\dp\\rte@box}%',
      "\\shipout\\hbox{\\special{dvisvgm:bbox rel \\the\\wd\\rte@box\\space\\the\\ht\\rte@box\\space\\the\\dp\\rte@box}\\special{dvisvgm:bbox lock}\\special{dvisvgm:raw <g class='rte-base' data-y='{?y}'/>}\\usebox\\rte@box}}"
    )
  }
  lines.push('\\AtBeginDocument{\\typeout{RTE-FONTSIZE:\\f@size}}', '\\makeatother')
  return lines
}

/** Loads a package the picture needs unless the preamble already did (no option clash). */
function ensure(pkg: string): string {
  const load = pkg === 'xy' ? '\\usepackage[all]{xy}' : pkg === 'pgfplots' ? '\\usepackage{pgfplots}\\pgfplotsset{compat=newest}' : `\\usepackage{${pkg}}`
  return `\\makeatletter\\@ifpackageloaded{${pkg}}{\\makeatother}{\\makeatother${load}}`
}

/** The whole file: prologue, preamble, shipping macros, then the picture alone. */
export function assemble(input: { preamble: string; snippet: string; mode: SnippetMode; route: Route }): Assembly {
  const out: string[] = []
  // TikZ's dvisvgm driver must be chosen before TikZ loads (the class option covers the rest).
  out.push(input.route === 'pdf' ? '%rte' : '\\def\\pgfsysdriver{pgfsys-dvisvgm.def}')
  const preambleFirst = out.length + 1
  const preambleLines = input.preamble.split('\n')
  out.push(...preambleLines)
  for (const pkg of packagesFor(input.snippet)) out.push(ensure(pkg))
  out.push(...shipping(input.route))
  out.push('\\begin{document}')
  const open = input.mode === 'display-math' ? '\\begin{rtesnippet}$\\displaystyle' : input.mode === 'inline-math' ? '\\begin{rtesnippet}$' : '\\begin{rtesnippet}%'
  out.push(open)
  const snippetFirst = out.length + 1
  const math = input.mode === 'display-math' || input.mode === 'inline-math'
  // Math begins on the `$` line, so the rest of a `\[` line is an empty line here: in math a
  // blank line would end the paragraph. Each becomes a comment, keeping the line count.
  const snippetLines = input.snippet.split('\n').map((line) => (math && line.trim() === '' ? '%' : line))
  out.push(...snippetLines)
  out.push(math ? '$%' : '%')
  out.push('\\end{rtesnippet}', '\\end{document}', '')
  return { source: out.join('\n'), preambleFirst, preambleCount: preambleLines.length, snippetFirst, snippetCount: snippetLines.length }
}
