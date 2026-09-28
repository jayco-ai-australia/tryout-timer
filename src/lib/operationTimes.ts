import type { SupabaseClient } from '@supabase/supabase-js'
import { chunked, fetchAllChunked, fetchAllRows, logSupabaseError, READ_CHUNK } from './supabaseRead'
import { selectIn } from './chunkedIn'
import type { OperationTime, OperationTimeNote } from './types'

/**
 * The single operation_times module — every screen that reads or writes operation_times
 * (/collect, /tryouts, /dashboard, /model-total) goes through the helpers here so the labour
 * math and the insert shape can't drift between screens.
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

/**
 * A labour figure for one operation (optionally scoped to one model), and the history behind it.
 *
 * `minutes` USED TO BE the mean of every recorded run. It is not any more: it is the CURRENT
 * record's total_minutes, full stop. A run is a measurement of the same work, not a sample of a
 * distribution — three runs of an operation are three attempts to state one figure, and the
 * latest agreed one is the answer. Averaging them made every re-measure drag the number halfway
 * back to a figure somebody had already decided was wrong.
 */
export interface OperationTimeStat {
  /** The current record's total_minutes — THE labour content for this pair. */
  minutes: number
  /** Which record that is, so a caller can open or promote against it. */
  currentId: string
  /** How many superseded records sit behind it. Displayed as history, never averaged in. */
  archived: number
}

/**
 * How a figure's history reads wherever a run count used to be shown.
 *
 * "3 runs averaged" was a statement about how the number was computed. It isn't computed that
 * way any more: the number IS one record, and the others are what it replaced. One phrase, one
 * definition, every surface — /collect's model badges, /setup's coverage badges and collected
 * times, /tryouts' van log, /model-total's breakdown and the times drawer.
 */
export function historyLabel(stat: OperationTimeStat): string {
  return stat.archived === 0
    ? 'current, no earlier records'
    : `current + ${stat.archived} archived`
}

/**
 * ── What a job's figure is worth ───────────────────────────────────────────────────────────
 *
 * A job's minutes are the sum of its operations' current records. "142.0m" means something
 * different depending on whether that is all of the job or three-fifths of it, so every surface
 * that prints or draws a job figure has to be able to say which — and say it the same way.
 *
 *   'timed'   every operation of the job has a current record — the figure is the job.
 *   'partial' some do. The figure is real and INCOMPLETE, which is the dangerous case: a
 *             partially timed job shown as a plain number reads as a finished measurement.
 *   'none'    nothing timed. 0.0, which without a marker cannot be told apart from a job that
 *             genuinely takes no labour.
 *
 * Lives here rather than in a screen because it is now asked by /model-total's two print sheets
 * and by /labour-matrix's grid and its A3 print, and three copies of a three-way rule is three
 * chances for one of them to call a partial job finished.
 */
export type JobCompleteness = 'timed' | 'partial' | 'none'

export function jobCompleteness(timedOps: number, totalOps: number): JobCompleteness {
  if (timedOps === 0) return 'none'
  return timedOps < totalOps ? 'partial' : 'timed'
}

/**
 * The minimum of an operation_times row needed to work out a labour figure.
 *
 * superseded_by is REQUIRED, deliberately and unavoidably: it is the column that says which row
 * is the figure. Making it optional would let a caller select the old three columns, get an
 * answer that silently treats every archived run as current, and never hear about it — which is
 * exactly the class of drift this module exists to prevent. Required, TypeScript finds every
 * read that feeds a number.
 */
interface TimeRow {
  id: string
  operation_id: string
  total_minutes: number | null
  superseded_by: string | null
  /** Only used to break a tie if the data ever holds two current rows for one pair. */
  created_at?: string
}
interface TimeModelRow { operation_time_id: string; product_id: string }

/**
 * Pick the current row out of a pair's rows, and count what it replaced.
 *
 * THE one implementation of "which of these is the figure". Both public helpers below call it,
 * and nothing else may re-derive it — this logic was inlined in seven places once and the copies
 * drifted, which is the whole reason for the rule.
 *
 * Exactly one row per pair should have superseded_by = null. Where the data holds more than one
 * (a half-applied write, a hand edit), the newest wins rather than the first encountered, so the
 * figure is at least deterministic between renders instead of depending on row order. Where it
 * holds none, there is no figure: null, and the caller renders the pair as untimed rather than
 * quietly promoting an archived run to headline status.
 */
function pickCurrent(rows: TimeRow[]): OperationTimeStat | null {
  const current = rows.filter((r) => r.superseded_by == null)
  if (current.length === 0) return null

  const winner = current.length === 1
    ? current[0]
    : [...current].sort((a, b) => {
        const byDate = (b.created_at ?? '').localeCompare(a.created_at ?? '')
        return byDate !== 0 ? byDate : b.id.localeCompare(a.id)
      })[0]

  if (winner.total_minutes == null) return null
  return { minutes: winner.total_minutes, currentId: winner.id, archived: rows.length - 1 }
}

/**
 * ── Copied records: the note IS the record of where a figure came from ──────────────────────
 *
 * /model-total's copy-to-other-models writes each copy as an ordinary operation_time with
 * `is_imported: true` and a note naming the model it came from. There is no "copied" column and
 * there deliberately isn't one: a copy is a real recorded time, and a flag would be a second
 * source of truth to keep in sync with the note a person actually reads.
 *
 * The writer and the reader live here together on purpose. When the phrasing was only a template
 * literal at the write site, nothing anywhere could recognise a copy after the fact — which is
 * how copied figures became indistinguishable from measured ones on screen.
 */
const COPIED_NOTE_PREFIX = 'Copied from '

/** The note text written on every copied record. */
export function copiedNoteFor(sourceModel: string): string {
  return `${COPIED_NOTE_PREFIX}${sourceModel}`
}

/**
 * The source model named by a copy note, or null if this note isn't one.
 *
 * Case-insensitive on the prefix only — the model name itself comes back exactly as written,
 * since it has to match what a person sees in the model picker.
 */
