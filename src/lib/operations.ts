import type { SupabaseClient } from '@supabase/supabase-js'
import { WRITE_CHUNK, chunked } from './modelOperations'
import type { Operation } from './types'

/**
 * The single operations-creation module — every screen that adds an operation goes through
 * here, so the defaults can't drift between the four places that create one (/setup's form
 * with its operator assignment, NewOperationModal on /tryouts and /collect, and /collect's
 * quick-add and paste rows).
 *
 * The default that matters is `is_active: true`, written explicitly rather than left to the
 * column default: is_active = false is the retired-by-merge state, and an operation born
 * retired would be invisible on every screen in the app the moment it was created, with no
 * error to explain why.
 *
 * Operator assignment is deliberately optional and defaulted to null. On the collection
 * screens the operator is picked per captured time, not per operation, so those callers pass
 * nothing; /setup's form is the one place that assigns a primary/secondary up front.
 */

export interface CreateOperationInput {
  name: string
  jobId: string
  primaryOperatorId?: string | null
  secondaryOperatorId?: string | null
}

/** The row shape every insert here writes. Keeping it in one function is the point — it is
 * what stops one caller forgetting is_active and creating an operation nobody can see. */
function operationRow(input: CreateOperationInput) {
  return {
    name: input.name.trim(),
    job_id: input.jobId,
    primary_operator_id: input.primaryOperatorId || null,
    secondary_operator_id: input.secondaryOperatorId || null,
    is_active: true,
  }
}

/** The only function anywhere that inserts a single operation. Reads the row back so an RLS
 * rejection surfaces as an error rather than a list that quietly doesn't change. */
export async function createOperation(
  supabase: SupabaseClient,
  input: CreateOperationInput
): Promise<Operation> {
  const name = input.name.trim()
  if (!name) throw new Error('Operation name must not be empty')
  if (!input.jobId) throw new Error('An operation needs a job')

  const { data, error } = await supabase
    .from('operations').insert(operationRow({ ...input, name })).select('*').single()
  if (error || !data) throw new Error(error?.message ?? 'Could not create operation')
  return data as Operation
}

/**
 * Turns pasted text into the operation names it describes: one per line, trimmed, blank lines
 * dropped. Repeats within the paste are dropped case-insensitively — a pasted list is exactly
 * where the same name appears twice, and two identical operations under one job is the mess
 * /setup has a whole merge mode to clean up. Only the paste is de-duplicated; names that
 * already exist under the job are left alone, because a caller here can't tell a genuine
 * re-add from a mistake.
 */
export function parseOperationNames(text: string): { names: string[]; duplicatesDropped: number } {
  const seen = new Set<string>()
  const names: string[] = []
  let duplicatesDropped = 0
  for (const line of text.split('\n')) {
    const name = line.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) { duplicatesDropped++; continue }
    seen.add(key)
    names.push(name)
  }
  return { names, duplicatesDropped }
}

/**
 * Many operations under one job in a single write. Rows are read back and counted rather than
 * assumed, so a partial RLS rejection is reported as "created 3 of 7" instead of passing for
 * success — the same contract the model_operations bulk helpers hold themselves to.
 */
export async function createOperations(
  supabase: SupabaseClient,
  jobId: string,
  names: string[]
): Promise<{ created: Operation[]; attempted: number; error: string | null }> {
  if (!jobId) throw new Error('An operation needs a job')
  const rows = names.map((name) => operationRow({ name, jobId })).filter((r) => r.name)
  const created: Operation[] = []
  let error: string | null = null

  for (const chunk of chunked(rows, WRITE_CHUNK)) {
    const { data, error: err } = await supabase.from('operations').insert(chunk).select('*')
    if (err) error ??= err.message
    else created.push(...((data ?? []) as Operation[]))
  }
  return { created, attempted: rows.length, error }
}

