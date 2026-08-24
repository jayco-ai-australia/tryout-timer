'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import ConfirmDialog from '@/components/ConfirmDialog'
import NewOperationModal from '@/components/NewOperationModal'
import { ModelSeriesPicker } from '@/components/ModelLinker'
import BulkModelLinkDrawer, { DRAWER_WIDTH, useSlideOverDrawer } from '@/components/BulkModelLinkDrawer'
import JobEditDrawer from '@/components/JobEditDrawer'
import JobFormModal from '@/components/JobFormModal'
import OperationEditDrawer from '@/components/OperationEditDrawer'
import {
  JobsPane, Pane, RenameButton, StagesPane, UNSTAGED_KEY, plural, type StageEntry,
} from '@/components/FinderPanes'
import {
  CompleteTimerDialog, StartTimerDialog, TimerRail,
  type CompleteTimerResult, type StartTimerChoice,
} from '@/components/TimerRail'
import {
  addOperationTimeNote, averageForOperation, operationProductKey, recordOperationTime,
  type OperationTimeStat,
} from '@/lib/operationTimes'
import { fetchLinksForOperations } from '@/lib/modelOperations'
import { saveTimerRun, useStopwatches, type ActiveTimer } from '@/lib/stopwatch'
import { setJobStage, sortStages } from '@/lib/stages'
import { blockedMergeMessage, mergeOperations, preflightMerge, strandedMergeMessage, type MergePreflight } from '@/lib/mergeOperations'
import { createOperation, createOperations, parseOperationNames } from '@/lib/operations'
import { fmtMinutes } from '@/lib/format'
import { usePersistedFilter } from '@/lib/useLocalStorage'
import type { Job, Operation, Product, ProductionLine, Stage, Team } from '@/lib/types'

/**
 * Collect — fill coverage by operation.
 *
 * The point of this screen is that most operations are IDENTICAL across models: fitting the
 * same hatch on eleven vans is the same job eleven times. So a run is timed once and banked
 * against every model it applies to at once — ONE operation_times row, linked to many products
 * through operation_time_models. That is the whole difference between here and /tryouts, which
 * times one specific van and links a run to exactly that van's model.
 *
 * There is deliberately NO chassis anywhere on this screen. A coverage time is a statement
 * about an operation on a model, not about a particular van, and attaching a chassis would make
 * it look like a tryout measurement when it isn't. recordOperationTime is called with
 * chassisId: null.
 *
 * ── What this replaced ────────────────────────────────────────────────────────────────────
 * The old screen had two entry flows. "Chassis-first" is now /tryouts, which does that job
 * properly with a whole van view behind it; keeping a second, thinner version here would have
 * been two answers to one question. "Operator-first" — pick a person, then one of their
 * operations — is retired outright: it organised the work by who happened to be standing there
 * rather than by what still has no data, which is the opposite of what filling coverage needs.
 *
 * What replaces both is the same structure-first drill-down /setup and /tryouts use — Line →
 * Team → Stage → Job → Operation — so the walk to an operation is the same walk everywhere in
 * the app, and then a Models pane that shows exactly where the gaps are.
 *
 * ── Reuse ─────────────────────────────────────────────────────────────────────────────────
 * Nothing here is a fork. The panes are components/FinderPanes (the stage column mounted
 * read-only — structural editing belongs to /setup), the models list is ModelSeriesPicker, the
 * stopwatches are lib/stopwatch through the shared useStopwatches hook, and the running-timers
 * rail and the Start/Complete dialogs are components/TimerRail — the same components /tryouts
 * mounts. Timers, notes and the operator behave identically on both screens because they are
 * literally the same code.
 *
 * The three structural writes this screen does allow — adding a job, adding an operation, and
 * linking operations to models — are the same writes /setup and /tryouts perform (addJob
 * mirrors /setup's field for field; every operation insert, whether from the modal, the
 * quick-add row or the paste box, is lib/operations' createOperation/createOperations; the
 * the model links go through BulkModelLinkDrawer, the same component /setup mounts, guard and
 * all). Everything else about the structure — renaming, moving, merging,
 * staging — stays in /setup. The line is drawn at "a missing row is a coverage gap you found
 * mid-walk": having to leave the screen to add it is how it ends up never recorded.
 *
 * Adding operations is shaped for a person standing on a line with a list, not for a form:
 * the quick-add row takes a name and Enter and stays focused so several can be rattled off in
 * a row, and the paste box takes a whole list at once. Both land on the same insert, so an
 * operation created any of the three ways is indistinguishable from the others.
 *
 * ── Two model lists, two jobs ─────────────────────────────────────────────────────────────
 * This screen shows models in two places, and they are NOT two views of one thing. Confusing
 * them is the one mistake that produces bad data here, so they are kept apart deliberately:
 *
 *   - The Models — Coverage PANE is about THIS TIMING. Its checkboxes choose which models the
 *     next run is banked against, for the one operation being timed. Ticking is in-memory
 *     until the time is saved; it writes nothing, links nothing, and unlinks nothing. It can
 *     only offer models the operation is already linked to — coverage of a model an operation
 *     doesn't apply to is not a thing.
 *
 *   - The Link models DRAWER is about APPLICABILITY. It writes model_operations for the
 *     operations multi-selected in pane 3 — "these operations are done on these models" — and
 *     has nothing to do with any timing run. Add-only, so it never removes a link.
 *
 * They never both show a checkbox list at once: the drawer is a slide-over, and the pane shows
 * no model rows at all when the operation has nothing linked (there is nothing to bank against
 * yet), offering the drawer instead. An operation with no models linked has no coverage to
 * collect and no gaps to show — the fix is applicability, which is the drawer's job, and it
 * opens over this screen rather than sending anyone to another one.
 */

interface Props { lines: ProductionLine[]; userId: string }

const SEL: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
  border: '1.5px solid var(--border)', borderRadius: 8, padding: '7px 10px',
  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', outline: 'none', minWidth: 200,
}
const ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}
const OK_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--green-bg)',
  border: '1px solid #bbf7d0', color: '#15803d', fontSize: 13,
}

/** Its own key, separate from /tryouts' — a coverage run and a van run are different work, and
 * a timer started here must not turn up in a van's rail as though it belonged to that chassis. */
const TIMERS_KEY = 'jmotion_collect_timers'

function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

// ── Raw query shapes (relations come back object-or-array from PostgREST) ────────────────
interface RawTeamRef { id: string; name: string }
interface RawJob {
  id: string; name: string; primary_operator_id: string | null
  team_id: string | null; production_line_id: string | null; stage_id: string | null; created_at: string
  teams: RawTeamRef | RawTeamRef[] | null
}

interface OperatorOption { id: string; full_name: string }

/** Which operation a Start is pointing at, with its labels — so the dialog can name it without
 * re-deriving it from the panes. */
interface TimerTarget { operationId: string; operationName: string; jobName: string }