export function parseCopiedFrom(noteContent: string | null | undefined): string | null {
  if (!noteContent) return null
  const text = noteContent.trim()
  if (text.length <= COPIED_NOTE_PREFIX.length) return null
  if (text.slice(0, COPIED_NOTE_PREFIX.length).toLowerCase() !== COPIED_NOTE_PREFIX.toLowerCase()) return null
  return text.slice(COPIED_NOTE_PREFIX.length).trim() || null
}

/** Composite key used to look up a stat for a given (operation, product) pair. */
export function operationProductKey(operationId: string, productId: string): string {
  return `${operationId}:${productId}`
}

/**
 * The current labour figure per (operation, product) pair. Replaces averageForOperation, which
 * returned the mean of every run — see OperationTimeStat for why that rule was retired.
 *
 * operation_times doesn't carry product_id: that comes from the operation_time_models junction,
 * which is why both the rows and their model links are required here. A run linked to four
 * models is the current figure for four pairs at once.
 *
 * Hand it EVERY row for the operations in question, archived ones included, and it sorts them
 * out. It also works over a set already filtered to `superseded_by is null` — every row is then
 * current, and `archived` reads 0 because no history was asked for. Either input gives the same
 * `minutes`; only the history count differs, so a surface that shows the count must not filter.
 */
export function currentForOperation(times: TimeRow[], timeModels: TimeModelRow[]): Record<string, OperationTimeStat> {
  const timeById = new Map(times.map((t) => [t.id, t]))

  const byPair = new Map<string, TimeRow[]>()
  for (const tm of timeModels) {
    const t = timeById.get(tm.operation_time_id)
    if (!t) continue
    const key = operationProductKey(t.operation_id, tm.product_id)
    const list = byPair.get(key)
    if (list) list.push(t)
    else byPair.set(key, [t])
  }

  const result: Record<string, OperationTimeStat> = {}
  for (const [key, rows] of byPair) {
    const stat = pickCurrent(rows)
    if (stat) result[key] = stat
  }
  return result
}

/**
 * The current labour figure per operation, NOT scoped to a model — the row-level stat shown
 * beside an operation's name (/collect's operation list, /tryouts' van log).
 *
 * Note what "current" means without a product in play: a run's superseded_by is set when a newer
 * run replaces it FOR A MODEL, so an operation-level view of a multi-model operation can see
 * several current rows. The newest wins (see pickCurrent) rather than an average of them, which
 * keeps this consistent with every model-scoped figure on the same screen.
 */
export function currentByOperation(times: TimeRow[]): Record<string, OperationTimeStat> {
  const byOperation = new Map<string, TimeRow[]>()
  for (const t of times) {
    const list = byOperation.get(t.operation_id)
    if (list) list.push(t)
    else byOperation.set(t.operation_id, [t])
  }

  const result: Record<string, OperationTimeStat> = {}
  for (const [operationId, rows] of byOperation) {
    const stat = pickCurrent(rows)
    if (stat) result[operationId] = stat
  }
  return result
}

export interface ModelTotalOperationRow {
  operationId: string
  operationName: string
  jobId: string
  jobName: string
  /** The current record's total_minutes — this operation's labour content for the model. */
  minutes: number
  /** Superseded records behind it. History for the drawer; never part of the figure. */
  archived: number
  /** WHICH record the figure came from — `stat.currentId`, already computed by
   * currentForOperation and previously thrown away here. Surfaced so a caller can ask something
   * about the record itself rather than only about its number: /model-total reads its note and
   * is_imported flag to mark a row whose figure was copied from another model rather than
   * measured on this one. */
  currentTimeId: string
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
 * A model's total labour content: for every operation timed against this model, take THE CURRENT
 * RECORD's total_minutes, and sum those across operations.
 *
 * This changed. It used to average an operation's runs and sum the averages; it now takes the
 * one record marked current (superseded_by is null) and sums those. Never SUM(total_minutes)
 * raw either — that would count an operation once per time it was ever measured. Built on
 * currentForOperation, the same per-(operation, product) lookup every other surface uses, so the
 * rule can't drift into a second implementation here.
 *
 * No 50/50 operator split: that halving is a workload-assignment concept for when two operators
 * share a secondary operation, and has nothing to do with a model's own labour content, which
 * always uses the operation's full current figure.
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

  const pairStats = currentForOperation(operationTimes, operationTimeModels)
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
      minutes: stat.minutes,
      archived: stat.archived,
      currentTimeId: stat.currentId,
      primaryOperatorId: op.primary_operator_id,
      secondaryOperatorId: op.secondary_operator_id,
    })
  }

  const totalMinutes = rows.reduce((sum, r) => sum + r.minutes, 0)
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
    /** Hop 3's jobs, with the line each one belongs to. `jobs.production_line_id` is the source
     * of truth for which line a piece of labour sits on (operation_times carries a copy stamped
     * from the job, but the job is the original), and it rides along here rather than being
     * re-fetched: a caller splitting this total by line — /model-total's labour-source filter —
     * must attribute exactly the jobs this total was built from, or the parts stop summing to
     * the whole. */
    jobs: { id: string; name: string; production_line_id: string | null }[]
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
 *
 * A FAILING hop logs too, and logs the whole PostgREST error — message, details, hint and code —
 * before re-throwing (logSupabaseError, lib/supabaseRead). `throw new Error(error.message)` is
 * what the caller needs for its banner, but it keeps only one of the four fields, and the page's
 * banner then says "Bad Request" while the sentence naming the offending column never reaches
 * anywhere a person looks. Each hop names itself in the log, so a failure is placed in the chain
 * without reading this file.
 */
