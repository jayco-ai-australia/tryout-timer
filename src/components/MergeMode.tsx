'use client'

import { useCallback, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import ConfirmDialog from './ConfirmDialog'
import { plural } from '@/lib/format'
import {
  mergeSections, preflightSectionMerge, strandedSectionMergeMessage,
} from '@/lib/sections'
import { mergeJobs, preflightJobMerge } from '@/lib/jobs'
import {
  blockedMergeMessage, mergeOperations, preflightMerge, strandedMergeMessage,
} from '@/lib/mergeOperations'
import type { Job, Operation, Section } from '@/lib/types'

/**
 * THE merge affordance — one multi-select pattern, three levels of the walk, three screens.
 *
 * Every Finder pane that can merge (Sections, Jobs, Operations, on /setup, /collect and
 * /tryouts) mounts this module and nothing else. There is no per-row Merge link anywhere any
 * more, no per-screen merge toolbar, and no second dialog: the checkboxes, the primary picker,
 * the confirmation and the result banner are all here, parameterised by `level`.
 *
 * ── The flow, identical everywhere ────────────────────────────────────────────────────────
 *   1. A "Merge" button at the BOTTOM of the pane, beside "+ Add …".
 *   2. It puts that pane — and only that pane — into merge mode: rows become checkboxes, the
 *      pane header carries a count, and Cancel is always one click away.
 *   3. Tick two or more rows.
 *   4. Nominate the PRIMARY explicitly. It starts unset and stays unset: no defaulting to the
 *      first ticked, no alphabetical guess. Which row survives is the one irreversible decision
 *      in a merge, and it is not one to be made by ordering.
 *   5. Preflight, then a confirmation that states real numbers, then the write.
 *
 * ── What the pane may offer ───────────────────────────────────────────────────────────────
 * A row carries a `groupKey`: sections may only merge with sections on the same team and line,
 * jobs only within one section, operations only within one job. The first tick LOCKS the group,
 * and rows outside it go disabled with a reason rather than silently vanishing — a merge that
 * can't be offered should say why. Every rule is re-checked in the write path too (see each
 * level's lib module); the UI is not the only way in.
 *
 * ── The guard differs by level, and that is deliberate ────────────────────────────────────
 * The time-ownership guard — blocked if any time in the selection belongs to a different real
 * user, ownerless (null collected_by) times treated as mergeable — belongs to whatever moves an
 * operation_times row. That is the OPERATION merge, and the same-name FOLDS a job merge performs
 * (see lib/jobs), which is why the job level asks for a userId too. A section merge repoints
 * section_id and flips is_active; it never touches a recorded time, so it is never refused on
 * ownership grounds. See the notes at the top of lib/sections and lib/jobs.
 *
 * ── Preflight, always ─────────────────────────────────────────────────────────────────────
 * All three levels preflight BEFORE the confirmation opens, so the dialog states what the write
 * will actually do rather than a generic promise. /collect already worked this way; /setup and
 * /tryouts used to open their operation-merge confirmation blind, and now don't.
 */

export type MergeLevel = 'section' | 'job' | 'operation'

/** One row offered to merge mode, carrying the domain object the write path needs. */
export interface MergeRow<T> {
  id: string
  name: string
  /**
   * Rows may only be merged with others sharing this key — team+line for a section, section for
   * a job, job for an operation. null means the row can never be merged (the unsorted tray).
   */
  groupKey: string | null
  /** Shown on a permanently ineligible row instead of a checkbox. */
  ineligibleReason?: string
  subject: T
}

type MergeModeConfig =
  | { level: 'section'; supabase: SupabaseClient; rows: MergeRow<Section>[]; onMerged: (message: string) => Promise<void> | void }
  | {
      level: 'job'
      supabase: SupabaseClient
      /**
       * Whose merge this is. A job merge FOLDS same-named operations together (see lib/jobs), and
       * a fold moves recorded times — so the operation-level ownership guard applies here too and
       * needs to know who is asking.
       */
      userId: string
      rows: MergeRow<Job>[]
      onMerged: (message: string) => Promise<void> | void
    }
  | {
      level: 'operation'
      supabase: SupabaseClient
      /** Whose merge this is — the operation-level ownership guard needs to know who is asking. */
      userId: string
      rows: MergeRow<Operation>[]
      onMerged: (message: string) => Promise<void> | void
    }

/** Per-level wording. The nouns are the only thing that changes between the three flows. */
const LEVEL_META: Record<MergeLevel, {
  noun: string
  /** What lives one level down, and therefore what moves. */
  childNoun: string | null
  /** The pane a follow-up merge would be run from. */
  childPane: string | null
  /** How rows are constrained — said out loud when a row is disabled. */
  scope: string
}> = {
  section: { noun: 'section', childNoun: 'job', childPane: 'Jobs', scope: 'the same team' },
  job: { noun: 'job', childNoun: 'operation', childPane: 'Operations', scope: 'the same section' },
  operation: { noun: 'operation', childNoun: null, childPane: null, scope: 'the same job' },
}

/** What the confirmation renders — built by the level's own preflight, then forgotten. */
interface MergePlan {
  keeperName: string
  retiredNames: string[]
  /** The count the dialog quotes, in `movingNoun` units. */
  movingCount: number
  movingNoun: string
  /** Extra sentence for a level that moves more than one kind of thing. */
  extraNote: string | null
  /** Child names that will sit side by side in the keeper, needing a merge one level down.
   * Section level only — a job merge fuses same-named operations rather than stacking them. */
  duplicateNames: string[]
  /**
   * Job level only: the operations that will FOLD INTO a same-named operation on the keeper
   * instead of landing beside it. Named, counted, and said BEFORE it happens — folding moves
   * recorded times between operations, which is the one part of a job merge the app cannot undo.
   */
  combining: {
    /** How many operations fold. Can exceed `names.length` — two folded-away jobs both holding
     * "PSCL" are two folds onto one name. */
    count: number
    /** The distinct names they fold onto, sorted. */
    names: string[]
    /** How many operations move across untouched. */
    otherCount: number
    /** Operations retired on the keeper that a live one folds into, so they come back into view. */
    reactivatingNames: string[]
  } | null
}

export interface MergeModeState {
  level: MergeLevel
  active: boolean
  start: () => void
  cancel: () => void
  selectedIds: Set<string>
  toggle: (id: string) => void
  primaryId: string | null
  setPrimary: (id: string) => void
  /** null when the row can be ticked; otherwise why it can't. */
  disabledReason: (id: string) => string | null
  count: number
  busy: boolean
  error: string | null
  notice: string | null
  dismissNotice: () => void
  /** What the pane header appends while merge mode is on. */
  subtitle: string
  /** Whether this pane has enough rows for a merge to be possible at all. */
  offerable: boolean
  // Internals the exported components read.
  _plan: MergePlan | null
  _requestMerge: () => void
  _runMerge: () => void
  _closePlan: () => void
}

/**
 * The whole merge flow as one hook. Owns the mode, the selection, the primary, the preflight,
 * the write and what to say afterwards — so a pane contributes markup and nothing else.
 */
export function useMergeMode(config: MergeModeConfig): MergeModeState {
  const { level, rows, onMerged } = config
  const meta = LEVEL_META[level]

  const [active, setActive] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [primaryId, setPrimaryId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [plan, setPlan] = useState<MergePlan | null>(null)

  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])

  /** The group the selection has locked onto, if anything is ticked yet. */
  const lockedGroup = useMemo(() => {
    for (const id of selectedIds) {
      const row = rowById.get(id)
      if (row) return row.groupKey
    }
    return null
  }, [selectedIds, rowById])

  /** Rows still present AND still ticked. One deleted or moved away under the selection must
   * never be written to. */
  const selectedRows = useMemo(
    () => rows.filter((r) => selectedIds.has(r.id)),
    [rows, selectedIds]
  )

  const reset = useCallback(() => {
    setSelectedIds(new Set())
    setPrimaryId(null)
    setPlan(null)
    setError(null)
  }, [])

  const start = useCallback(() => {
    reset()
    setNotice(null)
    setActive(true)
  }, [reset])

  const cancel = useCallback(() => {
    reset()
    setActive(false)
  }, [reset])

  function toggle(id: string) {
    const row = rowById.get(id)
    if (!row || row.groupKey === null) return
    setError(null)
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
    // The primary must always be one of the ticked rows. Untick it and the choice is simply
    // gone — it is NOT silently reassigned to whatever is left, because which row survives is
    // the decision this flow exists to make explicit.
    if (primaryId && !next.has(primaryId)) setPrimaryId(null)
  }

  function disabledReason(id: string): string | null {
    const row = rowById.get(id)
    if (!row) return null
    if (row.groupKey === null) return row.ineligibleReason ?? `This ${meta.noun} can’t be merged.`
    if (lockedGroup !== null && row.groupKey !== lockedGroup && !selectedIds.has(id)) {
      return `Not on ${meta.scope} as what you’ve already ticked — a merge can only fold ${meta.noun}s together within ${meta.scope}.`
    }
    return null
  }

  /** Merge needs two rows to fold together, and at least two that could ever be partners. */
  const offerable = rows.filter((r) => r.groupKey !== null).length > 1

  const keeperRow = primaryId ? selectedRows.find((r) => r.id === primaryId) ?? null : null
  const mergedRows = keeperRow ? selectedRows.filter((r) => r.id !== keeperRow.id) : []

  /** Preflight, then open the confirmation. Nothing is written here. */
  async function requestMerge() {
    if (!keeperRow || mergedRows.length === 0) return
    setBusy(true); setError(null)
    try {
      const retiredNames = mergedRows.map((r) => r.name)
      let next: MergePlan
      if (config.level === 'section') {
        const keeper = keeperRow.subject as Section
        const merged = mergedRows.map((r) => r.subject as Section)
        const pre = await preflightSectionMerge(config.supabase, { keeper, merged })
        next = {
          keeperName: keeperRow.name,
          retiredNames,
          movingCount: pre.visibleJobs.length,
          movingNoun: 'job',
          extraNote: pre.operationCount > 0
            ? `${plural(pre.operationCount, 'operation')} ride along with those jobs — nothing about them is written.`
            : null,
          duplicateNames: pre.duplicateNames,
          combining: null,
        }
      } else if (config.level === 'job') {
        const keeper = keeperRow.subject as Job
        const merged = mergedRows.map((r) => r.subject as Job)
        const pre = await preflightJobMerge(config.supabase, { keeper, merged, userId: config.userId })
        // Refusable at this level now, for the same reason the operation level is: a fold moves
        // recorded times. Stop before offering a confirmation — there is nothing to confirm.
        if (pre.blockers.length > 0) { setError(blockedMergeMessage(pre.blockers)); return }
        next = {
          keeperName: keeperRow.name,
          retiredNames,
          movingCount: pre.visibleOperations.length,
          movingNoun: 'operation',
          extraNote: 'Recorded times, notes and model links ride along with their operation — nothing about them is written.',
          duplicateNames: [],
          combining: pre.combining.length === 0 ? null : {
            count: pre.visibleCombiningCount,
            names: pre.combiningNames,
            otherCount: pre.visibleReparentingCount,
            reactivatingNames: pre.reactivatingNames,
          },
        }
      } else {
        const merged = mergedRows.map((r) => r.subject as Operation)
        const pre = await preflightMerge(config.supabase, merged, config.userId)
        // The one level that can be refused outright. Stop before offering a confirmation:
        // there is nothing to confirm, and the message names what is holding it up.
        if (pre.blockers.length > 0) { setError(blockedMergeMessage(pre.blockers)); return }
        next = {
          keeperName: keeperRow.name,
          retiredNames,
          movingCount: pre.totalTimes,
          movingNoun: 'recorded time',
          extraNote: pre.totalNotes > 0
            ? `${plural(pre.totalNotes, 'note')} on those times move with them. Nothing is re-collected, edited or deleted — the times only change which operation they belong to.`
            : 'Nothing is re-collected, edited or deleted — the times only change which operation they belong to.',
          duplicateNames: [],
          combining: null,
        }
      }
      setPlan(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not work out what this merge would move')
    } finally {
      setBusy(false)
    }
  }

  /** The write. Every level is all-or-nothing on its own writes — see each lib module. */
  async function runMerge() {
    if (!keeperRow || mergedRows.length === 0) return
    setBusy(true); setError(null)
    try {
      const retired = mergedRows.map((r) => r.name)
      let summary: string
      let stranded: string[]
      let strandedMessage: string

      if (config.level === 'section') {
        const result = await mergeSections(config.supabase, {
          keeper: keeperRow.subject as Section,
          merged: mergedRows.map((r) => r.subject as Section),
        })
        summary = mergeMessage('section', keeperRow.name, retired, result.movedJobs, 'job', result.duplicateNames, 'job', 'Jobs')
        stranded = result.stranded
        strandedMessage = strandedSectionMergeMessage(result.stranded)
      } else if (config.level === 'job') {
        const result = await mergeJobs(config.supabase, {
          keeper: keeperRow.subject as Job,
          merged: mergedRows.map((r) => r.subject as Job),
          userId: config.userId,
        })
        summary = mergeMessage('job', keeperRow.name, retired, result.movedOperations, 'operation', [], null, null)
        if (result.combinedOperations > 0) {
          summary +=
            ` ${plural(result.combinedOperations, 'operation')} combined with operations of the same name ` +
            `already on "${keeperRow.name}" (${result.combinedNames.map((n) => `"${n}"`).join(', ')}) — ` +
            'their times moved across.'
        }
        // Nothing to strand any more: a job merge either completes or is rewound. See lib/jobs.
        stranded = []
        strandedMessage = ''
      } else {
        const result = await mergeOperations(config.supabase, {
          keeper: keeperRow.subject as Operation,
          dups: mergedRows.map((r) => r.subject as Operation),
          userId: config.userId,
        })
        summary = mergeMessage('operation', keeperRow.name, retired, null, null, [], null, null)
        stranded = result.stranded
        strandedMessage = strandedMergeMessage(result.stranded)
      }

      setPlan(null)
      if (stranded.length > 0) {
        // A partial result is reported as an error, not a success: something the user asked for
        // did not happen, and the list they are about to see won't show it.
        setError(strandedMessage)
        setSelectedIds(new Set())
        setPrimaryId(null)
        await onMerged(summary)
      } else {
        setNotice(summary)
        setActive(false)
        setSelectedIds(new Set())
        setPrimaryId(null)
        await onMerged(summary)
      }
    } catch (err) {
      setPlan(null)
      setError(err instanceof Error ? err.message : 'Merge failed')
      // The list is reloaded either way — a merge that threw part-way through has still left the
      // rows that did move where they moved to, and showing stale ones would be worse.
      await onMerged('')
    } finally {
      setBusy(false)
    }
  }

  const count = selectedRows.length
  const subtitle = count === 0
    ? 'merge — tick two or more'
    : primaryId
      ? `merge — keeping “${keeperRow?.name ?? '—'}”, retiring ${count - 1}`
      : `merge — ${count} ticked, no keeper picked`

  return {
    level,
    active,
    start,
    cancel,
    selectedIds,
    toggle,
    primaryId,
    setPrimary: (id: string) => { if (selectedIds.has(id)) setPrimaryId(id) },
    disabledReason,
    count,
    busy,
    error,
    notice,
    dismissNotice: () => setNotice(null),
    subtitle,
    offerable,
    _plan: plan,
    _requestMerge: requestMerge,
    _runMerge: runMerge,
    _closePlan: () => setPlan(null),
  }
}

/** The one wording for what a finished merge did, at every level — including the nudge to fold
 * same-named children together at the level below. */
function mergeMessage(
  noun: string,
  keeperName: string,
  retiredNames: string[],
  movedCount: number | null,
  movedNoun: string | null,
  duplicateNames: string[],
  duplicateNoun: string | null,
  childPane: string | null
): string {
  const retired = retiredNames.map((n) => `"${n}"`).join(', ')
  const moved = movedCount != null && movedNoun ? `${plural(movedCount, movedNoun)} moved, and ` : ''
  const base =
    `${plural(retiredNames.length, noun)} merged into "${keeperName}" — ${moved}` +
    `${retired} ${retiredNames.length === 1 ? 'is' : 'are'} now retired.`
  if (duplicateNames.length === 0 || !duplicateNoun || !childPane) return base
  return (
    `${base} "${keeperName}" now holds more than one ${duplicateNoun} named ` +
    `${duplicateNames.map((n) => `"${n}"`).join(', ')} — they were left side by side on purpose. ` +
    `Merge them from the ${childPane} column when you’re ready.`
  )
}

// ── The pane-facing pieces ─────────────────────────────────────────────────────────────────
const BTN: React.CSSProperties = { padding: '6px 11px', fontSize: 12 }

/**
 * The bottom-of-pane control. Renders the plain "Merge" button when the mode is off, and the
 * whole active-mode bar when it is on — so a pane places ONE element beside its "+ Add …"
 * button and gets the entire affordance.
 *
 * A pane with nothing to merge shows the button DISABLED, with the reason on hover, rather than
 * dropping it. Hiding it made "there aren't two rows here to fold together" — a temporary state
 * of this pane, one row away from going away — indistinguishable from "this app can't merge
 * these", which sent people looking for a feature that was in front of them all along. The same
 * button, in the same place, always: only its state changes. All three levels get this, because
 * all three mount this component.
 */
export function MergeFooter({ merge }: { merge: MergeModeState }) {
  const meta = LEVEL_META[merge.level]

  if (!merge.active) {
    // Two rows is the floor, and they must be rows that could ever be partners — a pane holding
    // one section and its tray has two rows and still nothing to merge (see `offerable`).
    const blockedReason = merge.offerable ? null : `Needs at least two ${meta.noun}s to merge`
    return (
      <button
        type="button"
        className="btn-ghost"
        style={BTN}
        disabled={blockedReason !== null}
        title={blockedReason ?? `Fold two or more ${meta.noun}s on ${meta.scope} into one`}
        onClick={merge.start}
      >
        Merge
      </button>
    )
  }

  const ready = merge.count >= 2 && merge.primaryId !== null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {merge.count < 2
          ? `Tick two or more ${meta.noun}s on ${meta.scope}, then choose which one to keep.`
          : merge.primaryId === null
            ? `${plural(merge.count, meta.noun)} ticked. Now choose which one to KEEP — tap “Keep this one” on it.`
            : `Keeping one ${meta.noun}; the other ${plural(merge.count - 1, meta.noun)} will be retired.`}
      </span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn-danger"
          style={BTN}
          disabled={merge.busy || !ready}
          onClick={merge._requestMerge}
        >
          {merge.busy ? 'Checking…' : `Merge ${Math.max(merge.count - 1, 0)} into keeper`}
        </button>
        <button type="button" className="btn-ghost" style={BTN} disabled={merge.busy} onClick={merge.cancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * One row, in merge mode. The pane swaps its normal row for this one wholesale: in merge mode a
 * row's only job is to be ticked, so the navigation, rename, delete and stopwatch affordances
 * are gone rather than merely ignored — every one of them is a mis-click waiting to happen.
 */
export function MergeRowItem<T>({
  merge, row, meta,
}: {
  merge: MergeModeState
  row: MergeRow<T>
  /** The row's usual second line (team, operator, counts) — passed through unchanged. */
  meta?: React.ReactNode
}) {
  const ticked = merge.selectedIds.has(row.id)
  const isPrimary = merge.primaryId === row.id
  const disabled = merge.disabledReason(row.id)

  return (
    <label
      className={'finder-row' + (ticked ? ' finder-row-selected' : '')}
      title={disabled ?? undefined}
      style={{ cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1 }}
    >
      <span className="finder-row-main">
        <input
          type="checkbox"
          checked={ticked}
          disabled={Boolean(disabled) || merge.busy}
          onChange={() => merge.toggle(row.id)}
          style={{ width: 15, height: 15, accentColor: 'var(--blue)', flexShrink: 0, cursor: disabled ? 'not-allowed' : 'pointer' }}
        />
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <span className="finder-row-name">
            {row.name}
            {isPrimary && (
              <span className="badge badge-blue" style={{ marginLeft: 6 }}>Keeping</span>
            )}
          </span>
          {meta && <span className="finder-row-meta">{meta}</span>}
          {/* The primary picker only exists on ticked rows, and it starts unset on every one of
              them — see the note at the top of this module about not defaulting. */}
          {ticked && (
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 3,
                fontSize: 11, fontWeight: 700, color: isPrimary ? 'var(--blue)' : 'var(--text-muted)',
              }}
              // Stopped here rather than at the label: letting the click bubble would run the
              // label's activation behaviour and untick the row's checkbox.
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="radio"
                name={`merge-primary-${merge.level}`}
                checked={isPrimary}
                disabled={merge.busy}
                onChange={() => merge.setPrimary(row.id)}
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

/** The pane's merge error and success lines. Placed at the top of the pane body by every pane
 * that mounts merge mode, so a refusal or a result reads the same wherever it happens. */
export function MergeNotices({ merge }: { merge: MergeModeState }) {
  return (
    <>
      {merge.error && (
        <p
          style={{
            margin: '10px 12px', padding: '9px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.55,
            background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)',
          }}
        >
          {merge.error}
        </p>
      )}
      {merge.notice && (
        <p
          style={{
            margin: '10px 12px', padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.5,
            background: 'var(--green-bg)', border: '1px solid #bbf7d0', color: '#15803d', cursor: 'pointer',
          }}
          title="Dismiss"
          onClick={(e) => { e.stopPropagation(); merge.dismissNotice() }}
        >
          {merge.notice}
        </p>
      )}
    </>
  )
}

/**
 * The confirmation. Every number in it came from a preflight that has already run, so what it
 * promises is what the write will do — and it names the row being KEPT, the rows being RETIRED,
 * how many children move, and (where there is a level below) that same-named children land side
 * by side and need merging there.
 */
export function MergeConfirm({ merge, detail }: {
  merge: MergeModeState
  /**
   * Optional host-supplied block, rendered above the "Retiring N …" list.
   *
   * For a host that can say something specific this module can't: /line-config uses it to spell
   * out each losing section against the keeper by name and job count ("All 3 jobs in Flooring
   * move to Floors"), which it derives from counts already on screen. Left out and the dialog is
   * exactly what it always was — every other caller passes nothing.
   */
  detail?: React.ReactNode
}) {
  const plan = merge._plan
  if (!plan) return null
  const meta = LEVEL_META[merge.level]

  return (
    <ConfirmDialog
      title={`Merge ${plural(plan.retiredNames.length, meta.noun)} into "${plan.keeperName}"`}
      message={
        `"${plan.keeperName}" is KEPT. ` +
        `${plural(plan.movingCount, plan.movingNoun)} move onto it, and ` +
        `${plan.retiredNames.length === 1 ? 'the other is' : `the other ${plan.retiredNames.length} are`} ` +
        `retired — they stop appearing across the app. Nothing is DELETED: retiring sets ` +
        `is_active = false, so every row and everything pointing at it survives and an admin can ` +
        `bring it back in the database. There is no un-merge on this screen, though — what moved ` +
        `stays moved.`
      }
      confirmLabel={merge.busy ? 'Merging…' : 'Merge & retire'}
      danger
      maxWidth={520}
      onConfirm={() => { if (!merge.busy) merge._runMerge() }}
      onCancel={() => { if (!merge.busy) merge._closePlan() }}
    >
      <div style={{ fontSize: 13, color: 'var(--text-mid)' }}>
        {detail && <div style={{ marginBottom: 12 }}>{detail}</div>}
        <div style={{ fontWeight: 700, marginBottom: 4 }}>
          Retiring {plural(plan.retiredNames.length, meta.noun)}:
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 150, overflowY: 'auto' }}>
          {plan.retiredNames.map((name) => <li key={name}>{name}</li>)}
        </ul>
        {plan.extraNote && (
          <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
            {plan.extraNote}
          </p>
        )}
        {/* Job level: the collision, named BEFORE it happens. This is the one part of a merge
            that moves recorded times between rows, and the one part with no way back. */}
        {plan.combining && (
          <p style={{ margin: '12px 0 0', padding: '9px 12px', borderRadius: 8, background: 'var(--blue-light)', border: '1px solid #bcdff2', fontSize: 12, lineHeight: 1.55 }}>
            <strong>{plural(plan.combining.count, 'operation')} will combine</strong> with operations of the
            same name on the keeper: {plan.combining.names.join(', ')}.
            {' '}Their times move across.{' '}
            {plan.combining.otherCount > 0
              ? `${plural(plan.combining.otherCount, 'other operation')} move as they are.`
              : 'Nothing else moves.'}
            {plan.combining.reactivatingNames.length > 0 && (
              <>
                {' '}
                <strong>{plan.combining.reactivatingNames.join(', ')}</strong> on &ldquo;{plan.keeperName}&rdquo;
                {plan.combining.reactivatingNames.length === 1 ? ' was' : ' were'} retired and
                {plan.combining.reactivatingNames.length === 1 ? ' comes' : ' come'} back into view — the
                combined operation holds current work.
              </>
            )}
            {' '}Combining cannot be undone from the app: once two operations are one, nothing here
            separates them again.
          </p>
        )}
        {/* The deliberate non-behaviour, said out loud: same-named children are NOT fused. */}
        {plan.duplicateNames.length > 0 && meta.childNoun && meta.childPane && (
          <p style={{ margin: '12px 0 0', padding: '9px 12px', borderRadius: 8, background: 'var(--blue-light)', border: '1px solid #bcdff2', fontSize: 12, lineHeight: 1.55 }}>
            <strong>{plural(plan.duplicateNames.length, `${meta.childNoun} name`)}</strong> will appear more than
            once in &ldquo;{plan.keeperName}&rdquo;: {plan.duplicateNames.map((n) => `"${n}"`).join(', ')}.
            They land side by side — this merge never fuses {meta.childNoun}s by name. Merge them yourself
            from the {meta.childPane} column afterwards.
          </p>
        )}
      </div>
    </ConfirmDialog>
  )
}
