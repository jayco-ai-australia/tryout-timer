'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  chunked, fetchLinksForOperations, READ_CHUNK,
} from '@/lib/modelOperations'
import { fetchAllChunked } from '@/lib/supabaseRead'
import { modelsForLine } from '@/lib/lines'
import { modelTotalMinutes, operationProductKey } from '@/lib/operationTimes'
import {
  aggregateCoverage, computeCoverageCombos, modelCoverageFromCombos, type ModelCoverage,
} from '@/lib/coverage'
import { fetchFutureBuilds, fmtScheduleDate, todayIsoDate } from '@/lib/schedule'
import { periodBounds, periodRangeLabel } from '@/lib/periods'
import { fmtHours, fmtMinutes } from '@/lib/format'
import { usePersistedFilter } from '@/lib/useLocalStorage'
import CollectorsPanel from '@/components/CollectorsPanel'
import type { ProductionLine, UserRole } from '@/lib/types'

/**
 * Dashboard — the collection scorecard.
 *
 * One question, answered in three parts: how much of the line is covered, which models to
 * collect next, and whether anyone is collecting. Everything is scoped by a single production
 * line filter and computed live; nothing here is cached or stored.
 *
 * ── Two coverage grains, one of them the headline ────────────────────────────────────────
 * The headline is JOB × model, straight out of lib/coverage.ts — the same definition
 * /model-total uses. A job counts as covered for a model when any of its
 * operations has a recorded time for that model. That is the planning unit, and making it the
 * headline is what lets this screen's percentage be compared with Model Total's without a
 * footnote explaining why they differ.
 *
 * Operation × model — one unit per model_operations row — is kept, but demoted to a single
 * muted detail line. It is the finer measure of collection effort (a job whose four operations
 * are one-quarter timed reads as one-quarter, not as covered), and it is worth showing; it just
 * isn't the number anyone should quote.
 *
 * The two are computed from the SAME fetched rows, so they can't disagree about the underlying
 * data — only about what they count. The job-level numbers all come from coverage.ts; nothing
 * here re-implements that definition.
 *
 * ── The schedule ──────────────────────────────────────────────────────────────────────────
 * Future builds come from `chassis`, joined to products through chassis.product_id and filtered
 * in the DATABASE by `dateonline >= today` — see lib/schedule. dateonline is a real Postgres
 * date column; nothing here parses, coerces or string-compares it.
 *
 * ── Everything else is reused ─────────────────────────────────────────────────────────────
 * Labour totals come from modelTotalMinutes (lib/operationTimes) — the "current record per
 * operation, then sum" rule, not a fresh SUM() — fed once from data fetched for the whole line
 * rather than per model. The applies-list read is fetchLinksForOperations, the chunking is
 * lib/modelOperations', and the schedule read is lib/schedule.
 */

interface Props {
  userId: string
  role: UserRole
  lines: ProductionLine[]
  initialLineId: string
}

const SEL: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
  border: '1.5px solid var(--border)', borderRadius: 8, padding: '7px 10px',
  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', outline: 'none', minWidth: 220,
}
const ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}
/** Same slide-in width as /setup's and /tryouts' drawers (.gaps-drawer is hard-coded to 25vw
 * for the dashboard gap drawer — overridden here to match the rest). */
const DRAWER_WIDTH: React.CSSProperties = { width: '33.333vw', minWidth: 340 }
const EMPTY: React.CSSProperties = {
  textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '28px 0',
}

/** Red below a third, amber below four fifths, green above — the same three-band reading the
 * coverage badges use elsewhere, so a colour means the same thing on every screen. */
function coveragePctClass(pct: number | null): string {
  if (pct == null) return 'badge-grey'
  if (pct >= 80) return 'badge-green'
  if (pct >= 33) return 'badge-amber'
  return 'badge-red'
}

function pctLabel(pct: number | null): string {
  return pct == null ? '—' : `${pct.toFixed(1)}%`
}

interface CoverageSummary {
  // ── Headline: job × model, from coverage.ts ──────────────────────────────────────────
  /** Required (job, model) combos in scope. */
  requiredCombos: number
  coveredCombos: number
  /** Uncovered COMBOS — job-level, not operations. */
  gaps: number
  pct: number | null
  /** Distinct models any job requires. */
  models: number
  /** Of those, the ones where every required job is covered. */
  modelsAtFull: number
  /** Per-model job×model coverage, keyed by product id — feeds the priority table's column, so
   * it is the same number as the headline, just scoped to one model. */
  byProductId: Map<string, ModelCoverage>

  // ── Secondary detail: operation × model ──────────────────────────────────────────────
  allocatedOperations: number
  timedOperations: number
  operationPct: number | null
}

