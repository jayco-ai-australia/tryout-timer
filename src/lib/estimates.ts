import type { SupabaseClient } from '@supabase/supabase-js'
import { selectIn } from './chunkedIn'
import { unlinkOperationsFromModel } from './modelLinks'
import { fetchLinksForOperations, linkOperationsToModels } from './modelOperations'
import {
  TIME_FLAG_COLUMNS, currentForOperation, fetchOperationTimeModelLinks, isMeasuredCurrent,
  addOperationTimeNote, operationProductKey, recordOperationTime, splitOperationTimeForModel, updateOperationTime,
  type TimeRow,
} from './operationTimes'
import { fetchAllChunked, READ_CHUNK, type RangeableQuery } from './supabaseRead'
import type { OperationTime, Product } from './types'

/**
 * ── /estimate: extrapolating a job's times across a range of models ────────────────────────
 *
 * Times are collected on the floor against a handful of models; the rest of a range is filled in
 * from what those taught. This module is the read that builds that screen's grid and the save
 * that writes it — and it owns no rule of its own about what a figure is:
 *
 *   WHICH RECORD IS THE FIGURE   lib/operationTimes' currentForOperation, as on every screen.
 *   MEASURED OR ESTIMATED        the current record's is_estimated; "measured" is
 *                                isMeasuredCurrent, the same test recordOperationTime's guard asks.
 *   DOES IT APPLY                model_operations, through lib/modelOperations.
 *   WRITING                      recordOperationTime (new), updateOperationTime (re-save),
 *                                splitOperationTimeForModel (re-save of a shared record), and
 *                                linkOperationsToModels — the existing writers, no second path.
 *   NOT APPLICABLE               lib/modelLinks' unlinkOperationsFromModel — the app's one
 *                                "this doesn't apply to this model" path — behind a guard that
 *                                refuses any pair with a measured time (markNotApplicable), then a
 *                                model_operation_exclusions row recording the decision.
 *
 * ── Applicability is asserted here, not only read ──────────────────────────────────────────
 * On a line where each operation is linked to two or three models, a screen that only let you
 * fill LINKED cells could fill almost nothing. So an unlinked cell is an input too: a figure typed
 * into it links the operation to the model and records the time, in that order. The reverse is
 * markNotApplicable.
 *
 * ── Three states, two tables ───────────────────────────────────────────────────────────────
 *   model_operations row             applies.
 *   model_operation_exclusions row   somebody DECIDED it doesn't (who, when). Kept across reloads.
 *   neither                          nobody has decided.
 * Coverage reads only the first: an excluded pair and an undecided one are both "no link", and
 * both are absent from every coverage figure. The exclusions table records a decision, not a fact
 * about labour, and NOTHING outside this module reads or writes it — not coverage, not the Labour
 * Matrix, not Reports. A link always outranks an exclusion on screen: if a pair is linked again
 * from somewhere else, the stale exclusion is simply not shown.
 */

/** One operation — a grid row. `job_id` says which job's block it sits in. */
export interface EstimateOperation { id: string; name: string; job_id: string }

/** A note on the record behind a cell (operation_time_notes): what, who wrote it, when. */
export interface EstimateCellNote { content: string; author: string | null; createdAt: string }

/**
 * What one (operation, model) cell holds when the grid loads. Absent from the map = nothing
 * recorded: an input if the operation applies to the model, blank if it doesn't.
 */
export type EstimateCellState =
  /** A measured current record — the evidence. Read-only, always. */
  | { kind: 'measured'; minutes: number }
  /** An estimate is the current record. Editable; a re-save updates `timeId` in place.
   * `fanOut` is how many models that record counts for — 1 for everything this screen writes. */
  | { kind: 'estimated'; minutes: number; timeId: string; fanOut: number }

export interface EstimateGrid {
  operations: EstimateOperation[]
  /** Every model any of the job's operations applies to, or has a time for. */
  products: Product[]
  /** operationProductKey pairs with a model_operations row. */
  links: Set<string>
  /** Keyed operationProductKey. */
  cells: Map<string, EstimateCellState>
  /** operationProductKey pairs with a model_operation_exclusions row — decided not applicable. */
  exclusions: Set<string>
  /** Pairs with ANY measured record linked — current or superseded, hidden or retired. Such a
   * pair can never be marked not applicable: measured work on a model is proof it applies. */
  measuredHistory: Set<string>
  /** Keyed operationProductKey: the notes on the record that IS the cell's figure (measured or
   * estimated), oldest first. Only cells with at least one note appear. */
  notes: Map<string, EstimateCellNote[]>
}

