// Bundles src/ into editor/app.js (unminified, so the shipped code stays readable) and copies
// KaTeX's stylesheet and fonts next to it. Orca loads plugin files as they are in the folder,
// so editor/app.js and editor/vendor/ are committed; run `npm run build` after editing src/.
import { build, context } from 'esbuild'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const katexDist = join(root, 'node_modules/katex/dist')
const vendor = join(root, 'editor/vendor/katex')

const pdfjsDist = join(root, 'node_modules/pdfjs-dist')
const pdfjsVendor = join(root, 'editor/vendor/pdfjs')

/** pdf.js draws PDF figures; the editor loads it on first use, so it ships beside app.js. */
async function copyPdfjs() {
  await rm(pdfjsVendor, { recursive: true, force: true })
  await mkdir(join(pdfjsVendor, 'standard_fonts'), { recursive: true })
  for (const file of ['pdf.mjs', 'pdf.worker.mjs', 'pdf.renderer.mjs']) {
    await cp(join(pdfjsDist, 'build', file), join(pdfjsVendor, file))
  }
  await cp(join(pdfjsDist, 'LICENSE'), join(pdfjsVendor, 'LICENSE'))
  for (const file of await readdir(join(pdfjsDist, 'standard_fonts'))) {
    await cp(join(pdfjsDist, 'standard_fonts', file), join(pdfjsVendor, 'standard_fonts', file))
  }
}

async function copyKatex() {
  await rm(vendor, { recursive: true, force: true })
  await mkdir(join(vendor, 'fonts'), { recursive: true })
  await cp(join(katexDist, 'katex.min.css'), join(vendor, 'katex.min.css'))
  await cp(join(root, 'node_modules/katex/LICENSE'), join(vendor, 'LICENSE'))
  for (const file of await readdir(join(katexDist, 'fonts'))) {
    // Every browser Orca runs in takes woff2, the first source in KaTeX's @font-face rules.
    if (file.endsWith('.woff2')) await cp(join(katexDist, 'fonts', file), join(vendor, 'fonts', file))
  }
}

const options = {
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'editor/app.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: false,
  sourcemap: false,
  charset: 'utf8',
  legalComments: 'eof',
  banner: { js: '// Rich TeX Editor: generated from src/ by scripts/build.mjs. Edit the sources, not this file.' },
  logLevel: 'info'
}

await copyKatex()
await copyPdfjs()
if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}
