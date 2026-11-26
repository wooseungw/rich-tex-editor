// Compiling one picture with the person's TeX, in a fresh temporary folder, safely: no shell
// escape, no writing outside that folder, no reading dot-files, killed after a time limit. When
// the document's preamble is what fails (a class or package not installed on this machine, as
// with a document on an SSH host), the failing part is set aside and the picture tried again.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  assemble,
  defaultPreamble,
  NO_EDITS,
  preparePreamble,
  reducedPreamble,
  statementAt,
  type Assembly,
  type PreambleEdits,
  type SnippetMode
} from './document'
import { loadedPackages, type EngineChoice } from './engine'
import { parseLog, recordedInputs, type TexError } from './log'
import { finishSvg, type Drawn } from './svg'
import { capture, pdfConverter, plansFor, type Plan, type Toolchain } from './toolchain'

/** A file the picture read (a data table, an \input), to redraw it when the file changes. */
export interface Dependency {
  file: string
  size: number
  mtimeMs: number
}

export interface CompileInput {
  /** The document's preamble, or the root document's for a section file; '' when unknown. */
  preamble: string
  snippet: string
  mode: SnippetMode
  engine: EngineChoice
  /** Folders TeX looks in first: the document's folder (and the root's), \graphicspath. */
  texInputs: string[]
  tools: Toolchain
  signal?: AbortSignal
  /** Per program run (default 25 s). */
  timeoutMs?: number
  /** When the whole drawing must be done (Date.now() scale), attempts and conversions included:
   *  the editor's request gives up a little after it. */
  deadline?: number
}

export type CompileResult =
  | {
      ok: true
      drawn: Drawn
      /** `XeLaTeX`, `pdfLaTeX`… and what was set aside to draw it. */
      label: string
      notes: string[]
      deps: Dependency[]
      fontSize: number | null
    }
  | {
      ok: false
      /** `busy`: the deadline passed before TeX could run at all (other pictures went first). */
      reason: 'error' | 'timeout' | 'cancelled' | 'unavailable' | 'busy'
      message: string
      /** Where the error is: in the picture (with `line`, 1-based in the picture), the preamble,
       *  another file, or none of those. */
      where: 'picture' | 'preamble' | 'file' | 'other'
      line: number | null
      file: string | null
      context: string
      label: string
      notes: string[]
      deps: Dependency[]
    }

const MAX_ATTEMPTS = 8
/** Preamble statements set aside before the reduced preamble is tried instead. */
const MAX_PREAMBLE_DROPS = 3
const MAX_SVG_BYTES = 8 * 1024 * 1024
const MAX_LOG_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 25000

/** The most a run may write into its folder (a `\write` loop would otherwise fill the disk). */
const MAX_RUN_BYTES = 64 * 1024 * 1024

interface Run {
  code: number | null
  timedOut: boolean
  cancelled: boolean
  /** Killed for writing more than MAX_RUN_BYTES. */
  tooLarge: boolean
}

/** The size of the files in a folder (the run's own: flat, a few files). */
async function folderBytes(dir: string): Promise<number> {
  let total = 0
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const stat = await fs.stat(path.join(dir, name)).catch(() => null)
    if (stat?.isFile()) total += stat.size
  }
  return total
}

/** Runs a program in `cwd`, killing it (and anything it started) on timeout, abort, or when it
 *  writes too much. */
function run(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<Run> {
  return new Promise((resolve) => {
    if (signal?.aborted || timeoutMs <= 0) return resolve({ code: null, timedOut: timeoutMs <= 0, cancelled: !!signal?.aborted, tooLarge: false })
    const posix = process.platform !== 'win32'
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'ignore', 'ignore'], detached: posix, windowsHide: true })
    let timedOut = false
    let cancelled = false
    let tooLarge = false
    const kill = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, 'SIGKILL')
        else if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    let measuring = false
    const watch = setInterval(() => {
      if (measuring) return
      measuring = true
      void folderBytes(cwd).then((bytes) => {
        measuring = false
        if (bytes > MAX_RUN_BYTES && !tooLarge) {
          tooLarge = true
          kill()
        }
      })
    }, 250)
    const onAbort = () => {
      cancelled = true
      kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = (code: number | null) => {
      clearTimeout(timer)
      clearInterval(watch)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, timedOut, cancelled, tooLarge })
    }
    child.on('error', () => done(-1))
    child.on('close', (code) => done(code))
  })
}

