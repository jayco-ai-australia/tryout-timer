'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { selectIn } from '@/lib/chunkedIn'
import ConfirmDialog from '@/components/ConfirmDialog'
import NewOperationModal from '@/components/NewOperationModal'
import ManualTimesDialog, { type ManualTimeEntry } from '@/components/ManualTimesDialog'
import { ModelSeriesPicker } from '@/components/ModelLinker'
import BankingAgainstList from '@/components/BankingAgainstList'
import BulkModelLinkDrawer, { DRAWER_WIDTH, useSlideOverDrawer } from '@/components/BulkModelLinkDrawer'
import JobEditDrawer from '@/components/JobEditDrawer'
import JobFormModal from '@/components/JobFormModal'
import OperationEditDrawer from '@/components/OperationEditDrawer'
import {
  JobsPane, Pane, RenameButton, SectionsPane, UNSECTIONED_KEY, plural, type SectionEntry,
} from '@/components/FinderPanes'
import {
  MergeConfirm, MergeFooter, MergeNotices, MergeRowItem, useMergeMode,
  type MergeModeState, type MergeRow,
} from '@/components/MergeMode'
import {
  CompleteTimerDialog, StartTimerDialog, TimerRail,
  type CompleteTimerResult, type StartTimerChoice,
} from '@/components/TimerRail'
import {
  addOperationTimeNote, currentForOperation, historyLabel, operationProductKey, recordOperationTime,
  type OperationTimeStat,
} from '@/lib/operationTimes'
import { fetchLinksForOperations } from '@/lib/modelOperations'
import { saveTimerRun, useStopwatches, type ActiveTimer } from '@/lib/stopwatch'
import { findSectionTray, setJobSection, sortSections, teamForJob } from '@/lib/sections'
import { createOperation, createOperations, parseOperationNames } from '@/lib/operations'
import { fmtMinutes } from '@/lib/format'
import { usePersistedFilter } from '@/lib/useLocalStorage'
import {
  fetchOperators, operatorsForLine, type OperatorOption,
} from '@/lib/operators'
import type { Job, Operation, Product, ProductionLine, Section, Team } from '@/lib/types'

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
 * Team → Section → Job → Operation — so the walk to an operation is the same walk everywhere in
 * the app, and then a Models pane that shows exactly where the gaps are.
 *
 * ── Reuse ─────────────────────────────────────────────────────────────────────────────────
 * Nothing here is a fork. The panes are components/FinderPanes (the section column mounted
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
  team_id: string | null; production_line_id: string | null; section_id: string | null; created_at: string
  teams: RawTeamRef | RawTeamRef[] | null
}


/** Which operation a Start is pointing at, with its labels — so the dialog can name it without
 * re-deriving it from the panes. */
interface TimerTarget { operationId: string; operationName: string; jobName: string }