interface PriorityRow {
  productId: string
  model: string
  /** Carried so the Model Total link can land already scoped — that screen restores its
   * line/series/model selects from localStorage, and a series that doesn't match its product's
   * own would be cleared as stale the moment it mounts. */
  lineId: string | null
  series: string
  /** 0 for a model with nothing booked — such a model is still listed. */
  futureBuilds: number
  /** This model's share of the line's future builds. null when the line has none at all. */
  sharePct: number | null
  /** `YYYY-MM-DD`, straight off the date column — formatted only at render. null when there is
   * no build ahead, which is what sorts those rows to the bottom. */
  nextOnLine: string | null
  /** Job × model, same definition as the headline — see coverage.ts. null means no job requires
   * this model at all, which is a different thing from 0%. */
  coveragePct: number | null
  requiredCombos: number
  coveredCombos: number
  totalMinutes: number | null
}

type SortKey = 'model' | 'future' | 'next' | 'coverage' | 'labour'
type SortDir = 'asc' | 'desc'

/** What each column sorts on. A null always sinks to the bottom, whichever direction is
 * active — "no date" and "no coverage" are absences, not extreme values, and floating them to
 * the top on a descending sort would bury the rows somebody actually asked to see. */
const SORT_VALUES: Record<SortKey, (row: PriorityRow) => string | number | null> = {
  model: (r) => r.model,
  future: (r) => r.futureBuilds,
  next: (r) => r.nextOnLine,
  coverage: (r) => r.coveragePct,
  labour: (r) => r.totalMinutes,
}

function sortRows(rows: PriorityRow[], key: SortKey, dir: SortDir): PriorityRow[] {
  const pick = SORT_VALUES[key]
  return [...rows].sort((a, b) => {
    const av = pick(a)
    const bv = pick(b)
    if (av == null && bv == null) return a.model.localeCompare(b.model)
    if (av == null) return 1
    if (bv == null) return -1
    let diff: number
    if (typeof av === 'number' && typeof bv === 'number') diff = av - bv
    // Dates are YYYY-MM-DD, so a string compare is a date compare.
    else diff = String(av).localeCompare(String(bv))
    if (diff === 0) return a.model.localeCompare(b.model)
    return dir === 'asc' ? diff : -diff
  })
}

/** One scheduled van in the focus panel — the chassis rows behind a model's "future builds". */
interface UpcomingChassis { id: string; chassisnumber: string; dateonline: string }

interface CollectedCounts {
  today: number
  thisWeek: number
  lastWeek: number
  /** The exact windows the counts came from, rendered under each card so the boundaries are
   * verifiable at a glance rather than taken on trust. */
  todayLabel: string
  thisWeekLabel: string
  lastWeekLabel: string
}

