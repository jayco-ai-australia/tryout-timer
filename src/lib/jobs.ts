import type { SupabaseClient } from '@supabase/supabase-js'
import { READ_CHUNK, chunked } from './modelOperations'
import { fetchAllChunked, fetchAllRows } from './supabaseRead'
import { plural } from './format'
import { operationNameKey, reactivateOperation, retireOperation, setOperationJob } from './operations'
import {
  blockedMergeMessage, mergeOperations, preflightMerge, reverseOperationMerge,
  type MergeBlocker, type OperationMergeReversal,
} from './mergeOperations'
import { isUniqueViolation, setJobSection } from './sections'
import type { Job, Section } from './types'

/**
 * The jobs module — job merge, and the one place the "a retired job is invisible" rule is
 * written down.
 *
 * ── jobs.is_active ────────────────────────────────────────────────────────────────────────
 * `jobs.is_active` (boolean not null default true) is the same soft-delete flag
 * `sections.is_active` and `operations.is_active` carry, and it means the same thing: false =
 * merged away, not deleted. The row survives, everything that ever pointed at it survives, and
 * reactivating it in the database brings it back — but no list, pane or picker in the app shows
 * it.
 *
 * Every read that FEEDS A LIST filters `.eq('is_active', true)`. The deliberate exceptions are
 * identity lookups — "what is this job called?", resolving a job id already held by a row that
 * references it — because a retired job still labels the history that points at it, and dropping
 * it there would render a real operation, time or model total under a blank job name. Those are
 * listed in the report and each carries its own comment at the call site.
 *
 * Note this is NOT operation_times.is_active, which despite the name flags a superseded import
 * batch rather than a hidden row — see the warning at the top of lib/operationTimes.
 *
 * ── Merge ─────────────────────────────────────────────────────────────────────────────────
 * Job merge is the middle level of the walk's three merges: many jobs fold into one keeper,
 * their operations repoint, the emptied jobs are retired.
 *
 * It moves OPERATIONS and nothing else. An operation that reparents carries its recorded times,
 * notes and model links with it untouched — they hang off operation_id, not job_id.
 *
 * SAME-NAMED OPERATIONS FOLD TOGETHER. `operations_name_job_id_key` is a plain
 * UNIQUE (name, job_id), so an arriving "PSCL" cannot simply sit beside the keeper's "PSCL" —
 * the database rejects it. On this line that is the normal case, not an edge one: every job
 * carries "Tool Box Meeting", "PSCL" and "Read Paperwork". So a collision is resolved by folding
 * the incoming operation into the keeper's, through lib/mergeOperations — the same and only
 * operation-merge path the three collection screens use. That is what the user did by hand
 * straight afterwards anyway.
 *
 * THE TIME-OWNERSHIP GUARD THEREFORE APPLIES — to the folds, and only to them. A reparent still
 * touches no operation_times row and is still refused on no ownership grounds. But a fold moves
 * times, and a time collected by somebody else is not ours to move, so the operation-level
 * preflight runs across every fold BEFORE anything is written and the whole merge is refused if
 * it finds one.
 *
 * ALL OR NOTHING, as far as a browser can make that true — see the atomicity note on mergeJobs.
 * There is no transaction available here; the merge is fully resolved and every rule checked at
 * zero writes, and anything that fails after that rewinds what already ran.
 *
 * SAME SECTION ONLY. A job's team is its section's team (see lib/sections' teamForJob), so
 * merging across sections would silently re-team every operation that moved — and it would be a
 * reassignment, which lives on the job's own edit panel. The candidate list never offers a
 * cross-section row and mergeJobs re-checks it before writing: the UI is not the only way in.
 */

/**
 * THE definition of "which jobs may be merged together": two jobs are valid partners exactly
 * when this returns the same string for both — that is, when they sit in the same section. Both
 * being unsectioned (section_id null) is the legacy "not filed into the walk at all" state, and
 * it is one bucket, not many.
 *
 * One function, both sides of the fence: components/MergeMode builds each row's `groupKey` from
 * it and disables anything outside the ticked group, and mergeJobs re-checks it before writing.
 * The UI is not the only way in, and the two cannot drift into different ideas of what a legal
 * merge is.
 */
