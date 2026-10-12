'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import ConfirmDialog from '@/components/ConfirmDialog'
import { MergeConfirm, useMergeMode, type MergeRow } from '@/components/MergeMode'
import Modal from '@/components/Modal'
import MoveOperationsDialog from '@/components/MoveOperationsDialog'
import { plural } from '@/lib/format'
import { createJob, jobMergeGroupKey, renameJob, retireJob } from '@/lib/jobs'
import { STRUCTURE_LOCKED_REASON, canDeletePermanently, canEditStructure } from '@/lib/permissions'
import { clearEmptyRetiredOperations, nameKey, type SectionJob } from '@/lib/sectionManager'
import { isSectionTray, setJobSection, sortSections } from '@/lib/sections'
import type { Job, Section, UserRole } from '@/lib/types'

/**
 * The jobs inside one expanded section on /config → Sections.
 *
 * Every write here is a shared one — nothing on this screen has its own version of an action:
 *
 *   add                 lib/jobs' createJob
 *   rename              lib/jobs' renameJob
 *   move                lib/sections' setJobSection (same line only; re-stamps the job's times)
 *   merge               lib/jobs' mergeJobs, through components/MergeMode — the same hook, the
 *                       same preflight and the same confirm /setup and /line-config use. This is
 *                       the one action that FUSES: same-named operations under the merged jobs
 *                       combine, and the confirm names them.
 *   retire / restore    lib/jobs' retireJob / restoreJob. A job that still holds LIVE operations
 *                       is never retired over them — they would be out of reach under a job no
 *                       screen lists — so its Retire opens components/MoveOperationsDialog: move
 *                       the operations to another job (lib/jobs' moveOperationsToJob), then retire.
 *
 * ── Retired rows are not here ──────────────────────────────────────────────────────────────
 * This is a cleanup workspace, not an audit view: a retired job or operation affects no figure
 * anywhere, so it is simply absent — no toggle, no badge, no restore (that is /setup's and
 * /line-config's Retired items). And because it is absent it must never be the unseen reason
 * something is refused: retiring a job also clears the empty retired operations left under it
 * (lib/sectionManager's clearEmptyRetiredOperations, for a user who may delete permanently), and
 * deleting a section deals with whatever retired jobs still point at it.
 *
 * Operations are a count on the job row; clicking it opens the operations side pane
 * (./JobOperationsPane), which the host mounts. No model link and no recorded time is created
 * or edited here.
 *
 * ── One selection ──────────────────────────────────────────────────────────────────────────
 * The ticked rows ARE the merge hook's selection. Move and retire act on the same ticks, so
 * there is one set of checkboxes and one count, and the bar above the rows says what each
 * action would do to exactly those jobs before anything runs.
 */

