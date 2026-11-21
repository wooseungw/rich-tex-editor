/**
 * The rendered document beside the source in split mode. Blocks carry `data-line` (the source
 * line they start on), which drives scroll sync both ways and double-click-to-source.
 */
export class PreviewPane {
  readonly root: HTMLElement
  readonly content: HTMLElement
  private lines: number[] = []
  private tops: number[] = []
  private stale = true

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'rt-preview-pane'
    this.root.tabIndex = 0
    this.root.setAttribute('aria-label', 'Document preview')
    this.content = document.createElement('div')
    this.content.className = 'rt-preview'
    this.root.append(this.content)
    new ResizeObserver(() => {
      this.stale = true
    }).observe(this.content)
  }

  /** `html` comes from the preview renderer, which escapes every piece of source text. */
  setHtml(html: string): void {
    this.content.innerHTML = html
    this.stale = true
  }

  private measure(): void {
    if (!this.stale) return
    const base = this.root.getBoundingClientRect().top - this.root.scrollTop
    const pairs: Array<[number, number]> = []
    for (const el of this.content.querySelectorAll<HTMLElement>('[data-line]')) {
      const line = Number(el.dataset.line)
      if (!Number.isFinite(line)) continue
      pairs.push([line, el.getBoundingClientRect().top - base])
    }
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    this.lines = [1]
    this.tops = [0]
    for (const [line, top] of pairs) {
      const last = this.lines.length - 1
      if (line === this.lines[last]) continue
      // Keep the mapping monotonic: a block placed above an earlier one (a float) is skipped.
      if (top < this.tops[last]) continue
      this.lines.push(line)
      this.tops.push(top)
    }
    this.stale = false
  }

  /** Scrolls so that source line `line` (fractional) is at the top. */
  scrollToLine(line: number): void {
    this.measure()
    const { lines, tops } = this
    let i = 0
    while (i + 1 < lines.length && lines[i + 1] <= line) i++
    let top = tops[i]
    if (i + 1 < lines.length) {
      const span = lines[i + 1] - lines[i]
      top += ((tops[i + 1] - tops[i]) * (line - lines[i])) / span
    }
    this.root.scrollTop = Math.max(0, top - 12)
  }

  /** The source line (fractional) at the top of the visible preview. */
  lineAtTop(): number {
    this.measure()
    const { lines, tops } = this
    const y = this.root.scrollTop + 12
    let i = 0
    while (i + 1 < tops.length && tops[i + 1] <= y) i++
    if (i + 1 < lines.length) {
      const span = tops[i + 1] - tops[i]
      return lines[i] + (span > 0 ? ((lines[i + 1] - lines[i]) * (y - tops[i])) / span : 0)
    }
    return lines[i]
  }

  /** The source line of the block under a click, if any. */
  lineAt(target: EventTarget | null): number | null {
    const el = target instanceof Element ? target.closest<HTMLElement>('[data-line]') : null
    const line = el ? Number(el.dataset.line) : NaN
    return Number.isFinite(line) ? line : null
  }
}
