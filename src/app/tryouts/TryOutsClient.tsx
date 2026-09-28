'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { selectIn } from '@/lib/chunkedIn'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'
import NewOperationModal from '@/components/NewOperationModal'
import { NoteThread } from '@/components/ModelLinker'
import {
  JobsPane, Pane, RenameButton, RunningDot, SectionsPane, UNSECTIONED_KEY, plural,
  type SectionEntry,
} from '@/components/FinderPanes'
import {
  MergeConfirm, MergeFooter, MergeNotices, MergeRowItem, useMergeMode,
  type MergeModeState, type MergeRow,
} from '@/components/MergeMode'
import { useSlideOverDrawer } from '@/components/BulkModelLinkDrawer'
import JobEditDrawer from '@/components/JobEditDrawer'
import OperationEditDrawer from '@/components/OperationEditDrawer'
import {
  chunked, fetchOperationIdsForModel, fetchTimedOperationIdsForModel, jobsApplying,
  linkOperationToModel, linkOperationsToModels, unlinkOperationFromModel,
  unlinkOperationsFromModels, READ_CHUNK,
} from '@/lib/modelOperations'
import {
  addOperationTimeNote, currentByOperation, currentForOperation, deleteOperationTime, historyLabel,
  fetchOperationTimeNotes, recordOperationTime, updateOperationTimeMinutes,
  type OperationTimeStat,
} from '@/lib/operationTimes'
import {
  elapsedSecondsNow, saveTimerRun, useStopwatches, type ActiveTimer,
} from '@/lib/stopwatch'
import {
  CompleteTimerDialog, StartTimerDialog, TimerRail, type CompleteTimerResult, type StartTimerChoice,
} from '@/components/TimerRail'
import { fmtClock, fmtDate, fmtDateTime, fmtMinutes } from '@/lib/format'
import { operationProductKey } from '@/lib/operationTimes'
import {
  canDeleteTime, canEditTime, timeEditBlockedReason, type PermissionActor,
} from '@/lib/permissions'
import { findSectionTray, sortSections, teamForJob } from '@/lib/sections'
import { usePersistedFilter } from '@/lib/useLocalStorage'
import {
  fetchOperators, operatorsForLine, type OperatorOption,
} from '@/lib/operators'
import OperatorSelect from '@/components/OperatorSelect'
import type { Job, Operation, OperationTimeNote, Section, Team, UserRole } from '@/lib/types'

/**
 * Try Outs — the "follow one van down the line" capture flow.
 *
 * Everything past the landing list is scoped to a single chassis: a tryout *is* the set of
 * operation_times carrying that chassis_id. The van's chassis fixes the production line (via
 * chassis → product → production_line_id), and inside that line the screen is the same
 * Finder-style drill-down /setup uses — Team filter, then Sections → Jobs → Operations, the
 * literal same pane components from components/FinderPanes for the first two columns (mounted
 * read-only for sections, and with the job applies-toggle turned on), Unsectioned bucket and all.
 *
 * ── Model applicability ──────────────────────────────────────────────────────────────────
 * Stored in exactly one place, model_operations (operation ↔ product), and nowhere else:
 *   - an OPERATION applies to this van's model iff a model_operations row exists for the pair;
 *   - a JOB applies iff at least one of its operations does — derived, never stored, so the two
 *     can't fall out of step (there is no job→model link and there must not be one);
 *   - a SECTION is line-level structure and is never model-scoped at all. Every section on the line
 *     always shows, whatever the model. The Sections pane here is navigation plus create: a new
 *     section is appended to the line (never to the model), while rename, reorder and delete —
 *     the operations that can disturb a walk other vans are mid-way through — stay on /setup.
 *
 * It is operated at the JOB grain, because that's the unit a van actually differs by: the job
 * toggle in pane 2 writes every operation under it in one bulk call. The per-operation toggle
 * in pane 3 is the fine-grained override for "everything in this job applies except that one".
 * A job with NO operations is the one case there is nothing to write: ticking it opens the
 * add-operation modal for that job instead, pre-linked to this van's model, so the first
 * operation created both fills the job and applies it. Still no job→model flag — the job's
 * "Applies" state simply derives itself on once that operation exists.
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
 * sections, and a pane would only ever show the ones under the current selection — so every
 * running or paused timer ALSO lives in the fixed rail down the right-hand quarter of the
 * screen, where any of them can be paused or completed without navigating back to its
 * operation. The rail and the row are two views of one timer: their Complete buttons call the
 * same handler and open the same operator + notes confirmation. The drill-down panes carry a running dot on the section/job/operation a timer
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

interface Props {
  userId: string
  /** The viewer's profiles.role, read server-side. Used only by the time-detail panel, which
   * gates its edit and delete controls through lib/permissions. */
  role: UserRole | null
}

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
  team_id: string | null; production_line_id: string | null; section_id: string | null; created_at: string
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
  /** Who collected the record — the ownership half of the edit permission (lib/permissions).
   * null is an ownerless imported row, editable by anyone. */
  collectedBy: string | null
  /** null = the current record for its model; set = archived behind that one. Carried so the
   * van log can pick the figure through the shared helper and label the rest as history. */
  supersededBy: string | null
}

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

