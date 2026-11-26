// A section file (`\input` into a paper's main.tex) has no preamble of its own: its pictures are
// drawn with the preamble of the document that includes it. That document is found as LaTeX
// editors do: `% !TEX root = …`, the subfiles class's option, or a .tex file with
// \documentclass in this folder or a parent (within the workspace) that \input's this one,
// through as many as four levels of \input.
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { documentClass, stripComments } from './engine'

export interface RootDocument {
  /** Absolute path of the root .tex file. */
  file: string
  /** Its whole text (for the engine choice) and its preamble. */
  text: string
  preamble: string
}

const MAX_FILES = 300
const MAX_BYTES = 2 * 1024 * 1024
const MAX_LEVELS = 4

/** The text before `\begin{document}`, or '' when there is none. */
export function preambleOf(text: string): string {
  const at = /\\begin\s*\{document\}/.exec(text)
  return at ? text.slice(0, at.index) : ''
}

const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep)

/** A small text file, read only when it really is inside the workspace (links resolved). */
export async function readSmall(realRoot: string, file: string): Promise<string | null> {
  const real = await fs.realpath(file).catch(() => null)
  if (!real || !inside(realRoot, real)) return null
  const stat = await fs.stat(real).catch(() => null)
  if (!stat?.isFile() || stat.size > MAX_BYTES) return null
  return fs.readFile(real, 'utf8').catch(() => null)
}

/** The file a `% !TEX root = …` comment or `\documentclass[…]{subfiles}` names. */
export function namedRoot(text: string): string | null {
  for (const raw of text.split(/\r\n?|\n/, 40)) {
    const line = raw.trim()
    if (line === '') continue
    if (!line.startsWith('%')) break
    const m = /^%+\s*!\s*TeX\s+root\s*=\s*(.+?)\s*$/i.exec(line)
    if (m) return m[1]
  }
  const sub = /\\documentclass\s*\[([^\]]+)\]\s*\{subfiles\}/.exec(stripComments(text))
  return sub ? sub[1].trim() : null
}

/**
 * The files a document \input's, \include's, \subfile's or \import's, as absolute paths. An
 * \input in a file that is itself \input is read from the root document's folder (TeX's working
 * folder), which is not known yet: `bases` lists the folders to try, the file's own first.
 */
export function referencedFiles(text: string, bases: string[]): string[] {
  const body = stripComments(text)
  const out: string[] = []
  const add = (base: string, ref: string) => {
    const clean = ref.trim().replace(/^"|"$/g, '')
    if (!clean || clean.includes('\0')) return
    const abs = path.resolve(base, clean)
    out.push(abs, /\.[A-Za-z]+$/.test(clean) ? abs : `${abs}.tex`)
  }
  for (const m of body.matchAll(/\\(?:input|include|subfile|subfileinclude|InputIfFileExists)\s*\{([^}]+)\}/g)) {
    for (const base of bases) add(base, m[1])
  }
  // \subimport is relative to the file it is in; \import names its folder from the working one.
  for (const m of body.matchAll(/\\(sub)?(?:import|inputfrom|includefrom)\*?\s*\{([^}]*)\}\s*\{([^}]+)\}/g)) {
    for (const base of m[1] ? bases.slice(0, 1) : bases) add(path.resolve(base, m[2]), m[3])
  }
  return out
}

/** The .tex files in a folder. */
async function texFiles(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  return names.filter((name) => /\.(?:tex|ltx|latex)$/i.test(name)).map((name) => path.join(dir, name))
}

/**
 * The root document of `file` (absolute, inside `realRoot`), or null when it has none that can be
 * found. `text` is the file's current text in the editor.
 */
