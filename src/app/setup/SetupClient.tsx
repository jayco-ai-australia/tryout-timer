'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'
import ModelLinker, { ModelSeriesPicker } from '@/components/ModelLinker'
import BulkModelLinkDrawer, { DRAWER_WIDTH, useSlideOverDrawer } from '@/components/BulkModelLinkDrawer'
import JobEditDrawer from '@/components/JobEditDrawer'
import JobFormModal from '@/components/JobFormModal'
import OperationEditDrawer from '@/components/OperationEditDrawer'
import OperatorAssign from '@/components/OperatorAssign'
import {
  averageForOperation, fetchOperationTimeNotes, operationProductKey, type OperationTimeStat,
} from '@/lib/operationTimes'
import { fmtDate, fmtMinutes } from '@/lib/format'
import { setJobStage, sortStages } from '@/lib/stages'
import { createOperation } from '@/lib/operations'
import { mergeOperations, preflightMerge, strandedMergeMessage, type MergePreflight } from '@/lib/mergeOperations'
import {
  JobsPane, Pane, RenameButton, ROW_INPUT, StagesPane, UNSTAGED_KEY, plural,
  type StageEntry,
} from '@/components/FinderPanes'
import {
  chunked, fetchLinksForOperations, fetchTimedPairs, linkOperationsToModels,
  unlinkOperationsFromModels, READ_CHUNK,
} from '@/lib/modelOperations'
import { usePersistedFilter } from '@/lib/useLocalStorage'
import type { Job, Operation, OperationTimeNote, Product, ProductionLine, Stage, Team, UserRole } from '@/lib/types'

interface Props { lines: ProductionLine[]; role: UserRole; userId: string }

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
  team_id: string | null; production_line_id: string | null; stage_id: string | null; created_at: string
  teams: RawTeamRef | RawTeamRef[] | null
}
interface RawOperation {
  id: string; name: string; job_id: string
  primary_operator_id: string | null; secondary_operator_id: string | null; created_at: string
  primary_operator: RawOperatorRef | RawOperatorRef[] | null
  secondary_operator: RawOperatorRef | RawOperatorRef[] | null
}
interface RawJobOption { id: string; name: string; teams: RawTeamRef | RawTeamRef[] | null }

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
 * in-progress capture still counts as collected. (The averages shown in pane 4 come from the
 * shared averageForOperation, which does skip null minutes.)
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