export async function fetchModelTotal(supabase: SupabaseClient, productId: string): Promise<ModelTotalFetchResult> {
  console.log('[modelTotalMinutes] resolvedProductId =', productId)

  // Hop 1: the junction, filtered ONLY by product_id.
  const { data: links, error: linksError } = await supabase
    .from('operation_time_models')
    .select('operation_time_id')
    .eq('product_id', productId)
  if (linksError) {
    logSupabaseError('hop 1 — operation_time_models WHERE product_id', linksError)
    throw new Error(linksError.message)
  }

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
      raw: { operations: [], operationTimes: [], operationTimeModels: [], jobs: [] },
    }
  }

  // Hop 2: the operation_times rows themselves — id IN (...) only. No production_line_id,
  // is_imported, or is_active filter here or anywhere above it. See the is_active note at the
  // top of this module: filtering it here is what took /dashboard coverage to 0.5%.
  //
  // Deliberately NOT filtered to `superseded_by is null` either, even though only the current
  // record contributes to the total. The page shows "current + N archived" beside every figure,
  // and currentForOperation counts that N from the rows it is handed — filter here and every
  // operation would report a history of 0. The figure is picked by the helper, not by the query;
  // superseded_by is selected so it can be.
  //
  // Chunked (lib/chunkedIn): timeIds is one id per link found in hop 1, and on the Motor Home
  // line that is ~700 of them — a ~28KB URL, which Supabase's edge rejected with a bare 400.
  // A primary-key lookup, so chunking alone is complete: 100 ids can return at most 100 rows,
  // well under the response cap. Order is not asked for here and not relied on — the rows are
  // grouped by operation_id downstream, never read positionally.
  const times = await selectIn<TimeRow>(timeIds, async (chunk) => {
    const res = await supabase
      .from('operation_times')
      .select('id, operation_id, total_minutes, superseded_by, created_at')
      .in('id', chunk)
    if (res.error) logSupabaseError('hop 2 — operation_times WHERE id IN (…)', res.error)
    return res
  })
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
  // Chunked for the same reason as hop 2. The is_active filter stays INSIDE the chunk callback,
  // so every chunk carries it and the result set is identical to the single-request version.
  const operations = await selectIn<{ id: string; name: string; job_id: string; primary_operator_id: string | null; secondary_operator_id: string | null }>(
    opIds,
    async (chunk) => {
      const res = await supabase
        .from('operations').select('id, name, job_id, primary_operator_id, secondary_operator_id')
        .in('id', chunk).eq('is_active', true)
      if (res.error) logSupabaseError('hop 3 — operations WHERE id IN (…) AND is_active', res.error)
      return res
    }
  )

  const jobIds = [...new Set(operations.map((o) => o.job_id as string))]
  // Identity lookup by id — NOT filtered to is_active, so a retired job still labels the
  // operations feeding this total. See the note at the top of lib/jobs.
  const jobs = await selectIn<{ id: string; name: string; production_line_id: string | null }>(jobIds, async (chunk) => {
    const res = await supabase.from('jobs').select('id, name, production_line_id').in('id', chunk)
    if (res.error) logSupabaseError('hop 3 — jobs WHERE id IN (…)', res.error)
    return res
  })

  // Hop 4: group by operation_id, take each operation's CURRENT record, sum those —
  // modelTotalMinutes itself, unchanged; this function only fixes *what* gets fed into it.
  const linkRows: TimeModelRow[] = timeIds.map((id) => ({ operation_time_id: id, product_id: productId }))
  const result = modelTotalMinutes({ productId, operations, jobs, operationTimes: times, operationTimeModels: linkRows })

  const rawSumMinutes = times.reduce((sum, t) => sum + (t.total_minutes ?? 0), 0)
  console.log(
    '[modelTotalMinutes] hop 4 — current record per operation:',
    result.operations.map((r) => `${r.operationName}: ${r.minutes.toFixed(1)}m current + ${r.archived} archived`)
  )

  /**
   * Why the shown total sits below the raw sum, told apart in the log rather than guessed at.
   *
   * The total is now the sum of CURRENT records only, so a gap between it and SUM(total_minutes)
   * over every row is expected and healthy: every archived run's minutes are in `raw` and in
   * nothing else. `archivedMinutes` is exactly that history, and `unaccounted` is what is left
   * over once both are subtracted — which should be zero, and is not history at all when it
   * isn't. That residue is times whose operation never reached a row (hop 3 filters operations
   * to is_active, so a retired one's times land here), i.e. a genuine short-fall.
   */
  const currentMinutes = result.totalMinutes
  const archivedMinutes = times
    .filter((t) => t.superseded_by != null)
    .reduce((sum, t) => sum + (t.total_minutes ?? 0), 0)
  const unaccounted = rawSumMinutes - currentMinutes - archivedMinutes
  console.log(
    '[modelTotalMinutes] TOTAL (current record per operation, summed):', currentMinutes,
    '— archived history not counted:', archivedMinutes,
    '— raw SUM(total_minutes) over every row, for comparison:', rawSumMinutes
  )
  if (Math.abs(unaccounted) > 0.005) {
    console.warn(
      '[modelTotalMinutes]', unaccounted, 'minute(s) are neither in the total nor in the archived',
      'history — they belong to operation_times whose operation did not come back from hop 3.',
      'Hop 3 filters operations to is_active = true, so a retired (merged-away) operation is the',
      'usual cause. The shown total is short by that work, and this is NOT the current-record rule.'
    )
  } else {
    console.log(
      '[modelTotalMinutes] every raw minute is accounted for — the gap between', currentMinutes,
      'and', rawSumMinutes, 'is archived history alone (superseded runs are kept, never counted),',
      'not dropped rows.'
    )
  }

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
      jobs: jobs.map((j) => ({ id: j.id, name: j.name, production_line_id: j.production_line_id })),
    },
  }
}

/** A recorded run plus the FULL set of models it counts towards. See
 * fetchOperationTimesForModel — the fan-out is the thing an editor has to see. */
export interface OperationTimeWithModels extends OperationTime {
  productIds: string[]
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
  /**
   * Filing carried forward from an EXISTING run, for the one caller that is re-recording one
   * rather than observing new work: splitOperationTimeForModel.
   *
   * Leave it undefined and provenance is derived from the operation's job, which is the rule and
   * stays the rule (see resolveTimeProvenance) — a screen must never be able to hand-pick which
   * team a fresh time lands under. A split is the exception because it is not a fresh time: it is
   * half of a run that already exists, and the two halves have to agree on where they are filed.
   * For the same operation_id derivation normally returns the same answer anyway; this only
   * differs for a row whose filing predates the current structure, e.g. an import.
   */
  provenance?: TimeProvenance
}

