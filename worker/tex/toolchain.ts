// Finding the person's TeX installation. Orca starts the worker with the PATH its app got, which
// on macOS often lacks /Library/TeX/texbin, so the usual install folders of TeX Live, MacTeX,
// MiKTeX and TinyTeX are searched too, and as a last resort the login shell's PATH.
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Engine } from './engine'

export interface Toolchain {
  /** Absolute paths of the programs found, by name (`latex`, `xelatex`, `dvisvgm`, …). */
  bin: Partial<Record<Program, string>>
  /** dvisvgm can run PostScript (needs Ghostscript): PSTricks pictures. */
  postscript: boolean
  /** `TeX Live 2025`, `MiKTeX 24.1`, … for the status line and the cache key. */
  distribution: string
}

export type Program =
  | 'latex'
  | 'pdflatex'
  | 'xelatex'
  | 'lualatex'
  | 'dvilualatex'
  | 'platex'
  | 'uplatex'
  | 'dvisvgm'
  | 'kpsewhich'
  | 'pdftocairo'
  | 'mutool'

const PROGRAMS: readonly Program[] = ['latex', 'pdflatex', 'xelatex', 'lualatex', 'dvilualatex', 'platex', 'uplatex', 'dvisvgm', 'kpsewhich', 'pdftocairo', 'mutool']

/** Folders where TeX distributions put their programs, newest TeX Live first. */
export async function candidateFolders(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): Promise<string[]> {
  const dirs: string[] = []
  const list = async (dir: string) => fs.readdir(dir).catch(() => [] as string[])
  const texlive = async (base: string) => {
    const years = (await list(base)).filter((name) => /^\d{4}$/.test(name)).sort().reverse()
    for (const year of years) {
      const bin = path.join(base, year, 'bin')
      for (const arch of await list(bin)) dirs.push(path.join(bin, arch))
    }
  }
  const sep = platform === 'win32' ? ';' : ':'
  for (const dir of (env.PATH ?? env.Path ?? '').split(sep)) if (dir) dirs.push(dir)
  if (platform === 'darwin') {
    dirs.push('/Library/TeX/texbin')
    await texlive('/usr/local/texlive')
    for (const arch of await list(path.join(home, 'Library/TinyTeX/bin'))) dirs.push(path.join(home, 'Library/TinyTeX/bin', arch))
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin')
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    const programs = env.ProgramFiles ?? 'C:\\Program Files'
    dirs.push(path.join(local, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'), path.join(programs, 'MiKTeX', 'miktex', 'bin', 'x64'))
    await texlive('C:\\texlive')
    const appdata = env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    for (const arch of await list(path.join(appdata, 'TinyTeX', 'bin'))) dirs.push(path.join(appdata, 'TinyTeX', 'bin', arch))
  } else {
    await texlive('/usr/local/texlive')
    for (const arch of await list(path.join(home, '.TinyTeX/bin'))) dirs.push(path.join(home, '.TinyTeX/bin', arch))
    dirs.push('/usr/bin', '/usr/local/bin', '/snap/bin')
  }
  return dirs.filter((dir, i) => dirs.indexOf(dir) === i)
}

async function executable(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return false
    if (process.platform === 'win32') return true
    await fs.access(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Runs a program briefly and answers its output, or null. */
export function capture(file: string, args: string[], timeoutMs = 5000, env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20, env, windowsHide: true }, (error, stdout, stderr) => {
      if (error && !stdout && !stderr) resolve(null)
      else resolve(`${stdout}${stderr}`)
    })
  })
}

/** The login shell's PATH (macOS and Linux apps started from the desktop do not see it). */
async function loginShellPath(env: NodeJS.ProcessEnv): Promise<string[]> {
  if (process.platform === 'win32') return []
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : '/bin/sh'
  const out = await capture(shell, ['-lc', 'printf "%s" "$PATH"'], 4000, { HOME: env.HOME, PATH: env.PATH, USER: env.USER })
  return out ? out.trim().split(':').filter(Boolean) : []
}

async function locate(dirs: string[], platform: NodeJS.Platform): Promise<Partial<Record<Program, string>>> {
  const found: Partial<Record<Program, string>> = {}
  for (const name of PROGRAMS) {
    for (const dir of dirs) {
      const file = path.join(dir, platform === 'win32' ? `${name}.exe` : name)
      if (await executable(file)) {
        found[name] = file
        break
      }
    }
  }
  return found
}

