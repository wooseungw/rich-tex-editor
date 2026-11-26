// Drawn pictures, kept in memory and on disk (the user's cache folder) under a key made of
// everything that went into them, so reopening a document shows its pictures at once. An entry
// whose data files changed (a table a plot reads) counts as missing.
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { changed, type Dependency } from './compile'

export interface Picture {
  key: string
  svg: string
  width: number
  height: number
  depth: number
  fontSize: number | null
  label: string
  notes: string[]
  deps: Dependency[]
}

const MEMORY_BYTES = 48 * 1024 * 1024
const DISK_BYTES = 256 * 1024 * 1024

/** The per-user cache folder for drawn pictures; `RICH_TEX_EDITOR_CACHE` (tests) moves it, or
 *  turns the disk cache off with `off`. */
export function cacheFolder(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const override = env.RICH_TEX_EDITOR_CACHE
  if (override === 'off') return null
  if (override && path.isAbsolute(override)) return override
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir()
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'rich-tex-editor', 'pictures')
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'rich-tex-editor', 'Cache', 'pictures')
  return path.join(env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'rich-tex-editor', 'pictures')
}

export const keyOf = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

const isPicture = (value: unknown): value is Picture => {
  const p = value as Picture
  return (
    !!p &&
    typeof p.key === 'string' &&
    typeof p.svg === 'string' &&
    [p.width, p.height, p.depth].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    Array.isArray(p.notes) &&
    Array.isArray(p.deps)
  )
}

export class PictureCache {
  private readonly memory = new Map<string, Picture>()
  private bytes = 0
  private writes = 0

  /** `folder` null keeps pictures in memory only. */
  constructor(private readonly folder: string | null) {}

  private file(key: string): string | null {
    if (!this.folder || !/^[0-9a-f]{64}$/.test(key)) return null
    return path.join(this.folder, key.slice(0, 2), `${key}.json`)
  }

  private remember(picture: Picture): void {
    const old = this.memory.get(picture.key)
    if (old) {
      this.memory.delete(picture.key)
      this.bytes -= old.svg.length
    }
    this.memory.set(picture.key, picture)
    this.bytes += picture.svg.length
    for (const [key, p] of this.memory) {
      if (this.bytes <= MEMORY_BYTES) break
      this.memory.delete(key)
      this.bytes -= p.svg.length
    }
  }

  /** A picture already drawn and still current, from memory without checking its files. */
  peek(key: string): Picture | undefined {
    return this.memory.get(key)
  }

  async get(key: string): Promise<Picture | null> {
    let picture: Picture | null = this.memory.get(key) ?? null
    if (!picture) {
      const file = this.file(key)
      if (!file) return null
      const text = await fs.readFile(file, 'utf8').catch(() => null)
      if (!text) return null
      try {
        const parsed = JSON.parse(text) as unknown
        if (isPicture(parsed) && parsed.key === key) picture = parsed
      } catch {
        picture = null
      }
      if (!picture) return null
      const now = new Date()
      void fs.utimes(file, now, now).catch(() => undefined)
    }
    if (await changed(picture.deps)) {
      this.memory.delete(key)
      return null
    }
    this.remember(picture)
    return picture
  }

  async put(picture: Picture): Promise<void> {
    this.remember(picture)
    const file = this.file(picture.key)
    if (!file) return
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.${process.pid}.tmp`
      await fs.writeFile(temp, JSON.stringify(picture), { mode: 0o600 })
      await fs.rename(temp, file)
    } catch {
      return
    }
    if (++this.writes % 40 === 1) void this.prune()
  }

  /** Keeps the disk cache under its size, dropping the least recently used pictures. */
  async prune(): Promise<void> {
    if (!this.folder) return
    const entries: Array<{ file: string; size: number; time: number }> = []
    for (const sub of await fs.readdir(this.folder).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue
      const dir = path.join(this.folder, sub)
      for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
        const file = path.join(dir, name)
        const stat = await fs.stat(file).catch(() => null)
        if (!stat?.isFile()) continue
        // Leftovers of an interrupted write.
        if (name.endsWith('.tmp') && Date.now() - stat.mtimeMs > 60000) {
          await fs.rm(file, { force: true }).catch(() => undefined)
          continue
        }
        entries.push({ file, size: stat.size, time: stat.mtimeMs })
      }
    }
    let total = entries.reduce((n, e) => n + e.size, 0)
    entries.sort((a, b) => a.time - b.time)
    for (const entry of entries) {
      if (total <= DISK_BYTES) break
      await fs.rm(entry.file, { force: true }).catch(() => undefined)
      total -= entry.size
    }
  }
}

/** Runs at most `limit` jobs at once; asking again for a job that is queued or running joins it,
 *  and a job is cancelled only when everyone who asked for it gave up. */
export class JobQueue<T> {
  private running = 0
  private readonly waiting: Array<() => void> = []
  private readonly jobs = new Map<string, { promise: Promise<T>; controller: AbortController; askers: number }>()

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.jobs.size
  }

  run(key: string, task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let job = this.jobs.get(key)
    // A job everyone gave up on is not joined: it is ending with nothing to show.
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController()
      const entry: { promise: Promise<T>; controller: AbortController; askers: number } = { promise: Promise.resolve() as Promise<T>, controller, askers: 0 }
      entry.promise = this.slot().then(async (release) => {
        try {
          return await task(controller.signal)
        } finally {
          release()
          if (this.jobs.get(key) === entry) this.jobs.delete(key)
        }
      })
      job = entry
      this.jobs.set(key, job)
    }
    const current = job
    current.askers++
    if (signal) {
      const leave = () => {
        current.askers--
        if (current.askers <= 0) current.controller.abort()
      }
      if (signal.aborted) leave()
      else {
        signal.addEventListener('abort', leave, { once: true })
        void current.promise.finally(() => signal.removeEventListener('abort', leave)).catch(() => undefined)
      }
    }
    return current.promise
  }

  private slot(): Promise<() => void> {
    const release = () => {
      this.running--
      this.waiting.shift()?.()
    }
    if (this.running < this.limit) {
      this.running++
      return Promise.resolve(release)
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.running++
        resolve(release)
      })
    })
  }
}
