// The Rich TeX Editor's worker: the editor frame has no file system, so it asks here to find its
// .tex file, save dropped images next to it and read the images it references (src/protocol.ts).
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

const UPLOAD_IDLE_MS = 2 * 60 * 1000
const MAX_UPLOADS = 8
const MAX_GRAPHICS_PATHS = 32
/** `workspace.list` answers are reused this long, so a burst of image reads makes one call. */
const LIST_TTL_MS = 2000

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

  orca.panels.handle('image.read', async (input) => {
    const { location, ref, graphicsPath = [], offset } = fields(input)
    if (typeof ref !== 'string' || ref === '' || ref.includes('\0')) fail('invalid_params', 'ref must be a path')
    if (!Array.isArray(graphicsPath)) fail('invalid_params', 'graphicsPath must be a list')
    if (!isCount(offset)) fail('invalid_params', 'offset must be a byte offset')
    const where = await place(location)
    if (!where) return NOT_FOUND
    const folders = graphicsPath
      .filter((folder): folder is string => typeof folder === 'string' && !folder.includes('\0'))
      .slice(0, MAX_GRAPHICS_PATHS)
    const image = await findImage(where.realRoot, where.texDir, ref, folders)
    if (!image) return NOT_FOUND
    const handle = await fs.open(image.file, 'r').catch(() => null)
    if (!handle) return NOT_FOUND
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return NOT_FOUND
      if (offset > stat.size) fail('invalid_params', `offset is past the end (${stat.size} bytes)`)
      const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, stat.size - offset))
      const { bytesRead } = buffer.length > 0 ? await handle.read(buffer, 0, buffer.length, offset) : { bytesRead: 0 }
      const end = offset + bytesRead
      return {
        found: true as const,
        path: image.path,
        mime: image.mime,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        data: buffer.subarray(0, bytesRead).toString('base64'),
        next: end < stat.size ? end : null
      }
    } finally {
      await handle.close()
    }
  })
}
