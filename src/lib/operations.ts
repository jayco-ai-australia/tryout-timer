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
