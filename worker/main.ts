// The Rich TeX Editor's worker: the editor frame has no file system, so it asks here to find its
// .tex file, save dropped images next to it, read the images it references, and draw the
// pictures only TeX can draw with the person's own TeX (src/protocol.ts, worker/pictures.ts).
// Inputs come from a frame that renders untrusted .tex content: everything is validated.
import type { OrcaWorkerApi } from 'orca/worker'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  READ_CHUNK_BYTES,
  UPLOAD_CHUNK_BYTES,
  type TexLocation
} from '../src/protocol'
import {
  fail,
  findImage,
  findTex,
  freeName,
  makeFolder,
  relativeSegments,
  splitName,
  stillMatches,
  writeUnique
} from './files'
import { registerPictures } from './pictures'
import { PdfDrawings } from './tex/pdf'
import { preambleGraphicsPaths, preambleOf, readSmall, RootFinder } from './tex/root'
import { ToolchainCache } from './tex/tools'
import { documentClass } from './tex/engine'

const UPLOAD_IDLE_MS = 2 * 60 * 1000
const MAX_UPLOADS = 8
const MAX_GRAPHICS_PATHS = 32
/** `workspace.list` answers are reused this long, so a burst of image reads makes one call. */
const LIST_TTL_MS = 2000
/** How long a found image and a section file's image folders are reused: the editor asks about
 *  every image every few seconds, and a search can touch hundreds of paths. */
const FOUND_TTL_MS = 10000

/** Where a request's files go: the workspace root (as listed and resolved) and the .tex folder. */
interface Place {
  root: string
  realRoot: string
  texDir: string
}

interface Upload {
  id: string
  realRoot: string
  /** Absolute target folder, and its segments relative to the .tex folder. */
  folder: string
  segments: string[]
  stem: string
  ext: string
  bytes: number
  chunks: Buffer[]
  received: number
  next: number
  touched: number
}

/** The fields of an object input, or `invalid_params`. */
function fields<T>(input: T): Partial<T> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('invalid_params', 'expected an object')
  }
  return input
}

const NOT_FOUND = { found: false } as const

const isCount = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min

const isDirectory = (dir: string) =>
  fs.stat(dir).then(
    (stat) => stat.isDirectory(),
    () => false
  )

