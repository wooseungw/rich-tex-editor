import { Facet, StateEffect } from '@codemirror/state'

export interface LoadedImage {
  /** A `blob:` URL the frame can show. */
  url: string
  /** Path relative to the .tex folder, as found on disk. */
  path: string
  mime: string
  /** Natural size once it has been drawn, so later draws reserve its space before decoding. */
  width?: number
  height?: number
}

/** Finds and loads the images a document references; the worker does the file access. */
export interface ImageLoader {
  /** Rises when earlier answers may be stale (folders or the file's location changed). */
  readonly generation: number
  /** The image if it is already loaded, so a redraw shows it at once. */
  cached(ref: string): LoadedImage | null | undefined
  load(ref: string): Promise<LoadedImage | null>
}

/** Dispatched when the loader's generation rises, so image widgets load again. */
export const refreshImages = StateEffect.define<null>()

/** The loader the visual mode uses; without one, images show as their file name. */
export const imageLoader = Facet.define<ImageLoader, ImageLoader | null>({
  combine: (values) => values[0] ?? null
})