export async function findRoot(realRoot: string, file: string, text: string): Promise<RootDocument | null> {
  const dir = path.dirname(file)
  const named = namedRoot(text)
  if (named) {
    const target = path.resolve(dir, /\.[A-Za-z]+$/.test(named) ? named : `${named}.tex`)
    const rootText = await readSmall(realRoot, target)
    if (rootText && documentClass(rootText)) return { file: target, text: rootText, preamble: preambleOf(rootText) }
  }
  // Candidates: .tex files in this folder and each parent up to the workspace root.
  const candidates: string[] = []
  for (let d = dir; inside(realRoot, d); d = path.dirname(d)) {
    for (const f of await texFiles(d)) if (f !== file) candidates.push(f)
    if (candidates.length >= MAX_FILES || d === realRoot) break
  }
  const texts = new Map<string, string>()
  for (const f of candidates.slice(0, MAX_FILES)) {
    const t = await readSmall(realRoot, f)
    if (t !== null) texts.set(f, t)
  }
  let targets = new Set([file, file.replace(/\.tex$/i, '')])
  const seen = new Set<string>([file])
  for (let level = 0; level < MAX_LEVELS; level++) {
    const next = new Set<string>()
    for (const [candidate, candidateText] of texts) {
      if (seen.has(candidate)) continue
      const bases: string[] = []
      for (let d = path.dirname(candidate); inside(realRoot, d); d = path.dirname(d)) {
        bases.push(d)
        if (d === realRoot) break
      }
      const refs = referencedFiles(candidateText, bases)
      if (!refs.some((r) => targets.has(r))) continue
      if (documentClass(candidateText)) return { file: candidate, text: candidateText, preamble: preambleOf(candidateText) }
      next.add(candidate)
      next.add(candidate.replace(/\.tex$/i, ''))
      seen.add(candidate)
    }
    if (next.size === 0) break
    targets = next
  }
  return null
}

/** The latexmkrc next to a document or in its workspace root, if any. */
export async function findLatexmkrc(realRoot: string, dir: string): Promise<string | null> {
  for (let d = dir; inside(realRoot, d); d = path.dirname(d)) {
    for (const name of ['.latexmkrc', 'latexmkrc']) {
      const text = await readSmall(realRoot, path.join(d, name))
      if (text !== null) return text
    }
    if (d === realRoot) break
  }
  return null
}

/** The folders of `\graphicspath{{a/}{b/}}`, as written (relative to the root document's folder). */
export function graphicsPathOf(preamble: string): string[] {
  const out: string[] = []
  for (const m of stripComments(preamble).matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\})*)\s*\}/g)) {
    for (const g of m[1].matchAll(/\{([^{}]*)\}/g)) if (g[1].trim()) out.push(g[1].trim())
  }
  return out
}

/**
 * Root documents found recently, shared by pictures and images: a burst of requests from one
 * document searches its folders once. Answers (a miss too) are kept a few seconds.
 */
export class RootFinder {
  private readonly found = new Map<string, { at: number; value: Promise<RootDocument | null> }>()

  constructor(private readonly ttlMs = 5000) {}

  find(realRoot: string, file: string, head: string): Promise<RootDocument | null> {
    const key = `${realRoot}\0${file}\0${head.slice(0, 4096)}`
    const hit = this.found.get(key)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value
    const value = findRoot(realRoot, file, head).catch(() => null)
    this.found.set(key, { at: Date.now(), value })
    if (this.found.size > 64) this.found.delete(this.found.keys().next().value as string)
    return value
  }
}

/**
 * The \graphicspath folders a root document sets: in its preamble, and one level into the files
 * the preamble reads from its own folder (`\input{setup}`, a local `mystyle.sty`), where papers
 * often keep it. Files are read only inside the workspace.
 */
export async function preambleGraphicsPaths(realRoot: string, rootDir: string, preamble: string): Promise<string[]> {
  const out = graphicsPathOf(preamble)
  const text = stripComments(preamble)
  const files: string[] = []
  for (const m of text.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) {
    const name = m[1].trim()
    files.push(path.resolve(rootDir, /\.[A-Za-z]+$/.test(name) ? name : `${name}.tex`))
  }
  for (const m of text.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)) {
    for (const name of m[1].split(',')) if (name.trim()) files.push(path.resolve(rootDir, `${name.trim()}.sty`))
  }
  for (const file of files.slice(0, 32)) {
    const content = await readSmall(realRoot, file)
    if (content) out.push(...graphicsPathOf(content))
  }
  return out
}