/**
 * What recordOperationTime wrote. `savedProductIds` is what the run was actually linked to, and
 * can be SHORTER than what was asked for: models the operation does not apply to are refused,
 * not written (see the guard in recordOperationTime). A caller that recorded against more than
 * one model must report `refusedProductIds` — a partial save reported as a whole one is exactly
 * how the orphaned times this guard exists for went unnoticed.
 */
export interface RecordedOperationTime {
  created: OperationTime
  savedProductIds: string[]
  refusedProductIds: string[]
}

/**
 * recordOperationTime refused EVERY model it was handed, so nothing was written. A distinct type
 * so a caller can tell "this operation doesn't apply to that model" from a database failure and
 * say so in its own words — it knows the model names; the guard only knows ids.
 */
export class UnlinkedOperationError extends Error {
  constructor(public readonly operationId: string, public readonly productIds: string[]) {
    super(
      productIds.length === 1
        ? 'This operation doesn’t apply to this model, so the time was not saved. Apply the ' +
          'operation to the model first, then record the time.'
        : `This operation doesn’t apply to any of the ${productIds.length} models it was recorded ` +
          'against, so nothing was saved. Apply it to those models first, then record the time.'
    )
    this.name = 'UnlinkedOperationError'
  }
}

/**
 * Which of `productIds` the operation applies to — its model_operations rows. The read
 * recordOperationTime's guard is built on, exported so a screen can ask the same question before
 * it offers a save and get the same answer the guard will.
 *
 * Read inline rather than through lib/modelOperations, which imports from this module. Chunked
 * AND paged, with a total order over the junction's key — a short read here would refuse a model
 * that does apply, which fails closed but is still wrong.
 */
export async function fetchLinkedProductIds(
  supabase: SupabaseClient,
  operationId: string,
  productIds: string[]
): Promise<Set<string>> {
  if (productIds.length === 0) return new Set()
  const rows = await fetchAllChunked<{ product_id: string }>(
    [...new Set(productIds)], READ_CHUNK,
    (chunk) => supabase
      .from('model_operations').select('product_id')
      .eq('operation_id', operationId).in('product_id', chunk)
      .order('product_id'),
    { table: 'model_operations' }
  )
  return new Set(rows.map((r) => r.product_id))
}

/** The team/line a recorded time is filed under. Both columns are nullable on the table, so
 * this can carry nulls — but only after every source below has come up empty. */
export interface TimeProvenance { teamId: string | null; productionLineId: string | null }

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
 * The job's SECTION is the source of truth for the team, and the job itself for the line —
 * that's what the two columns are read as everywhere else: /dashboard filters
 * `operation_times.production_line_id` to answer "how much
 * was collected on this line", and team rollups mean "work belonging to this team's part of the
 * walk". An operator is a footnote on the run (operator_id still records who was timed), and
 * operators move between teams — stamping their current team made a time's provenance depend on
 * staffing rather than on the work, so the same job's runs could land under different teams.
 *
 * Resolved in flat hops rather than one embedded select, matching the rest of this module —
 * PostgREST returns an embed as object-or-array depending on the relationship it infers, and
 * the provenance of a time is not worth making conditional on that.
 *
 * A job can have no section at all, or no line — and an operation's job_id can be null — so if
 * the structure
 * can't supply a field this falls back, per field, to the job's own redundant team_id and then
 * to the operator's current team/line, logging that it had to. Writing a null is the last resort
 * when nothing has anything to give.
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

  // Hop 2: the job → its line, and the section it sits in.
  type JobProvenanceRow = { team_id: string | null; production_line_id: string | null; section_id: string | null }
  let job: JobProvenanceRow | null = null
  if (operation.job_id) {
    // Identity lookup by id — NOT filtered to is_active. This resolves where an existing
    // operation's work belongs, and a retired job's provenance is still the right answer.
    const { data, error } = await supabase
      .from('jobs')
      .select('team_id, production_line_id, section_id')
      .eq('id', operation.job_id)
      .single()
    if (error) throw new Error(error.message)
    job = (data ?? null) as JobProvenanceRow | null
  }

  // Hop 3: the section → the team. The SECTION owns the team (see lib/sections' teamForJob), so
  // that is what a time is filed under; jobs.team_id is the redundant copy and is only consulted
  // below, in the degraded path, when the section can't answer.
  let sectionTeamId: string | null = null
  if (job?.section_id) {
    const { data } = await supabase.from('sections').select('team_id').eq('id', job.section_id).single()
    sectionTeamId = (data?.team_id as string | null) ?? null
  }

  if (sectionTeamId && job?.production_line_id) {
    return { teamId: sectionTeamId, productionLineId: job.production_line_id }
  }

  // Degraded path: the job didn't supply both. Never abort the save over it — a recorded time
  // is worth more than perfect provenance — but say exactly what was missing, since a job with
  // no team or line is a structure problem to fix on /setup.
  console.warn(
    '[recordOperationTime] operation', operationId, '→ job', operation.job_id ?? '(none)',
    'could not supply both a team (via its section) and a production line (section_id =',
    job?.section_id ?? null, ', section team_id =', sectionTeamId,
    ', job production_line_id =', job?.production_line_id ?? null,
    '). Falling back to the job\'s own team_id, then the operator\'s current team/line, for',
    'whichever is missing — put the job in a real section on Setup so its times file under the',
    'right team. A job with no section at all has no team to inherit.'
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
    teamId: sectionTeamId ?? job?.team_id ?? operator?.team_id ?? null,
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
): Promise<RecordedOperationTime> {
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

  /**
   * ── THE APPLICABILITY GUARD ─────────────────────────────────────────────────────────────
   *
   * A time is only ever recorded against a model the operation APPLIES to (a model_operations
   * row). Every screen that records a time funnels through here, and until this guard none of
   * them was checked: a time for an unlinked pair counts towards the model's total while the
   * operation is missing from its coverage — the state behind 554 orphaned records and 18,211
   * minutes of inflated totals. Checked here once rather than trusted from seven callers.
   *
   * Unlinked models are REFUSED and the rest are written: one model of five that the operation
   * doesn't apply to is no reason to lose the other four and invite a duplicate re-entry. The
   * refused ids come back on the result for the caller to report. Every model refused → nothing
   * is written and UnlinkedOperationError is thrown.
   *
   * A failed read throws before anything is written — this fails closed.
   *
   * This is a browser-side check, so it still races with a concurrent unlink landing between the
   * read and the insert. Only a database constraint closes that completely. The window is one
   * round trip, and it also covers the case where a pair was unlinked while a stopwatch ran.
   */
  const linkedIds = await fetchLinkedProductIds(supabase, operationId, productIds)
  const savedProductIds = [...new Set(productIds)].filter((id) => linkedIds.has(id))
  const refusedProductIds = [...new Set(productIds)].filter((id) => !linkedIds.has(id))
  if (savedProductIds.length === 0) {
    throw new UnlinkedOperationError(operationId, refusedProductIds)
  }

  // Resolved BEFORE provenance so the degraded "fall back to the operator's team/line" path
  // below still has a real operator row to read, rather than being handed a null it can't use.
  const resolvedOperatorId = operatorId ?? await resolvePlaceholderOperatorId(supabase)

  // Derived, unless the caller is carrying an existing run's filing forward — see `provenance`
  // on the input type. Nothing else may supply it.
  const provenance = input.provenance ?? await resolveTimeProvenance(supabase, operationId, resolvedOperatorId)

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

  await linkOperationTimeToModels(supabase, created.id, savedProductIds)

  /**
   * A NEW time is the current one for every model it was recorded against, and whatever was
   * current for those pairs becomes history. Done HERE, in the single write path, rather than at
   * the seven call sites that record a time — /collect's complete, /tryouts' complete and manual
   * entry, /model-total's Add Time, CopyToModelsPanel, ModelLinker, the split — because a caller
   * that forgot would leave two current records for the pair and a labour figure that flips
   * between them depending on row order.
   *
   * Per product, because the pairs are independent: a run recorded against four models supersedes
   * four different previous records, and a model with no previous record supersedes nothing.
   *
   * Deliberately AFTER the insert and the links, and deliberately not fatal to them: the time is
   * banked and linked by this point, and throwing here would report a save that actually
   * succeeded as a failure. A pair briefly holding two current records resolves to the newest —
   * which is this one — so the figure is right even in the failure case; the warning is what says
   * the history behind it is not.
   */
  for (const productId of savedProductIds) {
    try {
      const pairTimes = await fetchOperationTimesForModel(supabase, operationId, productId)
      const previousCurrent = pairTimes
        .filter((t) => t.id !== created.id && t.superseded_by == null)
        .map((t) => t.id)
      await setSupersededBy(supabase, previousCurrent, created.id)
    } catch (err) {
      console.warn(
        '[recordOperationTime] time', created.id, 'was saved and linked, but the previous current',
        'record for product', productId, 'could not be archived:',
        err instanceof Error ? err.message : err,
        '— the new record is the newest, so it is the figure being shown, but this pair now has',
        'more than one record marked current. Promote the right one from the times drawer.'
      )
    }
  }

  return { created: created as OperationTime, savedProductIds, refusedProductIds }
}

