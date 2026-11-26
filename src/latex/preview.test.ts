import { assert, test } from 'orca/testing'
import katex from 'katex'
import { DISPLAY_MATH_ENVS } from './math'
import { renderPreview, type PreviewOptions } from './preview'

/** Shows each formula as `{D:tex}` / `{I:tex}` so tests can read what reached the renderer. */
const stub: PreviewOptions = { renderMath: (tex, display) => `{${display ? 'D' : 'I'}:${tex}}` }
const realKatex: PreviewOptions = {
  renderMath: (tex, displayMode, macros) => katex.renderToString(tex, { displayMode, macros: { ...macros }, throwOnError: true, strict: 'ignore' })
}
const html = (src: string) => renderPreview(src, stub).html
const text = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '\u00a0').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const doc = (body: string, preamble = '') => `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`

const VOID = new Set(['br', 'hr', 'img', 'wbr'])
/** The opening tags of the top-level elements of an HTML fragment. */
function topLevel(fragment: string): string[] {
  const out: string[] = []
  let depth = 0
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(fragment)) !== null) {
    const [whole, close, tag] = m
    if (close) depth--
    else {
      if (depth === 0) out.push(whole)
      if (!VOID.has(tag.toLowerCase()) && !whole.endsWith('/>')) depth++
    }
  }
  return out
}
const lineOf = (openTag: string) => Number(/data-line="(\d+)"/.exec(openTag)?.[1] ?? NaN)

test('paragraphs split on blank lines and carry their source line', () => {
  const src = 'First line\nstill first.\n\n\nSecond   paragraph.\n%comment only\nThird? no, same paragraph.\n\n  Third.'
  const blocks = topLevel(html(src))
  assert.equal(blocks.length, 3)
  assert.deepEqual(blocks.map(lineOf), [1, 5, 9])
  assert.ok(text(html(src)).includes('Second paragraph. Third? no'))
})

test('every top-level block of a realistic document carries data-line', () => {
  const src = doc(String.raw`\maketitle
\begin{abstract}
Short.
\end{abstract}
\tableofcontents
\section{Intro}
Text one.

Text two with math
\begin{equation} x = 1 \end{equation}
continued.
\[ y \]
\begin{itemize} \item a \end{itemize}
\begin{figure} \includegraphics{a.png} \caption{C} \end{figure}
\begin{tabular}{ll} a & b \end{tabular}
\begin{verbatim}
raw
\end{verbatim}
\begin{quote} Q \end{quote}
\begin{theorem} T \end{theorem}
\begin{proof} P \end{proof}
\begin{center} C \end{center}
Footnote\footnote{F}.
\begin{thebibliography}{1} \bibitem{k} K. \end{thebibliography}`, '\\title{T}\\author{A}')
  const out = html(src)
  const blocks = topLevel(out)
  assert.ok(blocks.length >= 18, String(blocks.length))
  const lines: number[] = []
  for (const b of blocks) {
    if (b.startsWith('<section class="rt-footnotes"')) {
      assert.ok(!b.includes('data-line'))
      continue
    }
    assert.ok(/data-line="\d+"/.test(b), b)
    lines.push(lineOf(b))
  }
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i] >= lines[i - 1], `lines go backwards: ${lines.join(',')}`)
  // Spot-check a few exact lines (body starts on line 4).
  const at = (needle: string) => lineOf(blocks.find((b) => b.includes(needle)) ?? '')
  assert.equal(at('rt-titleblock'), 4)
  assert.equal(at('rt-abstract'), 5)
  assert.equal(at('rt-section'), 9)
  assert.equal(at('rt-math-display'), 13)
  // The footnotes section holds no data-line at all.
  const footnotes = out.slice(out.indexOf('<section class="rt-footnotes"'))
  assert.ok(!footnotes.includes('data-line'))
})

test('only the document body renders; the preamble feeds title, author and date', () => {
  const src = doc('\\maketitle\nBody.', '\\title{My \\emph{Title}}\n\\author{Ada \\and Alan\\thanks{Fund.}}\n\\date{\\today}\n\\usepackage{amsmath}')
  const out = html(src)
  assert.match(out, /<h1 class="rt-title">My <em>Title<\/em><\/h1>/)
  assert.equal((out.match(/class="rt-author"/g) ?? []).length, 2)
  assert.match(out, /class="rt-date">[A-Z][a-z]+ \d{1,2}, \d{4}</)
  assert.ok(!out.includes('amsmath') && !out.includes('documentclass'))
  assert.ok(text(out).includes('Fund.'))
})

