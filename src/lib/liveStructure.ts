import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * "Is this piece of structure live?" — for the lists that OFFER structure (pickers, panes, a
 * Start button), as lib/operationTimes' TIME_PARENT_JOIN / hasRetiredParent is for the times
 * recorded under it. The same soft-delete flags, read the same way: null and true are live, only
 * false is retired (the columns are nullable here, so `!== false`, never `=== true`).
 *
 * The chain runs one level further than the labour rule. A time's figure depends on its
 * operation and job; whether something may be OFFERED also depends on the section, because a
 * live job inside a merged-away section is still dead structure — every section list hides
 * that section, so its jobs fall into whatever bucket a screen keeps for strays and are offered
 * from there. Retiring a parent retires everything under it:
 *
 *   operations.is_active IS NOT FALSE
 *   AND its job's is_active IS NOT FALSE
 *   AND that job's section (when it has one) is_active IS NOT FALSE
 *
 * Filtering one level at a time (`.eq('is_active', true)` on each query) is fine when every
 * child is reached THROUGH a parent that was itself filtered. It is not enough when a child is
 * reached any other way — a job read by production line, a pre-filled id, a timer restored from
 * localStorage, a page loaded before the structure was cleaned up. Those go through here.
 */

/** sections.is_active, as embedded under a job. */
export interface SectionLiveFlag { is_active: boolean | null }

/** A job with its section's flag embedded — select with JOB_PARENT_CHAIN. `sections` is null
 * for an unsectioned job, which is live as far as the section goes. */
export interface JobLiveChain {
  is_active: boolean | null
  sections: SectionLiveFlag | null
}

/** An operation with its job and section flags embedded — select with OPERATION_PARENT_CHAIN. */
export interface OperationLiveChain {
  is_active: boolean | null
  jobs: JobLiveChain | null
}

/** The embed a jobs select appends to bring back JobLiveChain. A left join: an unsectioned job
 * must still come back. */
export const JOB_PARENT_CHAIN: string = 'sections ( is_active )'

/** The embed an operations select appends to bring back OperationLiveChain. */
export const OPERATION_PARENT_CHAIN: string = `jobs ( is_active, ${JOB_PARENT_CHAIN} )`

/** The job and its section are both live. */
export function isLiveJob(job: JobLiveChain): boolean {
  return job.is_active !== false && job.sections?.is_active !== false
}

/** Which level of an operation's chain is retired, highest first, or null when all of it is
 * live. A job that did not come back at all is treated as retired — the operation is
 * unreachable, and offering it would be the silent failure this module exists to prevent. */
export function retiredLevel(op: OperationLiveChain): 'section' | 'job' | 'operation' | null {
  if (!op.jobs) return 'job'
  if (op.jobs.sections?.is_active === false) return 'section'
  if (op.jobs.is_active === false) return 'job'
  if (op.is_active === false) return 'operation'
  return null
}

/** The operation, its job and its section are all live. */
export function isLiveOperation(op: OperationLiveChain): boolean {
  return retiredLevel(op) === null
}

/**
 * One operation's chain, read fresh. For the moments a screen is about to act on an operation it
 * did not just read — Start on a page that may have loaded before a cleanup, Complete on a timer
 * that may have been running since before one. null when the operation no longer exists.
 */
export async function fetchOperationLiveChain(
  supabase: SupabaseClient,
  operationId: string
): Promise<OperationLiveChain | null> {
  const { data, error } = await supabase
    .from('operations').select(`is_active, ${OPERATION_PARENT_CHAIN}`).eq('id', operationId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as unknown as OperationLiveChain | null) ?? null
}
