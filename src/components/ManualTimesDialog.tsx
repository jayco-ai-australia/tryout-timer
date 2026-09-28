'use client'

import { useMemo, useState } from 'react'
import Modal from './Modal'
import OperatorSelect, { type OperatorSelectOption } from './OperatorSelect'
import { plural } from '@/lib/format'

/**
 * "Enter times manually" — one dialog, EVERY operation the collector picked.
 *
 * It replaced a single-operation form that took the drilled-down operation and quietly ignored
 * the rest of the selection: tick four operations, press Enter manually, and exactly one time
 * was written with no indication the other three had been dropped. Silently recording a quarter
 * of what somebody measured on the floor is worse than refusing outright, and the fix is not a
 * warning — it is a row per operation.
 *
 * ── One row per operation ─────────────────────────────────────────────────────────────────
 * OPERATION (read-only) | MINUTES | OPERATOR | NOTE. Operator and note are PER ROW because they
 * genuinely differ: four operations measured in one walk may well have been four different
 * people, and a note about one of them is not a note about the others. The operation name is
 * never truncated — it is the only thing identifying which row is which, and an ellipsis in the
 * middle of "Fit Hatches — Nearside" makes two rows look identical.
 *
 * ── Apply to all ──────────────────────────────────────────────────────────────────────────
 * Typing the same operator four times is the reason a bulk form gets abandoned half way. The
 * shortcuts above the table fill one value down every row and then get out of the way: they
 * hold no state of their own once applied, and every row stays independently editable. Two
 * separate buttons rather than one, so filling the operator down can't wipe notes already typed.
 *
 * ── Blank rows are SKIPPED, not invalid ───────────────────────────────────────────────────
 * A collector who measured three of the four operations should be able to save the three. An
 * empty Minutes box is therefore not an error, is not highlighted, and does not block Save; it
 * simply isn't recorded. The only rule is that at least ONE row has minutes above zero.
 *
 * Text that isn't a positive number IS refused, and that is not a contradiction: blank means
 * "I didn't measure this one", but "2o" means "I measured this one and it is about to be
 * thrown away". Those rows are named rather than silently dropped.
 *
 * ── Each row is saved against the models ITS operation applies to ─────────────────────────
 * The ticked models come from whichever operation was drilled into, and the ticked operations
 * need not all apply to them. Every row therefore states what it will be saved against, and a
 * row whose operation applies to NONE of the ticked models says so and can't be filled in —
 * rather than banking a time against models it doesn't apply to (the guard in
 * recordOperationTime would refuse it anyway; this stops anyone typing a number that can't land).
 *
 * ── Layout ────────────────────────────────────────────────────────────────────────────────
 * The three-region Modal — header fixed, rows scroll, footer PINNED. This is the same screen
 * where an unbounded list once pushed its own Save button off a tablet viewport (see the
 * `footer` note on components/Modal), and this dialog lists a row per selected operation, so it
 * is exactly the shape that caused it.
 *
 * Below ~700px the four columns become a card per operation with the operation name as its
 * heading — same markup, driven by the .mt-* rules in globals.css, so the two layouts cannot
 * drift apart.
 */

/** One row the caller should write. Only rows with real minutes reach this. */
export interface ManualTimeEntry {
  operationId: string
  operationName: string
  minutes: number
  /** '' → nobody chosen. The caller passes null through to recordOperationTime. */
  operatorId: string
  /** Already trimmed; '' → no note to write. */
  note: string
}

interface Row {
  operationId: string
  operationName: string
  minutes: string
  operatorId: string
  note: string
}

/** Blank → skipped. A positive number → recorded. Anything else → named and refused. */
function readMinutes(raw: string): { state: 'blank' } | { state: 'ok'; value: number } | { state: 'bad' } {
  const trimmed = raw.trim()
  if (!trimmed) return { state: 'blank' }
  const value = Number(trimmed)
  if (Number.isNaN(value) || value <= 0) return { state: 'bad' }
  return { state: 'ok', value }
}

