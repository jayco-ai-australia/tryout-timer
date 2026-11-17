import type { OperationTimeStat } from './operationTimes'

/**
 * ── Where a FIGURE came from: measured or estimated ────────────────────────────────────────
 *
 * The one rule for colouring a minutes figure green (measured) or orange (estimated). Written
 * for the Labour Matrix and moved here unchanged so /collect's Models — coverage badges answer
 * the same way; the colours are globals.css's --measured-bg and --estimated-bg.
 *
 * Two steps:
 *   1. ONE (operation, model) figure is estimated when the record the shared helper picked for
 *      it (stat.currentId) is an estimate. Asked of the picked record, never decided again here,
 *      so the colour describes the very figure shown.
 *   2. SEVERAL figures added together (a Matrix cell is every timed operation under a job,
 *      section or team) are estimated if ANY of them is: a figure partly inferred is inferred.
 *
 * NOT the same question as lib/coverage's estimateOnlyComboKeys, where a combo covered by one
 * measured and one estimated operation counts as MEASURED. That one asks "would this stay covered
 * without the estimates?"; this one asks "is any of this number inferred?".
 */

export type FigureSource = 'measured' | 'estimated'

/** The ids of the estimated records among `times`, for isEstimatedFigure. */
export function estimatedTimeIds(times: { id: string; is_estimated: boolean }[]): Set<string> {
  return new Set(times.filter((t) => t.is_estimated).map((t) => t.id))
}

/** Step 1 — is this one (operation, model) figure an estimate? */
export function isEstimatedFigure(stat: Pick<OperationTimeStat, 'currentId'>, estimatedIds: Set<string>): boolean {
  return estimatedIds.has(stat.currentId)
}

/** Step 2 — the source of a figure built from `timedCount` figures, `estimatedCount` of them
 * estimated (step 1). Null when nothing is timed: there is no figure to source. */
export function figureSource(timedCount: number, estimatedCount: number): FigureSource | null {
  if (timedCount === 0) return null
  return estimatedCount > 0 ? 'estimated' : 'measured'
}