/**
 * The only function anywhere that creates a job with its filing already correct.
 *
 * A JOB MUST HAVE A SECTION. Not a database constraint — jobs.section_id is nullable, and the
 * unsorted-tray flows on /setup and /collect legitimately create jobs into a tray — but the rule
 * every NEW job created from a collection flow answers to. A job's team IS its section's team
 * (lib/sections' teamForJob); a job with no section has no team, and every recorded time
 * underneath it is filed against a null team and vanishes from every per-team rollup that reads
 * it back. There is no "No Section" fallback here on purpose: a caller with nowhere to put a job
 * has to say where it goes.
 *
 * The filing itself is delegated to setJobSection rather than reimplemented in the insert. That
 * function is the single writer of jobs.section_id and the one place that knows the section also
 * dictates team_id and production_line_id — four screens currently hand-roll that payload into
 * their own `jobs.insert`, which is exactly the drift this avoids being a fifth of.
 */
export async function createJob(
  supabase: SupabaseClient,
  input: { name: string; section: Section }
): Promise<Job> {
  const name = input.name.trim()
  if (!name) throw new Error('Job name must not be empty')
  if (!input.section) throw new Error('A new job needs a section — its team is derived from one')

  const { data, error } = await supabase
    .from('jobs')
    .insert({ name, production_line_id: input.section.production_line_id, is_active: true })
    .select('*')
    .single()
  if (error || !data) throw new Error(error?.message ?? 'Could not create job')

  // Second write, deliberately: section_id/team_id go through the one function that owns them.
  await setJobSection(supabase, data.id as string, input.section)
  return { ...(data as Job), section_id: input.section.id, team_id: input.section.team_id }
}

/**
 * Retire a job — the soft delete. `is_active = false`, and nothing else is touched.
 *
 * The counterpart of what mergeJobs does to the jobs it folds away, exposed on its own so a
 * structural screen can retire a duplicate that has no keeper to merge into. /setup's Delete is
 * a HARD `.delete()` guarded by "has no operations at all", which is a different act with a
 * different consequence: it cascades operations and their operation_times away for good. This
 * one keeps every row and only stops the job appearing in lists — see the is_active note at the
 * top of this module. A retired job's operations stay pointed at it, which is exactly why a
 * caller should say how much is being hidden before calling this.
 *
 * The row is read back because an update filtered out by RLS succeeds having changed nothing —
 * the failure mode that would leave a screen refreshing into an unchanged list with no error.
 */
export async function retireJob(supabase: SupabaseClient, jobId: string): Promise<void> {
  const { data, error } = await supabase
    .from('jobs').update({ is_active: false }).eq('id', jobId).select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error('That job could not be retired — the change was rejected by the database (check your permissions).')
  }
}

/**
 * Bring a retired job back — the exact inverse of retireJob, and the only function anywhere that
 * sets jobs.is_active back to true outside a merge rollback.
 *
 * ── Why this is not admin-gated ────────────────────────────────────────────────────────────
 * Retiring a job is offered to every signed-in user on /line-config, so restoring one has to be
 * too. A flag anyone can set and only an admin can clear is a one-way door: the job disappears
 * from every list in the app, keeps blocking the section it sits in and the name it holds, and the
 * person who hid it cannot undo their own action. Restore is also not destructive — the row is
 * already there, nothing is created, and retiring it again is one click.
 *
 * ── The one way it can fail on its own ─────────────────────────────────────────────────────
 * `jobs_name_team_id_operator_key` is UNIQUE (name, team_id, primary_operator_id) with no
 * is_active predicate, so in a consistent database a retired job and a live one cannot already
 * share that key and this update cannot collide. It is still caught and named: the index has been
 * observed rejecting writes on rows the app cannot see (see lib/sections' JobNameConflictError),
 * and "restore failed: duplicate key value violates…" is not something to hand a user. When it
 * does happen the answer is a merge, not a restore, and the message says so.
 *
 * The row is read back because an update filtered out by RLS succeeds having changed nothing.
 */
