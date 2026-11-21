import { createHash } from 'node:crypto'
import { assert, test } from 'orca/testing'
import { sha256 } from './sha256'

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

test('matches node:crypto across block boundaries', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff)
    assert.equal(hex(sha256(bytes)), createHash('sha256').update(bytes).digest('hex'))
  }
})
