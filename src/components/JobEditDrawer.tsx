'use client'

import { useMemo, useState } from 'react'
import ConfirmDialog from '@/components/ConfirmDialog'
import { teamForJob } from '@/lib/sections'
import type { Job, Section, Team } from '@/lib/types'

/**
 * The shared job editor — /setup, /collect and /tryouts all open this from the ✎ on a job row,
 * so the rename + re-section rules can't drift between them.
 *
 * It edits the two things that belong together: the job's name, and where it sits in the walk.
 * Moving it between LINES is a different question with different consequences (a line change
 * unsections the job, because sections belong to one line) and lives in the separate JobFormModal
 * behind "Line".
 *
 * The re-section itself is not written here. The caller's onSave routes it through sections.ts'
 * setJobSection, which syncs the job's team and line FROM the target section — a job under a Team 2
 * section that still reports Team 1 is a walk contradicting itself. That is why a section change
 * always asks first and a plain rename doesn't: picking a section can move the job between teams.
 *
 * ── nameOnly ──────────────────────────────────────────────────────────────────────────────
 * /tryouts opens this with `nameOnly`, which leaves the Section control off and nothing else.
 * The reason is the screen, not the drawer: /tryouts is somebody walking one van, and a
 * re-section can move a job to another team, at which point it drops out of the pane they are
 * mid-walk through. Renaming a badly-named job is a five-second fix that shouldn't be able to
 * turn into that. It stays the same component and the same write path — the alternative was a
 * fourth inline rename, which is exactly the divergence this drawer exists to end.
 */

const ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export default function JobEditDrawer({
  job, sections, teams, operationCount, nameOnly = false, onSave, onSaved, onClose,
}: {
  job: Job
  /** Every section on the job's line, all teams — pre-sorted into walk order. */
  sections: Section[]
  teams: Team[]
  /** The job's active operation count, so the confirm can say how much moves with it. */
  operationCount: number
  /** Rename only — the Section control is left off entirely. See the note above; this is a
   * property of the SCREEN opening the drawer, not of the job. */
  nameOnly?: boolean
  onSave: (job: Job, name: string, section: Section | null) => Promise<void>
  /** Called after a successful write with the line to show on the page behind the drawer. */
  onSaved: (summary: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(job.name)
  // A section_id pointing outside this line's sections reads as Unsectioned, the same way pane 1
  // buckets it — never as a blank select.
  const [sectionId, setSectionId] = useState(
    job.section_id && sections.some((s) => s.id === job.section_id) ? job.section_id : ''
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const teamNameById = useMemo(() => new Map(teams.map((t) => [t.id, t.name])), [teams])

  /** Sections grouped under their team, teams in name order, sections left in walk order within
   * each — the grouping is the only thing that makes a cross-team target legible. */
  const sectionGroups = useMemo(() => {
    const byTeam = new Map<string, Section[]>()
    for (const section of sections) {
      const key = section.team_id ?? ''
      const list = byTeam.get(key)
      if (list) list.push(section)
      else byTeam.set(key, [section])
    }
    return [...byTeam.entries()]
      .map(([teamId, group]) => ({ teamId, teamName: teamNameById.get(teamId) ?? 'No team', sections: group }))
      .sort((a, b) => a.teamName.localeCompare(b.teamName))
  }, [sections, teamNameById])

  // In nameOnly mode the section is never offered, so it is never a change: the target is the
  // job's own section, whatever that is. Without this, a caller passing a `sections` list that
  // doesn't contain the job's section would silently save a re-section to null.
  const targetSection = nameOnly
    ? sections.find((s) => s.id === job.section_id) ?? null
    : sections.find((s) => s.id === sectionId) ?? null
  const targetTeamName = targetSection ? teamNameById.get(targetSection.team_id ?? '') ?? 'No team' : null
  /** Derived from the job's SECTION, not from jobs.team_id — the section owns the team (see
   * teamForJob), and the joined jobs.teams is only the fallback for a job with no section. */
  const currentTeamId = teamForJob(job, new Map(sections.map((sec) => [sec.id, sec])))
  const currentTeamName = currentTeamId ? teamNameById.get(currentTeamId) ?? 'No team' : 'Unsorted'

  const trimmedName = name.trim()
  const nameChanged = Boolean(trimmedName) && trimmedName !== job.name
  const sectionChanged = !nameOnly && (targetSection?.id ?? null) !== (job.section_id ?? null)
  const dirty = nameChanged || sectionChanged
  const movingTeam = Boolean(targetSection) && targetTeamName !== currentTeamName

  async function commit() {
    setConfirming(false)
    setSaving(true); setError(null)
    try {
      await onSave(job, trimmedName || job.name, targetSection)
      const finalName = trimmedName || job.name
      const summary = sectionChanged
        ? targetSection
          ? `Moved "${finalName}" to ${targetSection.name} · ${targetTeamName}`
          : `"${finalName}" now has no section — it stays in ${currentTeamName}`
        : `Renamed to "${finalName}"`
      onSaved(summary)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this job')
      setSaving(false)
    }
  }

  return (
    <>
      <div className="gaps-drawer-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="gaps-drawer-title">{nameOnly ? 'Rename job' : 'Edit job'}</div>
          <div className="gaps-drawer-jobname">
            {job.name} · {currentTeamName} · {plural(operationCount, 'operation')}
          </div>
        </div>
        <button className="gaps-drawer-close" onClick={onClose} aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="gaps-drawer-body" style={{ padding: '16px 20px', flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {error && <p style={{ ...ERR_BOX, marginBottom: 14 }}>{error}</p>}

        <div style={{ marginBottom: 18 }}>
          <label className="label">Job name</label>
          <input
            autoFocus
            className="input"
            style={{ width: '100%' }}
            value={name}
            disabled={saving}
            onChange={(e) => setName(e.target.value)}
            // Only where there is nothing else to fill in. With the Section select present,
            // Enter in the name field would commit before the user reached it.
            onKeyDown={(e) => {
              if (nameOnly && e.key === 'Enter') {
                e.preventDefault()
                if (!saving && nameChanged) commit()
              }
            }}
          />
          {nameOnly && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0', lineHeight: 1.5 }}>
              The name only. Recorded times, model links and this try-out are untouched — they
              hang off the job, not what it is called.
            </p>
          )}
        </div>

        {!nameOnly && (
        <div>
          <label className="label">Section</label>
          {sections.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              This job&apos;s production line has no sections, so there is nothing to reassign it to.
              Add sections on the left, or use Line to move the job to another line.
            </p>
          ) : (
            <>
              <select
                className="select"
                style={{ width: '100%' }}
                value={sectionId}
                disabled={saving}
                onChange={(e) => setSectionId(e.target.value)}
              >
                <option value="">— No section —</option>
                {sectionGroups.map((group) => (
                  <optgroup key={group.teamId || 'no-team'} label={group.teamName}>
                    {group.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </optgroup>
                ))}
              </select>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0', lineHeight: 1.5 }}>
                {targetSection
                  ? movingTeam
                    ? `Moves this job from ${currentTeamName} to ${targetTeamName} — a job belongs to the team that owns its section.`
                    : `Stays in ${currentTeamName}.`
                  : `Clears the section only. The job stays in ${currentTeamName}.`}
              </p>
            </>
          )}
        </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 20px', display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', flexShrink: 0, background: 'var(--surface)' }}>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>Close</button>
        <button
          type="button"
          className="btn-primary"
          disabled={saving || !dirty || !trimmedName}
          // A section change moves the job (and its whole operation list) between teams, so it
          // always asks first. A plain rename doesn't need a gate.
          onClick={() => (sectionChanged ? setConfirming(true) : commit())}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {confirming && (
        <ConfirmDialog
          title={targetSection ? `Move to ${targetSection.name}` : 'Unsection this job'}
          message={targetSection
            ? `"${job.name}" and all ${plural(operationCount, 'operation')} under it move to ${targetSection.name} (${targetTeamName}). ` +
              'Their recorded times move with them — nothing is re-collected or lost. ' +
              (movingTeam
                ? `The job leaves ${currentTeamName}, so it will drop out of the list behind this drawer if your current filter doesn't cover ${targetTeamName}.`
                : 'It stays in the same team.')
            : `"${job.name}" leaves the walk and ends up with no section, along with all ${plural(operationCount, 'operation')} under it. ` +
              `It stays in ${currentTeamName} — only its section is cleared.`}
          confirmLabel={targetSection ? 'Move job' : 'Unsection'}
          onConfirm={commit}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  )
}
