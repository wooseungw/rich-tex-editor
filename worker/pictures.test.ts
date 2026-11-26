// Pictures drawn with this computer's TeX through the worker's handlers. Skipped (passing) where
// no TeX is installed, as on a machine that only runs the plugin's other tests.
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import { TEXT_CHUNK_CHARS, type PictureAnswer, type TexLocation } from '../src/protocol'
import * as worker from './main'
import { findToolchain } from './tex/toolchain'

const temporary: string[] = []
afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})
async function tempDir() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rich-tex-pictures-')))
  temporary.push(dir)
  return dir
}
async function write(root: string, rel: string, content: string) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), content)
}
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const ref = (text: string) => ({ sha256: sha(text), text })

let hasTex: Promise<boolean> | null = null
const texInstalled = () => (hasTex ??= findToolchain().then((t) => !!t.bin.latex && !!t.bin.dvisvgm))

async function setup(files: Record<string, string>) {
  const root = await tempDir()
  process.env.RICH_TEX_EDITOR_CACHE = await tempDir()
  for (const [rel, content] of Object.entries(files)) await write(root, rel, content)
  const host = mockHost({
    results: {
      'workspace.readContext': { workspaceId: 'ws-1', branch: 'main', displayName: 'Paper', terminals: [] },
      'workspace.list': {
        workspaces: [{ id: 'ws-1', kind: 'folder', name: 'Paper', path: root, branch: null, hostId: null }],
        truncated: false
      }
    }
  })
  const orca = await mountWorker(worker, { host })
  return { root, orca }
}

const PREAMBLE = '\\documentclass{article}\n\\usepackage{tikz}\n\\newcommand{\\mylabel}{Root}\n'

test('pictures: tex.tools reports the installation', async () => {
  const { orca } = await setup({})
  const tools = await orca.request('tex.tools', null)
  assert.equal(typeof tools.found, 'boolean')
  if (await texInstalled()) {
    assert.equal(tools.found, true)
    assert.ok(tools.engines.includes('pdflatex'))
  }
})

test('pictures: a picture is drawn, and an error points at its line', async () => {
  if (!(await texInstalled())) return
  const { orca } = await setup({})
  const drawn = (await orca.request('picture.render', {
    location: null,
    preamble: ref(PREAMBLE),
    snippet: ref('\\begin{tikzpicture}\\draw[red] (0,0) rectangle (1,1); \\node {\\mylabel};\\end{tikzpicture}'),
    mode: 'block',
    graphicsPath: []
  })) as PictureAnswer
  assert.equal(drawn.status, 'drawn', JSON.stringify(drawn))
  if (drawn.status !== 'drawn') return
  assert.match(drawn.svg ?? '', /^<\?xml|<svg/)
  assert.ok(drawn.width > 30 && drawn.width < 60, `${drawn.width}`) // a 1 cm square and a label centred on its corner
  const read = await orca.request('picture.read', { key: drawn.key, offset: 0 })
  assert.deepEqual(read, { found: true, data: drawn.svg, next: null })
  // Asked again: from the cache, the same drawing.
  const again = (await orca.request('picture.render', { location: null, preamble: ref(PREAMBLE), snippet: ref('\\begin{tikzpicture}\\draw[red] (0,0) rectangle (1,1); \\node {\\mylabel};\\end{tikzpicture}'), mode: 'block', graphicsPath: [] })) as PictureAnswer
  assert.equal(again.status === 'drawn' && again.key, drawn.key)

  const failed = (await orca.request('picture.render', {
    location: null,
    preamble: ref(PREAMBLE),
    snippet: ref('\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\drw (0,0);\n\\end{tikzpicture}'),
    mode: 'block',
    graphicsPath: []
  })) as PictureAnswer
  assert.equal(failed.status, 'failed')
  if (failed.status === 'failed') {
    assert.equal(failed.where, 'picture')
    assert.equal(failed.line, 3)
    assert.match(failed.message, /Undefined control sequence/)
    assert.match(failed.context, /\\drw/)
  }
})