export default function CollectClient({ lines, userId }: Props) {
  const supabase = useMemo(() => createClient(), [])

  // ── Filters + drill position, persisted like /setup's so a refresh comes back here ────
  const [lineId, setLineId] = usePersistedFilter('jmotion_collect_line')
  const [teamId, setTeamId] = usePersistedFilter('jmotion_collect_team')
  const [stageKey, setStageKey] = usePersistedFilter('jmotion_collect_stage')
  const [jobId, setJobId] = usePersistedFilter('jmotion_collect_job')
  const [operationId, setOperationId] = usePersistedFilter('jmotion_collect_operation')

  const [allTeams, setAllTeams] = useState<Team[]>([])
  const [stages, setStages] = useState<Stage[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [operationsByJob, setOperationsByJob] = useState<Record<string, Operation[]>>({})
  const [operators, setOperators] = useState<OperatorOption[]>([])
  const [loadingStructure, setLoadingStructure] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)

  // ── Models pane: the applies-list of the selected operation, plus its coverage ────────
  const [opModels, setOpModels] = useState<Product[]>([])
  const [opStats, setOpStats] = useState<Record<string, OperationTimeStat>>({})
  const [loadingModels, setLoadingModels] = useState(false)
  /** The coverage targets the next run gets banked against. Default none — a time banked
   * against models nobody chose is exactly the quiet wrong data this screen exists to fix. */
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set())
  /**
   * Which operations the Link models drawer is currently writing applicability for. Captured
   * when the drawer opens rather than read live, so the subject can't shift underneath it: the
   * bulk button opens it on the ticked operations, and the coverage pane's empty state opens
   * it on just the operation being timed.
   */
  const [linkTargets, setLinkTargets] = useState<Operation[]>([])

  // ── Stopwatches: the shared module, driving the shared rail ───────────────────────────
  const {
    timers, nowMs, start: startStopwatch, togglePause, discard: discardTimer,
    addNote: addTimerNote, removeNote: removeTimerNote,
  } = useStopwatches(TIMERS_KEY)
  const [startTarget, setStartTarget] = useState<TimerTarget | null>(null)
  const [completingTimer, setCompletingTimer] = useState<ActiveTimer | null>(null)
  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState<string | null>(null)
  const [cancelingTimerId, setCancelingTimerId] = useState<string | null>(null)

  // ── Manual entry ─────────────────────────────────────────────────────────────────────
  const [manualOpen, setManualOpen] = useState(false)
  const [manualMinutes, setManualMinutes] = useState('')
  const [manualOperatorId, setManualOperatorId] = useState('')
  const [manualNote, setManualNote] = useState('')
  const [savingManual, setSavingManual] = useState(false)
  const [manualError, setManualError] = useState<string | null>(null)

  /** The confirmation that gaps just closed — dismissible, since the green rows say it too. */
  const [savedNotice, setSavedNotice] = useState<string | null>(null)

  /** The job a new operation is being added under, or null when the dialog is closed. Always
   * the selected job — this pane only ever adds into the job it is showing. */
  const [newOperationJob, setNewOperationJob] = useState<{ jobId: string; jobName: string } | null>(null)

  // ── Editing structure: the same drawers /setup opens ─────────────────────────────────
  /** The job open in the shared edit drawer (name + stage), or null. */
  const [jobDrawer, setJobDrawer] = useState<Job | null>(null)
  /** The job open in the shared Team / Line form, or null. Separate from the drawer above
   * because a line change unstages the job, which is a different question. */
  const [jobFormJob, setJobFormJob] = useState<Job | null>(null)
  /** Where a just-edited job went — the same line /setup shows behind its drawer. */
  const [jobNotice, setJobNotice] = useState<string | null>(null)
  /** The operation open in the shared editor (name + operators), or null. */
  const [operationDrawer, setOperationDrawer] = useState<Operation | null>(null)

  // ── Operations pane multi-select ─────────────────────────────────────────────────────
  /** Ticking operations is a mode, not a second meaning for the row click: clicking a row
   * still means "show me this operation's models", which is the whole drill-down. */
  const [opSelectMode, setOpSelectMode] = useState(false)
  const [opSelection, setOpSelection] = useState<Set<string>>(new Set())
  const {
    open: bulkLinkOpen, visible: bulkLinkVisible,
    openDrawer: openBulkLink, closeDrawer: closeBulkLink,
  } = useSlideOverDrawer()
  const {
    open: jobDrawerOpen, visible: jobDrawerVisible,
    openDrawer: showJobDrawer, closeDrawer: hideJobDrawer,
  } = useSlideOverDrawer()
  const {
    open: opDrawerOpen, visible: opDrawerVisible,
    openDrawer: showOperationDrawer, closeDrawer: hideOperationDrawer,
  } = useSlideOverDrawer()

  /** Which operation survives a merge. Always one of the ticked ones — see toggleOpSelected. */
  const [mergeKeeperId, setMergeKeeperId] = useState<string | null>(null)
  /** The pending merge, with what preflightMerge found it would move. */
  const [mergeConfirm, setMergeConfirm] = useState<{ keeper: Operation; dups: Operation[]; preflight: MergePreflight } | null>(null)
  const [mergePreparing, setMergePreparing] = useState(false)
  const [merging, setMerging] = useState(false)

  // ── Reference data ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.from('teams').select('*').order('name').then(({ data }) => setAllTeams((data ?? []) as Team[]))
    supabase.from('stages').select('*').order('sort_order')
      .then(({ data }) => setStages(sortStages((data ?? []) as Stage[])))
    supabase.from('operators').select('id, full_name').eq('is_active', true).order('full_name')
      .then(({ data }) => setOperators((data ?? []) as OperatorOption[]))
  }, [supabase])

  // ── Structure: jobs in scope, then their active operations ───────────────────────────
  const loadStructure = useCallback(async () => {
    setLoadingStructure(true)
    setPageError(null)

    let q = supabase.from('jobs').select('*, teams ( id, name )').order('name')
    if (teamId) q = q.eq('team_id', teamId)
    else if (lineId) q = q.eq('production_line_id', lineId)
    const { data: jobRows, error: jobsError } = await q
    if (jobsError) { setPageError(jobsError.message); setLoadingStructure(false); return }

    const loadedJobs: Job[] = ((jobRows ?? []) as unknown as RawJob[]).map((r) => ({
      id: r.id, name: r.name, primary_operator_id: r.primary_operator_id,
      team_id: r.team_id, production_line_id: r.production_line_id, stage_id: r.stage_id,
      created_at: r.created_at, teams: one(r.teams),
    }))
    setJobs(loadedJobs)

    const jobIds = loadedJobs.map((j) => j.id)
    if (jobIds.length === 0) { setOperationsByJob({}); setLoadingStructure(false); return }

    const { data: opRows, error: opsError } = await supabase
      .from('operations').select('*').in('job_id', jobIds).eq('is_active', true).order('name')
    if (opsError) { setPageError(opsError.message); setLoadingStructure(false); return }

    const grouped: Record<string, Operation[]> = {}
    for (const op of (opRows ?? []) as Operation[]) (grouped[op.job_id] ??= []).push(op)
    setOperationsByJob(grouped)
    setLoadingStructure(false)
  }, [supabase, lineId, teamId])

  useEffect(() => { loadStructure() }, [loadStructure])

  // ── Scope, mirroring /setup exactly ──────────────────────────────────────────────────
  const teamOptions = lineId ? allTeams.filter((t) => t.production_line_id === lineId) : allTeams

  /** Stages belong to exactly one line, so a team filter with no line chosen still resolves to
   * that team's line — otherwise picking a team would silently switch stage grouping off. */
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

  /** Deliberately NOT narrowed by the team filter: a stage belongs to one team, but a job
   * sitting in it doesn't have to, so filtering here would hide the very stage a filtered job
   * is grouped under. */
  const stageOptions = useMemo(
    () => (scopeLineId ? sortStages(stages.filter((s) => s.production_line_id === scopeLineId)) : []),
    [stages, scopeLineId]
  )

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

  /** The line's stages in walk order, plus "Unstaged" whenever it holds anything. A line with
   * no stages at all (Caravan, Motor Home) gets Unstaged as its single entry — every job lives
   * there, and no empty stage scaffolding is invented. */
  const stageEntries = useMemo<StageEntry[]>(() => {
    const entries: StageEntry[] = stageOptions.map((s) => ({
      key: s.id, name: s.name, stage: s, jobCount: (jobsByStageKey.get(s.id) ?? []).length,
    }))
    const unstagedCount = (jobsByStageKey.get(UNSTAGED_KEY) ?? []).length
    if (stageOptions.length === 0 || unstagedCount > 0) {
      entries.push({
        key: UNSTAGED_KEY,
        name: scopeLineId ? 'Unstaged' : 'All jobs',
        stage: null,
        jobCount: unstagedCount,
      })
    }
    return entries
  }, [stageOptions, jobsByStageKey, scopeLineId])

  // A persisted id can outlive the scope it was chosen in; fall back to "nothing selected"
  // rather than writing over the stored value.
  const activeStageKey = stageEntries.some((e) => e.key === stageKey) ? stageKey : ''
  const activeStageEntry = stageEntries.find((e) => e.key === activeStageKey) ?? null

  const jobsInStage = useMemo(
    () => (activeStageKey ? jobsByStageKey.get(activeStageKey) ?? [] : []),
    [activeStageKey, jobsByStageKey]
  )
  const activeJobId = jobsInStage.some((j) => j.id === jobId) ? jobId : ''
  const selectedJob = jobsInStage.find((j) => j.id === activeJobId) ?? null

  const operations = useMemo(
    () => (activeJobId ? operationsByJob[activeJobId] ?? [] : []),
    [activeJobId, operationsByJob]
  )
  const activeOperationId = operations.some((o) => o.id === operationId) ? operationId : ''
  const selectedOperation = operations.find((o) => o.id === activeOperationId) ?? null

  // ── Models pane data ─────────────────────────────────────────────────────────────────
  /**
   * The models this operation applies to (model_operations), and for each the average and run
   * count of the times already banked against that exact (operation, model) pair — through the
   * shared averager, so "42.0m · 3" here is the same figure /dashboard and /model-total show.
   */
  const loadModels = useCallback(async (opId: string) => {
    setLoadingModels(true)
    setPageError(null)
    try {
      const links = await fetchLinksForOperations(supabase, [opId])
      const productIds = [...new Set(links.map((l) => l.product_id))]
      if (productIds.length === 0) { setOpModels([]); setOpStats({}); return }

      const [{ data: productRows, error: productsError }, { data: timeRows, error: timesError }] = await Promise.all([
        supabase.from('products').select('*').in('id', productIds).order('model'),
        supabase.from('operation_times').select('id, operation_id, total_minutes').eq('operation_id', opId),
      ])
      if (productsError) throw new Error(productsError.message)
      if (timesError) throw new Error(timesError.message)

      const times = timeRows ?? []
      const { data: timeModels, error: timeModelsError } = times.length > 0
        ? await supabase.from('operation_time_models')
            .select('operation_time_id, product_id').in('operation_time_id', times.map((t) => t.id))
        : { data: [] as { operation_time_id: string; product_id: string }[], error: null }
      if (timeModelsError) throw new Error(timeModelsError.message)

      // averageForOperation keys by "operationId:productId"; this pane is scoped to one
      // operation, so remap down to plain product ids for the row lookup.
      const pairStats = averageForOperation(times, timeModels ?? [])
      const stats: Record<string, OperationTimeStat> = {}
      for (const id of productIds) {
        const stat = pairStats[operationProductKey(opId, id)]
        if (stat) stats[id] = stat
      }

      setOpModels((productRows ?? []) as Product[])
      setOpStats(stats)
    } catch (err) {
      setOpModels([]); setOpStats({})
      setPageError(err instanceof Error ? err.message : 'Could not load this operation’s models')
    } finally {
      setLoadingModels(false)
    }
  }, [supabase])

  useEffect(() => {
    if (!activeOperationId) { setOpModels([]); setOpStats({}); return }
    loadModels(activeOperationId)
  }, [activeOperationId, loadModels])

  // Changing which operation is in view invalidates a selection made against the previous
  // one — those product ids belong to a different applies-list.
  useEffect(() => {
    setSelectedProductIds(new Set())
    setManualOpen(false)
    setManualError(null)
  }, [activeOperationId])

  /**
   * A selection can only ever name models the operation still applies to. Unlinking is now
   * possible from this screen, and a product id left ticked after its link was removed would
   * bank the next run against a pair that no longer exists — silently, since the row it was
   * ticked on is gone from the list.
   */
  useEffect(() => {
    setSelectedProductIds((prev) => {
      if (prev.size === 0) return prev
      const linked = new Set(opModels.map((p) => p.id))
      const next = new Set([...prev].filter((id) => linked.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [opModels])

  /**
   * Which line's products the linker offers. The operation's own job is the authority (that's
   * what /setup passes), with the scope filter as a fallback for a job whose line was never
   * filled in. No line resolvable → nothing to link against, and the pane says so rather than
   * showing an empty picker.
   */
  const modelLinkLineId =
    selectedJob?.production_line_id || activeStageEntry?.stage?.production_line_id || scopeLineId || null

  /** Re-read the applies-list and its coverage after the linker writes, so a model linked here
   * appears in the list below it — with its gap/timed status — without a screen change. */
  const refreshModels = useCallback(() => {
    if (activeOperationId) loadModels(activeOperationId)
  }, [activeOperationId, loadModels])

  // ── Drill actions ────────────────────────────────────────────────────────────────────
  function selectStage(key: string) { setStageKey(key); setJobId(''); setOperationId('') }
  function selectJob(id: string) { setJobId(id); setOperationId('') }

  /**
   * Add a job under the selected stage — the same insert /setup's addJob performs, field for
   * field, so a job created here is indistinguishable from one created there.
   *
   * The stage comes off activeStageEntry.stage, which is null for the virtual "Unstaged" /
   * "All jobs" bucket — so stage_id lands as a real null and the UNSTAGED_KEY sentinel never
   * reaches the database. Line and team come from the pane's filter context: the scoped line,
   * and the team filter if one is set, otherwise the stage's own team. All three columns are
   * nullable, so "All teams" is a legitimate choice rather than something to block on.
   *
   * The inserted row is read back (.select('id').single()) so a constraint or RLS rejection
   * shows as a message instead of a list that quietly doesn't change.
   */
  async function addJob(name: string) {
    const trimmed = name.trim()
    if (!trimmed || !activeStageEntry) return
    setPageError(null)
    const stage = activeStageEntry.stage
    const { data, error } = await supabase.from('jobs').insert({
      name: trimmed,
      production_line_id: scopeLineId || null,
      team_id: teamId || stage?.team_id || null,
      stage_id: stage?.id ?? null,
    }).select('id').single()
    if (error) { setPageError(error.message); return }
    // Re-runs the jobs query under the current line/team filter, so the new row arrives through
    // the same path every other job on this screen did — no hand-appended copy to drift.
    await loadStructure()
    if (data?.id) selectJob(data.id)
  }
  // ── Adding operations ────────────────────────────────────────────────────────────────
  /**
   * The quick-add row: one name, Enter, gone. Deliberately does NOT select what it created —
   * the point of the row is rattling off a list, and selecting each new operation would swing
   * the Models pane (and reload its coverage) between every name typed. The modal, which is
   * the one-off path, still selects.
   *
   * Rethrows so the pane can leave the typed name in the box on failure rather than clearing
   * it into thin air.
   */
  async function quickAddOperation(name: string) {
    if (!selectedJob) return
    setPageError(null)
    await createOperation(supabase, { name, jobId: selectedJob.id })
    await loadStructure()
  }

  /**
   * The paste box: one operation per non-empty line, all created in one action. Reports what
   * actually landed — created vs attempted — rather than assuming, so a partial RLS rejection
   * shows up instead of passing for success.
   */
  async function bulkAddOperations(text: string) {
    if (!selectedJob) return { created: 0, attempted: 0, duplicatesDropped: 0, error: null as string | null }
    setPageError(null)
    const { names, duplicatesDropped } = parseOperationNames(text)
    if (names.length === 0) return { created: 0, attempted: 0, duplicatesDropped, error: null }
    const result = await createOperations(supabase, selectedJob.id, names)
    await loadStructure()
    return {
      created: result.created.length,
      attempted: result.attempted,
      duplicatesDropped,
      error: result.error,
    }
  }

  // ── Operations multi-select → bulk model link ────────────────────────────────────────
  function toggleOpSelectMode() {
    setOpSelectMode((on) => !on)
    setOpSelection(new Set())
  }

  function toggleOpSelected(id: string) {
    const next = new Set(opSelection)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpSelection(next)
    // The keeper always has to be one of the selected operations — default to the first picked
    // and only move it when the current keeper is deselected. Computed here rather than inside
    // the setOpSelection updater: an updater must stay pure, and React may run it twice.
    if (!mergeKeeperId || !next.has(mergeKeeperId)) setMergeKeeperId([...next][0] ?? null)
  }

  function setAllOpsSelected(selected: boolean) {
    setOpSelection(selected ? new Set(operations.map((o) => o.id)) : new Set())
    setMergeKeeperId(selected ? operations[0]?.id ?? null : null)
  }

  /** Only operations still in the job count. One retired or moved away under the selection
   * must not be written to — the same guard /setup's bulk mode applies. */
  const selectedOperations = useMemo(
    () => operations.filter((o) => opSelection.has(o.id)),
    [operations, opSelection]
  )

  // A selection belongs to the job it was made in; changing jobs (or leaving the mode) drops it.
  useEffect(() => {
    setOpSelection(new Set())
    setMergeKeeperId(null)
  }, [activeJobId])

  const mergeKeeper = selectedOperations.find((o) => o.id === mergeKeeperId) ?? null
  const mergeDups = mergeKeeper ? selectedOperations.filter((o) => o.id !== mergeKeeper.id) : []

  /**
   * Asks lib/mergeOperations what the merge would move BEFORE offering to run it, so the
   * confirmation states real numbers and a merge blocked by another user's times is refused
   * here — with nothing written — rather than part-way through.
   */
  async function requestMerge() {
    if (!mergeKeeper || mergeDups.length === 0) return
    setMergePreparing(true); setPageError(null)
    try {
      const preflight = await preflightMerge(supabase, mergeDups, userId)
      if (preflight.blockers.length > 0) {
        setPageError(blockedMergeMessage(preflight.blockers))
        return
      }
      setMergeConfirm({ keeper: mergeKeeper, dups: mergeDups, preflight })
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Could not check this merge')
    } finally {
      setMergePreparing(false)
    }
  }

  /** Merge — lib/mergeOperations, the same helper /setup and /tryouts call. It owns the write
   * order, the ownership guard and the post-move verification; this only handles the outcome. */
  async function runMerge(keeper: Operation, dups: Operation[]) {
    setMerging(true); setPageError(null)
    try {
      const { stranded } = await mergeOperations(supabase, { keeper, dups, userId })
      await loadStructure()
      setOperationId(keeper.id)
      setOpSelection(new Set())
      setMergeKeeperId(null)
      if (stranded.length > 0) setPageError(strandedMergeMessage(stranded))
      else setOpSelectMode(false)
    } catch (err) {
      await loadStructure()
      setPageError(err instanceof Error ? err.message : 'Merge failed')
    } finally {
      setMerging(false)
      setMergeConfirm(null)
    }
  }

  // ── Editing jobs and operations ──────────────────────────────────────────────────────
  /**
   * The single save path behind the job drawer: rename, then re-stage — /setup's saveJobEdit,
   * field for field. The re-stage goes through stages.ts' setJobStage, so the job's team and
   * line follow the target stage rather than being written here.
   *
   * Deliberately does NOT follow the job to its new stage. Once it moves to another team's
   * stage the current Line/Team filter may legitimately exclude it, and chasing it would mean
   * silently rewriting the filter the user set. It drops out of the list, and the summary the
   * drawer returns is what says where it went.
   */
  async function saveJobEdit(job: Job, name: string, stage: Stage | null): Promise<void> {
    setPageError(null)
    const trimmed = name.trim()
    if (trimmed && trimmed !== job.name) {
      const { error } = await supabase.from('jobs').update({ name: trimmed }).eq('id', job.id)
      if (error) throw new Error(error.message)
    }
    if ((stage?.id ?? null) !== (job.stage_id ?? null)) {
      await setJobStage(supabase, job.id, stage)
    }
    const { data } = await supabase.from('stages').select('*').order('sort_order')
    setStages(sortStages((data ?? []) as Stage[]))
    await loadStructure()
  }

  function openJobDrawer(job: Job) {
    setJobNotice(null)
    setJobDrawer(job)
    showJobDrawer()
  }
  function closeJobDrawer() {
    hideJobDrawer()
    window.setTimeout(() => setJobDrawer(null), 320)
  }

  /** Applicability for the operations ticked in pane 3 — the bulk entry point. */
  function openLinkDrawerForSelection() {
    setLinkTargets(selectedOperations)
    openBulkLink()
  }

  /** Applicability for the one operation being timed — the entry point from the coverage
   * pane's empty state, where there is nothing to bank a run against yet. Same drawer, same
   * writes; only the subject is narrower. */
  function openLinkDrawerForCurrent() {
    setLinkTargets(selectedOperation ? [selectedOperation] : [])
    openBulkLink()
  }

  function openOperationDrawer(op: Operation) {
    setOperationDrawer(op)
    showOperationDrawer()
  }
  function closeOperationDrawer() {
    hideOperationDrawer()
    window.setTimeout(() => setOperationDrawer(null), 320)
  }

  function clearFilters() {
    setLineId(''); setTeamId('')
    setStageKey(''); setJobId(''); setOperationId('')
  }

  // ── Model selection ──────────────────────────────────────────────────────────────────
  function toggleModel(product: Product, isSelected: boolean) {
    setSelectedProductIds((prev) => {
      const next = new Set(prev)
      if (isSelected) next.delete(product.id)
      else next.add(product.id)
      return next
    })
  }

  function toggleSeries(_series: string, seriesProducts: Product[], allSelected: boolean) {
    setSelectedProductIds((prev) => {
      const next = new Set(prev)
      for (const p of seriesProducts) {
        if (allSelected) next.delete(p.id)
        else next.add(p.id)
      }
      return next
    })
  }

  /** Every model with no recorded time for this operation — the gaps, which is what the screen
   * exists to close, so they get a one-click selection of their own. */
  const gapProductIds = useMemo(
    () => opModels.filter((p) => !opStats[p.id]).map((p) => p.id),
    [opModels, opStats]
  )

  /** Untimed first within each series: on a coverage screen the gaps are the work, and a gap
   * buried under twelve green rows is a gap nobody fills. */
  const sortByGapFirst = useCallback(
    (a: Product, b: Product) => {
      const aTimed = opStats[a.id] ? 1 : 0
      const bTimed = opStats[b.id] ? 1 : 0
      if (aTimed !== bTimed) return aTimed - bTimed
      return a.model.localeCompare(b.model)
    },
    [opStats]
  )

  const runningOperationIds = useMemo(() => new Set(timers.map((t) => t.operationId)), [timers])

  /** Jobs with a stopwatch running on one of their operations — the running dot on pane 2. */
  const runningJobIds = useMemo(() => {
    const ids = new Set<string>()
    for (const [jId, ops] of Object.entries(operationsByJob)) {
      if (ops.some((o) => runningOperationIds.has(o.id))) ids.add(jId)
    }
    return ids
  }, [operationsByJob, runningOperationIds])

  const selectedCount = selectedProductIds.size
  const selectedModelLabel = plural(selectedCount, 'model')

  // ── Capture ──────────────────────────────────────────────────────────────────────────
  /** The rule every save on this screen answers to: a coverage time banked against nothing
   * records no coverage at all, so it is refused rather than written and lost. */
  const noModelsReason = selectedCount > 0
    ? null
    : opModels.length === 0
      // Not a dead end — the Link models drawer sets applicability, and the coverage pane
      // offers it. Point at the action rather than stating a fact nobody can act on.
      ? 'This operation isn\u2019t linked to any models yet, so there is no coverage to record against it. Use "Link models" on the right to say which models it applies to.'
      : 'Pick at least one model on the right first — a coverage time has to be banked against something.'

  /** One timer per operation, the same rule /tryouts enforces — a second run started on top of
   * a first would be indistinguishable in the rail. */
  const alreadyTiming = selectedOperation ? runningOperationIds.has(selectedOperation.id) : false

  function requestStart() {
    if (!selectedOperation || !selectedJob || noModelsReason || alreadyTiming) return
    setStartTarget({
      operationId: selectedOperation.id,
      operationName: selectedOperation.name,
      jobName: selectedJob.name,
    })
  }

  /**
   * Begins the run. The models are snapshotted onto the timer HERE, at Start — not read from
   * the pane at Complete. A timer can run for twenty minutes while its owner drills off to
   * another operation and ticks a different set; reading the selection at the end would bank
   * the run against whatever happened to be ticked by then. What was chosen when the clock
   * started is what the run is about.
   */
  function confirmStart(choice: StartTimerChoice) {
    if (!startTarget) return
    const chosen = opModels.filter((p) => selectedProductIds.has(p.id))
    startStopwatch({
      operationId: startTarget.operationId,
      operationName: startTarget.operationName,
      jobName: startTarget.jobName,
      productIds: chosen.map((p) => p.id),
      models: chosen.map((p) => ({ productId: p.id, productCode: p.product_code, model: p.model })),
      operatorId: choice.operatorId,
      operatorName: choice.operatorName,
      notes: choice.note.trim() ? [choice.note.trim()] : [],
      // No chassis: a coverage time is about an operation on a model, not about one van.
      chassisId: null,
      chassisNumber: null,
    })
    setStartTarget(null)
  }

  function requestComplete(timer: ActiveTimer) {
    setCompleteError(null)
    setCompletingTimer(timer)
  }

  async function confirmComplete(result: CompleteTimerResult) {
    if (!completingTimer) return
    const timer = completingTimer
    setCompleting(true); setCompleteError(null)
    try {
      // The shared save path: ONE operation_times row, linked to every model on the timer via
      // operation_time_models, then the run's notes in order. chassisId is null on the timer
      // and rides through untouched.
      await saveTimerRun(supabase, timer, {
        userId,
        operatorId: result.operatorId,
        notes: result.notes,
        note: result.note,
        atMs: result.atMs,
      })
      discardTimer(timer.timerId)
      setCompletingTimer(null)
      setSavedNotice(`“${timer.operationName}” banked against ${plural(timer.productIds.length, 'model')}.`)
      // Flip the just-timed models green without a page reload.
      if (timer.operationId === activeOperationId) await loadModels(activeOperationId)
    } catch (err) {
      setCompleteError(err instanceof Error ? err.message : 'Could not save time')
    } finally {
      setCompleting(false)
    }
  }

  function confirmCancelTimer() {
    if (!cancelingTimerId) return
    discardTimer(cancelingTimerId)
    setCancelingTimerId(null)
  }

  // ── Manual entry: the same fields, for a run nobody stopwatched ──────────────────────
  async function saveManual() {
    if (!selectedOperation || noModelsReason) return
    const minutes = Number(manualMinutes)
    if (!manualMinutes.trim() || Number.isNaN(minutes) || minutes <= 0) {
      setManualError('Enter a valid number of minutes')
      return
    }
    const productIds = [...selectedProductIds]
    setSavingManual(true); setManualError(null)
    try {
      const created = await recordOperationTime(supabase, {
        operationId: selectedOperation.id,
        productIds,
        // Blank → null → recorded against the placeholder operator, since
        // operation_times.operator_id is NOT NULL.
        operatorId: manualOperatorId || null,
        collectedBy: userId,
        totalMinutes: minutes,
        chassisId: null,
      })
      if (manualNote.trim()) {
        await addOperationTimeNote(supabase, created.id, manualNote.trim(), userId)
      }
      setSavedNotice(`“${selectedOperation.name}” banked against ${plural(productIds.length, 'model')}.`)
      setManualOpen(false)
      setManualMinutes(''); setManualOperatorId(''); setManualNote('')
      await loadModels(selectedOperation.id)
    } catch (err) {
      setManualError(err instanceof Error ? err.message : 'Could not save time')
    } finally {
      setSavingManual(false)
    }
  }

  const filtersActive = Boolean(lineId || teamId)
  const timedCount = opModels.filter((p) => opStats[p.id]).length

  return (
    <main className="page-wide rail-page">
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Collect</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
          Fill coverage by operation &mdash; walk to an operation, tick every model it applies to,
          then time it once and bank the run against all of them. No chassis: these are general
          coverage times, not a specific van.
        </p>
      </div>

      {/* ── Filter bar: Line + Team scope every pane below ──────────────────────────── */}
      <div className="card" style={{ padding: '14px 20px', marginBottom: 16, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
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

      {pageError && <p style={{ ...ERR_BOX, marginBottom: 16 }}>{pageError}</p>}

      {savedNotice && (
        <div style={{ ...OK_BOX, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>{savedNotice}</span>
          <button
            type="button"
            onClick={() => setSavedNotice(null)}
            aria-label="Dismiss"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 15, lineHeight: 1, color: 'inherit', flexShrink: 0 }}
          >
            &times;
          </button>
        </div>
      )}

      {/* Where a just-edited job went. A job re-staged into another team legitimately drops out
          of the list behind the drawer, so this is the only thing that says where it landed. */}
      {jobNotice && (
        <div style={{ ...OK_BOX, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>{jobNotice}</span>
          <button
            type="button"
            onClick={() => setJobNotice(null)}
            aria-label="Dismiss"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 15, lineHeight: 1, color: 'inherit', flexShrink: 0 }}
          >
            &times;
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
          // Navigation only — structural stage editing belongs to /setup, exactly as on
          // /tryouts. This screen collects times; it doesn't restructure a line.
          readOnly
          onSelect={selectStage}
          onChanged={loadStructure}
        />

        <JobsPane
          entry={activeStageEntry}
          jobs={jobsInStage}
          loading={loadingStructure}
          operationsByJob={operationsByJob}
          selectedJobId={activeJobId}
          runningJobIds={runningJobIds}
          onSelect={selectJob}
          onAdd={addJob}
          // Row ✎ and the footer's Team / Line — the same two entry points /setup offers, into
          // the same two shared components. The row's own click still selects the job.
          onEdit={openJobDrawer}
          onEditTeamLine={setJobFormJob}
        />

        <CollectOperationsPane
          job={selectedJob}
          operations={operations}
          loading={loadingStructure}
          selectedOperationId={activeOperationId}
          runningOperationIds={runningOperationIds}
          selectMode={opSelectMode}
          selectedIds={opSelection}
          mergeKeeperId={mergeKeeperId}
          mergeBusy={merging || mergePreparing}
          onSelect={setOperationId}
          onEdit={openOperationDrawer}
          onPickKeeper={setMergeKeeperId}
          onRequestMerge={requestMerge}
          onAdd={() => selectedJob && setNewOperationJob({ jobId: selectedJob.id, jobName: selectedJob.name })}
          onQuickAdd={quickAddOperation}
          onBulkAdd={bulkAddOperations}
          onToggleSelectMode={toggleOpSelectMode}
          onToggleSelected={toggleOpSelected}
          onSetAllSelected={setAllOpsSelected}
          onOpenBulkLink={openLinkDrawerForSelection}
        />

        <ModelsCoveragePane
          operation={selectedOperation}
          products={opModels}
          stats={opStats}
          loading={loadingModels}
          canLink={Boolean(modelLinkLineId)}
          onOpenLinkDrawer={openLinkDrawerForCurrent}
          selectedIds={selectedProductIds}
          gapCount={gapProductIds.length}
          timedCount={timedCount}
          sortWithinSeries={sortByGapFirst}
          onToggle={toggleModel}
          onToggleSeries={toggleSeries}
          onSelectGaps={() => setSelectedProductIds(new Set(gapProductIds))}
          onSelectAll={() => setSelectedProductIds(new Set(opModels.map((p) => p.id)))}
          onClear={() => setSelectedProductIds(new Set())}
        />
      </div>

      {/* ── Capture bar: what the next run banks against, and how to start it ───────── */}
      {selectedOperation && (
        <div className="card collect-capture">
          <div style={{ minWidth: 0, marginRight: 'auto' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{selectedOperation.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {selectedJob?.name}
              {' · '}
              {selectedCount === 0 ? 'no models selected' : `banking against ${selectedModelLabel}`}
            </div>
          </div>

          {noModelsReason ? (
            <span style={{ fontSize: 12, color: 'var(--red)', fontWeight: 600, maxWidth: 520 }}>
              {noModelsReason}
            </span>
          ) : alreadyTiming ? (
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>
              Already timing &mdash; finish it in the Running panel first.
            </span>
          ) : (
            <>
              <button type="button" className="btn-primary" onClick={requestStart}>&#9654; Start timing</button>
              <button type="button" className="btn-ghost" onClick={() => { setManualOpen(true); setManualError(null) }}>
                Enter manually
              </button>
            </>
          )}
        </div>
      )}

      {/* ── The shared running-timers rail ──────────────────────────────────────────── */}
      <TimerRail
        timers={timers}
        nowMs={nowMs}
        // Nothing here is tied to a chassis, so there is no "elsewhere" to label a card with.
        currentContextKey={null}
        onTogglePause={togglePause}
        onComplete={requestComplete}
        onDiscard={(timerId) => setCancelingTimerId(timerId)}
        onAddNote={addTimerNote}
        onRemoveNote={removeTimerNote}
      />

      {startTarget && (
        <StartTimerDialog
          operationName={startTarget.operationName}
          jobName={startTarget.jobName}
          contextLabel={selectedModelLabel}
          operators={operators}
          onStart={confirmStart}
          onCancel={() => setStartTarget(null)}
        />
      )}

      {completingTimer && (
        <CompleteTimerDialog
          timer={completingTimer}
          contextLabel={plural(completingTimer.productIds.length, 'model')}
          operators={operators}
          saving={completing}
          error={completeError}
          // Start refuses to create a timer with no models, but a timer restored from
          // localStorage is not something this screen wrote this session — refuse the save
          // rather than write a coverage time that covers nothing.
          blockedReason={completingTimer.productIds.length === 0
            ? 'This timer has no models on it, so there is nothing to bank the time against. Discard it and start again.'
            : null}
          onSave={confirmComplete}
          onCancel={() => { if (!completing) { setCompletingTimer(null); setCompleteError(null) } }}
        >
          <div>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
              Banking against
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {completingTimer.models.map((m) => (
                <span key={m.productId} className="badge badge-blue">{m.model}</span>
              ))}
            </div>
          </div>
        </CompleteTimerDialog>
      )}

      {newOperationJob && (
        <NewOperationModal
          supabase={supabase}
          jobId={newOperationJob.jobId}
          jobName={newOperationJob.jobName}
          // Nothing is auto-linked here, unlike /tryouts. Coverage collection is model-scoped
          // rather than van-scoped, so there is no one model a new operation obviously applies
          // to — it starts with an empty applies-list and Cam picks its models in the Models
          // pane, which is the same act as linking them.
          autoLinkProductId={null}
          hint={`Added to ${newOperationJob.jobName} with no models on it yet — pick the models it applies to in the Models pane, then time it. Staff it in Operator later.`}
          submitLabel="Add operation"
          busyLabel="Adding…"
          onClose={() => setNewOperationJob(null)}
          onCreated={async (createdOperationId) => {
            setNewOperationJob(null)
            // Reload the structure and select the new row in the same pass, so the drill-down
            // stays exactly where it was and the operation is live in the Models pane straight
            // away — no reload, no walking back down from the stage.
            await loadStructure()
            setOperationId(createdOperationId)
          }}
        />
      )}

      {cancelingTimerId && (
        <ConfirmDialog
          title="Discard timer"
          message={
            'Discard this timer? No time will be recorded' +
            ((timers.find((t) => t.timerId === cancelingTimerId)?.notes ?? []).length > 0
              ? `, and the ${plural((timers.find((t) => t.timerId === cancelingTimerId)?.notes ?? []).length, 'note')} written during this run will be discarded with it.`
              : '.')
          }
          confirmLabel="Discard"
          danger
          onConfirm={confirmCancelTimer}
          onCancel={() => setCancelingTimerId(null)}
        />
      )}

      {/* ── Manual entry: minutes typed in, same optional operator + note ───────────── */}
      {manualOpen && selectedOperation && (
        <ConfirmDialog
          title="Enter a time manually"
          message={
            `Record a time for “${selectedOperation.name}” against ${selectedModelLabel}, ` +
            'without running a stopwatch. Operator and note are optional.'
          }
          confirmLabel={savingManual ? 'Saving…' : 'Save'}
          cancelLabel="Cancel"
          maxWidth={560}
          onConfirm={() => { if (!savingManual) saveManual() }}
          onCancel={() => { if (!savingManual) { setManualOpen(false); setManualError(null) } }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label className="label">Minutes *</label>
              <input
                type="number" min={0} step="0.1" className="input" style={{ width: '100%' }}
                value={manualMinutes} disabled={savingManual} autoFocus
                onChange={(e) => setManualMinutes(e.target.value)}
              />
            </div>
            <div className="capture-fields">
              <div>
                <label className="label">Operator &mdash; who was timed?</label>
                <select
                  style={{ ...SEL, width: '100%', minWidth: 0 }}
                  value={manualOperatorId}
                  disabled={savingManual}
                  onChange={(e) => setManualOperatorId(e.target.value)}
                >
                  <option value="">&mdash; None &mdash;</option>
                  {operators.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
                </select>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
                  Optional. The operation&apos;s own primary operator isn&apos;t changed either way.
                </p>
              </div>
              <div>
                <label className="label">Note</label>
                <textarea
                  className="input" rows={3} style={{ width: '100%', resize: 'vertical' }}
                  placeholder="Optional — anything worth remembering about this run"
                  value={manualNote} disabled={savingManual}
                  onChange={(e) => setManualNote(e.target.value)}
                />
              </div>
            </div>
            {manualError && <p style={ERR_BOX}>{manualError}</p>}
          </div>
        </ConfirmDialog>
      )}

      {/* ── Job editor: name + stage, the shared drawer /setup opens ──────────────────── */}
      {jobDrawerOpen && jobDrawer && (
        <>
          <div className={'gaps-drawer-overlay' + (jobDrawerVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={closeJobDrawer} />
          <div className={'gaps-drawer' + (jobDrawerVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <JobEditDrawer
              job={jobDrawer}
              // Every stage on the job's OWN line, across all its teams — reassigning to
              // another team's stage is the point, so this must not be narrowed by the Team
              // filter. Falls back to the scoped line for a job whose line was never set.
              stages={sortStages(stages.filter((st) => st.production_line_id === (jobDrawer.production_line_id ?? scopeLineId)))}
              teams={allTeams}
              operationCount={(operationsByJob[jobDrawer.id] ?? []).length}
              onSave={saveJobEdit}
              onSaved={(summary) => { setJobNotice(summary); closeJobDrawer() }}
              onClose={closeJobDrawer}
            />
          </div>
        </>
      )}

      {/* ── Operation editor: name + operator assignment, the shared drawer ───────────── */}
      {opDrawerOpen && operationDrawer && selectedJob && (
        <>
          <div className={'gaps-drawer-overlay' + (opDrawerVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={closeOperationDrawer} />
          <div className={'gaps-drawer' + (opDrawerVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <OperationEditDrawer
              operation={operationDrawer}
              jobName={selectedJob.name}
              operators={operators}
              supabase={supabase}
              onSaved={loadStructure}
              onClose={closeOperationDrawer}
            />
          </div>
        </>
      )}

      {/* ── Team / Line: the shared job form, the one edit that can change the line ───── */}
      {jobFormJob && (
        <JobFormModal
          mode="edit"
          job={jobFormJob}
          defaultLineId={scopeLineId}
          defaultTeamId={teamId}
          lines={lines}
          allTeams={allTeams}
          supabase={supabase}
          onClose={() => setJobFormJob(null)}
          onSaved={loadStructure}
        />
      )}

      {/* ── Merge: the numbers come from preflightMerge, so this states what really moves ── */}
      {mergeConfirm && (
        <ConfirmDialog
          title={`Merge ${plural(mergeConfirm.dups.length, 'operation')} into "${mergeConfirm.keeper.name}"`}
          message={
            `${plural(mergeConfirm.preflight.totalTimes, 'recorded time')}` +
            (mergeConfirm.preflight.totalNotes > 0 ? ` and ${plural(mergeConfirm.preflight.totalNotes, 'note')}` : '') +
            ` move onto "${mergeConfirm.keeper.name}". Nothing is re-collected, edited or deleted — the times only change ` +
            `which operation they belong to. The ${mergeConfirm.dups.length === 1 ? 'other operation is' : 'other operations are'} ` +
            'then retired and stop appearing across the app; their model links are cleared so they stop counting towards coverage.'
          }
          confirmLabel={merging ? 'Merging…' : 'Merge'}
          danger
          onConfirm={() => { if (!merging) runMerge(mergeConfirm.keeper, mergeConfirm.dups) }}
          onCancel={() => { if (!merging) setMergeConfirm(null) }}
        >
          <div style={{ fontSize: 13, color: 'var(--text-mid)' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Retired:</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {mergeConfirm.dups.map((d) => (
                <li key={d.id}>
                  {d.name}
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' — '}{plural(mergeConfirm.preflight.timesByOperation[d.id] ?? 0, 'time')} moves
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </ConfirmDialog>
      )}

      {/* ── Bulk model-link drawer: the selected operations × the ticked models ────────── */}
      {bulkLinkOpen && selectedJob && (
        <>
          <div className={'gaps-drawer-overlay' + (bulkLinkVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={closeBulkLink} />
          <div className={'gaps-drawer' + (bulkLinkVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <BulkModelLinkDrawer
              productionLineId={modelLinkLineId}
              subjectLabel={selectedJob.name}
              operations={linkTargets}
              supabase={supabase}
              // Add only. This screen builds an applies-list forward; Replace would unlink
              // models from operations whose current links were never on screen to review.
              allowReplace={false}
              onClose={closeBulkLink}
              onApplied={async () => {
                // Applicability changed, so the coverage pane's list of what can be banked
                // against changes with it — re-read both. The coverage SELECTION is left
                // alone: it is this run's choice, not a consequence of a structural edit.
                // (Anything unlinked out from under it is pruned by the effect on opModels.)
                await loadStructure()
                refreshModels()
              }}
            />
          </div>
        </>
      )}
    </main>
  )
}

// ── Pane 3: Operations ─────────────────────────────────────────────────────────────────────
/**
 * The job's operations, as a picker with two structural actions: adding missing ones, and
 * linking a set of them to models in one go. Renaming, moving and merging stay in /setup —
 * this screen collects times, and the reason add is the exception is that a gap in the
 * operation list IS a coverage gap. Finding one mid-walk and having to leave for /setup is how
 * it ends up never recorded.
 *
 * Adding has two shapes because building a job's operation list and adding one forgotten
 * operation are different jobs:
 *   - the quick-add row is always there, takes a name and Enter, clears and keeps focus, so a
 *     list can be typed straight in without a dialog opening and closing between each one;
 *   - the paste box takes the whole list at once, one operation per line.
 * Both go through lib/operations, the same insert the modal and /setup's form use.
 *
 * Multi-select is a mode rather than a second meaning for the row click: clicking a row still
 * means "show me this operation's models", which is what the drill-down is for. In the mode,
 * ticked operations feed the shared bulk-link drawer — many operations × many models in one
 * apply, the same component /setup opens.
 *
 * The only extra a row carries is a running dot, so an operation with a stopwatch on it stays
 * recognisable while its timer sits in the rail.
 */
function CollectOperationsPane({
  job, operations, loading, selectedOperationId, runningOperationIds, selectMode, selectedIds,
  mergeKeeperId, mergeBusy,
  onSelect, onEdit, onAdd, onQuickAdd, onBulkAdd, onToggleSelectMode, onToggleSelected,
  onSetAllSelected, onOpenBulkLink, onPickKeeper, onRequestMerge,
}: {
  job: Job | null
  operations: Operation[]
  loading: boolean
  selectedOperationId: string
  runningOperationIds: Set<string>
  selectMode: boolean
  selectedIds: Set<string>
  /** Which ticked operation a merge would keep. */
  mergeKeeperId: string | null
  mergeBusy: boolean
  onSelect: (id: string) => void
  /** Opens the shared operation editor. Distinct from onSelect so the row's click can stay
   * "show me this operation's models" — selecting and editing must not collide. */
  onEdit: (op: Operation) => void
  onAdd: () => void
  /** Rejects on failure so the typed name survives to be corrected. */
  onQuickAdd: (name: string) => Promise<void>
  onBulkAdd: (text: string) => Promise<{ created: number; attempted: number; duplicatesDropped: number; error: string | null }>
  onToggleSelectMode: () => void
  onToggleSelected: (id: string) => void
  onSetAllSelected: (selected: boolean) => void
  onOpenBulkLink: () => void
  onPickKeeper: (id: string) => void
  onRequestMerge: () => void
}) {
  const [quickName, setQuickName] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const quickInputRef = useRef<HTMLInputElement>(null)
  const quickWasBusy = useRef(false)

  /**
   * Put the cursor back the moment an add finishes, so the next name can just be typed. It has
   * to happen here rather than in the submit handler: the input is disabled while the write is
   * in flight (otherwise a name typed during the save gets wiped by the clear that follows it),
   * and focusing a still-disabled element does nothing. By this effect the re-render has
   * committed and the input is live again.
   */
  useEffect(() => {
    if (quickWasBusy.current && !quickBusy) quickInputRef.current?.focus()
    quickWasBusy.current = quickBusy
  }, [quickBusy])

  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteBusy, setPasteBusy] = useState(false)
  const [pasteResult, setPasteResult] = useState<string | null>(null)

  const selectedCount = selectedIds.size
  const allSelected = operations.length > 0 && operations.every((o) => selectedIds.has(o.id))

  async function submitQuickAdd(e: React.FormEvent) {
    e.preventDefault()
    const name = quickName.trim()
    if (!name || quickBusy) return
    setQuickBusy(true); setAddError(null)
    try {
      await onQuickAdd(name)
      setQuickName('')
    } catch (err) {
      // The name stays in the box — retyping it is the last thing anyone wants after a failure.
      setAddError(err instanceof Error ? err.message : 'Could not add that operation')
    } finally {
      setQuickBusy(false)
    }
  }

  async function submitPaste() {
    if (pasteBusy) return
    setPasteBusy(true); setAddError(null); setPasteResult(null)
    try {
      const { created, attempted, duplicatesDropped, error } = await onBulkAdd(pasteText)
      if (attempted === 0) {
        setPasteResult('Nothing to add — every line was blank.')
      } else {
        const dupNote = duplicatesDropped > 0 ? `, ${duplicatesDropped} repeated line${duplicatesDropped === 1 ? '' : 's'} skipped` : ''
        setPasteResult(
          created === attempted
            ? `Added ${plural(created, 'operation')}${dupNote}.`
            : `Added ${created} of ${attempted}${dupNote}.`
        )
        if (created === attempted && !error) { setPasteText(''); setPasteOpen(false) }
      }
      if (error) setAddError(error)
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Could not add those operations')
    } finally {
      setPasteBusy(false)
    }
  }

  const subtitle = !job
    ? 'No job selected'
    : selectMode
      ? `${job.name} · ${selectedCount} of ${operations.length} selected`
      : `${job.name} · ${plural(operations.length, 'operation')}`

  return (
    <Pane
      title="Operations"
      subtitle={subtitle}
      active={selectMode ? selectedCount > 0 : Boolean(selectedOperationId)}
      footer={
        job ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            {addError && (
              <p style={{ ...ERR_BOX, fontSize: 12, padding: '7px 10px', margin: 0 }}>{addError}</p>
            )}

            {selectMode ? (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button" className="btn-primary" style={{ padding: '6px 11px', fontSize: 12 }}
                    disabled={selectedCount === 0 || mergeBusy} onClick={onOpenBulkLink}
                  >
                    Link models to selected ({selectedCount})
                  </button>
                  <button
                    type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }}
                    disabled={operations.length === 0 || mergeBusy} onClick={() => onSetAllSelected(!allSelected)}
                  >
                    {allSelected ? 'Clear all' : 'Select all'}
                  </button>
                  <button
                    type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }}
                    disabled={mergeBusy} onClick={onToggleSelectMode}
                  >
                    Done
                  </button>
                </div>

                {/* Merge only makes sense from two operations up — below that there is nothing
                    to fold into anything, so the whole block stays out of the way. */}
                {selectedCount >= 2 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
                      Merge duplicates — keep
                    </span>
                    <select
                      className="select"
                      style={{ fontSize: 12, padding: '5px 8px', width: '100%' }}
                      value={mergeKeeperId ?? ''}
                      disabled={mergeBusy}
                      onChange={(e) => onPickKeeper(e.target.value)}
                    >
                      {operations.filter((o) => selectedIds.has(o.id)).map((o) => (
                        <option key={o.id} value={o.id}>{o.name}</option>
                      ))}
                    </select>
                    <button
                      type="button" className="btn-ghost"
                      style={{ padding: '6px 11px', fontSize: 12, color: 'var(--red)', alignSelf: 'flex-start' }}
                      disabled={mergeBusy || !mergeKeeperId} onClick={onRequestMerge}
                    >
                      {mergeBusy ? 'Working…' : `Merge selected (${selectedCount})`}
                    </button>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      The other {plural(selectedCount - 1, 'operation')} hand their recorded times and
                      notes to the keeper, then retire.
                    </span>
                  </div>
                )}

                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {selectedCount === 0
                    ? 'Tick operations to link models to all of them at once, or to merge duplicates together.'
                    : `${plural(selectedCount, 'operation')} selected.`}
                </span>
              </>
            ) : (
              <>
                {/* Always visible: a name and Enter, no dialog. */}
                <form onSubmit={submitQuickAdd} style={{ display: 'flex', gap: 6, width: '100%' }}>
                  <input
                    ref={quickInputRef}
                    className="input"
                    placeholder="Add operation — type a name, press Enter"
                    style={{ fontSize: 12, padding: '5px 8px', flex: 1, minWidth: 0 }}
                    value={quickName}
                    disabled={quickBusy}
                    onChange={(e) => { setQuickName(e.target.value); setAddError(null) }}
                  />
                  <button
                    type="submit" className="btn-primary" style={{ padding: '6px 11px', fontSize: 12 }}
                    disabled={quickBusy || !quickName.trim()}
                  >
                    {quickBusy ? '…' : 'Add'}
                  </button>
                </form>

                {pasteOpen ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <textarea
                      autoFocus
                      className="input"
                      rows={6}
                      placeholder={'One operation per line, e.g.\nFit roof hatch\nSeal roof hatch\nTest for leaks'}
                      style={{ fontSize: 12, padding: '6px 8px', width: '100%', resize: 'vertical' }}
                      value={pasteText}
                      disabled={pasteBusy}
                      onChange={(e) => { setPasteText(e.target.value); setPasteResult(null); setAddError(null) }}
                    />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button" className="btn-primary" style={{ padding: '6px 11px', fontSize: 12 }}
                        disabled={pasteBusy || !pasteText.trim()} onClick={submitPaste}
                      >
                        {pasteBusy ? 'Adding…' : `Add ${plural(parseOperationNames(pasteText).names.length, 'operation')}`}
                      </button>
                      <button
                        type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }}
                        disabled={pasteBusy} onClick={() => { setPasteOpen(false); setPasteText(''); setPasteResult(null) }}
                      >
                        Cancel
                      </button>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      Blank lines are skipped, and a name repeated in the paste is only added once.
                      They all land under {job.name} with no models on them yet.
                    </span>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => { setPasteOpen(true); setAddError(null) }}>
                      Add several
                    </button>
                    <button type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={onAdd}>
                      Add with details
                    </button>
                    <button
                      type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }}
                      disabled={operations.length === 0} onClick={onToggleSelectMode}
                    >
                      Link models in bulk
                    </button>
                  </div>
                )}

                {pasteResult && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{pasteResult}</span>
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
        <p className="finder-pane-empty">Loading&hellip;</p>
      ) : operations.length === 0 ? (
        <p className="finder-pane-empty">No operations under {job.name} yet — type one in below.</p>
      ) : (
        operations.map((op) => {
          const isTicked = selectedIds.has(op.id)
          return (
            <div
              key={op.id}
              className={'finder-row' + ((selectMode ? isTicked : op.id === selectedOperationId) ? ' finder-row-selected' : '')}
              role="button"
              tabIndex={0}
              onClick={() => (selectMode ? onToggleSelected(op.id) : onSelect(op.id))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (selectMode) onToggleSelected(op.id)
                  else onSelect(op.id)
                }
              }}
            >
              <span className="finder-row-main">
                {selectMode && (
                  <input
                    type="checkbox"
                    checked={isTicked}
                    onChange={() => onToggleSelected(op.id)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ width: 14, height: 14, accentColor: 'var(--blue)', flexShrink: 0, cursor: 'pointer' }}
                  />
                )}
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                  <span className="finder-row-name">
                    {op.name}
                    {runningOperationIds.has(op.id) && (
                      <span className="finder-running-dot" title="A timer is running on this operation" />
                    )}
                  </span>
                </span>
              </span>
              <span className="finder-row-actions">
                {!selectMode && (
                  <>
                    <RenameButton title="Edit operation" onClick={() => onEdit(op)} />
                    <span className="finder-chevron">&rsaquo;</span>
                  </>
                )}
              </span>
            </div>
          )
        })
      )}
    </Pane>
  )
}

// ── Pane 4: Models — coverage ──────────────────────────────────────────────────────────────
/**
 * WHAT THIS RUN COUNTS FOR — and nothing else.
 *
 * Every model the selected operation applies to (its model_operations rows), each showing
 * whether that exact (operation, model) pair has ever been timed: green with its average and
 * run count, or a red "gap". Untimed models float to the top of each series, because the gaps
 * are the work.
 *
 * Ticking here is NOT a structural act. It writes nothing — no link, no unlink, no row of any
 * kind — and stays in memory until a time is saved, at which point recordOperationTime banks
 * that time against exactly the ticked models. Nothing is ticked by default, because a
 * coverage time silently banked against a set nobody chose is worse than no time at all, and
 * the capture bar refuses to save until at least one is.
 *
 * WHICH models the operation applies to is a different question with a different answer: the
 * Link models drawer, which writes model_operations for the operations ticked in pane 3. This
 * pane can only ever offer what that has already established — coverage of a model an
 * operation isn't done on is not a thing. The two never show a checkbox list at the same time:
 * with nothing linked there is nothing to bank a run against, so this pane shows no rows at
 * all and hands over to the drawer instead of pretending to be it.
 *
 * "Link models…" sits at the top of this pane in both states — with models linked and without
 * — because that is the same question either way ("what is this operation done on?"), and an
 * entry point that only appears when the list is empty is one nobody finds the second time.
 * It opens the drawer scoped to this one operation and adds links; it never reaches the ticks.
 */
function ModelsCoveragePane({
  operation, products, stats, loading, selectedIds, gapCount, timedCount, sortWithinSeries,
  canLink, onOpenLinkDrawer, onToggle, onToggleSeries, onSelectGaps, onSelectAll, onClear,
}: {
  operation: Operation | null
  products: Product[]
  stats: Record<string, OperationTimeStat>
  loading: boolean
  selectedIds: Set<string>
  gapCount: number
  timedCount: number
  sortWithinSeries: (a: Product, b: Product) => number
  /** False when no production line resolves for the operation's job — there is nothing to link
   * it to, so the empty state explains that instead of offering the drawer. */
  canLink: boolean
  /** Opens the Link models drawer on the operation being timed. This pane performs no link
   * writes itself; it only points at the surface that does. */
  onOpenLinkDrawer: () => void
  onToggle: (product: Product, isSelected: boolean) => void
  onToggleSeries: (series: string, seriesProducts: Product[], allSelected: boolean) => void
  onSelectGaps: () => void
  onSelectAll: () => void
  onClear: () => void
}) {
  const hasModels = products.length > 0
  const subtitle = !operation
    ? 'No operation selected'
    : !hasModels
      ? 'Not linked to any models'
      : `${timedCount} of ${plural(products.length, 'model')} timed · ${gapCount} gap${gapCount === 1 ? '' : 's'}`

  return (
    <Pane
      title="Models &mdash; coverage"
      subtitle={subtitle}
      active={selectedIds.size > 0}
      footer={
        operation && hasModels ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} disabled={gapCount === 0} onClick={onSelectGaps}>
                Select {gapCount} gap{gapCount === 1 ? '' : 's'}
              </button>
              <button type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={onSelectAll}>Select all</button>
              <button type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} disabled={selectedIds.size === 0} onClick={onClear}>Clear</button>
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {selectedIds.size === 0
                ? 'Nothing ticked — this timing can\u2019t be saved until at least one model is.'
                : `This timing will count for ${plural(selectedIds.size, 'model')}.`}
            </span>
          </div>
        ) : undefined
      }
    >
      {!operation ? (
        <p className="finder-pane-empty">Select an operation to see the models it applies to.</p>
      ) : loading ? (
        <p className="finder-pane-empty">Loading&hellip;</p>
      ) : !hasModels ? (
        // No rows, deliberately: there is nothing to bank a run against, and showing the
        // structural picker here is what made this pane and the drawer look like two versions
        // of one list. Hand over instead.
        <div style={{ padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 12, color: 'var(--text-mid)', margin: 0, lineHeight: 1.55 }}>
            <strong>{operation.name}</strong> isn&rsquo;t linked to any models yet, so there&rsquo;s no
            coverage to record against it.
          </p>
          {canLink ? (
            <>
              <button
                type="button"
                className="btn-primary"
                style={{ padding: '6px 11px', fontSize: 12, alignSelf: 'flex-start' }}
                onClick={onOpenLinkDrawer}
              >
                Link models&hellip;
              </button>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                That opens the Link models panel, where you say which models this operation is
                done on. They appear here afterwards, ready to tick and time.
              </p>
            </>
          ) : (
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
              This operation&rsquo;s job isn&rsquo;t on a production line, so there are no models to link
              it to. Set the job&rsquo;s line under Team / Line first.
            </p>
          )}
        </div>
      ) : (
        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* The way into applicability, in the same place whether or not anything is linked
              yet — an operation that turns out to be done on one more model is found just as
              often mid-collection as at the start. Same drawer, same single-operation scope as
              the empty state's prompt; it adds links, and never touches the ticks below. */}
          {canLink && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                This timing counts for
              </span>
              <button
                type="button"
                className="btn-ghost"
                style={{ padding: '5px 10px', fontSize: 11 }}
                title={`Add more models to what ${operation.name} applies to`}
                onClick={onOpenLinkDrawer}
              >
                Link models&hellip;
              </button>
            </div>
          )}

          {/* Says what a tick means, right above the ticks — the pane and the drawer both show
              model checkboxes, and this is the line that tells them apart. */}
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
            Tick the models this timing counts for. This doesn&rsquo;t change what {operation.name}{' '}
            applies to &mdash; that&rsquo;s the Link models panel.
          </p>
          <ModelSeriesPicker
            products={products}
            selectedIds={selectedIds}
            sortWithinSeries={sortWithinSeries}
            onToggle={onToggle}
            onToggleSeries={onToggleSeries}
            renderRowStatus={(p) => {
              const stat = stats[p.id]
              return stat ? (
                <span className="badge badge-green" title={`${stat.runs} recorded run${stat.runs === 1 ? '' : 's'}`}>
                  {fmtMinutes(stat.avg)}m &middot; {stat.runs}
                </span>
              ) : (
                <span className="badge badge-red" title="No time has ever been recorded for this operation on this model">gap</span>
              )
            }}
          />
        </div>
      )}
    </Pane>
  )
}
