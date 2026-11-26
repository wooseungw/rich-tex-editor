// The editor <-> worker contract, declared once: src/ (the editor frame) and worker/ both read it.
//
// The editor frame has no file system and never learns the path of the file it shows. The worker
// (Node) finds that file by its contents, saves dropped images next to it and reads the images
// it references. Request inputs are capped at 64 KiB and answers at 1 MiB, so image bytes travel
// base64-encoded in chunks.
export {}

/** Image types the worker writes and reads. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'] as const

/** Raw bytes per `image.chunk` input (base64 grows it by 4/3, staying under 64 KiB of JSON). */
export const UPLOAD_CHUNK_BYTES = 45 * 1024
/** Raw bytes per `image.read` answer (base64 grows it by 4/3, staying under 1 MiB of JSON). */
export const READ_CHUNK_BYTES = 700 * 1024
/** Largest image the worker accepts or returns. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/** Where the open .tex file is, as found by `tex.locate`. `dir` is relative to `root`. */
export interface TexLocation {
  /** Absolute path of the workspace folder that holds the file. */
  root: string
  /** Folder of the .tex file relative to `root`, with `/` separators; `''` for the root itself. */
  dir: string
  /** The .tex file's name, e.g. `paper.tex`. */
  file: string
}

/** How a picture sits in the document: an environment of its own, `\tikz` in a line of text, or
 *  math that only TeX can draw (`\xymatrix` in `\[ … \]`). */
export type SnippetMode = 'block' | 'inline' | 'display-math' | 'inline-math'

/** A text the worker may already have: its SHA-256 (of the UTF-8 bytes), with the text itself
 *  unless it is large; large texts go first through `text.put`. */
export interface TextRef {
  sha256: string
  text?: string
}

/** A text travels inside `picture.render` when its JSON is at most this many UTF-8 bytes. */
export const INLINE_TEXT_BYTES = 24 * 1024
/** Characters per `text.put` chunk (as JSON, at most ~3 bytes each: well under 64 KiB). */
export const TEXT_CHUNK_CHARS = 12 * 1024
/** Largest preamble or picture source accepted. */
export const MAX_TEXT_CHARS = 1024 * 1024
/** Characters of SVG per `picture.read` answer, and the most `picture.render` returns inline. */
export const PICTURE_CHUNK_CHARS = 600 * 1024

/** A picture TeX drew: its SVG (null when it must be read in chunks), size and baseline. */
export interface DrawnPicture {
  status: 'drawn'
  key: string
  svg: string | null
  length: number
  /** Size of the drawing and the depth below its baseline, in big points (1/72 in). */
  width: number
  height: number
  depth: number
  /** The document's \normalsize in points, to show the drawing at the text's size. */
  fontSize: number | null
  /** How it was drawn (`XeLaTeX`, `pdfLaTeX`) and anything set aside to draw it. */
  label: string
  notes: string[]
  /** The document is written for LuaLaTeX, which was not used: it runs the document's Lua, which
   *  can read any file. The person may allow it for this document (`allowLua`). */
  wantsLua: boolean
}

export interface FailedPicture {
  status: 'failed'
  key: string
  /** `busy`: not run yet (others went first); asked again later. */
  reason: 'error' | 'timeout' | 'cancelled' | 'busy'
  message: string
  /** In the picture (then `line` is 1-based in it), the preamble, another file, or unknown. */
  where: 'picture' | 'preamble' | 'file' | 'other'
  line: number | null
  file: string | null
  /** What TeX had read when it stopped. */
  context: string
  label: string
  notes: string[]
  wantsLua: boolean
}

export type PictureAnswer =
  | { status: 'missing'; missing: string[] }
  | DrawnPicture
  | FailedPicture
  | { status: 'unavailable'; message: string }

