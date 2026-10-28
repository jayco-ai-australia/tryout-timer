'use client'

import type { RangeableQuery } from '@/lib/supabaseRead'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  TIME_FLAG_COLUMNS, currentForOperation, jobCompleteness, onlyCountedTimes, operationProductKey,
  type JobCompleteness, type OperationTimeStat, type TimeExclusionFlags,
} from '@/lib/operationTimes'
import { computeCoverageCombos, coverageComboKey, estimateOnlyComboKeys, type CoverageCombo } from '@/lib/coverage'
import { chunked, fetchAllChunked, fetchAllRows, logSupabaseError, READ_CHUNK } from '@/lib/supabaseRead'
import { selectIn } from '@/lib/chunkedIn'
import { feedTargetsForLine, loadLineSplit, modelsForLine, type LineSplit } from '@/lib/lines'
import { compareSections } from '@/lib/sections'
import { fetchFutureBuilds, fmtScheduleDate, todayIsoDate, type FutureBuildSummary } from '@/lib/schedule'
import { fmtHours, fmtMinutes, plural } from '@/lib/format'
import { usePersistedFilter, usePersistedState } from '@/lib/useLocalStorage'
// THE series-grouped multi-select model list — the same component /collect's Models pane,
// /setup's BulkModelLinkDrawer and the Add Time drawer render. It is presentational and fully
// controlled, so a host drives it by choosing what to pass in; the search box below is this
// screen's own concern and filters the `products` it is handed rather than changing a component
// three other screens depend on.
import { ModelSeriesPicker } from '@/components/ModelLinker'
import AreaChips from '@/components/AreaChips'
import MatrixCellDrawer from './MatrixCellDrawer'
import { groupProducts } from '@/lib/productGroups'
import type { Product, ProductionLine, UserRole } from '@/lib/types'

/**
 * ── /labour-matrix ─────────────────────────────────────────────────────────────────────────
 *
 * Models down the left, jobs across the top, a job's total labour for that model in the cell.
 * /model-total for every model on a line at once.
 *
 * ── Nothing here decides what a number means ───────────────────────────────────────────────
 * Two rules govern every cell, and this screen owns neither of them:
 *
 *   WHAT A FIGURE IS   an operation's labour is its CURRENT record (superseded_by is null), and
 *                      a job's figure is the plain sum of its operations' current records.
 *                      That comes from lib/operationTimes' currentForOperation — the same
 *                      per-(operation, product) lookup /model-total, /collect, /setup and
 *                      /dashboard all read. Runs are never averaged; that rule is retired.
 *
 *   WHETHER IT APPLIES a job applies to a model when at least one of the job's operations is
 *                      linked to it in model_operations. That comes from lib/coverage's
 *                      computeCoverageCombos, the same function /dashboard and /model-total use.
 *
 * If this screen and /model-total ever disagreed about one model, one of those two helpers
 * would have been re-implemented here. Neither is: the aggregation below only adds up what they
 * return, and the row total is the same addition /model-total's grand total performs.
 *
 * ── The cell's four states, which are not the same thing ───────────────────────────────────
 *   BLANK    the job does not apply to this model. Not 0 — 0 is a claim that the work is done
 *            in no time, and this is the absence of the question.
 *   RED 0.0  it applies and nothing has been timed. A real gap, and the figure it contributes.
 *   PLAIN    every operation of the job is timed for this model. The figure is the job.
 *   MARKED   some operations are timed and some are not. The figure is real and INCOMPLETE,
 *            which is the state most easily misread as finished — so it is never a plain number.
 */

/** Rows: models. Columns: jobs. This is the cell. */
interface MatrixCell {
  /** Sum of the CURRENT records of this job's operations for this model. 0 when nothing is timed. */
  minutes: number
  /** How many of the job's operations have a current record for this model… */
  timedOps: number
  /** …out of how many the pair involves at all: the union of "required via model_operations"
   * and "has a recorded time". The union, not the required set, for the same reason
   * /model-total takes it — a run whose applies-list row was removed elsewhere still counts
   * minutes, and a denominator that ignored it would call a partial job complete. */
  totalOps: number
  /** Whether the job applies to this model at all. False renders BLANK, never 0. */
  applies: boolean
  /** How many of the timedOps have an ESTIMATED current record (/estimate). Any at all and the
   * cell reads as estimated — a figure partly inferred is inferred. See Cell's background. */
  estimatedOps: number
}

/** The labour-source filter, with the same three meanings /model-total's toggle has: it splits
 * the JOBS by the production line each one sits on. The rule itself is not re-implemented here
 * — `lineSplit.isPreAssembly` (lib/lines' cached topology) is the one implementation of "is
 * this a pre-assembly line", and both screens ask it. */
type LabourSource = 'all' | 'line' | 'pre'

const LABOUR_SOURCES: { key: LabourSource; label: string; hint: string }[] = [
  { key: 'all', label: 'All', hint: 'Every job that applies to these models — pre-assembly and line labour together' },
  { key: 'line', label: 'Line labour', hint: 'Only jobs on a build line — pre-assembly areas excluded' },
  { key: 'pre', label: 'Pre-assembly', hint: 'Only jobs on a pre-assembly area — Chassis, Lamination, Saws, Sew, Filling, Training' },
]

/**
 * ── The grain ──────────────────────────────────────────────────────────────────────────────
 *
 * Three views of ONE grid. The rows are models in all three; only the columns change, and they
 * change by GROUPING — never by asking a different question of the database.
 *
 * The hierarchy is Team → Section → Job, and a job reaches its team through its SECTION
 * (sections.team_id). jobs.team_id exists and is legacy; reading it would give this screen a
 * second answer to "whose job is this" that could disagree with the section it rolls up through.
 */
type Grain = 'team' | 'section' | 'job'

const GRAINS: { key: Grain; label: string; noun: string; hint: string }[] = [
  { key: 'team', label: 'Team', noun: 'team', hint: 'One column per team — the sum of its sections' },
  { key: 'section', label: 'Section', noun: 'section', hint: 'One column per section — the sum of its jobs' },
  { key: 'job', label: 'Job', noun: 'job', hint: 'One column per job — the figures every coarser view is built from' },
]

/** A column of the grid, at whatever grain is selected. At job grain `jobIds` holds exactly one
 * id and the column IS the job; at coarser grains it holds every visible job beneath it, which
 * is the only thing the roll-up needs. */
interface MatrixColumn {
  /** React key, and the first half of the cell-map key. A job id at job grain. */
  key: string
  label: string
  /** The VISIBLE jobs under this column — already past the Show and Team filters, so a filtered
   * column is the sum of what is on screen and never of what was filtered out. */
  jobIds: string[]
  /** The pre-assembly area (a production line id) this column belongs to. Set only under
   * Show = Pre-assembly, where the columns are ordered and headed by area; null otherwise. */
  areaId: string | null
  /** What the column sits under, one level up the Team → Section → Job hierarchy: a job's
   * section, a section's team. Null at Team grain, which has no level above it on this grid. */
  parent: { key: string; label: string } | null
}

/** A run of adjacent columns belonging to one area — one cell of the area header row. */
interface AreaSpan { areaId: string; name: string; span: number }
/** A run of adjacent columns under one parent — one cell of the parent header row. */
interface ParentSpan { key: string; label: string; span: number }

/**
 * A model's row total. `applies` is false when NO visible column applies to the model — every
 * cell on its row is blank — and then the total is blank too, hatched like the cells, never 0.0:
 * a 0.0 total reads as "applies, nothing timed", a gap to go and close, and this is not one. It
 * is the cell's BLANK-vs-red-0 rule carried to the end of the row.
 */
interface RowTotal { minutes: number; incomplete: boolean; applies: boolean }
const NO_ROW_TOTAL: RowTotal = { minutes: 0, incomplete: false, applies: false }

/** Buckets for what the hierarchy doesn't reach: a job with no section, or a section with no
 * team. Real states — an unsectioned job still exists and its labour still counts — so they get
 * a column rather than being dropped, and sort to the end like groupProductsBySeries' "Other". */
const NO_SECTION = '__no-section__'
const NO_TEAM = '__no-team__'

const SEL: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
  border: '1.5px solid var(--border)', borderRadius: 8, padding: '7px 10px',
  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', outline: 'none', minWidth: 190,
}
const EMPTY: React.CSSProperties = { textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '40px 0' }

/**
 * How many columns go on one printed A3 sheet before the grid starts again on the next.
 *
 * A3 landscape is 420mm wide; 10mm margins leave 400mm, of which the model name takes 44mm and
 * the model total 16mm — 340mm for the data columns. Each data column has a hard 13mm floor in
 * the print CSS (.lm-print-th-job — the widest figure, "2514.7*", is 10.3mm, and the rest is
 * padding and a guaranteed gap), so 340 / 13 = 26 columns is the most one sheet holds legibly.
 * Past that the grid splits into bands and each band says "sheet n of m across"; it is never
 * squeezed further.
 *
 * Job grain keeps 22 (15.7mm each): a line has ninety jobs, so it runs to several sheets
 * whatever the cap, and the extra width is margin for a printer that lies about its
 * unprintable edge. Section and Team grain get the full 26, because a section sheet that splits
 * in two loses the left-to-right production sequence that is the reason to print it.
 *
 * This is the whole answer to "the grid is wider than the paper": it is cut into bands of
 * columns, each band a fresh sheet with the model names and the model totals repeated down its
 * left. The alternative — letting a 90-column table overflow — does not degrade gracefully in
 * any browser: it either clips at the page box and prints the first 22 columns with no
 * indication that 68 are missing, or it shrinks the type until nothing is readable. A band
 * cannot silently lose a column, because every band says which columns it holds.
 */
const PRINT_BAND_COLUMNS_JOB = 22
const PRINT_BAND_COLUMNS_ROLLUP = 26

// groupProducts — the type → series row grouping — lives in lib/productGroups so /estimate's
// model columns break the range the same way these rows do.

interface Props {
  lines: ProductionLine[]
  /** The viewer. Not used by the grid at all — it is handed to the cell drawer, which opens the
   * shared time-record editor, which is where the permission rules live (lib/permissions). */
  userId: string
  role: UserRole
}

/** The rows this screen reads. Deliberately narrow selects — a 101-model line pulls tens of
 * thousands of junction rows, and every column not asked for is bytes off the wire. */
/** jobs.team_id is NOT selected, deliberately. It is legacy: a job's team is its SECTION's
 * team (sections.team_id), which is the hierarchy the grain selector rolls up, and reading both
 * would give this screen two answers to "whose job is this". section_id is the only link. */
interface JobRow { id: string; name: string; section_id: string | null; production_line_id: string | null; is_active: boolean }
/** sort_order is the LINE-WIDE production sequence, independent of team, and it is what orders
 * the Section-grain columns (lib/sections' compareSections). */
interface SectionRow { id: string; name: string; team_id: string | null; sort_order: number | null }
interface OperationRow { id: string; job_id: string }
interface PairRow { operation_id: string; product_id: string }
interface TimeRow extends TimeExclusionFlags { id: string; operation_id: string; total_minutes: number | null; superseded_by: string | null; chassis_id: string | null; is_estimated: boolean }
interface TimeModelRow { operation_time_id: string; product_id: string }
/** production_line_id is what SCOPES the Team filter. A team belongs to exactly one line (it is
 * NOT NULL on the table — see lib/types' Team), and without the column the picker could only
 * offer "every team that owns a job on this grid", which on a build line includes every
 * pre-assembly team whose work applies to its models. */
interface TeamRow { id: string; name: string; production_line_id: string | null }

/** Everything one production line's grid is built from, fetched together and then never
 * re-fetched by a filter — the filters below are all in-memory views over this. */
interface MatrixSource {
  products: Product[]
  /** The build lines the selected line feeds — lib/lines' feedTargetsForLine, so empty for a
   * normal build line. What the Build line filter offers; carried in `source` rather than held
   * as its own state so it can never describe a different line than the products beside it. */
  feedTargetIds: string[]
  jobs: JobRow[]
  /** The middle of the Team → Section → Job hierarchy: a section's name (the SECTION-grain
   * column label) and its team (which is what makes a job a team's job). */
  sections: SectionRow[]
  operations: OperationRow[]
  modelOperations: PairRow[]
  /** The current-record rows and their model links — kept as well as the stats derived from
   * them, because the grid needs to know WHICH (operation, model) pairs have a figure, and the
   * stats map is keyed by a string this screen must not take apart. */
  operationTimes: TimeRow[]
  operationTimeModels: TimeModelRow[]
  /** Keyed `operationId:productId` by lib/operationTimes' own key function. */
  stats: Record<string, OperationTimeStat>
  /** lib/coverage's (job, model) applicability + covered flags. */
  combos: CoverageCombo[]
  /** The covered combos covered ONLY by estimates — lib/coverage's estimateOnlyComboKeys. The
   * "of which N estimated" beside the coverage figure; never subtracted from it. */
  estimateOnlyKeys: Set<string>
  teams: TeamRow[]
  /** One entry per model with at least one build still ahead of it — lib/schedule's answer,
   * not a second one. Absence from this map is what "no future builds" means. */
  futureByProductId: Map<string, FutureBuildSummary>
}

const EMPTY_SOURCE: MatrixSource = {
  products: [], feedTargetIds: [], jobs: [], sections: [], operations: [], modelOperations: [],
  operationTimes: [], operationTimeModels: [], stats: {}, combos: [], estimateOnlyKeys: new Set(), teams: [],
  futureByProductId: new Map(),
}

/**
 * A multi-select's ticked ids, remembered across a reload — lib/useLocalStorage's
 * usePersistedState underneath (the JSON sibling of the usePersistedFilter the selects use),
 * stored as an array because a Set does not survive JSON, and handed back as the Set the rest of
 * this screen already works in. Anything that isn't an array of strings reads as "nothing
 * ticked", which on this screen means "all".
 */
