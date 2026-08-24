'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import Modal from '@/components/Modal'
import type { Job, ProductionLine, Team } from '@/lib/types'

/**
 * The shared job add/edit form — name, production line, team. /setup and /collect both open it
 * behind "Team / Line" on a selected job, and /setup also uses it to add one.
 *
 * It is deliberately separate from JobEditDrawer, which handles name + stage. This form is the
 * one that can move a job to a different LINE, and a line change has a consequence a stage
 * change doesn't: stages belong to exactly one line, so the job's stage_id is cleared or it
 * would keep pointing at a step of the line it just left.
 */

const ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}

export default function JobFormModal({
  mode, job, defaultLineId, defaultTeamId, lines, allTeams, supabase, onClose, onSaved,
}: {
  mode: 'add' | 'edit'
  job?: Job
  defaultLineId: string
  defaultTeamId: string
  lines: ProductionLine[]
  allTeams: Team[]
  supabase: SupabaseClient
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(job?.name ?? '')
  const [formLineId, setFormLineId] = useState(job?.production_line_id ?? defaultLineId ?? '')
  const [formTeamId, setFormTeamId] = useState(job?.team_id ?? defaultTeamId ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const teamOptions = allTeams.filter((t) => !formLineId || t.production_line_id === formLineId)

  // If the chosen line changes such that the current team no longer belongs to it, clear it.
  useEffect(() => {
    if (formTeamId && !teamOptions.some((t) => t.id === formTeamId)) setFormTeamId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formLineId])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true); setError(null)
    const payload: Record<string, unknown> = { name: name.trim(), production_line_id: formLineId || null, team_id: formTeamId || null }
    // Stages belong to one line, so moving a job to a different line has to unstage it —
    // otherwise its stage_id keeps pointing at a step of the line it just left.
    if (mode === 'edit' && job?.stage_id && formLineId !== job.production_line_id) payload.stage_id = null
    const { error: err } = mode === 'add'
      ? await supabase.from('jobs').insert(payload)
      : await supabase.from('jobs').update(payload).eq('id', job!.id)
    if (err) { setError(err.message); setSaving(false); return }
    setSaving(false)
    await onSaved()
    onClose()
  }

  return (
    <Modal title={mode === 'add' ? 'Add Job' : 'Edit Job'} onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label className="label">Job Name *</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </div>
        <div>
          <label className="label">Production Line</label>
          <select className="select" style={{ width: '100%' }} value={formLineId} onChange={(e) => setFormLineId(e.target.value)}>
            <option value="">— None —</option>
            {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Team</label>
          <select className="select" style={{ width: '100%' }} value={formTeamId} onChange={(e) => setFormTeamId(e.target.value)}>
            <option value="">— None —</option>
            {teamOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        {mode === 'edit' && job?.stage_id && formLineId !== job.production_line_id && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            Moving this job to another line unstages it — stages belong to one line, so it lands in Unstaged there.
          </p>
        )}
        {error && <p style={ERR_BOX}>{error}</p>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={saving || !name.trim()} className="btn-primary">
            {saving ? 'Saving…' : mode === 'add' ? 'Add Job' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
