// Bundles src/ into editor/app.js and copies KaTeX's stylesheet and fonts next to it. Orca loads
// plugin files as they are in the folder, so editor/app.js and editor/vendor/ are committed; run
// `npm run build` after editing src/.
//
// app.js is minified: Orca's plugin directory holds plugins over about 1 MB a file for review,
// and unminified it is 1.5 MB. The sources it is built from are all in src/.
//
// Files are written only when their bytes change: Orca reloads a development plugin's open
// editors whenever a file in its folder changes, and a rebuild that rewrites everything would
// flash them for nothing.
import { context } from 'esbuild'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Writes `data` to `path` unless it already holds exactly that; answers whether it wrote. */
async function writeIfChanged(path, data) {
  const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
  const current = await readFile(path).catch(() => null)
  if (current && current.equals(bytes)) return false
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return true
}

/** Makes `dest` hold exactly `files` (name → source path): copies what differs, removes the rest. */
async function mirror(dest, files) {
  let changed = 0
  for (const [name, source] of Object.entries(files)) {
    if (await writeIfChanged(join(dest, name), await readFile(source))) changed++
  }
  const existing = await readdir(dest, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const entry of existing) {
    if (!entry.isFile()) continue
    const name = relative(dest, join(entry.parentPath ?? entry.path, entry.name))
    if (!(name in files)) {
      await rm(join(dest, name))
      changed++
    }
  }
  // Drop folders the removals emptied, deepest first.
  const folders = existing.filter((entry) => entry.isDirectory()).map((entry) => join(entry.parentPath ?? entry.path, entry.name))
  for (const folder of folders.sort((a, b) => b.length - a.length)) {
    if ((await readdir(folder)).length === 0) await rm(folder, { recursive: true })
  }
  return changed
}

async function vendorFiles() {
  const katex = join(root, 'node_modules/katex')
  const katexFiles = {
    'katex.min.css': join(katex, 'dist/katex.min.css'),
    LICENSE: join(katex, 'LICENSE')
  }
  // Every browser Orca runs in takes woff2, the first source in KaTeX's @font-face rules.
  for (const file of await readdir(join(katex, 'dist/fonts'))) {
    if (file.endsWith('.woff2')) katexFiles[`fonts/${file}`] = join(katex, 'dist/fonts', file)
  }
  return katexFiles
}

const options = {
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'editor/app.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  charset: 'utf8',
  legalComments: 'eof',
  banner: { js: '// Rich TeX Editor: generated from src/ by scripts/build.mjs. Edit the sources, not this file.' },
  logLevel: 'warning',
  write: false,
  plugins: [
    {
      name: 'write-if-changed',
      setup(build) {
        build.onEnd(async (result) => {
          for (const file of result.outputFiles ?? []) {
            const wrote = await writeIfChanged(file.path, file.contents)
            console.log(`${wrote ? 'wrote' : 'unchanged'} ${relative(root, file.path)} (${(file.contents.length / 1024).toFixed(0)} KB)`)
          }
        })
      }
    }
  ]
}

const vendorChanges = await mirror(join(root, 'editor/vendor/katex'), await vendorFiles())
console.log(vendorChanges ? `vendor: ${vendorChanges} files updated` : 'vendor: unchanged')

const ctx = await context(options)
if (process.argv.includes('--watch')) {
  await ctx.watch()
} else {
  await ctx.rebuild()
  await ctx.dispose()
}