test('pictures: a section file is drawn with its root document preamble and folder', async () => {
  if (!(await texInstalled())) return
  const { root, orca } = await setup({
    'paper/main.tex': `${PREAMBLE}\\begin{document}\n\\input{sections/plot}\n\\end{document}\n`,
    'paper/sections/plot.tex': 'the section',
    'paper/label.tex': 'From a file'
  })
  const location: TexLocation = { root, dir: 'paper/sections', file: 'plot.tex' }
  const answer = (await orca.request('picture.render', {
    location,
    preamble: ref(''),
    snippet: ref('\\begin{tikzpicture}\\node {\\mylabel};\\end{tikzpicture}'),
    mode: 'block',
    graphicsPath: []
  })) as PictureAnswer
  assert.equal(answer.status, 'drawn', JSON.stringify(answer))
  if (answer.status === 'drawn') assert.ok(!answer.notes.some((n) => /no preamble/.test(n)), 'the root preamble was used')

  // A file the picture reads, relative to the root document's folder (TeX's working folder).
  const snippet = ref('\\begin{tikzpicture}\\node {\\input{label.tex}};\\end{tikzpicture}')
  const withData = (await orca.request('picture.render', {
    location,
    preamble: ref(''),
    snippet,
    mode: 'block',
    graphicsPath: []
  })) as PictureAnswer
  assert.equal(withData.status, 'drawn', JSON.stringify(withData))
  if (withData.status !== 'drawn') return
  assert.deepEqual(await orca.request('picture.check', { keys: [withData.key] }), { stale: [] })
  await new Promise((r) => setTimeout(r, 20))
  await write(root, 'paper/label.tex', 'Changed')
  assert.deepEqual(await orca.request('picture.check', { keys: [withData.key] }), { stale: [withData.key] })
})

test('pictures: large texts come in chunks; bad input is refused', async () => {
  if (!(await texInstalled())) return
  const { orca } = await setup({})
  const padding = `%${'x'.repeat(TEXT_CHUNK_CHARS)}\n`.repeat(3)
  const big = `${PREAMBLE}${padding}`
  const snippet = ref('\\tikz \\draw (0,0) circle (1pt);')
  const first = (await orca.request('picture.render', { location: null, preamble: { sha256: sha(big) }, snippet, mode: 'inline', graphicsPath: [] })) as PictureAnswer
  assert.deepEqual(first, { status: 'missing', missing: [sha(big)] })
  const count = Math.ceil(big.length / TEXT_CHUNK_CHARS)
  for (let index = 0; index < count; index++) {
    const answer = await orca.request('text.put', { sha256: sha(big), index, count, data: big.slice(index * TEXT_CHUNK_CHARS, (index + 1) * TEXT_CHUNK_CHARS) })
    assert.equal(answer.complete, index === count - 1)
  }
  const drawn = (await orca.request('picture.render', { location: null, preamble: { sha256: sha(big) }, snippet, mode: 'inline', graphicsPath: [] })) as PictureAnswer
  assert.equal(drawn.status, 'drawn', JSON.stringify(drawn))
  if (drawn.status === 'drawn') assert.ok(drawn.depth >= 0)

  const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c
  await assert.rejects(orca.request('picture.render', { location: null, preamble: { sha256: 'nope' }, snippet, mode: 'block', graphicsPath: [] }), code('invalid_params'))
  await assert.rejects(orca.request('picture.render', { location: null, preamble: ref(''), snippet, mode: 'sideways' as 'block', graphicsPath: [] }), code('invalid_params'))
  await assert.rejects(orca.request('picture.render', { location: null, preamble: { sha256: sha('a'), text: 'b' }, snippet, mode: 'block', graphicsPath: [] }), code('invalid_params'))
  await assert.rejects(orca.request('text.put', { sha256: sha('x'), index: 5, count: 2, data: 'x' }), code('invalid_params'))
  await assert.rejects(orca.request('picture.read', { key: '../../etc/passwd', offset: 0 }), code('invalid_params'))
  // A location outside the workspaces is not refused: the picture is drawn from its text alone.
  const elsewhere = (await orca.request('picture.render', { location: { root: '/', dir: 'etc', file: 'x.tex' }, preamble: ref(PREAMBLE), snippet, mode: 'inline', graphicsPath: ['/etc'] })) as PictureAnswer
  assert.equal(elsewhere.status, 'drawn')
})

