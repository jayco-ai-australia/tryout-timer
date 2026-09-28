import type { SupabaseClient } from '@supabase/supabase-js'
import { operationProductKey } from './operationTimes'
import { fetchAllChunked, fetchAllRows } from './supabaseRead'

/**
 * The single model_operations module — every screen that links or unlinks an operation to a
 * model goes through the helpers here.
 *
 * model_operations is the applies-list: one row per (operation, product) pair meaning "this
 * operation applies to this model". It is the ONLY place applicability is recorded — there is
 * no job→model or section→model link anywhere. A job "applies to a model" iff at least one of its
 * operations does (see jobsApplying below), and sections are line-level structure that is never
 * model-scoped at all.
 *
 * Three screens write it and they must not drift:
 *   - /setup's bulk drawer (many operations × many models, Add or Replace),
 *   - ModelLinker's per-model and per-series toggles (one operation × many models),
 *   - /tryouts' job-level and per-operation toggles (many operations × one model).
 * They differ only in which pairs they compute; the reads, the chunking, the upsert/delete
 * shape and — critically — the "never unlink a pair that has recorded times" guard all live
 * here.
 *
 * That guard is the reason unlinking is never a plain delete: operation_times carries no
 * product_id of its own (it joins through operation_time_models), so a pair that has been
 * timed is real evidence the operation applies. Dropping such a link would hide a model from
 * coverage while its times still count towards that model's total — the two would disagree.
 * unlinkOperationsFromModels keeps those pairs and reports them instead.
 *
 * These reads deliberately do NOT filter operation_times.is_active — see the note at the top of
 * lib/operationTimes.ts. In this database that flag marks a superseded import batch, not an
 * admin-hidden row, and filtering on it here would wave through unlinks of pairs that carry the
 * bulk of their model's recorded history.
 *
 * They do not filter superseded_by either, for the same shape of reason. The question these
 * guards ask is "has this pair ever been timed?" — which is what authorises an unlink — not
 * "what is its labour figure?". A pair whose records have all been superseded has been timed,
 * and filtering to the current record would wave through unlinks that orphan real history.
 */

/** PostgREST caps how much a single `.in(...)` filter or insert payload can carry comfortably,
 * so every bulk read/write below is chunked. Reads use the smaller size because their ids go
 * into the URL — that size and the chunker itself now live in lib/supabaseRead alongside the
 * OTHER limit a bulk read has to respect (the row cap on what one response can return), and are
 * re-exported here so the many callers that import them from this module still can. */
export { chunked, READ_CHUNK } from './supabaseRead'
import { chunked, READ_CHUNK } from './supabaseRead'

/** Insert/upsert payload size. Not a URL concern, so it stays larger and stays here. */
export const WRITE_CHUNK = 500

/** One (operation, product) applies-list row. */
export interface ModelOperationPair { operation_id: string; product_id: string }

// ── Reads ──────────────────────────────────────────────────────────────────────────────────

/** Every applies-list row for a set of operations, across all models. */
export async function fetchLinksForOperations(
  supabase: SupabaseClient,
  operationIds: string[]
): Promise<ModelOperationPair[]> {
  if (operationIds.length === 0) return []
  return fetchAllChunked<ModelOperationPair>(
    operationIds, READ_CHUNK,
    (chunk) => supabase
      .from('model_operations').select('operation_id, product_id').in('operation_id', chunk)
      .order('operation_id').order('product_id'),
    { table: 'model_operations' }
  )
}

/**
 * The operations that apply to one model. Filtered by product_id ALONE — no line, team or
 * is_active filter anywhere in the chain, the same contract fetchModelTotal holds itself to.
 * "Applies to this model" means every van of it, so a filter here would quietly under-report.
 */
export async function fetchOperationIdsForModel(
  supabase: SupabaseClient,
  productId: string
): Promise<Set<string>> {
  const rows = await fetchAllRows<{ operation_id: string }>(
    () => supabase
      .from('model_operations').select('operation_id').eq('product_id', productId)
      .order('operation_id').order('product_id'),
    { table: 'model_operations' }
  )
  return new Set(rows.map((r) => r.operation_id))
}