export async function restoreJob(supabase: SupabaseClient, jobId: string): Promise<void> {
  const { data, error } = await supabase
    .from('jobs').update({ is_active: true }).eq('id', jobId).select('id, name')
  if (error) {
    if (isUniqueViolation(error)) {
      throw new Error(
        'That job cannot be restored as it stands: a live job already holds its name on this team, ' +
        'and the database allows only one. Merge the deleted job into that live one instead — the ' +
        'operations and recorded times end up on the live job, which is what a restore was for.'
      )
    }
    throw new Error(error.message)
  }
  if (!data || data.length === 0) {
    throw new Error('That job could not be restored — the change was rejected by the database (check your permissions).')
  }
}

/**
 * ── The only function anywhere that HARD-deletes a job ─────────────────────────────────────
 *
 * Destroys the row. Not a retire — see retireJob for that, which is what every "Delete" on a live
 * job does and what keeps the work recoverable. This exists for one case: an EMPTY SHELL, a job
 * row left behind by a merge or a deletion that holds nothing at all. Retiring one of those again
 * is a no-op, moving it only relocates it, and merging it folds nothing — so without this there is
 * no way to be rid of a row that still blocks the section it sits in.
 *
 * ── The guard, and why it is counted here rather than trusted from the caller ──────────────
 * operations.job_id cascades on delete, and operation_times.operation_id cascades from there. So a
 * job with any operation under it — RETIRED OPERATIONS INCLUDED — takes real collected history with
 * it, permanently, with no rollback available from a browser. The screen disables its control on
 * the same numbers, but a screen's numbers are a render old and its operations list is filtered to
 * the live ones; these two reads are the check that actually holds, and they are deliberately
 * re-run here at the moment of writing.
 *
 * Both counts are taken and both are named in the refusal, because "3 operations" and "3 operations
 * and 148 recorded times" are different warnings to the person reading them. With no operations
 * there can be no times — a time reaches a job only through an operation — and the times read is
 * skipped rather than issued to confirm a zero.
 */
export async function deleteJobPermanently(supabase: SupabaseClient, jobId: string): Promise<void> {
  // Every operation ever filed here. countOperationsInJob is deliberately unfiltered by is_active
  // (see its note), which is exactly the count this guard needs.
  const operations = await fetchAllRows<{ id: string; name: string }>(
    () => supabase.from('operations').select('id, name').eq('job_id', jobId).order('id'),
    { table: 'operations' }
  )

  if (operations.length > 0) {
    let times = 0
    for (const chunk of chunked(operations.map((o) => o.id), READ_CHUNK)) {
      const { count, error } = await supabase
        .from('operation_times').select('id', { count: 'exact', head: true }).in('operation_id', chunk)
      if (error) throw new Error(`Checking what this job holds: ${error.message}`)
      times += count ?? 0
    }
    throw new Error(
      `this job is not empty — it holds ${plural(operations.length, 'operation')}` +
      (times > 0 ? ` and ${plural(times, 'recorded time')}` : '') +
      (times > 0
        ? ', which a permanent delete would destroy along with the row. Merge it into the live job '
          + 'that replaced it instead: the operations and their times move across and nothing is lost.'
        : ', some of which may themselves be retired and invisible. Merge or restore it instead — a '
          + 'permanent delete would take those operations with it.')
    )
  }

  // A delete filtered out by RLS succeeds having removed nothing, so the row is read back and its
  // absence reported — the same shape deleteSection uses, and the difference between "deleted" and
  // "the database quietly declined".
  const { data, error } = await supabase.from('jobs').delete().eq('id', jobId).select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error(
      'That job could not be deleted — the database rejected it, which usually means permanently '
      + 'deleting a job is restricted to admins in this environment. Nothing was changed.'
    )
  }
}

