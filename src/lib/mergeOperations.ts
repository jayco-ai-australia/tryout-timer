import type { SupabaseClient } from '@supabase/supabase-js'
import { READ_CHUNK, chunked, fetchLinksForOperations, linkOperationsToModels } from './modelOperations'
import { fetchAllRows } from './supabaseRead'

/**
 * The least an operation has to be for this module to fold it away. Deliberately NOT the full
 * `Operation` row: lib/jobs' job merge reaches this path holding rows it read itself (id, name
 * and is_active off `operations`), and widening the parameter is what lets it call THIS merge
 * rather than growing a second one of its own.
 */
export interface MergeableOperation {
  id: string
  name: string
  /** Only read to record whether a reversal has to bring the duplicate back. */
  is_active?: boolean
}

/**
 * The single operation-merge module — /setup, /tryouts and /collect all fold duplicate
 * operations into a keeper through here, so the order of writes, the RLS guard and what counts
 * as a completed merge can't drift between the three screens that offer it.
 *
 * A merge re-points every operation_time from each duplicate onto the keeper, then flips the
 * duplicate to is_active = false. Notes and time-model links ride along untouched — both hang
 * off operation_time_id, not operation_id — so no time or note is created, deleted or edited;
 * they only change which operation they belong to.
 *
 * Applies-list rows (model_operations) are UNIONED onto the keeper and then cleared off the
 * duplicate. Clearing them is required — a retired operation still carrying them keeps counting
 * towards a model's coverage while no screen shows it — but clearing them WITHOUT first putting
 * them on the keeper loses real applicability: the duplicate's times have just moved to the
 * keeper carrying their own operation_time_models rows, so those minutes go on counting towards
 * a model the keeper is no longer listed as doing. The upsert de-duplicates, so a model both
 * operations already applied to is one row before and one row after.
 *
 * ── The guard ─────────────────────────────────────────────────────────────────────────────
 * A time collected by somebody else is not ours to move: an update touching one can come back
 * successful having changed nothing, so a merge run blind would retire a duplicate and strand
 * real times on a row no screen lists any more.
 *
 * preflightMerge answers that BEFORE anything is written: it reads collected_by across the
 * whole selection and refuses the merge outright if any time in it belongs to another, real
 * user. All-or-nothing is the point — a merge that half-completes leaves the operation list in
 * a state nobody chose, and the user can't tell which half moved.
 *
 * A NULL collected_by is NOT a blocker. It means ownerless, not someone else's: the great
 * majority of this database's times were imported rather than collected through the app, and
 * they carry no owner at all. Treating null as foreign made the guard refuse nearly every
 * merge on real data — the duplicates worth merging are exactly the imported ones. Ownerless
 * times move with the merge like the user's own.
 *
 * That is an app-level decision about what the user is allowed to attempt; whether the
 * database accepts the update is a separate question its UPDATE policy answers. If a policy of
 * `collected_by = auth.uid()` is in force, null-owner rows are rejected there regardless of
 * what this guard permits — which is precisely what the post-move re-count below catches.
 *
 * The post-move re-count is kept as well, and deliberately: the preflight proves no row is
 * owned by another user, not that every policy on the table will allow the write. If anything
 * is still left behind, the duplicate is kept ACTIVE and named.
 */

/** A duplicate that can't be merged, and why — one entry per operation holding times that
 * belong to another, real user. Ownerless (null collected_by) times never appear here. */
export interface MergeBlocker {
  operationId: string
  operationName: string
  /** How many of its times were collected by a different, non-null user. */
  foreignTimes: number
}

export interface MergePreflight {
  /** Recorded times per duplicate operation id — what the confirmation says will move. */
  timesByOperation: Record<string, number>
  totalTimes: number
  /** Notes hanging off those times. They move with them; counted so the confirm can say so. */
  totalNotes: number
  /** Times with no collected_by at all — imported history. They move with the merge; counted
   * separately only because the database may still refuse them (see the guard note above). */
  ownerlessTimes: number
  /** Non-empty → the merge is refused. */
  blockers: MergeBlocker[]
}