const readText = async (file: string, max: number) => {
  const handle = await fs.open(file, 'r').catch(() => null)
  if (!handle) return null
  try {
    const stat = await handle.stat()
    const buffer = Buffer.alloc(Math.min(stat.size, max))
    await handle.read(buffer, 0, buffer.length, 0)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Where an error TeX reported sits in the assembled file. */
export function placeError(error: TexError, assembly: Assembly, afterBegin: boolean):
  | { where: 'picture'; line: number }
  | { where: 'preamble'; line: number }
  | { where: 'file' }
  | { where: 'other' } {
  const ours = error.file === null || error.file === 'snippet.tex'
  if (!ours) return { where: 'file' }
  const line = error.line
  if (line === null) return afterBegin ? { where: 'picture', line: 1 } : { where: 'other' }
  const { snippetFirst, snippetCount, preambleFirst, preambleCount } = assembly
  if (line >= snippetFirst && line < snippetFirst + snippetCount) return { where: 'picture', line: line - snippetFirst + 1 }
  // The lines that close the picture: an unclosed environment shows up there.
  if (line >= snippetFirst + snippetCount && line <= snippetFirst + snippetCount + 2) return { where: 'picture', line: snippetCount }
  if (line >= preambleFirst && line < preambleFirst + preambleCount) return { where: 'preamble', line: line - preambleFirst + 1 }
  return { where: 'other' }
}

/** Which packages kpsewhich finds, of those named. */
async function installedPackages(tools: Toolchain, names: string[], env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const found = new Set<string>()
  if (!tools.bin.kpsewhich || names.length === 0) return found
  const out = (await capture(tools.bin.kpsewhich, names.map((n) => `${n}.sty`), 8000, env)) ?? ''
  for (const line of out.split(/\r?\n/)) {
    const m = /([^/\\]+)\.sty$/.exec(line.trim())
    if (m) found.add(m[1])
  }
  return found
}

/**
 * A folder kpathsea takes literally. Its search paths split at `:`/`;` and expand `$VAR` and
 * `{a,b}` anywhere (`~` and `!!` only at the start of an entry, which an absolute path never
 * has: iCloud's `com~apple~CloudDocs` is fine), so a folder named `x:~` would add the home folder.
 */
export const literalFolder = (dir: string) => !/[:;${}]/.test(process.platform === 'win32' ? dir.slice(2) : dir) && !dir.includes('\0')

function texEnv(tools: Toolchain, program: string, cwd: string, texInputs: string[], lua: boolean): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':'
  texInputs = texInputs.filter(literalFolder)
  const base = process.env
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA']) {
    if (base[key] !== undefined) env[key] = base[key]
  }
  env.PATH = [path.dirname(program), base.PATH ?? ''].filter(Boolean).join(sep)
  // A trailing separator keeps the distribution's own search path after these folders.
  env.TEXINPUTS = texInputs.length ? `${texInputs.join(sep)}${sep}` : ''
  if (!env.TEXINPUTS) delete env.TEXINPUTS
  // Paranoid both ways: no dot-files, no absolute paths, no `..`. The document's folders are
  // searched through TEXINPUTS, so its own files are still found. LuaTeX checks the absolute
  // paths kpathsea finds against it too and could not load its own classes; its Lua can read
  // any file anyway, which is why it runs only for documents the person allowed.
  env.openout_any = 'p'
  env.openin_any = lua ? 'r' : 'p'
  env.shell_escape = 'f'
  env.max_print_line = '1000'
  env.error_line = '254'
  env.half_error_line = '238'
  env.TEXMFOUTPUT = cwd
  return env
}

