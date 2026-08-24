'use client'

import { useMemo, useState } from 'react'
import ConfirmDialog from '@/components/ConfirmDialog'
import type { Job, Stage, Team } from '@/lib/types'

/**
 * The shared job editor — /setup and /collect both open this from the ✎ on a job row, so the
 * rename + re-stage rules can't drift between them.
 *
 * It edits the two things that belong together: the job's name, and where it sits in the walk.
 * Moving it between LINES is a different question with different consequences (a line change
 * unstages the job, because stages belong to one line) and lives in the separate JobFormModal
 * behind "Team / Line".
 *
 * The re-stage itself is not written here. The caller's onSave routes it through stages.ts'
 * setJobStage, which syncs the job's team and line FROM the target stage — a job under a Team 2
 * stage that still reports Team 1 is a walk contradicting itself. That is why a stage change
 * always asks first and a plain rename doesn't: picking a stage can move the job between teams.
 */

const ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export default function JobEditDrawer({
  job, stages, teams, operationCount, onSave, onSaved, onClose,
}: {
  job: Job
  /** Every stage on the job's line, all teams — pre-sorted into walk order. */
  stages: Stage[]
  teams: Team[]
  /** The job's active operation count, so the confirm can say how much moves with it. */
  operationCount: number
  onSave: (job: Job, name: string, stage: Stage | null) => Promise<void>
  /** Called after a successful write with the line to show on the page behind the drawer. */
  onSaved: (summary: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(job.name)
  // A stage_id pointing outside this line's stages reads as Unstaged, the same way pane 1
  // buckets it — never as a blank select.
  const [stageId, setStageId] = useState(
    job.stage_id && stages.some((s) => s.id === job.stage_id) ? job.stage_id : ''
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const teamNameById = useMemo(() => new Map(teams.map((t) => [t.id, t.name])), [teams])

  /** Stages grouped under their team, teams in name order, stages left in walk order within
   * each — the grouping is the only thing that makes a cross-team target legible. */
  const stageGroups = useMemo(() => {
    const byTeam = new Map<string, Stage[]>()
    for (const stage of stages) {
      const key = stage.team_id ?? ''
      const list = byTeam.get(key)
      if (list) list.push(stage)
      else byTeam.set(key, [stage])
    }
    return [...byTeam.entries()]
      .map(([teamId, group]) => ({ teamId, teamName: teamNameById.get(teamId) ?? 'No team', stages: group }))
      .sort((a, b) => a.teamName.localeCompare(b.teamName))
  }, [stages, teamNameById])

  const targetStage = stages.find((s) => s.id === stageId) ?? null
  const targetTeamName = targetStage ? teamNameById.get(targetStage.team_id ?? '') ?? 'No team' : null
  const currentTeamName = job.teams?.name ?? 'No team'

  const trimmedName = name.trim()
  const nameChanged = Boolean(trimmedName) && trimmedName !== job.name
  const stageChanged = (targetStage?.id ?? null) !== (job.stage_id ?? null)
  const dirty = nameChanged || stageChanged
  const movingTeam = Boolean(targetStage) && targetTeamName !== currentTeamName

  async function commit() {
    setConfirming(false)
    setSaving(true); setError(null)
    try {
      await onSave(job, trimmedName || job.name, targetStage)
      const finalName = trimmedName || job.name
      const summary = stageChanged
        ? targetStage
          ? `Moved "${finalName}" to ${targetStage.name} · ${targetTeamName}`
          : `"${finalName}" is now Unstaged — it stays in ${currentTeamName}`
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
          <div className="gaps-drawer-title">Edit job</div>
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
          />
        </div>

        <div>
          <label className="label">Stage</label>
          {stages.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              This job&apos;s production line has no stages, so there is nothing to reassign it to.
              Add stages on the left, or use Team / Line to move the job to another line.
            </p>
          ) : (
            <>
              <select
                className="select"
                style={{ width: '100%' }}
                value={stageId}
                disabled={saving}
                onChange={(e) => setStageId(e.target.value)}
              >
                <option value="">— Unstaged —</option>
                {stageGroups.map((group) => (
                  <optgroup key={group.teamId || 'no-team'} label={group.teamName}>
                    {group.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </optgroup>
                ))}
              </select>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0', lineHeight: 1.5 }}>
                {targetStage
                  ? movingTeam
                    ? `Moves this job from ${currentTeamName} to ${targetTeamName} — a job belongs to the team that owns its stage.`
                    : `Stays in ${currentTeamName}.`
                  : `Clears the stage only. The job stays in ${currentTeamName}.`}
              </p>
            </>
          )}
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 20px', display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', flexShrink: 0, background: 'var(--surface)' }}>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>Close</button>
        <button
          type="button"
          className="btn-primary"
          disabled={saving || !dirty || !trimmedName}
          // A stage change moves the job (and its whole operation list) between teams, so it
          // always asks first. A plain rename doesn't need a gate.
          onClick={() => (stageChanged ? setConfirming(true) : commit())}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {confirming && (
        <ConfirmDialog
          title={targetStage ? `Move to ${targetStage.name}` : 'Unstage this job'}
          message={targetStage
            ? `"${job.name}" and all ${plural(operationCount, 'operation')} under it move to ${targetStage.name} (${targetTeamName}). ` +
              'Their recorded times move with them — nothing is re-collected or lost. ' +
              (movingTeam
                ? `The job leaves ${currentTeamName}, so it will drop out of the list behind this drawer if your current filter doesn't cover ${targetTeamName}.`
                : 'It stays in the same team.')
            : `"${job.name}" leaves the walk and becomes Unstaged, along with all ${plural(operationCount, 'operation')} under it. ` +
              `It stays in ${currentTeamName} — only its stage is cleared.`}
          confirmLabel={targetStage ? 'Move job' : 'Unstage'}
          onConfirm={commit}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  )
}
