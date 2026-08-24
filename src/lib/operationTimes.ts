import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationTime, OperationTimeNote } from './types'

/**
 * The single operation_times module — every screen that reads or writes operation_times
 * (/collect, /tryouts, /dashboard, /model-total) goes through the helpers here so the
 * averaging math and the insert shape can't drift between screens.
 *
 * ── is_active: do NOT filter reads on it ──────────────────────────────────────────────────
 * operation_times has an is_active column, and it is tempting to read it as "an admin hid this
 * time" and exclude it from averages, totals and coverage. Do not. In this database it does not
 * mean that.
 *
 * Measured 2026-08-20: 759 of 1244 rows are is_active = false — 750 of them imported, all
 * created 6–11 Aug, i.e. an import batch that was superseded by the re-import of 10–11 Aug and
 * flagged rather than deleted. They are ordinary history and they carry most of the recorded
 * coverage: on the Caravan line, 758 of the 781 times linked to its models sit in that batch.
 *
 * Filtering reads on `.eq('is_active', true)` was tried and reverted — it silently dropped 61%
 * of every average and total in the app and took /dashboard coverage from 68.0% to 0.5%, which
 * is what surfaced it. If per-time hiding is wanted, it needs a flag that means only that, or
 * the legacy batch reconciled first; until then every read here counts every row.
 */

export interface OperationTimeStat { avg: number; runs: number }

interface TimeRow { id: string; operation_id: string; total_minutes: number | null }
interface TimeModelRow { operation_time_id: string; product_id: string }

/** Composite key used to look up a stat for a given (operation, product) pair. */
export function operationProductKey(operationId: string, productId: string): string {
  return `${operationId}:${productId}`
}

/**
 * Averages operation_times.total_minutes per (operation, product) pair. operation_times
 * doesn't carry product_id directly — that comes from the operation_time_models junction,
 * which is why both the raw time rows and their model links are required here.
 */
export function averageForOperation(times: TimeRow[], timeModels: TimeModelRow[]): Record<string, OperationTimeStat> {
  const timeById = Object.fromEntries(times.map((t) => [t.id, t]))

  const sums: Record<string, { sum: number; count: number }> = {}
  for (const tm of timeModels) {
    const t = timeById[tm.operation_time_id]
    if (!t || t.total_minutes == null) continue
    const key = operationProductKey(t.operation_id, tm.product_id)
    if (!sums[key]) sums[key] = { sum: 0, count: 0 }
    sums[key].sum += t.total_minutes
    sums[key].count += 1
  }

  const result: Record<string, OperationTimeStat> = {}
  for (const [key, v] of Object.entries(sums)) result[key] = { avg: v.sum / v.count, runs: v.count }
  return result
}

/** Mean + run count of total_minutes across an operation's operation_times, keyed by
 * operation_id — unlike `averageForOperation` this isn't scoped to a single product, it's a
 * row-level stat for display next to the operation's name (/collect's
 * left-pane operation list). */
export function averageByOperation(times: TimeRow[]): Record<string, OperationTimeStat> {
  const sums: Record<string, { sum: number; count: number }> = {}
  for (const t of times) {
    if (t.total_minutes == null) continue
    if (!sums[t.operation_id]) sums[t.operation_id] = { sum: 0, count: 0 }
    sums[t.operation_id].sum += t.total_minutes
    sums[t.operation_id].count += 1
  }
  const result: Record<string, OperationTimeStat> = {}
  for (const [id, v] of Object.entries(sums)) result[id] = { avg: v.sum / v.count, runs: v.count }
  return result
}

export interface ModelTotalOperationRow {
  operationId: string
  operationName: string
  jobId: string
  jobName: string
  avgMinutes: number
  runs: number
  /** Carried straight off the operations row this was built from — so a caller rendering this
   * row can read the operator directly, instead of re-looking the operation up in a second,
   * separately-fetched map that can silently miss entries. */
  primaryOperatorId: string | null
  secondaryOperatorId: string | null
}

