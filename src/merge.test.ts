import { assert, test } from 'orca/testing'
import { CONFLICT_END, CONFLICT_MINE, CONFLICT_OUTSIDE, diffLines, mergeText } from './merge'

/** Applies hunks from diffLines(a, b) to a, which must give back b. */
function apply(a: string[], b: string[]): string[] {
  const out: string[] = []
  let at = 0
  for (const h of diffLines(a, b)) {
    out.push(...a.slice(at, h.aStart), ...b.slice(h.bStart, h.bEnd))
    at = h.aEnd
  }
  out.push(...a.slice(at))
  return out
}

test('diffLines round-trips random edits', () => {
  let seed = 7
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: rand(30) }, () => String.fromCharCode(97 + rand(5)))
    const b = a.slice()
    for (let e = rand(6); e > 0; e--) {
      const at = rand(b.length + 1)
      if (rand(2) === 0) b.splice(at, 1)
      else b.splice(at, 0, String.fromCharCode(97 + rand(5)))
    }
    assert.deepEqual(apply(a, b), b)
  }
})

test('diffLines finds a minimal hunk for a one-line change', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'x', 'c']), [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }])
  assert.deepEqual(diffLines([], []), [])
  assert.deepEqual(diffLines(['a'], ['a']), [])
})

test('takes the only side that changed', () => {
  assert.equal(mergeText('a', 'a', 'b'), 'b')
  assert.equal(mergeText('a', 'b', 'a'), 'b')
  assert.equal(mergeText('a', 'b', 'b'), 'b')
})

test('merges edits on different lines', () => {
  const base = ['\\section{Intro}', 'First.', '', 'Second.', '', 'Third.'].join('\n')
  const outside = ['\\section{Introduction}', 'First.', '', 'Second.', '', 'Third.'].join('\n')
  const mine = ['\\section{Intro}', 'First.', '', 'Second.', '', 'Third, edited.'].join('\n')
  assert.equal(
    mergeText(base, outside, mine),
    ['\\section{Introduction}', 'First.', '', 'Second.', '', 'Third, edited.'].join('\n')
  )
})

test('merges edits on adjacent lines', () => {
  assert.equal(mergeText('a\nb\nc', 'A\nb\nc', 'a\nB\nc'), 'A\nB\nc')
})

test('keeps insertions from both sides at different points', () => {
  assert.equal(mergeText('a\nb\nc', 'a\nx\nb\nc', 'a\nb\nc\ny'), 'a\nx\nb\nc\ny')
})

test('keeps both versions of a conflicting line between TeX comments', () => {
  const merged = mergeText('a\nb\nc', 'a\nOUT\nc', 'a\nMINE\nc')
  assert.equal(merged, ['a', CONFLICT_OUTSIDE, 'OUT', CONFLICT_MINE, 'MINE', CONFLICT_END, 'c'].join('\n'))
  for (const marker of [CONFLICT_OUTSIDE, CONFLICT_MINE, CONFLICT_END]) assert.ok(marker.startsWith('%'))
})

test('identical changes on both sides do not conflict', () => {
  assert.equal(mergeText('a\nb\nc', 'a\nz\nc\nq', 'a\nz\nc'), 'a\nz\nc\nq')
})

test('preserves a trailing newline', () => {
  assert.equal(mergeText('a\nb\n', 'a\nB\n', 'a\nb\nc\n'), 'a\nB\nc\n')
})

test('large documents merge quickly', () => {
  const base = Array.from({ length: 20000 }, (_, i) => `line ${i}`)
  const outside = base.slice()
  outside[100] = 'outside edit'
  const mine = base.slice()
  mine[19000] = 'my edit'
  const started = performance.now()
  const merged = mergeText(base.join('\n'), outside.join('\n'), mine.join('\n')).split('\n')
  assert.ok(performance.now() - started < 200)
  assert.equal(merged[100], 'outside edit')
  assert.equal(merged[19000], 'my edit')
})
