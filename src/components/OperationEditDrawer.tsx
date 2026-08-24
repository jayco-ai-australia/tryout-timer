'use client'

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import OperatorAssign, { type OperatorOption } from '@/components/OperatorAssign'
import { renameOperation } from '@/lib/operations'
import type { Operation } from '@/lib/types'

/**
 * The shared operation editor — /setup and /collect both open this from the ✎ on an operation
 * row, so what "editing an operation" means is one thing in the app rather than one per screen.
 *
 * It holds the two edits an operation actually has: its name, and who is assigned to it. The
 * name goes through lib/operations' renameOperation (the only writer of operations.name); the
 * operators go through the shared OperatorAssign, which owns its own writes and saves each
 * select on change — so the Save button below is the RENAME's, not the whole drawer's, and the
 * hint under the operator block says so rather than leaving it ambiguous.
 *
 * Operator assignment is phase-1 context only: nothing in the app waits on it, no time is
 * attributed by it (the operator is picked per captured time), and an operation with nobody
 * assigned is a normal state. A caller with no operator list simply passes an empty array and
 * the block is left off.
 *
 * Deliberately does NOT offer delete or move-to-another-job. Both are structural acts with
 * consequences beyond one operation — a delete cascades its recorded times away — and they
 * stay on /setup, which is the screen for restructuring.
 */
export default function OperationEditDrawer({
  operation, jobName, operators, supabase, onSaved, onClose,
}: {
  operation: Operation
  /** Shown in the header so the operation is identified by where it lives, not just its name. */
  jobName: string
  /** All active operators. Empty → the assignment block is hidden entirely. */
  operators: OperatorOption[]
  supabase: SupabaseClient
  /** Re-read whatever the host shows for this operation. Called after every successful write. */
  onSaved: () => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(operation.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const trimmed = name.trim()
  const nameChanged = Boolean(trimmed) && trimmed !== operation.name

  async function commitRename() {
    if (!nameChanged) return
    setSaving(true); setError(null); setNotice(null)
    try {
      await renameOperation(supabase, operation.id, trimmed)
      await onSaved()
      setNotice(`Renamed to "${trimmed}"`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename this operation')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="gaps-drawer-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="gaps-drawer-title">Edit operation</div>
          <div className="gaps-drawer-jobname">{operation.name} · {jobName}</div>
        </div>
        <button className="gaps-drawer-close" onClick={onClose} aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="gaps-drawer-body" style={{ padding: '16px 20px', flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {error && (
          <p style={{ padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13, marginBottom: 14 }}>
            {error}
          </p>
        )}
        {notice && (
          <p style={{ padding: '9px 14px', borderRadius: 8, background: 'var(--green-bg)', border: '1px solid #bbf7d0', color: '#15803d', fontSize: 13, marginBottom: 14 }}>
            {notice}
          </p>
        )}

        <div style={{ marginBottom: 18 }}>
          <label className="label">Operation name</label>
          <input
            autoFocus
            className="input"
            style={{ width: '100%' }}
            value={name}
            disabled={saving}
            onChange={(e) => { setName(e.target.value); setNotice(null); setError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename() } }}
          />
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0', lineHeight: 1.5 }}>
            Renaming changes the operation everywhere it appears. Its recorded times, model links
            and notes are untouched — they hang off the operation, not its name.
          </p>
        </div>

        {operators.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 10 }}>
              Assigned operators
            </div>
            <OperatorAssign
              operationId={operation.id}
              primaryOperatorId={operation.primary_operator_id ?? ''}
              secondaryOperatorId={operation.secondary_operator_id}
              options={operators}
              onChange={() => { onSaved() }}
            />
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 0', lineHeight: 1.5 }}>
              Saved as soon as you pick one — the Save button below is for the name. Assignment is
              context only: the operator a time counts for is chosen when that time is recorded.
            </p>
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 20px', display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', flexShrink: 0, background: 'var(--surface)' }}>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>Close</button>
        <button type="button" className="btn-primary" disabled={saving || !nameChanged} onClick={commitRename}>
          {saving ? 'Saving…' : 'Save name'}
        </button>
      </div>
    </>
  )
}