function usePersistedIdSet(key: string): [Set<string>, (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void] {
  const [stored, setStored] = usePersistedState<string[]>(key, [])
  const ids = useMemo(
    () => new Set(Array.isArray(stored) ? stored.filter((v): v is string => typeof v === 'string') : []),
    [stored],
  )
  const setIds = useCallback((next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setStored((prev) => {
      const before = new Set(Array.isArray(prev) ? prev : [])
      return [...(typeof next === 'function' ? next(before) : next)]
    })
  }, [setStored])
  return [ids, setIds]
}

export default function LabourMatrixClient({ lines, userId, role }: Props) {
  const supabase = useMemo(() => createClient(), [])

  const [lineId, setLineId] = usePersistedFilter('labourMatrix.lineId', '')
  /**
   * ── The build-line filter ─────────────────────────────────────────────────────────────
   *
   * Only meaningful — and only rendered — for a PRE-ASSEMBLY line. Chassis feeds every build
   * line, so its model list is all of theirs together, and neither Series (the same series name
   * appears on several build lines) nor Team (Chassis has one) can cut it back to "Caravans".
   * This can: it narrows the model ROWS to one of the build lines the selected line feeds.
   *
   * Rows only. The columns are the jobs that apply to whatever models are left, as always.
   * Persisted alongside Line and Series because it is the same kind of answer — "what was I
   * looking at" — and read only through `activeBuildLineId`, which drops a stored value the
   * current line doesn't offer.
   */
  const [buildLineId, setBuildLineId] = usePersistedFilter('labourMatrix.buildLineId', '')
  const [series, setSeries] = usePersistedFilter('labourMatrix.series', '')

  /**
   * ── The team filter ───────────────────────────────────────────────────────────────────
   *
   * MULTI-select, the same shape as the model filter below it and with the same rule: EMPTY MEANS
   * ALL. Comparing Team 1 against Team 2 is the question this screen gets asked, and a
   * single-select could only answer it one team at a time.
   *
   * PERSISTED (labourMatrix.teamIds), like every other control on this bar — a reload lands on
   * the view that was left. It used to be session-only, on the argument that a remembered subset
   * misleads whoever opens the page next; in practice the page is reopened by the person who set
   * it, and losing the view on every refresh was the real cost. The button states an active
   * subset in blue, which is what answers "why are there only two teams".
   *
   * The set is only ever read through `activeTeamIds`, which intersects it with what the CURRENT
   * line offers — so a stored id for a team that has since been deleted, or that belongs to
   * another line, cannot reach the grid. If none of them resolve the filter is simply off.
   */
  const [selectedTeamIds, setSelectedTeamIds] = usePersistedIdSet('labourMatrix.teamIds')
  const [teamPickerOpen, setTeamPickerOpen] = useState(false)
  /** The Teams button and its dropdown together — a press anywhere outside this closes it. */
  const teamPopRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!teamPickerOpen) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (teamPopRef.current && !teamPopRef.current.contains(e.target as Node)) setTeamPickerOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTeamPickerOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [teamPickerOpen])

  /**
   * Show, PERSISTED (labourMatrix.show). Read through `labourSource`, which accepts only the
   * three known keys — anything else in storage is "All". See the restore guard below the Show
   * split for the other half: a remembered Show that leaves this line with no columns at all is
   * dropped back to All when the line loads.
   */
  const [storedShow, setLabourSource] = usePersistedFilter('labourMatrix.show', 'all')
  const labourSource: LabourSource = LABOUR_SOURCES.some((x) => x.key === storedShow) ? (storedShow as LabourSource) : 'all'
  /** '' = every pre-assembly area. Only meaningful while labourSource === 'pre' — the same state,
   * with the same meaning, as /model-total's area chips. Persisted (labourMatrix.areaLineId) and
   * only ever read through `activeAreaLineId`, which drops an area the current rows don't offer. */
  const [areaLineId, setAreaLineId] = usePersistedFilter('labourMatrix.areaLineId', '')

  /**
   * ── The model filter ──────────────────────────────────────────────────────────────────
   *
   * MULTI-select, because the point of the grid is comparing a chosen handful of models side by
   * side; a single-select would collapse it to one row, which /model-total already does better.
   *
   * EMPTY MEANS ALL. Unticking the last model shows every model again rather than an empty
   * grid — "none selected" is the absence of a filter, not a filter that matches nothing, and a
   * blank grid would read as a broken screen.
   *
   * PERSISTED (labourMatrix.modelIds), and read only through `activeModelIds`, which intersects
   * it with the models the current Line + Build line + Series offer — a deleted model, or one
   * from a line since left, drops out, and if nothing is left the filter is off.
   */
  const [selectedModelIds, setSelectedModelIds] = usePersistedIdSet('labourMatrix.modelIds')
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelSearch, setModelSearch] = useState('')

  /**
   * ── Future builds only ────────────────────────────────────────────────────────────────
   *
   * ON by default. This screen exists to plan collection, and a model with nothing booked is
   * labour content nobody is going to need — 25 of the 101 models in the database, carried
   * across the grid as columns of figures that can't be acted on.
   *
   * "Future" means `chassis.dateonline >= today`, and that definition is lib/schedule's, shared
   * with /dashboard — see the fetch below. It is NOT despatchstatus (opaque ERP codes with no
   * documented meaning in this project) and NOT dateoffline (populated on every row including
   * builds booked into Dec 2026, so it is a PLAN, not a record of completion). Neither can be
   * read as "despatched", and nothing here tries to.
   */
  const [storedFutureOnly, setStoredFutureOnly] = usePersistedFilter('labourMatrix.futureOnly', '1')
  /** Persisted as '1' / '0'. Anything but an explicit '0' is the default, ON. */
  const futureOnly = storedFutureOnly !== '0'
  const setFutureOnly = (on: boolean) => setStoredFutureOnly(on ? '1' : '0')

  /** Job level is the default: it is the grain the figures are actually computed at, and the
   * one that answers "which job do I go and time". The coarser two are roll-ups of it. */
  const [storedGrain, setGrain] = usePersistedFilter('labourMatrix.grain', 'job')
  /** Persisted; an unrecognised stored value is Job. */
  const grain: Grain = GRAINS.some((g) => g.key === storedGrain) ? (storedGrain as Grain) : 'job'

  const [source, setSource] = useState<MatrixSource>(EMPTY_SOURCE)

  /**
   * Bumped by every write the cell drawer makes. It is in the fetch effect's dependency list, so
   * one increment re-reads the line and EVERY derived figure moves together — the cell, the row
   * total, the header counts, the coverage fraction and the grid total are all views over `source`,
   * so there is no way for one to update and another to lag. The drawer stays mounted across it.
   *
   * A whole-line re-read for one time entry is deliberate rather than economical: the alternative
   * is patching the eight arrays in place, which means this screen holding a second, incremental
   * implementation of what the fetch already computes — the exact duplication that makes two
   * numbers on one page disagree. /model-total's refreshTick works the same way.
   */
  const [refreshTick, setRefreshTick] = useState(0)
  const refreshMatrix = useCallback(() => setRefreshTick((t) => t + 1), [])

  const [lineSplit, setLineSplit] = useState<LineSplit | null>(null)
  const [loading, setLoading] = useState(false)
  /**
   * A re-read of a line whose grid is ALREADY on screen — a write from the cell drawer, never a
   * change of scope. Held apart from `loading` because the two need opposite treatments: a first
   * load has nothing to show and says so, whereas blanking a grid somebody is looking at (with a
   * drawer open over it) to say "Reading the line's models…" loses their place and reads as the
   * action having navigated somewhere. The rows stay put and swap underneath.
   */
  const [refreshing, setRefreshing] = useState(false)
  /** The line whose grid is currently rendered, so the effect can tell the two cases apart. */
  const loadedLineRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The is_pre_assembly rule, from lib/lines' cached topology — one load per session. Held as
  // the synchronous view because the Show filter asks it of every job inside a useMemo, not once
  // per await. Losing it leaves every job reading as line labour (see LineSplit's null rule), so
  // the filter degrades to "All" rather than to a blank grid.
  useEffect(() => {
    let cancelled = false
    loadLineSplit(supabase)
      .then((split) => { if (!cancelled) setLineSplit(split) })
      .catch((err) => console.error('[labour-matrix] could not load line topology:', err))
    return () => { cancelled = true }
  }, [supabase])

  /**
   * ── The whole grid, in eight reads ─────────────────────────────────────────────────────
   *
   * Keyed on the production line and NOTHING else. Series, team and the Show toggle never touch
   * the database: they are views over what is already here, so changing one is instant and
   * cannot produce a grid built from a different read than the one beside it.
   *
   * EVERY read below goes through lib/supabaseRead. That is not belt-and-braces on this screen,
   * it is the difference between a right answer and a quietly wrong one: a 101-model line has
   * tens of thousands of model_operations and operation_time_models rows, PostgREST caps a
   * response at 1000, and a capped response is a normal 200 with a short array. An unpaged read
   * here would not fail — it would draw a full grid with most of its cells silently zeroed.
   * That exact bug has been fixed twice in this codebase already (see the module note).
   *
   * Fan-out reads (one product id matching many rows) use fetchAllChunked, which chunks the
   * filter AND pages each chunk. Identity lookups by primary key use selectIn, which chunks
   * only — a chunk of 100 ids can return at most 100 rows, so the response cap is unreachable
   * by construction. The distinction is lib/chunkedIn's, not a judgement call made here.
   */
  useEffect(() => {
    if (!lineId) { setSource(EMPTY_SOURCE); setError(null); loadedLineRef.current = null; return }
    let cancelled = false
    const isCurrent = () => !cancelled

    // Quiet when this line's grid is already up: see `refreshing`.
    if (loadedLineRef.current === lineId) setRefreshing(true)
    else setLoading(true)
    setError(null)

    ;(async () => {
      try {
        // ── 1. The models ───────────────────────────────────────────────────────────────
        // modelsForLine, never `products.production_line_id = lineId`: a pre-assembly line owns
        // no products of its own and inherits the models of the build lines it feeds. The obvious
        // query returns an empty list for Chassis or Sew and looks like missing data. Paged
        // inside lib/lines.
        const products = await modelsForLine(supabase, lineId)
        // Off the same cached topology modelsForLine just read — no extra round trip.
        const feedTargetIds = await feedTargetsForLine(supabase, lineId)
        if (!isCurrent()) return
        const productIds = products.map((p) => p.id)
        if (productIds.length === 0) {
          setSource({ ...EMPTY_SOURCE, products, feedTargetIds })
          loadedLineRef.current = lineId
          return
        }

        // ── 2. The applies-list ─────────────────────────────────────────────────────────
        // Scoped by PRODUCT, not by the operation's line: an operation doesn't have to sit on the
        // same line as the model it applies to, and for imported data it usually doesn't. This is
        // what decides BLANK vs 0 in every cell, so a truncated read here would draw blanks over
        // real work. Ordered by the full primary key, which paging requires (see lib/supabaseRead
        // on why an unordered paged read repeats and skips rows).
        const modelOperations = await fetchAllChunked<PairRow>(
          productIds, READ_CHUNK,
          (chunk) => supabase
            .from('model_operations').select('operation_id, product_id').in('product_id', chunk)
            .order('operation_id').order('product_id'),
          { table: 'model_operations' },
        )
        if (!isCurrent()) return

        // ── 3. Recorded times, product-first ────────────────────────────────────────────
        // The same chain fetchModelTotal holds itself to: junction → times → operations, filtered
        // by product_id at the top and never re-narrowed by line. operation_times has no
        // product_id of its own; this junction is the only thing that ties a run to a model.
        const operationTimeModels = await fetchAllChunked<TimeModelRow>(
          productIds, READ_CHUNK,
          (chunk) => supabase
            .from('operation_time_models').select('operation_time_id, product_id').in('product_id', chunk)
            .order('operation_time_id').order('product_id'),
          { table: 'operation_time_models' },
        )
        if (!isCurrent()) return

        // FILTERED to current records. This screen shows figures and nothing about the history
        // behind them — no run counts, no archived counts — so archived rows would be fetched
        // only for currentForOperation to discard. superseded_by is still SELECTED: the helper
        // decides which row is the figure, and handing it rows without the column would have it
        // guess. Per lib/operationTimes, both inputs give the same `minutes`; only the history
        // count differs, and nothing here shows one.
        //
        // Retired (is_active = false) and hidden records are filtered AT THE QUERY, through
        // onlyCountedTimes: the matrix only aggregates, so it has no use for them. The flags are
        // still selected — the helpers' types require them — and currentForOperation and
        // computeCoverageCombos apply the same rule again. See the note atop lib/operationTimes.
        const timeIds = [...new Set(operationTimeModels.map((tm) => tm.operation_time_id))]
        const operationTimes = await fetchAllChunked<TimeRow>(
          timeIds, READ_CHUNK,
          (chunk) => onlyCountedTimes(supabase
            .from('operation_times').select(`id, operation_id, total_minutes, superseded_by, chassis_id, is_estimated, ${TIME_FLAG_COLUMNS}`)
            .in('id', chunk).is('superseded_by', null))
            .order('id') as unknown as RangeableQuery<TimeRow>,
          { table: 'operation_times' },
        )
        if (!isCurrent()) return

        // ── 4. Operations, to reach their jobs ──────────────────────────────────────────
        // The union of what the models REQUIRE and what they have TIMED. The two can drift — a
        // run whose applies-list row was removed elsewhere still counts minutes — and an
        // operation set built from either half alone would lose one of those cases.
        //
        // is_active = true, matching fetchModelTotal hop 3 exactly: a retired operation has had
        // its times moved onto its keeper by the merge, so it contributes nothing, and excluding
        // it here is what keeps this screen's totals identical to /model-total's.
        const opIds = [...new Set([
          ...modelOperations.map((mo) => mo.operation_id),
          ...operationTimes.map((t) => t.operation_id),
        ])]
        const linkedOperations = await selectIn<OperationRow>(opIds, async (chunk) => {
          const res = await supabase
            .from('operations').select('id, job_id').in('id', chunk).eq('is_active', true)
          if (res.error) logSupabaseError('labour-matrix — operations WHERE id IN (…) AND is_active', res.error)
          return res
        })
        if (!isCurrent()) return

        // ── 5. Jobs: the columns themselves ─────────────────────────────────────────────
        // Identity lookup by id, NOT filtered to is_active in the query — is_active is selected
        // and the retired jobs are dropped explicitly just below, together with their
        // operations, so a retired job's column disappears whole rather than surviving with a
        // blank heading. See the note atop lib/jobs.
        // section_id and production_line_id come down because they are what the grain roll-up
        // and the Show filter split the columns on. team_id does NOT — see JobRow.
        const jobIds = [...new Set(linkedOperations.map((o) => o.job_id).filter(Boolean))]
        const readJobs = await selectIn<JobRow>(jobIds, async (chunk) => {
          const res = await supabase
            .from('jobs').select('id, name, section_id, production_line_id, is_active').in('id', chunk)
          if (res.error) logSupabaseError('labour-matrix — jobs WHERE id IN (…)', res.error)
          return res
        })
        if (!isCurrent()) return

        // A RETIRED job is not a column. A job can be is_active = false while its operations
        // stay active and linked to models — the operations filter above can't catch that — and
        // /setup and /collect hide such a job, so this grid and its printout do too. It is
        // dropped HERE, with its operations, before anything is computed: cells, row totals,
        // coverage and the printed sheet all read `jobs` and `operations`, so none of them can
        // count it, and they still reconcile with each other and with /model-total, which applies
        // the same rule. An operation whose job row didn't come back at all is kept, as before.
        const retiredJobIds = new Set(readJobs.filter((j) => !j.is_active).map((j) => j.id))
        const jobs = readJobs.filter((j) => j.is_active)
        const operations = linkedOperations.filter((o) => !retiredJobIds.has(o.job_id))

        // ── 6. Sections: the middle of the hierarchy ────────────────────────────────────
        // The SECTION-grain column labels, and the only route from a job to a team. One read,
        // once, for all three grains — switching grain re-groups what is already in memory and
        // issues nothing. Identity lookup by id, so selectIn (chunked, cap unreachable), and
        // deliberately not filtered to is_active: a merged-away section still labels the jobs
        // that point at it, exactly as a retired job still labels its operations.
        const sectionIds = [...new Set(jobs.map((j) => j.section_id).filter((id): id is string => !!id))]
        const sections = await selectIn<SectionRow>(sectionIds, async (chunk) => {
          const res = await supabase.from('sections').select('id, name, team_id, sort_order').in('id', chunk)
          if (res.error) logSupabaseError('labour-matrix — sections WHERE id IN (…)', res.error)
          return res
        })
        if (!isCurrent()) return

        // ── 7. The build schedule ───────────────────────────────────────────────────────
        // fetchFutureBuilds is /dashboard's own derivation of "upcoming" (lib/schedule), scoped
        // to this line's models so the `dateonline >= today` comparison happens in the database
        // over this line's chassis rather than over all 5,660 of them. Reused rather than
        // rewritten: two screens holding two definitions of "still to be built" is two answers
        // to one question, and the date boundary here is subtle enough on its own — the window
        // opens on the LOCAL calendar day, so it moves at Melbourne midnight, not UTC's.
        //
        // Chunked and paged inside the helper via lib/supabaseRead: 653 future rows today across
        // the fleet, and an unpaged read would stop at 1,000 as an ordinary 200 with a short
        // array — silently marking the models past the cap as having nothing booked.
        const future = await fetchFutureBuilds(supabase, productIds)
        if (!isCurrent()) return

        // ── 8. Teams, to name the filter's options ──────────────────────────────────────
        // Whole table, paged. Tiny today; paged anyway, for the reason in page.tsx.
        // Every team, NOT only this line's — the Team-grain column labels are looked up in here,
        // and a job that reaches this grid from a pre-assembly team has to be nameable even though
        // that team is not on offer in the filter. Scoping the READ to the line would have turned
        // those columns into "Unknown team". The filter does its own scoping (see teamOptions).
        const teams = await fetchAllRows<TeamRow>(
          () => supabase.from('teams').select('id, name, production_line_id').order('name'),
          { table: 'teams' },
        )
        if (!isCurrent()) return

        // ── 9 & 10. The two shared rules, applied once over everything above ────────────
        // Neither is computed here. currentForOperation returns the labour figure per
        // (operation, product) pair; computeCoverageCombos returns one (job, model) combo per
        // pair declared through model_operations, flagged covered where a time exists. Every
        // cell below is an addition over these two answers and nothing else.
        const stats = currentForOperation(operationTimes, operationTimeModels)
        const combos = computeCoverageCombos({
          operations,
          modelOperations,
          operationTimes,
          operationTimeModels,
        })
        // Alongside coverage, not instead of it: which covered combos would be gaps again
        // without the estimates. Same rows, same countsTowardLabour underneath.
        const estimateOnlyKeys = estimateOnlyComboKeys(combos, { operations, operationTimes, operationTimeModels })

        if (!isCurrent()) return
        setSource({
          products, feedTargetIds, jobs, sections, operations, modelOperations,
          operationTimes, operationTimeModels, stats, combos, estimateOnlyKeys, teams,
          futureByProductId: future.byProductId,
        })
        loadedLineRef.current = lineId
      } catch (err) {
        if (!isCurrent()) return
        console.error('[labour-matrix] grid read failed:', err)
        setError(err instanceof Error ? err.message : 'Could not load the matrix')
        setSource(EMPTY_SOURCE)
        loadedLineRef.current = null
      } finally {
        if (isCurrent()) { setLoading(false); setRefreshing(false) }
      }
    })()

    return () => { cancelled = true }
    // refreshTick: a write from the cell drawer re-reads the line — see its declaration.
  }, [supabase, lineId, refreshTick])

  // ── The filters, as in-memory views ────────────────────────────────────────────────────

  /** Whether the selected line inherits its models — lib/lines' rule, via the cached topology.
   * This, not the length of the feed list, is what shows the Build line filter: a pre-assembly
   * line with nothing configured is still one, and a build line never is. */
  const isPreAssemblyLine = lineSplit?.isPreAssembly(lineId) ?? false

  /** The build lines the selected line feeds, named and A–Z. Empty for a normal build line. */
  const buildLineOptions = useMemo(() => {
    if (!isPreAssemblyLine) return []
    return source.feedTargetIds
      .map((id) => ({ id, name: lines.find((l) => l.id === id)?.name ?? 'Unknown line' }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [isPreAssemblyLine, source.feedTargetIds, lines])

  /** The stored build line, if the current line offers it — otherwise not set. Same guard, for
   * the same reason, as activeSeries below. */
  const activeBuildLineId = buildLineOptions.some((b) => b.id === buildLineId) ? buildLineId : ''

  /**
   * The line's models, cut to the chosen build line. Everything downstream that used to read
   * `source.products` for the ROWS reads this instead — the series list, the model picker and
   * the grid — so Series filters within the build line and offers only series present in it.
   *
   * Filtering by `production_line_id` here is safe in the way lib/lines warns a re-filter by the
   * SELECTED line is not: for a pre-assembly line each row carries the build line it really
   * belongs to, and that is exactly the id being asked for.
   */
  const lineProducts = useMemo(
    () => (activeBuildLineId
      ? source.products.filter((p) => p.production_line_id === activeBuildLineId)
      : source.products),
    [source.products, activeBuildLineId],
  )

  /** Every series present on the line (and build line, when one is chosen), A–Z. Models with no
   * series land under '(no series)' and are reachable — a model that can't be filtered to is a
   * model nobody checks. */
  const seriesOptions = useMemo(() => {
    const set = new Set<string>()
    for (const p of lineProducts) set.add(p.product_series?.trim() || '(no series)')
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [lineProducts])

  /**
   * The persisted series and team are remembered across reloads, but they are remembered
   * per-browser and the LINE can change underneath them — "Sew Team 2" means nothing on the
   * Campervan line, and a stored value with no matching <option> leaves the select displaying
   * "All teams" while the grid is filtered to nothing by a value only the state knows about.
   * So a stored filter that isn't on offer is treated as not set, everywhere: the select, the
   * columns and the printed header all read the same resolved value.
   */
  const activeSeries = seriesOptions.includes(series) ? series : ''

  /**
   * Every model the current Line + Build line + Series selection offers — what the picker lists, and the
   * denominator of "12 of 29". The model filter narrows THIS, so it is always a subset of what
   * the other two filters already chose.
   *
   * Labelled and ordered by products.model, NEVER product_code. Several past bugs came from
   * showing the code: two models can share a code family, the code is not what anyone on the
   * floor calls the van, and a matrix row labelled with one is a row nobody can place.
   */
  const modelCandidates = useMemo(() => {
    const rows = activeSeries
      ? lineProducts.filter((p) => (p.product_series?.trim() || '(no series)') === activeSeries)
      : lineProducts
    return [...rows].sort((a, b) => a.model.localeCompare(b.model))
  }, [lineProducts, activeSeries])

  /**
   * The selection intersected with what is actually on offer — the same guard activeSeries and
   * activeTeamIds carry, and the one that makes "reset on Line/Series change" impossible to get
   * wrong. The handlers clear the set when either changes so the picker reads honestly, but even
   * if one were missed, a model id from another line cannot reach the grid: it isn't a candidate,
   * so it is not in here, and the grid is built from here.
   */
  const activeModelIds = useMemo(() => {
    const ids = new Set<string>()
    for (const p of modelCandidates) if (selectedModelIds.has(p.id)) ids.add(p.id)
    return ids
  }, [modelCandidates, selectedModelIds])

  /** Whether this model has a build booked from today onwards — membership of lib/schedule's
   * map, never a date compared here. */
  const hasFutureBuild = useCallback(
    (productId: string) => source.futureByProductId.has(productId),
    [source.futureByProductId],
  )

  /**
   * ── The rows, and the one interaction worth getting right ─────────────────────────────
   *
   * AN EXPLICIT PICK BEATS A BLANKET FILTER. If someone has ticked models by name, those models
   * are what they asked to compare, and "future builds only" does not get to quietly remove one
   * of them — the toggle is a default about models nobody chose, not a veto over models someone
   * did. So the two filters are ordered, not combined:
   *
   *   models ticked   → exactly those, schedule ignored
   *   nothing ticked  → every candidate, narrowed by the toggle
   *
   * The alternative (intersecting them) fails silently in the worst way: you search for a model,
   * tick it, and it isn't in the grid, with nothing saying why. Where the override actually bites
   * — a ticked model with nothing booked — it is named on screen and on the printed sheet rather
   * than left to be noticed. See scheduleOverrides below.
   */
  const visibleProducts = useMemo(() => {
    if (activeModelIds.size > 0) return modelCandidates.filter((p) => activeModelIds.has(p.id))
    if (!futureOnly) return modelCandidates
    return modelCandidates.filter((p) => hasFutureBuild(p.id))
  }, [modelCandidates, activeModelIds, futureOnly, hasFutureBuild])

  /** Ticked models that the schedule filter would have removed, and didn't. Empty unless both
   * filters are actually in play, which is the only time the override is worth a word. */
  const scheduleOverrides = useMemo(
    () => (futureOnly && activeModelIds.size > 0
      ? visibleProducts.filter((p) => !hasFutureBuild(p.id))
      : []),
    [futureOnly, activeModelIds, visibleProducts, hasFutureBuild],
  )

  /** How many of the current candidates are booked — the toggle's own denominator, so the
   * control can say what it will cost before it is pressed. */
  const futureCandidateCount = useMemo(
    () => modelCandidates.filter((p) => hasFutureBuild(p.id)).length,
    [modelCandidates, hasFutureBuild],
  )

  /** What the picker lists: the candidates narrowed by the search box. Matches on the MODEL
   * name only — never product_code, which is not what the list is labelled by and would let a
   * search hit a row whose visible text doesn't contain the query. */
  const pickerProducts = useMemo(() => {
    const q = modelSearch.trim().toLowerCase()
    if (!q) return modelCandidates
    return modelCandidates.filter((p) => p.model.toLowerCase().includes(q))
  }, [modelCandidates, modelSearch])

  function toggleModel(product: Product, isSelected: boolean) {
    setSelectedModelIds((prev) => {
      const next = new Set(prev)
      if (isSelected) next.delete(product.id)
      else next.add(product.id)
      return next
    })
  }

  /** The picker's per-series select-all. `allSelected` is which way the header button should
   * go, decided by the component from the set it was handed. */
  function toggleModelSeries(_series: string, seriesProducts: Product[], allSelected: boolean) {
    setSelectedModelIds((prev) => {
      const next = new Set(prev)
      for (const p of seriesProducts) {
        if (allSelected) next.delete(p.id)
        else next.add(p.id)
      }
      return next
    })
  }

  /** Line and Series both re-scope the model list, so both drop the selection rather than
   * leaving models ticked that no longer apply. */
  function resetModelFilter() {
    setSelectedModelIds(new Set())
    setModelSearch('')
  }

  /**
   * The (operation, product) pairs that have a recorded time, rebuilt from the two junction
   * arrays the fetch already holds — operation_times gives time → operation, and
   * operation_time_models gives time → model. operation_times has no product_id of its own;
   * this join is the only thing that ties a run to a model, and it is the same one
   * currentForOperation performs internally over the same rows.
   */
  const timedPairs = useMemo(() => {
    const opByTimeId = new Map(source.operationTimes.map((t) => [t.id, t.operation_id]))
    const out: { operationId: string; productId: string }[] = []
    for (const tm of source.operationTimeModels) {
      const operationId = opByTimeId.get(tm.operation_time_id)
      // A junction row whose time didn't come back is a SUPERSEDED run (the fetch filters to
      // current records) or a deleted one. Either way it has no figure, and skipping it here is
      // what keeps an archived run from being counted as a timed operation.
      if (operationId) out.push({ operationId, productId: tm.product_id })
    }
    return out
  }, [source.operationTimes, source.operationTimeModels])

  /**
   * Team → Section → Job, resolved once. `sectionOf` and `teamOf` are the ONLY route from a job
   * to either level — the Team filter, the Section-grain columns and the Team-grain columns all
   * ask these, so the three cannot disagree about where a job belongs.
   *
   * Via sections.team_id, never jobs.team_id. The latter is legacy and is not even selected.
   */
  const hierarchy = useMemo(() => {
    const sectionById = new Map(source.sections.map((s) => [s.id, s]))
    const sectionOf = new Map<string, SectionRow | null>()
    const teamIdOf = new Map<string, string | null>()
    for (const j of source.jobs) {
      const section = j.section_id ? sectionById.get(j.section_id) ?? null : null
      sectionOf.set(j.id, section)
      teamIdOf.set(j.id, section?.team_id ?? null)
    }
    return { sectionOf, teamIdOf }
  }, [source.jobs, source.sections])

  /**
   * What the Team picker offers: teams ON THE SELECTED LINE that also own a column on this grid.
   * Both halves matter, and for different reasons.
   *
   * SCOPED TO THE LINE (teams.production_line_id) — this is the fix for a picker that listed
   * teams from every line in the business. The jobs on this grid are not this line's jobs: they
   * are the jobs whose operations apply to this line's MODELS, which on a build line pulls in
   * every pre-assembly team that feeds it and, in imported data, jobs sitting on other lines
   * entirely. "Every team that owns a job here" is therefore not a line-scoped list, and asking
   * the jobs was the mistake. A team belongs to exactly one line and says so on its own row.
   *
   * AND PRESENT ON THE GRID — kept from before. A picker offering a team with no column empties
   * the grid, and a picker that can empty the grid is one people learn not to touch.
   *
   * Computed BEFORE the filter is applied, so ticking a team never shortens the list it was
   * ticked from.
   */
  const teamOptions = useMemo(() => {
    const present = new Set<string>()
    for (const j of source.jobs) {
      const jobTeamId = hierarchy.teamIdOf.get(j.id)
      if (jobTeamId) present.add(jobTeamId)
    }
    return source.teams.filter((t) => t.production_line_id === lineId && present.has(t.id))
  }, [source.jobs, source.teams, hierarchy, lineId])

  /**
   * The selection intersected with what is on offer — the team counterpart of `activeModelIds`,
   * and the same guarantee: the handlers clear the set when the line changes, but even if one
   * were missed, a team id from another line is not an option, so it is not in here, and the grid
   * is built from here. Empty = every team, which is what "no filter" means.
   */
  const activeTeamIds = useMemo(() => {
    const ids = new Set<string>()
    for (const t of teamOptions) if (selectedTeamIds.has(t.id)) ids.add(t.id)
    return ids
  }, [teamOptions, selectedTeamIds])

  function toggleTeam(id: string) {
    setSelectedTeamIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** The line re-scopes the team list, so changing it drops the selection rather than leaving
   * teams ticked that belong to a line nobody is looking at. */
  function resetTeamFilter() {
    setSelectedTeamIds(new Set())
  }

  /**
   * The jobs past Show and Team, A–Z — the columns, before the area chips narrow them further
   * (see visibleJobs, below `cells`).
   *
   * The Show split asks lineSplit.isPreAssembly of the JOB's production_line_id — the same
   * question, of the same cached topology, that /model-total's toggle asks. A job on no line at
   * all counts as line labour (LineSplit's documented null rule), which keeps it visible under
   * one half of a split that is meant to partition everything rather than vanishing from both.
   */
  const sourceJobs = useMemo(() => {
    return source.jobs
      .filter((j) => {
        // Empty selection = every team, so the test is only applied when something is ticked.
        // A job with no team at all (no section, or a section with no team) is excluded by a team
        // filter for the same reason it gets its own "No team" column: it belongs to none of the
        // teams that were asked for.
        if (activeTeamIds.size > 0) {
          const jobTeamId = hierarchy.teamIdOf.get(j.id)
          if (!jobTeamId || !activeTeamIds.has(jobTeamId)) return false
        }
        if (labourSource === 'all') return true
        const isPre = lineSplit?.isPreAssembly(j.production_line_id) ?? false
        return labourSource === 'pre' ? isPre : !isPre
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [source.jobs, activeTeamIds, labourSource, lineSplit, hierarchy])

  /**
   * ── The restore guard for Show ────────────────────────────────────────────────────────
   *
   * Teams, Models and the area chip are each read through an intersection with what is on offer,
   * so a stale stored value there turns itself off. Show has no such list to intersect with: a
   * remembered "Pre-assembly" on a line with no pre-assembly work is a valid value that matches
   * nothing, and the grid would open with no columns and nothing saying why.
   *
   * So when a line's data ARRIVES and the remembered Show leaves it without a single column,
   * Show goes back to All (and the area chip with it). Keyed on the load, not on the toggle: a
   * click that empties the grid is somebody's own action and stays put — this only refuses to
   * OPEN on nothing. Waits for lineSplit, without which every job reads as line labour and
   * Pre-assembly would look empty on every line.
   */
  const sourceJobCountRef = useRef(0)
  sourceJobCountRef.current = sourceJobs.length
  const labourSourceRef = useRef(labourSource)
  labourSourceRef.current = labourSource
  useEffect(() => {
    if (!lineSplit || source.jobs.length === 0) return
    if (labourSourceRef.current !== 'all' && sourceJobCountRef.current === 0) {
      setLabourSource('all')
      setAreaLineId('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.jobs, lineSplit])

  /**
   * ── The grid ───────────────────────────────────────────────────────────────────────────
   *
   * One pass over the applies-list and one over the timed pairs, into a map keyed
   * `jobId:productId`. No per-cell lookup, no per-model query, nothing quadratic: 101 models ×
   * 90 jobs is ~9,000 cells, and they are filled by walking the two junction tables once each.
   *
   * Operation ids are held in Sets rather than counted as they arrive, because both inputs can
   * present the same (operation, model) pair more than once — an operation linked to a model
   * through two rows, or a model with several time rows for one operation — and a count would
   * double. The figure is added once per pair, from the stat the shared helper already picked.
   */
  const cells = useMemo(() => {
    const jobIdByOp = new Map(source.operations.map((o) => [o.id, o.job_id]))

    // Which current records are estimates — asked of the record the shared helper PICKED
    // (stat.currentId), never decided here, so the colour describes the very figure in the cell.
    const estimatedTimeIds = new Set(source.operationTimes.filter((t) => t.is_estimated).map((t) => t.id))

    interface Acc { minutes: number; timed: Set<string>; required: Set<string>; estimated: number }
    const acc = new Map<string, Acc>()
    const get = (jobId: string, productId: string): Acc => {
      const key = `${jobId}:${productId}`
      let a = acc.get(key)
      if (!a) { a = { minutes: 0, timed: new Set(), required: new Set(), estimated: 0 }; acc.set(key, a) }
      return a
    }

    // Pass 1 — what applies. This is what separates a BLANK cell from a red 0.
    for (const mo of source.modelOperations) {
      const jobId = jobIdByOp.get(mo.operation_id)
      if (!jobId) continue
      get(jobId, mo.product_id).required.add(mo.operation_id)
    }

    // Pass 2 — what is timed.
    //
    // The (operation, product) pairs are enumerated from `operations` × `modelOperations` and
    // from the timed pairs together, and each is ASKED OF the shared stats map by its own key
    // function rather than read out of it by parsing keys. operationProductKey builds the key;
    // nothing here needs to know that it is two UUIDs and a colon, and a screen that took that
    // apart would break silently the day the helper changed its mind about the separator.
    //
    // `timedPairs` is rebuilt from the same two arrays currentForOperation was handed, so a pair
    // can only reach here if the helper has a figure for it — operationTimes was filtered to
    // current records, so a superseded run's junction row resolves to no stat and falls out. A
    // HIDDEN run falls out the same way: currentForOperation gives its pair no stat, so the
    // `if (!stat) continue` below is what keeps it out of timedOps and minutes.
    for (const { operationId, productId } of timedPairs) {
      const stat = source.stats[operationProductKey(operationId, productId)]
      if (!stat) continue
      const jobId = jobIdByOp.get(operationId)
      if (!jobId) continue
      const a = get(jobId, productId)
      // Once per pair. A model can have several junction rows pointing at one operation, and the
      // figure is the operation's, not one per row.
      if (a.timed.has(operationId)) continue
      a.timed.add(operationId)
      a.minutes += stat.minutes
      if (estimatedTimeIds.has(stat.currentId)) a.estimated += 1
    }

    // Applicability comes from the shared combos, not from `required.size` — same answer today,
    // but coverage.ts owns the definition of "this job applies to this model" and this screen
    // must not hold a second one that could drift from it.
    const appliesKeys = new Set(source.combos.map((c) => `${c.jobId}:${c.productId}`))

    const out = new Map<string, MatrixCell>()
    for (const [key, a] of acc) {
      const union = new Set([...a.required, ...a.timed])
      out.set(key, {
        minutes: a.minutes,
        timedOps: a.timed.size,
        totalOps: union.size,
        // `|| a.timed.size > 0` is the drift case /model-total also honours: a model with
        // recorded minutes for a job whose applies-list row was removed elsewhere still counts
        // those minutes in its total, so the cell has to show them rather than print a blank
        // over a number that is in the row total beside it.
        applies: appliesKeys.has(key) || a.timed.size > 0,
        estimatedOps: a.estimated,
      })
    }
    return out
  }, [source.operations, source.modelOperations, source.operationTimes, source.stats, source.combos, timedPairs])

  /**
   * ── The area chips ────────────────────────────────────────────────────────────────────
   *
   * Under Show = Pre-assembly the columns come from several areas at once — Lamination, Chassis
   * and Sew sections side by side as flat peers, with nothing saying which is whose. The chips
   * restrict the COLUMNS to one area, exactly as /model-total's do for its breakdown.
   *
   * Which areas are offered follows /model-total's rule, widened from one model to the rows on
   * screen: a pre-assembly line gets a chip only if one of its jobs applies to (or has a time
   * for) a model currently in the grid. So a chip always narrows to something, and choosing a
   * build line that Sew does no work for takes the Sew chip away with it.
   *
   * Derived from `sourceJobs` — past Show and Team, BEFORE the area filter — so picking a chip
   * never shortens the row it was picked from.
   */
  const preAssemblyAreas = useMemo(() => {
    if (labourSource !== 'pre' || !lineSplit) return []
    const ids = new Set<string>()
    for (const j of sourceJobs) {
      const jobLineId = j.production_line_id
      if (!jobLineId || ids.has(jobLineId) || !lineSplit.isPreAssembly(jobLineId)) continue
      if (visibleProducts.some((p) => cells.get(`${j.id}:${p.id}`)?.applies)) ids.add(jobLineId)
    }
    return [...ids]
      .map((id) => ({ id, name: lineSplit.name(id) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [labourSource, lineSplit, sourceJobs, visibleProducts, cells])

  /** The chosen area, if it is still on offer — a chip that has gone (different rows, Show
   * changed) reads as "All areas" rather than filtering by an id nothing matches. */
  const activeAreaLineId = preAssemblyAreas.some((a) => a.id === areaLineId) ? areaLineId : ''

  /** The columns' jobs: past Show, Team and the area chip. Everything below — columns, row
   * totals, coverage, the printed sheet — reads this, so they all narrow together. */
  const visibleJobs = useMemo(
    () => (activeAreaLineId
      ? sourceJobs.filter((j) => j.production_line_id === activeAreaLineId)
      : sourceJobs),
    [sourceJobs, activeAreaLineId],
  )

  /**
   * ── The columns, at the selected grain ────────────────────────────────────────────────
   *
   * A grouping of `visibleJobs` and nothing else — so every filter that narrowed the jobs
   * (Show, Team) has already been applied before a column exists, at every grain.
   */
  const columns: MatrixColumn[] = useMemo(() => {
    // ── Under Show = Pre-assembly the columns are ORDERED BY AREA ──────────────────────────
    // Area A–Z, then the section's sort_order within the area. sort_order is a per-line
    // sequence, so sorting on it alone interleaves Lamination's "Stage 1" with Chassis's and
    // Sew's sections — numerically adjacent, and nothing to do with each other. A job's area is
    // the line it sits on, the same attribution the Show split and the area chips use.
    const byArea = labourSource === 'pre'
    const areaIdOf = (j: JobRow) => (byArea ? j.production_line_id : null)
    const areaName = (id: string | null) => (id ? lineSplit?.name(id) ?? '' : '')
    const teamName = (section: SectionRow | null) => (section?.team_id
      ? source.teams.find((tm) => tm.id === section.team_id)?.name ?? 'Unknown team'
      : 'No team')

    interface Built {
      col: MatrixColumn; section: SectionRow | null; none: boolean
      /** The team the column sits in (its section's), named for sorting. Null = no team. */
      team: { id: string; name: string } | null
    }
    const teamOf = (section: SectionRow | null) => (section?.team_id
      ? { id: section.team_id, name: teamName(section) }
      : null)
    const built: Built[] = []

    if (grain === 'job') {
      for (const j of visibleJobs) {
        const section = hierarchy.sectionOf.get(j.id) ?? null
        built.push({
          col: {
            key: j.id, label: j.name, jobIds: [j.id], areaId: areaIdOf(j),
            parent: { key: section?.id ?? NO_SECTION, label: section?.name ?? 'No section' },
          },
          section,
          none: false,
          team: teamOf(section),
        })
      }
    } else {
      const byKey = new Map<string, Built>()
      for (const j of visibleJobs) {
        const section = hierarchy.sectionOf.get(j.id) ?? null
        const areaId = areaIdOf(j)
        const base = grain === 'section'
          ? (section?.id ?? NO_SECTION)
          : (section?.team_id ?? NO_TEAM)
        // Keyed by area as well while the columns are grouped by it, so a column sits under
        // exactly one area heading. A section's jobs normally all share a line and the prefix
        // changes nothing; one that straddles two is two columns rather than one column filed
        // under whichever area its first job happened to be on.
        const key = areaId ? `${areaId}|${base}` : base
        const label = grain === 'section' ? (section?.name ?? 'No section') : teamName(section)
        let b = byKey.get(key)
        if (!b) {
          b = {
            col: {
              key, label, jobIds: [], areaId,
              parent: grain === 'section'
                ? { key: section?.team_id ?? NO_TEAM, label: teamName(section) }
                : null,
            },
            section: grain === 'section' ? section : null,
            // The "doesn't reach the hierarchy" buckets — real, and not what anyone looks for first.
            none: base === NO_SECTION || base === NO_TEAM,
            team: teamOf(section),
          }
          byKey.set(key, b)
        }
        b.col.jobIds.push(j.id)
      }
      built.push(...byKey.values())
    }

    // Job grain is sorted too, in every Show state: the parent header row spans a section's jobs,
    // and it can only span them if they sit together. A–Z within the section.
    return built.sort((a, b) => {
      if (byArea && a.col.areaId !== b.col.areaId) {
        return areaName(a.col.areaId).localeCompare(areaName(b.col.areaId))
          || (a.col.areaId ?? '').localeCompare(b.col.areaId ?? '')
      }
      // TEAM NEXT, A–Z, at every grain — before the section sequence, not after it. sort_order
      // is not unique across teams (Running Gear's sections run 1–6 and Chassis Build's 1–3 on
      // the same line), so sorting on it alone interleaves the two teams' sections and the team
      // heading above them fragments into a run per interleaving. Team first makes each team
      // one contiguous block. No team last.
      if ((a.team?.id ?? '') !== (b.team?.id ?? '')) {
        if (!a.team || !b.team) return a.team ? -1 : 1
        return a.team.name.localeCompare(b.team.name) || a.team.id.localeCompare(b.team.id)
      }
      if (a.none !== b.none) return a.none ? 1 : -1
      // THEN PRODUCTION SEQUENCE within the team: sort_order, then name — lib/sections'
      // compareSections, shared with every other section list. At Section grain and at Job grain,
      // so a section's jobs read together in the team's order (a job with no section last). The
      // printed sheet is built from this same array, so screen and paper cannot disagree.
      if (grain !== 'team') {
        if (a.section && b.section) {
          const bySection = compareSections(a.section, b.section)
          if (bySection !== 0) return bySection
        } else if (a.section || b.section) {
          return a.section ? -1 : 1
        }
      }
      return a.col.label.localeCompare(b.col.label)
    }).map((b) => b.col)
  }, [grain, visibleJobs, hierarchy, source.teams, labourSource, lineSplit])

  /**
   * ── The area header row ───────────────────────────────────────────────────────────────
   *
   * Shown under Show = Pre-assembly with the chip on "All areas" — the one state where columns
   * from several areas sit side by side. With a single area chosen every column is that area and
   * the chip already says so, so the row is omitted rather than repeated.
   *
   * `areaSpansOf` is run over whatever slice of `columns` is being rendered: the whole array on
   * screen, one band at a time on paper — an area cut by a band boundary is headed on both sheets.
   */
  const showAreaHeader = labourSource === 'pre' && !activeAreaLineId
  const areaSpansOf = useCallback((cols: MatrixColumn[]): AreaSpan[] => {
    const spans: AreaSpan[] = []
    for (const col of cols) {
      const last = spans[spans.length - 1]
      if (last && last.areaId === (col.areaId ?? '')) last.span += 1
      else spans.push({ areaId: col.areaId ?? '', name: lineSplit?.name(col.areaId) ?? '', span: 1 })
    }
    return spans
  }, [lineSplit])
  const areaSpans = useMemo(
    () => (showAreaHeader ? areaSpansOf(columns) : []),
    [showAreaHeader, areaSpansOf, columns],
  )

  /**
   * ── The parent header row ─────────────────────────────────────────────────────────────
   *
   * One level up from the columns: the SECTION over each run of jobs, the TEAM over each run of
   * sections. Team grain has nothing above it here (the area row, when on, already is that), so
   * the row is omitted.
   *
   * A parent is headed once per stretch of adjacent columns, and the sort above (area → team →
   * section → job) is what makes that once per section at Job grain and once per team at Section
   * grain. A run never crosses an area boundary — the area row sits above this one, and a parent
   * cell straddling two area cells would belong to both.
   *
   * Run over a slice like `areaSpansOf`: a parent cut by a print band is headed on both sheets.
   */
  const showParentHeader = grain !== 'team'
  const parentSpansOf = useCallback((cols: MatrixColumn[]): ParentSpan[] => {
    const spans: ParentSpan[] = []
    for (const col of cols) {
      const key = `${col.areaId ?? ''}|${col.parent?.key ?? ''}`
      const last = spans[spans.length - 1]
      if (last && last.key === key) last.span += 1
      else spans.push({ key, label: col.parent?.label ?? '', span: 1 })
    }
    return spans
  }, [])
  const parentSpans = useMemo(
    () => (showParentHeader ? parentSpansOf(columns) : []),
    [showParentHeader, parentSpansOf, columns],
  )
  /** How many header rows are stacked — what Model and Total span to keep their corners. */
  const headerRows = 1 + (showAreaHeader ? 1 : 0) + (showParentHeader ? 1 : 0)
  const parentNoun = grain === 'job' ? 'Section' : 'Team'

  /**
   * ── The roll-up ───────────────────────────────────────────────────────────────────────
   *
   * THE rule this whole feature turns on: the job-level figures are computed ONCE, in `cells`
   * above, and the coarser grains are sums of them. There is no second aggregation path, no
   * second query and no per-grain derivation — at job grain this function returns `cells`
   * itself, unmodified, which is the strongest statement available that the three views are one
   * computation seen at three depths.
   *
   * What is summed, and why it is enough:
   *   minutes   plain addition. A section is the sum of its jobs; a team the sum of its
   *             sections, which is the same set of jobs, so both are the same addition over the
   *             same leaves — associativity does the rest, and the three grains cannot disagree.
   *   timedOps  \ summed too, so that the SHARED jobCompleteness rule decides the colour at
   *   totalOps  / every grain instead of a second, coarser rule written beside it:
   *                Σtimed = 0                → 'none'   — nothing timed anywhere beneath
   *                Σtimed = Σtotal           → 'timed'  — every applicable job beneath is full
   *                                                       (sums are equal only if every term is,
   *                                                       since timed ≤ total for each job)
   *                otherwise                 → 'partial'
   *             which is exactly the three states a coarse cell is specified to have.
   *   applies   OR. A column applies to a model if ANY job beneath it does; if none does there
   *             is no entry, and the cell renders blank rather than 0.
   *
   * `partial` becomes the common state as the grain coarsens — a team of twenty jobs with three
   * timed is partial, and that is correct rather than a rounding of it up to green. It is why
   * partial carries an underline and an asterisk and not only a colour.
   */
  const columnCells = useMemo(() => {
    // Job grain IS the job-level computation. Returned by identity, not rebuilt.
    if (grain === 'job') return cells

    const out = new Map<string, MatrixCell>()
    for (const col of columns) {
      for (const p of visibleProducts) {
        let minutes = 0
        let timedOps = 0
        let totalOps = 0
        let applies = false
        let estimatedOps = 0
        for (const jobId of col.jobIds) {
          const cell = cells.get(`${jobId}:${p.id}`)
          if (!cell || !cell.applies) continue
          applies = true
          minutes += cell.minutes
          timedOps += cell.timedOps
          totalOps += cell.totalOps
          estimatedOps += cell.estimatedOps
        }
        if (applies) out.set(`${col.key}:${p.id}`, { minutes, timedOps, totalOps, applies, estimatedOps })
      }
    }
    return out
  }, [grain, columns, visibleProducts, cells])

  /**
   * ── The cell drawer ───────────────────────────────────────────────────────────────────
   *
   * Held as (column key, product id) rather than as the resolved column and product: a write
   * re-reads the line and replaces every object in `source`, and a target holding the old ones
   * would act on a snapshot the grid has already moved past. Resolved fresh on every render below,
   * and a target whose column no longer exists (grain changed, a filter narrowed) simply resolves
   * to nothing and the drawer unmounts.
   */
  const [cellTarget, setCellTarget] = useState<{ columnKey: string; productId: string } | null>(null)
  const targetColumn = cellTarget ? columns.find((c) => c.key === cellTarget.columnKey) ?? null : null
  const targetProduct = cellTarget ? visibleProducts.find((p) => p.id === cellTarget.productId) ?? null : null

  /** The jobs under the open cell, in the grid's own order — already past Show and Team, so the
   * drawer cannot act on a job the grid was hiding. */
  const targetJobs = useMemo(() => {
    if (!targetColumn) return []
    const byId = new Map(source.jobs.map((j) => [j.id, j]))
    return targetColumn.jobIds
      .map((id) => byId.get(id))
      .filter((j): j is JobRow => !!j)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [targetColumn, source.jobs])

  /** The applies-list for the open cell's model: which operation ids it claims. Straight off the
   * same `model_operations` rows every cell was built from — no second read, no second rule. */
  const targetLinkedOperationIds = useMemo(() => {
    const ids = new Set<string>()
    if (!cellTarget) return ids
    for (const mo of source.modelOperations) {
      if (mo.product_id === cellTarget.productId) ids.add(mo.operation_id)
    }
    return ids
  }, [source.modelOperations, cellTarget])

  /** The CURRENT figure for (operation, the open cell's model) — asked of lib/operationTimes' stats
   * map by its own key function, exactly as the cells are. null means nothing is timed, which is
   * not the same as zero. */
  const targetMinutesFor = useCallback(
    (operationId: string): number | null => {
      if (!cellTarget) return null
      const stat = source.stats[operationProductKey(operationId, cellTarget.productId)]
      return stat ? stat.minutes : null
    },
    [source.stats, cellTarget],
  )

  const cellFor = useCallback(
    (jobId: string) => (cellTarget ? cells.get(`${jobId}:${cellTarget.productId}`) : undefined),
    [cells, cellTarget],
  )

  /**
   * product id → how many of this job's operations are linked to it. BulkModelLinkDrawer's job
   * mode wants exactly this, and its own contract says the caller supplies it "from data it
   * already holds, never fetched here" — which is true: both halves are in `source`.
   */
  const jobLinkCountsFor = useCallback(
    (jobId: string) => {
      const opIds = new Set(source.operations.filter((o) => o.job_id === jobId).map((o) => o.id))
      const counts = new Map<string, number>()
      for (const mo of source.modelOperations) {
        if (!opIds.has(mo.operation_id)) continue
        counts.set(mo.product_id, (counts.get(mo.product_id) ?? 0) + 1)
      }
      return counts
    },
    [source.operations, source.modelOperations],
  )

  const teamIdOf = useCallback(
    (jobId: string) => hierarchy.teamIdOf.get(jobId) ?? null,
    [hierarchy],
  )

  /**
   * An untimed cell is where a gap gets noticed, so its click goes to /estimate with the cell's
   * job and model already chosen — the page resolves the section (and line) from the job, so the
   * URL can't name a section the job isn't in. At section and team grain the cell is several
   * jobs, every one untimed for this model; the first that applies, in column order, is opened.
   */
  const router = useRouter()
  const openEstimate = useCallback((col: MatrixColumn, productId: string) => {
    const jobId = col.jobIds.find((id) => cells.get(`${id}:${productId}`)?.applies)
    if (!jobId) return
    router.push(`/estimate?job=${encodeURIComponent(jobId)}&model=${encodeURIComponent(productId)}`)
  }, [cells, router])

  const grainNoun = GRAINS.find((g) => g.key === grain)?.noun ?? 'column'

  /**
   * A model's row total: the sum of its visible cells.
   *
   * Under Show=All with every team, this is exactly /model-total's headline for the same model —
   * both are the sum of every current record linked to it, grouped by job on the way. Under a
   * filter it is the sum of what is on the row, which is the same rule /model-total's
   * visibleTotalMinutes follows: the parts always add to the whole that is on screen.
   *
   * DELIBERATELY OVER visibleJobs, NOT over the columns. The grain is a view of the same jobs,
   * so summing the leaves makes a row total identical across all three grains BY CONSTRUCTION
   * rather than by the roll-up happening to be right — switching from Job to Team cannot move a
   * number that never consulted the grain. (Summing the columns would give the same answer,
   * because the columns partition visibleJobs; it would just be an answer that could break.)
   */
  const rowTotals = useMemo(() => {
    const out = new Map<string, RowTotal>()
    for (const p of visibleProducts) {
      let minutes = 0
      let incomplete = false
      let applies = false
      for (const j of visibleJobs) {
        const cell = cells.get(`${j.id}:${p.id}`)
        if (!cell || !cell.applies) continue
        applies = true
        minutes += cell.minutes
        if (jobCompleteness(cell.timedOps, cell.totalOps) !== 'timed') incomplete = true
      }
      out.set(p.id, { minutes, incomplete, applies })
    }
    return out
  }, [visibleProducts, visibleJobs, cells])

  /**
   * Coverage over what is on screen — (job, model) pairs required, and how many are timed.
   * Straight off the shared combos, filtered to the visible rows and columns rather than
   * recounted, so this cannot disagree with the cells underneath it.
   */
  const coverage = useMemo(() => {
    const jobIds = new Set(visibleJobs.map((j) => j.id))
    const productIds = new Set(visibleProducts.map((p) => p.id))
    let required = 0
    let covered = 0
    let estimated = 0
    for (const c of source.combos) {
      if (!jobIds.has(c.jobId) || !productIds.has(c.productId)) continue
      required += 1
      if (c.covered) covered += 1
      if (source.estimateOnlyKeys.has(coverageComboKey(c.jobId, c.productId))) estimated += 1
    }
    return { required, covered, estimated }
  }, [source.combos, source.estimateOnlyKeys, visibleJobs, visibleProducts])

  const gridTotal = useMemo(
    () => visibleProducts.reduce((sum, p) => sum + (rowTotals.get(p.id)?.minutes ?? 0), 0),
    [visibleProducts, rowTotals],
  )

  /** The same rows, under type and series headings — display only; see groupProducts. */
  const productGroups = useMemo(() => groupProducts(visibleProducts), [visibleProducts])

  /**
   * The thead's rendered height, as --lm-head-h on the table, so the group headings can stick
   * directly beneath it. Measured rather than summed from constants: the column-heading row is
   * as tall as its longest rotated label, which the CSS caps but does not fix.
   */
  const [headHeight, setHeadHeight] = useState(0)
  const headObserver = useRef<ResizeObserver | null>(null)
  // A callback ref, because the table mounts and unmounts with the loading and empty states.
  // ResizeObserver reports once on observe, so that is the first measurement too.
  const theadRef = useCallback((el: HTMLTableSectionElement | null) => {
    headObserver.current?.disconnect()
    headObserver.current = null
    if (!el) return
    const ro = new ResizeObserver(() => setHeadHeight(el.offsetHeight))
    ro.observe(el)
    headObserver.current = ro
  }, [])

  /** The filter state as a sentence, for the printed sheet. Names "All labour" and "All teams"
   * explicitly rather than staying silent — a sheet with no scope line reads as unfiltered
   * whether it is or not, which is the one way a printout is worse than no printout. */
  const filterPhrase = useMemo(() => {
    const show = labourSource === 'all' ? 'All labour'
      : labourSource === 'line' ? 'Line labour only'
        : activeAreaLineId
          // The area, NAMED — "Pre-assembly only" over a grid cut to Chassis would be true and
          // would describe a different sheet. Same wording as /model-total's printed scope.
          ? `Pre-assembly — ${lineSplit?.name(activeAreaLineId) ?? 'area'}`
          : 'Pre-assembly only'
    // The teams, NAMED — not "2 teams". A header is read away from the controls that produced it
    // (on paper there are no controls at all), and "Team 1 + Team 2" is the only version of this
    // line that lets a reader check the figures are about what they think they are about. Past
    // four it falls back to a count, because the sheet's band heading repeats this on every page
    // and eight team names would push the first band off it; the on-screen summary carries the
    // same string, so the two can't disagree about what was filtered.
    const teamNames = teamOptions.filter((t) => activeTeamIds.has(t.id)).map((t) => t.name)
    const team = teamNames.length === 0
      // The count is stated when there is one to state, for the same reason "All 29 models" is:
      // "All teams" alone invites the reader to assume nothing was done to them, which is right,
      // but says nothing about how many that is.
      ? (teamOptions.length > 0 ? `All ${teamOptions.length} teams` : 'All teams')
      : teamNames.length <= 4
        ? teamNames.join(' + ')
        : `${teamNames.length} of ${teamOptions.length} teams`

    // The models, stated whether or not they were narrowed. "All 29 models on this line" is a
    // fact worth printing: a header that names the line, the series, the team and the Show state
    // but says nothing about models invites the reader to assume nothing was done to them, which
    // is right four times out of five and badly wrong the fifth.
    //
    // Counted from what is ON THE GRID, not from the picker's selection — two filters can narrow
    // the rows now, and a header that only knew about one of them would have called a
    // schedule-filtered grid "All 29 models" while showing 21.
    const subset = visibleProducts.length < modelCandidates.length
    const models = subset
      ? `${visibleProducts.length} of ${modelCandidates.length} models`
      : `All ${modelCandidates.length} models`
    // Named outright while the list is short enough to read; past that the grid's own left-hand
    // column is the enumeration, and a header running to fifty names would push the first band
    // off its sheet.
    const modelNames = !subset ? null
      : visibleProducts.length <= 10
        ? visibleProducts.map((p) => p.model).join(', ')
        : 'each named down the left of the grid'
    // The schedule filter, always stated. "76 of 101" is exactly the kind of cut that looks like
    // the whole dataset once it is on paper.
    const schedule = futureOnly
      ? `Future builds only — on line from ${fmtScheduleDate(todayIsoDate())}`
      : 'Every model, booked or not'

    const grainMeta = GRAINS.find((g) => g.key === grain) ?? GRAINS[2]

    // Only a pre-assembly line has the filter, so only a pre-assembly line gets the phrase. "All
    // build lines" is stated rather than left out, for the same reason "All teams" is.
    const buildLine = !isPreAssemblyLine ? null
      : buildLineOptions.find((b) => b.id === activeBuildLineId)?.name ?? 'All build lines'

    // The two filters the head-count alone hides, in words beside the counts they narrowed:
    // "66 models built on Caravan × 17 sections in Chassis". Said for "all" as well, so the
    // sentence reads the same shape whether or not anything was cut.
    const rowScope = !buildLine ? ''
      : activeBuildLineId ? ` built on ${buildLine}` : ' across all build lines'
    const columnScope = labourSource !== 'pre' ? ''
      : activeAreaLineId ? ` in ${lineSplit?.name(activeAreaLineId) ?? 'one area'}`
        : preAssemblyAreas.length > 0
          ? ` across ${preAssemblyAreas.length === 1 ? '1 pre-assembly area' : `all ${preAssemblyAreas.length} pre-assembly areas`} (${preAssemblyAreas.map((a) => a.name).join(', ')})`
          : ''

    return {
      show, team, buildLine, rowScope, columnScope, series: activeSeries || 'All series', models, modelNames, subset, schedule,
      grain: `${grainMeta.label} level`,
      // Capitalised for the band heading ("Teams 1–8 of 8").
      grainNoun: grainMeta.noun.charAt(0).toUpperCase() + grainMeta.noun.slice(1),
    }
  }, [labourSource, activeAreaLineId, preAssemblyAreas, lineSplit, activeTeamIds, teamOptions, isPreAssemblyLine, buildLineOptions, activeBuildLineId, activeSeries, modelCandidates, visibleProducts, futureOnly, grain])

  const lineName = lines.find((l) => l.id === lineId)?.name ?? 'No production line'

  // ── Print ────────────────────────────────────────────────────────────────────────────────
  // The printed document is mounted only once Print is pressed, the same way /model-total's
  // sheets are. It is a second copy of a grid that can run to 9,000 cells; keeping it in the DOM
  // permanently would double the node count of the heaviest screen in the app for the sake of
  // something nobody has asked for yet.
  const [printing, setPrinting] = useState(false)
  // Stamped when Print is pressed rather than at render: this component server-renders too, and
  // a date evaluated during render would differ between the server and client markup.
  const [printedAt, setPrintedAt] = useState<string | null>(null)
  function handlePrint() {
    setPrinting(true)
    setPrintedAt(new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }))
    // Two frames so the sheet is mounted AND painted before the dialog snapshots the page — it
    // does not exist in the DOM until this render commits.
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()))
  }
  // The document stays mounted after the dialog closes; there is no reliable cross-browser
  // "printed" event, and afterprint at least fires in every engine that matters here.
  useEffect(() => {
    if (!printing) return
    const done = () => setPrinting(false)
    window.addEventListener('afterprint', done)
    return () => window.removeEventListener('afterprint', done)
  }, [printing])

  // Bands are computed off the COLUMNS, whatever grain produced them — nothing here assumes a
  // count. Team and Section grain usually come out as a single band; job grain on a full line
  // runs to four or five. Either way the band heading names the range it holds.
  const printBandSize = grain === 'job' ? PRINT_BAND_COLUMNS_JOB : PRINT_BAND_COLUMNS_ROLLUP
  const printBands = useMemo(() => chunked(columns, printBandSize), [columns, printBandSize])

  const ready = !!lineId && !loading && !error && visibleProducts.length > 0

  return (
    <main className="page-wide rp-page">
      <div className="rp-screen-only">
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Labour Matrix</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
            Every model on a line against every job — Model Total for all of them at once
          </p>
        </div>

        <div className="card" style={{ padding: '14px 20px', marginBottom: 16, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            style={SEL}
            value={lineId}
            onChange={(e) => {
              setLineId(e.target.value)
              setBuildLineId('')
              setSeries('')
              // Both multi-selects are re-scoped by the line, so both are dropped rather than left
              // holding ids that belong to the line being left. The panels close with them: a panel
              // left open over a list that has just been replaced is a list nobody asked for.
              resetTeamFilter(); setTeamPickerOpen(false)
              resetModelFilter(); setModelPickerOpen(false)
              setCellTarget(null)
            }}
          >
            <option value="">— Select a production line —</option>
            {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          {/* Only for a pre-assembly line: a build line's models are all its own, so the filter
              could offer exactly one option. Before Series because it is the broader cut — Series
              then filters within it, and its list narrows to match. */}
          {isPreAssemblyLine && (
            <select
              style={SEL}
              value={activeBuildLineId}
              aria-label="Build line"
              title="Narrow the model rows to one of the build lines this area feeds"
              onChange={(e) => {
                setBuildLineId(e.target.value)
                // Re-scopes Series and the model list, so both are dropped — the same reason the
                // line select drops them.
                setSeries('')
                resetModelFilter()
                setCellTarget(null)
              }}
            >
              <option value="">All build lines</option>
              {buildLineOptions.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          <select
            style={SEL}
            value={activeSeries}
            onChange={(e) => { setSeries(e.target.value); resetModelFilter() }}
            disabled={!lineId}
          >
            <option value="">All series</option>
            {seriesOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {/* The Team control is the same SHAPE as the Models control below it — a button that
              states the selection and opens a checkbox panel — because it now answers the same
              kind of question ("which of these, together?") and two multi-selects that looked
              different would read as two different mechanisms. Same classes, same "empty = all"
              rule, same panel. */}
          <div className="lm-pop-anchor" ref={teamPopRef}>
          <button
            type="button"
            className={activeTeamIds.size > 0 ? 'btn-ghost lm-models-btn lm-models-btn-on' : 'btn-ghost lm-models-btn'}
            disabled={!lineId || teamOptions.length === 0}
            aria-expanded={teamPickerOpen}
            title={teamOptions.length === 0
              ? 'No team on this line owns a job on this grid'
              : activeTeamIds.size > 0
                ? `Showing ${activeTeamIds.size} of ${teamOptions.length} teams on this line — click to change`
                : 'Every team on this line — click to pick a subset to compare'}
            onClick={() => setTeamPickerOpen((open) => !open)}
          >
            {activeTeamIds.size > 0
              ? `Teams: ${activeTeamIds.size} of ${teamOptions.length}`
              : `Teams: all ${teamOptions.length}`}
            <span aria-hidden="true" style={{ fontSize: 10 }}>{teamPickerOpen ? '▲' : '▼'}</span>
          </button>
          {/* ── The team picker ─────────────────────────────────────────────────────────
              The rows are the same primitives ModelSeriesPicker renders — `.checkbox-list
              .checkbox-list-grid` and `.checkbox-row`, so the ticks, the hit areas and the columns
              are the app's, not this screen's — inside the same `.lm-models-panel` chrome the model
              filter opens — here as a DROPDOWN anchored to the Teams button (.lm-pop), closed by Done,
              Escape or a click anywhere else. ModelSeriesPicker itself is not reused HERE because it is typed to
              `Product` and groups by `product_series`: a team has neither, and handing it fabricated
              products to get one flat group would mean this screen inventing what a product is for
              a component three other screens depend on. */}
          {teamPickerOpen && lineId && teamOptions.length > 0 && (
            <div className="card lm-models-panel lm-pop" role="dialog" aria-label="Teams">
              <div className="lm-models-panel-bar">
                <button
                  type="button"
                  className="lm-models-action"
                  disabled={activeTeamIds.size === teamOptions.length}
                  onClick={() => setSelectedTeamIds(new Set(teamOptions.map((t) => t.id)))}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="lm-models-action"
                  disabled={activeTeamIds.size === 0}
                  onClick={resetTeamFilter}
                >
                  Clear
                </button>
                <span className="lm-models-count">
                  {activeTeamIds.size === 0
                    ? `Nothing ticked — showing all ${teamOptions.length}`
                    : `${activeTeamIds.size} of ${teamOptions.length} selected`}
                </span>
                <button type="button" className="lm-models-action" onClick={() => setTeamPickerOpen(false)}>
                  Done
                </button>
              </div>
              {/* Said out loud for the same reason it is said over the models: "tick nothing to see
                  everything" is the opposite of what a filter usually does. The second sentence is
                  this filter's own: the list is the LINE's teams, which is not the same set as the
                  teams owning a column, and a reader who expects to find a pre-assembly team in here
                  should be told where it went rather than left to conclude the list is incomplete. */}
              <p className="lm-models-hint">
                Tick the teams to compare. With none ticked the grid shows every team on this line —
                clearing the selection is how you get back to all of them. Only teams that belong to{' '}
                <strong>{lineName}</strong> are listed; a pre-assembly team whose work applies to
                these models still has its jobs in the grid and its own column at Team grain, and the{' '}
                <strong>Show</strong> toggle is what separates that labour out.
              </p>
              <div className="checkbox-list lm-pop-list">
                {teamOptions.map((t) => {
                  const isSelected = activeTeamIds.has(t.id)
                  // How many of the grid's jobs this team owns, before the Show filter — the same
                  // service the model picker's row badge performs: what a tick will cost, stated at
                  // the moment of ticking rather than after the grid comes back empty.
                  const jobCount = source.jobs.filter((j) => hierarchy.teamIdOf.get(j.id) === t.id).length
                  return (
                    <div key={t.id} className="checkbox-row" style={{ cursor: 'default' }}>
                      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, cursor: 'pointer', width: '100%', minWidth: 0 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <input type="checkbox" checked={isSelected} onChange={() => toggleTeam(t.id)} />
                          {t.name}
                        </span>
                        <span className="lm-models-badge">{plural(jobCount, 'job')}</span>
                      </label>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          </div>

          {/* A 101-model checkbox list cannot sit inline in a filter bar, so the control here is
              a button that states the selection and opens the list beneath the card. Not a
              popover: a popover needs click-outside handling, focus management and positioning
              against a bar that already wraps onto two rows at tablet width, and buys nothing a
              panel doesn't. */}
          <button
            type="button"
            className={activeModelIds.size > 0 ? 'btn-ghost lm-models-btn lm-models-btn-on' : 'btn-ghost lm-models-btn'}
            disabled={!lineId || modelCandidates.length === 0}
            aria-expanded={modelPickerOpen}
            title={activeModelIds.size > 0
              ? `Showing ${activeModelIds.size} of ${modelCandidates.length} models — click to change`
              : 'Every model on this line and series — click to pick a subset to compare'}
            onClick={() => setModelPickerOpen((open) => !open)}
          >
            {activeModelIds.size > 0
              ? `Models: ${activeModelIds.size} of ${modelCandidates.length}`
              : `Models: all ${modelCandidates.length}`}
            <span aria-hidden="true" style={{ fontSize: 10 }}>{modelPickerOpen ? '▲' : '▼'}</span>
          </button>

          {/* A checkbox, not a fourth segmented control: it is one binary with a sensible
              default, and the bar already carries three pickers and a three-way toggle. The
              count beside it says what it costs before it is pressed. */}
          <label
            className="lm-future"
            title={futureOnly
              ? `Showing only models with a chassis booked on line from ${fmtScheduleDate(todayIsoDate())}`
              : 'Showing every model, including those with nothing booked'}
          >
            <input
              type="checkbox"
              checked={futureOnly}
              disabled={!lineId}
              onChange={(e) => setFutureOnly(e.target.checked)}
            />
            <span>Future builds only</span>
            {lineId && modelCandidates.length > 0 && (
              <span className="lm-future-count">{futureCandidateCount} of {modelCandidates.length}</span>
            )}
          </label>

          {/* Same segmented shape as Show — one grid, three depths. Job is first in the data
              and last in the control, because it is the default and the eye lands on the end of
              a segmented group it has already read. */}
          <div className="lm-toggle" role="group" aria-label="Grain">
            <span className="lm-toggle-label">Grain</span>
            {GRAINS.map((g) => (
              <button
                key={g.key}
                type="button"
                title={g.hint}
                className={grain === g.key ? 'lm-toggle-btn lm-toggle-btn-on' : 'lm-toggle-btn'}
                // The open cell belongs to a column at the OLD grain, so it is dropped rather
                // than left resolving to nothing.
                onClick={() => { setGrain(g.key); setCellTarget(null) }}
              >
                {g.label}
              </button>
            ))}
          </div>

          {/* The same three-way toggle /model-total carries above its breakdown, with the same
              meanings — it splits the JOBS by the line each one sits on, not the models. */}
          <div className="lm-toggle" role="group" aria-label="Show">
            <span className="lm-toggle-label">Show</span>
            {LABOUR_SOURCES.map((s) => (
              <button
                key={s.key}
                type="button"
                title={s.hint}
                className={labourSource === s.key ? 'lm-toggle-btn lm-toggle-btn-on' : 'lm-toggle-btn'}
                // Leaving Pre-assembly drops any area narrowing with it — an area chip that
                // stayed selected while invisible would silently scope the next view.
                onClick={() => { setLabourSource(s.key); if (s.key !== 'pre') setAreaLineId('') }}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* The same chips /model-total shows beside the same toggle. Without them the
              Pre-assembly grid lays "Stage 1", "CUTTING" and "After Press Section" side by side
              with nothing saying they belong to three different areas. */}
          {labourSource === 'pre' && preAssemblyAreas.length > 0 && (
            <AreaChips areas={preAssemblyAreas} value={activeAreaLineId} onChange={setAreaLineId} />
          )}

          <button
            type="button"
            className="btn-ghost"
            style={{ marginLeft: 'auto' }}
            disabled={!ready}
            title={ready ? 'Print the grid — A3 landscape' : 'Select a production line first'}
            onClick={handlePrint}
          >
            Print matrix
          </button>

          {loading && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</span>}
          {/* Said, but quietly: the grid is still on screen and still correct, it is just about to
              be replaced by the same read one write later. */}
          {refreshing && !loading && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Updating figures…</span>
          )}
        </div>

        {/* ── The model picker ────────────────────────────────────────────────────────
            ModelSeriesPicker is the app's one series-grouped multi-select model list — the same
            component /collect, /setup's bulk-link drawer and the Add Time drawer render. It owns
            no data and performs no writes, so driving it here is a matter of handing it the
            products to show and the ids that are ticked; the search box filters what it is
            HANDED rather than reaching inside it, which is why adding search to this screen did
            not mean changing a component three others depend on. */}
        {modelPickerOpen && lineId && modelCandidates.length > 0 && (
          <div className="card lm-models-panel">
            <div className="lm-models-panel-bar">
              <input
                type="search"
                className="lm-models-search"
                placeholder={`Search ${modelCandidates.length} models…`}
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                aria-label="Search models"
                autoFocus
              />
              <button
                type="button"
                className="lm-models-action"
                disabled={pickerProducts.length === 0}
                onClick={() => setSelectedModelIds((prev) => {
                  const next = new Set(prev)
                  for (const p of pickerProducts) next.add(p.id)
                  return next
                })}
              >
                Select {modelSearch.trim() ? `these ${pickerProducts.length}` : 'all'}
              </button>
              <button
                type="button"
                className="lm-models-action"
                disabled={activeModelIds.size === 0}
                onClick={resetModelFilter}
              >
                Clear
              </button>
              <span className="lm-models-count">
                {activeModelIds.size === 0
                  ? `Nothing ticked — showing all ${modelCandidates.length}`
                  : `${activeModelIds.size} of ${modelCandidates.length} selected`}
              </span>
              <button type="button" className="lm-models-action" onClick={() => setModelPickerOpen(false)}>
                Done
              </button>
            </div>
            {/* Said out loud, because "tick nothing to see everything" is the opposite of what a
                filter usually does and is otherwise discovered by emptying the grid. */}
            <p className="lm-models-hint">
              Tick the models to compare. With none ticked the grid shows every model on this
              line and series — clearing the selection is how you get back to all of them.
            </p>
            {pickerProducts.length === 0 ? (
              <p className="lm-models-hint">No model on this line matches “{modelSearch.trim()}”.</p>
            ) : (
              <ModelSeriesPicker
                products={pickerProducts}
                selectedIds={activeModelIds}
                onToggle={toggleModel}
                onToggleSeries={toggleModelSeries}
                /* renderRowStatus is the picker's own extension point — used here so the one
                   thing that makes a model unusual is visible AT THE MOMENT OF CHOOSING it,
                   rather than after the grid comes back a row short. A model with nothing booked
                   can still be ticked; it says so, and ticking it wins. */
                renderRowStatus={(p) => {
                  const summary = source.futureByProductId.get(p.id)
                  return summary
                    ? <span className="lm-models-badge">{plural(summary.futureBuilds, 'build')} · next {fmtScheduleDate(summary.nextOnLine)}</span>
                    : <span className="lm-models-badge lm-models-badge-none">Nothing booked</span>
                }}
              />
            )}
          </div>
        )}

        {error && (
          <p style={{ margin: '0 0 16px', padding: '9px 12px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 12 }}>
            {error}
          </p>
        )}

        {!lineId ? (
          <p style={EMPTY}>Select a production line to build its matrix</p>
        ) : loading ? (
          <p style={EMPTY}>Reading the line’s models, jobs and recorded times…</p>
        ) : visibleProducts.length === 0 ? (
          futureOnly && modelCandidates.length > 0 ? (
            // Not "no models" — there are models, none of them booked. Saying which filter
            // emptied the grid is the difference between a dead end and one click.
            <p style={EMPTY}>
              No model on this line{activeSeries ? ` in ${activeSeries}` : ''} has a build booked
              from {fmtScheduleDate(todayIsoDate())}.
              <br />
              Untick <strong>Future builds only</strong> to see all {modelCandidates.length} of them.
            </p>
          ) : (
            <p style={EMPTY}>No models on this line{activeSeries ? ` in ${activeSeries}` : ''}.</p>
          )
        ) : columns.length === 0 ? (
          <p style={EMPTY}>No jobs match this Show / Team filter.</p>
        ) : (
          <>
            <div className="lm-summary">
              <span>
                <strong>{visibleProducts.length}</strong> {visibleProducts.length === 1 ? 'model' : 'models'}
                {filterPhrase.rowScope}
                {' × '}<strong>{columns.length}</strong> {columns.length === 1 ? grainNoun : `${grainNoun}s`}
                {filterPhrase.columnScope}
              </span>
              <span>
                {filterPhrase.show} · {filterPhrase.series} · {filterPhrase.team} · {filterPhrase.models}
              </span>
              <span>{filterPhrase.schedule}</span>
              <span>
                coverage <strong>{coverage.covered} / {coverage.required}</strong> job×model cells timed
                {coverage.estimated > 0 && (
                  <span title="Covered only by estimates from the Estimate screen — they would be gaps again without them. Included in the coverage figure, not added to it.">
                    , of which <strong>{coverage.estimated}</strong> estimated
                  </span>
                )}
              </span>
              <span>
                <strong>{fmtMinutes(gridTotal)}m</strong> ({fmtHours(gridTotal)}h) across the grid
              </span>
            </div>

            {/* Said out loud, and naming the models: the alternative is a grid that quietly
                contains rows the schedule filter says shouldn't be there, which reads as the
                filter not working. */}
            {scheduleOverrides.length > 0 && (
              <p className="lm-override">
                <strong>{plural(scheduleOverrides.length, 'selected model')}</strong> {scheduleOverrides.length === 1 ? 'has' : 'have'} no
                build booked from {fmtScheduleDate(todayIsoDate())} — shown anyway because{' '}
                {scheduleOverrides.length === 1 ? 'it was' : 'they were'} picked by name:{' '}
                {scheduleOverrides.map((p) => p.model).join(', ')}.
              </p>
            )}

            <Legend />

            {/* The scroll container is what makes the sticky cells stick: position: sticky is
                relative to the nearest scrolling ancestor, so both axes have to scroll HERE and
                not on the window, or the model column scrolls away with everything else. */}
            <div className="lm-scroll">
              <table
                className={`lm-table${showAreaHeader ? ' lm-has-area' : ''}${showParentHeader ? ' lm-has-parent' : ''}`}
                style={{ '--lm-head-h': `${headHeight}px` } as React.CSSProperties}
              >
                <thead ref={theadRef}>
                  {/* Up to three rows: area → parent → column. Model and Total sit in whichever
                      row comes first and span them all, so they keep their corners; each row
                      below sticks BENEATH the ones above it (the lm-has-* classes on the table
                      are what tell the CSS how far down that is). */}
                  {showAreaHeader && (
                    <tr>
                      <th className="lm-th-corner" rowSpan={headerRows}>Model</th>
                      {areaSpans.map((a) => (
                        <th key={a.areaId} className="lm-th-area" colSpan={a.span} title={`${a.name} — ${plural(a.span, grainNoun)}`}>
                          <span className="lm-th-area-text">{a.name}</span>
                        </th>
                      ))}
                      <th className="lm-th-total" rowSpan={headerRows}>Total</th>
                    </tr>
                  )}
                  {showParentHeader && (
                    <tr className="lm-th-row-parent">
                      {!showAreaHeader && <th className="lm-th-corner" rowSpan={headerRows}>Model</th>}
                      {parentSpans.map((s, i) => (
                        <th key={`${i}|${s.key}`} className="lm-th-parent" colSpan={s.span} title={`${parentNoun}: ${s.label} — ${plural(s.span, grainNoun)}`}>
                          <span className="lm-th-parent-text">{s.label}</span>
                        </th>
                      ))}
                      {!showAreaHeader && <th className="lm-th-total" rowSpan={headerRows}>Total</th>}
                    </tr>
                  )}
                  <tr className="lm-th-row-cols">
                    {headerRows === 1 && <th className="lm-th-corner">Model</th>}
                    {columns.map((col) => (
                      // Rotated, because the column is sized by its widest FIGURE (~5
                      // characters) and not by a name that can run to forty. Horizontal
                      // headings would make every column 130px and the grid three times wider
                      // than it needs to be.
                      <th
                        key={col.key}
                        className="lm-th-job"
                        title={grain === 'job' ? col.label : `${col.label} — ${plural(col.jobIds.length, 'job')}`}
                      >
                        <span className="lm-th-job-text">{col.label}</span>
                      </th>
                    ))}
                    {headerRows === 1 && <th className="lm-th-total">Total</th>}
                  </tr>
                </thead>
                <tbody>
                  {/* Type → series headings between the rows, each one a single cell across the
                      whole grid so it reads as a divider. Sticky in both directions: the cell
                      sticks beneath the thead (--lm-head-h) while its label sticks to the left
                      edge — see .lm-grp in globals.css. */}
                  {productGroups.map((g) => (
                    <Fragment key={`t|${g.key}`}>
                      <tr className="lm-grp-row">
                        <th scope="colgroup" colSpan={columns.length + 2} className="lm-grp lm-grp-type">
                          <span className="lm-grp-label">
                            {g.label}<span className="lm-grp-count">{plural(g.count, 'model')}</span>
                          </span>
                        </th>
                      </tr>
                      {g.series.map((s) => (
                        <Fragment key={`s|${s.key}`}>
                          <tr className="lm-grp-row">
                            <th scope="colgroup" colSpan={columns.length + 2} className="lm-grp lm-grp-series">
                              <span className="lm-grp-label">
                                {s.label}<span className="lm-grp-count">{plural(s.products.length, 'model')}</span>
                              </span>
                            </th>
                          </tr>
                          {s.products.map((p) => {
                            const total = rowTotals.get(p.id) ?? NO_ROW_TOTAL
                            return (
                              <tr key={p.id}>
                                {/* products.model, never product_code — see visibleProducts. */}
                                <th scope="row" className="lm-td-model">
                                  <ModelLabel product={p} schedule={source.futureByProductId.get(p.id)} />
                                </th>
                                {columns.map((col) => (
                                  <Cell
                                    key={col.key}
                                    cell={columnCells.get(`${col.key}:${p.id}`)}
                                    columnLabel={col.label}
                                    jobCount={col.jobIds.length}
                                    grain={grain}
                                    model={p.model}
                                    // EVERY cell opens, including a blank one: "this doesn't apply" is a
                                    // state the drawer exists to change, so the cells with nothing in them
                                    // are the ones most worth clicking.
                                    onOpen={() => setCellTarget({ columnKey: col.key, productId: p.id })}
                                    onEstimate={() => openEstimate(col, p.id)}
                                  />
                                ))}
                                {total.applies ? (
                                  <td className={`lm-td-total${total.incomplete ? ' lm-incomplete' : ''}`}>
                                    {fmtMinutes(total.minutes)}{total.incomplete ? '*' : ''}
                                  </td>
                                ) : (
                                  // Nothing on this row applies, so there is no total to state — see RowTotal.
                                  <td className="lm-td-total lm-td-na" title={`Nothing in these columns applies to ${p.model}`} />
                                )}
                              </tr>
                            )
                          })}
                        </Fragment>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ── The cell drawer ─────────────────────────────────────────────────────────────
          A new entry point to existing flows, not a new implementation of any of them — see the
          component's own note. It is handed the facts the grid already computed (applies, minutes,
          coverage, the applies-list) so it cannot arrive at a different answer than the cell
          behind it, and `refreshMatrix` is what makes every figure on the screen move the moment
          it writes. */}
      {cellTarget && targetColumn && targetProduct && (
        <MatrixCellDrawer
          supabase={supabase}
          userId={userId}
          role={role}
          product={targetProduct}
          grainLabel={GRAINS.find((g) => g.key === grain)?.label ?? 'Column'}
          columnLabel={targetColumn.label}
          jobs={targetJobs}
          isJobGrain={grain === 'job'}
          cellFor={cellFor}
          linkedOperationIds={targetLinkedOperationIds}
          minutesFor={targetMinutesFor}
          jobLinkCountsFor={jobLinkCountsFor}
          lineId={lineId}
          teamIdOf={teamIdOf}
          onChanged={refreshMatrix}
          onClose={() => setCellTarget(null)}
        />
      )}

      {/* ── The printed document ────────────────────────────────────────────────────────
          A3 landscape (see print.css), cut into bands of printBandSize columns. Not
          .rp-doc: that class flattens everything inside it to black on purpose, and the red
          zeros are the point of this sheet. It follows /roadmap instead, which scopes its forced
          black to the prose and lets the chart keep its colour. */}
      {printing && ready && (
        <div className="lm-print rp-print-only">
          <div className="lm-print-head">
            <h1 className="lm-print-title">Labour Matrix · {lineName}</h1>
            {/* The filter state, in words, on the paper. A printed grid that doesn't say it was
                narrowed to Pre-assembly reads as a model's whole labour content — the one way a
                printout is actively misleading rather than merely thin. */}
            <p className="lm-print-meta">
              {/* The grain first: it is what the columns ARE, so a reader who takes it for job
                  level when it is team level misreads every figure on the sheet. */}
              Grain: <strong>{filterPhrase.grain}</strong>
              {filterPhrase.buildLine && <>{' · Build line: '}<strong>{filterPhrase.buildLine}</strong></>}
              {' · '}<strong>{filterPhrase.series}</strong> · <strong>{filterPhrase.team}</strong>
              {' · Show: '}<strong>{filterPhrase.show}</strong>
            </p>
            {/* The model selection, on the paper, always — and emphasised when it is a subset.
                A sheet showing eight models out of a hundred, under a grid total and a coverage
                figure that are true only of those eight, is the one printout that is worse than
                none: everything on it is correct and the thing it is correct ABOUT is missing. */}
            <p className={filterPhrase.subset ? 'lm-print-meta lm-print-subset' : 'lm-print-meta'}>
              Models: <strong>{filterPhrase.models}</strong>
              {filterPhrase.modelNames ? ` — ${filterPhrase.modelNames}` : ' on this line and series'}
            </p>
            {/* The schedule filter is the one that cuts hardest — 76 of 101 fleet-wide — and it
                leaves no trace in the grid, because the models it removed simply aren't rows. On
                paper there is no toggle to glance at, so it is stated, and emphasised whenever
                it is on. */}
            <p className={futureOnly ? 'lm-print-meta lm-print-subset' : 'lm-print-meta'}>
              Schedule: <strong>{filterPhrase.schedule}</strong>
            </p>
            {scheduleOverrides.length > 0 && (
              <p className="lm-print-meta">
                Included despite having no build booked, because {scheduleOverrides.length === 1 ? 'it was' : 'they were'} picked
                by name: <strong>{scheduleOverrides.map((p) => p.model).join(', ')}</strong>.
              </p>
            )}
            <p className="lm-print-meta">
              {plural(visibleProducts.length, 'model')} × {plural(columns.length, grainNoun)}
              {' · '}coverage <strong>{coverage.covered} / {coverage.required}</strong> job×model cells timed
              {coverage.estimated > 0 && <>, of which <strong>{coverage.estimated}</strong> estimated</>}
              {' · '}<strong>{fmtMinutes(gridTotal)}m</strong> ({fmtHours(gridTotal)}h) across the grid
              {printedAt ? ` · printed ${printedAt}` : ''}
            </p>
            <p className="lm-print-key">
              Blank = nothing in this column applies to this model · <span className="lm-print-key-none">0.0 in bold red</span> = applies,
              nothing timed beneath it · <span className="lm-print-key-partial">underlined*</span> = partly timed, the figure is
              real but incomplete · <span className="lm-print-key-timed">green</span> = every applicable job beneath is timed ·{' '}
              <span className="lm-print-key-bg lm-src-measured">shaded green</span> = the figure is measured ·{' '}
              <span className="lm-print-key-bg lm-src-estimated">shaded orange</span> = the figure is estimated, or partly
              estimated — a cell mixing both counts as estimated · a figure is the
              sum of that job’s operations’ current recorded times, and superseded runs are kept
              but never counted. The number in brackets beside a model is how many builds it has
              booked on line from {fmtScheduleDate(todayIsoDate())}; a model with none has no
              bracket.
            </p>
          </div>

          {printBands.map((band, bandIndex) => {
            const from = bandIndex * printBandSize + 1
            const to = from + band.length - 1
            const colgroup = (
              <colgroup>
                <col className="lm-print-col-model" />
                {band.map((col) => <col key={col.key} className="lm-print-col-job" />)}
                <col className="lm-print-col-total" />
              </colgroup>
            )
            const printRow = (p: Product) => {
              const total = rowTotals.get(p.id) ?? NO_ROW_TOTAL
              return (
                <tr key={p.id}>
                  <th scope="row" className="lm-print-td-model">
                    <ModelLabel product={p} schedule={source.futureByProductId.get(p.id)} forPrint />
                  </th>
                  {band.map((col) => (
                    <Cell
                      key={col.key}
                      cell={columnCells.get(`${col.key}:${p.id}`)}
                      columnLabel={col.label}
                      jobCount={col.jobIds.length}
                      grain={grain}
                      model={p.model}
                      forPrint
                    />
                  ))}
                  {/* The model's total across EVERY visible job, repeated on each band
                      rather than recomputed for the band — it is the figure /model-total
                      would show for this model under this filter, and a per-band subtotal
                      would be a number that exists nowhere else in the app. The heading
                      says "Model total" for exactly that reason. */}
                  {/* Blank when nothing on the row applies — blank on paper means blank,
                      the same as a cell. See RowTotal. */}
                  <td className={`lm-print-td-total${total.incomplete ? ' lm-incomplete' : ''}`}>
                    {total.applies ? `${fmtMinutes(total.minutes)}${total.incomplete ? '*' : ''}` : ''}
                  </td>
                </tr>
              )
            }
            return (
              <section key={from} className="lm-print-band">
                {/* Every band says which columns it holds, so a sheet on its own can never be
                    mistaken for the whole grid. */}
                <p className="lm-print-band-head">
                  {filterPhrase.grainNoun}s {from}–{to} of {columns.length}
                  {printBands.length > 1 ? ` · sheet ${bandIndex + 1} of ${printBands.length} across` : ''}
                  {' · '}{lineName}{filterPhrase.buildLine ? ` · ${filterPhrase.buildLine}` : ''} · {filterPhrase.series} · {filterPhrase.team} · {filterPhrase.show}
                  {/* Repeated on every band: the bands are separate sheets and get separated,
                      so each one has to say for itself that it is a subset. */}
                  {filterPhrase.subset ? ` · ${filterPhrase.models}` : ''}
                  {futureOnly ? ' · future builds only' : ''}
                </p>
                {/* ONE TABLE PER PRODUCT TYPE, each starting a fresh sheet (.lm-print-type in
                    globals.css) — except the first in the band, which follows the band heading
                    on the band's opening sheet, so no sheet is left blank.

                    The job names AND the type heading are this table's thead, so in Chromium
                    both come back at the top of every sheet the type runs onto. Safari never
                    repeats a thead on paper, but because each type starts its own sheet, the
                    type's first sheet at least always opens with its job names and its heading,
                    and a type heading can never be stranded at the foot of a sheet.

                    Each series is a NESTED table inside it whose thead is the series heading — a
                    series broken by a page resumes (in Chromium) under the job names, its type and
                    its series. Every nested table repeats the band's colgroup and is laid out
                    fixed at 100%, so the columns line up exactly with the headings above them. */}
                {productGroups.map((g) => (
                  <table key={`t|${g.key}`} className="lm-print-table lm-print-type">
                    {/* Explicit columns. Under table-layout: fixed the widths are read off the
                        FIRST row, and when that row is the area headings its cells are colspans
                        with no width of their own — the 13mm floor would be lost exactly when the
                        area row is on. A colgroup outranks any row. */}
                    {colgroup}
                    {/* display: table-header-group in the print CSS — a type with 90 models runs
                        down several sheets, and the job names come back at the top of each. */}
                    <thead>
                      {showAreaHeader && (
                        <tr>
                          <th className="lm-print-th-model" rowSpan={headerRows}>Model</th>
                          {areaSpansOf(band).map((a) => (
                            <th key={a.areaId} className="lm-print-th-area" colSpan={a.span}>{a.name}</th>
                          ))}
                          <th className="lm-print-th-total" rowSpan={headerRows}>Model total</th>
                        </tr>
                      )}
                      {/* Spans worked out per band, like the area row's — a section or team cut by
                          the band boundary is headed again on the next sheet. */}
                      {showParentHeader && (
                        <tr>
                          {!showAreaHeader && <th className="lm-print-th-model" rowSpan={headerRows}>Model</th>}
                          {parentSpansOf(band).map((s, i) => (
                            <th key={`${i}|${s.key}`} className="lm-print-th-parent" colSpan={s.span}>
                              <span className="lm-print-th-parent-text">{s.label}</span>
                            </th>
                          ))}
                          {!showAreaHeader && <th className="lm-print-th-total" rowSpan={headerRows}>Model total</th>}
                        </tr>
                      )}
                      <tr>
                        {headerRows === 1 && <th className="lm-print-th-model">Model</th>}
                        {band.map((col) => (
                          <th key={col.key} className="lm-print-th-job">
                            <span className="lm-print-th-job-text">{col.label}</span>
                          </th>
                        ))}
                        {headerRows === 1 && <th className="lm-print-th-total">Model total</th>}
                      </tr>
                      <tr>
                        <th colSpan={band.length + 2} className="lm-print-grp lm-print-grp-type">
                          {g.label}<span className="lm-print-grp-count">{plural(g.count, 'model')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.series.map((s) => (
                        <tr key={`s|${s.key}`} className="lm-print-nest-row">
                          <td colSpan={band.length + 2} className="lm-print-nest-cell">
                            <table className="lm-print-table lm-print-nest">
                              {colgroup}
                              <thead>
                                <tr>
                                  <th colSpan={band.length + 2} className="lm-print-grp lm-print-grp-series">
                                    {s.label}<span className="lm-print-grp-count">{plural(s.products.length, 'model')}</span>
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {s.products.map(printRow)}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ))}
              </section>
            )
          })}
        </div>
      )}
    </main>
  )
}

/**
 * One cell, on screen and on paper — the same component, so the two can't drift into describing
 * the same pair differently.
 *
 * The three cues on an untimed cell are colour, WEIGHT and the figure itself, in that order of
 * fragility: #dc2626 is --red, the same colour /model-total puts on a not-yet-timed 0, but on a
 * mono office printer it lands as a mid-grey LIGHTER than the black around it. Bold is what
 * survives that, and it is why the red is never the only cue.
 */
function Cell({ cell, columnLabel, jobCount, grain, model, onOpen, onEstimate, forPrint = false }: {
  cell: MatrixCell | undefined
  columnLabel: string
  /** How many visible jobs the column covers — 1 at job grain. Only used in the tooltip, to say
   * what a coarse figure is a sum OF. */
  jobCount: number
  grain: Grain
  model: string
  /** Open the cell drawer. Absent on the printed sheet, which is paper — the `forPrint` copy
   * renders the same figures with no interaction at all. */
  onOpen?: () => void
  /** Where an UNTIMED cell's click goes instead: /estimate, with this cell's job and model
   * selected. That is where the gap gets filled; every other cell still opens the drawer. */
  onEstimate?: () => void
  forPrint?: boolean
}) {
  const base = forPrint ? 'lm-print-td' : 'lm-td'
  const scope = grain === 'job' ? columnLabel : `${columnLabel} (${plural(jobCount, 'job')})`
  // The cell is a control on screen and a figure on paper. role/tabIndex rather than a <button>
  // inside the <td>: a button would need its own box model in a 13mm-wide cell and would fight the
  // sticky column's overflow, and the whole cell is the target anyway.
  const untimed = !!cell && cell.applies && cell.timedOps === 0
  const open = forPrint ? undefined : (untimed && onEstimate ? onEstimate : onOpen)
  const interactive = open
    ? {
      onClick: open,
      role: 'button' as const,
      tabIndex: 0,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
      },
    }
    : {}

  // BLANK, not 0: nothing under this column applies to this model, and 0 would be a claim that
  // something does and takes no time. Given a title anyway, because on screen an empty cell in a
  // 9,000-cell grid invites "is this broken?" and one hover should answer it.
  if (!cell || !cell.applies) {
    return (
      <td
        className={`${base} ${base}-na${open ? ' lm-td-open' : ''}`}
        title={forPrint ? undefined : `${scope} does not apply to ${model} — click to apply it`}
        {...interactive}
      />
    )
  }

  // The SAME rule at every grain — at job grain the counts are the job's operations, at coarser
  // grains they are those counts summed. See columnCells for why summing them is sufficient.
  const state: JobCompleteness = jobCompleteness(cell.timedOps, cell.totalOps)
  // WHERE the figure came from, as a background — on top of, never instead of, the text colour
  // and underline above. Measured only if every timed operation beneath is measured; one estimate
  // anywhere and the figure is partly inferred, so it reads as estimated. An untimed cell has no
  // figure to source and gets no background, which is what keeps the red 0.0 on white.
  const source = cell.timedOps === 0 ? '' : cell.estimatedOps > 0 ? ' lm-src-estimated' : ' lm-src-measured'
  const cls = ` ${base}-${state === 'none' ? 'none' : state === 'partial' ? 'partial' : 'timed'}${source}`
  const sourceNote = cell.timedOps === 0 ? ''
    : cell.estimatedOps === 0 ? ' · measured'
      : cell.estimatedOps === cell.timedOps ? ' · estimated'
        : ` · ${cell.estimatedOps} of ${cell.timedOps} timed operations estimated, so the figure counts as estimated`
  const title = forPrint ? undefined
    : (state === 'none' ? `${scope} · ${model} — applies, nothing timed yet (${plural(cell.totalOps, 'operation')})`
      : state === 'partial' ? `${scope} · ${model} — ${cell.timedOps} of ${cell.totalOps} operations timed; the figure is incomplete`
        : `${scope} · ${model} — ${plural(cell.totalOps, 'operation')}, all timed`)
      + sourceNote
      + (untimed && onEstimate ? ' · click to estimate it from measured models' : ' · click to open')

  return (
    <td className={`${base}${cls}${open ? ' lm-td-open' : ''}`} title={title} {...interactive}>
      {fmtMinutes(cell.minutes)}{state === 'partial' ? '*' : ''}
    </td>
  )
}

/**
 * A model's label in the left-hand column — the name, and how many builds it has still ahead.
 *
 * The count is `FutureBuildSummary.futureBuilds` off the SAME map the "future builds only"
 * toggle filters on (lib/schedule's fetchFutureBuilds, one read, one definition of today). The
 * two therefore agree by construction rather than by matching rules: a model absent from that
 * map gets no bracket here AND is the model the toggle hides. There is no second query and no
 * second date comparison anywhere in this screen.
 *
 * ZERO PRINTS NOTHING, not "(0)". A bracket is an annotation about work that is coming; "(0)" is
 * a figure, and a column of them would read as data. It is only ever visible with the toggle off
 * anyway — with it on, every row in the grid has at least one build by definition.
 *
 * The name truncates and the count does not: the model code is what people scan a 101-row column
 * for, but if one has to be lost to a narrow column it is the annotation. Hence the inner flex
 * rather than letting the cell's own ellipsis decide — a cell-level ellipsis eats whatever is
 * last, which is the count.
 */
function ModelLabel({ product, schedule, forPrint = false }: {
  product: Product
  schedule: FutureBuildSummary | undefined
  forPrint?: boolean
}) {
  const base = forPrint ? 'lm-print-model' : 'lm-model'
  return (
    <span
      className={`${base}-label`}
      title={forPrint ? undefined : schedule
        ? `${product.model} — ${plural(schedule.futureBuilds, 'build')} booked, next on line ${fmtScheduleDate(schedule.nextOnLine)}`
        : `${product.model} — no builds booked`}
    >
      <span className={`${base}-name`}>{product.model}</span>
      {schedule && <span className={`${base}-builds`}>({schedule.futureBuilds})</span>}
    </span>
  )
}

/** What the grid's three marked states mean, on screen. The printed sheet carries the same key
 * in its header — a legend that only exists on screen is a legend the person holding the paper
 * doesn't have. */
function Legend() {
  return (
    <div className="lm-legend">
      <span className="lm-legend-item"><span className="lm-legend-swatch lm-legend-na" /> Doesn’t apply to this model</span>
      <span className="lm-legend-item"><span className="lm-td-none lm-legend-fig">0.0</span> Applies, nothing timed</span>
      <span className="lm-legend-item"><span className="lm-td-partial lm-legend-fig">142.5*</span> Partly timed — figure incomplete</span>
      <span className="lm-legend-item"><span className="lm-td-timed lm-legend-fig">142.5</span> Fully timed</span>
      <span className="lm-legend-sep" aria-hidden />
      <span className="lm-legend-item"><span className="lm-legend-fig lm-src-measured">142.5</span> Measured</span>
      <span className="lm-legend-item"><span className="lm-legend-fig lm-src-estimated">142.5</span> Estimated — or a mix of measured and estimated, which counts as estimated</span>
    </div>
  )
}