export function jobMergeGroupKey(job: { section_id?: string | null }): string {
  return `section:${job.section_id ?? ''}`
}

/**
 * The operations still pointing at this job — the post-move check a merge has to clear.
 *
 * Counted across EVERY operation, retired ones included: `operations.job_id` is not filtered by
 * is_active, and retiring a job with a retired operation still pointing at it would strand that
 * operation's history under a job no screen lists.
 *
 * `ignoreOperationIds` is the one exception, and it is narrow: a job merge that FOLDS an
 * incoming operation into a same-named one on the keeper leaves the incoming row behind,
 * retired, still on the job being folded away — and empty, because the fold moved its times to
 * the keeper and cleared its model links. Counting those shells would strand every job the
 * collision walk touched. Nothing else may use it.
 */
export async function countOperationsInJob(
  supabase: SupabaseClient,
  jobId: string,
  ignoreOperationIds: string[] = []
): Promise<number> {
  const rows = await fetchAllRows<{ id: string }>(
    () => supabase.from('operations').select('id').eq('job_id', jobId).order('id'),
    { table: 'operations' }
  )
  const ignore = new Set(ignoreOperationIds)
  return rows.filter((r) => !ignore.has(r.id)).length
}

/** An operation that reparents untouched, because nothing on the keeper claims its name. */
export interface JobMergeReparent {
  id: string
  name: string
  job_id: string
  is_active?: boolean
}

/**
 * An operation arriving from a folded-away job onto a name the keeper already holds — the
 * collision this whole walk exists for.
 *
 * `operations_name_job_id_key` is a plain UNIQUE (name, job_id), so reparenting one of these is
 * simply rejected by the database. It is also, on this line, the NORMAL case rather than an edge
 * one: every job carries "Tool Box Meeting", "PSCL" and "Read Paperwork", so almost every job
 * merge collides on all three.
 */
export interface JobMergeCombine {
  /** The operation arriving from the job being folded away. It is the one that gets retired. */
  incomingId: string
  incomingName: string
  incomingJobId: string
  incomingIsActive: boolean
  /**
   * What it folds INTO. Either an operation already on the keeper, or one that arrived earlier
   * in this same merge — two folded-away jobs both holding "PSCL" collide with each other just
   * as surely as either collides with the keeper's own.
   */
  targetId: string
  targetName: string
  targetIsActive: boolean
  /**
   * The target is retired and something live is folding into it. The constraint takes no notice
   * of is_active, so a retired operation still owns its name on the keeper — the fold has to go
   * into it, and the combined row then holds current work, so it comes back.
   */
  reactivateTarget: boolean
}

/** The write path as a list, resolved before anything is written and replayed in order. */
export type JobMergeStep =
  | { kind: 'reparent'; operation: JobMergeReparent }
  | { kind: 'combine'; combine: JobMergeCombine }

export interface JobMergePreflight {
  /**
   * EVERY operation that would move, retired ones included, with the job each currently belongs
   * to. The write below deals with all of them: `operations.job_id` is not filtered by is_active,
   * and leaving a retired operation behind would strand it under a job about to be retired —
   * which the post-move count would (rightly) refuse to complete.
   */
  movingOperations: { id: string; name: string; job_id: string; is_active?: boolean }[]
  /** Of those, the ones a screen can actually show — what the confirmation counts. A retired
   * operation is real history being re-filed, but naming it would name a row the user already
   * merged away and can't see anywhere. */
  visibleOperations: { id: string; name: string }[]
  /** Every write, in the order it happens. */
  steps: JobMergeStep[]
  /** The steps that are plain reparents. */
  reparenting: JobMergeReparent[]
  /** The steps that fold into a same-named operation. */
  combining: JobMergeCombine[]
  /** The distinct names being folded together, sorted — what the confirmation lists by name. */
  combiningNames: string[]
  /** Of `combining`, the ones a screen can show. The number the confirmation quotes. */
  visibleCombiningCount: number
  /** Of `reparenting`, the ones a screen can show — "N other operations move as they are". */
  visibleReparentingCount: number
  /** Retired operations on the keeper that a live one folds into, and which therefore come back
   * into view. Named, because an operation reappearing is not something to do silently. */
  reactivatingNames: string[]
  /**
   * From the operation-level preflight, run across every operation that would fold. Non-empty →
   * the merge is refused before a single row is written, exactly as an operation merge is.
   */
  blockers: MergeBlocker[]
}