declare module 'orca' {
  interface PluginRequests {
    /** The TeX installation pictures are drawn with, as found on this computer. */
    'tex.tools': {
      input: { refresh?: boolean } | null
      output: { found: boolean; distribution: string; engines: string[]; converter: string | null; postscript: boolean; message: string | null }
    }
    /** One chunk of a large text, by the SHA-256 of the whole; `complete` once all have come. */
    'text.put': {
      input: { sha256: string; index: number; count: number; data: string }
      output: { complete: boolean }
    }
    /**
     * Draws a picture with the person's TeX: `snippet` is the picture's source, `preamble` the
     * document's text before \begin{document} (or its leading comments when it has none: a
     * section file, whose root document's preamble is used when the file is found on disk).
     * Answers `missing` with the texts to `text.put` first. Waits for TeX (up to ~100 s).
     */
    'picture.render': {
      input: {
        location: TexLocation | null
        preamble: TextRef
        snippet: TextRef
        mode: SnippetMode
        graphicsPath: string[]
        force?: boolean
        /** The person allowed LuaLaTeX for this document (it runs the document's Lua code). */
        allowLua?: boolean
      }
      output: PictureAnswer
    }
    /** Characters `[offset, offset + PICTURE_CHUNK_CHARS)` of a drawn picture's SVG. */
    'picture.read': {
      input: { key: string; offset: number }
      output: { found: boolean; data: string; next: number | null }
    }
    /** Of these drawn pictures, those whose files (data tables, \input files) changed on disk. */
    'picture.check': {
      input: { keys: string[] }
      output: { stale: string[] }
    }
    /**
     * Finds the open .tex file: a `.tex`/`.ltx`/`.latex` file in the focused workspace whose
     * UTF-8 bytes have this SHA-256 (lowercase hex) and length. `location` is null when none
     * matches (the tab has unsaved edits, or the file is on a remote host); the editor tries again
     * after a save. When no workspace is focused, `workspace` is null too.
     */
    'tex.locate': {
      input: { sha256: string; bytes: number }
      output: { location: TexLocation | null; workspace: string | null }
    }
    /**
     * Starts saving a dropped or pasted image into `<root>/<dir>/<folder>/`, creating the folder.
     * `name` is sanitised to `[A-Za-z0-9._-]` (other characters become `-`) and made unique
     * (`plot.png`, `plot-1.png`, …); its extension must be one of IMAGE_EXTENSIONS. `path` is
     * what `\includegraphics` should use: relative to the .tex folder, `/`-separated.
     * Without a location (null) the image goes under the focused workspace's root.
     */
    'image.begin': {
      input: { location: TexLocation | null; folder: string; name: string; bytes: number }
      output: { uploadId: string; path: string }
    }
    /** One base64 chunk of an upload, in order from 0. */
    'image.chunk': {
      input: { uploadId: string; index: number; data: string }
      output: { received: number }
    }
    /** Writes the uploaded bytes (never overwriting) and answers the final `\includegraphics` path. */
    'image.commit': {
      input: { uploadId: string }
      output: { path: string }
    }
    /**
     * Reads an image a document references, resolved as LaTeX does: `ref` relative to the .tex
     * folder, then each `\graphicspath` folder; when `ref` has no extension, each of
     * IMAGE_EXTENSIONS in order. Answers `found: false` for anything outside `root`, any other
     * file type, or a missing file. A null `location` resolves against the focused workspace's
     * root. `data` is the base64 of bytes `[offset, offset + READ_CHUNK_BYTES)`;
     * `next` is the offset to ask for next, or null at the end. A PDF, which the editor does not
     * draw, comes with no bytes.
     */
    'image.read': {
      /** `drawPdf`: a PDF comes as an SVG of its first page (mime image/svg+xml) when this
       *  computer has a PDF converter; its size and time stay the PDF's. */
      input: { location: TexLocation | null; ref: string; graphicsPath: string[]; offset: number; drawPdf?: boolean }
      output:
        | { found: false }
        | { found: true; path: string; mime: string; size: number; mtimeMs: number; data: string; next: number | null }
    }
    /** Where `image.read` would find `ref` now, with its size and modification time but not its
     *  bytes: the editor asks again for images it shows, to notice ones redrawn on disk. */
    'image.stat': {
      input: { location: TexLocation | null; ref: string; graphicsPath: string[] }
      output: { found: false } | { found: true; path: string; size: number; mtimeMs: number }
    }
  }
}