const CELL: React.CSSProperties = { padding: '7px 10px', fontSize: 13, color: 'var(--text-mid)', verticalAlign: 'middle' }
const HEAD: React.CSSProperties = { padding: '6px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)', textAlign: 'left' }
const LINK_BTN: React.CSSProperties = { background: 'none', border: 'none', padding: '2px 5px', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--blue)', cursor: 'pointer' }
const LINK_BTN_OFF: React.CSSProperties = { ...LINK_BTN, color: 'var(--text-muted)', opacity: 0.5, cursor: 'not-allowed' }
const SMALL_BTN: React.CSSProperties = { padding: '5px 10px', fontSize: 12 }
const ERR_BOX: React.CSSProperties = { margin: '0 0 8px', padding: '8px 12px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 12, lineHeight: 1.55 }

export default function SectionJobs({
  supabase, userId, role, section, sections, jobs, loadError, teamName, moveRequest,
  onSelectionCount, onOpenOperations, onChanged,
}: {
  supabase: SupabaseClient
  userId: string
  role: UserRole | null
  section: Section
  /** Every section — the move picker filters it to this section's own line. */
  sections: Section[]
  /** null while the first load is in flight. Afterwards the last loaded rows stay on screen
   * during a re-read, so the list never blanks out under the user. */
  jobs: SectionJob[] | null
  loadError: string | null
  teamName: (id: string | null) => string
  /** Bumped by the section row's own "Move jobs" action to open this panel's move picker. */
  moveRequest: number
  onSelectionCount: (count: number) => void
  /** Open the operations side pane for a job (the host owns the one pane). */
  onOpenOperations: (job: SectionJob) => void
  /** Something was written. A message is a success worth showing; none means "just re-read". */
  onChanged: (message?: string) => void
}) {
  const canEdit = canEditStructure(role)
  const lockedReason = canEdit ? null : STRUCTURE_LOCKED_REASON
  const canPurge = canDeletePermanently(role)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [moveIds, setMoveIds] = useState<string[] | null>(null)
  const [moveTargetId, setMoveTargetId] = useState('')
  const [retireIds, setRetireIds] = useState<string[] | null>(null)
  /** A job whose Retire needs its live operations moved first. */
  const [moveThenRetire, setMoveThenRetire] = useState<SectionJob | null>(null)

  /** Retire, routed by what the job holds: a plain confirm for one with no live operations,
   * move-then-retire for one that has them. */
  function requestRetire(ids: string[]) {
    setError(null)
    const only = ids.length === 1 ? jobById.get(ids[0]) : null
    if (only && only.operations > 0) setMoveThenRetire(only)
    else setRetireIds(ids)
  }

  /** Everything loaded is live — lib/sectionManager's fetchSectionJobs returns nothing else. */
  const live = useMemo(() => jobs ?? [], [jobs])

  /** After a job is retired: delete the retired operations under it that hold nothing, so they
   * are never what stops something later. Admin only (it is a permanent delete); for anyone else
   * they simply stay under the retired job. Never fails the retire it follows. */
  async function tidyRetired(jobId: string) {
    if (!canPurge) return
    try { await clearEmptyRetiredOperations(supabase, jobId) } catch { /* tidying only */ }
  }
  const jobById = useMemo(() => new Map((jobs ?? []).map((j) => [j.id, j])), [jobs])

  // Live jobs only: a merge folds live work together. All of them share one group key — they
  // are in the same section by construction, which is the only place a job merge is allowed.
  const mergeRows: MergeRow<Job>[] = useMemo(() => live.map((j) => ({
    id: j.id, name: j.name, groupKey: jobMergeGroupKey(j), subject: j as unknown as Job,
  })), [live])
  const merge = useMergeMode({
    level: 'job', supabase, userId,
    // Merging is manager or admin, the tier that may act on other people's recorded work.
    canMoveOthersTimes: canEdit,
    rows: mergeRows,
    onMerged: async (message) => { onChanged(message || undefined) },
  })
  const selectedIds = useMemo(() => live.filter((j) => merge.selectedIds.has(j.id)).map((j) => j.id), [live, merge.selectedIds])
  const selectedCount = selectedIds.length

  useEffect(() => { onSelectionCount(selectedCount) }, [selectedCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // The section row's "Move jobs" action. Skips the first render: the counter is a signal, and
  // its starting value is not a request.
  const lastMoveRequest = useRef(moveRequest)
  useEffect(() => {
    if (moveRequest === lastMoveRequest.current) return
    lastMoveRequest.current = moveRequest
    if (selectedIds.length > 0) { setMoveTargetId(''); setMoveIds(selectedIds) }
  }, [moveRequest]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Sections a job here may move to: this section's OWN LINE, nothing else. Trays included —
   * a team's unsorted tray is a legitimate place to park a job. */
  const moveTargets = useMemo(
    () => sortSections(sections.filter((s) =>
      s.id !== section.id && s.is_active !== false && s.production_line_id === section.production_line_id
    )).sort((a, b) => teamName(a.team_id).localeCompare(teamName(b.team_id))),
    [sections, section.id, section.production_line_id, teamName]
  )

  async function act(action: () => Promise<string>) {
    setBusy(true); setError(null)
    try {
      onChanged(await action())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be done')
      // Re-read regardless: a batch that stopped part-way has still moved what it moved.
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const sum = (ids: string[], field: 'operations' | 'timeRecords') =>
    ids.reduce((n, id) => n + (jobById.get(id)?.[field] ?? 0), 0)
  const names = (ids: string[]) => ids.map((id) => jobById.get(id)?.name ?? '—')

  const renameClash = renamingId && renameValue.trim()
    ? live.find((j) => j.id !== renamingId && nameKey(j.name) === nameKey(renameValue)) ?? null
    : null
  const addClash = adding.trim() ? live.find((j) => nameKey(j.name) === nameKey(adding)) ?? null : null

  function commitRename(job: SectionJob) {
    const next = renameValue.trim()
    if (!next || next === job.name || renameClash) return
    setRenamingId(null)
    act(async () => { await renameJob(supabase, job.id, next); return `"${job.name}" renamed to "${next}".` })
  }

  function commitAdd() {
    const name = adding.trim()
    if (!name || addClash) return
    setAdding('')
    act(async () => { const created = await createJob(supabase, { name, section }); return `Job "${created.name}" added to ${section.name}.` })
  }

  const moveTarget = moveTargets.find((s) => s.id === moveTargetId) ?? null
  const keeperPicked = merge.primaryId !== null && merge.selectedIds.has(merge.primaryId)
  const shown = live
  const disabled = busy || merge.busy || !canEdit

  return (
    <div style={{ padding: '10px 20px 14px 56px', background: 'var(--bg)', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-mid)' }}>
          {jobs === null ? 'Loading jobs…' : `${plural(live.length, 'job')} in ${section.name}`}
        </span>
        {lockedReason && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>View only — {lockedReason.toLowerCase()}.</span>}
        {!lockedReason && jobs !== null && moveTargets.length === 0 && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Move is unavailable — this is the only section on the line.</span>
        )}
      </div>

      {(error || loadError || merge.error) && <p style={ERR_BOX}>{error ?? merge.error ?? loadError}</p>}

      {/* The selection bar: how many are ticked, and what each action would do to them. */}
      {selectedCount > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', marginBottom: 8, borderRadius: 8, background: 'var(--blue-light)', border: '1px solid #bcdff2' }}>
          <span style={{ fontSize: 12, color: 'var(--blue-dark)', flex: 1, minWidth: 220, lineHeight: 1.5 }}>
            <strong>{plural(selectedCount, 'job')} selected</strong>
            {` — ${plural(sum(selectedIds, 'operations'), 'operation')}, ${plural(sum(selectedIds, 'timeRecords'), 'time record')}. `}
            {selectedCount < 2
              ? 'Move or retire it, or tick another to merge.'
              : keeperPicked
                ? `Merge keeps "${jobById.get(merge.primaryId!)?.name}" and folds the other ${plural(selectedCount - 1, 'job')} into it.`
                : 'To merge, tick “Keep” on the job that should survive.'}
          </span>
          <button
            type="button" className="btn-ghost" style={SMALL_BTN} disabled={disabled || moveTargets.length === 0}
            title={lockedReason ?? `Move the ${plural(selectedCount, 'selected job')} to another section on this line — their recorded times are re-stamped to that section’s team`}
            onClick={() => { setMoveTargetId(''); setMoveIds(selectedIds) }}
          >
            Move {selectedCount}…
          </button>
          <button
            type="button" className="btn-ghost" style={SMALL_BTN} disabled={disabled}
            title={lockedReason ?? `Retire the ${plural(selectedCount, 'selected job')} — hidden everywhere, with operations, times and model links kept`}
            onClick={() => requestRetire(selectedIds)}
          >
            Retire {selectedCount}…
          </button>
          <button
            type="button" className="btn-danger" style={SMALL_BTN}
            disabled={disabled || selectedCount < 2 || !keeperPicked}
            title={lockedReason ?? (selectedCount < 2 ? 'Tick two or more jobs to merge' : keeperPicked ? 'Check what this merge would combine, then confirm' : 'Choose which job to keep first')}
            onClick={merge._requestMerge}
          >
            {merge.busy ? 'Checking…' : `Merge ${selectedCount}…`}
          </button>
          <button type="button" className="btn-ghost" style={SMALL_BTN} disabled={busy || merge.busy} onClick={merge.cancel}>Clear</button>
        </div>
      )}

      {jobs !== null && (
        <table style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ ...HEAD, width: 30 }} />
              <th style={HEAD}>Job</th>
              <th style={{ ...HEAD, textAlign: 'center' }}>Operations</th>
              <th style={{ ...HEAD, textAlign: 'center' }}>Time records</th>
              <th style={{ ...HEAD, textAlign: 'center' }}>Models</th>
              <th style={{ ...HEAD, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={6} style={{ ...CELL, textAlign: 'center', color: 'var(--text-muted)', padding: '14px 10px' }}>
                No jobs in this section.
              </td></tr>
            )}
            {shown.map((job) => {
              const ticked = merge.selectedIds.has(job.id)
              const isKeeper = merge.primaryId === job.id
              const renaming = renamingId === job.id
              return (
                <tr key={job.id} style={{ borderBottom: '1px solid #f2f2f2', background: ticked ? 'var(--blue-light)' : undefined }}>
                  <td style={CELL}>
                    {(
                      <input
                        type="checkbox" aria-label={`Select ${job.name}`} checked={ticked}
                        disabled={disabled} title={lockedReason ?? undefined}
                        onChange={() => merge.toggle(job.id)}
                      />
                    )}
                  </td>
                  <td style={{ ...CELL, fontWeight: 600, color: 'var(--text)' }}>
                    {renaming ? (
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ display: 'flex', gap: 6 }}>
                          <input
                            className="input" autoFocus value={renameValue} disabled={busy}
                            style={{ fontSize: 13, padding: '4px 8px', maxWidth: 320 }}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); commitRename(job) }
                              if (e.key === 'Escape') setRenamingId(null)
                            }}
                          />
                          <button type="button" className="btn-primary" style={SMALL_BTN} disabled={busy || !renameValue.trim() || Boolean(renameClash) || renameValue.trim() === job.name} onClick={() => commitRename(job)}>Save</button>
                          <button type="button" className="btn-ghost" style={SMALL_BTN} onClick={() => setRenamingId(null)}>Cancel</button>
                        </span>
                        {renameClash && (
                          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--red)' }}>
                            {`This section already has a job called "${renameClash.name}".`}
                          </span>
                        )}
                      </span>
                    ) : (
                      <>
                        {job.name}
                        {ticked && (
                          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 10, fontSize: 11, fontWeight: 700, color: isKeeper ? 'var(--blue)' : 'var(--text-muted)', cursor: 'pointer' }}>
                            <input type="radio" name={`keep-${section.id}`} checked={isKeeper} disabled={merge.busy} onChange={() => merge.setPrimary(job.id)} />
                            {isKeeper ? 'Keeping' : 'Keep'}
                          </label>
                        )}
                      </>
                    )}
                  </td>
                  <td style={{ ...CELL, textAlign: 'center' }}>
                    <button
                      type="button" style={{ ...LINK_BTN, fontSize: 13 }}
                      title="Show this job’s operations — rename, move, merge or delete them"
                      onClick={() => onOpenOperations(job)}
                    >
                      {job.operations.toLocaleString()}
                    </button>
                  </td>
                  <td style={{ ...CELL, textAlign: 'center' }}>{job.timeRecords.toLocaleString()}</td>
                  <td style={{ ...CELL, textAlign: 'center' }}>{job.models.toLocaleString()}</td>
                  <td style={{ ...CELL, textAlign: 'right', whiteSpace: 'nowrap', background: 'var(--sec-zone)' }}>
                    {!renaming && (
                      <>
                        <button
                          type="button" style={disabled ? LINK_BTN_OFF : LINK_BTN} disabled={disabled} title={lockedReason ?? undefined}
                          onClick={() => { setError(null); setRenamingId(job.id); setRenameValue(job.name) }}
                        >
                          Rename
                        </button>
                        ·
                        <button
                          type="button" style={disabled || moveTargets.length === 0 ? LINK_BTN_OFF : LINK_BTN}
                          disabled={disabled || moveTargets.length === 0}
                          title={lockedReason ?? 'Move to another section on this line'}
                          onClick={() => { setMoveTargetId(''); setMoveIds([job.id]) }}
                        >
                          Move
                        </button>
                        ·
                        <button
                          type="button" style={disabled ? LINK_BTN_OFF : { ...LINK_BTN, color: 'var(--red)' }} disabled={disabled}
                          title={lockedReason ?? (job.operations > 0 ? `Holds ${plural(job.operations, 'live operation')} — you will pick a job to move ${job.operations === 1 ? 'it' : 'them'} to, then this job is retired` : 'Hide this job everywhere — it can be restored')}
                          onClick={() => requestRetire([job.id])}
                        >
                          Retire
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {jobs !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="input" placeholder={`New job in ${section.name}…`} value={adding} disabled={disabled}
              title={lockedReason ?? undefined}
              style={{ fontSize: 13, padding: '5px 8px', maxWidth: 320 }}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitAdd() } }}
            />
            <button type="button" className="btn-ghost" style={SMALL_BTN} disabled={disabled || !adding.trim() || Boolean(addClash)} title={lockedReason ?? undefined} onClick={commitAdd}>
              + Add job
            </button>
          </div>
          {addClash && <span style={{ fontSize: 12, color: 'var(--red)' }}>{`This section already has a job called "${addClash.name}".`}</span>}
        </div>
      )}

      {/* ── Move ─────────────────────────────────────────────────────────────────────────── */}
      {moveIds && (
        <Modal
          title={moveIds.length === 1 ? `Move "${names(moveIds)[0]}"` : `Move ${plural(moveIds.length, 'job')}`}
          onClose={() => setMoveIds(null)} maxWidth={520}
          footer={(
            <>
              <button className="btn-ghost" onClick={() => setMoveIds(null)}>Cancel</button>
              <button
                className="btn-primary" disabled={!moveTarget}
                onClick={() => {
                  const ids = moveIds
                  const target = moveTarget
                  if (!target) return
                  setMoveIds(null)
                  merge.cancel()
                  act(async () => {
                    let moved = 0
                    try {
                      // The single writer of jobs.section_id — it syncs the job's team from the
                      // section and re-stamps the recorded times under it.
                      for (const id of ids) { await setJobSection(supabase, id, target); moved++ }
                    } catch (err) {
                      throw new Error(`${moved} of ${plural(ids.length, 'job')} moved to ${target.name} before it stopped: ${err instanceof Error ? err.message : 'rejected'}`)
                    }
                    return `${plural(moved, 'job')} moved from ${section.name} to ${target.name}.`
                  })
                }}
              >
                {moveTarget ? `Move to ${moveTarget.name}` : 'Move'}
              </button>
            </>
          )}
        >
          <p style={{ fontSize: 14, color: 'var(--text-mid)', lineHeight: 1.6, margin: '0 0 12px' }}>
            {moveIds.length === 1 ? 'This job moves' : `These ${moveIds.length} jobs move`} to another section on this production line.
            {' '}Operations and model links go with {moveIds.length === 1 ? 'it' : 'them'}, untouched.
          </p>
          {moveIds.length > 1 && (
            <ul style={{ margin: '0 0 12px', paddingLeft: 20, maxHeight: 120, overflowY: 'auto', fontSize: 13, color: 'var(--text-mid)' }}>
              {names(moveIds).map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
          <label className="label">Destination section</label>
          <select className="select" style={{ width: '100%' }} value={moveTargetId} onChange={(e) => setMoveTargetId(e.target.value)}>
            <option value="">— Select a section —</option>
            {moveTargets.map((s) => (
              <option key={s.id} value={s.id}>{`${teamName(s.team_id)} — ${s.name}${isSectionTray(s) ? ' (unsorted tray)' : ''}`}</option>
            ))}
          </select>
          {moveTarget && (
            <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, margin: '12px 0 0' }}>
              {`${plural(sum(moveIds, 'operations'), 'operation')} and ${plural(sum(moveIds, 'timeRecords'), 'time record')} go with ${moveIds.length === 1 ? 'it' : 'them'}. `}
              {moveTarget.team_id !== section.team_id
                ? `${moveTarget.name} is on ${teamName(moveTarget.team_id)}, not ${teamName(section.team_id)} — the jobs change team, and those time records are re-stamped to ${teamName(moveTarget.team_id)}.`
                : 'Same team, so nothing changes team.'}
            </p>
          )}
        </Modal>
      )}

      {/* ── Retire ───────────────────────────────────────────────────────────────────────── */}
      {retireIds && (() => {
        // A job holding live operations is never retired over them. In a batch those are left
        // out and named: each needs its own Retire, where its operations get a destination.
        const plain = retireIds.filter((id) => (jobById.get(id)?.operations ?? 0) === 0)
        const holding = retireIds.filter((id) => (jobById.get(id)?.operations ?? 0) > 0)
        return (
          <ConfirmDialog
            title={plain.length === 1 ? `Retire "${names(plain)[0]}"` : `Retire ${plural(plain.length, 'job')}`}
            message={plain.length === 0
              ? 'None of the selected jobs can be retired in one go — each still holds live operations.'
              : `${plain.length === 1 ? 'This job stops' : `These ${plain.length} jobs stop`} appearing across the app. Nothing is deleted: ` +
                `${plain.length === 1 ? 'it holds' : 'they hold'} no live operations, ${plural(sum(plain, 'timeRecords'), 'time record')} under ` +
                `${plain.length === 1 ? 'it' : 'them'} ${sum(plain, 'timeRecords') === 1 ? 'is' : 'are'} kept, and ${plain.length === 1 ? 'it' : 'each'} can be restored from Line Config or Setup.`}
            confirmLabel={plain.length === 0 ? 'OK' : plain.length === 1 ? 'Retire job' : `Retire ${plain.length} jobs`}
            danger={plain.length > 0}
            maxWidth={540}
            onConfirm={() => {
              setRetireIds(null)
              if (plain.length === 0) return
              merge.cancel()
              act(async () => {
                let done = 0
                try {
                  for (const id of plain) { await retireJob(supabase, id); await tidyRetired(id); done++ }
                } catch (err) {
                  throw new Error(`${done} of ${plural(plain.length, 'job')} retired before it stopped: ${err instanceof Error ? err.message : 'rejected'}`)
                }
                return `${plural(done, 'job')} retired in ${section.name}.` +
                  (holding.length > 0 ? ` ${plural(holding.length, 'job')} left as ${holding.length === 1 ? 'it is' : 'they are'} — retire ${holding.length === 1 ? 'it' : 'each'} on its own to move its operations first.` : '')
              })
            }}
            onCancel={() => setRetireIds(null)}
          >
            {plain.length > 1 && (
              <ul style={{ margin: 0, paddingLeft: 20, maxHeight: 120, overflowY: 'auto', fontSize: 13, color: 'var(--text-mid)' }}>
                {names(plain).map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            )}
            {holding.length > 0 && (
              <div style={{ marginTop: 10, padding: '9px 12px', borderRadius: 8, background: 'var(--amber-bg)', border: '1px solid #fcd34d', color: '#92400e', fontSize: 12, lineHeight: 1.55 }}>
                <strong>{plural(holding.length, 'job')} will NOT be retired here</strong> — {holding.length === 1 ? 'it still holds' : 'they still hold'} live operations, which must move to another job first:
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {holding.map((id) => <li key={id}>{`${jobById.get(id)?.name} — ${plural(jobById.get(id)?.operations ?? 0, 'operation')}`}</li>)}
                </ul>
                Use Retire on each of those rows; it asks where the operations go.
              </div>
            )}
          </ConfirmDialog>
        )
      })()}

      {/* ── Retire a job that holds live operations: move them, then retire ────────────────── */}
      {moveThenRetire && (
        <MoveOperationsDialog
          supabase={supabase} userId={userId} retireAfter
          job={{ id: moveThenRetire.id, name: moveThenRetire.name, section_id: moveThenRetire.section_id, production_line_id: moveThenRetire.production_line_id }}
          onClose={() => setMoveThenRetire(null)}
          onChanged={() => onChanged()}
          onDone={async (message) => {
            const jobId = moveThenRetire.id
            setMoveThenRetire(null); merge.cancel()
            // A fused operation leaves an emptied, retired row behind under the retired job.
            await tidyRetired(jobId)
            onChanged(message)
          }}
        />
      )}

      {/* The shared merge confirm: keeper, retired jobs, and the operations that will COMBINE, by name. */}
      <MergeConfirm merge={merge} />
    </div>
  )
}
