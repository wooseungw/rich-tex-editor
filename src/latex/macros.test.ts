import { assert, test } from 'orca/testing'
import { extractMacros } from './macros'

test('newcommand: braced and bare names, arity, nested braces', () => {
  const m = extractMacros(
    String.raw`\newcommand{\R}{\mathbb{R}}
\newcommand\N{\mathbb{N}}
\newcommand{\norm}[1]{\left\|#1\right\|}
\newcommand*{\pair}[2]{\langle #1, #2 \rangle}
\newcommand{\set}[1]{\{\, #1 \,\}}`
  )
  assert.equal(m['\\R'], '\\mathbb{R}')
  assert.equal(m['\\N'], '\\mathbb{N}')
  assert.equal(m['\\norm'], '\\left\\|#1\\right\\|')
  assert.equal(m['\\pair'], '\\langle #1, #2 \\rangle')
  assert.equal(m['\\set'], '\\{\\, #1 \\,\\}')
})

test('optional-argument default is dropped, arity kept in the body', () => {
  const m = extractMacros(String.raw`\newcommand{\op}[2][x]{#1 \mapsto #2}`)
  assert.equal(m['\\op'], '#1 \\mapsto #2')
})

test('renewcommand overrides, providecommand only fills gaps', () => {
  const m = extractMacros(String.raw`\newcommand{\a}{1}\renewcommand{\a}{2}\providecommand{\a}{3}\providecommand{\b}{4}\renewcommand*\c{5}`)
  assert.equal(m['\\a'], '2')
  assert.equal(m['\\b'], '4')
  assert.equal(m['\\c'], '5')
})

test('def with and without parameters, let', () => {
  const m = extractMacros(String.raw`\def\half{\frac12}\def\ratio#1#2{#1/#2}\gdef\g{G}\let\eps\varepsilon`)
  assert.equal(m['\\half'], '\\frac12')
  assert.equal(m['\\ratio'], '#1/#2')
  assert.equal(m['\\g'], 'G')
  assert.equal(m['\\eps'], '\\varepsilon')
})

test('DeclareMathOperator and its starred form', () => {
  const m = extractMacros(String.raw`\DeclareMathOperator{\tr}{tr}\DeclareMathOperator*{\argmax}{arg\,max}`)
  assert.equal(m['\\tr'], '\\operatorname{tr}')
  assert.equal(m['\\argmax'], '\\operatorname*{arg\\,max}')
})

test('xparse NewDocumentCommand', () => {
  const m = extractMacros(String.raw`\NewDocumentCommand{\abs}{m}{\lvert #1 \rvert}`)
  assert.equal(m['\\abs'], '\\lvert #1 \\rvert')
})

test('comments are skipped, escaped percent is not a comment', () => {
  const m = extractMacros(
    String.raw`% \newcommand{\hidden}{no}
\newcommand{\pct}{50\%} % \newcommand{\alsohidden}{no}
\newcommand{\multi}{a % trailing comment
  b}`
  )
  assert.equal(m['\\hidden'], undefined)
  assert.equal(m['\\alsohidden'], undefined)
  assert.equal(m['\\pct'], '50\\%')
  assert.equal(m['\\multi'], 'a b')
})

test('malformed definitions never throw and do not hide later ones', () => {
  const inputs = [
    String.raw`\newcommand{\x}{unbalanced`,
    String.raw`\newcommand`,
    String.raw`\newcommand{}{}`,
    String.raw`\def`,
    String.raw`\def\x`,
    String.raw`\DeclareMathOperator{\op}`,
    '\\',
    '{{{{',
    '}}}}'
  ]
  for (const input of inputs) extractMacros(input)
  const m = extractMacros(String.raw`\newcommand{\bad}{oops \newcommand{\good}{ok}`)
  assert.equal(m['\\good'], 'ok')
  assert.deepEqual(extractMacros(undefined as unknown as string), {})
})
