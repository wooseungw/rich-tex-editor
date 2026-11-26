// PDF figures (`\includegraphics{plot.pdf}`, matplotlib's savefig to PDF) drawn as SVG by the
// PDF converter the person has (pdftocairo from poppler, or mutool), page 1, so the editor shows
// them instead of a card with their name. Each version of a file is converted once.
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { JobQueue } from './cache'
import { run } from './compile'
import { sanitizeSvg } from './svg'
import { pdfConverter, type Toolchain } from './toolchain'

const MAX_SVG_BYTES = 16 * 1024 * 1024
const TIMEOUT_MS = 20000
const KEPT_BYTES = 64 * 1024 * 1024

export class PdfDrawings {
  private readonly drawn = new Map<string, Promise<Buffer | null>>()
  private readonly sizes = new Map<string, number>()
  private bytes = 0
  /** A paper's figures load together: two conversions at a time. */
  private readonly queue = new JobQueue<Buffer | null>(2)

  constructor(private readonly tools: () => Promise<Toolchain>) {}

  /** Whether PDFs can be drawn on this computer. */
  async available(): Promise<boolean> {
    return pdfConverter(await this.tools()) !== null
  }

  /** Page 1 of the PDF as cleaned SVG bytes, or null when it cannot be drawn. */
  svg(file: string, stat: { size: number; mtimeMs: number }): Promise<Buffer | null> {
    const key = `${file}\0${stat.size}\0${stat.mtimeMs}`
    let hit = this.drawn.get(key)
    if (hit) {
      // Recently used: to the end.
      this.drawn.delete(key)
      this.drawn.set(key, hit)
      return hit
    }
    hit = this.queue.run(key, () => this.convert(file)).then((svg) => {
      // A PDF that cannot be drawn is remembered too (until the file changes, which is a new key).
      if (!svg) return null
      this.sizes.set(key, svg.length)
      this.bytes += svg.length
      // Oldest drawings go first, keeping the memory they hold bounded.
      for (const k of this.drawn.keys()) {
        if (this.bytes <= KEPT_BYTES) break
        const size = this.sizes.get(k)
        if (k === key || size === undefined) continue
        this.drawn.delete(k)
        this.sizes.delete(k)
        this.bytes -= size
      }
      return svg
    })
    this.drawn.set(key, hit)
    return hit
  }

  private async convert(file: string): Promise<Buffer | null> {
    const converter = pdfConverter(await this.tools())
    if (!converter) return null
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rich-tex-pdf-'))
    try {
      // The converter reads the PDF where it is and writes into its own folder.
      const args = converter.kind === 'pdftocairo' ? ['-svg', '-f', '1', '-l', '1', file, 'page.svg'] : ['draw', '-F', 'svg', '-o', 'page.svg', file, '1']
      const env: NodeJS.ProcessEnv = { PATH: path.dirname(converter.program), HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG }
      const done = await run(converter.program, args, cwd, env, TIMEOUT_MS)
      if (done.timedOut || done.tooLarge || done.cancelled) return null
      const out = path.join(cwd, 'page.svg')
      const stat = await fs.stat(out).catch(() => null)
      if (!stat?.isFile() || stat.size === 0 || stat.size > MAX_SVG_BYTES) return null
      const svg = sanitizeSvg(await fs.readFile(out, 'utf8'))
      return /<svg\b/.test(svg) ? Buffer.from(svg, 'utf8') : null
    } finally {
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
