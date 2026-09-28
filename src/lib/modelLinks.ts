import type { SupabaseClient } from '@supabase/supabase-js'
import { selectIn } from './chunkedIn'
import { fetchAllChunked, READ_CHUNK, type RangeableQuery } from './supabaseRead'
import { unlinkOperationsFromModels } from './modelOperations'
import { unlinkOperationTimesFromModel } from './operationTimes'

/**
 * "This doesn't apply to this model" — the complete unlink, at either level.
 *
 * ── This is an UNLINK, never a delete ─────────────────────────────────────────────────────
 * Nothing here removes a job, an operation, a time or a note. It removes the two rows that say
 * "this model does this work":
 *
 *   a) model_operations       — the applies-list. The operation is required for this model.
 *   b) operation_time_models  — the recorded runs that count towards this model.
 *
 * Both, always, together. (a) alone is what the guard in lib/modelOperations exists to prevent:
 * operation_times carries no product_id of its own, so dropping the applies-list row while the
 * junction rows survive leaves the model out of coverage while its minutes still land in that
 * model's total — the two figures then disagree and neither is wrong on its own terms. That
 * guard KEEPS timed pairs and reports them, which is right for every caller that removes only
 * (a). This module removes (b) first, which is what makes removing (a) safe rather than what
 * makes the guard skippable.
 *
 * ── Times are never deleted ───────────────────────────────────────────────────────────────
 * A run whose LAST model link is removed becomes UNATTACHED: zero rows in operation_time_models.
 * It stays in operation_times with its notes and still lists in /reports (which has an
 * "Unattached (no model)" filter for exactly this). That is a real, pre-existing state in this
 * database — historical records already carry no model — so it is one the app reads rather than
 * a hole this creates. `previewModelUnlink` names the runs that will end up there BEFORE the
 * write, because it is the one part of this that is not a one-click undo.
 *
 * ── Reversibility, stated honestly ────────────────────────────────────────────────────────
 * Re-linking the operation to the model is easy — Setup's model linker, one tick. Re-ATTACHING
 * an individual run to this model is not: nothing in the app offers "put this time back on that
 * model", and the run's own record no longer says which model it was for. The confirmation says
 * so in those words.
 *
 * ── One writer, still ─────────────────────────────────────────────────────────────────────
 * This module computes and sequences; it writes nothing itself. (a) goes through
 * lib/modelOperations' unlinkOperationsFromModels and (b) through lib/operationTimes'
 * unlinkOperationTimesFromModel, which remain the only functions that delete from their tables.
 * Both the job-level and the operation-level unlink call the SAME function here — the levels
 * differ only in how many operation ids they pass.
 */

/** One recorded run that the unlink will detach from this model. */
export interface AffectedTimePreview {
  id: string
  operationId: string
  operationName: string
  /** created_at, ISO — "date" in the confirmation. */
  createdAt: string
  minutes: number | null
  /** Models this run stays linked to afterwards. Empty means it becomes unattached. */
  otherModels: string[]
  /** No other model link — this run ends up in operation_times with nothing pointing at it. */
  becomesUnattached: boolean
}

export interface ModelUnlinkPreview {
  /** Of the operations asked about, the ones that actually have an applies-list row to remove. */
  linkedOperationIds: string[]
  /** Every run that will lose its link to this model, named so the confirmation can list them. */
  times: AffectedTimePreview[]
  /** How many of those end up attached to nothing. */
  unattachedCount: number
}

export interface ModelUnlinkResult {
  /** model_operations rows actually removed. */
  applicabilityUnlinked: number
  /** operation_time_models rows actually removed. */
  timeLinksRemoved: number
  /** Runs that are now attached to no model at all. */
  unattachedTimes: number
  /** Partial failures — reported, never swallowed. The batch is not transactional. */
  failures: string[]
}