/**
 * The (operation, product) pairs that already have a recorded time — the unlink guard, keyed
 * with the shared operationProductKey so it lines up with every other pair-keyed map in the
 * app. Joined through operation_time_models because operation_times has no product_id column.
 *
 * BOTH reads are paged (lib/supabaseRead), and that is a correctness requirement rather than a
 * completeness nicety. This set is consulted as "a pair NOT in here has no recorded times, so
 * it is safe to delete" — the absence of a pair is what authorises the delete. A read truncated
 * at the row cap therefore FAILS OPEN: the missing pairs look untimed and get unlinked, orphaning
 * their operation_times behind a link that no longer exists. There is no error to catch on that
 * path; a capped response is a normal 200. Every query below carries a total order over its
 * primary key, without which paging could skip a row and reproduce the same hole.
 */
export async function fetchTimedPairs(
  supabase: SupabaseClient,
  operationIds: string[]
): Promise<Set<string>> {
  const pairs = new Set<string>()
  if (operationIds.length === 0) return pairs

  const timeRows = await fetchAllChunked<{ id: string; operation_id: string }>(
    operationIds, READ_CHUNK,
    (chunk) => supabase
      .from('operation_times').select('id, operation_id').in('operation_id', chunk)
      .order('id'),
    { table: 'operation_times' }
  )

  const opByTimeId = new Map(timeRows.map((t) => [t.id, t.operation_id]))
  const linkRows = await fetchAllChunked<{ operation_time_id: string; product_id: string }>(
    [...opByTimeId.keys()], READ_CHUNK,
    (chunk) => supabase
      .from('operation_time_models').select('operation_time_id, product_id').in('operation_time_id', chunk)
      .order('operation_time_id').order('product_id'),
    { table: 'operation_time_models' }
  )
  for (const r of linkRows) {
    const opId = opByTimeId.get(r.operation_time_id)
    if (opId) pairs.add(operationProductKey(opId, r.product_id))
  }
  return pairs
}

/**
 * The operations that have at least one recorded time for ONE model — the same guard as
 * fetchTimedPairs, narrowed to a single product so a screen scoped to one model (e.g. a
 * /tryouts van) can ask the cheap question directly.
 *
 * Returns null when the lookup fails rather than an empty set: "we don't know" and "nothing is
 * timed" must never be confused, because the caller uses this to decide whether unlinking is
 * allowed, and an empty set would wave every unlink through.
 *
 * The same fail-open hazard fetchTimedPairs carries applies here, and null only covers the half
 * of it that raises an error. A SHORT read raises nothing — it just answers "fewer operations
 * are timed than really are", which permits an unlink that should have been refused. That is why
 * both reads are paged rather than merely chunked.
 */
export async function fetchTimedOperationIdsForModel(
  supabase: SupabaseClient,
  productId: string
): Promise<Set<string> | null> {
  // The paged helpers throw where the old inline reads returned an error object, so the whole
  // chain is wrapped to keep this function's contract exactly as it was: any failure — including
  // a page failing halfway through — is null, never a partial set. A partial set here reads as
  // "these operations are timed and no others", which is the answer that lets a timed pair be
  // unlinked.
  try {
    const linkRows = await fetchAllRows<{ operation_time_id: string }>(
      () => supabase
        .from('operation_time_models').select('operation_time_id').eq('product_id', productId)
        .order('operation_time_id').order('product_id'),
      { table: 'operation_time_models' }
    )
    const timeIds = [...new Set(linkRows.map((r) => r.operation_time_id))]
    const timeRows = await fetchAllChunked<{ operation_id: string }>(
      timeIds, READ_CHUNK,
      (chunk) => supabase
        .from('operation_times').select('operation_id').in('id', chunk).order('id'),
      { table: 'operation_times' }
    )
    return new Set(timeRows.map((r) => r.operation_id))
  } catch {
    return null
  }
}

// ── Derivation ─────────────────────────────────────────────────────────────────────────────

/**
 * Which jobs apply to a model: a job applies iff at least one of its operations does. There is
 * no job→model row and there must never be one — a derived answer can't fall out of step with
 * the operation links the way a stored duplicate would.
 */
export function jobsApplying(
  operationsByJob: Record<string, { id: string }[]>,
  linkedOperationIds: Set<string>
): Set<string> {
  const jobIds = new Set<string>()
  for (const [jobId, operations] of Object.entries(operationsByJob)) {
    if (operations.some((o) => linkedOperationIds.has(o.id))) jobIds.add(jobId)
  }
  return jobIds
}

// ── Writes ─────────────────────────────────────────────────────────────────────────────────

export interface BulkLinkResult {
  /** Pairs written (upserted). */
  linked: number
  attempted: number
  /** The first failure, if any — the rest of the batch is still attempted. */
  error: string | null
}