export interface ModelTotalResult {
  totalMinutes: number
  operations: ModelTotalOperationRow[]
}

/**
 * A model's total labour content: for every operation that has been timed against this model,
 * take that operation's average total_minutes across its runs for this model, then sum those
 * averages — never SUM(total_minutes) raw, which would multiply an operation's contribution by
 * however many times it happened to be timed instead of averaging that out first. Built on
 * averageForOperation (the same per-(operation, product) averaging /model-total's model rows and
 * every coverage rollup already use), so "average per operation, then sum" can't drift into a
 * second, slightly-different implementation here.
 *
 * No 50/50 operator split: that halving is a workload-assignment concept for when two operators
 * share a secondary operation, and has nothing to do with a model's own labour content, which
 * always uses the operation's full average.
 */
export function modelTotalMinutes(input: {
  productId: string
  /** Every operation that might have a time recorded against it. primary/secondary_operator_id
   * ride along purely so a rendered row carries its own operator — not used in the total math. */
  operations: { id: string; name: string; job_id: string; primary_operator_id: string | null; secondary_operator_id: string | null }[]
  jobs: { id: string; name: string }[]
  operationTimes: TimeRow[]
  operationTimeModels: TimeModelRow[]
}): ModelTotalResult {
  const { productId, operations, jobs, operationTimes, operationTimeModels } = input

  const pairStats = averageForOperation(operationTimes, operationTimeModels)
  const jobNameById = new Map(jobs.map((j) => [j.id, j.name]))

  const rows: ModelTotalOperationRow[] = []
  for (const op of operations) {
    const stat = pairStats[operationProductKey(op.id, productId)]
    if (!stat) continue
    rows.push({
      operationId: op.id,
      operationName: op.name,
      jobId: op.job_id,
      jobName: jobNameById.get(op.job_id) ?? '—',
      avgMinutes: stat.avg,
      runs: stat.runs,
      primaryOperatorId: op.primary_operator_id,
      secondaryOperatorId: op.secondary_operator_id,
    })
  }

  const totalMinutes = rows.reduce((sum, r) => sum + r.avgMinutes, 0)
  return { totalMinutes, operations: rows }
}

export interface ModelTotalFetchResult extends ModelTotalResult {
  /** Row counts at each hop, for a "why is the total wrong/zero" report to be answered from
   * the console instead of a fresh round of guessing. */
  diagnostics: {
    resolvedProductId: string
    junctionLinkCount: number
    sampleOperationTimeIds: string[]
    operationTimesFoundCount: number
    rawSumMinutes: number
  }
  /** The same product_id-first rows this function used internally (hop 2's operation_times,
   * hop 3's operations, and the junction links from hop 1) — exposed so a caller computing
   * "which jobs are covered for this model" (e.g. coverage.ts's computeCoverageCombos) can use
   * the exact same join this total was built from, instead of re-fetching an equivalent query
   * scoped some other way (by production line, say) that risks disagreeing with this total. */
  raw: {
    /** primary/secondary_operator_id ride along here too — not needed for the coverage combos
     * this was originally added for, but it means a caller wanting "who's assigned to this
     * model's timed operations" (e.g. the breakdown's per-job operator line) doesn't need a
     * second fetch for operations it already has. */
    operations: { id: string; job_id: string; primary_operator_id: string | null; secondary_operator_id: string | null }[]
    operationTimes: { id: string; operation_id: string }[]
    operationTimeModels: TimeModelRow[]
  }
}

