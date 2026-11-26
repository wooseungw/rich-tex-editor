import type { ImageStore } from './images'
import {
  INLINE_TEXT_BYTES,
  MAX_TEXT_CHARS,
  TEXT_CHUNK_CHARS,
  type FailedPicture,
  type PictureAnswer,
  type TextRef
} from './protocol'
import { sha256Hex } from './sha256'
import type { PictureRenderer, PictureSpec, PictureView, ShownPicture } from './editor/picture-spec'

/**
 * The editor's side of drawing pictures with the person's TeX. The worker compiles; this keeps
 * each drawing as a `blob:` URL, shows the last drawing of a picture while its new version is
 * drawn (so editing a TikZ picture never blanks it), waits for a pause in typing before asking,
 * and asks for at most a few pictures at a time, newest first.
 */

const encoder = new TextEncoder()
const MAX_IN_FLIGHT = 3
/** A picture being typed into is drawn this long after the last keystroke. */
const TYPING_DELAY_MS = 650
const MAX_KEPT = 300
/** Documents the person allowed LuaLaTeX for, by where they are on disk. */
const LUA_PREF = 'rich-tex-editor:lua-documents'
const MAX_LUA_DOCUMENTS = 200

function readLuaDocuments(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LUA_PREF) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

type Entry =
  | { state: 'pending' }
  | { state: 'drawn'; picture: ShownPicture }
  | { state: 'failed'; error: FailedPicture }

