import type { SupabaseClient } from '@supabase/supabase-js'
import { computeCoverageCombos, type CoverageCombo } from './coverage'
import { listPreAssemblyAreas, loadLineSplit } from './lines'
import { currentForOperation, operationProductKey } from './operationTimes'
import { fetchScheduleWindow, type ScheduleWindow } from './schedule'
import { fetchAllChunked, logSupabaseError, READ_CHUNK, type RangeableQuery } from './supabaseRead'
import { selectIn } from './chunkedIn'

/**
 * ── /pre-assembly-coverage: what has been timed in the feeder areas, per scheduled model ─────
 *
 * The question the report answers, in one line: for each pre-assembly area, of the models
 * actually booked to be built, how many has that area ever recorded a time against — and which
 * ones has it not.
 *
 * ── What the denominator is, and why it is the schedule ──────────────────────────────────────
 * Not "every model in the catalogue". A model with no build ahead of it is not a gap anybody can
 * close by standing on the line with a stopwatch, and counting it drags every figure down with
 * work that will never be done. So the denominator is `chassis.dateonline >= today`, resolved to
 * distinct products (lib/schedule's fetchScheduleWindow), then narrowed per area to the build
 * lines that area FEEDS (lib/lines' production_line_feeds mapping). Sew's denominator is the
 * scheduled Caravan and Camper models, because those are the lines Sew feeds — not the whole
 * schedule, and not Sew's own products, of which it has none.
 *
 * Scheduled chassis with no product_id are counted and reported rather than dropped. They are
 * real builds; they simply cannot be attributed to a model, so they can be neither covered nor
 * missing, and a reader is entitled to know how many of them the denominator silently excluded.
 *
 * ── What "covered" means, and what it deliberately does not ─────────────────────────────────
 * Coverage is job × model and comes from lib/coverage's computeCoverageCombos — the same
 * function /dashboard and /model-total call, fed a different scope. It is NOT reimplemented
 * here, and the reason is the one that matters most in this report:
 *
 *   applicable jobs for (area, model) = the area's jobs with at least one operation linked to
 *   that model via model_operations.
 *
 * That is derived per model, from the applies-list, and never inferred from what OTHER models
 * have. A Camper with no Welding job linked to it has no Welding job applicable, so it is not
 * short a Welding time and must never be reported as partial for the lack of one. Inferring the
 * applicable set from the union across models is the single most tempting shortcut here and it
 * would make the "Partial" column a list of models that are, in fact, complete.
 *
 * The three states a scheduled model can be in for an area:
 *   full    — every applicable job has a time for it
 *   partial — some but not all do  (only possible when at least one does)
 *   missing — none do. INCLUDING the case where nothing at all is applicable yet, which is
 *             flagged separately (see `noApplicableJobs`) because "we have not timed it" and
 *             "nobody has said this area works on it" are different problems with different
 *             fixes, and only the second is fixed in Setup rather than on the line.
 */

/** An area's jobs, operations and the models/times attached to them — one read of the world,
 * partitioned per area afterwards rather than re-queried six times. */
interface JobRow { id: string; name: string; production_line_id: string | null }
interface OperationRow { id: string; job_id: string }
interface ModelOperationRow { operation_id: string; product_id: string }
interface TimeRow { id: string; operation_id: string; total_minutes: number | null; superseded_by: string | null }
interface TimeModelRow { operation_time_id: string; product_id: string }
interface ProductRow { id: string; model: string; product_series: string | null; production_line_id: string | null }

/** One row of the report table: a product_series within one build line within one area. */
export interface SeriesRow {
  series: string
  /**
   * Mean of the per-model total area minutes across COVERED models only, or null when none is
   * covered. Covered models only because a missing model contributes 0 minutes by definition,
   * and averaging those in would report a number that describes the gaps rather than the work —
   * a series with one timed model out of ten would read as a tenth of its real content.
   */
  avgMinutes: number | null
  /** Scheduled models of this series with at least one timed applicable job in this area. */
  covered: number
  /** Scheduled models of this series in the denominator — the row's denominator. */
  scheduled: number
  /** Covered models where SOME but not all applicable jobs are timed. A subset of `covered`. */
  partial: number
  /** Every scheduled model of this series with zero coverage in this area, A–Z. The full list —
   * the page decides how many to print. */
  missingModels: string[]
  /** Of `missingModels`, the ones with no applicable job in this area AT ALL. Not a timing gap:
   * a Setup gap, or a model this area genuinely does not touch. */
  noApplicableJobs: string[]
}