/** Finds the toolchain. Programs a TeX distribution ships are taken from one folder when it can. */
export async function findToolchain(env: NodeJS.ProcessEnv = process.env): Promise<Toolchain> {
  const platform = process.platform
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir()
  let dirs = await candidateFolders(env, platform, home)
  let bin = await locate(dirs, platform)
  if (!bin.latex && !bin.xelatex && !bin.lualatex) {
    dirs = [...dirs, ...(await loginShellPath(env))]
    bin = await locate(dirs, platform)
  }
  // Prefer the TeX programs from the folder `latex` came from, so they match one another.
  const texDir = bin.latex ? path.dirname(bin.latex) : bin.xelatex ? path.dirname(bin.xelatex) : null
  if (texDir) {
    for (const name of ['pdflatex', 'xelatex', 'lualatex', 'dvilualatex', 'platex', 'uplatex', 'dvisvgm', 'kpsewhich'] as const) {
      const file = path.join(texDir, platform === 'win32' ? `${name}.exe` : name)
      if (await executable(file)) bin[name] = file
    }
  }
  let distribution = 'TeX'
  const anyTex = bin.latex ?? bin.pdflatex ?? bin.xelatex ?? bin.lualatex
  if (anyTex) {
    const version = (await capture(anyTex, ['--version'])) ?? ''
    const tl = /TeX Live (\d{4})/.exec(version)
    const mik = /MiKTeX[- ](\d+(?:\.\d+)*)/i.exec(version)
    distribution = tl ? `TeX Live ${tl[1]}` : mik ? `MiKTeX ${mik[1]}` : (version.split('\n')[0] ?? 'TeX').slice(0, 60)
  }
  let postscript = false
  if (bin.dvisvgm) {
    const handlers = (await capture(bin.dvisvgm, ['-l'])) ?? ''
    postscript = /^ps\s/m.test(handlers)
  }
  return { bin, postscript, distribution }
}

/** The program that runs an engine's first pass, and the route its output takes to SVG. */
export interface Plan {
  program: string
  args: string[]
  route: 'dvi' | 'xdv' | 'pdf'
  /** What this plan is, for the status line (`XeLaTeX`, `pdfLaTeX (DVI)`, …). */
  label: string
}

/** A PDF→SVG converter, or null. */
export function pdfConverter(tools: Toolchain): { program: string; kind: 'pdftocairo' | 'mutool' } | null {
  if (tools.bin.pdftocairo) return { program: tools.bin.pdftocairo, kind: 'pdftocairo' }
  if (tools.bin.mutool) return { program: tools.bin.mutool, kind: 'mutool' }
  return null
}

/**
 * The ways to compile for an engine, best first. pdfLaTeX documents run as `latex` (the same
 * pdfTeX, writing DVI), which dvisvgm turns into SVG without Ghostscript; XeLaTeX writes XDV.
 * LuaLaTeX needs a PDF converter (its DVI cannot carry OpenType fonts), else DVI LuaLaTeX.
 */
export function plansFor(engine: Engine, tools: Toolchain, needsPostScript: boolean): Plan[] {
  const common = ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-no-shell-escape', '-recorder']
  // LuaTeX runs Lua from the document (\directlua): no file writes, processes or sockets from it.
  const lua = ['--safer', '--nosocket', ...common]
  const plans: Plan[] = []
  const converter = pdfConverter(tools)
  const dvi = !!tools.bin.dvisvgm && (!needsPostScript || tools.postscript)
  const pdf = (program: string | undefined, label: string, args = common) => {
    if (program && converter) plans.push({ program, args, route: 'pdf', label })
  }
  switch (engine) {
    case 'pdflatex':
    case 'latex':
      if (dvi && tools.bin.latex) plans.push({ program: tools.bin.latex, args: common, route: 'dvi', label: engine === 'latex' ? 'LaTeX' : 'pdfLaTeX' })
      pdf(tools.bin.pdflatex, 'pdfLaTeX')
      break
    case 'xelatex':
      // XDV only: writing PDF, XeLaTeX runs xdvipdfmx, which reads picture files by absolute path
      // whatever openin_any says (\XeTeXpicfile "/any/file.png" would be drawn in).
      if (dvi && tools.bin.xelatex) plans.push({ program: tools.bin.xelatex, args: ['-no-pdf', ...common], route: 'xdv', label: 'XeLaTeX' })
      break
    case 'lualatex':
      pdf(tools.bin.lualatex, 'LuaLaTeX', lua)
      if (dvi && tools.bin.dvilualatex) plans.push({ program: tools.bin.dvilualatex, args: lua, route: 'dvi', label: 'LuaLaTeX (DVI)' })
      if (dvi && tools.bin.xelatex) plans.push({ program: tools.bin.xelatex, args: ['-no-pdf', ...common], route: 'xdv', label: 'XeLaTeX (for LuaLaTeX)' })
      break
    case 'platex':
    case 'uplatex': {
      const program = tools.bin[engine]
      if (dvi && program) plans.push({ program, args: common, route: 'dvi', label: engine === 'platex' ? 'pLaTeX' : 'upLaTeX' })
      break
    }
  }
  return plans
}
