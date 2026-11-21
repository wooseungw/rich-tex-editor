import { assert, test } from 'orca/testing'
import katex from 'katex'
import { DISPLAY_MATH_ENVS, prepareMath } from './math'

const counter = (start = 0) => {
  let n = start
  return () => ++n
}

const render = (tex: string, displayMode: boolean) => katex.renderToString(tex, { displayMode, throwOnError: true, strict: 'ignore' })

test('equation takes one number, its label gets the tag', () => {
  const p = prepareMath({ env: 'equation', body: 'a = b \\label{eq:one}', display: true }, counter(4))
  assert.deepEqual(p.tags, ['5'])
  assert.deepEqual(p.labels, [{ key: 'eq:one', tag: '5' }])
  assert.ok(p.displayMode)
  assert.ok(!p.tex.includes('\\label'))
  assert.match(p.tex, /\\tag\{5\}/)
  render(p.tex, true)
})

test('equation* and \\nonumber take no number; labels have a null tag', () => {
  const next = counter()
  const a = prepareMath({ env: 'equation*', body: 'x \\label{a}', display: true }, next)
  const b = prepareMath({ env: 'equation', body: 'y \\nonumber \\label{b}', display: true }, next)
  assert.deepEqual(a.tags, [])
  assert.deepEqual(b.tags, [])
  assert.deepEqual(a.labels, [{ key: 'a', tag: null }])
  assert.deepEqual(b.labels, [{ key: 'b', tag: null }])
  assert.equal(next(), 1)
})

test('align numbers each row, skipping \\nonumber, \\notag, explicit \\tag and the trailing empty row', () => {
  const body = String.raw`
  a &= b \label{r1} \\
  c &= d \nonumber \\
  e &= f \notag \\
  g &= h \tag{*} \label{star} \\
  i &= j \label{r5} \\
`
  const p = prepareMath({ env: 'align', body, display: true }, counter(10))
  assert.deepEqual(p.tags, ['11', '*', '12'])
  assert.deepEqual(p.labels, [
    { key: 'r1', tag: '11' },
    { key: 'star', tag: '*' },
    { key: 'r5', tag: '12' }
  ])
  assert.match(p.tex, /^\\begin\{align\*\}/)
  assert.ok(!/\\nonumber|\\notag|\\label/.test(p.tex))
  const text = render(p.tex, true).replace(/<annotation[\s\S]*?<\/annotation>/g, '').replace(/<[^>]+>/g, '')
  assert.ok(text.includes('(11)') && text.includes('(12)') && text.includes('(*)'), text)
})

test('rows split only at top level (not inside braces or nested environments)', () => {
  const body = String.raw`f(x) &= \begin{cases} 1 & x > 0 \\ 0 & \text{else} \end{cases} \\ g &= {a \\ b}`
  const p = prepareMath({ env: 'align', body, display: true }, counter())
  assert.deepEqual(p.tags, ['1', '2'])
  render(p.tex, true)
})

test('gather, multline (one number on the last row), flalign, alignat', () => {
  const next = counter()
  const g = prepareMath({ env: 'gather', body: 'a \\\\ b', display: true }, next)
  assert.deepEqual(g.tags, ['1', '2'])
  const m = prepareMath({ env: 'multline', body: 'a + b \\\\ + c \\\\ + d \\label{m}', display: true }, next)
  assert.deepEqual(m.tags, ['3'])
  assert.deepEqual(m.labels, [{ key: 'm', tag: '3' }])
  assert.match(m.tex, /\+ d \\tag\{3\}\\end\{gather\*\}$/)
  const f = prepareMath({ env: 'flalign', body: 'a &= b', display: true }, next)
  assert.deepEqual(f.tags, ['4'])
  const at = prepareMath({ env: 'alignat', body: '{2} a &= b & c &= d', display: true }, next)
  assert.match(at.tex, /^\\begin\{alignat\*\}\{2\}/)
  assert.deepEqual(at.tags, ['5'])
  const inferred = prepareMath({ env: 'alignat*', body: 'a &= b & c &= d', display: true }, next)
  assert.match(inferred.tex, /^\\begin\{alignat\*\}\{2\}/)
  for (const p of [g, m, f, at, inferred]) render(p.tex, true)
})

test('eqnarray becomes align with the relation leading the right column', () => {
  const p = prepareMath({ env: 'eqnarray', body: 'a & = & b + c \\label{e} \\\\ & & + d', display: true }, counter())
  assert.deepEqual(p.tags, ['1', '2'])
  assert.match(p.tex, /^\\begin\{align\*\}a &= b \+ c/)
  render(p.tex, true)
})

test('inline math drops \\label and \\tag', () => {
  const p = prepareMath({ env: null, body: 'x \\label{k} \\tag{3}', display: false }, counter())
  assert.equal(p.displayMode, false)
  assert.deepEqual(p.labels, [{ key: 'k', tag: null }])
  assert.ok(!/\\label|\\tag/.test(p.tex))
  render(p.tex, false)
})

test('comments are stripped before anything else', () => {
  const p = prepareMath({ env: 'align', body: 'a &= b % \\label{ghost} \\\\ c\n\\\\ c &= 50\\%', display: true }, counter())
  assert.deepEqual(p.labels, [])
  assert.deepEqual(p.tags, ['1', '2'])
  assert.ok(p.tex.includes('50\\%'))
})

test('$$\\begin{align}..\\end{align}$$ is numbered like the bare environment', () => {
  const p = prepareMath({ env: null, body: '\\begin{align} a &= b \\\\ c &= d \\end{align}', display: true }, counter())
  assert.deepEqual(p.tags, ['1', '2'])
})

test('displaymath and math', () => {
  const d = prepareMath({ env: 'displaymath', body: 'x', display: true }, counter())
  assert.ok(d.displayMode)
  assert.deepEqual(d.tags, [])
  const i = prepareMath({ env: 'math', body: 'x', display: true }, counter())
  assert.equal(i.displayMode, false)
})

test('DISPLAY_MATH_ENVS covers the amsmath family', () => {
  for (const env of ['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'flalign', 'flalign*', 'alignat', 'alignat*', 'displaymath', 'math']) {
    assert.ok(DISPLAY_MATH_ENVS.has(env), env)
  }
})

test('every environment renders in KaTeX', () => {
  for (const env of DISPLAY_MATH_ENVS) {
    const body = env.startsWith('alignat') || env.startsWith('xalignat') || env === 'xxalignat' ? '{2} a &= b & c &= d \\\\ e &= f & g &= h' : env.startsWith('eqnarray') ? 'a &=& b \\\\ c &<& d' : 'a &= b \\label{x} \\\\ c &= d'
    const single = env.startsWith('equation') || env.startsWith('dmath') || env === 'displaymath' || env === 'math'
    const p = prepareMath({ env, body: single ? 'a = b \\label{x}' : body, display: env !== 'math' }, counter())
    render(p.tex, p.displayMode)
  }
})

test('never throws on odd input', () => {
  const next = counter()
  for (const body of ['', '\\', '{', '}}}', '\\label{', '\\tag{', '\\\\\\\\', '\\begin{cases}', '%']) {
    for (const env of [null, 'align', 'equation', 'eqnarray', 'alignat', 'multline', 'unknownenv']) {
      const p = prepareMath({ env, body, display: true }, next)
      assert.equal(typeof p.tex, 'string')
    }
  }
  const odd = prepareMath(undefined as unknown as { env: null; body: string; display: boolean }, next)
  assert.equal(typeof odd.tex, 'string')
})