export default function activate(orca: OrcaWorkerApi) {
  const located = new Map<string, TexLocation>()
  const uploads = new Map<string, Upload>()
  let listed: { at: number; value: Promise<{ id: string; root: string }[]> } | undefined

  function workspaces() {
    if (!listed || Date.now() - listed.at > LIST_TTL_MS) {
      const value = orca.host
        .call('workspace.list')
        // Only workspaces on this machine: an `ssh:` or `runtime:` row's path names a folder on
        // another host, even when a folder of that name happens to exist here too.
        .then(({ workspaces }) =>
          workspaces
            .filter((ws) => ws.hostId === null || ws.hostId === 'local')
            .map((ws) => ({ id: ws.id, root: path.resolve(ws.path) }))
        )
      listed = { at: Date.now(), value }
      value.catch(() => {
        if (listed?.value === value) listed = undefined
      })
    }
    return listed.value
  }

  /** The focused workspace's folder, or null when none is focused or it is not on this machine. */
  async function focusedRoot(): Promise<string | null> {
    const context = await orca.host.call('workspace.readContext')
    if (!context?.workspaceId) return null
    const workspace = (await workspaces()).find((ws) => ws.id === context.workspaceId)
    return workspace && (await isDirectory(workspace.root)) ? workspace.root : null
  }

  /** Checks a frame-supplied location; null resolves to the focused root (or null if none). */
  async function place(location: TexLocation | null | undefined): Promise<Place | null> {
    if (location === null || location === undefined) {
      const root = await focusedRoot()
      return root ? { root, realRoot: await fs.realpath(root), texDir: root } : null
    }
    if (typeof location !== 'object') fail('invalid_location', 'location must be { root, dir, file } or null')
    const { root, dir } = location
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('invalid_location', 'root must be an absolute path')
    const resolved = path.resolve(root)
    if (!(await workspaces()).some((ws) => ws.root === resolved)) {
      fail('invalid_location', 'root is not the folder of an Orca workspace')
    }
    const segments = relativeSegments(dir) ?? fail('invalid_location', 'dir must be a relative path without ..')
    const realRoot = await fs.realpath(resolved).catch(() => fail('invalid_location', 'the workspace is not on this machine'))
    return { root: resolved, realRoot, texDir: path.join(resolved, ...segments) }
  }

  function forgetIdleUploads() {
    const now = Date.now()
    for (const [id, pending] of uploads) if (now - pending.touched > UPLOAD_IDLE_MS) uploads.delete(id)
  }

  function upload(uploadId: unknown): Upload {
    forgetIdleUploads()
    const found = typeof uploadId === 'string' ? uploads.get(uploadId) : undefined
    if (!found) fail('invalid_params', 'unknown or expired upload')
    found.touched = Date.now()
    return found
  }

  // Section files (\input into a main document) read images and pictures from that document's
  // folder, as LaTeX does: both kinds of request find it through one cache.
  const roots = new RootFinder()
  const toolchains = new ToolchainCache()
  const pdfs = new PdfDrawings(() => toolchains.get())

  // Pictures only TeX can draw (TikZ, pgfplots, tikz-cd…), drawn with the person's TeX.
  registerPictures(orca, (location) => place(location), roots, toolchains)

  orca.panels.handle('tex.locate', async (input) => {
    const { sha256, bytes } = fields(input)
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) fail('invalid_params', 'sha256 must be 64 hex digits')
    if (!isCount(bytes)) fail('invalid_params', 'bytes must be a size')
    // The editor's file is usually in the focused workspace, but the person may have another one
    // focused (or none): then every other workspace on this machine is searched too.
    const focused = await focusedRoot()
    const roots = [focused, ...(await workspaces()).map((ws) => ws.root)].filter(
      (root, i, all): root is string => root !== null && all.indexOf(root) === i
    )
    const hash = sha256.toLowerCase()
    for (const root of roots) {
      const key = `${root}\0${hash}\0${bytes}`
      const cached = located.get(key)
      if (cached && (await stillMatches(cached, hash))) return { location: cached, workspace: root }
      located.delete(key)
    }
    for (const root of roots) {
      if (root !== focused && !(await isDirectory(root))) continue
      const location = await findTex(root, hash, bytes)
      if (location) {
        located.set(`${root}\0${hash}\0${bytes}`, location)
        return { location, workspace: root }
      }
    }
    return { location: null, workspace: focused }
  })

  orca.panels.handle('image.begin', async (input) => {
    const { location, folder, name, bytes } = fields(input)
    const parts = splitName(name) ?? fail('invalid_params', `name must end in .${IMAGE_EXTENSIONS.join(', .')}`)
    if (!isCount(bytes, 1)) fail('invalid_params', 'bytes must be a positive integer')
    if (bytes > MAX_IMAGE_BYTES) fail('too_large', `images are limited to ${MAX_IMAGE_BYTES} bytes`)
    const segments = relativeSegments(folder) ?? fail('invalid_params', 'folder must be a relative path without ..')
    forgetIdleUploads()
    if (uploads.size >= MAX_UPLOADS) fail('rate_limited', 'too many uploads in progress')
    const where = (await place(location)) ?? fail('invalid_location', 'no workspace is focused')
    const target = path.join(where.texDir, ...segments)
    const realFolder = await makeFolder(where.realRoot, target)
    const fileName = await freeName(realFolder, parts.stem, parts.ext)
    const uploadId = randomUUID()
    uploads.set(uploadId, {
      id: uploadId,
      realRoot: where.realRoot,
      folder: target,
      segments,
      ...parts,
      bytes,
      chunks: [],
      received: 0,
      next: 0,
      touched: Date.now()
    })
    return { uploadId, path: [...segments, fileName].join('/') }
  })

  orca.panels.handle('image.chunk', async (input) => {
    const { uploadId, index, data } = fields(input)
    const current = upload(uploadId)
    try {
      if (index !== current.next) fail('invalid_params', `expected chunk ${current.next}`)
      const chunk = typeof data === 'string' ? Buffer.from(data, 'base64') : null
      if (!chunk || chunk.toString('base64') !== data) fail('invalid_params', 'data must be base64')
      if (chunk.length > UPLOAD_CHUNK_BYTES) fail('too_large', `chunks are limited to ${UPLOAD_CHUNK_BYTES} bytes`)
      if (current.received + chunk.length > current.bytes) fail('too_large', `more than the ${current.bytes} bytes declared`)
      current.chunks.push(chunk)
      current.received += chunk.length
      current.next++
      return { received: current.received }
    } catch (error) {
      uploads.delete(current.id) // an upload with a bad chunk cannot be finished
      throw error
    }
  })

  orca.panels.handle('image.commit', async (input) => {
    const { uploadId } = fields(input)
    const current = upload(uploadId)
    uploads.delete(current.id)
    if (current.received !== current.bytes) {
      fail('invalid_params', `received ${current.received} of ${current.bytes} bytes`)
    }
    const realFolder = await makeFolder(current.realRoot, current.folder)
    const fileName = await writeUnique(realFolder, current.stem, current.ext, Buffer.concat(current.chunks))
    return { path: [...current.segments, fileName].join('/') }
  })

  /** The image a document's `ref` names, looked up as `image.read` and `image.stat` describe. */
  const foundImages = new Map<string, { at: number; image: NonNullable<Awaited<ReturnType<typeof findImage>>> }>()
  const sectionFolders = new Map<string, { at: number; value: Promise<{ rootDir: string; folders: string[] } | null> }>()

  async function lookUp(input: { location?: TexLocation | null; ref?: unknown; graphicsPath?: unknown }) {
    const { location, ref, graphicsPath = [] } = input
    if (typeof ref !== 'string' || ref === '' || ref.includes('\0')) fail('invalid_params', 'ref must be a path')
    if (!Array.isArray(graphicsPath)) fail('invalid_params', 'graphicsPath must be a list')
    if (location && (typeof location.file !== 'string' || !/^[^/\\\0]+$/.test(location.file) || location.file === '..')) {
      fail('invalid_location', 'file must be a file name')
    }
    const where = await place(location)
    if (!where) return null
    const folders = graphicsPath
      .filter((folder): folder is string => typeof folder === 'string' && !folder.includes('\0'))
      .slice(0, MAX_GRAPHICS_PATHS)
    // Found a moment ago and still there: no new search (the file's own size and time are read
    // fresh by the caller, so a redrawn figure is still noticed).
    const key = JSON.stringify([where.realRoot, where.texDir, location?.file ?? null, ref, folders])
    const known = foundImages.get(key)
    if (known && Date.now() - known.at < FOUND_TTL_MS && (await fs.stat(known.image.file).then((s) => s.isFile(), () => false))) return known.image
    foundImages.delete(key)
    const image = await search(where, location ?? null, ref, folders)
    if (image) {
      foundImages.set(key, { at: Date.now(), image })
      if (foundImages.size > 512) foundImages.delete(foundImages.keys().next().value as string)
    }
    return image
  }

  async function search(where: Place, location: TexLocation | null, ref: string, folders: string[]) {
    const here = await findImage(where.realRoot, where.texDir, ref, folders)
    if (here || !location) return here
    const found = await rootFolders(where, location)
    if (!found) return null
    return findImage(where.realRoot, found.rootDir, ref, [...found.folders, ...folders].slice(0, MAX_GRAPHICS_PATHS))
  }

  /** Where a section file's images are looked for as LaTeX does: its root document's folder and
   *  \graphicspath. Kept a few seconds per file. */
  function rootFolders(where: Place, location: TexLocation) {
    const key = `${where.realRoot}\0${where.texDir}\0${location.file}`
    const hit = sectionFolders.get(key)
    if (hit && Date.now() - hit.at < FOUND_TTL_MS) return hit.value
    const value = findRootFolders(where, location).catch(() => null)
    sectionFolders.set(key, { at: Date.now(), value })
    if (sectionFolders.size > 64) sectionFolders.delete(sectionFolders.keys().next().value as string)
    return value
  }

  async function findRootFolders(where: Place, location: TexLocation) {
    const realDir = await fs.realpath(where.texDir).catch(() => null)
    if (!realDir) return null
    const file = path.join(realDir, location.file)
    const text = (await readSmall(where.realRoot, file)) ?? ''
    const root = await roots.find(where.realRoot, file, text.slice(0, 4096))
    // Not a section file: its own preamble may still set \graphicspath in a file it \input's.
    let rootDir = realDir
    let preamble = ''
    if (root) {
      rootDir = path.dirname(root.file)
      preamble = root.preamble
    } else if (documentClass(text)) preamble = preambleOf(text)
    if (!preamble) return null
    return { rootDir, folders: await preambleGraphicsPaths(where.realRoot, rootDir, preamble) }
  }

  /** The image opened for reading, with what it is now; null when it cannot be read. `image.stat`
   *  and `image.read` both go through it, so they agree on which files exist. */
  async function open(file: string) {
    const handle = await fs.open(file, 'r').catch(() => null)
    if (!handle) return null
    const stat = await handle.stat().catch(() => null)
    if (stat?.isFile() && stat.size <= MAX_IMAGE_BYTES) return { handle, stat }
    await handle.close()
    return null
  }

  orca.panels.handle('image.stat', async (input) => {
    const image = await lookUp(fields(input))
    const opened = image && (await open(image.file))
    if (!image || !opened) return NOT_FOUND
    await opened.handle.close()
    return { found: true as const, path: image.path, size: opened.stat.size, mtimeMs: opened.stat.mtimeMs }
  })

  orca.panels.handle('image.read', async (input) => {
    const { offset, drawPdf, ...rest } = fields(input)
    if (!isCount(offset)) fail('invalid_params', 'offset must be a byte offset')
    const image = await lookUp(rest)
    const opened = image && (await open(image.file))
    if (!image || !opened) return NOT_FOUND
    const { handle, stat } = opened
    try {
      // A PDF figure drawn as SVG (page 1), when this computer has a PDF converter. Size and time
      // stay the PDF's, so the editor's checks for a redrawn file still compare like with like.
      if (image.mime === 'application/pdf' && drawPdf === true) {
        const svg = await pdfs.svg(image.file, stat)
        if (svg) {
          if (offset > svg.length) fail('invalid_params', `offset is past the end (${svg.length} bytes)`)
          const end = Math.min(svg.length, offset + READ_CHUNK_BYTES)
          return {
            found: true as const,
            path: image.path,
            mime: 'image/svg+xml',
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            data: svg.subarray(offset, end).toString('base64'),
            next: end < svg.length ? end : null
          }
        }
      }
      if (offset > stat.size) fail('invalid_params', `offset is past the end (${stat.size} bytes)`)
      // The editor does not draw PDFs: knowing where one is is enough.
      const wanted = image.mime === 'application/pdf' ? 0 : stat.size - offset
      const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, wanted))
      const { bytesRead } = buffer.length > 0 ? await handle.read(buffer, 0, buffer.length, offset) : { bytesRead: 0 }
      const end = offset + bytesRead
      return {
        found: true as const,
        path: image.path,
        mime: image.mime,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        data: buffer.subarray(0, bytesRead).toString('base64'),
        next: wanted > 0 && end < stat.size ? end : null
      }
    } finally {
      await handle.close()
    }
  })
}
