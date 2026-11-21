import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  snippetCompletion
} from '@codemirror/autocomplete'
import { analysisField } from './analysis'

const cmd = (template: string, detail: string, info?: string, boost = 0): Completion =>
  snippetCompletion(template, {
    label: template.replace(/[{[#].*$/s, '').trim(),
    detail,
    info,
    type: 'keyword',
    boost
  })

const plain = (name: string, detail: string, boost = 0): Completion => ({
  label: `\\${name}`,
  detail,
  type: 'constant',
  boost
})

/** Commands offered after a backslash. Snippet fields are `#{...}`. */
const COMMANDS: Completion[] = [
  cmd('\\section{#{title}}', 'section', undefined, 5),
  cmd('\\subsection{#{title}}', 'subsection', undefined, 4),
  cmd('\\subsubsection{#{title}}', 'subsubsection', undefined, 3),
  cmd('\\chapter{#{title}}', 'chapter'),
  cmd('\\part{#{title}}', 'part'),
  cmd('\\paragraph{#{title}}', 'run-in heading'),
  cmd('\\section*{#{title}}', 'unnumbered section'),
  cmd('\\textbf{#{}}', 'bold', undefined, 4),
  cmd('\\textit{#{}}', 'italic', undefined, 4),
  cmd('\\emph{#{}}', 'emphasis', undefined, 4),
  cmd('\\underline{#{}}', 'underline'),
  cmd('\\texttt{#{}}', 'monospace'),
  cmd('\\textsc{#{}}', 'small caps'),
  cmd('\\textsf{#{}}', 'sans serif'),
  cmd('\\textcolor{#{red}}{#{}}', 'coloured text'),
  cmd('\\footnote{#{}}', 'footnote', undefined, 2),
  cmd('\\label{#{key}}', 'label', undefined, 3),
  cmd('\\ref{#{key}}', 'reference', undefined, 3),
  cmd('\\eqref{#{key}}', 'equation reference', undefined, 2),
  cmd('\\cref{#{key}}', 'clever reference'),
  cmd('\\autoref{#{key}}', 'named reference'),
  cmd('\\pageref{#{key}}', 'page reference'),
  cmd('\\cite{#{key}}', 'citation', undefined, 3),
  cmd('\\citep{#{key}}', 'parenthetical citation'),
  cmd('\\citet{#{key}}', 'textual citation'),
  cmd('\\href{#{url}}{#{text}}', 'link'),
  cmd('\\url{#{url}}', 'URL'),
  cmd('\\includegraphics[width=#{\\linewidth}]{#{file}}', 'image'),
  cmd('\\caption{#{}}', 'caption'),
  cmd('\\item #{}', 'list item', undefined, 4),
  cmd('\\usepackage{#{package}}', 'package'),
  cmd('\\usepackage[#{options}]{#{package}}', 'package with options'),
  cmd('\\documentclass{#{article}}', 'document class'),
  cmd('\\title{#{}}', 'title'),
  cmd('\\author{#{}}', 'author'),
  cmd('\\date{#{\\today}}', 'date'),
  cmd('\\newcommand{\\#{name}}{#{definition}}', 'macro'),
  cmd('\\newcommand{\\#{name}}[#{1}]{#{definition}}', 'macro with arguments'),
  cmd('\\DeclareMathOperator{\\#{name}}{#{text}}', 'math operator'),
  cmd('\\input{#{file}}', 'input file'),
  cmd('\\bibliography{#{refs}}', 'BibTeX file'),
  cmd('\\bibliographystyle{#{plain}}', 'BibTeX style'),
  cmd('\\vspace{#{1em}}', 'vertical space'),
  cmd('\\hspace{#{1em}}', 'horizontal space'),
  cmd('\\frac{#{a}}{#{b}}', 'fraction', undefined, 3),
  cmd('\\dfrac{#{a}}{#{b}}', 'display fraction'),
  cmd('\\sqrt{#{x}}', 'square root', undefined, 2),
  cmd('\\sqrt[#{n}]{#{x}}', 'n-th root'),
  cmd('\\sum_{#{i=1}}^{#{n}}', 'sum', undefined, 2),
  cmd('\\prod_{#{i=1}}^{#{n}}', 'product'),
  cmd('\\int_{#{a}}^{#{b}}', 'integral', undefined, 2),
  cmd('\\lim_{#{x \\to 0}}', 'limit'),
  cmd('\\binom{#{n}}{#{k}}', 'binomial'),
  cmd('\\mathbb{#{R}}', 'blackboard bold'),
  cmd('\\mathcal{#{A}}', 'calligraphic'),
  cmd('\\mathbf{#{x}}', 'bold math'),
  cmd('\\mathrm{#{d}}', 'upright math'),
  cmd('\\operatorname{#{name}}', 'operator'),
  cmd('\\text{#{}}', 'text in math'),
  cmd('\\left( #{} \\right)', 'scaled parentheses'),
  cmd('\\hat{#{x}}', 'hat'),
  cmd('\\bar{#{x}}', 'bar'),
  cmd('\\vec{#{x}}', 'vector'),
  cmd('\\overline{#{x}}', 'overline'),
  cmd('\\tilde{#{x}}', 'tilde'),
  ...[
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta',
    'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi',
    'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma',
    'Upsilon', 'Phi', 'Psi', 'Omega'
  ].map((g) => plain(g, 'Greek letter')),
  ...(
    [
      ['infty', '∞'], ['partial', '∂'], ['nabla', '∇'], ['cdot', '·'], ['cdots', '⋯'], ['ldots', '…'],
      ['times', '×'], ['div', '÷'], ['pm', '±'], ['mp', '∓'], ['leq', '≤'], ['geq', '≥'], ['neq', '≠'],
      ['approx', '≈'], ['equiv', '≡'], ['sim', '∼'], ['propto', '∝'], ['in', '∈'], ['notin', '∉'],
      ['subset', '⊂'], ['subseteq', '⊆'], ['cup', '∪'], ['cap', '∩'], ['emptyset', '∅'],
      ['forall', '∀'], ['exists', '∃'], ['neg', '¬'], ['land', '∧'], ['lor', '∨'], ['to', '→'],
      ['rightarrow', '→'], ['Rightarrow', '⇒'], ['leftarrow', '←'], ['Leftarrow', '⇐'],
      ['leftrightarrow', '↔'], ['iff', '⟺'], ['implies', '⟹'], ['mapsto', '↦'], ['circ', '∘'],
      ['quad', 'space'], ['qquad', 'wide space'], ['noindent', 'no indent'], ['centering', 'center'],
      ['maketitle', 'title block'], ['tableofcontents', 'contents'], ['newpage', 'page break'],
      ['clearpage', 'flush floats'], ['appendix', 'start appendix'], ['today', 'date'], ['LaTeX', 'logo'],
      ['hline', 'table rule'], ['toprule', 'booktabs'], ['midrule', 'booktabs'], ['bottomrule', 'booktabs'],
      ['nonumber', 'no equation number'], ['notag', 'no equation number']
    ] as const
  ).map(([name, detail]) => plain(name, detail))
]

/** Environments offered after `\begin{`; `body` goes between begin and end. */
const ENVIRONMENTS: Array<{ name: string; detail: string; body?: string; args?: string }> = [
  { name: 'equation', detail: 'numbered equation' },
  { name: 'equation*', detail: 'unnumbered equation' },
  { name: 'align', detail: 'aligned equations', body: '#{a} &= #{b} \\\\\n  #{c} &= #{d}' },
  { name: 'align*', detail: 'aligned, unnumbered', body: '#{a} &= #{b} \\\\\n  #{c} &= #{d}' },
  { name: 'gather', detail: 'centred equations' },
  { name: 'multline', detail: 'long equation' },
  { name: 'cases', detail: 'piecewise (in math)', body: '#{a} & \\text{if } #{x} \\\\\n  #{b} & \\text{otherwise}' },
  { name: 'pmatrix', detail: 'matrix (in math)', body: '#{a} & #{b} \\\\\n  #{c} & #{d}' },
  { name: 'bmatrix', detail: 'matrix (in math)', body: '#{a} & #{b} \\\\\n  #{c} & #{d}' },
  { name: 'itemize', detail: 'bulleted list', body: '\\item #{}' },
  { name: 'enumerate', detail: 'numbered list', body: '\\item #{}' },
  { name: 'description', detail: 'description list', body: '\\item[#{term}] #{}' },
  {
    name: 'figure',
    detail: 'figure',
    args: '[#{htbp}]',
    body: '\\centering\n  \\includegraphics[width=0.8\\linewidth]{#{file}}\n  \\caption{#{caption}}\n  \\label{fig:#{key}}'
  },
  {
    name: 'table',
    detail: 'table',
    args: '[#{htbp}]',
    body: '\\centering\n  \\caption{#{caption}}\n  \\label{tab:#{key}}\n  \\begin{tabular}{#{lcr}}\n    \\hline\n    #{a} & #{b} & #{c} \\\\\n    \\hline\n  \\end{tabular}'
  },
  { name: 'tabular', detail: 'table body', args: '{#{lcr}}', body: '#{a} & #{b} & #{c} \\\\' },
  { name: 'abstract', detail: 'abstract' },
  { name: 'quote', detail: 'quotation' },
  { name: 'center', detail: 'centred block' },
  { name: 'verbatim', detail: 'verbatim text' },
  { name: 'lstlisting', detail: 'code listing' },
  { name: 'minted', detail: 'highlighted code', args: '{#{python}}' },
  { name: 'theorem', detail: 'theorem' },
  { name: 'lemma', detail: 'lemma' },
  { name: 'proposition', detail: 'proposition' },
  { name: 'corollary', detail: 'corollary' },
  { name: 'definition', detail: 'definition' },
  { name: 'remark', detail: 'remark' },
  { name: 'example', detail: 'example' },
  { name: 'proof', detail: 'proof' },
  { name: 'thebibliography', detail: 'bibliography', args: '{#{9}}', body: '\\bibitem{#{key}} #{reference}' },
  { name: 'document', detail: 'document body' }
]

const CITE_COMMANDS = 'cite|citep|citet|citealp|citeauthor|citeyear|parencite|textcite|autocite|footcite|nocite'
const REF_COMMANDS = 'ref|eqref|autoref|Autoref|cref|Cref|pageref|nameref'

function environmentCompletions(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\\(begin|end)\{[a-zA-Z*]*$/)
  if (!match) return null
  const begin = match.text.startsWith('\\begin')
  const from = match.from + match.text.indexOf('{') + 1
  // Swallow a `}` that closeBrackets already put after the cursor.
  const to = context.state.sliceDoc(context.pos, context.pos + 1) === '}' ? context.pos + 1 : context.pos
  const options = ENVIRONMENTS.map((env) =>
    begin
      ? snippetCompletion(`${env.name}}${env.args ?? ''}\n  ${env.body ?? '#{}'}\n\\end{${env.name}}`, {
          label: env.name,
          detail: env.detail,
          type: 'type'
        })
      : { label: env.name, detail: env.detail, type: 'type', apply: `${env.name}}` }
  )
  return { from, to, options, validFor: /^[a-zA-Z*]*$/ }
}

function keyCompletions(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(new RegExp(`\\\\(${CITE_COMMANDS}|${REF_COMMANDS})\\*?(\\[[^\\]]*\\])*\\{[^}]*$`))
  if (!match) return null
  const cite = new RegExp(`^\\\\(${CITE_COMMANDS})`).test(match.text)
  const afterBrace = match.text.lastIndexOf('{') + 1
  const afterComma = match.text.lastIndexOf(',') + 1
  const start = match.from + Math.max(afterBrace, afterComma)
  const from = start + (/^\s*/.exec(context.state.sliceDoc(start, context.pos))?.[0].length ?? 0)
  const a = context.state.field(analysisField)
  const options: Completion[] = cite
    ? [...a.citations.keys()].map((key) => ({ label: key, detail: `[${a.citations.get(key)}]`, type: 'variable' }))
    : [...a.labels].map(([key, target]) => ({ label: key, detail: `${target.kind} ${target.number}`, type: 'variable' }))
  return { from, options, validFor: /^[^,}\s]*$/ }
}

function commandCompletions(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\\[a-zA-Z]*$/)
  if (!match || (match.from === match.to && !context.explicit)) return null
  // `\\` is a line break, not the start of a command.
  if (context.state.sliceDoc(match.from - 1, match.from) === '\\') return null
  const a = context.state.field(analysisField)
  const macros: Completion[] = Object.keys(a.macros).map((name) => ({
    label: name,
    detail: 'your macro',
    type: 'function',
    boost: 1
  }))
  return { from: match.from, options: [...macros, ...COMMANDS], validFor: /^\\[a-zA-Z]*$/ }
}

export const latexCompletionSources = [environmentCompletions, keyCompletions, commandCompletions]
