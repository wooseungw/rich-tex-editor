// Which TeX engine a document is written for. There is no single "TeX": pdfLaTeX, XeLaTeX and
// LuaLaTeX read different preambles (fontspec needs Xe/Lua, luacode needs Lua), and Japanese
// documents use pLaTeX or upLaTeX. A picture is drawn with the engine the document compiles with.

export type Engine = 'pdflatex' | 'xelatex' | 'lualatex' | 'latex' | 'platex' | 'uplatex'

export const ENGINES: readonly Engine[] = ['pdflatex', 'xelatex', 'lualatex', 'latex', 'platex', 'uplatex']

export interface EngineChoice {
  engine: Engine
  /** Why: `magic comment`, `latexmkrc`, `fontspec`, … for the status line. */
  reason: string
}

const PROGRAMS: Readonly<Record<string, Engine>> = {
  pdflatex: 'pdflatex',
  'pdflatex-dev': 'pdflatex',
  pdftex: 'pdflatex',
  latex: 'latex',
  'latex-dev': 'latex',
  xelatex: 'xelatex',
  'xelatex-dev': 'xelatex',
  xetex: 'xelatex',
  lualatex: 'lualatex',
  'lualatex-dev': 'lualatex',
  luatex: 'lualatex',
  luahbtex: 'lualatex',
  'lualatex-hb': 'lualatex',
  platex: 'platex',
  'platex-dev': 'platex',
  uplatex: 'uplatex',
  'uplatex-dev': 'uplatex'
}

/** The engine a program name stands for (`XeLaTeX`, `lualatex-dev`, `pdflatex.exe`). */
export function programEngine(name: string): Engine | null {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '')
  return PROGRAMS[key] ?? null
}

/**
 * `% !TEX program = xelatex` (TeXShop, TeXstudio, VS Code), `% !TeX TS-program = lualatex`, or an
 * arara directive, in the comment lines at the top of the file.
 */
export function magicEngine(text: string): Engine | null {
  const lines = text.split(/\r\n?|\n/, 40)
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (!line.startsWith('%')) break
    const magic = /^%+\s*!\s*TeX\s+(?:TS-)?program\s*=\s*([A-Za-z.-]+)/i.exec(line)
    if (magic) return programEngine(magic[1]) ?? null
    const arara = /^%+\s*arara\s*:\s*([A-Za-z.-]+)/i.exec(line)
    if (arara) {
      const engine = programEngine(arara[1])
      if (engine) return engine
    }
  }
  return null
}

/** The engine a latexmkrc selects: `$pdf_mode = 5;`, or `$pdflatex = 'xelatex %O %S';`. */
export function latexmkEngine(rc: string): Engine | null {
  let engine: Engine | null = null
  for (const raw of rc.split(/\r\n?|\n/)) {
    const line = raw.replace(/(^|[^\\$])#.*$/, '$1')
    const mode = /\$pdf_mode\s*=\s*(\d)/.exec(line)
    if (mode) {
      const n = Number(mode[1])
      if (n === 1) engine = 'pdflatex'
      else if (n === 4) engine = 'lualatex'
      else if (n === 5) engine = 'xelatex'
      else if (n === 2 || n === 3) engine = 'latex'
    }
    const program = /\$(?:pdf)?latex\s*=\s*['"]\s*([A-Za-z.-]+)/.exec(line)
    if (program) {
      const named = programEngine(program[1])
      if (named) engine = named
    }
  }
  return engine
}

/** The preamble without comments, so a commented-out `\usepackage{fontspec}` does not count. */
export function stripComments(text: string): string {
  return text.replace(/(^|[^\\])%.*$/gm, '$1')
}

/** Every package a preamble loads, by name. */
export function loadedPackages(preamble: string): string[] {
  const names: string[] = []
  const re = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g
  for (const m of stripComments(preamble).matchAll(re)) {
    for (const name of m[1].split(',')) if (name.trim()) names.push(name.trim())
  }
  return names
}

/** The document class's name, or null when the text has no `\documentclass`. */
export function documentClass(preamble: string): string | null {
  const m = /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/.exec(stripComments(preamble))
  return m ? m[1].trim() : null
}

const LUA_ONLY = new Set(['luatexja', 'luatexja-fontspec', 'luatexja-preset', 'luacode', 'luaotfload', 'lua-ul', 'luamplib', 'lua-visual-debug', 'luatexbase', 'selnolig', 'ltj-latex'])
const XE_ONLY = new Set(['xecjk', 'xeCJK', 'xetexko', 'xltxtra', 'xunicode', 'xepersian', 'bidi', 'xgreek', 'zhspacing', 'xeindex'])
const UNICODE_FONTS = new Set(['fontspec', 'unicode-math', 'polyglossia', 'mathspec', 'realscripts', 'ctex'])

/** The engine the preamble needs, from the packages and commands only one engine has. */
export function preambleEngine(preamble: string): EngineChoice | null {
  const text = stripComments(preamble)
  const cls = documentClass(text)
  if (cls === 'ltjsarticle' || cls === 'ltjsbook' || cls === 'ltjsreport' || cls?.startsWith('ltjs') || cls === 'ltjarticle') {
    return { engine: 'lualatex', reason: cls }
  }
  if (cls && /^u(?:j|t)(?:article|book|report)$|^ujarticle$|^ujbook$|^ujreport$/.test(cls)) return { engine: 'uplatex', reason: cls }
  if (cls && /^(?:j|t)(?:article|book|report)$|^jsarticle$|^jsbook$|^jsreport$/.test(cls)) {
    return { engine: /\[[^\]]*uplatex/.test(text) ? 'uplatex' : 'platex', reason: cls }
  }
  if (cls === 'jlreq' && /\[[^\]]*platex/.test(text)) return { engine: 'platex', reason: 'jlreq' }
  const packages = loadedPackages(text)
  for (const name of packages) if (LUA_ONLY.has(name)) return { engine: 'lualatex', reason: name }
  if (/\\directlua\b|\\luaexec\b|\\begin\{luacode\*?\}/.test(text)) return { engine: 'lualatex', reason: '\\directlua' }
  for (const name of packages) if (XE_ONLY.has(name)) return { engine: 'xelatex', reason: name }
  if (/\\XeTeX[A-Za-z]+|\\setCJK(?:main|sans|mono)font/.test(text)) return { engine: 'xelatex', reason: 'XeTeX commands' }
  for (const name of packages) if (UNICODE_FONTS.has(name)) return { engine: 'xelatex', reason: name }
  if (/\\set(?:main|sans|mono|math)font\b|\\newfontfamily\b|\\set(?:main|sans|mono)hangulfont\b|\\sethangulfont\b/.test(text)) {
    return { engine: 'xelatex', reason: 'font commands' }
  }
  return null
}

/**
 * The engine for a document: its magic comment wins, then the project's latexmkrc, then what its
 * preamble needs; pdfLaTeX otherwise.
 */
export function chooseEngine(input: { text: string; preamble: string; latexmkrc?: string | null }): EngineChoice {
  const magic = magicEngine(input.text) ?? magicEngine(input.preamble)
  if (magic) return { engine: magic, reason: '% !TEX program' }
  const rc = input.latexmkrc ? latexmkEngine(input.latexmkrc) : null
  if (rc) return { engine: rc, reason: 'latexmkrc' }
  return preambleEngine(input.preamble) ?? { engine: 'pdflatex', reason: 'default' }
}
