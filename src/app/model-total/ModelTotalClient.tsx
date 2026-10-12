'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { computeCoverageCombos, type CoverageOperationInput, type CoverageModelOperationInput } from '@/lib/coverage'
import { addOperationTimeNote, fetchModelTotal, historyLabel, jobCompleteness, parseCopiedFrom, recordOperationTime, type ModelTotalFetchResult, type ModelTotalOperationRow } from '@/lib/operationTimes'
import { fmtDate, fmtHours, fmtMinutes, plural } from '@/lib/format'
// The preview and the write now happen inside ModelUnlinkConfirm; this screen only names the
// result type it reports afterwards.
import type { ModelUnlinkResult } from '@/lib/modelLinks'
import ModelUnlinkConfirm from '@/components/ModelUnlinkConfirm'
import { fetchAllChunked, logSupabaseError, READ_CHUNK, type RangeableQuery } from '@/lib/supabaseRead'
import { selectIn } from '@/lib/chunkedIn'
import { buildReportHref, UNATTACHED_PRODUCT_ID } from '@/lib/reports'
import { buildSetupHref } from '@/lib/setupLinks'
import { UNSECTIONED_KEY } from '@/components/FinderPanes'
import { loadLineSplit, modelsForLine, type LineSplit } from '@/lib/lines'
import { usePersistedFilter } from '@/lib/useLocalStorage'
import { usePageSetup } from '@/lib/usePageSetup'
import ConfirmDialog from '@/components/ConfirmDialog'
import AreaChips from '@/components/AreaChips'
import OperationTimesDrawer from '@/components/OperationTimesDrawer'
import BreakdownTable, { NotYetTimedTable } from './BreakdownTable'
import { buildBreakdownTree, treeRollup, untimedCount, type HierarchySection, type JobNode, type MissingOpRow, type Rollup, type SectionNode } from './breakdownTree'
import CopyToModelsPanel, { type CopyJob } from './CopyToModelsPanel'
import type { Product, ProductionLine, UserRole } from '@/lib/types'

interface Props {
  lines: ProductionLine[]
  userId: string
  /** The viewer's profiles.role, read server-side. null = no profiles row; every permission
   * helper treats that as the least privileged answer. Passed straight through to the time
   * drawer, which is the only thing on this screen that gates on it. */
  role: UserRole | null
}

const SEL: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
  border: '1.5px solid var(--border)', borderRadius: 8, padding: '7px 10px',
  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', outline: 'none', minWidth: 220,
}
const EMPTY: React.CSSProperties = { textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '40px 0' }
const ADD_TIME_DRAWER_WIDTH: React.CSSProperties = { width: '50vw' }
/** How far the breakdown is opened. Sections are always listed; this is what shows under them. */
type Depth = 'sections' | 'jobs' | 'operations'
const DEPTHS: { key: Depth; label: string; hint: string }[] = [
  { key: 'sections', label: 'Sections', hint: 'Teams and sections only — every section closed' },
  { key: 'jobs', label: 'Jobs', hint: 'Every section open to its jobs' },
  { key: 'operations', label: 'Operations', hint: 'Every section and every job open, down to the operations' },
]
/** Stand-ins while the hierarchy read is in flight — module-level so the tree memo is stable. */
const NO_SECTION_IDS = new Map<string, string | null>()
const NO_SECTIONS = new Map<string, HierarchySection>()
/** .gaps-drawer (see globals.css) is hard-coded to 25vw for the /dashboard gap drawer —
 * reused here for the slide-in/overlay/shadow behaviour, matching the convention of
 * overriding just the width to half the page. */

/** OPERATION (flexible) | MINS (fixed) | HISTORY (fixed) — applied identically to the column
 * header, every job card's header line, every operation row, and the grand total, so the three
 * columns sit at the same x-position everywhere regardless of which job cards are expanded. */


/** An operation that requires the selected model, per model_operations — fetched product_id
 * first, with no production-line scope, so it lines up with what fetchModelTotal found. */
interface RequiredOpRow { id: string; name: string; job_id: string; primary_operator_id: string | null; secondary_operator_id: string | null }
/** A job in the required set, with just enough of its section to name it and link to it, plus
 * the production line it sits on — jobs.production_line_id is the source of truth for which
 * line a piece of labour belongs to, and it is what the labour-source filter splits on. */
interface RequiredJobRow { id: string; name: string; section_id: string | null; sectionName: string | null; productionLineId: string | null; isActive: boolean }
/** What the jobs query actually returns, before the embedded section is flattened. */
interface RawRequiredJobRow {
  id: string; name: string; section_id: string | null; production_line_id: string | null; is_active: boolean
  sections?: { name: string } | { name: string }[] | null
}


/**
 * ── What labour is being counted ────────────────────────────────────────────────────────
 *
 * The line/series/model selects at the top of this page choose WHICH MODEL is on screen and
 * nothing else — once a model is picked, its total is defined by operation_time_models.product_id
 * alone (see fetchModelTotal), which is why picking "Sew" still showed Caravan-line jobs. That is
 * correct for a total, and unreadable as a filter.
 *
 * This is the filter. It splits the jobs behind the number by the line each job sits on:
 *
 *   all  → every job that applies to the model, pre-assembly and line labour together
 *   line → only jobs on a line with is_pre_assembly = false
 *   pre  → only jobs on a pre-assembly line, optionally narrowed to ONE of them
 *
 * Every figure on the page follows it — headline total, coverage, breakdown, "Not yet timed",
 * grand total and the printed sheet — so the parts always sum to the whole that is on screen.
 */
type LabourSource = 'all' | 'line' | 'pre'

/**
 * The sheets this page can print. 'times', 'summary', 'section' and 'team' are the SAME
 * recorded-times document at four grains — Operation → Job → Section → Team, the Labour
 * Matrix's grain selector on paper; see handlePrint and TimesSheetHead — and 'blank' is a
 * different errand: an empty sheet that goes out to the line, not a record that comes back.
 */
type PrintMode = 'blank' | 'times' | 'summary' | 'section' | 'team'

/** This page's paper, kept identical to ./print.css. Module-level so usePageSetup's effect
 * runs once per mount. */
const MODEL_TOTAL_PAGE_CSS = '@page { size: A4 portrait; margin: 12mm; }'

const LABOUR_SOURCES: { key: LabourSource; label: string; hint: string }[] = [
  { key: 'all', label: 'All', hint: 'Every job that applies to this model — pre-assembly and line labour together' },
  { key: 'line', label: 'Line labour', hint: 'Only jobs on a build line — pre-assembly areas excluded' },
  { key: 'pre', label: 'Pre-assembly', hint: 'Only jobs on a pre-assembly area — Chassis, Lamination, Saws, Sew, Filling, Training' },
]

interface JobGroup {
  jobId: string
  jobName: string
  /** jobs.production_line_id — null when the job is on no line at all. Drives both the filter
   * and the per-line subtotal headers. */
  lineId: string | null
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
  lineId: string | null
  operatorIds: string[]
  operations: MissingOpRow[]
}

/** One row of the JOB DETAIL sheet (and the leaf the Section and Team sheets sum): a job that applies to this model, timed or not. */
interface SummaryJobRow {
  jobId: string
  jobName: string
  lineId: string | null
  /** The sum of the job's CURRENT operation times. 0 for a job with nothing timed. */
  minutes: number
  /** How many of the job's operations have a current record, out of how many it has at all —
   * the two numbers the completeness rule below is built from, and nothing else. */
  timedOps: number
  totalOps: number
}

/** The job-hierarchy the SECTION DETAIL and TEAM DETAIL sheets group by: each job's section,
 * each section's team and place in production order, and each team's name. Grouping data only —
 * no figure is read from here. `key` is the job set it was read for, so a stale read (the model
 * changed, a job was unlinked) is recognisable rather than silently grouped against. */

interface JobHierarchy {
  key: string
  sectionIdOfJob: Map<string, string | null>
  sectionsById: Map<string, HierarchySection>
  teamNameById: Map<string, string>
}

/** A job's figure as it prints, with the asterisk that says it is not the whole job. The
 * asterisk is keyed by INCOMPLETE_NOTE at the foot of whichever sheet used it. */
function jobFigure(minutes: number, timedOps: number, totalOps: number): string {
  return `${fmtMinutes(minutes)}m${jobCompleteness(timedOps, totalOps) === 'timed' ? '' : '*'}`
}

/**
 * The words beside the job's name saying the same thing the asterisk says, because an asterisk
 * alone sends the reader to the footnote to find out which of the two cases this is. Italic and
 * un-bolded against the job heading it sits in; nothing here relies on colour or grey, neither
 * of which survives a mono printer.
 */
function JobStatusNote({ timedOps, totalOps }: { timedOps: number; totalOps: number }) {
  const state = jobCompleteness(timedOps, totalOps)
  if (state === 'timed') return null
  return (
    <span className="mt-times-note">
      {state === 'none'
        ? ` · not yet timed (${plural(totalOps, 'operation')})`
        : ` · partly timed — ${timedOps} of ${totalOps} operations`}
    </span>
  )
}

/**
 * A row's completeness as a class, appended to EVERY cell of the row so the whole line changes
 * together rather than just the figure. One function, so every recorded-times sheet
 * cannot end up marking the same job two different ways.
 *
 * What each class does is in globals.css's print block, and it is not only colour: see the note
 * there about mono printers, where #dc2626 lands as a mid-grey that is LESS legible than the
 * black around it.
 */
function rowClass(timedOps: number, totalOps: number): string {
  const state = jobCompleteness(timedOps, totalOps)
  if (state === 'none') return ' mt-times-untimed'
  if (state === 'partial') return ' mt-times-partial'
  return ''
}

/** The key to the asterisk, on every sheet that can print one. */
const INCOMPLETE_NOTE =
  '* not this job’s full labour content — some or all of its operations are not yet timed, and an untimed operation contributes 0.'

/**
 * The header EVERY recorded-times sheet carries — Operations, Job, Section and Team Detail.
 *
 * One component, not one per sheet. The two sheets differ in what they list underneath and in
 * nothing else, and a second header is precisely how two printouts of the same selection start
 * disagreeing about which selection it was.
 *
 * Everything a reader needs to know what the figures are a total OF is on it, because a sheet
 * on a desk has no filter bar above it: the model, the production line and series it was chosen
 * through, THE SHOW FILTER IN WORDS, the total labour, coverage, and the date it was printed. A
 * Pre-assembly sheet that omits its filter reads as the model's whole labour content, which is
 * the one way a printout can be actively wrong rather than merely thin.
 *
 * `variantLabel` is the only line that differs between the two, and it is there so a sheet in a
 * pile says which of the two it is.
 */
