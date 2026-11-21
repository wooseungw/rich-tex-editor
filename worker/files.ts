// File-system work for the worker: finding the open .tex file, and reading and writing images
// without leaving the workspace. Paths that reach here come from an editor frame showing
// untrusted .tex content, so every target is checked after `fs.realpath`.
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, type TexLocation } from '../src/protocol'

type ImageExtension = (typeof IMAGE_EXTENSIONS)[number]

const TEX_EXTENSIONS = new Set(['.tex', '.ltx', '.latex'])
const SKIPPED_FOLDERS = new Set(['node_modules', 'build', 'dist', 'out', 'target', '__pycache__', 'venv'])
const MAX_DEPTH = 8
const MAX_ENTRIES = 5000
const MAX_NAME_ATTEMPTS = 1000

const MIME: Record<ImageExtension, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf'
}

/** Rejects a request; the code leads the message too, since Orca passes only its own codes on. */
export function fail(code: string, message: string): never {
  throw Object.assign(new Error(`${code}: ${message}`), { code })
}

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** The segments of a `/`- or `\`-separated relative path; null when it is absolute or has `..`. */
export function relativeSegments(value: unknown): string[] | null {
  if (typeof value !== 'string' || value.includes('\0')) return null
  if (path.isAbsolute(value) || /^[\\/]|^[A-Za-z]:/.test(value)) return null
  const segments = value.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.')
  return segments.includes('..') ? null : segments
}

/** The lowercase extension of `name` when it is one of IMAGE_EXTENSIONS. */
export function imageExtension(name: string): ImageExtension | null {
  const ext = path.extname(name).slice(1).toLowerCase()
  return IMAGE_EXTENSIONS.find((known) => known === ext) ?? null
}

/** `My Plot (1).PNG` → `{ stem: 'My-Plot-1', ext: 'png' }`; null without an image extension. */
export function splitName(name: unknown): { stem: string; ext: ImageExtension } | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  const ext = imageExtension(trimmed)
  if (!ext) return null
  const stem = trimmed
    .slice(0, -(ext.length + 1))
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100)
    .replace(/^[-.]+|[-.]+$/g, '')
  return { stem: stem || 'image', ext }
}

async function hashFile(file: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await fs.readFile(file)).digest('hex')
  } catch {
    return null
  }
}

/** Whether `location` still names a file with these bytes. */
export async function stillMatches(location: TexLocation, sha256: string): Promise<boolean> {
  return (await hashFile(path.join(location.root, location.dir, location.file))) === sha256
}

/**
 * Walks `root` breadth first (no dot-folders, dependency or build folders, or symlinks) for a
 * .tex file of `bytes` bytes hashing to `sha256`; of several, the most recently modified.
 */
export async function findTex(root: string, sha256: string, bytes: number): Promise<TexLocation | null> {
  let best: { location: TexLocation; mtimeMs: number } | null = null
  let seen = 0
  let level = ['']
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0 && seen < MAX_ENTRIES; depth++) {
    const listings = await Promise.all(
      level.map((dir) =>
        fs.readdir(path.join(root, dir), { withFileTypes: true }).then(
          (entries) => ({ dir, entries }),
          () => ({ dir, entries: [] })
        )
      )
    )
    const next: string[] = []
    for (const { dir, entries } of listings) {
      for (const entry of entries) {
        if (++seen > MAX_ENTRIES) break
        const rel = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name)) next.push(rel)
          continue
        }
        if (!entry.isFile() || !TEX_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
        const file = path.join(root, rel)
        const stat = await fs.stat(file).catch(() => null)
        if (!stat || stat.size !== bytes || (best && stat.mtimeMs <= best.mtimeMs)) continue
        if ((await hashFile(file)) === sha256) {
          best = { location: { root, dir, file: entry.name }, mtimeMs: stat.mtimeMs }
        }
      }
    }
    level = next
  }
  return best?.location ?? null
}

/** Creates `folder`, refusing (`outside_workspace`) when it or an existing parent leaves `realRoot`. */
export async function makeFolder(realRoot: string, folder: string): Promise<string> {
  let existing = folder
  let real: string
  for (;;) {
    try {
      real = await fs.realpath(existing)
      break
    } catch (error) {
      const parent = path.dirname(existing)
      if (errorCode(error) !== 'ENOENT' || parent === existing) throw error
      existing = parent
    }
  }
  if (!isInside(realRoot, real)) fail('outside_workspace', 'the folder is outside the workspace')
  await fs.mkdir(folder, { recursive: true })
  real = await fs.realpath(folder)
  if (!isInside(realRoot, real)) fail('outside_workspace', 'the folder is outside the workspace')
  return real
}

const nameAt = (stem: string, ext: string, n: number) => (n === 0 ? `${stem}.${ext}` : `${stem}-${n}.${ext}`)

/** The first of `stem.ext`, `stem-1.ext`, … that does not exist in `folder` yet. */
export async function freeName(folder: string, stem: string, ext: string): Promise<string> {
  for (let n = 0; n < MAX_NAME_ATTEMPTS; n++) {
    const name = nameAt(stem, ext, n)
    try {
      await fs.lstat(path.join(folder, name))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return name
      throw error
    }
  }
  fail('conflict', `no free name for ${stem}.${ext}`)
}

/** Writes `data` under the first free name, never replacing a file; a failed write is removed. */
export async function writeUnique(folder: string, stem: string, ext: string, data: Buffer): Promise<string> {
  for (let n = 0; n < MAX_NAME_ATTEMPTS; n++) {
    const name = nameAt(stem, ext, n)
    const target = path.join(folder, name)
    let handle: fs.FileHandle
    try {
      handle = await fs.open(target, 'wx')
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue
      throw error
    }
    try {
      await handle.writeFile(data)
      await handle.close()
    } catch (error) {
      await handle.close().catch(() => undefined)
      await fs.rm(target, { force: true })
      throw error
    }
    return name
  }
  fail('conflict', `no free name for ${stem}.${ext}`)
}

export interface FoundImage {
  /** The real file, symlinks resolved. */
  file: string
  /** As the document reaches it: relative to the .tex folder, `/`-separated. */
  path: string
  mime: string
}

/**
 * Resolves `ref` as LaTeX does: in `texDir`, then each `graphicsPath` folder; without an image
 * extension, with each of IMAGE_EXTENSIONS in turn. Only image files inside `realRoot` count.
 */
export async function findImage(
  realRoot: string,
  texDir: string,
  ref: string,
  graphicsPath: string[]
): Promise<FoundImage | null> {
  const folders = [texDir, ...graphicsPath.map((folder) => path.resolve(texDir, folder))]
  const names = imageExtension(ref) ? [ref] : IMAGE_EXTENSIONS.map((ext) => `${ref}.${ext}`)
  for (const folder of folders) {
    for (const name of names) {
      const candidate = path.resolve(folder, name)
      const file = await fs.realpath(candidate).catch(() => null)
      const ext = file && imageExtension(file)
      if (!file || !ext || !isInside(realRoot, file)) continue
      const stat = await fs.stat(file).catch(() => null)
      if (!stat?.isFile() || stat.size > MAX_IMAGE_BYTES) continue
      return { file, path: path.relative(texDir, candidate).split(path.sep).join('/'), mime: MIME[ext] }
    }
  }
  return null
}
