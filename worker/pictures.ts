// The worker's side of drawing pictures with the person's TeX (src/protocol.ts: tex.tools,
// text.put, picture.render, picture.read, picture.check). Everything here is reached from a frame
// that renders untrusted .tex text: inputs are validated, TeX runs with no shell escape, and only
// folders inside the document's workspace are given to it.
import type { OrcaWorkerApi } from 'orca/worker'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  MAX_TEXT_CHARS,
  PICTURE_CHUNK_CHARS,
  TEXT_CHUNK_CHARS,
  type PictureAnswer,
  type SnippetMode,
  type TexLocation,
  type TextRef
} from '../src/protocol'
import { fail } from './files'
import { cacheFolder, JobQueue, keyOf, PictureCache, type Picture } from './tex/cache'
import { compilePicture, literalFolder, type CompileResult } from './tex/compile'
import { chooseEngine, documentClass, magicEngine, type EngineChoice } from './tex/engine'
import { findLatexmkrc, type RootFinder } from './tex/root'
import { pdfConverter } from './tex/toolchain'
import type { ToolchainCache } from './tex/tools'

/** Bumped whenever the way pictures are drawn changes, so older cached drawings are not reused. */
const PICTURE_VERSION = 1
const MODES: readonly SnippetMode[] = ['block', 'inline', 'display-math', 'inline-math']
const TEXT_STORE_CHARS = 32 * 1024 * 1024
const MAX_PARTIAL_TEXTS = 16
const MAX_GRAPHICS_PATHS = 32
/** How long a failure is remembered (the same broken picture is not compiled again meanwhile). */
const FAILURE_TTL_MS = 10 * 60 * 1000
/** A whole drawing, queue wait included, ends before the editor's request (110 s) gives up. */
const JOB_DEADLINE_MS = 95 * 1000

export interface Where {
  realRoot: string
  texDir: string
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep)

/**
 * Registers the picture handlers. `place` checks a frame's location the way image requests do,
 * answering the workspace folder and the .tex folder, or null when there is none.
 */