/**
 * Everything the confirmation has to state, read before anything is written.
 *
 * Deliberately returns the affected runs themselves rather than a count: the requirement is to
 * say what will happen in NAMES, and "3 time records" does not let anyone check whether the
 * right three are about to be detached.
 */
export async function previewModelUnlink(
  supabase: SupabaseClient,
  productId: string,
  operationIds: string[]
): Promise<ModelUnlinkPreview> {
  if (operationIds.length === 0 || !productId) {
    return { linkedOperationIds: [], times: [], unattachedCount: 0 }
  }

  // Which of these operations the model actually claims. An operation with no applies-list row
  // still gets its time links cleaned up below — the two can drift, and this is the screen for
  // tidying exactly that — but only the linked ones are counted as applicability removals.
  const links = await fetchAllChunked<{ operation_id: string }>(
    operationIds, READ_CHUNK,
    (chunk) => supabase
      .from('model_operations').select('operation_id')
      .eq('product_id', productId).in('operation_id', chunk)
      .order('operation_id') as unknown as RangeableQuery<{ operation_id: string }>,
    { table: 'model_operations' }
  )
  const linkedOperationIds = [...new Set(links.map((l) => l.operation_id))]

  // Every run on these operations. Fans out (one operation, many runs), so chunked AND paged —
  // a truncated read here would leave a run silently attached to a model that no longer does it.
  const timeRows = await fetchAllChunked<{
    id: string; operation_id: string; total_minutes: number | null; created_at: string
  }>(
    operationIds, READ_CHUNK,
    (chunk) => supabase
      .from('operation_times').select('id, operation_id, total_minutes, created_at')
      .in('operation_id', chunk).order('id') as unknown as RangeableQuery<{
        id: string; operation_id: string; total_minutes: number | null; created_at: string
      }>,
    { table: 'operation_times' }
  )
  if (timeRows.length === 0) return { linkedOperationIds, times: [], unattachedCount: 0 }

  // Their model links — ALL of them, not just this product's, because "does this run still count
  // for something else?" is the question the confirmation has to answer per run.
  const timeModels = await fetchAllChunked<{ operation_time_id: string; product_id: string }>(
    timeRows.map((t) => t.id), READ_CHUNK,
    (chunk) => supabase
      .from('operation_time_models').select('operation_time_id, product_id')
      .in('operation_time_id', chunk)
      .order('operation_time_id').order('product_id') as unknown as RangeableQuery<{ operation_time_id: string; product_id: string }>,
    { table: 'operation_time_models' }
  )

  const productsByTime = new Map<string, string[]>()
  for (const tm of timeModels) {
    const list = productsByTime.get(tm.operation_time_id)
    if (list) list.push(tm.product_id)
    else productsByTime.set(tm.operation_time_id, [tm.product_id])
  }

  // Only runs actually linked to THIS model are affected. A run on the same operation recorded
  // against a different model is none of this unlink's business.
  const affected = timeRows.filter((t) => (productsByTime.get(t.id) ?? []).includes(productId))
  if (affected.length === 0) return { linkedOperationIds, times: [], unattachedCount: 0 }

  const otherProductIds = [...new Set(
    affected.flatMap((t) => (productsByTime.get(t.id) ?? []).filter((id) => id !== productId))
  )]
  const [operations, otherProducts] = await Promise.all([
    // Primary-key lookups — selectIn (chunk only) is complete for both.
    selectIn<{ id: string; name: string }>(
      [...new Set(affected.map((t) => t.operation_id))],
      (chunk) => supabase.from('operations').select('id, name').in('id', chunk)
    ),
    selectIn<{ id: string; model: string }>(
      otherProductIds,
      (chunk) => supabase.from('products').select('id, model').in('id', chunk)
    ),
  ])
  const operationNameById = new Map(operations.map((o) => [o.id, o.name]))
  const modelNameById = new Map(otherProducts.map((p) => [p.id, p.model]))

  const times: AffectedTimePreview[] = affected.map((t) => {
    const others = (productsByTime.get(t.id) ?? [])
      .filter((id) => id !== productId)
      .map((id) => modelNameById.get(id) ?? '(unknown model)')
      .sort((a, b) => a.localeCompare(b))
    return {
      id: t.id,
      operationId: t.operation_id,
      operationName: operationNameById.get(t.operation_id) ?? '—',
      createdAt: t.created_at,
      minutes: t.total_minutes,
      otherModels: others,
      becomesUnattached: others.length === 0,
    }
  })
  // Newest first, and by operation within a day — the order somebody reads a list of runs in.
  times.sort((a, b) => {
    const byDate = b.createdAt.localeCompare(a.createdAt)
    return byDate !== 0 ? byDate : a.operationName.localeCompare(b.operationName)
  })

  return {
    linkedOperationIds,
    times,
    unattachedCount: times.filter((t) => t.becomesUnattached).length,
  }
}