export default function ManualTimesDialog({
  operations, modelCount, modelsByOperation, operators, saving, error, onSave, onCancel,
}: {
  /** Every operation the collector selected, in the order the pane shows them. */
  operations: { id: string; name: string }[]
  /** How many models each recorded time will be banked against — the context that makes a
   * coverage time mean something, so it is named in the subtitle rather than assumed. */
  modelCount: number
  /** Per operation id, the ticked models that operation applies to — what its row will be saved
   * against. Empty → the row is locked and says why. */
  modelsByOperation: Record<string, { id: string; model: string }[]>
  /** Already scoped to the walked production line by the caller. */
  operators: OperatorSelectOption[]
  saving: boolean
  /** The write's failure, shown above the footer. Owned by the caller — it does the writes. */
  error: string | null
  onSave: (entries: ManualTimeEntry[]) => void
  onCancel: () => void
}) {
  const [rows, setRows] = useState<Row[]>(() => operations.map((op) => ({
    operationId: op.id,
    operationName: op.name,
    minutes: '',
    operatorId: '',
    note: '',
  })))

  // The fill-down values. Deliberately NOT the rows' source of truth — they seed rows on demand
  // and are otherwise inert, which is what keeps every row independently editable afterwards.
  const [allOperatorId, setAllOperatorId] = useState('')
  const [allNote, setAllNote] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  function updateRow(operationId: string, patch: Partial<Row>) {
    setLocalError(null)
    setRows((prev) => prev.map((r) => (r.operationId === operationId ? { ...r, ...patch } : r)))
  }

  const appliesToNone = (operationId: string) => (modelsByOperation[operationId] ?? []).length === 0
  const lockedCount = operations.filter((op) => appliesToNone(op.id)).length

  // A locked row's minutes are ignored even if something was typed before it locked.
  const parsed = useMemo(
    () => rows.map((r) => ({
      row: r,
      minutes: (modelsByOperation[r.operationId] ?? []).length === 0
        ? { state: 'blank' as const }
        : readMinutes(r.minutes),
    })),
    [rows, modelsByOperation]
  )
  const readyCount = parsed.filter((p) => p.minutes.state === 'ok').length
  const badRows = parsed.filter((p) => p.minutes.state === 'bad').map((p) => p.row.operationName)

  function submit() {
    if (saving) return
    if (badRows.length > 0) {
      setLocalError(
        `${badRows.length === 1 ? 'This row has' : 'These rows have'} something in Minutes that isn’t a ` +
        `number above zero: ${badRows.join(', ')}. Fix ${badRows.length === 1 ? 'it' : 'them'}, or clear ` +
        `${badRows.length === 1 ? 'the box' : 'the boxes'} to leave ${badRows.length === 1 ? 'that operation' : 'those operations'} unrecorded.`
      )
      return
    }
    if (readyCount === 0) {
      setLocalError('Enter minutes against at least one operation — there is nothing to record yet.')
      return
    }
    setLocalError(null)
    onSave(
      parsed
        .filter((p): p is { row: Row; minutes: { state: 'ok'; value: number } } => p.minutes.state === 'ok')
        .map((p) => ({
          operationId: p.row.operationId,
          operationName: p.row.operationName,
          minutes: p.minutes.value,
          operatorId: p.row.operatorId,
          note: p.row.note.trim(),
        }))
    )
  }

  const shown = localError ?? error

  return (
    <Modal
      title="Enter times manually"
      maxWidth={980}
      onClose={() => { if (!saving) onCancel() }}
      footer={
        <>
          <span style={{ marginRight: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
            {readyCount === 0
              ? 'Nothing to save yet — fill in Minutes on at least one row.'
              : `${plural(readyCount, 'operation')} ready; the rest are left unrecorded.`}
          </span>
          <button type="button" className="btn-ghost" disabled={saving} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={saving || readyCount === 0}
            onClick={submit}
          >
            {saving ? 'Saving…' : `Save ${plural(readyCount, 'time')}`}
          </button>
        </>
      }
    >
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.55 }}>
        Recording {plural(operations.length, 'operation')} against the {plural(modelCount, 'ticked model')},
        without running a stopwatch. Each operation is saved only against the ticked models it
        applies to — shown under its name. Minutes is the only thing needed — operator and note
        are optional, and an operation left blank simply isn&apos;t recorded.
      </p>
      {lockedCount > 0 && (
        <p
          style={{
            margin: '0 0 16px', padding: '9px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.55,
            background: 'var(--amber-bg)', border: '1px solid #fde68a', color: '#92400e',
          }}
        >
          <strong>
            {lockedCount === 1 ? '1 ticked operation applies' : `${lockedCount} ticked operations apply`} to
            none of the ticked models
          </strong>{' '}
          and can&apos;t be recorded here. Link {lockedCount === 1 ? 'it' : 'them'} to the models first
          (Link models), or untick {lockedCount === 1 ? 'it' : 'them'}.
        </p>
      )}

      {/* ── Apply to all: type once, fill down. A convenience only — see the note above. ── */}
      <div className="mt-apply">
        <span className="mt-apply-title">Apply to all rows</span>
        <div className="mt-apply-fields">
          <div className="mt-apply-field">
            <label className="label">Operator</label>
            <OperatorSelect
              operators={operators}
              value={allOperatorId}
              disabled={saving}
              ariaLabel="Operator to apply to every row"
              onChange={setAllOperatorId}
            />
            <button
              type="button" className="btn-ghost mt-apply-btn"
              disabled={saving || rows.length === 0}
              onClick={() => setRows((prev) => prev.map((r) => ({ ...r, operatorId: allOperatorId })))}
            >
              Fill operator down
            </button>
          </div>
          <div className="mt-apply-field">
            <label className="label">Note</label>
            <input
              type="text" className="input" style={{ width: '100%' }}
              placeholder="Optional — applied to every row"
              value={allNote} disabled={saving}
              onChange={(e) => setAllNote(e.target.value)}
            />
            <button
              type="button" className="btn-ghost mt-apply-btn"
              disabled={saving || rows.length === 0}
              onClick={() => setRows((prev) => prev.map((r) => ({ ...r, note: allNote })))}
            >
              Fill note down
            </button>
          </div>
        </div>
      </div>

      {/* One markup, two layouts. The narrow-width card view is the SAME rows restyled by
          globals.css rather than a second render — see the layout note at the top. */}
      <table className="mt-table">
        <thead>
          <tr>
            <th scope="col">Operation</th>
            <th scope="col" className="mt-col-minutes">Minutes *</th>
            <th scope="col" className="mt-col-operator">Operator</th>
            <th scope="col" className="mt-col-note">Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.operationId}>
              <td className="mt-cell-op">
                {row.operationName}
                {/* What this row lands against — not the tick list, the part of it this
                    operation applies to. */}
                <div style={{ fontSize: 11, fontWeight: 400, marginTop: 3, lineHeight: 1.45, color: appliesToNone(row.operationId) ? '#92400e' : 'var(--text-muted)' }}>
                  {appliesToNone(row.operationId)
                    ? 'Applies to none of the ticked models — won’t be saved.'
                    : (modelsByOperation[row.operationId].length === modelCount
                        ? `Saves against all ${plural(modelCount, 'ticked model')}`
                        : `Saves against ${modelsByOperation[row.operationId].length} of ${modelCount}: `
                          + modelsByOperation[row.operationId].map((m) => m.model).join(', '))}
                </div>
              </td>
              <td>
                <span className="mt-cell-label">Minutes *</span>
                <input
                  type="number" min={0} step="0.01" inputMode="decimal"
                  className="input mt-minutes"
                  aria-label={`Minutes for ${row.operationName}`}
                  value={appliesToNone(row.operationId) ? '' : row.minutes}
                  disabled={saving || appliesToNone(row.operationId)}
                  title={appliesToNone(row.operationId) ? 'This operation applies to none of the ticked models' : undefined}
                  autoFocus={i === 0 && !appliesToNone(row.operationId)}
                  onChange={(e) => updateRow(row.operationId, { minutes: e.target.value })}
                />
              </td>
              <td>
                <span className="mt-cell-label">Operator</span>
                <OperatorSelect
                  operators={operators}
                  value={row.operatorId}
                  disabled={saving}
                  ariaLabel={`Operator timed for ${row.operationName}`}
                  onChange={(operatorId) => updateRow(row.operationId, { operatorId })}
                />
              </td>
              <td>
                <span className="mt-cell-label">Note</span>
                <input
                  type="text" className="input" style={{ width: '100%' }}
                  placeholder="Optional"
                  aria-label={`Note for ${row.operationName}`}
                  value={row.note} disabled={saving}
                  onChange={(e) => updateRow(row.operationId, { note: e.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {shown && (
        <p
          style={{
            margin: '14px 0 0', padding: '9px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.55,
            background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)',
          }}
        >
          {shown}
        </p>
      )}
    </Modal>
  )
}