/**
 * The only function anywhere that inserts into model_operations. Upsert rather than insert so a
 * pair that already exists is a no-op instead of a duplicate-key error that fails the whole
 * batch — every caller's "link these" means "make sure these exist", not "these are new".
 */
export async function linkOperationsToModels(
  supabase: SupabaseClient,
  pairs: ModelOperationPair[]
): Promise<BulkLinkResult> {
  let linked = 0
  let error: string | null = null
  for (const chunk of chunked(pairs, WRITE_CHUNK)) {
    const { error: err } = await supabase
      .from('model_operations').upsert(chunk, { onConflict: 'operation_id,product_id' })
    if (err) error ??= err.message
    else linked += chunk.length
  }
  return { linked, attempted: pairs.length, error }
}

export interface BulkUnlinkResult {
  unlinked: number
  /** Pairs actually sent for deletion — excludes everything held back by the timed guard. */
  attempted: number
  /** Pairs kept because they have recorded times. Never silently dropped: a caller is expected
   * to tell the user how many were kept and why. */
  kept: ModelOperationPair[]
  error: string | null
}

/**
 * The only function anywhere that deletes from model_operations by (operation, product).
 *
 * `timedPairs` is the guard — pass the set from fetchTimedPairs (or build one from
 * fetchTimedOperationIdsForModel for a single-model screen) and any pair in it is kept and
 * returned in `kept` instead of being deleted. Pass an empty set only when the caller has
 * already proven none of the pairs are timed; passing nothing at all is refused, because a
 * missing guard is indistinguishable from a guard that found nothing.
 */
export async function unlinkOperationsFromModels(
  supabase: SupabaseClient,
  pairs: ModelOperationPair[],
  timedPairs: Set<string>
): Promise<BulkUnlinkResult> {
  const kept: ModelOperationPair[] = []
  const deletable: ModelOperationPair[] = []
  for (const pair of pairs) {
    if (timedPairs.has(operationProductKey(pair.operation_id, pair.product_id))) kept.push(pair)
    else deletable.push(pair)
  }

  // Grouped by operation so each delete is one `eq(operation_id) + in(product_id)` round trip
  // rather than one per pair. PostgREST has no multi-column `in`, so this is the shape.
  const productIdsByOp = new Map<string, string[]>()
  for (const pair of deletable) {
    const list = productIdsByOp.get(pair.operation_id)
    if (list) list.push(pair.product_id)
    else productIdsByOp.set(pair.operation_id, [pair.product_id])
  }

  // The deleted rows are read back rather than assumed: a delete filtered out by RLS comes
  // back successful having removed nothing, so `unlinked` counts what the database actually
  // dropped, not what was asked for. A caller comparing it to `attempted` sees the rejection.
  let unlinked = 0
  let error: string | null = null
  for (const [operationId, productIds] of productIdsByOp) {
    for (const chunk of chunked(productIds, READ_CHUNK)) {
      const { data, error: err } = await supabase
        .from('model_operations').delete()
        .eq('operation_id', operationId).in('product_id', chunk)
        .select('operation_id')
      if (err) error ??= err.message
      else unlinked += (data ?? []).length
    }
  }

  return { unlinked, attempted: deletable.length, kept, error }
}

/** One operation, one model — the single-pair form of linkOperationsToModels. */
export async function linkOperationToModel(
  supabase: SupabaseClient,
  operationId: string,
  productId: string
): Promise<void> {
  const { error } = await linkOperationsToModels(supabase, [{ operation_id: operationId, product_id: productId }])
  if (error) throw new Error(error)
}

/**
 * One operation, one model — the single-pair form of unlinkOperationsFromModels. Throws when
 * the pair is timed rather than returning it in `kept`: a single toggle has one outcome to
 * report, and the caller shows the message.
 */
export async function unlinkOperationFromModel(
  supabase: SupabaseClient,
  operationId: string,
  productId: string,
  timedPairs: Set<string>
): Promise<void> {
  const result = await unlinkOperationsFromModels(
    supabase, [{ operation_id: operationId, product_id: productId }], timedPairs
  )
  if (result.error) throw new Error(result.error)
  if (result.kept.length > 0) {
    throw new Error('That operation has recorded times for this model, so it clearly applies and can\'t be unlinked.')
  }
  if (result.unlinked === 0) {
    throw new Error(
      'That link could not be removed — the delete was rejected. Removing a model link may be ' +
      'restricted to admins in this environment.'
    )
  }
}