interface GridTimeRow extends TimeRow { is_estimated: boolean; created_at: string }

/**
 * The whole grid for one or more jobs (a section's jobs, stacked) in six reads, whatever its size — a job of 20 operations against 40
 * models is not 800 lookups. Operations → their applies-list → their current records → those
 * records' model links → the products named by either. Every fan-out read is chunked AND paged
 * (lib/supabaseRead): a short read here would draw an input over a measured cell.
 *
 * EVERY record, archived ones included: the figures come from currentForOperation as everywhere,
 * but "has this pair ever been measured" (measuredHistory, which decides whether a cell may be
 * marked not applicable) is a question about history, not about the figure. Hidden and retired
 * rows are NOT filtered at the query either; currentForOperation and isMeasuredCurrent drop them.
 */
export async function fetchEstimateGrid(supabase: SupabaseClient, jobIds: string[]): Promise<EstimateGrid> {
  const operations = jobIds.length === 0 ? [] : await fetchAllChunked<EstimateOperation>(
    jobIds, READ_CHUNK,
    (chunk) => supabase.from('operations').select('id, name, job_id').in('job_id', chunk).eq('is_active', true)
      .order('name').order('id') as unknown as RangeableQuery<EstimateOperation>,
    { table: 'operations' },
  )
  operations.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const opIds = operations.map((o) => o.id)
  if (opIds.length === 0) return { operations, products: [], links: new Set(), cells: new Map(), exclusions: new Set(), measuredHistory: new Set(), notes: new Map() }

  const modelOperations = await fetchLinksForOperations(supabase, opIds)
  const exclusionRows = await fetchAllChunked<{ operation_id: string; product_id: string }>(
    opIds, READ_CHUNK,
    (chunk) => supabase.from('model_operation_exclusions').select('operation_id, product_id')
      .in('operation_id', chunk).order('operation_id').order('product_id') as unknown as RangeableQuery<{ operation_id: string; product_id: string }>,
    { table: 'model_operation_exclusions' },
  )
  const times = await fetchAllChunked<GridTimeRow>(
    opIds, READ_CHUNK,
    (chunk) => supabase
      .from('operation_times')
      .select(`id, operation_id, total_minutes, superseded_by, is_estimated, created_at, ${TIME_FLAG_COLUMNS}`)
      .in('operation_id', chunk)
      .order('id') as unknown as RangeableQuery<GridTimeRow>,
    { table: 'operation_times' },
  )
  const timeModels = await fetchOperationTimeModelLinks(supabase, times.map((t) => t.id))

  const links = new Set(modelOperations.map((mo) => operationProductKey(mo.operation_id, mo.product_id)))
  const stats = currentForOperation(times, timeModels)
  const timeById = new Map(times.map((t) => [t.id, t]))
  const fanOut = new Map<string, number>()
  for (const tm of timeModels) fanOut.set(tm.operation_time_id, (fanOut.get(tm.operation_time_id) ?? 0) + 1)

  // Measured always wins, including in the one state where the figure alone would not say so: a
  // pair briefly holding a measured AND an estimated current record (a time recorded on the floor
  // in the same moment an estimate was saved). currentForOperation takes the newest; the grid
  // still treats the pair as measured, so nothing here offers to edit over an observation.
  const measuredByPair = new Map<string, GridTimeRow>()
  for (const tm of timeModels) {
    const t = timeById.get(tm.operation_time_id)
    if (!t || !isMeasuredCurrent(t) || t.total_minutes == null) continue
    const key = operationProductKey(t.operation_id, tm.product_id)
    const prev = measuredByPair.get(key)
    if (!prev || t.created_at > prev.created_at) measuredByPair.set(key, t)
  }

  const cells = new Map<string, EstimateCellState>()
  /** The record behind each cell's figure — whose notes the cell carries. */
  const recordByPair = new Map<string, GridTimeRow>()
  const pairKeys = new Set([...Object.keys(stats), ...measuredByPair.keys()])
  for (const key of pairKeys) {
    const measured = measuredByPair.get(key)
    if (measured) {
      cells.set(key, { kind: 'measured', minutes: measured.total_minutes as number })
      recordByPair.set(key, measured)
      continue
    }
    const stat = stats[key]
    const current = stat ? timeById.get(stat.currentId) : undefined
    if (!stat || !current?.is_estimated) continue
    cells.set(key, { kind: 'estimated', minutes: stat.minutes, timeId: stat.currentId, fanOut: fanOut.get(stat.currentId) ?? 1 })
    recordByPair.set(key, current)
  }

  // The context written when each figure was collected ("two operators", "new starter") or saved
  // ("scaled from 88A") — operation_time_notes on the cell's own record, nothing older.
  const recordIds = [...new Set([...recordByPair.values()].map((t) => t.id))]
  type NoteRow = { operation_time_id: string; content: string; created_at: string; profiles: { full_name: string | null } | null }
  const noteRows = await fetchAllChunked<NoteRow>(
    recordIds, READ_CHUNK,
    (chunk) => supabase.from('operation_time_notes').select('operation_time_id, content, created_at, profiles(full_name)')
      .in('operation_time_id', chunk).order('created_at').order('id') as unknown as RangeableQuery<NoteRow>,
    { table: 'operation_time_notes' },
  )
  const notesByRecord = new Map<string, NoteRow[]>()
  for (const n of noteRows) {
    const list = notesByRecord.get(n.operation_time_id)
    if (list) list.push(n)
    else notesByRecord.set(n.operation_time_id, [n])
  }
  const notes = new Map<string, EstimateCellNote[]>()
  for (const [key, t] of recordByPair) {
    const list = notesByRecord.get(t.id)
    if (!list) continue
    notes.set(key, list.map((n) => ({ content: n.content, author: n.profiles?.full_name ?? null, createdAt: n.created_at })))
  }

  const productIds = [...new Set([
    ...modelOperations.map((mo) => mo.product_id),
    ...timeModels.map((tm) => tm.product_id),
  ])]
  const products = await selectIn<Product>(productIds, async (chunk) => supabase.from('products').select('*').in('id', chunk))

  return {
    operations, products, links, cells,
    exclusions: new Set(exclusionRows.map((r) => operationProductKey(r.operation_id, r.product_id))),
    measuredHistory: measuredPairsOf(times, timeModels),
    notes,
  }
}

