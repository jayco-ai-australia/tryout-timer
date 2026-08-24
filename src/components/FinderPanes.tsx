'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import ConfirmDialog from './ConfirmDialog'
import {
  countJobsInStage, createStage, deleteStage, moveStage, renameStage,
} from '@/lib/stages'
import type { Job, Operation, Stage, Team } from '@/lib/types'

/**
 * The shared drill-down panes — the Finder-style columns /setup walks its structure with
 * (Stages → Jobs → Operations → Models) and /tryouts walks one van with (Stages → Jobs →
 * Operations, with running stopwatches instead of a fourth pane).
 *
 * Pane 1 and pane 2 are literally the same components on both screens: a stage list that
 * creates/renames/reorders/deletes through lib/stages, and a job list whose row is "show me
 * this job's operations". Pane 3 differs (the two screens do genuinely different work with an
 * operation), so each owns its own — but both build it out of the `Pane` shell and the
 * .finder-row markup here, which is what keeps the columns looking and behaving like one
 * screen rather than two that resemble each other.
 *
 * Every callback a screen doesn't need is optional: /tryouts has no job-edit drawer and no
 * delete rights to offer, and passing nothing simply leaves those affordances off the row.
 */

type SupabaseClient = ReturnType<typeof createClient>

/** Inline row-edit input — the same look wherever a pane row turns into a text field. */
export const ROW_INPUT: React.CSSProperties = {
  fontSize: 13, fontWeight: 600, fontFamily: 'inherit', color: 'var(--text)',
  background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 6,
  padding: '2px 6px', width: '100%', minWidth: 0, outline: 'none',
}

export const PANE_ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}

/**
 * The virtual first-pane entry that holds every job with no stage — either because the line
 * has no stages at all (Caravan, Motor Home), or because the job hasn't been placed in the walk
 * yet. It is not a `stages` row: it can't be renamed, reordered or deleted, and selecting it
 * means "stage_id IS NULL" in the pane to its right.
 */
export const UNSTAGED_KEY = '__unstaged__'

/** One row of pane 1 — a real stage, or the virtual Unstaged bucket (stage === null). */
export interface StageEntry {
  key: string
  name: string
  stage: Stage | null
  /** Jobs under it within the current filter — i.e. exactly what pane 2 will list. */
  jobCount: number
}

export function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** The small ✎ that turns a pane row into an inline text field. */
export function RenameButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      className="finder-row-action"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      style={{ fontSize: 12 }}
    >
      ✎
    </button>
  )
}

/** The pulsing dot that marks a row with a stopwatch running somewhere beneath it — on the
 * operation itself, and on the job and stage containing it, so navigating away from a running
 * timer still leaves a trail back to it. */
export function RunningDot({ title }: { title: string }) {
  return <span className="finder-running-dot" title={title} aria-label={title} />
}

/** One pane: fixed header, scrolling body, optional pinned footer of actions. */
export function Pane({
  title, subtitle, active, children, footer,
}: {
  title: string
  subtitle: React.ReactNode
  /** True once this pane has something selected — a quiet border cue, not a second selection. */
  active: boolean
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className={'finder-pane' + (active ? ' finder-pane-active' : '')}>
      <div className="finder-pane-header">
        <div className="finder-pane-title">{title}</div>
        <div className="finder-pane-sub">{subtitle}</div>
      </div>
      <div className="finder-pane-body">{children}</div>
      {footer && <div className="finder-pane-footer">{footer}</div>}
    </div>
  )
}

// ── Pane 1: Stages ─────────────────────────────────────────────────────────────────────────
/**
 * The line's walk order, plus the virtual "Unstaged" bucket. Every write goes through the
 * shared lib/stages helpers, so the rules (what sort_order a new stage gets, how a reorder
 * renumbers, what blocks a delete) live in one place.
 *
 * Both production_line_id and team_id are NOT NULL on the table, so with no line in scope there
 * is no stage to create: the add form is replaced by a prompt to pick one. The Unstaged entry
 * is not a row in `stages` and is never editable, reorderable or deletable.
 *
 * `readOnly` turns the pane into pure navigation — the line's stages in walk order, selectable,
 * with no add/rename/reorder/delete anywhere on it. A stage is line-level structure, not
 * something to be restructured while walking a single van, and a Delete button sitting next to
 * the stage you are drilling through is a footgun with no upside. Stage editing lives on
 * /setup, which mounts the same component writable.
 *
 * `allowAdd` re-opens the footer's add form on top of `readOnly`, and nothing else: creating a
 * stage only ever appends one, so it can't reorder or destroy anything already on the line.
 * That's how /tryouts mounts it — a van being walked can turn out to need a step the line
 * doesn't have yet, and having to leave for /setup mid-walk breaks the flow. Rename, reorder
 * and delete stay behind `readOnly`, off.
 */
