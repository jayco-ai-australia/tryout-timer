'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import ConfirmDialog from '@/components/ConfirmDialog'
import OperatorSelect from '@/components/OperatorSelect'
import { fmtDateTime, fmtMinutes, plural } from '@/lib/format'
import { fetchOperators, operatorsForLine, type OperatorOption } from '@/lib/operators'
import {
  canDeleteTime, canEditTime, canPromoteTime, promoteBlockedReason, timeEditBlockedReason,
  type PermissionActor,
} from '@/lib/permissions'
import {
  addOperationTimeNote, deleteOperationTime, deleteOperationTimeNote, fetchOperationTimeNotes,
  fetchOperationTimesForModel, promoteOperationTime, splitOperationTimeForModel,
  updateOperationTime, updateOperationTimeNote, type OperationTimeWithModels,
} from '@/lib/operationTimes'
import { chunked, logSupabaseError, READ_CHUNK } from '@/lib/supabaseRead'
import type { OperationTimeNote, UserRole } from '@/lib/types'

/**
 * THE time-record editor — one operation, one model, every run behind that model's figure.
 *
 * Parameterised by (operationId, productId) and nothing screen-specific, because the same drawer
 * is wanted from /model-total's breakdown, /setup's collected-times pane, /tryouts' van walk and
 * the dashboard's activity feed. It fetches what it needs from those two ids: a screen hands it a
 * label for the header and a way to refresh itself, and that is the whole contract.
 *
 * ── The multi-model fan-out, which is the whole reason this is not a simple form ────────────
 * operation_times HAS NO product_id. Which models a run counts towards lives in the
 * operation_time_models junction, and ONE run can be linked to MANY models — a /collect capture
 * that ticked four models writes one row and four links. So editing a run's minutes edits it for
 * every one of those models at once, and there is no per-model figure to edit instead: the
 * measurement is the run, not the link.
 *
 * That has to be said BEFORE anything is typed, not caught at save time, so a record linked to
 * more than one model opens with the others named — by products.model, the name on the page and
 * in the picker, never product_code — above the fields rather than below them.
 *
 * The user then picks a scope:
 *   - "Apply to all N models" — an ordinary update of the run. Every linked model moves.
 *   - "Apply to <this model> only" — a SPLIT (lib/operationTimes' splitOperationTimeForModel):
 *     this model comes off the original's links, and a NEW run carrying the edited values is
 *     created for it alone. Two records afterwards, and the other models' figures are untouched.
 *
 * A run linked to ONE model has no such choice to make, so it isn't offered one — the scope
 * control is absent, not disabled, and Save is just Save.
 *
 * ── Writes ─────────────────────────────────────────────────────────────────────────────────
 * Not one supabase call in this file writes anything. Every write goes through lib/operationTimes
 * — updateOperationTime, splitOperationTimeForModel (which itself goes through
 * recordOperationTime), deleteOperationTime, and add/update/deleteOperationTimeNote. The only
 * queries here are reads for labels (products, operators, profiles) that no helper owns.
 *
 * ── Current vs archived ────────────────────────────────────────────────────────────────────
 * Labour content for an operation+model is THE CURRENT RECORD's minutes — not an average across
 * runs, which is what it used to be. Exactly one record per pair has superseded_by = null; the
 * rest are what it replaced, and they are kept as history rather than deleted.
 *
 * So this list is in two parts, and they are not two styles of the same thing. The current record
 * is the figure the whole app is showing and is fully editable. The archived ones are a record of
 * what the figure used to be: read-only, dimmed, and offering exactly one action — Promote, which
 * makes one of them the figure again and archives the current one in its place. Editing an
 * archived record would be editing history to no effect, so it isn't offered.
 *
 * ── What RLS makes read-only rather than what it makes fail ────────────────────────────────
 * Every gate here comes from lib/permissions, which is the UI's copy of the RLS policies. Nothing
 * in this file tests a role directly. A control the database would refuse is never offered — a
 * rejected write reads as the app being broken rather than as permission being denied.
 *
 * operation_times: a user edits their own records and ownerless ones; a manager or admin edits
 * any. Only a manager or admin may DELETE — so the Delete button is absent, not disabled, for a
 * plain user: it is not something they may do to their own work either, and a disabled button
 * implies it might become available.
 *
 * Someone else's record still SPLITS, whatever the role, because a split creates a new record
 * belonging to the person doing it and leaves theirs untouched. That is the honest shape of the
 * permission and the more useful one: you can correct what a model counts without write access to
 * anybody else's collected work.
 *
 * operation_time_notes keeps its own-author rule for update and delete — for managers and admins
 * too. A note is somebody's written comment, not a measurement, and a manager correcting a figure
 * has no business rewriting what a collector said about it. That check is `note.created_by ===
 * userId` inline below, with no helper to import, so nobody reaches for a role check here.
 */

