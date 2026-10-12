'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import ConfirmDialog from '@/components/ConfirmDialog'
import { MergeConfirm, useMergeMode, type MergeRow } from '@/components/MergeMode'
import MoveOperationsDialog from '@/components/MoveOperationsDialog'
import { fmtMinutesTotal } from '@/components/SectionMergeSummary'
import { plural } from '@/lib/format'
import { resetLineTopologyCache } from '@/lib/lines'
import {
  createOperation, deleteOperationPermanently, operationNameKey, renameOperation, retireOperation,
} from '@/lib/operations'
import { STRUCTURE_LOCKED_REASON, canDeletePermanently, canEditStructure } from '@/lib/permissions'
import {
  clearEmptyRetiredOperations, fetchJobOperations, type JobOperation, type JobOperations, type SectionJob,
} from '@/lib/sectionManager'
import type { Operation, Section, UserRole } from '@/lib/types'

/**
 * The operations inside one job, in the slide-over on /config → Sections — so the whole
 * structure cleanup (sections, their jobs, their operations) happens on one screen.
 *
 * The slide-in itself is the app's existing one: components/BulkModelLinkDrawer's
 * useSlideOverDrawer (owned by the host) and the .gaps-drawer chrome every other drawer uses.
 *
 * Every write is a shared one:
 *   add      lib/operations' createOperation
 *   rename   lib/operations' renameOperation
 *   move     components/MoveOperationsDialog → lib/jobs' moveOperationsToJob (same line only;
 *            per-operation Rename or Fuse on a name clash; re-stamps the recorded times)
 *   merge    lib/mergeOperations' mergeOperations, through components/MergeMode — the same hook
 *            and confirm every other operation merge uses
 *   delete   lib/operations' retireOperation; and for an operation holding nothing, then
 *            deleteOperationPermanently (admin), so there is no empty shell left behind
 *
 * LIVE operations only, like the rest of this tab. But `operations` is UNIQUE on (name, job_id)
 * and that index counts retired rows, so a retired operation can still refuse a name — and when
 * it does, the message NAMES it. A cause that is hidden is never left unexplained.
 */
