'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'
import NewOperationModal from '@/components/NewOperationModal'
import { NoteThread } from '@/components/ModelLinker'
import {
  JobsPane, Pane, RenameButton, ROW_INPUT, RunningDot, StagesPane, UNSTAGED_KEY, plural,
  type StageEntry,
} from '@/components/FinderPanes'
import {
  fetchOperationIdsForModel, fetchTimedOperationIdsForModel, jobsApplying,
  linkOperationToModel, linkOperationsToModels, unlinkOperationFromModel,
  unlinkOperationsFromModels,
} from '@/lib/modelOperations'
import {
  addOperationTimeNote, averageByOperation, deleteOperationTime, fetchOperationTimeNotes,
  recordOperationTime, updateOperationTimeMinutes, type OperationTimeStat,
} from '@/lib/operationTimes'
import {
  elapsedSecondsNow, saveTimerRun, useStopwatches, type ActiveTimer,
} from '@/lib/stopwatch'
import {
  CompleteTimerDialog, StartTimerDialog, TimerRail, type CompleteTimerResult, type StartTimerChoice,
} from '@/components/TimerRail'
import { fmtClock, fmtDate, fmtMinutes } from '@/lib/format'
import { operationProductKey } from '@/lib/operationTimes'
import { sortStages } from '@/lib/stages'
import { mergeOperations, strandedMergeMessage } from '@/lib/mergeOperations'
import { usePersistedFilter } from '@/lib/useLocalStorage'
import type { Job, Operation, OperationTimeNote, Stage, Team } from '@/lib/types'

/**
 * Try Outs — the "follow one van down the line" capture flow.
 *
 * Everything past the landing list is scoped to a single chassis: a tryout *is* the set of
 * operation_times carrying that chassis_id. The van's chassis fixes the production line (via
 * chassis → product → production_line_id), and inside that line the screen is the same
 * Finder-style drill-down /setup uses — Team filter, then Stages → Jobs → Operations, the
 * literal same pane components from components/FinderPanes for the first two columns (mounted
 * read-only for stages, and with the job applies-toggle turned on), Unstaged bucket and all.
 *
 * ── Model applicability ──────────────────────────────────────────────────────────────────
 * Stored in exactly one place, model_operations (operation ↔ product), and nowhere else:
 *   - an OPERATION applies to this van's model iff a model_operations row exists for the pair;
 *   - a JOB applies iff at least one of its operations does — derived, never stored, so the two
 *     can't fall out of step (there is no job→model link and there must not be one);
 *   - a STAGE is line-level structure and is never model-scoped at all. Every stage on the line
 *     always shows, whatever the model. The Stages pane here is navigation plus create: a new
 *     stage is appended to the line (never to the model), while rename, reorder and delete —
 *     the operations that can disturb a walk other vans are mid-way through — stay on /setup.
 *
 * It is operated at the JOB grain, because that's the unit a van actually differs by: the job
 * toggle in pane 2 writes every operation under it in one bulk call. The per-operation toggle
 * in pane 3 is the fine-grained override for "everything in this job applies except that one".
 * Both go through lib/modelOperations, the same helpers /setup's bulk drawer and ModelLinker
 * use, so the guard — an operation with recorded times for this model can never be un-applied,
 * it demonstrably applies — is enforced identically everywhere.
 *
 * By default the panes show what applies; the "Show what doesn't apply" toggle reveals the rest
 * so it can be switched back on.
 *
 * ── The Operations column ────────────────────────────────────────────────────────────────
 * /setup's Operations pane is about structure; here each operation row carries the three things
 * a team leader walking a van needs at once:
 *   1. whether the operation applies to THIS van's model, with the toggle described above;
 *   2. the times already recorded on THIS van (not the operation's all-time average across
 *      every van, which is what /dashboard and /model-total show);
 *   3. a fixed-height capture slot holding Start, or elapsed + Pause/Resume + Complete once a
 *      stopwatch is on it. Nothing in the row changes height between those states.
 *
 * There is no fourth "Running now" pane. Timers can run concurrently across different jobs and
 * stages, and a pane would only ever show the ones under the current selection — so every
 * running or paused timer ALSO lives in the fixed rail down the right-hand quarter of the
 * screen, where any of them can be paused or completed without navigating back to its
 * operation. The rail and the row are two views of one timer: their Complete buttons call the
 * same handler and open the same operator + notes confirmation. The drill-down panes carry a running dot on the stage/job/operation a timer
 * belongs to so the rail and the columns agree about where the work is.
 *
 * The stopwatches themselves are lib/stopwatch — the same module /collect's Active Timers run
 * on (shared timer state, pause accumulation, localStorage persistence for refresh recovery,
 * and one save path through recordOperationTime/addOperationTimeNote), so the two screens can't
 * drift into different ideas of what "elapsed" means.
 *
 * The operator is optional here and asked for only at completion ("who was timed?"), because on
 * a tryout the person on the van changes station to station and often isn't the point of the
 * measurement. operation_times.operator_id is NOT NULL in the database, so a blank one is
 * recorded against the shared placeholder operator — see recordOperationTime.
 */

interface Props { userId: string }

type SupabaseClient = ReturnType<typeof createClient>

const SEL: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
  border: '1.5px solid var(--border)', borderRadius: 8, padding: '7px 10px',
  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', outline: 'none', width: '100%',
}
const EMPTY: React.CSSProperties = { textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '40px 0' }
const ERR_BOX: React.CSSProperties = { padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13 }
/** Same slide-in pattern as /setup's drawers (.gaps-drawer is hard-coded to
 * 25vw for the dashboard's gap drawer — overridden here, narrower than /setup's since this
 * panel only holds three fields). */
const DRAWER_WIDTH: React.CSSProperties = { width: '33.333vw', minWidth: 340 }
const JOB_LABEL: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'var(--text-muted)', marginBottom: 8,
}

/** localStorage key for the running stopwatches. Deliberately not per-van: a timer left running
 * on one van must not become invisible (and un-completable) because somebody opened another. */
const TIMERS_KEY = 'jmotion_tryout_timers'


function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

// ── Raw query shapes (relations come back object-or-array from PostgREST) ────────────────
interface RawProductRef { id: string; product_code: string; model: string; production_line_id: string | null }
interface RawChassisRow {
  id: string; chassisnumber: string; product_id: string | null
  products: RawProductRef | RawProductRef[] | null
}
interface RawTeamRef { id: string; name: string }
interface RawJob {
  id: string; name: string; primary_operator_id: string | null
  team_id: string | null; production_line_id: string | null; stage_id: string | null; created_at: string
  teams: RawTeamRef | RawTeamRef[] | null
}
interface RawOperatorRef { id: string; full_name: string }
interface RawOperation {
  id: string; name: string; job_id: string
  primary_operator_id: string | null; secondary_operator_id: string | null; created_at: string
  primary_operator: RawOperatorRef | RawOperatorRef[] | null
  secondary_operator: RawOperatorRef | RawOperatorRef[] | null
}

// ── View models ──────────────────────────────────────────────────────────────────────────
/** The one van the whole screen is scoped to once a tryout is open. */
interface VanContext {
  chassisId: string
  chassisNumber: string
  productId: string | null
  productCode: string | null
  model: string | null
  productionLineId: string | null
  productionLineName: string | null
  /** The tryouts row this van was opened from — null only in the moment before one is created.
   * Carries `is_active` so the van view can offer Close / Reopen. */
  tryoutId?: string | null
  tryoutActive?: boolean
}

interface TryoutCard {
  tryoutId: string
  isActive: boolean
  chassisId: string
  chassisNumber: string
  model: string | null
  productCode: string | null
  productionLineName: string | null
  timesCollected: number
  /** null when the van is listed because its model is scoped but nothing has been timed on it
   * yet — the card shows "not yet timed" rather than a date. */
  lastCollectedAt: string | null
  van: VanContext
}

interface VanTime {
  id: string
  operationId: string
  totalMinutes: number | null
  createdAt: string
  operatorName: string | null
}

interface OperatorOption { id: string; full_name: string }

/** Which operation a drawer is pointing at. Carries its labels rather than looking them up
 * from the panes, so an operation created inline can be worked on immediately without waiting
 * for the reload that puts it into the columns. */
interface CaptureTarget { operationId: string; operationName: string; jobName: string }

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.75 }}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

/**
 * Makes sure a chassis has an open tryouts row, and returns it. chassis_id is unique, so
 * starting a tryout for a van that already has one must not error — an existing row is
 * reactivated instead.
 *
 * Deliberately a read-then-write rather than a blind upsert on chassis_id: an upsert would
 * overwrite started_by/started_at with whoever re-opened it, losing who actually started the
 * tryout and when. The unique constraint is still respected — a row lost to a race (two people
 * starting the same van at once) comes back as a duplicate-key error, which is caught and
 * resolved by reading the winner's row and reactivating that.
 */
async function ensureTryout(
  supabase: SupabaseClient,
  chassisId: string,
  userId: string
): Promise<{ id: string; is_active: boolean }> {
  const { data: existing, error: findError } = await supabase
    .from('tryouts')
    .select('id, is_active')
    .eq('chassis_id', chassisId)
    .maybeSingle()
  if (findError) throw new Error(findError.message)

  if (existing) {
    if (existing.is_active) return { id: existing.id, is_active: true }
    const { data: reopened, error: reopenError } = await supabase
      .from('tryouts')
      .update({ is_active: true })
      .eq('id', existing.id)
      .select('id, is_active')
    if (reopenError) throw new Error(reopenError.message)
    if (!reopened || reopened.length === 0) throw new Error('That tryout could not be re-opened.')
    return { id: reopened[0].id, is_active: true }
  }

  const { data: created, error: insertError } = await supabase
    .from('tryouts')
    .insert({ chassis_id: chassisId, started_by: userId })
    .select('id, is_active')
    .single()
  if (!insertError && created) return { id: created.id, is_active: created.is_active }

  // 23505 = someone else inserted the same chassis between the read and the write.
  if (insertError?.code === '23505') {
    const { data: raced } = await supabase.from('tryouts').select('id, is_active').eq('chassis_id', chassisId).maybeSingle()
    if (raced) {
      if (raced.is_active) return { id: raced.id, is_active: true }
      await supabase.from('tryouts').update({ is_active: true }).eq('id', raced.id)
      return { id: raced.id, is_active: true }
    }
  }
  throw new Error(insertError?.message ?? 'Could not start the tryout')
}

/** Chassis row (+ its product, + that product's line name) → the context every other query on
 * this screen is scoped by. Shared by the landing list and the "start new tryout" lookup so a
 * van opened either way resolves its model/line identically. */
async function buildVanContext(
  supabase: SupabaseClient,
  row: RawChassisRow,
  lineNameById: Map<string, string>
): Promise<VanContext> {
  const product = one(row.products)
  const lineId = product?.production_line_id ?? null
  let lineName = lineId ? lineNameById.get(lineId) ?? null : null

  if (lineId && !lineName) {
    const { data } = await supabase.from('production_lines').select('name').eq('id', lineId).single()
    lineName = data?.name ?? null
    if (lineName) lineNameById.set(lineId, lineName)
  }

  return {
    chassisId: row.id,
    chassisNumber: row.chassisnumber,
    productId: product?.id ?? null,
    productCode: product?.product_code ?? null,
    model: product?.model ?? null,
    productionLineId: lineId,
    productionLineName: lineName,
  }
}