// ── operation_time_models: the junction, and the only three functions that touch it ────────
/**
 * operation_times has NO product_id column. Which models a recorded run counts towards lives
 * entirely in `operation_time_models`, one row per (time, model) — and ONE time can be linked to
 * MANY models, which is what makes editing a time a multi-model act (see
 * splitOperationTimeForModel).
 *
 * These three functions are the only things anywhere that read or write that junction.
 * recordOperationTime's insert used to be inline here; it now goes through the same writer the
 * split path uses, so a link can't be created two slightly different ways.
 */

/** The only function anywhere that inserts into operation_time_models. */
export async function linkOperationTimeToModels(
  supabase: SupabaseClient,
  operationTimeId: string,
  productIds: string[]
): Promise<void> {
  if (productIds.length === 0) return
  const { error } = await supabase
    .from('operation_time_models')
    .insert(productIds.map((productId) => ({ operation_time_id: operationTimeId, product_id: productId })))
  if (error) throw new Error(error.message)
}

/**
 * The only function anywhere that deletes from operation_time_models — one (time, model) pair.
 *
 * The deleted row is read back and its absence reported rather than assumed: a delete filtered
 * out by RLS comes back successful having removed nothing, and this is the FIRST step of a split
 * (see splitOperationTimeForModel). Letting a silent no-op through there would leave the model
 * linked to both the original and the new record, double-counting the run in every average
 * built off it.
 */
export async function unlinkOperationTimeFromModel(
  supabase: SupabaseClient,
  operationTimeId: string,
  productId: string
): Promise<void> {
  const { data, error } = await supabase
    .from('operation_time_models')
    .delete()
    .eq('operation_time_id', operationTimeId)
    .eq('product_id', productId)
    .select('operation_time_id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error(
      'This record could not be unlinked from the model — the change was rejected by the ' +
      'database (check your permissions). Nothing has been changed.'
    )
  }
}

/**
 * MANY (time, model) links for ONE model, in as few round trips as the ids allow — the bulk form
 * of unlinkOperationTimeFromModel, and the second of the two deleters this junction has.
 *
 * Built for lib/modelLinks' "this operation doesn't apply to this model" unlink, where a single
 * job can carry dozens of recorded runs and one delete per run is dozens of round trips.
 *
 * A ROW REMOVED HERE NEVER REMOVES A TIME. operation_times and operation_time_notes are not
 * touched by this function or by anything that calls it: a run whose last link goes is UNATTACHED
 * — zero rows in this junction — and it stays in operation_times, keeps its notes, and still
 * appears in /reports. That state already exists in this database on historical records, so it is
 * a state the app has to read rather than a hole this creates.
 *
 * Unlike the single-pair form this does NOT throw when it removes nothing. The caller is deleting
 * over a set it computed from a read, and a link that has gone in between is the outcome it
 * wanted; the count comes back so a partial RLS rejection is still visible as removed < asked.
 */