/**
 * What a job merge would do, resolved down to the individual writes. Reads only — safe to call
 * while a confirmation is open, which is where it belongs: the numbers and names it returns are
 * what that dialog states.
 *
 * ── The collision walk ────────────────────────────────────────────────────────────────────
 * The keeper's operations are keyed by name (lib/operations' operationNameKey: trimmed, case
 * folded) INCLUDING the retired ones, because the unique constraint includes them. Each moving
 * operation is then walked in order: a free name reparents and CLAIMS that key for the rest of
 * the walk; a taken one folds into whatever holds it. That running claim is what makes two
 * folded-away jobs both holding "PSCL" resolve — the first reparents, the second folds into it.
 */
export async function preflightJobMerge(
  supabase: SupabaseClient,
  { keeper, merged, userId }: { keeper: Job; merged: Job[]; userId: string }
): Promise<JobMergePreflight> {
  const mergedIds = merged.map((j) => j.id)
  const movingOperations = await fetchAllChunked<{ id: string; name: string; job_id: string; is_active?: boolean }>(
    mergedIds, READ_CHUNK,
    (chunk) => supabase.from('operations').select('id, name, job_id, is_active')
      .in('job_id', chunk).order('id'),
    { table: 'operations' }
  )
  const visible = movingOperations.filter((o) => o.is_active !== false)

  // NOT filtered to is_active — see the collision walk above. A retired operation on the keeper
  // still occupies its name there, and missing it is exactly the duplicate-key failure this
  // function exists to make impossible.
  const keeperOperations = await fetchAllRows<{ id: string; name: string; is_active?: boolean }>(
    () => supabase.from('operations').select('id, name, is_active')
      .eq('job_id', keeper.id).order('id'),
    { table: 'operations' }
  )

  const claimed = new Map<string, { id: string; name: string; isActive: boolean }>()
  for (const op of keeperOperations) {
    // First claim wins. Two rows can only share a key here by differing in case or padding —
    // the constraint permits that — and the walk needs one answer, not two.
    const key = operationNameKey(op.name)
    if (!claimed.has(key)) claimed.set(key, { id: op.id, name: op.name, isActive: op.is_active !== false })
  }

  const steps: JobMergeStep[] = []
  const reparenting: JobMergeReparent[] = []
  const combining: JobMergeCombine[] = []

  // Job by job in the order the caller gave them, and by id within each — the same order the
  // write replays, so what the confirmation described is what runs.
  for (const job of merged) {
    for (const op of movingOperations.filter((o) => o.job_id === job.id)) {
      const key = operationNameKey(op.name)
      const target = claimed.get(key)
      const incomingIsActive = op.is_active !== false

      if (!target) {
        claimed.set(key, { id: op.id, name: op.name, isActive: incomingIsActive })
        reparenting.push(op)
        steps.push({ kind: 'reparent', operation: op })
        continue
      }

      const combine: JobMergeCombine = {
        incomingId: op.id,
        incomingName: op.name,
        incomingJobId: op.job_id,
        incomingIsActive,
        targetId: target.id,
        targetName: target.name,
        targetIsActive: target.isActive,
        reactivateTarget: incomingIsActive && !target.isActive,
      }
      // The claim is updated in place so a THIRD operation of the same name sees the target as
      // it will actually be by the time it folds in, not as it was before the walk started.
      if (combine.reactivateTarget) target.isActive = true
      combining.push(combine)
      steps.push({ kind: 'combine', combine })
    }
  }

  // The operation-level ownership guard, asked once for the whole selection. A job merge on its
  // own never touches a recorded time — but a FOLD does, and it is not exempt from the rule that
  // somebody else's collected time is not ours to move. Asking here rather than inside each fold
  // is what keeps the refusal all-or-nothing: nothing is written before the answer is known.
  const blockers = combining.length === 0
    ? []
    : (await preflightMerge(
        supabase,
        combining.map((c) => ({ id: c.incomingId, name: c.incomingName })),
        userId
      )).blockers

  return {
    movingOperations,
    visibleOperations: [...visible].sort((a, b) => a.name.localeCompare(b.name)),
    steps,
    reparenting,
    combining,
    combiningNames: [...new Set(combining.map((c) => c.targetName))].sort((a, b) => a.localeCompare(b)),
    visibleCombiningCount: combining.filter((c) => c.incomingIsActive).length,
    visibleReparentingCount: reparenting.filter((o) => o.is_active !== false).length,
    reactivatingNames: [...new Set(combining.filter((c) => c.reactivateTarget).map((c) => c.targetName))]
      .sort((a, b) => a.localeCompare(b)),
    blockers,
  }
}

