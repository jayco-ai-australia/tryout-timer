'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'
import ModelLinker, { ModelSeriesPicker } from '@/components/ModelLinker'
import BulkModelLinkDrawer, { DRAWER_WIDTH, useSlideOverDrawer } from '@/components/BulkModelLinkDrawer'
import JobEditDrawer from '@/components/JobEditDrawer'
import DuplicateJobsDrawer from '@/components/DuplicateJobsDrawer'
import JobFormModal from '@/components/JobFormModal'
import OperationEditDrawer from '@/components/OperationEditDrawer'
import OperatorAssign from '@/components/OperatorAssign'
import {
  currentForOperation, fetchOperationTimeNotes, historyLabel, operationProductKey, type OperationTimeStat,
} from '@/lib/operationTimes'
import { fmtDate, fmtMinutes } from '@/lib/format'
import { findSectionTray, setJobSection, sortSections, teamForJob } from '@/lib/sections'
import { logSupabaseError } from '@/lib/supabaseRead'
import { createOperation, setOperationJob } from '@/lib/operations'
import {
  JobsPane, Pane, RenameButton, ROW_INPUT, SectionsPane, UNSECTIONED_KEY, plural, teamNameForJob,
  type SectionEntry,
} from '@/components/FinderPanes'
import {
  MergeConfirm, MergeFooter, MergeNotices, MergeRowItem, useMergeMode,
  type MergeModeState, type MergeRow,
} from '@/components/MergeMode'
import {
  chunked, fetchLinksForOperations, fetchTimedPairs, linkOperationsToModels,
  unlinkOperationsFromModels, READ_CHUNK,
} from '@/lib/modelOperations'
import { fetchAllChunked } from '@/lib/supabaseRead'
import { modelsForLine } from '@/lib/lines'
import { usePersistedFilter } from '@/lib/useLocalStorage'
import { NO_SETUP_FOCUS, type SetupFocus } from '@/lib/setupLinks'
import type { Job, Operation, OperationTimeNote, Product, ProductionLine, Section, Team, UserRole } from '@/lib/types'

interface Props {
  lines: ProductionLine[]
  role: UserRole
  userId: string
  /** Where a deep link wants this screen pointed, resolved server-side (lib/setupLinks). */
  initialFocus?: SetupFocus
}

type SupabaseClient = ReturnType<typeof createClient>

const SEL: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
  border: '1.5px solid var(--border)', borderRadius: 8, padding: '7px 10px',
  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', outline: 'none', minWidth: 200,
}
const ERR_BOX: React.CSSProperties = { padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13 }
/** The ERR_BOX shape in the confirmation palette — used for "here's where that job went". */
const OK_BOX: React.CSSProperties = { padding: '9px 14px', borderRadius: 8, background: 'var(--green-bg)', border: '1px solid #bbf7d0', color: '#15803d', fontSize: 13 }

interface OperatorOption { id: string; full_name: string }
interface JobMoveOption { id: string; label: string }

function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

// ── Raw query shapes (relations come back object-or-array from PostgREST) ────────────────
interface RawTeamRef { id: string; name: string }
interface RawOperatorRef { id: string; full_name: string }
interface RawJob {
  id: string; name: string; primary_operator_id: string | null
  team_id: string | null; production_line_id: string | null; section_id: string | null; created_at: string
  teams: RawTeamRef | RawTeamRef[] | null
}
interface RawOperation {
  id: string; name: string; job_id: string
  primary_operator_id: string | null; secondary_operator_id: string | null; created_at: string
  primary_operator: RawOperatorRef | RawOperatorRef[] | null
  secondary_operator: RawOperatorRef | RawOperatorRef[] | null
}
interface RawJobOption { id: string; name: string; section_id: string | null }

/** Chunking for this screen's own bulk reads (jobs → operations, coverage) — the same sizes
 * lib/modelOperations uses for the applies-list, imported from there so there is one answer to
 * "how much fits in one PostgREST call".  */

// ── Operation-level model coverage ─────────────────────────────────────────────────────────
/**
 * Per-operation coverage: of the models linked to THIS operation via model_operations, how many
 * have at least one recorded operation_time. Deliberately simpler than lib/coverage.ts, which
 * rolls the same three junctions up to (job × model) combos — here the unit is one operation, so
 * a job's two operations covering different halves of the same model set each report their own
 * gap instead of cancelling each other out.
 *
 * "Timed" follows lib/coverage.ts' definition — the *existence* of an operation_time linked to
 * the model via operation_time_models — not whether that time has a total_minutes value, so an
 * in-progress capture still counts as collected. Coverage is deliberately unmoved by the
 * current-record rule: a superseded time is still a time that was collected, so a pair with
 * nothing but archived records still counts as timed here. (The FIGURES shown in pane 4 come
 * from the shared currentForOperation, which takes the current record and skips null minutes.)
 */
interface OperationCoverage { timed: number; total: number }

function computeOperationCoverage(input: {
  operationIds: string[]
  modelOperations: { operation_id: string; product_id: string }[]
  operationTimes: { id: string; operation_id: string }[]
  operationTimeModels: { operation_time_id: string; product_id: string }[]
}): Record<string, OperationCoverage> {
  const { operationIds, modelOperations, operationTimes, operationTimeModels } = input

  const linkedByOp = new Map<string, Set<string>>()
  for (const mo of modelOperations) {
    let set = linkedByOp.get(mo.operation_id)
    if (!set) { set = new Set(); linkedByOp.set(mo.operation_id, set) }
    set.add(mo.product_id)
  }

  const opByTimeId = new Map(operationTimes.map((t) => [t.id, t.operation_id]))
  const timedPairs = new Set<string>()
  for (const tm of operationTimeModels) {
    const opId = opByTimeId.get(tm.operation_time_id)
    if (opId) timedPairs.add(operationProductKey(opId, tm.product_id))
  }

  const result: Record<string, OperationCoverage> = {}
  for (const opId of operationIds) {
    const linked = linkedByOp.get(opId)
    let timed = 0
    if (linked) for (const productId of linked) if (timedPairs.has(operationProductKey(opId, productId))) timed += 1
    result[opId] = { timed, total: linked?.size ?? 0 }
  }
  return result
}

/** green = every linked model timed, amber = partly timed, red = none timed, grey = no models
 * linked yet (nothing declared, which is a different thing from a 0% gap). */
function coverageBadgeClass(coverage: OperationCoverage): string {
  if (coverage.total === 0) return 'badge-grey'
  if (coverage.timed >= coverage.total) return 'badge-green'
  if (coverage.timed === 0) return 'badge-red'
  return 'badge-amber'
}

/**
 * Spelled out against the JOB badge one pane to the left, which counts a different thing —
 * "applies to 9 of 29 models" there, "timed on 1 of 29 models" here. Both are shown as "n / m"
 * and they are NOT the same fraction; the tooltips are the disambiguation.
 */
function coverageTitle(coverage: OperationCoverage): string {
  if (coverage.total === 0) return 'No models linked to this operation yet'
  return `Timed on ${coverage.timed} of ${plural(coverage.total, 'model')} this operation is linked to `
    + '— collection progress, not applicability (the job badge counts what the job applies to)'
}

function CoverageBadge({ coverage, loading }: { coverage: OperationCoverage | undefined; loading: boolean }) {
  if (!coverage) {
    return <span className="badge badge-grey" title={loading ? 'Loading coverage…' : 'Coverage unavailable'}>{loading ? '…' : '—'}</span>
  }
  return (
    <span className={'badge ' + coverageBadgeClass(coverage)} title={coverageTitle(coverage)}>
      {coverage.timed} / {coverage.total}
    </span>
  )
}



