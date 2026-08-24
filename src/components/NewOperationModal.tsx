'use client'

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import Modal from '@/components/Modal'
import { linkOperationToModel } from '@/lib/modelOperations'
import { createOperation } from '@/lib/operations'

const ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}

/**
 * The one place an operation is created inline from a drill-down — /tryouts (walking a van) and
 * /collect (filling coverage) both open this, so the insert, the validation and the defaults
 * can't drift between them. /setup has its own richer form because it also assigns operators;
 * the insert it performs is the same shape.
 *
 * What differs between callers is only what happens to the applies-list afterwards, and that is
 * carried by `autoLinkProductId`:
 *   - /tryouts passes the van's product id. An operation created while walking a van is by
 *     definition one that applies to that van, so it joins the applies-list in the same breath
 *     as being created — otherwise it would be created and then instantly filtered out of the
 *     view that created it. Exactly one product is linked: that van's.
 *   - /collect passes null. Coverage collection is model-scoped, not van-scoped — there is no
 *     single model the new operation obviously applies to, so it starts with no links and the
 *     operator picks its models in the Models pane. Auto-linking here would silently invent
 *     applicability nobody asserted.
 */
export default function NewOperationModal({
  supabase, jobId, jobName, autoLinkProductId, hint, submitLabel = 'Create', busyLabel = 'Creating…',
  onClose, onCreated,
}: {
  supabase: SupabaseClient
  jobId: string
  jobName: string
  /** The one model to link the new operation to, or null to create it with no links at all. */
  autoLinkProductId: string | null
  /** Caller's one-liner under the field, saying what happens next on that screen. */
  hint?: React.ReactNode
  submitLabel?: string
  busyLabel?: string
  onClose: () => void
  onCreated: (operationId: string, operationName: string, jobName: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true); setError(null)

    // Name + job only — the operator is picked per captured time on these screens, so no
    // primary/secondary assignment is made here. The insert itself is lib/operations'
    // createOperation, the same one /setup's form and /collect's quick-add call, so the
    // defaults (is_active in particular) are decided in exactly one place.
    let data: { id: string; name: string }
    try {
      data = await createOperation(supabase, { name: trimmed, jobId })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create operation')
      setSaving(false)
      return
    }

    if (autoLinkProductId) {
      try {
        await linkOperationToModel(supabase, data.id, autoLinkProductId)
      } catch (err) {
        // The operation exists — say why it won't show up in the model's list rather than
        // pretending the whole create failed.
        setError(`Created "${data.name}", but it couldn't be linked to this model: ${err instanceof Error ? err.message : 'unknown error'}`)
        setSaving(false)
        return
      }
    }

    await onCreated(data.id, data.name, jobName)
  }

  return (
    <Modal title={`Add operation — ${jobName}`} onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label className="label">Operation Name *</label>
          <input className="input" style={{ width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </div>
        {hint && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>{hint}</p>}
        {error && <p style={ERR_BOX}>{error}</p>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving || !name.trim()}>
            {saving ? busyLabel : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}
