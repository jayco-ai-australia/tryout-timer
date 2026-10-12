'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import Modal from './Modal'
import { fmtMinutesTotal } from './SectionMergeSummary'
import { StructureFailureBox, toStructureFailure, type StructureFailure } from './StructureFailure'
import { plural } from '@/lib/format'
import { resetLineTopologyCache } from '@/lib/lines'
import {
  moveSectionAcrossTeams, preflightSectionMove, type SectionMovePlan,
} from '@/lib/sectionManager'
import type { Section, Team } from '@/lib/types'

/**
 * "Move to another team" for one section — THE dialog, on every screen that offers the move
 * (/setup's Sections pane, /line-config's Sections column, /config's Sections tab), so the
 * confirm says the same thing and the write does the same thing wherever it is opened.
 *
 * Every read and write is lib/sectionManager's preflightSectionMove / moveSectionAcrossTeams.
 * SAME PRODUCTION LINE ONLY: the picker lists the other teams on the section's own line and
 * nothing else — a team on another line is not offered, here or anywhere. jobs.team_id and every
 * recorded time's team stamp follow the section. The preflight runs as soon as a team is picked,
 * so the confirm states real counts before anything is pressed; the write re-runs it.
 */
export interface SectionMoveOutcome {
  /** The section as it now stands — enough for a host to follow it to where it landed. */
  section: { id: string; team_id: string; production_line_id: string }
  plan: SectionMovePlan
}

type TeamOption = Pick<Team, 'id' | 'name' | 'production_line_id'>

const BODY_TEXT: React.CSSProperties = { fontSize: 14, color: 'var(--text-mid)', lineHeight: 1.6, margin: '0 0 12px' }
const FIELD: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }
const ERR_BOX: React.CSSProperties = { marginTop: 10, padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13, lineHeight: 1.55 }

export default function SectionTeamMoveDialog({
  supabase, section, teams, onMoved, onChanged, onClose,
}: {
  supabase: SupabaseClient
  section: Section
  /** Any list of teams that includes the section's line's. Teams on other lines are ignored —
   * the dialog filters to the section's own line itself, so no host can offer a cross-line move. */
  teams: TeamOption[]
  onMoved: (outcome: SectionMoveOutcome, summary: string) => void | Promise<void>
  /** Called when a move stopped part-way — something was written, so the host should re-read. */
  onChanged?: () => void
  onClose: () => void
}) {
  const [teamId, setTeamId] = useState('')
  const [plan, setPlan] = useState<SectionMovePlan | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<StructureFailure | null>(null)

  const options = teams
    .filter((t) => t.production_line_id === section.production_line_id && t.id !== section.team_id)
    .sort((a, b) => a.name.localeCompare(b.name))
  const currentTeamName = teams.find((t) => t.id === section.team_id)?.name ?? 'its current team'

  // The counts are read when a destination is picked — the moment the confirm has something to
  // state — and again by the write itself.
  useEffect(() => {
    setPlan(null); setFailure(null)
    if (!teamId) return
    let cancelled = false
    setChecking(true)
    preflightSectionMove(supabase, section.id, teamId)
      .then((p) => { if (!cancelled) setPlan(p) })
      .catch((err) => { if (!cancelled) setFailure(toStructureFailure(err, 'Could not check this move')) })
      .finally(() => { if (!cancelled) setChecking(false) })
    return () => { cancelled = true }
  }, [supabase, section.id, teamId])

  async function confirm() {
    if (!plan || plan.blockedReason) return
    setSaving(true); setFailure(null)
    try {
      const { plan: ran } = await moveSectionAcrossTeams(supabase, section.id, teamId)
      // The Labour Matrix and Model Total read line topology through lib/lines' cache.
      resetLineTopologyCache()
      const jobs = ran.activeJobCount + ran.retiredJobCount
      await onMoved(
        { section: { id: section.id, team_id: ran.targetTeam.id, production_line_id: ran.targetTeam.production_line_id }, plan: ran },
        `"${section.name}" moved from ${currentTeamName} to ${ran.targetTeam.name}` +
        ` — ${plural(jobs, 'job')} and ${plural(ran.timeRecordCount, 'time record')} went with it.`
      )
    } catch (err) {
      setFailure(toStructureFailure(err, 'Could not move this section'))
      setSaving(false)
      resetLineTopologyCache()
      onChanged?.()
    }
  }

  return (
    <Modal
      title={`Move "${section.name}" to another team`} onClose={saving ? () => {} : onClose} maxWidth={540}
      footer={(
        <>
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={confirm} disabled={!plan || Boolean(plan.blockedReason) || checking || saving}>
            {saving ? 'Moving…' : plan ? `Move to ${plan.targetTeam.name}` : 'Move'}
          </button>
        </>
      )}
    >
      <p style={BODY_TEXT}>
        {`"${section.name}" is on ${currentTeamName}. Its jobs, their operations and every recorded time under them move with it.`}
      </p>
      <div style={FIELD}>
        <label className="label">Destination team</label>
        <select className="select" value={teamId} disabled={saving} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">— Select a team —</option>
          {options.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      {options.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>This line has no other team to move it to.</p>
      )}
      {checking && <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '12px 0 0' }}>Checking…</p>}
      {plan && !plan.blockedReason && (
        <ul style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.7, margin: '4px 0 0', paddingLeft: 20 }}>
          <li>
            {`${plural(plan.activeJobCount, 'job')} will change team to ${plan.targetTeam.name}`}
            {plan.retiredJobCount > 0 && `, plus ${plural(plan.retiredJobCount, 'retired job')} still filed here`}
          </li>
          <li>{`${plural(plan.operationCount, 'operation')} go with those jobs, untouched`}</li>
          <li>{`${plural(plan.timeRecordCount, 'time record')} (${fmtMinutesTotal(plan.totalMinutes)}) will be re-stamped to ${plan.targetTeam.name}`}</li>
          <li>The section keeps its place in the line’s sequence</li>
        </ul>
      )}
      {plan?.blockedReason && <p style={ERR_BOX}>{plan.blockedReason}</p>}
      {failure && <StructureFailureBox failure={failure} />}
    </Modal>
  )
}
