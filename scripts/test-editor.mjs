// Runs the CodeMirror-based specs (src/**/*.spec.ts) in Node. `orca plugin test` only lets plugin
// sources import relative files, so these specs are bundled with esbuild first.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function specs(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await specs(path)))
    else if (entry.name.endsWith('.spec.ts')) found.push(path)
  }
  return found
}

const entries = await specs(join(root, 'src'))
const out = await mkdtemp(join(tmpdir(), 'rich-tex-specs-'))
try {
  await build({
    entryPoints: entries,
    outdir: out,
    outbase: join(root, 'src'),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['node:*'],
    logLevel: 'warning'
  })
  const files = entries.map((e) => join(out, relative(join(root, 'src'), e)).replace(/\.ts$/, '.mjs'))
  const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
  process.exitCode = run.status ?? 1
} finally {
  await rm(out, { recursive: true, force: true })
}