export interface JobMergeResult {
  movedOperations: number
  /** How many of the moved operations folded into a same-named operation rather than landing
   * beside it. */
  combinedOperations: number
  /** The names they folded into — what the result banner repeats back. */
  combinedNames: string[]
}

/**
 * Every write this merge has made so far, newest last — the tape a failure is rewound along.
 * See the atomicity note in mergeJobs.
 */
type JobMergeUndo =
  | { kind: 'reparent'; operationId: string; operationName: string; fromJobId: string }
  | { kind: 'combine'; reversal: OperationMergeReversal }
  | { kind: 'reactivate'; operationId: string; operationName: string }
  | { kind: 'retire-job'; jobId: string; jobName: string }

/**
 * Undo the tape, last write first. Returns what it could NOT put back, and never throws: a
 * reversal is itself a sequence of writes that can be refused, and swallowing that would be the
 * one outcome worse than the half-finished merge it is clearing up.
 */
async function reverseJobMerge(supabase: SupabaseClient, undo: JobMergeUndo[]): Promise<string[]> {
  const failures: string[] = []
  for (const step of [...undo].reverse()) {
    try {
      if (step.kind === 'reparent') {
        // Safe to put back: the operation's original job is the one it just left, and nothing in
        // this merge ever creates a name on a job being folded away.
        await setOperationJob(supabase, step.operationId, step.fromJobId)
      } else if (step.kind === 'combine') {
        failures.push(...(await reverseOperationMerge(supabase, step.reversal)))
      } else if (step.kind === 'reactivate') {
        await retireOperation(supabase, step.operationId)
      } else {
        const { data, error } = await supabase
          .from('jobs').update({ is_active: true }).eq('id', step.jobId).select('id')
        if (error) throw new Error(error.message)
        if (!data || data.length === 0) throw new Error('the update was rejected')
      }
    } catch (err) {
      const what =
        step.kind === 'reparent' ? `"${step.operationName}" back onto its original job`
          : step.kind === 'combine' ? `"${step.reversal.dupName}"`
            : step.kind === 'reactivate' ? `"${step.operationName}" back to retired`
              : `"${step.jobName}" back to active`
      failures.push(`${what}: ${err instanceof Error ? err.message : 'rejected'}`)
    }
  }
  return failures
}

/** What a caller is told when the merge failed. Says which of the two situations they are in —
 * everything put back, or something left needing hands — and never blurs them together. */
