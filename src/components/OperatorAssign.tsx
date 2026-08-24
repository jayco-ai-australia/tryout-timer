'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export interface OperatorOption { id: string; full_name: string }

export interface OperatorAssignProps {
  operationId: string
  /** Empty string means unassigned — valid on /setup (a freshly-created operation may have no
   * primary yet); a caller with a settled assignment always passes a real id since it shows
   * operations the current operator is already primary or secondary on. */
  primaryOperatorId: string
  secondaryOperatorId: string | null
  /** All active operators — not scoped to a team, matching the rest of the app's convention. */
  options: OperatorOption[]
  onChange?: () => void
}

const ROW_SEL: React.CSSProperties = { minWidth: 0, padding: '5px 8px', fontSize: 12, width: '100%' }
const LABEL: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 4 }

/**
 * Primary/Secondary operator assignment for one operation — used by /setup's
 * drawer and /setup's operation panel so the two can't drift. Writes directly to
 * operations.primary_operator_id / secondary_operator_id (secondary clearable via "None");
 * `onChange` fires after a successful write so the host screen can refetch the operation's
 * current values.
 */
export default function OperatorAssign({ operationId, primaryOperatorId, secondaryOperatorId, options, onChange }: OperatorAssignProps) {
  const [supabase] = useState(() => createClient())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function updatePrimary(newId: string) {
    if (!newId) return
    setSaving(true); setError(null)
    const { error: err } = await supabase.from('operations').update({ primary_operator_id: newId }).eq('id', operationId)
    setSaving(false)
    if (err) { setError(err.message); return }
    onChange?.()
  }

  async function updateSecondary(newId: string) {
    setSaving(true); setError(null)
    const { error: err } = await supabase.from('operations').update({ secondary_operator_id: newId || null }).eq('id', operationId)
    setSaving(false)
    if (err) { setError(err.message); return }
    onChange?.()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={LABEL}>Primary</div>
        <select className="select" style={ROW_SEL} value={primaryOperatorId} disabled={saving} onChange={(e) => updatePrimary(e.target.value)}>
          {!primaryOperatorId && <option value="">— Unassigned —</option>}
          {options.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
        </select>
      </div>
      <div>
        <div style={LABEL}>Secondary</div>
        <select className="select" style={ROW_SEL} value={secondaryOperatorId ?? ''} disabled={saving} onChange={(e) => updateSecondary(e.target.value)}>
          <option value="">— None —</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
        </select>
      </div>
      {error && <p style={{ fontSize: 12, color: 'var(--red)', margin: 0 }}>{error}</p>}
    </div>
  )
}
