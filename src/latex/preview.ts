/**
 * LaTeX → HTML for the split-mode preview.
 *
 * One linear pass over the document body writes HTML with placeholders for everything that can
 * only be known at the end (cross-references, citations, the table of contents, and math, whose
 * `\eqref`s are substituted before rendering); a final pass resolves them. Every top-level block
 * carries `data-line` (the 1-based source line where it starts) for scroll sync. All source text
 * is escaped; nothing from the source reaches the output as markup. The renderer never throws and
 * every loop consumes input, so malformed documents always terminate.
 */
import { extractMacros, type MacroMap } from './macros'
import { DISPLAY_MATH_ENVS, prepareMath, type PreparedMath } from './math'

export interface PreviewOptions {
  /** Returns HTML for one formula. May throw a KaTeX ParseError; it is shown inline. */
  renderMath(tex: string, displayMode: boolean, macros: MacroMap): string
}
export interface OutlineEntry {
  level: number
  title: string
  number: string | null
  line: number
}
export interface PreviewResult {
  html: string
  outline: OutlineEntry[]
  wordCount: number
}

// ---------------------------------------------------------------------------------------------
// Helpers

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const ESCAPE_RE = /[&<>"'\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
function esc(s: string): string {
  return s.replace(ESCAPE_RE, (c) => ESCAPES[c] ?? '')
}

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)

function roman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n)
  const table: Array<[number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']
  ]
  let out = ''
  for (const [v, r] of table) {
    while (n >= v) {
      out += r
      n -= v
    }
  }
  return out
}

function alpha(n: number): string {
  if (n <= 0) return String(n)
  let out = ''
  while (n > 0) {
    n--
    out = String.fromCharCode(97 + (n % 26)) + out
    n = Math.floor(n / 26)
  }
  return out
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function today(): string {
  const d = new Date()
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

/** `\u0001<kind><index>\u0002`: escaping strips these control characters from source text. */
const ph = (kind: string, i: number) => `\u0001${kind}${i}\u0002`

/** Splits at top-level `sep` (outside braces). */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') i++
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === sep && depth <= 0) {
      out.push(s.slice(from, i))
      from = i + 1
    }
  }
  out.push(s.slice(from))
  return out
}

/** Splits an `\author` argument at top-level `\and`. */
function splitAnd(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '\\') {
      if (depth <= 0 && s.startsWith('and', i + 1) && !isLetter(s.charCodeAt(i + 4))) {
        out.push(s.slice(from, i))
        from = i + 4
        i += 3
      } else {
        i++
      }
    }
  }
  out.push(s.slice(from))
  return out.filter((a) => a.trim().length > 0)
}

function keyValues(s: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of splitTopLevel(s, ',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    let value = part.slice(eq + 1).trim()
    if (value.startsWith('{') && value.endsWith('}')) value = value.slice(1, -1)
    out.set(part.slice(0, eq).trim(), value)
  }
  return out
}

/** A LaTeX width as a percentage of the text width, when it can be read (`0.5\textwidth`, `6cm`). */
function widthPercent(raw: string): number | null {
  const s = raw.trim()
  let m = /^([0-9]*\.?[0-9]+)?\s*\\(?:textwidth|linewidth|columnwidth|hsize|textheight)$/.exec(s)
  let pct: number | null = null
  if (m) pct = (m[1] ? parseFloat(m[1]) : 1) * 100
  else if ((m = /^([0-9]*\.?[0-9]+)\s*(cm|mm|in|pt|bp|em)$/.exec(s))) {
    const v = parseFloat(m[1])
    const cm = m[2] === 'cm' ? v : m[2] === 'mm' ? v / 10 : m[2] === 'in' ? v * 2.54 : m[2] === 'em' ? v * 0.35 : v / 28.45
    pct = (cm / 12.2) * 100
  }
  if (pct === null || !Number.isFinite(pct)) return null
  return Math.round(Math.min(100, Math.max(5, pct)) * 10) / 10
}