/**
 * The only function anywhere that writes operations.job_id — /setup's "Move to job" modal and
 * lib/jobs' mergeJobs both go through it, so re-filing an operation means the same thing however
 * it is reached.
 *
 * An operation's recorded times, notes and model links ride along untouched: they hang off
 * operation_id, not job_id, so nothing has to be migrated when the operation changes job.
 *
 * The row is read back because an update filtered out by RLS succeeds having changed nothing —
 * the failure mode that would let a merge retire a job with operations still pointing at it.
 */
export async function setOperationJob(
  supabase: SupabaseClient,
  operationId: string,
  jobId: string
): Promise<void> {
  if (!jobId) throw new Error('An operation needs a job')
  const { data, error } = await supabase
    .from('operations').update({ job_id: jobId }).eq('id', operationId).select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error("That operation's job could not be changed — the change was rejected by the database (check your permissions).")
  }
}

/**
 * Retire an operation — the soft delete. `is_active = false`, and nothing else is touched.
 *
 * What mergeOperations does to the duplicates it folds away, exposed on its own for a structural
 * screen that wants to hide an operation with no keeper to merge it into.
 *
 * Deliberately NOT a `.delete()`. /setup deletes the row outright and can only offer it when the
 * operation has no recorded times, because `operation_times.operation_id` and
 * `model_operations.operation_id` both cascade — a hard delete destroys the collected history and
 * the applies-list with it. Retiring keeps every one of those rows: the times still exist, the
 * model links still exist, and reactivating the row in the database brings the whole thing back.
 * That is what makes this offerable on an operation that HAS been timed, which is the common
 * case on a line somebody is tidying.
 *
 * Read back for the same reason every other writer here reads back: an update filtered out by
 * RLS succeeds having changed nothing.
 */
export async function retireOperation(supabase: SupabaseClient, operationId: string): Promise<void> {
  const { data, error } = await supabase
    .from('operations').update({ is_active: false }).eq('id', operationId).select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error('That operation could not be retired — the change was rejected by the database (check your permissions).')
  }
}

/**
 * Bring a retired operation back — the inverse of retireOperation.
 *
 * Exists for one caller: lib/jobs' job merge. `operations_name_job_id_key` is a plain
 * UNIQUE (name, job_id) and takes no notice of is_active, so a RETIRED operation on the keeper
 * still owns its name there. An arriving active operation of that name therefore has to fold
 * into it — and the combined row then holds live, current work, so leaving it retired would
 * hide real history behind a merge the user asked for. See the collision walk in lib/jobs.
 *
 * Read back for the same reason every other writer here reads back: an update filtered out by
 * RLS succeeds having changed nothing.
 */
export async function reactivateOperation(supabase: SupabaseClient, operationId: string): Promise<void> {
  const { data, error } = await supabase
    .from('operations').update({ is_active: true }).eq('id', operationId).select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error('That operation could not be brought back — the change was rejected by the database (check your permissions).')
  }
}

/**
 * THE definition of "these two operations have the same name", and the only one anywhere.
 *
 * Trimmed and case-folded, which is deliberately WIDER than the database's own idea of a
 * duplicate: `operations_name_job_id_key` compares names byte for byte, so "PSCL" and "pscl"
 * are two legal rows under one job. Every pair the constraint would reject is caught by this,
 * plus the handful it would wave through — and those are duplicates by any human reading, which
 * is what the job merge's collision walk is for.
 */
export function operationNameKey(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * The only function anywhere that updates operations.name. Reads the row back so a rename
 * rejected by RLS surfaces as an error rather than a list that quietly refreshes unchanged.
 */
export async function renameOperation(
  supabase: SupabaseClient,
  operationId: string,
  name: string
): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Operation name must not be empty')
  const { data, error } = await supabase
    .from('operations').update({ name: trimmed }).eq('id', operationId).select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error('That operation could not be renamed — the change was rejected by the database (check your permissions).')
  }
}
