import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, assert, test } from 'orca/testing'
import { JobQueue, PictureCache, type Picture } from './cache'
import { compilePicture, literalFolder, placeError } from './compile'
import { assemble, defaultPreamble, NO_EDITS, packagesFor, preparePreamble, reducedPreamble, statementAt, statements } from './document'
import { chooseEngine, latexmkEngine, magicEngine, preambleEngine, programEngine } from './engine'
import { parseLog, recordedInputs } from './log'
import { findLatexmkrc, findRoot, namedRoot, preambleOf, referencedFiles } from './root'
import { finishSvg, sanitizeSvg } from './svg'
import { candidateFolders, findToolchain, plansFor, type Toolchain } from './toolchain'

const temporary: string[] = []
afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})
async function tempDir() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rich-tex-tex-')))
  temporary.push(dir)
  return dir
}
async function write(root: string, rel: string, content: string) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), content)
}

// ----- engine ---------------------------------------------------------------------------------

test('engine: magic comments, latexmkrc and the preamble, in that order', () => {
  assert.equal(magicEngine('% !TEX program = xelatex\n\\documentclass{article}'), 'xelatex')
  assert.equal(magicEngine('%!TeX TS-program = LuaLaTeX\n'), 'lualatex')
  assert.equal(magicEngine('% arara: pdflatex\n'), 'pdflatex')
  assert.equal(magicEngine('\\documentclass{article}\n% !TEX program = xelatex'), null, 'only the leading comments count')
  assert.equal(programEngine('pdflatex.exe'), 'pdflatex')
  assert.equal(latexmkEngine('$pdf_mode = 5;\n'), 'xelatex')
  assert.equal(latexmkEngine("$pdf_mode = 1;\n$pdflatex = 'lualatex %O %S';"), 'lualatex')
  assert.equal(latexmkEngine('# $pdf_mode = 4;\n'), null, 'a commented setting does not count')
  assert.equal(preambleEngine('\\documentclass{article}\n\\usepackage{fontspec}')?.engine, 'xelatex')
  assert.equal(preambleEngine('\\documentclass{article}\n\\usepackage{luacode}')?.engine, 'lualatex')
  assert.equal(preambleEngine('\\documentclass{article}\n% \\usepackage{fontspec}\n\\usepackage{kotex}'), null)
  assert.equal(preambleEngine('\\documentclass{jsarticle}')?.engine, 'platex')
  assert.equal(preambleEngine('\\documentclass[uplatex]{jsarticle}')?.engine, 'uplatex')
  assert.equal(preambleEngine('\\documentclass{ltjsarticle}')?.engine, 'lualatex')
  assert.equal(preambleEngine('\\documentclass{article}\\setmainhangulfont{Noto Serif CJK KR}')?.engine, 'xelatex')
  const both = '% !TEX program = lualatex\n\\documentclass{article}\n\\usepackage{fontspec}'
  assert.deepEqual(chooseEngine({ text: both, preamble: both, latexmkrc: '$pdf_mode = 5;' }), { engine: 'lualatex', reason: '% !TEX program' })
  assert.deepEqual(chooseEngine({ text: '', preamble: '\\usepackage{fontspec}', latexmkrc: '$pdf_mode = 4;' }), { engine: 'lualatex', reason: 'latexmkrc' })
  assert.deepEqual(chooseEngine({ text: '', preamble: '\\documentclass{article}' }), { engine: 'pdflatex', reason: 'default' })
})

// ----- the file a picture is compiled from ------------------------------------------------------

test('document: the packages a picture needs', () => {
  assert.deepEqual(packagesFor('\\begin{tikzpicture}\\begin{axis}\\addplot{x};\\end{axis}\\end{tikzpicture}').sort(), ['pgfplots', 'tikz'])
  assert.deepEqual(packagesFor('\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}').sort(), ['tikz', 'tikz-cd'])
  assert.deepEqual(packagesFor('\\xymatrix{A \\ar[r] & B}'), ['xy'])
  assert.deepEqual(packagesFor('% \\begin{forest}\n\\begin{circuitikz}\\end{circuitikz}').sort(), ['circuitikz', 'tikz'])
})

