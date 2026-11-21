import { assert, test } from 'orca/testing'
import { type Construct, plainText, scan } from './scan'

const kinds = (src: string) => scan(src).constructs.map((c) => c.kind)
const first = <K extends Construct['kind']>(src: string, kind: K) =>
  scan(src).constructs.find((c): c is Extract<Construct, { kind: K }> => c.kind === kind)
const slice = (src: string, c: { from: number; to: number }) => src.slice(c.from, c.to)

test('inline and display math with every delimiter', () => {
  const src = 'a $x^2$ b \\(y\\) c $$z$$ d \\[w\\] e'
  const math = scan(src).constructs.filter((c) => c.kind === 'math')
  assert.deepEqual(
    math.map((m) => [slice(src, m), m.display, src.slice(m.bodyFrom, m.bodyTo)]),
    [
      ['$x^2$', false, 'x^2'],
      ['\\(y\\)', false, 'y'],
      ['$$z$$', true, 'z'],
      ['\\[w\\]', true, 'w']
    ]
  )
})

test('math environments, with the environment name and body', () => {
  const src = 'x\n\\begin{align*}\na &= b \\\\\nc &= d\n\\end{align*}\ny'
  const m = first(src, 'math')
  assert.ok(m)
  assert.equal(m.env, 'align*')
  assert.equal(m.display, true)
  assert.equal(slice(src, m), '\\begin{align*}\na &= b \\\\\nc &= d\n\\end{align*}')
  assert.equal(src.slice(m.bodyFrom, m.bodyTo), '\na &= b \\\\\nc &= d\n')
})

test('unterminated math stays source', () => {
  assert.deepEqual(kinds('price $5 and more\n\nnext'), [])
  assert.deepEqual(kinds('\\begin{equation} x = 1'), ['env'])
  assert.deepEqual(kinds('\\[ x'), [])
})

test('escaped dollars are not math', () => {
  const c = scan('costs \\$5 or \\$6').constructs
  assert.deepEqual(c.map((x) => x.kind), ['symbol', 'symbol'])
})

test('comments run to the end of the line, but not escaped percent signs', () => {
  const src = '50\\% done % a note\nnext'
  const c = scan(src).constructs
  assert.deepEqual(c.map((x) => [x.kind, slice(src, x)]), [
    ['symbol', '\\%'],
    ['comment', '% a note']
  ])
})

test('headings are numbered, starred ones are not', () => {
  const src = '\\section{Intro}\n\\subsection{A}\n\\subsection*{B}\n\\section{Next}\n\\subsection{C}'
  const h = scan(src).constructs.filter((c) => c.kind === 'heading')
  assert.deepEqual(h.map((x) => [x.cmd, x.number, src.slice(x.argFrom, x.argTo)]), [
    ['section', '1', 'Intro'],
    ['subsection', '1.1', 'A'],
    ['subsection', null, 'B'],
    ['section', '2', 'Next'],
    ['subsection', '2.1', 'C']
  ])
})

test('chapters prefix section numbers and appendix switches to letters', () => {
  const src = '\\chapter{One}\\section{S}\\appendix\\chapter{Extra}\\section{T}'
  const h = scan(src).constructs.filter((c) => c.kind === 'heading')
  assert.deepEqual(h.map((x) => x.number), ['1', '1.1', 'A', 'A.1'])
})

test('headings with a short title and math inside', () => {
  const src = '\\section[Short]{Long $x$ title}'
  const c = scan(src).constructs
  assert.deepEqual(c.map((x) => x.kind), ['heading', 'math'])
  const h = c[0] as Extract<Construct, { kind: 'heading' }>
  assert.equal(src.slice(h.argFrom, h.argTo), 'Long $x$ title')
})

test('nested formatting', () => {
  const src = '\\textbf{bold \\emph{both}} \\texttt{code}'
  const f = scan(src).constructs.filter((c) => c.kind === 'format')
  assert.deepEqual(f.map((x) => [x.style, src.slice(x.argFrom, x.argTo)]), [
    ['bold', 'bold \\emph{both}'],
    ['emph', 'both'],
    ['mono', 'code']
  ])
})