/** Keeps http:, https: and mailto: links; everything else renders as plain text. */
function safeUrl(raw: string): string | null {
  const u = raw
    .replace(/\\([%#&_~$\\{}])/g, '$1')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/\s+/g, '%20')
  return /^(?:https?:|mailto:)/i.test(u) ? u : null
}

function macroArity(body: string): number {
  let max = 0
  for (let i = 0; i < body.length; i++) {
    if (body.charCodeAt(i) !== 35) continue
    const n = body.charCodeAt(i + 1)
    if (n === 35) i++
    else if (n >= 49 && n <= 57) max = Math.max(max, n - 48)
  }
  return max
}

function inComment(s: string, index: number): boolean {
  const lineStart = s.lastIndexOf('\n', index - 1) + 1
  for (let i = lineStart; i < index; i++) {
    const c = s.charCodeAt(i)
    if (c === 92) i++
    else if (c === 37) return true
  }
  return false
}

function findUncommented(s: string, re: RegExp, from: number, to = s.length): { index: number; length: number } | null {
  re.lastIndex = from
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null && m.index < to) {
    if (!inComment(s, m.index)) return { index: m.index, length: m[0].length }
  }
  return null
}

const WORD_RE = /[\p{L}\p{N}\p{M}]/u
const isCJK = (c: number) =>
  (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)

// ---------------------------------------------------------------------------------------------
// Command tables

const SECTION_LEVELS: Record<string, number> = {
  part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5
}
const HEADING_TAGS = ['h1', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']

const TEXT_SYMBOLS: Record<string, string> = {
  ldots: '…', dots: '…', textellipsis: '…', S: '§', P: '¶', copyright: '©',
  textcopyright: '©', textregistered: '®', texttrademark: '™', dag: '†', ddag: '‡',
  textdagger: '†', textdaggerdbl: '‡', pounds: '£', textsterling: '£', euro: '€',
  texteuro: '€', textbackslash: '\\', textasciitilde: '~', textasciicircum: '^', textbar: '|',
  textless: '<', textgreater: '>', textunderscore: '_', textbraceleft: '{', textbraceright: '}',
  textquoteleft: '‘', textquoteright: '’', textquotedblleft: '“', textquotedblright: '”',
  textquotesingle: "'", textquotedbl: '"', textendash: '–', textemdash: '—', textbullet: '•',
  textdegree: '°', textperiodcentered: '·', textsection: '§', textparagraph: '¶',
  ss: 'ß', SS: 'SS', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø',
  aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ', dh: 'ð', DH: 'Ð',
  th: 'þ', TH: 'Þ', ng: 'ŋ', NG: 'Ŋ', dj: 'đ', DJ: 'Đ',
  guillemotleft: '«', guillemotright: '»', guillemetleft: '«', guillemetright: '»',
  guilsinglleft: '‹', guilsinglright: '›', quotedblbase: '„', quotesinglbase: '‚',
  textexclamdown: '¡', textquestiondown: '¿', checkmark: '✓', textmu: 'µ',
  textonehalf: '½', textonequarter: '¼', textthreequarters: '¾', texttimes: '×',
  textdiv: '÷', textpm: '±', textminus: '−', textasteriskcentered: '∗',
  textcent: '¢', textyen: '¥', textnumero: '№', textcelsius: '℃', textperthousand: '‰',
  textleftarrow: '←', textrightarrow: '→', textuparrow: '↑', textdownarrow: '↓',
  slash: '/', textslash: '/', nobreakspace: ' ', textvisiblespace: '␣', textcompwordmark: '',
  qed: '∎', qedsymbol: '∎', figurename: 'Figure', tablename: 'Table', refname: 'References',
  bibname: 'Bibliography', abstractname: 'Abstract', contentsname: 'Contents', proofname: 'Proof',
  appendixname: 'Appendix', chaptername: 'Chapter', partname: 'Part', textasciigrave: '`',
  textordfeminine: 'ª', textordmasculine: 'º', lq: '‘', rq: '’'
}

const SPACES: Record<string, string> = {
  quad: ' ', qquad: '  ', enspace: ' ', enskip: ' ', thinspace: ' ',
  space: ' ', nobreak: '', negthinspace: '', hfill: ' ', hfil: ' ', dotfill: ' … ', hrulefill: ' '
}

const TEX_E = '<span class="rt-logo-e">e</span>'
const TEX_A = '<span class="rt-logo-a">a</span>'
const LOGO_TEX = `T${TEX_E}X`
const LOGOS: Record<string, string> = {
  TeX: LOGO_TEX,
  LaTeX: `L${TEX_A}${LOGO_TEX}`,
  LaTeXe: `L${TEX_A}${LOGO_TEX} 2<span class="rt-logo-eps">ε</span>`,
  BibTeX: `Bib${LOGO_TEX}`,
  XeTeX: `X${TEX_E}${LOGO_TEX}`,
  XeLaTeX: `X${TEX_E}L${TEX_A}${LOGO_TEX}`,
  LuaTeX: `Lua${LOGO_TEX}`,
  LuaLaTeX: `LuaL${TEX_A}${LOGO_TEX}`,
  pdfTeX: `pdf${LOGO_TEX}`,
  pdfLaTeX: `pdfL${TEX_A}${LOGO_TEX}`,
  AmS: 'AMS',
  ConTeXt: `Con${LOGO_TEX}t`
}

/** Combining marks for accents: `\'e`, `\c{c}`, … */
const ACCENTS: Record<string, string> = {
  "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇',
  u: '̆', v: '̌', H: '̋', c: '̧', k: '̨', r: '̊', d: '̣', b: '̱', t: '͡'
}
const SPACING_ACCENTS: Record<string, string> = { "'": '´', '`': '`', '^': '^', '"': '¨', '~': '~', '=': '¯', '.': '˙' }

interface Wrap {
  /** Arguments to skip before the content: s = star, o = optional, m = mandatory. */
  skip: string
  tag: string
  cls: string
  long?: boolean
}
const w = (tag: string, cls = '', skip = '', long = false): Wrap => ({ tag, cls, skip, long })
const WRAPPERS: Record<string, Wrap> = {
  textbf: w('b'), textit: w('i'), emph: w('em'), underline: w('u'), texttt: w('code', 'rt-tt'),
  textsc: w('span', 'rt-sc'), textsf: w('span', 'rt-sf'), textrm: w('span', 'rt-rm'), textsl: w('span', 'rt-sl'),
  textup: w('span', 'rt-up'), textmd: w('span', 'rt-md'), textnormal: w('span', 'rt-normal'),
  textsuperscript: w('sup'), textsubscript: w('sub'), sout: w('s'), st: w('s'), xout: w('s'), uline: w('u'),
  uuline: w('u'), uwave: w('u', 'rt-wave'), hl: w('mark', 'rt-hl'), textls: w('', '', 'o'),
  mbox: w('span', 'rt-mbox'), hbox: w('span', 'rt-mbox'), makebox: w('span', 'rt-mbox', 'oo'),
  fbox: w('span', 'rt-fbox', '', true), framebox: w('span', 'rt-fbox', 'oo', true), boxed: w('span', 'rt-fbox'),
  colorbox: w('span', 'rt-colorbox', 'om', true), fcolorbox: w('span', 'rt-fbox', 'omm', true),
  parbox: w('span', 'rt-parbox', 'ooom', true), raisebox: w('', '', 'moo'), resizebox: w('', '', 'smm', true),
  scalebox: w('', '', 'mo', true), rotatebox: w('', '', 'om', true), reflectbox: w('', '', '', true),
  adjustbox: w('', '', 'm', true), centerline: w('span', 'rt-centerline'), leftline: w(''), rightline: w(''),
  smash: w('', '', 'o'), makecell: w('', '', 'o'), thead: w('b', '', 'o'), shortstack: w('', '', 'o'),
  multirow: w('', '', 'momo'), multicolumn: w('', '', 'mm'), foreignlanguage: w('', '', 'om'), text: w(''),
  textcolor: w('span', 'rt-color', 'om'), hyperlink: w('', '', 'm'), hypertarget: w('', '', 'm'),
  hyperref: w('span', 'rt-ref', 'o'), MakeUppercase: w('span', 'rt-upper'), uppercase: w('span', 'rt-upper'),
  MakeTextUppercase: w('span', 'rt-upper'), MakeLowercase: w('span', 'rt-lower'), lowercase: w('span', 'rt-lower'),
  MakeTextLowercase: w('span', 'rt-lower'), marginpar: w('span', 'rt-marginpar', 'o', true),
  marginnote: w('span', 'rt-marginpar', 'o', true), sidenote: w('span', 'rt-marginpar', 'o', true),
  todo: w('span', 'rt-todo', 'o', true), textcircled: w(''), mintedinline: w('code', 'rt-tt'),
  ul: w('u'), mathrm: w('span', 'rt-rm'), mathbf: w('b'), mathit: w('i'), mathsf: w('span', 'rt-sf'),
  mathtt: w('code', 'rt-tt')
}

const DECLARATIONS: Record<string, string> = {
  bf: 'rt-bf', bfseries: 'rt-bf', it: 'rt-it', itshape: 'rt-it', em: 'rt-em', tt: 'rt-tt', ttfamily: 'rt-tt',
  sc: 'rt-sc', scshape: 'rt-sc', sf: 'rt-sf', sffamily: 'rt-sf', rm: 'rt-rm', rmfamily: 'rt-rm',
  sl: 'rt-sl', slshape: 'rt-sl', upshape: 'rt-up', mdseries: 'rt-md', normalfont: 'rt-normal'
}

/** Commands that print nothing and take no argument. */
const NOOPS = new Set([
  'tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE', 'huge', 'Huge',
  'relax', 'protect', 'null', 'leavevmode', 'ignorespaces', 'unskip', 'allowbreak', 'sloppy', 'fussy',
  'frenchspacing', 'nonfrenchspacing', 'smallskip', 'medskip', 'bigskip', 'vfill', 'vfil', 'onecolumn',
  'balance', 'FloatBarrier', 'makeatletter', 'makeatother', 'indent', 'newblock', 'normalcolor',
  'raggedbottom', 'flushbottom', 'listoffigures', 'listoftables', 'printindex', 'makeindex', 'strut',
  'mathstrut', 'hss', 'break', 'goodbreak', 'filbreak', 'displaybreak', 'selectfont', 'boldmath',
  'unboldmath', 'endinput', 'justifying', 'fi', 'else', 'iftrue', 'qedhere', 'arraybackslash',
  'centeringarraybackslash', 'tightlist', 'maketitlepage', 'printglossaries', 'makeglossaries', 'nocopyright',
  'and', 'hline', 'toprule', 'midrule', 'bottomrule', 'endhead', 'endfirsthead', 'endfoot', 'endlastfoot',
  'morecmidrules', 'acknowledgments'
])

/** Commands whose arguments are dropped: s = star, o = optional, m = mandatory. */
const IGNORED: Record<string, string> = {
  documentclass: 'om', usepackage: 'om', RequirePackage: 'om', setlength: 'mm', addtolength: 'mm',
  settowidth: 'mm', settoheight: 'mm', settodepth: 'mm', setcounter: 'mm', addtocounter: 'mm',
  stepcounter: 'm', refstepcounter: 'm', pagestyle: 'm', thispagestyle: 'm', pagenumbering: 'm',
  bibliographystyle: 'm', linespread: 'm', geometry: 'm', newgeometry: 'm', restoregeometry: '',
  hypersetup: 'm', graphicspath: 'm', definecolor: 'ommm', colorlet: 'omm', color: 'om', pagecolor: 'om',
  index: 'om', glossary: 'm', nocite: 'm', addbibresource: 'om', captionsetup: 'om', lstset: 'm',
  setminted: 'om', usemintedstyle: 'om', usetikzlibrary: 'm', tikzset: 'm', pgfplotsset: 'm',
  usepgfplotslibrary: 'm', numberwithin: 'mm', fontsize: 'mm', enlargethispage: 'sm', markboth: 'mm',
  markright: 'm', fancyhead: 'om', fancyfoot: 'om', fancyhf: 'om', lhead: 'm', chead: 'm', rhead: 'm',
  lfoot: 'm', cfoot: 'm', rfoot: 'm', setmainfont: 'om', setsansfont: 'om', setmonofont: 'om',
  setCJKmainfont: 'om', newfontfamily: 'mom', fontfamily: 'm', fontseries: 'm', fontshape: 'm',
  usefont: 'mmmm', titleformat: 'smommmo', titlespacing: 'smmmmo', hyphenation: 'm', includeonly: 'm',
  DeclareGraphicsExtensions: 'm', setstretch: 'm', restylefloat: 'm', floatstyle: 'm', newfloat: 'mmmo',
  floatname: 'mm', crefname: 'mmm', Crefname: 'mmm', crefformat: 'mm', Crefformat: 'mm',
  addcontentsline: 'mmm', addtocontents: 'mm', counterwithin: 'smm', counterwithout: 'smm',
  AtBeginDocument: 'm', AtEndDocument: 'm', ExecuteOptions: 'm', PassOptionsToPackage: 'mm',
  PassOptionsToClass: 'mm', sisetup: 'm', selectlanguage: 'm', phantom: 'm', hphantom: 'm', vphantom: 'm',
  vspace: 'sm', addvspace: 'm', newtheoremstyle: 'mmmmmmmmm', setbeamertemplate: 'mom', usetheme: 'om',
  usecolortheme: 'om', usefonttheme: 'om', useinnertheme: 'om', useoutertheme: 'om', setbeamercolor: 'mm',
  setbeamerfont: 'mm', urlstyle: 'm', allowdisplaybreaks: 'o', DeclareUnicodeCharacter: 'mm',
  newacronym: 'ommm', loadglossarystyle: 'm', setglossarystyle: 'm', rule: 'omm', pagebreak: 'o',
  nopagebreak: 'o', nolinebreak: 'o', special: 'm', pdfbookmark: 'omm', bookmark: 'om',
  pgfdeclarelayer: 'm', pgfsetlayers: 'm', tcbuselibrary: 'm', tcbset: 'm', mdfsetup: 'm',
  lstdefinestyle: 'mm', lstdefinelanguage: 'omom', chaptermark: 'm', sectionmark: 'm', setcitestyle: 'm',
  citestyle: 'm', bibpunct: 'ommmmmm', noalign: 'm', arrayrulecolor: 'om', rowcolor: 'om',
  columncolor: 'om', cellcolor: 'om', rowcolors: 'smmm', setkeys: 'mm', newsavebox: 'm', sbox: 'mm',
  savebox: 'moom', usebox: 'm', cline: 'm', cmidrule: 'om', addlinespace: 'o', specialrule: 'mmm',
  hhline: 'm', frametitle: 'm', framesubtitle: 'm', institute: 'om', titlegraphic: 'm', logo: 'm',
  subject: 'm', glsaddall: 'o', setuptoc: 'mm', KOMAoptions: 'm', setkomafont: 'mm',
  addtokomafont: 'mm', twocolumn: 'o', settocdepth: 'm',
  setsecnumdepth: 'm', SetKwInOut: 'mm', SetKw: 'mm', SetAlgoLined: '', DontPrintSemicolon: '',
  LinesNumbered: '', algrenewcommand: 'mm', algnewcommand: 'mm', resetcounter: 'm', newpagestyle: 'mm',
  pdfinfo: 'm', acrodef: 'mom', ifthenelse: 'mmm'
}

/** Length/number registers: `\parindent=0pt`, `\itemsep 2pt plus 1pt` consume their value. */
const REGISTERS = new Set([
  'itemsep', 'parsep', 'parskip', 'parindent', 'topsep', 'partopsep', 'baselineskip', 'tabcolsep',
  'arrayrulewidth', 'columnsep', 'labelsep', 'leftmargin', 'rightmargin', 'labelwidth', 'itemindent',
  'abovecaptionskip', 'belowcaptionskip', 'textfloatsep', 'floatsep', 'intextsep', 'hoffset', 'voffset',
  'oddsidemargin', 'evensidemargin', 'topmargin', 'headheight', 'headsep', 'footskip', 'textheight',
  'textwidth', 'linewidth', 'columnwidth', 'hsize', 'vsize', 'vskip', 'hskip', 'kern', 'penalty',
  'tolerance', 'emergencystretch', 'clubpenalty', 'widowpenalty', 'displaywidowpenalty',
  'interlinepenalty', 'hyphenpenalty', 'exhyphenpenalty', 'brokenpenalty', 'predisplaypenalty',
  'postdisplaypenalty', 'abovedisplayskip', 'belowdisplayskip', 'abovedisplayshortskip',
  'belowdisplayshortskip', 'jot', 'lineskip', 'lineskiplimit', 'fboxsep', 'fboxrule', 'doublerulesep',
  'extrarowheight', 'arraycolsep', 'mathsurround', 'unitlength', 'footnotesep', 'marginparwidth',
  'marginparsep', 'looseness', 'vbadness', 'hbadness', 'hfuzz', 'vfuzz', 'overfullrule', 'pretolerance',
  'linepenalty', 'adjdemerits', 'skip', 'mskip', 'mkern', 'baselinestretch'
])

const DEFINITIONS = new Set([
  'newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand', 'def', 'gdef', 'edef', 'xdef',
  'let', 'DeclareMathOperator', 'NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand',
  'DeclareDocumentCommand', 'NewExpandableDocumentCommand', 'newenvironment', 'renewenvironment',
  'provideenvironment', 'NewDocumentEnvironment', 'RenewDocumentEnvironment', 'newcolumntype', 'newif',
  'newcounter', 'newlength', 'DeclarePairedDelimiter', 'DeclarePairedDelimiterX', 'DeclareMathAlphabet',
  'DeclareSymbolFont', 'DeclareMathSymbol', 'SetMathAlphabet', 'DeclareFontFamily', 'DeclareFontShape',
  'newrobustcmd', 'renewrobustcmd', 'providerobustcmd'
])

const REF_COMMANDS = new Set([
  'ref', 'eqref', 'autoref', 'Autoref', 'cref', 'Cref', 'pageref', 'nameref', 'vref', 'Vref', 'subref',
  'cpageref', 'Cpageref', 'labelcref', 'fullref'
])

const CITE_COMMANDS = new Set([
  'cite', 'citep', 'citet', 'citealp', 'citealt', 'citenum', 'Citep', 'Citet', 'parencite', 'Parencite',
  'textcite', 'Textcite', 'autocite', 'Autocite', 'footcite', 'supercite', 'smartcite', 'fullcite',
  'citeauthor', 'Citeauthor', 'citeyear', 'citeyearpar', 'citetitle', 'citeurl'
])
const TEXT_CITES = new Set(['citeauthor', 'Citeauthor', 'citeyear', 'citetitle', 'citeurl'])

const REF_NAMES: Record<string, [string, string]> = {
  part: ['Part', 'part'], chapter: ['Chapter', 'chapter'], section: ['Section', 'section'],
  subsection: ['Section', 'section'], subsubsection: ['Section', 'section'], paragraph: ['Paragraph', 'paragraph'],
  subparagraph: ['Paragraph', 'paragraph'], appendix: ['Appendix', 'appendix'], figure: ['Figure', 'fig.'],
  table: ['Table', 'table'], equation: ['Equation', 'eq.'], item: ['Item', 'item'],
  algorithm: ['Algorithm', 'algorithm'], listing: ['Listing', 'listing'], footnote: ['Footnote', 'footnote']
}

const LIST_KINDS: Record<string, 'itemize' | 'enumerate' | 'description'> = {
  itemize: 'itemize', enumerate: 'enumerate', description: 'description', compactitem: 'itemize',
  compactenum: 'enumerate', compactdesc: 'description', asparaitem: 'itemize', asparaenum: 'enumerate',
  inparaitem: 'itemize', inparaenum: 'enumerate', 'itemize*': 'itemize', 'enumerate*': 'enumerate',
  'description*': 'description', todolist: 'itemize', checklist: 'itemize', outline: 'enumerate'
}
const BULLETS = ['•', '–', '∗', '·']

const FLOATS: Record<string, string> = {
  figure: 'figure', 'figure*': 'figure', wrapfigure: 'figure', sidewaysfigure: 'figure', SCfigure: 'figure',
  marginfigure: 'figure', table: 'table', 'table*': 'table', wraptable: 'table', sidewaystable: 'table',
  SCtable: 'table', margintable: 'table', algorithm: 'algorithm', 'algorithm*': 'algorithm',
  algorithm2e: 'algorithm', listing: 'listing'
}
const FLOAT_NAMES: Record<string, string> = { figure: 'Figure', table: 'Table', algorithm: 'Algorithm', listing: 'Listing' }

const TABULARS = new Set([
  'tabular', 'tabular*', 'tabularx', 'tabulary', 'longtable', 'longtable*', 'array', 'supertabular',
  'xtabular', 'mpsupertabular', 'xltabular', 'tabu'
])
const VERBATIMS = new Set([
  'verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'BVerbatim', 'LVerbatim', 'lstlisting', 'minted',
  'alltt', 'spverbatim', 'code', 'Code', 'sourcecode', 'filecontents', 'filecontents*', 'comment',
  'lstinputlisting'
])
const PICTURES = new Set([
  'tikzpicture', 'pgfpicture', 'circuitikz', 'forest', 'picture', 'pspicture', 'asy', 'tikzcd', 'dot2tex',
  'gnuplot', 'pythontex'
])
const QUOTES = new Set(['quote', 'quotation', 'verse'])

const DEFAULT_THEOREMS: Record<string, [string, string]> = {
  theorem: ['Theorem', 'plain'], lemma: ['Lemma', 'plain'], proposition: ['Proposition', 'plain'],
  corollary: ['Corollary', 'plain'], conjecture: ['Conjecture', 'plain'], claim: ['Claim', 'plain'],
  fact: ['Fact', 'plain'], definition: ['Definition', 'definition'], example: ['Example', 'definition'],
  exercise: ['Exercise', 'definition'], problem: ['Problem', 'definition'], assumption: ['Assumption', 'definition'],
  axiom: ['Axiom', 'definition'], hypothesis: ['Hypothesis', 'definition'], question: ['Question', 'definition'],
  notation: ['Notation', 'definition'], remark: ['Remark', 'remark'], note: ['Note', 'remark'],
  observation: ['Observation', 'remark']
}

/** KaTeX lacks these; the user's own definitions win. */
const COMPAT_MACROS: MacroMap = {
  '\\mathbbm': '\\mathbb{#1}',
  '\\mathds': '\\mathbb{#1}',
  '\\qedhere': '',
  '\\nobreakdash': ''
}

const MAX_DEPTH = 48
const MAX_EXPANSIONS = 5000

// ---------------------------------------------------------------------------------------------
// Types

type Reason = 'end' | 'env' | 'ancestor' | 'item' | 'bibitem'
interface Stop {
  env?: string
  item?: boolean
  bibitem?: boolean
}
interface Range {
  s: number
  e: number
}
interface LabelInfo {
  num: string
  kind: string
  /** Display name for `\autoref`/`\cref` when the kind has none of its own (theorems). */
  name?: string
  titleHtml?: string
}
interface MathItem {
  tex: string
  display: boolean
  raw: string
  body: string
  html?: string
}
interface CiteItem {
  keys: string[]
  pre: string
  post: string
  text: boolean
}
interface OutlineRec {
  level: number
  titleHtml: string
  number: string | null
  line: number
}
interface TheoremDef {
  title: string
  counter: string
  numbered: boolean
  style: string
}
interface Meta {
  text: string
  line: number
}
interface TableRow {
  top: string[]
  clines: Array<[number, number]>
  bottom: string[]
  cells: Range[]
  line: number
}
interface TableSegment {
  rows: TableRow[]
  trailing: string[]
  marker: string | null
}
interface Column {
  align: string
  width: string | null
}

/** Output buffer for one flow: finished blocks plus the paragraph being built (block mode), or a
 *  single inline run (inline mode). */
class Sink {
  readonly blocks: string[] = []
  par: string[] = []
  /** The paragraph (or run) has visible content. */
  has = false
  line = 1
  /** Start of the token being processed: a paragraph's line is where its first content starts. */
  at = 0
  space = true
  decls: string[] = []
  /** How many of `decls` have their span open in `par`. */
  open = 0
  scopes: Array<{ decls: number; align: string | null }> = []
  align: string | null = null
  noindent = false
  /** Text right after display math continues the paragraph (no indent). */
  cont = false
  afterHeading = false
  /** Run-in head (theorem title, `\paragraph`) for the next paragraph. */
  leader: string | null = null
  leaderLine = 1
  constructor(readonly block: boolean) {}
}

const SPECIAL = new Uint8Array(128)
for (const ch of '\n \t\r%\\{}$~`\'-') SPECIAL[ch.charCodeAt(0)] = 1

// ---------------------------------------------------------------------------------------------
// Renderer

class Renderer {
  s: string
  pos = 0
  private lineOverride = 0
  private readonly lineStarts: number[] = [0]
  private readonly macros: MacroMap
  private readonly katexMacros: MacroMap
  private readonly beginAliases = new Map<string, string>()
  private readonly endAliases = new Map<string, string>()
  private readonly labels = new Map<string, LabelInfo>()
  private readonly refs: Array<{ keys: string[]; kind: string }> = []
  private readonly cites: CiteItem[] = []
  private readonly maths: MathItem[] = []
  private readonly footnotes: Array<{ mark: string; html: string }> = []
  private readonly outline: OutlineRec[] = []
  private readonly bibitems = new Map<string, string>()
  private readonly theorems = new Map<string, TheoremDef>()
  private readonly thmCounters = new Map<string, { value: number; within: string | null }>()
  private readonly meta: { title: Meta | null; author: Meta | null; date: Meta | null; subtitle: Meta | null; affils: Meta[] } = {
    title: null,
    author: null,
    date: null,
    subtitle: null,
    affils: []
  }
  private thmStyle = 'plain'
  private currentLabel: LabelInfo = { num: '', kind: 'none' }
  private readonly envStack: string[] = []
  private depth = 0
  private expansions = 0
  /** Characters macros may add in total: a few times the source, so a crafted file cannot
   *  blow one keystroke up into megabytes of HTML. */
  private expansionBudget = 0
  private macroDepth = 0
  private words = 0
  private inWord = false
  private counting = true
  private hasChapters = false
  private appendix = false
  private part = 0
  private chapter = 0
  private section = 0
  private subsection = 0
  private subsubsection = 0
  private eq = 0
  private readonly floatCounters: Record<string, number> = { figure: 0, table: 0, algorithm: 0, listing: 0 }
  private floatKind: string | null = null
  private inSubfloat = false
  private subCounter = 0
  private fnCounter = 0
  private thanksCounter = 0
  private bibCounter = 0
  private enumDepth = 0
  private itemDepth = 0
  private readonly enumValues: string[] = []
  private quoteDepth = 0
  private readonly nextEq = (): number => ++this.eq

  constructor(source: string, private readonly opts: PreviewOptions) {
    this.expansionBudget = Math.max(200_000, source.length * 4)
    this.s = source
    for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) this.lineStarts.push(i + 1)
    this.macros = extractMacros(source)
    this.katexMacros = { ...COMPAT_MACROS, ...this.macros }
    for (const key of Object.keys(this.macros)) {
      const body = this.macros[key]
      const name = key.slice(1)
      let m = /^\s*\\begin\s*\{([^{}]+)\}\s*$/.exec(body)
      if (m) this.beginAliases.set(name, m[1].trim())
      m = /^\s*\\end\s*\{([^{}]+)\}\s*$/.exec(body)
      if (m) this.endAliases.set(name, m[1].trim())
    }
  }

  run(): PreviewResult {
    const s = this.s
    const begin = findUncommented(s, /\\begin\s*\{document\}/g, 0)
    let bodyStart = 0
    if (begin) {
      this.scanPreamble(begin.index)
      bodyStart = begin.index + begin.length
    }
    const endDoc = findUncommented(s, /\\end\s*\{document\}/g, bodyStart)
    const bodyEnd = endDoc ? endDoc.index : s.length
    this.hasChapters = findUncommented(s, /\\chapter(?![a-zA-Z])/g, bodyStart, bodyEnd) !== null
    const sink = new Sink(true)
    this.pos = bodyStart
    for (let guard = 0; this.pos < bodyEnd && guard < 1000; guard++) {
      const before = this.pos
      if (this.flow(sink, bodyEnd, {}) === 'end') break
      if (this.pos <= before) this.pos = before + 1
    }
    let html = this.finish(sink)
    if (this.footnotes.length > 0) {
      html += '<section class="rt-footnotes" aria-label="Footnotes"><ol class="rt-footnote-list">'
      for (const f of this.footnotes) {
        html += `<li class="rt-footnote" data-fn="${esc(f.mark)}"><span class="rt-fn-mark">${esc(f.mark)}</span> ${f.html.replace(/ data-line="\d+"/g, '')}</li>`
      }
      html += '</ol></section>'
    }
    html = this.resolve(html)
    const outline = this.outline.map((o) => ({ level: o.level, title: this.plain(o.titleHtml), number: o.number, line: o.line }))
    return { html, outline, wordCount: this.words }
  }

  // ----- positions ----------------------------------------------------------------------------

  private lineAt(pos: number): number {
    if (this.lineOverride) return this.lineOverride
    const ls = this.lineStarts
    let lo = 0
    let hi = ls.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ls[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  private withSource<T>(text: string, line: number, fn: () => T): T {
    const s = this.s
    const pos = this.pos
    const override = this.lineOverride
    this.s = text
    this.pos = 0
    this.lineOverride = line > 0 ? line : 1
    try {
      return fn()
    } finally {
      this.s = s
      this.pos = pos
      this.lineOverride = override
    }
  }

  private raw(r: Range | null): string {
    return r ? this.s.slice(r.s, r.e) : ''
  }

  /** `\n` at `i` followed by a blank line. */
  private isParBreak(i: number, end: number): boolean {
    const s = this.s
    for (let j = i + 1; j < end; j++) {
      const c = s.charCodeAt(j)
      if (c === 10) return true
      if (c !== 32 && c !== 9 && c !== 13) return false
    }
    return false
  }

  private skipIndent(p: number, end: number): number {
    const s = this.s
    while (p < end) {
      const c = s.charCodeAt(p)
      if (c === 32 || c === 9 || c === 13) p++
      else break
    }
    return p
  }

  private skipBlank(p: number, end: number): number {
    const s = this.s
    while (p < end) {
      const c = s.charCodeAt(p)
      if (c === 32 || c === 9 || c === 13 || c === 10) p++
      else break
    }
    return p
  }

  /** `%` at `p`: TeX drops the rest of the line, its end and the next line's indentation. */
  private skipComment(p: number, end: number): number {
    const nl = this.s.indexOf('\n', p)
    if (nl === -1 || nl >= end) return end
    if (this.isParBreak(nl, end)) return nl
    return this.skipIndent(nl + 1, end)
  }

  /** Spaces after a control word (one line end, never a paragraph break). */
  private skipCmdSpace(end: number): void {
    let p = this.skipIndent(this.pos, end)
    if (p < end && this.s.charCodeAt(p) === 10 && !this.isParBreak(p, end)) p = this.skipIndent(p + 1, end)
    this.pos = p
  }

  /** Spaces, single line ends and comments before an argument. */
  private skipArgSpace(end: number): void {
    const s = this.s
    let p = this.pos
    while (p < end) {
      const c = s.charCodeAt(p)
      if (c === 32 || c === 9 || c === 13) p++
      else if (c === 10) {
        if (this.isParBreak(p, end)) break
        p++
      } else if (c === 37) {
        const nl = s.indexOf('\n', p)
        p = nl === -1 || nl >= end ? end : nl
      } else break
    }
    this.pos = p
  }

  private star(end: number): boolean {
    this.skipArgSpace(end)
    if (this.pos < end && this.s.charCodeAt(this.pos) === 42) {
      this.pos++
      return true
    }
    return false
  }

  /** Index after `\verb<d>..<d>` whose delimiter search starts at `i` (just after `verb`). */
  private skipVerbAt(i: number, end: number): number {
    const s = this.s
    if (s[i] === '*') i++
    const d = s[i]
    if (!d || d === '\n' || d === ' ') return i
    const close = s.indexOf(d, i + 1)
    const nl = s.indexOf('\n', i + 1)
    if (close === -1 || close >= end || (nl !== -1 && nl < close)) return nl === -1 || nl > end ? end : nl
    return close + 1
  }

  /** Env name in `{..}` at or after `j`. */
  private peekEnvName(j: number, end: number): { name: string; next: number } | null {
    const s = this.s
    while (j < end && (s[j] === ' ' || s[j] === '\t')) j++
    if (s[j] !== '{') return null
    const close = s.indexOf('}', j + 1)
    if (close === -1 || close >= end || close - j > 64) return null
    return { name: s.slice(j + 1, close).trim(), next: close + 1 }
  }

  /**
   * End of a `{..}` group opening at `open`. Short arguments stop at a paragraph break, and any
   * argument stops at an `\end` it did not open (unless `strict`, used for definitions).
   */
  private groupEnd(open: number, end: number, long: boolean, strict: boolean): { inner: number; next: number } {
    const s = this.s
    let depth = 0
    let envs = 0
    for (let i = open; i < end; i++) {
      const c = s.charCodeAt(i)
      if (c === 92) {
        const n = s.charCodeAt(i + 1)
        if (!isLetter(n)) {
          i++
          continue
        }
        let j = i + 1
        while (j < end && isLetter(s.charCodeAt(j))) j++
        const word = s.slice(i + 1, j)
        if (!strict) {
          if (word === 'begin' || this.beginAliases.has(word)) envs++
          else if (word === 'end' || this.endAliases.has(word)) {
            if (envs === 0) return { inner: i, next: i }
            envs--
          } else if (word === 'verb') j = this.skipVerbAt(j, end)
        }
        i = j - 1
      } else if (c === 123) depth++
      else if (c === 125) {
        depth--
        if (depth === 0) return { inner: i, next: i + 1 }
      } else if (c === 37) {
        const nl = s.indexOf('\n', i)
        if (nl === -1 || nl >= end) break
        i = nl - 1
      } else if (c === 10 && !long && this.isParBreak(i, end)) return { inner: i, next: i }
    }
    return { inner: end, next: end }
  }

  private readArg(end: number, long = false, strict = false): Range | null {
    this.skipArgSpace(end)
    const s = this.s
    const p = this.pos
    if (p >= end) return null
    const c = s.charCodeAt(p)
    if (c === 123) {
      const g = this.groupEnd(p, end, long, strict)
      this.pos = g.next
      return { s: p + 1, e: g.inner }
    }
    if (c === 125 || c === 10) return null
    if (c === 92) {
      let j = p + 1
      if (j < end && isLetter(s.charCodeAt(j))) {
        while (j < end && isLetter(s.charCodeAt(j))) j++
      } else j = Math.min(j + 1, end)
      this.pos = j
      return { s: p, e: j }
    }
    this.pos = c >= 0xd800 && c <= 0xdbff ? Math.min(p + 2, end) : p + 1
    return { s: p, e: this.pos }
  }

  private readOpt(end: number, sameLine = false): Range | null {
    const save = this.pos
    if (sameLine) this.pos = this.skipIndent(this.pos, end)
    else this.skipArgSpace(end)
    const s = this.s
    const p = this.pos
    if (p >= end || s.charCodeAt(p) !== 91) {
      this.pos = save
      return null
    }
    let depth = 0
    for (let i = p + 1; i < end; i++) {
      const c = s.charCodeAt(i)
      if (c === 92) i++
      else if (c === 123) depth++
      else if (c === 125) {
        if (depth === 0) break
        depth--
      } else if (c === 93 && depth === 0) {
        this.pos = i + 1
        return { s: p + 1, e: i }
      } else if (c === 10 && this.isParBreak(i, end)) break
    }
    this.pos = save
    return null
  }

  /** `{..}` of a URL: braces only (`%` and `#` are literal there). */
  private readUrl(end: number): string {
    this.skipArgSpace(end)
    const s = this.s
    const p = this.pos
    if (s.charCodeAt(p) !== 123) {
      const r = this.readArg(end)
      return this.raw(r)
    }
    let depth = 0
    for (let i = p; i < end; i++) {
      const c = s.charCodeAt(i)
      if (c === 92) i++
      else if (c === 123) depth++
      else if (c === 125) {
        depth--
        if (depth === 0) {
          this.pos = i + 1
          return s.slice(p + 1, i)
        }
      } else if (c === 10 && this.isParBreak(i, end)) {
        this.pos = i
        return s.slice(p + 1, i)
      }
    }
    this.pos = end
    return s.slice(p + 1, end)
  }

  private skipSpec(spec: string, end: number): void {
    for (const k of spec) {
      if (k === 's') this.star(end)
      else if (k === 'o') this.readOpt(end)
      else this.readArg(end)
    }
  }

  /** `\parindent=0pt`, `\vskip 1em plus 2pt`: consumes the value. */
  private skipRegisterValue(end: number): void {
    const s = this.s
    let p = this.skipIndent(this.pos, end)
    let assigned = false
    if (s[p] === '=') {
      assigned = true
      p = this.skipIndent(p + 1, end)
    }
    const rest = s.slice(p, Math.min(end, p + 96))
    const unit = '(?:true\\s*)?(?:pt|em|ex|mm|cm|in|bp|pc|sp|dd|cc|mu|px|fill+|\\\\[a-zA-Z]+)'
    const num = '[-+]?\\s*(?:\\d+(?:[.,]\\d*)?|[.,]\\d+)'
    const re = new RegExp(`^(?:${num}\\s*${unit}?|\\\\[a-zA-Z]+)(?:\\s*plus\\s*${num}\\s*${unit}?)?(?:\\s*minus\\s*${num}\\s*${unit}?)?`)
    const m = re.exec(rest)
    if (m && (assigned || !m[0].startsWith('\\'))) this.pos = p + m[0].length
  }

  // ----- emission -----------------------------------------------------------------------------

  private start(sink: Sink): void {
    if (sink.has) return
    sink.has = true
    if (sink.block) {
      sink.line = sink.leader !== null ? sink.leaderLine : this.lineAt(sink.at)
      for (const d of sink.decls) sink.par.push(`<span class="${d}">`)
      sink.open = sink.decls.length
    }
  }

  private put(sink: Sink, html: string): void {
    this.start(sink)
    sink.par.push(html)
    sink.space = false
  }

  private text(sink: Sink, str: string): void {
    if (str.length === 0) return
    this.start(sink)
    sink.par.push(esc(str))
    sink.space = false
    if (this.counting) this.count(str)
  }

  private space(sink: Sink): void {
    this.inWord = false
    if (sink.space || (sink.block && !sink.has)) return
    sink.par.push(' ')
    sink.space = true
  }

  private count(str: string): void {
    let inWord = this.inWord
    let n = 0
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i)
      if (c < 128) {
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
          if (!inWord) {
            n++
            inWord = true
          }
        } else if (c !== 39 && c !== 45) inWord = false
      } else if (isCJK(c)) {
        n++
        inWord = false
      } else if (c === 0x2019) {
        // apostrophe inside a word
      } else if (WORD_RE.test(str[i])) {
        if (!inWord) {
          n++
          inWord = true
        }
      } else inWord = false
    }
    this.words += n
    this.inWord = inWord
  }

  private declare(sink: Sink, cls: string): void {
    sink.decls.push(cls)
    if (!sink.block || sink.has) {
      sink.par.push(`<span class="${cls}">`)
      sink.open++
    }
  }

  private openScope(sink: Sink): void {
    sink.scopes.push({ decls: sink.decls.length, align: sink.align })
  }

  private closeScope(sink: Sink): void {
    const scope = sink.scopes.pop()
    if (!scope) return
    while (sink.decls.length > scope.decls) {
      sink.decls.pop()
      if (sink.open > sink.decls.length) {
        sink.par.push('</span>')
        sink.open--
      }
    }
    sink.align = scope.align
  }

  private closeScopesTo(sink: Sink, n: number): void {
    while (sink.scopes.length > n) this.closeScope(sink)
  }

  private flush(sink: Sink, trailer = ''): void {
    if (!sink.block) return
    if (sink.has) {
      while (sink.par.length > 0 && sink.par[sink.par.length - 1] === ' ') sink.par.pop()
      let html = sink.par.join('')
      for (let i = 0; i < sink.open; i++) html += '</span>'
      const noindent = sink.noindent || sink.cont || sink.afterHeading || sink.leader !== null
      const cls = `rt-par${noindent ? ' rt-noindent' : ''}${sink.align ? ` rt-al-${sink.align}` : ''}`
      const lead = sink.leader ?? ''
      sink.leader = null
      sink.blocks.push(`<div class="${cls}" data-line="${sink.line}">${lead}${html}${trailer}</div>`)
      sink.afterHeading = false
      sink.cont = false
    }
    sink.par = []
    sink.has = false
    sink.open = 0
    sink.space = true
    sink.noindent = false
  }

  private block(sink: Sink, html: string, kind?: 'heading' | 'display'): void {
    if (!sink.block) {
      this.put(sink, html)
      return
    }
    this.flush(sink)
    if (sink.leader !== null) {
      sink.blocks.push(`<div class="rt-par rt-noindent" data-line="${sink.leaderLine}">${sink.leader}</div>`)
      sink.leader = null
    }
    sink.blocks.push(html)
    sink.afterHeading = kind === 'heading'
    sink.cont = kind === 'display'
  }

  private parBreak(sink: Sink): void {
    this.inWord = false
    if (sink.block) {
      this.flush(sink)
      sink.cont = false
    } else if (sink.has && !sink.space) {
      sink.par.push('<br>')
      sink.space = true
    }
  }

  private finish(sink: Sink, trailer = ''): string {
    if (!sink.block) {
      while (sink.par.length > 0 && sink.par[sink.par.length - 1] === ' ') sink.par.pop()
      let html = sink.par.join('')
      for (let i = 0; i < sink.open; i++) html += '</span>'
      return html + trailer
    }
    if (sink.has) this.flush(sink, trailer)
    else if (sink.leader !== null) {
      sink.blocks.push(`<div class="rt-par rt-noindent" data-line="${sink.leaderLine}">${sink.leader}${trailer}</div>`)
      sink.leader = null
    } else if (trailer) sink.blocks.push(`<div class="rt-par rt-noindent rt-qed-line">${trailer}</div>`)
    return sink.blocks.join('')
  }

  /** Renders a range as an inline run. */
  private inline(r: Range | null): string {
    if (!r || r.e <= r.s) return ''
    if (this.depth >= MAX_DEPTH) return esc(this.s.slice(r.s, r.e))
    this.depth++
    const save = this.pos
    const sink = new Sink(false)
    this.pos = r.s
    try {
      for (let guard = 0; this.pos < r.e && guard < 256; guard++) {
        const before = this.pos
        const reason = this.flow(sink, r.e, {})
        if (reason === 'end') break
        if (reason === 'ancestor') {
          // An `\end` that belongs outside this run: drop it.
          this.pos += 4
          this.readArg(r.e)
        }
        if (this.pos <= before) this.pos = before + 1
      }
    } finally {
      this.pos = save
      this.depth--
    }
    return this.finish(sink)
  }

  private inlineString(text: string, line: number, count = false): string {
    const saved = this.counting
    if (!count) this.counting = false
    try {
      return this.withSource(text, line, () => this.inline({ s: 0, e: text.length }))
    } finally {
      this.counting = saved
    }
  }

  private uncounted<T>(fn: () => T): T {
    const saved = this.counting
    this.counting = false
    try {
      return fn()
    } finally {
      this.counting = saved
    }
  }

  // ----- the flow loop ------------------------------------------------------------------------

  private flow(sink: Sink, end: number, stop: Stop): Reason {
    const s = this.s
    while (this.pos < end) {
      const pos = this.pos
      sink.at = pos
      const c = s.charCodeAt(pos)
      if (c >= 128 || SPECIAL[c] === 0) {
        let j = pos + 1
        while (j < end) {
          const d = s.charCodeAt(j)
          if (d < 128 && SPECIAL[d] === 1) break
          j++
        }
        this.text(sink, s.slice(pos, j))
        this.pos = j
        continue
      }
      switch (c) {
        case 10:
          if (this.isParBreak(pos, end)) {
            this.parBreak(sink)
            this.pos = this.skipBlank(pos, end)
          } else {
            this.space(sink)
            this.pos = this.skipIndent(pos + 1, end)
          }
          break
        case 32:
        case 9:
        case 13:
          this.space(sink)
          this.pos = this.skipIndent(pos + 1, end)
          break
        case 37:
          this.pos = this.skipComment(pos, end)
          break
        case 92: {
          const reason = this.backslash(sink, end, stop)
          if (reason !== null) return reason
          if (this.pos <= pos) this.pos = pos + 1
          break
        }
        case 123:
          this.openScope(sink)
          this.pos = pos + 1
          break
        case 125:
          this.closeScope(sink)
          this.pos = pos + 1
          break
        case 36:
          this.dollar(sink, end)
          if (this.pos <= pos) this.pos = pos + 1
          break
        case 126:
          this.put(sink, '&nbsp;')
          this.inWord = false
          this.pos = pos + 1
          break
        case 96:
        case 39: {
          const double = pos + 1 < end && s.charCodeAt(pos + 1) === c
          this.text(sink, c === 96 ? (double ? '“' : '‘') : double ? '”' : '’')
          this.pos = pos + (double ? 2 : 1)
          break
        }
        default: {
          // '-': hyphen, en dash, em dash
          let n = 1
          while (n < 3 && pos + n < end && s.charCodeAt(pos + n) === 45) n++
          this.text(sink, n === 3 ? '—' : n === 2 ? '–' : '-')
          this.pos = pos + n
        }
      }
    }
    return 'end'
  }

  private backslash(sink: Sink, end: number, stop: Stop): Reason | null {
    const s = this.s
    const start = this.pos
    if (start + 1 >= end) {
      this.pos = end
      return null
    }
    const c1 = s.charCodeAt(start + 1)
    if (isLetter(c1)) {
      let j = start + 2
      while (j < end && isLetter(s.charCodeAt(j))) j++
      this.pos = j
      return this.command(sink, s.slice(start + 1, j), start, end, stop)
    }
    this.pos = start + 2
    this.symbol(sink, s[start + 1], start, end)
    return null
  }

  private symbol(sink: Sink, ch: string, start: number, end: number): void {
    switch (ch) {
      case '\\':
        this.lineBreak(sink, end)
        return
      case '[':
        this.delimitedMath(sink, start, end, '\\]', true)
        return
      case '(':
        this.delimitedMath(sink, start, end, '\\)', false)
        return
      case ']':
      case ')':
      case '!':
      case '/':
      case '@':
      case '-':
      case '*':
        return
      case ' ':
      case '\n':
      case '\t':
      case '\r':
        if (sink.has || !sink.block) {
          this.put(sink, ' ')
          sink.space = true
        }
        this.inWord = false
        return
      case ',':
        this.put(sink, ' ')
        this.inWord = false
        return
      case ';':
      case ':':
      case '>':
        this.put(sink, ' ')
        this.inWord = false
        return
      case '|':
        this.text(sink, '‖')
        return
      default:
        if (ACCENTS[ch] !== undefined) this.accent(sink, ch, end)
        else this.text(sink, ch)
    }
  }

  private lineBreak(sink: Sink, end: number): void {
    const s = this.s
    if (s[this.pos] === '*') this.pos++
    if (s[this.pos] === '[') this.readOpt(end, true)
    if (sink.block && !sink.has) return
    this.put(sink, '<br>')
    sink.space = true
    this.inWord = false
  }

  private accent(sink: Sink, ch: string, end: number): void {
    const s = this.s
    let base = ''
    const c = s.charCodeAt(this.pos)
    if (c === 123) {
      const r = this.readArg(end)
      base = this.raw(r).trim()
    } else if (c === 92) {
      const r = this.readArg(end)
      base = this.raw(r)
    } else if (this.pos < end && c !== 10 && c !== 32 && c !== 125) {
      base = s[this.pos]
      this.pos++
    }
    if (base.startsWith('\\')) {
      const name = base.slice(1).trim()
      base = name === 'i' ? 'i' : name === 'j' ? 'j' : TEXT_SYMBOLS[name] ?? ''
    }
    if (!base) {
      this.text(sink, SPACING_ACCENTS[ch] ?? '')
      return
    }
    const chars = Array.from(base)
    this.text(sink, (chars[0] + ACCENTS[ch]).normalize('NFC') + chars.slice(1).join(''))
  }

  private command(sink: Sink, name: string, start: number, end: number, stop: Stop): Reason | null {
    // These read the characters right after their name.
    switch (name) {
      case 'verb':
        this.verb(sink, end)
        return null
      case 'lstinline':
      case 'mintinline':
      case 'mint':
        this.inlineCode(sink, name, end)
        return null
    }
    this.skipCmdSpace(end)
    switch (name) {
      case 'begin': {
        const r = this.readArg(end)
        const env = this.raw(r).trim()
        if (env) this.env(sink, env, start, end)
        return null
      }
      case 'end': {
        const r = this.readArg(end)
        return this.endNamed(this.raw(r).trim(), start, stop)
      }
      case 'item':
        if (stop.item) {
          this.pos = start
          return 'item'
        }
        this.strayItem(sink, end)
        return null
      case 'bibitem':
        if (stop.bibitem) {
          this.pos = start
          return 'bibitem'
        }
        this.readOpt(end)
        this.readArg(end)
        return null
      case 'part':
      case 'chapter':
      case 'section':
      case 'subsection':
      case 'subsubsection':
      case 'paragraph':
      case 'subparagraph':
        this.heading(sink, name, start, end, false)
        return null
      case 'addchap':
        this.heading(sink, 'chapter', start, end, true)
        return null
      case 'addsec':
        this.heading(sink, 'section', start, end, true)
        return null
      case 'label': {
        const key = this.raw(this.readArg(end)).trim()
        if (key) this.labels.set(key, this.currentLabel)
        return null
      }
      case 'crefrange':
      case 'Crefrange':
      case 'crefrange*': {
        const a = this.raw(this.readArg(end)).trim()
        const b = this.raw(this.readArg(end)).trim()
        this.put(sink, ph('R', this.refs.push({ keys: [a], kind: name === 'Crefrange' ? 'Cref' : 'cref' }) - 1))
        this.text(sink, ' to ')
        this.put(sink, ph('R', this.refs.push({ keys: [b], kind: 'ref' }) - 1))
        return null
      }
      case 'footnote':
        this.footnote(sink, end, 'footnote')
        return null
      case 'footnotemark':
        this.footnote(sink, end, 'mark')
        return null
      case 'footnotetext':
        this.footnote(sink, end, 'text')
        return null
      case 'thanks':
        this.footnote(sink, end, 'thanks')
        return null
      case 'href':
        this.href(sink, end)
        return null
      case 'url':
      case 'nolinkurl':
      case 'path': {
        const url = this.readUrl(end)
        const shown = url.replace(/\\([%#&_~$])/g, '$1')
        const safe = name === 'url' ? safeUrl(url) : null
        this.put(sink, safe ? `<a class="rt-link rt-url" data-href="${esc(safe)}">${esc(shown)}</a>` : `<span class="rt-url">${esc(shown)}</span>`)
        this.inWord = false
        return null
      }
      case 'includegraphics':
        this.graphics(sink, end)
        return null
      case 'caption':
        this.caption(sink, start, end, null)
        return null
      case 'captionof': {
        this.star(end)
        const type = this.raw(this.readArg(end)).trim()
        this.caption(sink, start, end, FLOATS[type] ?? type)
        return null
      }
      case 'subfloat':
      case 'subcaptionbox':
        this.subfloatCommand(sink, name, start, end)
        return null
      case 'maketitle':
        this.maketitle(sink, start)
        return null
      case 'title':
      case 'author':
      case 'date':
      case 'subtitle':
      case 'affil':
      case 'affiliation':
        this.metaCommand(name, end)
        return null
      case 'tableofcontents':
        this.block(sink, `<nav class="rt-toc" data-line="${this.lineAt(start)}"><div class="rt-toc-title">Contents</div>${ph('T', 0)}</nav>`)
        return null
      case 'appendix':
        this.startAppendix()
        return null
      case 'newpage':
      case 'clearpage':
      case 'cleardoublepage':
        this.pageBreak(sink, start)
        return null
      case 'noindent':
        if (sink.block && !sink.has) sink.noindent = true
        return null
      case 'centering':
      case 'Centering':
        sink.align = 'c'
        return null
      case 'raggedright':
      case 'RaggedRight':
        sink.align = 'l'
        return null
      case 'raggedleft':
      case 'RaggedLeft':
        sink.align = 'r'
        return null
      case 'par':
        this.parBreak(sink)
        return null
      case 'newline':
        this.lineBreak(sink, end)
        return null
      case 'linebreak':
        this.readOpt(end, true)
        this.lineBreak(sink, end)
        return null
      case 'hspace':
        this.star(end)
        this.readArg(end)
        this.put(sink, ' ')
        this.inWord = false
        return null
      case 'today':
        this.text(sink, today())
        return null
      case 'ensuremath': {
        const r = this.readArg(end)
        this.inlineMath(sink, this.raw(r), this.s.slice(start, this.pos))
        return null
      }
      case 'iffalse':
        this.skipConditional(end)
        return null
      case 'newtheorem':
        this.newTheorem(end)
        return null
      case 'theoremstyle':
        this.thmStyle = this.raw(this.readArg(end)).trim() || 'plain'
        return null
      case 'input':
      case 'include':
      case 'subfile':
      case 'import':
      case 'subimport':
      case 'inputminted':
      case 'lstinputlisting':
      case 'verbatiminput':
        this.inputFile(sink, name, start, end)
        return null
      case 'bibliography':
      case 'printbibliography':
        this.externalBibliography(sink, name, start, end)
        return null
      case 'tikz':
        this.readOpt(end)
        if (this.s.charCodeAt(this.pos) === 123) this.readArg(end, true, true)
        else {
          const semi = this.s.indexOf(';', this.pos)
          this.pos = semi === -1 || semi >= end ? end : semi + 1
        }
        this.put(sink, '<span class="rt-graphic rt-picture rt-graphic-inline"><span class="rt-graphic-name">TikZ</span></span>')
        this.inWord = false
        return null
      case 'enquote':
      case 'textquote': {
        this.star(end)
        const r = this.readArg(end)
        const outer = this.quoteDepth % 2 === 0
        this.quoteDepth++
        const inner = this.inline(r)
        this.quoteDepth--
        this.put(sink, `${outer ? '“' : '‘'}${inner}${outer ? '”' : '’'}`)
        return null
      }
      case 'texorpdfstring': {
        const r = this.readArg(end)
        this.readArg(end)
        this.put(sink, this.inline(r))
        return null
      }
      case 'item@':
        return null
    }
    if (REF_COMMANDS.has(name)) {
      this.star(end)
      const keys = this.raw(this.readArg(end)).split(',').map((k) => k.trim()).filter((k) => k.length > 0)
      this.put(sink, ph('R', this.refs.push({ keys, kind: name }) - 1))
      this.inWord = false
      return null
    }
    if (CITE_COMMANDS.has(name)) {
      this.cite(sink, name, end)
      return null
    }
    const symbol = TEXT_SYMBOLS[name]
    if (symbol !== undefined) {
      this.text(sink, symbol)
      return null
    }
    const space = SPACES[name]
    if (space !== undefined) {
      if (space) this.put(sink, space)
      this.inWord = false
      return null
    }
    const logo = LOGOS[name]
    if (logo !== undefined) {
      this.put(sink, `<span class="rt-logo">${logo}</span>`)
      if (this.counting) this.count(name)
      return null
    }
    if (ACCENTS[name] !== undefined && name.length === 1) {
      this.accent(sink, name, end)
      return null
    }
    const wrap = WRAPPERS[name]
    if (wrap !== undefined) {
      this.skipSpec(wrap.skip, end)
      const html = this.inline(this.readArg(end, wrap.long))
      this.put(sink, wrap.tag ? `<${wrap.tag}${wrap.cls ? ` class="${wrap.cls}"` : ''}>${html}</${wrap.tag}>` : html)
      return null
    }
    const decl = DECLARATIONS[name]
    if (decl !== undefined) {
      this.declare(sink, decl)
      return null
    }
    if (NOOPS.has(name)) return null
    const ignored = IGNORED[name]
    if (ignored !== undefined) {
      this.skipSpec(ignored, end)
      return null
    }
    if (REGISTERS.has(name)) {
      this.skipRegisterValue(end)
      return null
    }
    if (DEFINITIONS.has(name)) {
      this.skipDefinition(name, end)
      return null
    }
    const beginAlias = this.beginAliases.get(name)
    if (beginAlias !== undefined) {
      this.env(sink, beginAlias, start, end)
      return null
    }
    const endAlias = this.endAliases.get(name)
    if (endAlias !== undefined) return this.endNamed(endAlias, start, stop)
    const body = this.macros['\\' + name]
    if (body !== undefined) {
      this.expand(sink, body, start, end)
      return null
    }
    // Unknown: drop the name (and a star or optional argument); its braces render as groups.
    if (this.s.charCodeAt(this.pos) === 42) this.pos++
    if (this.s.charCodeAt(this.pos) === 91) this.readOpt(end, true)
    this.inWord = false
    return null
  }

  private endNamed(name: string, start: number, stop: Stop): Reason | null {
    if (stop.env !== undefined && name === stop.env) return 'env'
    if (name && this.envStack.includes(name)) {
      this.pos = start
      return 'ancestor'
    }
    return null
  }

  private expand(sink: Sink, body: string, start: number, end: number): void {
    const arity = macroArity(body)
    const args: string[] = []
    for (let i = 0; i < arity; i++) args.push(this.raw(this.readArg(end, true)))
    if (this.expansions >= MAX_EXPANSIONS || this.macroDepth >= 24) return
    this.expansions++
    const text = arity > 0 ? body.replace(/#([1-9#])/g, (_m, d: string) => (d === '#' ? '#' : args[Number(d) - 1] ?? '')) : body
    if (!text || text.length > this.expansionBudget) return
    this.expansionBudget -= text.length
    this.macroDepth++
    try {
      this.withSource(text, this.lineAt(start), () => {
        for (let guard = 0; this.pos < text.length && guard < 64; guard++) {
          const before = this.pos
          const reason = this.flow(sink, text.length, {})
          if (reason === 'end' || reason === 'ancestor') break
          if (this.pos <= before) this.pos = before + 1
        }
      })
    } finally {
      this.macroDepth--
    }
  }

  private skipDefinition(name: string, end: number): void {
    switch (name) {
      case 'def':
      case 'gdef':
      case 'edef':
      case 'xdef': {
        this.readArg(end)
        const open = this.s.indexOf('{', this.pos)
        if (open !== -1 && open < end && open - this.pos <= 80 && !/\n[ \t]*\n/.test(this.s.slice(this.pos, open))) {
          this.pos = open
          this.readArg(end, true, true)
        }
        return
      }
      case 'let':
        this.readArg(end)
        this.skipArgSpace(end)
        if (this.s[this.pos] === '=') this.pos++
        this.readArg(end)
        return
      case 'DeclareMathOperator':
        this.star(end)
        this.readArg(end)
        this.readArg(end, true, true)
        return
      case 'newenvironment':
      case 'renewenvironment':
      case 'provideenvironment':
        this.star(end)
        this.readArg(end)
        this.readOpt(end)
        this.readOpt(end)
        this.readArg(end, true, true)
        this.readArg(end, true, true)
        return
      case 'NewDocumentEnvironment':
      case 'RenewDocumentEnvironment':
        for (let i = 0; i < 4; i++) this.readArg(end, true, true)
        return
      case 'NewDocumentCommand':
      case 'RenewDocumentCommand':
      case 'ProvideDocumentCommand':
      case 'DeclareDocumentCommand':
      case 'NewExpandableDocumentCommand':
      case 'DeclarePairedDelimiter':
        for (let i = 0; i < 3; i++) this.readArg(end, true, true)
        return
      case 'DeclarePairedDelimiterX':
        this.readArg(end)
        this.readOpt(end)
        for (let i = 0; i < 3; i++) this.readArg(end, true, true)
        return
      case 'newcolumntype':
        this.readArg(end)
        this.readOpt(end)
        this.readArg(end, true, true)
        return
      case 'newif':
      case 'newlength':
        this.readArg(end)
        return
      case 'newcounter':
        this.readArg(end)
        this.readOpt(end)
        return
      case 'DeclareMathAlphabet':
      case 'DeclareSymbolFont':
      case 'DeclareFontShape':
        for (let i = 0; i < 5; i++) this.readArg(end)
        return
      case 'DeclareMathSymbol':
        for (let i = 0; i < 4; i++) this.readArg(end)
        return
      case 'SetMathAlphabet':
        for (let i = 0; i < 6; i++) this.readArg(end)
        return
      case 'DeclareFontFamily':
        for (let i = 0; i < 3; i++) this.readArg(end)
        return
      default:
        // \newcommand and friends
        this.star(end)
        this.readArg(end)
        this.readOpt(end)
        this.readOpt(end)
        this.readArg(end, true, true)
    }
  }

  /** `\iffalse .. \else .. \fi`: skips to `\else` or the matching `\fi`. */
  private skipConditional(end: number): void {
    const s = this.s
    let nest = 0
    for (let i = this.pos; i < end; i++) {
      const c = s.charCodeAt(i)
      if (c === 37) {
        const nl = s.indexOf('\n', i)
        if (nl === -1 || nl >= end) break
        i = nl
      } else if (c === 92) {
        let j = i + 1
        while (j < end && isLetter(s.charCodeAt(j))) j++
        if (j === i + 1) {
          i++
          continue
        }
        const word = s.slice(i + 1, j)
        if (word === 'fi' || (word === 'else' && nest === 0)) {
          if (nest === 0) {
            this.pos = j
            return
          }
          nest--
        } else if (word.startsWith('if') && word !== 'iff' && !word.startsWith('ifthenelse') && !word.startsWith('ifstr')) nest++
        i = j - 1
      }
    }
    this.pos = end
  }

  // ----- inline constructs --------------------------------------------------------------------

  private verb(sink: Sink, end: number): void {
    const s = this.s
    let p = this.pos
    let starred = false
    if (s[p] === '*') {
      starred = true
      p++
    }
    const d = s[p]
    if (!d || p >= end || d === '\n' || d === ' ' || isLetter(s.charCodeAt(p))) {
      this.pos = p
      return
    }
    const next = this.skipVerbAt(p, end)
    const close = s[next - 1] === d && next - 1 > p ? next - 1 : next
    let content = s.slice(p + 1, close)
    if (starred) content = content.replace(/ /g, '␣')
    this.pos = next
    this.put(sink, `<code class="rt-verb">${esc(content)}</code>`)
    this.inWord = false
  }

  private inlineCode(sink: Sink, name: string, end: number): void {
    this.readOpt(end, true)
    if (name !== 'lstinline') this.readArg(end) // language
    const s = this.s
    this.pos = this.skipIndent(this.pos, end)
    let content = ''
    if (s.charCodeAt(this.pos) === 123) {
      content = this.readUrl(end)
    } else if (this.pos < end) {
      const p = this.pos
      const next = this.skipVerbAt(p, end)
      content = s.slice(p + 1, s[next - 1] === s[p] && next - 1 > p ? next - 1 : next)
      this.pos = next
    }
    this.put(sink, `<code class="rt-verb">${esc(content)}</code>`)
    this.inWord = false
  }

  private strayItem(sink: Sink, end: number): void {
    const label = this.readOpt(end)
    this.put(sink, `<span class="rt-item-label">${label ? this.inline(label) : '•'}</span> `)
  }

  private chapStr(): string {
    return this.appendix && this.hasChapters ? alpha(this.chapter).toUpperCase() : String(this.chapter)
  }

  private secStr(): string {
    const s = this.appendix && !this.hasChapters ? alpha(this.section).toUpperCase() : String(this.section)
    return this.hasChapters ? `${this.chapStr()}.${s}` : s
  }

  private withinNumber(within: string): string {
    switch (within) {
      case 'chapter':
        return this.chapStr()
      case 'section':
        return this.secStr()
      case 'subsection':
        return `${this.secStr()}.${this.subsection}`
      default:
        return ''
    }
  }

  private resetWithin(level: string): void {
    for (const c of this.thmCounters.values()) if (c.within === level) c.value = 0
  }

  private stepSection(level: number): string | null {
    switch (level) {
      case -1:
        return roman(++this.part).toUpperCase()
      case 0:
        this.chapter++
        this.section = this.subsection = this.subsubsection = 0
        this.resetWithin('chapter')
        return this.chapStr()
      case 1:
        this.section++
        this.subsection = this.subsubsection = 0
        this.resetWithin('section')
        return this.secStr()
      case 2:
        this.subsection++
        this.subsubsection = 0
        this.resetWithin('subsection')
        return `${this.secStr()}.${this.subsection}`
      case 3:
        this.subsubsection++
        return `${this.secStr()}.${this.subsection}.${this.subsubsection}`
      default:
        return null
    }
  }

  private startAppendix(): void {
    if (this.appendix) return
    this.appendix = true
    if (this.hasChapters) this.chapter = 0
    else this.section = 0
    this.subsection = this.subsubsection = 0
  }

  private heading(sink: Sink, name: string, start: number, end: number, forceStar: boolean): void {
    const level = SECTION_LEVELS[name]
    const starred = this.star(end) || forceStar
    const short = this.readOpt(end)
    const title = this.readArg(end)
    const line = this.lineAt(start)
    const number = starred ? null : this.stepSection(level)
    let label: LabelInfo | null = null
    if (number !== null) {
      const top = this.hasChapters ? 0 : 1
      label = { num: number, kind: this.appendix && level === top ? 'appendix' : name }
      this.currentLabel = label
    }
    this.inWord = false
    const titleHtml = this.inline(title)
    this.inWord = false
    const tocHtml = short ? this.uncounted(() => this.inline(short)) : titleHtml
    if (label) label.titleHtml = titleHtml
    this.outline.push({ level, titleHtml: tocHtml, number, line })
    if (level >= 4) {
      // \paragraph and \subparagraph are run-in heads.
      this.flush(sink)
      if (sink.block) {
        if (sink.leader !== null) this.flushLeader(sink)
        sink.leader = `<span class="rt-runin rt-${name}">${titleHtml}</span> `
        sink.leaderLine = line
      } else this.put(sink, `<b class="rt-runin rt-${name}">${titleHtml}</b> `)
      return
    }
    let head = ''
    if (number !== null) {
      head =
        level <= 0
          ? `<span class="rt-heading-label">${level < 0 ? 'Part' : this.appendix ? 'Appendix' : 'Chapter'} ${esc(number)}</span>`
          : `<span class="rt-secnum">${esc(number)}</span>`
    }
    const tag = HEADING_TAGS[level + 1]
    this.block(sink, `<${tag} class="rt-heading rt-${name}" data-line="${line}">${head}${titleHtml}</${tag}>`, 'heading')
  }

  private flushLeader(sink: Sink): void {
    if (sink.leader === null) return
    sink.blocks.push(`<div class="rt-par rt-noindent" data-line="${sink.leaderLine}">${sink.leader}</div>`)
    sink.leader = null
  }

  private footnote(sink: Sink, end: number, kind: 'footnote' | 'mark' | 'text' | 'thanks'): void {
    const opt = kind === 'thanks' ? null : this.readOpt(end)
    let mark: string
    if (opt) mark = this.raw(opt).trim()
    else if (kind === 'thanks') mark = ['*', '†', '‡', '§', '¶', '‖'][this.thanksCounter++ % 6]
    else if (kind === 'text') mark = String(this.fnCounter)
    else mark = String(++this.fnCounter)
    if (kind !== 'mark') {
      const arg = this.readArg(end, true)
      const savedLabel = this.currentLabel
      const savedWord = this.inWord
      this.currentLabel = { num: mark, kind: 'footnote' }
      this.inWord = false
      const html = this.inline(arg)
      this.currentLabel = savedLabel
      this.inWord = savedWord
      this.footnotes.push({ mark, html })
    }
    if (kind !== 'text') this.put(sink, `<sup class="rt-fnref" data-fn="${esc(mark)}">${esc(mark)}</sup>`)
  }

  private href(sink: Sink, end: number): void {
    const url = this.readUrl(end)
    const inner = this.inline(this.readArg(end))
    const safe = safeUrl(url)
    this.put(sink, safe ? `<a class="rt-link" data-href="${esc(safe)}">${inner}</a>` : `<span class="rt-link-text">${inner}</span>`)
  }

  private cite(sink: Sink, name: string, end: number): void {
    this.star(end)
    const o1 = this.readOpt(end)
    const o2 = this.readOpt(end)
    const keys = this.raw(this.readArg(end)).split(',').map((k) => k.trim()).filter((k) => k.length > 0)
    const [pre, post] = this.uncounted(() => (o1 && o2 ? [this.inline(o1), this.inline(o2)] : ['', this.inline(o1)]))
    this.put(sink, ph('C', this.cites.push({ keys, pre, post, text: TEXT_CITES.has(name) }) - 1))
    this.inWord = false
  }

  private graphics(sink: Sink, end: number): void {
    this.star(end)
    const o1 = this.readOpt(end)
    const o2 = this.readOpt(end)
    const file = this.raw(this.readArg(end)).trim()
    let pct: number | null = null
    if (o1 && !o2) {
      const kv = keyValues(this.raw(o1))
      const width = kv.get('width')
      if (width) pct = widthPercent(width)
      const scale = kv.get('scale')
      if (pct === null && scale && /^\d*\.?\d+$/.test(scale.trim())) pct = Math.min(100, Math.max(5, parseFloat(scale) * 100))
    }
    this.put(
      sink,
      `<span class="rt-graphic"${pct !== null ? ` style="width:${pct}%"` : ''} data-file="${esc(file)}" title="${esc(file)}">` +
        `<span class="rt-graphic-icon" aria-hidden="true"></span><span class="rt-graphic-name">${esc(file || 'image')}</span></span>`
    )
    this.inWord = false
  }

  private caption(sink: Sink, start: number, end: number, kind: string | null): void {
    const starred = this.star(end)
    this.readOpt(end)
    const text = this.readArg(end)
    const line = this.lineAt(start)
    const type = kind ?? this.floatKind
    let label = ''
    if (type && !starred) {
      if (this.inSubfloat && kind === null) {
        const letter = alpha(++this.subCounter)
        this.currentLabel = { num: `${(this.floatCounters[type] ?? 0) + 1}${letter}`, kind: type }
        label = `(${letter})`
      } else {
        const n = (this.floatCounters[type] ?? 0) + 1
        this.floatCounters[type] = n
        this.currentLabel = { num: String(n), kind: type }
        label = `${FLOAT_NAMES[type] ?? type.charAt(0).toUpperCase() + type.slice(1)} ${n}:`
      }
    }
    const body = this.inline(text)
    this.block(sink, `<div class="rt-caption" data-line="${line}">${label ? `<span class="rt-caption-label">${esc(label)}</span> ` : ''}${body}</div>`)
  }

  private subfloatCommand(sink: Sink, name: string, start: number, end: number): void {
    let captionRange: Range | null
    let contentRange: Range | null
    if (name === 'subfloat') {
      captionRange = this.readOpt(end)
      this.readOpt(end)
      contentRange = this.readArg(end, true)
    } else {
      this.star(end)
      this.readOpt(end)
      captionRange = this.readArg(end)
      this.readOpt(end)
      contentRange = this.readArg(end, true)
    }
    const type = this.floatKind ?? 'figure'
    const letter = alpha(++this.subCounter)
    const saved = this.currentLabel
    this.currentLabel = { num: `${(this.floatCounters[type] ?? 0) + 1}${letter}`, kind: type }
    const content = this.inline(contentRange)
    const caption = this.inline(captionRange)
    this.currentLabel = saved
    this.put(
      sink,
      `<div class="rt-subfloat" data-line="${this.lineAt(start)}">${content}<div class="rt-caption"><span class="rt-caption-label">(${letter})</span> ${caption}</div></div>`
    )
  }

  private metaCommand(name: string, end: number): void {
    if (name !== 'date') this.readOpt(end)
    const r = this.readArg(end, true)
    if (!r) return
    const meta = { text: this.raw(r), line: this.lineAt(r.s) }
    if (name === 'title') this.meta.title = meta
    else if (name === 'author') this.meta.author = meta
    else if (name === 'date') this.meta.date = meta
    else if (name === 'subtitle') this.meta.subtitle = meta
    else this.meta.affils.push(meta)
  }

  private maketitle(sink: Sink, start: number): void {
    const m = this.meta
    const line = this.lineAt(start)
    let html = `<header class="rt-titleblock" data-line="${line}">`
    if (m.title) html += `<h1 class="rt-title">${this.inlineString(m.title.text, line, true)}</h1>`
    if (m.subtitle) html += `<div class="rt-subtitle">${this.inlineString(m.subtitle.text, line, true)}</div>`
    if (m.author) {
      const authors = splitAnd(m.author.text).map((a) => `<span class="rt-author">${this.inlineString(a, line, true)}</span>`)
      if (authors.length) html += `<div class="rt-authors">${authors.join('')}</div>`
    }
    if (m.affils.length) html += `<div class="rt-affils">${m.affils.map((a) => `<div class="rt-affil">${this.inlineString(a.text, line)}</div>`).join('')}</div>`
    const date = m.date ? this.inlineString(m.date.text, line) : esc(today())
    if (date.trim()) html += `<div class="rt-date">${date}</div>`
    html += '</header>'
    this.block(sink, html)
  }

  private pageBreak(sink: Sink, start: number): void {
    if (!sink.block) return
    this.flush(sink)
    const last = sink.blocks[sink.blocks.length - 1]
    if (last === undefined || last.startsWith('<div class="rt-pagebreak"')) return
    this.block(sink, `<div class="rt-pagebreak" data-line="${this.lineAt(start)}" aria-hidden="true"></div>`)
  }

  private newTheorem(end: number): void {
    const starred = this.star(end)
    const name = this.raw(this.readArg(end)).trim()
    const shared = this.readOpt(end)
    const title = this.raw(this.readArg(end)).trim()
    const within = this.readOpt(end)
    if (!name) return
    const counter = shared ? this.raw(shared).trim() || name : name
    if (!this.thmCounters.has(counter)) this.thmCounters.set(counter, { value: 0, within: within ? this.raw(within).trim() : null })
    this.theorems.set(name, { title: title || name, counter, numbered: !starred, style: this.thmStyle })
  }

  private inputFile(sink: Sink, name: string, start: number, end: number): void {
    if (name === 'import' || name === 'subimport' || name === 'inputminted') {
      this.readOpt(end)
      this.readArg(end)
    } else this.readOpt(end)
    const file = this.raw(this.readArg(end)).trim()
    this.block(sink, `<div class="rt-input" data-line="${this.lineAt(start)}"><span class="rt-input-label">Included file</span> <code>${esc(file)}</code></div>`)
  }

  private externalBibliography(sink: Sink, name: string, start: number, end: number): void {
    const opt = name === 'printbibliography' ? this.readOpt(end) : null
    const file = name === 'bibliography' ? this.raw(this.readArg(end)).trim() : ''
    let heading = this.hasChapters ? 'Bibliography' : 'References'
    if (opt) heading = keyValues(this.raw(opt)).get('title') ?? heading
    const note = file ? `Entries from <code>${esc(file.split(',').map((f) => (f.trim().endsWith('.bib') ? f.trim() : f.trim() + '.bib')).join(', '))}</code> are not rendered in the preview.` : 'Bibliography entries are not rendered in the preview.'
    this.block(
      sink,
      `<section class="rt-bibliography rt-bib-external" data-line="${this.lineAt(start)}"><h2 class="rt-heading rt-bib-heading">${esc(heading)}</h2><div class="rt-bib-note">${note}</div></section>`
    )
  }

  // ----- math ---------------------------------------------------------------------------------

  private mathClose(from: number, end: number, closer: '$' | '$$' | '\\)' | '\\]'): { at: number; ok: boolean } {
    const s = this.s
    let depth = 0
    // A `$` inside braces belongs to `\text{$..$}`; but if the braces never close, it was the
    // closing one after all (`$\frac{1$`): fall back to it rather than run to the paragraph end.
    let fallback = -1
    const unterminated = (at: number) => (fallback !== -1 ? { at: fallback, ok: true } : { at, ok: false })
    for (let i = from; i < end; i++) {
      const c = s.charCodeAt(i)
      if (c === 92) {
        const n = s.charCodeAt(i + 1)
        if ((closer === '\\)' && n === 41) || (closer === '\\]' && n === 93)) return { at: i, ok: true }
        i++
      } else if (c === 123) depth++
      else if (c === 125) depth--
      else if (c === 36) {
        const match = closer === '$' || (closer === '$$' && s.charCodeAt(i + 1) === 36)
        if (match && depth <= 0) return { at: i, ok: true }
        if (match && fallback === -1) fallback = i
        if (closer === '$$' && s.charCodeAt(i + 1) === 36) i++
      } else if (c === 37) {
        const nl = s.indexOf('\n', i)
        if (nl === -1 || nl >= end) return unterminated(end)
        i = nl - 1
      } else if (c === 10 && this.isParBreak(i, end)) return unterminated(i)
    }
    return unterminated(end)
  }

  private dollar(sink: Sink, end: number): void {
    const s = this.s
    const start = this.pos
    const display = start + 1 < end && s.charCodeAt(start + 1) === 36
    const from = start + (display ? 2 : 1)
    const close = this.mathClose(from, end, display ? '$$' : '$')
    const body = s.slice(from, close.at)
    this.pos = close.ok ? close.at + (display ? 2 : 1) : close.at
    const raw = s.slice(start, this.pos)
    if (display) this.displayMath(sink, null, body, raw, start)
    else this.inlineMath(sink, body, raw)
  }

  private delimitedMath(sink: Sink, start: number, end: number, closer: '\\)' | '\\]', display: boolean): void {
    const from = this.pos
    const close = this.mathClose(from, end, closer)
    const body = this.s.slice(from, close.at)
    this.pos = close.ok ? close.at + 2 : close.at
    const raw = this.s.slice(start, this.pos)
    if (display) this.displayMath(sink, null, body, raw, start)
    else this.inlineMath(sink, body, raw)
  }

  private addMathLabels(prepared: PreparedMath): void {
    for (const { key, tag } of prepared.labels) {
      if (!key) continue
      this.labels.set(key, tag !== null ? { num: tag, kind: 'equation' } : this.currentLabel)
    }
  }

  private inlineMath(sink: Sink, body: string, raw: string): void {
    const prepared = prepareMath({ env: null, body, display: false }, this.nextEq)
    this.addMathLabels(prepared)
    const i = this.maths.push({ tex: prepared.tex, display: false, raw, body }) - 1
    this.put(sink, ph('M', i))
    this.inWord = false
  }

  private displayMath(sink: Sink, env: string | null, body: string, raw: string, start: number): void {
    const prepared = prepareMath({ env, body, display: true }, this.nextEq)
    this.addMathLabels(prepared)
    const i = this.maths.push({ tex: prepared.tex, display: prepared.displayMode, raw, body }) - 1
    this.inWord = false
    if (!prepared.displayMode) {
      this.put(sink, ph('M', i))
      return
    }
    this.block(sink, `<div class="rt-math-display" data-line="${this.lineAt(start)}">${ph('M', i)}</div>`, 'display')
  }

  // ----- preamble -----------------------------------------------------------------------------

  private scanPreamble(end: number): void {
    const s = this.s
    this.pos = 0
    while (this.pos < end) {
      const c = s.charCodeAt(this.pos)
      if (c === 37) {
        const nl = s.indexOf('\n', this.pos)
        this.pos = nl === -1 || nl >= end ? end : nl + 1
        continue
      }
      if (c !== 92) {
        this.pos++
        continue
      }
      const start = this.pos
      let j = start + 1
      while (j < end && isLetter(s.charCodeAt(j))) j++
      if (j === start + 1) {
        this.pos = start + 2
        continue
      }
      const name = s.slice(start + 1, j)
      this.pos = j
      this.skipCmdSpace(end)
      switch (name) {
        case 'title':
        case 'author':
        case 'date':
        case 'subtitle':
        case 'affil':
        case 'affiliation':
          this.metaCommand(name, end)
          break
        case 'newtheorem':
          this.newTheorem(end)
          break
        case 'theoremstyle':
          this.thmStyle = this.raw(this.readArg(end)).trim() || 'plain'
          break
        case 'iffalse':
          this.skipConditional(end)
          break
        default:
          if (DEFINITIONS.has(name)) this.skipDefinition(name, end)
      }
      if (this.pos <= start) this.pos = start + 1
    }
  }

  // ----- environments -------------------------------------------------------------------------

  /** Finds `\end{name}` (nesting-aware), stopping at an ancestor's `\end` or, with `parStop`, at a
   *  blank line. `ok` is false when the environment is unterminated. */
  private findEnvEnd(name: string, from: number, end: number, parStop: boolean): { bodyEnd: number; next: number; ok: boolean } {
    const s = this.s
    let nest = 0
    for (let i = from; i < end; i++) {
      const c = s.charCodeAt(i)
      if (c === 92) {
        if (!isLetter(s.charCodeAt(i + 1))) {
          i++
          continue
        }
        let j = i + 1
        while (j < end && isLetter(s.charCodeAt(j))) j++
        const word = s.slice(i + 1, j)
        let envName: string | undefined
        let isBegin = false
        if (word === 'begin' || word === 'end') {
          const g = this.peekEnvName(j, end)
          if (g) {
            envName = g.name
            isBegin = word === 'begin'
            j = g.next
          }
        } else if (word === 'verb') j = this.skipVerbAt(j, end)
        else if (this.beginAliases.has(word)) {
          envName = this.beginAliases.get(word)
          isBegin = true
        } else if (this.endAliases.has(word)) envName = this.endAliases.get(word)
        if (envName !== undefined) {
          if (envName === name) {
            if (isBegin) nest++
            else if (nest === 0) return { bodyEnd: i, next: j, ok: true }
            else nest--
          } else if (!isBegin && (envName === 'document' || this.envStack.includes(envName))) {
            return { bodyEnd: i, next: i, ok: false }
          }
        }
        i = j - 1
      } else if (c === 37) {
        const nl = s.indexOf('\n', i)
        if (nl === -1 || nl >= end) break
        i = nl - 1
      } else if (c === 10 && parStop && this.isParBreak(i, end)) return { bodyEnd: i, next: i, ok: false }
    }
    return { bodyEnd: end, next: end, ok: false }
  }

  private env(sink: Sink, name: string, start: number, end: number): void {
    if (this.depth >= MAX_DEPTH) {
      const found = this.findEnvEnd(name, this.pos, end, false)
      this.text(sink, this.s.slice(this.pos, found.bodyEnd))
      this.pos = found.next
      return
    }
    this.depth++
    try {
      this.envInner(sink, name, start, end)
    } finally {
      this.depth--
    }
  }

  private envInner(sink: Sink, name: string, start: number, end: number): void {
    if (DISPLAY_MATH_ENVS.has(name)) {
      const from = this.pos
      const found = this.findEnvEnd(name, from, end, true)
      this.pos = found.next
      this.displayMath(sink, name, this.s.slice(from, found.bodyEnd), this.s.slice(start, found.next), start)
      return
    }
    if (VERBATIMS.has(name)) return this.verbatim(sink, name, start, end)
    if (PICTURES.has(name)) {
      const found = this.findEnvEnd(name, this.pos, end, false)
      this.pos = found.next
      const label = name === 'tikzcd' ? 'Commutative diagram' : name === 'forest' ? 'Tree' : 'TikZ picture'
      this.put(sink, `<span class="rt-graphic rt-picture" data-line="${this.lineAt(start)}"><span class="rt-graphic-icon" aria-hidden="true"></span><span class="rt-graphic-name">${label}</span></span>`)
      this.inWord = false
      return
    }
    const listKind = LIST_KINDS[name]
    if (listKind !== undefined) return this.list(sink, name, listKind, start, end)
    const floatKind = FLOATS[name]
    if (floatKind !== undefined) return this.float(sink, name, floatKind, start, end)
    if (TABULARS.has(name)) return this.tabular(sink, name, start, end)
    if (QUOTES.has(name)) return this.boxed(sink, name, start, end, 'blockquote', `rt-quote rt-${name}`, '', null)
    switch (name) {
      case 'center':
        return this.boxed(sink, name, start, end, 'div', 'rt-center', '', 'c')
      case 'flushleft':
        return this.boxed(sink, name, start, end, 'div', 'rt-flushleft', '', 'l')
      case 'flushright':
        return this.boxed(sink, name, start, end, 'div', 'rt-flushright', '', 'r')
      case 'abstract':
        return this.boxed(sink, name, start, end, 'div', 'rt-abstract', '<div class="rt-abstract-title">Abstract</div>', null)
      case 'thebibliography':
        return this.bibliography(sink, start, end)
      case 'proof':
        return this.proof(sink, start, end)
      case 'subfigure':
      case 'subtable':
      case 'minipage':
        return this.minipage(sink, name, start, end)
      case 'multicols':
      case 'multicols*': {
        const n = Math.min(6, Math.max(1, parseInt(this.raw(this.readArg(end)), 10) || 2))
        this.readOpt(end)
        return this.boxed(sink, name, start, end, 'div', 'rt-multicols', '', null, `column-count:${n}`)
      }
      case 'appendices':
        this.startAppendix()
        return this.transparent(sink, name, end)
      case 'spacing':
      case 'otherlanguage':
      case 'otherlanguage*':
      case 'adjustbox':
      case 'column':
      case 'block':
      case 'alertblock':
      case 'exampleblock':
        this.readOpt(end)
        this.readArg(end)
        return this.transparent(sink, name, end)
      case 'tcolorbox':
      case 'mdframed':
      case 'columns':
      case 'frame':
      case 'titlepage':
      case 'framed':
      case 'shaded':
      case 'leftbar':
        this.readOpt(end, true)
        return this.transparent(sink, name, end)
    }
    const thm = this.theoremFor(name)
    if (thm) return this.theorem(sink, name, thm.def, thm.starred, start, end)
    this.transparent(sink, name, end)
  }

  /** Unknown and purely stylistic environments: a group in the surrounding flow. */
  private transparent(sink: Sink, name: string, end: number): void {
    const scopes = sink.scopes.length
    this.openScope(sink)
    this.envStack.push(name)
    try {
      this.flow(sink, end, { env: name })
    } finally {
      this.envStack.pop()
    }
    this.closeScopesTo(sink, scopes)
  }

  /** Runs a nested block flow until `\end{name}`. */
  private nested(name: string, end: number, setup?: (inner: Sink) => void, stop: Stop = {}): { sink: Sink; reason: Reason } {
    const inner = new Sink(true)
    inner.at = this.pos
    if (setup) setup(inner)
    this.envStack.push(name)
    try {
      return { sink: inner, reason: this.flow(inner, end, { ...stop, env: name }) }
    } finally {
      this.envStack.pop()
    }
  }

  private boxed(sink: Sink, name: string, start: number, end: number, tag: string, cls: string, head: string, align: string | null, style = ''): void {
    const line = this.lineAt(start)
    const { sink: inner } = this.nested(name, end, (s) => {
      s.align = align
    })
    const body = this.finish(inner)
    this.block(sink, `<${tag} class="${cls}"${style ? ` style="${style}"` : ''} data-line="${line}">${head}${body}</${tag}>`)
  }

  private verbatim(sink: Sink, name: string, start: number, end: number): void {
    const s = this.s
    let lang = ''
    let caption = ''
    if (name === 'lstlisting' || name === 'Verbatim' || name === 'Verbatim*' || name === 'BVerbatim' || name === 'LVerbatim' || name === 'minted') {
      const opt = this.readOpt(end, true)
      if (opt) {
        const kv = keyValues(this.raw(opt))
        lang = kv.get('language') ?? ''
        caption = kv.get('caption') ?? ''
      }
      if (name === 'minted') lang = this.raw(this.readArg(end)).trim()
    }
    const closeTag = `\\end{${name}}`
    let close = s.indexOf(closeTag, this.pos)
    let next: number
    if (close === -1 || close > end) {
      close = end
      next = end
    } else next = close + closeTag.length
    let from = this.pos
    const nl = s.indexOf('\n', from)
    if (nl !== -1 && nl < close && s.slice(from, nl).trim() === '') from = nl + 1
    let content = s.slice(from, close)
    content = content.replace(/\n[ \t]*$/, '')
    this.pos = next
    if (name === 'comment' || name === 'filecontents' || name === 'filecontents*') return
    const line = this.lineAt(start)
    let html = `<pre class="rt-verbatim" data-line="${line}"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(content)}</code></pre>`
    if (caption) {
      const n = ++this.floatCounters.listing
      html = `<figure class="rt-float rt-listing" data-line="${line}">${html}<div class="rt-caption"><span class="rt-caption-label">Listing ${n}:</span> ${this.inlineString(caption, line)}</div></figure>`
    }
    this.block(sink, html)
  }

  private listOptions(raw: string, kind: string): { template: string | null; start: number } {
    let template: string | null = null
    let start = 1
    const kv = keyValues(raw)
    if (kv.size > 0) {
      template = kv.get('label') ?? null
      const st = parseInt(kv.get('start') ?? '', 10)
      if (Number.isFinite(st)) start = st
    } else if (kind === 'enumerate' && raw.trim()) {
      // enumerate package: the first 1/a/A/i/I outside braces is the counter.
      const t = raw.trim()
      let depth = 0
      template = t
      for (let i = 0; i < t.length; i++) {
        const c = t[i]
        if (c === '{') depth++
        else if (c === '}') depth--
        else if (depth === 0 && '1aAiI'.includes(c)) {
          const counter = { '1': '\\arabic*', a: '\\alph*', A: '\\Alph*', i: '\\roman*', I: '\\Roman*' }[c] as string
          template = t.slice(0, i) + counter + t.slice(i + 1)
          break
        }
      }
    }
    return { template, start }
  }

  private list(sink: Sink, name: string, kind: 'itemize' | 'enumerate' | 'description', start: number, end: number): void {
    const opt = this.readOpt(end)
    const options = this.listOptions(this.raw(opt), kind)
    const line = this.lineAt(start)
    const level = kind === 'enumerate' ? ++this.enumDepth : kind === 'itemize' ? ++this.itemDepth : 0
    const savedLabel = this.currentLabel
    const items: string[] = []
    let n = options.start - 1
    try {
      const first = this.nested(name, end, undefined, { item: true })
      let reason = first.reason
      const preHtml = this.finish(first.sink)
      if (preHtml) items.push(kind === 'description' ? `<dd class="rt-desc-body">${preHtml}</dd>` : `<li class="rt-item rt-item-pre"><div class="rt-item-body">${preHtml}</div></li>`)
      while (reason === 'item') {
        const itemStart = this.pos
        this.pos += 5
        this.skipCmdSpace(end)
        const lab = this.readOpt(end)
        let labelHtml = ''
        if (lab) labelHtml = this.uncounted(() => this.inline(lab))
        else if (kind === 'enumerate') {
          n++
          const v = this.enumValue(level, n)
          this.enumValues[level - 1] = v.value
          this.enumValues.length = level
          labelHtml = options.template !== null ? this.listTemplate(options.template, n, itemStart) : esc(v.label)
          this.currentLabel = { num: this.enumRef(level), kind: 'item' }
        } else if (kind === 'itemize') {
          labelHtml = options.template !== null ? this.listTemplate(options.template, 0, itemStart) : BULLETS[(level - 1) % 4]
        }
        const result = this.nested(name, end, undefined, { item: true })
        reason = result.reason
        const body = this.finish(result.sink)
        const ln = this.lineAt(itemStart)
        if (kind === 'description') {
          items.push(`<dt class="rt-desc-term" data-line="${ln}">${labelHtml}</dt><dd class="rt-desc-body">${body}</dd>`)
        } else {
          items.push(`<li class="rt-item" data-line="${ln}"><span class="rt-item-label">${labelHtml}</span><div class="rt-item-body">${body}</div></li>`)
        }
      }
    } finally {
      if (kind === 'enumerate') this.enumDepth--
      else if (kind === 'itemize') this.itemDepth--
      this.currentLabel = savedLabel
    }
    const tag = kind === 'description' ? 'dl' : kind === 'enumerate' ? 'ol' : 'ul'
    this.block(sink, `<${tag} class="rt-list rt-${kind}" data-line="${line}">${items.join('')}</${tag}>`)
  }

  private enumValue(level: number, n: number): { label: string; value: string } {
    switch ((level - 1) % 4) {
      case 0:
        return { label: `${n}.`, value: String(n) }
      case 1:
        return { label: `(${alpha(n)})`, value: alpha(n) }
      case 2:
        return { label: `${roman(n)}.`, value: roman(n) }
      default:
        return { label: `${alpha(n).toUpperCase()}.`, value: alpha(n).toUpperCase() }
    }
  }

  private enumRef(level: number): string {
    const v = this.enumValues
    if (level <= 1) return v[0] ?? ''
    if (level === 2) return `${v[0] ?? ''}${v[1] ?? ''}`
    return `${v[0] ?? ''}(${v[1] ?? ''})${v.slice(2, level).join('')}`
  }

  private listTemplate(template: string, n: number, at: number): string {
    const text = template
      .replace(/\\arabic\*/g, String(n))
      .replace(/\\alph\*/g, alpha(n))
      .replace(/\\Alph\*/g, alpha(n).toUpperCase())
      .replace(/\\roman\*/g, roman(n))
      .replace(/\\Roman\*/g, roman(n).toUpperCase())
    return this.inlineString(text, this.lineAt(at))
  }

  private bibliography(sink: Sink, start: number, end: number): void {
    this.readArg(end)
    const line = this.lineAt(start)
    const items: string[] = []
    const saved = this.counting
    this.counting = false
    try {
      let { reason } = this.nested('thebibliography', end, undefined, { bibitem: true })
      while (reason === 'bibitem') {
        const itemStart = this.pos
        this.pos += 8
        this.skipCmdSpace(end)
        const lab = this.readOpt(end)
        const key = this.raw(this.readArg(end)).trim()
        const label = lab ? this.plain(this.inline(lab)) : String(++this.bibCounter)
        if (key && !this.bibitems.has(key)) this.bibitems.set(key, label)
        const result = this.nested('thebibliography', end, undefined, { bibitem: true })
        reason = result.reason
        items.push(
          `<li class="rt-bibitem" data-line="${this.lineAt(itemStart)}" data-cite="${esc(key)}"><span class="rt-bib-label">[${esc(label)}]</span><div class="rt-bib-body">${this.finish(result.sink)}</div></li>`
        )
      }
    } finally {
      this.counting = saved
    }
    const heading = this.hasChapters ? 'Bibliography' : 'References'
    this.block(sink, `<section class="rt-bibliography" data-line="${line}"><h2 class="rt-heading rt-bib-heading">${heading}</h2><ol class="rt-bib-list">${items.join('')}</ol></section>`)
  }

  private float(sink: Sink, name: string, kind: string, start: number, end: number): void {
    if (name === 'wrapfigure' || name === 'wraptable') {
      this.readOpt(end)
      this.readArg(end)
      this.readOpt(end)
      this.readArg(end)
    } else {
      this.readOpt(end)
      if (name === 'SCfigure' || name === 'SCtable') this.readOpt(end)
    }
    const line = this.lineAt(start)
    const saved = { label: this.currentLabel, kind: this.floatKind, sub: this.subCounter, inSub: this.inSubfloat }
    this.floatKind = kind
    this.subCounter = 0
    this.inSubfloat = false
    let body: string
    try {
      body = this.finish(this.nested(name, end).sink)
    } finally {
      this.currentLabel = saved.label
      this.floatKind = saved.kind
      this.subCounter = saved.sub
      this.inSubfloat = saved.inSub
    }
    this.block(sink, `<figure class="rt-float rt-${kind}" data-line="${line}">${body}</figure>`)
  }

  private minipage(sink: Sink, name: string, start: number, end: number): void {
    this.readOpt(end)
    if (name === 'minipage') {
      this.readOpt(end)
      this.readOpt(end)
    }
    const pct = widthPercent(this.raw(this.readArg(end)))
    const saved = { label: this.currentLabel, inSub: this.inSubfloat }
    if (name !== 'minipage') this.inSubfloat = true
    let body: string
    try {
      body = this.finish(this.nested(name, end).sink)
    } finally {
      this.currentLabel = saved.label
      this.inSubfloat = saved.inSub
    }
    const cls = name === 'minipage' ? 'rt-minipage' : 'rt-subfloat'
    this.put(sink, `<div class="${cls}"${pct !== null ? ` style="width:${pct}%"` : ''} data-line="${this.lineAt(start)}">${body}</div>`)
  }

  private theoremFor(name: string): { def: TheoremDef; starred: boolean } | null {
    const starred = name.endsWith('*')
    const base = starred ? name.slice(0, -1) : name
    const declared = this.theorems.get(name) ?? (starred ? this.theorems.get(base) : undefined)
    if (declared) return { def: declared, starred: starred && !this.theorems.has(name) }
    const builtin = DEFAULT_THEOREMS[base]
    if (!builtin) return null
    const def: TheoremDef = { title: builtin[0], counter: base, numbered: true, style: builtin[1] }
    this.theorems.set(base, def)
    return { def, starred }
  }

  private theorem(sink: Sink, name: string, def: TheoremDef, starred: boolean, start: number, end: number): void {
    const note = this.readOpt(end)
    const line = this.lineAt(start)
    const title = this.inlineString(def.title, line)
    let num = ''
    if (def.numbered && !starred) {
      let counter = this.thmCounters.get(def.counter)
      if (!counter) {
        counter = { value: 0, within: null }
        this.thmCounters.set(def.counter, counter)
      }
      counter.value++
      const prefix = counter.within ? this.withinNumber(counter.within) : ''
      num = prefix ? `${prefix}.${counter.value}` : String(counter.value)
    }
    const saved = this.currentLabel
    if (num) this.currentLabel = { num, kind: 'theorem', name: this.plain(title) }
    const noteHtml = note ? this.inline(note) : ''
    const leader = `<span class="rt-thm-head">${title}${num ? ` ${esc(num)}` : ''}${noteHtml ? ` <span class="rt-thm-note">(${noteHtml})</span>` : ''}.</span> `
    let body: string
    try {
      body = this.finish(
        this.nested(name, end, (s) => {
          s.leader = leader
          s.leaderLine = line
        }).sink
      )
    } finally {
      this.currentLabel = saved
    }
    const style = def.style === 'definition' || def.style === 'remark' ? def.style : 'plain'
    this.block(sink, `<div class="rt-thm rt-thm-${style}" data-env="${esc(name)}" data-line="${line}">${body}</div>`)
  }

  private proof(sink: Sink, start: number, end: number): void {
    const note = this.readOpt(end)
    const line = this.lineAt(start)
    const head = note ? this.uncounted(() => this.inline(note)) : 'Proof'
    const { sink: inner } = this.nested('proof', end, (s) => {
      s.leader = `<span class="rt-proof-head">${head}.</span> `
      s.leaderLine = line
    })
    const body = this.finish(inner, '<span class="rt-qed" aria-hidden="true">∎</span>')
    this.block(sink, `<div class="rt-proof" data-line="${line}">${body}</div>`)
  }

  // ----- tables -------------------------------------------------------------------------------

  private tabular(sink: Sink, name: string, start: number, end: number): void {
    if (name === 'tabular*' || name === 'tabularx' || name === 'tabulary' || name === 'xltabular') this.readArg(end)
    if (name === 'tabu') {
      // \begin{tabu} to \textwidth {spec}
      const brace = this.s.indexOf('{', this.pos)
      if (brace !== -1 && brace < end && brace - this.pos < 40) this.pos = brace
    }
    if (name !== 'tabularx' && name !== 'tabulary') this.readOpt(end)
    const spec = parseColumns(this.raw(this.readArg(end)))
    const from = this.pos
    let found = this.findEnvEnd(name, from, end, false)
    if (!found.ok) found = this.findEnvEnd(name, from, end, true)
    const after = found.next
    const line = this.lineAt(start)
    const isArray = name === 'array'
    const longtable = name.startsWith('longtable') || name === 'xltabular'
    const saved = this.currentLabel
    const caption: { html: string } = { html: '' }
    const rows = this.tableRows(from, found.bodyEnd, longtable, caption)
    this.currentLabel = saved
    let html = ''
    for (const row of rows) {
      const cls = [...row.top.map((k) => `rt-rt-${k}`), ...row.bottom.map((k) => `rt-rb-${k}`)]
      let cells = ''
      let col = 0
      for (const range of row.cells) {
        const cell = this.tableCell(range, isArray)
        const span = cell.span
        const own = cell.cols
        const align = own ? own.cols[0]?.align ?? 'l' : spec.cols[col]?.align ?? 'l'
        const width = own ? null : spec.cols[col]?.width ?? null
        const left = own ? own.vlines[0] > 0 : col === 0 && spec.vlines[0] > 0
        const right = own ? (own.vlines[own.cols.length] ?? 0) > 0 : (spec.vlines[col + span] ?? 0) > 0
        const cline = row.clines.some(([a, b]) => a <= col + 1 && b >= col + span)
        const c = `rt-al-${align}${left ? ' rt-vl' : ''}${right ? ' rt-vr' : ''}${cline ? ' rt-cl' : ''}`
        cells += `<td class="${c}"${span > 1 ? ` colspan="${span}"` : ''}${width ? ` style="width:${width}"` : ''}>${cell.html}</td>`
        col += span
      }
      for (; col < spec.cols.length; col++) {
        const right = (spec.vlines[col + 1] ?? 0) > 0
        const left = col === 0 && spec.vlines[0] > 0
        cells += `<td class="rt-al-${spec.cols[col].align}${left ? ' rt-vl' : ''}${right ? ' rt-vr' : ''}"></td>`
      }
      html += `<tr${cls.length ? ` class="${cls.join(' ')}"` : ''} data-line="${row.line}">${cells}</tr>`
    }
    this.pos = after
    const wrapCls = `rt-table-wrap${sink.align ? ` rt-al-${sink.align}` : ''}${isArray ? ' rt-array' : ''}`
    this.block(sink, `<div class="${wrapCls}" data-line="${line}">${caption.html}<table class="rt-tabular"><tbody>${html}</tbody></table></div>`)
  }

  /** Splits a tabular body into rows of cell ranges, peeling rules, longtable markers and captions
   *  off the start of each row. */
  private tableRows(a: number, b: number, longtable: boolean, caption: { html: string }): TableRow[] {
    const s = this.s
    const raw: Array<{ cells: Range[]; terminated: boolean }> = []
    let cells: Range[] = []
    let cellStart = a
    let depth = 0
    let envs = 0
    for (let i = a; i < b; i++) {
      const c = s.charCodeAt(i)
      if (c === 92) {
        const n = s.charCodeAt(i + 1)
        if (n === 92 && depth === 0 && envs === 0) {
          cells.push({ s: cellStart, e: i })
          raw.push({ cells, terminated: true })
          cells = []
          let j = i + 2
          if (s[j] === '*') j++
          if (s[j] === '[') {
            const close = s.indexOf(']', j)
            if (close !== -1 && close < b) j = close + 1
          }
          cellStart = j
          i = j - 1
        } else if (isLetter(n)) {
          let j = i + 1
          while (j < b && isLetter(s.charCodeAt(j))) j++
          const word = s.slice(i + 1, j)
          if (word === 'begin') envs++
          else if (word === 'end') envs = Math.max(0, envs - 1)
          else if (word === 'verb') j = this.skipVerbAt(j, b)
          else if ((word === 'tabularnewline' || word === 'cr') && depth === 0 && envs === 0) {
            cells.push({ s: cellStart, e: i })
            raw.push({ cells, terminated: true })
            cells = []
            cellStart = j
          }
          i = j - 1
        } else i++
      } else if (c === 123) depth++
      else if (c === 125) depth = Math.max(0, depth - 1)
      else if (c === 38 && depth === 0 && envs === 0) {
        cells.push({ s: cellStart, e: i })
        cellStart = i + 1
      } else if (c === 37) {
        const nl = s.indexOf('\n', i)
        if (nl === -1 || nl >= b) break
        i = nl - 1
      }
    }
    cells.push({ s: cellStart, e: b })
    raw.push({ cells, terminated: false })

    const segments: TableSegment[] = []
    let cur: TableSegment = { rows: [], trailing: [], marker: null }
    let pending: string[] = []
    let clines: Array<[number, number]> = []
    for (const r of raw) {
      const first = r.cells[0]
      let hadCaption = false
      this.pos = first.s
      for (;;) {
        this.skipArgSpace(first.e)
        const p = this.pos
        if (s.charCodeAt(p) !== 92 || !isLetter(s.charCodeAt(p + 1))) break
        let j = p + 1
        while (j < first.e && isLetter(s.charCodeAt(j))) j++
        const word = s.slice(p + 1, j)
        this.pos = j
        if (word === 'hline') {
          if (pending[pending.length - 1] === 'hl') pending[pending.length - 1] = 'hl2'
          else pending.push('hl')
        } else if (word === 'toprule' || word === 'bottomrule' || word === 'specialrule' || word === 'Xhline') {
          if (word === 'specialrule') this.skipSpec('mmm', first.e)
          else this.readOpt(first.e)
          if (word === 'Xhline') this.readArg(first.e)
          pending.push('thick')
        } else if (word === 'midrule' || word === 'hhline') {
          if (word === 'hhline') this.readArg(first.e)
          else this.readOpt(first.e)
          pending.push('thin')
        } else if (word === 'cline' || word === 'cmidrule') {
          if (word === 'cmidrule') {
            this.readOpt(first.e)
            this.skipArgSpace(first.e)
            if (s[this.pos] === '(') {
              const close = s.indexOf(')', this.pos)
              if (close !== -1 && close < first.e) this.pos = close + 1
            }
          }
          const m = /^\s*(\d+)\s*-\s*(\d+)/.exec(this.raw(this.readArg(first.e)))
          if (m) clines.push([Number(m[1]), Number(m[2])])
        } else if (word === 'addlinespace' || word === 'morecmidrules' || word === 'noalign' || word === 'rowcolor' || word === 'arrayrulecolor' || word === 'rowcolors') {
          if (word === 'addlinespace') this.readOpt(first.e)
          else if (word === 'noalign') this.readArg(first.e)
          else if (word === 'rowcolors') this.skipSpec('smmm', first.e)
          else if (word !== 'morecmidrules') this.skipSpec('om', first.e)
        } else if (word === 'endhead' || word === 'endfirsthead' || word === 'endfoot' || word === 'endlastfoot') {
          cur.trailing = pending
          cur.marker = word
          segments.push(cur)
          cur = { rows: [], trailing: [], marker: null }
          pending = []
          clines = []
        } else if (word === 'caption' && longtable) {
          hadCaption = true
          this.star(first.e)
          this.readOpt(first.e)
          const text = this.readArg(first.e)
          if (!caption.html) {
            const n = ++this.floatCounters.table
            this.currentLabel = { num: String(n), kind: 'table' }
            caption.html = `<div class="rt-caption" data-line="${this.lineAt(p)}"><span class="rt-caption-label">Table ${n}:</span> ${this.inline(text)}</div>`
          }
        } else if (word === 'label') {
          const key = this.raw(this.readArg(first.e)).trim()
          if (key) this.labels.set(key, this.currentLabel)
        } else {
          this.pos = p
          break
        }
      }
      const contentStart = this.pos
      const hasContent = r.cells.length > 1 || this.hasText(contentStart, first.e)
      if (hasContent || (r.terminated && !hadCaption)) {
        cur.rows.push({ top: pending, clines, bottom: [], cells: [{ s: contentStart, e: first.e }, ...r.cells.slice(1)], line: this.lineAt(contentStart) })
        pending = []
        clines = []
      }
    }
    cur.trailing = pending
    segments.push(cur)

    const find = (m: string) => segments.find((x) => x.marker === m)
    const ordered = longtable
      ? [find('endfirsthead') ?? find('endhead'), segments[segments.length - 1], find('endlastfoot') ?? find('endfoot')]
      : segments
    const out: TableRow[] = []
    let carry: string[] = []
    for (const seg of ordered) {
      if (!seg) continue
      for (const row of seg.rows) {
        if (carry.length) {
          row.top = [...carry, ...row.top]
          carry = []
        }
        out.push(row)
      }
      if (seg.trailing.length) {
        if (out.length) out[out.length - 1].bottom.push(...seg.trailing)
        else carry = seg.trailing
      }
    }
    return out
  }

  /** Whether [a, b) holds anything but whitespace and comments. */
  private hasText(a: number, b: number): boolean {
    const s = this.s
    for (let i = a; i < b; i++) {
      const c = s.charCodeAt(i)
      if (c === 37) {
        const nl = s.indexOf('\n', i)
        if (nl === -1 || nl >= b) return false
        i = nl
      } else if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return true
    }
    return false
  }

  private tableCell(r: Range, isArray: boolean): { html: string; span: number; cols: ReturnType<typeof parseColumns> | null } {
    const s = this.s
    let p = this.skipBlank(r.s, r.e)
    let span = 1
    let cols: ReturnType<typeof parseColumns> | null = null
    let content: Range = { s: p, e: r.e }
    let rest: Range | null = null
    if (s.startsWith('\\multicolumn', p) && !isLetter(s.charCodeAt(p + 12))) {
      this.pos = p + 12
      span = Math.min(64, Math.max(1, parseInt(this.raw(this.readArg(r.e)), 10) || 1))
      cols = parseColumns(this.raw(this.readArg(r.e)))
      content = this.readArg(r.e, true) ?? { s: this.pos, e: this.pos }
      rest = { s: this.pos, e: r.e }
      p = this.pos
    }
    const render = (range: Range | null): string => {
      if (!range || range.e <= range.s) return ''
      if (isArray) {
        const body = s.slice(range.s, range.e)
        if (!body.trim()) return ''
        const sink = new Sink(false)
        this.inlineMath(sink, body, body)
        return this.finish(sink)
      }
      return this.inline(range)
    }
    return { html: render(content) + render(rest), span, cols }
  }

  // ----- resolution ---------------------------------------------------------------------------

  private resolve(html: string): string {
    if (html.indexOf('\u0001') === -1) return html
    return html.replace(/\u0001([RCMT])(\d+)\u0002/g, (_m, kind: string, index: string) => {
      const i = Number(index)
      if (kind === 'M') return this.mathHtml(i)
      if (kind === 'R') return this.refHtml(i)
      if (kind === 'C') return this.citeHtml(i)
      return this.tocHtml()
    })
  }

  /** Plain text of rendered HTML (outline titles, bibliography labels). */
  private plain(html: string): string {
    let t = html.replace(/<sup class="rt-fnref"[^>]*>[\s\S]*?<\/sup>/g, '')
    t = t.replace(/\u0001([MT])(\d+)\u0002/g, (_m, kind: string, i: string) => (kind === 'M' ? this.maths[Number(i)]?.body.trim() ?? '' : ''))
    t = this.resolve(t)
    return t
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private refText(kind: string, key: string): { text: string; info: LabelInfo | undefined } {
    const info = this.labels.get(key)
    const num = info && info.num ? info.num : '??'
    if (!info || !info.num) return { text: kind === 'eqref' ? '(??)' : '??', info: undefined }
    switch (kind) {
      case 'eqref':
        return { text: `(${num})`, info }
      case 'autoref':
      case 'Autoref':
      case 'cref':
      case 'Cref':
      case 'vref':
      case 'Vref':
      case 'labelcref': {
        if (kind === 'labelcref' || kind === 'vref') return { text: num, info }
        const names = REF_NAMES[info.kind]
        const lower = kind === 'cref'
        let name = info.name ?? (names ? names[0] : '')
        if (lower) name = names ? names[1] : name.toLowerCase()
        const n = info.kind === 'equation' && kind !== 'autoref' && kind !== 'Autoref' ? `(${num})` : num
        return { text: name ? `${name} ${n}` : n, info }
      }
      default:
        return { text: num, info }
    }
  }

  private refHtml(i: number): string {
    const ref = this.refs[i]
    if (!ref || ref.keys.length === 0) return '<span class="rt-ref rt-ref-missing">??</span>'
    return ref.keys
      .map((key) => {
        if (ref.kind === 'nameref') {
          const info = this.labels.get(key)
          const html = info?.titleHtml ? this.resolve(info.titleHtml) : '??'
          return `<span class="rt-ref${info?.titleHtml ? '' : ' rt-ref-missing'}" data-ref="${esc(key)}">${html}</span>`
        }
        const { text, info } = this.refText(ref.kind, key)
        return `<span class="rt-ref${ref.kind === 'eqref' ? ' rt-eqref' : ''}${info ? '' : ' rt-ref-missing'}" data-ref="${esc(key)}">${esc(text)}</span>`
      })
      .join(', ')
  }

  private citeHtml(i: number): string {
    const cite = this.cites[i]
    if (!cite) return ''
    if (cite.text) return `<span class="rt-cite rt-cite-text">${cite.keys.map((k) => esc(k)).join(', ')}</span>`
    const known = this.bibitems.size > 0
    const keys = cite.keys.map((k) => {
      const label = this.bibitems.get(k)
      return `<span class="rt-cite-key${known && label === undefined ? ' rt-cite-missing' : ''}" data-cite="${esc(k)}">${esc(label ?? k)}</span>`
    })
    const pre = cite.pre ? `${this.resolve(cite.pre)} ` : ''
    const post = cite.post ? `, ${this.resolve(cite.post)}` : ''
    return `<span class="rt-cite">[${pre}${keys.join(', ') || '?'}${post}]</span>`
  }

  private tocHtml(): string {
    const items = this.outline
      .filter((o) => o.level <= 3)
      .map(
        (o) =>
          `<li class="rt-toc-item rt-toc-l${o.level + 1}" data-target-line="${o.line}">${o.number ? `<span class="rt-toc-num">${esc(o.number)}</span> ` : ''}<span class="rt-toc-text">${this.resolve(o.titleHtml)}</span></li>`
      )
    return `<ol class="rt-toc-list">${items.join('')}</ol>`
  }

  private mathHtml(i: number): string {
    const m = this.maths[i]
    if (!m) return ''
    if (m.html !== undefined) return m.html
    let html: string
    try {
      const out = this.opts.renderMath(this.mathRefs(m.tex), m.display, this.katexMacros)
      html = typeof out === 'string' ? out : ''
    } catch (error) {
      let message = 'Invalid formula'
      try {
        message = error instanceof Error ? error.message : String(error)
      } catch {
        // keep the generic message
      }
      html =
        `<span class="rt-math-error${m.display ? ' rt-math-error-display' : ''}" title="${esc(message)}">` +
        `<code class="rt-math-error-src">${esc(m.raw)}</code><span class="rt-math-error-msg">${esc(message)}</span></span>`
    }
    m.html = html
    return html
  }

  /** KaTeX has no `\ref`: substitute the resolved numbers as text. */
  private mathRefs(tex: string): string {
    if (tex.indexOf('ref') === -1) return tex
    return tex.replace(/\\(eqref|ref|autoref|cref|Cref|pageref)\*?\s*\{([^{}]*)\}/g, (_m, kind: string, keys: string) => {
      const text = keys
        .split(',')
        .map((k) => this.refText(kind, k.trim()).text)
        .join(', ')
      return `\\text{${text.replace(/[\\{}$&#^_%~]/g, '')}}`
    })
  }
}

// ---------------------------------------------------------------------------------------------
// Column specs

function readGroup(spec: string, i: number): { content: string; next: number } {
  let j = i
  while (j < spec.length && /\s/.test(spec[j])) j++
  if (spec[j] !== '{') return { content: '', next: i }
  let depth = 0
  for (let k = j; k < spec.length; k++) {
    if (spec[k] === '\\') k++
    else if (spec[k] === '{') depth++
    else if (spec[k] === '}') {
      depth--
      if (depth === 0) return { content: spec.slice(j + 1, k), next: k + 1 }
    }
  }
  return { content: spec.slice(j + 1), next: spec.length }
}

function cssLength(raw: string): string | null {
  const s = raw.trim()
  const m = /^(\d*\.?\d+)\s*(cm|mm|in|pt|em|ex)$/.exec(s)
  if (m) return `${m[1]}${m[2]}`
  const pct = widthPercent(s)
  return pct !== null && /\\/.test(s) ? `${pct}%` : null
}

function parseColumns(spec: string): { cols: Column[]; vlines: number[] } {
  const cols: Column[] = []
  const vlines = [0]
  let pendingAlign: string | null = null
  const walk = (str: string, depth: number): void => {
    for (let i = 0; i < str.length && cols.length < 64; i++) {
      const c = str[i]
      if (c === '|') vlines[cols.length]++
      else if (c === 'l' || c === 'c' || c === 'r' || c === 'L' || c === 'C' || c === 'R' || c === 'J' || c === 'S' || c === 'X' || c === 'Y' || c === 'Z') {
        const align = c === 'J' || c === 'X' || c === 'Y' || c === 'Z' ? 'p' : c === 'S' ? 'c' : c.toLowerCase()
        cols.push({ align: pendingAlign ?? align, width: null })
        vlines.push(0)
        pendingAlign = null
        if (c === 'S' || c === 'X') {
          let j = i + 1
          while (j < str.length && str[j] === ' ') j++
          if (str[j] === '[') {
            const close = str.indexOf(']', j)
            if (close !== -1) i = close
          }
        }
      } else if (c === 'p' || c === 'm' || c === 'b') {
        const g = readGroup(str, i + 1)
        cols.push({ align: pendingAlign ?? 'p', width: cssLength(g.content) })
        vlines.push(0)
        pendingAlign = null
        i = g.next - 1
      } else if (c === 'w' || c === 'W') {
        const a = readGroup(str, i + 1)
        const b = readGroup(str, a.next)
        cols.push({ align: /^[lcr]$/.test(a.content.trim()) ? a.content.trim() : 'l', width: cssLength(b.content) })
        vlines.push(0)
        i = b.next - 1
      } else if (c === 'D') {
        let g = readGroup(str, i + 1)
        g = readGroup(str, g.next)
        g = readGroup(str, g.next)
        cols.push({ align: 'c', width: null })
        vlines.push(0)
        i = g.next - 1
      } else if (c === '>') {
        const g = readGroup(str, i + 1)
        if (/\\centering|\\Centering/.test(g.content)) pendingAlign = 'c'
        else if (/\\raggedleft|\\RaggedLeft/.test(g.content)) pendingAlign = 'r'
        else if (/\\raggedright|\\RaggedRight/.test(g.content)) pendingAlign = 'l'
        i = g.next - 1
      } else if (c === '<' || c === '@' || c === '!') {
        const g = readGroup(str, i + 1)
        if (c === '!' && /\\vrule|\|/.test(g.content)) vlines[cols.length]++
        i = g.next - 1
      } else if (c === '*') {
        const n = readGroup(str, i + 1)
        const body = readGroup(str, n.next)
        const times = Math.min(32, Math.max(0, parseInt(n.content, 10) || 0))
        if (depth < 4) for (let k = 0; k < times; k++) walk(body.content, depth + 1)
        i = body.next - 1
      } else if (c === '{') {
        const g = readGroup(str, i)
        i = g.next - 1
      } else if (/[a-zA-Z]/.test(c)) {
        cols.push({ align: 'l', width: null })
        vlines.push(0)
      }
    }
  }
  walk(spec, 0)
  return { cols, vlines }
}

// ---------------------------------------------------------------------------------------------

export function renderPreview(source: string, options: PreviewOptions): PreviewResult {
  const src = (typeof source === 'string' ? source : '').replace(/\r\n?/g, '\n')
  try {
    return new Renderer(src, options).run()
  } catch (error) {
    let message = 'Unexpected error'
    try {
      message = error instanceof Error ? error.message : String(error)
    } catch {
      // keep the generic message
    }
    return {
      html: `<div class="rt-preview-error" data-line="1">Preview failed: ${esc(message)}</div><pre class="rt-verbatim" data-line="1"><code>${esc(src)}</code></pre>`,
      outline: [],
      wordCount: 0
    }
  }
}