/**
 * Do it. The ONE path for both levels — a job-level unlink is this with every operation id in the
 * job, an operation-level unlink is this with one.
 *
 * ORDER IS LOAD-BEARING. The time links go first, the applies-list row second:
 *
 *   - links then applicability: a failure in between leaves the model still claiming the
 *     operation with no times against it. Visible on screen as "not timed", correct on its own
 *     terms, and fixed by running the unlink again.
 *   - applicability then links: a failure in between leaves the model NOT claiming the operation
 *     while its runs still count towards that model's total — the coverage/total disagreement
 *     lib/modelOperations' guard exists to prevent, and invisible until somebody queries why the
 *     numbers don't add up.
 *
 * The empty `timedPairs` set passed to unlinkOperationsFromModels is not a bypass of that guard.
 * The guard's contract is "pass an empty set only when the caller has already proven none of the
 * pairs are timed", and by that line it is literally true: the links that made them timed for
 * this model were removed on the line above.
 */
export async function unlinkOperationsFromModel(
  supabase: SupabaseClient,
  productId: string,
  operationIds: string[]
): Promise<ModelUnlinkResult> {
  const result: ModelUnlinkResult = {
    applicabilityUnlinked: 0, timeLinksRemoved: 0, unattachedTimes: 0, failures: [],
  }
  if (operationIds.length === 0 || !productId) return result

  // Re-read rather than trusting a preview the user may have been looking at for a while — this
  // also yields the exact ids to delete and the unattached count actually achieved.
  const preview = await previewModelUnlink(supabase, productId, operationIds)

  // 1. The recorded runs stop counting for this model. Nothing is deleted from operation_times.
  if (preview.times.length > 0) {
    const { removed, attempted, error } = await unlinkOperationTimesFromModel(
      supabase, preview.times.map((t) => t.id), productId
    )
    result.timeLinksRemoved = removed
    if (error) result.failures.push(`Unlinking recorded times: ${error}`)
    else if (removed < attempted) {
      result.failures.push(
        `${attempted - removed} recorded time link${attempted - removed === 1 ? '' : 's'} could not be ` +
        'removed — the delete was rejected by the database (check your permissions).'
      )
    }
    // Counted from what the preview established, narrowed to what actually came off.
    result.unattachedTimes = removed === 0 ? 0 : preview.unattachedCount
  }

  // 2. The model stops requiring the operation. Safe now, and only now — see the note above.
  if (preview.linkedOperationIds.length > 0) {
    const { unlinked, attempted, error } = await unlinkOperationsFromModels(
      supabase,
      preview.linkedOperationIds.map((operation_id) => ({ operation_id, product_id: productId })),
      new Set()
    )
    result.applicabilityUnlinked = unlinked
    if (error) result.failures.push(`Unlinking operations from the model: ${error}`)
    else if (unlinked < attempted) {
      result.failures.push(
        `${attempted - unlinked} operation${attempted - unlinked === 1 ? '' : 's'} could not be unlinked ` +
        '— the delete was rejected by the database (check your permissions).'
      )
    }
  }

  return result
}