test('document: statements follow braces across lines', () => {
  const pre = '\\documentclass{article}\n\\newcommand{\\foo}{%\n  bar\n}\n\\usepackage{tikz} % {not counted\n\\def\\x{\\{}'
  assert.deepEqual(
    statements(pre).map((s) => [s.first, s.last]),
    [[1, 1], [2, 4], [5, 5], [6, 6]]
  )
  assert.deepEqual(statementAt(pre, 3), { first: 2, last: 4, text: '\\newcommand{\\foo}{%\n  bar\n}' })
})

test('document: the preamble is changed in place, line for line', () => {
  const pre = [
    '\\documentclass[11pt,twocolumn]{iclr}',
    '\\usepackage{tikz,iclrstyle,amsmath}',
    '\\usetikzlibrary{external}\\tikzexternalize[prefix=figs/]',
    '\\pdfoutput=1',
    '\\includeonly{ch1}',
    '\\newcommand{\\bad}{\\undefined}'
  ].join('\n')
  const out = preparePreamble(pre, 'dvi', { dropLines: [6], dropPackages: ['iclrstyle'], articleClass: true }).split('\n')
  assert.equal(out.length, 6)
  assert.equal(out[0], '\\documentclass[dvisvgm,11pt,twocolumn]{article}')
  assert.equal(out[1], '\\usepackage{tikz,amsmath}')
  assert.equal(out[2], '\\usetikzlibrary{external}\\relax')
  assert.equal(out[3], '')
  assert.equal(out[4], '')
  assert.match(out[5], /^%rte: skipped: /)
  assert.equal(preparePreamble('\\documentclass{article}', 'xdv', NO_EDITS), '\\documentclass[dvisvgm]{article}')
  assert.equal(preparePreamble('\\documentclass{article}\\pdfoutput=1', 'pdf', NO_EDITS), '\\documentclass{article}\\pdfoutput=1')
  assert.equal(preparePreamble('\\documentclass[t]{beamer}', 'pdf', NO_EDITS), '\\documentclass{article}\\usepackage{beamerarticle}')
  assert.equal(preparePreamble('\\documentclass[tikz,border=2pt]{standalone}', 'dvi', NO_EDITS), '\\documentclass[dvisvgm]{article}')
  assert.equal(preparePreamble('\\usepackage{iclrstyle}', 'pdf', { ...NO_EDITS, dropPackages: ['iclrstyle'] }), '')
})

test('document: the picture keeps its own lines, so errors map back', () => {
  const a = assemble({ preamble: '\\documentclass{article}\n\\usepackage{tikz}', snippet: '\\begin{tikzpicture}\n\\draw (0,0);\n\\end{tikzpicture}', mode: 'block', route: 'dvi' })
  const lines = a.source.split('\n')
  assert.equal(lines[0], '\\def\\pgfsysdriver{pgfsys-dvisvgm.def}')
  assert.equal(lines[a.preambleFirst - 1], '\\documentclass{article}')
  assert.equal(lines[a.snippetFirst - 1], '\\begin{tikzpicture}')
  assert.equal(lines[a.snippetFirst + 1], '\\end{tikzpicture}')
  assert.equal(a.snippetCount, 3)
  assert.match(a.source, /\\@ifpackageloaded\{tikz\}/)
  // Math: blank lines (the rest of a `\[` line) would end the paragraph inside math.
  const m = assemble({ preamble: '', snippet: '\n\\xymatrix{A}\n', mode: 'display-math', route: 'pdf' })
  const ml = m.source.split('\n')
  assert.equal(ml[m.snippetFirst - 2], '\\begin{rtesnippet}$\\displaystyle')
  assert.deepEqual(ml.slice(m.snippetFirst - 1, m.snippetFirst + 2), ['%', '\\xymatrix{A}', '%'])
  assert.equal(ml[m.snippetFirst + 2], '$%')
  assert.match(m.source, /\\pdfpagewidth|\\pagewidth/)
})