test('section numbering: hierarchy, starred, chapters, appendix', () => {
  const a = renderPreview(doc('\\section{A}\\subsection{B}\\subsubsection{C}\\section*{D}\\section{E}\\subsection[Short]{Long}\\paragraph{P}'), stub)
  assert.deepEqual(
    a.outline.map((o) => [o.level, o.title, o.number]),
    [[1, 'A', '1'], [2, 'B', '1.1'], [3, 'C', '1.1.1'], [1, 'D', null], [1, 'E', '2'], [2, 'Short', '2.1'], [4, 'P', null]]
  )
  assert.ok(a.html.includes('Long'))
  const b = renderPreview(doc('\\chapter{One}\\section{S}\\chapter{Two}\\section{T}\\appendix\\chapter{App}\\section{X}'), stub)
  assert.deepEqual(b.outline.map((o) => o.number), ['1', '1.1', '2', '2.1', 'A', 'A.1'])
  const c = renderPreview(doc('\\section{S}\\appendix\\section{First}\\subsection{Sub}\\section{Second}'), stub)
  assert.deepEqual(c.outline.map((o) => o.number), ['1', 'A', 'A.1', 'B'])
  assert.ok(c.outline.every((o) => o.line > 0))
  const p = renderPreview(doc('\\part{Intro}\\section{S}'), stub)
  assert.deepEqual(p.outline.map((o) => [o.level, o.number]), [[-1, 'I'], [1, '1']])
})

test('labels resolve for sections, figures, tables, equations, theorems and items (two-pass)', () => {
  const src = doc(String.raw`See \ref{sec:b}, \ref{fig:x}, \ref{tab:y}, \eqref{eq:z}, \ref{thm:t}, \ref{it:two}, \ref{nope}.
\section{A}\label{sec:a}
\section{B}\label{sec:b}
\begin{figure}\caption{Fig}\label{fig:x}\end{figure}
\begin{figure}\caption{Fig 2}\label{fig:x2}\end{figure}
\begin{table}\caption{Tab}\label{tab:y}\end{table}
\begin{equation} a \label{eq:w} \end{equation}
\begin{equation} b \label{eq:z} \end{equation}
\begin{theorem}\label{thm:t} T. \end{theorem}
\begin{enumerate}\item one \item two \label{it:two}\end{enumerate}
\autoref{fig:x2} \cref{eq:z} \Cref{sec:a} \nameref{sec:b}`)
  const t = text(html(src))
  assert.ok(t.includes('See 2, 1, 1, (2), 1, 2, ??.'), t)
  assert.ok(t.includes('Figure 2 eq. (2) Section 1 B'), t)
  assert.ok(html(src).includes('rt-ref-missing'))
})

test('equation numbers run document-wide across align rows, \\nonumber and \\eqref', () => {
  const src = doc(String.raw`\begin{equation} x \label{e1} \end{equation}
\begin{align}
a &= b \label{e2} \\
c &= d \nonumber \\
e &= f \label{e3}
\end{align}
\begin{equation*} y \end{equation*}
\begin{gather} g \\ h \label{e5} \end{gather}
\eqref{e1} \eqref{e2} \eqref{e3} \eqref{e5}`)
  const out = html(src)
  assert.ok(text(out).includes('(1) (2) (3) (5)'), text(out))
  assert.match(out, /\{D: x \\tag\{1\}\}/)
  assert.match(out, /a &= b \\tag\{2\}/)
  assert.ok(!/c &= d \\tag/.test(out))
  assert.match(out, /e &= f \\tag\{3\}/)
  assert.match(out, /\{D: y \}/)
  assert.match(out, /g \\tag\{4\}\\\\ h \\tag\{5\}/)
})

test('\\eqref inside math becomes text with the resolved number', () => {
  const out = html(doc('\\begin{equation} a \\label{q} \\end{equation} $x \\overset{\\eqref{q}}{=} y$'))
  assert.ok(out.includes('\\overset{\\text{(1)}}{=}'), out)
})

