'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Profile, ProductionLine } from '@/lib/types'

interface Props {
  profile: Profile
  email: string
  lines: ProductionLine[]
}

const ERR_BOX: React.CSSProperties = { padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13 }
const OK_BOX: React.CSSProperties = { padding: '9px 14px', borderRadius: 8, background: 'var(--green-bg)', border: '1px solid #86efac', color: '#15803d', fontSize: 13 }
const READONLY: React.CSSProperties = { background: 'var(--bg)', color: 'var(--text-mid)', cursor: 'not-allowed' }

export default function ProfileClient({ profile, email, lines }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [fullName, setFullName] = useState(profile.full_name ?? '')
  const [lineId, setLineId] = useState(profile.production_line_id ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setSaving(true); setError(null); setSaved(false)
    const { error: err } = await supabase
      .from('profiles')
      .update({ full_name: fullName.trim() || null, production_line_id: lineId || null })
      .eq('id', profile.id)
    if (err) setError(err.message)
    else setSaved(true)
    setSaving(false)
  }

  return (
    <main className="page" style={{ maxWidth: 480 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Profile Settings</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Your account details and production line preference</p>
      </div>

      <div className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label className="label">Full Name</label>
          <input
            className="input"
            value={fullName}
            onChange={(e) => { setFullName(e.target.value); setSaved(false) }}
            placeholder="Your full name"
          />
        </div>

        <div>
          <label className="label">Email</label>
          <input className="input" style={READONLY} value={email} readOnly />
        </div>

        <div>
          <label className="label">Production Line</label>
          <select
            className="select"
            style={{ width: '100%' }}
            value={lineId}
            onChange={(e) => { setLineId(e.target.value); setSaved(false) }}
          >
            <option value="">— None —</option>
            {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>

        {error && <p style={ERR_BOX}>{error}</p>}
        {saved && <p style={OK_BOX}>Saved</p>}

        <button
          type="button"
          className="btn-primary"
          disabled={saving}
          onClick={handleSave}
          style={{ alignSelf: 'flex-start' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </main>
  )
}