test('a formatting argument cut by a blank line is not formatted', () => {
  assert.deepEqual(kinds('\\textbf{open\n\nnext}'), [])
})

test('links keep their target', () => {
  const src = '\\href{https://example.com}{the site} and \\url{https://a.b/c}'
  const f = scan(src).constructs.filter((c) => c.kind === 'format')
  assert.deepEqual(f.map((x) => [x.url, src.slice(x.argFrom, x.argTo)]), [
    ['https://example.com', 'the site'],
    ['https://a.b/c', 'https://a.b/c']
  ])
})

test('textcolor accepts names and hex only', () => {
  const a = first('\\textcolor{red}{x}', 'format')
  const b = first('\\textcolor{url(evil)}{x}', 'format')
  assert.equal(a?.color, 'red')
  assert.equal(b?.color, undefined)
})

test('labels resolve to sections and figure captions', () => {
  const src = [
    '\\section{Intro}\\label{sec:intro}',
    '\\begin{figure}[h]',
    '\\caption{A plot}\\label{fig:plot}',
    '\\end{figure}',
    '\\begin{table}\\caption{Data}\\label{tab:data}\\end{table}',
    'See \\ref{sec:intro}, \\cref{fig:plot} and \\cite[p.~2]{knuth, lamport}.'
  ].join('\n')
  const r = scan(src)
  assert.deepEqual(r.labels.get('sec:intro'), { number: '1', kind: 'section' })
  assert.deepEqual(r.labels.get('fig:plot'), { number: '1', kind: 'figure' })
  assert.deepEqual(r.labels.get('tab:data'), { number: '1', kind: 'table' })
  const caption = r.constructs.find((c) => c.kind === 'format' && c.style === 'caption')
  assert.equal(caption && 'prefix' in caption ? caption.prefix : null, 'Figure 1')
  const cite = r.constructs.find((c) => c.kind === 'ref' && c.cmd === 'cite')
  assert.deepEqual(cite && 'keys' in cite ? cite.keys : null, ['knuth', 'lamport'])
})

test('list items get markers by kind and depth', () => {
  const src = [
    '\\begin{enumerate}',
    '\\item one',
    '\\item two',
    '\\begin{itemize}',
    '\\item inner',
    '\\end{itemize}',
    '\\item[x)] custom',
    '\\end{enumerate}',
    '\\begin{description}\\item[Term] text\\end{description}'
  ].join('\n')
  const r = scan(src)
  const items = r.constructs.filter((c) => c.kind === 'item')
  assert.deepEqual(items.map((i) => [i.list, i.depth, i.marker, i.custom]), [
    ['enumerate', 1, '1.', false],
    ['enumerate', 1, '2.', false],
    ['itemize', 2, '–', false],
    ['enumerate', 1, 'x)', true],
    ['description', 1, 'Term', true]
  ])
  assert.deepEqual(r.lists.map((l) => [l.list, l.depth]), [
    ['enumerate', 1],
    ['itemize', 2],
    ['description', 1]
  ])
  assert.equal(r.lists[0].to, src.indexOf('\\end{enumerate}') + '\\end{enumerate}'.length)
})

test('an unclosed list runs to the end', () => {
  const src = '\\begin{itemize}\n\\item a'
  assert.equal(scan(src).lists[0].to, src.length)
})

test('typographic symbols and accents', () => {
  const src = "pages 1--2 --- ``quoted'' \\'ecole \\\"{o} \\c{c} \\ldots{} \\ss"
  const s = scan(src).constructs.filter((c) => c.kind === 'symbol')
  assert.deepEqual(s.map((x) => x.text), ['–', '—', '“', '”', 'é', 'ö', 'ç', '…', 'ß'])
})

