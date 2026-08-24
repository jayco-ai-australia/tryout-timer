'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeCoverageCombos, type CoverageOperationInput, type CoverageModelOperationInput } from '@/lib/coverage'
import { addOperationTimeNote, fetchModelTotal, recordOperationTime, type ModelTotalFetchResult, type ModelTotalOperationRow } from '@/lib/operationTimes'
import { fmtHours, fmtMinutes } from '@/lib/format'
import { usePersistedFilter } from '@/lib/useLocalStorage'
import CopyToModelsPanel, { type CopyJob } from './CopyToModelsPanel'
import type { Product, ProductionLine } from '@/lib/types'

interface Props { lines: ProductionLine[]; userId: string }

const SEL: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
  border: '1.5px solid var(--border)', borderRadius: 8, padding: '7px 10px',
  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', outline: 'none', minWidth: 220,
}
const EMPTY: React.CSSProperties = { textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '40px 0' }
/** .gaps-drawer (see globals.css) is hard-coded to 25vw for the /dashboard gap drawer —
 * reused here for the slide-in/overlay/shadow behaviour, matching the convention of
 * overriding just the width to half the page. */
const ADD_TIME_DRAWER_WIDTH: React.CSSProperties = { width: '50vw' }

/** OPERATION (flexible) | AVG MINS (fixed) | RUNS (fixed) — applied identically to the column
 * header, every job card's header line, every operation row, and the grand total, so the three
 * columns sit at the same x-position everywhere regardless of which job cards are expanded. */
const GRID_COLS = '1fr 100px 70px'
const GRID_GAP = 12

/** An operation that requires the selected model, per model_operations — fetched product_id
 * first, with no production-line scope, so it lines up with what fetchModelTotal found. */
interface RequiredOpRow { id: string; name: string; job_id: string; primary_operator_id: string | null; secondary_operator_id: string | null }

/** An untimed/"missing" operation shown inside a Timed job card, greyed. Carries the operator
 * fields directly (from requiredOps) rather than an id looked up in a side map. */
interface MissingOpRow { operationId: string; operationName: string; primaryOperatorId: string | null; secondaryOperatorId: string | null }

interface JobGroup {
  jobId: string
  jobName: string
  rows: ModelTotalOperationRow[]
  subtotal: number
  missing: MissingOpRow[]
  /** Distinct operator ids across every operation in this group (timed + missing) — primary and
   * secondary, deduped. Names are resolved separately (see operatorNames). */
  operatorIds: string[]
}

/** A job required for this model (via model_operations) with zero recorded times anywhere in
 * it — coverage's "required but not covered" jobs, which jobGroups never surfaces at all (it
 * only ever seeds a group from a *timed* operation). Every operation here is, by definition,
 * untimed — if any of them had a time, coverage would mark the job covered. */
interface UntimedJobGroup {
  jobId: string
  jobName: string
  operatorIds: string[]
  operations: MissingOpRow[]
}

/** Distinct primary+secondary operator ids read directly off the operation objects a card
 * renders (ModelTotalOperationRow rows, MissingOpRow rows) — no separate id-lookup map. If a
 * row is on screen, its operator counts toward the header; nothing can silently fail to
 * resolve, because there's no second data source to fall out of sync with the first. */
function collectOperatorIds(operations: { primaryOperatorId: string | null; secondaryOperatorId: string | null }[]): string[] {
  const set = new Set<string>()
  for (const op of operations) {
    if (op.primaryOperatorId) set.add(op.primaryOperatorId)
    if (op.secondaryOperatorId) set.add(op.secondaryOperatorId)
  }
  return [...set]
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0, color: 'var(--text-muted)' }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