test('text is escaped everywhere; links keep only http(s)/mailto and never get an href', () => {
  const out = html(
    doc(String.raw`<script>alert(1)</script> & "q" 'a'
\href{https://ex.com/?a=1&b="2"}{<b>bold</b>}
\href{javascript:alert(1)}{click}
\href{ JAVASCRIPT:alert(1)}{x} \href{data:text/html,<script>}{y} \href{mailto:a@b.c}{mail}
\url{http://x.y/<img src=x onerror=alert(1)>} \url{javascript:void(0)}
\textbf{<img src=x>} \verb|<i>| \section{<h1>}`)
  )
  assert.ok(!/<script|<img|<b>bold|<i>|<h1>/i.test(out), out)
  assert.ok(!/\shref=/.test(out), 'no href attributes')
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(out.includes('data-href="https://ex.com/?a=1&amp;b=&quot;2&quot;"'))
  assert.ok(out.includes('data-href="mailto:a@b.c"'))
  assert.ok(!/data-href="[^"]*(javascript|data:)/i.test(out), out)
  assert.ok(out.includes('<span class="rt-link-text">click</span>'))
  const links = out.match(/class="rt-link[ "][^>]*>/g) ?? []
  assert.equal(links.length, 3)
})

test('inline formatting, style groups and declarations', () => {
  const out = html('\\textbf{bold \\textit{both}} \\emph{em} {\\bf b} {\\it i} {\\em e} {\\tt t} {\\bfseries x {\\itshape y}} \\texttt{code} \\textsc{Sc} \\underline{u} z')
  assert.ok(out.includes('<b>bold <i>both</i></b>'))
  assert.ok(out.includes('<em>em</em>'))
  assert.ok(out.includes('<span class="rt-bf">b</span>'))
  assert.ok(out.includes('<span class="rt-it">i</span>'))
  assert.ok(out.includes('<span class="rt-em">e</span>'))
  assert.ok(out.includes('<span class="rt-bf">x <span class="rt-it">y</span></span>'))
  assert.ok(out.includes('<code class="rt-tt">code</code>'))
  assert.ok(out.includes('<span class="rt-sc">Sc</span>') && out.includes('<u>u</u>'))
  // A declaration lasts to the end of its group, across paragraphs.
  const multi = html('{\\bfseries one\n\ntwo} three')
  assert.equal((multi.match(/<span class="rt-bf">/g) ?? []).length, 2)
  assert.ok(multi.includes('</span> three'))
  // Size commands vanish.
  assert.equal(text(html('{\\small s} \\Large L')), 's L')
})

test('typography: quotes, dashes, ties, escapes, accents, symbols, line breaks', () => {
  const t = text(html("``double'' `single' it's 1--2 a---b x~y \\% \\& \\$ \\# \\_ \\{ \\} \\textbackslash{} \\'e \\\"o \\^a \\`a \\~n \\c{c} \\v{s} \\ldots{} \\S{} \\copyright"))
  assert.equal(t, '\u201cdouble\u201d \u2018single\u2019 it\u2019s 1\u20132 a\u2014b x\u00a0y % & $ # _ { } \\ é ö â à ñ ç š \u2026 \u00a7 \u00a9')
  const br = html('a\\\\b\\newline c\\\\[2pt] d')
  assert.equal((br.match(/<br>/g) ?? []).length, 3)
  assert.match(text(html('\\LaTeX\\ and \\TeX')), /^LaTeX and TeX$/)
  const date = text(html('\\today'))
  assert.match(date, /^[A-Z][a-z]+ \d{1,2}, \d{4}$/)
})

test('comments are removed, escaped percent is kept, \\iffalse and comment env are skipped', () => {
  const t = text(html('a % hidden\nb 50\\% c\n\\iffalse gone \\fi d \\begin{comment}\nalso gone\n\\end{comment}\ne'))
  assert.equal(t, 'a b 50% c d e')
})

test('footnotes are numbered and listed at the end', () => {
  const out = html('One\\footnote{First \\emph{note}.} two\\footnote{Second.}')
  assert.ok(out.includes('<sup class="rt-fnref" data-fn="1">1</sup>'))
  assert.ok(out.includes('<sup class="rt-fnref" data-fn="2">2</sup>'))
  const notes = out.slice(out.indexOf('rt-footnotes'))
  assert.ok(notes.includes('First <em>note</em>.') && notes.indexOf('First') < notes.indexOf('Second'))
})