export default function TryOutsClient({ userId, role }: Props) {
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
  const [sections, setSections] = useState<Section[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [operationsByJob, setOperationsByJob] = useState<Record<string, Operation[]>>({})
  const [lineTeams, setLineTeams] = useState<Team[]>([])
  const [vanTimes, setVanTimes] = useState<VanTime[]>([])
  const [loadingVan, setLoadingVan] = useState(false)
  const [vanError, setVanError] = useState<string | null>(null)
  const [operators, setOperators] = useState<OperatorOption[]>([])
  /** The add-operation modal's target, plus why it opened: 'time' is the Operations pane's
   * "+ Add operation" (create, then straight into Start), 'apply' is pane 2's applies-toggle on
   * a job with no operations yet — see toggleJobApplies. */
  const [newOperationJob, setNewOperationJob] =
    useState<{ jobId: string; jobName: string; intent: 'time' | 'apply' } | null>(null)

  // ── Drill position — persisted, exactly like /setup's, so a refresh comes back to the
  // same operation. The production line is NOT a filter here: the van's chassis fixes it. ──
  const [teamId, setTeamId] = usePersistedFilter('jmotion_tryout_team')
  const [sectionKey, setSectionKey] = usePersistedFilter('jmotion_tryout_section')
  const [jobId, setJobId] = usePersistedFilter('jmotion_tryout_job')
  const [operationId, setOperationId] = usePersistedFilter('jmotion_tryout_operation')

  /**
   * Pane 3's merge mode — the same hook the Sections and Jobs panes mount, at the operation
   * level. Declared up here, above the effects that reset it when the van or the job changes,
   * so those effects can call `cancel()` without reaching forward to a binding that hasn't been
   * initialised yet.
   *
   * Rows come straight off `operationsByJob` rather than the van-scoped `visibleOperations`
   * below: merging is structure work on the JOB, and hiding a duplicate because it doesn't
   * happen to apply to the van currently being walked would leave it unmergeable from here.
   * The group key is job_id, which is the rule lib/mergeOperations enforces.
   */
  const opMergeRows = useMemo<MergeRow<Operation>[]>(
    () => (operationsByJob[jobId] ?? []).map((op) => ({
      id: op.id, name: op.name, groupKey: `job:${op.job_id}`, subject: op,
    })),
    [operationsByJob, jobId]
  )
  const opMerge = useMergeMode({
    level: 'operation',
    supabase,
    userId,
    rows: opMergeRows,
    onMerged: async () => { if (van) await loadVan(van) },
  })

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


  // ── Stopwatches: the shared module, one persisted list across every van ───────────────
  const {
    timers, nowMs, start: startStopwatch, togglePause, restart: restartTimer, discard: discardTimer,
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

  // ── "Who have I timed?": the left-hand log, opposite the timer rail ──────────────────
  const {
    open: timedLogOpen, visible: timedLogVisible,
    openDrawer: openTimedLog, closeDrawer: closeTimedLog,
  } = useSlideOverDrawer()

  /**
   * ── Renaming, on the SHARED editors ────────────────────────────────────────────────
   * The ✎ on a job row and the ✎ on an operation row open components/JobEditDrawer and
   * components/OperationEditDrawer — the same two drawers /setup, /collect and /line-config
   * open from the same icon. This screen used to rename operations with its own inline text
   * field and had no way to rename a job at all; both are gone.
   *
   * The job drawer is opened `nameOnly`: see the note on JobEditDrawer. A re-section can move a
   * job to another team and out of the pane, which is not something a van walk should be able
   * to do by accident.
   */
  const [jobDrawer, setJobDrawer] = useState<Job | null>(null)
  const [operationDrawer, setOperationDrawer] = useState<{ operation: Operation; jobName: string } | null>(null)
  /** What the rename did, shown above the panes — the drawer slides away, so the confirmation
   * has to land somewhere the user is still looking. */
  const [renameNotice, setRenameNotice] = useState<string | null>(null)
  const {
    open: jobDrawerOpen, visible: jobDrawerVisible,
    openDrawer: showJobDrawer, closeDrawer: hideJobDrawer,
  } = useSlideOverDrawer()
  const {
    open: opDrawerOpen, visible: opDrawerVisible,
    openDrawer: showOperationDrawer, closeDrawer: hideOperationDrawer,
  } = useSlideOverDrawer()

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

    // Both chunked (lib/chunkedIn): chassisIds is one id per listed try-out, which is unbounded
    // — a full season's list overflows the ~16KB URL cap on its own. Neither read is ordered and
    // neither is consumed positionally: the first builds a Map by id, the second aggregates.
    let chassisRows: RawChassisRow[]
    let timeRows: { chassis_id: string; created_at: string }[]
    try {
      ;[chassisRows, timeRows] = await Promise.all([
        selectIn<RawChassisRow>(chassisIds, (chunk) => supabase
          .from('chassis')
          .select('id, chassisnumber, product_id, products ( id, product_code, model, production_line_id )')
          .in('id', chunk) as unknown as PromiseLike<{ data: RawChassisRow[] | null; error: { message: string } | null }>),
        // Scoped to the listed chassis rather than every time in the table — the count is a
        // per-card detail now, not the thing that builds the list.
        // Unfiltered: "has this van been worked on, and when" is activity, not labour content.
        selectIn<{ chassis_id: string; created_at: string }>(chassisIds, (chunk) => supabase
          .from('operation_times').select('chassis_id, created_at').in('chassis_id', chunk)),
      ])
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not load try-outs'); setLoadingCards(false); return
    }

    const agg = new Map<string, { count: number; last: string }>()
    for (const t of timeRows) {
      const cur = agg.get(t.chassis_id)
      if (!cur) agg.set(t.chassis_id, { count: 1, last: t.created_at })
      else { cur.count += 1; if (t.created_at > cur.last) cur.last = t.created_at }
    }

    const chassisById = new Map<string, RawChassisRow>()
    for (const row of chassisRows) chassisById.set(row.id, row)

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

  // Every active operator, fetched once with the line each belongs to; the pickers below are
  // handed `lineOperators`, not this.
  useEffect(() => {
    fetchOperators(supabase)
      .then(setOperators)
      .catch(() => setOperators([]))
  }, [supabase])

  /**
   * The only operator list this screen offers anywhere — the van's own production line's.
   * A van is walked by the people on its line, and a run banked against another line's operator
   * is invisible in every per-line rollup that reads it back. A van whose model has no line
   * falls back to everyone, since there is then nothing to scope by.
   */
  const lineOperators = useMemo(
    () => operatorsForLine(operators, van?.productionLineId),
    [operators, van?.productionLineId]
  )

  // ── Van view loader ──────────────────────────────────────────────────────────────────
  /**
   * Everything the columns and the on-van figures are built from, in one pass: this van's own
   * times, its model's applies-list (plus which of those operations are already timed, the
   * guard on un-applying one), and the line's Section → Job → Operation structure.
   *
   * The structure query is /setup's, narrowed to the van's line: sections for the line, jobs on
   * the line OR attached to one of its sections (the section link is the stronger signal for a
   * walk), then that job set's active operations. The Team filter is applied client-side over
   * the loaded jobs, so switching teams doesn't cost a round trip.
   */
  const loadVan = useCallback(async (context: VanContext) => {
    setLoadingVan(true)
    setVanError(null)

    // The van's own times come first — they're keyed by chassis alone, so they load (and the
    // count stays truthful) even when the line structure below turns up empty.
    // Every record this van has, archived ones included: this is the van's log, and the drawer
    // it feeds shows history. superseded_by is selected so currentByOperation can pick the figure.
    const { data: timeRows, error: timesError } = await supabase
      .from('operation_times')
      .select('id, operation_id, operator_id, total_minutes, created_at, superseded_by, collected_by')
      .eq('chassis_id', context.chassisId)
      .order('created_at', { ascending: false })
    if (timesError) { setVanError(timesError.message); setLoadingVan(false); return }
    const times = (timeRows ?? []) as { id: string; operation_id: string; operator_id: string | null; total_minutes: number | null; created_at: string; superseded_by: string | null; collected_by: string | null }[]

    const operatorIds = [...new Set(times.map((t) => t.operator_id).filter((id): id is string => !!id))]
    const operatorNameById = new Map<string, string>()
    if (operatorIds.length > 0) {
      // Chunked (lib/chunkedIn): one id per distinct operator across every time on the van.
      // Feeds a Map, so chunk-order concatenation is irrelevant.
      const opRows = await selectIn<{ id: string; full_name: string }>(operatorIds, (chunk) =>
        supabase.from('operators').select('id, full_name').in('id', chunk))
      for (const o of opRows) operatorNameById.set(o.id, o.full_name)
    }

    setVanTimes(times.map((t) => ({
      id: t.id,
      operationId: t.operation_id,
      totalMinutes: t.total_minutes,
      createdAt: t.created_at,
      supersededBy: t.superseded_by,
      collectedBy: t.collected_by,
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
      setSections([]); setJobs([]); setOperationsByJob({}); setLineTeams([])
      setLoadingVan(false)
      return
    }

    const { data: teamRows } = await supabase
      .from('teams').select('*').eq('production_line_id', context.productionLineId).order('name')
    setLineTeams((teamRows ?? []) as Team[])

    const { data: sectionRows, error: sectionsError } = await supabase
      .from('sections')
      .select('*')
      .eq('production_line_id', context.productionLineId)
      // Retired sections (merged away — see lib/sections' mergeSections) never appear in a list,
      // a pane or a picker.
      .eq('is_active', true)
      .order('sort_order')
    if (sectionsError) { setVanError(sectionsError.message); setLoadingVan(false); return }
    const loadedSections = sortSections((sectionRows ?? []) as Section[])
    setSections(loadedSections)

    // Jobs on this line, plus any job attached to one of this line's sections even if its own
    // production_line_id was never filled in — the section link is the stronger signal for a walk.
    const sectionIds = loadedSections.map((s) => s.id)
    // Retired jobs (merged away — see lib/jobs' mergeJobs) never appear in a pane, a list or a
    // picker, exactly as retired sections and operations don't.
    let jobQuery = supabase.from('jobs').select('*, teams ( id, name )').eq('is_active', true).order('name')
    jobQuery = sectionIds.length > 0
      ? jobQuery.or(`production_line_id.eq.${context.productionLineId},section_id.in.(${sectionIds.join(',')})`)
      : jobQuery.eq('production_line_id', context.productionLineId)
    const { data: jobRows, error: jobsError } = await jobQuery
    if (jobsError) { setVanError(jobsError.message); setLoadingVan(false); return }

    const loadedJobs: Job[] = ((jobRows ?? []) as unknown as RawJob[]).map((r) => ({
      id: r.id, name: r.name, primary_operator_id: r.primary_operator_id,
      team_id: r.team_id, production_line_id: r.production_line_id, section_id: r.section_id,
      created_at: r.created_at,
      teams: one(r.teams),
    }))
    setJobs(loadedJobs)

    const jobIds = loadedJobs.map((j) => j.id)
    if (jobIds.length === 0) { setOperationsByJob({}); setLoadingVan(false); return }

    // Chunked (lib/chunkedIn): jobIds is every job on the van's line, unbounded. is_active and
    // the name ordering stay inside the callback. Chunking splits the JOB list, so every
    // operation for a given job lands in exactly one chunk and the per-job name ordering the
    // grouping below relies on survives — opRows is never read flat.
    let opRows: RawOperation[]
    try {
      opRows = await selectIn<RawOperation>(jobIds, (chunk) => supabase
        .from('operations')
        .select('*, primary_operator:primary_operator_id ( id, full_name ), secondary_operator:secondary_operator_id ( id, full_name )')
        .in('job_id', chunk)
        .eq('is_active', true)
        .order('name') as unknown as PromiseLike<{ data: RawOperation[] | null; error: { message: string } | null }>)
    } catch (err) {
      setVanError(err instanceof Error ? err.message : 'Could not load operations'); setLoadingVan(false); return
    }

    const grouped: Record<string, Operation[]> = {}
    for (const r of opRows) {
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
    opMerge.cancel()
    setShowUnallocated(false); setScopeError(null)
    if (!van) { setSections([]); setJobs([]); setOperationsByJob({}); setVanTimes([]); setVanError(null); return }
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

  /** The current time per operation across THIS van's records — the shared lookup, fed nothing
   * but this chassis's rows, so a "65m · current + 1 archived" here is the same rule as
   * everywhere else. Was an average across runs; see OperationTimeStat for why it isn't. */
  const vanStatByOperation = useMemo(
    () => currentByOperation(vanTimes.map((t) => ({
      id: t.id, operation_id: t.operationId, total_minutes: t.totalMinutes,
      superseded_by: t.supersededBy, created_at: t.createdAt,
    }))),
    [vanTimes]
  )

  // ── Drill-down derivation — the same shape /setup builds, minus the line filter ───────
  /** Every loaded section by id — the lookup teamForJob reads a job's team through. */
  /** Team names for the derived job-team the panes show. */
  const teamNameById = useMemo(() => new Map(lineTeams.map((t) => [t.id, t.name])), [lineTeams])

  const sectionsById = useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections])

  /**
   * The van's line's sections, narrowed by the Team filter. A section belongs to exactly one
   * team and a job's team comes FROM its section, so choosing a team is choosing that team's
   * part of the walk — the same rule /setup and /collect now follow.
   */
  const teamSections = useMemo(
    () => (teamId ? sections.filter((s) => s.team_id === teamId) : sections),
    [sections, teamId]
  )

  /** The Team filter over the jobs, applied to the team DERIVED from each job's section so it
   * agrees with the section list above rather than with whatever jobs.team_id says. */
  const filteredJobs = useMemo(
    () => (teamId ? jobs.filter((j) => teamForJob(j, sectionsById) === teamId) : jobs),
    [jobs, teamId, sectionsById]
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

  /** Loaded jobs bucketed by the pane-1 entry they belong to. A job whose section_id is null, or
   * points at a section outside this line, lands in Unsectioned. */
  /** The unsorted tray jobs fall back to: the scoped TEAM's tray on this van's line. There is
   * one tray per team now, so with no team filtered the line has several and none of them is
   * "the line's" — findSectionTray returns null and the stray jobs land in the virtual bucket
   * below, which is where work belonging to no team in view belongs. */
  const noSectionTray = useMemo(
    () => findSectionTray(sections, van?.productionLineId, teamId),
    [sections, van?.productionLineId, teamId]
  )

  /**
   * Jobs bucketed by the pane-1 row they belong under: their own section when it is in view,
   * otherwise the line's unsorted tray. UNSECTIONED_KEY is the last resort only, for a line
   * whose tray row is missing.
   */
  const jobsBySectionKey = useMemo(() => {
    const map = new Map<string, Job[]>()
    const known = new Set(teamSections.map((s) => s.id))
    const trayKey = noSectionTray && known.has(noSectionTray.id) ? noSectionTray.id : UNSECTIONED_KEY
    for (const job of scopedJobs) {
      const key = job.section_id && known.has(job.section_id) ? job.section_id : trayKey
      const list = map.get(key)
      if (list) list.push(job)
      else map.set(key, [job])
    }
    return map
  }, [scopedJobs, teamSections, noSectionTray])

  /**
   * Pane 1's rows: every section the Team filter leaves in scope, in walk order, plus "No
   * section" at the bottom whenever it holds anything. Still deliberately unaffected by the
   * MODEL — the applies-list and the "show what doesn't apply" toggle never remove a section, so
   * one with no applicable jobs still shows with a count of 0. A line with no sections in scope
   * gets "No section" as its single entry; no empty scaffolding is invented.
   */
  const sectionEntries = useMemo<SectionEntry[]>(() => {
    const entries: SectionEntry[] = teamSections.map((s) => ({
      key: s.id, name: s.name, section: s, jobCount: (jobsBySectionKey.get(s.id) ?? []).length,
    }))
    // Only where a real tray can't stand in — the same rule /setup and /collect follow.
    const strayCount = (jobsBySectionKey.get(UNSECTIONED_KEY) ?? []).length
    if (strayCount > 0 || (teamSections.length === 0 && !teamId)) {
      entries.push({ key: UNSECTIONED_KEY, name: 'No section', section: null, jobCount: strayCount })
    }
    return entries
  }, [teamSections, jobsBySectionKey, teamId])

  // A persisted id can outlive the scope it was chosen in (van changed, section deleted, job
  // moved). Rather than write over the stored value, fall back to "nothing selected" whenever
  // the id isn't among the options actually available right now.
  const activeSectionKey = sectionEntries.some((e) => e.key === sectionKey) ? sectionKey : ''
  const activeSectionEntry = sectionEntries.find((e) => e.key === activeSectionKey) ?? null

  const jobsInSection = useMemo(
    () => (activeSectionKey ? jobsBySectionKey.get(activeSectionKey) ?? [] : []),
    [activeSectionKey, jobsBySectionKey]
  )
  const activeJobId = jobsInSection.some((j) => j.id === jobId) ? jobId : ''
  const selectedJob = jobsInSection.find((j) => j.id === activeJobId) ?? null

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

  /** The running dots on panes 1 and 2 — a section or job is "running" when any operation under
   * it has a timer, so leaving an operation still leaves a trail back to it. */
  const { runningJobIds, runningSectionKeys } = useMemo(() => {
    const jobIds = new Set<string>()
    const sectionKeys = new Set<string>()
    if (vanTimersByOperation.size === 0) return { runningJobIds: jobIds, runningSectionKeys: sectionKeys }

    const knownSections = new Set(sections.map((s) => s.id))
    const jobById = new Map(jobs.map((j) => [j.id, j]))
    for (const [jId, ops] of Object.entries(operationsByJob)) {
      if (!ops.some((o) => vanTimersByOperation.has(o.id))) continue
      jobIds.add(jId)
      const job = jobById.get(jId)
      sectionKeys.add(job?.section_id && knownSections.has(job.section_id) ? job.section_id : UNSECTIONED_KEY)
    }
    return { runningJobIds: jobIds, runningSectionKeys: sectionKeys }
  }, [vanTimersByOperation, operationsByJob, jobs, sections])

  // ── Drill actions ────────────────────────────────────────────────────────────────────
  function selectSection(key: string) { setSectionKey(key); setJobId(''); setOperationId('') }
  function selectJob(id: string) { setJobId(id); setOperationId('') }

  // Changing what pane 3 is showing invalidates any merge selection held against the old job.
  useEffect(() => {
    opMerge.cancel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId])

  // ── Structure writes (panes 1–3) ─────────────────────────────────────────────────────
  async function refreshVan() {
    if (van) await loadVan(van)
  }

  async function addJob(name: string) {
    const trimmed = name.trim()
    if (!trimmed || !activeSectionEntry || !van) return
    setVanError(null)
    // The virtual bucket still lands the job in the line's real tray where one exists, so a job
    // is never created with a null section_id.
    const section = activeSectionEntry.section ?? noSectionTray
    const { data, error } = await supabase.from('jobs').insert({
      name: trimmed,
      // Line comes from the van; the team comes from the SECTION and nowhere else — the same
      // rule setJobSection enforces on a move. A job added to the tray has no team yet.
      production_line_id: van.productionLineId,
      team_id: section?.team_id ?? null,
      section_id: section?.id ?? null,
    }).select('id').single()
    if (error) { setVanError(error.message); return }
    // A job with no operations yet can't apply to the model (applicability is derived from its
    // operations), and the default view hides what doesn't apply — so reveal, or the job would
    // vanish the instant it was created. Its first operation will link automatically.
    if (scoped) setShowUnallocated(true)
    await refreshVan()
    if (data?.id) selectJob(data.id)
  }

  // ── Renaming: open the shared drawers, and the ONE write behind the job one ──────────
  function openJobDrawer(job: Job) {
    setRenameNotice(null)
    setJobDrawer(job)
    showJobDrawer()
  }
  function closeJobDrawer() {
    hideJobDrawer()
    // After the slide-out, so the drawer doesn't blank mid-animation.
    window.setTimeout(() => setJobDrawer(null), 320)
  }

  function openOperationDrawer(operation: Operation, jobName: string) {
    setRenameNotice(null)
    setOperationDrawer({ operation, jobName })
    showOperationDrawer()
  }
  function closeOperationDrawer() {
    hideOperationDrawer()
    window.setTimeout(() => setOperationDrawer(null), 320)
  }

  /**
   * The job drawer's save, name only.
   *
   * The `section` argument is deliberately IGNORED rather than passed to setJobSection: the
   * drawer is opened `nameOnly`, so the user was never shown a section control and re-filing
   * the job is not something this screen may do silently. Nothing else is written — the van's
   * times, the operations' model links and the try-out itself all hang off ids, not the name.
   */
  async function saveJobName(job: Job, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed || trimmed === job.name) return
    setVanError(null)
    const { data, error } = await supabase
      .from('jobs').update({ name: trimmed }).eq('id', job.id).select('id')
    if (error) throw new Error(error.message)
    // Read back: an update filtered out by RLS succeeds having changed nothing, which would
    // otherwise show as a drawer closing on a name that never changed.
    if (!data || data.length === 0) {
      throw new Error('That job could not be renamed — the change was rejected by the database (check your permissions).')
    }
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

    // A job with nothing under it can't be linked — applicability lives on operations, and there
    // are none. Rather than block the tick (which strands a freshly-loaded job), take it as
    // "this job applies, I just haven't written its first operation yet" and open the same
    // add-operation modal the Operations pane uses, scoped to this job and pre-linked to this
    // van's model. Creating that operation both fills the job and applies it, in one step.
    if (operations.length === 0) {
      setJobApplyNotice(null)
      selectJob(job.id)
      setNewOperationJob({ jobId: job.id, jobName: job.name, intent: 'apply' })
      return
    }

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

  // ── Stopwatch actions ────────────────────────────────────────────────────────────────
  /**
   * One timer per operation: the Start button is hidden entirely once this operation has one,
   * so a second run can't be started on top of a first and quietly overwrite it in the bar.
   * Concurrency across DIFFERENT operations (and different jobs and sections) is the point, and
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
          {/* The badge says how many; this says who, on what, and when — the question the
            * drill-down columns can't answer, since they show one operation at a time. */}
          <button
            className="btn-ghost"
            style={{ padding: '6px 11px', fontSize: 12 }}
            title="Every time recorded on this van — or across every van of this model"
            onClick={openTimedLog}
          >
            Who have I timed?
          </button>
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
          onChange={(e) => { setTeamId(e.target.value); setSectionKey(''); setJobId(''); setOperationId('') }}
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
            onClick={() => { setTeamId(''); setSectionKey(''); setJobId(''); setOperationId('') }}
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
      {/* The rename drawer slides away on save, so what it did is reported here — the same
          green line the applicability toggles use, in the same place. */}
      {renameNotice && (
        <div style={{ padding: '9px 14px', borderRadius: 8, background: 'var(--green-bg)', border: '1px solid #bbf7d0', color: '#15803d', fontSize: 13, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>{renameNotice}</span>
          <button
            type="button"
            onClick={() => setRenameNotice(null)}
            aria-label="Dismiss"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 15, lineHeight: 1, color: 'inherit', flexShrink: 0 }}
          >
            ×
          </button>
        </div>
      )}

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
        <p style={EMPTY}>This van&apos;s model isn&apos;t on a production line, so there&apos;s no section structure to walk</p>
      ) : (
        <div className="finder-panes finder-panes-3">
          <SectionsPane
            supabase={supabase}
            entries={sectionEntries}
            sections={sections}
            productionLineId={van.productionLineId}
            productionLineName={van.productionLineName}
            teams={lineTeams}
            selectedKey={activeSectionKey}
            runningKeys={runningSectionKeys}
            // Navigation, plus create. A section is line-level structure — not model-scoped —
            // so rename/reorder/delete stay on /setup: nothing here can renumber the walk or
            // destroy a section out from under the line (a line-wide footgun mid-van-walk).
            // Adding is different — it only ever appends a section to the end of the line, and a
            // van being walked can turn out to need a step the line doesn't have yet, so
            // leaving for /setup to get it would break the walk.
            readOnly
            allowAdd
            // And merge, for the same reason adding survives readOnly: a van walk is exactly
            // where you find two sections that are really one. It folds jobs within a single
            // team and retires the emptied section — no step of the walk is renumbered or
            // destroyed under a van mid-tryout. Same dialog and same lib as /setup and /collect.
            allowMerge
            // The team is already answered by the filter bar above these panes, so the add form
            // doesn't ask again — only "All teams" leaves it with nothing to inherit.
            defaultTeamId={teamId}
            onSelect={selectSection}
            onChanged={refreshVan}
          />

          <JobsPane
            supabase={supabase}
            userId={userId}
            onChanged={refreshVan}
            sectionsById={sectionsById}
            teamNameById={teamNameById}
            entry={activeSectionEntry}
            jobs={jobsInSection}
            loading={loadingVan}
            operationsByJob={operationsByJob}
            selectedJobId={activeJobId}
            runningJobIds={runningJobIds}
            applicability={{
              appliesIds: applyingJobIds,
              targetLabel: van.model ?? 'this model',
              busyJobId: jobApplyBusyId,
              // Nothing to link a job TO until the van's model is known — the only case the
              // toggle is genuinely dead.
              disabledReasons: van.productId
                ? undefined
                : Object.fromEntries(
                    jobsInSection.map((j) => [j.id, 'This van has no model linked to it, so nothing can be applied to it.'])
                  ),
              // A job with no operations keeps its toggle LIVE: applicability is derived from
              // operations, so ticking it opens the add-operation flow for its first one
              // (pre-linked to this model) rather than trying to link nothing.
              toggleHints: Object.fromEntries(
                jobsInSection
                  .filter((j) => (operationsByJob[j.id] ?? []).length === 0)
                  .map((j) => [j.id, `This job has no operations yet — tick to add its first one, applying to ${van.model ?? 'this model'}.`])
              ),
              onToggle: toggleJobApplies,
            }}
            onSelect={selectJob}
            onAdd={addJob}
            // The ✎ between the name and the Applies toggle — the shared JobEditDrawer, the
            // same one /setup and /collect open from the same icon. Applies stays the primary
            // action on the row and is untouched.
            onEdit={openJobDrawer}
            editHint="Rename this job"
          />

          <VanOperationsPane
            job={selectedJob}
            operations={visibleOperations}
            loading={loadingVan}
            van={van}
            scoped={scoped}
            modelOpIds={modelOpIds}
            timesByOperation={timesByOperation}
            vanStatByOperation={vanStatByOperation}
            timersByOperation={vanTimersByOperation}
            nowMs={nowMs}
            timedOnVanCount={timedOnVanCount}
            scopeBusyOpId={scopeBusy}
            selectedOperationId={activeOperationId}
            merge={opMerge}
            mergeRows={opMergeRows}
            onSelect={setOperationId}
            onEdit={(op, job) => openOperationDrawer(op, job.name)}
            onAdd={() => selectedJob && setNewOperationJob({ jobId: selectedJob.id, jobName: selectedJob.name, intent: 'time' })}
            onAllocate={addToModel}
            onDeallocate={requestRemoveFromModel}
            onStart={(op, job) => requestStart({ operationId: op.id, operationName: op.name, jobName: job.name })}
            onTogglePause={togglePause}
            onComplete={requestComplete}
            onOpenTimes={(op, job) => openTimeDetail({ operationId: op.id, operationName: op.name, jobName: job.name })}
            onAddManualTime={(op, job) => openCapture({ operationId: op.id, operationName: op.name, jobName: job.name })}
          />
        </div>
      )}

      {/* ── Renaming: the two SHARED editors, in the same slide-over the other drawers on
        * this screen use. Nothing here writes a time, a model link or the try-out — the job
        * drawer writes jobs.name and the operation drawer goes through lib/operations'
        * renameOperation, which is the only writer of operations.name in the app. ── */}
      {jobDrawerOpen && jobDrawer && (
        <>
          <div className={'gaps-drawer-overlay' + (jobDrawerVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={closeJobDrawer} />
          <div className={'gaps-drawer' + (jobDrawerVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <JobEditDrawer
              job={jobDrawer}
              // Passed so the header can name the job's team correctly; the Section control
              // itself is off — see nameOnly on JobEditDrawer.
              sections={sections}
              teams={lineTeams}
              operationCount={(operationsByJob[jobDrawer.id] ?? []).length}
              nameOnly
              onSave={saveJobName}
              onSaved={(summary) => { setRenameNotice(summary); closeJobDrawer() }}
              onClose={closeJobDrawer}
            />
          </div>
        </>
      )}

      {opDrawerOpen && operationDrawer && (
        <>
          <div className={'gaps-drawer-overlay' + (opDrawerVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={closeOperationDrawer} />
          <div className={'gaps-drawer' + (opDrawerVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <OperationEditDrawer
              operation={operationDrawer.operation}
              jobName={operationDrawer.jobName}
              operators={lineOperators}
              supabase={supabase}
              onSaved={refreshVan}
              onClose={closeOperationDrawer}
            />
          </div>
        </>
      )}

      {/* ── The persistent right-hand rail: every running/paused timer, wherever it was
        * started. Fixed, so it stays put while the panes are scrolled and drilled through. ── */}
      {/* Left-hand slide-over: what has already been recorded, opposite the rail's what is
        * running now. Unmounted when closed, so its queries only run when it is asked for. */}
      {timedLogOpen && (
        <TimedLogPanel
          supabase={supabase}
          van={van}
          visible={timedLogVisible}
          onClose={closeTimedLog}
        />
      )}

      <TimerRail
        timers={timers}
        nowMs={nowMs}
        currentContextKey={van.chassisId}
        onTogglePause={togglePause}
        onRestart={restartTimer}
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
          hint={
            newOperationJob.intent === 'apply'
              // Opened by pane 2's applies-toggle on an empty job: the point of this operation is
              // to BE the thing that makes the job apply, so say that rather than talk about timing.
              ? `Added to ${newOperationJob.jobName} and applied to ${van.model ?? 'this model'} — that first operation is what makes "${newOperationJob.jobName}" apply. Time it whenever you reach it.`
              : `Added to ${newOperationJob.jobName}, then its stopwatch starts straight away for this van. Staff it in Operator later.`
          }
          submitLabel={newOperationJob.intent === 'apply' ? 'Create & Apply' : 'Create & Time'}
          onClose={() => setNewOperationJob(null)}
          onCreated={async (operationId, operationName, jobName) => {
            const intent = newOperationJob.intent
            setNewOperationJob(null)
            await loadVan(van)
            setOperationId(operationId)
            if (intent === 'apply') {
              // The job's "Applies" state is derived, so it flips on by itself the moment this
              // operation lands in the applies-list — nothing to write here. Just say what the
              // tick ended up doing, in the same notice the job toggle uses.
              setJobApplyNotice(
                `"${jobName}" now applies to ${van.model ?? 'this model'} — "${operationName}" was added to it and linked.`
              )
              return
            }
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

      {/* The operation-merge confirmation — the same component the Sections and Jobs panes use,
        * fed by a preflight that has already run. See components/MergeMode. */}
      <MergeConfirm merge={opMerge} />

      {/* ── Start a timer: the shared confirmation, before the clock begins ─────────── */}
      {startTarget && (
        <StartTimerDialog
          operationName={startTarget.operationName}
          jobName={startTarget.jobName}
          contextLabel={van.chassisNumber}
          operators={lineOperators}
          onStart={confirmStart}
          onCancel={() => setStartTarget(null)}
        />
      )}

      {/* ── Complete a timer: the shared operator + run-notes + final-note dialog ─────── */}
      {completingTimer && (
        <CompleteTimerDialog
          timer={completingTimer}
          contextLabel={`${completingTimer.chassisNumber ?? 'this van'} · ${van.model ?? 'this model'}`}
          operators={lineOperators}
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
                operators={lineOperators}
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
                role={role}
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
  job, operations, loading, van, scoped, modelOpIds, timesByOperation, vanStatByOperation,
  timersByOperation, nowMs, timedOnVanCount, scopeBusyOpId, selectedOperationId,
  merge, mergeRows,
  onSelect, onEdit, onAdd, onAllocate, onDeallocate, onStart, onTogglePause, onComplete,
  onOpenTimes, onAddManualTime,
}: {
  job: Job | null
  operations: Operation[]
  loading: boolean
  van: VanContext
  scoped: boolean
  modelOpIds: Set<string>
  timesByOperation: Map<string, VanTime[]>
  vanStatByOperation: Record<string, OperationTimeStat>
  timersByOperation: Map<string, ActiveTimer[]>
  nowMs: number
  timedOnVanCount: number
  /** The operation whose allocation is being written right now, or '__all__' for the bulk
   * allocate — either way its row's toggle is disabled while it's in flight. */
  scopeBusyOpId: string | null
  selectedOperationId: string
  /** The shared merge flow, owned by the screen so it survives this pane's re-renders. */
  merge: MergeModeState
  mergeRows: MergeRow<Operation>[]
  onSelect: (id: string) => void
  /** Opens the SHARED operation editor. This pane used to rename inline with its own text
   * field — the last such divergence in the app — and now does what every other pane does. */
  onEdit: (op: Operation, job: Job) => void
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
}) {
  const subtitle = !job
    ? 'No job selected'
    : merge.active
      ? `${job.name} · ${merge.subtitle}`
      : `${job.name} · ${timedOnVanCount} of ${plural(operations.length, 'operation')} timed on ${van.chassisNumber}`

  return (
    <Pane
      title="Operations"
      subtitle={subtitle}
      active={merge.active ? merge.count > 0 : Boolean(selectedOperationId)}
      footer={
        job ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            {merge.active ? <MergeFooter merge={merge} /> : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={onAdd}>+ Add operation</button>
                {/* The one merge affordance, in the one place it lives on every pane. */}
                <MergeFooter merge={merge} />
              </div>
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
        mergeRows.map((row) => <MergeRowItem key={row.id} merge={merge} row={row} />)
      ) : operations.length === 0 ? (
        <p className="finder-pane-empty">
          {scoped
            ? `No operations in ${job.name} apply to ${van.model ?? 'this model'} — tick “Show what doesn’t apply” above to switch one on, or add a new operation below.`
            : `No operations under ${job.name} yet — add one below.`}
        </p>
      ) : (
        operations.map((op) => {
          const isSelected = op.id === selectedOperationId
          const applies = modelOpIds.has(op.id)
          const times = timesByOperation.get(op.id) ?? []
          const stat = vanStatByOperation[op.id]
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
                  {/* The shared editor, not an inline field — same ✎, same drawer, same
                      lib/operations writer as /setup, /collect and /line-config. */}
                  <RenameButton title="Edit operation" onClick={() => onEdit(op, job)} />
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
                    ✓ {stat
                      ? `${fmtMinutes(stat.minutes)}m${stat.archived > 0 ? ` · +${stat.archived} archived` : ''}`
                      : `${fmtMinutes(times[0].totalMinutes)}m`} on this van
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
  supabase, times, userId, role, onChanged, onEmpty, onAddTime,
}: {
  supabase: SupabaseClient
  times: VanTime[]
  userId: string
  role: UserRole | null
  onChanged: () => Promise<void>
  onEmpty: () => void
  onAddTime: () => void
}) {
  const [notesByTime, setNotesByTime] = useState<Record<string, OperationTimeNote[]>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<VanTime | null>(null)

  /**
   * The same permission rules the /model-total drawer uses, from the same helper — this is the
   * app's OTHER time-editing surface, and two surfaces offering different things for the same
   * record is exactly what one shared helper exists to prevent. A user edits their own records
   * and ownerless ones; only a manager or admin deletes.
   */
  const actor = useMemo<PermissionActor>(() => ({ userId, role }), [userId, role])
  const canDelete = canDeleteTime(actor)

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
        // Chunked (lib/chunkedIn): one id per distinct note author across every note on the
        // van. Feeds a Map, so chunk order is irrelevant.
        const data = await selectIn<{ id: string; full_name: string | null }>(authorIds, (chunk) =>
          supabase.from('profiles').select('id, full_name').in('id', chunk))
        for (const p of data) nameById.set(p.id, p.full_name)
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
          // Ownership is on the record, so this is asked per row rather than once for the panel.
          const canEdit = canEditTime(actor, { collected_by: t.collectedBy })
          const blockedReason = timeEditBlockedReason(actor, { collected_by: t.collectedBy }, t.operatorName)
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
                  disabled={isBusy || !canEdit}
                  title={blockedReason ?? undefined}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && changed && canEdit) saveMinutes(t) }}
                />
                <button
                  type="button" className="btn-primary" style={{ padding: '5px 11px', fontSize: 12 }}
                  disabled={isBusy || !changed || !canEdit}
                  title={blockedReason ?? undefined}
                  onClick={() => saveMinutes(t)}
                >
                  {isBusy ? '…' : 'Save'}
                </button>
                {/* Manager/admin only, and absent rather than disabled — deleting a recorded time
                    is not something a collector may do even to their own work. */}
                {canDelete && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => setConfirmDelete(t)}
                    style={{ marginLeft: 'auto', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--red)' }}
                  >
                    Delete
                  </button>
                )}
              </div>
              {blockedReason && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{blockedReason}</span>
              )}

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

// ── "Who have I timed?" — the read-only log behind the left-hand slide-over ────────────────

/** What the two scopes mean, and what each is labelled. */
type TimedLogScope = 'van' | 'model'

/** One recorded run, flattened for display. Everything is resolved to a name here so the list
 * itself does no lookups while it renders. */
interface TimedLogRow {
  id: string
  operationId: string
  operationName: string
  jobName: string | null
  operatorName: string | null
  chassisNumber: string | null
  /** Whose team this run's work belongs to — derived section-first, see teamForJob. */
  teamId: string | null
  teamName: string | null
  totalMinutes: number | null
  createdAt: string
  notes: string[]
}

interface TimedLogData {
  rows: TimedLogRow[]
  /** avg + runs keyed by operation id, over exactly the rows above — so "typical" means
   * typical for the scope being looked at, not some other population. */
  statByOperation: Record<string, OperationTimeStat>
}

const EMPTY_TIMED_LOG: TimedLogData = { rows: [], statByOperation: {} }

/** The team dropdown's value for "runs whose job has no team at all" — a real state (an
 * unsectioned job on a line that predates teams), and distinct from '' meaning All teams. */
const NO_TEAM_KEY = '__no_team__'

/**
 * Every run recorded against this van, or against this van's MODEL across every van of it.
 *
 * Strictly read-only: it opens no editor and writes nothing. Editing and deleting a time
 * already have one home — the per-operation time drawer on pane 3 — and a second write path
 * over the same rows is how two screens end up disagreeing about what was recorded. This
 * answers "who have I timed, and on what?", which the columns can't: they show one operation at
 * a time, and the answer spans all of them.
 *
 * Names are resolved with the same batched `.in()` lookups loadVan uses rather than embedded
 * relationships (see lib/operationTimes' note on why), chunked through READ_CHUNK because the
 * model scope's id list is unbounded — a popular model has years of times across dozens of vans.
 */
async function fetchTimedLog(
  supabase: SupabaseClient,
  van: VanContext,
  scope: TimedLogScope
): Promise<TimedLogData> {
  interface RawTime {
    id: string; operation_id: string; operator_id: string | null; chassis_id: string | null
    total_minutes: number | null; created_at: string; superseded_by: string | null
  }
  // Unfiltered by superseded_by throughout this function, deliberately: the timed log IS the
  // history. The column is selected so the figure below can be picked by the shared helper.
  const TIME_COLUMNS = 'id, operation_id, operator_id, chassis_id, total_minutes, created_at, superseded_by'

  let times: RawTime[] = []
  /** The (time, product) links behind the model scope — kept because currentForOperation is
   * defined over them, not over the times alone. */
  let timeModels: { operation_time_id: string; product_id: string }[] = []

  if (scope === 'van') {
    const { data, error } = await supabase
      .from('operation_times')
      .select(TIME_COLUMNS)
      .eq('chassis_id', van.chassisId)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    times = (data ?? []) as RawTime[]
  } else {
    if (!van.productId) return EMPTY_TIMED_LOG
    // operation_times carries no product_id — which model a run counts for lives entirely in
    // the junction, so the model scope starts there and reads the times back by id.
    const { data: linkRows, error: linkError } = await supabase
      .from('operation_time_models')
      .select('operation_time_id, product_id')
      .eq('product_id', van.productId)
    if (linkError) throw new Error(linkError.message)
    timeModels = (linkRows ?? []) as { operation_time_id: string; product_id: string }[]

    const timeIds = [...new Set(timeModels.map((l) => l.operation_time_id))]
    if (timeIds.length === 0) return EMPTY_TIMED_LOG

    for (const batch of chunked(timeIds, READ_CHUNK)) {
      const { data, error } = await supabase.from('operation_times').select(TIME_COLUMNS).in('id', batch)
      if (error) throw new Error(error.message)
      times.push(...((data ?? []) as RawTime[]))
    }
    // Sorted here rather than by the query: the rows arrive one batch at a time, so ordering
    // per batch would interleave into something that only looks sorted.
    times.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  if (times.length === 0) return EMPTY_TIMED_LOG

  // ── Names, in batched lookups keyed by the ids actually present ──
  async function lookup<T>(table: string, columns: string, ids: string[]): Promise<T[]> {
    if (ids.length === 0) return []
    const out: T[] = []
    for (const batch of chunked(ids, READ_CHUNK)) {
      const { data, error } = await supabase.from(table).select(columns).in('id', batch)
      if (error) throw new Error(error.message)
      out.push(...((data ?? []) as unknown as T[]))
    }
    return out
  }

  const operationRows = await lookup<{ id: string; name: string; job_id: string | null }>(
    'operations', 'id, name, job_id',
    [...new Set(times.map((t) => t.operation_id))]
  )
  const operationById = new Map(operationRows.map((o) => [o.id, o]))

  // section_id rides along with the name: a run's team is derived from the job's SECTION, so
  // that is the only column needed — jobs.team_id is never consulted.
  const jobRows = await lookup<{ id: string; name: string; section_id: string | null }>(
    'jobs', 'id, name, section_id',
    [...new Set(operationRows.map((o) => o.job_id).filter((id): id is string => !!id))]
  )
  const jobById = new Map(jobRows.map((j) => [j.id, j]))

  // Team lives on the SECTION (see lib/sections' teamForJob), so the sections behind these jobs
  // are the whole of the derivation; a job in the line's unsorted tray has no team yet.
  const sectionRows = await lookup<{ id: string; team_id: string | null }>(
    'sections', 'id, team_id',
    [...new Set(jobRows.map((j) => j.section_id).filter((id): id is string => !!id))]
  )
  const sectionById = new Map(sectionRows.map((st) => [st.id, st]))

  const teamIdByJobId = new Map(jobRows.map((j) => [j.id, teamForJob(j, sectionById)]))
  const teamRows = await lookup<{ id: string; name: string }>(
    'teams', 'id, name',
    [...new Set([...teamIdByJobId.values()].filter((id): id is string => !!id))]
  )
  const teamNameById = new Map(teamRows.map((t) => [t.id, t.name]))

  const operatorRows = await lookup<{ id: string; full_name: string }>(
    'operators', 'id, full_name',
    [...new Set(times.map((t) => t.operator_id).filter((id): id is string => !!id))]
  )
  const operatorNameById = new Map(operatorRows.map((o) => [o.id, o.full_name]))

  // Only the model scope spans more than one van, so only it needs to say which.
  const chassisRows = scope === 'model'
    ? await lookup<{ id: string; chassisnumber: string }>(
      'chassis', 'id, chassisnumber',
      [...new Set(times.map((t) => t.chassis_id).filter((id): id is string => !!id))]
    )
    : []
  const chassisNumberById = new Map(chassisRows.map((c) => [c.id, c.chassisnumber]))

  // ── Notes, through the shared fetcher, grouped back onto their run ──
  const notesByTimeId = new Map<string, string[]>()
  for (const batch of chunked(times.map((t) => t.id), READ_CHUNK)) {
    for (const note of await fetchOperationTimeNotes(supabase, batch)) {
      const list = notesByTimeId.get(note.operation_time_id) ?? []
      list.push(note.content)
      notesByTimeId.set(note.operation_time_id, list)
    }
  }

  const rows: TimedLogRow[] = times.map((t) => {
    const operation = operationById.get(t.operation_id)
    const job = operation?.job_id ? jobById.get(operation.job_id) ?? null : null
    const teamId = job ? teamIdByJobId.get(job.id) ?? null : null
    return {
      id: t.id,
      operationId: t.operation_id,
      operationName: operation?.name ?? 'Unknown operation',
      jobName: job?.name ?? null,
      teamId,
      teamName: teamId ? teamNameById.get(teamId) ?? null : null,
      operatorName: t.operator_id ? operatorNameById.get(t.operator_id) ?? null : null,
      chassisNumber: t.chassis_id ? chassisNumberById.get(t.chassis_id) ?? null : null,
      totalMinutes: t.total_minutes,
      createdAt: t.created_at,
      notes: notesByTimeId.get(t.id) ?? [],
    }
  })

  // The van scope is one chassis's records, so the per-operation current time is the right one;
  // the model scope is defined by the junction, so it goes through the (operation, product)
  // lookup and is re-keyed by operation id — the product is fixed at this van's, so the pair
  // collapses.
  let statByOperation: Record<string, OperationTimeStat> = {}
  if (scope === 'van') {
    statByOperation = currentByOperation(times)
  } else if (van.productId) {
    const byPair = currentForOperation(times, timeModels)
    for (const [key, stat] of Object.entries(byPair)) {
      const [operationId, productId] = key.split(':')
      if (productId === van.productId) statByOperation[operationId] = stat
    }
  }

  return { rows, statByOperation }
}

/**
 * The left-hand slide-over. Mirrors the timer rail's side of the screen deliberately: the rail
 * on the right is what is running NOW, this on the left is what has already been recorded, and
 * both can be open at once without one covering the other.
 *
 * Refetches whenever the scope is switched — the two scopes are different queries over
 * different key columns (chassis_id vs the operation_time_models junction), not one result
 * filtered two ways, so there is nothing to cache between them.
 */
function TimedLogPanel({
  supabase, van, visible, onClose,
}: {
  supabase: SupabaseClient
  van: VanContext
  /** Drives the slide-in class; mounting and unmounting is the caller's (useSlideOverDrawer). */
  visible: boolean
  onClose: () => void
}) {
  const [scope, setScope] = useState<TimedLogScope>('van')
  const [teamFilter, setTeamFilter] = useState('')
  const [data, setData] = useState<TimedLogData>(EMPTY_TIMED_LOG)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    fetchTimedLog(supabase, van, scope)
      .then((result) => { if (!cancelled) setData(result) })
      .catch((err) => {
        if (!cancelled) {
          setData(EMPTY_TIMED_LOG)
          setError(err instanceof Error ? err.message : 'Could not load the recorded times')
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [supabase, van, scope])

  const { rows, statByOperation } = data

  /**
   * Only the teams that actually have times in the current scope — an option that would filter
   * to nothing is worse than no option at all, and which teams have been timed is itself part
   * of the answer this panel gives.
   */
  const teamOptions = useMemo(() => {
    const byId = new Map<string, string>()
    let hasUnteamed = false
    for (const row of rows) {
      if (row.teamId) byId.set(row.teamId, row.teamName ?? 'Unnamed team')
      else hasUnteamed = true
    }
    const options = [...byId.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
    if (hasUnteamed) options.push({ key: NO_TEAM_KEY, label: 'No team' })
    return options
  }, [rows])

  // Switching scope changes which teams are represented, and a filter left pointing at a team
  // that has no times in the new scope would show an empty list with no visible cause.
  useEffect(() => {
    if (teamFilter && !teamOptions.some((o) => o.key === teamFilter)) setTeamFilter('')
  }, [teamOptions, teamFilter])

  const visibleRows = useMemo(() => {
    if (!teamFilter) return rows
    if (teamFilter === NO_TEAM_KEY) return rows.filter((r) => !r.teamId)
    return rows.filter((r) => r.teamId === teamFilter)
  }, [rows, teamFilter])

  const totalMinutes = visibleRows.reduce((sum, r) => sum + (r.totalMinutes ?? 0), 0)
  const operationCount = new Set(visibleRows.map((r) => r.operationId)).size
  const modelLabel = van.model ?? 'this model'
  const teamLabel = teamOptions.find((o) => o.key === teamFilter)?.label ?? null

  // Both halves of what is being counted, in one line: the scope, then the team narrowing it.
  const summary = loading
    ? 'Loading…'
    : (scope === 'van'
      ? `${plural(visibleRows.length, 'time')} on this van`
      : `${plural(visibleRows.length, 'time')} for ${modelLabel}`)
      + (teamLabel ? ` · ${teamLabel}` : '')

  return (
    <>
      <div className={'gaps-drawer-overlay' + (visible ? ' gaps-drawer-overlay-visible' : '')} onClick={onClose} />
      <div
        className={'gaps-drawer gaps-drawer-left' + (visible ? ' gaps-drawer-visible' : '')}
        style={DRAWER_WIDTH}
        role="dialog"
        aria-label="Who have I timed?"
      >
        <div className="gaps-drawer-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="gaps-drawer-title">Who have I timed?</div>
            <div className="gaps-drawer-jobname">
              {van.chassisNumber} · {modelLabel}
            </div>
          </div>
          <button className="gaps-drawer-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scope, and what it currently adds up to. The two are together because the summary is
          * only meaningful alongside the scope it counts — "12 times" means nothing on its own. */}
        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div role="group" aria-label="Which times to show" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {([
              { key: 'van' as const, label: 'This van', title: `Only times recorded against ${van.chassisNumber}` },
              { key: 'model' as const, label: `All times for ${modelLabel}`, title: `Every time recorded for ${modelLabel}, across every van of it` },
            ]).map((option) => {
              const active = scope === option.key
              return (
                <button
                  key={option.key}
                  type="button"
                  className={active ? 'btn-primary' : 'btn-ghost'}
                  style={{ padding: '6px 12px', fontSize: 12 }}
                  aria-pressed={active}
                  title={option.title}
                  // Switching to the model scope with no model would query nothing; the button
                  // says why rather than silently returning an empty list.
                  disabled={option.key === 'model' && !van.productId}
                  onClick={() => setScope(option.key)}
                >
                  {option.label}
                </button>
              )
            })}
          </div>

          {/* Narrows whichever scope is selected — the two compose, they don't replace each
            * other. Only rendered once there is more than one team to choose between: with a
            * single team every option would be the whole list. */}
          {teamOptions.length > 1 && (
            <select
              style={{ ...SEL, fontSize: 12, padding: '6px 9px' }}
              value={teamFilter}
              aria-label="Filter these times by team"
              onChange={(e) => setTeamFilter(e.target.value)}
            >
              <option value="">All teams</option>
              {teamOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{summary}</span>
            {!loading && visibleRows.length > 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {plural(operationCount, 'operation')} · {fmtMinutes(totalMinutes)} minutes total
              </span>
            )}
            {!van.productId && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                This van has no model linked, so there is no model-wide view of it.
              </span>
            )}
          </div>
        </div>

        <div className="gaps-drawer-body">
          {error ? (
            <p style={{ ...ERR_BOX, margin: '12px 20px' }}>{error}</p>
          ) : loading ? (
            <p className="finder-pane-empty">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="finder-pane-empty">
              {scope === 'van'
                ? `Nothing has been timed on ${van.chassisNumber} yet. Start a stopwatch on an operation and it will appear here.`
                : `No times have been recorded for ${modelLabel} on any van yet.`}
            </p>
          ) : visibleRows.length === 0 ? (
            // Only reachable in the moment before the effect above clears a stale filter, but
            // "nothing timed yet" would be the wrong thing to say while a filter is on.
            <p className="finder-pane-empty">
              None of these {plural(rows.length, 'time')} belong to {teamLabel ?? 'that team'}. Choose All teams to see them.
            </p>
          ) : (
            visibleRows.map((row) => {
              const stat = statByOperation[row.operationId]
              return (
                <div key={row.id} className="gaps-drawer-item">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', wordBreak: 'break-word' }}>
                        {row.operationName}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', wordBreak: 'break-word' }}>
                        {row.jobName ?? 'No job'}
                        {/* Named only while the list is mixed — with a team chosen it's on
                          * every row and says nothing the summary hasn't already said. */}
                        {!teamFilter && teamOptions.length > 1 && <> · {row.teamName ?? 'No team'}</>}
                        {/* Only the model scope spans vans, so only it names one. */}
                        {scope === 'model' && <> · {row.chassisNumber ?? 'No van'}</>}
                      </span>
                    </div>
                    <span className="badge badge-blue" style={{ flexShrink: 0 }}>{fmtMinutes(row.totalMinutes)}m</span>
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--text-mid)' }}>
                    <span style={{ fontWeight: 600 }}>
                      Timed: {row.operatorName ?? 'No operator recorded'}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>{fmtDateTime(row.createdAt)}</span>
                    {/* Which record is the live figure, and how much sits behind it. Only worth
                        showing once this pair has more than the one record. */}
                    {stat && stat.archived > 0 && (
                      <span className="badge badge-grey">{fmtMinutes(stat.minutes)}m {historyLabel(stat)}</span>
                    )}
                  </div>

                  {row.notes.length > 0 && (
                    <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {row.notes.map((note, index) => (
                        <li key={index} style={{ fontSize: 12, color: 'var(--text-mid)', wordBreak: 'break-word' }}>{note}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </>
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
  /** Already scoped to the van's production line by the host. */
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
          <OperatorSelect
            operators={operators}
            value={operatorId}
            disabled={saving}
            ariaLabel="Operator who was timed"
            onChange={setOperatorId}
          />
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
            Optional, and only this van&apos;s production line. Recorded against this van only — the
            operation&apos;s own primary operator isn&apos;t changed.
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