/** The pairs any MEASURED record is linked to, whatever its flags — see measuredHistory. */
function measuredPairsOf(
  times: { id: string; operation_id: string; is_estimated: boolean }[],
  timeModels: { operation_time_id: string; product_id: string }[],
): Set<string> {
  const opByMeasuredId = new Map(times.filter((t) => !t.is_estimated).map((t) => [t.id, t.operation_id]))
  const out = new Set<string>()
  for (const tm of timeModels) {
    const opId = opByMeasuredId.get(tm.operation_time_id)
    if (opId) out.add(operationProductKey(opId, tm.product_id))
  }
  return out
}

/** measuredHistory read fresh from the database for a set of operations — the guard
 * markNotApplicable asks immediately before it unlinks, never trusting the page's own read. */
async function fetchMeasuredPairs(supabase: SupabaseClient, operationIds: string[]): Promise<Set<string>> {
  const times = await fetchAllChunked<{ id: string; operation_id: string; is_estimated: boolean }>(
    [...new Set(operationIds)], READ_CHUNK,
    (chunk) => supabase.from('operation_times').select('id, operation_id, is_estimated')
      .in('operation_id', chunk).order('id') as unknown as RangeableQuery<{ id: string; operation_id: string; is_estimated: boolean }>,
    { table: 'operation_times' },
  )
  const timeModels = await fetchOperationTimeModelLinks(supabase, times.filter((t) => !t.is_estimated).map((t) => t.id))
  return measuredPairsOf(times, timeModels)
}

/** One (operation, model) pair. */
export interface EstimatePair { operationId: string; productId: string }

/**
 * "This work isn't done on this model" — removes the model_operations row, so the pair stops
 * being a gap in every coverage figure.
 *
 * REFUSED for any pair with a measured record linked to it — current or archived, hidden or
 * retired. A measurement is proof the work is done on that model, and lib/modelLinks' unlink
 * would otherwise detach that record from the model. The guard is a fresh read, made here,
 * immediately before the unlink; the grid's own read is only what greys the control out.
 *
 * ORDER: unlink first, then record the exclusion — and only for pairs whose unlink went through.
 * The reverse could leave a pair both linked and excluded if the unlink failed; this way a
 * failure in between leaves it merely undecided, which is true and harmless.
 *
 * A pair whose only records are ESTIMATES is allowed: unlinkOperationsFromModel detaches those
 * estimates from the model first (they stay in operation_times, unattached, as that module
 * describes) and then removes the link — so an estimate never outlives the applicability it was
 * an estimate of, and never counts toward a model that doesn't do the work.
 */
