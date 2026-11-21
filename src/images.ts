import type { LoadedImage, ImageLoader } from './editor/image-loader'
import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, type TexLocation, UPLOAD_CHUNK_BYTES } from './protocol'
import { renderPdfFirstPage } from './pdf-render'
import { sha256Hex } from './sha256'

/**
 * The editor's side of the image worker: finds where the open .tex file lives, loads the images
 * it references into `blob:` URLs, and saves dropped or pasted images next to it.
 */

const encoder = new TextEncoder()

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}


/** An error the person should see, with the worker's code when there is one. */
export class ImageError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}

/** The error's code. Orca passes only its own codes through from the worker, so the worker also
 *  starts each message with its code (`invalid_location: …`). */
function codeOf(err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'action_failed'
  if (code !== 'action_failed') return code
  const message = err instanceof Error ? err.message : ''
  return /^([a-z_]+):/.exec(message)?.[1] ?? code
}

export const isImageFile = (file: File) => {
  if (file.type.startsWith('image/') || file.type === 'application/pdf') return true
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext)
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf'
}

/** A file name for an image, giving pasted screenshots (named `image.png`) a dated one. */
export function imageName(file: File, pasted: boolean): string {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : (EXTENSION_BY_TYPE[file.type] ?? 'png')
  if (!pasted && file.name) return file.name
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `pasted-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`
}

export class ImageStore implements ImageLoader {
  private location: TexLocation | null = null
  private locatedFor: string | null = null
  private locating: Promise<TexLocation | null> | null = null
  private readonly images = new Map<string, LoadedImage | null>()
  private readonly pending = new Map<string, Promise<LoadedImage | null>>()
  private graphicsPath: string[] = []
  private available = true
  generation = 0
  /** Called after the generation rises. */
  onChange: (() => void) | null = null

  private bump(): void {
    this.generation++
    this.onChange?.()
  }

  /** `text` gives the document as it is now; it identifies the file on disk. */
  constructor(private readonly text: () => string) {}

  setGraphicsPath(paths: string[]): void {
    if (paths.join('\u0000') === this.graphicsPath.join('\u0000')) return
    this.graphicsPath = paths
    // Folders changed: images not found before may resolve now.
    for (const [ref, image] of this.images) if (image === null) this.images.delete(ref)
    this.bump()
  }

  /** Finds the open file once; until it matches a file on disk (unsaved edits) it tries again.
   *  Calls made while a search runs share it. */
  locate(): Promise<TexLocation | null> {
    if (this.location || !this.available) return Promise.resolve(this.location)
    this.locating ??= this.search().finally(() => {
      this.locating = null
    })
    return this.locating
  }

  private async search(): Promise<TexLocation | null> {
    const text = this.text()
    const bytes = encoder.encode(text)
    const sha256 = await sha256Hex(bytes)
    if (this.locatedFor === sha256) return null
    this.locatedFor = sha256
    try {
      const { location } = await orca.plugin.request('tex.locate', { sha256, bytes: bytes.length }, { timeoutMs: 15000 })
      this.location = location
      // Images looked up before the file was found (unsaved edits) can resolve now.
      if (location && this.generation > 0) this.bump()
    } catch (err) {
      console.warn('Rich TeX Editor: could not find the .tex file on disk', err)
      if (codeOf(err) === 'unavailable') this.available = false
    }
    return this.location
  }

  cached(ref: string): LoadedImage | null | undefined {
    return this.images.get(ref)
  }

  load(ref: string): Promise<LoadedImage | null> {
    const known = this.images.get(ref)
    if (known !== undefined) return Promise.resolve(known)
    let promise = this.pending.get(ref)
    if (!promise) {
      promise = this.read(ref).then(
        (image) => {
          this.pending.delete(ref)
          // A miss is not cached until the file is located, so it is retried after a save.
          if (image || this.location) this.images.set(ref, image)
          return image
        },
        (err: unknown) => {
          console.warn(`Rich TeX Editor: could not load ${ref}`, err)
          this.pending.delete(ref)
          return null
        }
      )
      this.pending.set(ref, promise)
    }
    return promise
  }

  private async read(ref: string): Promise<LoadedImage | null> {
    if (!this.available) return null
    const location = await this.locate()
    const chunks: Uint8Array[] = []
    let offset = 0
    let mime = ''
    let path = ''
    for (;;) {
      const answer = await orca.plugin.request(
        'image.read',
        { location, ref, graphicsPath: this.graphicsPath, offset },
        { timeoutMs: 30000 }
      )
      if (!answer.found) return null
      mime = answer.mime
      path = answer.path
      chunks.push(fromBase64(answer.data))
      if (answer.next === null) break
      offset = answer.next
    }
    if (mime === 'application/pdf') {
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const bytes = new Uint8Array(total)
      let at = 0
      for (const chunk of chunks) {
        bytes.set(chunk, at)
        at += chunk.length
      }
      try {
        return { url: URL.createObjectURL(await renderPdfFirstPage(bytes)), path, mime: 'image/png' }
      } catch (err) {
        console.warn(`Rich TeX Editor: could not draw ${path}`, err)
        return null
      }
    }
    const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: mime }))
    return { url, path, mime }
  }

  /** Saves an image under `figures/` next to the .tex file; answers the `\includegraphics` path. */
  async save(file: File, name: string, onProgress?: (fraction: number) => void): Promise<string> {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new ImageError(`${name} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`, 'too_large')
    }
    const location = await this.locate()
    if (!location) {
      // Without the file's place on disk the image would land in some other folder and the
      // inserted path would not resolve: ask for a save instead.
      throw new ImageError('save the .tex file first (⌘S), so the image can go next to it', 'not_located')
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    try {
      const { uploadId } = await orca.plugin.request('image.begin', { location, folder: 'figures', name, bytes: bytes.length })
      for (let index = 0, at = 0; at < bytes.length; index++, at += UPLOAD_CHUNK_BYTES) {
        const data = toBase64(bytes.subarray(at, at + UPLOAD_CHUNK_BYTES))
        await orca.plugin.request('image.chunk', { uploadId, index, data })
        onProgress?.(Math.min(1, (at + UPLOAD_CHUNK_BYTES) / bytes.length))
      }
      const { path } = await orca.plugin.request('image.commit', { uploadId }, { timeoutMs: 30000 })
      // Show it at once, without reading it back (a PDF is drawn when it is first shown).
      if (file.type !== 'application/pdf') this.images.set(path, { url: URL.createObjectURL(file), path, mime: file.type })
      return path
    } catch (err) {
      throw new ImageError(`Could not save ${name}`, codeOf(err))
    }
  }
}