test('a tie is a non-breaking space', () => {
  const s = scan('Section~1').constructs
  assert.deepEqual(s.map((c) => (c.kind === 'symbol' ? c.text : c.kind)), ['\u00a0'])
})

test('verbatim content is not scanned', () => {
  const src = '\\begin{verbatim}\n$x$ % not a comment \\textbf{x}\n\\end{verbatim} \\verb|$y$|'
  assert.deepEqual(kinds(src), ['verbatim', 'verbatim'])
})

test('the comment environment is one comment', () => {
  assert.deepEqual(kinds('\\begin{comment}\n$x$\n\\end{comment}'), ['comment'])
})

test('document start, title and maketitle', () => {
  const src = '\\documentclass{article}\n\\title{A \\textbf{Title}}\n\\author{Me \\and You}\n\\begin{document}\n\\maketitle\n\\end{document}'
  const r = scan(src)
  assert.equal(r.documentStart, src.indexOf('\\begin{document}'))
  assert.equal(r.title, 'A \\textbf{Title}')
  assert.equal(plainText(r.title ?? ''), 'A Title')
  assert.ok(r.constructs.some((c) => c.kind === 'maketitle'))
})

test('images and environment options', () => {
  const src = '\\begin{theorem}[Pythagoras]\\includegraphics[width=3cm]{fig/plot.pdf}\\end{theorem}'
  const r = scan(src)
  const env = r.constructs.find((c) => c.kind === 'env' && c.begin)
  assert.equal(env && 'option' in env ? env.option : null, 'Pythagoras')
  const image = r.constructs.find((c) => c.kind === 'image')
  assert.equal(image && 'file' in image ? image.file : null, 'fig/plot.pdf')
})

test('constructs come sorted, parents before children', () => {
  const r = scan('\\section{A \\textbf{b $c$}} $d$')
  const froms = r.constructs.map((c) => c.from)
  assert.deepEqual(froms, [...froms].sort((a, b) => a - b))
  assert.equal(r.constructs[0].kind, 'heading')
})

test('garbage input terminates', () => {
  const nasty = ['\\', '{', '}', '$', '$$', '\\[', '\\begin{', '\\end{x}', '%', '\\verb', '\\item[', '``', '--']
  let seed = 3
  let src = ''
  for (let i = 0; i < 4000; i++) {
    seed = (seed * 16807) % 2147483647
    src += nasty[seed % nasty.length] + (seed % 7 === 0 ? '\n' : ' ')
  }
  const r = scan(src)
  assert.ok(Array.isArray(r.constructs))
  for (const c of r.constructs) assert.ok(c.from >= 0 && c.to <= src.length && c.from <= c.to)
})

test('a long document scans quickly', () => {
  const para =
    'The \\textbf{energy} $E = mc^2$ of a body, see \\cite{einstein} and \\ref{eq:1}. ' +
    "It's ``quoted'' -- like \\emph{this}.\n\n"
  const src = '\\begin{document}\n' + '\\section{Part}\n'.concat(para.repeat(40)).repeat(50) + '\\end{document}'
  const started = performance.now()
  const r = scan(src)
  const took = performance.now() - started
  assert.ok(r.constructs.length > 10000)
  assert.ok(took < 150, `took ${took}ms`)
})

test('bibitems carry their optional label or their number', () => {
  const r = scan('\\begin{thebibliography}{9}\\bibitem[Kn84]{knuth} A.\\bibitem{lamport} B.\\end{thebibliography}')
  const items = r.constructs.filter((c) => c.kind === 'bibitem')
  assert.deepEqual(items.map((c) => [c.key, c.label]), [
    ['knuth', 'Kn84'],
    ['lamport', '2']
  ])
})

test('a commented-out chapter does not change section numbers', () => {
  const r = scan('% \\chapter{Old}\n\\section{One}')
  const h = r.constructs.find((c) => c.kind === 'heading')
  assert.equal(h && 'number' in h ? h.number : null, '1')
})