test('document: the reduced preamble keeps what a picture may use', () => {
  const pre = [
    '\\documentclass[12pt]{acmart}',
    '\\usepackage{acmstuff,amsmath,tikz}',
    '\\usetikzlibrary{positioning}',
    '\\newcommand{\\R}{\\mathbb{R}}',
    '\\tikzset{box/.style={draw,',
    '  rounded corners}}',
    '\\acmConference{X}',
    '\\setmainfont{Foo}'
  ].join('\n')
  const out = reducedPreamble(pre, 'snippet 한글', 'pdflatex', (name) => name !== 'acmstuff')
  assert.match(out, /^\\documentclass\[12pt\]\{article\}/)
  assert.match(out, /\\usepackage\{kotex\}/)
  assert.match(out, /\\usepackage\{amsmath,tikz\}/)
  assert.match(out, /\\usetikzlibrary\{positioning\}/)
  assert.match(out, /\\newcommand\{\\R\}/)
  assert.match(out, /\\tikzset\{box\/\.style=\{draw,\n {2}rounded corners\}\}/)
  assert.ok(!out.includes('acmConference') && !out.includes('setmainfont') && !out.includes('acmstuff'))
  assert.match(defaultPreamble('\\begin{axis}\\addplot{x};\\end{axis}'), /\\pgfplotsset\{compat=newest\}/)
})

// ----- TeX's log ----------------------------------------------------------------------------------

test('log: the first error, where it is, and what TeX had read', () => {
  const log = [
    'RTE-FONTSIZE:10',
    './snippet.tex:12: Undefined control sequence.',
    'l.12   \\drw',
    '            (0,0) -- (1,1);',
    'RTE-BOX:10.0pt:5.5pt:1.25pt',
    './snippet.tex:14: Another error.'
  ].join('\n')
  const out = parseLog(log)
  assert.deepEqual(out.error, {
    message: 'Undefined control sequence.',
    file: 'snippet.tex',
    line: 12,
    context: '  \\drw\n       (0,0) -- (1,1);',
    missing: null,
    afterBegin: true
  })
  assert.deepEqual(out.boxes, [{ width: 10, height: 5.5, depth: 1.25 }])
  assert.equal(out.fontSize, 10)
  const missing = parseLog("./snippet.tex:3: LaTeX Error: File `iclrstyle.sty' not found.\n\nType X to quit")
  assert.equal(missing.error?.missing, 'iclrstyle.sty')
  assert.equal(missing.error?.afterBegin, false)
  const table = parseLog("RTE-FONTSIZE:10\n./snippet.tex:20: Package pgfplots Error: Could not read table file 'data.csv'. In case you intended to provide inline data, maybe TeX screwed up your end-of-lines?")
  assert.equal(table.error?.missing, 'data.csv')
  const bang = parseLog('! Emergency stop.\n<*> snippet.tex\n')
  assert.equal(bang.error?.message, 'Emergency stop.')
  assert.equal(bang.error?.line, null)
  assert.deepEqual(recordedInputs('PWD /tmp/x\nINPUT ./snippet.tex\nINPUT /usr/share/tikz.sty\nOUTPUT snippet.log'), ['/tmp/x/./snippet.tex', '/usr/share/tikz.sty'])
})