test('pictures: TeX runs no commands and writes nothing outside its folder', async () => {
  if (!(await texInstalled())) return
  const { root, orca } = await setup({ 'doc/main.tex': `${PREAMBLE}\\begin{document}\\end{document}` })
  const marker = path.join(root, 'pwned')
  const snippet = [
    '\\begin{tikzpicture}',
    `\\immediate\\write18{touch ${marker}}`,
    '\\newwrite\\rteout',
    `\\immediate\\openout\\rteout=${marker}-written.tex`,
    '\\immediate\\write\\rteout{hello}',
    '\\immediate\\closeout\\rteout',
    '\\immediate\\openout\\rteout=../escaped.tex',
    '\\immediate\\closeout\\rteout',
    '\\draw (0,0) -- (1,0);',
    '\\end{tikzpicture}'
  ].join('\n')
  const answer = (await orca.request('picture.render', {
    location: { root, dir: 'doc', file: 'main.tex' },
    preamble: ref(PREAMBLE),
    snippet: ref(snippet),
    mode: 'block',
    graphicsPath: []
  })) as PictureAnswer
  assert.ok(answer.status === 'drawn' || answer.status === 'failed', JSON.stringify(answer))
  const exists = (file: string) => fs.stat(file).then(() => true, () => false)
  assert.equal(await exists(marker), false, 'shell escape is off')
  assert.equal(await exists(`${marker}-written.tex`), false, 'no writing to absolute paths')
  assert.equal(await exists(path.join(root, 'escaped.tex')), false, 'no writing to parent folders')
  assert.equal(await exists(path.join(os.tmpdir(), 'escaped.tex')), false)
})

test('pictures: TeX reads only the document folders, not absolute paths or dot-folders', async () => {
  if (!(await texInstalled())) return
  const { root, orca } = await setup({ 'doc/main.tex': 'x', 'doc/near.tex': 'NEARBY', 'secret.txt': 'SECRET' })
  const read = async (file: string) =>
    (await orca.request('picture.render', {
      location: { root, dir: 'doc', file: 'main.tex' },
      preamble: ref(PREAMBLE),
      snippet: ref(`\\begin{tikzpicture}\\node {\\input{${file}}};\\end{tikzpicture}`),
      mode: 'block',
      graphicsPath: []
    })) as PictureAnswer
  assert.equal((await read('near.tex')).status, 'drawn', 'a file next to the document is found')
  for (const file of [path.join(root, 'secret.txt'), '../secret.txt', '/etc/hosts']) {
    const answer = await read(file)
    assert.equal(answer.status, 'failed', file)
    if (answer.status === 'failed') assert.match(answer.message, /not found/, file)
  }
})

test('pictures: LuaLaTeX runs only when the person allowed it for the document', async () => {
  if (!(await texInstalled())) return
  const { orca } = await setup({})
  const lua = '% !TEX program = lualatex\n\\documentclass{article}\n\\usepackage{tikz}\n'
  const ask = async (allowLua: boolean) =>
    (await orca.request('picture.render', { location: null, preamble: ref(lua), snippet: ref('\\tikz \\draw (0,0) -- (1,0);'), mode: 'inline', graphicsPath: [], allowLua })) as PictureAnswer
  const blocked = await ask(false)
  assert.equal(blocked.status, 'drawn')
  if (blocked.status === 'drawn') {
    assert.equal(blocked.wantsLua, true)
    assert.match(blocked.label, /^XeLaTeX/)
  }
  const allowed = await ask(true)
  if (allowed.status === 'drawn') {
    assert.equal(allowed.wantsLua, false)
    assert.match(allowed.label, /LuaLaTeX/)
  }
})
