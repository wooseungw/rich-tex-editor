import { snippet } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { analysisField } from './editor/analysis'
import { imageLoader, refreshImages } from './editor/image-loader'
import { headOf, pictureAt, pictureRenderer, refreshPictures, type PictureView, type ShownPicture } from './editor/picture-spec'
import { renderMathOrThrow } from './editor/math-render'
import { createEditor, type Mode, replaceText, setBoundaries, setMode, setReadOnly } from './editor/setup'
import { ImageError, imageName, ImageStore, isImageFile } from './images'
import { PictureStore } from './pictures'
import { renderPreview } from './latex/preview'
import { scan } from './latex/scan'
import { start } from './sync'
import { PreviewPane } from './ui/preview-pane'
import { Toolbar } from './ui/toolbar'

const PREFS = 'rich-tex-editor:'
const readPref = (key: string): string | null => {
  try {
    return localStorage.getItem(PREFS + key)
  } catch {
    return null
  }
}
const writePref = (key: string, value: string) => {
  try {
    localStorage.setItem(PREFS + key, value)
  } catch {
    // Storage is a convenience: without it the editor starts in visual mode.
  }
}

const SAFE_URL = /^(https?:|mailto:)/i
const rootStyle = document.documentElement.style

/** Uses the font and size of Orca's own editor for source text. */
async function followTypography(): Promise<void> {
  if (!orca.host.has('editor.readTypography')) return
  const apply = (t: { cssFontFamily: string; fontSize: number }) => {
    rootStyle.setProperty('--rt-mono-font', `${t.cssFontFamily}, var(--orca-font-mono, ui-monospace, monospace)`)
    rootStyle.setProperty('--rt-mono-size', `${t.fontSize}px`)
  }
  try {
    apply(await orca.host.call('editor.readTypography'))
    orca.on('editor.typography.changed', apply)
  } catch {
    // Older Orca or a refused call: the CSS defaults apply.
  }
}

/** The preview marks links with `data-href` (the editor opens them itself); a saved page needs
 *  real links. Only http, https and mailto addresses are ever given a `data-href`. */