function TimesSheetHead({
  variantLabel, model, productCode, lineName, seriesName, filterPhrase,
  totalMinutes, jobsTimed, jobsRequired, printedAt,
}: {
  variantLabel: string
  model: string
  productCode: string | null
  lineName: string
  seriesName: string
  filterPhrase: string
  totalMinutes: number
  jobsTimed: number
  jobsRequired: number
  printedAt: string | null
}) {
  return (
    <div className="rp-head">
      <h1 className="rp-title">{model}</h1>
      <p className="rp-meta">
        Recorded times · {variantLabel} · <strong>{filterPhrase}</strong>
        {productCode ? ` · ${productCode}` : ''}
      </p>
      <p className="rp-meta">{lineName} · {seriesName}</p>
      <p className="rp-meta">
        <strong>{fmtMinutes(totalMinutes)}m</strong> ({fmtHours(totalMinutes)}h)
        {' · '}coverage <strong>{jobsTimed} / {jobsRequired}</strong> jobs timed
        {' · '}the sum of each operation’s current recorded time
      </p>
      {printedAt && <p className="rp-meta">Printed {printedAt}</p>}
    </div>
  )
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

/** A level's roll-up in words, for the printed sheets — the same three counts the screen's
 * columns carry, with the untimed count stated rather than left to subtraction. */
function rollupPhrase(r: Rollup): string {
  return `${r.jobsCovered} of ${plural(r.jobCount, 'job')} timed · ${r.timedOps} of ${plural(r.totalOps, 'operation')} timed · ${untimedCount(r)} untimed`
}

/** A section's name on paper, with the tray said in words where the screen uses a badge. */
function sectionLabel(section: SectionNode): string {
  return section.tray ? `${section.name} (unsorted tray)` : section.name
}

/** A production-line or team heading on a recorded-times sheet: the name, its roll-up and its
 * minutes. Marked by the shared rowClass, so a team with nothing timed prints as an untimed job
 * does. */
function SheetGroupHead({ level, name, r }: { level: 'line' | 'team'; name: string; r: Rollup }) {
  return (
    <p className={`mt-times-grouphead mt-times-${level}${rowClass(r.timedOps, r.totalOps)}`}>
      <span>{name}</span>
      <span>{rollupPhrase(r)} · {jobFigure(r.minutes, r.timedOps, r.totalOps)}</span>
    </p>
  )
}

export default function ModelTotalClient({ lines, userId, role }: Props) {
  const supabase = useMemo(() => createClient(), [])

  const [lineId, setLineId] = usePersistedFilter('modelTotal.lineId', '')
  const [series, setSeries] = usePersistedFilter('modelTotal.series', '')
  const [productId, setProductId] = usePersistedFilter('modelTotal.productId', '')

  // Bumped after a successful Add Time save to force the two productId-keyed fetches below to
  // re-run without productId itself changing — the total, coverage, and breakdown all read off
  // fetchModelTotal/the required-set fetch, so re-running those is the one place a refresh needs
  // to happen for everything (headline, "X / Y jobs timed", job cards) to reconcile.
  const [refreshTick, setRefreshTick] = useState(0)

  /**
   * ── The labour-source filter ────────────────────────────────────────────────────────────
   * Session-scoped component state on purpose — NOT usePersistedFilter like the three selects
   * above. Those answer "what was I looking at", which is worth surviving a reload; this answers
   * "what am I checking right now", and a remembered Pre-assembly would silently hide most of a
   * model's labour from whoever opened the page next, with a total to match.
   */
  const [labourSource, setLabourSource] = useState<LabourSource>('all')
  /** '' = every pre-assembly area. Only meaningful while labourSource === 'pre'. */
  const [areaLineId, setAreaLineId] = useState('')

  // The is_pre_assembly rule, from lib/lines' cached topology — one load per session, shared with
  // modelsForLine above. Held as the synchronous view (LineSplit) because the filter has to ask
  // the question of every job inside a useMemo, not once per await.
  const [lineSplit, setLineSplit] = useState<LineSplit | null>(null)
  useEffect(() => {
    let cancelled = false
    loadLineSplit(supabase)
      .then((split) => { if (!cancelled) setLineSplit(split) })
      // Losing this leaves every job reading as line labour (see LineSplit's null rule) — the
      // filter degrades to "All", which is the pre-existing behaviour, not a blank page.
      .catch((err) => console.error('[model-total] could not load line topology:', err))
    return () => { cancelled = true }
  }, [supabase])

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
  const [requiredJobs, setRequiredJobs] = useState<RequiredJobRow[]>([])
  const [requiredLoading, setRequiredLoading] = useState(false)
  const [requiredError, setRequiredError] = useState<string | null>(null)

  // Products for the chosen line — drives both the series/model selects below.
  useEffect(() => {
    let cancelled = false
    if (!lineId) { setProducts([]); return }
    setProductsLoading(true)
    // lib/lines: on a pre-assembly line the models come from the lines it feeds. This one list
    // drives the series/model selects here AND the target list in CopyToModelsPanel, so both
    // inherit the fix from one call.
    modelsForLine(supabase, lineId)
      .then((rows) => { if (!cancelled) { setProducts(rows); setProductsLoading(false) } })
      .catch(() => { if (!cancelled) { setProducts([]); setProductsLoading(false) } })
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
      if (moError) { logSupabaseError('required set — model_operations WHERE product_id', moError); setRequiredError(moError.message); setRequiredLoading(false); return }
      setRequiredModelOps(moRows ?? [])

      // Chunked (lib/chunkedIn): this is the required-set twin of fetchModelTotal's hop 3 and
      // grows with the same id list — a Motor Home model resolves ~700 operations, whose ids
      // alone overflow the ~16KB URL cap. is_active stays inside the callback so every chunk
      // carries it. Order isn't asked for and isn't relied on: the rows are keyed by id and
      // grouped by job_id downstream.
      const opIds = [...new Set((moRows ?? []).map((r) => r.operation_id))]
      let opRows: RequiredOpRow[]
      try {
        opRows = await selectIn<RequiredOpRow>(opIds, async (chunk) => {
          const res = await supabase.from('operations')
            .select('id, name, job_id, primary_operator_id, secondary_operator_id')
            .in('id', chunk).eq('is_active', true)
          if (res.error) logSupabaseError('required set — operations WHERE id IN (…) AND is_active', res.error)
          return res
        })
      } catch (err) {
        if (cancelled) return
        setRequiredError(err instanceof Error ? err.message : 'Could not load operations'); setRequiredLoading(false); return
      }
      if (cancelled) return
      setRequiredOps(opRows)

      // Identity lookup by id — NOT filtered to is_active, so a retired job still labels the
      // operations that point at it. See the note at the top of lib/jobs.
      const jobIds = [...new Set(opRows.map((o) => o.job_id))]
      // section_id and the section's NAME ride along on this existing read — no extra query —
      // for the "add more in Setup" signpost under the Add Time operation list. /setup's Jobs
      // pane is scoped by section, so a link without the id would land on a remembered section
      // that doesn't contain the job; the name is what makes the sentence readable.
      let jobRows: RequiredJobRow[]
      try {
        jobRows = await selectIn<RawRequiredJobRow>(jobIds, async (chunk) => {
          // is_active is selected, not filtered: the row still names the job, and jobPassesFilter
          // is what hides a retired one — see jobActiveById.
          const res = await supabase.from('jobs').select('id, name, section_id, production_line_id, is_active, sections ( name )').in('id', chunk)
          if (res.error) logSupabaseError('required set — jobs WHERE id IN (…)', res.error)
          return res
        }).then((rows) => rows.map((r) => ({
          id: r.id,
          name: r.name,
          section_id: r.section_id,
          productionLineId: r.production_line_id,
          isActive: r.is_active,
          // The embedded row arrives as an object or a one-element array depending on how
          // PostgREST resolves the relationship; both mean the same one section.
          sectionName: (Array.isArray(r.sections) ? r.sections[0]?.name : r.sections?.name) ?? null,
        })))
      } catch (err) {
        if (cancelled) return
        setRequiredError(err instanceof Error ? err.message : 'Could not load jobs'); setRequiredLoading(false); return
      }
      if (cancelled) return
      setRequiredJobs(jobRows)

      setRequiredLoading(false)
    }

    run()
    return () => { cancelled = true }
  }, [supabase, productId, refreshTick])

  // ── Which figures were COPIED rather than measured ────────────────────────────────────
  //
  // /model-total's copy-to-other-models writes each copy as an ordinary operation_time with
  // is_imported = true and a note naming the model it came from (lib/operationTimes'
  // copiedNoteFor). There is no "copied" column and this does not add one — it reads back
  // exactly what the copy already wrote, which is the only way the two can't drift.
  //
  // Scoped to each operation's CURRENT record, because that is the record whose minutes the
  // breakdown row shows. An operation measured on this model but with an older copied run
  // behind it is deliberately NOT marked: the number on screen wasn't copied.
  const [copiedSourceByOperation, setCopiedSourceByOperation] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    const rows = modelTotal?.operations ?? []
    const timeIds = [...new Set(rows.map((r) => r.currentTimeId).filter(Boolean))]
    if (timeIds.length === 0) { setCopiedSourceByOperation({}); return }

    async function run() {
      try {
        const [importedRows, noteRows] = await Promise.all([
          // Primary-key lookup — selectIn (chunk only) is complete here.
          selectIn<{ id: string; is_imported: boolean }>(timeIds, (chunk) =>
            supabase.from('operation_times').select('id, is_imported').in('id', chunk)),
          // Fans out (many notes per record), so this one is chunked AND paged.
          fetchAllChunked<{ operation_time_id: string; content: string }>(
            timeIds, READ_CHUNK,
            (chunk) => supabase
              .from('operation_time_notes').select('operation_time_id, content')
              .in('operation_time_id', chunk)
              .order('operation_time_id').order('id') as unknown as RangeableQuery<{ operation_time_id: string; content: string }>,
            { table: 'operation_time_notes' }
          ),
        ])
        if (cancelled) return

        const importedIds = new Set(importedRows.filter((t) => t.is_imported).map((t) => t.id))
        const sourceByTimeId = new Map<string, string>()
        for (const n of noteRows) {
          if (sourceByTimeId.has(n.operation_time_id)) continue
          const source = parseCopiedFrom(n.content)
          // BOTH signals required. A note alone could be typed by hand on a measured record;
          // is_imported alone covers the whole legacy import batch, which is not a copy of
          // anything. Together they mean what the copy path writes and nothing else does.
          if (source && importedIds.has(n.operation_time_id)) sourceByTimeId.set(n.operation_time_id, source)
        }

        const next: Record<string, string> = {}
        for (const r of rows) {
          const source = sourceByTimeId.get(r.currentTimeId)
          if (source) next[r.operationId] = source
        }
        setCopiedSourceByOperation(next)
      } catch (err) {
        // Presentational only — losing this loses a marker, never a figure, so it is logged
        // and dropped rather than surfaced as a page error.
        if (cancelled) return
        console.error('[model-total] could not resolve copied-record markers:', err)
        setCopiedSourceByOperation({})
      }
    }
    run()
    return () => { cancelled = true }
  }, [supabase, modelTotal])

  /**
   * job id → the production line it sits on, for every job this model has anything to do with.
   *
   * Both halves are needed and neither is a superset of the other: requiredJobs covers what
   * model_operations says APPLIES to the model, and fetchModelTotal's jobs cover what has been
   * TIMED against it. A job whose applies-list row was removed while its recorded times stayed
   * exists only in the second; a job that applies but has never been timed only in the first.
   * A job missing from this map would be attributed to no line and would drop out of both halves
   * of the split, so the map is built from the union rather than from whichever list is handy.
   */
  const jobLineById = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const j of modelTotal?.raw.jobs ?? []) map.set(j.id, j.production_line_id)
    for (const j of requiredJobs) map.set(j.id, j.productionLineId)
    return map
  }, [modelTotal, requiredJobs])

  /**
   * job id → jobs.is_active, from the same two reads as jobLineById.
   *
   * A job can be retired (is_active = false) while its operations are still active and still
   * linked to models — so filtering OPERATIONS on is_active, which both reads already do, is not
   * enough to keep it off this page. /setup and /collect hide such a job; this page, and every
   * sheet it prints, now does the same through jobPassesFilter below. Its recorded minutes leave
   * the total with it, so the screen, the total and every printout still reconcile.
   */
  const jobActiveById = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const j of modelTotal?.raw.jobs ?? []) map.set(j.id, j.is_active)
    for (const j of requiredJobs) map.set(j.id, j.isActive)
    return map
  }, [modelTotal, requiredJobs])

  /** The pre-assembly areas this model actually has work on — the chip row. Derived from the
   * jobs in play, not from the full list of pre-assembly lines, so a chip is never offered that
   * would filter the breakdown down to nothing. */
  const preAssemblyAreas = useMemo(() => {
    if (!lineSplit) return []
    const ids = new Set<string>()
    for (const [jobId, lineId] of jobLineById) {
      // A retired job is never on the page, so it can't be the reason a chip exists.
      if (jobActiveById.get(jobId) === false) continue
      if (lineId && lineSplit.isPreAssembly(lineId)) ids.add(lineId)
    }
    return [...ids]
      .map((id) => ({ id, name: lineSplit.name(id) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [jobLineById, jobActiveById, lineSplit])

  // A chip that no longer exists (different model, or its last job unlinked) would otherwise
  // keep filtering by an id nothing matches — an empty breakdown with no visible cause.
  useEffect(() => {
    if (areaLineId && !preAssemblyAreas.some((a) => a.id === areaLineId)) setAreaLineId('')
  }, [preAssemblyAreas, areaLineId])

  /**
   * THE filter predicate — every filtered figure on this page goes through this one function.
   *
   * An unknown line (a job whose production_line_id is null, or points at a line the topology
   * doesn't have) counts as line labour, following LineSplit's own rule: the split is meant to
   * partition the jobs, so the uncertain case has to land on one side rather than disappearing
   * from both.
   */
  const jobPassesFilter = useCallback((jobId: string): boolean => {
    // A retired job is out under EVERY filter, before the labour-source split is asked. An id
    // not in the map (its job row hasn't loaded) passes — absent is not the same as retired.
    if (jobActiveById.get(jobId) === false) return false
    if (labourSource === 'all') return true
    const lineId = jobLineById.get(jobId) ?? null
    const isPre = lineSplit?.isPreAssembly(lineId) ?? false
    if (labourSource === 'line') return !isPre
    if (!isPre) return false
    return !areaLineId || lineId === areaLineId
  }, [labourSource, areaLineId, jobLineById, jobActiveById, lineSplit])

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

    // The labour-source filter is applied HERE, to coverage's inputs, rather than to its output
    // or in a second count of our own: coverage.ts still decides what "required" and "covered"
    // mean, it is just handed the operations of the jobs currently in scope. That is what keeps
    // the x/y on the card equal to the number of job cards below it under every selection.
    const scopedOperations = [...opMap.values()].filter((o) => jobPassesFilter(o.job_id))

    return computeCoverageCombos({
      operations: scopedOperations as CoverageOperationInput[],
      modelOperations: requiredModelOps,
      operationTimes: modelTotal?.raw.operationTimes ?? [],
      operationTimeModels: modelTotal?.raw.operationTimeModels ?? [],
    }).filter((c) => c.productId === productId)
  }, [productId, requiredOps, requiredModelOps, modelTotal, jobPassesFilter])

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
      // The filter is applied at the group level, never per operation: a job is in scope or it
      // isn't, and half a job's operations would give a subtotal that matches nothing.
      if (!jobPassesFilter(row.jobId)) continue
      const g = byJob.get(row.jobId) ?? { jobId: row.jobId, jobName: row.jobName, lineId: jobLineById.get(row.jobId) ?? null, rows: [], subtotal: 0, missing: [] }
      g.rows.push(row)
      // A job's total is a plain SUM of its operations' CURRENT times — unchanged as a rule,
      // only the per-operation figure underneath it changed.
      g.subtotal += row.minutes
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
  }, [productId, requiredOps, requiredModelOps, result, jobPassesFilter, jobLineById])

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
      const g = byJob.get(op.job_id) ?? { jobId: op.job_id, jobName: jobNameById.get(op.job_id) ?? '—', lineId: jobLineById.get(op.job_id) ?? null, operations: [] }
      g.operations.push({ operationId: op.id, operationName: op.name, primaryOperatorId: op.primary_operator_id, secondaryOperatorId: op.secondary_operator_id })
      byJob.set(op.job_id, g)
    }
    return [...byJob.values()]
      .map((g) => ({ ...g, operatorIds: collectOperatorIds(g.operations) }))
      .sort((a, b) => a.jobName.localeCompare(b.jobName))
    // No jobPassesFilter here: untimedJobIds comes from modelCombos, which is already scoped, so
    // this section can't disagree with the coverage figure it is the remainder of.
  }, [productId, modelCombos, requiredOps, requiredJobs, jobLineById])

  /**
   * The total for what is ON SCREEN — the sum of the visible job subtotals, deliberately NOT
   * `result.totalMinutes`.
   *
   * Under "All" the two are the same number by construction (every timed row lands in exactly one
   * job group), so nothing is lost; under a filter, `result.totalMinutes` is still the model's
   * whole labour content and would contradict every figure beneath it. Summing the groups means
   * the headline, the grand total row and the job cards cannot disagree — there is one addition,
   * not three.
   */
  const visibleTotalMinutes = useMemo(() => jobGroups.reduce((sum, g) => sum + g.subtotal, 0), [jobGroups])


  /**
   * ── The JOB DETAIL sheet's job list ────────────────────────────────────────────────────
   *
   * EVERY job that applies to this model under the current filter, one row each — BOTH halves
   * of the on-screen breakdown, not just the timed one.
   *
   * It listed only timed jobs until now, and that was the one way a printout can be actively
   * misleading rather than merely thin: a job list that looks complete, under a total that looks
   * like full labour content, with nothing on the sheet to say six jobs were left off it.
   *
   * This is the UNION of jobGroups and untimedJobGroups and nothing else — the same two arrays
   * the screen renders, in the same order, already scoped by the Show filter (jobGroups via
   * jobPassesFilter; untimedJobGroups via modelCombos, which is coverage.ts fed the filtered
   * operations). There is no third derivation of "which jobs apply", so the printed set cannot
   * drift from the on-screen set — if a job is on the screen it is on the sheet, and nothing
   * else can be.
   *
   * The minutes are `g.subtotal` untouched, and 0 for a job with nothing timed, so the grand
   * total is exactly the number it was before these rows appeared. Only the row list changed.
   */
  const summaryJobs: SummaryJobRow[] = useMemo(() => [
    ...jobGroups.map((g) => ({
      jobId: g.jobId, jobName: g.jobName, lineId: g.lineId, minutes: g.subtotal,
      timedOps: g.rows.length, totalOps: g.rows.length + g.missing.length,
    })),
    ...untimedJobGroups.map((g) => ({
      jobId: g.jobId, jobName: g.jobName, lineId: g.lineId, minutes: 0,
      timedOps: 0, totalOps: g.operations.length,
    })),
  ], [jobGroups, untimedJobGroups])


  /** Whether anything on the sheet is an incomplete figure — decides if the asterisk key is
   * printed at all, and whether the grand total carries one. Read off the same per-job counts
   * the rows are marked from. */
  const anyIncomplete = useMemo(
    () => summaryJobs.some((j) => jobCompleteness(j.timedOps, j.totalOps) !== 'timed'),
    [summaryJobs],
  )

  /**
   * ── The hierarchy above a job, for the Section and Team sheets ────────────────────────
   *
   * Read for every job this model has anything to do with (jobLineById's keys — the union of
   * required and timed jobs), so the Show filter re-groups what is already in memory and issues
   * nothing. Three identity reads: each job's section_id, those sections, those sections' teams.
   *
   * A job's team is its SECTION's team (lib/sections' teamForJob). jobs.team_id is legacy and is
   * not selected — reading it would give this sheet a second answer to "whose job is this".
   *
   * Grouping only. No minutes are read here; every figure on the two sheets is a sum of
   * summaryJobs rows, which are the on-screen job subtotals.
   */
  const hierarchyJobKey = useMemo(() => [...jobLineById.keys()].sort().join(','), [jobLineById])
  const [hierarchy, setHierarchy] = useState<JobHierarchy | null>(null)
  const [hierarchyError, setHierarchyError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setHierarchyError(null)
    if (!hierarchyJobKey) { setHierarchy({ key: '', sectionIdOfJob: new Map(), sectionsById: new Map(), teamNameById: new Map() }); return }
    const jobIds = hierarchyJobKey.split(',')

    async function run() {
      try {
        const jobs = await selectIn<{ id: string; section_id: string | null }>(jobIds, async (chunk) => {
          const res = await supabase.from('jobs').select('id, section_id').in('id', chunk)
          if (res.error) logSupabaseError('model-total hierarchy — jobs WHERE id IN (…)', res.error)
          return res
        })
        if (cancelled) return
        // Not filtered to is_active: a merged-away section still labels the jobs pointing at it.
        const sectionIds = [...new Set(jobs.map((j) => j.section_id).filter((id): id is string => !!id))]
        const sections = await selectIn<HierarchySection>(sectionIds, async (chunk) => {
          const res = await supabase.from('sections').select('id, name, team_id, sort_order').in('id', chunk)
          if (res.error) logSupabaseError('model-total hierarchy — sections WHERE id IN (…)', res.error)
          return res
        })
        if (cancelled) return
        const teamIds = [...new Set(sections.map((sec) => sec.team_id).filter((id): id is string => !!id))]
        const teams = await selectIn<{ id: string; name: string }>(teamIds, async (chunk) => {
          const res = await supabase.from('teams').select('id, name').in('id', chunk)
          if (res.error) logSupabaseError('model-total hierarchy — teams WHERE id IN (…)', res.error)
          return res
        })
        if (cancelled) return
        setHierarchy({
          key: hierarchyJobKey,
          sectionIdOfJob: new Map(jobs.map((j) => [j.id, j.section_id])),
          sectionsById: new Map(sections.map((sec) => [sec.id, sec])),
          teamNameById: new Map(teams.map((t) => [t.id, t.name])),
        })
      } catch (err) {
        if (cancelled) return
        setHierarchyError(err instanceof Error ? err.message : 'Could not load sections and teams')
      }
    }
    run()
    return () => { cancelled = true }
  }, [supabase, hierarchyJobKey])

  /** Only a hierarchy read for THIS job set groups anything — a stale one would put a newly
   * linked job in "No section" on paper. The two buttons wait for it. */
  const hierarchyReady = hierarchy !== null && hierarchy.key === hierarchyJobKey

  /** null only for "no team"; a team id the read didn't resolve is still a team, just unnamed. */
  const teamNameOf = useCallback(
    (teamId: string | null) => (teamId ? hierarchy?.teamNameById.get(teamId) ?? 'Unknown team' : null),
    [hierarchy],
  )

  /**
   * ── The roll-up ───────────────────────────────────────────────────────────────────────
   *
   * THE rule the recorded-times sheets turn on: the operation figures are computed ONCE —
   * fetchModelTotal's current record per operation (superseded_by null, not hidden) — and every
   * coarser grain is a sum of the grain below it, done in one place (./breakdownTree):
   *
   *   operation  result.operations                    (Operations Detail)
   *   job        jobGroups' subtotal = Σ operations   (Job Detail)
   *   section    the tree's section node = Σ its jobs (Section Detail)
   *   team       the tree's team node = Σ its sections (Team Detail)
   *
   * No grain re-reads a time or re-derives a figure; the hierarchy read above only says which
   * bucket a job lands in, and every job lands in exactly one (the no-section / no-team buckets
   * catch the rest). So each sheet's rows sum to visibleTotalMinutes, the on-screen total, and
   * the sheets cannot disagree with each other or with the screen.
   */

  /**
   * ── The breakdown tree: Line → Team → Section → Job ───────────────────────────────────
   *
   * What the screen, the "Not yet timed" list and the blank / Operations / Job sheets all
   * render. The leaves are jobGroups and untimedJobGroups — the same two arrays as summaryJobs,
   * already scoped by the Show filter — and ./breakdownTree only groups and sums them, so no
   * figure here is a second derivation of anything.
   *
   * A hierarchy read for an older job set is still used while the new one is in flight (an
   * unlink only ever shrinks the set, so the old read covers it); the print buttons wait for
   * the current one.
   */
  const jobNodes: JobNode[] = useMemo(() => [
    ...jobGroups.map((g) => ({
      jobId: g.jobId, jobName: g.jobName, lineId: g.lineId, rows: g.rows, missing: g.missing,
      minutes: g.subtotal, timedOps: g.rows.length, totalOps: g.rows.length + g.missing.length, operatorIds: g.operatorIds,
    })),
    ...untimedJobGroups.map((g) => ({
      jobId: g.jobId, jobName: g.jobName, lineId: g.lineId, rows: [], missing: g.operations,
      minutes: 0, timedOps: 0, totalOps: g.operations.length, operatorIds: g.operatorIds,
    })),
  ], [jobGroups, untimedJobGroups])

  const tree = useMemo(() => buildBreakdownTree({
    jobs: jobNodes, split: lineSplit, teamName: teamNameOf,
    sectionIdOfJob: hierarchy?.sectionIdOfJob ?? NO_SECTION_IDS, sectionsById: hierarchy?.sectionsById ?? NO_SECTIONS,
  }), [jobNodes, hierarchy, teamNameOf, lineSplit])

  /** The same tree, narrowed to the jobs that still have an untimed operation. */
  const gapTree = useMemo(() => buildBreakdownTree({
    jobs: jobNodes.filter((j) => j.missing.length > 0), split: lineSplit, teamName: teamNameOf,
    sectionIdOfJob: hierarchy?.sectionIdOfJob ?? NO_SECTION_IDS, sectionsById: hierarchy?.sectionsById ?? NO_SECTIONS,
  }), [jobNodes, hierarchy, teamNameOf, lineSplit])

  const totals = useMemo(() => treeRollup(tree), [tree])
  const sectionKeys = useMemo(
    () => tree.flatMap((l) => l.teams.flatMap((t) => t.sections.map((s) => `${l.key}|${s.key}`))),
    [tree],
  )
  /** Sections where nothing at all is timed — the most actionable thing on the page. */
  const untouchedSections = useMemo(
    () => tree.reduce((n, l) => n + l.teams.reduce((m, t) => m + t.sections.filter((s) => s.timedOps === 0).length, 0), 0),
    [tree],
  )

  /** The current selection as a short noun, for the stat-card labels and the grand-total row.
   * null under "All", where the unqualified figure IS the model's total and saying so twice
   * would only invite the reader to look for a filter that isn't on. */
  const scopeLabel = useMemo(() => {
    if (labourSource === 'all') return null
    if (labourSource === 'line') return 'Line labour'
    if (areaLineId) return lineSplit?.name(areaLineId) ?? 'Pre-assembly'
    return 'Pre-assembly'
  }, [labourSource, areaLineId, lineSplit])

  /** …and the same thing as a clause, so the stat-card subtitles stay true sentences about what
   * was actually summed rather than a fixed line that quietly stops describing the number. */
  const scopeClause = scopeLabel ? ` on ${scopeLabel.toLowerCase()} jobs` : ''

  // Active operators — fetched once, globally (same shape/query as /collect's and /tryouts'
  // allActiveOperators), not scoped to any one job/team. Feeds both the Add Time pane's Operator
  // select and, via operatorNameById below, the job-card labels.
  const [allActiveOperators, setAllActiveOperators] = useState<{ id: string; full_name: string }[]>([])
  useEffect(() => {
    // No is_active filter: `operators` has no such column — this query is where /model-total's
    // "Bad Request" came from. The soft-delete flag exists on sections, jobs and operations only.
    // The error is logged rather than swallowed; an empty Operator select with nothing in the
    // console is exactly how this survived a release.
    supabase.from('operators').select('id, full_name').order('full_name')
      .then(({ data, error }) => {
        if (error) { logSupabaseError('operators (Add Time picker)', error); return }
        setAllActiveOperators(data ?? [])
      })
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

    // Chunked (lib/chunkedIn): `needed` is every operator id across every job card on the
    // screen, which on a large model is well past what one URL can carry.
    selectIn<{ id: string; full_name: string }>([...needed], (chunk) =>
      supabase.from('operators').select('id, full_name').in('id', chunk))
      .then((rows) => {
        // Un-mark anything this batch didn't actually resolve (an id the query returned no row
        // for) so a later run retries it rather than leaving the id marked as "fetched" against
        // a name that never arrived.
        const returned = new Set(rows.map((o) => o.id))
        for (const id of needed) if (!returned.has(id)) fetchedOperatorIds.current.delete(id)
        setOperatorNames((prev) => {
          const next = { ...prev }
          for (const o of rows) next[o.id] = o.full_name
          return next
        })
      })
      // A failed read resolves nothing, so every id in the batch is un-marked and retried by a
      // later run — the same rule as the partial case above, which is what the old
      // `data ?? []`-then-`if (error) return` pair did.
      .catch(() => { for (const id of needed) fetchedOperatorIds.current.delete(id) })
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
  /** Sections are OPEN unless listed here: the screen exists to show the gaps, and a closed
   * section hides them. Keyed `line|section`, as BreakdownTable keys them. */
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  useEffect(() => { setExpandedJobs(new Set()); setCollapsedSections(new Set()) }, [productId])
  function toggleJob(jobId: string) {
    setExpandedJobs((prev) => { const next = new Set(prev); if (next.has(jobId)) next.delete(jobId); else next.add(jobId); return next })
  }
  function toggleSection(key: string) {
    setCollapsedSections((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }
  /** Opens the whole breakdown to one level. 'jobs' is how the page loads. */
  function openTo(level: Depth) {
    setCollapsedSections(level === 'sections' ? new Set(sectionKeys) : new Set())
    setExpandedJobs(level === 'operations' ? new Set(jobNodes.map((j) => j.jobId)) : new Set())
  }
  /** Which segment is lit: only when the breakdown is exactly at that level. */
  const depth: Depth | null =
    collapsedSections.size === 0 && expandedJobs.size === 0 ? 'jobs'
      : collapsedSections.size === 0 && jobNodes.length > 0 && jobNodes.every((j) => expandedJobs.has(j.jobId)) ? 'operations'
        : sectionKeys.length > 0 && sectionKeys.every((k) => collapsedSections.has(k)) ? 'sections'
          : null

  /**
   * ── Edit-times drill-in ────────────────────────────────────────────────────────────────
   * One timed operation row → the shared OperationTimesDrawer, parameterised by nothing but
   * (operationId, productId). Everything it shows and every write it makes is its own; this
   * screen holds the target and the refresh, and that is the whole integration.
   */
  const [editTimesTarget, setEditTimesTarget] = useState<{ operationId: string; operationName: string } | null>(null)

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

  /** The job's section, for the signpost under the operation list — name for the sentence, id
   * for the link. Both come off requiredJobs, which is already loaded. */
  const addTimeSection = useMemo(() => {
    const job = requiredJobs.find((j) => j.id === addTimeTarget?.jobId)
    return job?.section_id ? { id: job.section_id, name: job.sectionName } : null
  }, [requiredJobs, addTimeTarget])

  const addTimeLineName = useMemo(
    () => lines.find((l) => l.id === lineId)?.name ?? null,
    [lines, lineId]
  )

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
      const { created } = await recordOperationTime(supabase, {
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

  /**
   * ── "Doesn't apply to this model" ─────────────────────────────────────────────────────
   *
   * An UNLINK, at either level, and never a delete. It says this model doesn't do this work; it
   * does not say the work stopped existing. The job, its operations, every recorded time and
   * every note survive untouched — see lib/modelLinks, which owns both removals and is the one
   * path the job-level and operation-level actions share. This screen holds the target, the
   * confirmation and the refresh, and writes nothing itself.
   *
   * Never blocked because times exist. Times ARE the awkward case — a model counting minutes
   * from work it doesn't do is exactly what Cam is here to fix — so the recorded runs are
   * detached alongside the applies-list row, and the confirmation names every run it will touch
   * rather than refusing.
   */
  const [unlinkTarget, setUnlinkTarget] = useState<
    { jobId: string; jobName: string; operationIds: string[]; operationName?: string } | null
  >(null)
  // The preview, the saving flag and the error all moved into ModelUnlinkConfirm with the dialog
  // itself — this screen keeps only the target it opens with and the result it reports afterwards.
  const [unlinkResult, setUnlinkResult] = useState<
    (ModelUnlinkResult & { jobName: string; operationName?: string }) | null
  >(null)

  /**
   * Every operation of a job that this model has anything to do with — the union of what the
   * model REQUIRES (requiredOps, the applies-list) and what it has TIMED (result.operations).
   * The two can drift: a run whose applies-list row was removed elsewhere still counts minutes
   * for the model, and an unlink that only covered the required set would leave it counting.
   */
  function operationIdsForJob(jobId: string): string[] {
    const ids = new Set<string>()
    for (const o of requiredOps) if (o.job_id === jobId) ids.add(o.id)
    for (const r of result.operations) if (r.jobId === jobId) ids.add(r.operationId)
    return [...ids]
  }

  /** The rows offer exactly two things now: Add Time, and the X that says this model doesn't
   * do this work. Merge used to sit here too and is gone — it deep-linked to /setup with nothing
   * selected, which was a dead end. Merge lives on /setup, which owns the structure. */
  function unlinkJob(rowJobId: string, rowJobName: string) {
    openUnlink({ jobId: rowJobId, jobName: rowJobName, operationIds: operationIdsForJob(rowJobId) })
  }

  function unlinkOperation(rowJobId: string, rowJobName: string, operationId: string, operationName: string) {
    openUnlink({ jobId: rowJobId, jobName: rowJobName, operationIds: [operationId], operationName })
  }

  /** Opens the shared dialog and nothing else. The preview read, the confirmation wording and the
   * write all live in ModelUnlinkConfirm now. */
  function openUnlink(target: { jobId: string; jobName: string; operationIds: string[]; operationName?: string }) {
    if (!productId || target.operationIds.length === 0) return
    setUnlinkTarget(target)
  }

  // ── Printable collection sheet ──────────────────────────────────────────────────────────
  /** The to-collect list is gapTree — the on-screen "Not yet timed" list, printed. So the sheet
   * can't list an operation the page considers timed, or omit one it shows as a gap. */
  const printOperationCount = untimedCount(totals)

  /**
   * ── The page's printouts ────────────────────────────────────────────────────────────────
   *
   *   'blank'   — the collection sheet: everything still to collect, with ruled blanks to write
   *               minutes into. A field document, unchanged.
   *   'times'   — OPERATIONS DETAIL: every job with its operations beneath it, each operation
   *               showing its minutes. What the screen currently shows, as a document.
   *   'summary' — JOB DETAIL: the same jobs, one line each — job name and the job's total.
   *               Nothing beneath them, and nothing beside them.
   *   'section' — SECTION DETAIL: one line per section, the sum of its jobs, under its team.
   *   'team'    — TEAM DETAIL: one line per team, the sum of its sections, under its line.
   *
   * The last four are ONE document at four grains. They share TimesSheetHead, and each grain is
   * the grain below it summed (see "The roll-up" above): a job's figure is its `subtotal`, a
   * section's and a team's are the breakdown tree's roll-ups — never a second derivation that
   * happens to agree.
   *
   * Only ONE is mounted at a time. Every sheet is `.print-sheet`, which is the class the print
   * rule keys off to hide the rest of the page, so having two in the DOM would print both; the
   * mode decides which exists rather than which is visible.
   */
  const [printMode, setPrintMode] = useState<PrintMode | null>(null)

  // Stamped when Print is pressed rather than at render: this component server-renders too, and
  // a date evaluated during render would differ between server and client markup.
  const [printedAt, setPrintedAt] = useState<string | null>(null)
  // Every sheet on this page prints on A4 portrait, wherever else the tab has been. The same rule
  // as ./print.css; see lib/usePageSetup for why print.css alone isn't enough.
  const pinPageSetup = usePageSetup(MODEL_TOTAL_PAGE_CSS)
  function handlePrint(mode: PrintMode) {
    pinPageSetup()
    setPrintMode(mode)
    setPrintedAt(new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }))
    // Two frames so the chosen sheet is mounted and painted before the print dialog snapshots
    // the page — the sheet does not exist in the DOM until this render commits.
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()))
  }

  /**
   * The Show filter, stated in words for the printed sheet. `scopeLabel` above is a chip for the
   * stat cards; this is a sentence, and it names "All labour" explicitly rather than saying
   * nothing — a sheet with no scope line reads as unfiltered whether it is or not.
   */
  const filterPhrase = useMemo(() => {
    if (labourSource === 'all') return 'All labour'
    if (labourSource === 'line') return 'Line labour only'
    if (areaLineId) return `Pre-assembly — ${lineSplit?.name(areaLineId) ?? 'area'}`
    return 'Pre-assembly only'
  }, [labourSource, areaLineId, lineSplit])

  /** The line and series the model was chosen through, named the way every sheet names them.
   * Computed once here rather than inline per sheet: all three printouts state the same
   * selection, and three copies of the same fallback chain is three chances to drift. */
  const printLineName = lines.find((l) => l.id === lineId)?.name ?? 'No production line'
  const printSeriesName = selectedProduct?.product_series?.trim() || series || 'No series'

  const loading = productsLoading || modelTotalLoading || requiredLoading
  const combinedError = modelTotalError || requiredError

  return (
    <main className="page rp-page">
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
        {/* ── The print controls ───────────────────────────────────────────────────────
            Two errands, and the gap between them says so. "Print blank sheet" is what goes OUT
            to the line with room to write on it; the pair beside it is what comes back, as a
            record. They are deliberately not three buttons in a row — that reads as three
            equivalent choices, and the first one isn't.

            The record is one document at four grains — Operation → Job → Section → Team, the
            Labour Matrix's grain selector — so it is one labelled control with four segments
            rather than a dropdown. A menu would hide the fact that the coarser sheets exist at
            all (the same reason the breakdown rows lost their "…" overflow menu). */}
        <button
          type="button"
          className="btn-ghost"
          disabled={!productId || !hierarchyReady}
          title={productId ? 'Print a blank sheet of everything still to collect for this model, with room to write' : 'Select a model first'}
          onClick={() => handlePrint('blank')}
        >
          Print blank sheet
        </button>
        <span className="mt-print-divider" aria-hidden="true" />
        <div className="mt-print-group" role="group" aria-label="Print recorded times">
          <span className="mt-print-group-label">Print recorded times</span>
          <div className="mt-print-seg">
            <button
              type="button"
              className="btn-ghost mt-print-seg-btn"
              disabled={!productId || !hierarchyReady}
              title={productId ? `Every job with its operations beneath it, each showing its minutes — ${filterPhrase.toLowerCase()}, exactly as shown below` : 'Select a model first'}
              onClick={() => handlePrint('times')}
            >
              Operations Detail
            </button>
            <button
              type="button"
              className="btn-ghost mt-print-seg-btn"
              disabled={!productId || !hierarchyReady}
              title={productId ? `One line per job — job name and its total minutes, nothing else — ${filterPhrase.toLowerCase()}` : 'Select a model first'}
              onClick={() => handlePrint('summary')}
            >
              Job Detail
            </button>
            <button
              type="button"
              className="btn-ghost mt-print-seg-btn"
              disabled={!productId || !hierarchyReady}
              title={
                !productId ? 'Select a model first'
                  : hierarchyError ? `Could not load sections and teams — ${hierarchyError}`
                    : !hierarchyReady ? 'Loading sections…'
                      : `One line per section, in production order — the sum of its jobs' totals — ${filterPhrase.toLowerCase()}`
              }
              onClick={() => handlePrint('section')}
            >
              Section Detail
            </button>
            <button
              type="button"
              className="btn-ghost mt-print-seg-btn"
              disabled={!productId || !hierarchyReady}
              title={
                !productId ? 'Select a model first'
                  : hierarchyError ? `Could not load sections and teams — ${hierarchyError}`
                    : !hierarchyReady ? 'Loading teams…'
                      : `One line per team — the sum of its sections' totals — ${filterPhrase.toLowerCase()}`
              }
              onClick={() => handlePrint('team')}
            >
              Team Detail
            </button>
          </div>
        </div>
        {/* These three selects pick WHICH MODEL is on screen — nothing more. On a pre-assembly
            line they list the models of the lines it feeds (lib/lines), so choosing "Sew" and
            then a Caravan model is the normal case, not a mis-selection. Saying so here is what
            stops the Caravan jobs underneath reading as a broken filter; the filter that does
            narrow them is the one above the breakdown. */}
        <p style={{ flexBasis: '100%', margin: 0, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.55 }}>
          Line, series and model choose which model to show. A model’s total is its own labour
          wherever it was recorded, so every line’s jobs are included — use{' '}
          <strong style={{ color: 'var(--text-mid)' }}>Show</strong>, above the breakdown, to
          count pre-assembly and line labour separately.
        </p>
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
              <div className="stat-card-label">
                Total for {selectedProduct?.model ?? '—'}{scopeLabel && <> · {scopeLabel}</>}
              </div>
              <div className="stat-card-value">{fmtMinutes(visibleTotalMinutes)}m</div>
              {/* NOT "average per operation": an operation's figure is its CURRENT record
                  (superseded_by is null) and a total is the plain sum of those. The old wording
                  outlived the change by a release and described a calculation the app no longer
                  performs — see OperationTimeStat in lib/operationTimes for why it changed. */}
              <div className="stat-card-sub">
                {fmtHours(visibleTotalMinutes)}h · the sum of each operation’s current recorded
                time{scopeClause}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-card-label">Coverage{scopeLabel && <> · {scopeLabel}</>}</div>
              <div className="stat-card-value">{jobsTimed} / {jobsRequired}</div>
              <div className="stat-card-sub">
                {scopeLabel ? `${scopeLabel.toLowerCase()} jobs` : 'jobs'} timed for this model — timed
                so far, not full labour content. Untimed operations contribute 0.
              </div>
            </div>
          </div>

          {/* ── Unlink result ────────────────────────────────────────── */}
          {unlinkResult && (
            <div
              style={{
                padding: '12px 16px', borderRadius: 10, marginBottom: 16, fontSize: 13,
                background: unlinkResult.failures.length > 0 ? 'var(--red-bg)' : 'var(--green-bg)',
                border: `1px solid ${unlinkResult.failures.length > 0 ? '#fecaca' : '#bbf7d0'}`,
                color: unlinkResult.failures.length > 0 ? 'var(--red)' : '#15803d',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <strong>{unlinkResult.operationName ?? unlinkResult.jobName}</strong> no longer applies to{' '}
                  <strong>{selectedProduct?.model ?? 'this model'}</strong> —{' '}
                  {plural(unlinkResult.applicabilityUnlinked, 'operation')} unlinked
                  {unlinkResult.unattachedTimes > 0 && <>, {plural(unlinkResult.unattachedTimes, 'time')} now unattached</>}.
                  {unlinkResult.unattachedTimes > 0 && (
                    <>
                      {' '}
                      {/* The runs are still there — this is the filter that proves it. */}
                      <Link
                        href={buildReportHref({ lineId, productId: UNATTACHED_PRODUCT_ID, preset: 'all' })}
                        style={{ color: 'inherit', fontWeight: 700 }}
                      >
                        View unattached times →
                      </Link>
                    </>
                  )}
                  {unlinkResult.failures.length > 0 && (
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
                      {unlinkResult.failures.map((f, i) => <li key={i}>{f}</li>)}
                    </ul>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setUnlinkResult(null)}
                  style={{ background: 'none', border: 0, cursor: 'pointer', color: 'inherit', fontSize: 16, lineHeight: 1, padding: 0 }}
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            </div>
          )}

          {/* ── Breakdown ────────────────────────────────────────────── */}
          <div className="card" style={{ marginBottom: 16 }}>
            {/* ── Labour source ─────────────────────────────────────────────────────────
                The real filter. Sits directly above the breakdown it narrows, not up with the
                model selects, because it answers a different question from them: those choose
                the model, this chooses which of that model's labour counts. */}
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                Show
              </span>
              <div className="labour-seg" role="group" aria-label="Labour source">
                {LABOUR_SOURCES.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    title={s.hint}
                    aria-pressed={labourSource === s.key}
                    className={'labour-seg-btn' + (labourSource === s.key ? ' labour-seg-btn-on' : '')}
                    // Leaving Pre-assembly drops any area narrowing with it — an area chip that
                    // stayed selected while invisible would silently scope the next view.
                    onClick={() => { setLabourSource(s.key); if (s.key !== 'pre') setAreaLineId('') }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              {labourSource === 'pre' && (
                preAssemblyAreas.length === 0 ? (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    No pre-assembly area has a job linked to this model.
                  </span>
                ) : (
                  // Only the areas this model actually has work on — so a chip always narrows
                  // to something. A team under an area (Running Gear, under Chassis) is not a
                  // chip of its own: the line is what labour is attributed to.
                  <AreaChips areas={preAssemblyAreas} value={areaLineId} onChange={setAreaLineId} />
                )
              )}
            </div>

            <div style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Breakdown by team and section</span>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 0' }}>
                  Team, then section in line order, jobs A–Z{scopeLabel && <> · {scopeLabel} only</>}
                </p>
                {/* The gap, stated — not left for the reader to subtract or scroll for. */}
                {jobNodes.length > 0 && (
                  <p style={{ fontSize: 12, margin: '6px 0 0', color: 'var(--text-mid)' }}>
                    {untimedCount(totals) === 0 ? (
                      <span className="badge badge-green">Every applicable operation is timed</span>
                    ) : (
                      <>
                        <strong className="mt-untimed">{plural(untimedCount(totals), 'operation')} not yet timed</strong>
                        {' '}of {totals.totalOps}
                        {untouchedSections > 0 && <> · <strong className="mt-untimed">{plural(untouchedSections, 'section')}</strong> with nothing timed</>}
                        {' · '}<a href="#not-yet-timed" style={{ color: 'var(--blue)', fontWeight: 600 }}>See the list ↓</a>
                      </>
                    )}
                  </p>
                )}
              </div>
              {jobNodes.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>Open to</span>
                  <div className="labour-seg" role="group" aria-label="How far the breakdown is opened">
                    {DEPTHS.map((d) => (
                      <button
                        key={d.key} type="button" title={d.hint}
                        aria-pressed={depth === d.key}
                        className={'labour-seg-btn' + (depth === d.key ? ' labour-seg-btn-on' : '')}
                        onClick={() => openTo(d.key)}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {hierarchyError && (
            <p style={{ margin: '0 0 16px', padding: '9px 12px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 12 }}>
              Could not load sections and teams — {hierarchyError}. The jobs below are listed without their grouping.
            </p>
          )}

          {jobNodes.length === 0 ? (
            <p style={EMPTY}>
              {loading ? 'Loading…'
                : scopeLabel ? `No ${scopeLabel.toLowerCase()} jobs for this model — switch Show back to All to see the rest.`
                  : 'No jobs require this model yet'}
            </p>
          ) : !hierarchy && !hierarchyError ? (
            <p style={EMPTY}>Loading sections…</p>
          ) : (
            <>
              <BreakdownTable
                lines={tree}
                showLineHeadings={tree.length > 1 || labourSource === 'all'}
                modelName={selectedProduct?.model ?? 'this model'}
                total={totals}
                totalLabel={<>Grand total{scopeLabel && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {scopeLabel}</span>}</>}
                collapsedSections={collapsedSections}
                onToggleSection={toggleSection}
                expandedJobs={expandedJobs}
                onToggleJob={toggleJob}
                operatorLabelFor={operatorLabelFor}
                copiedSourceByOperation={copiedSourceByOperation}
                onAddTime={openAddTime}
                onEditTimes={(operationId, operationName) => setEditTimesTarget({ operationId, operationName })}
                onUnlinkJob={unlinkJob}
                onUnlinkOperation={unlinkOperation}
              />

              {/* ── Not yet timed ────────────────────────────────────────
                  The same tree narrowed to the jobs with a gap, listing only their untimed
                  operations — the on-screen twin of "Print blank sheet", which prints this
                  very list. */}
              <div id="not-yet-timed" style={{ margin: '28px 0 12px', scrollMarginTop: 72 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                  Not yet timed <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({plural(untimedCount(totals), 'operation')})</span>
                </span>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 0' }}>
                  Every operation that applies to this model and has no recorded time, by team and section{scopeLabel && <> · {scopeLabel} only</>}
                </p>
              </div>
              {gapTree.length === 0 ? (
                <p style={EMPTY}>Nothing left to time — every operation that applies to this model has a recorded time.</p>
              ) : (
                <NotYetTimedTable lines={gapTree} showLineHeadings={gapTree.length > 1 || labourSource === 'all'} onAddTime={openAddTime} />
              )}
            </>
          )}
        </>
      )}

      {/* ── Printable recorded-times sheet · OPERATIONS DETAIL ──────────────────────────
          The screen's filtered view as a document, jobs with their operations beneath them. It
          reads the SAME derived values the page renders — timedLineGroups, untimedLineGroups,
          visibleTotalMinutes, jobsTimed — rather than re-deriving anything, so a filtered sheet
          cannot disagree with the screen it was printed from, or with the job-summary sheet
          below, which reads the very same groups.

          Every operation is listed regardless of expandedJobs: the collapse state is a reading
          aid on screen and a printed sheet of collapsed rows is a sheet of headings.

          Structure, layout and rules come from app/report-print.css via the .rp-* classes;
          .mt-times-* is only what is particular to a job/operation breakdown. */}
      {productId && printMode === 'times' && (
        <div className="print-sheet rp-doc mt-times-sheet">
          <TimesSheetHead
            variantLabel="Operations Detail"
            model={selectedProduct?.model ?? '—'}
            productCode={selectedProduct?.product_code ?? null}
            lineName={printLineName}
            seriesName={printSeriesName}
            filterPhrase={filterPhrase}
            totalMinutes={visibleTotalMinutes}
            jobsTimed={jobsTimed}
            jobsRequired={jobsRequired}
            printedAt={printedAt}
          />

          {tree.length === 0 ? (
            <p className="rp-meta">No jobs apply to this model in this selection.</p>
          ) : (
            <>
              {/* Line → Team → ONE TABLE PER SECTION, the same tree the screen renders. A table
                  per section because its <thead> is what a browser repeats on every sheet the
                  section runs onto — so it names the team AND the section, and both come back at
                  the top of each page. */}
              {tree.map((line) => (
                <Fragment key={line.key}>
                  <SheetGroupHead level="line" name={line.lineName} r={line} />
                  {line.teams.map((team) => (
                    <Fragment key={team.key}>
                      <SheetGroupHead level="team" name={`${team.name} · ${plural(team.sectionCount, 'section')}`} r={team} />
                      {team.sections.map((section) => (
                        <table key={section.key} className="rp-table mt-times-table mt-sec-table">
                          <thead>
                            <tr>
                              <th className="mt-col-name mt-sec-head">{team.name} · {sectionLabel(section)}</th>
                              <th className="mt-col-mins rp-num">Mins</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr className="rp-group">
                              <td className={rowClass(section.timedOps, section.totalOps).trim()}>
                                {section.timedOps === 0 && 'NOTHING TIMED — '}{rollupPhrase(section)}
                              </td>
                              <td className={`rp-num${rowClass(section.timedOps, section.totalOps)}`}>
                                {jobFigure(section.minutes, section.timedOps, section.totalOps)}
                              </td>
                            </tr>
                          </tbody>
                          {/* A TBODY PER JOB — tbody is the only element inside a table that
                              `break-inside: avoid` can be hung on, and a job's block (its heading,
                              its operations, its untimed gaps) is what must not be torn across two
                              sheets. A job longer than a sheet still splits. */}
                          {section.jobs.map((g) => (
                            <tbody key={g.jobId} className="mt-times-jobblock">
                              {/* rp-subhead: a job heading is never the last thing on a sheet. A
                                  partly timed job is marked HERE — the heading's figure is what
                                  gets copied off the sheet, and alone it reads as the whole job. */}
                              <tr className="rp-subhead">
                                <td className={`mt-times-job${rowClass(g.timedOps, g.totalOps)}`}>
                                  {g.jobName}
                                  <JobStatusNote timedOps={g.timedOps} totalOps={g.totalOps} />
                                </td>
                                <td className={`rp-num mt-times-job${rowClass(g.timedOps, g.totalOps)}`}>
                                  {jobFigure(g.minutes, g.timedOps, g.totalOps)}
                                </td>
                              </tr>
                              {g.rows.map((r) => (
                                <tr key={r.operationId}>
                                  <td className="mt-times-op">{r.operationName}</td>
                                  <td className="rp-num">{fmtMinutes(r.minutes)}m</td>
                                </tr>
                              ))}
                              {/* Untimed operations. Italic, not grey: the screen greys them and
                                  grey does not survive a mono printer. */}
                              {g.missing.map((m) => (
                                <tr key={m.operationId}>
                                  <td className="mt-times-op mt-times-untimed">{m.operationName} · not timed</td>
                                  <td className="rp-num mt-times-untimed">—</td>
                                </tr>
                              ))}
                            </tbody>
                          ))}
                        </table>
                      ))}
                    </Fragment>
                  ))}
                </Fragment>
              ))}
              {/* The total is the sum of every current record in scope, an untimed operation
                  contributing 0. The asterisk doesn't alter it; it says the figure is not the
                  model's full labour content, which the counts beside it quantify. */}
              <table className="rp-table mt-times-table mt-sec-table">
                <tbody>
                  <tr className="mt-times-grand">
                    <td className="mt-col-name mt-times-total">Total · {filterPhrase} · {rollupPhrase(totals)}</td>
                    <td className="mt-col-mins rp-num mt-times-total">
                      {fmtMinutes(visibleTotalMinutes)}m{anyIncomplete ? '*' : ''}
                    </td>
                  </tr>
                </tbody>
              </table>
            </>
          )}

          <p className="rp-foot">
            {selectedProduct?.model ?? '—'} · {filterPhrase} · an operation's minutes are its
            current record and a job's total is the sum of them; superseded runs are kept but
            never counted.
            {anyIncomplete && <><br />{INCOMPLETE_NOTE}</>}
          </p>
        </div>
      )}

      {/* ── Printable recorded-times sheet · JOB DETAIL ─────────────────────────────────
          The same document as the detailed sheet above, at one level less depth: one line per
          job, the job's name and the job's total minutes. No operations, no operator, no run
          counts — the header says what this is a total of, and anything else here would make it
          a second, thinner copy of the detailed sheet rather than a different reading of it.

          EVERY job that applies to the model is on it, timed or not — summaryLineGroups, the
          union of both halves of the on-screen breakdown. It listed only the timed ones once,
          which meant six absent jobs and a total that read as full labour content, with nothing
          on the paper to say so. A row that is missing cannot be questioned; a row that says
          "0.0m · not yet timed" can.

          The figures are `g.subtotal` and `visibleTotalMinutes`: the SAME objects the detailed
          sheet prints and the on-screen breakdown renders. Nothing is re-added here — if these
          two sheets ever disagreed it would mean a total had been recomputed somewhere, which is
          the thing this arrangement exists to make impossible. */}
      {productId && printMode === 'summary' && (
        <div className="print-sheet rp-doc mt-times-sheet">
          <TimesSheetHead
            variantLabel="Job Detail"
            model={selectedProduct?.model ?? '—'}
            productCode={selectedProduct?.product_code ?? null}
            lineName={printLineName}
            seriesName={printSeriesName}
            filterPhrase={filterPhrase}
            totalMinutes={visibleTotalMinutes}
            jobsTimed={jobsTimed}
            jobsRequired={jobsRequired}
            printedAt={printedAt}
          />

          {tree.length === 0 ? (
            <p className="rp-meta">No jobs apply to this model in this selection.</p>
          ) : (
            <>
              {/* Line → Team → ONE TABLE PER SECTION, the same tree the screen renders. A table
                  per section because its <thead> is what a browser repeats on every sheet the
                  section runs onto — so it names the team AND the section, and both come back at
                  the top of each page. */}
              {tree.map((line) => (
                <Fragment key={line.key}>
                  <SheetGroupHead level="line" name={line.lineName} r={line} />
                  {line.teams.map((team) => (
                    <Fragment key={team.key}>
                      <SheetGroupHead level="team" name={`${team.name} · ${plural(team.sectionCount, 'section')}`} r={team} />
                      {team.sections.map((section) => (
                        <table key={section.key} className="rp-table mt-times-table mt-sec-table">
                          <thead>
                            <tr>
                              <th className="mt-col-name mt-sec-head">{team.name} · {sectionLabel(section)}</th>
                              <th className="mt-col-mins rp-num">Mins</th>
                            </tr>
                          </thead>
                          {/* A job IS one row here, and a row is already unbreakable (.rp-table tr). */}
                          <tbody>
                            <tr className="rp-group">
                              <td className={rowClass(section.timedOps, section.totalOps).trim()}>
                                {section.timedOps === 0 && 'NOTHING TIMED — '}{rollupPhrase(section)}
                              </td>
                              <td className={`rp-num${rowClass(section.timedOps, section.totalOps)}`}>
                                {jobFigure(section.minutes, section.timedOps, section.totalOps)}
                              </td>
                            </tr>
                            {section.jobs.map((j) => (
                              <tr key={j.jobId}>
                                <td className={`mt-times-op${rowClass(j.timedOps, j.totalOps)}`}>
                                  {j.jobName}
                                  <JobStatusNote timedOps={j.timedOps} totalOps={j.totalOps} />
                                </td>
                                {/* 0.0m, never blank: a job that applies and has no recorded time
                                    contributes exactly zero, and the row shows what it contributes. */}
                                <td className={`rp-num${rowClass(j.timedOps, j.totalOps)}`}>
                                  {jobFigure(j.minutes, j.timedOps, j.totalOps)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ))}
                    </Fragment>
                  ))}
                </Fragment>
              ))}
              {/* The total is the sum of every current record in scope, an untimed operation
                  contributing 0. The asterisk doesn't alter it; it says the figure is not the
                  model's full labour content, which the counts beside it quantify. */}
              <table className="rp-table mt-times-table mt-sec-table">
                <tbody>
                  <tr className="mt-times-grand">
                    <td className="mt-col-name mt-times-total">Total · {filterPhrase} · {rollupPhrase(totals)}</td>
                    <td className="mt-col-mins rp-num mt-times-total">
                      {fmtMinutes(visibleTotalMinutes)}m{anyIncomplete ? '*' : ''}
                    </td>
                  </tr>
                </tbody>
              </table>
            </>
          )}

          <p className="rp-foot">
            {selectedProduct?.model ?? '—'} · {filterPhrase} · every job that applies to this
            model is listed; each figure is the sum of that job's operations' current recorded
            times, and superseded runs are kept but never counted. Print Operations Detail for
            the operations behind each job.
            {anyIncomplete && <><br />{INCOMPLETE_NOTE}</>}
          </p>
        </div>
      )}

      {/* ── Printable recorded-times sheet · SECTION DETAIL ──────────────────────────────
          Job Detail one grain up: one row per section, under its line and team — the same tree
          and the same order as the screen and the other sheets (team, then sections.sort_order).
          ONE TABLE PER TEAM, whose <thead> names the team, so the heading comes back at the top
          of every sheet the team runs onto. Every figure is the tree's own roll-up. */}
      {productId && printMode === 'section' && (
        <div className="print-sheet rp-doc mt-times-sheet">
          <TimesSheetHead
            variantLabel="Section Detail"
            model={selectedProduct?.model ?? '—'}
            productCode={selectedProduct?.product_code ?? null}
            lineName={printLineName}
            seriesName={printSeriesName}
            filterPhrase={filterPhrase}
            totalMinutes={visibleTotalMinutes}
            jobsTimed={jobsTimed}
            jobsRequired={jobsRequired}
            printedAt={printedAt}
          />

          {tree.length === 0 ? (
            <p className="rp-meta">No jobs apply to this model in this selection.</p>
          ) : (
            <>
              {tree.map((line) => (
                <Fragment key={line.key}>
                  <SheetGroupHead level="line" name={line.lineName} r={line} />
                  {line.teams.map((team) => (
                    <table key={team.key} className="rp-table mt-times-table mt-sec-table">
                      <thead>
                        <tr>
                          <th className="mt-col-name mt-sec-head">{team.name} · {plural(team.sectionCount, 'section')}</th>
                          <th className="mt-col-mins rp-num">Mins</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="rp-group">
                          <td className={rowClass(team.timedOps, team.totalOps).trim()}>
                            {team.timedOps === 0 && 'NOTHING TIMED — '}{rollupPhrase(team)}
                          </td>
                          <td className={`rp-num${rowClass(team.timedOps, team.totalOps)}`}>
                            {jobFigure(team.minutes, team.timedOps, team.totalOps)}
                          </td>
                        </tr>
                        {team.sections.map((sec) => (
                          <tr key={sec.key}>
                            <td className={`mt-times-op${rowClass(sec.timedOps, sec.totalOps)}`}>
                              {sectionLabel(sec)} <span style={{ fontWeight: 400 }}>· {plural(sec.jobCount, 'job')}</span>
                              <JobStatusNote timedOps={sec.timedOps} totalOps={sec.totalOps} />
                            </td>
                            <td className={`rp-num${rowClass(sec.timedOps, sec.totalOps)}`}>
                              {jobFigure(sec.minutes, sec.timedOps, sec.totalOps)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ))}
                </Fragment>
              ))}
              <table className="rp-table mt-times-table mt-sec-table">
                <tbody>
                  <tr className="mt-times-grand">
                    <td className="mt-col-name mt-times-total">Total · {filterPhrase} · {rollupPhrase(totals)}</td>
                    <td className="mt-col-mins rp-num mt-times-total">
                      {fmtMinutes(visibleTotalMinutes)}m{anyIncomplete ? '*' : ''}
                    </td>
                  </tr>
                </tbody>
              </table>
            </>
          )}

          <p className="rp-foot">
            {selectedProduct?.model ?? '—'} · {filterPhrase} · each section's figure is the sum of
            its jobs' totals, each job's the sum of its operations' current recorded times;
            superseded runs are kept but never counted. Print Job Detail for the jobs behind each
            section.
            {anyIncomplete && <><br />{INCOMPLETE_NOTE}</>}
          </p>
        </div>
      )}

      {/* ── Printable recorded-times sheet · TEAM DETAIL ─────────────────────────────────
          One row per team, under its production line, in the same team order as every other
          sheet (where each team first appears in the line's sequence). ONE TABLE PER LINE, whose
          <thead> names the line and repeats across a page break. Each row is the tree's team
          roll-up — the same figure as that team's row on the Section Detail sheet. */}
      {productId && printMode === 'team' && (
        <div className="print-sheet rp-doc mt-times-sheet">
          <TimesSheetHead
            variantLabel="Team Detail"
            model={selectedProduct?.model ?? '—'}
            productCode={selectedProduct?.product_code ?? null}
            lineName={printLineName}
            seriesName={printSeriesName}
            filterPhrase={filterPhrase}
            totalMinutes={visibleTotalMinutes}
            jobsTimed={jobsTimed}
            jobsRequired={jobsRequired}
            printedAt={printedAt}
          />

          {tree.length === 0 ? (
            <p className="rp-meta">No jobs apply to this model in this selection.</p>
          ) : (
            <>
              {tree.map((line) => (
                <table key={line.key} className="rp-table mt-times-table mt-sec-table">
                  <thead>
                    <tr>
                      <th className="mt-col-name mt-sec-head">{line.lineName} · {plural(line.teams.length, 'team')}</th>
                      <th className="mt-col-mins rp-num">Mins</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="rp-group">
                      <td className={rowClass(line.timedOps, line.totalOps).trim()}>
                        {line.timedOps === 0 && 'NOTHING TIMED — '}{rollupPhrase(line)}
                      </td>
                      <td className={`rp-num${rowClass(line.timedOps, line.totalOps)}`}>
                        {jobFigure(line.minutes, line.timedOps, line.totalOps)}
                      </td>
                    </tr>
                    {line.teams.map((team) => (
                      <tr key={team.key}>
                        <td className={`mt-times-op${rowClass(team.timedOps, team.totalOps)}`}>
                          {team.name}{' '}
                          <span style={{ fontWeight: 400 }}>· {plural(team.sectionCount, 'section')} · {plural(team.jobCount, 'job')}</span>
                          <JobStatusNote timedOps={team.timedOps} totalOps={team.totalOps} />
                        </td>
                        <td className={`rp-num${rowClass(team.timedOps, team.totalOps)}`}>
                          {jobFigure(team.minutes, team.timedOps, team.totalOps)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
              <table className="rp-table mt-times-table mt-sec-table">
                <tbody>
                  <tr className="mt-times-grand">
                    <td className="mt-col-name mt-times-total">Total · {filterPhrase} · {rollupPhrase(totals)}</td>
                    <td className="mt-col-mins rp-num mt-times-total">
                      {fmtMinutes(visibleTotalMinutes)}m{anyIncomplete ? '*' : ''}
                    </td>
                  </tr>
                </tbody>
              </table>
            </>
          )}

          <p className="rp-foot">
            {selectedProduct?.model ?? '—'} · {filterPhrase} · each team's figure is the sum of its
            sections' totals — a job's team is its section's team. Superseded runs are kept but
            never counted. Print Section Detail for the sections behind each team.
            {anyIncomplete && <><br />{INCOMPLETE_NOTE}</>}
          </p>
        </div>
      )}

      {/* ── Printable collection sheet ───────────────────────────────────────────────────
          Never visible on screen (.print-sheet is display:none until @media print) and a direct
          child of .page, which is what the print rule keys off to hide everything else. Black on
          white, no app chrome — a field document to hand-write on. */}
      {productId && printMode === 'blank' && (
        <div className="print-sheet">
          <div className="print-sheet-header">
            <h1 className="print-sheet-title">Collection Sheet</h1>
            <p className="print-sheet-meta">
              <strong>{selectedProduct?.model ?? '—'}</strong>
              {selectedProduct?.product_code ? ` · ${selectedProduct.product_code}` : ''}
            </p>
            <p className="print-sheet-meta">
              {printLineName}
              {' · '}
              {printSeriesName}
            </p>
            {/* The sheet is the on-screen selection, printed — so it has to say which selection,
                or a Pre-assembly sheet reads as a complete list of everything outstanding. */}
            {scopeLabel && <p className="print-sheet-meta"><strong>{scopeLabel}</strong> only</p>}
            <p className="print-sheet-coverage">
              {jobsTimed} / {jobsRequired} jobs timed — {Math.max(jobsRequired - jobsTimed, 0)} to collect
              {printOperationCount > 0 && ` (${printOperationCount} operation${printOperationCount !== 1 ? 's' : ''})`}
            </p>
            <p className="print-sheet-signoff">
              Collected by:<span className="print-blank print-blank-operator" />
              Date:<span className="print-blank print-blank-minutes" />
            </p>
          </div>

          {gapTree.length === 0 ? (
            <p>Nothing to collect — every operation required for this model has a recorded time.</p>
          ) : (
            // Line → Team → ONE TABLE PER SECTION. The table is what makes the heading come back:
            // a <thead> is the only thing a browser repeats at the top of each sheet a block runs
            // onto, so every section's names its team and section, and a sheet picked up off the
            // floor says whose work it lists without the sheet before it.
            gapTree.map((line) => (
              <Fragment key={line.key}>
                <p className="print-line-name">
                  {line.lineName} · {untimedCount(line)} to collect
                </p>
                {line.teams.map((team) => (
                  <Fragment key={team.key}>
                    <h2 className="print-team-name">
                      {team.name} · {plural(team.sectionCount, 'section')} · {untimedCount(team)} to collect
                    </h2>
                    {team.sections.map((section) => (
                      <table key={section.key} className="print-sec-table">
                        <thead>
                          <tr>
                            <th>
                              {team.name} · {sectionLabel(section)}
                              <span className="print-sec-count"> ({untimedCount(section)} to collect)</span>
                            </th>
                          </tr>
                        </thead>
                        {/* A tbody per job: the only element in a table a break can be kept out of. */}
                        {section.jobs.map((job) => (
                          <tbody key={job.jobId} className="print-job">
                            <tr>
                              <td>
                                <h3 className="print-job-name">
                                  {job.jobName} ({job.missing.length} to collect)
                                </h3>
                              </td>
                            </tr>
                            {job.missing.map((op) => (
                              <tr key={op.operationId}>
                                <td>
                                  <div className="print-op">
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
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        ))}
                      </table>
                    ))}
                  </Fragment>
                ))}
              </Fragment>
            ))
          )}

          <div className="print-sheet-footer">
            {selectedProduct?.model ?? '—'} · collection sheet{printedAt ? ` · printed ${printedAt}` : ''}
          </div>
        </div>
      )}

      {/* ── Edit-times drawer ───────────────────────────────────────────────────────────
          onChanged bumps refreshTick, which is what fetchModelTotal and the required-set fetch
          are both keyed on — so the headline, the grand total, every job subtotal AND coverage
          are recomputed from the database after any edit, split or delete. Nothing here patches
          a cached number: deleting the last run for an operation has to be able to turn it back
          into an untimed gap, and only a refetch can do that. */}
      {editTimesTarget && productId && (
        <OperationTimesDrawer
          supabase={supabase}
          userId={userId}
          role={role}
          operationId={editTimesTarget.operationId}
          operationName={editTimesTarget.operationName}
          productId={productId}
          onClose={() => setEditTimesTarget(null)}
          onChanged={async () => { setRefreshTick((n) => n + 1) }}
        />
      )}

      {/* ── "Doesn't apply to this model" confirmation ───────────────────────────────
          components/ModelUnlinkConfirm — extracted from here when the Labour Matrix cell drawer
          needed the identical act with the identical safeguards. It owns the preview read, the
          wording and the write (through lib/modelLinks, still the only unlink path); this screen
          owns the target and the refresh. */}
      {unlinkTarget && selectedProduct && productId && (
        <ModelUnlinkConfirm
          supabase={supabase}
          productId={productId}
          modelName={selectedProduct.model}
          jobName={unlinkTarget.jobName}
          operationName={unlinkTarget.operationName}
          operationIds={unlinkTarget.operationIds}
          onCancel={() => setUnlinkTarget(null)}
          onDone={(res) => {
            setUnlinkResult({ ...res, jobName: unlinkTarget.jobName, operationName: unlinkTarget.operationName })
            setUnlinkTarget(null)
            // The breakdown, the coverage figure and the model total all hang off these two
            // fetches, so one bump refreshes every number on the screen in place.
            setRefreshTick((t) => t + 1)
          }}
        />
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
                {/* The signpost. This list is deliberately the applies-list for THIS model, not
                    every operation on the job — so an operation somebody expects to see and
                    can't is the normal case, not a fault. Without this line the only reading
                    available is "the drawer is broken". It points at the screen that can change
                    that, deep-linked so the pointing is literal. */}
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0', lineHeight: 1.55 }}>
                  Only operations that apply to this model are listed. To add more, use{' '}
                  <Link
                    href={buildSetupHref({
                      lineId,
                      sectionKey: addTimeSection?.id ?? UNSECTIONED_KEY,
                      jobId: addTimeTarget.jobId,
                    })}
                    style={{ color: 'var(--blue)', fontWeight: 600 }}
                  >
                    Setup
                  </Link>
                  {addTimeLineName && <> &rarr; {addTimeLineName}</>}
                  {addTimeSection?.name && <> &rarr; {addTimeSection.name}</>}
                  {' '}&rarr; this job.
                </p>
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