export function StagesPane({
  supabase, entries, stages, productionLineId, productionLineName, teams, selectedKey,
  runningKeys, readOnly = false, allowAdd = false, onSelect, onChanged,
}: {
  supabase: SupabaseClient
  entries: StageEntry[]
  /** The real stages behind those entries, in walk order — what a reorder writes against. */
  stages: Stage[]
  productionLineId: string
  productionLineName: string | null
  /** The scoped line's teams — a stage's team is required, so an empty list blocks creation. */
  teams: Team[]
  selectedKey: string
  /** Entry keys with a stopwatch running somewhere under them. */
  runningKeys?: Set<string>
  /** Navigation only — no add form, no per-row rename/reorder/delete. */
  readOnly?: boolean
  /** With `readOnly`, brings back the add form alone — create-only, still no rename/reorder/delete. */
  allowAdd?: boolean
  onSelect: (key: string) => void
  onChanged: () => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [busyStageId, setBusyStageId] = useState<string | null>(null)

  const [addingOpen, setAddingOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newTeamId, setNewTeamId] = useState('')
  const [creating, setCreating] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const [blockedDelete, setBlockedDelete] = useState<{ name: string; jobCount: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Stage | null>(null)

  // One team on the line → nothing to choose, so preselect it.
  useEffect(() => {
    if (teams.length === 1) setNewTeamId(teams[0].id)
    else if (!teams.some((t) => t.id === newTeamId)) setNewTeamId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams])

  const teamNameById = useMemo(() => new Map(teams.map((t) => [t.id, t.name])), [teams])
  const stageIndex = useMemo(() => new Map(stages.map((s, i) => [s.id, i])), [stages])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim() || !newTeamId) return
    setCreating(true); setError(null)
    try {
      const created = await createStage(supabase, { name: newName, productionLineId, teamId: newTeamId })
      setNewName('')
      setAddingOpen(false)
      await onChanged()
      // Land on what was just created: a new stage is empty by definition, so the next thing
      // wanted is always the pane to the right of it.
      onSelect(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create stage')
    } finally {
      setCreating(false)
    }
  }

  async function handleRename(stage: Stage) {
    const trimmed = editDraft.trim()
    if (!trimmed || trimmed === stage.name) { setEditingId(null); return }
    setBusyStageId(stage.id); setError(null)
    try {
      await renameStage(supabase, stage.id, trimmed)
      setEditingId(null)
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename stage')
    } finally {
      setBusyStageId(null)
    }
  }

  async function handleMove(stage: Stage, direction: -1 | 1) {
    setBusyStageId(stage.id); setError(null)
    try {
      await moveStage(supabase, stages, stage.id, direction)
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reorder stages')
    } finally {
      setBusyStageId(null)
    }
  }

  /** Re-counts before asking: the pane's count is scoped to the current filter, and a stage
   * deleted out from under jobs the filter hides would leave them pointing at nothing. */
  async function requestDelete(stage: Stage) {
    setBusyStageId(stage.id); setError(null)
    try {
      const count = await countJobsInStage(supabase, stage.id)
      if (count > 0) setBlockedDelete({ name: stage.name, jobCount: count })
      else setConfirmDelete(stage)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check this stage for jobs')
    } finally {
      setBusyStageId(null)
    }
  }

  async function handleDelete(stage: Stage) {
    setConfirmDelete(null)
    setBusyStageId(stage.id); setError(null)
    try {
      await deleteStage(supabase, stage.id)
      await onChanged()
    } catch (err) {
      // Includes an RLS rejection: the delete succeeds having removed nothing, which
      // deleteStage turns into this message rather than letting the list quietly refresh
      // unchanged.
      setError(err instanceof Error ? err.message : 'Could not delete stage')
    } finally {
      setBusyStageId(null)
    }
  }

  /** Creating appends and can't disturb the existing walk, so it survives `readOnly` when a
   * caller asks for it — unlike rename/reorder/delete, which stay gated on `readOnly` alone. */
  const canAdd = !readOnly || allowAdd

  const realStageCount = stages.length
  const subtitle = productionLineName
    ? `${productionLineName} · ${realStageCount === 0 ? 'no stages' : plural(realStageCount, 'stage')}`
    : 'All production lines'

  return (
    <>
      <Pane
        title="Stages"
        subtitle={subtitle}
        active={Boolean(selectedKey)}
        footer={
          !canAdd ? undefined : productionLineId ? (
            addingOpen ? (
              <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                <input
                  autoFocus
                  className="input"
                  placeholder="Stage name"
                  style={{ fontSize: 12, padding: '5px 8px' }}
                  value={newName}
                  disabled={creating}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <select
                  className="select"
                  style={{ fontSize: 12, padding: '5px 8px', width: '100%' }}
                  value={newTeamId}
                  disabled={creating}
                  onChange={(e) => setNewTeamId(e.target.value)}
                >
                  <option value="">— Select a team —</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="submit" className="btn-primary" style={{ padding: '6px 11px', fontSize: 12 }} disabled={creating || !newName.trim() || !newTeamId}>
                    {creating ? 'Adding…' : 'Add stage'}
                  </button>
                  <button type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} disabled={creating} onClick={() => { setAddingOpen(false); setNewName('') }}>
                    Cancel
                  </button>
                </div>
                {teams.length === 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    This line has no teams yet — a stage needs one, so add a team first.
                  </span>
                )}
              </form>
            ) : (
              <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => { setAddingOpen(true); setError(null) }}>
                + Add stage
              </button>
            )
          ) : readOnly ? undefined : (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Pick a production line above to add, reorder or delete stages.
            </span>
          )
        }
      >
        {error && <p style={{ ...PANE_ERR_BOX, margin: '10px 12px', fontSize: 12 }}>{error}</p>}

        {entries.length === 0 ? (
          <p className="finder-pane-empty">
            {productionLineId
              ? 'This line has no stages and no jobs yet.'
              : 'Select a production line to see its stages.'}
          </p>
        ) : (
          entries.map((entry) => {
            const stage = entry.stage
            const isSelected = entry.key === selectedKey
            const isBusy = stage ? busyStageId === stage.id : false
            const index = stage ? stageIndex.get(stage.id) ?? 0 : -1

            return (
              <div
                key={entry.key}
                className={'finder-row' + (isSelected ? ' finder-row-selected' : '')}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(entry.key)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(entry.key) } }}
              >
                <span className="finder-row-main">
                  {stage && !readOnly && (
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button" title="Move up" disabled={isBusy || index === 0}
                        onClick={() => handleMove(stage, -1)}
                        style={{ background: 'none', border: 'none', padding: 0, lineHeight: 1, fontSize: 10, cursor: index === 0 ? 'default' : 'pointer', color: index === 0 ? 'var(--border)' : 'var(--text-muted)' }}
                      >
                        ▲
                      </button>
                      <button
                        type="button" title="Move down" disabled={isBusy || index === stages.length - 1}
                        onClick={() => handleMove(stage, 1)}
                        style={{ background: 'none', border: 'none', padding: 0, lineHeight: 1, fontSize: 10, cursor: index === stages.length - 1 ? 'default' : 'pointer', color: index === stages.length - 1 ? 'var(--border)' : 'var(--text-muted)' }}
                      >
                        ▼
                      </button>
                    </span>
                  )}
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                    {stage && !readOnly && editingId === stage.id ? (
                      <input
                        autoFocus
                        style={ROW_INPUT}
                        value={editDraft}
                        disabled={isBusy}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') { e.preventDefault(); handleRename(stage) }
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        onBlur={() => handleRename(stage)}
                      />
                    ) : (
                      <>
                        <span className="finder-row-name">
                          {entry.name}
                          {runningKeys?.has(entry.key) && <RunningDot title="A timer is running in this stage" />}
                        </span>
                        <span className="finder-row-meta">
                          {stage
                            ? `${teamNameById.get(stage.team_id ?? '') ?? 'No team'} · ${plural(entry.jobCount, 'job')}`
                            : `${productionLineId ? 'Jobs with no stage' : 'Pick a line to see its stages'} · ${plural(entry.jobCount, 'job')}`}
                        </span>
                      </>
                    )}
                  </span>
                </span>
                <span className="finder-row-actions">
                  {stage && !readOnly && editingId !== stage.id && (
                    <>
                      <RenameButton title="Rename stage" onClick={() => { setEditingId(stage.id); setEditDraft(stage.name) }} />
                      <button
                        type="button"
                        className="finder-row-action finder-row-action-danger"
                        disabled={isBusy}
                        title="Delete stage"
                        onClick={(e) => { e.stopPropagation(); requestDelete(stage) }}
                      >
                        {isBusy ? '…' : 'Delete'}
                      </button>
                    </>
                  )}
                  <span className="finder-chevron">›</span>
                </span>
              </div>
            )
          })
        )}
      </Pane>

      {blockedDelete && (
        <ConfirmDialog
          title="Can't delete this stage"
          message={`"${blockedDelete.name}" still has ${plural(blockedDelete.jobCount, 'job')} assigned. Reassign or unstage its ${blockedDelete.jobCount === 1 ? 'job' : 'jobs'} first — deleting the stage here never touches them.`}
          confirmLabel="Got it"
          cancelLabel="Close"
          onConfirm={() => setBlockedDelete(null)}
          onCancel={() => setBlockedDelete(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete Stage"
          message={`Delete "${confirmDelete.name}"? No jobs are assigned to it. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  )
}

// ── Pane 2: Jobs ───────────────────────────────────────────────────────────────────────────
/**
 * Optional per-job applicability, for a screen scoped to one thing a job can apply to (today:
 * /tryouts, scoped to one van's model). Applicability itself is always DERIVED — the pane is
 * handed the set of job ids that currently apply and never computes or stores one — so this is
 * a display + toggle contract, not a second source of truth.
 */
export interface JobApplicability {
  /** Job ids that currently apply. */
  appliesIds: Set<string>
  /** What they apply to, for labels and tooltips — e.g. the model name. */
  targetLabel: string
  /** The job whose toggle is in flight, if any. */
  busyJobId: string | null
  /** Jobs that can't be toggled at all (e.g. a job with no operations, since applicability is
   * derived from operations and there'd be nothing to link). Keyed by job id → why. */
  disabledReasons?: Record<string, string>
  onToggle: (job: Job, currentlyApplies: boolean) => void
}

/**
 * The selected stage's jobs. Adding here places the job in that stage directly (stage_id set,
 * line/team from the pane context).
 *
 * Renaming and re-staging live in the caller's slide-over behind each row's ✎ — deliberately
 * not on the row and not in this footer. Moving a job between stages also moves it between
 * teams (see stages.ts' setJobStage), which is too consequential to sit behind an unconfirmed
 * dropdown change. A caller that offers no such drawer (e.g. /tryouts, which walks the
 * structure rather than editing it) simply passes no onEdit, and the row shows no ✎.
 */
export function JobsPane({
  entry, jobs, loading, operationsByJob, selectedJobId, canDelete, runningJobIds, applicability,
  onSelect, onAdd, onEdit, onEditTeamLine, onDeleteRequest,
}: {
  entry: StageEntry | null
  jobs: Job[]
  loading: boolean
  operationsByJob: Record<string, Operation[]>
  selectedJobId: string
  canDelete?: boolean
  /** Job ids with a stopwatch running on one of their operations. */
  runningJobIds?: Set<string>
  /** Set to show — and toggle — whether each job applies to whatever the screen is scoped to. */
  applicability?: JobApplicability
  onSelect: (id: string) => void
  onAdd: (name: string) => Promise<void>
  /** Opens the caller's edit/reassign slide-over. Distinct from onSelect so the row's click
   * can stay "show me this job's operations" — selecting and editing must not collide. */
  onEdit?: (job: Job) => void
  onEditTeamLine?: (job: Job) => void
  onDeleteRequest?: (job: Job) => void
}) {
  const [addingOpen, setAddingOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null
  const hasJobActions = Boolean(onEdit || onEditTeamLine || (canDelete && onDeleteRequest))

  async function commitAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setBusy(true)
    try { await onAdd(newName) } finally { setBusy(false); setNewName(''); setAddingOpen(false) }
  }

  return (
    <Pane
      title="Jobs"
      subtitle={entry ? `${entry.name} · ${plural(jobs.length, 'job')}` : 'No stage selected'}
      active={Boolean(selectedJobId)}
      footer={
        entry ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            {addingOpen ? (
              <form onSubmit={commitAdd} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input
                  autoFocus
                  className="input"
                  placeholder="Job name"
                  style={{ fontSize: 12, padding: '5px 8px' }}
                  value={newName}
                  disabled={busy}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="submit" className="btn-primary" style={{ padding: '6px 11px', fontSize: 12 }} disabled={busy || !newName.trim()}>
                    {busy ? 'Adding…' : 'Add job'}
                  </button>
                  <button type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} disabled={busy} onClick={() => { setAddingOpen(false); setNewName('') }}>
                    Cancel
                  </button>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Added under {entry.name}
                </span>
              </form>
            ) : (
              <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12, alignSelf: 'flex-start' }} onClick={() => setAddingOpen(true)}>
                + Add job
              </button>
            )}

            {selectedJob && hasJobActions && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>{selectedJob.name}</span>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {onEdit && (
                    <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => onEdit(selectedJob)}>
                      Edit / reassign
                    </button>
                  )}
                  {onEditTeamLine && (
                    <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => onEditTeamLine(selectedJob)}>
                      Team / Line
                    </button>
                  )}
                  {canDelete && onDeleteRequest && (
                    <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12, color: 'var(--red)' }} onClick={() => onDeleteRequest(selectedJob)}>
                      Delete job
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : undefined
      }
    >
      {!entry ? (
        <p className="finder-pane-empty">Select a stage.</p>
      ) : loading ? (
        <p className="finder-pane-empty">Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="finder-pane-empty">
          No jobs in {entry.name} yet — add one below, or move a job here from another stage.
        </p>
      ) : (
        jobs.map((job) => {
          const isSelected = job.id === selectedJobId
          const opCount = (operationsByJob[job.id] ?? []).length
          const applies = applicability?.appliesIds.has(job.id) ?? true
          const toggleDisabled = applicability
            ? applicability.busyJobId !== null || Boolean(applicability.disabledReasons?.[job.id])
            : false
          return (
            <div
              key={job.id}
              className={'finder-row' + (isSelected ? ' finder-row-selected' : '')}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(job.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(job.id) } }}
              // A job that doesn't apply is still listed (that's how it gets turned back on),
              // just visibly stood down from the ones that do.
              style={applicability && !applies ? { opacity: 0.62 } : undefined}
            >
              <span className="finder-row-main">
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                  <span className="finder-row-name">
                    {job.name}
                    {runningJobIds?.has(job.id) && <RunningDot title="A timer is running in this job" />}
                  </span>
                  <span className="finder-row-meta">
                    {job.teams?.name ?? 'No team'} · {plural(opCount, 'operation')}
                  </span>
                </span>
              </span>
              <span className="finder-row-actions">
                {applicability && (
                  <label
                    title={
                      applicability.disabledReasons?.[job.id]
                        ?? (applies
                          ? `Stop this job applying to ${applicability.targetLabel}`
                          : `Make this job apply to ${applicability.targetLabel}`)
                    }
                    style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: toggleDisabled ? 'default' : 'pointer' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={applies}
                      disabled={toggleDisabled}
                      onChange={() => applicability.onToggle(job, applies)}
                      style={{ width: 14, height: 14, accentColor: 'var(--blue)', cursor: toggleDisabled ? 'default' : 'pointer' }}
                    />
                    <span className={'badge ' + (applies ? 'badge-green' : 'badge-grey')}>
                      {applicability.busyJobId === job.id ? '…' : applies ? 'Applies' : 'Doesn’t apply'}
                    </span>
                  </label>
                )}
                {onEdit && <RenameButton title="Edit / reassign this job" onClick={() => onEdit(job)} />}
                <span className="finder-chevron">›</span>
              </span>
            </div>
          )
        })
      )}
    </Pane>
  )
}
