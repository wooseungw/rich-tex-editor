// Development only: serves the worker's picture handlers (worker/pictures.ts) over HTTP, so
// dev/harness.html draws TikZ with this computer's TeX the way the plugin's worker does.
//
//   node dev/tex-server.mjs [--port 8790] [--dir examples]
//
// then open the harness URL it prints (…/dev/harness.html?tex=8790&token=…). `--dir` is the folder
// the harness's document "lives" in (TeX looks there for \input files and data tables). Only pages
// on localhost that send the printed token are answered: other sites cannot use it.
import { build } from 'esbuild'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const port = Number(arg('port', '8790'))
const dir = resolve(root, arg('dir', 'examples'))

const out = await mkdtemp(join(tmpdir(), 'rich-tex-dev-'))
// Drawings go to a cache of this run's own, never the person's (~/Library/Caches/rich-tex-editor).
process.env.RICH_TEX_EDITOR_CACHE = join(out, 'cache')
await build({
  entryPoints: [join(root, 'worker/pictures.ts')],
  outfile: join(out, 'pictures.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'warning'
})
const { registerPictures } = await import(pathToFileURL(join(out, 'pictures.mjs')).href)

const handlers = new Map()
const orca = {
  panels: { handle: (name, handler) => handlers.set(name, handler), post() {} },
  log: (message) => console.log(message)
}
registerPictures(orca, async () => ({ realRoot: dir, texDir: dir }))

const token = randomBytes(16).toString('hex')
const LOCAL = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/

const server = createServer((req, res) => {
  const origin = req.headers.origin ?? ''
  if (!LOCAL.test(origin)) {
    res.statusCode = 403
    return res.end()
  }
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-rte-token')
  res.setHeader('Vary', 'Origin')
  if (req.method === 'OPTIONS') return res.end()
  if (req.method !== 'POST' || req.url !== '/request' || req.headers['x-rte-token'] !== token) {
    res.statusCode = 404
    return res.end()
  }
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > 4 * 1024 * 1024) req.destroy()
  })
  req.on('end', async () => {
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    res.setHeader('content-type', 'application/json')
    try {
      const { name, input } = JSON.parse(body)
      const handler = handlers.get(name)
      if (!handler) throw Object.assign(new Error(`unknown_method: ${name}`), { code: 'unknown_method' })
      const started = Date.now()
      const output = await handler(input, { signal: controller.signal, panel: { id: 'harness', surface: 'editor', contributionId: 'latex' } })
      if (name === 'picture.render') console.log(`${name} ${output.status} ${Date.now() - started} ms`)
      res.end(JSON.stringify({ ok: true, output }))
    } catch (error) {
      res.end(JSON.stringify({ ok: false, code: error?.code ?? 'action_failed', message: error instanceof Error ? error.message : String(error) }))
    }
  })
})
server.listen(port, '127.0.0.1', () => {
  console.log(`Rich TeX pictures on http://127.0.0.1:${port}/request (documents in ${dir})`)
  console.log(`Harness: /dev/harness.html?tex=${port}&token=${token}&file=…`)
})
const stop = async () => {
  server.close()
  await rm(out, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