function failedJobMergeMessage(cause: string, rollbackFailures: string[]): string {
  if (rollbackFailures.length === 0) {
    return (
      `${cause} Nothing was changed: every step that had already run was undone, and the jobs are ` +
      'exactly as they were before you pressed Merge. Fix the cause and run it again.'
    )
  }
  return (
    `${cause} Undoing what had already run did not fully succeed, so the merge is PART DONE. ` +
    `Still needing attention: ${rollbackFailures.join('; ')}. ` +
    'Nothing has been deleted — every row involved still exists — but do not re-run the merge ' +
    'until someone has looked at those.'
  )
}

/**
 * The only function anywhere that merges jobs. Many into one.
 *
 * Every operation move goes through lib/operations' setOperationJob — the only function anywhere
 * that writes operations.job_id — rather than one bulk UPDATE, so a merge re-files an operation
 * exactly the way "Move to job" does, read-back check included. Every FOLD goes through
 * lib/mergeOperations' mergeOperations, the only function anywhere that merges operations, for
 * the same reason: there is one operation-merge path in this app and a job merge uses it rather
 * than growing a second.
 *
 * ── Collisions FOLD; they do not fail ─────────────────────────────────────────────────────
 * This used to reparent every operation blind and leave same-named ones side by side for the
 * user to merge afterwards. On this line that is not an edge case — every job carries "Tool Box
 * Meeting", "PSCL" and "Read Paperwork" — so `operations_name_job_id_key` rejected almost every
 * job merge part-way through. Folding is what the user did by hand immediately afterwards
 * anyway, so doing it here removes a step rather than adding behaviour. See preflightJobMerge
 * for how the collisions are resolved, and JobMergeCombine for the retired-name case.
 *
 * ── Atomicity, stated honestly ────────────────────────────────────────────────────────────
 * This runs in a browser against PostgREST. There is NO transaction available to it: every
 * write is its own request, and wrapping the sequence in a real BEGIN/COMMIT would take a
 * database function, which is a schema change. So "all or nothing" is achieved the only way it
 * can be from here, in two halves:
 *
 *   1. Nothing is written until the WHOLE merge is resolved and every rule checked — the
 *      section rule, the collision walk (so a duplicate key is impossible by construction) and
 *      the operation-level ownership guard across every fold. Every refusal happens at zero
 *      writes.
 *   2. Anything that still fails rewinds a tape of what was already written — reparents go
 *      back, folds are reversed row by row (lib/mergeOperations' reverseOperationMerge), retired
 *      jobs come back. If the rewind itself is refused, the caller is told exactly what is left
 *      where. It is never silent.
 *
 * That is a compensating reversal, not a transaction, and the difference is real: a reversal is
 * writes, and writes can be refused. What it does guarantee is that the merge never stops
 * quietly half-done.
 *
 * ── What moves ────────────────────────────────────────────────────────────────────────────
 * OPERATIONS and nothing else. Recorded times, notes and model links hang off operation_id, not
 * job_id, so a reparented operation carries them with nothing to migrate. A FOLD does move
 * times — that is what an operation merge is — which is why the ownership guard applies to it.
 *
 * SAME SECTION ONLY. A job's team is its section's team (see lib/sections' teamForJob), so
 * merging across sections would silently re-team every operation that moved — and it would be a
 * reassignment, which lives on the job's own edit panel. The candidate list never offers a
 * cross-section row and mergeJobs re-checks it before writing: the UI is not the only way in.
 */
