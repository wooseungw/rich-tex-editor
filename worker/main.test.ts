import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import { MAX_IMAGE_BYTES, READ_CHUNK_BYTES, UPLOAD_CHUNK_BYTES, type TexLocation } from '../src/protocol'
import * as worker from './main'

const TEX = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n'
const temporary: string[] = []

afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rich-tex-worker-'))
  temporary.push(dir)
  return dir
}

async function write(root: string, rel: string, content: string | Buffer) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), content)
}

/** A worker whose focused workspace is a fresh temp folder holding `files`. */
async function setup(files: Record<string, string | Buffer> = {}, options: { focused?: boolean } = {}) {
  const root = await tempDir()
  for (const [rel, content] of Object.entries(files)) await write(root, rel, content)
  const host = mockHost({
    results: {
      'workspace.readContext':
        options.focused === false ? null : { workspaceId: 'ws-1', branch: 'main', displayName: 'Paper', terminals: [] },
      'workspace.list': {
        workspaces: [{ id: 'ws-1', kind: 'folder', name: 'Paper', path: root, branch: null, hostId: null }],
        truncated: false
      }
    }
  })
  const orca = await mountWorker(worker, { host })
  const location: TexLocation = { root, dir: 'paper', file: 'main.tex' }
  return { root, orca, location }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const locateInput = (text: string) => ({ sha256: sha256(text), bytes: Buffer.byteLength(text) })
const withCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code

type Worker = Awaited<ReturnType<typeof setup>>['orca']

async function upload(orca: Worker, location: TexLocation | null, name: string, data: Buffer, folder = 'figures') {
  const begun = await orca.request('image.begin', { location, folder, name, bytes: data.length })
  for (let index = 0; index * UPLOAD_CHUNK_BYTES < data.length; index++) {
    const chunk = data.subarray(index * UPLOAD_CHUNK_BYTES, (index + 1) * UPLOAD_CHUNK_BYTES)
    await orca.request('image.chunk', { uploadId: begun.uploadId, index, data: chunk.toString('base64') })
  }
  return { begun, committed: await orca.request('image.commit', { uploadId: begun.uploadId }) }
}

test('tex.locate finds a nested .tex by content and prefers the newest duplicate', async () => {
  // Copies found before and after the newest one (the walk goes breadth first), and newer ones
  // in folders the walk skips.
  const { root, orca } = await setup({
    'copy.tex': TEX,
    'paper/main.tex': TEX,
    'paper/old/copy.tex': TEX,
    'same-size.tex': TEX.replace('Hello', 'Jello'),
    'node_modules/pkg/main.tex': TEX,
    '.git/main.tex': TEX,
    'notes.txt': TEX
  })
  const at = async (rel: string, hours: number) => {
    const time = new Date(Date.now() + hours * 3600_000)
    await fs.utimes(path.join(root, rel), time, time)
  }
  await at('copy.tex', -2)
  await at('paper/old/copy.tex', -1)
  await at('node_modules/pkg/main.tex', 1)
  await at('.git/main.tex', 1)

  const answer = await orca.request('tex.locate', locateInput(TEX))
  assert.deepEqual(answer, { location: { root, dir: 'paper', file: 'main.tex' }, workspace: root })
  assert.deepEqual(await orca.request('tex.locate', locateInput(TEX)), answer) // from the cache

  await fs.rm(path.join(root, 'paper/main.tex')) // a stale cache entry is checked and dropped
  const moved = await orca.request('tex.locate', locateInput(TEX))
  assert.deepEqual(moved.location, { root, dir: 'paper/old', file: 'copy.tex' })
})

test('tex.locate answers null without a match or a local folder, and searches unfocused workspaces', async () => {
  const { root, orca } = await setup({ 'main.tex': TEX })
  assert.deepEqual(await orca.request('tex.locate', locateInput('other text')), { location: null, workspace: root })
  assert.deepEqual(await orca.request('tex.locate', locateInput(TEX)), {
    location: { root, dir: '', file: 'main.tex' },
    workspace: root
  })

  // Another workspace may be focused (or none): the file is still found where it is.
  const unfocused = await setup({ 'main.tex': TEX }, { focused: false })
  assert.deepEqual(await unfocused.orca.request('tex.locate', locateInput(TEX)), {
    location: { root: unfocused.root, dir: '', file: 'main.tex' },
    workspace: unfocused.root
  })

  const remote = await mountWorker(worker, {
    host: mockHost({
      results: {
        'workspace.readContext': { workspaceId: 'ssh-1', branch: 'main', displayName: 'Remote', terminals: [] },
        'workspace.list': {
          workspaces: [{ id: 'ssh-1', kind: 'worktree', name: 'Remote', path: path.join(root, 'missing'), branch: 'main', hostId: 'ssh:box' }],
          truncated: false
        }
      }
    })
  })
  assert.deepEqual(await remote.request('tex.locate', locateInput(TEX)), { location: null, workspace: null })
  await assert.rejects(orca.request('tex.locate', { sha256: 'nope', bytes: 1 }), withCode('invalid_params'))
})

test('an upload in several chunks writes identical bytes and never overwrites', async () => {
  const { root, orca, location } = await setup({ 'paper/main.tex': TEX })
  const data = randomBytes(Math.floor(UPLOAD_CHUNK_BYTES * 2.5))
  const first = await upload(orca, location, 'plot.png', data)
  assert.equal(first.begun.path, 'figures/plot.png')
  assert.equal(first.committed.path, 'figures/plot.png')
  assert.ok(data.equals(await fs.readFile(path.join(root, 'paper/figures/plot.png'))))

  const other = randomBytes(1000)
  const second = await upload(orca, location, 'plot.png', other)
  assert.equal(second.begun.path, 'figures/plot-1.png')
  assert.equal(second.committed.path, 'figures/plot-1.png')
  assert.ok(data.equals(await fs.readFile(path.join(root, 'paper/figures/plot.png'))))
  assert.ok(other.equals(await fs.readFile(path.join(root, 'paper/figures/plot-1.png'))))

  // A file that appears between begin and commit is kept; the commit picks the next name.
  const begun = await orca.request('image.begin', { location, folder: 'figures', name: 'late.png', bytes: 3 })
  await write(root, 'paper/figures/late.png', 'old')
  await orca.request('image.chunk', { uploadId: begun.uploadId, index: 0, data: Buffer.from('new').toString('base64') })
  assert.deepEqual(await orca.request('image.commit', { uploadId: begun.uploadId }), { path: 'figures/late-1.png' })
  assert.equal(await fs.readFile(path.join(root, 'paper/figures/late.png'), 'utf8'), 'old')
})

test('upload names are sanitised and a null location saves under the workspace root', async () => {
  const { root, orca, location } = await setup({ 'paper/main.tex': TEX })
  const data = Buffer.from('<svg/>')
  assert.equal((await upload(orca, location, 'My Plot (final)!!.PNG', data)).committed.path, 'figures/My-Plot-final.png')
  assert.equal((await upload(orca, location, '그림.jpeg', data)).committed.path, 'figures/image.jpeg')
  assert.equal((await upload(orca, location, '../../evil.svg', data)).committed.path, 'figures/evil.svg')
  assert.equal((await upload(orca, location, 'a//b.gif', data, './img/')).committed.path, 'img/a-b.gif')
  assert.equal((await upload(orca, null, 'shot.webp', data)).committed.path, 'figures/shot.webp')
  assert.ok(await fs.stat(path.join(root, 'paper/figures/evil.svg')))
  assert.ok(await fs.stat(path.join(root, 'paper/img/a-b.gif')))
  assert.ok(await fs.stat(path.join(root, 'figures/shot.webp')))
})

test('uploads reject bad folders, names, sizes, chunk order and totals', async () => {
  const { root, orca, location } = await setup({ 'paper/main.tex': TEX })
  const begin = (input: Partial<{ folder: string; name: string; bytes: number }>) =>
    orca.request('image.begin', { location, folder: 'figures', name: 'plot.png', bytes: 10, ...input })

  await assert.rejects(begin({ folder: '../outside' }), withCode('invalid_params'))
  await assert.rejects(begin({ folder: 'figures/../../x' }), withCode('invalid_params'))
  await assert.rejects(begin({ folder: '/tmp' }), withCode('invalid_params'))
  await assert.rejects(begin({ name: 'notes.txt' }), withCode('invalid_params'))
  await assert.rejects(begin({ name: 'plot' }), withCode('invalid_params'))
  await assert.rejects(begin({ bytes: MAX_IMAGE_BYTES + 1 }), withCode('too_large'))
  await assert.rejects(begin({ bytes: 0 }), withCode('invalid_params'))

  const chunk = (uploadId: string, index: number, bytes: number) =>
    orca.request('image.chunk', { uploadId, index, data: Buffer.alloc(bytes, 1).toString('base64') })

  const outOfOrder = await begin({})
  await assert.rejects(chunk(outOfOrder.uploadId, 1, 5), withCode('invalid_params'))
  await assert.rejects(chunk(outOfOrder.uploadId, 0, 5), withCode('invalid_params')) // that upload is gone

  const short = await begin({})
  await chunk(short.uploadId, 0, 5)
  await assert.rejects(orca.request('image.commit', { uploadId: short.uploadId }), withCode('invalid_params'))

  const long = await begin({})
  await assert.rejects(chunk(long.uploadId, 0, 11), withCode('too_large'))

  const badData = await begin({})
  await assert.rejects(
    orca.request('image.chunk', { uploadId: badData.uploadId, index: 0, data: 'not base64!' }),
    withCode('invalid_params')
  )
  await assert.rejects(orca.request('image.commit', { uploadId: 'nope' }), withCode('invalid_params'))
  await assert.rejects(fs.stat(path.join(root, 'paper/figures/plot.png')), withCode('ENOENT'))
})

test('uploads idle for over two minutes are forgotten', async () => {
  const { orca, location } = await setup({ 'paper/main.tex': TEX })
  const begun = await orca.request('image.begin', { location, folder: 'figures', name: 'plot.png', bytes: 1 })
  const now = Date.now
  Date.now = () => now() + 121_000
  try {
    await assert.rejects(
      orca.request('image.chunk', { uploadId: begun.uploadId, index: 0, data: 'AA==' }),
      withCode('invalid_params')
    )
  } finally {
    Date.now = now
  }
})

test('image.read resolves extensionless refs and \\graphicspath folders', async () => {
  const png = randomBytes(64)
  const { orca, location } = await setup({
    'paper/main.tex': TEX,
    'paper/figures/plot.png': png,
    'paper/figures/plot.pdf': 'pdf',
    'paper/figures/only.PDF': 'pdf',
    'paper/notes.txt': 'text',
    'shared/logo.jpg': 'jpg'
  })
  const read = (ref: string, graphicsPath: string[] = []) => orca.request('image.read', { location, ref, graphicsPath, offset: 0 })

  const plot = await read('figures/plot')
  assert.ok(plot.found)
  assert.deepEqual({ path: plot.path, mime: plot.mime, size: plot.size, next: plot.next }, {
    path: 'figures/plot.png',
    mime: 'image/png',
    size: 64,
    next: null
  })
  assert.ok(Buffer.from(plot.data, 'base64').equals(png))
  assert.equal(typeof plot.mtimeMs, 'number')

  const pdf = await read('figures/plot.pdf')
  assert.ok(pdf.found && pdf.mime === 'application/pdf')
  const upper = await read('figures/only.PDF')
  assert.ok(upper.found && upper.path === 'figures/only.PDF')
  const logo = await read('logo', ['figures/', '../shared/'])
  assert.ok(logo.found)
  assert.deepEqual([logo.path, logo.mime], ['../shared/logo.jpg', 'image/jpeg'])

  assert.deepEqual(await read('missing'), { found: false })
  assert.deepEqual(await read('notes.txt'), { found: false })
  assert.deepEqual(await read('main.tex'), { found: false })
  assert.deepEqual(await read('../../../../../../etc/hosts'), { found: false })
})

test('image.read chunks a large file that reassembles exactly', async () => {
  const big = randomBytes(READ_CHUNK_BYTES * 2 + 123)
  const { orca, location } = await setup({ 'paper/main.tex': TEX, 'paper/big.png': big })
  const readAt = (offset: number) => orca.request('image.read', { location, ref: 'big.png', graphicsPath: [], offset })
  const parts: Buffer[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const answer = await readAt(offset)
    assert.ok(answer.found)
    assert.equal(answer.size, big.length)
    parts.push(Buffer.from(answer.data, 'base64'))
    offset = answer.next
  }
  assert.equal(parts.length, 3)
  assert.ok(Buffer.concat(parts).equals(big))
  await assert.rejects(readAt(big.length + 1), withCode('invalid_params'))
})

test('symlinks out of the workspace and roots that are not workspaces are refused', async () => {
  const { root, orca, location } = await setup({ 'paper/main.tex': TEX, 'paper/inside.png': 'ok' })
  const outside = await tempDir()
  await write(outside, 'secret.png', 'secret')
  await fs.symlink(path.join(outside, 'secret.png'), path.join(root, 'paper/leak.png'))
  await fs.symlink(outside, path.join(root, 'paper/out'))
  await fs.symlink(path.join(root, 'paper/main.tex'), path.join(root, 'paper/tex.png'))

  const read = (ref: string, at: TexLocation = location) =>
    orca.request('image.read', { location: at, ref, graphicsPath: [], offset: 0 })
  assert.deepEqual(await read('leak.png'), { found: false })
  assert.deepEqual(await read('out/secret.png'), { found: false })
  assert.deepEqual(await read('tex.png'), { found: false }) // an image name linking to another type
  assert.ok((await read('inside.png')).found)

  await assert.rejects(
    orca.request('image.begin', { location, folder: 'out/figures', name: 'x.png', bytes: 1 }),
    withCode('outside_workspace')
  )
  assert.deepEqual(await fs.readdir(outside), ['secret.png'])

  const stranger: TexLocation = { root: outside, dir: '', file: 'main.tex' }
  await assert.rejects(read('secret.png', stranger), withCode('invalid_location'))
  await assert.rejects(
    orca.request('image.begin', { location: stranger, folder: 'figures', name: 'x.png', bytes: 1 }),
    withCode('invalid_location')
  )
  await assert.rejects(read('secret.png', { root, dir: '../x', file: 'main.tex' }), withCode('invalid_location'))
  await assert.rejects(read('secret.png', { root: 'paper', dir: '', file: 'main.tex' }), withCode('invalid_location'))
})

test('a remote workspace is never searched or written, even when its path exists here', async () => {
  const root = await tempDir()
  await write(root, 'main.tex', TEX)
  const remote = await mountWorker(worker, {
    host: mockHost({
      results: {
        'workspace.readContext': { workspaceId: 'ssh-1', branch: 'main', displayName: 'Remote', terminals: [] },
        'workspace.list': {
          workspaces: [{ id: 'ssh-1', kind: 'worktree', name: 'Remote', path: root, branch: 'main', hostId: 'ssh:box' }],
          truncated: false
        }
      }
    })
  })
  assert.deepEqual(await remote.request('tex.locate', locateInput(TEX)), { location: null, workspace: null })
  await assert.rejects(
    remote.request('image.begin', { location: { root, dir: '', file: 'main.tex' }, folder: 'figures', name: 'a.png', bytes: 4 }),
    withCode('invalid_location')
  )
})
