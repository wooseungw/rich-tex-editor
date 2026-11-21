import { StateField } from '@codemirror/state'
import { extractMacros, type MacroMap } from '../latex/macros'
import { prepareMath, type PreparedMath } from '../latex/math'
import { type LabelTarget, type MathConstruct, scan, type ScanResult } from '../latex/scan'

/** Everything the visual mode, completions and toolbar read about the document, recomputed
 *  once per document change (never per cursor move). */
export interface Analysis {
  scan: ScanResult
  macros: MacroMap
  /** Changes whenever the macros do; widgets compare it to know when to re-render. */
  macrosKey: string
  math: Map<MathConstruct, PreparedMath>
  /** Every label, equations included. */
  labels: Map<string, LabelTarget>
  /** `\bibitem` key → what a citation of it prints (`3`, or its `[label]`). */
  citations: Map<string, string>
}

export function analyze(text: string): Analysis {
  const result = scan(text)
  const macros = extractMacros(text)
  const math = new Map<MathConstruct, PreparedMath>()
  const labels = new Map(result.labels)
  let equation = 0
  const nextNumber = () => ++equation
  const bodyStart = result.documentStart ?? 0
  for (const c of result.constructs) {
    // Math in the preamble (inside macro definitions) is never shown and takes no number.
    if (c.kind !== 'math' || c.from < bodyStart) continue
    const prepared = prepareMath(
      { env: c.env, body: text.slice(c.bodyFrom, c.bodyTo), display: c.display },
      nextNumber
    )
    math.set(c, prepared)
    for (const label of prepared.labels) {
      if (label.tag !== null) labels.set(label.key, { number: label.tag, kind: 'equation' })
    }
  }
  const citations = new Map<string, string>()
  for (const c of result.constructs) {
    if (c.kind === 'bibitem' && !citations.has(c.key)) citations.set(c.key, c.label)
  }
  return { scan: result, macros, macrosKey: JSON.stringify(macros), math, labels, citations }
}

export const analysisField = StateField.define<Analysis>({
  create: (state) => analyze(state.doc.toString()),
  update: (value, tr) => (tr.docChanged ? analyze(tr.state.doc.toString()) : value)
})
