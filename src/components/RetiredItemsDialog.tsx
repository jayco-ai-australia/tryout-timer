'use client'

import { useCallback, useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import ConfirmDialog from './ConfirmDialog'
import Modal from './Modal'
import MoveOperationsDialog from './MoveOperationsDialog'
import { plural } from '@/lib/format'
import { deleteJobPermanently, restoreJob } from '@/lib/jobs'
import { READ_CHUNK, fetchLinksForOperations } from '@/lib/modelOperations'
import { deleteOperationPermanently, reactivateOperation, retireOperation } from '@/lib/operations'
import { STRUCTURE_LOCKED_REASON, canDeletePermanently, canEditStructure } from '@/lib/permissions'
import { fetchAllChunked, fetchAllRows } from '@/lib/supabaseRead'
import type { UserRole } from '@/lib/types'

/**
 * The marker for a retired job or operation (is_active = false) wherever one is listed — the
 * structure counterpart of RetiredTimeBadge on a time record. Retired is the only "delete" a job
 * or an operation has: the row, its times and its model links are all kept.
 */
export function RetiredBadge() {
  return (
    <span
      className="badge badge-grey"
      title="Retired (is_active = false): hidden from every list, with its recorded times and model links kept. It can be restored."
    >
      retired
    </span>
  )
}

/**
 * Retired jobs and operations in one section — THE way back from Retire, and the one place a
 * retired, empty row can be deleted for good. Mounted by /setup, /line-config and /config, so
 * Restore and Delete permanently mean the same thing on all three.
 *
 *   Restore             manager or admin (lib/permissions' canEditStructure). Sets is_active = true.
 *   Move / Retire       manager or admin, on a LIVE operation still inside a retired job — the
 *                       group that would otherwise be out of reach. Move is the shared
 *                       MoveOperationsDialog; Retire is lib/operations' retireOperation.
 *   Delete permanently  admin only (canDeletePermanently), and only for a row that holds nothing:
 *                       a job with no operations at all, an operation with no recorded times and
 *                       no model links. The guard is re-run inside lib/jobs' deleteJobPermanently
 *                       and lib/operations' deleteOperationPermanently — this dialog is consent.
 *
 * Every action re-reads the whole dialog in place, so a button's enabled state always reflects
 * what is in the database now: delete a job's last operation and its Delete permanently enables
 * without closing anything.
 */
interface RetiredJobRow { id: string; name: string; operations: number; liveOperations: number; times: number }
interface RetiredOperationRow { id: string; name: string; jobName: string; jobRetired: boolean; times: number; links: number }
/** A LIVE operation whose job is retired. It is on no other screen — every list hides a retired
 * job — and it is what keeps that job from being deleted, so it has to be listed here. */
interface StrandedOperationRow {
  id: string; name: string; times: number; links: number
  job: { id: string; name: string; section_id: string | null; production_line_id: string | null }
}

type Purge = { kind: 'job'; id: string; name: string } | { kind: 'operation'; id: string; name: string }

const ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid #f2f2f2' }
const HEADING: React.CSSProperties = { fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-mid)', margin: '14px 0 2px' }
const SMALL_BTN: React.CSSProperties = { padding: '5px 10px', fontSize: 12 }
const ERR_BOX: React.CSSProperties = { margin: '0 0 10px', padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13, lineHeight: 1.55 }

export default function RetiredItemsDialog({
  supabase, userId, role, sectionId, sectionName, onClose, onChanged,
}: {
  supabase: SupabaseClient
  userId: string
  role: UserRole | null
  sectionId: string
  sectionName: string
  onClose: () => void
  /** Something was restored or deleted — the host re-reads its lists. */
  onChanged: () => void
}) {
  const [jobs, setJobs] = useState<RetiredJobRow[]>([])
  const [operations, setOperations] = useState<RetiredOperationRow[]>([])
  const [stranded, setStranded] = useState<StrandedOperationRow[]>([])
  const [moveTarget, setMoveTarget] = useState<StrandedOperationRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [purge, setPurge] = useState<Purge | null>(null)

  const canRestore = canEditStructure(role)
  const canPurge = canDeletePermanently(role)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const jobRows = await fetchAllRows<{ id: string; name: string; section_id: string | null; production_line_id: string | null; is_active?: boolean | null }>(
        () => supabase.from('jobs').select('id, name, section_id, production_line_id, is_active').eq('section_id', sectionId).order('id'),
        { table: 'jobs' }
      )
      const opRows = await fetchAllChunked<{ id: string; name: string; job_id: string; is_active?: boolean | null }>(
        jobRows.map((j) => j.id), READ_CHUNK,
        (chunk) => supabase.from('operations').select('id, name, job_id, is_active').in('job_id', chunk).order('id'),
        { table: 'operations' }
      )
      // Counts are needed for every operation under a retired job (what restoring it brings
      // back) and for every retired operation (whether it is empty enough to delete).
      const retiredJobIds = new Set(jobRows.filter((j) => j.is_active === false).map((j) => j.id))
      const relevant = opRows.filter((o) => o.is_active === false || retiredJobIds.has(o.job_id))
      const relevantIds = relevant.map((o) => o.id)
      const [timeRows, links] = await Promise.all([
        fetchAllChunked<{ operation_id: string }>(
          relevantIds, READ_CHUNK,
          (chunk) => supabase.from('operation_times').select('operation_id').in('operation_id', chunk).order('id'),
          { table: 'operation_times' }
        ),
        fetchLinksForOperations(supabase, relevantIds),
      ])
      const timesByOp = new Map<string, number>()
      for (const t of timeRows) timesByOp.set(t.operation_id, (timesByOp.get(t.operation_id) ?? 0) + 1)
      const linksByOp = new Map<string, number>()
      for (const l of links) linksByOp.set(l.operation_id, (linksByOp.get(l.operation_id) ?? 0) + 1)
      const jobById = new Map(jobRows.map((j) => [j.id, j]))

      setJobs(jobRows.filter((j) => j.is_active === false).map((j) => {
        const own = opRows.filter((o) => o.job_id === j.id)
        return {
          id: j.id, name: j.name, operations: own.length,
          liveOperations: own.filter((o) => o.is_active !== false).length,
          times: own.reduce((n, o) => n + (timesByOp.get(o.id) ?? 0), 0),
        }
      }).sort((a, b) => a.name.localeCompare(b.name)))
      setOperations(opRows.filter((o) => o.is_active === false).map((o) => ({
        id: o.id, name: o.name,
        jobName: jobById.get(o.job_id)?.name ?? '—',
        jobRetired: retiredJobIds.has(o.job_id),
        times: timesByOp.get(o.id) ?? 0,
        links: linksByOp.get(o.id) ?? 0,
      })).sort((a, b) => a.jobName.localeCompare(b.jobName) || a.name.localeCompare(b.name)))
      setStranded(opRows.filter((o) => o.is_active !== false && retiredJobIds.has(o.job_id)).map((o) => {
        const job = jobById.get(o.job_id)!
        return {
          id: o.id, name: o.name, times: timesByOp.get(o.id) ?? 0, links: linksByOp.get(o.id) ?? 0,
          job: { id: job.id, name: job.name, section_id: job.section_id, production_line_id: job.production_line_id },
        }
      }).sort((a, b) => a.job.name.localeCompare(b.job.name) || a.name.localeCompare(b.name)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the retired items')
    } finally {
      setLoading(false)
    }
  }, [supabase, sectionId])

  useEffect(() => { load() }, [load])

  async function run(id: string, action: () => Promise<void>) {
    setBusyId(id); setError(null); setNotice(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be done')
    }
    await load()
    setBusyId(null)
  }

  const purgeButton = (target: Purge, empty: boolean, notEmptyReason: string) => (
    <button
      type="button" className="btn-ghost" style={{ ...SMALL_BTN, color: canPurge && empty ? 'var(--red)' : undefined }}
      disabled={busyId !== null || !canPurge || !empty}
      title={!empty ? notEmptyReason : !canPurge ? 'Deleting permanently is admin-only' : 'Remove this empty row for good — cannot be undone'}
      onClick={() => setPurge(target)}
    >
      Delete permanently
    </button>
  )
  const restoreButton = (id: string, action: () => Promise<void>) => (
    <button
      type="button" className="btn-ghost" style={SMALL_BTN}
      disabled={busyId !== null || !canRestore}
      title={canRestore ? 'Bring it back as a live row' : STRUCTURE_LOCKED_REASON}
      onClick={() => run(id, action)}
    >
      {busyId === id ? 'Restoring…' : 'Restore'}
    </button>
  )

  return (
    <>
      <Modal
        title={`Retired in "${sectionName}"`} onClose={onClose} maxWidth={640}
        footer={<button className="btn-ghost" onClick={onClose}>Close</button>}
      >
        <p style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6, margin: '0 0 6px' }}>
          Retired jobs and operations are hidden everywhere else, with their recorded times and model links kept.
          Restore brings one back. Delete permanently is only for a retired row that holds nothing.
        </p>
        {error && <p style={ERR_BOX}>{error}</p>}
        {notice && <p style={{ margin: '0 0 10px', padding: '9px 14px', borderRadius: 8, background: 'var(--green-bg)', border: '1px solid #86efac', color: '#15803d', fontSize: 13, lineHeight: 1.55 }}>{notice}</p>}
        {loading && jobs.length === 0 && operations.length === 0 && stranded.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '12px 0 0' }}>Loading…</p>
        ) : jobs.length === 0 && operations.length === 0 && stranded.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '12px 0 0' }}>Nothing in this section is retired.</p>
        ) : (
          <>
            {jobs.length > 0 && <div style={HEADING}>{plural(jobs.length, 'retired job')}</div>}
            {jobs.map((job) => (
              <div key={job.id} style={ROW}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)' }}>{job.name}</span>{' '}
                  <RetiredBadge />
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>
                    {job.operations === 0 ? 'holds nothing' : `${plural(job.operations, 'operation')} (${job.liveOperations} live, ${job.operations - job.liveOperations} retired) · ${plural(job.times, 'recorded time')}`}
                  </span>
                  {job.operations > 0 && (
                    <span style={{ display: 'block', fontSize: 12, color: '#92400e' }}>
                      {`${plural(job.operations, 'operation')} must be moved out or permanently deleted before this job can be deleted — see below.`}
                    </span>
                  )}
                </span>
                {restoreButton(job.id, () => restoreJob(supabase, job.id))}
                {purgeButton(
                  { kind: 'job', id: job.id, name: job.name }, job.operations === 0,
                  `Holds ${plural(job.operations, 'operation')} (${job.liveOperations} live, ${job.operations - job.liveOperations} retired) — move or permanently delete ${job.operations === 1 ? 'it' : 'them'} first`
                )}
              </div>
            ))}
            {stranded.length > 0 && (
              <>
                <div style={HEADING}>{`${plural(stranded.length, 'operation')} still in retired jobs`}</div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: '2px 0 0' }}>
                  Live operations whose job is retired. They appear nowhere else, and they keep that job from being deleted. Move each to a live job, or retire it.
                </p>
              </>
            )}
            {stranded.map((op) => (
              <div key={op.id} style={ROW}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{op.name}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>
                    {`in ${op.job.name} (retired job) · ${plural(op.times, 'recorded time')} · ${plural(op.links, 'model link')}`}
                  </span>
                </span>
                <button
                  type="button" className="btn-ghost" style={SMALL_BTN} disabled={busyId !== null || !canRestore}
                  title={canRestore ? 'Move this operation, with its times and model links, to a live job' : STRUCTURE_LOCKED_REASON}
                  onClick={() => setMoveTarget(op)}
                >
                  Move to another job
                </button>
                <button
                  type="button" className="btn-ghost" style={SMALL_BTN} disabled={busyId !== null || !canRestore}
                  title={canRestore ? 'Retire this operation — its times and model links are kept; once it holds nothing it can be deleted' : STRUCTURE_LOCKED_REASON}
                  onClick={() => run(op.id, () => retireOperation(supabase, op.id))}
                >
                  {busyId === op.id ? 'Retiring…' : 'Retire'}
                </button>
              </div>
            ))}
            {operations.length > 0 && <div style={HEADING}>{plural(operations.length, 'retired operation')}</div>}
            {operations.map((op) => (
              <div key={op.id} style={ROW}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)' }}>{op.name}</span>{' '}
                  <RetiredBadge />
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>
                    {`in ${op.jobName}${op.jobRetired ? ' (retired job)' : ''} · `}
                    {op.times === 0 && op.links === 0 ? 'holds nothing' : `${plural(op.times, 'recorded time')} · ${plural(op.links, 'model link')}`}
                  </span>
                </span>
                {restoreButton(op.id, () => reactivateOperation(supabase, op.id))}
                {purgeButton(
                  { kind: 'operation', id: op.id, name: op.name }, op.times === 0 && op.links === 0,
                  `Holds ${plural(op.times, 'recorded time')} and ${plural(op.links, 'model link')} — restore it and move or merge it, so they are kept`
                )}
              </div>
            ))}
          </>
        )}
      </Modal>

      {moveTarget && (
        <MoveOperationsDialog
          supabase={supabase} userId={userId} job={moveTarget.job} operationIds={[moveTarget.id]}
          onClose={() => setMoveTarget(null)}
          onChanged={() => { onChanged(); load() }}
          onDone={(message) => { setMoveTarget(null); setError(null); setNotice(message); onChanged(); load() }}
        />
      )}

      {purge && (
        <ConfirmDialog
          title={`Permanently delete "${purge.name}"`}
          message={
            `“${purge.name}” is retired and holds nothing — ` +
            (purge.kind === 'job' ? 'no operations, no recorded times, no model links' : 'no recorded times and no model links') +
            `. This removes the ${purge.kind} row from the database for good. It is not a retire, and it cannot be undone.`
          }
          confirmLabel="Delete permanently"
          danger
          maxWidth={520}
          onConfirm={() => {
            const target = purge
            setPurge(null)
            run(target.id, () => target.kind === 'job'
              ? deleteJobPermanently(supabase, target.id)
              : deleteOperationPermanently(supabase, target.id))
          }}
          onCancel={() => setPurge(null)}
        />
      )}
    </>
  )
}