function coverageTitle(coverage: OperationCoverage): string {
  if (coverage.total === 0) return 'No models linked to this operation yet'
  return `${coverage.timed} of ${plural(coverage.total, 'linked model')} have at least one recorded time`
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



export default function SetupClient({ lines, role, userId }: Props) {
  const supabase = useState(() => createClient())[0]

  // ── Filter bar: scopes every pane below ────────────────────────────────────────────────
  const [lineId, setLineId] = usePersistedFilter('jmotion_setup_line')
  const [teamId, setTeamId] = usePersistedFilter('jmotion_setup_team')
  // ── Drill position: persisted so a refresh comes back to the same operation ─────────────
  const [stageKey, setStageKey] = usePersistedFilter('jmotion_setup_stage')
  const [jobId, setJobId] = usePersistedFilter('jmotion_setup_job')
  const [operationId, setOperationId] = usePersistedFilter('jmotion_setup_operation')
  // Deliberately not persisted — a search term is a momentary "find me this one operation",
  // not a scope the screen should still be in next time it's opened.
  const [search, setSearch] = useState('')

  const [allTeams, setAllTeams] = useState<Team[]>([])
  const [allStages, setAllStages] = useState<Stage[]>([])
  const [allActiveOperators, setAllActiveOperators] = useState<OperatorOption[]>([])
  const [allJobOptions, setAllJobOptions] = useState<JobMoveOption[]>([])

  const [jobs, setJobs] = useState<Job[]>([])
  const [operationsByJob, setOperationsByJob] = useState<Record<string, Operation[]>>({})
  const [loadingJobs, setLoadingJobs] = useState(false)

  const [coverageByOp, setCoverageByOp] = useState<Record<string, OperationCoverage>>({})
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
  // 'bulk'  — multi-select operations, then apply one model set to all of them.
  // 'merge' — multi-select duplicates, pick a keeper, move their times onto it and retire them.
  // Both share one selection set: only one mode is ever live, and leaving either drops it.
  const [opMode, setOpMode] = useState<'normal' | 'bulk' | 'merge'>('normal')
  const [opSelection, setOpSelection] = useState<Set<string>>(new Set())
  const [mergeKeeperId, setMergeKeeperId] = useState<string | null>(null)
  const [mergeConfirm, setMergeConfirm] = useState<{ keeper: Operation; dups: Operation[] } | null>(null)
  const [merging, setMerging] = useState(false)
  /** The optional operator strip in pane 3 — collapsed by default (phase-1: operators are
   * context only, so nothing on this screen waits on them). */
  const [operatorsOpen, setOperatorsOpen] = useState(false)

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
    reloadStages()
    supabase.from('operators').select('id, full_name').eq('is_active', true).order('full_name')
      .then(({ data }) => setAllActiveOperators((data ?? []) as OperatorOption[]))
    supabase.from('jobs').select('id, name, teams ( id, name )').order('name').then(({ data }) => {
      setAllJobOptions(((data ?? []) as unknown as RawJobOption[]).map((r) => {
        const team = one(r.teams)
        return { id: r.id, label: team ? `${r.name} — ${team.name}` : r.name }
      }))
    })
  }, [supabase])

  async function reloadStages() {
    const { data } = await supabase.from('stages').select('*').order('sort_order')
    setAllStages(sortStages((data ?? []) as Stage[]))
  }

  async function loadJobs() {
    setLoadingJobs(true)
    let q = supabase.from('jobs').select('*, teams ( id, name )').order('name')
    if (teamId) q = q.eq('team_id', teamId)
    else if (lineId) q = q.eq('production_line_id', lineId)
    const { data: jobRows } = await q

    const loadedJobs: Job[] = ((jobRows ?? []) as unknown as RawJob[]).map((r) => ({
      id: r.id, name: r.name, primary_operator_id: r.primary_operator_id,
      team_id: r.team_id, production_line_id: r.production_line_id, stage_id: r.stage_id,
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
    setOperationsByJob(grouped)
    setLoadingJobs(false)
  }

  useEffect(() => { loadJobs() }, [supabase, lineId, teamId])

  // ── Per-operation coverage for everything currently loaded ─────────────────────────────
  // One pass over the whole scoped set (not per visible row), so drilling between stages/jobs
  // or typing in the search box re-renders badges from data already in hand instead of firing
  // a fresh round of queries per keystroke.
  const loadedOperationIds = useMemo(
    () => Object.values(operationsByJob).flat().map((o) => o.id).sort(),
    [operationsByJob]
  )
  const coverageRunRef = useRef(0)

  useEffect(() => {
    const runId = ++coverageRunRef.current
    if (loadedOperationIds.length === 0) { setCoverageByOp({}); setLoadingCoverage(false); return }

    let cancelled = false
    async function load() {
      setLoadingCoverage(true)
      try {
        const modelOperations: { operation_id: string; product_id: string }[] = []
        for (const chunk of chunked(loadedOperationIds, READ_CHUNK)) {
          const { data, error } = await supabase
            .from('model_operations').select('operation_id, product_id').in('operation_id', chunk)
          if (error) throw new Error(error.message)
          modelOperations.push(...((data ?? []) as { operation_id: string; product_id: string }[]))
        }

        const operationTimes: { id: string; operation_id: string }[] = []
        for (const chunk of chunked(loadedOperationIds, READ_CHUNK)) {
          const { data, error } = await supabase
            .from('operation_times').select('id, operation_id').in('operation_id', chunk)
          if (error) throw new Error(error.message)
          operationTimes.push(...((data ?? []) as { id: string; operation_id: string }[]))
        }

        const operationTimeModels: { operation_time_id: string; product_id: string }[] = []
        for (const chunk of chunked(operationTimes.map((t) => t.id), READ_CHUNK)) {
          const { data, error } = await supabase
            .from('operation_time_models').select('operation_time_id, product_id').in('operation_time_id', chunk)
          if (error) throw new Error(error.message)
          operationTimeModels.push(...((data ?? []) as { operation_time_id: string; product_id: string }[]))
        }

        if (cancelled || coverageRunRef.current !== runId) return
        setCoverageByOp(computeOperationCoverage({
          operationIds: loadedOperationIds, modelOperations, operationTimes, operationTimeModels,
        }))
      } catch (err) {
        // A coverage failure must not take the structure-editing screen down with it — the
        // badges fall back to "—" and the rest of the page keeps working.
        if (!cancelled && coverageRunRef.current === runId) {
          setCoverageByOp({})
          console.error('[setup] could not load operation coverage:', err)
        }
      } finally {
        if (!cancelled && coverageRunRef.current === runId) setLoadingCoverage(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [supabase, loadedOperationIds])

  // Refresh the "move to another job" list too, so a job just added/renamed/deleted shows up
  // there without a full page reload.
  async function refreshAll() {
    await loadJobs()
    const { data } = await supabase.from('jobs').select('id, name, teams ( id, name )').order('name')
    setAllJobOptions(((data ?? []) as unknown as RawJobOption[]).map((r) => {
      const team = one(r.teams)
      return { id: r.id, label: team ? `${r.name} — ${team.name}` : r.name }
    }))
  }

  const teamOptions = lineId ? allTeams.filter((t) => t.production_line_id === lineId) : allTeams

  // ── Scope ──────────────────────────────────────────────────────────────────────────────
  // Which line the screen is effectively looking at. Stages belong to exactly one line, so a
  // team filter with no line chosen still resolves to that team's line — otherwise picking a
  // team would silently switch stage grouping off.
  const scopeLineId = useMemo(() => {
    if (lineId) return lineId
    if (teamId) return allTeams.find((t) => t.id === teamId)?.production_line_id ?? ''
    return ''
  }, [lineId, teamId, allTeams])

  const scopeLineName = lines.find((l) => l.id === scopeLineId)?.name ?? null
  const scopeTeams = useMemo(
    () => allTeams.filter((t) => t.production_line_id === scopeLineId),
    [allTeams, scopeLineId]
  )

  /** The scoped line's stages, in walk order. Deliberately NOT narrowed by the team filter: a
   * stage belongs to one team, but a job sitting in it doesn't have to, so filtering here would
   * hide the very stage a filtered job is grouped under. */
  const stageOptions = useMemo(
    () => (scopeLineId ? sortStages(allStages.filter((s) => s.production_line_id === scopeLineId)) : []),
    [allStages, scopeLineId]
  )

  // ── Pane 1 data: stages + the virtual Unstaged bucket ──────────────────────────────────
  /** Loaded jobs bucketed by the pane-1 entry they belong to. A job whose stage_id is null, or
   * points at a stage outside this line, lands in Unstaged — the same rule /tryouts' walk uses. */
  const jobsByStageKey = useMemo(() => {
    const map = new Map<string, Job[]>()
    const known = new Set(stageOptions.map((s) => s.id))
    for (const job of jobs) {
      const key = job.stage_id && known.has(job.stage_id) ? job.stage_id : UNSTAGED_KEY
      const list = map.get(key)
      if (list) list.push(job)
      else map.set(key, [job])
    }
    return map
  }, [jobs, stageOptions])

  /**
   * Pane 1's rows: the line's stages in walk order, plus "Unstaged" at the bottom whenever it
   * holds anything. A line with no stages at all (Caravan, Motor Home) gets Unstaged as its
   * single entry — every job lives there, and no empty stage scaffolding is invented.
   */
  const stageEntries = useMemo<StageEntry[]>(() => {
    const entries: StageEntry[] = stageOptions.map((s) => ({
      key: s.id, name: s.name, stage: s, jobCount: (jobsByStageKey.get(s.id) ?? []).length,
    }))
    const unstagedCount = (jobsByStageKey.get(UNSTAGED_KEY) ?? []).length
    if (stageOptions.length === 0 || unstagedCount > 0) {
      // With no line in scope the bucket holds every job in the filter — staged ones included,
      // since their stages belong to lines this view isn't looking at — so it isn't "Unstaged".
      entries.push({
        key: UNSTAGED_KEY,
        name: scopeLineId ? 'Unstaged' : 'All jobs',
        stage: null,
        jobCount: unstagedCount,
      })
    }
    return entries
  }, [stageOptions, jobsByStageKey, scopeLineId])

  // A persisted id can outlive the scope it was chosen in (line changed, stage deleted, job
  // moved). Rather than write over the stored value, fall back to "nothing selected" whenever
  // the id isn't among the options actually available right now — so a refresh restores the
  // position when it still exists, and shows an empty state when it doesn't.
  const activeStageKey = stageEntries.some((e) => e.key === stageKey) ? stageKey : ''
  const activeStageEntry = stageEntries.find((e) => e.key === activeStageKey) ?? null

  // ── Pane 2 data ────────────────────────────────────────────────────────────────────────
  const jobsInStage = useMemo(
    () => (activeStageKey ? jobsByStageKey.get(activeStageKey) ?? [] : []),
    [activeStageKey, jobsByStageKey]
  )
  const activeJobId = jobsInStage.some((j) => j.id === jobId) ? jobId : ''
  const selectedJob = jobsInStage.find((j) => j.id === activeJobId) ?? null

  // ── Pane 3 data ────────────────────────────────────────────────────────────────────────
  const operations = useMemo(
    () => (activeJobId ? operationsByJob[activeJobId] ?? [] : []),
    [activeJobId, operationsByJob]
  )
  const activeOperationId = operations.some((o) => o.id === operationId) ? operationId : ''
  const selectedOperation = operations.find((o) => o.id === activeOperationId) ?? null

  // ── Drill actions ──────────────────────────────────────────────────────────────────────
  function selectStage(key: string) {
    setStageKey(key)
    setJobId('')
    setOperationId('')
  }
  function selectJob(id: string) {
    setJobId(id)
    setOperationId('')
  }

  /** Search's "take me to it": set all three panes at once so the operation is on screen in
   * context (its stage, its job) rather than as a lone row. */
  function revealOperation(op: Operation, job: Job) {
    const inLine = job.stage_id && stageOptions.some((s) => s.id === job.stage_id)
    setStageKey(inLine ? (job.stage_id as string) : UNSTAGED_KEY)
    setJobId(job.id)
    setOperationId(op.id)
  }

  // Changing what pane 3 is showing invalidates any multi-select held against the old job.
  useEffect(() => {
    setOpMode('normal')
    setOpSelection(new Set())
    setMergeKeeperId(null)
    setOperatorsOpen(false)
  }, [activeJobId])

  // ── Search across everything loaded ────────────────────────────────────────────────────
  const stageNameById = useMemo(() => new Map(allStages.map((s) => [s.id, s.name])), [allStages])
  const searchTerm = search.trim().toLowerCase()
  const searching = searchTerm.length > 0

  /** Every operation whose name matches, anywhere in the Line/Team scope — each carries its own
   * job (and stage) so a name that repeats across jobs is still unambiguous. */
  const searchResults = useMemo(() => {
    if (!searching) return []
    const rows: { operation: Operation; job: Job; stageName: string | null }[] = []
    for (const job of jobs) {
      for (const op of operationsByJob[job.id] ?? []) {
        if (!op.name.toLowerCase().includes(searchTerm)) continue
        rows.push({ operation: op, job, stageName: job.stage_id ? stageNameById.get(job.stage_id) ?? null : null })
      }
    }
    return rows.sort((a, b) => a.operation.name.localeCompare(b.operation.name) || a.job.name.localeCompare(b.job.name))
  }, [searching, searchTerm, jobs, operationsByJob, stageNameById])

  const filtersActive = Boolean(lineId || teamId || search)

  function clearFilters() {
    setLineId(''); setTeamId(''); setSearch('')
    setStageKey(''); setJobId(''); setOperationId('')
  }

  // ── Stage writes (pane 1) ──────────────────────────────────────────────────────────────
  async function afterStageChange() {
    await reloadStages()
    await loadJobs()
  }

  // ── Job writes (pane 2) ────────────────────────────────────────────────────────────────
  /**
   * The single save path behind the job drawer: rename, then re-stage. Both are optional — the
   * drawer only asks for what actually changed — and the re-stage goes through stages.ts'
   * setJobStage, so the job's team/line follow the target stage rather than being written here.
   *
   * Deliberately does NOT follow the job to its new stage. Once a job moves to another team's
   * stage the current Line→Team filter may legitimately exclude it, and chasing it would mean
   * silently rewriting the filter the user set. It drops out of the list and the returned
   * summary is what tells them where it went.
   */
  async function saveJobEdit(job: Job, name: string, stage: Stage | null): Promise<void> {
    setPageError(null)
    const trimmed = name.trim()

    if (trimmed && trimmed !== job.name) {
      const { error } = await supabase.from('jobs').update({ name: trimmed }).eq('id', job.id)
      if (error) throw new Error(error.message)
    }

    const currentStageId = job.stage_id ?? null
    if ((stage?.id ?? null) !== currentStageId) {
      await setJobStage(supabase, job.id, stage)
    }

    await reloadStages()
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
    if (!trimmed || !activeStageEntry) return
    setPageError(null)
    const stage = activeStageEntry.stage
    const { data, error } = await supabase.from('jobs').insert({
      name: trimmed,
      // Line and team come from the pane context: the scoped line, and the team filter if one
      // is set — otherwise the stage's own team, which is the team that stage belongs to.
      production_line_id: scopeLineId || null,
      team_id: teamId || stage?.team_id || null,
      stage_id: stage?.id ?? null,
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

  // ── Pane 3 multi-select (shared by bulk-link and merge) ────────────────────────────────
  function enterMode(mode: 'bulk' | 'merge') {
    setOpMode((cur) => (cur === mode ? 'normal' : mode))
    setOpSelection(new Set())
    setMergeKeeperId(null)
    setPageError(null)
  }

  function toggleOpSelection(id: string) {
    const next = new Set(opSelection)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpSelection(next)
    // The keeper always has to be one of the selected operations — default to the first picked
    // and only move it when the current keeper is deselected.
    if (!mergeKeeperId || !next.has(mergeKeeperId)) setMergeKeeperId([...next][0] ?? null)
  }

  function setAllOpSelection(selected: boolean) {
    const next = selected ? new Set(operations.map((o) => o.id)) : new Set<string>()
    setOpSelection(next)
    setMergeKeeperId(selected ? operations[0]?.id ?? null : null)
  }

  // Only operations still present in the job count — one deleted or moved away under the
  // selection must not be written to.
  const selectedOperations = useMemo(
    () => operations.filter((o) => opSelection.has(o.id)),
    [operations, opSelection]
  )
  const mergeKeeper = selectedOperations.find((o) => o.id === mergeKeeperId) ?? null
  const mergeDups = mergeKeeper ? selectedOperations.filter((o) => o.id !== mergeKeeper.id) : []

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

  /**
   * Merge — lib/mergeOperations, the same helper /tryouts and /collect call. It owns the write
   * order, the all-or-nothing ownership guard and the post-move verification; this handler only
   * decides what to do with the outcome on this screen.
   */
  async function runMerge(keeper: Operation, dups: Operation[]) {
    setMerging(true)
    setPageError(null)
    try {
      const { stranded } = await mergeOperations(supabase, { keeper, dups, userId })
      await refreshAll()
      setPanelDataVersion((v) => v + 1)
      setOperationId(keeper.id)
      setOpSelection(new Set())
      setMergeKeeperId(null)
      if (stranded.length > 0) setPageError(strandedMergeMessage(stranded))
      else setOpMode('normal')
    } catch (err) {
      await refreshAll()
      setPageError(err instanceof Error ? err.message : 'Merge failed')
    } finally {
      setMerging(false)
      setMergeConfirm(null)
    }
  }

  return (
    <main className="page-wide">
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Setup</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
          Drill down the line&apos;s structure — Stage → Job → Operation → Models. Each column is filled by what you pick in the one to its left.
        </p>
      </div>

      {/* ── Filter bar: Line + Team scope every pane, search jumps to one operation ─────── */}
      <div className="card" style={{ padding: '14px 20px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            style={SEL}
            value={lineId}
            onChange={(e) => { setLineId(e.target.value); setTeamId(''); setStageKey(''); setJobId(''); setOperationId('') }}
          >
            <option value="">All production lines</option>
            {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <select
            style={SEL}
            value={teamId}
            onChange={(e) => { setTeamId(e.target.value); setStageKey(''); setJobId(''); setOperationId('') }}
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
            {searchResults.map(({ operation, job, stageName }) => (
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
                    {stageName && <> · {stageName}</>}
                    {job.teams?.name && <> · {job.teams.name}</>}
                  </span>
                </span>
                <CoverageBadge coverage={coverageByOp[operation.id]} loading={loadingCoverage} />
              </button>
            ))}
          </div>
        </div>
      )}

      {pageError && <p style={{ ...ERR_BOX, marginBottom: 16 }}>{pageError}</p>}

      {/* Where a just-moved job went. A job reassigned to another team's stage legitimately
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
        <StagesPane
          supabase={supabase}
          entries={stageEntries}
          stages={stageOptions}
          productionLineId={scopeLineId}
          productionLineName={scopeLineName}
          teams={scopeTeams}
          selectedKey={activeStageKey}
          onSelect={selectStage}
          onChanged={afterStageChange}
        />

        <JobsPane
          entry={activeStageEntry}
          jobs={jobsInStage}
          loading={loadingJobs}
          operationsByJob={operationsByJob}
          selectedJobId={activeJobId}
          canDelete={role === 'admin'}
          onSelect={selectJob}
          onAdd={addJob}
          onEdit={openJobDrawer}
          onEditTeamLine={(job) => setJobModal({ mode: 'edit', job })}
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
          mergeKeeperId={mergeKeeperId}
          merging={merging}
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
          onPickKeeper={setMergeKeeperId}
          onOpenBulkDrawer={openBulkDrawer}
          onRequestMerge={() => { if (mergeKeeper && mergeDups.length > 0) setMergeConfirm({ keeper: mergeKeeper, dups: mergeDups }) }}
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
          defaultTeamId={teamId}
          lines={lines}
          allTeams={allTeams}
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
      {mergeConfirm && (
        <ConfirmDialog
          title={`Merge ${plural(mergeConfirm.dups.length, 'operation')} into "${mergeConfirm.keeper.name}"`}
          message={`Move all recorded times and notes from the selected operations onto ${mergeConfirm.keeper.name}, then retire the others. They'll stop appearing across the app. This can be reversed by reactivating them in the database.`}
          confirmLabel={merging ? 'Merging…' : 'Merge & retire'}
          danger
          onConfirm={() => { if (!merging) runMerge(mergeConfirm.keeper, mergeConfirm.dups) }}
          onCancel={() => { if (!merging) setMergeConfirm(null) }}
        >
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--text-mid)' }}>
            {mergeConfirm.dups.map((d) => <li key={d.id}>{d.name}</li>)}
          </ul>
        </ConfirmDialog>
      )}

      {/* ── Job edit / reassign drawer ─────────────────────────────────────────────────── */}
      {jobDrawer && (
        <>
          <div className={'gaps-drawer-overlay' + (jobDrawerVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={closeJobDrawer} />
          <div className={'gaps-drawer' + (jobDrawerVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <JobEditDrawer
              job={jobDrawer}
              // Every stage on the job's OWN line, across all its teams — reassigning to
              // another team's stage is the point, so this must not be narrowed by the Team
              // filter. Falls back to the scoped line for a job that has no line of its own.
              stages={sortStages(allStages.filter((s) => s.production_line_id === (jobDrawer.production_line_id ?? scopeLineId)))}
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
    </main>
  )
}



// ── Job edit / reassign slide-over ─────────────────────────────────────────────────────────
/**
 * Rename a job and move it to another stage — including a stage belonging to a different team,
 * which is the case the old footer dropdown couldn't express safely.
 *
 * The stage list is grouped by team via <optgroup>, because "Fit-out 3" means nothing without
 * knowing whose Fit-out 3 it is, and picking one silently changes the job's team (see
 * stages.ts' setJobStage). That consequence is stated in the confirm rather than discovered
 * afterwards, and the confirm also says what rides along: the job's operations and their
 * recorded times, which need no migration because they hang off job_id/operation_id.
 *
 * Nothing is written until Save; × discards.
 */
// ── Pane 3: Operations ─────────────────────────────────────────────────────────────────────
/**
 * The selected job's active operations, each with its model-coverage badge. Two multi-select
 * modes live here rather than in a drawer of their own — "Bulk link" (apply one model set to
 * many operations at once) and "Merge" (fold duplicates into a keeper) — because both are
 * chosen from this same list. Only one is ever live, and the row turns into a checkbox for the
 * duration so the per-operation actions can't be mis-clicked.
 *
 * Operator assignment sits in the footer, collapsed: it stays fully editable, but nothing on
 * this screen waits on it (phase-1: operators are context only).
 */
function OperationsPane({
  job, operations, loading, coverageByOp, loadingCoverage, selectedOperationId, selectedOperation,
  operators, canDelete, mode, selection, mergeKeeperId, merging, operatorsOpen,
  onSelect, onEdit, onAdd, onMove, onDeleteRequest, onEnterMode, onToggleSelection,
  onSetAllSelection, onPickKeeper, onOpenBulkDrawer, onRequestMerge, onToggleOperators, onOperatorChange,
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
  mode: 'normal' | 'bulk' | 'merge'
  selection: Set<string>
  mergeKeeperId: string | null
  merging: boolean
  operatorsOpen: boolean
  onSelect: (id: string) => void
  /** Opens the shared operation editor. Distinct from onSelect so the row's click can stay
   * "show me this operation's models" — selecting and editing must not collide. */
  onEdit: (op: Operation) => void
  onAdd: () => void
  onMove: (op: Operation) => void
  onDeleteRequest: (op: Operation) => void
  onEnterMode: (mode: 'bulk' | 'merge') => void
  onToggleSelection: (id: string) => void
  onSetAllSelection: (selected: boolean) => void
  onPickKeeper: (id: string) => void
  onOpenBulkDrawer: () => void
  onRequestMerge: () => void
  onToggleOperators: () => void
  onOperatorChange: () => void
}) {
  const selectedCount = operations.filter((o) => selection.has(o.id)).length
  const allSelected = operations.length > 0 && selectedCount === operations.length
  const inSelectMode = mode !== 'normal'

  const subtitle = !job
    ? 'No job selected'
    : mode === 'bulk'
      ? `${job.name} · bulk link — ${selectedCount} selected`
      : mode === 'merge'
        ? `${job.name} · merge — ${selectedCount} selected`
        : `${job.name} · ${plural(operations.length, 'operation')}`

  return (
    <Pane
      title="Operations"
      subtitle={subtitle}
      active={Boolean(selectedOperationId)}
      footer={
        job ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            {mode === 'bulk' ? (
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
            ) : mode === 'merge' ? (
              <>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {selectedCount < 2
                    ? 'Tick two or more duplicates, then pick which one to keep.'
                    : `Keeper: ${operations.find((o) => o.id === mergeKeeperId)?.name ?? '—'} · ${selectedCount - 1} will be retired`}
                </span>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    className="btn-danger"
                    style={{ padding: '6px 11px', fontSize: 12 }}
                    disabled={merging || selectedCount < 2 || !mergeKeeperId}
                    onClick={onRequestMerge}
                  >
                    {merging ? 'Merging…' : `Merge ${Math.max(selectedCount - 1, 0)} into keeper`}
                  </button>
                  <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} disabled={merging} onClick={() => onEnterMode('merge')}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={onAdd}>+ Add operation</button>
                  {operations.length > 1 && (
                    <>
                      <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => onEnterMode('bulk')}>Bulk link</button>
                      <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => onEnterMode('merge')}>Merge</button>
                    </>
                  )}
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
      {!job ? (
        <p className="finder-pane-empty">Select a job.</p>
      ) : loading ? (
        <p className="finder-pane-empty">Loading…</p>
      ) : operations.length === 0 ? (
        <p className="finder-pane-empty">No operations under {job.name} yet — add one below.</p>
      ) : (
        operations.map((op) => {
          const isSelected = op.id === selectedOperationId
          const isTicked = selection.has(op.id)
          const isKeeper = mergeKeeperId === op.id

          // In a select mode the row is a checkbox and nothing else — the per-operation
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
                    {mode === 'merge' && isTicked && (
                      <span
                        style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: isKeeper ? 'var(--blue)' : 'var(--text-muted)', marginTop: 2 }}
                        // Stopped here rather than at the label: letting the click bubble would
                        // run the label's activation behaviour and untick the row's checkbox.
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="radio"
                          name="merge-keeper"
                          checked={isKeeper}
                          onChange={() => onPickKeeper(op.id)}
                          style={{ width: 13, height: 13, accentColor: 'var(--blue)', cursor: 'pointer' }}
                        />
                        Keep this one
                      </span>
                    )}
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
          supabase
            .from('operation_times')
            .select('id, total_minutes, created_at, operator_id')
            .eq('operation_id', operationId)
            .order('created_at', { ascending: false }),
        ])
        if (linkError) throw new Error(linkError.message)
        if (timeError) throw new Error(timeError.message)

        const linkedIds = new Set((linkRows ?? []).map((r) => r.product_id as string))
        const times = (timeRows ?? []) as { id: string; total_minutes: number | null; created_at: string; operator_id: string | null }[]
        const timeIds = times.map((t) => t.id)

        // Which model(s) each time belongs to — operation_times carries no product_id of its
        // own, exactly as averageForOperation and lib/coverage.ts both assume.
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
          operatorName: t.operator_id ? operatorNameById.get(t.operator_id) ?? null : null,
          notes: notesByTime.get(t.id) ?? [],
        }]))

        // The same shared averager every other screen uses — re-shaped to the (operation_id,
        // times) rows it expects, then read back per product for this one operation.
        const stats = averageForOperation(
          times.map((t) => ({ id: t.id, operation_id: operationId, total_minutes: t.total_minutes })),
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
                          {group.stat ? `${group.stat.avg.toFixed(1)}m avg · ` : ''}{plural(group.times.length, 'time')}
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
                              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{fmtMinutes(time.totalMinutes)}m</span>
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
    const { error: err } = await supabase.from('operations').update({ job_id: targetJobId }).eq('id', operation.id)
    if (err) { setError(err.message); setSaving(false); return }
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