/**
 * Fetches everything modelTotalMinutes needs for one product and computes its total —
 * DIRECTLY off operation_time_models.product_id, with no other filter anywhere in the chain.
 *
 * This matters: an earlier version of the /model-total page fetched jobs for the *currently
 * selected production line* first, then operations under those jobs, then operation_times under
 * those operations, and only then joined to operation_time_models — i.e. it scoped the fetch by
 * "jobs on this line" before ever touching the junction. A model's total labour content has
 * nothing to do with which line's jobs happened to record it (operations don't have to belong
 * to the same production line as the model they were timed against, and often don't for
 * historical/imported data) — modelTotalMinutes' own contract is "every operation_time linked
 * to it via operation_time_models," full stop. Scoping the fetch by line silently dropped any
 * operation_time recorded under a job on a different line, which is exactly how a model with a
 * real, non-zero total in the database renders as 0.0m on the page. product_id is now the only
 * filter that ever touches this data — no production_line_id, is_imported, or is_active filter
 * anywhere in the chain.
 *
 * Logs a row count at every hop (junction → operation_times → operations/jobs) so the next
 * "total is 0 / wrong" report can be diagnosed from the browser console alone.
 */
export async function fetchModelTotal(supabase: SupabaseClient, productId: string): Promise<ModelTotalFetchResult> {
  console.log('[modelTotalMinutes] resolvedProductId =', productId)

  // Hop 1: the junction, filtered ONLY by product_id.
  const { data: links, error: linksError } = await supabase
    .from('operation_time_models')
    .select('operation_time_id')
    .eq('product_id', productId)
  if (linksError) throw new Error(linksError.message)

  const timeIds = [...new Set((links ?? []).map((l) => l.operation_time_id as string))]
  console.log(
    '[modelTotalMinutes] hop 1 — operation_time_models WHERE product_id = resolvedProductId:',
    timeIds.length, 'row(s). sample operation_time_ids:', timeIds.slice(0, 5)
  )

  if (timeIds.length === 0) {
    console.warn(
      '[modelTotalMinutes] hop 1 returned 0 rows for productId', productId,
      '— either nothing has ever been timed for this model, or the id the page resolved does not',
      'match what operation_time_models.product_id actually holds for it. Total is 0 because of',
      'this hop, not a downstream averaging bug.'
    )
    return {
      totalMinutes: 0, operations: [],
      diagnostics: { resolvedProductId: productId, junctionLinkCount: 0, sampleOperationTimeIds: [], operationTimesFoundCount: 0, rawSumMinutes: 0 },
      raw: { operations: [], operationTimes: [], operationTimeModels: [] },
    }
  }

  // Hop 2: the operation_times rows themselves — id IN (...) only. No production_line_id,
  // is_imported, or is_active filter here or anywhere above it. See the is_active note at the
  // top of this module: filtering it here is what took /dashboard coverage to 0.5%.
  const { data: timeRows, error: timesError } = await supabase
    .from('operation_times')
    .select('id, operation_id, total_minutes')
    .in('id', timeIds)
  if (timesError) throw new Error(timesError.message)

  const times = timeRows ?? []
  console.log(
    '[modelTotalMinutes] hop 2 — operation_times WHERE id IN (…):',
    times.length, 'of', timeIds.length, 'requested'
  )
  if (times.length < timeIds.length) {
    console.warn(
      '[modelTotalMinutes] hop 2 came back short —', timeIds.length - times.length,
      'operation_time_models row(s) point at an operation_times id that did not come back',
      '(deleted row, or RLS hiding it).'
    )
  }

  // Hop 3: operations + jobs, purely to label each row (name lookups, not filters) — every
  // operation_id / job_id that showed up in hop 2 is looked up as-is, regardless of line. The
  // one exception is is_active: a retired operation (merged away on /tryouts) is excluded, and
  // since a merge moves every operation_time onto the keeper before retiring, it has no times
  // left to contribute — the total is unchanged by the merge, it just stops being attributed to
  // a name nobody can see any more.
  const opIds = [...new Set(times.map((t) => t.operation_id as string))]
  const { data: opRows, error: opsError } = opIds.length > 0
    ? await supabase.from('operations').select('id, name, job_id, primary_operator_id, secondary_operator_id').in('id', opIds).eq('is_active', true)
    : { data: [] as { id: string; name: string; job_id: string; primary_operator_id: string | null; secondary_operator_id: string | null }[], error: null }
  if (opsError) throw new Error(opsError.message)
  const operations = opRows ?? []

  const jobIds = [...new Set(operations.map((o) => o.job_id as string))]
  const { data: jobRows, error: jobsError } = jobIds.length > 0
    ? await supabase.from('jobs').select('id, name').in('id', jobIds)
    : { data: [] as { id: string; name: string }[], error: null }
  if (jobsError) throw new Error(jobsError.message)
  const jobs = jobRows ?? []

  // Hop 4: group by operation_id, average per operation, sum the averages — modelTotalMinutes
  // itself, unchanged; this function only fixes *what* gets fed into it.
  const linkRows: TimeModelRow[] = timeIds.map((id) => ({ operation_time_id: id, product_id: productId }))
  const result = modelTotalMinutes({ productId, operations, jobs, operationTimes: times, operationTimeModels: linkRows })

  const rawSumMinutes = times.reduce((sum, t) => sum + (t.total_minutes ?? 0), 0)
  console.log(
    '[modelTotalMinutes] hop 4 — grouped by operation:',
    result.operations.map((r) => `${r.operationName}: avg ${r.avgMinutes.toFixed(1)}m × ${r.runs} run(s)`)
  )
  console.log(
    '[modelTotalMinutes] TOTAL (average per operation, then summed):', result.totalMinutes,
    '— raw SUM(total_minutes) for comparison (NOT what is shown):', rawSumMinutes
  )

  return {
    ...result,
    diagnostics: {
      resolvedProductId: productId,
      junctionLinkCount: timeIds.length,
      sampleOperationTimeIds: timeIds.slice(0, 5),
      operationTimesFoundCount: times.length,
      rawSumMinutes,
    },
    raw: {
      operations: operations.map((o) => ({ id: o.id, job_id: o.job_id, primary_operator_id: o.primary_operator_id, secondary_operator_id: o.secondary_operator_id })),
      operationTimes: times.map((t) => ({ id: t.id, operation_id: t.operation_id })),
      operationTimeModels: linkRows,
    },
  }
}