export async function unlinkOperationTimesFromModel(
  supabase: SupabaseClient,
  operationTimeIds: string[],
  productId: string
): Promise<{ removed: number; attempted: number; error: string | null }> {
  if (operationTimeIds.length === 0) return { removed: 0, attempted: 0, error: null }
  let removed = 0
  let error: string | null = null
  for (const chunk of chunked(operationTimeIds, READ_CHUNK)) {
    const { data, error: err } = await supabase
      .from('operation_time_models')
      .delete()
      .eq('product_id', productId)
      .in('operation_time_id', chunk)
      .select('operation_time_id')
    if (err) error ??= err.message
    else removed += (data ?? []).length
  }
  return { removed, attempted: operationTimeIds.length, error }
}

/** Every (time, model) link for a batch of operation_time ids. Chunked and paged like every
 * other bulk read in the app (lib/supabaseRead) — a short read here would under-report a
 * record's model fan-out, which is exactly the warning the drawer exists to show. */
export async function fetchOperationTimeModelLinks(
  supabase: SupabaseClient,
  operationTimeIds: string[]
): Promise<{ operation_time_id: string; product_id: string }[]> {
  if (operationTimeIds.length === 0) return []
  return fetchAllChunked<{ operation_time_id: string; product_id: string }>(
    operationTimeIds, READ_CHUNK,
    (chunk) => supabase
      .from('operation_time_models').select('operation_time_id, product_id')
      .in('operation_time_id', chunk)
      .order('operation_time_id').order('product_id'),
    { table: 'operation_time_models' }
  )
}

// ── superseded_by: the current-record chain ────────────────────────────────────────────────
/**
 * The ONLY function anywhere that writes operation_times.superseded_by. Every promotion,
 * supersede-on-record and delete-promotion below goes through it, so "what makes a record
 * current" has exactly one implementation.
 *
 * Pass null to make records current, or a record id to archive them behind it. The written rows
 * are read back and a short result reported rather than assumed: RLS on operation_times is
 * "edit your own", and a filtered-out update comes back successful having changed nothing — which
 * on this column would leave a pair with two current records or none, both of which produce a
 * wrong labour figure that looks perfectly normal on screen.
 */
export async function setSupersededBy(
  supabase: SupabaseClient,
  operationTimeIds: string[],
  supersededById: string | null
): Promise<void> {
  if (operationTimeIds.length === 0) return
  for (const chunk of chunked(operationTimeIds, READ_CHUNK)) {
    const { data, error } = await supabase
      .from('operation_times')
      .update({ superseded_by: supersededById })
      .in('id', chunk)
      .select('id')
    if (error) throw new Error(error.message)
    if (!data || data.length < chunk.length) {
      throw new Error(
        'The current-record pointer could not be updated on every record — the change was ' +
        'rejected by the database (you can only edit times you collected). Nothing further was ' +
        'changed; re-open the record and try again.'
      )
    }
  }
}

/**
 * Newest first, by created_at with id breaking the tie — the order "most recent" means
 * everywhere in this module (which record supersedes which, which one a delete promotes).
 */
function newestFirst<T extends { id: string; created_at: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const byDate = b.created_at.localeCompare(a.created_at)
    return byDate !== 0 ? byDate : b.id.localeCompare(a.id)
  })
}

/**
 * Make an ARCHIVED record the current one for its operation+model, archiving whatever was
 * current behind it. The inverse of what recording a new time does automatically.
 *
 * All-or-nothing, and the order is chosen for which transient state is survivable:
 *   1. Clear the promoted record's pointer. The pair now briefly has TWO current records.
 *   2. Point the previously-current record(s) at the promoted one. The pair has one again.
 * If step 2 fails, step 1 is rolled back. The reverse order would leave the pair with ZERO
 * current records between the writes — no labour figure at all, i.e. the operation reads as an
 * untimed gap — and if the second write then failed it would STAY that way. Two current records
 * is the recoverable transient: pickCurrent resolves it to the newest, so the figure is briefly
 * arguable rather than briefly absent.
 *
 * Only the pair's own records move. A record current for four models that is superseded here is
 * superseded for THIS model's pair — which is the same row, so it is superseded for all four.
 * That is inherent to a figure living on the row rather than on the link, and it is why the
 * drawer offers a split: to give one model a record of its own first.
 */
export async function promoteOperationTime(
  supabase: SupabaseClient,
  { operationTimeId, operationId, productId }: { operationTimeId: string; operationId: string; productId: string }
): Promise<void> {
  const pairTimes = await fetchOperationTimesForModel(supabase, operationId, productId)
  const promoted = pairTimes.find((t) => t.id === operationTimeId)
  if (!promoted) {
    throw new Error('That record is no longer linked to this model, so it can’t be made the current one.')
  }
  if (promoted.superseded_by == null) return

  const previousCurrent = pairTimes.filter((t) => t.superseded_by == null)
  const originalPointer = promoted.superseded_by

  await setSupersededBy(supabase, [operationTimeId], null)
  try {
    await setSupersededBy(supabase, previousCurrent.map((t) => t.id), operationTimeId)
  } catch (err) {
    // Put it back rather than leaving two current records standing.
    try {
      await setSupersededBy(supabase, [operationTimeId], originalPointer)
    } catch {
      throw new Error(
        `The previous record could not be archived (${err instanceof Error ? err.message : 'rejected'}), ` +
        'and the promotion could not be undone either. This operation and model now have two ' +
        'current records — the newest is being used. Ask an admin to correct it.'
      )
    }
    throw new Error(
      `The previous current record could not be archived: ${err instanceof Error ? err.message : 'rejected'}. ` +
      'Nothing was changed.'
    )
  }
}

/** One operation's recorded runs, each carrying the full set of models it is linked to.
 *
 * `productId` narrows to the runs that count towards ONE model — but `productIds` on each row is
 * deliberately the WHOLE fan-out, not the narrowed set: a screen editing one of these has to be
 * able to say "this also counts for 3 other models" before anything is written. */