test('citations: numbered through thebibliography, keys otherwise, optional notes', () => {
  const withBib = text(html(doc('\\cite{b} \\citep[see][p.~3]{a,b} \\cite{zz}\n\\begin{thebibliography}{9}\\bibitem{a} A.\\bibitem[Kn84]{b} B.\\end{thebibliography}')))
  assert.ok(withBib.includes('[Kn84] [see 1, Kn84, p.\u00a03] [zz]'), withBib)
  assert.ok(withBib.includes('[1]') && withBib.includes('References'))
  const noBib = text(html('\\parencite{x} \\textcite{y} \\citeauthor{z}'))
  assert.equal(noBib, '[x] [y] z')
})

test('lists: itemize, nested enumerate styles, description, custom labels', () => {
  const out = html(String.raw`\begin{enumerate}
\item a
\begin{enumerate} \item b \begin{enumerate} \item c \begin{enumerate} \item d \end{enumerate} \end{enumerate} \end{enumerate}
\item[(x)] custom
\item e
\end{enumerate}
\begin{itemize} \item p \begin{itemize} \item q \end{itemize} \end{itemize}
\begin{description} \item[Term] Def \end{description}
\begin{enumerate}[label=(\roman*)] \item r \item s \end{enumerate}`)
  const labels = (out.match(/<span class="rt-item-label">([^<]*)<\/span>/g) ?? []).map((l) => text(l))
  assert.deepEqual(labels, ['1.', '(a)', 'i.', 'A.', '(x)', '2.', '\u2022', '\u2013', '(i)', '(ii)'])
  assert.ok(out.includes('<dt class="rt-desc-term"') && out.includes('>Term</dt>'))
})

test('tabular: alignment, rules, multicolumn, cline, vertical lines', () => {
  const out = html(String.raw`\begin{tabular}{|l|c|r|}
\hline
a & b & c \\ \hline\hline
\multicolumn{2}{|c|}{wide} & z \\
\cline{2-3}
1 & 2 & 3 \\
\hline
\end{tabular}`)
  assert.equal((out.match(/<tr/g) ?? []).length, 3)
  assert.ok(out.includes('<td class="rt-al-l rt-vl rt-vr">a</td>'), out)
  assert.ok(out.includes('<td class="rt-al-r rt-vr">c</td>'))
  assert.ok(out.includes('colspan="2"') && out.includes('>wide</td>'))
  assert.match(out, /<tr class="rt-rt-hl"[^>]*><td[^>]*>a</)
  assert.match(out, /<tr class="rt-rt-hl2"/)
  assert.match(out, /<tr class="rt-rb-hl"[^>]*><td[^>]*>1</)
  assert.match(out, /<td class="rt-al-c rt-vr rt-cl">2<\/td>/)
  const booktabs = html('\\begin{tabular}{lr}\\toprule H & K \\\\ \\midrule x & y \\\\ \\bottomrule\\end{tabular}')
  assert.match(booktabs, /<tr class="rt-rt-thick"[^>]*><td class="rt-al-l">H/)
  assert.match(booktabs, /<tr class="rt-rt-thin rt-rb-thick"/)
  const px = html('\\begin{tabular}{>{\\centering\\arraybackslash}p{2cm}*{2}{c}} a & b & c \\end{tabular}')
  assert.ok(px.includes('<td class="rt-al-c rt-wrap" style="width:2cm">a</td>'), px)
  assert.ok(px.includes('<td class="rt-al-c">b</td>'), px)
})

test('tabular: only paragraph columns wrap', () => {
  const out = html(String.raw`\begin{tabularx}{\linewidth}{lX} 잡음 바닥 (b) & long text \\ \multicolumn{2}{p{3cm}}{note} \end{tabularx}`)
  assert.ok(out.includes('<td class="rt-al-l">잡음 바닥 (b)</td>'), out)
  assert.ok(out.includes('<td class="rt-al-p rt-wrap">long text</td>'), out)
  assert.ok(out.includes('<td class="rt-al-p rt-wrap" colspan="2">note</td>'), out)
})

