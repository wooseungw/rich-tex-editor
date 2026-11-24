import { assert, test } from 'orca/testing'
import { ImageStore } from './images'

/** A file on the fake disk; `stamp` changes whenever it is rewritten. */
interface FakeFile {
  bytes: Uint8Array
  mtimeMs: number
}

/**
 * The worker as the editor sees it, over an in-memory folder. `chunk` makes reads come in pieces,
 * `beforeChunk` runs before each piece after the first (to rewrite a file mid-read), and
 * `failStat` makes `image.stat` reject for a ref.
 */
function fakeWorker() {
  const files = new Map<string, FakeFile>()
  const calls: string[] = []
  const worker = {
    files,
    calls,
    chunk: 1 << 20,
    beforeChunk: null as (() => void) | null,
    failStat: new Set<string>(),
    write(path: string, size: number) {
      files.set(path, { bytes: new Uint8Array(size).fill(size & 0xff), mtimeMs: (files.get(path)?.mtimeMs ?? 0) + 1 })
    }
  }
  const found = (ref: string) => {
    const file = files.get(ref)
    return file ? { path: ref, size: file.bytes.length, mtimeMs: file.mtimeMs, file } : null
  }
  const handlers: Record<string, (input: any) => unknown> = {
    'tex.locate': () => ({ location: { root: '/w', dir: '', file: 'main.tex' }, workspace: '/w' }),
    'image.stat': ({ ref }) => {
      if (worker.failStat.has(ref)) throw Object.assign(new Error('timed out'), { code: 'timeout' })
      const f = found(ref)
      return f ? { found: true, path: f.path, size: f.size, mtimeMs: f.mtimeMs } : { found: false }
    },
    'image.read': ({ ref, offset }) => {
      if (offset > 0) worker.beforeChunk?.()
      const f = found(ref)
      if (!f) return { found: false }
      if (offset > f.size) throw Object.assign(new Error('offset is past the end'), { code: 'invalid_params' })
      const end = Math.min(f.size, offset + worker.chunk)
      return {
        found: true,
        path: f.path,
        mime: 'image/png',
        size: f.size,
        mtimeMs: f.mtimeMs,
        data: Buffer.from(f.file.bytes.subarray(offset, end)).toString('base64'),
        next: end < f.size ? end : null
      }
    },
    'image.begin': ({ name }) => ({ uploadId: 'u1', path: `figures/${name}` }),
    'image.chunk': () => ({ received: 0 }),
    'image.commit': () => ({ path: 'figures/plot.png' })
  }
  ;(globalThis as { orca?: unknown }).orca = {
    plugin: {
      request: async (name: string, input: unknown) => {
        calls.push(name)
        return handlers[name](input)
      }
    }
  }
  return worker
}

async function located(worker: ReturnType<typeof fakeWorker>) {
  const store = new ImageStore(() => '\\documentclass{article}')
  await store.locate()
  worker.calls.length = 0
  return store
}

test('an image redrawn on disk loads again; one left alone is only checked', async () => {
  const worker = fakeWorker()
  worker.write('a.png', 10)
  const store = await located(worker)
  const first = await store.load('a.png')
  assert.ok(first?.url)

  worker.calls.length = 0
  await store.revalidate()
  await store.revalidate()
  assert.equal(store.generation, 0)
  assert.ok(!worker.calls.includes('image.read'))

  worker.write('a.png', 20)
  await store.revalidate()
  assert.equal(store.generation, 1)
  assert.equal(store.cached('a.png'), undefined)
  const second = await store.load('a.png')
  assert.ok(second?.url && second.url !== first.url)
})

test('an image the document names before it exists shows once it is written', async () => {
  const worker = fakeWorker()
  const store = await located(worker)
  assert.equal(await store.load('later.png'), null)
  await store.revalidate()
  assert.equal(store.generation, 0)
  worker.write('later.png', 5)
  await store.revalidate()
  assert.equal(store.generation, 1)
  assert.ok((await store.load('later.png'))?.url)
})

test('one failed check still redraws the images found to have changed', async () => {
  const worker = fakeWorker()
  worker.write('a.png', 10)
  worker.write('b.png', 10)
  const store = await located(worker)
  await store.load('a.png')
  await store.load('b.png')
  worker.write('a.png', 11)
  worker.failStat.add('b.png')
  await store.revalidate()
  assert.equal(store.generation, 1)
  assert.equal(store.cached('a.png'), undefined)
})

test('a file rewritten between chunks is read again once it changes, and only then', async () => {
  const worker = fakeWorker()
  worker.chunk = 4
  worker.write('a.png', 10)
  const store = await located(worker)
  // A script rewrites the file while it is being read.
  worker.beforeChunk = () => {
    worker.beforeChunk = null
    worker.write('a.png', 12)
  }
  assert.equal(await store.load('a.png'), null)
  // The next check finds the file changed since the read began, and it loads whole.
  await store.revalidate()
  assert.equal(store.generation, 1)
  assert.ok((await store.load('a.png'))?.url)
  await store.revalidate()
  assert.equal(store.generation, 1)
})

test('a read that fails on a file left alone is not retried on every check', async () => {
  const worker = fakeWorker()
  worker.chunk = 4
  worker.write('a.png', 10)
  const store = await located(worker)
  worker.beforeChunk = () => {
    throw Object.assign(new Error('timed out'), { code: 'timeout' })
  }
  assert.equal(await store.load('a.png'), null)
  await store.revalidate()
  await store.revalidate()
  assert.equal(store.generation, 0)
  // Once the file changes it is tried again.
  worker.beforeChunk = null
  worker.write('a.png', 10)
  await store.revalidate()
  assert.equal(store.generation, 1)
})

test('saving over an image the document was missing shows it at once', async () => {
  const worker = fakeWorker()
  const store = await located(worker)
  assert.equal(await store.load('figures/plot.png'), null)
  const path = await store.save(new File([new Uint8Array(8)], 'plot.png', { type: 'image/png' }), 'plot.png')
  assert.equal(path, 'figures/plot.png')
  assert.equal(store.generation, 1)
  assert.ok(store.cached('figures/plot.png')?.url)
  // What is on disk is what it shows: the next check reloads nothing.
  worker.write('figures/plot.png', 8)
  await store.revalidate()
  assert.equal(store.generation, 1)
})