export default function DashboardClient({ role, lines, initialLineId }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()

  // Persisted, but seeded from the profile's line the first time — an admin starts unfiltered.
  const [lineId, setLineId] = usePersistedFilter('jmotion_dashboard_line', initialLineId)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [coverage, setCoverage] = useState<CoverageSummary | null>(null)
  const [priority, setPriority] = useState<PriorityRow[]>([])
  /** Default: soonest on the line first — the ordering the section exists for. */
  const [sortKey, setSortKey] = useState<SortKey>('next')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  // ── Focus panel: one model's upcoming vans, as a way into their Try Outs ─────────────
  const [focusRow, setFocusRow] = useState<PriorityRow | null>(null)
  const [focusVisible, setFocusVisible] = useState(false)
  const [focusChassis, setFocusChassis] = useState<UpcomingChassis[] | null>(null)
  const [focusError, setFocusError] = useState<string | null>(null)
  const [unlinkedBuilds, setUnlinkedBuilds] = useState(0)
  const [collected, setCollected] = useState<CollectedCounts>({
    today: 0, thisWeek: 0, lastWeek: 0, todayLabel: '', thisWeekLabel: '', lastWeekLabel: '',
  })

  /**
   * Which load is allowed to write to state.
   *
   * THIS IS THE LINE FILTER BUG, and it is worth being precise about it because the query that
   * looked wrong was never wrong. Every read below is correctly scoped by `lineId` already; what
   * was missing is that a load could still be in flight when the next one starts, and the LAST
   * ONE TO FINISH won — not the last one to start.
   *
   * On mount that is not a race, it is a certainty, and it always resolves the wrong way:
   *   1. First render uses `initialLineId`, which for an admin is '' — load #1 starts, unscoped,
   *      and sweeps every model in the business.
   *   2. usePersistedFilter's mount effect then restores the saved line, `lineId` changes, and
   *      load #2 starts correctly scoped to (say) Caravan.
   *   3. Load #2 is reading 89 models; load #1 is reading every model, every applies-list row,
   *      every recorded time and all 5,660 chassis. #2 lands first, paints Caravan, and is then
   *      overwritten by #1 with the whole business.
   *
   * What made it read as "only the schedule table leaks" is that the headings are derived from
   * the LIVE `lineId` while the figures came from the stale load — so the page said "How much of
   * Caravan is covered" over business-wide numbers, and the schedule table was simply the one
   * block listing model names you can eyeball against the filter. The coverage headline was
   * equally stale; "89 models" was just not obviously the wrong 89.
   *
   * A monotonic sequence number is enough: a load that is no longer the newest writes nothing —
   * not its results, not its error, not even setLoading(false), which would otherwise clear the
   * spinner out from under the load still running.
   */
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const isCurrent = () => loadSeq.current === seq

    setLoading(true)
    setError(null)
    try {
      // ── 1. The line's models ────────────────────────────────────────────────────────
      // THE model list for the line in scope — lib/lines, not a products-by-line query. A
      // pre-assembly line (Chassis, Sew, …) owns no products and inherits the models of the
      // lines it feeds, so the old filter gave those lines an empty table and a coverage
      // denominator of zero. Unfiltered ("All production lines") it still means every product.
      //
      // Still paged inside the resolver, for the reason this read has always been paged: an
      // unpaged select stops at PostgREST's 1,000-row cap as a normal 200 with a short array,
      // dropping models off both the coverage denominator and this table with nothing on screen
      // to say so. The table's own ordering is applied client-side by sortRows either way.
      //
      // NOTE these rows' `production_line_id` is the model's OWN line, which for a pre-assembly
      // line in scope is the build line it was inherited from. That is exactly what
      // openModelTotal wants to seed below: Model Total has to open on a line whose model list
      // actually holds the model.
      const products = await modelsForLine(supabase, lineId || null)
      // Cheap early exit: the line changed while this was reading, so everything below it is
      // work for a scope nobody is looking at any more.
      if (!isCurrent()) return
      const productIds = products.map((p) => p.id)

      // ── 2. The applies-list, scoped to those models ─────────────────────────────────
      // Scoped by PRODUCT, not by the operation's line: an operation doesn't have to sit on the
      // same line as the model it applies to, and often doesn't for imported data. The unit
      // being counted is "this operation is allocated to this model", so the model decides.
      // Paged, not just chunked: one 150-model chunk of the applies-list runs to thousands of
      // rows, well past the 1000-row response cap, and a capped response is a normal 200 with a
      // short array — the truncation that used to leave this screen's coverage headline at 0%.
      // See lib/supabaseRead. The order is the table's full primary key, which paging requires.
      const modelOperations = await fetchAllChunked<{ operation_id: string; product_id: string }>(
        productIds, READ_CHUNK,
        (chunk) => supabase
          .from('model_operations').select('operation_id, product_id').in('product_id', chunk)
          .order('operation_id').order('product_id'),
        { table: 'model_operations' }
      )

      // ── 3. Recorded times for those models, product-first ───────────────────────────
      // The same chain fetchModelTotal holds itself to: junction → times → operations, filtered
      // by product_id alone at the top and never re-narrowed by line.
      const operationTimeModels = await fetchAllChunked<{ operation_time_id: string; product_id: string }>(
        productIds, READ_CHUNK,
        (chunk) => supabase
          .from('operation_time_models').select('operation_time_id, product_id').in('product_id', chunk)
          .order('operation_time_id').order('product_id'),
        { table: 'operation_time_models' }
      )

      // FILTERED to the current records. This screen shows labour totals and nothing about the
      // history behind them — no run counts, no archived counts — so the archived rows would be
      // fetched only to be discarded by currentForOperation. superseded_by is still selected: the
      // helper decides which row is the figure, and handing it rows without the column would have
      // it guess.
      const timeIds = [...new Set(operationTimeModels.map((tm) => tm.operation_time_id))]
      const operationTimes = await fetchAllChunked<{ id: string; operation_id: string; total_minutes: number | null; superseded_by: string | null }>(
        timeIds, READ_CHUNK,
        (chunk) => supabase
          .from('operation_times').select('id, operation_id, total_minutes, superseded_by')
          .in('id', chunk).is('superseded_by', null)
          .order('id'),
        { table: 'operation_times' }
      )

      // ── 4. Operations + jobs, purely to label the labour rows ───────────────────────
      const opIds = [...new Set([
        ...modelOperations.map((mo) => mo.operation_id),
        ...operationTimes.map((t) => t.operation_id),
      ])]
      const operations: {
        id: string; name: string; job_id: string
        primary_operator_id: string | null; secondary_operator_id: string | null
      }[] = []
      for (const chunk of chunked(opIds, READ_CHUNK)) {
        const { data, error: err } = await supabase
          .from('operations')
          .select('id, name, job_id, primary_operator_id, secondary_operator_id')
          .in('id', chunk).eq('is_active', true)
        if (err) throw new Error(err.message)
        operations.push(...(data ?? []) as typeof operations)
      }

      const jobIds = [...new Set(operations.map((o) => o.job_id).filter(Boolean))]
      const jobs: { id: string; name: string }[] = []
      for (const chunk of chunked(jobIds, READ_CHUNK)) {
        // Identity lookup by id — deliberately NOT filtered to is_active. A retired job still
        // labels the operations and times that point at it; filtering here would blank the name
        // on real history rather than hide a row. See the note at the top of lib/jobs.
        const { data, error: err } = await supabase.from('jobs').select('id, name').in('id', chunk)
        if (err) throw new Error(err.message)
        jobs.push(...(data ?? []) as { id: string; name: string }[])
      }

      // ── 5. Coverage, both grains, from one set of rows ──────────────────────────────
      // Job × model is the headline and comes entirely from coverage.ts — the same
      // computeCoverageCombos /model-total calls, fed the same product_id-first
      // join, so the three screens cannot report different percentages for the same models.
      const combos = computeCoverageCombos({
        operations,
        modelOperations,
        operationTimes,
        operationTimeModels,
      })
      const aggregate = aggregateCoverage(combos)
      const perModel = modelCoverageFromCombos(combos)

      // ── TEMPORARY coverage diagnostics — remove once confirmed ──────────────────────
      // Prints the two sets computeCoverageCombos matches against, in the same
      // `jobId:productId` shape it keys them by, so an empty timed set (join/filter bug) is
      // instantly distinguishable from a populated one that doesn't intersect (key bug).
      {
        const jobIdByOperationId = new Map(operations.map((o) => [o.id, o.job_id]))
        const jobIdByTimeId = new Map<string, string>()
        for (const t of operationTimes) {
          const j = jobIdByOperationId.get(t.operation_id)
          if (j) jobIdByTimeId.set(t.id, j)
        }
        const requiredKeys = new Set<string>()
        for (const mo of modelOperations) {
          const j = jobIdByOperationId.get(mo.operation_id)
          if (j) requiredKeys.add(`${j}:${mo.product_id}`)
        }
        const timedKeys = new Set<string>()
        for (const tm of operationTimeModels) {
          const j = jobIdByTimeId.get(tm.operation_time_id)
          if (j) timedKeys.add(`${j}:${tm.product_id}`)
        }
        const intersect = [...timedKeys].filter((k) => requiredKeys.has(k))
        console.log('[coverage] line:', lineId || '(all)', {
          products: productIds.length,
          modelOperationRows: modelOperations.length,
          operationTimeModelRows: operationTimeModels.length,
          operationTimesFetched: operationTimes.length,
          operationsFetched: operations.length,
          requiredSet: requiredKeys.size,
          timedSet: timedKeys.size,
          matched: intersect.length,
          pct: aggregate.coveragePct === null ? null : Number(aggregate.coveragePct.toFixed(1)),
        })
        console.log('[coverage] sample required keys:', [...requiredKeys].slice(0, 3))
        console.log('[coverage] sample timed keys   :', [...timedKeys].slice(0, 3))
        console.log('[coverage] sample matched keys :', intersect.slice(0, 3))
        if (timedKeys.size === 0 && operationTimeModels.length > 0) {
          console.warn('[coverage] timed set is EMPTY despite', operationTimeModels.length,
            'model links — the times→operation→job join dropped every row (filter or fetch bug).')
        } else if (intersect.length === 0 && timedKeys.size > 0 && requiredKeys.size > 0) {
          console.warn('[coverage] timed set is populated but intersects nothing — key mismatch.')
        }
      }
      // ── end TEMPORARY diagnostics ───────────────────────────────────────────────────

      // Operation × model, the demoted detail line. Counted here rather than in coverage.ts
      // because it is a different unit — one per model_operations row — and coverage.ts owns
      // exactly one definition of coverage on purpose.
      const operationByTimeId = new Map(operationTimes.map((t) => [t.id, t.operation_id]))
      const timedPairs = new Set<string>()
      for (const tm of operationTimeModels) {
        const opId = operationByTimeId.get(tm.operation_time_id)
        if (opId) timedPairs.add(operationProductKey(opId, tm.product_id))
      }
      const allocatedOperations = modelOperations.length
      const timedOperations = modelOperations.filter(
        (mo) => timedPairs.has(operationProductKey(mo.operation_id, mo.product_id))
      ).length

      const byProductId = new Map(perModel.map((m) => [m.productId, m]))
      if (!isCurrent()) return
      setCoverage({
        requiredCombos: aggregate.totalRequired,
        coveredCombos: aggregate.totalCovered,
        gaps: aggregate.gapsRemaining,
        pct: aggregate.coveragePct,
        models: perModel.length,
        modelsAtFull: perModel.filter((m) => m.requiredCount > 0 && m.coveredCount === m.requiredCount).length,
        byProductId,
        allocatedOperations,
        timedOperations,
        operationPct: allocatedOperations > 0 ? (timedOperations / allocatedOperations) * 100 : null,
      })

      // ── 6. The schedule, and the priority table ─────────────────────────────────────
      // Scoped by the line's product ids and filtered by date IN THE DATABASE, so what comes
      // back is only the builds still ahead — no client-side date parsing, and no 1,000-row
      // page of the oldest rows standing in for the whole table.
      const future = await fetchFutureBuilds(supabase, lineId ? productIds : null)
      if (!isCurrent()) return
      setUnlinkedBuilds(future.unlinkedBuilds)

      // Every model on the line gets a row, including the ones with nothing booked. A model
      // that is fully covered and has no upcoming builds is a real answer — "nothing to do
      // here" — and dropping it made the table look like the model had disappeared.
      const totalFuture = future.totalFutureBuilds
      const rows: PriorityRow[] = products.map((product) => {
        const entry = future.byProductId.get(product.id)
        const cov = byProductId.get(product.id)
        // The shared "current record per operation, then sum" helper — never a raw
        // SUM(total_minutes), which would count every superseded run as extra labour content.
        const total = modelTotalMinutes({
          productId: product.id,
          operations,
          jobs,
          operationTimes,
          operationTimeModels,
        })
        const futureBuilds = entry?.futureBuilds ?? 0
        return {
          productId: product.id,
          model: product.model,
          lineId: product.production_line_id,
          series: product.product_series?.trim() || 'Other',
          futureBuilds,
          sharePct: totalFuture > 0 ? (futureBuilds / totalFuture) * 100 : null,
          nextOnLine: entry?.nextOnLine ?? null,
          coveragePct: cov?.coveragePct ?? null,
          requiredCombos: cov?.requiredCount ?? 0,
          coveredCombos: cov?.coveredCount ?? 0,
          totalMinutes: total.operations.length > 0 ? total.totalMinutes : null,
        }
      })
      if (!isCurrent()) return
      setPriority(rows)

      // ── 7. Times collected: today / this week / last week ───────────────────────────
      // Boundaries and labels come from lib/periods, which is also what the "Who's collecting"
      // panel below counts over — one Monday, one midnight, so the two sets of numbers
      // reconcile by construction rather than by two copies of the arithmetic agreeing.
      const bounds = periodBounds()
      const { todayStart, thisWeekStart, lastWeekStart } = bounds
      // NOT filtered to the current record: this counts COLLECTION ACTIVITY — how many times
      // were recorded in a window — not labour content. A run that has since been superseded was
      // still collected that day, and hiding it would make the week's work shrink retroactively
      // every time somebody re-measured something.
      async function countTimes(fromDate: Date, toDate?: Date): Promise<number> {
        let q = supabase.from('operation_times').select('id', { count: 'exact', head: true })
          .gte('created_at', fromDate.toISOString())
        if (toDate) q = q.lt('created_at', toDate.toISOString())
        if (lineId) q = q.eq('production_line_id', lineId)
        const { count, error: err } = await q
        if (err) throw new Error(err.message)
        return count ?? 0
      }
      const [todayCount, weekCount, lastWeekCount] = await Promise.all([
        countTimes(todayStart),
        countTimes(thisWeekStart),
        countTimes(lastWeekStart, thisWeekStart),
      ])
      if (!isCurrent()) return
      setCollected({
        today: todayCount,
        thisWeek: weekCount,
        lastWeek: lastWeekCount,
        todayLabel: periodRangeLabel('today', bounds),
        thisWeekLabel: periodRangeLabel('thisWeek', bounds),
        lastWeekLabel: periodRangeLabel('lastWeek', bounds),
      })
    } catch (err) {
      // A superseded load's failure is not this screen's problem — reporting it would put an
      // error banner over figures that loaded perfectly well for the line actually selected.
      if (!isCurrent()) return
      setError(err instanceof Error ? err.message : 'Could not load the dashboard')
      setCoverage(null); setPriority([]); setUnlinkedBuilds(0)
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [supabase, lineId])

  useEffect(() => { load() }, [load])

  const sortedPriority = useMemo(() => sortRows(priority, sortKey, sortDir), [priority, sortKey, sortDir])

  /** First click on a column sorts it ascending; clicking the active column flips it. */
  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  /**
   * Opens the focus panel and loads that model's upcoming vans — the chassis rows the "future
   * builds" count is made of, so the number can be drilled into rather than just read.
   */
  function openFocus(row: PriorityRow) {
    setFocusRow(row)
    setFocusChassis(null)
    setFocusError(null)
    requestAnimationFrame(() => requestAnimationFrame(() => setFocusVisible(true)))

    supabase
      .from('chassis')
      .select('id, chassisnumber, dateonline')
      .eq('product_id', row.productId)
      // The same date-column comparison the table's counts use — filtered by the database,
      // never parsed client-side.
      .gte('dateonline', todayIsoDate())
      .order('dateonline')
      .then(({ data, error }) => {
        if (error) { setFocusError(error.message); setFocusChassis([]); return }
        setFocusChassis((data ?? []) as UpcomingChassis[])
      })
  }

  function closeFocus() {
    setFocusVisible(false)
    window.setTimeout(() => setFocusRow(null), 320)
  }

  /** Straight into that van's Try Out. /tryouts creates or re-opens the tryouts row itself from
   * this parameter, so there is no second "start tryout" path to keep in step. */
  function openTryoutFor(chassisId: string) {
    router.push(`/tryouts?chassisId=${encodeURIComponent(chassisId)}`)
  }

  /**
   * Model Total, already scoped to this model. That screen restores its three selects from
   * localStorage via usePersistedFilter, so seeding those keys is what makes it open on the
   * model instead of blank. All three must agree — it clears a series or product that doesn't
   * belong to the line it mounts with.
   */
  function openModelTotal(row: PriorityRow) {
    try {
      window.localStorage.setItem('modelTotal.lineId', row.lineId ?? '')
      window.localStorage.setItem('modelTotal.series', row.series)
      window.localStorage.setItem('modelTotal.productId', row.productId)
    } catch {
      // Storage unavailable (private mode) — Model Total simply opens unscoped.
    }
    router.push('/model-total')
  }

  // Escape closes the focus panel, matching every other slide-over in the app.
  useEffect(() => {
    if (!focusRow) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closeFocus() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRow])

  const lineName = lines.find((l) => l.id === lineId)?.name ?? null

  return (
    <main className="page-wide">
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Collection scorecard</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
          How much of {lineName ?? 'the business'} is covered, which models to collect next, and
          whether anyone is collecting.
        </p>
      </div>

      {/* ── 1. Line filter — scopes everything below ─────────────────────────────────── */}
      <div className="card" style={{ padding: '14px 20px', marginBottom: 16, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={SEL} value={lineId} onChange={(e) => setLineId(e.target.value)}>
          <option value="">All production lines</option>
          {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {role === 'admin' && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Admins start unfiltered; your choice is remembered on this device.
          </span>
        )}
      </div>

      {error && <p style={{ ...ERR_BOX, marginBottom: 16 }}>{error}</p>}

      {loading ? (
        <p style={EMPTY}>Loading…</p>
      ) : (
        <>
          {/* ── 2. Coverage + gaps ───────────────────────────────────────────────────── */}
          <section className="card" style={{ padding: '22px 24px', marginBottom: 20 }}>
            {!coverage || coverage.requiredCombos === 0 ? (
              <div>
                <div className="stat-card-label">Coverage</div>
                <p style={{ ...EMPTY, textAlign: 'left', padding: '8px 0 0' }}>
                  No jobs require any model on {lineName ?? 'any line'} yet, so there is nothing to
                  have coverage of. Allocate operations to models in Setup or Try Outs and this
                  fills in.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ minWidth: 180 }}>
                  <div className="stat-card-label">Coverage</div>
                  <div style={{ fontSize: 52, fontWeight: 700, lineHeight: 1, color: coverage.pct != null && coverage.pct >= 80 ? 'var(--green)' : coverage.pct != null && coverage.pct >= 33 ? 'var(--amber)' : 'var(--red)' }}>
                    {pctLabel(coverage.pct)}
                  </div>
                  <div className="stat-card-sub">
                    {coverage.gaps.toLocaleString()} job&times;model gap{coverage.gaps === 1 ? '' : 's'} remaining
                  </div>
                </div>

                <div style={{ flex: 1, minWidth: 320 }}>
                  {/* Headline descriptor — job × model, the same unit Model Total uses. */}
                  <div style={{ fontSize: 14, color: 'var(--text-mid)', lineHeight: 1.7 }}>
                    <strong style={{ color: 'var(--text)' }}>{coverage.requiredCombos.toLocaleString()}</strong>{' '}
                    job&times;model combination{coverage.requiredCombos === 1 ? '' : 's'} required across{' '}
                    <strong style={{ color: 'var(--text)' }}>{coverage.models}</strong>{' '}
                    model{coverage.models === 1 ? '' : 's'}.{' '}
                    <strong style={{ color: 'var(--text)' }}>{coverage.coveredCombos.toLocaleString()}</strong>{' '}
                    covered &rarr; <strong style={{ color: 'var(--text)' }}>{pctLabel(coverage.pct)}</strong>.{' '}
                    <strong style={{ color: 'var(--text)' }}>{coverage.modelsAtFull}</strong> of{' '}
                    {coverage.models} model{coverage.models === 1 ? '' : 's'} fully covered.
                  </div>

                  {/* Secondary, deliberately subordinate: the finer measure of collection
                    * effort. Same underlying rows, different unit — never the quoted number. */}
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.6 }}>
                    <strong style={{ fontWeight: 700 }}>Operation detail:</strong>{' '}
                    {coverage.timedOperations.toLocaleString()} of{' '}
                    {coverage.allocatedOperations.toLocaleString()} allocated operations timed
                    ({pctLabel(coverage.operationPct)}).
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
                    A job counts as covered once any one of its operations has a time for that
                    model — so the headline runs ahead of the operation detail, which counts every
                    allocation separately.
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* ── 3. Times collected ───────────────────────────────────────────────────── */}
          <section>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>Times collected</div>
            <div className="grid-3">
              <div className="stat-card">
                <div className="stat-card-label">Today</div>
                <div className="stat-card-value">{collected.today.toLocaleString()}</div>
                <div className="stat-card-sub">{collected.todayLabel}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-label">This week</div>
                <div className="stat-card-value">{collected.thisWeek.toLocaleString()}</div>
                <div className="stat-card-sub">
                  {collected.thisWeekLabel}
                  {collected.lastWeek > 0 && ` · ${collected.lastWeek.toLocaleString()} across all of last week`}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card-label">Last week</div>
                <div className="stat-card-value">{collected.lastWeek.toLocaleString()}</div>
                <div className="stat-card-sub">{collected.lastWeekLabel}</div>
              </div>
            </div>
          </section>

          {/* ── 4. Who's collecting ──────────────────────────────────────────────────── */}
          {/* The same operation_times the cards above count, broken down by who recorded
            * them. Loads independently of the coverage sweep and over the same line filter;
            * see lib/collectors for the aggregation and lib/periods for the windows. */}
          <div style={{ marginTop: 20 }}>
            <CollectorsPanel lineId={lineId} lineName={lineName} />
          </div>

          {/* ── 5. Schedule priority ─────────────────────────────────────────────────── */}
          <section className="card" style={{ marginBottom: 20, overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Collect these next</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                Every model on the line, soonest build first — models with nothing booked sink to
                the bottom. A low coverage figure at the top of this list is the most expensive
                gap you have. Click any column to re-sort.
              </div>
            </div>

            {priority.length === 0 ? (
              <p style={EMPTY}>
                No models are set up for {lineName ?? 'any line'} yet.
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <SortHeader label="Model" col="model" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <SortHeader label="Future builds" col="future" align="center" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <SortHeader label="Next online" col="next" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <SortHeader label="Coverage" col="coverage" align="right" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <SortHeader label="Total labour" col="labour" align="right" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      {/* Not sortable — it holds a link, not a value. */}
                      <th className="right" style={{ width: 1, whiteSpace: 'nowrap' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPriority.map((row) => (
                      <tr key={row.productId} style={row.futureBuilds === 0 ? { opacity: 0.7 } : undefined}>
                        <td className="primary">
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <button
                              type="button"
                              className="row-icon-button"
                              title={`Show ${row.model}'s upcoming vans`}
                              aria-label={`Show ${row.model}'s upcoming vans`}
                              onClick={() => openFocus(row)}
                            >
                              <StopwatchIcon />
                            </button>
                            {row.model}
                          </span>
                        </td>
                        <td className="center">
                          {row.futureBuilds}
                          {row.futureBuilds > 0 && row.sharePct != null && (
                            <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                              {' '}({row.sharePct.toFixed(0)}%)
                            </span>
                          )}
                        </td>
                        <td>
                          {row.nextOnLine
                            ? fmtScheduleDate(row.nextOnLine)
                            : <span style={{ color: 'var(--text-muted)' }}>none scheduled</span>}
                        </td>
                        <td className="right">
                          {row.coveragePct == null ? (
                            <span className="badge badge-grey" title="No job requires this model — nothing has been allocated to it yet, so there is no coverage to report">
                              —
                            </span>
                          ) : (
                            <span className={'badge ' + coveragePctClass(row.coveragePct)} title={`${row.coveredCombos} of ${row.requiredCombos} required job×model combinations covered`}>
                              {pctLabel(row.coveragePct)}
                            </span>
                          )}
                        </td>
                        <td className="right mono" title={row.totalMinutes != null ? `${fmtHours(row.totalMinutes)} h` : 'Nothing has been timed for this model yet'}>
                          {row.totalMinutes != null ? `${fmtMinutes(row.totalMinutes)}m` : '—'}
                        </td>
                        <td className="right">
                          <button
                            type="button"
                            className="finder-row-action"
                            style={{ whiteSpace: 'nowrap' }}
                            title={`Open ${row.model} in Model Total`}
                            onClick={() => openModelTotal(row)}
                          >
                            Model Total →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Small print: scheduled builds that couldn't be attributed to a model. Only shown
              * unfiltered — under a line filter a build with no model belongs to no line. */}
            {!lineId && unlinkedBuilds > 0 && (
              <div style={{ padding: '10px 20px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)' }}>
                {unlinkedBuilds} scheduled build{unlinkedBuilds === 1 ? '' : 's'} {unlinkedBuilds === 1 ? 'is' : 'are'} not
                linked to a model (chassis.product_id is empty), so {unlinkedBuilds === 1 ? 'it is' : 'they are'} not
                counted above.
              </div>
            )}
          </section>
        </>
      )}

      {/* ── Focus panel: one model's upcoming vans, each a way into its Try Out ─────── */}
      {focusRow && (
        <>
          <div
            className={'gaps-drawer-overlay' + (focusVisible ? ' gaps-drawer-overlay-visible' : '')}
            onClick={closeFocus}
          />
          <div className={'gaps-drawer' + (focusVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <div className="gaps-drawer-header">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="gaps-drawer-title">{focusRow.model}</div>
                <div className="gaps-drawer-jobname" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className={'badge ' + coveragePctClass(focusRow.coveragePct)}>
                    {focusRow.coveragePct == null ? 'no coverage' : `${pctLabel(focusRow.coveragePct)} covered`}
                  </span>
                  <span>
                    {focusRow.futureBuilds} future build{focusRow.futureBuilds === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
              <button className="gaps-drawer-close" onClick={closeFocus} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="gaps-drawer-body" style={{ padding: '16px 20px' }}>
              {focusError && <p style={{ ...ERR_BOX, marginBottom: 12 }}>{focusError}</p>}

              {focusChassis == null ? (
                <p style={EMPTY}>Loading…</p>
              ) : focusChassis.length === 0 ? (
                <p style={EMPTY}>
                  No vans of this model are scheduled from today onwards, so there is nothing
                  coming up to time.
                </p>
              ) : (
                <>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px', lineHeight: 1.5 }}>
                    Soonest first. Picking one opens its Try Out — starting the tryout if it
                    hasn&apos;t been started yet.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {focusChassis.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="exception-item-button"
                        style={{
                          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          gap: 12, textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer',
                        }}
                        onClick={() => openTryoutFor(c.id)}
                        title={`Open the Try Out for ${c.chassisnumber}`}
                      >
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{c.chassisnumber}</span>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            online {fmtScheduleDate(c.dateonline)}
                          </span>
                        </span>
                        <span className="finder-chevron">›</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </main>
  )
}

/** The stopwatch that opens a model's focus panel — same glyph as the app's own mark, so the
 * affordance reads as "go and time this". */
function StopwatchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="13" r="8" />
      <polyline points="12 9 12 13 14.5 15.5" />
      <path d="M9 3h6" />
      <path d="M12 3v2" />
    </svg>
  )
}

/** A clickable column header. The arrow is always rendered — faint on inactive columns, so the
 * whole row reads as sortable — and solid on the one actually in force. */
function SortHeader({
  label, col, align, sortKey, sortDir, onSort,
}: {
  label: string
  col: SortKey
  align?: 'center' | 'right'
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
}) {
  const active = sortKey === col
  return (
    <th
      className={'sortable' + (align ? ' ' + align : '') + (active ? ' sorted' : '')}
      onClick={() => onSort(col)}
      role="button"
      tabIndex={0}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(col) } }}
    >
      {label}
      <span className="sort-arrow">{active ? (sortDir === 'asc' ? '▲' : '▼') : '▲'}</span>
    </th>
  )
}