export default function SetupClient({ lines, role, userId, initialFocus = NO_SETUP_FOCUS }: Props) {
  const supabase = useState(() => createClient())[0]

  // ── Filter bar: scopes every pane below ────────────────────────────────────────────────
  // Each takes the deep link's value as an override where one was given — it wins over the
  // remembered position outright, so arriving from /model-total's "Merge with another job…"
  // lands on that job instead of wherever this screen was last left. See usePersistedFilter.
  const [lineId, setLineId] = usePersistedFilter('jmotion_setup_line', '', initialFocus.lineId)
  const [teamId, setTeamId] = usePersistedFilter('jmotion_setup_team')
  // ── Drill position: persisted so a refresh comes back to the same operation ─────────────
  const [sectionKey, setSectionKey] = usePersistedFilter('jmotion_setup_section', '', initialFocus.sectionKey)
  const [jobId, setJobId] = usePersistedFilter('jmotion_setup_job', '', initialFocus.jobId)
  const [operationId, setOperationId] = usePersistedFilter('jmotion_setup_operation', '', initialFocus.operationId)
  /**
   * Whether the persisted filters above have finished restoring from localStorage.
   *
   * THIS IS THE RUNAWAY READ. usePersistedFilter starts at '' and restores in a mount effect, so
   * the FIRST render of this screen has no line and no team — and loadJobs treats "no line, no
   * team" as a legitimate "All lines" view and fetches EVERY JOB IN THE DATABASE, then every
   * operation under them, then pages model_operations over the whole lot in 150-id chunks. That
   * is the dozens of repeated reads: not one query firing dozens of times, but one sweep over
   * thousands of operations that has no business running at all, immediately followed by the
   * real scoped one when the restore lands a tick later.
   *
   * The hooks above register their restore effects BEFORE this one, so by the time this commits
   * lineId/teamId already hold their stored values and the first fetch is the correct one. An
   * "All lines" view chosen deliberately still works — it just isn't guessed at on mount.
   */
  const [filtersRestored, setFiltersRestored] = useState(false)
  useEffect(() => { setFiltersRestored(true) }, [])

  // Deliberately not persisted — a search term is a momentary "find me this one operation",
  // not a scope the screen should still be in next time it's opened.
  const [search, setSearch] = useState('')

  const [allTeams, setAllTeams] = useState<Team[]>([])
  const [allSections, setAllSections] = useState<Section[]>([])
  const [allActiveOperators, setAllActiveOperators] = useState<OperatorOption[]>([])
  /** Every job, for the "move to another job" dropdown — raw, because its label carries the
   * job's team and that is DERIVED from its section rather than stored on the row. */
  const [allJobRows, setAllJobRows] = useState<RawJobOption[]>([])

  const [jobs, setJobs] = useState<Job[]>([])
  const [operationsByJob, setOperationsByJob] = useState<Record<string, Operation[]>>({})
  const [loadingJobs, setLoadingJobs] = useState(false)

  const [coverageByOp, setCoverageByOp] = useState<Record<string, OperationCoverage>>({})
  /**
   * The applies-list rows the coverage sweep already fetched, kept rather than discarded.
   *
   * The per-job "9 / 29 models" badge needs applicability for every job on the line, and this IS
   * that data — the sweep reads model_operations for every loaded operation, which is a superset
   * of what any job-level rollup needs. Keeping the rows adds no query; throwing them away and
   * asking again per job would have added one per row.
   */
  const [modelLinkPairs, setModelLinkPairs] = useState<{ operation_id: string; product_id: string }[]>([])
  /** Bumped to re-run the sweep alone after the job model panel writes — see jobModelsDrawer. */
  const [applicabilityVersion, setApplicabilityVersion] = useState(0)
  /** Every product, once. The badge's DENOMINATOR is "models on this line", which the sweep
   * cannot supply: a product linked to nothing never appears in model_operations at all. Loaded
   * with the other one-time reference data below and filtered by line client-side. */
  /** Models for the line in scope, from lib/lines' modelsForLine. Named for what it holds: it
   * is no longer every product in the database. */
  const [lineProducts, setLineProducts] = useState<Product[]>([])
  const [loadingCoverage, setLoadingCoverage] = useState(false)
  /** Bumped whenever pane 4's ModelLinker writes, so the collected-times panel under it
   * re-reads instead of showing the model set it loaded with. */
  const [panelDataVersion, setPanelDataVersion] = useState(0)

  const [pageError, setPageError] = useState<string | null>(null)

  const [jobModal, setJobModal] = useState<{ mode: 'add' | 'edit'; job?: Job } | null>(null)
  // The job edit/reassign slide-over. Holds the job row itself, not its id: a save can move the
  // job out of the current filter entirely, and the drawer still has to render its own subject
  // while it animates closed.
  /** The operation open in the shared editor, or null. */
  const [operationDrawer, setOperationDrawer] = useState<Operation | null>(null)
  const [jobDrawer, setJobDrawer] = useState<Job | null>(null)
  const [jobDrawerVisible, setJobDrawerVisible] = useState(false)
  /** "Moved to X · Y" after a save — the only trace of a job that just left the current
   * filter, so it's cleared on the next drawer open rather than the next render. */
  const [jobNotice, setJobNotice] = useState<string | null>(null)
  const [operationModal, setOperationModal] = useState<{ jobId: string; jobName: string } | null>(null)
  const [moveModal, setMoveModal] = useState<Operation | null>(null)

  // ── Pane 3 modes ───────────────────────────────────────────────────────────────────────
  // 'bulk' — multi-select operations, then apply one model set to all of them. Merge is NOT a
  // mode here any more: it lives in the shared merge-mode hook below, the same one the Sections
  // and Jobs panes mount, so the three levels of the walk offer one affordance rather than three.
  const [opMode, setOpMode] = useState<'normal' | 'bulk'>('normal')
  const [opSelection, setOpSelection] = useState<Set<string>>(new Set())
  /** The optional operator strip in pane 3 — collapsed by default (phase-1: operators are
   * context only, so nothing on this screen waits on them). */
  const [operatorsOpen, setOperatorsOpen] = useState(false)
  /** The duplicate-name reconciliation drawer — see components/DuplicateJobsDrawer. It is a
   * drawer rather than a fourth pane because it is a reconciliation task over the WHOLE line,
   * not another step of the Section → Job → Operation drill the panes exist for. */
  const [duplicatesOpen, setDuplicatesOpen] = useState(false)

  const [blockedDeleteJob, setBlockedDeleteJob] = useState<string | null>(null)
  const [blockedDeleteOperation, setBlockedDeleteOperation] = useState<string | null>(null)
  const [confirmDeleteJob, setConfirmDeleteJob] = useState<Job | null>(null)
  const [confirmDeleteOperation, setConfirmDeleteOperation] = useState<Operation | null>(null)

  // ── One-time reference data: all teams (for form/filter selects), all active operators
  // (for primary/secondary selects — deliberately not scoped to a team),
  // all jobs (for the "move to another job" dropdown, which must reach beyond the current
  // filter). ──────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.from('teams').select('*').order('name').then(({ data }) => setAllTeams(data ?? []))
    reloadSections()
    // No is_active filter: `operators` has no such column (it lives on sections/jobs/operations
    // only), and filtering on it here was a 400 on every load. Errors are surfaced rather than
    // swallowed — a silently empty operator list reads as "nobody is set up", not as a failure.
    supabase.from('operators').select('id, full_name').order('full_name')
      .then(({ data, error }) => {
        if (error) { logSupabaseError('operators (Setup picker list)', error); return }
        setAllActiveOperators((data ?? []) as OperatorOption[])
      })
    // Feeds the "move to another job" dropdown — a list, so retired jobs are filtered out
    // (lib/jobs). Sending an operation to a merged-away job would hide it from every screen.
    supabase.from('jobs').select('id, name, section_id').eq('is_active', true).order('name')
      .then(({ data }) => setAllJobRows((data ?? []) as RawJobOption[]))
  }, [supabase])

  const teamOptions = lineId ? allTeams.filter((t) => t.production_line_id === lineId) : allTeams

  /**
   * The Team filter, ignored when the stored id isn't one of the teams currently on offer.
   *
   * THIS IS THE EMPTY SECTIONS PANE. sectionKey and jobId already fall back this way (see
   * activeSectionKey/activeJobId below) but teamId did not, and it is persisted independently of
   * the line. Pick Caravan + a Caravan team, switch to Motor Home in another session or after
   * the team list changes, and localStorage restores BOTH — lineId wins for the line name, so
   * the header says "Motor Home", while every Motor Home section is filtered against a Caravan
   * team id and none match.
   *
   * That produced an empty pane with no error, because it is not a failure: sectionOptions is
   * legitimately empty, and sectionEntries' fallback "No section" row is suppressed while a team
   * filter is active (a team that owns no sections here genuinely has nothing to show). The two
   * correct behaviours combined into "this line has no sections and no jobs yet" on a line with
   * twelve of them.
   *
   * The stored value is left alone rather than cleared — same rule as the other two: a refresh
   * restores the position when it still applies, and shows everything when it doesn't.
   */
  const activeTeamId = teamOptions.some((t) => t.id === teamId) ? teamId : ''

  // ── Scope ──────────────────────────────────────────────────────────────────────────────
  // Which line the screen is effectively looking at. Sections belong to exactly one line, so a
  // team filter with no line chosen still resolves to that team's line — otherwise picking a
  // team would silently switch section grouping off.
  const scopeLineId = useMemo(() => {
    if (lineId) return lineId
    if (activeTeamId) return allTeams.find((t) => t.id === activeTeamId)?.production_line_id ?? ''
    return ''
  }, [lineId, activeTeamId, allTeams])

  /**
   * The models in scope — the "of 29 models" denominator on every job badge.
   *
   * Scoped by lib/lines rather than by fetching every product and filtering on
   * production_line_id, which is what this did before. Two reasons, and the second is the
   * important one: it stops reading the whole products table to count one line's worth, and a
   * pre-assembly line owns no products at all, so the old client-side filter counted zero and
   * every badge on Chassis, Sew, Lamination and the rest read "n / 0 models".
   *
   * Re-runs on the line in scope only. "All lines" (no line chosen) yields every product, which
   * is what the unscoped view has always meant by it.
   */
  useEffect(() => {
    let cancelled = false
    modelsForLine(supabase, scopeLineId || null)
      .then((rows) => { if (!cancelled) setLineProducts(rows) })
      .catch((err) => { if (!cancelled) console.error('[setup] could not load models for this line:', err) })
    return () => { cancelled = true }
  }, [supabase, scopeLineId])

  async function reloadSections() {
    // Retired sections (merged away — see lib/sections' mergeSections) never appear in a list,
    // a pane or a picker. Every section dropdown on this screen is built from allSections, so
    // this one filter covers them all.
    const { data } = await supabase.from('sections').select('*').eq('is_active', true).order('sort_order')
    setAllSections(sortSections((data ?? []) as Section[]))
  }

  /**
   * Jobs in scope. Keyed on the LINE, not the team, because a job's team is derived from its
   * section (see teamForJob) and jobs.team_id can lag behind a section move — filtering the
   * query by it would drop jobs that belong to the chosen team by every rule the walk uses. The
   * team narrowing happens client-side, over `scopedJobs` below.
   *
   * The team_id fallback is only for the first render, before allTeams has arrived and
   * scopeLineId can resolve the chosen team's line; it keeps that moment from fetching every
   * job in the database.
   */
  const jobsRunRef = useRef(0)

  async function loadJobs() {
    // Same guard the coverage sweep below already carries. Two loadJobs calls can overlap
    // whenever the scope changes, and the LAST TO FINISH wins rather than the last to start —
    // a broad read is far slower than a narrow one, so without this the wrong one lands.
    const runId = ++jobsRunRef.current
    const isCurrent = () => jobsRunRef.current === runId
    setLoadingJobs(true)
    // Retired jobs (merged away — see lib/jobs' mergeJobs) never appear in a pane, a list or a
    // picker, exactly as retired sections and operations don't.
    let q = supabase.from('jobs').select('*, teams ( id, name )').eq('is_active', true).order('name')
    if (scopeLineId) q = q.eq('production_line_id', scopeLineId)
    else if (activeTeamId) q = q.eq('team_id', activeTeamId)
    const { data: jobRows } = await q
    if (!isCurrent()) return

    const loadedJobs: Job[] = ((jobRows ?? []) as unknown as RawJob[]).map((r) => ({
      id: r.id, name: r.name, primary_operator_id: r.primary_operator_id,
      team_id: r.team_id, production_line_id: r.production_line_id, section_id: r.section_id,
      created_at: r.created_at,
      teams: one(r.teams),
    }))
    setJobs(loadedJobs)

    const jobIds = loadedJobs.map((j) => j.id)
    if (jobIds.length === 0) { setOperationsByJob({}); setLoadingJobs(false); return }


    const grouped: Record<string, Operation[]> = {}
    for (const chunk of chunked(jobIds, READ_CHUNK)) {
      const { data: opRows } = await supabase
        .from('operations')
        .select('*, primary_operator:primary_operator_id ( id, full_name ), secondary_operator:secondary_operator_id ( id, full_name )')
        .in('job_id', chunk)
        .eq('is_active', true)
        .order('name')

      for (const r of (opRows ?? []) as unknown as RawOperation[]) {
        const op: Operation = {
          id: r.id, name: r.name, job_id: r.job_id,
          primary_operator_id: r.primary_operator_id, secondary_operator_id: r.secondary_operator_id,
          created_at: r.created_at,
          primary_operator: one(r.primary_operator),
          secondary_operator: one(r.secondary_operator),
        }
        ;(grouped[op.job_id] ??= []).push(op)
      }
    }
    if (!isCurrent()) return
    setOperationsByJob(grouped)
    setLoadingJobs(false)
  }

  useEffect(() => {
    if (!filtersRestored) return
    loadJobs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, scopeLineId, activeTeamId, filtersRestored])

  // ── Per-operation coverage for everything currently loaded ─────────────────────────────
  // One pass over the whole scoped set (not per visible row), so drilling between sections/jobs
  // or typing in the search box re-renders badges from data already in hand instead of firing
  // a fresh round of queries per keystroke.
  /**
   * Keyed by CONTENT, not by identity. operationsByJob is a fresh object after every loadJobs —
   * including a refreshAll that changed nothing — and a fresh array dependency re-ran this whole
   * sweep each time. The joined string is the actual dependency; the array is derived from it,
   * so it only changes identity when the id SET changes.
   */
  const loadedOperationIdsKey = useMemo(
    () => Object.values(operationsByJob).flat().map((o) => o.id).sort().join(','),
    [operationsByJob]
  )
  const loadedOperationIds = useMemo(
    () => (loadedOperationIdsKey ? loadedOperationIdsKey.split(',') : []),
    [loadedOperationIdsKey]
  )
  const coverageRunRef = useRef(0)

  useEffect(() => {
    const runId = ++coverageRunRef.current
    if (loadedOperationIds.length === 0) { setCoverageByOp({}); setModelLinkPairs([]); setLoadingCoverage(false); return }

    let cancelled = false
    async function load() {
      setLoadingCoverage(true)
      try {
        // All three reads go through fetchAllChunked: the id lists are still chunked at
        // READ_CHUNK for URL length, and each chunk is now PAGED, because a 150-operation chunk
        // asks for far more than the 1000-row response cap (this operation alone has 34 models)
        // and the excess used to be dropped silently — which is exactly why every badge read
        // "0 / 0". Each query carries a total order over its primary key, without which paging
        // could repeat rows on one page and skip them on the next.
        const modelOperations = await fetchAllChunked<{ operation_id: string; product_id: string }>(
          loadedOperationIds, READ_CHUNK,
          (chunk) => supabase
            .from('model_operations').select('operation_id, product_id').in('operation_id', chunk)
            .order('operation_id').order('product_id'),
          { table: 'model_operations' }
        )

        // NOT filtered to the current record, and it must never be: this feeds the coverage
        // badges, and coverage asks "has this ever been timed?", not "what is the figure?". A
        // pair whose only records are archived has still been timed. Filtering here would move
        // coverage as a side effect of the labour-content rule, which is exactly what must not
        // happen. It reads no minutes at all — see lib/coverage.ts.
        const operationTimes = await fetchAllChunked<{ id: string; operation_id: string }>(
          loadedOperationIds, READ_CHUNK,
          (chunk) => supabase
            .from('operation_times').select('id, operation_id').in('operation_id', chunk)
            .order('id'),
          { table: 'operation_times' }
        )

        const operationTimeModels = await fetchAllChunked<{ operation_time_id: string; product_id: string }>(
          operationTimes.map((t) => t.id), READ_CHUNK,
          (chunk) => supabase
            .from('operation_time_models').select('operation_time_id, product_id').in('operation_time_id', chunk)
            .order('operation_time_id').order('product_id'),
          { table: 'operation_time_models' }
        )

        if (cancelled || coverageRunRef.current !== runId) return
        setModelLinkPairs(modelOperations)
        setCoverageByOp(computeOperationCoverage({
          operationIds: loadedOperationIds, modelOperations, operationTimes, operationTimeModels,
        }))
      } catch (err) {
        // A coverage failure must not take the structure-editing screen down with it — the
        // badges fall back to "—" and the rest of the page keeps working.
        if (!cancelled && coverageRunRef.current === runId) {
          setCoverageByOp({})
          setModelLinkPairs([])
          console.error('[setup] could not load operation coverage:', err)
        }
      } finally {
        if (!cancelled && coverageRunRef.current === runId) setLoadingCoverage(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [supabase, loadedOperationIds, applicabilityVersion])

  /**
   * ── Per-job model applicability, derived from the sweep above ─────────────────────────
   *
   * "A job applies to a model if ANY of its operations is linked to it" — the settled job-level
   * rollup (lib/modelOperations' jobsApplying), computed here over the rows the coverage sweep
   * ALREADY fetched. No per-job query, nothing fetched inside a map, no extra effect: the
   * model_operations read count for a page load is exactly what it was.
   *
   * Both dependencies are state that changes only when a load completes, never per render, so
   * this recomputes once per sweep rather than on every keystroke in the search box.
   *
   * NOT to be confused with the coverage badge on operation rows: that one is timed/linked for
   * one operation, this is applies/all-models-on-the-line for a whole job. See JobsPane.
   */
  const jobModelIds = useMemo(() => {
    const jobByOperation = new Map<string, string>()
    for (const [jid, ops] of Object.entries(operationsByJob)) for (const o of ops) jobByOperation.set(o.id, jid)
    const byJob = new Map<string, Set<string>>()
    for (const pair of modelLinkPairs) {
      const jid = jobByOperation.get(pair.operation_id)
      if (!jid) continue
      const set = byJob.get(jid)
      if (set) set.add(pair.product_id)
      else byJob.set(jid, new Set([pair.product_id]))
    }
    return byJob
  }, [modelLinkPairs, operationsByJob])

  const jobModelCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const [jid, set] of jobModelIds) counts.set(jid, set.size)
    return counts
  }, [jobModelIds])

  /** The denominator: models on the line in scope — see the loader above. Deliberately NOT
   * re-filtered by production_line_id here: on a pre-assembly line these rows carry the id of
   * the BUILD line the model really belongs to, and re-filtering would zero the count again. */
  const lineProductCount = scopeLineId ? lineProducts.length : 0

  // ── The job's model panel ──────────────────────────────────────────────────────────────
  // Reuses BulkModelLinkDrawer rather than adding a second drawer or a second write path; the
  // per-job variant is that component in "job mode" — see jobLinkCounts there.
  const [modelJob, setModelJob] = useState<Job | null>(null)
  const {
    open: jobModelsOpen, visible: jobModelsVisible,
    openDrawer: showJobModels, closeDrawer: hideJobModels,
  } = useSlideOverDrawer()

  const modelJobOperations = useMemo(
    () => (modelJob ? operationsByJob[modelJob.id] ?? [] : []),
    [modelJob, operationsByJob]
  )

  /**
   * How many of THIS job's operations each model is linked to — the "3 of 8 operations" partial
   * state. Same rows as the badge, narrowed to one job, so the panel and the badge cannot
   * disagree and neither costs a read.
   */
  const modelJobLinkCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (!modelJob) return counts
    const opIds = new Set(modelJobOperations.map((o) => o.id))
    for (const pair of modelLinkPairs) {
      if (!opIds.has(pair.operation_id)) continue
      counts.set(pair.product_id, (counts.get(pair.product_id) ?? 0) + 1)
    }
    return counts
  }, [modelJob, modelJobOperations, modelLinkPairs])

  function openJobModels(job: Job) {
    setModelJob(job)
    showJobModels()
  }

  // Refresh the "move to another job" list too, so a job just added/renamed/deleted shows up
  // there without a full page reload.
  async function refreshAll() {
    await loadJobs()
    // Same list, same filter as the initial load above — see lib/jobs.
    const { data } = await supabase.from('jobs').select('id, name, section_id').eq('is_active', true).order('name')
    setAllJobRows((data ?? []) as RawJobOption[])
  }

  const scopeLineName = lines.find((l) => l.id === scopeLineId)?.name ?? null
  const scopeTeams = useMemo(
    () => allTeams.filter((t) => t.production_line_id === scopeLineId),
    [allTeams, scopeLineId]
  )

  /**
   * The scoped line's sections, in walk order — narrowed by the Team filter, because a section
   * belongs to exactly one team and a job's team now comes FROM its section. Choosing a team is
   * therefore choosing that team's part of the walk, and the sections it doesn't own have
   * nothing in them to show.
   */
  const sectionOptions = useMemo(() => {
    if (!scopeLineId) return []
    const onLine = allSections.filter((s) => s.production_line_id === scopeLineId)
    return sortSections(activeTeamId ? onLine.filter((s) => s.team_id === activeTeamId) : onLine)
  }, [allSections, scopeLineId, activeTeamId])

  /** Every loaded section by id — the lookup teamForJob reads a job's team through. Built from
   * ALL sections, not the scoped ones: a job's team is a property of the section it points at,
   * whether or not that section is in the current view. */
  /** Team names for the derived job-team the panes show. */
  const teamNameById = useMemo(() => new Map(allTeams.map((t) => [t.id, t.name])), [allTeams])

  const sectionsById = useMemo(() => new Map(allSections.map((s) => [s.id, s])), [allSections])

  /** The "move to another job" labels, with each job's team derived through its section. */
  const allJobOptions = useMemo<JobMoveOption[]>(() => allJobRows.map((r) => {
    const jobTeamId = teamForJob(r, sectionsById)
    const teamName = jobTeamId ? teamNameById.get(jobTeamId) ?? null : null
    return { id: r.id, label: teamName ? `${r.name} — ${teamName}` : r.name }
  }), [allJobRows, sectionsById, teamNameById])

  /**
   * The jobs the panes actually work over. The Team filter is applied here, on the team derived
   * from each job's section, so it agrees with the section list above rather than with whatever
   * jobs.team_id happens to say.
   */
  const scopedJobs = useMemo(
    () => (activeTeamId ? jobs.filter((j) => teamForJob(j, sectionsById) === activeTeamId) : jobs),
    [jobs, activeTeamId, sectionsById]
  )

  // ── Pane 1 data: the line's sections, its unsorted tray, and the legacy stray bucket ───
  /** The unsorted tray jobs fall back to: the scoped TEAM's tray on the scoped line. There is
   * one tray per team now, so with no team filtered the line has several and none of them is
   * "the line's" — findSectionTray returns null and the stray jobs land in the virtual bucket
   * below, which is where work belonging to no team in view belongs. */
  const noSectionTray = useMemo(
    () => findSectionTray(allSections, scopeLineId, activeTeamId),
    [allSections, scopeLineId, activeTeamId]
  )

  /**
   * Loaded jobs bucketed by the pane-1 row they belong under: their own section when it is in
   * view, otherwise the line's unsorted tray — which is where a job with no section_id (or one
   * pointing at another line's section) belongs. UNSECTIONED_KEY is only the last resort, for a
   * view with no line in scope and for a line whose tray row is missing.
   */
  const jobsBySectionKey = useMemo(() => {
    const map = new Map<string, Job[]>()
    const known = new Set(sectionOptions.map((s) => s.id))
    const trayKey = noSectionTray && known.has(noSectionTray.id) ? noSectionTray.id : UNSECTIONED_KEY
    for (const job of scopedJobs) {
      const key = job.section_id && known.has(job.section_id) ? job.section_id : trayKey
      const list = map.get(key)
      if (list) list.push(job)
      else map.set(key, [job])
    }
    return map
  }, [scopedJobs, sectionOptions, noSectionTray])

  /**
   * Pane 1's rows: the line's sections in walk order, plus "Unsectioned" at the bottom whenever it
   * holds anything. A line with no sections at all gets Unsectioned as its single entry — every
   * job lives there, and no empty section scaffolding is invented.
   *
   * That fallback row is suppressed while a team filter is active, because a team that owns no
   * sections on this line genuinely has nothing to show. Correct — but combined with a STALE
   * team id it rendered a fully-sectioned line as empty, which is what activeTeamId now prevents.
   */
  const sectionEntries = useMemo<SectionEntry[]>(() => {
    const entries: SectionEntry[] = sectionOptions.map((s) => ({
      key: s.id, name: s.name, section: s, jobCount: (jobsBySectionKey.get(s.id) ?? []).length,
    }))
    // The virtual bucket, only where a real tray can't stand in: anything that actually landed
    // there is shown rather than silently dropped, and an empty pane with no line in scope still
    // gets its "All jobs" row. With a tray in view this count is 0 and no row is added.
    const strayCount = (jobsBySectionKey.get(UNSECTIONED_KEY) ?? []).length
    if (strayCount > 0 || (sectionOptions.length === 0 && !activeTeamId)) {
      entries.push({
        key: UNSECTIONED_KEY,
        name: scopeLineId ? 'No section' : 'All jobs',
        section: null,
        jobCount: strayCount,
      })
    }
    return entries
  }, [sectionOptions, jobsBySectionKey, scopeLineId, activeTeamId])

  // A persisted id can outlive the scope it was chosen in (line changed, section deleted, job
  // moved). Rather than write over the stored value, fall back to "nothing selected" whenever
  // the id isn't among the options actually available right now — so a refresh restores the
  // position when it still exists, and shows an empty state when it doesn't.
  const activeSectionKey = sectionEntries.some((e) => e.key === sectionKey) ? sectionKey : ''
  const activeSectionEntry = sectionEntries.find((e) => e.key === activeSectionKey) ?? null

  // ── Pane 2 data ────────────────────────────────────────────────────────────────────────
  const jobsInSection = useMemo(
    () => (activeSectionKey ? jobsBySectionKey.get(activeSectionKey) ?? [] : []),
    [activeSectionKey, jobsBySectionKey]
  )
  const activeJobId = jobsInSection.some((j) => j.id === jobId) ? jobId : ''
  const selectedJob = jobsInSection.find((j) => j.id === activeJobId) ?? null

  // ── Pane 3 data ────────────────────────────────────────────────────────────────────────
  const operations = useMemo(
    () => (activeJobId ? operationsByJob[activeJobId] ?? [] : []),
    [activeJobId, operationsByJob]
  )
  const activeOperationId = operations.some((o) => o.id === operationId) ? operationId : ''
  const selectedOperation = operations.find((o) => o.id === activeOperationId) ?? null

  /**
   * Pane 3's merge mode — the same hook the Sections and Jobs panes mount, at the operation
   * level. The pane is already scoped to one job, so every row shares a group; the key is
   * computed from job_id anyway, because that is the rule lib/mergeOperations enforces and the
   * two must not be able to disagree.
   */
  const opMergeRows = useMemo<MergeRow<Operation>[]>(
    () => operations.map((op) => ({ id: op.id, name: op.name, groupKey: `job:${op.job_id}`, subject: op })),
    [operations]
  )
  const opMerge = useMergeMode({
    level: 'operation',
    supabase,
    userId,
    rows: opMergeRows,
    onMerged: async () => {
      await refreshAll()
      setPanelDataVersion((v) => v + 1)
    },
  })

  // ── Drill actions ──────────────────────────────────────────────────────────────────────
  function selectSection(key: string) {
    setSectionKey(key)
    setJobId('')
    setOperationId('')
  }
  function selectJob(id: string) {
    setJobId(id)
    setOperationId('')
  }

  /** Search's "take me to it": set all three panes at once so the operation is on screen in
   * context (its section, its job) rather than as a lone row. */
  function revealOperation(op: Operation, job: Job) {
    const inLine = job.section_id && sectionOptions.some((s) => s.id === job.section_id)
    setSectionKey(inLine ? (job.section_id as string) : UNSECTIONED_KEY)
    setJobId(job.id)
    setOperationId(op.id)
  }

  /**
   * Deep-linked operation merge: arm the pane's merge mode with this operation already ticked,
   * leaving the TARGET to be chosen here — which is the whole point of sending the user to this
   * screen instead of merging from /model-total. A merge moves times and notes and retires a
   * row for every model on the line; the choice of what survives belongs on the screen that owns
   * the structure.
   *
   * Fires once, and only once the operation is actually in `operations` — merge.toggle looks the
   * row up by id and silently ignores an id it can't find, so arming before the pane has loaded
   * would open an empty merge mode with nothing ticked.
   */
  const armedMerge = useRef(false)
  useEffect(() => {
    if (armedMerge.current) return
    if (initialFocus.merge !== 'operation' || !initialFocus.operationId) return
    if (!operations.some((o) => o.id === initialFocus.operationId)) return
    armedMerge.current = true
    opMerge.start()
    opMerge.toggle(initialFocus.operationId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operations, initialFocus])

  // Changing what pane 3 is showing invalidates any multi-select held against the old job.
  useEffect(() => {
    setOpMode('normal')
    setOpSelection(new Set())
    // A merge armed by the deep link must survive this — it fires on the same pass that first
    // sets activeJobId, and cancelling here would undo it before the user sees it.
    if (!armedMerge.current) opMerge.cancel()
    setOperatorsOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId])

  // ── Search across everything loaded ────────────────────────────────────────────────────
  const sectionNameById = useMemo(() => new Map(allSections.map((s) => [s.id, s.name])), [allSections])
  const searchTerm = search.trim().toLowerCase()
  const searching = searchTerm.length > 0

  /** Every operation whose name matches, anywhere in the Line/Team scope — each carries its own
   * job (and section) so a name that repeats across jobs is still unambiguous. */
  const searchResults = useMemo(() => {
    if (!searching) return []
    const rows: { operation: Operation; job: Job; sectionName: string | null }[] = []
    for (const job of scopedJobs) {
      for (const op of operationsByJob[job.id] ?? []) {
        if (!op.name.toLowerCase().includes(searchTerm)) continue
        rows.push({ operation: op, job, sectionName: job.section_id ? sectionNameById.get(job.section_id) ?? null : null })
      }
    }
    return rows.sort((a, b) => a.operation.name.localeCompare(b.operation.name) || a.job.name.localeCompare(b.job.name))
  }, [searching, searchTerm, scopedJobs, operationsByJob, sectionNameById])

  // Raw teamId, not activeTeamId, on purpose: a stored team that no longer applies is still
  // something Clear should be offered for and able to reset.
  const filtersActive = Boolean(lineId || teamId || search)

  function clearFilters() {
    setLineId(''); setTeamId(''); setSearch('')
    setSectionKey(''); setJobId(''); setOperationId('')
  }

  // ── Section writes (pane 1) ──────────────────────────────────────────────────────────────
  async function afterSectionChange() {
    await reloadSections()
    await loadJobs()
  }

  // ── Job writes (pane 2) ────────────────────────────────────────────────────────────────
  /**
   * The single save path behind the job drawer: rename, then re-section. Both are optional — the
   * drawer only asks for what actually changed — and the re-section goes through sections.ts'
   * setJobSection, so the job's team/line follow the target section rather than being written here.
   *
   * Deliberately does NOT follow the job to its new section. Once a job moves to another team's
   * section the current Line→Team filter may legitimately exclude it, and chasing it would mean
   * silently rewriting the filter the user set. It drops out of the list and the returned
   * summary is what tells them where it went.
   */
  async function saveJobEdit(job: Job, name: string, section: Section | null): Promise<void> {
    setPageError(null)
    const trimmed = name.trim()

    if (trimmed && trimmed !== job.name) {
      const { error } = await supabase.from('jobs').update({ name: trimmed }).eq('id', job.id)
      if (error) throw new Error(error.message)
    }

    const currentSectionId = job.section_id ?? null
    if ((section?.id ?? null) !== currentSectionId) {
      await setJobSection(supabase, job.id, section)
    }

    await reloadSections()
    await refreshAll()
  }

  function openJobDrawer(job: Job) {
    setJobNotice(null)
    setJobDrawer(job)
    requestAnimationFrame(() => requestAnimationFrame(() => setJobDrawerVisible(true)))
  }
  function closeJobDrawer() {
    setJobDrawerVisible(false)
    window.setTimeout(() => setJobDrawer(null), 320)
  }

  useEffect(() => {
    if (!jobDrawer) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closeJobDrawer() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobDrawer])

  async function addJob(name: string) {
    const trimmed = name.trim()
    if (!trimmed || !activeSectionEntry) return
    setPageError(null)
    // Adding under the virtual bucket still lands the job in the line's real tray, so a job is
    // never created with a null section_id where a tray exists to hold it.
    const section = activeSectionEntry.section ?? noSectionTray
    const { data, error } = await supabase.from('jobs').insert({
      name: trimmed,
      production_line_id: scopeLineId || null,
      // The SECTION owns the team — the same rule setJobSection enforces on a move. A job added
      // to the unsorted tray gets no team, because unsorted work isn't anybody's yet.
      team_id: section?.team_id ?? null,
      section_id: section?.id ?? null,
    }).select('id').single()
    if (error) { setPageError(error.message); return }
    await refreshAll()
    if (data?.id) selectJob(data.id)
  }

  async function requestDeleteJob(job: Job) {
    setPageError(null)
    // Deliberately counts retired operations too (no is_active filter, unlike pane 3):
    // operations.job_id cascades on delete, and operation_times.operation_id cascades from
    // there, so letting a job be deleted because its only remaining operations are hidden would
    // destroy their history rather than just hide it.
    const { count } = await supabase.from('operations').select('id', { count: 'exact', head: true }).eq('job_id', job.id)
    if ((count ?? 0) > 0) { setBlockedDeleteJob(job.name); return }
    setConfirmDeleteJob(job)
  }

  async function handleDeleteJob(job: Job) {
    const { error } = await supabase.from('jobs').delete().eq('id', job.id)
    setConfirmDeleteJob(null)
    if (error) { setPageError(error.message); return }
    setJobId(''); setOperationId('')
    await refreshAll()
  }

  // ── Operation writes (pane 3) ──────────────────────────────────────────────────────────
  async function requestDeleteOperation(op: Operation) {
    setPageError(null)
    // Counts every time, on purpose. Deleting the operation cascade-deletes its
    // operation_times rows, so this guard has to see all of them or it waves through a
    // delete that takes recorded history with it.
    const { count } = await supabase.from('operation_times').select('id', { count: 'exact', head: true }).eq('operation_id', op.id)
    if ((count ?? 0) > 0) { setBlockedDeleteOperation(op.name); return }
    setConfirmDeleteOperation(op)
  }

  async function handleDeleteOperation(op: Operation) {
    // model_operations rows for this operation cascade-delete automatically at the DB level
    // (operation_id ... on delete cascade) — nothing to clean up here beyond the operation row.
    const { error } = await supabase.from('operations').delete().eq('id', op.id)
    setConfirmDeleteOperation(null)
    if (error) { setPageError(error.message); return }
    setOperationId('')
    await refreshAll()
  }

  // ── Pane 3 multi-select (bulk model linking) ───────────────────────────────────────────
  function enterMode(mode: 'bulk') {
    setOpMode((cur) => (cur === mode ? 'normal' : mode))
    setOpSelection(new Set())
    setPageError(null)
  }

  function toggleOpSelection(id: string) {
    const next = new Set(opSelection)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpSelection(next)
  }

  function setAllOpSelection(selected: boolean) {
    setOpSelection(selected ? new Set(operations.map((o) => o.id)) : new Set<string>())
  }

  // Only operations still present in the job count — one deleted or moved away under the
  // selection must not be written to.
  const selectedOperations = useMemo(
    () => operations.filter((o) => opSelection.has(o.id)),
    [operations, opSelection]
  )

  // Slide-in choreography and Escape handling come from the shared drawer module.
  const {
    open: bulkDrawerOpen, visible: bulkDrawerVisible,
    openDrawer: openBulkDrawer, closeDrawer: closeBulkDrawer,
  } = useSlideOverDrawer()
  const {
    open: opDrawerOpen, visible: opDrawerVisible,
    openDrawer: showOperationDrawer, closeDrawer: hideOperationDrawer,
  } = useSlideOverDrawer()

  function openOperationDrawer(op: Operation) {
    setOperationDrawer(op)
    showOperationDrawer()
  }
  function closeOperationDrawer() {
    hideOperationDrawer()
    window.setTimeout(() => setOperationDrawer(null), 320)
  }

  return (
    <main className="page-wide">
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Setup</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
          Drill down the line&apos;s structure — Section → Job → Operation → Models. Each column is filled by what you pick in the one to its left.
        </p>
      </div>

      {/* ── Filter bar: Line + Team scope every pane, search jumps to one operation ─────── */}
      <div className="card" style={{ padding: '14px 20px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            style={SEL}
            value={lineId}
            onChange={(e) => { setLineId(e.target.value); setTeamId(''); setSectionKey(''); setJobId(''); setOperationId('') }}
          >
            <option value="">All production lines</option>
            {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <select
            style={SEL}
            value={activeTeamId}
            onChange={(e) => { setTeamId(e.target.value); setSectionKey(''); setJobId(''); setOperationId('') }}
          >
            <option value="">All teams</option>
            {teamOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <input
            className="input"
            type="search"
            placeholder="Search operations by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 240, fontSize: 13 }}
          />
          {/* Structure reconciliation, not structure browsing. It needs ONE line: duplicate
              names only mean anything within a line, and job merge cannot cross one anyway. */}
          <button
            type="button"
            className="btn-ghost"
            disabled={!scopeLineId}
            title={scopeLineId
              ? 'Find job names that appear more than once on this line, with the operations and recorded times behind each copy'
              : 'Pick a single production line first — duplicate names are only meaningful within one'}
            onClick={() => setDuplicatesOpen(true)}
          >
            Duplicate jobs
          </button>
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mid)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {searching && (
        <div className="card" style={{ marginBottom: 16, overflow: 'hidden' }}>
          <div style={{ padding: '10px 18px', borderBottom: searchResults.length > 0 ? '1px solid var(--border)' : 'none' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
              {loadingJobs ? 'Searching…' : plural(searchResults.length, 'matching operation')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Matching &ldquo;{search.trim()}&rdquo; within the current filters — click one to drill the columns to it
            </div>
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {searchResults.map(({ operation, job, sectionName }) => (
              <button
                key={operation.id}
                type="button"
                className="exception-item-button"
                onClick={() => revealOperation(operation, job)}
                style={{
                  width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  gap: 12, textAlign: 'left', fontFamily: 'inherit',
                  background: operation.id === activeOperationId ? 'var(--blue-light)' : undefined,
                }}
              >
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{operation.name}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {job.name}
                    {sectionName && <> · {sectionName}</>}
                    <> · {teamNameForJob(job, sectionsById, teamNameById)}</>
                  </span>
                </span>
                <CoverageBadge coverage={coverageByOp[operation.id]} loading={loadingCoverage} />
              </button>
            ))}
          </div>
        </div>
      )}

      {pageError && <p style={{ ...ERR_BOX, marginBottom: 16 }}>{pageError}</p>}

      {/* Where a just-moved job went. A job reassigned to another team's section legitimately
          drops out of the current Line→Team filter, so without this it would simply vanish. */}
      {jobNotice && (
        <div style={{ ...OK_BOX, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>{jobNotice}</span>
          <button
            type="button"
            onClick={() => setJobNotice(null)}
            aria-label="Dismiss"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 15, lineHeight: 1, color: 'inherit', flexShrink: 0 }}
          >
            ×
          </button>
        </div>
      )}

      <div className="finder-panes">
        <SectionsPane
          supabase={supabase}
          entries={sectionEntries}
          sections={sectionOptions}
          productionLineId={scopeLineId}
          productionLineName={scopeLineName}
          teams={scopeTeams}
          selectedKey={activeSectionKey}
          // Section merge, the same control /tryouts and /collect get — one component, one lib.
          allowMerge
          onSelect={selectSection}
          onChanged={afterSectionChange}
        />

        <JobsPane
          supabase={supabase}
          userId={userId}
          onChanged={refreshAll}
          sectionsById={sectionsById}
          teamNameById={teamNameById}
          entry={activeSectionEntry}
          jobs={jobsInSection}
          loading={loadingJobs}
          operationsByJob={operationsByJob}
          selectedJobId={activeJobId}
          modelApplicability={{
            countByJobId: jobModelCounts,
            total: lineProductCount,
            loading: loadingCoverage,
            onOpen: openJobModels,
          }}
          autoStartMergeJobId={initialFocus.merge === 'job' ? initialFocus.jobId : undefined}
          canDelete={role === 'admin'}
          onSelect={selectJob}
          onAdd={addJob}
          onEdit={openJobDrawer}
          onEditLine={(job) => setJobModal({ mode: 'edit', job })}
          onDeleteRequest={requestDeleteJob}
        />

        <OperationsPane
          job={selectedJob}
          operations={operations}
          loading={loadingJobs}
          coverageByOp={coverageByOp}
          loadingCoverage={loadingCoverage}
          selectedOperationId={activeOperationId}
          operators={allActiveOperators}
          canDelete={role === 'admin'}
          mode={opMode}
          selection={opSelection}
          merge={opMerge}
          mergeRows={opMergeRows}
          operatorsOpen={operatorsOpen}
          selectedOperation={selectedOperation}
          onSelect={setOperationId}
          onEdit={openOperationDrawer}
          onAdd={() => selectedJob && setOperationModal({ jobId: selectedJob.id, jobName: selectedJob.name })}
          onMove={(op) => setMoveModal(op)}
          onDeleteRequest={requestDeleteOperation}
          onEnterMode={enterMode}
          onToggleSelection={toggleOpSelection}
          onSetAllSelection={setAllOpSelection}
          onOpenBulkDrawer={openBulkDrawer}
          onToggleOperators={() => setOperatorsOpen((v) => !v)}
          onOperatorChange={refreshAll}
        />

        <ModelsPane
          supabase={supabase}
          operation={selectedOperation}
          job={selectedJob}
          refreshKey={panelDataVersion}
          onChanged={() => { setPanelDataVersion((v) => v + 1); refreshAll() }}
        />
      </div>

      {jobModal && (
        <JobFormModal
          mode={jobModal.mode}
          job={jobModal.job}
          defaultLineId={lineId}
          lines={lines}
          sections={allSections}
          supabase={supabase}
          onClose={() => setJobModal(null)}
          onSaved={refreshAll}
        />
      )}

      {operationModal && (
        <OperationFormModal
          jobId={operationModal.jobId}
          jobName={operationModal.jobName}
          operators={allActiveOperators}
          supabase={supabase}
          onClose={() => setOperationModal(null)}
          onSaved={refreshAll}
        />
      )}

      {moveModal && (
        <MoveOperationModal
          operation={moveModal}
          jobOptions={allJobOptions}
          supabase={supabase}
          onClose={() => setMoveModal(null)}
          onSaved={refreshAll}
        />
      )}

      {blockedDeleteOperation && (
        <ConfirmDialog
          title="Can't delete this operation"
          message={`"${blockedDeleteOperation}" has recorded operation times. Remove those times in Admin first, then delete the operation here.`}
          confirmLabel="Got it"
          cancelLabel="Close"
          onConfirm={() => setBlockedDeleteOperation(null)}
          onCancel={() => setBlockedDeleteOperation(null)}
        />
      )}
      {blockedDeleteJob && (
        <ConfirmDialog
          title="Can't delete this job"
          message={`"${blockedDeleteJob}" still has operations. Delete or move them to another job first — this includes any retired (merged) operations, which are hidden from the list above.`}
          confirmLabel="Got it"
          cancelLabel="Close"
          onConfirm={() => setBlockedDeleteJob(null)}
          onCancel={() => setBlockedDeleteJob(null)}
        />
      )}
      {confirmDeleteOperation && (
        <ConfirmDialog
          title="Delete Operation"
          message={`Delete "${confirmDeleteOperation.name}"? This also removes its model links. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => handleDeleteOperation(confirmDeleteOperation)}
          onCancel={() => setConfirmDeleteOperation(null)}
        />
      )}
      {confirmDeleteJob && (
        <ConfirmDialog
          title="Delete Job"
          message={`Delete "${confirmDeleteJob.name}"? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => handleDeleteJob(confirmDeleteJob)}
          onCancel={() => setConfirmDeleteJob(null)}
        />
      )}
      {/* The operation-merge confirmation — the same component the Sections and Jobs panes use,
        * fed by a preflight that has already run. See components/MergeMode. */}
      <MergeConfirm merge={opMerge} />

      {/* ── Job edit / reassign drawer ─────────────────────────────────────────────────── */}
      {jobDrawer && (
        <>
          <div className={'gaps-drawer-overlay' + (jobDrawerVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={closeJobDrawer} />
          <div className={'gaps-drawer' + (jobDrawerVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <JobEditDrawer
              job={jobDrawer}
              // Every section on the job's OWN line, across all its teams — reassigning to
              // another team's section is the point, so this must not be narrowed by the Team
              // filter. Falls back to the scoped line for a job that has no line of its own.
              sections={sortSections(allSections.filter((s) => s.production_line_id === (jobDrawer.production_line_id ?? scopeLineId)))}
              teams={allTeams}
              operationCount={(operationsByJob[jobDrawer.id] ?? []).length}
              onSave={saveJobEdit}
              onSaved={(summary) => { setJobNotice(summary); closeJobDrawer() }}
              onClose={closeJobDrawer}
            />
          </div>
        </>
      )}

      {/* ── Operation editor: rename + operator assignment, the shared drawer ─────────── */}
      {opDrawerOpen && operationDrawer && selectedJob && (
        <>
          <div className={'gaps-drawer-overlay' + (opDrawerVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={closeOperationDrawer} />
          <div className={'gaps-drawer' + (opDrawerVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <OperationEditDrawer
              operation={operationDrawer}
              jobName={selectedJob.name}
              operators={allActiveOperators}
              supabase={supabase}
              onSaved={refreshAll}
              onClose={closeOperationDrawer}
            />
          </div>
        </>
      )}

      {/* ── Bulk model-link drawer: many operations × many models in one apply ─────────── */}
      {/* ── The job's model panel ─────────────────────────────────────────────────────
          Same drawer, same write path, in job mode — opened from the "N / M models" badge on a
          Jobs-pane row. onApplied bumps applicabilityVersion alone rather than calling
          refreshAll: only the applies-list changed, so re-reading jobs and operations to update
          one badge would be work for nothing. */}
      {jobModelsOpen && modelJob && (
        <>
          <div className={'gaps-drawer-overlay' + (jobModelsVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={hideJobModels} />
          <div className={'gaps-drawer' + (jobModelsVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <BulkModelLinkDrawer
              productionLineId={modelJob.production_line_id ?? scopeLineId}
              subjectLabel={modelJob.name}
              operations={modelJobOperations}
              jobLinkCounts={modelJobLinkCounts}
              supabase={supabase}
              onClose={hideJobModels}
              onApplied={async () => { setApplicabilityVersion((v) => v + 1) }}
            />
          </div>
        </>
      )}

      {bulkDrawerOpen && selectedJob && (
        <>
          <div className={'gaps-drawer-overlay' + (bulkDrawerVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={closeBulkDrawer} />
          <div className={'gaps-drawer' + (bulkDrawerVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <BulkModelLinkDrawer
              productionLineId={selectedJob.production_line_id}
              subjectLabel={selectedJob.name}
              operations={selectedOperations}
              supabase={supabase}
              onClose={closeBulkDrawer}
              onApplied={async () => { setPanelDataVersion((v) => v + 1); await refreshAll() }}
            />
          </div>
        </>
      )}

      {/* Mounted only while open: it reads every job, operation and recorded time on the line,
          and that is not work to do behind a closed drawer. */}
      {duplicatesOpen && scopeLineId && (
        <DuplicateJobsDrawer
          supabase={supabase}
          userId={userId}
          productionLineId={scopeLineId}
          productionLineName={scopeLineName ?? 'This line'}
          onClose={() => setDuplicatesOpen(false)}
          onChanged={refreshAll}
        />
      )}
    </main>
  )
}



// ── Job edit / reassign slide-over ─────────────────────────────────────────────────────────
/**
 * Rename a job and move it to another section — including a section belonging to a different team,
 * which is the case the old footer dropdown couldn't express safely.
 *
 * The section list is grouped by team via <optgroup>, because "Fit-out 3" means nothing without
 * knowing whose Fit-out 3 it is, and picking one silently changes the job's team (see
 * sections.ts' setJobSection). That consequence is stated in the confirm rather than discovered
 * afterwards, and the confirm also says what rides along: the job's operations and their
 * recorded times, which need no migration because they hang off job_id/operation_id.
 *
 * Nothing is written until Save; × discards.
 */
// ── Pane 3: Operations ─────────────────────────────────────────────────────────────────────
/**
 * The selected job's active operations, each with its model-coverage badge.
 *
 * Two multi-select flows live here rather than in a drawer of their own, because both are chosen
 * from this same list: "Bulk link" (apply one model set to many operations at once), which is
 * local to this screen, and Merge, which is the shared merge mode from components/MergeMode —
 * the identical affordance the Sections and Jobs panes to the left of this one offer. Only one
 * is ever live, and the row turns into a checkbox for the duration so the per-operation actions
 * can't be mis-clicked.
 *
 * Operator assignment sits in the footer, collapsed: it stays fully editable, but nothing on
 * this screen waits on it (phase-1: operators are context only).
 */
function OperationsPane({
  job, operations, loading, coverageByOp, loadingCoverage, selectedOperationId, selectedOperation,
  operators, canDelete, mode, selection, merge, mergeRows, operatorsOpen,
  onSelect, onEdit, onAdd, onMove, onDeleteRequest, onEnterMode, onToggleSelection,
  onSetAllSelection, onOpenBulkDrawer, onToggleOperators, onOperatorChange,
}: {
  job: Job | null
  operations: Operation[]
  loading: boolean
  coverageByOp: Record<string, OperationCoverage>
  loadingCoverage: boolean
  selectedOperationId: string
  selectedOperation: Operation | null
  operators: OperatorOption[]
  canDelete: boolean
  mode: 'normal' | 'bulk'
  selection: Set<string>
  /** The shared merge flow, owned by the screen so it survives this pane's re-renders. */
  merge: MergeModeState
  mergeRows: MergeRow<Operation>[]
  operatorsOpen: boolean
  onSelect: (id: string) => void
  /** Opens the shared operation editor. Distinct from onSelect so the row's click can stay
   * "show me this operation's models" — selecting and editing must not collide. */
  onEdit: (op: Operation) => void
  onAdd: () => void
  onMove: (op: Operation) => void
  onDeleteRequest: (op: Operation) => void
  onEnterMode: (mode: 'bulk') => void
  onToggleSelection: (id: string) => void
  onSetAllSelection: (selected: boolean) => void
  onOpenBulkDrawer: () => void
  onToggleOperators: () => void
  onOperatorChange: () => void
}) {
  const selectedCount = operations.filter((o) => selection.has(o.id)).length
  const allSelected = operations.length > 0 && selectedCount === operations.length
  const inSelectMode = mode !== 'normal'

  const subtitle = !job
    ? 'No job selected'
    : merge.active
      ? `${job.name} · ${merge.subtitle}`
      : mode === 'bulk'
        ? `${job.name} · bulk link — ${selectedCount} selected`
        : `${job.name} · ${plural(operations.length, 'operation')}`

  return (
    <Pane
      title="Operations"
      subtitle={subtitle}
      active={merge.active ? merge.count > 0 : Boolean(selectedOperationId)}
      footer={
        job ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            {merge.active ? <MergeFooter merge={merge} /> : mode === 'bulk' ? (
              <>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="finder-row-action"
                    onClick={() => onSetAllSelection(!allSelected)}
                  >
                    {allSelected ? 'Clear selection' : 'Select all'}
                  </button>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{selectedCount} of {operations.length}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn-primary" style={{ padding: '6px 11px', fontSize: 12 }} disabled={selectedCount === 0} onClick={onOpenBulkDrawer}>
                    Link models ({selectedCount})
                  </button>
                  <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => onEnterMode('bulk')}>Done</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={onAdd}>+ Add operation</button>
                  {operations.length > 1 && (
                    <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => onEnterMode('bulk')}>Bulk link</button>
                  )}
                  {/* The one merge affordance, in the one place it lives on every pane. */}
                  <MergeFooter merge={merge} />
                </div>

                {selectedOperation && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>{selectedOperation.name}</span>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => onMove(selectedOperation)}>Move to job</button>
                      {canDelete && (
                        <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12, color: 'var(--red)' }} onClick={() => onDeleteRequest(selectedOperation)}>
                          Delete
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      className="finder-row-action"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={onToggleOperators}
                    >
                      {operatorsOpen ? '▾' : '▸'} Operators (optional) — {selectedOperation.primary_operator?.full_name ?? 'unassigned'}
                    </button>
                    {operatorsOpen && (
                      <>
                        <OperatorAssign
                          operationId={selectedOperation.id}
                          primaryOperatorId={selectedOperation.primary_operator_id ?? ''}
                          secondaryOperatorId={selectedOperation.secondary_operator_id}
                          options={operators}
                          onChange={onOperatorChange}
                        />
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : undefined
      }
    >
      <MergeNotices merge={merge} />

      {!job ? (
        <p className="finder-pane-empty">Select a job.</p>
      ) : loading ? (
        <p className="finder-pane-empty">Loading…</p>
      ) : merge.active ? (
        mergeRows.map((row) => (
          <MergeRowItem
            key={row.id}
            merge={merge}
            row={row}
            meta={row.subject.primary_operator?.full_name ?? 'No operator'}
          />
        ))
      ) : operations.length === 0 ? (
        <p className="finder-pane-empty">No operations under {job.name} yet — add one below.</p>
      ) : (
        operations.map((op) => {
          const isSelected = op.id === selectedOperationId
          const isTicked = selection.has(op.id)

          // In bulk-link mode the row is a checkbox and nothing else — the per-operation
          // actions would be a mis-click waiting to happen while the row's job is to be ticked.
          if (inSelectMode) {
            return (
              <label
                key={op.id}
                className={'finder-row' + (isTicked ? ' finder-row-selected' : '')}
                style={{ cursor: 'pointer' }}
              >
                <span className="finder-row-main">
                  <input
                    type="checkbox"
                    checked={isTicked}
                    onChange={() => onToggleSelection(op.id)}
                    style={{ width: 15, height: 15, accentColor: 'var(--blue)', cursor: 'pointer', flexShrink: 0 }}
                  />
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                    <span className="finder-row-name">{op.name}</span>
                  </span>
                </span>
                <CoverageBadge coverage={coverageByOp[op.id]} loading={loadingCoverage} />
              </label>
            )
          }

          return (
            <div
              key={op.id}
              className={'finder-row' + (isSelected ? ' finder-row-selected' : '')}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(op.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(op.id) } }}
            >
              <span className="finder-row-main">
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                  <span className="finder-row-name">{op.name}</span>
                  <span className="finder-row-meta">
                    {op.primary_operator?.full_name ?? 'No operator'}
                    {op.secondary_operator && <> · {op.secondary_operator.full_name}</>}
                  </span>
                </span>
              </span>
              <span className="finder-row-actions">
                {!inSelectMode && <RenameButton title="Edit operation" onClick={() => onEdit(op)} />}
                <CoverageBadge coverage={coverageByOp[op.id]} loading={loadingCoverage} />
                <span className="finder-chevron">›</span>
              </span>
            </div>
          )
        })
      )}
    </Pane>
  )
}

// ── Pane 4: Models ─────────────────────────────────────────────────────────────────────────
/** What the selected operation applies to: the series-grouped model links, then every time
 * collected against it, per model. Both are the shared components — ModelLinker owns the
 * link/unlink writes (including the "can't unlink a timed model" guard), and the times panel
 * below re-reads whenever ModelLinker writes. */
function ModelsPane({
  supabase, operation, job, refreshKey, onChanged,
}: {
  supabase: SupabaseClient
  operation: Operation | null
  job: Job | null
  refreshKey: number
  onChanged: () => void
}) {
  return (
    <Pane
      title="Models"
      subtitle={operation ? operation.name : 'No operation selected'}
      active={Boolean(operation)}
    >
      {!operation || !job ? (
        <p className="finder-pane-empty">Select an operation to scope it to models and see its collected times.</p>
      ) : (
        <div style={{ padding: '12px 14px' }}>
          <ModelLinker
            operationId={operation.id}
            operationName={operation.name}
            productionLineId={job.production_line_id}
            enableTimeEntry={false}
            onChange={onChanged}
          />
          <OperationCoverageTimesPanel
            operationId={operation.id}
            supabase={supabase}
            refreshKey={refreshKey}
          />
        </div>
      )}
    </Pane>
  )
}

// ── "Coverage & Collected Times" ───────────────────────────────────────────────────────────
/** One operation_time as listed under its model — flattened out of the raw rows so the render
 * doesn't have to re-join anything. */
interface CollectedTimeRow {
  id: string
  totalMinutes: number | null
  createdAt: string
  /** null = this is the current record for its model; set = archived behind that record. Drives
   * the badge on each row, so history reads as history rather than as more of the same. */
  supersededBy: string | null
  /** operations_times.operator_id → name. Context only: "who was timed". Nothing on this
   * screen requires an operation to have a primary/secondary operator set, and this is not
   * that — it's whoever the recorded run was captured against. */
  operatorName: string | null
  notes: OperationTimeNote[]
}

/** A model's row in the panel: the product, its recorded times, and its average. A linked model
 * with no times is the gap the panel exists to make visible. */
interface ModelTimesGroup {
  product: Product | null
  /** false for a model that has times but is no longer linked via model_operations — shown so
   * history doesn't silently vanish when someone unlinks a model. */
  linked: boolean
  times: CollectedTimeRow[]
  stat: OperationTimeStat | undefined
}

function OperationCoverageTimesPanel({
  operationId, supabase, refreshKey,
}: {
  operationId: string
  supabase: SupabaseClient
  refreshKey: number
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [groups, setGroups] = useState<ModelTimesGroup[]>([])
  const [coverage, setCoverage] = useState<OperationCoverage>({ timed: 0, total: 0 })
  /** operation_times with no operation_time_models row at all — they exist, but no model can
   * claim them, so they'd otherwise be invisible here. */
  const [unlinkedTimes, setUnlinkedTimes] = useState<CollectedTimeRow[]>([])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true); setError(null)
      try {
        const [{ data: linkRows, error: linkError }, { data: timeRows, error: timeError }] = await Promise.all([
          supabase.from('model_operations').select('product_id').eq('operation_id', operationId),
          // Every record, current and archived — this pane IS the history for an operation, and
          // it labels each row below. superseded_by is selected so currentForOperation can pick
          // the figure and so each row can say which one it is.
          supabase
            .from('operation_times')
            .select('id, total_minutes, created_at, operator_id, superseded_by')
            .eq('operation_id', operationId)
            .order('created_at', { ascending: false }),
        ])
        if (linkError) throw new Error(linkError.message)
        if (timeError) throw new Error(timeError.message)

        const linkedIds = new Set((linkRows ?? []).map((r) => r.product_id as string))
        const times = (timeRows ?? []) as { id: string; total_minutes: number | null; created_at: string; operator_id: string | null; superseded_by: string | null }[]
        const timeIds = times.map((t) => t.id)

        // Which model(s) each time belongs to — operation_times carries no product_id of its
        // own, exactly as currentForOperation and lib/coverage.ts both assume.
        const timeModels: { operation_time_id: string; product_id: string }[] = []
        for (const chunk of chunked(timeIds, READ_CHUNK)) {
          const { data, error: err } = await supabase
            .from('operation_time_models').select('operation_time_id, product_id').in('operation_time_id', chunk)
          if (err) throw new Error(err.message)
          timeModels.push(...((data ?? []) as { operation_time_id: string; product_id: string }[]))
        }

        // Products for both the linked models and any model that only shows up via a recorded
        // time (i.e. was unlinked after being timed).
        const productIds = new Set<string>(linkedIds)
        for (const tm of timeModels) productIds.add(tm.product_id)
        const products: Product[] = []
        for (const chunk of chunked([...productIds], READ_CHUNK)) {
          const { data, error: err } = await supabase.from('products').select('*').in('id', chunk)
          if (err) throw new Error(err.message)
          products.push(...((data ?? []) as Product[]))
        }

        const operatorIds = [...new Set(times.map((t) => t.operator_id).filter((id): id is string => !!id))]
        const operatorNameById = new Map<string, string>()
        for (const chunk of chunked(operatorIds, READ_CHUNK)) {
          const { data, error: err } = await supabase.from('operators').select('id, full_name').in('id', chunk)
          if (err) throw new Error(err.message)
          for (const row of (data ?? []) as OperatorOption[]) operatorNameById.set(row.id, row.full_name)
        }

        // Notes are best-effort — a note-read failure shouldn't cost the whole times list.
        let notes: OperationTimeNote[] = []
        try {
          notes = await fetchOperationTimeNotes(supabase, timeIds)
        } catch {
          notes = []
        }
        const notesByTime = new Map<string, OperationTimeNote[]>()
        for (const note of notes) {
          const list = notesByTime.get(note.operation_time_id) ?? []
          list.push(note)
          notesByTime.set(note.operation_time_id, list)
        }

        if (cancelled) return

        const rowById = new Map<string, CollectedTimeRow>(times.map((t) => [t.id, {
          id: t.id,
          totalMinutes: t.total_minutes,
          createdAt: t.created_at,
          supersededBy: t.superseded_by,
          operatorName: t.operator_id ? operatorNameById.get(t.operator_id) ?? null : null,
          notes: notesByTime.get(t.id) ?? [],
        }]))

        // The same shared current-record lookup every other screen uses — re-shaped to the
        // (operation_id, times) rows it expects, then read back per product for this operation.
        const stats = currentForOperation(
          times.map((t) => ({
            id: t.id, operation_id: operationId, total_minutes: t.total_minutes,
            superseded_by: t.superseded_by, created_at: t.created_at,
          })),
          timeModels
        )

        const timesByProduct = new Map<string, CollectedTimeRow[]>()
        const claimedTimeIds = new Set<string>()
        for (const tm of timeModels) {
          const row = rowById.get(tm.operation_time_id)
          if (!row) continue
          claimedTimeIds.add(row.id)
          const list = timesByProduct.get(tm.product_id) ?? []
          list.push(row)
          timesByProduct.set(tm.product_id, list)
        }
        for (const list of timesByProduct.values()) list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

        const productById = new Map(products.map((p) => [p.id, p]))
        const nextGroups: ModelTimesGroup[] = []
        for (const productId of productIds) {
          nextGroups.push({
            product: productById.get(productId) ?? null,
            linked: linkedIds.has(productId),
            times: timesByProduct.get(productId) ?? [],
            stat: stats[operationProductKey(operationId, productId)],
          })
        }
        // Linked models first (untimed ones at the top of that group, since they're the gaps
        // this panel is for), then any timed-but-unlinked leftovers.
        nextGroups.sort((a, b) => {
          if (a.linked !== b.linked) return a.linked ? -1 : 1
          if (a.linked && (a.times.length === 0) !== (b.times.length === 0)) return a.times.length === 0 ? -1 : 1
          return (a.product?.model ?? '').localeCompare(b.product?.model ?? '')
        })

        const timedLinked = [...linkedIds].filter((id) => (timesByProduct.get(id) ?? []).length > 0).length

        setGroups(nextGroups)
        setCoverage({ timed: timedLinked, total: linkedIds.size })
        setUnlinkedTimes(times.filter((t) => !claimedTimeIds.has(t.id)).map((t) => rowById.get(t.id)!))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load collected times')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [supabase, operationId, refreshKey])

  const summaryColor = coverage.total === 0
    ? 'var(--text-muted)'
    : coverage.timed >= coverage.total ? '#15803d' : coverage.timed === 0 ? 'var(--red)' : '#92400e'

  return (
    <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 8 }}>
        Collected Times
      </div>

      {loading ? (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>Loading…</p>
      ) : error ? (
        <p style={ERR_BOX}>{error}</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <CoverageBadge coverage={coverage} loading={false} />
            <span style={{ fontSize: 12, fontWeight: 600, color: summaryColor }}>
              {coverage.total === 0
                ? 'No models linked yet'
                : `Timed for ${coverage.timed} of ${plural(coverage.total, 'model')}`}
            </span>
          </div>

          {groups.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Link a model above, then any times collected against it appear here.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {groups.map((group, i) => {
                const label = group.product
                  ? `${group.product.product_code}${group.product.model ? ` — ${group.product.model}` : ''}`
                  : 'Unknown model'
                return (
                  <div
                    key={group.product?.id ?? `unknown-${i}`}
                    style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', background: 'var(--bg)' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', wordBreak: 'break-word' }}>
                        {label}
                        {!group.linked && (
                          <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}> · no longer linked</span>
                        )}
                      </span>
                      {group.times.length === 0 ? (
                        <span className="gaps-drawer-item-status gaps-drawer-item-status-missing">Not yet timed</span>
                      ) : (
                        <span className="gaps-drawer-item-status gaps-drawer-item-status-ok">
                          {group.stat ? `${group.stat.minutes.toFixed(1)}m · ${historyLabel(group.stat)}` : plural(group.times.length, 'time')}
                        </span>
                      )}
                    </div>

                    {group.times.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                        {group.times.map((time) => (
                          <div
                            key={time.id}
                            style={{ padding: '7px 9px', borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--border)' }}
                          >
                            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 13, fontWeight: 700, color: time.supersededBy ? 'var(--text-muted)' : 'var(--text)' }}>{fmtMinutes(time.totalMinutes)}m</span>
                              {/* Which of these rows IS the figure above. Without it the list
                                  reads as several equally-live numbers, which is what the
                                  averaging rule used to make them. */}
                              {time.supersededBy
                                ? <span className="badge badge-grey">archived</span>
                                : <span className="badge badge-green">current</span>}
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                Timed: {time.operatorName ?? 'Unknown operator'}
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(time.createdAt)}</span>
                            </div>
                            {time.notes.length > 0 && (
                              <ul style={{ margin: '5px 0 0', paddingLeft: 16, fontSize: 11, color: 'var(--text-mid)' }}>
                                {time.notes.map((note) => <li key={note.id}>{note.content}</li>)}
                              </ul>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {unlinkedTimes.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>
                {plural(unlinkedTimes.length, 'time')} recorded with no model attached
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {unlinkedTimes.map((time) => (
                  <div
                    key={time.id}
                    style={{ padding: '7px 9px', borderRadius: 6, background: 'var(--bg)', border: '1px solid var(--border)', display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{fmtMinutes(time.totalMinutes)}m</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Timed: {time.operatorName ?? 'Unknown operator'}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(time.createdAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Add/Edit Job modal ───────────────────────────────────────────────────────────────────
// ── Add Operation modal ──────────────────────────────────────────────────────────────────
function OperationFormModal({
  jobId, jobName, operators, supabase, onClose, onSaved,
}: {
  jobId: string
  jobName: string
  operators: OperatorOption[]
  supabase: SupabaseClient
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [primaryId, setPrimaryId] = useState('')
  const [secondaryId, setSecondaryId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true); setError(null)
    // The shared insert — same defaults as every other screen's add, plus the operator
    // assignment this form is the only place to make.
    try {
      await createOperation(supabase, {
        name, jobId, primaryOperatorId: primaryId, secondaryOperatorId: secondaryId,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create operation')
      setSaving(false)
      return
    }
    setSaving(false)
    await onSaved()
    onClose()
  }

  return (
    <Modal title={`Add Operation — ${jobName}`} onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label className="label">Operation Name *</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </div>
        <div>
          <label className="label">Primary Operator</label>
          <select className="select" style={{ width: '100%' }} value={primaryId} onChange={(e) => setPrimaryId(e.target.value)}>
            <option value="">— Unassigned —</option>
            {operators.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Secondary Operator</label>
          <select className="select" style={{ width: '100%' }} value={secondaryId} onChange={(e) => setSecondaryId(e.target.value)}>
            <option value="">— None —</option>
            {operators.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
          </select>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>Both are optional — an operation can be added now and staffed later in Operator.</p>
        {error && <p style={ERR_BOX}>{error}</p>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={saving || !name.trim()} className="btn-primary">{saving ? 'Adding…' : 'Add Operation'}</button>
        </div>
      </form>
    </Modal>
  )
}

// ── Move Operation modal ─────────────────────────────────────────────────────────────────
function MoveOperationModal({
  operation, jobOptions, supabase, onClose, onSaved,
}: {
  operation: Operation
  jobOptions: JobMoveOption[]
  supabase: SupabaseClient
  onClose: () => void
  onSaved: () => void
}) {
  const [targetJobId, setTargetJobId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const options = jobOptions.filter((j) => j.id !== operation.job_id)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!targetJobId) return
    setSaving(true); setError(null)
    try {
      // The single writer of operations.job_id — the same one lib/jobs' mergeJobs re-files
      // through, so a move means the same thing however it is reached (read-back check included).
      await setOperationJob(supabase, operation.id, targetJobId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move that operation')
      setSaving(false)
      return
    }
    setSaving(false)
    await onSaved()
    onClose()
  }

  return (
    <Modal title={`Move "${operation.name}"`} onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label className="label">Move to Job *</label>
          <select className="select" style={{ width: '100%' }} value={targetJobId} onChange={(e) => setTargetJobId(e.target.value)} required autoFocus>
            <option value="">— Select a job —</option>
            {options.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
          </select>
        </div>
        {error && <p style={ERR_BOX}>{error}</p>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={saving || !targetJobId} className="btn-primary">{saving ? 'Moving…' : 'Move'}</button>
        </div>
      </form>
    </Modal>
  )
}