/**
 * What a merge would move, and whether it is allowed to. Reads only — safe to call while a
 * confirmation dialog is open, which is exactly where it belongs: the numbers it returns are
 * what that dialog should be summarising.
 *
 * A null collected_by does NOT block: ownerless is not the same as someone else's, and nearly
 * all of this database's times are imported with no owner. They are counted in ownerlessTimes
 * and move with the merge.
 */
export async function preflightMerge(
  supabase: SupabaseClient,
  dups: MergeableOperation[],
  userId: string
): Promise<MergePreflight> {
  const timesByOperation: Record<string, number> = {}
  for (const dup of dups) timesByOperation[dup.id] = 0
  if (dups.length === 0) {
    return { timesByOperation, totalTimes: 0, totalNotes: 0, ownerlessTimes: 0, blockers: [] }
  }

  const nameById = new Map(dups.map((d) => [d.id, d.name]))
  const foreignByOp = new Map<string, number>()
  const timeIds: string[] = []
  let totalTimes = 0
  let ownerlessTimes = 0

  for (const chunk of chunked(dups.map((d) => d.id), READ_CHUNK)) {
    const { data, error } = await supabase
      .from('operation_times').select('id, operation_id, collected_by').in('operation_id', chunk)
    if (error) throw new Error(`Checking what would move: ${error.message}`)
    for (const row of (data ?? []) as { id: string; operation_id: string; collected_by: string | null }[]) {
      timeIds.push(row.id)
      totalTimes++
      timesByOperation[row.operation_id] = (timesByOperation[row.operation_id] ?? 0) + 1
      // Blocking condition: owned, and owned by somebody else. Null passes.
      if (row.collected_by === null) ownerlessTimes++
      else if (row.collected_by !== userId) {
        foreignByOp.set(row.operation_id, (foreignByOp.get(row.operation_id) ?? 0) + 1)
      }
    }
  }

  let totalNotes = 0
  for (const chunk of chunked(timeIds, READ_CHUNK)) {
    const { count, error } = await supabase
      .from('operation_time_notes').select('id', { count: 'exact', head: true }).in('operation_time_id', chunk)
    if (error) throw new Error(`Checking notes: ${error.message}`)
    totalNotes += count ?? 0
  }

  const blockers: MergeBlocker[] = [...foreignByOp.entries()].map(([operationId, foreignTimes]) => ({
    operationId,
    operationName: nameById.get(operationId) ?? 'Operation',
    foreignTimes,
  }))

  return { timesByOperation, totalTimes, totalNotes, ownerlessTimes, blockers }
}

/** The message a blocked merge reports. One wording, so all three screens say the same thing.
 * Names only operations holding another real user's times — imported times with no owner are
 * never a blocker and are never listed here. */
export function blockedMergeMessage(blockers: MergeBlocker[]): string {
  const list = blockers
    .map((b) => `${b.operationName} (${b.foreignTimes} time${b.foreignTimes === 1 ? '' : 's'})`)
    .join(', ')
  return (
    `This merge can't run: ${list} ${blockers.length === 1 ? 'holds times' : 'hold times'} collected by ` +
    'another user, and moving a recorded time is restricted to whoever collected it. Nothing has ' +
    'been changed. Drop those operations from the selection, or ask the person who collected the ' +
    'times to merge them.'
  )
}

/**
 * One duplicate folded away, and everything needed to put it back exactly as it was.
 *
 * Recorded as the merge runs and handed to the caller. A single operation merge does not need
 * it — it is one operation and it either happened or it didn't — but lib/jobs' job merge runs a
 * whole sequence of these alongside its own reparents, and a failure half way through has to be
 * undone rather than reported as a mess. See reverseOperationMerge.
 */
export interface OperationMergeReversal {
  dupId: string
  dupName: string
  keeperId: string
  /** The operation_times ids that moved, read BEFORE the move — afterwards they are
   * indistinguishable from times the keeper already had, so this is the only chance to know. */
  movedTimeIds: string[]
  /** The applies-list rows the duplicate carried, all of which were deleted from it. */
  dupProductIds: string[]
  /** Of those, the ones the keeper did NOT already have — precisely the rows the union added,
   * so a reversal removes what it created and nothing the keeper owned in its own right. */
  addedToKeeperProductIds: string[]
  /** Whether the duplicate was active before it was retired. */
  dupWasActive: boolean
}