export async function fetchOperationTimesForModel(
  supabase: SupabaseClient,
  operationId: string,
  productId: string
): Promise<OperationTimeWithModels[]> {
  const times = await fetchAllRows<OperationTime>(
    () => supabase
      .from('operation_times').select('*').eq('operation_id', operationId)
      // Newest first, with id breaking ties — paging is only sound over a total order, and
      // created_at alone is not one.
      .order('created_at', { ascending: false }).order('id'),
    { table: 'operation_times' }
  )
  if (times.length === 0) return []

  const links = await fetchOperationTimeModelLinks(supabase, times.map((t) => t.id))
  const productIdsByTime = new Map<string, string[]>()
  for (const link of links) {
    const list = productIdsByTime.get(link.operation_time_id)
    if (list) list.push(link.product_id)
    else productIdsByTime.set(link.operation_time_id, [link.product_id])
  }

  return times
    .map((t) => ({ ...t, productIds: productIdsByTime.get(t.id) ?? [] }))
    .filter((t) => t.productIds.includes(productId))
}

/** What an edit may change on an existing run. Every field optional: an omitted one is left
 * exactly as it is, so a caller correcting the minutes can't blank the operator by accident. */
export interface UpdateOperationTimeInput {
  totalMinutes?: number
  /**
   * Who was timed, or null for "nobody said". operator_id is NOT NULL on the table, so a null
   * here resolves to the shared placeholder operator — the same rule recordOperationTime
   * follows, in the same module, so "cleared" means one thing across insert and update.
   */
  operatorId?: string | null
}

/**
 * The only function anywhere that updates operation_times — the edit-side counterpart of
 * recordOperationTime, so a corrected figure can't be written by an inline
 * `.from('operation_times').update(...)` that skips the "must be > 0" rule or writes a null
 * operator into a NOT NULL column.
 *
 * RLS on operation_times is "update own" (auth.uid() = collected_by), and a row filtered out by
 * that policy comes back successful having changed nothing — so the updated row is read back and
 * its absence reported, rather than letting the caller show a saved value the database rejected.
 *
 * NOTE WHAT THIS DOES NOT DO: it does not touch operation_time_models. An update here changes the
 * run for EVERY model it is linked to, because the figure lives on the run and not on the link.
 * Editing one model's share of a multi-model run is a different operation entirely — see
 * splitOperationTimeForModel.
 */