/** The area's rows for one of the build lines it feeds. */
export interface BuildLineGroup {
  lineId: string
  lineName: string
  covered: number
  scheduled: number
  series: SeriesRow[]
}

export interface AreaReport {
  lineId: string
  name: string
  covered: number
  scheduled: number
  /** False when this area has no recorded time against ANY scheduled model — the "No times
   * collected" case, which is reported rather than omitted. */
  hasTimes: boolean
  /** Jobs configured on this area's line at all. Zero here and hasTimes false means the area
   * exists but nothing has been set up on it, which reads differently from "set up, never
   * timed". */
  jobCount: number
  buildLines: BuildLineGroup[]
}

export interface PreAssemblyCoverageReport {
  areas: AreaReport[]
  /** The schedule window every denominator on the page was drawn from. */
  window: ScheduleWindow
  /** Distinct scheduled models across the whole window, before any per-area narrowing. */
  scheduledModels: number
}

/**
 * Builds the whole report in one pass.
 *
 * Every id list below is read through lib/supabaseRead's fetchAllChunked, which chunks the
 * `.in(...)` filter so the URL stays under Supabase's ~16KB edge limit AND pages each chunk so
 * nothing is lost to the 1,000-row response cap. Both limits bite here and neither announces
 * itself: an over-long URL comes back as a bare 400, and a truncated page comes back as a normal
 * 200 with a short array. This query set is larger than /model-total's, which is where the
 * chunking helper came from — the applies-list alone spans every operation on six lines.
 */
