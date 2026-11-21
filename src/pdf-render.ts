import type * as PdfJs from 'pdfjs-dist'

/**
 * Draws the first page of a PDF figure to a PNG, with pdf.js loaded from the plugin's own files
 * the first time a PDF shows up (it is large, and most documents never need it).
 */

let library: Promise<typeof PdfJs> | null = null

const vendor = (file: string) => new URL(`./vendor/pdfjs/${file}`, import.meta.url).href

function pdfjs(): Promise<typeof PdfJs> {
  // A computed specifier keeps esbuild from bundling pdf.js into app.js.
  library ??= (import(/* @vite-ignore */ vendor('pdf.mjs')) as Promise<typeof PdfJs>).then((m) => {
    m.GlobalWorkerOptions.workerSrc = vendor('pdf.worker.mjs')
    return m
  })
  return library
}

export async function renderPdfFirstPage(bytes: Uint8Array, maxWidth = 1400): Promise<Blob> {
  const { getDocument } = await pdfjs()
  const task = getDocument({
    // pdf.js hands the buffer to its worker; give it a copy.
    data: bytes.slice(),
    useWasm: false,
    disableWorkerRendering: true,
    standardFontDataUrl: vendor('standard_fonts/'),
    verbosity: 0
  } as Parameters<typeof getDocument>[0])
  try {
    const pdf = await task.promise
    const page = await pdf.getPage(1)
    const natural = page.getViewport({ scale: 1 })
    // Fit the width, but never draw more than about 16 million pixels for a huge page.
    const pixelCap = Math.sqrt(16_000_000 / Math.max(1, natural.width * natural.height))
    const scale = Math.max(0.05, Math.min(3, maxWidth / natural.width, pixelCap))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, viewport } as Parameters<typeof page.render>[0]).promise
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not encode the page'))), 'image/png')
    )
  } finally {
    await task.destroy()
  }
}