/** Same slide-in markup and width convention as the other drawers on these screens. */
const DRAWER_WIDTH: React.CSSProperties = { width: '50vw' }

const ERR_BOX: React.CSSProperties = {
  margin: 0, padding: '9px 12px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 12, lineHeight: 1.5,
}
const WARN_BOX: React.CSSProperties = {
  margin: 0, padding: '10px 12px', borderRadius: 8, background: 'var(--amber-bg)',
  border: '1px solid #fde68a', color: '#92400e', fontSize: 12, lineHeight: 1.55,
}
const INFO_BOX: React.CSSProperties = {
  margin: 0, padding: '10px 12px', borderRadius: 8, background: 'var(--blue-light)',
  border: '1px solid #bae0f5', color: 'var(--text-mid)', fontSize: 12, lineHeight: 1.55,
}
const SMALL_BTN: React.CSSProperties = { padding: '6px 11px', fontSize: 12 }
const LINK_BTN: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, fontFamily: 'inherit',
  fontSize: 11, fontWeight: 600, color: 'var(--blue)', cursor: 'pointer',
}

/** What the drawer holds per run: the row, its full model fan-out, and its notes. */
interface TimeRecord {
  time: OperationTimeWithModels
  notes: OperationTimeNote[]
}

/**
 * One record in the list. The same row for the current record and for an archived one — the
 * difference is stated (dimmed, badged, and carrying Promote rather than nothing) rather than
 * built twice, so the two can't drift apart visually and start reading as unrelated things.
 */
function RecordRow({
  record, productId, archived, operatorNameById, onOpen, onPromote,
  promoteDisabled = false, promoteBlockedReason,
}: {
  record: TimeRecord
  productId: string
  archived: boolean
  operatorNameById: Map<string, string>
  onOpen: () => void
  /** Archived rows only. Absent on the current record — it is already the figure. */
  onPromote?: () => void
  promoteDisabled?: boolean
  /** Why Promote is disabled, on hover. Disabled rather than hidden here: the action exists for
   * this row and somebody else can perform it, which is worth saying. */
  promoteBlockedReason?: string | null
}) {
  const { time, notes } = record
  const others = time.productIds.filter((id) => id !== productId).length

  return (
    <div
      style={{
        border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
        background: archived ? 'var(--bg)' : 'var(--surface)',
        display: 'flex', gap: 10, alignItems: 'flex-start',
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        style={{
          flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none',
          padding: 0, cursor: 'pointer', fontFamily: 'inherit',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: archived ? 'var(--text-muted)' : 'var(--blue)' }}>
            {fmtMinutes(time.total_minutes)}m
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-mid)' }}>
            {time.operator_id ? operatorNameById.get(time.operator_id) ?? 'Unknown operator' : 'No operator'}
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)' }}>
          <span>{fmtDateTime(time.created_at)}</span>
          {notes.length > 0 && <span>· {plural(notes.length, 'note')}</span>}
          {/* Flagged on the row, not just inside the editor — the fan-out is a property of the
              record, and seeing it before clicking in is the point. */}
          {others > 0 && (
            <span className="badge badge-amber">also counts for {plural(others, 'other model')}</span>
          )}
        </span>
      </button>
      {onPromote && (
        <button
          type="button"
          className="btn-ghost"
          style={{ padding: '5px 10px', fontSize: 11, flexShrink: 0 }}
          disabled={promoteDisabled}
          title={promoteBlockedReason ?? 'Make this the current time for this model'}
          onClick={onPromote}
        >
          Promote
        </button>
      )}
    </div>
  )
}

/** The scope a save is applied at. Only ever asked when the run has more than one model. */
type SaveScope = 'all' | 'this'

