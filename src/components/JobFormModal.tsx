'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import Modal from '@/components/Modal'
import { findSectionTray } from '@/lib/sections'
import type { Job, ProductionLine, Section } from '@/lib/types'

/**
 * The shared job add/edit form — name and production line. /setup and /collect both open it
 * behind "Line" on a selected job, and /setup also uses it to add one.
 *
 * It is deliberately separate from JobEditDrawer, which handles name + section. This form is the
 * one that can move a job to a different LINE, and a line change has a consequence a section
 * change doesn't: sections belong to exactly one line, so the job can't keep pointing at a step
 * of the line it just left — it lands in the new line's unsorted tray instead.
 *
 * There is deliberately NO team picker here. A job's team is its SECTION's team (see
 * lib/sections' teamForJob) and is changed by moving the job to another section, in
 * JobEditDrawer. A select writing jobs.team_id would let a job claim a team its section doesn't
 * belong to — a contradiction nothing on screen would show, because nothing reads that column.
 */

const ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}

export default function JobFormModal({
  mode, job, defaultLineId, lines, sections, supabase, onClose, onSaved,
}: {
  mode: 'add' | 'edit'
  job?: Job
  defaultLineId: string
  lines: ProductionLine[]
  /** Every loaded section — used only to find the target line's unsorted tray. */
  sections: Section[]
  supabase: SupabaseClient
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(job?.name ?? '')
  const [formLineId, setFormLineId] = useState(job?.production_line_id ?? defaultLineId ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const lineChanged = formLineId !== (job?.production_line_id ?? '')
  /**
   * Where a job lands on the line it is being moved to: an unsorted tray on that line — but only
   * when there is one obvious candidate. Trays are per TEAM (see lib/sections), and a job
   * arriving on a new line has no team there: its old team belongs to the line it just left. So
   * no team is passed, findSectionTray answers only for a line with a single tray, and on a line
   * with several the job arrives with no section at all rather than being dropped into some
   * team's inbox at random. It then shows under that line's "No section" row until somebody
   * files it, which is the same visible outcome as the tray with none of the false ownership.
   */
  const targetTray = findSectionTray(sections, formLineId)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true); setError(null)
    const payload: Record<string, unknown> = { name: name.trim(), production_line_id: formLineId || null }
    // Sections belong to one line, so a job arriving on a different line can't keep its old
    // section. It goes into the new line's unsorted tray — and its team goes with the section,
    // which for a tray means none until somebody files it.
    if (mode === 'add' || lineChanged) {
      payload.section_id = targetTray?.id ?? null
      payload.team_id = targetTray?.team_id ?? null
    }
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
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
          A job&apos;s team comes from its section — use Edit / reassign to move it to another
          section, and it moves to that section&apos;s team with it.
        </p>
        {mode === 'edit' && lineChanged && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            {targetTray
              ? 'Moving this job to another line puts it in that line’s No Section tray — sections belong to one line, so it starts there unsorted.'
              : 'Moving this job to another line clears its section — sections belong to one line and a No Section tray belongs to one team, and this job has no team on the line it’s moving to. It’ll show under “No section” there until you file it.'}
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