/** Converts the engine's output to SVG; null with a reason when it cannot. */
async function convert(plan: Plan, tools: Toolchain, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal | undefined, depthPt: number | null, postscript: boolean): Promise<Drawn | string> {
  if (plan.route === 'pdf') {
    const converter = pdfConverter(tools)
    if (!converter) return 'no PDF to SVG converter (pdftocairo or mutool) was found'
    const args = converter.kind === 'pdftocairo' ? ['-svg', '-f', '1', '-l', '1', 'snippet.pdf', 'rte.svg'] : ['draw', '-F', 'svg', '-o', 'rte.svg', 'snippet.pdf', '1']
    const done = await run(converter.program, args, cwd, env, timeoutMs, signal)
    if (done.cancelled) return 'cancelled'
    if (done.timedOut) return `${converter.kind} took too long`
    if (done.tooLarge) return 'the drawing is larger than 64 MB'
    const svg = await readText(path.join(cwd, 'rte.svg'), MAX_SVG_BYTES + 1)
    if (!svg) return `${converter.kind} wrote no SVG`
    if (svg.length > MAX_SVG_BYTES) return 'the drawing is larger than 8 MB'
    return finishSvg(svg, depthPt) ?? `${converter.kind} wrote an SVG without a size`
  }
  const input = plan.route === 'xdv' ? 'snippet.xdv' : 'snippet.dvi'
  // Only the specials drawings use (dvisvgm's own, colour, page size); PostScript goes to
  // Ghostscript only for PSTricks pictures, which need it.
  const off = postscript ? 'pdf,html,em,tpic' : 'ps,pdf,html,em,tpic'
  const args = ['--no-fonts', '--page=1-', '--output=rte-%p.svg', `--no-specials=${off}`, input]
  const done = await run(tools.bin.dvisvgm as string, args, cwd, env, timeoutMs, signal)
  if (done.cancelled) return 'cancelled'
  if (done.timedOut) return 'dvisvgm took too long'
  if (done.tooLarge) return 'the drawing is larger than 64 MB'
  const pages = (await fs.readdir(cwd)).filter((name) => /^rte-\d+\.svg$/.test(name)).sort((a, b) => Number(a.slice(4, -4)) - Number(b.slice(4, -4)))
  for (const page of pages) {
    const svg = await readText(path.join(cwd, page), MAX_SVG_BYTES + 1)
    if (!svg) continue
    if (svg.length > MAX_SVG_BYTES) return 'the drawing is larger than 8 MB'
    // The picture's page is the one with the baseline mark (a package may ship pages of its own).
    if (!svg.includes('rte-base')) continue
    return finishSvg(svg, depthPt) ?? 'dvisvgm wrote an SVG without a size'
  }
  return 'dvisvgm wrote no picture'
}

/** Files under the document's folders that TeX read, with their size and time now. */
async function dependencies(cwd: string, texInputs: string[]): Promise<Dependency[]> {
  const fls = await readText(path.join(cwd, 'snippet.fls'), MAX_LOG_BYTES)
  if (!fls) return []
  const roots = texInputs.map((dir) => path.resolve(dir) + path.sep)
  const out: Dependency[] = []
  for (const file of recordedInputs(fls)) {
    const abs = path.resolve(cwd, file)
    if (!roots.some((root) => abs.startsWith(root))) continue
    const stat = await fs.stat(abs).catch(() => null)
    if (stat?.isFile()) out.push({ file: abs, size: stat.size, mtimeMs: stat.mtimeMs })
    if (out.length >= 64) break
  }
  return out
}

/** Whether any dependency changed (or went away) since it was recorded. */
export async function changed(deps: Dependency[]): Promise<boolean> {
  for (const dep of deps) {
    const stat = await fs.stat(dep.file).catch(() => null)
    if (!stat || stat.size !== dep.size || stat.mtimeMs !== dep.mtimeMs) return true
  }
  return false
}

/** Errors that mean the route, not the document, is the problem. */
const ROUTE_LIMITS = /Cannot run pipe command|not in PDF mode|pdfTeX error|requires? (?:pdf|PDF)|Cannot determine size of graphic|Unknown graphics extension/

const needsPostScript = (snippet: string) => /\\begin\s*\{pspicture\*?\}|\\ps[a-z]+\b|\\rput\b|\\uput\b/.test(snippet)