test('compile: an error is placed in the picture, the preamble or elsewhere', () => {
  const a = { source: '', preambleFirst: 2, preambleCount: 5, snippetFirst: 20, snippetCount: 4 }
  const err = (line: number | null, file: string | null = 'snippet.tex') => ({ message: 'x', file, line, context: '', missing: null, afterBegin: true })
  assert.deepEqual(placeError(err(21), a, true), { where: 'picture', line: 2 })
  assert.deepEqual(placeError(err(25), a, true), { where: 'picture', line: 4 }, 'an unclosed environment surfaces on the closing lines')
  assert.deepEqual(placeError(err(4), a, false), { where: 'preamble', line: 3 })
  assert.deepEqual(placeError(err(12), a, false), { where: 'other' })
  assert.deepEqual(placeError(err(5, 'mystyle.sty'), a, false), { where: 'file' })
  assert.deepEqual(placeError(err(null), a, true), { where: 'picture', line: 1 })
})

// ----- SVG ----------------------------------------------------------------------------------------

test('svg: padding, baseline from the marker or the depth, nothing active', () => {
  const raw = "<?xml version='1.0'?><svg version='1.1' xmlns='http://www.w3.org/2000/svg' width='30pt' height='20pt' viewBox='0 0 30 20'><g class='rte-base' data-y='15'/><path d='M0 0'/></svg>"
  const drawn = finishSvg(raw, null)
  assert.ok(drawn)
  assert.equal(drawn.width, 33)
  assert.equal(drawn.height, 23)
  assert.equal(drawn.depth, 6.5)
  assert.ok(!drawn.svg.includes('rte-base'))
  assert.match(drawn.svg, /viewBox="-1\.5 -1\.5 33 23"/)
  const cairo = '<svg xmlns="http://www.w3.org/2000/svg" width="72pt" height="36pt" viewBox="0 0 72 36"><g/></svg>'
  assert.equal(finishSvg(cairo, 10.0375)?.depth, 11.5)
  assert.equal(finishSvg('<svg><g/></svg>', null), null)
  const dirty = `<svg viewBox='0 0 1 1'><script>alert(1)</script><a xlink:href='https://x.test'><path onclick="steal()" d='M0'/></a><use xlink:href='#g1'/><image href='data:image/png;base64,AA'/><image href='file:///etc/passwd'/><foreignObject><div/><p>x</p></foreignObject><rect style="fill:url(https://x.test/a)"/><rect fill='url(#grad)'/><svg:script>bad()</svg:script><use x:href='https://x.test'/><rect style='fill:u\\72l(https://x.test)'/><style>@import url(https://x.test);</style><style>.a{fill:red}</style><!-- c --><text>url( is fine in text</text></svg>`
  const clean = sanitizeSvg(dirty)
  assert.ok(!/script|onclick|x\.test|passwd|foreignObject|<p>|bad\(\)|72l|@import/.test(clean), clean)
  assert.match(clean, /<use xlink:href="#g1"\/>/)
  assert.match(clean, /<image href="data:image\/png;base64,AA"\/>/)
  assert.match(clean, /<rect fill="url\(#grad\)"\/>/)
  assert.match(clean, /<style>\.a\{fill:red\}<\/style>/)
  assert.match(clean, /<text>url\( is fine in text<\/text>/)
  assert.match(clean, /<a><path d="M0"\/><\/a>/)
  const refs = sanitizeSvg(`<svg><rect fill='u&#x72;l(http://e.x/a)'/><style>.a{fill:u&#114;l(http://e.x)}</style><text>A &amp; B</text></svg>`)
  assert.ok(!/e\.x|&#/.test(refs), refs)
  assert.match(refs, /<text>A &amp; B<\/text>/)
})

test('svg: cleaning takes time in proportion to the size, whatever the input', () => {
  // What a document can put in a drawing with \special{dvisvgm:raw …}: once quadratic.
  const nasty = `<svg viewBox='0 0 1 1'>${'<text>url(</text>'.repeat(60000)}${'<a b="'.repeat(20000)}</svg>`
  const started = Date.now()
  sanitizeSvg(nasty)
  sanitizeSvg(`<svg>${'<g style="url(#a) url(#b) '.repeat(30000)}`)
  sanitizeSvg(`<svg>${'<script>'.repeat(50000)}${'</script>'.repeat(50000)}<path d="M0"/></svg>`)
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`)
})

// ----- toolchain ----------------------------------------------------------------------------------

test('toolchain: the ways each engine is drawn', () => {
  const all: Toolchain = {
    bin: { latex: '/t/latex', pdflatex: '/t/pdflatex', xelatex: '/t/xelatex', lualatex: '/t/lualatex', dvilualatex: '/t/dvilualatex', platex: '/t/platex', dvisvgm: '/t/dvisvgm', pdftocairo: '/b/pdftocairo' },
    postscript: false,
    distribution: 'TeX Live 2025'
  }
  const routes = (engine: Parameters<typeof plansFor>[0], tools = all, ps = false) => plansFor(engine, tools, ps).map((p) => `${path.basename(p.program)}:${p.route}`)
  assert.deepEqual(routes('pdflatex'), ['latex:dvi', 'pdflatex:pdf'])
  assert.deepEqual(routes('xelatex'), ['xelatex:xdv'], 'never XeLaTeX to PDF: xdvipdfmx reads any picture file')
  assert.deepEqual(routes('lualatex'), ['lualatex:pdf', 'dvilualatex:dvi', 'xelatex:xdv'])
  assert.deepEqual(routes('platex'), ['platex:dvi'])
  assert.deepEqual(routes('pdflatex', all, true), ['pdflatex:pdf'], 'PSTricks without Ghostscript: pdfLaTeX only (which then cannot draw it)')
  const noConverter = { ...all, bin: { ...all.bin, pdftocairo: undefined } }
  assert.deepEqual(routes('lualatex', noConverter), ['dvilualatex:dvi', 'xelatex:xdv'])
  assert.deepEqual(routes('pdflatex', { ...all, bin: {} }), [])
  for (const engine of ['pdflatex', 'xelatex', 'lualatex', 'platex'] as const) {
    for (const plan of plansFor(engine, all, false)) assert.ok(plan.args.includes('-no-shell-escape'), `${engine}: ${plan.program}`)
  }
  for (const plan of plansFor('lualatex', all, false).filter((p) => /lua/.test(p.program))) {
    assert.ok(plan.args.includes('--safer') && plan.args.includes('--nosocket'), 'Lua from the document cannot write, run or connect')
  }
})

test('toolchain: TeX is looked for where distributions install it', async () => {
  const mac = await candidateFolders({ PATH: '/usr/bin:/bin' }, 'darwin', '/Users/x')
  assert.ok(mac.indexOf('/usr/bin') < mac.indexOf('/Library/TeX/texbin'), 'PATH first')
  assert.ok(mac.includes('/Library/TeX/texbin'))
  const win = await candidateFolders({ Path: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32', 'C:\\Users\\x')
  assert.ok(win.some((d) => d.includes('MiKTeX')))
})

// ----- the root document of a section file ----------------------------------------------------------

test('root: the document that includes a section file, through several levels', async () => {
  const root = await tempDir()
  await write(root, 'paper/main.tex', '% !TEX program = xelatex\n\\documentclass{article}\n\\usepackage{tikz}\n\\begin{document}\n\\input{chapters/ch1}\n\\end{document}\n')
  await write(root, 'paper/chapters/ch1.tex', '\\section{One}\n\\include{chapters/parts/p1}\n')
  await write(root, 'paper/chapters/parts/p1.tex', 'text\n')
  await write(root, 'paper/other.tex', '\\documentclass{article}\\begin{document}\\input{elsewhere}\\end{document}')
  const found = await findRoot(root, path.join(root, 'paper/chapters/parts/p1.tex'), 'text\n')
  assert.equal(found?.file, path.join(root, 'paper/main.tex'))
  assert.equal(found?.preamble, '% !TEX program = xelatex\n\\documentclass{article}\n\\usepackage{tikz}\n')
  assert.equal(await findRoot(root, path.join(root, 'paper/lonely.tex'), ''), null)
})

test('root: a `% !TEX root` comment or the subfiles class names it, inside the workspace only', async () => {
  const root = await tempDir()
  const outside = await tempDir()
  await write(root, 'main.tex', '\\documentclass{book}\n\\begin{document}\\end{document}')
  await write(outside, 'evil.tex', '\\documentclass{article}\n\\usepackage{secret}\n\\begin{document}\\end{document}')
  await fs.symlink(path.join(outside, 'evil.tex'), path.join(root, 'link.tex'))
  assert.equal(namedRoot('% !TEX root = ../main.tex\n\\section{x}'), '../main.tex')
  assert.equal(namedRoot('\\documentclass[../main.tex]{subfiles}'), '../main.tex')
  const named = await findRoot(root, path.join(root, 'sec/a.tex'), '% !TeX root = ../main\n')
  assert.equal(named?.file, path.join(root, 'main.tex'))
  const linked = await findRoot(root, path.join(root, 'sec/a.tex'), '% !TEX root = ../link.tex\n')
  assert.ok(linked === null || !linked.preamble.includes('secret'), 'a link out of the workspace is not followed')
  assert.deepEqual(referencedFiles('\\input{a}\\subimport{sub/}{b.tex} % \\input{c}', ['/w/s', '/w']), ['/w/s/a', '/w/s/a.tex', '/w/a', '/w/a.tex', '/w/s/sub/b.tex', '/w/s/sub/b.tex'])
  assert.equal(preambleOf('pre\\begin{document}body'), 'pre')
  await write(root, '.latexmkrc', '$pdf_mode = 4;')
  assert.equal(await findLatexmkrc(root, path.join(root, 'sec')), '$pdf_mode = 4;')
})

// ----- cache and queue ----------------------------------------------------------------------------

const picture = (key: string, deps: Picture['deps'] = []): Picture => ({
  key,
  svg: '<svg/>',
  width: 1,
  height: 1,
  depth: 0,
  fontSize: 10,
  label: 'pdfLaTeX',
  notes: [],
  deps
})

test('cache: kept on disk, and dropped when a file the picture read changes', async () => {
  const dir = await tempDir()
  const key = 'a'.repeat(64)
  await new PictureCache(dir).put(picture(key))
  assert.equal((await new PictureCache(dir).get(key))?.svg, '<svg/>', 'a new cache (a restarted worker) reads it from disk')
  const data = path.join(dir, 'data.csv')
  await fs.writeFile(data, '1,2\n')
  const stat = await fs.stat(data)
  const cache = new PictureCache(null)
  const withDeps = 'b'.repeat(64)
  await cache.put(picture(withDeps, [{ file: data, size: stat.size, mtimeMs: stat.mtimeMs }]))
  assert.ok(await cache.get(withDeps))
  await fs.writeFile(data, '1,2\n3,4\n')
  assert.equal(await cache.get(withDeps), null)
  assert.equal(await new PictureCache(dir).get('../etc'), null, 'a key that is not a hash is never a path')
})

test('queue: one job per key, at most the limit at once, cancelled only when everyone left', async () => {
  const queue = new JobQueue<string>(1)
  let running = 0
  let most = 0
  const job = (value: string, ms: number) => async (signal: AbortSignal) => {
    running++
    most = Math.max(most, running)
    await new Promise((r) => setTimeout(r, ms))
    running--
    return signal.aborted ? 'cancelled' : value
  }
  let calls = 0
  const counted = (signal: AbortSignal) => {
    calls++
    return job('a', 20)(signal)
  }
  const [a1, a2, b] = await Promise.all([queue.run('a', counted), queue.run('a', counted), queue.run('b', job('b', 5))])
  assert.deepEqual([a1, a2, b, calls, most], ['a', 'a', 'b', 1, 1])
  const left = new AbortController()
  const stays = new AbortController()
  const p1 = queue.run('c', job('c', 30), left.signal)
  const p2 = queue.run('c', job('c', 30), stays.signal)
  left.abort()
  assert.deepEqual(await Promise.all([p1, p2]), ['c', 'c'], 'one asker leaving does not cancel the others')
  const alone = new AbortController()
  const p3 = queue.run('d', job('d', 30), alone.signal)
  alone.abort()
  assert.equal(await p3, 'cancelled')
  assert.equal(await queue.run('d', job('d2', 5)), 'd2', 'a cancelled job is not joined')
})

// ----- limits on a run --------------------------------------------------------------------------

test('compile: folders kpathsea would expand are not searched', () => {
  assert.equal(literalFolder('/Users/me/paper'), true)
  assert.equal(literalFolder('/Users/me/My Paper (v2)'), true)
  assert.equal(literalFolder('/Users/me/Library/Mobile Documents/com~apple~CloudDocs/paper'), true, 'iCloud Drive')
  assert.equal(literalFolder('/w/Notes!/x'), true)
  for (const dir of ['/w/x:~', '/w/$HOME', '/w/{a,b}', '/w/a;b']) assert.equal(literalFolder(dir), false, dir)
})

test('compile: MiKTeX is not run, a spent deadline stops, a run that writes too much is killed', async () => {
  const tools = await findToolchain()
  const base = { preamble: '\\documentclass{article}\n\\usepackage{tikz}', mode: 'block' as const, engine: { engine: 'pdflatex' as const, reason: 'default' }, texInputs: [] }
  const miktex = await compilePicture({ ...base, snippet: '\\tikz \\draw (0,0);', tools: { ...tools, distribution: 'MiKTeX 24.1' } })
  assert.equal(miktex.ok, false)
  if (!miktex.ok) assert.equal(miktex.reason, 'unavailable')
  if (!tools.bin.latex || !tools.bin.dvisvgm) return
  const late = await compilePicture({ ...base, snippet: '\\tikz \\draw (0,0);', tools, deadline: Date.now() - 1 })
  assert.equal(!late.ok && late.reason, 'busy', 'never run: not a timeout to remember')
  const flood = '\\newwrite\\f\\immediate\\openout\\f=flood.txt\\def\\x{\\immediate\\write\\f{' + 'x'.repeat(900) + '}\\x}\\x'
  const started = Date.now()
  const big = await compilePicture({ ...base, snippet: flood, tools })
  assert.equal(big.ok, false)
  if (!big.ok) assert.match(big.message, /more than 64 MB|took longer/)
  assert.ok(Date.now() - started < 26000)
})

test('compile: a picture file named by absolute path is never drawn in, even with XeLaTeX', async () => {
  const tools = await findToolchain()
  if (!tools.bin.xelatex || !tools.bin.dvisvgm) return
  const dir = await tempDir()
  // A real PNG, outside every folder the picture may read.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await fs.writeFile(path.join(dir, 'photo.png'), png)
  // The document tries to force another route first, as an attacker would.
  const force = '\\makeatletter\\def\\rte@x{pgfsys-dvisvgm.def}\\ifx\\pgfsysdriver\\rte@x\\errmessage{Cannot determine size of graphic}\\fi\\makeatother'
  for (const snippet of [`\\XeTeXpicfile "${dir}/photo.png" width 2cm`, `${force}\\XeTeXpicfile "${dir}/photo.png" width 2cm`]) {
    const r = await compilePicture({ preamble: '\\documentclass{article}', snippet, mode: 'block', engine: { engine: 'xelatex', reason: 't' }, texInputs: [], tools })
    assert.ok(!r.ok || !r.drawn.svg.includes('data:image'), snippet)
  }
})