export async function updateOperationTime(
  supabase: SupabaseClient,
  operationTimeId: string,
  input: UpdateOperationTimeInput
): Promise<OperationTime> {
  const patch: Record<string, unknown> = {}

  if (input.totalMinutes !== undefined) {
    if (!(input.totalMinutes > 0)) throw new Error('Minutes must be greater than 0')
    patch.total_minutes = input.totalMinutes
  }
  if (input.operatorId !== undefined) {
    patch.operator_id = input.operatorId ?? await resolvePlaceholderOperatorId(supabase)
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('Nothing to update')
  }

  const { data: updated, error } = await supabase
    .from('operation_times')
    .update(patch)
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

/** Minutes-only form of updateOperationTime, kept because /tryouts' inline correction has
 * exactly one field to write. Delegates rather than duplicating the write. */
export async function updateOperationTimeMinutes(
  supabase: SupabaseClient,
  operationTimeId: string,
  totalMinutes: number
): Promise<OperationTime> {
  return updateOperationTime(supabase, operationTimeId, { totalMinutes })
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
 *
 * ── Deleting the CURRENT record hands the pair to its history ─────────────────────────────
 * A pair must never end up with archived records and no current one: the labour figure would
 * vanish and the operation would read as an untimed gap while its measurements sat there. So
 * before the row goes, for EVERY model it was linked to:
 *   - the most recent remaining record is promoted to current,
 *   - anything that pointed AT the doomed record is re-pointed at that promoted record, so no
 *     history is orphaned and no foreign key still references a row about to disappear.
 * Then, and only then, the row is deleted.
 *
 * Doing this first rather than after is not tidiness. superseded_by is a self-reference on this
 * table, so a row that others point at can't be deleted at all under a restricting foreign key —
 * clearing the references up front makes the delete work regardless of which on-delete rule the
 * column carries, and means a failure happens before anything is destroyed.
 *
 * Deleting an ARCHIVED record needs none of this: nothing depends on it except records further
 * back in the chain, which the same re-pointing sweep handles.
 */
export async function deleteOperationTime(supabase: SupabaseClient, operationTimeId: string): Promise<void> {
  // Read the links BEFORE the delete — they cascade away with the row, and afterwards there is
  // no way to know which pairs need a new current record.
  const { data: subject, error: subjectError } = await supabase
    .from('operation_times').select('id, operation_id').eq('id', operationTimeId).maybeSingle()
  if (subjectError) throw new Error(subjectError.message)

  if (subject) {
    const links = await fetchOperationTimeModelLinks(supabase, [operationTimeId])
    for (const productId of [...new Set(links.map((l) => l.product_id))]) {
      const pairTimes = await fetchOperationTimesForModel(supabase, subject.operation_id as string, productId)
      const remaining = pairTimes.filter((t) => t.id !== operationTimeId)
      if (remaining.length === 0) continue
      if (remaining.some((t) => t.superseded_by == null)) continue // the pair still has a current record

      const promoted = newestFirst(remaining)[0]
      const orphaned = remaining
        .filter((t) => t.id !== promoted.id && t.superseded_by === operationTimeId)
        .map((t) => t.id)
      await setSupersededBy(supabase, orphaned, promoted.id)
      await setSupersededBy(supabase, [promoted.id], null)
    }

    // Anything still pointing at this row — a chain link from a pair handled above, or a record
    // whose own links have since changed. Cleared rather than left to break the delete; each
    // becomes current for its pair, which pickCurrent resolves, and history beats a failed delete.
    const stillPointing = await fetchAllRows<{ id: string }>(
      () => supabase.from('operation_times').select('id').eq('superseded_by', operationTimeId).order('id'),
      { table: 'operation_times' }
    )
    await setSupersededBy(supabase, stillPointing.map((r) => r.id), null)
  }

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
 * SPLIT: peel one model off a run that counts towards several, so that model's figure can be
 * corrected without moving everybody else's.
 *
 * WHY THIS EXISTS AT ALL. total_minutes lives on `operation_times`; which models a run counts
 * towards lives on `operation_time_models`. There is no per-model minutes column and there must
 * not be one — a run IS one measurement, and storing it per link would let the same run disagree
 * with itself. The consequence is unavoidable: a plain update to a run linked to five models
 * changes all five. "Just this model" is therefore not a narrower update, it is a different
 * record, and this is the only function that makes one.
 *
 * WHAT IT DOES, in order, and why that order:
 *   1. Unlink the original from THIS model. First, deliberately. It is the step most likely to
 *      be refused (RLS), and failing here has changed nothing at all.
 *   2. Insert a new run through recordOperationTime — the same single write path every other
 *      time-entry flow uses — carrying the edited values and linked to THIS model only.
 *   3. If step 2 fails, RE-LINK the original and re-throw. Between 1 and 2 the model is briefly
 *      short one run; the compensation puts it back. The reverse order would leave the model
 *      linked to two records instead, double-counting the run in every average — a wrong number
 *      is worse than a missing one, and unlike a missing one it looks fine.
 *   4. Copy the notes across. Never fatal: the split itself has already succeeded by then, and
 *      losing a note copy must not be reported as losing the record.
 *
 * The original run keeps its remaining model links, its minutes, its operator and its own notes,
 * untouched. Every other model's figure is exactly what it was.
 *
 * PROVENANCE. operation_id, is_imported, chassis_id and the timing fields are carried across, so
 * the new row is the same run as the old one rather than a fresh observation. team_id/
 * production_line_id are carried too where the original has them: normally recordOperationTime
 * derives those from the operation's job, which for the same operation_id gives the same answer —
 * but an imported row can hold filing that predates the current structure, and a split of it must
 * not quietly re-file half the run somewhere else. Where the original holds nulls, derivation
 * takes over. collected_by is the CURRENT user: they made this record, and RLS on operation_times
 * is "edit your own", so anything else would create a row its author couldn't correct.
 */
export interface SplitOperationTimeInput {
  /** The run being split. Its stored values are the provenance carried forward. */
  original: OperationTime
  /** The model being peeled off — the only one the new record will be linked to. */
  productId: string
  totalMinutes: number
  operatorId: string | null
  collectedBy: string
  /** Note text to copy onto the new record. Copies, not moves — see the drawer's note. */
  noteContents: string[]
}

export interface SplitOperationTimeResult {
  created: OperationTime
  notesCopied: number
  /** Note copies that failed. The split still succeeded; the caller says so rather than
   * pretending the whole thing did or didn't happen. */
  noteErrors: string[]
}

export async function splitOperationTimeForModel(
  supabase: SupabaseClient,
  input: SplitOperationTimeInput
): Promise<SplitOperationTimeResult> {
  const { original, productId, totalMinutes, operatorId, collectedBy, noteContents } = input

  if (!(totalMinutes > 0)) throw new Error('Minutes must be greater than 0')
  if (!productId) throw new Error('A split needs the model it is being split for')

  // 0. The applicability guard, asked BEFORE anything moves. recordOperationTime would refuse an
  //    unlinked pair anyway, but only after step 1 had taken the model off the original — and
  //    the re-link in step 3 is best effort. An already-orphaned pair (a run against a model the
  //    operation doesn't apply to) is refused here, cleanly: splitting it would only mint a
  //    second orphan. Apply the operation to the model first, then split.
  const linked = await fetchLinkedProductIds(supabase, original.operation_id, [productId])
  if (!linked.has(productId)) {
    throw new Error(
      'This run can’t be split for this model: the operation doesn’t apply to the model (it has ' +
      'no applies-list row), so a new record for it would not count towards coverage. Apply the ' +
      'operation to the model first, then split. Nothing was changed.'
    )
  }

  // 1. Nothing has been created yet, so a refusal here is a clean no-op.
  await unlinkOperationTimeFromModel(supabase, original.id, productId)

  // 2. Through recordOperationTime like every other time insert in the app.
  let created: OperationTime
  try {
    ;({ created } = await recordOperationTime(supabase, {
      operationId: original.operation_id,
      productIds: [productId],
      operatorId,
      collectedBy,
      totalMinutes,
      startedAt: original.started_at,
      completedAt: original.completed_at,
      pausedDurationSeconds: original.paused_duration_seconds ?? 0,
      chassisId: original.chassis_id,
      isImported: original.is_imported,
      provenance: original.team_id !== null || original.production_line_id !== null
        ? { teamId: original.team_id, productionLineId: original.production_line_id }
        : undefined,
    }))
  } catch (err) {
    // 3. Put the model back on the original rather than leaving it short a run.
    try {
      await linkOperationTimeToModels(supabase, original.id, [productId])
    } catch {
      throw new Error(
        `The new record could not be created (${err instanceof Error ? err.message : 'rejected'}), ` +
        'and this model could not be re-linked to the original record either. The original record ' +
        'still exists with its minutes intact, but it no longer counts towards this model — ' +
        'ask an admin to restore the link.'
      )
    }
    throw new Error(
      `The new record could not be created: ${err instanceof Error ? err.message : 'rejected'}. ` +
      'Nothing was changed — the original record still counts towards this model.'
    )
  }

  // 4. Notes are per-record, so they are COPIED. Best effort by design.
  let notesCopied = 0
  const noteErrors: string[] = []
  for (const content of noteContents) {
    try {
      await addOperationTimeNote(supabase, created.id, content, collectedBy)
      notesCopied += 1
    } catch (err) {
      noteErrors.push(err instanceof Error ? err.message : 'Could not copy a note')
    }
  }

  return { created, notesCopied, noteErrors }
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
  //
  // Chunked (lib/chunkedIn): /tryouts opens this over every time on a van and /model-total over
  // every time on a model, so the id list tracks the same unbounded set hop 2 does.
  const rows = await selectIn<OperationTimeNote>(operationTimeIds, (chunk) => supabase
    .from('operation_time_notes')
    .select('*')
    .in('operation_time_id', chunk)
    .order('created_at', { ascending: false }))

  // Re-sorted here, NOT left to the query. Each chunk comes back newest-first on its own, but
  // selectIn concatenates chunks in chunk order, so the join of several sorted runs is only
  // sorted within each run. Callers group by operation_time_id and render in array order, which
  // would silently interleave. Same rule as the batched read in /tryouts' timed log.
  return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))
}
