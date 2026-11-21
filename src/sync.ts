import { mergeText } from './merge'

/** The only code that talks to Orca's document API: sends edits, keeps unsaved typing through
 *  outside writes by merging them line by line. */
export function start() {
  const document = orca.document
  if (!document) {
    throw new Error('Rich TeX Editor runs as a custom editor')
  }
  return document.session<string>({ merge: mergeText, debounceMs: 250 })
}
