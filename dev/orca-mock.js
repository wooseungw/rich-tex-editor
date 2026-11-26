// A stand-in for the `orca` global Orca's frame shell provides, for dev/harness.html.
// Query: file=<path from dev/>, theme=light|dark, mode=visual|split, readonly,
//        tex=<port of dev/tex-server.mjs>&token=<the token it prints> to draw TikZ with this
//        computer's TeX
;(() => {
  const params = new URLSearchParams(location.search)
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
  const file = params.get('file') || '../examples/showcase.tex'
  if (params.get('mode')) localStorage.setItem('rich-tex-editor:mode', params.get('mode'))

  const palettes = {
    light: {
      background: '#ffffff', foreground: '#18181b', card: '#ffffff', 'card-foreground': '#18181b',
      popover: '#ffffff', 'popover-foreground': '#18181b', primary: '#18181b', 'primary-foreground': '#fafafa',
      secondary: '#f4f4f5', 'secondary-foreground': '#18181b', muted: '#f4f4f5', 'muted-foreground': '#71717a',
      accent: '#f4f4f5', 'accent-foreground': '#18181b', destructive: '#dc2626', 'destructive-foreground': '#fafafa',
      border: '#e4e4e7', input: '#e4e4e7', ring: '#a1a1aa'
    },
    dark: {
      background: '#141414', foreground: '#ededed', card: '#1b1b1b', 'card-foreground': '#ededed',
      popover: '#1f1f1f', 'popover-foreground': '#ededed', primary: '#ededed', 'primary-foreground': '#141414',
      secondary: '#2a2a2a', 'secondary-foreground': '#ededed', muted: '#232323', 'muted-foreground': '#a1a1aa',
      accent: '#2a2a2a', 'accent-foreground': '#ededed', destructive: '#f87171', 'destructive-foreground': '#141414',
      border: '#2e2e2e', input: '#3a3a3a', ring: '#5b5b5b'
    }
  }
  const root = document.documentElement
  root.classList.add(theme)
  for (const [k, v] of Object.entries(palettes[theme])) root.style.setProperty(`--orca-${k}`, v)
  root.style.setProperty('--orca-radius', '6px')
  root.style.setProperty('--orca-font-sans', 'system-ui, -apple-system, sans-serif')
  root.style.setProperty('--orca-font-mono', 'ui-monospace, Menlo, monospace')

  const replaceHandlers = []
  const mock = { changes: [], saved: null, opened: [], value: null }
  window.__orcaMock = mock
  const disposable = { dispose() {} }

  window.orca = {
    api: { major: 1, minor: 10 },
    locale: 'en-US',
    host: {
      has: (method) => method === 'editor.readTypography',
      call: async (method) => {
        if (method === 'editor.readTypography') {
          return { fontFamily: 'Menlo', cssFontFamily: 'Menlo', fontSize: 13, fontWeight: '400', lineHeight: 20, fontLigatures: false, wordWrap: 'on', minimap: false }
        }
        throw Object.assign(new Error(`not mocked: ${method}`), { code: 'unknown_method' })
      }
    },
    on: () => disposable,
    shell: { openExternal: async (url) => (mock.opened.push(url), { opened: true }) },
    files: { saveAs: async (options) => ((mock.saved = options), { status: 'saved' }) },
    document: {
      session: async () => {
        mock.value = await (await fetch(file)).text()
        return {
          get value() { return mock.value },
          readOnly: params.has('readonly'),
          change(next) { mock.value = next; mock.changes.push(next) },
          flush: async () => {},
          onReplace(handler) { replaceHandlers.push(handler); return disposable },
          dispose() {}
        }
      }
    }
  }
  // The worker's requests, served from the files next to the harness. `file` decides the folder
  // the .tex "lives" in; uploads are kept in memory and readable afterwards.
  const texDir = file.replace(/[^/]*$/, '')
  const uploads = new Map()
  const saved = new Map()
  mock.uploads = saved
  /** Simulates a file written on disk (a redrawn plot): `mock.writeImage('figures/a.png', bytes)`. */
  mock.mtimes = new Map()
  mock.writeImage = (rel, bytes) => {
    saved.set(rel, bytes)
    mock.mtimes.set(rel, Date.now())
  }
  const toBase64 = (bytes) => {
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(s)
  }
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf' }
  const handlers = {
    'tex.locate': async () => ({ location: { root: '/mock', dir: '', file: file.replace(/^.*\//, '') }, workspace: '/mock' }),
    'image.read': async ({ ref, graphicsPath, offset }) => {
      const exts = /\.[a-z0-9]+$/i.test(ref) ? [''] : Object.keys(MIME).map((e) => '.' + e)
      for (const folder of ['', ...graphicsPath]) {
        for (const ext of exts) {
          const rel = (folder ? folder.replace(/\/?$/, '/') : '') + ref + ext
          let bytes = saved.get(rel)
          let mtimeMs = mock.mtimes.get(rel) ?? 0
          if (!bytes) {
            const res = await fetch(texDir + rel, { cache: 'no-store' })
            if (!res.ok) continue
            bytes = new Uint8Array(await res.arrayBuffer())
            mtimeMs = Date.parse(res.headers.get('last-modified') ?? '') || 0
          }
          const mime = MIME[rel.split('.').pop().toLowerCase()]
          if (!mime) continue
          return { found: true, path: rel, mime, size: bytes.length, mtimeMs, data: toBase64(bytes.subarray(offset, offset + 700 * 1024)), next: offset + 700 * 1024 < bytes.length ? offset + 700 * 1024 : null }
        }
      }
      return { found: false }
    },
    'image.stat': async ({ ref, graphicsPath }) => {
      const exts = /\.[a-z0-9]+$/i.test(ref) ? [''] : Object.keys(MIME).map((e) => '.' + e)
      for (const folder of ['', ...graphicsPath]) {
        for (const ext of exts) {
          const rel = (folder ? folder.replace(/\/?$/, '/') : '') + ref + ext
          if (!MIME[rel.split('.').pop().toLowerCase()]) continue
          const bytes = saved.get(rel)
          if (bytes) return { found: true, path: rel, size: bytes.length, mtimeMs: mock.mtimes.get(rel) ?? 0 }
          const res = await fetch(texDir + rel, { method: 'HEAD', cache: 'no-store' })
          if (!res.ok) continue
          return { found: true, path: rel, size: Number(res.headers.get('content-length')), mtimeMs: Date.parse(res.headers.get('last-modified') ?? '') || 0 }
        }
      }
      return { found: false }
    },
    'image.begin': async ({ folder, name, bytes }) => {
      const id = String(uploads.size + 1)
      uploads.set(id, { path: `${folder}/${name.replace(/[^A-Za-z0-9._-]+/g, '-')}`, bytes, chunks: [] })
      return { uploadId: id, path: uploads.get(id).path }
    },
    'image.chunk': async ({ uploadId, data }) => {
      const up = uploads.get(uploadId)
      up.chunks.push(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))
      return { received: up.chunks.reduce((n, c) => n + c.length, 0) }
    },
    'image.commit': async ({ uploadId }) => {
      const up = uploads.get(uploadId)
      const all = new Uint8Array(up.chunks.reduce((n, c) => n + c.length, 0))
      let at = 0
      for (const c of up.chunks) { all.set(c, at); at += c.length }
      saved.set(up.path, all)
      return { path: up.path }
    }
  }
  const texPort = params.get('tex')
  const texToken = params.get('token') ?? ''
  window.orca.plugin = {
    request: async (name, input, options = {}) => {
      // Pictures go to dev/tex-server.mjs, which runs the worker's own handlers.
      if (texPort && /^(?:tex\.tools|text\.put|picture\.)/.test(name)) {
        const res = await fetch(`http://127.0.0.1:${texPort}/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rte-token': texToken },
          body: JSON.stringify({ name, input }),
          signal: options.signal
        })
        const answer = await res.json()
        if (!answer.ok) throw Object.assign(new Error(answer.message), { code: answer.code })
        return answer.output
      }
      const handler = handlers[name]
      if (!handler) throw Object.assign(new Error(`unknown_method: ${name}`), { code: 'unknown_method' })
      return handler(input)
    },
    on: () => disposable
  }

  /** Simulates an outside write (an agent saving the file). */
  mock.replace = (text) => {
    mock.value = text
    for (const handler of replaceHandlers) handler(text)
  }
})()