export interface MergeResult {
  /** Duplicates left ACTIVE because times were still on them after the move. Empty on a clean
   * merge. Never silently dropped — a caller is expected to report these. */
  stranded: string[]
  /** One per duplicate actually folded away, in the order it happened. */
  reversals: OperationMergeReversal[]
}

/**
 * The only function anywhere that merges operations. Runs the preflight first and throws
 * without writing anything if it finds a blocker, so the merge is all-or-nothing by
 * construction rather than by each caller remembering to check.
 */
export async function mergeOperations(
  supabase: SupabaseClient,
  { keeper, dups, userId }: { keeper: MergeableOperation; dups: MergeableOperation[]; userId: string }
): Promise<MergeResult> {
  if (dups.length === 0) return { stranded: [], reversals: [] }

  const preflight = await preflightMerge(supabase, dups, userId)
  if (preflight.blockers.length > 0) throw new Error(blockedMergeMessage(preflight.blockers))

  const stranded: string[] = []
  const reversals: OperationMergeReversal[] = []
  for (const dup of dups) {
    // Read the ids of what is about to move BEFORE moving it. Two reasons: after the update
    // these rows are indistinguishable from the keeper's own, and a reversal has to move back
    // exactly the rows this merge moved and not one row more.
    const timeRows = await fetchAllRows<{ id: string }>(
      () => supabase.from('operation_times').select('id').eq('operation_id', dup.id).order('id'),
      { table: 'operation_times' }
    )
    const movedTimeIds = timeRows.map((t) => t.id)

    const { error: moveError } = await supabase
      .from('operation_times').update({ operation_id: keeper.id }).eq('operation_id', dup.id)
    if (moveError) throw new Error(`Moving times off "${dup.name}": ${moveError.message}`)

    // Unfiltered, matching the UPDATE above — the re-count has to see every row the move was
    // supposed to shift, or it reports a clean merge with rows left stranded on the duplicate
    // that is about to be retired.
    const { count, error: countError } = await supabase
      .from('operation_times').select('id', { count: 'exact', head: true }).eq('operation_id', dup.id)
    if (countError) throw new Error(`Checking "${dup.name}": ${countError.message}`)
    if ((count ?? 0) > 0) {
      stranded.push(`${dup.name} (${count} time${count === 1 ? '' : 's'} left behind)`)
      continue
    }

    // ── Model links: UNIONED onto the keeper, then cleared off the duplicate ──────────────
    // Clearing alone (which is all this did) loses applicability the merge had no business
    // losing: the duplicate's times have just landed on the keeper, and each of those times
    // carries its own operation_time_models rows. Drop the duplicate's applies-list row without
    // putting it on the keeper and that model's minutes still count towards its total while the
    // keeper is missing from its coverage — exactly the disagreement lib/modelOperations' guard
    // exists to prevent, arrived at from the other direction.
    //
    // The upsert in linkOperationsToModels is what de-duplicates: a model both operations
    // already applied to is one row before and one row after.
    const [dupLinks, keeperLinks] = await Promise.all([
      fetchLinksForOperations(supabase, [dup.id]),
      fetchLinksForOperations(supabase, [keeper.id]),
    ])
    const dupProductIds = [...new Set(dupLinks.map((l) => l.product_id))]
    const keeperProductIds = new Set(keeperLinks.map((l) => l.product_id))
    const addedToKeeperProductIds = dupProductIds.filter((id) => !keeperProductIds.has(id))
    if (addedToKeeperProductIds.length > 0) {
      const linked = await linkOperationsToModels(
        supabase,
        addedToKeeperProductIds.map((product_id) => ({ operation_id: keeper.id, product_id }))
      )
      if (linked.error) throw new Error(`Moving model links onto "${keeper.name}": ${linked.error}`)
    }

    // Stale model links on a retired operation would keep it counting towards a model's
    // coverage, so clear them. Times are never touched.
    const { error: linkError } = await supabase.from('model_operations').delete().eq('operation_id', dup.id)
    if (linkError) throw new Error(`Clearing model links on "${dup.name}": ${linkError.message}`)

    const { data: retired, error: retireError } = await supabase
      .from('operations').update({ is_active: false }).eq('id', dup.id).select('id')
    if (retireError) throw new Error(`Retiring "${dup.name}": ${retireError.message}`)
    if (!retired || retired.length === 0) throw new Error(`"${dup.name}" could not be retired — the update was rejected.`)

    reversals.push({
      dupId: dup.id,
      dupName: dup.name,
      keeperId: keeper.id,
      movedTimeIds,
      dupProductIds,
      addedToKeeperProductIds,
      dupWasActive: dup.is_active !== false,
    })
  }

  return { stranded, reversals }
}