test('figures, tables and includegraphics placeholders', () => {
  const out = html(doc(String.raw`\begin{figure}[ht]
\centering
\includegraphics[width=0.5\linewidth]{plots/a.pdf}
\caption{First}\label{f1}
\end{figure}
\begin{table}\caption{T}\end{table}
\begin{figure}\caption{Second}\end{figure}`))
  assert.ok(out.includes('<span class="rt-caption-label">Figure 1:</span> First'))
  assert.ok(out.includes('<span class="rt-caption-label">Table 1:</span> T'))
  assert.ok(out.includes('<span class="rt-caption-label">Figure 2:</span> Second'))
  assert.ok(out.includes('style="width:50%"') && out.includes('data-file="plots/a.pdf"'))
  assert.ok(!/<img/.test(out))
})

test('theorems: defaults, \\newtheorem shared counters, notes, proofs with QED', () => {
  const out = html(doc(String.raw`\section{S}
\begin{theorem}[Big] A. \end{theorem}
\begin{lemma} B. \end{lemma}
\begin{prop}\label{p} C. \end{prop}
\begin{claim*} D. \end{claim*}
\begin{remark} E. \end{remark}
\begin{proof} Done. \end{proof}
\begin{proof}[Proof of \ref{p}] Q. \end{proof}`, '\\newtheorem{theorem}{Theorem}[section]\n\\newtheorem{prop}[theorem]{Proposition}'))
  const heads = (out.match(/<span class="rt-thm-head">[\s\S]*?\.<\/span>/g) ?? []).map((h) => text(h))
  assert.deepEqual(heads, ['Theorem 1.1 (Big).', 'Lemma 1.', 'Proposition 1.2.', 'Claim.', 'Remark 1.'])
  assert.ok(out.includes('rt-thm-remark'))
  assert.equal((out.match(/rt-qed/g) ?? []).length, 2)
  assert.ok(text(out).includes('Proof of 1.2.'))
})

test('verbatim and code blocks keep their content raw but escaped', () => {
  const out = html('\\begin{verbatim}\n  <tag> & \\textbf{x} % not a comment\n\\end{verbatim}\n\\begin{lstlisting}[language=Python]\nprint("<>")\n\\end{lstlisting}\n\\begin{minted}{js}\nlet a = 1\n\\end{minted}')
  assert.ok(out.includes('<code>  &lt;tag&gt; &amp; \\textbf{x} % not a comment</code>'), out)
  assert.ok(out.includes('data-lang="Python"') && out.includes('print(&quot;&lt;&gt;&quot;)'))
  assert.ok(out.includes('data-lang="js"'))
  assert.ok(html('\\verb+a{b}+ and \\verb|x|').includes('<code class="rt-verb">a{b}</code>'))
})

test('user macros: passed to math, expanded in text, \\be/\\ee aliases', () => {
  const seen: Array<Record<string, string>> = []
  const r = renderPreview(
    doc('Use \\name{} and \\hi{Bob}. $\\R$\n\\be a \\label{x} \\ee \\eqref{x}', '\\newcommand{\\R}{\\mathbb{R}}\\newcommand{\\name}{\\textsc{Rich}}\\newcommand{\\hi}[1]{Hello #1}\\newcommand{\\be}{\\begin{equation}}\\newcommand{\\ee}{\\end{equation}}'),
    { renderMath: (tex, d, macros) => (seen.push(macros), `{${d ? 'D' : 'I'}:${tex}}`) }
  )
  assert.ok(r.html.includes('<span class="rt-sc">Rich</span>') && text(r.html).includes('Hello Bob.'))
  assert.equal(seen[0]['\\R'], '\\mathbb{R}')
  assert.ok(r.html.includes('{D:a \\tag{1}}'), r.html)
  assert.ok(text(r.html).includes('(1)'))
})

test('unknown commands drop their name and keep their argument text', () => {
  assert.equal(text(html('\\foo{bar} \\baz[opt]{qux} \\unknown')), 'bar qux')
  assert.equal(text(html('\\begin{mystery}inside\\end{mystery}')), 'inside')
})