const CELL: React.CSSProperties = { padding: '8px 8px', fontSize: 13, color: 'var(--text-mid)', verticalAlign: 'top' }
const HEAD: React.CSSProperties = { padding: '6px 8px', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)', textAlign: 'left' }
const LINK_BTN: React.CSSProperties = { background: 'none', border: 'none', padding: '2px 4px', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--blue)', cursor: 'pointer' }
const LINK_BTN_OFF: React.CSSProperties = { ...LINK_BTN, color: 'var(--text-muted)', opacity: 0.5, cursor: 'not-allowed' }
const SMALL_BTN: React.CSSProperties = { padding: '5px 10px', fontSize: 12 }
const ERR_BOX: React.CSSProperties = { margin: '0 0 10px', padding: '8px 12px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 12, lineHeight: 1.55 }
const OK_BOX: React.CSSProperties = { margin: '0 0 10px', padding: '8px 12px', borderRadius: 8, background: 'var(--green-bg)', border: '1px solid #86efac', color: '#15803d', fontSize: 12, lineHeight: 1.55 }

export default function JobOperationsPane({
  supabase, userId, role, job, section, teamName, onChanged, onClose,
}: {
  supabase: SupabaseClient
  userId: string
  role: UserRole | null
  job: SectionJob
  section: Section
  teamName: string
  /** Something was written — the host re-reads the job row's and the section row's counts. */
  onChanged: () => void
  onClose: () => void
}) {
  const canEdit = canEditStructure(role)
  const lockedReason = canEdit ? null : STRUCTURE_LOCKED_REASON
  const canPurge = canDeletePermanently(role)

  const [data, setData] = useState<JobOperations | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [adding, setAdding] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [moveIds, setMoveIds] = useState<string[] | null>(null)
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await fetchJobOperations(supabase, job.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this job’s operations')
      setData((prev) => prev ?? { operations: [], retired: [] })
    }
  }, [supabase, job.id])
  useEffect(() => { load() }, [load])

  /** After anything that wrote: this pane, the job row and the section row all re-read, and the
   * line-topology cache the Labour Matrix and Model Total read through is dropped. */
  const changed = useCallback(async () => {
    resetLineTopologyCache()
    onChanged()
    await load()
  }, [onChanged, load])

  const operations = useMemo(() => data?.operations ?? [], [data])
  const byId = useMemo(() => new Map(operations.map((o) => [o.id, o])), [operations])

  // The ticked rows ARE the merge hook's selection — one set of checkboxes for move, merge and delete.
  const mergeRows: MergeRow<Operation>[] = useMemo(() => operations.map((o) => ({
    id: o.id, name: o.name, groupKey: `job:${job.id}`,
    subject: { id: o.id, name: o.name, job_id: job.id, is_active: true } as unknown as Operation,
  })), [operations, job.id])
  const merge = useMergeMode({
    level: 'operation', supabase, userId,
    // Merging is manager or admin, the tier that may act on other people's recorded work.
    canMoveOthersTimes: canEdit,
    rows: mergeRows,
    onMerged: async (message) => {
      // The merged-away operations are retired and emptied; clear those shells so none is left
      // to hold a name nobody can see. Admin only (a permanent delete) — otherwise they stay.
      if (canPurge) { try { await clearEmptyRetiredOperations(supabase, job.id) } catch { /* tidying only */ } }
      if (message) { setError(null); setNotice(message) }
      await changed()
    },
  })
  const selected = useMemo(() => operations.filter((o) => merge.selectedIds.has(o.id)), [operations, merge.selectedIds])
  const selectedIds = selected.map((o) => o.id)
  const total = (rows: JobOperation[], field: 'timeRecords' | 'minutes') => rows.reduce((n, o) => n + o[field], 0)
  const keeperPicked = merge.primaryId !== null && merge.selectedIds.has(merge.primaryId)

  /** Why a name can't be used in this job, or null. A RETIRED holder is named as retired —
   * otherwise the user is told a name is taken that appears nowhere on screen. */
  function nameProblem(name: string, exceptId?: string): string | null {
    const key = operationNameKey(name)
    if (!key) return null
    const liveClash = operations.find((o) => o.id !== exceptId && operationNameKey(o.name) === key)
    if (liveClash) return `This job already has an operation called "${liveClash.name}".`
    const retiredClash = (data?.retired ?? []).find((o) => operationNameKey(o.name) === key)
    if (retiredClash) {
      return `A RETIRED operation in this job is still called "${retiredClash.name}". It is hidden here, but the database allows one operation per name per job and counts retired ones — choose another name, or restore or permanently delete it from Retired items on Line Config.`
    }
    return null
  }

  async function act(action: () => Promise<string>) {
    setBusy(true); setError(null); setNotice(null)
    try {
      setNotice(await action())
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'That could not be done'
      // The unique index, reached despite the check above (a name taken since the pane loaded).
      setError(/duplicate key value/i.test(raw)
        ? 'That name is already taken by another operation in this job — possibly a retired one, which is hidden here but still holds its name.'
        : raw)
    }
    await changed()
    setBusy(false)
  }

  const renameIssue = renamingId ? nameProblem(renameValue, renamingId) : null
  const addIssue = nameProblem(adding)

  function commitRename(op: JobOperation) {
    const next = renameValue.trim()
    if (!next || next === op.name || renameIssue) return
    setRenamingId(null)
    act(async () => { await renameOperation(supabase, op.id, next); return `"${op.name}" renamed to "${next}".` })
  }
  function commitAdd() {
    const name = adding.trim()
    if (!name || addIssue) return
    setAdding('')
    act(async () => { const created = await createOperation(supabase, { name, jobId: job.id }); return `"${created.name}" added to ${job.name}.` })
  }

  const disabled = busy || merge.busy || !canEdit
  const deleting = (deleteIds ?? []).map((id) => byId.get(id)).filter((o): o is JobOperation => Boolean(o))

  return (
    <>
      <div className="gaps-drawer-header">
        <div style={{ minWidth: 0 }}>
          <div className="gaps-drawer-title">{job.name}</div>
          <div className="gaps-drawer-jobname">{section.name} · {teamName}</div>
        </div>
        <button className="gaps-drawer-close" onClick={onClose} aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div style={{ padding: '14px 20px 20px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-mid)', marginBottom: 8 }}>
          {data === null ? 'Loading operations…' : plural(operations.length, 'operation')}
          {lockedReason && <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>{` · view only — ${lockedReason.toLowerCase()}`}</span>}
        </div>

        {notice && <p style={OK_BOX}>{notice}</p>}
        {(error || merge.error) && <p style={ERR_BOX}>{error ?? merge.error}</p>}

        {selected.length > 0 && (
          <div style={{ padding: '8px 10px', marginBottom: 10, borderRadius: 8, background: 'var(--blue-light)', border: '1px solid #bcdff2' }}>
            <div style={{ fontSize: 12, color: 'var(--blue-dark)', lineHeight: 1.5, marginBottom: 6 }}>
              <strong>{plural(selected.length, 'operation')} selected</strong>
              {` — ${plural(total(selected, 'timeRecords'), 'time record')}, ${fmtMinutesTotal(total(selected, 'minutes'))}. `}
              {selected.length < 2 ? 'Move or delete it, or tick another to merge.'
                : keeperPicked ? `Merge keeps "${byId.get(merge.primaryId!)?.name}" and folds the other ${plural(selected.length - 1, 'operation')} into it.`
                : 'To merge, tick “Keep” on the operation that should survive.'}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="btn-ghost" style={SMALL_BTN} disabled={disabled} title={lockedReason ?? 'Move to another job on this production line'} onClick={() => setMoveIds(selectedIds)}>
                Move {selected.length}…
              </button>
              <button
                type="button" className="btn-danger" style={SMALL_BTN} disabled={disabled || selected.length < 2 || !keeperPicked}
                title={lockedReason ?? (selected.length < 2 ? 'Tick two or more operations to merge' : keeperPicked ? 'Check what this merge would move, then confirm' : 'Choose which operation to keep first')}
                onClick={merge._requestMerge}
              >
                {merge.busy ? 'Checking…' : `Merge ${selected.length}…`}
              </button>
              <button type="button" className="btn-ghost" style={SMALL_BTN} disabled={disabled} title={lockedReason ?? undefined} onClick={() => setDeleteIds(selectedIds)}>
                Delete {selected.length}…
              </button>
              <button type="button" className="btn-ghost" style={SMALL_BTN} disabled={busy || merge.busy} onClick={merge.cancel}>Clear</button>
            </div>
          </div>
        )}

        {data !== null && (
          <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--border)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ ...HEAD, width: 26 }} />
                <th style={HEAD}>Operation</th>
                <th style={{ ...HEAD, textAlign: 'right' }} title="Time records that count toward labour">Times</th>
                <th style={{ ...HEAD, textAlign: 'right' }}>Models</th>
              </tr>
            </thead>
            <tbody>
              {operations.length === 0 && (
                <tr><td colSpan={4} style={{ ...CELL, textAlign: 'center', color: 'var(--text-muted)', padding: '14px 8px' }}>No operations in this job.</td></tr>
              )}
              {operations.map((op) => {
                const ticked = merge.selectedIds.has(op.id)
                const isKeeper = merge.primaryId === op.id
                const renaming = renamingId === op.id
                const operatorsLabel = [op.primaryOperator, op.secondaryOperator].filter(Boolean).join(' / ')
                return (
                  <tr key={op.id} style={{ borderBottom: '1px solid #f2f2f2', background: ticked ? 'var(--blue-light)' : undefined }}>
                    <td style={CELL}>
                      <input type="checkbox" aria-label={`Select ${op.name}`} checked={ticked} disabled={disabled} title={lockedReason ?? undefined} onChange={() => merge.toggle(op.id)} />
                    </td>
                    <td style={{ ...CELL, color: 'var(--text)' }}>
                      {renaming ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <input
                            className="input" autoFocus value={renameValue} disabled={busy}
                            style={{ fontSize: 13, padding: '4px 8px' }}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); commitRename(op) }
                              // Stop it reaching the drawer, which closes on Escape.
                              if (e.key === 'Escape') { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setRenamingId(null) }
                            }}
                          />
                          {renameIssue && <span style={{ fontSize: 12, color: 'var(--red)' }}>{renameIssue}</span>}
                          <span style={{ display: 'flex', gap: 6 }}>
                            <button type="button" className="btn-primary" style={SMALL_BTN} disabled={busy || !renameValue.trim() || Boolean(renameIssue) || renameValue.trim() === op.name} onClick={() => commitRename(op)}>Save</button>
                            <button type="button" className="btn-ghost" style={SMALL_BTN} onClick={() => setRenamingId(null)}>Cancel</button>
                          </span>
                        </div>
                      ) : (
                        <>
                          <span style={{ fontWeight: 600 }}>{op.name}</span>
                          {ticked && (
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8, fontSize: 11, fontWeight: 700, color: isKeeper ? 'var(--blue)' : 'var(--text-muted)', cursor: 'pointer' }}>
                              <input type="radio" name={`keep-op-${job.id}`} checked={isKeeper} disabled={merge.busy} onChange={() => merge.setPrimary(op.id)} />
                              {isKeeper ? 'Keeping' : 'Keep'}
                            </label>
                          )}
                          {operatorsLabel && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{operatorsLabel}</div>}
                          <div style={{ marginTop: 3, marginLeft: -4 }}>
                            <button type="button" style={disabled ? LINK_BTN_OFF : LINK_BTN} disabled={disabled} title={lockedReason ?? undefined} onClick={() => { setError(null); setRenamingId(op.id); setRenameValue(op.name) }}>Rename</button>
                            ·
                            <button type="button" style={disabled ? LINK_BTN_OFF : LINK_BTN} disabled={disabled} title={lockedReason ?? 'Move to another job on this production line'} onClick={() => setMoveIds([op.id])}>Move</button>
                            ·
                            <button
                              type="button" style={disabled ? LINK_BTN_OFF : { ...LINK_BTN, color: 'var(--red)' }} disabled={disabled}
                              title={lockedReason ?? 'Retire this operation — or remove it outright if it holds nothing'}
                              onClick={() => setDeleteIds([op.id])}
                            >
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </td>
                    <td style={{ ...CELL, textAlign: 'right' }}>{op.timeRecords.toLocaleString()}</td>
                    <td style={{ ...CELL, textAlign: 'right' }}>{op.models.toLocaleString()}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {data !== null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input" placeholder={`New operation in ${job.name}…`} value={adding} disabled={disabled}
                title={lockedReason ?? undefined} style={{ fontSize: 13, padding: '5px 8px', flex: 1, minWidth: 0 }}
                onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitAdd() } }}
              />
              <button type="button" className="btn-ghost" style={SMALL_BTN} disabled={disabled || !adding.trim() || Boolean(addIssue)} title={lockedReason ?? undefined} onClick={commitAdd}>
                + Add
              </button>
            </div>
            {addIssue && <span style={{ fontSize: 12, color: 'var(--red)' }}>{addIssue}</span>}
          </div>
        )}
      </div>

      {/* ── Move: the shared dialog, with its per-operation Rename / Fuse on a name clash ───── */}
      {moveIds && (
        <MoveOperationsDialog
          supabase={supabase} userId={userId} operationIds={moveIds}
          job={{ id: job.id, name: job.name, section_id: job.section_id, production_line_id: job.production_line_id }}
          onClose={() => setMoveIds(null)}
          onChanged={() => { changed() }}
          onDone={async (message) => {
            setMoveIds(null); merge.cancel(); setError(null); setNotice(message)
            // A fused operation leaves an emptied, retired row behind in this job.
            if (canPurge) { try { await clearEmptyRetiredOperations(supabase, job.id) } catch { /* tidying only */ } }
            await changed()
          }}
        />
      )}

      {/* ── Delete: retire, and remove outright what holds nothing ───────────────────────── */}
      {deleteIds && (
        <ConfirmDialog
          title={deleting.length === 1 ? `Delete "${deleting[0].name}"` : `Delete ${plural(deleting.length, 'operation')}`}
          message={
            `${deleting.length === 1 ? 'This operation is' : `These ${deleting.length} operations are`} retired: hidden everywhere, and no longer counted in any labour or coverage figure. ` +
            `${plural(total(deleting, 'timeRecords'), 'time record')} (${fmtMinutesTotal(total(deleting, 'minutes'))}) and the model links under ${deleting.length === 1 ? 'it' : 'them'} are kept, not destroyed.` +
            (canPurge ? ' An operation holding no time records and no model links is removed outright instead, since there is nothing to keep.' : '')
          }
          confirmLabel={deleting.length === 1 ? 'Delete operation' : `Delete ${deleting.length} operations`}
          danger
          maxWidth={520}
          onConfirm={() => {
            const targets = deleting
            setDeleteIds(null)
            merge.cancel()
            act(async () => {
              let retired = 0
              let removed = 0
              try {
                for (const op of targets) {
                  await retireOperation(supabase, op.id)
                  retired++
                  if (canPurge) {
                    // Its own guard re-counts EVERY time record and model link (not just the
                    // counted ones shown here) and refuses if any exist — then it stays retired.
                    try { await deleteOperationPermanently(supabase, op.id); removed++ } catch { /* holds something */ }
                  }
                }
              } catch (err) {
                throw new Error(`${retired} of ${plural(targets.length, 'operation')} deleted before it stopped: ${err instanceof Error ? err.message : 'rejected'}`)
              }
              return `${plural(retired, 'operation')} deleted from ${job.name}` +
                (removed > 0 ? ` — ${removed} held nothing and ${removed === 1 ? 'was' : 'were'} removed outright, ${retired - removed} retired.` : ' (retired).')
            })
          }}
          onCancel={() => setDeleteIds(null)}
        >
          {deleting.length > 1 && (
            <ul style={{ margin: 0, paddingLeft: 20, maxHeight: 140, overflowY: 'auto', fontSize: 13, color: 'var(--text-mid)' }}>
              {deleting.map((o) => <li key={o.id}>{`${o.name} — ${plural(o.timeRecords, 'time record')}`}</li>)}
            </ul>
          )}
        </ConfirmDialog>
      )}

      {/* The shared operation-merge confirm, with the combined figures stated above the list. */}
      <MergeConfirm
        merge={merge}
        detail={selected.length > 1 ? (
          <div style={{ padding: '9px 12px', borderRadius: 8, background: 'var(--blue-light)', border: '1px solid #bcdff2', fontSize: 13, lineHeight: 1.55 }}>
            Combined: <strong>{plural(total(selected, 'timeRecords'), 'time record')}</strong>, <strong>{fmtMinutesTotal(total(selected, 'minutes'))}</strong> counted toward labour across the {selected.length} operations.
            Model links the keeper doesn’t already have are copied onto it.
          </div>
        ) : undefined}
      />
    </>
  )
}