export interface RecordOperationTimeInput {
  operationId: string
  /** One or many product ids — one operation_time row is written and linked to every one of
   * them via operation_time_models (a multi-model /collect capture is still a single run). */
  productIds: string[]
  /**
   * Who was timed, or null for "nobody said". operation_times.operator_id is NOT NULL in the
   * database, so a null here is resolved to the shared placeholder operator rather than being
   * written through — see resolvePlaceholderOperatorId.
   */
  operatorId: string | null
  collectedBy: string
  totalMinutes: number
  startedAt?: string | null
  completedAt?: string | null
  /** Defaults to 0 (no pause). */
  pausedDurationSeconds?: number
  /** Defaults to null (no chassis attached). */
  chassisId?: string | null
  /** Defaults to false — set true only for bulk-imported historical data. */
  isImported?: boolean
}

/** The team/line a recorded time is filed under. Both columns are nullable on the table, so
 * this can carry nulls — but only after every source below has come up empty. */
interface TimeProvenance { teamId: string | null; productionLineId: string | null }

/**
 * The operator row that stands in for "we didn't record who was timed".
 *
 * operation_times.operator_id is NOT NULL (verified against the live schema, not just the
 * migration file), so an optional operator — /tryouts asks "who was timed?" at completion and
 * lets it be left blank — cannot be stored as null. It's stored as this row instead, which
 * already exists in the operators table (employee_id 999999) and is looked up by name rather
 * than hard-coded by id, so the same code works against a dev database seeded separately.
 *
 * Resolved once per page load and cached: it's a fixed row, and a save is not the moment to
 * spend a round trip re-confirming that.
 */
export const PLACEHOLDER_OPERATOR_NAME = 'Unassigned'

let placeholderOperatorId: string | null = null