/** A cheap stable hash for the editor's own maps (the worker gets real SHA-256). */
function quickHash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}:${text.length}`
}

function codeOf(err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'action_failed'
  if (code !== 'action_failed') return code
  const message = err instanceof Error ? err.message : ''
  return /^([a-z_]+):/.exec(message)?.[1] ?? code
}

interface Job {
  key: string
  spec: PictureSpec
  head: string
  force: boolean
  /** When it may start (a picture being typed into waits for a pause). */
  notBefore: number
  controller: AbortController
}

export class PictureStore implements PictureRenderer {
  generation = 0
  /** Called after the generation rises. */
  onChange: (() => void) | null = null
  /** Turned off by the person, or no TeX on this computer: pictures show as code. */
  private on = true
  private unavailable: string | null = null
  private readonly entries = new Map<string, Entry>()
  /** The last drawing shown in each place, by slot. */
  private readonly lastBySlot = new Map<number, ShownPicture>()
  /** The key each slot shows now, to drop a job a newer edit replaced. */
  private readonly wantedBySlot = new Map<number, string>()
  private readonly queue: Job[] = []
  private readonly running = new Map<string, Job>()
  private readonly shaCache = new Map<string, Promise<string>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private checking = false
  private readonly luaDocuments = new Set(readLuaDocuments())

  constructor(private readonly images: ImageStore) {}

  get enabled(): boolean {
    return this.on
  }

  /** Turns drawing on or off; off shows every picture as code and asks the worker for nothing. */
  setEnabled(on: boolean): void {
    if (on === this.on) return
    this.on = on
    if (!on) {
      for (const job of this.running.values()) job.controller.abort()
      this.queue.length = 0
    }
    this.bump()
  }

  /** Why pictures are not drawn on this computer, or null. */
  get problem(): string | null {
    return this.unavailable
  }

  private bump(): void {
    this.generation++
    this.onChange?.()
  }

  private keyOf(spec: PictureSpec, head: string): string {
    return `${spec.mode}|${this.luaAllowed() ? 'L' : ''}|${quickHash(head)}|${quickHash(spec.snippet)}`
  }

  /** This document, as LuaLaTeX permissions remember it: where it is on disk. */
  private documentKey(): string | null {
    const at = this.images.locationNow()
    return at ? `${at.root}\u0000${at.dir}\u0000${at.file}` : null
  }

  private luaAllowed(): boolean {
    const key = this.documentKey()
    return key !== null && this.luaDocuments.has(key)
  }

  canAllowLua(): boolean {
    return this.documentKey() !== null
  }

  allowLua(): void {
    const key = this.documentKey()
    if (key === null || this.luaDocuments.has(key)) return
    this.luaDocuments.add(key)
    const list = [...this.luaDocuments].slice(-MAX_LUA_DOCUMENTS)
    try {
      localStorage.setItem(LUA_PREF, JSON.stringify(list))
    } catch {
      // Kept for this session only.
    }
    this.bump()
  }

  view(spec: PictureSpec, head: string): PictureView {
    if (!this.on) return { state: 'off', message: null }
    // Said once, under the document's first picture; the rest show as code (the toolbar says it too).
    if (this.unavailable) return { state: 'off', message: spec.slot === 0 ? this.unavailable : null }
    if (spec.snippet.length > MAX_TEXT_CHARS || head.length > MAX_TEXT_CHARS) {
      return { state: 'off', message: 'this picture is too large to draw here' }
    }
    const key = this.keyOf(spec, head)
    const previous = this.lastBySlot.get(spec.slot) ?? null
    const entry = this.entries.get(key)
    if (entry?.state === 'drawn') {
      this.wantedBySlot.set(spec.slot, key)
      const old = this.lastBySlot.get(spec.slot)
      this.lastBySlot.set(spec.slot, entry.picture)
      if (old && old.url !== entry.picture.url) this.release(old.url)
      return { state: 'drawn', picture: entry.picture }
    }
    if (entry?.state === 'failed') {
      this.wantedBySlot.set(spec.slot, key)
      return { state: 'failed', error: entry.error, previous }
    }
    if (!entry) this.enqueue(key, spec, head, false)
    else if (this.wantedBySlot.get(spec.slot) !== key) this.wantedBySlot.set(spec.slot, key)
    return { state: 'pending', previous }
  }

  redraw(spec: PictureSpec, head: string): void {
    const key = this.keyOf(spec, head)
    this.forget(key)
    this.enqueue(key, spec, head, true)
    this.bump()
  }

  /** Drops an entry, and its drawing unless a place still shows it. */
  private forget(key: string): void {
    const entry = this.entries.get(key)
    this.entries.delete(key)
    if (entry?.state === 'drawn') this.release(entry.picture.url)
  }

  /** Frees a drawing's `blob:` URL once nothing shows or keeps it. */
  private release(url: string): void {
    for (const p of this.lastBySlot.values()) if (p.url === url) return
    for (const e of this.entries.values()) if (e.state === 'drawn' && e.picture.url === url) return
    URL.revokeObjectURL(url)
  }

  scale(picture: ShownPicture, fontPx: number): number {
    // TeX's \normalsize (10pt…) shows at the text's size; a big point is 72.27/72 TeX points.
    const fontPt = picture.fontSize && picture.fontSize > 4 ? picture.fontSize : 10
    return (fontPx / fontPt) * (72.27 / 72)
  }

  private enqueue(key: string, spec: PictureSpec, head: string, force: boolean): void {
    const before = this.wantedBySlot.get(spec.slot)
    this.wantedBySlot.set(spec.slot, key)
    this.entries.set(key, { state: 'pending' })
    // A place that showed another version is being edited: wait for a pause in typing (a new
    // picture too, so each keystroke does not start TeX).
    const typing = before !== undefined && before !== key
    const job: Job = { key, spec, head, force, notBefore: typing ? Date.now() + TYPING_DELAY_MS : 0, controller: new AbortController() }
    // An older version of this place still waiting will never be shown: drop it.
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const queued = this.queue[i]
      if (queued.spec.slot === spec.slot && queued.key !== key) {
        this.queue.splice(i, 1)
        this.entries.delete(queued.key)
      }
    }
    for (const running of this.running.values()) {
      if (running.spec.slot === spec.slot && running.key !== key) running.controller.abort()
    }
    // Newest first: what the person is looking at or just changed.
    this.queue.unshift(job)
    this.pump()
  }

  private pump(): void {
    clearTimeout(this.timer)
    const now = Date.now()
    while (this.running.size < MAX_IN_FLIGHT) {
      const index = this.queue.findIndex((job) => job.notBefore <= now)
      if (index < 0) break
      const [job] = this.queue.splice(index, 1)
      // Superseded while it waited.
      if (this.wantedBySlot.get(job.spec.slot) !== job.key && !job.force) {
        this.entries.delete(job.key)
        continue
      }
      this.running.set(job.key, job)
      void this.run(job).finally(() => {
        this.running.delete(job.key)
        this.pump()
      })
    }
    const waiting = this.queue.filter((job) => job.notBefore > now)
    if (waiting.length && this.running.size < MAX_IN_FLIGHT) {
      const soonest = Math.min(...waiting.map((job) => job.notBefore))
      this.timer = setTimeout(() => this.pump(), Math.max(10, soonest - now))
    }
  }

  private sha(text: string): Promise<string> {
    let hit = this.shaCache.get(text)
    if (!hit) {
      hit = sha256Hex(encoder.encode(text))
      this.shaCache.set(text, hit)
      if (this.shaCache.size > 64) this.shaCache.delete(this.shaCache.keys().next().value as string)
    }
    return hit
  }

  private async ref(text: string): Promise<TextRef> {
    const sha256 = await this.sha(text)
    return encoder.encode(JSON.stringify(text)).length <= INLINE_TEXT_BYTES ? { sha256, text } : { sha256 }
  }

  /** Sends a large text in chunks the worker reassembles. */
  private async upload(text: string, signal: AbortSignal): Promise<void> {
    const sha256 = await this.sha(text)
    const count = Math.max(1, Math.ceil(text.length / TEXT_CHUNK_CHARS))
    for (let index = 0; index < count; index++) {
      const data = text.slice(index * TEXT_CHUNK_CHARS, (index + 1) * TEXT_CHUNK_CHARS)
      const { complete } = await orca.plugin.request('text.put', { sha256, index, count, data }, { signal, timeoutMs: 15000 })
      if (complete) return
    }
  }

  private async run(job: Job): Promise<void> {
    const { signal } = job.controller
    let answer: PictureAnswer
    try {
      const location = await this.images.locate()
      const graphicsPath = this.images.graphicsPathNow()
      const preamble = await this.ref(job.head)
      const snippet = await this.ref(job.spec.snippet)
      const input = { location, preamble, snippet, mode: job.spec.mode, graphicsPath, force: job.force, allowLua: this.luaAllowed() }
      answer = await orca.plugin.request('picture.render', input, { signal, timeoutMs: 110000 })
      if (answer.status === 'missing') {
        if (answer.missing.includes(preamble.sha256)) await this.upload(job.head, signal)
        if (answer.missing.includes(snippet.sha256)) await this.upload(job.spec.snippet, signal)
        answer = await orca.plugin.request('picture.render', input, { signal, timeoutMs: 110000 })
      }
    } catch (err) {
      if (signal.aborted) {
        if (this.entries.get(job.key)?.state === 'pending') this.entries.delete(job.key)
        return
      }
      const code = codeOf(err)
      if (code === 'unavailable' || code === 'unknown_method') {
        // An older worker, or none: pictures stay code.
        this.unavailable = 'the plugin worker is not running'
        this.bump()
        return
      }
      if (code === 'timeout') {
        // The worker keeps drawing and caches the result; ask again shortly.
        this.entries.delete(job.key)
        setTimeout(() => this.bump(), 2000)
        return
      }
      this.entries.set(job.key, {
        state: 'failed',
        error: { status: 'failed', key: job.key, reason: 'error', message: err instanceof Error ? err.message : String(err), where: 'other', line: null, file: null, context: '', label: '', notes: [], wantsLua: false }
      })
      this.bump()
      return
    }
    if (answer.status === 'unavailable') {
      this.unavailable = answer.message
      this.entries.delete(job.key)
      this.bump()
      return
    }
    if (answer.status === 'missing') {
      this.entries.delete(job.key)
      return
    }
    if (answer.status === 'failed') {
      if (answer.reason === 'cancelled') {
        this.entries.delete(job.key)
        return
      }
      if (answer.reason === 'busy') {
        // Not drawn yet, not failed: asked again in a moment.
        this.entries.delete(job.key)
        setTimeout(() => this.bump(), 3000)
        return
      }
      this.entries.set(job.key, { state: 'failed', error: answer })
      this.bump()
      return
    }
    let svg = answer.svg
    if (svg === null) {
      const parts: string[] = []
      let offset: number | null = 0
      while (offset !== null) {
        const chunk: { found: boolean; data: string; next: number | null } | null = await orca.plugin
          .request('picture.read', { key: answer.key, offset }, { signal, timeoutMs: 30000 })
          .catch(() => null)
        if (!chunk?.found) {
          this.entries.delete(job.key)
          return
        }
        parts.push(chunk.data)
        offset = chunk.next
      }
      svg = parts.join('')
    }
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const { status: _status, svg: _svg, ...rest } = answer
    const picture: ShownPicture = { ...rest, url }
    // The worker key, not ours: the same drawing for the same input everywhere.
    this.entries.set(job.key, { state: 'drawn', picture })
    this.trim()
    this.bump()
  }

  /** Forgets the oldest drawings beyond the limit, keeping those any place shows. */
  private trim(): void {
    if (this.entries.size <= MAX_KEPT) return
    const shown = new Set<string>([...this.lastBySlot.values()].map((p) => p.url))
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_KEPT) break
      if (entry.state === 'pending') continue
      if (entry.state === 'drawn' && shown.has(entry.picture.url)) continue
      this.entries.delete(key)
      if (entry.state === 'drawn') URL.revokeObjectURL(entry.picture.url)
    }
  }

  /** Redraws pictures whose data files changed on disk (a table a plot reads was rewritten). */
  async revalidate(): Promise<void> {
    if (!this.on || this.unavailable || this.checking) return
    const drawn = [...this.entries.entries()].filter(([, e]) => e.state === 'drawn') as Array<[string, { state: 'drawn'; picture: ShownPicture }]>
    if (drawn.length === 0) return
    this.checking = true
    try {
      const byWorkerKey = new Map(drawn.map(([key, e]) => [e.picture.key, key]))
      const { stale } = await orca.plugin.request('picture.check', { keys: [...byWorkerKey.keys()].slice(0, 256) }, { timeoutMs: 15000 })
      if (stale.length === 0) return
      for (const workerKey of stale) {
        const key = byWorkerKey.get(workerKey)
        if (key) this.forget(key)
      }
      this.bump()
    } catch {
      // Checked again later.
    } finally {
      this.checking = false
    }
  }
}