export default function OperationTimesDrawer({
  supabase, userId, role, operationId, operationName, productId, onClose, onChanged,
}: {
  supabase: SupabaseClient
  /** The signed-in user — decides which notes are editable and owns anything created here. */
  userId: string
  /** Their profiles.role. null (still loading, or no profiles row) is the least privileged
   * answer everywhere — see lib/permissions. */
  role: UserRole | null
  /** The two ids the whole drawer is parameterised by. */
  operationId: string
  productId: string
  /** Header only. The model's own name is read from `products` along with everything else. */
  operationName: string
  onClose: () => void
  /**
   * Tell the host screen its numbers are stale. Called after EVERY successful write, including
   * a delete that empties the model — a deleted last run turns the operation back into a gap,
   * and a screen still showing the old average would be showing a figure with nothing behind it.
   */
  onChanged: () => Promise<void>
}) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
    return () => cancelAnimationFrame(id)
  }, [])

  const [records, setRecords] = useState<TimeRecord[]>([])
  const [modelNameById, setModelNameById] = useState<Map<string, string>>(new Map())
  const [operators, setOperators] = useState<OperatorOption[]>([])
  const [operatorNameById, setOperatorNameById] = useState<Map<string, string>>(new Map())
  const [authorNameById, setAuthorNameById] = useState<Map<string, string>>(new Map())
  const [lineId, setLineId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Which record is open for editing. Held as an id, not the row — a reload replaces every row
  // object, and an editor holding the old one would save against a stale copy.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [minutesDraft, setMinutesDraft] = useState('')
  const [operatorDraft, setOperatorDraft] = useState('')
  const [scope, setScope] = useState<SaveScope>('all')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [newNote, setNewNote] = useState('')
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)

  const [confirmSave, setConfirmSave] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmPromote, setConfirmPromote] = useState<TimeRecord | null>(null)
  const [confirmNoteDelete, setConfirmNoteDelete] = useState<OperationTimeNote | null>(null)

  // ── Load ─────────────────────────────────────────────────────────────────────────────────
  /**
   * One pass: the runs and their fan-out from the shared helper, then the label lookups those
   * ids need. The label reads are best-effort — an unnamed model or operator is a worse drawer,
   * a missing record list is a broken one, so only the first read can fail the whole thing.
   */
  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const times = await fetchOperationTimesForModel(supabase, operationId, productId)

      let notes: OperationTimeNote[] = []
      if (times.length > 0) {
        try {
          notes = await fetchOperationTimeNotes(supabase, times.map((t) => t.id))
        } catch {
          notes = []
        }
      }
      const notesByTime = new Map<string, OperationTimeNote[]>()
      for (const note of notes) {
        const list = notesByTime.get(note.operation_time_id)
        if (list) list.push(note)
        else notesByTime.set(note.operation_time_id, [note])
      }

      setRecords(times.map((t) => ({ time: t, notes: notesByTime.get(t.id) ?? [] })))

      // Model names for the whole fan-out — this model included, since the header needs it too.
      // products.model, never product_code: the code is a catalogue key nobody on the floor
      // reads, and naming the wrong one in a "this also changes…" warning defeats the warning.
      const productIds = [...new Set([productId, ...times.flatMap((t) => t.productIds)])]
      const nameById = new Map<string, string>()
      let productionLineId: string | null = null
      for (const chunk of chunked(productIds, READ_CHUNK)) {
        const { data, error } = await supabase
          .from('products').select('id, model, production_line_id').in('id', chunk)
        if (error) { logSupabaseError('products (time drawer labels)', error); break }
        for (const row of (data ?? []) as { id: string; model: string; production_line_id: string | null }[]) {
          nameById.set(row.id, row.model)
          if (row.id === productId) productionLineId = row.production_line_id
        }
      }
      setModelNameById(nameById)
      setLineId(productionLineId)

      // The operator picker is scoped to the MODEL's line — a run is filed against that line, so
      // offering another line's operators would bank it against somebody who isn't on it.
      try {
        setOperators(operatorsForLine(await fetchOperators(supabase), productionLineId))
      } catch {
        setOperators([])
      }

      const operatorIds = [...new Set(times.map((t) => t.operator_id).filter((id): id is string => !!id))]
      const opNames = new Map<string, string>()
      for (const chunk of chunked(operatorIds, READ_CHUNK)) {
        const { data, error } = await supabase.from('operators').select('id, full_name').in('id', chunk)
        if (error) { logSupabaseError('operators (time drawer labels)', error); break }
        for (const row of (data ?? []) as { id: string; full_name: string }[]) opNames.set(row.id, row.full_name)
      }
      setOperatorNameById(opNames)

      // Note authors AND record collectors — both are profile ids, and both are named in the
      // UI: the note's byline, and the "Collected by <name>" reason on a record somebody else
      // owns. One lookup covers both. A name that can't be read (RLS on profiles) simply isn't
      // shown; the note still says it belongs to somebody else and the reason still reads.
      const authorIds = [...new Set([
        ...notes.map((n) => n.created_by),
        ...times.map((t) => t.collected_by),
      ].filter((id): id is string => !!id))]
      const authors = new Map<string, string>()
      for (const chunk of chunked(authorIds, READ_CHUNK)) {
        const { data, error } = await supabase.from('profiles').select('id, full_name').in('id', chunk)
        if (error) { logSupabaseError('profiles (note authors)', error); break }
        for (const row of (data ?? []) as { id: string; full_name: string | null }[]) {
          if (row.full_name) authors.set(row.id, row.full_name)
        }
      }
      setAuthorNameById(authors)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load this operation’s times')
    } finally {
      setLoading(false)
    }
  }, [supabase, operationId, productId])

  useEffect(() => { load() }, [load])

  /** The viewer as lib/permissions sees them. Built once, passed to every gate below. */
  const actor = useMemo<PermissionActor>(() => ({ userId, role }), [userId, role])

  /** Who collected a record, for the "only they or a manager can change this" sentence. Falls
   * back to null (the reason still reads) rather than to a placeholder that looks like a name. */
  const collectorNameFor = useCallback(
    (collectedBy: string | null) => (collectedBy ? authorNameById.get(collectedBy) ?? null : null),
    [authorNameById]
  )

  const thisModelName = modelNameById.get(productId) ?? 'this model'
  const editing = useMemo(
    () => records.find((r) => r.time.id === editingId) ?? null,
    [records, editingId]
  )

  /** The one record that IS the figure, and the ones it replaced. Split here rather than at each
   * render site so "which is current" is asked once, off superseded_by and nothing else. */
  const currentRecord = useMemo(() => records.find((r) => r.time.superseded_by == null) ?? null, [records])
  const archivedRecords = useMemo(
    () => records.filter((r) => r.time.superseded_by != null),
    [records]
  )
  /** Editing an archived record is not offered — see the note at the top. */
  const editingIsArchived = editing ? editing.time.superseded_by != null : false

  /**
   * MAY THIS PERSON PROMOTE THAT RECORD — asked of TWO records, not one.
   *
   * Promoting clears superseded_by on the archived record AND sets it on whatever is current, and
   * those two rows can have different collectors. Checking only the record being promoted lets a
   * collector promote their own old measurement over somebody else's current one: their write
   * lands, the second is refused by RLS, and the pair is left with two current records and a
   * labour figure that depends on row order. canPromoteTime takes both for exactly that reason,
   * and the current record is passed even when it is null (every record archived — no second
   * write to authorise).
   */
  const promoteGate = useCallback(
    (record: TimeRecord) => ({
      allowed: canPromoteTime(actor, record.time, currentRecord?.time ?? null),
      reason: promoteBlockedReason(actor, record.time, currentRecord?.time ?? null, {
        promoted: collectorNameFor(record.time.collected_by),
        current: collectorNameFor(currentRecord?.time.collected_by ?? null),
      }),
    }),
    [actor, currentRecord, collectorNameFor]
  )

  /** The other models this run also counts towards — the fan-out the warning names. */
  const otherModelNames = useMemo(() => {
    if (!editing) return []
    return editing.time.productIds
      .filter((id) => id !== productId)
      .map((id) => modelNameById.get(id) ?? 'an unnamed model')
      .sort((a, b) => a.localeCompare(b))
  }, [editing, productId, modelNameById])

  const isMultiModel = otherModelNames.length > 0
  /**
   * May this record be updated at all — its minutes, its operator, its superseded_by pointer?
   * Own record, ownerless record, or manager/admin. Someone else's run can still be SPLIT, which
   * is why this gates the fields and the "all models" scope but not the split.
   */
  const canEdit = editing ? canEditTime(actor, editing.time) : false
  const editBlockedReason = editing
    ? timeEditBlockedReason(actor, editing.time, collectorNameFor(editing.time.collected_by))
    : null
  /** Delete is manager/admin only, and takes no record — no ownership case changes the answer. */
  const canDelete = canDeleteTime(actor)
  // "All models" updates the existing record, so it needs write access to it. Without that the
  // only route open is the split, which writes a new record of the viewer's own.
  const effectiveScope: SaveScope = !isMultiModel ? 'all' : canEdit ? scope : 'this'

  function openEditor(record: TimeRecord) {
    setEditingId(record.time.id)
    setMinutesDraft(record.time.total_minutes != null ? String(record.time.total_minutes) : '')
    setOperatorDraft(record.time.operator_id ?? '')
    // Defaults to the safe scope: changing every linked model is the bigger act, so it is the
    // one the user has to choose rather than the one they land on.
    setScope(record.time.productIds.length > 1 ? 'this' : 'all')
    setFormError(null)
    setNotice(null)
    setNewNote('')
    setEditingNoteId(null)
  }

  function closeEditor() {
    if (saving || noteBusy) return
    setEditingId(null)
    setFormError(null)
  }

  // ── Writes — every one through lib/operationTimes ────────────────────────────────────────
  function requestSave() {
    if (!editing) return
    const minutes = Number(minutesDraft)
    if (!minutesDraft.trim() || Number.isNaN(minutes) || minutes <= 0) {
      setFormError('Enter a valid number of minutes')
      return
    }
    setFormError(null)
    // A run on one model changes nothing the user can't see, so it saves straight away. Anything
    // touching more than one model — or creating a second record — gets stated first.
    if (isMultiModel) setConfirmSave(true)
    else void runSave()
  }

  async function runSave() {
    if (!editing) return
    setConfirmSave(false)
    setSaving(true)
    setFormError(null)
    const minutes = Number(minutesDraft)
    const operatorId = operatorDraft || null

    try {
      if (effectiveScope === 'this' && isMultiModel) {
        const result = await splitOperationTimeForModel(supabase, {
          original: editing.time,
          productId,
          totalMinutes: minutes,
          operatorId,
          collectedBy: userId,
          // COPIES, not moves — see the note beside the confirmation text below.
          noteContents: editing.notes.map((n) => n.content),
        })
        setNotice(
          `Split done. ${thisModelName} now counts a new record of ${fmtMinutes(minutes)}m` +
          (result.notesCopied > 0 ? `, with ${plural(result.notesCopied, 'note')} copied across` : '') +
          `. The original record is unchanged and still counts for ${plural(otherModelNames.length, 'other model')}.` +
          (result.noteErrors.length > 0 ? ` ${plural(result.noteErrors.length, 'note')} could not be copied: ${result.noteErrors[0]}` : '')
        )
      } else {
        await updateOperationTime(supabase, editing.time.id, {
          totalMinutes: minutes,
          operatorId,
        })
        setNotice(
          isMultiModel
            ? `Saved for all ${plural(otherModelNames.length + 1, 'model')} this record counts towards.`
            : 'Saved.'
        )
      }
      setEditingId(null)
      await load()
      await onChanged()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save this record')
    } finally {
      setSaving(false)
    }
  }

  /** Make an archived record the figure again. One helper call — the pointer arithmetic and its
   * rollback live in lib/operationTimes, not here. */
  async function runPromote(record: TimeRecord) {
    setConfirmPromote(null)
    setSaving(true)
    setFormError(null)
    try {
      await promoteOperationTime(supabase, {
        operationTimeId: record.time.id,
        operationId,
        productId,
      })
      setNotice(
        `${fmtMinutes(record.time.total_minutes)}m is now the current time for ${thisModelName}. ` +
        'The record it replaced is kept as history.'
      )
      setEditingId(null)
      await load()
      await onChanged()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not promote that record')
    } finally {
      setSaving(false)
    }
  }

  async function runDelete() {
    if (!editing) return
    setConfirmDelete(false)
    setSaving(true)
    setFormError(null)
    try {
      await deleteOperationTime(supabase, editing.time.id)
      setNotice('Record deleted.')
      setEditingId(null)
      await load()
      // Always, including when this was the last run: the operation becomes a gap again, and the
      // host screen has to recompute rather than keep the average it already had.
      await onChanged()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not delete this record')
    } finally {
      setSaving(false)
    }
  }

  async function runAddNote() {
    if (!editing || !newNote.trim()) return
    setNoteBusy(true)
    setFormError(null)
    try {
      await addOperationTimeNote(supabase, editing.time.id, newNote.trim(), userId)
      setNewNote('')
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not add that note')
    } finally {
      setNoteBusy(false)
    }
  }

  async function runUpdateNote(note: OperationTimeNote) {
    if (!noteDraft.trim()) { setEditingNoteId(null); return }
    setNoteBusy(true)
    setFormError(null)
    try {
      await updateOperationTimeNote(supabase, note.id, noteDraft.trim())
      setEditingNoteId(null)
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not update that note')
    } finally {
      setNoteBusy(false)
    }
  }

  async function runDeleteNote(note: OperationTimeNote) {
    setConfirmNoteDelete(null)
    setNoteBusy(true)
    setFormError(null)
    try {
      await deleteOperationTimeNote(supabase, note.id)
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not delete that note')
    } finally {
      setNoteBusy(false)
    }
  }

  function handleClose() {
    if (saving || noteBusy) return
    setVisible(false)
    window.setTimeout(onClose, 320)
  }

  // ── Render ───────────────────────────────────────────────────────────────────────────────
  return (
    <>
      <div className={'gaps-drawer-overlay' + (visible ? ' gaps-drawer-overlay-visible' : '')} onClick={handleClose} />
      <div className={'gaps-drawer' + (visible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
        <div className="gaps-drawer-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="gaps-drawer-title">Times — {operationName}</div>
            <div className="gaps-drawer-model">for {thisModelName}</div>
          </div>
          <button className="gaps-drawer-close" onClick={handleClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="gaps-drawer-body" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {loadError && <p style={ERR_BOX}>{loadError}</p>}
          {notice && !editing && (
            <p style={INFO_BOX}>
              {notice}{' '}
              <button type="button" style={LINK_BTN} onClick={() => setNotice(null)}>Dismiss</button>
            </p>
          )}

          {loading ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading times…</p>
          ) : editing ? (
            // ── Edit one record ──────────────────────────────────────────────────────────
            <>
              <button type="button" style={{ ...LINK_BTN, alignSelf: 'flex-start', fontSize: 12 }} onClick={closeEditor}>
                ‹ Back to all times
              </button>

              {/* The fan-out, stated BEFORE the fields — the whole point of this drawer. */}
              {isMultiModel && (
                <p style={WARN_BOX}>
                  <strong>This record counts towards {plural(otherModelNames.length + 1, 'model')}.</strong>{' '}
                  A recorded time has no model of its own — it is linked to each of them — so editing
                  it changes every one unless you split it. As well as {thisModelName}, it counts for:{' '}
                  <strong>{otherModelNames.join(', ')}</strong>.
                </p>
              )}

              {editBlockedReason && !editingIsArchived && (
                <p style={INFO_BOX}>
                  {editBlockedReason} You can still split {thisModelName} off into a record of your
                  own — the original stays exactly as it is.
                </p>
              )}

              {editingIsArchived && (
                <p style={INFO_BOX}>
                  <strong>This is an archived record.</strong> It was replaced, so it is history
                  and changing it would move no figure anywhere. Promote it to make it
                  {' '}{thisModelName}’s current time — whatever is current now is archived in its
                  place{canDelete ? ' — or delete it if it was recorded in error.' : '.'}
                  {promoteGate(editing).reason && (
                    <> <strong>{promoteGate(editing).reason}</strong></>
                  )}
                </p>
              )}

              {formError && <p style={ERR_BOX}>{formError}</p>}

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
                <span className={'badge ' + (editingIsArchived ? 'badge-grey' : 'badge-green')}>
                  {editingIsArchived ? 'archived' : 'current'}
                </span>
                <span>
                  Recorded {fmtDateTime(editing.time.created_at)}
                  {editing.time.is_imported && ' · imported'}
                </span>
              </div>

              <div>
                <label className="label">Minutes</label>
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="0.1"
                  value={minutesDraft}
                  disabled={saving || editingIsArchived || !canEdit}
                  onChange={(e) => setMinutesDraft(e.target.value)}
                />
              </div>

              <div>
                <label className="label">Who was timed</label>
                <OperatorSelect
                  operators={operators}
                  value={operatorDraft}
                  disabled={saving || editingIsArchived || !canEdit}
                  emptyLabel="— Not recorded —"
                  ariaLabel="Who was timed"
                  onChange={setOperatorDraft}
                />
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Optional context. Clearing it files the run against the shared “Unassigned”
                  operator — the figures are unaffected either way.
                </span>
              </div>

              {/* Scope. Absent, not disabled, when there is only one model — there is no choice
                  to make, and an inert radio pair implies there was. */}
              {isMultiModel && !editingIsArchived && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px', border: '1px solid var(--border)', borderRadius: 8 }}>
                  <span className="label" style={{ marginBottom: 0 }}>Apply this edit to</span>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: 'var(--text-mid)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>
                    <input
                      type="radio" name="save-scope" checked={effectiveScope === 'all'}
                      disabled={saving || !canEdit}
                      onChange={() => setScope('all')}
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      <strong>All {otherModelNames.length + 1} models</strong> — updates this one
                      record, so {otherModelNames.join(', ')} move too.
                      {editBlockedReason && ` Not available: ${editBlockedReason.charAt(0).toLowerCase()}${editBlockedReason.slice(1)}`}
                    </span>
                  </label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: 'var(--text-mid)', cursor: 'pointer' }}>
                    <input
                      type="radio" name="save-scope" checked={effectiveScope === 'this'}
                      disabled={saving}
                      onChange={() => setScope('this')}
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      <strong>{thisModelName} only</strong> — creates a second record for it and
                      leaves the original (and the other models) untouched.
                    </span>
                  </label>
                </div>
              )}

              {/* ── Notes ─────────────────────────────────────────────────────────────── */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="label" style={{ marginBottom: 0 }}>
                  Notes {editing.notes.length > 0 && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({editing.notes.length})</span>}
                </span>

                {editing.notes.length === 0 && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No notes on this record.</span>
                )}

                {editing.notes.map((note) => {
                  const ownNote = note.created_by === userId
                  const author = note.created_by ? authorNameById.get(note.created_by) ?? null : null
                  return (
                    <div key={note.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {editingNoteId === note.id ? (
                        <>
                          <textarea
                            className="input"
                            rows={3}
                            value={noteDraft}
                            disabled={noteBusy}
                            onChange={(e) => setNoteDraft(e.target.value)}
                          />
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button type="button" className="btn-primary" style={SMALL_BTN} disabled={noteBusy || !noteDraft.trim()} onClick={() => runUpdateNote(note)}>
                              {noteBusy ? 'Saving…' : 'Save note'}
                            </button>
                            <button type="button" className="btn-ghost" style={SMALL_BTN} disabled={noteBusy} onClick={() => setEditingNoteId(null)}>
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>{note.content}</span>
                          <span style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
                            <span>{ownNote ? 'You' : author ?? 'Someone else'} · {fmtDateTime(note.created_at)}</span>
                            {/* RLS restricts update/delete to the note's own author, so somebody
                                else's note shows without controls rather than offering buttons
                                that would fail on save. */}
                            {ownNote ? (
                              <>
                                <button type="button" style={LINK_BTN} disabled={noteBusy} onClick={() => { setEditingNoteId(note.id); setNoteDraft(note.content) }}>
                                  Edit
                                </button>
                                <button type="button" style={{ ...LINK_BTN, color: 'var(--red)' }} disabled={noteBusy} onClick={() => setConfirmNoteDelete(note)}>
                                  Delete
                                </button>
                              </>
                            ) : (
                              <span style={{ fontStyle: 'italic' }}>read-only</span>
                            )}
                          </span>
                        </>
                      )}
                    </div>
                  )
                })}

                <textarea
                  className="input"
                  rows={2}
                  placeholder="Add a note…"
                  value={newNote}
                  disabled={noteBusy}
                  onChange={(e) => setNewNote(e.target.value)}
                />
                <button type="button" className="btn-ghost" style={{ ...SMALL_BTN, alignSelf: 'flex-start' }} disabled={noteBusy || !newNote.trim()} onClick={runAddNote}>
                  {noteBusy ? 'Adding…' : 'Add note'}
                </button>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                {editingIsArchived ? (
                  <button
                    type="button"
                    className="btn-primary"
                    style={SMALL_BTN}
                    disabled={saving || !promoteGate(editing).allowed}
                    title={promoteGate(editing).reason ?? undefined}
                    onClick={() => setConfirmPromote(editing)}
                  >
                    {saving ? 'Working…' : `Make this ${thisModelName}’s current time`}
                  </button>
                ) : (
                  <button type="button" className="btn-primary" style={SMALL_BTN} disabled={saving} onClick={requestSave}>
                    {saving ? 'Saving…' : effectiveScope === 'this' && isMultiModel ? `Save for ${thisModelName} only` : 'Save'}
                  </button>
                )}
                <button type="button" className="btn-ghost" style={SMALL_BTN} disabled={saving} onClick={closeEditor}>
                  Cancel
                </button>
                {/* Manager/admin only, and ABSENT rather than disabled: deleting a recorded time
                    is not something a collector may do even to their own work, so a greyed-out
                    button would imply a permission that is never coming. */}
                {canDelete && (
                  <button type="button" className="btn-danger" style={{ ...SMALL_BTN, marginLeft: 'auto' }} disabled={saving} onClick={() => setConfirmDelete(true)}>
                    Delete record
                  </button>
                )}
              </div>
            </>
          ) : records.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              No times recorded against {thisModelName} for this operation yet.
            </p>
          ) : (
            // ── The current record, then the history behind it ──────────────────────────
            <>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {thisModelName}’s labour content for this operation is the CURRENT record below —
                not an average of them. {archivedRecords.length > 0
                  ? `${plural(archivedRecords.length, 'earlier record')} kept as history.`
                  : 'Nothing has replaced it yet.'}
              </span>

              <span className="label" style={{ marginBottom: 0 }}>Current</span>
              {currentRecord ? (
                <RecordRow
                  record={currentRecord} productId={productId} archived={false}
                  operatorNameById={operatorNameById}
                  onOpen={() => openEditor(currentRecord)}
                />
              ) : (
                <p style={WARN_BOX}>
                  Every record for {thisModelName} is archived, so this operation has no labour
                  figure and reads as an untimed gap. Promote one below to fix it.
                </p>
              )}

              {archivedRecords.length > 0 && (
                <>
                  {/* Deliberately below a heading and a rule rather than mixed in above: these
                      are what the figure USED to be, and a flat list of equal-looking rows is
                      exactly the impression the averaging rule used to give. */}
                  <span className="label" style={{ marginBottom: 0, marginTop: 6, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                    Archived ({archivedRecords.length})
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: -4 }}>
                    Read-only history. Promote one to make it the current figure — whatever is
                    current now is archived in its place.
                  </span>
                  {archivedRecords.map((record) => {
                    const gate = promoteGate(record)
                    return (
                      <RecordRow
                        key={record.time.id}
                        record={record} productId={productId} archived
                        operatorNameById={operatorNameById}
                        onOpen={() => openEditor(record)}
                        onPromote={() => setConfirmPromote(record)}
                        promoteDisabled={saving || !gate.allowed}
                        promoteBlockedReason={gate.reason}
                      />
                    )
                  })}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Confirmations — the shared dialog, never a bespoke one ───────────────────────── */}
      {confirmSave && editing && (
        <ConfirmDialog
          title={effectiveScope === 'this' ? `Split this record for ${thisModelName}?` : `Change all ${otherModelNames.length + 1} models?`}
          maxWidth={520}
          confirmLabel={effectiveScope === 'this' ? 'Split record' : 'Update all models'}
          danger={effectiveScope === 'all'}
          message={
            effectiveScope === 'this'
              ? `This creates a SECOND record of ${fmtMinutes(Number(minutesDraft) || 0)}m, linked to ${thisModelName} and nothing else. ` +
                `${thisModelName} stops counting the original record and counts the new one instead. ` +
                `The original record keeps its own minutes and stays linked to ${otherModelNames.join(', ')} — ` +
                `their figures do not change.` +
                (editing.notes.length > 0
                  ? ` Its ${plural(editing.notes.length, 'note')} are COPIED onto the new record (notes belong to one record, so they can't be shared); the originals stay where they are, and the copies are saved under your name.`
                  : '')
              : `This edits the one record, so every model linked to it moves: ${thisModelName}, ${otherModelNames.join(', ')}. ` +
                `Their totals and coverage all change. To correct ${thisModelName} alone, cancel and choose "${thisModelName} only" instead.`
          }
          onConfirm={runSave}
          onCancel={() => setConfirmSave(false)}
        />
      )}

      {confirmDelete && editing && (
        <ConfirmDialog
          title="Delete this record?"
          maxWidth={520}
          confirmLabel="Delete record"
          danger
          message={
            (isMultiModel
              ? `This record counts towards ${plural(otherModelNames.length + 1, 'model')}. Deleting it removes the run from all of them — ${thisModelName}, ${otherModelNames.join(', ')} — not just this one. To take it off ${thisModelName} alone, cancel and split it instead.`
              : `This removes the run from ${thisModelName}'s average.`) +
            ' Its notes go with it. If this is the last record for this operation and model, the operation becomes an untimed gap again. This cannot be undone.'
          }
          onConfirm={runDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {confirmPromote && (
        <ConfirmDialog
          title={`Make this ${thisModelName}’s current time?`}
          maxWidth={520}
          confirmLabel="Promote record"
          message={
            `${thisModelName}'s labour content for this operation becomes ` +
            `${fmtMinutes(confirmPromote.time.total_minutes)}m.` +
            (currentRecord
              ? ` The record currently providing it (${fmtMinutes(currentRecord.time.total_minutes)}m) is archived behind it — kept, not deleted, and promotable back at any time.`
              : ' This operation has no current record right now, so nothing is archived in its place.') +
            ' Every total and breakdown showing this operation moves to the new figure. Coverage does not change: both records are times that were collected.'
          }
          onConfirm={() => runPromote(confirmPromote)}
          onCancel={() => setConfirmPromote(null)}
        />
      )}

      {confirmNoteDelete && (
        <ConfirmDialog
          title="Delete this note?"
          message="The note is removed from this record. The recorded time itself is unaffected."
          confirmLabel="Delete note"
          danger
          onConfirm={() => runDeleteNote(confirmNoteDelete)}
          onCancel={() => setConfirmNoteDelete(null)}
        />
      )}
    </>
  )
}