export function registerPictures(
  orca: OrcaWorkerApi,
  place: (location: TexLocation | null) => Promise<Where | null>,
  roots: RootFinder,
  toolchains: ToolchainCache
): void {
  const texts = new Map<string, string>()
  let textChars = 0
  const partial = new Map<string, { count: number; parts: Array<string | undefined>; received: number; touched: number }>()
  const cache = new PictureCache(cacheFolder())
  const failures = new Map<string, { at: number; answer: PictureAnswer; deps: CompileResult['deps'] }>()
  const queue = new JobQueue<CompileResult>(Math.max(1, Math.min(3, Math.floor(os.cpus().length / 2))))
  void cache.prune()

  const toolchain = (refresh = false) => toolchains.get(refresh)

  function remember(text: string): string {
    const key = sha256(text)
    if (!texts.has(key)) {
      texts.set(key, text)
      textChars += text.length
      for (const [k, t] of texts) {
        if (textChars <= TEXT_STORE_CHARS) break
        texts.delete(k)
        textChars -= t.length
      }
    }
    return key
  }

  /** The text a reference names, or null when the frame must upload it first. */
  function resolve(ref: unknown, what: string): string | null {
    if (typeof ref !== 'object' || ref === null) fail('invalid_params', `${what} must be { sha256, text? }`)
    const { sha256: hash, text } = ref as TextRef
    if (!isSha(hash)) fail('invalid_params', `${what}.sha256 must be 64 lowercase hex digits`)
    if (text !== undefined) {
      if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS) fail('invalid_params', `${what}.text must be a string of at most ${MAX_TEXT_CHARS} characters`)
      if (sha256(text) !== hash) fail('invalid_params', `${what}.text does not match its sha256`)
      remember(text)
      return text
    }
    const known = texts.get(hash)
    if (known !== undefined) {
      // Recently used: move to the end.
      texts.delete(hash)
      texts.set(hash, known)
      return known
    }
    return null
  }

  orca.panels.handle('tex.tools', async (input) => {
    const refresh = !!(input && typeof input === 'object' && (input as { refresh?: unknown }).refresh === true)
    const t = await toolchain(refresh)
    const engines = (['latex', 'xelatex', 'lualatex', 'platex', 'uplatex'] as const).filter((e) => t.bin[e]).map((e) => (e === 'latex' ? 'pdflatex' : e))
    const converter = pdfConverter(t)?.kind ?? null
    const found = engines.length > 0 && (!!t.bin.dvisvgm || !!converter)
    const message = engines.length === 0 ? 'No TeX installation was found' : !found ? 'dvisvgm was not found' : null
    return { found, distribution: t.distribution, engines, converter, postscript: t.postscript, message }
  })

  orca.panels.handle('text.put', async (input) => {
    if (typeof input !== 'object' || input === null) fail('invalid_params', 'expected an object')
    const { sha256: hash, index, count, data } = input as { sha256?: unknown; index?: unknown; count?: unknown; data?: unknown }
    if (!isSha(hash)) fail('invalid_params', 'sha256 must be 64 lowercase hex digits')
    if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) * TEXT_CHUNK_CHARS > MAX_TEXT_CHARS + TEXT_CHUNK_CHARS) {
      fail('invalid_params', 'count is out of range')
    }
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= (count as number)) fail('invalid_params', 'index is out of range')
    if (typeof data !== 'string' || data.length > TEXT_CHUNK_CHARS) fail('invalid_params', `data must be at most ${TEXT_CHUNK_CHARS} characters`)
    if (texts.has(hash)) return { complete: true }
    const now = Date.now()
    for (const [k, p] of partial) if (now - p.touched > 120000) partial.delete(k)
    let entry = partial.get(hash)
    if (!entry || entry.count !== count) {
      if (!entry && partial.size >= MAX_PARTIAL_TEXTS) fail('rate_limited', 'too many texts in progress')
      entry = { count: count as number, parts: new Array<string | undefined>(count as number), received: 0, touched: now }
      partial.set(hash, entry)
    }
    entry.touched = now
    if (entry.parts[index as number] === undefined) entry.received++
    entry.parts[index as number] = data
    if (entry.received < entry.count) return { complete: false }
    partial.delete(hash)
    const text = entry.parts.join('')
    if (sha256(text) !== hash) fail('invalid_params', 'the chunks do not match their sha256')
    remember(text)
    return { complete: true }
  })


  orca.panels.handle('picture.render', async (input, context): Promise<PictureAnswer> => {
    if (typeof input !== 'object' || input === null) fail('invalid_params', 'expected an object')
    const { location, preamble: preambleRef, snippet: snippetRef, mode, graphicsPath = [], force, allowLua } = input as {
      location?: TexLocation | null
      preamble?: unknown
      snippet?: unknown
      mode?: unknown
      graphicsPath?: unknown
      force?: unknown
      allowLua?: unknown
    }
    if (location && (typeof location.file !== 'string' || !/^[^/\\\0]+$/.test(location.file) || location.file === '..')) {
      fail('invalid_location', 'file must be a file name')
    }
    if (!MODES.includes(mode as SnippetMode)) fail('invalid_params', `mode must be one of ${MODES.join(', ')}`)
    if (!Array.isArray(graphicsPath)) fail('invalid_params', 'graphicsPath must be a list')
    const head = resolve(preambleRef, 'preamble')
    const snippet = resolve(snippetRef, 'snippet')
    const missing = [head === null ? (preambleRef as TextRef).sha256 : null, snippet === null ? (snippetRef as TextRef).sha256 : null].filter(
      (x): x is string => x !== null
    )
    if (missing.length || head === null || snippet === null) return { status: 'missing' as const, missing }
    if (!snippet.trim()) fail('invalid_params', 'snippet is empty')

    // Where the document is: its folder is searched for \input files, data tables and styles. A
    // document not found on disk (unsaved, or on an SSH host) is drawn from its text alone.
    let where: Where | null = null
    if (location) {
      try {
        where = await place(location)
      } catch {
        where = null
      }
    }
    const texInputs: string[] = []
    const cls = documentClass(head)
    let preamble = cls && cls !== 'subfiles' ? head : ''
    let engineText = head
    let latexmkrc: string | null = null
    if (where && location) {
      const realDir = await fs.realpath(where.texDir).catch(() => null)
      if (realDir && inside(where.realRoot, realDir)) {
        if (!preamble) {
          const root = await roots.find(where.realRoot, path.join(realDir, location.file), head)
          if (root) {
            preamble = root.preamble
            engineText = magicEngine(head) ? head : root.text
            texInputs.push(path.dirname(root.file))
          }
        }
        if (!texInputs.includes(realDir)) texInputs.push(realDir)
        latexmkrc = await findLatexmkrc(where.realRoot, texInputs[0])
        // Kpathsea reads `:`, `~`, `$`… in a search path: such folders are left out (H1b).
        for (const folder of (graphicsPath as unknown[]).slice(0, MAX_GRAPHICS_PATHS)) {
          if (typeof folder !== 'string' || folder.includes('\0') || folder === '') continue
          const abs = path.resolve(texInputs[0], folder)
          const real = await fs.realpath(abs).catch(() => null)
          if (real && inside(where.realRoot, real) && !texInputs.includes(real)) texInputs.push(real)
        }
      }
    }

    for (let i = texInputs.length - 1; i >= 0; i--) if (!literalFolder(texInputs[i])) texInputs.splice(i, 1)
    const tools = await toolchain()
    let engine: EngineChoice = chooseEngine({ text: engineText, preamble, latexmkrc })
    // LuaLaTeX runs Lua from the document, and Lua can read any file the person can: only with
    // their say-so for this document. XeLaTeX reads the same fontspec preambles.
    const wantsLua = engine.engine === 'lualatex' && allowLua !== true
    if (wantsLua) engine = { engine: 'xelatex', reason: 'LuaLaTeX not allowed' }
    const key = keyOf([PICTURE_VERSION, tools.distribution, Object.keys(tools.bin).sort(), engine.engine, mode, preamble, snippet, texInputs])
    const deadline = Date.now() + JOB_DEADLINE_MS

    if (force !== true) {
      const cached = await cache.get(key)
      if (cached) return drawnAnswer(cached, wantsLua)
      const failed = failures.get(key)
      if (failed && Date.now() - failed.at < FAILURE_TTL_MS && !(await changedDeps(failed.deps))) return failed.answer
    }
    failures.delete(key)

    const result = await queue.run(
      key,
      (signal) => compilePicture({ preamble, snippet, mode: mode as SnippetMode, engine, texInputs, tools, signal, deadline }),
      context?.signal
    )
    if (result.ok) {
      const picture: Picture = {
        key,
        svg: result.drawn.svg,
        width: result.drawn.width,
        height: result.drawn.height,
        depth: result.drawn.depth,
        fontSize: result.fontSize,
        // `XeLaTeX (% !TEX program)`: which engine, and why that one.
        label: engine.reason !== 'default' ? `${result.label} (${engine.reason})` : result.label,
        notes: result.notes,
        deps: result.deps
      }
      await cache.put(picture)
      return drawnAnswer(picture, wantsLua)
    }
    if (result.reason === 'unavailable') return { status: 'unavailable' as const, message: result.message }
    const answer: PictureAnswer = {
      status: 'failed',
      key,
      reason: result.reason,
      message: result.message,
      where: result.where,
      line: result.line,
      file: result.file,
      context: result.context,
      label: result.label,
      notes: result.notes,
      wantsLua
    }
    // A timeout is remembered too: asking again would run the same long compile ("Try again" forces).
    if (result.reason === 'error' || result.reason === 'timeout') {
      failures.set(key, { at: Date.now(), answer, deps: result.deps })
      if (failures.size > 256) failures.delete(failures.keys().next().value as string)
    }
    return answer
  })

  async function changedDeps(deps: CompileResult['deps']): Promise<boolean> {
    for (const dep of deps) {
      const stat = await fs.stat(dep.file).catch(() => null)
      if (!stat || stat.size !== dep.size || stat.mtimeMs !== dep.mtimeMs) return true
    }
    return false
  }

  function drawnAnswer(p: Picture, wantsLua: boolean): PictureAnswer {
    return {
      status: 'drawn',
      key: p.key,
      svg: p.svg.length <= PICTURE_CHUNK_CHARS ? p.svg : null,
      length: p.svg.length,
      width: p.width,
      height: p.height,
      depth: p.depth,
      fontSize: p.fontSize,
      label: p.label,
      notes: p.notes,
      wantsLua
    }
  }

  orca.panels.handle('picture.read', async (input) => {
    if (typeof input !== 'object' || input === null) fail('invalid_params', 'expected an object')
    const { key, offset } = input as { key?: unknown; offset?: unknown }
    if (!isSha(key)) fail('invalid_params', 'key must be 64 lowercase hex digits')
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) fail('invalid_params', 'offset must be a position')
    const picture = cache.peek(key) ?? (await cache.get(key))
    if (!picture) return { found: false, data: '', next: null }
    const start = offset as number
    const end = Math.min(picture.svg.length, start + PICTURE_CHUNK_CHARS)
    return { found: true, data: picture.svg.slice(start, end), next: end < picture.svg.length ? end : null }
  })

  orca.panels.handle('picture.check', async (input) => {
    if (typeof input !== 'object' || input === null) fail('invalid_params', 'expected an object')
    const { keys } = input as { keys?: unknown }
    if (!Array.isArray(keys) || keys.length > 256) fail('invalid_params', 'keys must be a list of at most 256')
    const stale: string[] = []
    for (const key of keys) {
      if (!isSha(key)) continue
      const picture = cache.peek(key)
      if (picture && picture.deps.length && (await changedDeps(picture.deps))) stale.push(key)
    }
    return { stale }
  })
}
