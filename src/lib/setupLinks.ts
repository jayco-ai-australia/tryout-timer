/**
 * Deep links into /setup.
 *
 * Same mechanism as /reports' (lib/reports' reportFiltersFromParams / buildReportHref) and
 * deliberately the same shape: one PARAM_KEYS map read by both a parser and a builder, resolved
 * SERVER-side from the page's `searchParams` and handed down as props. Not a second approach —
 * a second module for a second screen's params, so that adding a link somewhere never means
 * inventing a new way to carry state between screens.
 *
 * What this is for: /model-total's row menu offers "Merge with another job…", and merge is a
 * GLOBAL structural operation — it moves times and notes, soft-deletes the losing job and
 * affects every model on the line, not just the one being viewed. It must not be executable
 * from a single model's screen. So the menu item navigates HERE instead, with the line, section
 * and job already picked and merge mode already open on that job, leaving the user to choose
 * the target on the screen that owns the operation.
 */

const PARAM_KEYS = {
  line: 'line',
  section: 'section',
  job: 'job',
  operation: 'operation',
  /** Which merge pane to open, if any. */
  merge: 'merge',
} as const

/** Which level's merge mode to arm on arrival. */
export type SetupMergeLevel = 'job' | 'operation'
const VALID_MERGE: SetupMergeLevel[] = ['job', 'operation']

/** Where a link wants /setup to be pointing when it opens. Blank = "say nothing, use whatever
 * the screen remembers". */
export interface SetupFocus {
  lineId: string
  /** A section id, or FinderPanes' UNSECTIONED_KEY. Passed through verbatim. */
  sectionKey: string
  jobId: string
  operationId: string
  /** null = don't arm merge mode, just navigate. */
  merge: SetupMergeLevel | null
}

export const NO_SETUP_FOCUS: SetupFocus = {
  lineId: '', sectionKey: '', jobId: '', operationId: '', merge: null,
}

type ParamValue = string | string[] | undefined
function one(value: ParamValue): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

/**
 * Focus from a URL. Unrecognised values are dropped rather than rejected — a stale link should
 * open a usable Setup screen, not an error page, and every field is independently optional.
 */
export function setupFocusFromParams(params: Record<string, ParamValue>): SetupFocus {
  const rawMerge = one(params[PARAM_KEYS.merge]) as SetupMergeLevel
  return {
    lineId: one(params[PARAM_KEYS.line]),
    sectionKey: one(params[PARAM_KEYS.section]),
    jobId: one(params[PARAM_KEYS.job]),
    operationId: one(params[PARAM_KEYS.operation]),
    merge: VALID_MERGE.includes(rawMerge) ? rawMerge : null,
  }
}

/** The inverse — only what is actually set is written, so the URL stays readable. */
export function buildSetupHref(focus: Partial<SetupFocus>): string {
  const q = new URLSearchParams()
  if (focus.lineId) q.set(PARAM_KEYS.line, focus.lineId)
  if (focus.sectionKey) q.set(PARAM_KEYS.section, focus.sectionKey)
  if (focus.jobId) q.set(PARAM_KEYS.job, focus.jobId)
  if (focus.operationId) q.set(PARAM_KEYS.operation, focus.operationId)
  if (focus.merge) q.set(PARAM_KEYS.merge, focus.merge)
  const qs = q.toString()
  return qs ? `/setup?${qs}` : '/setup'
}