export async function fetchPreAssemblyCoverage(supabase: SupabaseClient): Promise<PreAssemblyCoverageReport> {
  // ── 1. The areas, and the schedule they are measured against ──────────────────────────────
  // Independent reads; the areas come from the cached line topology, so this is usually one
  // request, not two.
  // lineSplit is the same cached topology the areas come from, used here only for its id→name
  // lookup: the report groups by BUILD line, and those lines are not in the areas list.
  const [areas, lineSplit, window] = await Promise.all([
    listPreAssemblyAreas(supabase),
    loadLineSplit(supabase),
    fetchScheduleWindow(supabase),
  ])

  // ── 2. The scheduled models themselves ────────────────────────────────────────────────────
  // A primary-key lookup (products.id), so chunking the filter is sufficient and complete: a
  // chunk of N ids returns at most N rows and the response cap is unreachable. See lib/chunkedIn.
  const products = await selectIn<ProductRow>(window.productIds, async (chunk) => {
    const res = await supabase
      .from('products').select('id, model, product_series, production_line_id')
      .in('id', chunk)
    if (res.error) logSupabaseError('pre-assembly coverage — products WHERE id IN (…)', res.error)
    return res
  }, READ_CHUNK)
  const productById = new Map(products.map((p) => [p.id, p]))

  // ── 3. The areas' structure: jobs → operations ────────────────────────────────────────────
  // Scoped by the JOB's line, not by the operation's or the time's. jobs.production_line_id is
  // the source of truth for which line a piece of labour belongs to; operation_times carries a
  // copy stamped from the job at record time, and attributing through the copy would silently
  // disagree with Setup for any job that has ever been moved between lines.
  //
  // is_active on jobs and operations: a merged-away job or operation has had its times moved
  // onto the keeper (see lib/jobs, lib/mergeOperations), so excluding it loses no work — it only
  // stops the report naming a job nobody can find on screen any more.
  const areaLineIds = areas.map((a) => a.id)
  const jobs = areaLineIds.length === 0 ? [] : await fetchAllChunked<JobRow>(
    areaLineIds, READ_CHUNK,
    (chunk) => supabase
      .from('jobs').select('id, name, production_line_id')
      .in('production_line_id', chunk).eq('is_active', true)
      .order('id') as unknown as RangeableQuery<JobRow>,
    { table: 'jobs' }
  )
  const jobIds = jobs.map((j) => j.id)

  const operations = await fetchAllChunked<OperationRow>(
    jobIds, READ_CHUNK,
    (chunk) => supabase
      .from('operations').select('id, job_id')
      .in('job_id', chunk).eq('is_active', true)
      .order('id') as unknown as RangeableQuery<OperationRow>,
    { table: 'operations' }
  )
  const operationIds = operations.map((o) => o.id)

  // ── 4. The applies-list and the recorded times, for those operations ──────────────────────
  // Both fan out — one operation has many models and many runs — so both are chunked AND paged,
  // ordered by their full primary key, which is what makes the paging sound (lib/supabaseRead).
  const modelOperations = await fetchAllChunked<ModelOperationRow>(
    operationIds, READ_CHUNK,
    (chunk) => supabase
      .from('model_operations').select('operation_id, product_id')
      .in('operation_id', chunk)
      .order('operation_id').order('product_id') as unknown as RangeableQuery<ModelOperationRow>,
    { table: 'model_operations' }
  )

  // Filtered to the CURRENT record. The report shows a mean of current labour figures and a
  // yes/no on coverage — no run counts, no history — so archived rows would be fetched only to be
  // discarded by currentForOperation. superseded_by is still selected: the helper decides which
  // row is the figure, and handing it rows without the column would have it guess.
  const operationTimes = await fetchAllChunked<TimeRow>(
    operationIds, READ_CHUNK,
    (chunk) => supabase
      .from('operation_times').select('id, operation_id, total_minutes, superseded_by')
      .in('operation_id', chunk).is('superseded_by', null)
      .order('id') as unknown as RangeableQuery<TimeRow>,
    { table: 'operation_times' }
  )

  const timeIds = operationTimes.map((t) => t.id)
  const operationTimeModels = await fetchAllChunked<TimeModelRow>(
    timeIds, READ_CHUNK,
    (chunk) => supabase
      .from('operation_time_models').select('operation_time_id, product_id')
      .in('operation_time_id', chunk)
      .order('operation_time_id').order('product_id') as unknown as RangeableQuery<TimeModelRow>,
    { table: 'operation_time_models' }
  )

  // The per-(operation, model) labour figure, from the same helper every other surface uses. One
  // pass over everything; the per-area minutes below are lookups into it, not a second rule.
  const currentByPair = currentForOperation(operationTimes, operationTimeModels)

  // ── 5. Partition by area ──────────────────────────────────────────────────────────────────
  const jobIdsByLine = new Map<string, Set<string>>()
  for (const j of jobs) {
    if (!j.production_line_id) continue
    const set = jobIdsByLine.get(j.production_line_id) ?? new Set<string>()
    set.add(j.id)
    jobIdsByLine.set(j.production_line_id, set)
  }
  const operationsByJob = new Map<string, OperationRow[]>()
  for (const o of operations) {
    const list = operationsByJob.get(o.job_id)
    if (list) list.push(o)
    else operationsByJob.set(o.job_id, [o])
  }

  const areaReports = areas.map((area) => {
    const areaJobIds = jobIdsByLine.get(area.id) ?? new Set<string>()
    const areaOperations: OperationRow[] = []
    for (const jobId of areaJobIds) areaOperations.push(...(operationsByJob.get(jobId) ?? []))
    const areaOperationIds = new Set(areaOperations.map((o) => o.id))

    // The area's denominator: scheduled models belonging to the build lines this area feeds.
    // An area with no feeds configured has an empty denominator — correct, and visible on the
    // page as "0 of 0" rather than as a wrong answer drawn from the whole schedule.
    const feeds = new Set(area.feeds)
    const scopedProducts = products
      .filter((p) => p.production_line_id !== null && feeds.has(p.production_line_id))
      .sort((a, b) => a.model.localeCompare(b.model))
    const scopedProductIds = new Set(scopedProducts.map((p) => p.id))

    // Coverage, from coverage.ts, over exactly this area's operations and this area's models.
    // Narrowing the INPUTS rather than filtering the output is what keeps "applicable" derived
    // per model: computeCoverageCombos creates a combo only where model_operations actually links
    // the model to an operation of that job, so a model with no Welding link simply has no
    // Welding combo and cannot be short one.
    const areaModelOperations = modelOperations.filter(
      (mo) => areaOperationIds.has(mo.operation_id) && scopedProductIds.has(mo.product_id)
    )
    const areaTimes = operationTimes.filter((t) => areaOperationIds.has(t.operation_id))
    const areaTimeIds = new Set(areaTimes.map((t) => t.id))
    const areaTimeModels = operationTimeModels.filter((tm) => areaTimeIds.has(tm.operation_time_id))

    const combos = computeCoverageCombos({
      operations: areaOperations,
      modelOperations: areaModelOperations,
      operationTimes: areaTimes,
      operationTimeModels: areaTimeModels,
    })

    const byProduct = new Map<string, { required: number; covered: number }>()
    for (const c of combos as CoverageCombo[]) {
      const entry = byProduct.get(c.productId) ?? { required: 0, covered: 0 }
      entry.required += 1
      if (c.covered) entry.covered += 1
      byProduct.set(c.productId, entry)
    }

    /** This model's total labour in this area: the current figure for every one of the area's
     * operations that has one for it, summed. The same current-record-per-operation rule
     * /model-total sums, scoped to the area's operations instead of to a whole model. */
    function areaMinutesFor(productId: string): number {
      let total = 0
      for (const op of areaOperations) {
        const stat = currentByPair[operationProductKey(op.id, productId)]
        if (stat) total += stat.minutes
      }
      return total
    }

    // Group: build line → series. Both groupings come off the PRODUCT (its own line, its own
    // series), never off the area, so a model always lands under the line that builds it.
    const byLine = new Map<string, Map<string, ProductRow[]>>()
    for (const p of scopedProducts) {
      const lineId = p.production_line_id as string
      const series = p.product_series?.trim() || 'Other'
      const lineGroup = byLine.get(lineId) ?? new Map<string, ProductRow[]>()
      const seriesGroup = lineGroup.get(series) ?? []
      seriesGroup.push(p)
      lineGroup.set(series, seriesGroup)
      byLine.set(lineId, lineGroup)
    }

    let areaCovered = 0
    const buildLines: BuildLineGroup[] = [...byLine.entries()].map(([lineId, seriesMap]) => {
      let lineCovered = 0
      let lineScheduled = 0

      const series: SeriesRow[] = [...seriesMap.entries()].map(([seriesName, seriesProducts]) => {
        let covered = 0
        let partial = 0
        const missingModels: string[] = []
        const noApplicableJobs: string[] = []
        const coveredMinutes: number[] = []

        for (const p of seriesProducts) {
          const entry = byProduct.get(p.id) ?? { required: 0, covered: 0 }
          if (entry.covered > 0) {
            covered += 1
            // Strictly fewer covered than required — the definition of partial. `required` is
            // this model's own applicable set, so a model with one applicable job and one time
            // is full, not partial, however many jobs the area has for other models.
            if (entry.covered < entry.required) partial += 1
            coveredMinutes.push(areaMinutesFor(p.id))
          } else {
            missingModels.push(p.model)
            if (entry.required === 0) noApplicableJobs.push(p.model)
          }
        }

        lineCovered += covered
        lineScheduled += seriesProducts.length

        return {
          series: seriesName,
          avgMinutes: coveredMinutes.length === 0
            ? null
            : coveredMinutes.reduce((sum, m) => sum + m, 0) / coveredMinutes.length,
          covered,
          scheduled: seriesProducts.length,
          partial,
          missingModels: missingModels.sort((a, b) => a.localeCompare(b)),
          noApplicableJobs,
        }
      }).sort((a, b) => {
        // "Other" is the unspecified-series bucket, not a series — it sorts last wherever it is
        // shown, the same rule every other series-grouped list in the app uses.
        if (a.series === 'Other' && b.series !== 'Other') return 1
        if (b.series === 'Other' && a.series !== 'Other') return -1
        return a.series.localeCompare(b.series)
      })

      areaCovered += lineCovered
      return {
        lineId,
        lineName: lineSplit.name(lineId),
        covered: lineCovered,
        scheduled: lineScheduled,
        series,
      }
    }).sort((a, b) => a.lineName.localeCompare(b.lineName))

    return {
      lineId: area.id,
      name: area.name,
      covered: areaCovered,
      scheduled: scopedProducts.length,
      hasTimes: areaTimeModels.some((tm) => scopedProductIds.has(tm.product_id)),
      jobCount: areaJobIds.size,
      buildLines,
    }
  })

  return { areas: areaReports, window, scheduledModels: window.productIds.length }
}