export default function ModelTotalClient({ lines, userId }: Props) {
  const supabase = useMemo(() => createClient(), [])

  const [lineId, setLineId] = usePersistedFilter('modelTotal.lineId', '')
  const [series, setSeries] = usePersistedFilter('modelTotal.series', '')
  const [productId, setProductId] = usePersistedFilter('modelTotal.productId', '')

  // Bumped after a successful Add Time save to force the two productId-keyed fetches below to
  // re-run without productId itself changing — the total, coverage, and breakdown all read off
  // fetchModelTotal/the required-set fetch, so re-running those is the one place a refresh needs
  // to happen for everything (headline, "X / Y jobs timed", job cards) to reconcile.
  const [refreshTick, setRefreshTick] = useState(0)

  // Products for the chosen line — purely a navigation aid for the Series/Model selects below.
  // Once a model is picked, nothing past this point is scoped by production line: a model's
  // total and coverage are defined by operation_time_models.product_id alone (see
  // fetchModelTotal), not by which line the recording operation's job happens to sit on.
  const [products, setProducts] = useState<Product[]>([])
  const [productsLoading, setProductsLoading] = useState(false)

  // The model's total — product_id-first, line-agnostic (see fetchModelTotal in operationTimes.ts).
  const [modelTotal, setModelTotal] = useState<ModelTotalFetchResult | null>(null)
  const [modelTotalLoading, setModelTotalLoading] = useState(false)
  const [modelTotalError, setModelTotalError] = useState<string | null>(null)

  // The "required" side of coverage — every operation (any line) that model_operations says
  // requires this model. Also product_id-first: this is what makes the coverage stat and the
  // totals breakdown reconcile, since both now walk the same unscoped join instead of one being
  // filtered down to "jobs on the currently-selected line" and the other not.
  const [requiredOps, setRequiredOps] = useState<RequiredOpRow[]>([])
  const [requiredModelOps, setRequiredModelOps] = useState<CoverageModelOperationInput[]>([])
  // Names for the required set's job_ids — fetchModelTotal's own `jobs` fetch only covers jobs
  // that have a *timed* operation, so a fully-untimed required job (see untimedJobGroups) has no
  // name anywhere else.
  const [requiredJobs, setRequiredJobs] = useState<{ id: string; name: string }[]>([])
  const [requiredLoading, setRequiredLoading] = useState(false)
  const [requiredError, setRequiredError] = useState<string | null>(null)

  // Products for the chosen line — drives both the series/model selects below.
  useEffect(() => {
    let cancelled = false
    if (!lineId) { setProducts([]); return }
    setProductsLoading(true)
    supabase.from('products').select('*').eq('production_line_id', lineId).order('model')
      .then(({ data }) => { if (!cancelled) { setProducts(data ?? []); setProductsLoading(false) } })
    return () => { cancelled = true }
  }, [supabase, lineId])

  // Series grouping for the model select — same "group, sort, Other-last" shape as every other
  // series-grouped model picker in the app (ModelLinker, /collect).
  const seriesGroups = useMemo(() => {
    const groups = new Map<string, Product[]>()
    for (const p of products) {
      const s = p.product_series?.trim() || 'Other'
      if (!groups.has(s)) groups.set(s, [])
      groups.get(s)!.push(p)
    }
    return [...groups.entries()]
      .map(([s, group]) => ({ series: s, products: [...group].sort((a, b) => a.model.localeCompare(b.model)) }))
      .sort((a, b) => {
        if (a.series === 'Other' && b.series !== 'Other') return 1
        if (b.series === 'Other' && a.series !== 'Other') return -1
        return a.series.localeCompare(b.series)
      })
  }, [products])

  const modelsInSeries = useMemo(
    () => seriesGroups.find((g) => g.series === series)?.products ?? [],
    [seriesGroups, series]
  )

  // Keep the three selects internally consistent: a stale series (from a previous line) or a
  // stale model (from a previous series) gets cleared rather than silently pointing at nothing.
  useEffect(() => {
    if (products.length === 0) return
    if (series && !seriesGroups.some((g) => g.series === series)) { setSeries(''); setProductId(''); return }
    if (productId && !products.some((p) => p.id === productId)) setProductId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, seriesGroups])

  const selectedProduct = useMemo(() => products.find((p) => p.id === productId) ?? null, [products, productId])

  // Fetches + computes the total for the selected model, product_id-first.
  useEffect(() => {
    let cancelled = false
    if (!productId) { setModelTotal(null); setModelTotalError(null); return }
    setModelTotalLoading(true)
    setModelTotalError(null)
    fetchModelTotal(supabase, productId)
      .then((r) => {
        if (cancelled) return
        setModelTotal(r)
      })
      .catch((err) => { if (!cancelled) setModelTotalError(err instanceof Error ? err.message : 'Could not load model total') })
      .finally(() => { if (!cancelled) setModelTotalLoading(false) })
    return () => { cancelled = true }
  }, [supabase, productId, refreshTick])

  // Fetches the required-set for coverage: model_operations WHERE product_id = productId, with
  // no line/job scope, then the operations those rows point at (for job_id + a readable name).
  useEffect(() => {
    let cancelled = false
    if (!productId) { setRequiredOps([]); setRequiredModelOps([]); setRequiredJobs([]); setRequiredError(null); return }

    async function run() {
      setRequiredLoading(true)
      setRequiredError(null)
      const { data: moRows, error: moError } = await supabase
        .from('model_operations').select('operation_id, product_id').eq('product_id', productId)
      if (cancelled) return
      if (moError) { setRequiredError(moError.message); setRequiredLoading(false); return }
      setRequiredModelOps(moRows ?? [])

      const opIds = [...new Set((moRows ?? []).map((r) => r.operation_id))]
      const { data: opRows, error: opsError } = opIds.length > 0
        ? await supabase.from('operations').select('id, name, job_id, primary_operator_id, secondary_operator_id').in('id', opIds).eq('is_active', true)
        : { data: [] as RequiredOpRow[], error: null }
      if (cancelled) return
      if (opsError) { setRequiredError(opsError.message); setRequiredLoading(false); return }
      setRequiredOps(opRows ?? [])

      const jobIds = [...new Set((opRows ?? []).map((o) => o.job_id))]
      const { data: jobRows, error: jobsError } = jobIds.length > 0
        ? await supabase.from('jobs').select('id, name').in('id', jobIds)
        : { data: [] as { id: string; name: string }[], error: null }
      if (cancelled) return
      if (jobsError) { setRequiredError(jobsError.message); setRequiredLoading(false); return }
      setRequiredJobs(jobRows ?? [])

      setRequiredLoading(false)
    }

    run()
    return () => { cancelled = true }
  }, [supabase, productId, refreshTick])

  // Coverage combos — computeCoverageCombos (coverage.ts, unchanged) fed with the union of the
  // required-set operations above and the timed operations fetchModelTotal already found, plus
  // that SAME fetch's raw operationTimes/operationTimeModels. Both "required" and "covered" now
  // walk the identical product_id → operation_time_models → operation_times join, so this can't
  // disagree with the breakdown/total the way a line-scoped fetch did.
  const modelCombos = useMemo(() => {
    if (!productId) return []
    const opMap = new Map<string, { id: string; job_id: string }>()
    for (const o of requiredOps) opMap.set(o.id, { id: o.id, job_id: o.job_id })
    for (const o of modelTotal?.raw.operations ?? []) opMap.set(o.id, o)

    return computeCoverageCombos({
      operations: [...opMap.values()] as CoverageOperationInput[],
      modelOperations: requiredModelOps,
      operationTimes: modelTotal?.raw.operationTimes ?? [],
      operationTimeModels: modelTotal?.raw.operationTimeModels ?? [],
    }).filter((c) => c.productId === productId)
  }, [productId, requiredOps, requiredModelOps, modelTotal])

  const jobsRequired = modelCombos.length
  const jobsTimed = modelCombos.filter((c) => c.covered).length

  const result = modelTotal ?? { totalMinutes: 0, operations: [] as ModelTotalOperationRow[] }

  // Grouped by job, subtotal-descending, with each job's required-but-untimed operations for
  // this model tacked on greyed-out at the bottom — visible as a gap, contributing 0. Each
  // group's operatorIds is collectOperatorIds() run directly over the row objects the card
  // renders (g.rows + g.missing) — both already carry primaryOperatorId/secondaryOperatorId
  // (ModelTotalOperationRow and MissingOpRow respectively), so there's no separate id list to
  // look up and no way for the header to disagree with what's actually on screen.
  const jobGroups: JobGroup[] = useMemo(() => {
    if (!productId) return []
    const opById = new Map(requiredOps.map((o) => [o.id, o]))
    const requiredOpIds = new Set(requiredModelOps.map((mo) => mo.operation_id))
    const timedOpIds = new Set(result.operations.map((r) => r.operationId))

    const byJob = new Map<string, Omit<JobGroup, 'operatorIds'>>()
    for (const row of result.operations) {
      const g = byJob.get(row.jobId) ?? { jobId: row.jobId, jobName: row.jobName, rows: [], subtotal: 0, missing: [] }
      g.rows.push(row)
      g.subtotal += row.avgMinutes
      byJob.set(row.jobId, g)
    }
    for (const opId of requiredOpIds) {
      if (timedOpIds.has(opId)) continue
      const op = opById.get(opId)
      if (!op) continue
      // Only surface a gap under a job that already has at least one timed operation for this
      // model — a job with nothing timed at all doesn't get a group (nothing to anchor it to).
      const g = byJob.get(op.job_id)
      if (!g) continue
      g.missing.push({ operationId: op.id, operationName: op.name, primaryOperatorId: op.primary_operator_id, secondaryOperatorId: op.secondary_operator_id })
    }
    return [...byJob.values()]
      .map((g) => ({ ...g, operatorIds: collectOperatorIds([...g.rows, ...g.missing]) }))
      .sort((a, b) => a.jobName.localeCompare(b.jobName))
  }, [productId, requiredOps, requiredModelOps, result])

  // Jobs required for this model (modelCombos, uncovered) that jobGroups doesn't surface at all
  // — reusing coverage.ts's own combos, not a re-derived required-set, so this count always
  // equals jobsRequired - jobsTimed exactly (see the headline stat above). Same direct
  // collectOperatorIds(operations) derivation as jobGroups, so the two sections can't disagree.
  const untimedJobGroups: UntimedJobGroup[] = useMemo(() => {
    if (!productId) return []
    const untimedJobIds = new Set(modelCombos.filter((c) => !c.covered).map((c) => c.jobId))
    if (untimedJobIds.size === 0) return []

    const jobNameById = new Map(requiredJobs.map((j) => [j.id, j.name]))
    const byJob = new Map<string, Omit<UntimedJobGroup, 'operatorIds'>>()
    for (const op of requiredOps) {
      if (!untimedJobIds.has(op.job_id)) continue
      const g = byJob.get(op.job_id) ?? { jobId: op.job_id, jobName: jobNameById.get(op.job_id) ?? '—', operations: [] }
      g.operations.push({ operationId: op.id, operationName: op.name, primaryOperatorId: op.primary_operator_id, secondaryOperatorId: op.secondary_operator_id })
      byJob.set(op.job_id, g)
    }
    return [...byJob.values()]
      .map((g) => ({ ...g, operatorIds: collectOperatorIds(g.operations) }))
      .sort((a, b) => a.jobName.localeCompare(b.jobName))
  }, [productId, modelCombos, requiredOps, requiredJobs])

  // Active operators — fetched once, globally (same shape/query as /collect's and /tryouts'
  // allActiveOperators), not scoped to any one job/team. Feeds both the Add Time pane's Operator
  // select and, via operatorNameById below, the job-card labels.
  const [allActiveOperators, setAllActiveOperators] = useState<{ id: string; full_name: string }[]>([])
  useEffect(() => {
    supabase.from('operators').select('id, full_name').eq('is_active', true).order('full_name')
      .then(({ data }) => setAllActiveOperators(data ?? []))
  }, [supabase])

  // Names for the operator ids collected above — one batched fetch for whatever isn't already
  // known, not a query per row. fetchedOperatorIds (a ref, not state) tracks what's already
  // in flight/loaded so this doesn't re-fetch every time operatorNames itself updates.
  //
  // The result is deliberately NOT discarded when this effect re-runs. The page's data lands in
  // waves (fetchModelTotal + the required-set fetch resolve independently), so jobGroups changes
  // identity several times on load and re-runs this effect each time. A cancel-on-cleanup guard
  // would throw away the in-flight response from wave N when wave N+1 arrived — while its ids
  // stayed marked in fetchedOperatorIds, so no later run would ever re-request them and the name
  // would never reach state. setOperatorNames merges by id and is idempotent, so applying a
  // response from a superseded run is harmless; dropping it is not.
  const [operatorNames, setOperatorNames] = useState<Record<string, string>>({})
  const fetchedOperatorIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    const needed = new Set<string>()
    for (const g of [...jobGroups, ...untimedJobGroups]) for (const id of g.operatorIds) if (!fetchedOperatorIds.current.has(id)) needed.add(id)
    if (needed.size === 0) return
    for (const id of needed) fetchedOperatorIds.current.add(id)

    supabase.from('operators').select('id, full_name').in('id', [...needed])
      .then(({ data, error }) => {
        // Un-mark anything this batch didn't actually resolve (query error, or an id the query
        // returned no row for) so a later run retries it rather than leaving the id marked as
        // "fetched" against a name that never arrived.
        const returned = new Set((data ?? []).map((o) => o.id))
        for (const id of needed) if (!returned.has(id)) fetchedOperatorIds.current.delete(id)
        if (error) return
        setOperatorNames((prev) => {
          const next = { ...prev }
          for (const o of data ?? []) next[o.id] = o.full_name
          return next
        })
      })
  }, [jobGroups, untimedJobGroups, supabase])

  // Single id→name lookup for the job-card labels. Folds in allActiveOperators (fetched once,
  // globally, for the Add Time pane) as a second source, so an active operator resolves even if
  // the batched .in() fetch above hasn't landed yet — and, being a useMemo over both, the labels
  // recompute when either source arrives in a later wave.
  const operatorNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const o of allActiveOperators) map.set(o.id, o.full_name)
    for (const [id, name] of Object.entries(operatorNames)) map.set(id, name)
    return map
  }, [operatorNames, allActiveOperators])

  // An id with no name yet is simply omitted — operatorNameById is a useMemo over both operator
  // sources, so the label recomputes and fills in when a later wave lands.
  function operatorLabelFor(operatorIds: string[]): string {
    return operatorIds
      .map((id) => operatorNameById.get(id))
      .filter((name): name is string => Boolean(name))
      .sort((a, b) => a.localeCompare(b))
      .join(', ')
  }

  // Collapsed by default — expand a job to see its operations, or use Expand/Collapse all.
  // ── Copy to other models ─────────────────────────────────────────────────────────────
  const [copyOpen, setCopyOpen] = useState(false)

  /**
   * Every job that applies to the source model, with its applicable operations — derived from
   * requiredOps (model_operations → active operations), NOT from jobGroups, because jobGroups
   * only seeds a group from a *timed* operation. A job whose work has never been timed still
   * has structure worth copying, and leaving it out would silently narrow what "copy all jobs"
   * means.
   */
  const copyJobs: CopyJob[] = useMemo(() => {
    if (!productId) return []
    const jobNameById = new Map(requiredJobs.map((j) => [j.id, j.name]))
    const byJob = new Map<string, CopyJob>()
    for (const op of requiredOps) {
      const g = byJob.get(op.job_id) ?? { jobId: op.job_id, jobName: jobNameById.get(op.job_id) ?? '—', operations: [] }
      g.operations.push({ id: op.id, name: op.name })
      byJob.set(op.job_id, g)
    }
    return [...byJob.values()].sort((a, b) => a.jobName.localeCompare(b.jobName))
  }, [productId, requiredOps, requiredJobs])

  /** Everything else on the line — the source can't be a target of itself. */
  const copyTargets = useMemo(
    () => products.filter((p) => p.id !== productId),
    [products, productId]
  )

  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set())
  useEffect(() => { setExpandedJobs(new Set()) }, [productId])
  function toggleJob(jobId: string) {
    setExpandedJobs((prev) => { const next = new Set(prev); if (next.has(jobId)) next.delete(jobId); else next.add(jobId); return next })
  }

  // ── Add Time slide-over ─────────────────────────────────────────────────────────────────
  const [addTimeTarget, setAddTimeTarget] = useState<{ jobId: string; jobName: string } | null>(null)
  const [addTimeVisible, setAddTimeVisible] = useState(false)
  const [addTimeOperationId, setAddTimeOperationId] = useState('')
  const [addTimeOperatorId, setAddTimeOperatorId] = useState('')
  const [addTimeMinutes, setAddTimeMinutes] = useState('')
  const [addTimeNote, setAddTimeNote] = useState('')
  const [addTimeSaving, setAddTimeSaving] = useState(false)
  const [addTimeError, setAddTimeError] = useState<string | null>(null)

  // The operations available in the pane's Operation select — every operation under the target
  // job that's actually required for the selected model (requiredOps, already job_id-tagged),
  // not every operation the job happens to have. A time recorded against an operation outside
  // this set wouldn't count toward this model's total/coverage at all, so it's not offered here.
  const addTimeJobOps = useMemo(
    () => requiredOps.filter((o) => o.job_id === addTimeTarget?.jobId),
    [requiredOps, addTimeTarget]
  )

  function openAddTime(jobId: string, jobName: string, preselectedOperationId?: string) {
    const jobOps = requiredOps.filter((o) => o.job_id === jobId)
    const totalOp = jobOps.find((o) => o.name.trim().endsWith('- Total'))
    const defaultOperationId = preselectedOperationId ?? totalOp?.id ?? jobOps[0]?.id ?? ''
    const defaultOperation = jobOps.find((o) => o.id === defaultOperationId)

    setAddTimeTarget({ jobId, jobName })
    setAddTimeOperationId(defaultOperationId)
    setAddTimeOperatorId(defaultOperation?.primary_operator_id ?? '')
    setAddTimeMinutes('')
    setAddTimeNote('')
    setAddTimeError(null)
    requestAnimationFrame(() => requestAnimationFrame(() => setAddTimeVisible(true)))
  }

  function closeAddTime() {
    if (addTimeSaving) return
    setAddTimeVisible(false)
    window.setTimeout(() => setAddTimeTarget(null), 320)
  }

  // Selecting a different operation re-defaults the operator to *that* operation's primary —
  // still editable afterwards, just a sensible starting point per operation.
  function handleAddTimeOperationChange(operationId: string) {
    setAddTimeOperationId(operationId)
    const op = addTimeJobOps.find((o) => o.id === operationId)
    setAddTimeOperatorId(op?.primary_operator_id ?? '')
  }

  /** Goes through the exact same recordOperationTime/addOperationTimeNote helpers every other
   * time-entry flow in the app uses (ModelLinker, /collect, /tryouts' stopwatch complete) —
   * no raw insert here. productIds is just the page's already-selected model. */
  async function handleAddTimeSave() {
    if (!productId || !addTimeOperationId) return
    const minutes = Number(addTimeMinutes)
    if (!addTimeMinutes.trim() || Number.isNaN(minutes) || minutes <= 0) {
      setAddTimeError('Enter a valid number of minutes')
      return
    }
    if (!addTimeOperatorId) {
      setAddTimeError('Select an operator')
      return
    }
    setAddTimeSaving(true)
    setAddTimeError(null)
    try {
      const created = await recordOperationTime(supabase, {
        operationId: addTimeOperationId,
        productIds: [productId],
        operatorId: addTimeOperatorId,
        collectedBy: userId,
        totalMinutes: minutes,
      })
      if (addTimeNote.trim()) {
        await addOperationTimeNote(supabase, created.id, addTimeNote.trim(), userId)
      }
      // Refresh the total/coverage/breakdown fetches so the job moves from "Not yet timed" into
      // "Timed" and the headline numbers tick up — same shared fetchModelTotal/coverage.ts path
      // everything else on the page already reconciles against.
      setRefreshTick((t) => t + 1)
      closeAddTime()
    } catch (err) {
      setAddTimeError(err instanceof Error ? err.message : 'Could not save time')
    } finally {
      setAddTimeSaving(false)
    }
  }

  // ── Printable collection sheet ──────────────────────────────────────────────────────────
  /**
   * The to-collect list: every job with at least one untimed operation for this model, with only
   * its untimed operations beneath it. Both halves of the on-screen breakdown feed it — jobs with
   * nothing timed at all (untimedJobGroups, where every operation is missing) and partially timed
   * jobs (jobGroups, contributing just their `missing` rows) — so the sheet can't list an
   * operation the page considers timed, or omit one it shows as a gap. Fully-timed jobs are
   * dropped entirely: this is a work list, not a report. Jobs A–Z.
   */
  const printJobs = useMemo(() => {
    const groups: { jobId: string; jobName: string; operations: MissingOpRow[] }[] = []
    for (const g of untimedJobGroups) groups.push({ jobId: g.jobId, jobName: g.jobName, operations: g.operations })
    for (const g of jobGroups) {
      if (g.missing.length === 0) continue
      groups.push({ jobId: g.jobId, jobName: g.jobName, operations: g.missing })
    }
    return groups.sort((a, b) => a.jobName.localeCompare(b.jobName))
  }, [jobGroups, untimedJobGroups])

  const printOperationCount = printJobs.reduce((sum, g) => sum + g.operations.length, 0)

  // Stamped when Print is pressed rather than at render: this component server-renders too, and
  // a date evaluated during render would differ between server and client markup.
  const [printedAt, setPrintedAt] = useState<string | null>(null)
  function handlePrint() {
    setPrintedAt(new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }))
    // Two frames so the stamp is painted before the print dialog snapshots the page.
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()))
  }

  const loading = productsLoading || modelTotalLoading || requiredLoading
  const combinedError = modelTotalError || requiredError

  return (
    <main className="page">
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Model Total</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Total labour minutes for a model, by job and operation</p>
      </div>

      <div className="card" style={{ padding: '14px 20px', marginBottom: 20, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={SEL} value={lineId} onChange={(e) => { setLineId(e.target.value); setSeries(''); setProductId('') }}>
          <option value="">— Select a production line —</option>
          {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select style={SEL} value={series} onChange={(e) => { setSeries(e.target.value); setProductId('') }} disabled={!lineId}>
          <option value="">— Select a series —</option>
          {seriesGroups.map((g) => <option key={g.series} value={g.series}>{g.series}</option>)}
        </select>
        <select style={SEL} value={productId} onChange={(e) => setProductId(e.target.value)} disabled={!series}>
          <option value="">— Select a model —</option>
          {modelsInSeries.map((p) => <option key={p.id} value={p.id}>{p.model}</option>)}
        </select>
        {loading && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</span>}
        <button
          type="button"
          className="btn-ghost"
          style={{ marginLeft: 'auto' }}
          disabled={!productId || copyTargets.length === 0}
          title={
            !productId ? 'Select a model first'
              : copyTargets.length === 0 ? 'There are no other models on this line to copy to'
                : `Copy this model's jobs and recorded times onto other models on this line`
          }
          onClick={() => setCopyOpen(true)}
        >
          Copy to other models
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!productId}
          title={productId ? 'Print a paper sheet of everything still to collect for this model' : 'Select a model first'}
          onClick={handlePrint}
        >
          Print collection sheet
        </button>
      </div>

      {combinedError && (
        <p style={{ margin: '0 0 20px', padding: '9px 12px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 12 }}>
          {combinedError}
        </p>
      )}

      {!productId ? (
        <p style={EMPTY}>{loading ? 'Loading…' : 'Select a production line, series, and model to see its total'}</p>
      ) : (
        <>
          {/* ── Headline ─────────────────────────────────────────────── */}
          <div className="grid-2" style={{ marginBottom: 24 }}>
            <div className="stat-card">
              <div className="stat-card-label">Total for {selectedProduct?.model ?? '—'}</div>
              <div className="stat-card-value">{fmtMinutes(result.totalMinutes)}m</div>
              <div className="stat-card-sub">{fmtHours(result.totalMinutes)}h · average per operation, summed across every timed operation</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-label">Coverage</div>
              <div className="stat-card-value">{jobsTimed} / {jobsRequired}</div>
              <div className="stat-card-sub">jobs timed for this model — timed so far, not full labour content. Untimed operations contribute 0.</div>
            </div>
          </div>

          {/* ── Breakdown ────────────────────────────────────────────── */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Breakdown by Job</span>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 0' }}>Jobs A–Z</p>
              </div>
              {(jobGroups.length > 0 || untimedJobGroups.length > 0) && (
                <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => setExpandedJobs(new Set([...jobGroups, ...untimedJobGroups].map((g) => g.jobId)))}
                    style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mid)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    Expand all
                  </button>
                  <button
                    type="button"
                    onClick={() => setExpandedJobs(new Set())}
                    style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mid)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    Collapse all
                  </button>
                </div>
              )}
            </div>

            {jobGroups.length === 0 && untimedJobGroups.length === 0 ? (
              <p style={EMPTY}>{loading ? 'Loading…' : 'No jobs require this model yet'}</p>
            ) : (
              <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Column header — same GRID_COLS template as every job card and the grand
                    total below, so AVG MINS/RUNS line up card-to-card no matter which jobs are
                    expanded (a job card's own width never depends on its neighbours' content). */}
                <div style={{ display: 'grid', gridTemplateColumns: GRID_COLS, gap: GRID_GAP, padding: '0 14px' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>Operation</span>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', textAlign: 'right' }}>Avg mins</span>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', textAlign: 'right' }}>Runs</span>
                </div>

                {untimedJobGroups.length > 0 && (
                  <>
                    <div style={{ padding: '4px 14px 0', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
                      Not yet timed <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({untimedJobGroups.length})</span>
                    </div>
                    {untimedJobGroups.map((g) => {
                      const isOpen = expandedJobs.has(g.jobId)
                      const operatorLabel = operatorLabelFor(g.operatorIds)
                      return (
                        <div key={g.jobId} style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)', overflow: 'hidden' }}>
                          <div
                            role="button" tabIndex={0} aria-expanded={isOpen}
                            onClick={() => toggleJob(g.jobId)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleJob(g.jobId) } }}
                            style={{
                              display: 'grid', gridTemplateColumns: GRID_COLS, gap: GRID_GAP, alignItems: 'center',
                              padding: '12px 14px', background: '#fafafa', cursor: 'pointer',
                            }}
                          >
                            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                                <ChevronIcon open={isOpen} />
                                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{g.jobName}</span>
                              </span>
                              {operatorLabel && (
                                <span style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                                  {operatorLabel}
                                </span>
                              )}
                            </span>
                            <span style={{ fontWeight: 700, color: 'var(--red)', textAlign: 'right' }}>0m</span>
                            <span style={{ textAlign: 'right' }}>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); openAddTime(g.jobId, g.jobName) }}
                                style={{ fontSize: 11, fontWeight: 600, color: 'var(--blue)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}
                              >
                                Add Time
                              </button>
                            </span>
                          </div>

                          {isOpen && (
                            <div style={{ borderTop: '1px solid var(--border)' }}>
                              {g.operations.map((op) => (
                                <div
                                  key={op.operationId}
                                  style={{ display: 'grid', gridTemplateColumns: GRID_COLS, gap: GRID_GAP, padding: '10px 14px 10px 40px', fontSize: 13, color: 'var(--text-muted)', borderTop: '1px solid #f2f2f2' }}
                                >
                                  <span>
                                    {op.operationName} <span style={{ fontSize: 11 }}>· not timed</span>{' '}
                                    <button
                                      type="button"
                                      onClick={() => openAddTime(g.jobId, g.jobName, op.operationId)}
                                      style={{ fontSize: 11, fontWeight: 600, color: 'var(--blue)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}
                                    >
                                      Add Time
                                    </button>
                                  </span>
                                  <span style={{ textAlign: 'right' }}>—</span>
                                  <span style={{ textAlign: 'right' }}>0</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    <div style={{ padding: '4px 14px 0', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
                      Timed <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({jobGroups.length})</span>
                    </div>
                  </>
                )}

                {jobGroups.map((g) => {
                  const isOpen = expandedJobs.has(g.jobId)
                  const operatorLabel = operatorLabelFor(g.operatorIds)
                  return (
                    <div key={g.jobId} style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)', overflow: 'hidden' }}>
                      <div
                        role="button" tabIndex={0} aria-expanded={isOpen}
                        onClick={() => toggleJob(g.jobId)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleJob(g.jobId) } }}
                        style={{
                          display: 'grid', gridTemplateColumns: GRID_COLS, gap: GRID_GAP, alignItems: 'center',
                          padding: '12px 14px', background: '#fafafa', cursor: 'pointer',
                        }}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                            <ChevronIcon open={isOpen} />
                            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{g.jobName}</span>
                          </span>
                          {operatorLabel && (
                            <span style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                              {operatorLabel}
                            </span>
                          )}
                        </span>
                        <span style={{ fontWeight: 700, color: 'var(--blue)', textAlign: 'right' }}>{fmtMinutes(g.subtotal)}m</span>
                        <span />
                      </div>

                      {isOpen && (
                        <div style={{ borderTop: '1px solid var(--border)' }}>
                          {g.rows.map((r) => (
                            <div
                              key={r.operationId}
                              style={{ display: 'grid', gridTemplateColumns: GRID_COLS, gap: GRID_GAP, padding: '10px 14px 10px 40px', fontSize: 13, color: 'var(--text-mid)', borderTop: '1px solid #f2f2f2' }}
                            >
                              <span>{r.operationName}</span>
                              <span style={{ textAlign: 'right' }}>{fmtMinutes(r.avgMinutes)}</span>
                              <span style={{ textAlign: 'right' }}>{r.runs}</span>
                            </div>
                          ))}
                          {g.missing.map((m) => (
                            <div
                              key={m.operationId}
                              style={{ display: 'grid', gridTemplateColumns: GRID_COLS, gap: GRID_GAP, padding: '10px 14px 10px 40px', fontSize: 13, color: 'var(--text-muted)', borderTop: '1px solid #f2f2f2' }}
                            >
                              <span>
                                {m.operationName} <span style={{ fontSize: 11 }}>· not timed</span>{' '}
                                <button
                                  type="button"
                                  onClick={() => openAddTime(g.jobId, g.jobName, m.operationId)}
                                  style={{ fontSize: 11, fontWeight: 600, color: 'var(--blue)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}
                                >
                                  Add Time
                                </button>
                              </span>
                              <span style={{ textAlign: 'right' }}>—</span>
                              <span style={{ textAlign: 'right' }}>0</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Grand total — same GRID_COLS template again; must equal the headline. */}
                <div style={{ display: 'grid', gridTemplateColumns: GRID_COLS, gap: GRID_GAP, padding: '12px 14px', borderTop: '2px solid var(--border)' }}>
                  <span style={{ fontWeight: 700, color: 'var(--text)' }}>Grand total</span>
                  <span style={{ fontWeight: 700, color: 'var(--blue)', textAlign: 'right' }}>{fmtMinutes(result.totalMinutes)}m</span>
                  <span />
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Printable collection sheet ───────────────────────────────────────────────────
          Never visible on screen (.print-sheet is display:none until @media print) and a direct
          child of .page, which is what the print rule keys off to hide everything else. Black on
          white, no app chrome — a field document to hand-write on. */}
      {productId && (
        <div className="print-sheet">
          <div className="print-sheet-header">
            <h1 className="print-sheet-title">Collection Sheet</h1>
            <p className="print-sheet-meta">
              <strong>{selectedProduct?.model ?? '—'}</strong>
              {selectedProduct?.product_code ? ` · ${selectedProduct.product_code}` : ''}
            </p>
            <p className="print-sheet-meta">
              {lines.find((l) => l.id === lineId)?.name ?? 'No production line'}
              {' · '}
              {selectedProduct?.product_series?.trim() || series || 'No series'}
            </p>
            <p className="print-sheet-coverage">
              {jobsTimed} / {jobsRequired} jobs timed — {Math.max(jobsRequired - jobsTimed, 0)} to collect
              {printOperationCount > 0 && ` (${printOperationCount} operation${printOperationCount !== 1 ? 's' : ''})`}
            </p>
            <p className="print-sheet-signoff">
              Collected by:<span className="print-blank print-blank-operator" />
              Date:<span className="print-blank print-blank-minutes" />
            </p>
          </div>

          {printJobs.length === 0 ? (
            <p>Nothing to collect — every operation required for this model has a recorded time.</p>
          ) : (
            printJobs.map((g) => (
              <div key={g.jobId} className="print-job">
                <h2 className="print-job-name">
                  {g.jobName} ({g.operations.length} to collect)
                </h2>
                {g.operations.map((op) => (
                  <div key={op.operationId} className="print-op">
                    <div className="print-op-name">
                      <span className="print-checkbox" />
                      {op.operationName}
                    </div>
                    <div className="print-fields">
                      Operator:<span className="print-blank print-blank-operator" />
                      Minutes:<span className="print-blank print-blank-minutes" />
                      Notes:<span className="print-blank print-blank-notes" />
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}

          <div className="print-sheet-footer">
            {selectedProduct?.model ?? '—'} · collection sheet{printedAt ? ` · printed ${printedAt}` : ''}
          </div>
        </div>
      )}

      {/* ── Add Time slide-over — same .gaps-drawer markup/width as the other drawers ── */}
      {addTimeTarget && (
        <>
          <div className={'gaps-drawer-overlay' + (addTimeVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={closeAddTime} />
          <div className={'gaps-drawer' + (addTimeVisible ? ' gaps-drawer-visible' : '')} style={ADD_TIME_DRAWER_WIDTH}>
            <div className="gaps-drawer-header">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="gaps-drawer-title">Add Time — {addTimeTarget.jobName}</div>
                <div className="gaps-drawer-model">for {selectedProduct?.model ?? '—'}</div>
              </div>
              <button className="gaps-drawer-close" onClick={closeAddTime} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="gaps-drawer-body" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              {addTimeError && (
                <p style={{ margin: 0, padding: '9px 12px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 12 }}>
                  {addTimeError}
                </p>
              )}

              <div>
                <label className="label">Operation</label>
                <select
                  className="select" style={{ width: '100%' }}
                  value={addTimeOperationId}
                  disabled={addTimeSaving || addTimeJobOps.length === 0}
                  onChange={(e) => handleAddTimeOperationChange(e.target.value)}
                >
                  {addTimeJobOps.length === 0 && <option value="">No operations require this model under this job</option>}
                  {addTimeJobOps.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>

              <div>
                <label className="label">Operator</label>
                <select
                  className="select" style={{ width: '100%' }}
                  value={addTimeOperatorId}
                  disabled={addTimeSaving}
                  onChange={(e) => setAddTimeOperatorId(e.target.value)}
                >
                  <option value="">— Select an operator —</option>
                  {allActiveOperators.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
                </select>
              </div>

              <div>
                <label className="label">Minutes</label>
                <input
                  type="number" min={0} step="0.1" placeholder="min" autoFocus
                  className="input"
                  value={addTimeMinutes}
                  disabled={addTimeSaving}
                  onChange={(e) => setAddTimeMinutes(e.target.value)}
                />
              </div>

              <div>
                <label className="label">Note (optional)</label>
                <textarea
                  className="input" rows={3} style={{ resize: 'none' }}
                  value={addTimeNote}
                  disabled={addTimeSaving}
                  onChange={(e) => setAddTimeNote(e.target.value)}
                  placeholder="Anything worth flagging about this run…"
                />
              </div>

              <button
                type="button"
                className="btn-primary"
                disabled={addTimeSaving || !addTimeOperationId || !addTimeMinutes.trim()}
                onClick={handleAddTimeSave}
              >
                {addTimeSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Copy this model's work onto other models on the same line ──────────────── */}
      {copyOpen && selectedProduct && (
        <CopyToModelsPanel
          supabase={supabase}
          sourceProduct={selectedProduct}
          targetProducts={copyTargets}
          jobs={copyJobs}
          userId={userId}
          onClose={() => setCopyOpen(false)}
          // Re-runs this page's own fetches. The source model's figures are unchanged by a copy
          // (nothing is written against it), but the refresh keeps the page honest if anything
          // else moved while the panel was open.
          onCompleted={() => setRefreshTick((t) => t + 1)}
          // Jump the page to a target so the copy can be checked immediately. Series has to be
          // set too or the three selects clear each other as stale.
          onOpenModel={(product) => {
            setSeries(product.product_series?.trim() || 'Other')
            setProductId(product.id)
          }}
        />
      )}
    </main>
  )
}