/** Draws one picture. Never throws for TeX's sake: every failure comes back as a result. */
export async function compilePicture(input: CompileInput): Promise<CompileResult> {
  const { tools, signal } = input
  const deadline = input.deadline ?? Number.POSITIVE_INFINITY
  /** This run's time: its own limit, or what is left before the deadline. */
  const budget = () => Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, deadline - Date.now())
  const notes: string[] = []
  let lastDeps: Dependency[] = []
  let plans = plansFor(input.engine.engine, tools, needsPostScript(input.snippet))
  const fail = (reason: 'error' | 'timeout' | 'cancelled' | 'unavailable' | 'busy', message: string, extra: Partial<Extract<CompileResult, { ok: false }>> = {}): CompileResult => ({
    ok: false,
    reason,
    message,
    where: 'other',
    line: null,
    file: null,
    context: '',
    label: plans[0]?.label ?? input.engine.engine,
    notes,
    deps: [],
    ...extra
  })
  // MiKTeX does not read kpathsea's openin_any/openout_any/shell_escape, the limits every run
  // here depends on; until its own are set and checked, it is not run.
  if (tools.distribution.startsWith('MiKTeX')) {
    return fail('unavailable', 'Drawing with MiKTeX is not supported yet (its file-access limits are not set up); TeX Live works')
  }
  if (plans.length === 0) {
    if (!tools.bin.latex && !tools.bin.xelatex && !tools.bin.lualatex) return fail('unavailable', 'No TeX installation was found on this computer')
    if (!tools.bin.dvisvgm && !pdfConverter(tools)) return fail('unavailable', 'dvisvgm was not found (it comes with TeX Live and MiKTeX)')
    if (needsPostScript(input.snippet)) return fail('unavailable', 'PSTricks pictures need Ghostscript for dvisvgm, or pdftocairo with XeLaTeX')
    return fail('unavailable', `${input.engine.engine} cannot be drawn here: install pdftocairo (poppler) or mutool`)
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rich-tex-picture-'))
  try {
    let planIndex = 0
    let preamble = input.preamble.trim() ? input.preamble : defaultPreamble(input.snippet)
    if (!input.preamble.trim()) notes.push('no preamble: drew with TikZ and common libraries')
    let reduced = false
    let drops = 0
    let edits: PreambleEdits = { ...NO_EDITS, dropLines: [], dropPackages: [] }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (budget() <= 0) return attempt === 0 ? fail('busy', 'waited too long for other pictures') : fail('timeout', 'drawing took too long', { deps: lastDeps })
      const plan = plans[planIndex]
      const env = texEnv(tools, plan.program, cwd, input.texInputs, plan.args.includes('--nosocket'))
      const assembly = assemble({ preamble: preparePreamble(preamble, plan.route, edits), snippet: input.snippet, mode: input.mode, route: plan.route })
      for (const name of await fs.readdir(cwd)) if (name.startsWith('snippet.') || name.startsWith('rte')) await fs.rm(path.join(cwd, name), { force: true })
      await fs.writeFile(path.join(cwd, 'snippet.tex'), assembly.source)
      const limit = budget()
      const done = await run(plan.program, [...plan.args, 'snippet.tex'], cwd, env, limit, signal)
      if (done.cancelled) return fail('cancelled', 'cancelled')
      if (done.timedOut) return fail('timeout', `${plan.label} took longer than ${Math.max(1, Math.round(limit / 1000))} s`, { label: plan.label, deps: lastDeps })
      if (done.tooLarge) return fail('error', `the picture wrote more than ${MAX_RUN_BYTES / 1024 / 1024} MB of files`, { label: plan.label, deps: lastDeps })
      const log = (await readText(path.join(cwd, 'snippet.log'), MAX_LOG_BYTES)) ?? ''
      const summary = parseLog(log)
      const outputName = plan.route === 'pdf' ? 'snippet.pdf' : plan.route === 'xdv' ? 'snippet.xdv' : 'snippet.dvi'
      const produced = await fs.stat(path.join(cwd, outputName)).then((s) => s.size > 0, () => false)
      const deps = await dependencies(cwd, input.texInputs)
      lastDeps = deps
      if (!summary.error && produced && done.code === 0) {
        const box = summary.boxes[0]
        const drawn = await convert(plan, tools, cwd, env, budget(), signal, box ? box.depth : null, needsPostScript(input.snippet))
        if (typeof drawn !== 'string') {
          return { ok: true, drawn, label: plan.label, notes, deps, fontSize: summary.fontSize }
        }
        if (drawn === 'cancelled') return fail('cancelled', 'cancelled')
        if (planIndex + 1 < plans.length) {
          planIndex++
          continue
        }
        return fail('error', drawn, { label: plan.label, deps })
      }

      const error: TexError = summary.error ?? {
        message: log ? 'TeX stopped without a picture' : `${plan.label} did not run`,
        file: null,
        line: null,
        context: '',
        missing: null,
        afterBegin: summary.fontSize !== null
      }
      const afterBegin = error.afterBegin
      const place = placeError(error, assembly, afterBegin)

      // What this way of compiling cannot do, wherever it shows: a bitmap's size in DVI mode needs
      // a pipe (shell escape, which stays off), a PDF-only primitive in DVI mode. The next way is
      // tried (pdfLaTeX writing PDF reads PNG and JPEG itself).
      if (planIndex + 1 < plans.length && ROUTE_LIMITS.test(error.message)) {
        planIndex++
        continue
      }

      // A class or package this machine does not have: draw without it.
      if (error.missing && !afterBegin) {
        const missing = error.missing
        if (/\.cls$/.test(missing) && !edits.articleClass) {
          edits = { ...edits, articleClass: true }
          notes.push(`class ${missing.replace(/\.cls$/, '')} is not installed here: drew with article`)
          continue
        }
        const name = missing.replace(/\.sty$/, '')
        if (/\.sty$|^[^.]+$/.test(missing) && loadedPackages(preamble).includes(name) && !edits.dropPackages.includes(name)) {
          edits = { ...edits, dropPackages: [...edits.dropPackages, name] }
          notes.push(`package ${name} is not installed here`)
          continue
        }
      }
      if (place.where === 'picture' || (place.where === 'file' && afterBegin) || (error.missing && afterBegin)) {
        return fail('error', error.message, {
          where: place.where === 'picture' ? 'picture' : 'file',
          line: place.where === 'picture' ? place.line : error.line,
          file: place.where === 'picture' ? null : (error.missing ?? error.file),
          context: error.context,
          label: plan.label,
          deps
        })
      }
      if (place.where === 'preamble' && !reduced && drops < MAX_PREAMBLE_DROPS) {
        drops++
        const statement = statementAt(preamble, place.line)
        const lines = statement ? Array.from({ length: statement.last - statement.first + 1 }, (_, i) => statement.first + i) : [place.line]
        if (!lines.every((n) => edits.dropLines.includes(n))) {
          edits = { ...edits, dropLines: [...edits.dropLines, ...lines] }
          notes.push(`skipped preamble line ${place.line}: ${error.message.slice(0, 120)}`)
          continue
        }
      }
      // Another engine may read this preamble (LuaLaTeX, kept from writing its font cache, fails
      // where XeLaTeX draws the same fontspec preamble): it goes before setting the preamble aside.
      const nextProgram = plans.slice(planIndex + 1).findIndex((p) => p.program !== plan.program)
      if (!reduced && nextProgram >= 0) {
        planIndex += nextProgram + 1
        continue
      }
      // Last: the reduced preamble (article, the picture's packages, the document's macros).
      if (!reduced) {
        reduced = true
        const candidates = loadedPackages(preamble)
        const installed = await installedPackages(tools, candidates, env)
        // Unicode fonts set in the preamble are gone with it: pdfLaTeX (fastest) draws the rest,
        // and the reduced preamble is made for the engine that really runs.
        let engine = input.engine.engine
        if (engine === 'lualatex' || engine === 'xelatex') {
          const fast = plansFor('pdflatex', tools, needsPostScript(input.snippet))
          if (fast.length) {
            plans = fast
            engine = 'pdflatex'
          }
        }
        planIndex = 0
        preamble = reducedPreamble(input.preamble || preamble, input.snippet, engine, (name) => installed.has(name))
        edits = { ...NO_EDITS, dropLines: [], dropPackages: [] }
        notes.push(`the preamble did not compile here (${error.message.slice(0, 80)}): drew with a reduced one`)
        continue
      }
      return fail('error', error.message, { where: place.where === 'preamble' ? 'preamble' : 'other', line: error.line, file: error.file, context: error.context, label: plan.label, deps })
    }
    return fail('error', 'the picture could not be drawn after several attempts', { label: plans[planIndex]?.label ?? input.engine.engine, deps: lastDeps })
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined)
  }
}