const exportLinks = (html: string) => html.replace(/ data-href="/g, ' href="')

async function main(): Promise<void> {
  const app = document.getElementById('app') ?? document.body
  app.classList.add('rt-app')
  void followTypography()

  const doc = await start()
  let mode: Mode = readPref('mode') === 'split' ? 'split' : 'visual'
  // Environment begin/end markers are on unless the person turned them off.
  let boundaries = readPref('boundaries') !== 'off'

  const main = document.createElement('div')
  main.className = 'rt-main'
  const editorPane = document.createElement('div')
  editorPane.className = 'rt-editor-pane'
  const divider = document.createElement('div')
  divider.className = 'rt-divider'
  divider.setAttribute('role', 'separator')
  divider.setAttribute('aria-orientation', 'vertical')
  divider.setAttribute('aria-label', 'Resize preview')
  const preview = new PreviewPane()
  main.append(editorPane, divider, preview.root)

  const split = Number(readPref('split'))
  if (split >= 0.2 && split <= 0.8) main.style.setProperty('--rt-split', `${split * 100}%`)

  let previewTimer: ReturnType<typeof setTimeout> | undefined
  let wordsTimer: ReturnType<typeof setTimeout> | undefined
  let syncing: 'editor' | 'preview' | null = null

  // Widgets ask for images while the editor is still being built, before `view` exists.
  let built: EditorView | null = null
  const images = new ImageStore(() => (built ? built.state.sliceDoc() : doc.value))
  images.setGraphicsPath(scan(doc.value).graphicsPath)
  // Find the file now, while the text still matches what is on disk.
  void images.locate()
  // Figures change on disk while the document is open (a script or an agent redraws a plot, or
  // makes one the document already names): look again now and then while the editor is visible.
  // Pictures only TeX can draw, drawn by the person's TeX through the worker.
  const pictures = new PictureStore(images)
  pictures.setEnabled(readPref('pictures') !== 'off')
  const recheckImages = () => {
    if (document.visibilityState !== 'visible') return
    void images.revalidate()
    void pictures.revalidate()
  }
  setInterval(recheckImages, 4000)
  window.addEventListener('focus', recheckImages)

  /**
   * Swaps the preview's image placeholders for the images. Each re-render reuses the same,
   * already decoded <img> elements, so images do not blank out while you type.
   */
  const previewImages = new Map<string, HTMLImageElement>()
  const showPreviewImages = () => {
    const used = new Set<HTMLImageElement>()
    const place = (box: HTMLElement, file: string, url: string) => {
      let img = previewImages.get(file)
      if (!img || img.src !== url) {
        img = document.createElement('img')
        img.className = 'rt-graphic-img'
        img.alt = file
        img.src = url
        previewImages.set(file, img)
      }
      // The same figure twice in one document needs a second element.
      const node = used.has(img) ? (img.cloneNode() as HTMLImageElement) : img
      used.add(img)
      box.replaceChildren(node)
      box.classList.add('rt-graphic-loaded')
    }
    for (const box of preview.content.querySelectorAll<HTMLElement>('.rt-graphic[data-file]')) {
      const file = box.dataset.file ?? ''
      if (!file) continue
      // A PDF (found, no url) keeps the placeholder that names it.
      const cached = images.cached(file)
      if (cached !== undefined) {
        if (cached?.url) place(box, file, cached.url)
        continue
      }
      void images.load(file).then((image) => {
        if (image?.url && box.isConnected) place(box, file, image.url)
      })
    }
  }

  /**
   * Swaps the preview's picture placeholders (`data-pic`, where the picture begins in the source)
   * for the drawings, keeping the same <img> across re-renders so they do not blink.
   */
  const previewPictureImgs = new Map<string, HTMLImageElement>()
  const showPreviewPictures = () => {
    const text = view.state.doc.toString()
    const analysis = view.state.field(analysisField)
    const head = headOf(text, analysis.scan.documentStart)
    const fontPx = parseFloat(getComputedStyle(preview.content).fontSize) || 16
    const used = new Set<HTMLImageElement>()
    const image = (picture: ShownPicture, stale: boolean, inline: boolean) => {
      let img = previewPictureImgs.get(picture.url)
      if (!img) {
        img = document.createElement('img')
        img.className = 'rt-picture-img'
        img.alt = 'Picture drawn by TeX'
        img.src = picture.url
        previewPictureImgs.set(picture.url, img)
      }
      const node = used.has(img) ? (img.cloneNode() as HTMLImageElement) : img
      used.add(img)
      const scale = pictures.scale(picture, fontPx)
      node.style.width = `${(picture.width * scale).toFixed(2)}px`
      node.style.aspectRatio = `${picture.width} / ${picture.height}`
      node.style.verticalAlign = inline ? `${(-picture.depth * scale).toFixed(2)}px` : ''
      node.classList.toggle('rt-picture-stale', stale)
      node.title = `${picture.label}${picture.notes.length ? `\n${picture.notes.join('\n')}` : ''}`
      return node
    }
    for (const box of preview.content.querySelectorAll<HTMLElement>('[data-pic]')) {
      const spec = pictureAt(analysis.scan, text, Number(box.dataset.pic))
      if (!spec) continue
      const inline = box.classList.contains('rt-graphic-inline')
      const v: PictureView = pictures.view(spec, head)
      const drawing = v.state === 'drawn' ? v.picture : v.state === 'pending' || v.state === 'failed' ? v.previous : null
      box.classList.toggle('rt-picture-pending', v.state === 'pending')
      box.classList.toggle('rt-picture-failed', v.state === 'failed')
      if (drawing) {
        box.replaceChildren(image(drawing, v.state !== 'drawn', inline))
        box.classList.add('rt-picture-loaded')
      }
      if (v.state === 'failed') {
        const e = v.error
        box.title = `${e.where === 'picture' && e.line !== null ? `Line ${e.line}: ` : ''}${e.message}${e.context ? `\n${e.context}` : ''}`
        if (!drawing) {
          const name = box.querySelector('.rt-graphic-name')
          if (name) name.textContent = `Not drawn: ${e.message}`
        }
      } else if (v.state === 'pending' && !drawing) {
        const name = box.querySelector('.rt-graphic-name')
        if (name && !name.textContent?.startsWith('Drawing')) name.textContent = `Drawing ${name.textContent ?? ''} with TeX…`
      } else if (v.state === 'off' && v.message) {
        box.title = `Not drawn: ${v.message}`
      }
    }
    // Elements of drawings no longer in the document go.
    for (const [url, img] of previewPictureImgs) if (!used.has(img)) previewPictureImgs.delete(url)
  }

  const renderNow = () => {
    const result = renderPreview(view.state.doc.toString(), { renderMath: renderMathOrThrow })
    preview.setHtml(result.html)
    showPreviewImages()
    showPreviewPictures()
    toolbar.setWords(result.wordCount)
  }
  const countWords = () => {
    const result = renderPreview(view.state.doc.toString(), { renderMath: () => '' })
    toolbar.setWords(result.wordCount)
  }
  const schedule = () => {
    if (mode === 'split') {
      clearTimeout(previewTimer)
      previewTimer = setTimeout(renderNow, 250)
    } else {
      clearTimeout(wordsTimer)
      wordsTimer = setTimeout(countWords, 400)
    }
  }

  const toolbar = new Toolbar({
    getView: () => view,
    getMode: () => mode,
    setMode: (next) => {
      if (next === mode) return
      mode = next
      writePref('mode', mode)
      applyMode()
      view.focus()
    },
    exportHtml: () => void exportHtml(),
    insertImage: () => pickImage(),
    getBoundaries: () => boundaries,
    setBoundaries: (on) => {
      boundaries = on
      writePref('boundaries', on ? 'on' : 'off')
      setBoundaries(view, on)
    },
    getPictures: () => ({ on: pictures.enabled, problem: pictures.enabled ? pictures.problem : null }),
    setPictures: (on) => {
      writePref('pictures', on ? 'on' : 'off')
      pictures.setEnabled(on)
      if (mode === 'split') renderNow()
    }
  })

  /** Positions waiting for an upload; they move with edits made while it runs. */
  const waiting = new Set<{ pos: number }>()
  const trackWaiting = EditorView.updateListener.of((update) => {
    if (update.docChanged) for (const w of waiting) w.pos = update.changes.mapPos(w.pos)
  })

  /** Saves image files next to the .tex file and puts a figure for each at `pos`. */
  async function addImages(files: File[], pos: number, pasted: boolean): Promise<void> {
    if (view.state.readOnly || files.length === 0) return
    const at = { pos }
    waiting.add(at)
    try {
      await saveAndInsert(files, at, pasted)
    } finally {
      waiting.delete(at)
    }
  }

  async function saveAndInsert(files: File[], at: { pos: number }, pasted: boolean): Promise<void> {
    const paths: string[] = []
    for (const [i, file] of files.entries()) {
      const name = imageName(file, pasted)
      const label = files.length > 1 ? ` (${i + 1}/${files.length})` : ''
      toolbar.setStatus(`Saving ${name}${label}…`)
      try {
        paths.push(
          await images.save(file, name, (f) => toolbar.setStatus(`Saving ${name}${label}… ${Math.round(f * 100)}%`))
        )
      } catch (err) {
        const reason = err instanceof ImageError && err.code === 'unavailable' ? 'the plugin worker is not running' : err instanceof Error ? err.message : String(err)
        toolbar.setStatus(`Image not saved: ${reason}`, 'error', 8000)
        console.warn('Rich TeX Editor: image save failed', err)
        if (err instanceof ImageError && err.code === 'not_located') break
      }
    }
    if (paths.length === 0 || view.state.readOnly) return
    toolbar.setStatus(paths.length === 1 ? `Saved ${paths[0]}` : `Saved ${paths.length} images`, 'normal', 3000)
    insertFigures(paths, Math.min(at.pos, view.state.doc.length))
  }

  function insertFigures(paths: string[], pos: number): void {
    const braces = (text: string) => text.replace(/[{}]/g, (c) => `\\${c}`)
    const figures = paths
      .map((path, i) => {
        const stem = path.replace(/^.*\//, '').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'image'
        const caption = i === 0 ? '#{Caption}' : 'Caption'
        return [
          '\\begin{figure}[htbp]',
          '  \\centering',
          `  \\includegraphics[width=0.8\\linewidth]{${braces(path)}}`,
          `  \\caption{${caption}}`,
          `  \\label{fig:${braces(stem)}}`,
          '\\end{figure}'
        ].join('\n')
      })
      .join('\n\n')
    const line = view.state.doc.lineAt(pos)
    if (line.text.trim() === '') snippet(figures)(view, null, line.from, line.to)
    else snippet(`\n${figures}`)(view, null, line.to, line.to)
    view.focus()
  }

  function pickImage(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf'
    input.multiple = true
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])].filter(isImageFile)
      void addImages(files, view.state.selection.main.head, false)
    })
    input.click()
  }

  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false
  const dropAndPaste = EditorView.domEventHandlers({
    dragover(event, v) {
      if (!hasFiles(event) || v.state.readOnly) return false
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      v.dom.classList.add('cm-rt-dropping')
      return true
    },
    dragleave(event, v) {
      if (event.relatedTarget instanceof Node && v.dom.contains(event.relatedTarget)) return false
      v.dom.classList.remove('cm-rt-dropping')
      return false
    },
    drop(event, v) {
      v.dom.classList.remove('cm-rt-dropping')
      const files = [...(event.dataTransfer?.files ?? [])].filter(isImageFile)
      if (files.length === 0 || v.state.readOnly) return false
      event.preventDefault()
      const pos = v.posAtCoords({ x: event.clientX, y: event.clientY }) ?? v.state.selection.main.head
      void addImages(files, pos, false)
      return true
    },
    paste(event, v) {
      const files = [...(event.clipboardData?.files ?? [])].filter(isImageFile)
      if (files.length === 0 || v.state.readOnly) return false
      event.preventDefault()
      void addImages(files, v.state.selection.main.head, true)
      return true
    }
  })

  const view: EditorView = createEditor({
    parent: editorPane,
    text: doc.value,
    readOnly: doc.readOnly,
    mode,
    boundaries,
    onChange: (text) => {
      doc.change(text)
      schedule()
    },
    onUpdate: (v) => {
      toolbar.update(v)
      images.setGraphicsPath(v.state.field(analysisField).scan.graphicsPath)
    },
    extensions: [imageLoader.of(images), pictureRenderer.of(pictures), dropAndPaste, trackWaiting]
  })
  built = view
  // Deferred: this can fire from inside an editor update, which may not dispatch another.
  images.onChange = () =>
    queueMicrotask(() => {
      view.dispatch({ effects: refreshImages.of(null) })
      if (mode === 'split') showPreviewImages()
    })
  // A drawing arrived (or failed): decorate again, and fill the preview's places. Several that
  // arrive together are handled once.
  let picturesQueued = false
  pictures.onChange = () => {
    if (picturesQueued) return
    picturesQueued = true
    requestAnimationFrame(() => {
      picturesQueued = false
      view.dispatch({ effects: refreshPictures.of(null) })
      if (mode === 'split') showPreviewPictures()
      toolbar.update(view)
    })
  }

  app.append(toolbar.el, main)
  if (doc.readOnly) {
    const banner = document.createElement('div')
    banner.className = 'rt-banner'
    banner.textContent = 'This file is read-only.'
    app.insertBefore(banner, main)
  }
  toolbar.setReadOnly(doc.readOnly)

  doc.onReplace((text) => {
    replaceText(view, text)
    schedule()
  })

  function applyMode(): void {
    main.dataset.mode = mode
    setMode(view, mode)
    toolbar.update(view)
    if (mode === 'split') {
      renderNow()
      requestAnimationFrame(syncPreviewToEditor)
    } else {
      countWords()
    }
  }

  // Scroll sync. Whichever pane the person is using leads; the other follows.
  const editorTopLine = (): number => {
    const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop
    const block = view.lineBlockAtHeight(Math.max(0, top))
    const line = view.state.doc.lineAt(block.from).number
    return line + Math.min(1, Math.max(0, (top - block.top) / Math.max(1, block.height)))
  }
  function syncPreviewToEditor(): void {
    if (mode !== 'split') return
    preview.scrollToLine(editorTopLine())
  }
  let lead: 'editor' | 'preview' = 'editor'
  editorPane.addEventListener('pointerenter', () => (lead = 'editor'))
  editorPane.addEventListener('wheel', () => (lead = 'editor'), { passive: true })
  preview.root.addEventListener('pointerenter', () => (lead = 'preview'))
  preview.root.addEventListener('wheel', () => (lead = 'preview'), { passive: true })
  view.scrollDOM.addEventListener('scroll', () => {
    if (lead !== 'editor' || syncing === 'preview') return
    syncing = 'editor'
    syncPreviewToEditor()
    requestAnimationFrame(() => (syncing = null))
  })
  preview.root.addEventListener('scroll', () => {
    if (mode !== 'split' || lead !== 'preview' || syncing === 'editor') return
    syncing = 'preview'
    const line = Math.floor(preview.lineAtTop())
    const pos = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines)).from
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) })
    requestAnimationFrame(() => (syncing = null))
  })

  preview.root.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-href]') : null
    if (!link) return
    event.preventDefault()
    const url = link.dataset.href ?? ''
    if (SAFE_URL.test(url)) void orca.shell?.openExternal(url).catch(() => undefined)
  })
  preview.root.addEventListener('dblclick', (event) => {
    const line = preview.lineAt(event.target)
    if (line === null) return
    const pos = view.state.doc.line(Math.min(line, view.state.doc.lines)).from
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    view.focus()
  })

  // Dragging the divider resizes the panes.
  divider.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    divider.setPointerCapture(event.pointerId)
    main.classList.add('rt-resizing')
    const box = main.getBoundingClientRect()
    let ratio = 0.5
    const move = (e: PointerEvent) => {
      ratio = Math.min(0.8, Math.max(0.2, (e.clientX - box.left) / box.width))
      main.style.setProperty('--rt-split', `${ratio * 100}%`)
    }
    const up = () => {
      divider.removeEventListener('pointermove', move)
      main.classList.remove('rt-resizing')
      writePref('split', ratio.toFixed(3))
      view.requestMeasure()
    }
    divider.addEventListener('pointermove', move)
    divider.addEventListener('pointerup', up, { once: true })
    divider.addEventListener('pointercancel', up, { once: true })
  })

  /** Puts the pictures drawn so far into exported HTML as SVG images (the file stands alone). */
  async function embedPictures(html: string, text: string): Promise<string> {
    const analysis = view.state.field(analysisField)
    const head = headOf(text, analysis.scan.documentStart)
    const svgs = new Map<string, string>()
    for (const m of html.matchAll(/data-pic="(\d+)"/g)) {
      const spec = pictureAt(analysis.scan, text, Number(m[1]))
      if (!spec) continue
      const v = pictures.view(spec, head)
      if (v.state !== 'drawn') continue
      try {
        const svg = await (await fetch(v.picture.url)).text()
        const scale = pictures.scale(v.picture, 16)
        const inline = spec.mode === 'inline' || spec.mode === 'inline-math'
        const style = `width:${(v.picture.width * scale).toFixed(2)}px;max-width:100%;${inline ? `vertical-align:${(-v.picture.depth * scale).toFixed(2)}px` : ''}`
        svgs.set(m[1], `<img class="rt-picture-img" alt="Picture" style="${style}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}">`)
      } catch {
        // Left as its card.
      }
    }
    return html.replace(/<span class="([^"]*)" data-pic="(\d+)"([^>]*)>(?:<span[^>]*><\/span>)?<span class="rt-graphic-name">[^<]*<\/span><\/span>/g, (whole, cls: string, at: string, rest: string) => {
      const img = svgs.get(at)
      return img ? `<span class="${cls} rt-picture-loaded"${rest}>${img}</span>` : whole
    })
  }

  async function exportHtml(): Promise<void> {
    // Only the desktop app's isolated frames can save files; the manifest asks for one.
    if (!orca.files) return
    const text = view.state.doc.toString()
    const result = renderPreview(text, { renderMath: renderMathOrThrow })
    result.html = await embedPictures(result.html, text)
    let css = ''
    try {
      css = await (await fetch('preview.css')).text()
    } catch {
      css = ''
    }
    const title = (/\\title\{([^{}]*)\}/.exec(text)?.[1] ?? 'Document').trim() || 'Document'
    const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
    const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/katex.min.css">
<style>
:root { --orca-background: #ffffff; --orca-foreground: #1f2328; --orca-card: #ffffff; --orca-card-foreground: #1f2328;
  --orca-muted: #f3f4f6; --orca-muted-foreground: #59636e; --orca-accent: #eef2ff; --orca-border: #d8dee4;
  --orca-primary: #2f6feb; --orca-destructive: #cf222e; --orca-radius: 6px; --orca-font-mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
body { margin: 0; background: var(--orca-background); color: var(--orca-foreground); }
${css}
</style>
</head>
<body>
<div class="rt-preview">${exportLinks(result.html)}</div>
</body>
</html>
`
    const name = `${title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'document'}.html`
    try {
      await orca.files.saveAs({ suggestedName: name, mimeType: 'text/html', data: page })
    } catch (err) {
      console.warn('Rich TeX Editor: export failed', err)
    }
  }

  setReadOnly(view, doc.readOnly)
  applyMode()
}

void main().catch((err) => {
  console.error('Rich TeX Editor failed to start', err)
  const message = document.createElement('pre')
  message.className = 'rt-fatal'
  message.textContent = `Rich TeX Editor could not start:\n${err instanceof Error ? err.message : String(err)}`
  document.body.append(message)
})