export default function TryOutsClient({ userId }: Props) {
  const supabase = useMemo(() => createClient(), [])

  const [van, setVan] = useState<VanContext | null>(null)

  // ── Landing ──────────────────────────────────────────────────────────────────────────
  const [cards, setCards] = useState<TryoutCard[]>([])
  const [loadingCards, setLoadingCards] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [startModalOpen, setStartModalOpen] = useState(false)
  const [noModelVan, setNoModelVan] = useState<VanContext | null>(null)
  const [showClosed, setShowClosed] = useState(false)
  const [closeTarget, setCloseTarget] = useState<TryoutCard | null>(null)
  const [tryoutBusy, setTryoutBusy] = useState(false)

  // ── Van view: the line's structure, and this van's times over it ──────────────────────
  const [stages, setStages] = useState<Stage[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [operationsByJob, setOperationsByJob] = useState<Record<string, Operation[]>>({})
  const [lineTeams, setLineTeams] = useState<Team[]>([])
  const [vanTimes, setVanTimes] = useState<VanTime[]>([])
  const [loadingVan, setLoadingVan] = useState(false)
  const [vanError, setVanError] = useState<string | null>(null)
  const [operators, setOperators] = useState<OperatorOption[]>([])
  const [newOperationJob, setNewOperationJob] = useState<{ jobId: string; jobName: string } | null>(null)

  // ── Drill position — persisted, exactly like /setup's, so a refresh comes back to the
  // same operation. The production line is NOT a filter here: the van's chassis fixes it. ──
  const [teamId, setTeamId] = usePersistedFilter('jmotion_tryout_team')
  const [stageKey, setStageKey] = usePersistedFilter('jmotion_tryout_stage')
  const [jobId, setJobId] = usePersistedFilter('jmotion_tryout_job')
  const [operationId, setOperationId] = usePersistedFilter('jmotion_tryout_operation')

  // ── Model applicability (model_operations) ───────────────────────────────────────────
  /** Operation ids that apply to this van's model. Empty = nothing applies yet, and every
   * operation on the line is shown so there's a way in. */
  const [modelOpIds, setModelOpIds] = useState<Set<string>>(new Set())
  /** Operations with at least one recorded time for this model, on ANY van of it — a timed
   * operation demonstrably applies, so it can't be un-applied. null means the lookup failed and
   * un-applying stays blocked rather than running unguarded. */
  const [timedForModelOpIds, setTimedForModelOpIds] = useState<Set<string> | null>(new Set())
  const [showUnallocated, setShowUnallocated] = useState(false)
  const [scopeConfirm, setScopeConfirm] = useState<{ count: number } | null>(null)
  const [removeTarget, setRemoveTarget] = useState<Operation | null>(null)
  const [blockedRemove, setBlockedRemove] = useState<string | null>(null)
  const [scopeBusy, setScopeBusy] = useState<string | null>(null)
  const [scopeError, setScopeError] = useState<string | null>(null)
  /** The job whose applies-toggle is writing right now, the pending "switch this job off"
   * confirmation, and the "what just happened" line under the filter bar. */
  const [jobApplyBusyId, setJobApplyBusyId] = useState<string | null>(null)
  const [unapplyJobTarget, setUnapplyJob] = useState<{ job: Job; unlinkCount: number; keptCount: number } | null>(null)
  const [jobApplyNotice, setJobApplyNotice] = useState<string | null>(null)

  // ── Merge mode (pane 3, one job at a time — same routine /setup runs) ─────────────────
  const [opMode, setOpMode] = useState<'normal' | 'merge'>('normal')
  const [mergeSelected, setMergeSelected] = useState<Set<string>>(new Set())
  const [mergeKeeperId, setMergeKeeperId] = useState<string | null>(null)
  const [mergeConfirm, setMergeConfirm] = useState<{ keeper: Operation; dups: Operation[] } | null>(null)
  const [merging, setMerging] = useState(false)

  // ── Stopwatches: the shared module, one persisted list across every van ───────────────
  const {
    timers, nowMs, start: startStopwatch, togglePause, discard: discardTimer,
    addNote: addTimerNote, removeNote: removeTimerNote,
  } = useStopwatches(TIMERS_KEY)
  /** The Start confirmation — operator and an opening note, both optional, asked BEFORE the
   * clock begins. Holds labels rather than the Operation/Job rows so an operation created
   * inline can be started from here without waiting for the reload that puts it in the panes. */
  const [startTarget, setStartTarget] = useState<CaptureTarget | null>(null)
  const [completingTimer, setCompletingTimer] = useState<ActiveTimer | null>(null)
  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState<string | null>(null)
  const [cancelingTimerId, setCancelingTimerId] = useState<string | null>(null)

  // ── Manual entry / time detail drawers ───────────────────────────────────────────────
  const [capture, setCapture] = useState<CaptureTarget | null>(null)
  const [captureVisible, setCaptureVisible] = useState(false)
  const [timeDetail, setTimeDetail] = useState<CaptureTarget | null>(null)
  const [timeDetailVisible, setTimeDetailVisible] = useState(false)

  /**
   * ── Landing: one card per tryouts row ───────────────────────────────────────────────
   *
   * The tryouts table is the source of truth — a van is a tryout because somebody explicitly
   * started one, not because it happens to have times or because its model was scoped. That
   * earlier inference is gone on purpose: scoping is per MODEL, so "show vans whose model is
   * scoped" surfaced every chassis of that model (scope RM.19-1.JV-MY26 and both EF0233 and
   * EF0234 appeared). An explicit row is per chassis, which is what the list always meant.
   *
   * Times are still shown per card, but they no longer decide membership — a brand-new tryout
   * with nothing recorded on it yet is a normal, expected card.
   */
  const loadCards = useCallback(async () => {
    setLoadingCards(true)
    setListError(null)

    // Both active and closed come back in one fetch; the "Show closed" toggle then filters
    // client-side, so flipping it doesn't cost a round trip.
    const { data: tryoutRows, error: tryoutsError } = await supabase
      .from('tryouts')
      .select('id, chassis_id, started_at, is_active')
      .order('started_at', { ascending: false })
    if (tryoutsError) { setListError(tryoutsError.message); setLoadingCards(false); return }

    const tryouts = (tryoutRows ?? []) as { id: string; chassis_id: string; started_at: string | null; is_active: boolean }[]
    if (tryouts.length === 0) { setCards([]); setLoadingCards(false); return }

    const chassisIds = [...new Set(tryouts.map((t) => t.chassis_id))]

    const [chassisResult, timesResult] = await Promise.all([
      supabase
        .from('chassis')
        .select('id, chassisnumber, product_id, products ( id, product_code, model, production_line_id )')
        .in('id', chassisIds),
      // Scoped to the listed chassis rather than every time in the table — the count is a
      // per-card detail now, not the thing that builds the list.
      supabase.from('operation_times').select('chassis_id, created_at').in('chassis_id', chassisIds),
    ])
    if (chassisResult.error) { setListError(chassisResult.error.message); setLoadingCards(false); return }
    if (timesResult.error) { setListError(timesResult.error.message); setLoadingCards(false); return }

    const agg = new Map<string, { count: number; last: string }>()
    for (const t of (timesResult.data ?? []) as { chassis_id: string; created_at: string }[]) {
      const cur = agg.get(t.chassis_id)
      if (!cur) agg.set(t.chassis_id, { count: 1, last: t.created_at })
      else { cur.count += 1; if (t.created_at > cur.last) cur.last = t.created_at }
    }

    const chassisById = new Map<string, RawChassisRow>()
    for (const row of (chassisResult.data ?? []) as unknown as RawChassisRow[]) chassisById.set(row.id, row)

    // One lookup for every line the listed vans resolve to, rather than one per card.
    const lineIds = [...new Set([...chassisById.values()].map((r) => one(r.products)?.production_line_id).filter((id): id is string => !!id))]
    const lineNameById = new Map<string, string>()
    if (lineIds.length > 0) {
      const { data: lineRows } = await supabase.from('production_lines').select('id, name').in('id', lineIds)
      for (const l of lineRows ?? []) lineNameById.set(l.id, l.name)
    }

    const next: TryoutCard[] = []
    for (const tryout of tryouts) {
      const row = chassisById.get(tryout.chassis_id)
      // A tryout whose chassis no longer resolves (deleted, or hidden by RLS) is skipped rather
      // than rendered as a card with no identity.
      if (!row) continue
      const stat = agg.get(row.id)
      const context = await buildVanContext(supabase, row, lineNameById)
      next.push({
        tryoutId: tryout.id,
        isActive: tryout.is_active,
        chassisId: row.id,
        chassisNumber: row.chassisnumber,
        model: context.model,
        productCode: context.productCode,
        productionLineName: context.productionLineName,
        timesCollected: stat?.count ?? 0,
        lastCollectedAt: stat?.last ?? null,
        van: { ...context, tryoutId: tryout.id, tryoutActive: tryout.is_active },
      })
    }
    // Active first, then most-recently-collected, then never-timed by chassis number — the work
    // in progress stays at the top whichever way the list is filtered.
    next.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
      if (a.lastCollectedAt && b.lastCollectedAt) return b.lastCollectedAt.localeCompare(a.lastCollectedAt)
      if (a.lastCollectedAt) return -1
      if (b.lastCollectedAt) return 1
      return a.chassisNumber.localeCompare(b.chassisNumber)
    })

    setCards(next)
    setLoadingCards(false)
  }, [supabase])

  useEffect(() => { if (!van) loadCards() }, [supabase, van, loadCards])

  /**
   * Deep link: /tryouts?chassisId=<uuid> opens straight into that van, creating or re-opening
   * its tryouts row on the way — the same ensureTryout path the "Start new tryout" modal uses,
   * so a van reached from /dashboard's focus panel is indistinguishable from one started here.
   *
   * Read from window.location rather than useSearchParams: this is a one-shot handoff, and
   * useSearchParams would drag a Suspense boundary into a screen that has no other need for one.
   * The parameter is stripped once consumed, so "← All tryouts" doesn't bounce straight back in.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const chassisId = params.get('chassisId')
    if (!chassisId) return
    window.history.replaceState({}, '', window.location.pathname)

    let cancelled = false
    async function openFromLink(id: string) {
      const { data, error } = await supabase
        .from('chassis')
        .select('id, chassisnumber, product_id, products ( id, product_code, model, production_line_id )')
        .eq('id', id)
        .maybeSingle()
      if (cancelled) return
      if (error || !data) {
        setListError(error?.message ?? 'That van could not be found.')
        return
      }
      const context = await buildVanContext(supabase, data as unknown as RawChassisRow, new Map())
      if (cancelled) return
      // Same guard openTryout applies: with no model resolved there is nothing to link a time to.
      if (!context.productId) { setNoModelVan(context); return }
      try {
        const tryout = await ensureTryout(supabase, context.chassisId, userId)
        if (!cancelled) setVan({ ...context, tryoutId: tryout.id, tryoutActive: tryout.is_active })
      } catch (err) {
        if (!cancelled) setListError(err instanceof Error ? err.message : 'Could not open that tryout')
      }
    }
    openFromLink(chassisId)
    return () => { cancelled = true }
  }, [supabase, userId])

  // Every active operator, not scoped to the van's team/line — a tryout regularly catches
  // whoever is actually on the van that day. Matches /setup's convention.
  useEffect(() => {
    supabase.from('operators').select('id, full_name').eq('is_active', true).order('full_name')
      .then(({ data }) => setOperators((data ?? []) as OperatorOption[]))
  }, [supabase])

  // ── Van view loader ──────────────────────────────────────────────────────────────────
  /**
   * Everything the columns and the on-van figures are built from, in one pass: this van's own
   * times, its model's applies-list (plus which of those operations are already timed, the
   * guard on un-applying one), and the line's Stage → Job → Operation structure.
   *
   * The structure query is /setup's, narrowed to the van's line: stages for the line, jobs on
   * the line OR attached to one of its stages (the stage link is the stronger signal for a
   * walk), then that job set's active operations. The Team filter is applied client-side over
   * the loaded jobs, so switching teams doesn't cost a round trip.
   */
  const loadVan = useCallback(async (context: VanContext) => {
    setLoadingVan(true)
    setVanError(null)

    // The van's own times come first — they're keyed by chassis alone, so they load (and the
    // count stays truthful) even when the line structure below turns up empty.
    const { data: timeRows, error: timesError } = await supabase
      .from('operation_times')
      .select('id, operation_id, operator_id, total_minutes, created_at')
      .eq('chassis_id', context.chassisId)
      .order('created_at', { ascending: false })
    if (timesError) { setVanError(timesError.message); setLoadingVan(false); return }
    const times = (timeRows ?? []) as { id: string; operation_id: string; operator_id: string | null; total_minutes: number | null; created_at: string }[]

    const operatorIds = [...new Set(times.map((t) => t.operator_id).filter((id): id is string => !!id))]
    const operatorNameById = new Map<string, string>()
    if (operatorIds.length > 0) {
      const { data: opRows } = await supabase.from('operators').select('id, full_name').in('id', operatorIds)
      for (const o of opRows ?? []) operatorNameById.set(o.id, o.full_name)
    }

    setVanTimes(times.map((t) => ({
      id: t.id,
      operationId: t.operation_id,
      totalMinutes: t.total_minutes,
      createdAt: t.created_at,
      operatorName: t.operator_id ? operatorNameById.get(t.operator_id) ?? null : null,
    })))

    // ── The applies-list for this van's model, and which of its operations are already timed
    // (the guard on un-applying one). Both go through lib/modelOperations, keyed by product_id
    // alone — "applies to this model" means every van of it, so a line/team/is_active filter
    // here would quietly under-report. A null timed-set means the lookup failed, and un-applying
    // stays blocked rather than running unguarded. ──
    let linkedOpIds = new Set<string>()
    let timedOpIds: Set<string> | null = new Set<string>()
    if (context.productId) {
      try {
        linkedOpIds = await fetchOperationIdsForModel(supabase, context.productId)
      } catch (err) {
        setVanError(err instanceof Error ? err.message : 'Could not load this model\u2019s applies-list')
        setLoadingVan(false)
        return
      }
      timedOpIds = await fetchTimedOperationIdsForModel(supabase, context.productId)
    }
    setModelOpIds(linkedOpIds)
    setTimedForModelOpIds(timedOpIds)

    if (!context.productionLineId) {
      setStages([]); setJobs([]); setOperationsByJob({}); setLineTeams([])
      setLoadingVan(false)
      return
    }

    const { data: teamRows } = await supabase
      .from('teams').select('*').eq('production_line_id', context.productionLineId).order('name')
    setLineTeams((teamRows ?? []) as Team[])

    const { data: stageRows, error: stagesError } = await supabase
      .from('stages')
      .select('*')
      .eq('production_line_id', context.productionLineId)
      .order('sort_order')
    if (stagesError) { setVanError(stagesError.message); setLoadingVan(false); return }
    const loadedStages = sortStages((stageRows ?? []) as Stage[])
    setStages(loadedStages)

    // Jobs on this line, plus any job attached to one of this line's stages even if its own
    // production_line_id was never filled in — the stage link is the stronger signal for a walk.
    const stageIds = loadedStages.map((s) => s.id)
    let jobQuery = supabase.from('jobs').select('*, teams ( id, name )').order('name')
    jobQuery = stageIds.length > 0
      ? jobQuery.or(`production_line_id.eq.${context.productionLineId},stage_id.in.(${stageIds.join(',')})`)
      : jobQuery.eq('production_line_id', context.productionLineId)
    const { data: jobRows, error: jobsError } = await jobQuery
    if (jobsError) { setVanError(jobsError.message); setLoadingVan(false); return }

    const loadedJobs: Job[] = ((jobRows ?? []) as unknown as RawJob[]).map((r) => ({
      id: r.id, name: r.name, primary_operator_id: r.primary_operator_id,
      team_id: r.team_id, production_line_id: r.production_line_id, stage_id: r.stage_id,
      created_at: r.created_at,
      teams: one(r.teams),
    }))
    setJobs(loadedJobs)

    const jobIds = loadedJobs.map((j) => j.id)
    if (jobIds.length === 0) { setOperationsByJob({}); setLoadingVan(false); return }

    const { data: opRows, error: opsError } = await supabase
      .from('operations')
      .select('*, primary_operator:primary_operator_id ( id, full_name ), secondary_operator:secondary_operator_id ( id, full_name )')
      .in('job_id', jobIds)
      .eq('is_active', true)
      .order('name')
    if (opsError) { setVanError(opsError.message); setLoadingVan(false); return }

    const grouped: Record<string, Operation[]> = {}
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
    setOperationsByJob(grouped)
    setLoadingVan(false)
  }, [supabase])

  useEffect(() => {
    // A merge selection belongs to the job it was started in — switching vans (or leaving the
    // view) must not carry it over.
    setOpMode('normal'); setMergeSelected(new Set()); setMergeKeeperId(null)
    setShowUnallocated(false); setScopeError(null)
    if (!van) { setStages([]); setJobs([]); setOperationsByJob({}); setVanTimes([]); setVanError(null); return }
    loadVan(van)
  }, [van, loadVan])

  const timesByOperation = useMemo(() => {
    const map = new Map<string, VanTime[]>()
    for (const t of vanTimes) {
      const list = map.get(t.operationId) ?? []
      list.push(t)
      map.set(t.operationId, list)
    }
    return map
  }, [vanTimes])

  /** Average per operation across THIS van's runs only — the shared averager, fed nothing but
   * this chassis's times, so a "65m · 2 runs" here is the same math as everywhere else. */
  const vanAvgByOperation = useMemo(
    () => averageByOperation(vanTimes.map((t) => ({ id: t.id, operation_id: t.operationId, total_minutes: t.totalMinutes }))),
    [vanTimes]
  )

  // ── Drill-down derivation — the same shape /setup builds, minus the line filter ───────
  /** The Team filter narrows the JOBS, never the stages: a stage belongs to one team, but a job
   * sitting in it doesn't have to, so filtering stages would hide the very stage a filtered job
   * is grouped under. Same rule as /setup. */
  const filteredJobs = useMemo(
    () => (teamId ? jobs.filter((j) => j.team_id === teamId) : jobs),
    [jobs, teamId]
  )

  /**
   * Which jobs apply to this van's model — DERIVED, never stored: a job applies iff at least
   * one of its operations has a model_operations row for this product. There is no job→model
   * link in the schema and there must not be one, or the two could disagree.
   */
  const applyingJobIds = useMemo(
    () => jobsApplying(operationsByJob, modelOpIds),
    [operationsByJob, modelOpIds]
  )

  /**
   * A model is "scoped" once it has any applies-list row at all. Before that there's nothing to
   * honour, so every job and operation on the line is shown — otherwise a brand-new model would
   * open onto empty columns with no way in.
   */
  const scoped = modelOpIds.size > 0

  /** Pane 2's default: the jobs that apply. "Show what doesn't apply" reveals the rest, which
   * is how a job that doesn't apply gets turned back on. */
  const scopedJobs = useMemo(
    () => (scoped && !showUnallocated ? filteredJobs.filter((j) => applyingJobIds.has(j.id)) : filteredJobs),
    [filteredJobs, scoped, showUnallocated, applyingJobIds]
  )

  /** Loaded jobs bucketed by the pane-1 entry they belong to. A job whose stage_id is null, or
   * points at a stage outside this line, lands in Unstaged. */
  const jobsByStageKey = useMemo(() => {
    const map = new Map<string, Job[]>()
    const known = new Set(stages.map((s) => s.id))
    for (const job of scopedJobs) {
      const key = job.stage_id && known.has(job.stage_id) ? job.stage_id : UNSTAGED_KEY
      const list = map.get(key)
      if (list) list.push(job)
      else map.set(key, [job])
    }
    return map
  }, [scopedJobs, stages])

  /**
   * Pane 1's rows: EVERY stage on the line, in walk order, plus "Unstaged" at the bottom
   * whenever it holds anything. A stage is line-level structure and is never model-scoped, so
   * this list is deliberately unaffected by the model, the applies-list and the "show not
   * apply" toggle — a stage with no applicable jobs still shows, with a count of 0. A line
   * with no stages at all gets Unstaged as its single entry; no empty scaffolding is invented.
   */
  const stageEntries = useMemo<StageEntry[]>(() => {
    const entries: StageEntry[] = stages.map((s) => ({
      key: s.id, name: s.name, stage: s, jobCount: (jobsByStageKey.get(s.id) ?? []).length,
    }))
    const unstagedCount = (jobsByStageKey.get(UNSTAGED_KEY) ?? []).length
    if (stages.length === 0 || unstagedCount > 0) {
      entries.push({ key: UNSTAGED_KEY, name: 'Unstaged', stage: null, jobCount: unstagedCount })
    }
    return entries
  }, [stages, jobsByStageKey])

  // A persisted id can outlive the scope it was chosen in (van changed, stage deleted, job
  // moved). Rather than write over the stored value, fall back to "nothing selected" whenever
  // the id isn't among the options actually available right now.
  const activeStageKey = stageEntries.some((e) => e.key === stageKey) ? stageKey : ''
  const activeStageEntry = stageEntries.find((e) => e.key === activeStageKey) ?? null

  const jobsInStage = useMemo(
    () => (activeStageKey ? jobsByStageKey.get(activeStageKey) ?? [] : []),
    [activeStageKey, jobsByStageKey]
  )
  const activeJobId = jobsInStage.some((j) => j.id === jobId) ? jobId : ''
  const selectedJob = jobsInStage.find((j) => j.id === activeJobId) ?? null

  const jobOperations = useMemo(
    () => (activeJobId ? operationsByJob[activeJobId] ?? [] : []),
    [activeJobId, operationsByJob]
  )
  /** What pane 3 lists: the job's operations, pruned to the ones that apply to this model
   * unless "Show what doesn't apply" is on (which is how one that doesn't apply gets switched
   * back on). */
  const visibleOperations = useMemo(
    () => (scoped && !showUnallocated ? jobOperations.filter((o) => modelOpIds.has(o.id)) : jobOperations),
    [jobOperations, scoped, showUnallocated, modelOpIds]
  )
  const activeOperationId = visibleOperations.some((o) => o.id === operationId) ? operationId : ''

  // ── Running-timer indicators ─────────────────────────────────────────────────────────
  /** Timers on THIS van, keyed by operation — one timer per operation is the rule the Start
   * button enforces, but the map holds a list so a stale duplicate can never be hidden. */
  const vanTimersByOperation = useMemo(() => {
    const map = new Map<string, ActiveTimer[]>()
    if (!van) return map
    for (const t of timers) {
      if (t.chassisId !== van.chassisId) continue
      const list = map.get(t.operationId) ?? []
      list.push(t)
      map.set(t.operationId, list)
    }
    return map
  }, [timers, van])

  /** The running dots on panes 1 and 2 — a stage or job is "running" when any operation under
   * it has a timer, so leaving an operation still leaves a trail back to it. */
  const { runningJobIds, runningStageKeys } = useMemo(() => {
    const jobIds = new Set<string>()
    const stageKeys = new Set<string>()
    if (vanTimersByOperation.size === 0) return { runningJobIds: jobIds, runningStageKeys: stageKeys }

    const knownStages = new Set(stages.map((s) => s.id))
    const jobById = new Map(jobs.map((j) => [j.id, j]))
    for (const [jId, ops] of Object.entries(operationsByJob)) {
      if (!ops.some((o) => vanTimersByOperation.has(o.id))) continue
      jobIds.add(jId)
      const job = jobById.get(jId)
      stageKeys.add(job?.stage_id && knownStages.has(job.stage_id) ? job.stage_id : UNSTAGED_KEY)
    }
    return { runningJobIds: jobIds, runningStageKeys: stageKeys }
  }, [vanTimersByOperation, operationsByJob, jobs, stages])

  // ── Drill actions ────────────────────────────────────────────────────────────────────
  function selectStage(key: string) { setStageKey(key); setJobId(''); setOperationId('') }
  function selectJob(id: string) { setJobId(id); setOperationId('') }

  // Changing what pane 3 is showing invalidates any merge selection held against the old job.
  useEffect(() => {
    setOpMode('normal')
    setMergeSelected(new Set())
    setMergeKeeperId(null)
  }, [activeJobId])

  // ── Structure writes (panes 1–3) ─────────────────────────────────────────────────────
  async function refreshVan() {
    if (van) await loadVan(van)
  }

  async function addJob(name: string) {
    const trimmed = name.trim()
    if (!trimmed || !activeStageEntry || !van) return
    setVanError(null)
    const stage = activeStageEntry.stage
    const { data, error } = await supabase.from('jobs').insert({
      name: trimmed,
      // Line comes from the van; team from the filter if one is set, otherwise the stage's own.
      production_line_id: van.productionLineId,
      team_id: teamId || stage?.team_id || null,
      stage_id: stage?.id ?? null,
    }).select('id').single()
    if (error) { setVanError(error.message); return }
    // A job with no operations yet can't apply to the model (applicability is derived from its
    // operations), and the default view hides what doesn't apply — so reveal, or the job would
    // vanish the instant it was created. Its first operation will link automatically.
    if (scoped) setShowUnallocated(true)
    await refreshVan()
    if (data?.id) selectJob(data.id)
  }

  async function renameOperation(id: string, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    setVanError(null)
    const { error } = await supabase.from('operations').update({ name: trimmed }).eq('id', id)
    if (error) { setVanError(error.message); return }
    await refreshVan()
  }

  // ── Applicability actions ────────────────────────────────────────────────────────────
  //
  // Applicability is stored ONLY on operations (model_operations, operation ↔ product) and is
  // operated at two grains: the job toggle in pane 2, which writes every operation under the
  // job in one go, and the per-operation toggle in pane 3, the fine-grained override for the
  // rare "this one operation differs" case. Every write goes through lib/modelOperations, so
  // the guard (never unlink a pair that has recorded times) is the same one /setup's bulk
  // drawer and ModelLinker enforce.

  /** Every operation currently loaded for the line — the exact set "Apply all" commits, so the
   * count in the confirmation is the count that gets written. */
  const allLineOperationIds = useMemo(
    () => Object.values(operationsByJob).flat().map((o) => o.id),
    [operationsByJob]
  )

  /** The timed guard as pairs, the shape lib/modelOperations' unlink helpers take. Empty when
   * the guard lookup failed — callers must check `timedForModelOpIds !== null` first and refuse
   * to unlink at all, rather than pass an empty set that would wave everything through. */
  const timedPairs = useMemo(() => {
    const pairs = new Set<string>()
    if (!van?.productId || !timedForModelOpIds) return pairs
    for (const opId of timedForModelOpIds) pairs.add(operationProductKey(opId, van.productId))
    return pairs
  }, [timedForModelOpIds, van?.productId])

  async function applyAllToModel() {
    if (!van?.productId) return
    const productId = van.productId
    setScopeBusy('__all__'); setScopeError(null)
    try {
      const { error } = await linkOperationsToModels(
        supabase,
        allLineOperationIds.map((id) => ({ operation_id: id, product_id: productId }))
      )
      if (error) throw new Error(error)
      await loadVan(van)
    } catch (err) {
      setScopeError(err instanceof Error ? err.message : 'Could not apply this model')
    } finally {
      setScopeBusy(null)
      setScopeConfirm(null)
    }
  }

  // ── Job-level toggle ─────────────────────────────────────────────────────────────────
  /**
   * Turning a job ON is unconditional — every operation under it gets a row for this model,
   * existing ones skipped by the upsert.
   *
   * Turning it OFF is not, which is why it confirms: the operations with recorded times for
   * this model stay linked (they demonstrably apply), so the action is "unlink N, keep M", and
   * the dialog says so before anything is written rather than after.
   */
  function toggleJobApplies(job: Job, currentlyApplies: boolean) {
    setScopeError(null)
    const operations = operationsByJob[job.id] ?? []
    if (operations.length === 0) return

    if (!currentlyApplies) { applyJob(job, operations); return }

    if (!timedForModelOpIds) {
      setBlockedRemove(
        `Couldn't check which of "${job.name}"'s operations have recorded times for this model, ` +
        'so it can\u2019t be switched off right now. Reload the van and try again.'
      )
      return
    }
    const linked = operations.filter((o) => modelOpIds.has(o.id))
    const kept = linked.filter((o) => timedForModelOpIds.has(o.id))
    setUnapplyJob({ job, unlinkCount: linked.length - kept.length, keptCount: kept.length })
  }

  async function applyJob(job: Job, operations: Operation[]) {
    if (!van?.productId) return
    const productId = van.productId
    setJobApplyBusyId(job.id); setScopeError(null); setJobApplyNotice(null)
    try {
      const { error } = await linkOperationsToModels(
        supabase,
        operations.map((o) => ({ operation_id: o.id, product_id: productId }))
      )
      if (error) throw new Error(error)
      await loadVan(van)
      setJobApplyNotice(`"${job.name}" now applies to ${van.model ?? 'this model'} — ${plural(operations.length, 'operation')} linked.`)
    } catch (err) {
      setScopeError(err instanceof Error ? err.message : 'Could not apply this job to the model')
    } finally {
      setJobApplyBusyId(null)
    }
  }

  async function unapplyJob(job: Job) {
    if (!van?.productId || !timedForModelOpIds) return
    const productId = van.productId
    const operations = operationsByJob[job.id] ?? []
    const linked = operations.filter((o) => modelOpIds.has(o.id))

    setJobApplyBusyId(job.id); setScopeError(null); setJobApplyNotice(null)
    try {
      const result = await unlinkOperationsFromModels(
        supabase,
        linked.map((o) => ({ operation_id: o.id, product_id: productId })),
        timedPairs
      )
      if (result.error) throw new Error(result.error)
      // A delete filtered out by RLS comes back successful having removed nothing, and
      // unlinkOperationsFromModels reads the deleted rows back — so a short count is a real
      // rejection, reported rather than refreshed into a screen that looks unchanged.
      if (result.unlinked < result.attempted) {
        throw new Error(
          `Only ${result.unlinked} of ${result.attempted} links could be removed — the rest were ` +
          'rejected. Removing a model link may be restricted to admins in this environment.'
        )
      }
      await loadVan(van)
      setJobApplyNotice(
        `"${job.name}" no longer applies to ${van.model ?? 'this model'} — ${plural(result.unlinked, 'operation')} unlinked` +
        (result.kept.length > 0 ? `, kept ${plural(result.kept.length, 'timed operation')}.` : '.')
      )
    } catch (err) {
      setScopeError(err instanceof Error ? err.message : 'Could not remove this job from the model')
    } finally {
      setJobApplyBusyId(null)
      setUnapplyJob(null)
    }
  }

  // ── Per-operation toggle ─────────────────────────────────────────────────────────────
  function requestRemoveFromModel(op: Operation) {
    setScopeError(null)
    if (!timedForModelOpIds) {
      setBlockedRemove(`Couldn't check whether "${op.name}" has recorded times for this model, so it can't be un-applied right now. Reload the van and try again.`)
      return
    }
    if (timedForModelOpIds.has(op.id)) {
      setBlockedRemove(`"${op.name}" has recorded times for ${van?.model ?? 'this model'}, so it clearly applies and can't be un-applied.`)
      return
    }
    setRemoveTarget(op)
  }

  /** Drops the (operation, model) link only. The operation row and every recorded time are
   * left exactly as they are — this is an applicability decision, not a deletion. */
  async function removeFromModel(op: Operation) {
    if (!van?.productId) return
    setScopeBusy(op.id); setScopeError(null)
    try {
      await unlinkOperationFromModel(supabase, op.id, van.productId, timedPairs)
      await loadVan(van)
    } catch (err) {
      setScopeError(err instanceof Error ? err.message : 'Could not remove from model')
    } finally {
      setScopeBusy(null)
      setRemoveTarget(null)
    }
  }

  async function addToModel(op: Operation) {
    if (!van?.productId) return
    setScopeBusy(op.id); setScopeError(null)
    try {
      await linkOperationToModel(supabase, op.id, van.productId)
      await loadVan(van)
    } catch (err) {
      setScopeError(err instanceof Error ? err.message : 'Could not apply to model')
    } finally {
      setScopeBusy(null)
    }
  }

  // ── Merge: fold duplicate operations into one keeper, retire the rest ─────────────────
  function toggleMergeSelection(operationId: string) {
    const next = new Set(mergeSelected)
    if (next.has(operationId)) next.delete(operationId)
    else next.add(operationId)
    setMergeSelected(next)
    // The keeper always has to be one of the selected operations — default to the first picked
    // and only move it when the current keeper is deselected.
    if (!mergeKeeperId || !next.has(mergeKeeperId)) setMergeKeeperId([...next][0] ?? null)
  }

  /**
   * Merge — lib/mergeOperations, the same helper /setup and /collect call. It owns the write
   * order, the all-or-nothing ownership guard and the post-move verification; this handler only
   * decides what to do with the outcome on this screen.
   */
  async function runMerge(keeper: Operation, dups: Operation[]) {
    if (!van) return
    setMerging(true)
    setVanError(null)
    try {
      const { stranded } = await mergeOperations(supabase, { keeper, dups, userId })
      await loadVan(van)
      setOperationId(keeper.id)
      setMergeSelected(new Set())
      setMergeKeeperId(null)
      if (stranded.length > 0) setVanError(strandedMergeMessage(stranded))
      else setOpMode('normal')
    } catch (err) {
      await loadVan(van)
      setVanError(err instanceof Error ? err.message : 'Merge failed')
    } finally {
      setMerging(false)
      setMergeConfirm(null)
    }
  }

  // ── Stopwatch actions ────────────────────────────────────────────────────────────────
  /**
   * One timer per operation: the Start button is hidden entirely once this operation has one,
   * so a second run can't be started on top of a first and quietly overwrite it in the bar.
   * Concurrency across DIFFERENT operations (and different jobs and stages) is the point, and
   * is unrestricted.
   */
  /** Opens the Start confirmation. Writes nothing and starts nothing — the clock begins only
   * when that form's "Start timing" is pressed (confirmStart), so Cancel leaves the operation
   * exactly as it was. */
  function requestStart(target: CaptureTarget) {
    setStartTarget(target)
  }

  /**
   * Begins the run. The operator picked here rides ON the timer — so it survives a refresh with
   * it, and comes back pre-filled at Complete — and the opening note becomes the first entry in
   * the timer's own notes list, held there until there's an operation_time row to hang it off.
   */
  function confirmStart(choice: StartTimerChoice) {
    if (!startTarget || !van?.productId) return
    startStopwatch({
      operationId: startTarget.operationId,
      operationName: startTarget.operationName,
      jobName: startTarget.jobName,
      productIds: [van.productId],
      models: [{ productId: van.productId, productCode: van.productCode ?? '', model: van.model ?? '' }],
      operatorId: choice.operatorId,
      operatorName: choice.operatorName,
      notes: choice.note.trim() ? [choice.note.trim()] : [],
      chassisId: van.chassisId,
      chassisNumber: van.chassisNumber,
    })
    setStartTarget(null)
  }

  function requestComplete(timer: ActiveTimer) {
    setCompleteError(null)
    setCompletingTimer(timer)
  }

  function cancelComplete() {
    setCompletingTimer(null)
    setCompleteError(null)
  }

  async function confirmComplete(result: CompleteTimerResult) {
    if (!completingTimer) return
    const timer = completingTimer
    setCompleting(true); setCompleteError(null)
    try {
      await saveTimerRun(supabase, timer, {
        userId,
        operatorId: result.operatorId,
        notes: result.notes,
        note: result.note,
        atMs: result.atMs,
      })
      // The timer is dropped only once the save has resolved — a failed save leaves it running
      // in the rail rather than throwing the elapsed time away.
      discardTimer(timer.timerId)
      setCompletingTimer(null)
      // Refresh the on-van figures so the operation row shows the run that was just recorded.
      if (van && timer.chassisId === van.chassisId) await loadVan(van)
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

  // ── Tryout open/close ────────────────────────────────────────────────────────────────
  /** is_active is the only field a close/reopen touches — the tryout's history stays intact so
   * it can be re-opened later without losing who started it. */
  async function setTryoutActive(tryoutId: string, isActive: boolean) {
    setTryoutBusy(true); setListError(null)
    try {
      const { data, error } = await supabase
        .from('tryouts')
        .update({ is_active: isActive })
        .eq('id', tryoutId)
        .select('id')
      if (error) throw new Error(error.message)
      if (!data || data.length === 0) throw new Error('That tryout could not be updated — the change was rejected.')
      await loadCards()
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not update the tryout')
    } finally {
      setTryoutBusy(false)
      setCloseTarget(null)
    }
  }

  function openTryout(context: VanContext) {
    // Without a resolved model there's no product to link a time to (operation_times carries
    // no product_id of its own — recordOperationTime links through operation_time_models), so
    // the van can't be timed. Say so rather than opening a view whose every action fails.
    if (!context.productId) { setNoModelVan(context); return }
    setVan(context)
  }

  // ── Drawers ──────────────────────────────────────────────────────────────────────────
  function openCapture(target: CaptureTarget) {
    closeTimeDetail()
    setCapture(target)
    requestAnimationFrame(() => requestAnimationFrame(() => setCaptureVisible(true)))
  }
  function closeCapture() {
    setCaptureVisible(false)
    window.setTimeout(() => setCapture(null), 320)
  }

  function openTimeDetail(target: CaptureTarget) {
    closeCapture()
    setTimeDetail(target)
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeDetailVisible(true)))
  }
  function closeTimeDetail() {
    setTimeDetailVisible(false)
    window.setTimeout(() => setTimeDetail(null), 320)
  }

  // Escape closes whichever pane is open (only one ever is).
  useEffect(() => {
    if (!timeDetail) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closeTimeDetail() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeDetail])

  useEffect(() => {
    if (!capture) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closeCapture() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture])

  // Closed tryouts are fetched but hidden by default — the toggle only appears once there's
  // something to reveal.
  const closedCount = cards.filter((c) => !c.isActive).length
  const visibleCards = showClosed ? cards : cards.filter((c) => c.isActive)

  // ── Landing ──────────────────────────────────────────────────────────────────────────
  if (!van) {
    return (
      <main className="page">
        <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Try Outs</h1>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Follow one van down the line — every time captured against its chassis</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            {closedCount > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: 'var(--text-mid)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showClosed}
                  onChange={(e) => setShowClosed(e.target.checked)}
                  style={{ width: 15, height: 15, accentColor: 'var(--blue)', cursor: 'pointer' }}
                />
                Show closed ({closedCount})
              </label>
            )}
            <button className="btn-primary" onClick={() => setStartModalOpen(true)}>+ Start new tryout</button>
          </div>
        </div>

        {listError && <p style={{ ...ERR_BOX, marginBottom: 16 }}>{listError}</p>}

        {/* The timer rail only exists inside a van, so a timer left running on one would
          * otherwise be invisible from here — and an unfinished timer is an unrecorded run.
          * Each van with one is listed, and opening it puts the rail (and its Complete) back. */}
        {timers.length > 0 && (
          <div className="card" style={{ padding: '12px 18px', marginBottom: 16, background: 'var(--green-bg)', borderColor: '#bbf7d0', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#15803d' }}>
              {plural(timers.length, 'timer')} still going
            </span>
            {[...new Map(timers.map((t) => [t.chassisId ?? '', t])).values()].map((t) => {
              const card = cards.find((c) => c.chassisId === t.chassisId)
              return (
                <button
                  key={t.chassisId ?? t.timerId}
                  type="button"
                  className="btn-ghost"
                  style={{ padding: '5px 10px', fontSize: 12 }}
                  disabled={!card}
                  onClick={() => card && openTryout(card.van)}
                >
                  Open {t.chassisNumber ?? 'van'}
                </button>
              )
            })}
          </div>
        )}

        {loadingCards ? (
          <p style={EMPTY}>Loading…</p>
        ) : visibleCards.length === 0 ? (
          <p style={EMPTY}>
            {cards.length > 0
              ? 'No open tryouts — turn on “Show closed” to see finished ones'
              : 'No tryouts yet — start one with a chassis number'}
          </p>
        ) : (
          <div className="grid-3">
            {visibleCards.map((card) => (
              <div
                key={card.tryoutId}
                role="button"
                tabIndex={0}
                className="card"
                onClick={() => openTryout(card.van)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTryout(card.van) } }}
                style={{
                  padding: '16px 18px', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                  display: 'flex', flexDirection: 'column', gap: 6, opacity: card.isActive ? 1 : 0.65,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>{card.chassisNumber}</span>
                  {!card.isActive && <span className="badge badge-grey">Closed</span>}
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-mid)' }}>
                  {card.model ?? 'No model linked'}
                  {card.productCode && <span style={{ color: 'var(--text-muted)' }}> · {card.productCode}</span>}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{card.productionLineName ?? 'No production line'}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  {card.lastCollectedAt ? (
                    <>
                      <span className="badge badge-blue">{card.timesCollected} time{card.timesCollected !== 1 ? 's' : ''}</span>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>last {fmtDate(card.lastCollectedAt)}</span>
                    </>
                  ) : (
                    <span className="badge badge-grey">Not yet timed</span>
                  )}
                  <button
                    type="button"
                    disabled={tryoutBusy}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (card.isActive) setCloseTarget(card)
                      else setTryoutActive(card.tryoutId, true)
                    }}
                    style={{
                      marginLeft: 'auto', background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
                    }}
                  >
                    {card.isActive ? 'Close' : 'Re-open'}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        {startModalOpen && (
          <StartTryoutModal
            supabase={supabase}
            userId={userId}
            onClose={() => setStartModalOpen(false)}
            onResolved={(context) => { setStartModalOpen(false); openTryout(context) }}
          />
        )}

        {closeTarget && (
          <ConfirmDialog
            title="Close this tryout"
            message={`Close the tryout for ${closeTarget.chassisNumber}? It drops off the list, and its recorded times are kept. You can re-open it later.`}
            confirmLabel={tryoutBusy ? 'Closing…' : 'Close tryout'}
            onConfirm={() => { if (!tryoutBusy) setTryoutActive(closeTarget.tryoutId, false) }}
            onCancel={() => { if (!tryoutBusy) setCloseTarget(null) }}
          />
        )}

        {noModelVan && (
          <ConfirmDialog
            title="Can't run a tryout on this van"
            message={`${noModelVan.chassisNumber} has no model linked to it, so a time recorded against it couldn't be attributed to a model. Link the chassis to a product first, then start the tryout.`}
            confirmLabel="Got it"
            cancelLabel="Close"
            onConfirm={() => setNoModelVan(null)}
            onCancel={() => setNoModelVan(null)}
          />
        )}
      </main>
    )
  }

  // ── Van view (one van) ───────────────────────────────────────────────────────────────
  const mergeKeeper = jobOperations.find((o) => o.id === mergeKeeperId && mergeSelected.has(o.id)) ?? null
  const mergeDups = mergeKeeper ? jobOperations.filter((o) => mergeSelected.has(o.id) && o.id !== mergeKeeper.id) : []
  const timedOnVanCount = visibleOperations.filter((o) => (timesByOperation.get(o.id)?.length ?? 0) > 0).length

  return (
    <main className="page-wide rail-page">
      <button
        type="button"
        onClick={() => setVan(null)}
        style={{ background: 'none', border: 'none', padding: 0, marginBottom: 14, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--text-mid)' }}
      >
        ← All tryouts
      </button>

      <div className="card" style={{ padding: '16px 20px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>{van.chassisNumber}</h1>
          <p style={{ fontSize: 13, color: 'var(--text-mid)', marginTop: 4 }}>
            {van.model ?? 'No model'}
            {van.productCode && <span style={{ color: 'var(--text-muted)' }}> · {van.productCode}</span>}
            <span style={{ color: 'var(--text-muted)' }}> · {van.productionLineName ?? 'No production line'}</span>
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="badge badge-blue">{vanTimes.length} time{vanTimes.length !== 1 ? 's' : ''} on this van</span>
          {van.tryoutId && (
            <button
              className="btn-ghost"
              style={{ padding: '6px 11px', fontSize: 12 }}
              disabled={tryoutBusy}
              onClick={async () => {
                if (!van.tryoutId) return
                const nextActive = !van.tryoutActive
                await setTryoutActive(van.tryoutId, nextActive)
                // Closing is a "done with this van" action, so it hands back to the list;
                // re-opening just updates the header in place.
                if (!nextActive) setVan(null)
                else setVan({ ...van, tryoutActive: true })
              }}
            >
              {van.tryoutActive === false ? 'Re-open tryout' : 'Close tryout'}
            </button>
          )}
        </div>
      </div>

      {/* ── Filter bar: the line is fixed by the van's chassis, so only Team is a choice ─── */}
      <div className="card" style={{ padding: '14px 20px', marginBottom: 16, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {van.productionLineName ?? 'No production line'}
        </span>
        <select
          style={{ ...SEL, width: 'auto', minWidth: 200 }}
          value={teamId}
          onChange={(e) => { setTeamId(e.target.value); setStageKey(''); setJobId(''); setOperationId('') }}
        >
          <option value="">All teams</option>
          {lineTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {scoped && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: 'var(--text-mid)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showUnallocated}
              onChange={(e) => setShowUnallocated(e.target.checked)}
              style={{ width: 15, height: 15, accentColor: 'var(--blue)', cursor: 'pointer' }}
            />
            Show what doesn&apos;t apply to {van.model ?? 'this model'}
          </label>
        )}
        {teamId && (
          <button
            type="button"
            onClick={() => { setTeamId(''); setStageKey(''); setJobId(''); setOperationId('') }}
            style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: 'var(--text-mid)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Clear team filter
          </button>
        )}
      </div>

      {vanError && <p style={{ ...ERR_BOX, marginBottom: 16 }}>{vanError}</p>}
      {scopeError && <p style={{ ...ERR_BOX, marginBottom: 16 }}>{scopeError}</p>}

      {/* What a job-level toggle just did — including how many timed operations it had to keep
        * linked, which is the one outcome a user can't infer from the resulting list. */}
      {jobApplyNotice && (
        <div style={{ padding: '9px 14px', borderRadius: 8, background: 'var(--green-bg)', border: '1px solid #bbf7d0', color: '#15803d', fontSize: 13, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>{jobApplyNotice}</span>
          <button
            type="button"
            onClick={() => setJobApplyNotice(null)}
            aria-label="Dismiss"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 15, lineHeight: 1, color: 'inherit', flexShrink: 0 }}
          >
            ×
          </button>
        </div>
      )}

      {/* ── Nothing applies yet — every operation on the line shows, and this is the way in ── */}
      {van.productId && !loadingVan && !scoped && allLineOperationIds.length > 0 && (
        <div
          className="card"
          style={{
            padding: '14px 18px', marginBottom: 16, background: 'var(--blue-light)', borderColor: '#bcdff2',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--blue)' }}>Nothing applies to {van.model ?? 'this model'} yet</div>
            <div style={{ fontSize: 12, color: 'var(--text-mid)', marginTop: 2 }}>
              Showing every job and operation on {van.productionLineName ?? 'this line'} ({allLineOperationIds.length} operations). Apply them all and switch off the jobs that don&apos;t fit, or switch on one job at a time in the Jobs column.
            </div>
          </div>
          <button className="btn-primary" disabled={scopeBusy !== null} onClick={() => setScopeConfirm({ count: allLineOperationIds.length })}>
            Apply all to this model
          </button>
        </div>
      )}

      {loadingVan ? (
        <p style={EMPTY}>Loading…</p>
      ) : !van.productionLineId ? (
        <p style={EMPTY}>This van&apos;s model isn&apos;t on a production line, so there&apos;s no stage structure to walk</p>
      ) : (
        <div className="finder-panes finder-panes-3">
          <StagesPane
            supabase={supabase}
            entries={stageEntries}
            stages={stages}
            productionLineId={van.productionLineId}
            productionLineName={van.productionLineName}
            teams={lineTeams}
            selectedKey={activeStageKey}
            runningKeys={runningStageKeys}
            // Navigation, plus create. A stage is line-level structure — not model-scoped —
            // so rename/reorder/delete stay on /setup: nothing here can renumber the walk or
            // destroy a stage out from under the line (a line-wide footgun mid-van-walk).
            // Adding is different — it only ever appends a stage to the end of the line, and a
            // van being walked can turn out to need a step the line doesn't have yet, so
            // leaving for /setup to get it would break the walk.
            readOnly
            allowAdd
            onSelect={selectStage}
            onChanged={refreshVan}
          />

          <JobsPane
            entry={activeStageEntry}
            jobs={jobsInStage}
            loading={loadingVan}
            operationsByJob={operationsByJob}
            selectedJobId={activeJobId}
            runningJobIds={runningJobIds}
            applicability={{
              appliesIds: applyingJobIds,
              targetLabel: van.model ?? 'this model',
              busyJobId: jobApplyBusyId,
              // Applicability is derived from operations, so a job with none has nothing to
              // link and the toggle would be a no-op — say why rather than let it look broken.
              disabledReasons: Object.fromEntries(
                jobsInStage
                  .filter((j) => (operationsByJob[j.id] ?? []).length === 0)
                  .map((j) => [j.id, 'This job has no operations yet — add one and it will apply to this model automatically.'])
              ),
              onToggle: toggleJobApplies,
            }}
            onSelect={selectJob}
            onAdd={addJob}
          />

          <VanOperationsPane
            job={selectedJob}
            operations={visibleOperations}
            loading={loadingVan}
            van={van}
            scoped={scoped}
            modelOpIds={modelOpIds}
            timesByOperation={timesByOperation}
            vanAvgByOperation={vanAvgByOperation}
            timersByOperation={vanTimersByOperation}
            nowMs={nowMs}
            timedOnVanCount={timedOnVanCount}
            scopeBusyOpId={scopeBusy}
            selectedOperationId={activeOperationId}
            mode={opMode}
            selection={mergeSelected}
            mergeKeeperId={mergeKeeperId}
            merging={merging}
            onSelect={setOperationId}
            onRename={renameOperation}
            onAdd={() => selectedJob && setNewOperationJob({ jobId: selectedJob.id, jobName: selectedJob.name })}
            onAllocate={addToModel}
            onDeallocate={requestRemoveFromModel}
            onStart={(op, job) => requestStart({ operationId: op.id, operationName: op.name, jobName: job.name })}
            onTogglePause={togglePause}
            onComplete={requestComplete}
            onOpenTimes={(op, job) => openTimeDetail({ operationId: op.id, operationName: op.name, jobName: job.name })}
            onAddManualTime={(op, job) => openCapture({ operationId: op.id, operationName: op.name, jobName: job.name })}
            onEnterMerge={() => {
              setOpMode((m) => (m === 'merge' ? 'normal' : 'merge'))
              setMergeSelected(new Set())
              setMergeKeeperId(null)
            }}
            onToggleSelection={toggleMergeSelection}
            onPickKeeper={setMergeKeeperId}
            onRequestMerge={() => { if (mergeKeeper && mergeDups.length > 0) setMergeConfirm({ keeper: mergeKeeper, dups: mergeDups }) }}
          />
        </div>
      )}

      {/* ── The persistent right-hand rail: every running/paused timer, wherever it was
        * started. Fixed, so it stays put while the panes are scrolled and drilled through. ── */}
      <TimerRail
        timers={timers}
        nowMs={nowMs}
        currentContextKey={van.chassisId}
        onTogglePause={togglePause}
        onComplete={requestComplete}
        onDiscard={(timerId) => setCancelingTimerId(timerId)}
        onAddNote={addTimerNote}
        onRemoveNote={removeTimerNote}
      />

      {newOperationJob && (
        <NewOperationModal
          supabase={supabase}
          jobId={newOperationJob.jobId}
          jobName={newOperationJob.jobName}
          // Always this van's model, and only it — a new operation created while walking a van
          // is by definition one that applies to it. Never any other model.
          autoLinkProductId={van.productId}
          hint={`Added to ${newOperationJob.jobName}, then its stopwatch starts straight away for this van. Staff it in Operator later.`}
          submitLabel="Create &amp; Time"
          onClose={() => setNewOperationJob(null)}
          onCreated={async (operationId, operationName, jobName) => {
            setNewOperationJob(null)
            await loadVan(van)
            setOperationId(operationId)
            // Straight into the Start step — creating the operation is only ever a step on the
            // way to timing it on this van, and it gets the same operator/opening-note prompt
            // as pressing Start on any other row.
            requestStart({ operationId, operationName, jobName })
          }}
        />
      )}

      {scopeConfirm && (
        <ConfirmDialog
          title={`Apply every operation to ${van.model ?? 'this model'}`}
          message={`Mark all ${scopeConfirm.count} operations on ${van.productionLineName ?? 'this line'} as applying to ${van.model ?? 'this model'}? You'll then be able to switch off the jobs and operations that don't. This affects all vans of this model.`}
          confirmLabel={scopeBusy ? 'Applying…' : 'Apply all'}
          onConfirm={() => { if (!scopeBusy) applyAllToModel() }}
          onCancel={() => { if (!scopeBusy) setScopeConfirm(null) }}
        />
      )}

      {removeTarget && (
        <ConfirmDialog
          title="Stop this operation applying"
          message={`Stop ${removeTarget.name} applying to ${van.model ?? 'this model'}? It will drop off this model's list for all its vans. (The operation itself is not deleted, and no recorded time is touched.)`}
          confirmLabel={scopeBusy ? 'Removing…' : 'Remove'}
          danger
          onConfirm={() => { if (!scopeBusy) removeFromModel(removeTarget) }}
          onCancel={() => { if (!scopeBusy) setRemoveTarget(null) }}
        />
      )}

      {blockedRemove && (
        <ConfirmDialog
          title="Can't change this"
          message={blockedRemove}
          confirmLabel="Got it"
          cancelLabel="Close"
          onConfirm={() => setBlockedRemove(null)}
          onCancel={() => setBlockedRemove(null)}
        />
      )}

      {/* Switching a job off is a bulk unlink with an exception, so the counts are stated
        * before anything is written — including the timed operations that will stay linked. */}
      {unapplyJobTarget && (
        <ConfirmDialog
          title={`Stop "${unapplyJobTarget.job.name}" applying`}
          message={
            unapplyJobTarget.unlinkCount === 0
              ? `Every one of "${unapplyJobTarget.job.name}"'s operations that applies to ${van.model ?? 'this model'} has recorded times for it, so all ${unapplyJobTarget.keptCount} stay linked and nothing would change.`
              : `Unlink ${plural(unapplyJobTarget.unlinkCount, 'operation')} from ${van.model ?? 'this model'}?` +
                (unapplyJobTarget.keptCount > 0
                  ? ` ${plural(unapplyJobTarget.keptCount, 'operation')} with recorded times for this model will be kept — they clearly apply.`
                  : '') +
                ' This affects all vans of this model. No operation is deleted and no recorded time is touched.'
          }
          confirmLabel={
            unapplyJobTarget.unlinkCount === 0
              ? 'Close'
              : jobApplyBusyId ? 'Removing…' : `Unlink ${unapplyJobTarget.unlinkCount}`
          }
          cancelLabel={unapplyJobTarget.unlinkCount === 0 ? 'Close' : 'Cancel'}
          danger={unapplyJobTarget.unlinkCount > 0}
          onConfirm={() => {
            if (jobApplyBusyId) return
            if (unapplyJobTarget.unlinkCount === 0) { setUnapplyJob(null); return }
            unapplyJob(unapplyJobTarget.job)
          }}
          onCancel={() => { if (!jobApplyBusyId) setUnapplyJob(null) }}
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>Being retired</span>
            {mergeConfirm.dups.map((d) => (
              <span key={d.id} style={{ fontSize: 13, color: 'var(--text-mid)' }}>{d.name}</span>
            ))}
          </div>
        </ConfirmDialog>
      )}

      {/* ── Start a timer: the shared confirmation, before the clock begins ─────────── */}
      {startTarget && (
        <StartTimerDialog
          operationName={startTarget.operationName}
          jobName={startTarget.jobName}
          contextLabel={van.chassisNumber}
          operators={operators}
          onStart={confirmStart}
          onCancel={() => setStartTarget(null)}
        />
      )}

      {/* ── Complete a timer: the shared operator + run-notes + final-note dialog ─────── */}
      {completingTimer && (
        <CompleteTimerDialog
          timer={completingTimer}
          contextLabel={`${completingTimer.chassisNumber ?? 'this van'} · ${van.model ?? 'this model'}`}
          operators={operators}
          saving={completing}
          error={completeError}
          onSave={confirmComplete}
          onCancel={() => { if (!completing) cancelComplete() }}
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

      {/* ── Manual entry: minutes typed in, for a run nobody stopwatched ─────────────── */}
      {capture && (
        <>
          <div className={'gaps-drawer-overlay' + (captureVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={closeCapture} />
          <div className={'gaps-drawer' + (captureVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <div className="gaps-drawer-header">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="gaps-drawer-title">{capture.operationName}</div>
                <div className="gaps-drawer-jobname">{capture.jobName} · {van.chassisNumber}</div>
              </div>
              <button className="gaps-drawer-close" onClick={closeCapture} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="gaps-drawer-body" style={{ padding: '16px 20px' }}>
              <CapturePanel
                key={capture.operationId}
                supabase={supabase}
                van={van}
                target={capture}
                operators={operators}
                userId={userId}
                existing={timesByOperation.get(capture.operationId) ?? []}
                onSaved={async () => { await loadVan(van); closeCapture() }}
              />
            </div>
          </div>
        </>
      )}

      {/* ── Time detail: edit / delete the runs already on this van ──────────────────── */}
      {timeDetail && (
        <>
          <div className={'gaps-drawer-overlay' + (timeDetailVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={closeTimeDetail} />
          <div className={'gaps-drawer' + (timeDetailVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <div className="gaps-drawer-header">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="gaps-drawer-title">{timeDetail.operationName}</div>
                <div className="gaps-drawer-jobname">{timeDetail.jobName} · {van.chassisNumber}</div>
              </div>
              <button className="gaps-drawer-close" onClick={closeTimeDetail} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="gaps-drawer-body" style={{ padding: '16px 20px' }}>
              <TimeDetailPanel
                supabase={supabase}
                times={timesByOperation.get(timeDetail.operationId) ?? []}
                userId={userId}
                onChanged={async () => { await loadVan(van) }}
                onEmpty={closeTimeDetail}
                onAddTime={() => openCapture(timeDetail)}
              />
            </div>
          </div>
        </>
      )}
    </main>
  )
}

// ── Pane 3: Operations, with an applies toggle + an inline stopwatch on every row ──────────
/**
 * The van's answer to /setup's Operations pane. Same `Pane` shell, same .finder-row markup and
 * same merge mode — but the row itself carries the three things a walker needs on the spot:
 * whether the operation applies to this van's model, what has already been timed on THIS van,
 * and a Start control.
 *
 * Every row is a fixed-height three-row grid (see .finder-row-op) and that is load-bearing, not
 * cosmetic: the row is exactly as tall whether the operation has never been timed, has a
 * stopwatch running, or was just completed. Starting or finishing a timer swaps what sits in
 * the third row — the reserved capture slot — and moves nothing else.
 *
 * That slot holds one line of controls in every state: Start + "Enter manually" when idle, and
 * elapsed + Pause/Resume + Complete once a stopwatch is on the operation. Both states are one
 * line, so nothing reflows; "Enter manually" stands down while timing rather than a fourth
 * control being squeezed in. Complete here and Complete on the rail's card call the same
 * handler, so both open the same operator + notes confirmation and share one save path.
 *
 * The per-operation applies toggle is the fine-grained override. The usual handle is the job
 * toggle one pane left, which writes every operation under the job at once; this one is for the
 * "everything in this job applies except that one" case.
 *
 * The pane is deliberately the wide one (see .finder-panes-3): three lines of content per row
 * don't fit a quarter-width column, and this is the column being worked in.
 */
function VanOperationsPane({
  job, operations, loading, van, scoped, modelOpIds, timesByOperation, vanAvgByOperation,
  timersByOperation, nowMs, timedOnVanCount, scopeBusyOpId, selectedOperationId,
  mode, selection, mergeKeeperId, merging,
  onSelect, onRename, onAdd, onAllocate, onDeallocate, onStart, onTogglePause, onComplete,
  onOpenTimes, onAddManualTime, onEnterMerge, onToggleSelection, onPickKeeper, onRequestMerge,
}: {
  job: Job | null
  operations: Operation[]
  loading: boolean
  van: VanContext
  scoped: boolean
  modelOpIds: Set<string>
  timesByOperation: Map<string, VanTime[]>
  vanAvgByOperation: Record<string, OperationTimeStat>
  timersByOperation: Map<string, ActiveTimer[]>
  nowMs: number
  timedOnVanCount: number
  /** The operation whose allocation is being written right now, or '__all__' for the bulk
   * allocate — either way its row's toggle is disabled while it's in flight. */
  scopeBusyOpId: string | null
  selectedOperationId: string
  mode: 'normal' | 'merge'
  selection: Set<string>
  mergeKeeperId: string | null
  merging: boolean
  onSelect: (id: string) => void
  onRename: (id: string, name: string) => Promise<void>
  onAdd: () => void
  onAllocate: (op: Operation) => void
  onDeallocate: (op: Operation) => void
  onStart: (op: Operation, job: Job) => void
  onTogglePause: (timerId: string) => void
  /** Opens the operator + notes confirmation — the SAME handler the rail's Complete uses, so
   * the two entry points can't diverge into two different save paths. */
  onComplete: (timer: ActiveTimer) => void
  onOpenTimes: (op: Operation, job: Job) => void
  onAddManualTime: (op: Operation, job: Job) => void
  onEnterMerge: () => void
  onToggleSelection: (id: string) => void
  onPickKeeper: (id: string) => void
  onRequestMerge: () => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const selectedCount = operations.filter((o) => selection.has(o.id)).length
  const inMerge = mode === 'merge'

  async function commitRename(op: Operation) {
    const trimmed = editDraft.trim()
    if (!trimmed || trimmed === op.name) { setEditingId(null); return }
    setBusy(true)
    try { await onRename(op.id, trimmed) } finally { setBusy(false); setEditingId(null) }
  }

  const subtitle = !job
    ? 'No job selected'
    : inMerge
      ? `${job.name} · merge — ${selectedCount} selected`
      : `${job.name} · ${timedOnVanCount} of ${plural(operations.length, 'operation')} timed on ${van.chassisNumber}`

  return (
    <Pane
      title="Operations"
      subtitle={subtitle}
      active={Boolean(selectedOperationId)}
      footer={
        job ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            {inMerge ? (
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
                  <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} disabled={merging} onClick={onEnterMerge}>Cancel</button>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={onAdd}>+ Add operation</button>
                {operations.length > 1 && (
                  <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={onEnterMerge}>Merge</button>
                )}
              </div>
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
        <p className="finder-pane-empty">
          {scoped
            ? `No operations in ${job.name} apply to ${van.model ?? 'this model'} — tick “Show what doesn’t apply” above to switch one on, or add a new operation below.`
            : `No operations under ${job.name} yet — add one below.`}
        </p>
      ) : (
        operations.map((op) => {
          // In merge mode the row is a checkbox and nothing else — the stopwatch and allocation
          // controls would be a mis-click waiting to happen while the row's job is to be ticked.
          if (inMerge) {
            const isTicked = selection.has(op.id)
            const isKeeper = mergeKeeperId === op.id
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
                    {isTicked && (
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
              </label>
            )
          }

          const isSelected = op.id === selectedOperationId
          const applies = modelOpIds.has(op.id)
          const times = timesByOperation.get(op.id) ?? []
          const stat = vanAvgByOperation[op.id]
          const timer = timersByOperation.get(op.id)?.[0] ?? null
          const allocBusy = scopeBusyOpId === op.id || scopeBusyOpId === '__all__'

          return (
            <div
              key={op.id}
              className={'finder-row finder-row-op' + (isSelected ? ' finder-row-selected' : '')}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(op.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(op.id) } }}
              style={applies ? undefined : { opacity: 0.62 }}
            >
              {/* Row 1 — the name, its running dot, and the applies toggle. */}
              <div className="finder-row-op-head">
                {editingId === op.id ? (
                  <input
                    autoFocus
                    style={ROW_INPUT}
                    value={editDraft}
                    disabled={busy}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(op) }
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    onBlur={() => commitRename(op)}
                  />
                ) : (
                  <>
                    {/* Titled as well as truncated: the row clips rather than wraps, so a long
                        name has to stay reachable some other way. The dot sits OUTSIDE the
                        ellipsised text — inside it a long name would clip the dot away — in a
                        slot that is always reserved, so the name doesn't re-truncate the moment
                        a timer starts. */}
                    <span className="finder-row-name" title={op.name} style={{ flex: 1 }}>{op.name}</span>
                    <span className="finder-row-op-dot">
                      {timer && <RunningDot title={timer.isPaused ? 'A paused timer is on this operation' : 'A timer is running on this operation'} />}
                    </span>
                    <span className="finder-row-actions" onClick={(e) => e.stopPropagation()}>
                      <RenameButton title="Rename operation" onClick={() => { setEditingId(op.id); setEditDraft(op.name) }} />
                      {/* The same control the Jobs pane uses, one grain down — this is the
                          fine-grained override for the rare "this operation differs" case, so it
                          reads identically rather than inventing a second vocabulary. */}
                      <label
                        title={
                          applies
                            ? `Stop this operation applying to ${van.model ?? 'this model'}`
                            : `Make this operation apply to ${van.model ?? 'this model'}`
                        }
                        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: allocBusy ? 'default' : 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          checked={applies}
                          disabled={allocBusy}
                          onChange={() => (applies ? onDeallocate(op) : onAllocate(op))}
                          style={{ width: 14, height: 14, accentColor: 'var(--blue)', cursor: allocBusy ? 'default' : 'pointer' }}
                        />
                        <span className={'badge ' + (applies ? 'badge-green' : 'badge-grey')}>
                          {allocBusy ? '…' : applies ? 'Applies' : 'Doesn’t apply'}
                        </span>
                      </label>
                    </span>
                  </>
                )}
              </div>

              {/* Row 2 — what is already recorded on THIS van. Always exactly one line: it goes
                  from "Not timed" to a "✓" chip when a run is saved, and the row height is
                  identical either way. */}
              <div className="finder-row-op-status" onClick={(e) => e.stopPropagation()}>
                {times.length === 0 ? (
                  <span className="finder-row-meta" style={{ marginTop: 0 }}>Not timed on {van.chassisNumber}</span>
                ) : (
                  <button
                    type="button"
                    className="finder-row-op-timed"
                    onClick={() => job && onOpenTimes(op, job)}
                    title={`View, edit or delete this van's recorded times — ${times.map((t) => `${fmtMinutes(t.totalMinutes)}m · ${t.operatorName ?? 'no operator'} · ${fmtDate(t.createdAt)}`).join(', ')}`}
                  >
                    ✓ {stat && stat.runs > 1
                      ? `avg ${fmtMinutes(stat.avg)}m · ${stat.runs} runs`
                      : `${fmtMinutes(stat?.avg ?? times[0].totalMinutes)}m · 1 run`} on this van
                    <PencilIcon />
                  </button>
                )}
              </div>

              {/* Row 3 — the reserved capture slot. Start, or a read-only readout while a
                  stopwatch is on this operation; Pause/Complete/Discard live in the right-hand
                  rail so this slot never grows a second row of controls. */}
              <div className="finder-row-op-slot" onClick={(e) => e.stopPropagation()}>
                {timer ? (
                  // A running timer gets its full set of controls here as well as in the rail —
                  // whichever the walker reaches for, Complete opens the same operator + notes
                  // confirmation. Three controls on one line, and "Enter manually" stands down
                  // while a stopwatch is going (it isn't the moment for it), so the slot's one
                  // fixed line is never asked to hold more than it can.
                  <>
                    <span
                      className={'finder-row-op-clock ' + (timer.isPaused ? 'timer-display-paused' : 'timer-display-running')}
                      title={timer.isPaused ? 'Paused' : 'Timing…'}
                    >
                      {fmtClock(elapsedSecondsNow(timer, nowMs))}
                    </span>
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ padding: '4px 10px', fontSize: 12 }}
                      onClick={() => onTogglePause(timer.timerId)}
                    >
                      {timer.isPaused ? 'Resume' : 'Pause'}
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      style={{ padding: '4px 10px', fontSize: 12 }}
                      title="Record this run — asks for an optional operator and notes first"
                      onClick={() => onComplete(timer)}
                    >
                      Complete
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn-primary"
                      style={{ padding: '4px 10px', fontSize: 12 }}
                      disabled={!van.productId || !job}
                      onClick={() => job && onStart(op, job)}
                    >
                      ▶ Start
                    </button>
                    <button
                      type="button"
                      className="finder-row-action"
                      style={{ marginLeft: 'auto' }}
                      title="Type the minutes in instead of running a stopwatch"
                      onClick={() => job && onAddManualTime(op, job)}
                    >
                      Enter manually
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })
      )}
    </Pane>
  )
}

// ── Time detail: every run of one operation on this van, each editable and deletable ──────
/**
 * The edit-side counterpart of CapturePanel: same slide-over shell, but scoped to the times
 * that already exist for (this operation, this chassis). Every write goes through the shared
 * operationTimes helpers — updateOperationTimeMinutes, deleteOperationTime, and the note
 * add/update/delete trio via the NoteThread reused from ModelLinker — so nothing here is a
 * second implementation of a write that exists elsewhere.
 *
 * `times` is owned by the parent (it's the same list the walk renders), so after any write this
 * calls onChanged to reload the van and the pane re-renders from the refreshed props.
 */
function TimeDetailPanel({
  supabase, times, userId, onChanged, onEmpty, onAddTime,
}: {
  supabase: SupabaseClient
  times: VanTime[]
  userId: string
  onChanged: () => Promise<void>
  onEmpty: () => void
  onAddTime: () => void
}) {
  const [notesByTime, setNotesByTime] = useState<Record<string, OperationTimeNote[]>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<VanTime | null>(null)

  const timeIdsKey = times.map((t) => t.id).join(',')

  const loadNotes = useCallback(async () => {
    const ids = timeIdsKey ? timeIdsKey.split(',') : []
    if (ids.length === 0) { setNotesByTime({}); return }
    try {
      const notes = await fetchOperationTimeNotes(supabase, ids)
      // Author names merged in from a flat profiles lookup, the same way ModelLinker does it —
      // no embedded relationship that could fail to resolve.
      const authorIds = [...new Set(notes.map((n) => n.created_by).filter((id): id is string => !!id))]
      const nameById = new Map<string, string | null>()
      if (authorIds.length > 0) {
        const { data } = await supabase.from('profiles').select('id, full_name').in('id', authorIds)
        for (const p of data ?? []) nameById.set(p.id, p.full_name)
      }
      const grouped: Record<string, OperationTimeNote[]> = {}
      for (const n of notes) {
        const withAuthor = n.created_by ? { ...n, profiles: { full_name: nameById.get(n.created_by) ?? null } } : n
        ;(grouped[n.operation_time_id] ??= []).push(withAuthor)
      }
      setNotesByTime(grouped)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load notes')
    }
  }, [supabase, timeIdsKey])

  useEffect(() => { loadNotes() }, [loadNotes])

  // Minute drafts follow the records — a reload after a save must not leave a stale draft
  // sitting in an input that no longer matches what's stored.
  useEffect(() => {
    setDrafts(Object.fromEntries(times.map((t) => [t.id, t.totalMinutes != null ? String(t.totalMinutes) : ''])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeIdsKey])

  async function saveMinutes(t: VanTime) {
    const raw = drafts[t.id] ?? ''
    const minutes = Number(raw)
    if (!raw.trim() || Number.isNaN(minutes) || minutes <= 0) { setError('Enter a valid number of minutes'); return }
    setBusyId(t.id); setError(null)
    try {
      await updateOperationTimeMinutes(supabase, t.id, minutes)
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update time')
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete(t: VanTime) {
    setBusyId(t.id); setError(null)
    try {
      await deleteOperationTime(supabase, t.id)
      const wasLast = times.length === 1
      await onChanged()
      // Nothing left to edit — the row that opened this pane no longer has a time.
      if (wasLast) onEmpty()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete time')
    } finally {
      setBusyId(null)
      setConfirmDelete(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && <p style={ERR_BOX}>{error}</p>}

      {times.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No times recorded on this van yet.</p>
      ) : (
        times.map((t) => {
          const isBusy = busyId === t.id
          const draft = drafts[t.id] ?? ''
          const changed = draft.trim() !== '' && draft.trim() !== String(t.totalMinutes ?? '')
          return (
            <div key={t.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{t.operatorName ?? 'Unknown operator'}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmtDate(t.createdAt)}</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <label className="label" style={{ margin: 0 }}>Minutes</label>
                <input
                  type="number" min={0} step="0.1" className="input"
                  style={{ width: 90, padding: '5px 8px', fontSize: 13 }}
                  value={draft}
                  disabled={isBusy}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && changed) saveMinutes(t) }}
                />
                <button
                  type="button" className="btn-primary" style={{ padding: '5px 11px', fontSize: 12 }}
                  disabled={isBusy || !changed}
                  onClick={() => saveMinutes(t)}
                >
                  {isBusy ? '…' : 'Save'}
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setConfirmDelete(t)}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--red)' }}
                >
                  Delete
                </button>
              </div>

              <div>
                <div style={{ ...JOB_LABEL, marginBottom: 6 }}>Notes</div>
                <NoteThread
                  supabase={supabase}
                  timeId={t.id}
                  notes={notesByTime[t.id] ?? []}
                  userId={userId}
                  onRefresh={loadNotes}
                />
              </div>
            </div>
          )
        })
      )}

      <button className="btn-ghost" onClick={onAddTime}>+ Add another time</button>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this time"
          message={`Delete the ${fmtMinutes(confirmDelete.totalMinutes)}m recorded by ${confirmDelete.operatorName ?? 'an unknown operator'} on ${fmtDate(confirmDelete.createdAt)}? Its notes and model links go with it. This cannot be undone.`}
          confirmLabel={busyId === confirmDelete.id ? 'Deleting…' : 'Delete'}
          danger
          onConfirm={() => { if (busyId !== confirmDelete.id) handleDelete(confirmDelete) }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

// ── Manual entry panel: minutes typed in, with an optional operator and note ───────────────
/**
 * The way in for a run nobody stopwatched — the figure is already known, so there's nothing to
 * time. Same write path as a completed timer (recordOperationTime + the optional note), and the
 * same optional operator: "who was timed" is context on a tryout, not a required field.
 */
function CapturePanel({
  supabase, van, target, operators, userId, existing, onSaved,
}: {
  supabase: SupabaseClient
  van: VanContext
  target: CaptureTarget
  operators: OperatorOption[]
  userId: string
  existing: VanTime[]
  onSaved: () => Promise<void>
}) {
  // No default operator — on a tryout the person doing the work changes station to station, so
  // carrying the last pick forward is exactly the mistake to avoid. Picked fresh every time,
  // and legitimately left blank.
  const [operatorId, setOperatorId] = useState('')
  const [minutes, setMinutes] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const minutesValue = Number(minutes)
  const canSave = minutes.trim() !== '' && !Number.isNaN(minutesValue) && minutesValue > 0

  async function handleSave() {
    if (!canSave || !van.productId) return
    setSaving(true); setError(null)
    try {
      const created = await recordOperationTime(supabase, {
        operationId: target.operationId,
        productIds: [van.productId],
        // Blank → null → recorded against the placeholder operator, since
        // operation_times.operator_id is NOT NULL.
        operatorId: operatorId || null,
        collectedBy: userId,
        totalMinutes: minutesValue,
        chassisId: van.chassisId,
      })
      if (note.trim()) {
        await addOperationTimeNote(supabase, created.id, note, userId)
      }
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save time')
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {existing.length > 0 && (
        <div>
          <div style={{ ...JOB_LABEL, marginBottom: 6 }}>Already on this van</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {existing.map((t) => (
              <span key={t.id} style={{ fontSize: 12, color: 'var(--text-mid)' }}>
                {fmtMinutes(t.totalMinutes)}m · {t.operatorName ?? 'Unknown operator'} · {fmtDate(t.createdAt)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div>
        <label className="label">Minutes *</label>
        <input
          type="number" min={0} step="0.1" className="input" style={{ width: '100%' }}
          value={minutes} disabled={saving} autoFocus
          onChange={(e) => setMinutes(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canSave) handleSave() }}
        />
      </div>

      {/* Operator and notes together, both optional and both skippable — the same pair, in the
          same order, as the complete-a-timer confirmation, so the two ways of recording a run
          ask for the same things in the same shape. */}
      <div className="capture-fields">
        <div>
          <label className="label">Operator — who was timed?</label>
          <select style={SEL} value={operatorId} disabled={saving} onChange={(e) => setOperatorId(e.target.value)}>
            <option value="">— None —</option>
            {operators.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
          </select>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
            Optional. Recorded against this van only — the operation&apos;s own primary operator isn&apos;t changed.
          </p>
        </div>

        <div>
          <label className="label">Notes</label>
          <textarea
            className="input" rows={3} style={{ width: '100%', resize: 'vertical' }}
            placeholder="Optional — anything worth remembering about this run"
            value={note} disabled={saving}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>

      {error && <p style={ERR_BOX}>{error}</p>}

      <button className="btn-primary" disabled={!canSave || saving} onClick={handleSave}>
        {saving ? 'Saving…' : 'Save Time'}
      </button>
    </div>
  )
}

// ── Start new tryout: chassis number → model + line ───────────────────────────────────────
function StartTryoutModal({
  supabase, userId, onClose, onResolved,
}: {
  supabase: SupabaseClient
  userId: string
  onClose: () => void
  onResolved: (van: VanContext) => void
}) {
  const [chassisNumber, setChassisNumber] = useState('')
  const [looking, setLooking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const num = chassisNumber.trim()
    if (!num) return
    setLooking(true); setError(null)

    const { data, error: lookupError } = await supabase
      .from('chassis')
      .select('id, chassisnumber, product_id, products ( id, product_code, model, production_line_id )')
      .ilike('chassisnumber', num)
      .limit(1)
    if (lookupError) { setError(lookupError.message); setLooking(false); return }

    const row = ((data ?? [])[0] ?? null) as unknown as RawChassisRow | null
    // Deliberately never creates a chassis row here — an unknown number means the van isn't in
    // the system yet, which is an import/data question, not something to paper over.
    if (!row) { setError(`Chassis "${num}" is not in the system`); setLooking(false); return }

    const context = await buildVanContext(supabase, row, new Map())

    // The tryouts row is what puts this van on the landing list, so it's written here rather
    // than left to the first recorded time — a started tryout with nothing timed on it yet is a
    // normal state.
    try {
      const tryout = await ensureTryout(supabase, row.id, userId)
      setLooking(false)
      onResolved({ ...context, tryoutId: tryout.id, tryoutActive: tryout.is_active })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the tryout')
      setLooking(false)
    }
  }

  return (
    <Modal title="Start new tryout" onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label className="label">Chassis Number *</label>
          <input
            className="input" style={{ width: '100%' }} autoFocus required
            placeholder="e.g. EF0754"
            value={chassisNumber}
            onChange={(e) => setChassisNumber(e.target.value)}
          />
        </div>
        {error && <p style={ERR_BOX}>{error}</p>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={looking || !chassisNumber.trim()}>
            {looking ? 'Looking up…' : 'Open tryout'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