export async function markNotApplicable(
  supabase: SupabaseClient,
  pairs: EstimatePair[],
  userId: string,
  /** The save's note, kept on each decision (the table's `note` column). Optional. */
  note?: string,
): Promise<{ unlinked: number; failures: (EstimatePair & { message: string })[] }> {
  const failures: (EstimatePair & { message: string })[] = []
  if (pairs.length === 0) return { unlinked: 0, failures }
  const measured = await fetchMeasuredPairs(supabase, pairs.map((p) => p.operationId))

  const opsByProduct = new Map<string, string[]>()
  for (const p of pairs) {
    if (measured.has(operationProductKey(p.operationId, p.productId))) {
      failures.push({
        ...p,
        message: 'it has a measured time recorded against this model, so the work is done on it — the link stays',
      })
      continue
    }
    const list = opsByProduct.get(p.productId)
    if (list) list.push(p.operationId)
    else opsByProduct.set(p.productId, [p.operationId])
  }

  let unlinked = 0
  const decided: EstimatePair[] = []
  for (const [productId, operationIds] of opsByProduct) {
    const result = await unlinkOperationsFromModel(supabase, productId, operationIds)
    unlinked += result.applicabilityUnlinked
    if (result.failures.length > 0) {
      for (const operationId of operationIds) failures.push({ operationId, productId, message: result.failures.join(' ') })
    } else {
      for (const operationId of operationIds) decided.push({ operationId, productId })
    }
  }

  // The decision itself. Upsert, so marking a pair again re-stamps who decided and when —
  // decided_at is written rather than left to the default for exactly that re-stamp.
  if (decided.length > 0) {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('model_operation_exclusions')
      .upsert(
        decided.map((p) => ({ operation_id: p.operationId, product_id: p.productId, decided_by: userId, decided_at: now, note: note?.trim() || null })),
        { onConflict: 'operation_id,product_id' },
      )
      .select('operation_id, product_id')
    // Read back rather than assumed — a write filtered by RLS succeeds having done nothing.
    const written = new Set((data ?? []).map((r) => operationProductKey(r.operation_id as string, r.product_id as string)))
    for (const p of decided) {
      if (written.has(operationProductKey(p.operationId, p.productId))) continue
      failures.push({
        ...p,
        message: `the link was removed, but the not-applicable decision could not be recorded${error ? ` (${error.message})` : ' — the database declined it'}; the cell is left undecided`,
      })
    }
  }
  return { unlinked, failures }
}

/**
 * Withdraw not-applicable decisions — the step before a figure typed into an excluded cell links
 * the pair. The only delete from model_operation_exclusions anywhere. Returns the pairs it could
 * NOT clear (counted off the deleted rows, never assumed): the caller must not link those, or the
 * pair would read as both applying and decided not to.
 */
async function clearExclusions(supabase: SupabaseClient, pairs: EstimatePair[]): Promise<{ failed: EstimatePair[]; error: string | null }> {
  const byOp = new Map<string, string[]>()
  for (const p of pairs) {
    const list = byOp.get(p.operationId)
    if (list) list.push(p.productId)
    else byOp.set(p.operationId, [p.productId])
  }
  const cleared = new Set<string>()
  let error: string | null = null
  for (const [operationId, productIds] of byOp) {
    const { data, error: err } = await supabase
      .from('model_operation_exclusions').delete()
      .eq('operation_id', operationId).in('product_id', productIds)
      .select('operation_id, product_id')
    if (err) { error ??= err.message; continue }
    for (const r of data ?? []) cleared.add(operationProductKey(r.operation_id as string, r.product_id as string))
  }
  return { failed: pairs.filter((p) => !cleared.has(operationProductKey(p.operationId, p.productId))), error }
}

/** One cell to write. `existing` is the estimate already there, when there is one. */
export interface EstimateWrite {
  operationId: string
  productId: string
  minutes: number
  existing: { timeId: string; fanOut: number } | null
  /** false when the pair has no model_operations row — the link is created first. */
  linked: boolean
  /** true when the pair was decided not applicable — that decision is withdrawn first. */
  excluded: boolean
}

export interface EstimateSaveResult {
  saved: number
  failures: { operationId: string; productId: string; message: string }[]
  /** Records saved whose note could not be added. The figure stands; only the note is missing. */
  noteFailures: number
}

/** How many writes run at once. Each new estimate is ~8 round trips inside recordOperationTime
 * (applicability, the estimate guard, provenance, insert, link); one at a time, a
 * 90-cell save would sit for half a minute. Small enough not to look like a flood to PostgREST. */
const SAVE_CONCURRENCY = 6