export default function CollectClient({ lines, userId }: Props) {
  const supabase = useMemo(() => createClient(), [])

  // ── Filters + drill position, persisted like /setup's so a refresh comes back here ────
  const [lineId, setLineId] = usePersistedFilter('jmotion_collect_line')
  const [teamId, setTeamId] = usePersistedFilter('jmotion_collect_team')
  const [sectionKey, setSectionKey] = usePersistedFilter('jmotion_collect_section')
  const [jobId, setJobId] = usePersistedFilter('jmotion_collect_job')
  const [operationId, setOperationId] = usePersistedFilter('jmotion_collect_operation')

  const [allTeams, setAllTeams] = useState<Team[]>([])
  const [sections, setSections] = useState<Section[]>([])
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
    timers, nowMs, start: startStopwatch, togglePause, restart: restartTimer, discard: discardTimer,
    addNote: addTimerNote, removeNote: removeTimerNote,
  } = useStopwatches(TIMERS_KEY)
  const [startTarget, setStartTarget] = useState<TimerTarget | null>(null)
  const [completingTimer, setCompletingTimer] = useState<ActiveTimer | null>(null)
  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState<string | null>(null)
  const [cancelingTimerId, setCancelingTimerId] = useState<string | null>(null)

  // ── Manual entry ─────────────────────────────────────────────────────────────────────
  /**
   * The operations the manual dialog is writing for, captured when it opens rather than read
   * live — the same rule the bulk-link drawer follows. Ticking a fifth operation behind an open
   * dialog must not add a row nobody typed a time into, and unticking one must not remove a row
   * they already filled in.
   *
   * null = closed. A non-empty array is the whole selection, not the first of it: this used to
   * be one operation and the rest of the tick list was silently dropped.
   */
  const [manualTargets, setManualTargets] = useState<Operation[] | null>(null)
  /**
   * Per ticked operation, the ticked models IT applies to — what each row will actually be saved
   * against. Read from model_operations when the dialog opens, because the ticked models came
   * from the DRILLED-INTO operation's applies-list, not each ticked operation's: banking every
   * row against that one list is how operation B got times against operation A's models.
   */
  const [manualModels, setManualModels] = useState<Record<string, Product[]> | null>(null)
  const [openingManual, setOpeningManual] = useState(false)
  const [savingManual, setSavingManual] = useState(false)
  const [manualError, setManualError] = useState<string | null>(null)

  /** The confirmation that gaps just closed — dismissible, since the green rows say it too. */
  const [savedNotice, setSavedNotice] = useState<string | null>(null)

  /** The job a new operation is being added under, or null when the dialog is closed. Always
   * the selected job — this pane only ever adds into the job it is showing. */
  const [newOperationJob, setNewOperationJob] = useState<{ jobId: string; jobName: string } | null>(null)

  // ── Editing structure: the same drawers /setup opens ─────────────────────────────────
  /** The job open in the shared edit drawer (name + section), or null. */
  const [jobDrawer, setJobDrawer] = useState<Job | null>(null)
  /** The job open in the shared Line form, or null. Separate from the drawer above
   * because a line change unsections the job, which is a different question. */
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


  // ── Reference data ───────────────────────────────────────────────────────────────────
  /** The line's walk order. Its own function rather than an inline fetch because adding a section
   * from pane 1 has to put it on screen immediately — the same reload /setup runs after a
   * section write. */
  const reloadSections = useCallback(async () => {
    // Retired sections (merged away — see lib/sections' mergeSections) never appear in a list,
    // a pane or a picker. Every section dropdown on this screen reads `sections`, so this one
    // filter covers them all.
    const { data } = await supabase.from('sections').select('*').eq('is_active', true).order('sort_order')
    setSections(sortSections((data ?? []) as Section[]))
  }, [supabase])

  useEffect(() => {
    supabase.from('teams').select('*').order('name').then(({ data }) => setAllTeams((data ?? []) as Team[]))
    reloadSections()
    // Every active operator with the line each belongs to; the pickers are handed the
    // line-scoped `lineOperators` below, never this.
    fetchOperators(supabase).then(setOperators).catch(() => setOperators([]))
  }, [supabase, reloadSections])

  /** Sections belong to exactly one line, so a team filter with no line chosen still resolves to
   * that team's line — otherwise picking a team would silently switch section grouping off. */
  const scopeLineId = useMemo(() => {
    if (lineId) return lineId
    if (teamId) return allTeams.find((t) => t.id === teamId)?.production_line_id ?? ''
    return ''
  }, [lineId, teamId, allTeams])

  // ── Structure: jobs in scope, then their active operations ───────────────────────────
  const loadStructure = useCallback(async () => {
    setLoadingStructure(true)
    setPageError(null)

    // Keyed on the LINE, not the team: a job's team is derived from its section (see
    // teamForJob) and jobs.team_id can lag behind a section move, so filtering the query by it
    // would drop jobs that belong to the chosen team by every rule the walk uses. The team
    // narrowing happens client-side, over `scopedJobs` below. The team_id fallback only covers
    // the first render, before allTeams has arrived and scopeLineId can resolve the team's line.
    // Retired jobs (merged away — see lib/jobs' mergeJobs) never appear in a pane, a list or a
    // picker, exactly as retired sections and operations don't.
    let q = supabase.from('jobs').select('*, teams ( id, name )').eq('is_active', true).order('name')
    if (scopeLineId) q = q.eq('production_line_id', scopeLineId)
    else if (teamId) q = q.eq('team_id', teamId)
    const { data: jobRows, error: jobsError } = await q
    if (jobsError) { setPageError(jobsError.message); setLoadingStructure(false); return }

    const loadedJobs: Job[] = ((jobRows ?? []) as unknown as RawJob[]).map((r) => ({
      id: r.id, name: r.name, primary_operator_id: r.primary_operator_id,
      team_id: r.team_id, production_line_id: r.production_line_id, section_id: r.section_id,
      created_at: r.created_at, teams: one(r.teams),
    }))
    setJobs(loadedJobs)

    const jobIds = loadedJobs.map((j) => j.id)
    if (jobIds.length === 0) { setOperationsByJob({}); setLoadingStructure(false); return }

    // Chunked (lib/chunkedIn): jobIds is every job in the selected section(s), unbounded.
    // is_active and the name ordering both stay inside the callback. Chunking splits the JOB
    // list, and every operation for a given job therefore lands in exactly one chunk — so the
    // per-job name ordering the grouping below relies on survives intact, even though the
    // concatenation across chunks is not globally sorted. Nothing reads opRows flat.
    let opRows: Operation[]
    try {
      opRows = await selectIn<Operation>(jobIds, (chunk) => supabase
        .from('operations').select('*').in('job_id', chunk).eq('is_active', true).order('name'))
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Could not load operations'); setLoadingStructure(false); return
    }

    const grouped: Record<string, Operation[]> = {}
    for (const op of opRows) (grouped[op.job_id] ??= []).push(op)
    setOperationsByJob(grouped)
    setLoadingStructure(false)
  }, [supabase, scopeLineId, teamId])

  useEffect(() => { loadStructure() }, [loadStructure])

  // ── Scope, mirroring /setup exactly ──────────────────────────────────────────────────
  const teamOptions = lineId ? allTeams.filter((t) => t.production_line_id === lineId) : allTeams

  const scopeLineName = lines.find((l) => l.id === scopeLineId)?.name ?? null

  /**
   * The only operator list this screen offers — the scoped line's, resolved exactly like the
   * panes' scope (an explicit line, or the line the chosen team belongs to). With no line in
   * scope at all there is nothing to narrow by, so every operator is offered.
   */
  const lineOperators = useMemo(
    () => operatorsForLine(operators, scopeLineId),
    [operators, scopeLineId]
  )
  const scopeTeams = useMemo(
    () => allTeams.filter((t) => t.production_line_id === scopeLineId),
    [allTeams, scopeLineId]
  )

  /**
   * The scoped line's sections, in walk order — narrowed by the Team filter, because a section
   * belongs to exactly one team and a job's team now comes FROM its section. Choosing a team is
   * choosing that team's part of the walk.
   */
  const sectionOptions = useMemo(() => {
    if (!scopeLineId) return []
    const onLine = sections.filter((s) => s.production_line_id === scopeLineId)
    return sortSections(teamId ? onLine.filter((s) => s.team_id === teamId) : onLine)
  }, [sections, scopeLineId, teamId])

  /** Every loaded section by id — the lookup teamForJob reads a job's team through. Built from
   * ALL sections: a job's team is a property of the section it points at, in view or not. */
  /** Team names for the derived job-team the panes show. */
  const teamNameById = useMemo(() => new Map(allTeams.map((t) => [t.id, t.name])), [allTeams])

  const sectionsById = useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections])

  /** The jobs the panes work over, with the Team filter applied to the team DERIVED from each
   * job's section — so it agrees with the section list above rather than with jobs.team_id. */
  const scopedJobs = useMemo(
    () => (teamId ? jobs.filter((j) => teamForJob(j, sectionsById) === teamId) : jobs),
    [jobs, teamId, sectionsById]
  )

  /** The unsorted tray jobs fall back to: the scoped TEAM's tray on the scoped line. There is
   * one tray per team now, so with no team filtered the line has several and none of them is
   * "the line's" — findSectionTray returns null and the stray jobs land in the virtual bucket
   * below, which is where work belonging to no team in view belongs. */
  const noSectionTray = useMemo(
    () => findSectionTray(sections, scopeLineId, teamId),
    [sections, scopeLineId, teamId]
  )

  /**
   * Jobs bucketed by the pane-1 row they belong under: their own section when it is in view,
   * otherwise the line's unsorted tray. UNSECTIONED_KEY is the last resort only — no line in
   * scope, or a line whose tray row is missing.
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

  /** The line's sections in walk order, plus "Unsectioned" whenever it holds anything. A line with
   * no sections at all (Caravan, Motor Home) gets Unsectioned as its single entry — every job lives
   * there, and no empty section scaffolding is invented. */
  const sectionEntries = useMemo<SectionEntry[]>(() => {
    const entries: SectionEntry[] = sectionOptions.map((s) => ({
      key: s.id, name: s.name, section: s, jobCount: (jobsBySectionKey.get(s.id) ?? []).length,
    }))
    // Only where a real tray can't stand in — see /setup, which builds this list the same way.
    const strayCount = (jobsBySectionKey.get(UNSECTIONED_KEY) ?? []).length
    if (strayCount > 0 || (sectionOptions.length === 0 && !teamId)) {
      entries.push({
        key: UNSECTIONED_KEY,
        name: scopeLineId ? 'No section' : 'All jobs',
        section: null,
        jobCount: strayCount,
      })
    }
    return entries
  }, [sectionOptions, jobsBySectionKey, scopeLineId, teamId])

  // A persisted id can outlive the scope it was chosen in; fall back to "nothing selected"
  // rather than writing over the stored value.
  const activeSectionKey = sectionEntries.some((e) => e.key === sectionKey) ? sectionKey : ''
  const activeSectionEntry = sectionEntries.find((e) => e.key === activeSectionKey) ?? null

  const jobsInSection = useMemo(
    () => (activeSectionKey ? jobsBySectionKey.get(activeSectionKey) ?? [] : []),
    [activeSectionKey, jobsBySectionKey]
  )
  const activeJobId = jobsInSection.some((j) => j.id === jobId) ? jobId : ''
  const selectedJob = jobsInSection.find((j) => j.id === activeJobId) ?? null

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

      const [productRows, { data: timeRows, error: timesError }] = await Promise.all([
        // Chunked (lib/chunkedIn): an operation on a big line applies to hundreds of models.
        // Re-sorted below rather than trusting the query — see the note there.
        selectIn<Product>(productIds, (chunk) => supabase.from('products').select('*').in('id', chunk).order('model')),
        // Unfiltered by superseded_by ON PURPOSE: the badge below states how much history sits
        // behind the figure, and currentForOperation counts that from the rows it is handed. It
        // picks the current record itself — the query's job is to select the column, not to
        // pre-decide the answer.
        supabase.from('operation_times').select('id, operation_id, total_minutes, superseded_by, created_at').eq('operation_id', opId),
      ])
      if (timesError) throw new Error(timesError.message)

      const times = timeRows ?? []
      // Chunked (lib/chunkedIn): one operation accumulates a run per model per re-measure, so
      // this id list grows with history rather than being bounded by anything.
      const timeModels = await selectIn<{ operation_time_id: string; product_id: string }>(
        times.map((t) => t.id),
        (chunk) => supabase.from('operation_time_models')
          .select('operation_time_id, product_id').in('operation_time_id', chunk)
      )

      // currentForOperation keys by "operationId:productId"; this pane is scoped to one
      // operation, so remap down to plain product ids for the row lookup.
      const pairStats = currentForOperation(times, timeModels)
      const stats: Record<string, OperationTimeStat> = {}
      for (const id of productIds) {
        const stat = pairStats[operationProductKey(opId, id)]
        if (stat) stats[id] = stat
      }

      // Sorted here, NOT left to the query: each chunk comes back model-ordered on its own,
      // but selectIn concatenates chunks in chunk order, so the join of several sorted runs is
      // only sorted within each run. This list is rendered in array order.
      setOpModels([...productRows].sort((a, b) => a.model.localeCompare(b.model)))
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
    // The dialog banks against the models ticked when it opened; those have just been cleared,
    // so what it would write no longer exists. Closing it is the honest move.
    setManualTargets(null)
    setManualModels(null)
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
    selectedJob?.production_line_id || activeSectionEntry?.section?.production_line_id || scopeLineId || null

  /** Re-read the applies-list and its coverage after the linker writes, so a model linked here
   * appears in the list below it — with its gap/timed status — without a screen change. */
  const refreshModels = useCallback(() => {
    if (activeOperationId) loadModels(activeOperationId)
  }, [activeOperationId, loadModels])

  // ── Drill actions ────────────────────────────────────────────────────────────────────
  /** Pane 1's write hook — sections, then the jobs bucketed under them, exactly as /setup does
   * after a section change. */
  async function afterSectionChange() {
    await reloadSections()
    await loadStructure()
  }

  function selectSection(key: string) { setSectionKey(key); setJobId(''); setOperationId('') }
  function selectJob(id: string) { setJobId(id); setOperationId('') }

  /**
   * Add a job under the selected section — the same insert /setup's addJob performs, field for
   * field, so a job created here is indistinguishable from one created there.
   *
   * The section comes off activeSectionEntry.section, falling back to the line's unsorted tray
   * so a job added under the virtual bucket still gets a real section_id — the UNSECTIONED_KEY
   * sentinel never reaches the database, and neither does a null where a tray exists. The team
   * comes from that section and nowhere else; the tray has none, which is correct for a job
   * nobody has sorted yet.
   *
   * The inserted row is read back (.select('id').single()) so a constraint or RLS rejection
   * shows as a message instead of a list that quietly doesn't change.
   */
  async function addJob(name: string) {
    const trimmed = name.trim()
    if (!trimmed || !activeSectionEntry) return
    setPageError(null)
    const section = activeSectionEntry.section ?? noSectionTray
    const { data, error } = await supabase.from('jobs').insert({
      name: trimmed,
      production_line_id: scopeLineId || null,
      // The SECTION owns the team — the same rule setJobSection enforces on a move.
      team_id: section?.team_id ?? null,
      section_id: section?.id ?? null,
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
  }

  function setAllOpsSelected(selected: boolean) {
    setOpSelection(selected ? new Set(operations.map((o) => o.id)) : new Set())
  }

  /** Only operations still in the job count. One retired or moved away under the selection
   * must not be written to — the same guard /setup's bulk mode applies. */
  const selectedOperations = useMemo(
    () => operations.filter((o) => opSelection.has(o.id)),
    [operations, opSelection]
  )

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
    onMerged: async () => { await loadStructure() },
  })

  // A selection belongs to the job it was made in; changing jobs (or leaving the mode) drops it.
  useEffect(() => {
    setOpSelection(new Set())
    opMerge.cancel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId])

  // ── Editing jobs and operations ──────────────────────────────────────────────────────
  /**
   * The single save path behind the job drawer: rename, then re-section — /setup's saveJobEdit,
   * field for field. The re-section goes through sections.ts' setJobSection, so the job's team and
   * line follow the target section rather than being written here.
   *
   * Deliberately does NOT follow the job to its new section. Once it moves to another team's
   * section the current Line/Team filter may legitimately exclude it, and chasing it would mean
   * silently rewriting the filter the user set. It drops out of the list, and the summary the
   * drawer returns is what says where it went.
   */
  async function saveJobEdit(job: Job, name: string, section: Section | null): Promise<void> {
    setPageError(null)
    const trimmed = name.trim()
    if (trimmed && trimmed !== job.name) {
      const { error } = await supabase.from('jobs').update({ name: trimmed }).eq('id', job.id)
      if (error) throw new Error(error.message)
    }
    if ((section?.id ?? null) !== (job.section_id ?? null)) {
      await setJobSection(supabase, job.id, section)
    }
    const { data } = await supabase.from('sections').select('*').eq('is_active', true).order('sort_order')
    setSections(sortSections((data ?? []) as Section[]))
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
    setSectionKey(''); setJobId(''); setOperationId('')
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
      const recorded = await saveTimerRun(supabase, timer, {
        userId,
        operatorId: result.operatorId,
        notes: result.notes,
        note: result.note,
        atMs: result.atMs,
      })
      discardTimer(timer.timerId)
      setCompletingTimer(null)
      // The models were snapshotted at Start; one unlinked while the clock ran is refused at
      // save and named here, rather than counted in "banked against N".
      const refusedNames = recorded.refusedProductIds.map(
        (id) => timer.models.find((m) => m.productId === id)?.model ?? 'a model'
      )
      setSavedNotice(
        `“${timer.operationName}” banked against ${plural(recorded.savedProductIds.length, 'model')}.`
        + (refusedNames.length > 0
          ? ` Skipped, no time saved: ${refusedNames.join(', ')} — the operation no longer applies to `
            + `${refusedNames.length === 1 ? 'it' : 'them'}.`
          : '')
      )
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

  // ── Manual entry: the same writes, for runs nobody stopwatched ───────────────────────
  /**
   * Open the dialog on whatever the collector actually picked. A tick list wins over the
   * drilled-down row — ticking four operations and pressing this used to write ONE time and
   * drop the other three without a word.
   */
  async function openManualEntry() {
    if (noModelsReason || openingManual) return
    const targets = selectedOperations.length > 0
      ? selectedOperations
      : selectedOperation ? [selectedOperation] : []
    if (targets.length === 0) return
    setManualError(null)
    setOpeningManual(true)
    try {
      // Each ticked operation's OWN applies-list, intersected with the ticked models. The same
      // question recordOperationTime's guard asks at save — asked here so the dialog can show the
      // answer before anyone types, instead of refusing afterwards.
      const links = await fetchLinksForOperations(supabase, targets.map((o) => o.id))
      const appliesTo = new Map<string, Set<string>>()
      for (const l of links) {
        const set = appliesTo.get(l.operation_id)
        if (set) set.add(l.product_id)
        else appliesTo.set(l.operation_id, new Set([l.product_id]))
      }
      const chosen = opModels.filter((p) => selectedProductIds.has(p.id))
      const perOp: Record<string, Product[]> = {}
      for (const op of targets) {
        const applies = appliesTo.get(op.id) ?? new Set<string>()
        perOp[op.id] = chosen.filter((p) => applies.has(p.id))
      }
      setManualModels(perOp)
      setManualTargets(targets)
    } catch (err) {
      setPageError(
        `Could not check which models the ticked operations apply to, so manual entry wasn’t opened: `
        + (err instanceof Error ? err.message : 'the read failed')
      )
    } finally {
      setOpeningManual(false)
    }
  }

  /**
   * One operation_time per filled row, each banked against every model ticked on this screen.
   * Straight through recordOperationTime and addOperationTimeNote — the same two functions the
   * stopwatch path ends in, so a manual time is indistinguishable from a timed one afterwards
   * apart from having no started_at. chassis_id stays null: nothing on /collect is about a
   * particular van (see the note at the top of this file).
   *
   * Written one row at a time and COUNTED as it goes. There is no transaction available from a
   * browser, so a refusal half way through leaves earlier rows written — and the only honest
   * thing to do then is say exactly how many landed rather than report a clean failure over
   * times that are already in the database.
   */
  async function saveManualTimes(entries: ManualTimeEntry[]) {
    if (!manualTargets || !manualModels || noModelsReason) return
    setSavingManual(true); setManualError(null)

    let recorded = 0
    let minutesRecorded = 0
    const modelsBanked = new Set<string>()
    const refusals: string[] = []
    try {
      for (const entry of entries) {
        // Each row against the models ITS operation applies to — never the whole tick list. The
        // dialog doesn't let a row with none be filled in, so an empty list here is skipped.
        const models = manualModels[entry.operationId] ?? []
        if (models.length === 0) continue
        const { created, savedProductIds, refusedProductIds } = await recordOperationTime(supabase, {
          operationId: entry.operationId,
          productIds: models.map((p) => p.id),
          // Blank → null → recorded against the placeholder operator, since
          // operation_times.operator_id is NOT NULL.
          operatorId: entry.operatorId || null,
          collectedBy: userId,
          totalMinutes: entry.minutes,
          chassisId: null,
        })
        for (const id of savedProductIds) modelsBanked.add(id)
        if (refusedProductIds.length > 0) {
          refusals.push(
            `${entry.operationName} (not ${refusedProductIds.map((id) => models.find((p) => p.id === id)?.model ?? 'a model').join(', ')})`
          )
        }
        if (entry.note) await addOperationTimeNote(supabase, created.id, entry.note, userId)
        recorded++
        minutesRecorded += entry.minutes
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'the write was rejected'
      setManualError(
        recorded === 0
          ? `Nothing was recorded: ${detail}`
          : `${plural(recorded, 'time')} of ${entries.length} were recorded before this failed: ${detail}. ` +
            'Clear the rows that saved before trying again — re-saving them would double them up.'
      )
      setSavingManual(false)
      // The coverage pane still has to catch up with whatever DID land.
      if (activeOperationId) await loadModels(activeOperationId)
      return
    }

    setSavingManual(false)
    setManualTargets(null)
    setManualModels(null)
    // Never a silent close — the whole point of the dialog is that more than one thing happened.
    setSavedNotice(
      `Recorded ${plural(recorded, 'time')} across ${plural(modelsBanked.size, 'model')} — ` +
      `${Number(minutesRecorded.toFixed(2))} minutes.` +
      (refusals.length > 0
        ? ` Some models were skipped because the operation stopped applying to them before the save: ${refusals.join('; ')}.`
        : '')
    )
    if (activeOperationId) await loadModels(activeOperationId)
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
          onChange={(e) => { setLineId(e.target.value); setTeamId(''); setSectionKey(''); setJobId(''); setOperationId('') }}
        >
          <option value="">All production lines</option>
          {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select
          style={SEL}
          value={teamId}
          onChange={(e) => { setTeamId(e.target.value); setSectionKey(''); setJobId(''); setOperationId('') }}
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

      {/* Where a just-edited job went. A job re-sectioned into another team legitimately drops out
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
        <SectionsPane
          supabase={supabase}
          entries={sectionEntries}
          sections={sectionOptions}
          productionLineId={scopeLineId}
          productionLineName={scopeLineName}
          teams={scopeTeams}
          selectedKey={activeSectionKey}
          // Navigation, plus create — the same mount /tryouts uses. Rename/reorder/delete stay
          // on /setup (this screen collects times; it doesn't restructure a line), but adding
          // only ever appends a section to the end of the walk, and coverage collection regularly
          // reaches a step the line doesn't have yet. Leaving for /setup to add it and coming
          // back breaks the add section → add job → operations → link → time flow.
          readOnly
          allowAdd
          // Merge, on top of readOnly, for the same reason: two sections that should be one is
          // something you notice while filling coverage, and it folds jobs within one team
          // rather than restructuring the walk. Same dialog and same lib as /setup and /tryouts.
          allowMerge
          // The team is already answered by the filter bar above, so the add form doesn't ask
          // again — only "All teams" leaves it with nothing to inherit.
          defaultTeamId={teamId}
          onSelect={selectSection}
          onChanged={afterSectionChange}
        />

        <JobsPane
          supabase={supabase}
          userId={userId}
          onChanged={loadStructure}
          sectionsById={sectionsById}
          teamNameById={teamNameById}
          entry={activeSectionEntry}
          jobs={jobsInSection}
          loading={loadingStructure}
          operationsByJob={operationsByJob}
          selectedJobId={activeJobId}
          runningJobIds={runningJobIds}
          onSelect={selectJob}
          onAdd={addJob}
          // Row ✎ and the footer's Line — the same two entry points /setup offers, into
          // the same two shared components. The row's own click still selects the job.
          onEdit={openJobDrawer}
          onEditLine={setJobFormJob}
        />

        <CollectOperationsPane
          job={selectedJob}
          operations={operations}
          loading={loadingStructure}
          selectedOperationId={activeOperationId}
          runningOperationIds={runningOperationIds}
          selectMode={opSelectMode}
          selectedIds={opSelection}
          merge={opMerge}
          mergeRows={opMergeRows}
          onSelect={setOperationId}
          onEdit={openOperationDrawer}
          onAdd={() => selectedJob && setNewOperationJob({ jobId: selectedJob.id, jobName: selectedJob.name })}
          onQuickAdd={quickAddOperation}
          onBulkAdd={bulkAddOperations}
          onToggleSelectMode={toggleOpSelectMode}
          onToggleSelected={toggleOpSelected}
          onSetAllSelected={setAllOpsSelected}
          onOpenBulkLink={openLinkDrawerForSelection}
          onOpenManualTimes={openManualEntry}
          manualBlockedReason={noModelsReason}
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
              {/* Honours the tick list when there is one — the same dialog, one row per ticked
                  operation. Pressing this with four ticked used to write only this row's time. */}
              <button type="button" className="btn-ghost" onClick={openManualEntry}>
                {selectedOperations.length > 0
                  ? `Enter times manually (${selectedOperations.length})`
                  : 'Enter manually'}
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
        onRestart={restartTimer}
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
          operators={lineOperators}
          onStart={confirmStart}
          onCancel={() => setStartTarget(null)}
        />
      )}

      {completingTimer && (
        <CompleteTimerDialog
          timer={completingTimer}
          contextLabel={plural(completingTimer.productIds.length, 'model')}
          operators={lineOperators}
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
          <BankingAgainstList models={completingTimer.models} />
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
            // away — no reload, no walking back down from the section.
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

      {/* ── Manual entry: a row per selected operation, times typed in ─────────────── */}
      {manualTargets && (
        <ManualTimesDialog
          operations={manualTargets}
          modelCount={selectedCount}
          modelsByOperation={manualModels ?? {}}
          operators={lineOperators}
          saving={savingManual}
          error={manualError}
          onSave={saveManualTimes}
          onCancel={() => { setManualTargets(null); setManualModels(null); setManualError(null) }}
        />
      )}

      {/* ── Job editor: name + section, the shared drawer /setup opens ──────────────────── */}
      {jobDrawerOpen && jobDrawer && (
        <>
          <div className={'gaps-drawer-overlay' + (jobDrawerVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={closeJobDrawer} />
          <div className={'gaps-drawer' + (jobDrawerVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <JobEditDrawer
              job={jobDrawer}
              // Every section on the job's OWN line, across all its teams — reassigning to
              // another team's section is the point, so this must not be narrowed by the Team
              // filter. Falls back to the scoped line for a job whose line was never set.
              sections={sortSections(sections.filter((st) => st.production_line_id === (jobDrawer.production_line_id ?? scopeLineId)))}
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
              operators={lineOperators}
              supabase={supabase}
              onSaved={loadStructure}
              onClose={closeOperationDrawer}
            />
          </div>
        </>
      )}

      {/* ── Line: the shared job form, the one edit that can change the line ───── */}
      {jobFormJob && (
        <JobFormModal
          mode="edit"
          job={jobFormJob}
          defaultLineId={scopeLineId}
          lines={lines}
          sections={sections}
          supabase={supabase}
          onClose={() => setJobFormJob(null)}
          onSaved={loadStructure}
        />
      )}

      {/* The operation-merge confirmation — the same component the Sections and Jobs panes use,
        * fed by a preflight that has already run. See components/MergeMode. */}
      <MergeConfirm merge={opMerge} />

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
 * ticked operations feed two bulk actions: the shared link drawer — many operations × many
 * models in one apply, the same component /setup opens — and manual time entry, which opens one
 * row per ticked operation rather than writing a time for one of them and dropping the rest.
 *
 * The only extra a row carries is a running dot, so an operation with a stopwatch on it stays
 * recognisable while its timer sits in the rail.
 */
function CollectOperationsPane({
  job, operations, loading, selectedOperationId, runningOperationIds, selectMode, selectedIds,
  merge, mergeRows,
  onSelect, onEdit, onAdd, onQuickAdd, onBulkAdd, onToggleSelectMode, onToggleSelected,
  onSetAllSelected, onOpenBulkLink, onOpenManualTimes, manualBlockedReason,
}: {
  job: Job | null
  operations: Operation[]
  loading: boolean
  selectedOperationId: string
  runningOperationIds: Set<string>
  selectMode: boolean
  selectedIds: Set<string>
  /** The shared merge flow, owned by the screen so it survives this pane's re-renders. */
  merge: MergeModeState
  mergeRows: MergeRow<Operation>[]
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
  /** Opens the manual-times dialog on the ticked operations — one row each. */
  onOpenManualTimes: () => void
  /** Why manual entry can't run yet (no models ticked), or null. Shown on the disabled button
   * rather than hidden: the fix is one pane to the right, and a button that vanishes sends
   * people looking for a feature that is in front of them. */
  manualBlockedReason: string | null
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
    : merge.active
      ? `${job.name} · ${merge.subtitle}`
      : selectMode
        ? `${job.name} · ${selectedCount} of ${operations.length} selected`
        : `${job.name} · ${plural(operations.length, 'operation')}`

  return (
    <Pane
      title="Operations"
      subtitle={subtitle}
      active={merge.active ? merge.count > 0 : selectMode ? selectedCount > 0 : Boolean(selectedOperationId)}
      footer={
        job ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            {addError && (
              <p style={{ ...ERR_BOX, fontSize: 12, padding: '7px 10px', margin: 0 }}>{addError}</p>
            )}

            {merge.active ? <MergeFooter merge={merge} /> : selectMode ? (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button" className="btn-primary" style={{ padding: '6px 11px', fontSize: 12 }}
                    disabled={selectedCount === 0} onClick={onOpenBulkLink}
                  >
                    Link models to selected ({selectedCount})
                  </button>
                  <button
                    type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }}
                    disabled={selectedCount === 0 || Boolean(manualBlockedReason)}
                    title={manualBlockedReason ?? 'One row per ticked operation — minutes, operator and note'}
                    onClick={onOpenManualTimes}
                  >
                    Enter times manually ({selectedCount})
                  </button>
                  <button
                    type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }}
                    disabled={operations.length === 0} onClick={() => onSetAllSelected(!allSelected)}
                  >
                    {allSelected ? 'Clear all' : 'Select all'}
                  </button>
                  <button
                    type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }}
                    onClick={onToggleSelectMode}
                  >
                    Done
                  </button>
                </div>

                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {selectedCount === 0
                    ? 'Tick operations to link models to all of them at once.'
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
                    {/* The one merge affordance, in the one place it lives on every pane. */}
                    <MergeFooter merge={merge} />
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
      <MergeNotices merge={merge} />

      {!job ? (
        <p className="finder-pane-empty">Select a job.</p>
      ) : loading ? (
        <p className="finder-pane-empty">Loading&hellip;</p>
      ) : merge.active ? (
        mergeRows.map((row) => <MergeRowItem key={row.id} merge={merge} row={row} />)
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
              it to. Set the job&rsquo;s line under Line first.
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
                <span className="badge badge-green" title={`Current time for this model — ${historyLabel(stat)}`}>
                  {fmtMinutes(stat.minutes)}m{stat.archived > 0 && <> &middot; +{stat.archived}</>}
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