export async function mergeJobs(
  supabase: SupabaseClient,
  { keeper, merged, userId }: { keeper: Job; merged: Job[]; userId: string }
): Promise<JobMergeResult> {
  if (merged.length === 0) return { movedOperations: 0, combinedOperations: 0, combinedNames: [] }
  if (merged.some((j) => j.id === keeper.id)) throw new Error('A job can’t be merged into itself.')

  // Re-checked against the SAME rule the picker used — see jobMergeGroupKey. The UI is not the
  // only way in, and a section move between opening the pane and confirming would otherwise
  // slip through.
  const keeperGroup = jobMergeGroupKey(keeper)
  const crossSection = merged.filter((j) => jobMergeGroupKey(j) !== keeperGroup)
  if (crossSection.length > 0) {
    throw new Error(
      `${crossSection.map((j) => `"${j.name}"`).join(', ')} ${crossSection.length === 1 ? 'is' : 'are'} not in the ` +
      `same section as "${keeper.name}". A job can only be merged into another job in the same section — ` +
      'moving a job between sections also moves it between teams, which is a reassignment, not a merge.'
    )
  }

  // Re-read rather than trusting the preflight the confirmation was built from: the user may
  // have been looking at that dialog for a while, and this is the plan that actually runs.
  const preflight = await preflightJobMerge(supabase, { keeper, merged, userId })
  if (preflight.blockers.length > 0) throw new Error(blockedMergeMessage(preflight.blockers))

  const undo: JobMergeUndo[] = []
  /** Folded-away shells: retired, emptied, and still sitting on the job they came from. They
   * are not stranded work — see countOperationsInJob. */
  const shellOperationIds: string[] = []

  try {
    for (const step of preflight.steps) {
      if (step.kind === 'reparent') {
        const op = step.operation
        await setOperationJob(supabase, op.id, keeper.id)
        undo.push({ kind: 'reparent', operationId: op.id, operationName: op.name, fromJobId: op.job_id })
        continue
      }

      const c = step.combine
      const result = await mergeOperations(supabase, {
        keeper: { id: c.targetId, name: c.targetName },
        dups: [{ id: c.incomingId, name: c.incomingName, is_active: c.incomingIsActive }],
        userId,
      })
      // A strand is a failure here, not a partial success to report. The rest of this merge is
      // still to come, and finishing it around a half-folded operation is exactly the state
      // this function now refuses to leave behind.
      if (result.stranded.length > 0 || result.reversals.length === 0) {
        throw new Error(
          `the database refused to move every recorded time off "${c.incomingName}"` +
          (result.stranded.length > 0 ? ` (${result.stranded.join(', ')})` : '') + '.'
        )
      }
      undo.push({ kind: 'combine', reversal: result.reversals[0] })
      shellOperationIds.push(c.incomingId)

      if (c.reactivateTarget) {
        await reactivateOperation(supabase, c.targetId)
        undo.push({ kind: 'reactivate', operationId: c.targetId, operationName: c.targetName })
      }
    }

    for (const job of merged) {
      // Prove the job is empty before retiring it. Counts retired operations too (see
      // countOperationsInJob) — only the shells this merge itself emptied are excused.
      const left = await countOperationsInJob(supabase, job.id, shellOperationIds)
      if (left > 0) {
        throw new Error(
          `"${job.name}" still has ${left === 1 ? '1 operation' : `${left} operations`} on it after the move, ` +
          'so retiring it would hide real work under a job no screen lists.'
        )
      }

      const { data: retired, error: retireError } = await supabase
        .from('jobs').update({ is_active: false }).eq('id', job.id).select('id')
      if (retireError) throw new Error(`retiring "${job.name}" failed: ${retireError.message}.`)
      if (!retired || retired.length === 0) {
        throw new Error(
          `"${job.name}" could not be retired — the update was rejected, which usually means changing ` +
          'jobs is restricted to admins in this environment.'
        )
      }
      undo.push({ kind: 'retire-job', jobId: job.id, jobName: job.name })
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'a write was rejected'
    const cause = `This merge could not be completed: ${detail.endsWith('.') ? detail : `${detail}.`}`
    const failures = await reverseJobMerge(supabase, undo)
    throw new Error(failedJobMergeMessage(cause, failures))
  }

  // Counts the operations a screen can see, matching what the confirmation promised — the
  // retired ones moved too, but reporting them would name rows the user can't find anywhere.
  return {
    movedOperations: preflight.visibleOperations.length,
    combinedOperations: preflight.visibleCombiningCount,
    combinedNames: preflight.combiningNames,
  }
}
