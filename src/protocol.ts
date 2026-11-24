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

declare module 'orca' {
  interface PluginRequests {
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
      input: { location: TexLocation | null; ref: string; graphicsPath: string[]; offset: number }
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
