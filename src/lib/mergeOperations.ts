import type { SupabaseClient } from '@supabase/supabase-js'
import { READ_CHUNK, chunked } from './modelOperations'
import type { Operation } from './types'

/**
 * The single operation-merge module — /setup, /tryouts and /collect all fold duplicate
 * operations into a keeper through here, so the order of writes, the RLS guard and what counts
 * as a completed merge can't drift between the three screens that offer it.
 *
 * A merge re-points every operation_time from each duplicate onto the keeper, then flips the
 * duplicate to is_active = false. Notes and time-model links ride along untouched — both hang
 * off operation_time_id, not operation_id — so no time or note is created, deleted or edited;
 * they only change which operation they belong to. Model links on the retired duplicate ARE
 * cleared, because a retired operation still carrying them keeps counting towards a model's
 * coverage while no screen shows it.
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
  dups: Operation[],
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

export interface MergeResult {
  /** Duplicates left ACTIVE because times were still on them after the move. Empty on a clean
   * merge. Never silently dropped — a caller is expected to report these. */
  stranded: string[]
}

/**
 * The only function anywhere that merges operations. Runs the preflight first and throws
 * without writing anything if it finds a blocker, so the merge is all-or-nothing by
 * construction rather than by each caller remembering to check.
 */
export async function mergeOperations(
  supabase: SupabaseClient,
  { keeper, dups, userId }: { keeper: Operation; dups: Operation[]; userId: string }
): Promise<MergeResult> {
  if (dups.length === 0) return { stranded: [] }

  const preflight = await preflightMerge(supabase, dups, userId)
  if (preflight.blockers.length > 0) throw new Error(blockedMergeMessage(preflight.blockers))

  const stranded: string[] = []
  for (const dup of dups) {
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

    // Stale model links on a retired operation would keep it counting towards a model's
    // coverage, so clear them. Times are never touched.
    const { error: linkError } = await supabase.from('model_operations').delete().eq('operation_id', dup.id)
    if (linkError) throw new Error(`Clearing model links on "${dup.name}": ${linkError.message}`)

    const { data: retired, error: retireError } = await supabase
      .from('operations').update({ is_active: false }).eq('id', dup.id).select('id')
    if (retireError) throw new Error(`Retiring "${dup.name}": ${retireError.message}`)
    if (!retired || retired.length === 0) throw new Error(`"${dup.name}" could not be retired — the update was rejected.`)
  }

  return { stranded }
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