export async function resolvePlaceholderOperatorId(supabase: SupabaseClient): Promise<string> {
  if (placeholderOperatorId) return placeholderOperatorId

  const { data, error } = await supabase
    .from('operators')
    .select('id')
    .eq('full_name', PLACEHOLDER_OPERATOR_NAME)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Could not look up the "${PLACEHOLDER_OPERATOR_NAME}" operator: ${error.message}`)
  if (!data) {
    throw new Error(
      `This time has no operator, and operation_times requires one. Add an operator named ` +
      `"${PLACEHOLDER_OPERATOR_NAME}" in Config to record times with nobody named, or pick an operator.`
    )
  }

  placeholderOperatorId = data.id as string
  return placeholderOperatorId
}

/**
 * Where a time's team_id/production_line_id come from: the STRUCTURE it was recorded against —
 * the operation's job — not the operator who happened to be timed.
 *
 * The job is the source of truth because that's what the team/line columns are read as
 * everywhere else: /dashboard filters `operation_times.production_line_id` to answer "how much
 * was collected on this line", and team rollups mean "work belonging to this team's part of the
 * walk". An operator is a footnote on the run (operator_id still records who was timed), and
 * operators move between teams — stamping their current team made a time's provenance depend on
 * staffing rather than on the work, so the same job's runs could land under different teams.
 *
 * Resolved in flat hops rather than one embedded select, matching the rest of this module —
 * PostgREST returns an embed as object-or-array depending on the relationship it infers, and
 * the provenance of a time is not worth making conditional on that.
 *
 * jobs.team_id and jobs.production_line_id are both nullable (and an operation's job_id can be
 * null), so if the job can't supply a field this falls back, per field, to the operator's
 * current team/line — the source this used to stamp from — and logs that it had to. Writing a
 * null is the last resort when neither the job nor the operator has anything to give.
 */
async function resolveTimeProvenance(
  supabase: SupabaseClient,
  operationId: string,
  operatorId: string
): Promise<TimeProvenance> {
  // Hop 1: the operation → its job.
  const { data: operation, error: operationError } = await supabase
    .from('operations')
    .select('job_id')
    .eq('id', operationId)
    .single()
  if (operationError || !operation) {
    throw new Error(operationError?.message ?? `Operation ${operationId} not found`)
  }

  // Hop 2: the job → the team/line to stamp.
  let job: { team_id: string | null; production_line_id: string | null } | null = null
  if (operation.job_id) {
    const { data, error } = await supabase
      .from('jobs')
      .select('team_id, production_line_id')
      .eq('id', operation.job_id)
      .single()
    if (error) throw new Error(error.message)
    job = data as { team_id: string | null; production_line_id: string | null } | null
  }

  if (job?.team_id && job?.production_line_id) {
    return { teamId: job.team_id, productionLineId: job.production_line_id }
  }

  // Degraded path: the job didn't supply both. Never abort the save over it — a recorded time
  // is worth more than perfect provenance — but say exactly what was missing, since a job with
  // no team or line is a structure problem to fix on /setup.
  console.warn(
    '[recordOperationTime] operation', operationId, '→ job', operation.job_id ?? '(none)',
    'did not supply both team_id and production_line_id (team_id =', job?.team_id ?? null,
    ', production_line_id =', job?.production_line_id ?? null,
    '). Falling back to the operator\'s current team/line for whichever is missing — set them on',
    'the job in Setup so times file under the right team.'
  )

  const { data: operator, error: operatorError } = await supabase
    .from('operators')
    .select('team_id, production_line_id')
    .eq('id', operatorId)
    .single()
  if (operatorError || !operator) {
    console.error(
      '[recordOperationTime] fallback lookup of operator', operatorId, 'also failed',
      `(${operatorError?.message ?? 'not found'}) — recording this time with whatever the job gave.`
    )
  }

  const resolved: TimeProvenance = {
    teamId: job?.team_id ?? operator?.team_id ?? null,
    productionLineId: job?.production_line_id ?? operator?.production_line_id ?? null,
  }
  if (resolved.teamId === null || resolved.productionLineId === null) {
    console.error(
      '[recordOperationTime] neither the job nor the operator could supply',
      resolved.teamId === null ? 'team_id' : '', resolved.productionLineId === null ? 'production_line_id' : '',
      '— writing null. This time will be missing from team/line rollups until it is corrected.'
    )
  }
  return resolved
}

/**
 * The only function anywhere that inserts into operation_times (and, via this, the only place
 * that inserts into operation_time_models). Every screen that records a time — /collect, the
 * /model-total's "add time", /tryouts' capture panel, and the
 * /dashboard drawer — calls this instead of writing its own
 * `.from('operation_times').insert(...)`, so defaults, validation, and the team/line stamp live
 * in exactly one place. None of them passes a team or line of its own: there is no input field
 * for one, so this resolution can't be overridden by a caller.
 *
 * team_id/production_line_id are stamped from the operation's JOB — see resolveTimeProvenance.
 * operator_id still records who was timed; it just no longer decides which team the time
 * belongs to.
 *
 * Links the time to every id in `productIds` via operation_time_models — operation_times has
 * no product_id column of its own, so a time without at least one such link would be invisible
 * to per-model coverage/averages.
 */
export async function recordOperationTime(
  supabase: SupabaseClient,
  input: RecordOperationTimeInput
): Promise<OperationTime> {
  const {
    operationId, productIds, operatorId, collectedBy, totalMinutes,
    startedAt = null, completedAt = null, pausedDurationSeconds = 0,
    chassisId = null, isImported = false,
  } = input

  if (!(totalMinutes > 0)) {
    throw new Error('Minutes must be greater than 0')
  }
  if (productIds.length === 0) {
    throw new Error('At least one model must be selected')
  }

  // Resolved BEFORE provenance so the degraded "fall back to the operator's team/line" path
  // below still has a real operator row to read, rather than being handed a null it can't use.
  const resolvedOperatorId = operatorId ?? await resolvePlaceholderOperatorId(supabase)

  const provenance = await resolveTimeProvenance(supabase, operationId, resolvedOperatorId)

  const { data: created, error: insertError } = await supabase
    .from('operation_times')
    .insert({
      operation_id: operationId,
      operator_id: resolvedOperatorId,
      collected_by: collectedBy,
      chassis_id: chassisId,
      started_at: startedAt,
      paused_duration_seconds: pausedDurationSeconds,
      completed_at: completedAt,
      total_minutes: totalMinutes,
      is_imported: isImported,
      team_id: provenance.teamId,
      production_line_id: provenance.productionLineId,
    })
    .select('*')
    .single()
  if (insertError || !created) {
    throw new Error(insertError?.message ?? 'Could not save time')
  }

  const { error: linkError } = await supabase
    .from('operation_time_models')
    .insert(productIds.map((productId) => ({ operation_time_id: created.id, product_id: productId })))
  if (linkError) {
    throw new Error(linkError.message)
  }

  return created as OperationTime
}

/**
 * The only function anywhere that updates operation_times.total_minutes — the edit-side
 * counterpart of recordOperationTime, so a corrected figure can't be written by an inline
 * `.from('operation_times').update(...)` that skips the "must be > 0" rule.
 *
 * RLS on operation_times is "update own" (auth.uid() = collected_by), and a row filtered out by
 * that policy comes back successful having changed nothing — so the updated row is read back and
 * its absence reported, rather than letting the caller show a saved value the database rejected.
 */
export async function updateOperationTimeMinutes(
  supabase: SupabaseClient,
  operationTimeId: string,
  totalMinutes: number
): Promise<OperationTime> {
  if (!(totalMinutes > 0)) {
    throw new Error('Minutes must be greater than 0')
  }

  const { data: updated, error } = await supabase
    .from('operation_times')
    .update({ total_minutes: totalMinutes })
    .eq('id', operationTimeId)
    .select('*')
  if (error) {
    throw new Error(error.message)
  }
  if (!updated || updated.length === 0) {
    throw new Error('That time could not be updated — you can only edit times you collected.')
  }

  return updated[0] as OperationTime
}

/**
 * The only function anywhere that deletes from operation_times. Its operation_time_models links
 * and operation_time_notes are removed by the database itself (both FKs are `on delete
 * cascade`), so this deliberately deletes nothing else — a manual pre-delete of either would be
 * a second, drifting cleanup path.
 *
 * Deleting is admin-only under RLS, and a delete filtered out by policy succeeds having removed
 * nothing, so the deleted row is read back and its absence reported instead of leaving a screen
 * to refresh into an unchanged list with no explanation.
 */
export async function deleteOperationTime(supabase: SupabaseClient, operationTimeId: string): Promise<void> {
  const { data: deleted, error } = await supabase
    .from('operation_times')
    .delete()
    .eq('id', operationTimeId)
    .select('id')
  if (error) {
    throw new Error(error.message)
  }
  if (!deleted || deleted.length === 0) {
    throw new Error('That time could not be deleted — deleting recorded times is restricted to admins.')
  }
}

/**
 * The only function anywhere that inserts into operation_time_notes — mirrors
 * recordOperationTime's role for the notes table so a note-write can't drift into an inline
 * `.from('operation_time_notes').insert(...)` on some screen.
 */
export async function addOperationTimeNote(
  supabase: SupabaseClient,
  operationTimeId: string,
  content: string,
  createdBy: string
): Promise<OperationTimeNote> {
  const trimmed = content.trim()
  if (!trimmed) {
    throw new Error('Note content must not be empty')
  }

  const { data: created, error } = await supabase
    .from('operation_time_notes')
    .insert({ operation_time_id: operationTimeId, content: trimmed, created_by: createdBy })
    .select('*')
    .single()
  if (error || !created) {
    throw new Error(error?.message ?? 'Could not save note')
  }

  return created as OperationTimeNote
}

/**
 * The only function anywhere that updates operation_time_notes.content — pairs with
 * addOperationTimeNote/deleteOperationTimeNote so an edit can't drift into an inline
 * `.from('operation_time_notes').update(...)` on some screen. RLS only allows a user to
 * update their own note, so this rejects (surface the message, don't swallow it) when a
 * caller tries to edit someone else's.
 */
export async function updateOperationTimeNote(
  supabase: SupabaseClient,
  noteId: string,
  content: string
): Promise<OperationTimeNote> {
  const trimmed = content.trim()
  if (!trimmed) {
    throw new Error('Note content must not be empty')
  }

  const { data: updated, error } = await supabase
    .from('operation_time_notes')
    .update({ content: trimmed })
    .eq('id', noteId)
    .select('*')
    .single()
  if (error || !updated) {
    throw new Error(error?.message ?? 'Could not update note')
  }

  return updated as OperationTimeNote
}

/** The only function anywhere that deletes from operation_time_notes. */
export async function deleteOperationTimeNote(supabase: SupabaseClient, noteId: string): Promise<void> {
  const { error } = await supabase.from('operation_time_notes').delete().eq('id', noteId)
  if (error) {
    throw new Error(error.message)
  }
}

/**
 * Notes for a batch of operation_time ids, newest first, with the author's name attached —
 * the read-side counterpart of add/update/deleteOperationTimeNote so nothing needs its own
 * inline `.from('operation_time_notes').select(...)`.
 */
export async function fetchOperationTimeNotes(
  supabase: SupabaseClient,
  operationTimeIds: string[]
): Promise<OperationTimeNote[]> {
  if (operationTimeIds.length === 0) return []

  // Flat select, no embedded `profiles` relationship — the author's name (when needed) is
  // merged in client-side by the caller instead, so this can't fail because of a relationship
  // name that doesn't resolve.
  const { data, error } = await supabase
    .from('operation_time_notes')
    .select('*')
    .in('operation_time_id', operationTimeIds)
    .order('created_at', { ascending: false })
  if (error) {
    throw new Error(error.message)
  }

  return (data ?? []) as OperationTimeNote[]
}