test('table of contents lists the outline', () => {
  const out = html(doc('\\tableofcontents\n\\section{One}\\subsection{Two $x$}'))
  assert.ok(out.includes('<span class="rt-toc-num">1</span> <span class="rt-toc-text">One</span>'))
  assert.ok(out.includes('<span class="rt-toc-num">1.1</span>'))
  const r = renderPreview(doc('\\section{Two $x^2$ \\& more}'), stub)
  assert.equal(r.outline[0].title, 'Two x^2 & more')
})

test('word count covers prose only', () => {
  const r = renderPreview(doc('Hello world, this is \\textbf{five} words.\n% not counted at all\n$x + y = z$ \\[ a b c \\] \\begin{equation} d e \\end{equation} don\'t well-known'), stub)
  assert.equal(r.wordCount, 8)
  assert.equal(renderPreview('', stub).wordCount, 0)
})

test('malformed input always terminates and renders something sensible', () => {
  const nasty = [
    '', '\\', '{', '}', '{{{{{{', '}}}}}}', '$', '$$', '$x', '$$x', '\\[', '\\(x', '\\begin', '\\begin{', '\\begin{itemize}',
    '\\begin{itemize}\\item a', '\\end{itemize}', '\\end{}', '\\end{document}', '\\item', '\\section', '\\section{', '\\textbf{abc',
    '\\textbf{abc\n\nnext paragraph', '\\begin{tabular}{', '\\begin{tabular}{ll} a & b', '\\begin{align} a &= b', '\\begin{verbatim}x',
    '\\verb', '\\verb|x', '\\href{', '\\url{', '\\footnote{', '\\cite{', '\\ref{', '\\label{', '\\newcommand{\\x}{\\x}\\x',
    '\\def\\a{\\a\\a}\\a', '\\newcommand{\\loop}{\\loop \\loop}\\loop', '\\begin{figure}\\caption{', '\\multicolumn{2}{c}{',
    '\\iffalse', '%', '\\begin{proof', '\\begin{enumerate}[label=', '\\begin{thebibliography}{1}\\bibitem', '~~~~',
    '{'.repeat(5000) + 'x', '}'.repeat(5000), '\\textbf{'.repeat(2000), '\\begin{center}'.repeat(500), '$'.repeat(999),
    '\\end{itemize}'.repeat(200), 'a\\\\'.repeat(100), '\\begin{document}\\begin{document}x', '\\begin{itemize}\\begin{enumerate}\\end{itemize}after'
  ]
  for (const src of nasty) {
    const r = renderPreview(src, stub)
    assert.equal(typeof r.html, 'string')
    assert.ok(Number.isFinite(r.wordCount))
  }
  assert.ok(text(html('\\textbf{abc\n\nnext paragraph')).includes('next paragraph'))
  assert.ok(text(html('\\begin{itemize}\\begin{enumerate}\\end{itemize}after')).includes('after'))
  assert.ok(text(html('$x\n\nafter')).includes('after'))
  assert.ok(text(html('stray } and \\end{foo} here')).includes('stray and here'))
  const throwing = renderPreview('$x$', { renderMath: () => { throw new Error('<boom>') } })
  assert.ok(throwing.html.includes('rt-math-error') && throwing.html.includes('&lt;boom&gt;') && throwing.html.includes('<code class="rt-math-error-src">$x$</code>'))
})