/**
 * Put one folded-away duplicate back — the inverse of the loop above, step for step.
 *
 * This exists for lib/jobs' job merge and nothing else. A job merge is a SEQUENCE of writes
 * (reparent, fold, reparent, retire the emptied job…) and PostgREST gives a browser no
 * transaction to wrap it in, so the only way to keep "all or nothing" honest is to undo what
 * already happened when a later step fails. That is a compensating reversal, not a rollback:
 * it is itself a set of writes that can fail, which is why it returns its failures instead of
 * throwing. A caller reports them — silence here would be the one outcome worse than the
 * partial state it is trying to clear up.
 *
 * Un-retiring comes FIRST: everything after it re-points rows back at this operation, and doing
 * that while the row is still retired would hide them on a screen mid-reversal.
 */
export async function reverseOperationMerge(
  supabase: SupabaseClient,
  reversal: OperationMergeReversal
): Promise<string[]> {
  const failures: string[] = []

  if (reversal.dupWasActive) {
    const { data, error } = await supabase
      .from('operations').update({ is_active: true }).eq('id', reversal.dupId).select('id')
    if (error) failures.push(`"${reversal.dupName}" could not be un-retired: ${error.message}`)
    else if (!data || data.length === 0) failures.push(`"${reversal.dupName}" could not be un-retired — the update was rejected.`)
  }

  // Only the rows the union created come off the keeper. A model the keeper already applied to
  // was never this merge's doing and must survive the reversal untouched.
  for (const chunk of chunked(reversal.addedToKeeperProductIds, READ_CHUNK)) {
    const { error } = await supabase
      .from('model_operations').delete().eq('operation_id', reversal.keeperId).in('product_id', chunk)
    if (error) failures.push(`model links added to the keeper by "${reversal.dupName}" could not be removed: ${error.message}`)
  }

  if (reversal.dupProductIds.length > 0) {
    const restored = await linkOperationsToModels(
      supabase,
      reversal.dupProductIds.map((product_id) => ({ operation_id: reversal.dupId, product_id }))
    )
    if (restored.error) failures.push(`model links on "${reversal.dupName}" could not be restored: ${restored.error}`)
  }

  // By id, never by operation_id: the keeper's own times are sitting under the same operation_id
  // now, and a filtered-by-operation update would drag them across too.
  for (const chunk of chunked(reversal.movedTimeIds, READ_CHUNK)) {
    const { data, error } = await supabase
      .from('operation_times').update({ operation_id: reversal.dupId }).in('id', chunk).select('id')
    if (error) failures.push(`${chunk.length} recorded time${chunk.length === 1 ? '' : 's'} could not be moved back onto "${reversal.dupName}": ${error.message}`)
    else if ((data ?? []).length < chunk.length) {
      failures.push(
        `${chunk.length - (data ?? []).length} recorded time${chunk.length - (data ?? []).length === 1 ? '' : 's'} ` +
        `could not be moved back onto "${reversal.dupName}" — the update was rejected.`
      )
    }
  }

  return failures
}

/**
 * The line a caller shows when a merge completed but left something behind.
 *
 * Deliberately does not name a cause. The preflight has already proved no time in the
 * selection belongs to another user, so a strand at this point is the database refusing the
 * update for some other reason — most likely an operation_times UPDATE policy of
 * `collected_by = auth.uid()`, which rejects ownerless imported rows as well as other people's.
 * Guessing wrong here would send someone looking for a user who doesn't exist.
 */
export function strandedMergeMessage(stranded: string[]): string {
  return (
    `Kept active — the database refused to move their recorded times, so retiring them would ` +
    `have stranded real history on a row no screen shows: ${stranded.join(', ')}. ` +
    'Everything else in the selection was merged. Nothing was lost. If these are imported times ' +
    'with no collector recorded against them, the operation_times update policy has to allow ' +
    'moving ownerless rows before this merge can complete.'
  )
}
