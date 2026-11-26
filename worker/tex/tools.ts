// The person's TeX toolchain, found once and shared by pictures and PDF figures.
import { findToolchain, type Toolchain } from './toolchain'

export class ToolchainCache {
  private tools: Promise<Toolchain> | null = null
  private at = 0
  private found = false

  /** Found once, kept; when nothing was found, looked for again after a minute (TeX may have
   *  just been installed). `refresh` looks again now. */
  get(refresh = false): Promise<Toolchain> {
    if (!this.tools || refresh || (!this.found && Date.now() - this.at > 60000)) {
      this.at = Date.now()
      this.tools = findToolchain()
        .catch((): Toolchain => ({ bin: {}, postscript: false, distribution: 'TeX' }))
        .then((t) => {
          // A PDF converter alone does not count: TeX installed later is still looked for.
          this.found = !!(t.bin.latex || t.bin.xelatex || t.bin.lualatex)
          return t
        })
    }
    return this.tools
  }
}