function bigDocument(lines: number): string {
  const para = [
    'Lorem ipsum dolor sit amet, \\emph{consectetur} adipiscing elit, sed do eiusmod tempor $a_i + b^2$ incididunt.',
    'Ut enim ad minim veniam, quis \\textbf{nostrud} exercitation~\\cite{knuth} ullamco laboris nisi ut aliquip.',
    'Duis aute irure dolor in reprehenderit in voluptate velit\\footnote{A footnote.} esse cillum dolore, see~\\ref{sec:1}.',
    ''
  ]
  const blocks = [
    '\\begin{align}\n  f(x) &= \\int_0^1 g(t)\\,dt \\label{eq:LINE} \\\\\n  h &= \\sum_{k=1}^n k^2 \\nonumber\n\\end{align}',
    '\\begin{itemize}\n  \\item First item with $x$\n  \\item Second item\n\\end{itemize}',
    '\\begin{table}[h]\n\\centering\n\\begin{tabular}{lcr}\n\\toprule\nA & B & C \\\\\n\\midrule\n1 & 2 & 3 \\\\\n\\bottomrule\n\\end{tabular}\n\\caption{Numbers}\\label{tab:LINE}\n\\end{table}',
    '\\begin{theorem}\\label{thm:LINE}\nFor all $n$, \\eqref{eq:LINE} holds.\n\\end{theorem}\n\\begin{proof}\nObvious.\n\\end{proof}'
  ]
  const out: string[] = ['\\documentclass{article}', '\\usepackage{amsmath}', '\\newcommand{\\R}{\\mathbb{R}}', '\\begin{document}', '\\tableofcontents']
  let n = 0
  while (out.length < lines - 1) {
    n++
    out.push(`\\section{Section ${n}}\\label{sec:${n}}`)
    for (let k = 0; k < 3; k++) out.push(...para)
    out.push(...blocks[n % blocks.length].replace(/LINE/g, String(n)).split('\n'))
    out.push('')
  }
  out.push('\\end{document}')
  return out.join('\n')
}

test('a 3,000-line document renders well under 150 ms', () => {
  const src = bigDocument(3000)
  assert.ok(src.split('\n').length >= 3000)
  renderPreview(src, stub) // warm up
  const times: number[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    const r = renderPreview(src, stub)
    times.push(performance.now() - t0)
    assert.ok(r.outline.length > 100 && r.wordCount > 10000)
  }
  times.sort((a, b) => a - b)
  assert.ok(times[1] < 150, `median ${times[1].toFixed(1)} ms`)
})

test('KaTeX end-to-end: every display environment renders without an error', () => {
  const bodies = [...DISPLAY_MATH_ENVS].map((env) => {
    const rows =
      env.startsWith('alignat') || env.includes('xalignat')
        ? '{2} a &= b & c &= d \\label{L-ENV} \\\\ e &= f & g &= h'
        : env.startsWith('eqnarray')
          ? 'a &=& b \\label{L-ENV} \\\\ c &<& d \\nonumber'
          : env.startsWith('equation') || env.startsWith('dmath') || env === 'displaymath' || env === 'math'
            ? 'a = \\R \\label{L-ENV}'
            : 'a &= b \\label{L-ENV} \\\\ c &= d \\notag \\\\ \\intertext{so} e &= f \\tag{T}'
    return `\\begin{${env}}\n${rows.replace('ENV', env)}\n\\end{${env}}`
  })
  const src = doc(`Inline $x^2$, \\(y\\), $$z$$ and \\[w \\label{wl}\\].\n${bodies.join('\n')}\nRefs: \\eqref{L-align}.`, '\\newcommand{\\R}{\\mathbb{R}}')
  const r = renderPreview(src, realKatex)
  assert.ok(!r.html.includes('rt-math-error'), r.html.slice(r.html.indexOf('rt-math-error') - 200, r.html.indexOf('rt-math-error') + 400))
  assert.ok(r.html.includes('class="katex-display"'))
  const shown = r.html.replace(/<annotation[\s\S]*?<\/annotation>/g, '').replace(/<[^>]+>/g, '')
  assert.ok(shown.includes('(1)') && shown.includes('(T)'))
  const bad = renderPreview('$\\frac{1$ and <b>', realKatex).html
  assert.ok(bad.includes('rt-math-error') && bad.includes('\\frac{1') && !bad.includes('<b>'))
})

test('a table whose last row has no trailing \\\\ renders that row once', () => {
  const out = html('\\begin{tabular}{ll} a & b \\\\ c & d \\end{tabular} after')
  assert.equal((out.match(/>c<\/td>/g) ?? []).length, 1)
  assert.equal(text(out).match(/c/g)?.length, 1)
  assert.ok(text(out).endsWith('after'))
})

test('an inline formula with an unclosed brace stops at its own closing $', () => {
  const out = html('Bad $\\frac{1$ then good $x$ and text.\nMore text.')
  assert.ok(out.includes('{I:\\frac{1}') && out.includes('{I:x}'), out)
  assert.ok(text(out).includes('and text. More text.'))
  assert.ok(html('$a \\text{ if $b$ } c$').includes('{I:a \\text{ if $b$ } c}'))
})
