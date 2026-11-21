import { assert, test } from 'orca/testing'
import { crlfOf, outsideChanges } from './outside'

const apply = (text: string, changes: { from: number; to: number; insert: string }[]) => {
  let out = text
  for (const c of [...changes].sort((x, y) => y.from - x.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to)
  return out
}

test('changes only the lines that differ', () => {
  const a = 'one\ntwo\nthree\nfour\nfive\n'
  const b = 'ONE\ntwo\nthree\nfour\nFIVE\n'
  const changes = outsideChanges(a, b)
  assert.equal(changes.length, 2)
  assert.deepEqual(changes[0], { from: 0, to: 4, insert: 'ONE\n' })
  assert.equal(apply(a, changes), b)
})

test('round-trips insertions, deletions and a missing final newline', () => {
  const cases: Array<[string, string]> = [
    ['a\nb', 'a\nb\nc'],
    ['a\nb\nc', 'a\nc'],
    ['', 'x\ny'],
    ['x\ny\n', ''],
    ['a\n\nb\n', 'a\nb\n\n'],
    ['same', 'same']
  ]
  for (const [a, b] of cases) assert.equal(apply(a, outsideChanges(a, b)), b)
})

test('detects files that use CRLF throughout', () => {
  assert.equal(crlfOf('a\r\nb\r\n'), '\r\n')
  assert.equal(crlfOf('a\nb\n'), null)
  assert.equal(crlfOf('a\r\nb\nc'), null)
  assert.equal(crlfOf('\nfirst'), null)
})