/**
 * Writes every filled cell, each as ONE operation_times record through the shared writers:
 *
 *   new cell          recordOperationTime with isEstimated — started/completed null (nothing was
 *                     observed), operator the "Unassigned" placeholder, team and line derived from
 *                     the job exactly as every other recorded time's are, and one
 *                     operation_time_models row to this model. Its estimate guard refuses the cell
 *                     if the pair has been MEASURED since the grid loaded.
 *   existing estimate updateOperationTime on that record — never a second record, which would sit
 *                     beside the first as history and invite the next screen to average them. If
 *                     the record counts for other models too (nothing here writes one, but the
 *                     times drawer can relink), splitOperationTimeForModel peels this model off
 *                     instead, so its neighbours' figures don't move.
 *   unlinked pair     linkOperationsToModels first, in one batch. The grid never offers such a
 *                     cell, so this is the belt to that brace: a time against an unlinked pair is
 *                     an orphan, and recordOperationTime would refuse it anyway.
 *
 * Per-cell failures are collected rather than thrown: 37 of 38 saved is a result to report, not
 * a reason to lose the 37.
 *
 * `note`, when given, is added to EVERY record this save writes — new, updated or split — through
 * addOperationTimeNote, the one writer of operation_time_notes. Best effort: a note that fails is
 * counted, never a reason to report the figure itself as lost.
 */
export async function saveEstimates(
  supabase: SupabaseClient,
  writes: EstimateWrite[],
  userId: string,
  onProgress?: (done: number) => void,
  note?: string,
): Promise<EstimateSaveResult> {
  const failures: EstimateSaveResult['failures'] = []
  const noteText = note?.trim() ?? ''
  let noteFailures = 0
  let done = 0

  // A figure in an excluded cell overturns the decision: the exclusion goes first, and a pair
  // whose exclusion couldn't be cleared is held back entirely rather than linked over it.
  const excluded = writes.filter((w) => w.excluded)
  if (excluded.length > 0) {
    const { failed, error } = await clearExclusions(supabase, excluded)
    const held = new Set(failed.map((p) => operationProductKey(p.operationId, p.productId)))
    for (const p of failed) {
      failures.push({ ...p, message: `the earlier not-applicable decision could not be withdrawn${error ? ` (${error})` : ' — the database declined it'}` })
    }
    writes = writes.filter((w) => !held.has(operationProductKey(w.operationId, w.productId)))
    done += failed.length
    if (failed.length > 0) onProgress?.(done)
  }

  const unlinked = writes.filter((w) => !w.linked)
  let ready = writes
  if (unlinked.length > 0) {
    const result = await linkOperationsToModels(
      supabase, unlinked.map((w) => ({ operation_id: w.operationId, product_id: w.productId })),
    )
    if (result.error) {
      // Which pairs made it isn't reported back per pair, so every unlinked cell is held back
      // rather than guessed at — recordOperationTime would refuse the ones that failed anyway.
      for (const w of unlinked) failures.push({ operationId: w.operationId, productId: w.productId, message: result.error })
      ready = writes.filter((w) => w.linked)
      done += unlinked.length
      onProgress?.(done)
    }
  }

  const queue = [...ready]
  let saved = 0
  async function worker() {
    for (let w = queue.shift(); w; w = queue.shift()) {
      try {
        const recordId = await writeOne(supabase, w, userId)
        saved += 1
        if (noteText) {
          try { await addOperationTimeNote(supabase, recordId, noteText, userId) }
          catch { noteFailures += 1 }
        }
      } catch (err) {
        failures.push({ operationId: w.operationId, productId: w.productId, message: err instanceof Error ? err.message : 'Could not save' })
      }
      done += 1
      onProgress?.(done)
    }
  }
  await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, queue.length) }, worker))
  return { saved, failures, noteFailures }
}

/** Writes one cell; returns the id of the record that now holds its figure. */
async function writeOne(supabase: SupabaseClient, w: EstimateWrite, userId: string): Promise<string> {
  if (!w.existing) {
    const { created } = await recordOperationTime(supabase, {
      operationId: w.operationId,
      productIds: [w.productId],
      operatorId: null,
      collectedBy: userId,
      totalMinutes: w.minutes,
      startedAt: null,
      completedAt: null,
      isEstimated: true,
    })
    return created.id
  }
  if (w.existing.fanOut <= 1) {
    await updateOperationTime(supabase, w.existing.timeId, { totalMinutes: w.minutes })
    return w.existing.timeId
  }
  const { data: original, error } = await supabase.from('operation_times').select('*').eq('id', w.existing.timeId).single()
  if (error || !original) throw new Error(error?.message ?? 'That estimate no longer exists')
  const { created } = await splitOperationTimeForModel(supabase, {
    original: original as OperationTime,
    productId: w.productId,
    totalMinutes: w.minutes,
    operatorId: (original as OperationTime).operator_id,
    collectedBy: userId,
    noteContents: [],
  })
  return created.id
}
