'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import Modal from './Modal'
import { StructureFailureBox, toStructureFailure, type StructureFailure } from './StructureFailure'
import { plural } from '@/lib/format'
import { moveOperationsToJob, type OperationMove } from '@/lib/jobs'
import { resetLineTopologyCache } from '@/lib/lines'
import { READ_CHUNK, fetchLinksForOperations } from '@/lib/modelOperations'
import { operationNameKey } from '@/lib/operations'
import { fetchAllChunked, fetchAllRows } from '@/lib/supabaseRead'

/**
 * Move operations out of a job — and, optionally, retire the job once it is empty.
 *
 * Two callers, one dialog:
 *   - Retiring a job that still holds live operations (`retireAfter`): every live operation has
 *     to go somewhere first, or it is stranded under a job no screen lists.
 *   - "Move to another job" on a live operation sitting inside a retired job (`operationIds`).
 *
 * The destination is a LIVE job in the same section, widening to the same production line on
 * request. Never another line: the wider list is read by production_line_id and nothing else is
 * ever offered.
 *
 * ── Name collisions ────────────────────────────────────────────────────────────────────────
 * `operations` is UNIQUE on (name, job_id), so an operation can't move into a job that already
 * holds its name. Each clash is shown and resolved PER OPERATION:
 *   Rename (the default) — an editable name; nothing combines.
 *   Fuse — fold it into the existing operation: times re-pointed, missing model links copied,
 *          the source retired. Always a deliberate choice, never applied in bulk.
 *
 * The write is lib/jobs' moveOperationsToJob, which uses the shared writers and re-stamps the
 * recorded times with the destination job's team.
 */
interface SourceJob { id: string; name: string; section_id: string | null; production_line_id: string | null }
interface OperationRow { id: string; name: string; times: number; links: number }
interface JobOption { id: string; name: string; sectionId: string | null; sectionName: string }
interface DestOperation { id: string; name: string; isActive: boolean }
type Resolution = { kind: 'rename'; name: string } | { kind: 'fuse' }

const BODY_TEXT: React.CSSProperties = { fontSize: 14, color: 'var(--text-mid)', lineHeight: 1.6, margin: '0 0 12px' }
const HEAD: React.CSSProperties = { padding: '6px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)', textAlign: 'left' }
const CELL: React.CSSProperties = { padding: '7px 10px', fontSize: 13, color: 'var(--text-mid)', verticalAlign: 'top' }
const ERR_BOX: React.CSSProperties = { marginTop: 10, padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13, lineHeight: 1.55 }

export default function MoveOperationsDialog({
  supabase, userId, job, operationIds, retireAfter = false, onDone, onChanged, onClose,
}: {
  supabase: SupabaseClient
  userId: string
  /** The job the operations are leaving. */
  job: SourceJob
  /** Only these operations. Omitted, it is every LIVE operation under the job. */
  operationIds?: string[]
  /** Retire the job once its live operations have moved. */
  retireAfter?: boolean
  onDone: (message: string) => void
  /** Something was written but the action stopped part-way — the host should re-read. */
  onChanged?: () => void
  onClose: () => void
}) {
  const [operations, setOperations] = useState<OperationRow[] | null>(null)
  const [sourceNames, setSourceNames] = useState<Set<string>>(new Set())
  const [wholeLine, setWholeLine] = useState(false)
  const [jobOptions, setJobOptions] = useState<JobOption[]>([])
  const [destinationId, setDestinationId] = useState('')
  const [destOperations, setDestOperations] = useState<DestOperation[] | null>(null)
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({})
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [failure, setFailure] = useState<StructureFailure | null>(null)

  const idsKey = operationIds?.join(',') ?? ''

  // What is moving, with real counts, read when the dialog opens.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const all = await fetchAllRows<{ id: string; name: string; is_active?: boolean | null }>(
          () => supabase.from('operations').select('id, name, is_active').eq('job_id', job.id).order('id'),
          { table: 'operations' }
        )
        const wanted = idsKey ? new Set(idsKey.split(',')) : null
        const moving = all.filter((o) => o.is_active !== false && (!wanted || wanted.has(o.id)))
        const ids = moving.map((o) => o.id)
        const [timeRows, links] = await Promise.all([
          fetchAllChunked<{ operation_id: string }>(
            ids, READ_CHUNK,
            (chunk) => supabase.from('operation_times').select('operation_id').in('operation_id', chunk).order('id'),
            { table: 'operation_times' }
          ),
          fetchLinksForOperations(supabase, ids),
        ])
        if (cancelled) return
        const count = (rows: { operation_id: string }[], id: string) => rows.filter((r) => r.operation_id === id).length
        setSourceNames(new Set(all.map((o) => operationNameKey(o.name))))
        setOperations(moving
          .map((o) => ({ id: o.id, name: o.name, times: count(timeRows, o.id), links: count(links, o.id) }))
          .sort((a, b) => a.name.localeCompare(b.name)))
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not read this job’s operations')
      }
    })()
    return () => { cancelled = true }
  }, [supabase, job.id, idsKey])

  // Destination candidates: live jobs in the same section, or — when asked — on the same line.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        if (wholeLine ? !job.production_line_id : !job.section_id) { setJobOptions([]); return }
        const rows = await fetchAllRows<{ id: string; name: string; section_id: string | null; is_active?: boolean | null; sections: { name: string } | null }>(
          () => {
            const q = supabase.from('jobs').select('id, name, section_id, is_active, sections ( name )')
            return (wholeLine ? q.eq('production_line_id', job.production_line_id!) : q.eq('section_id', job.section_id!))
              .order('id') as never
          },
          { table: 'jobs' }
        )
        if (cancelled) return
        setJobOptions(rows
          .filter((j) => j.is_active !== false && j.id !== job.id)
          .map((j) => ({ id: j.id, name: j.name, sectionId: j.section_id, sectionName: j.sections?.name ?? 'No section' }))
          .sort((a, b) => a.sectionName.localeCompare(b.sectionName) || a.name.localeCompare(b.name)))
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not read the jobs to move to')
      }
    })()
    return () => { cancelled = true }
  }, [supabase, job.id, job.section_id, job.production_line_id, wholeLine])

  // The destination's operations — retired ones included, because the unique index counts them.
  useEffect(() => {
    setDestOperations(null); setResolutions({}); setFailure(null)
    if (!destinationId) return
    let cancelled = false
    fetchAllRows<{ id: string; name: string; is_active?: boolean | null }>(
      () => supabase.from('operations').select('id, name, is_active').eq('job_id', destinationId).order('id'),
      { table: 'operations' }
    ).then((rows) => {
      if (!cancelled) setDestOperations(rows.map((o) => ({ id: o.id, name: o.name, isActive: o.is_active !== false })))
    }).catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not read that job’s operations') })
    return () => { cancelled = true }
  }, [supabase, destinationId])

  const destination = jobOptions.find((j) => j.id === destinationId) ?? null
  const destByKey = useMemo(() => {
    const map = new Map<string, DestOperation>()
    // A live holder of the name wins over a retired one: it is the one a person would fuse into.
    for (const op of destOperations ?? []) {
      const key = operationNameKey(op.name)
      const held = map.get(key)
      if (!held || (!held.isActive && op.isActive)) map.set(key, op)
    }
    return map
  }, [destOperations])

  const suffix = ` (from ${job.name})`
  const resolutionFor = (op: OperationRow): Resolution => resolutions[op.id] ?? { kind: 'rename', name: `${op.name}${suffix}` }

  /** Why a rename can't be used as typed, or null. Checked against the destination's names, the
   * source job's own names (the rename is written before the move) and the other arrivals. */
  function renameProblem(op: OperationRow, name: string): string | null {
    const key = operationNameKey(name)
    if (!key) return 'Enter a name'
    if (destByKey.has(key)) return `${destination?.name ?? 'That job'} already has an operation called "${name.trim()}"`
    if (key !== operationNameKey(op.name) && sourceNames.has(key)) return `${job.name} already has an operation called "${name.trim()}"`
    const others = (operations ?? []).filter((o) => o.id !== op.id).map((o) => {
      const clash = destByKey.has(operationNameKey(o.name))
      const res = resolutionFor(o)
      return clash ? (res.kind === 'rename' ? operationNameKey(res.name) : null) : operationNameKey(o.name)
    })
    return others.includes(key) ? 'Another operation in this move is taking that name' : null
  }

  const clashes = (operations ?? []).filter((op) => destByKey.has(operationNameKey(op.name)))
  const blocked = clashes.some((op) => {
    const res = resolutionFor(op)
    return res.kind === 'rename' && renameProblem(op, res.name) !== null
  })
  const ready = Boolean(operations && destination && destOperations) && !blocked && (operations?.length ?? 0) > 0

  async function confirm() {
    if (!ready || !operations || !destination) return
    setSaving(true); setFailure(null)
    const moves: OperationMove[] = operations.map((op) => {
      const target = destByKey.get(operationNameKey(op.name))
      if (!target) return { id: op.id, name: op.name, choice: { kind: 'move' } }
      const res = resolutionFor(op)
      return res.kind === 'fuse'
        ? { id: op.id, name: op.name, choice: { kind: 'fuse', targetId: target.id, targetName: target.name, targetIsActive: target.isActive } }
        : { id: op.id, name: op.name, choice: { kind: 'rename', name: res.name } }
    })
    try {
      await moveOperationsToJob(supabase, {
        moves, destinationJobId: destination.id, destinationJobName: destination.name, userId,
        retireJobId: retireAfter ? job.id : undefined, retireJobName: job.name,
      })
      resetLineTopologyCache()
      const fused = moves.filter((m) => m.choice.kind === 'fuse').length
      const renamed = moves.filter((m) => m.choice.kind === 'rename').length
      onDone(
        `${plural(moves.length - fused, 'operation')} moved from "${job.name}" to "${destination.name}"` +
        (renamed > 0 ? ` (${renamed} renamed)` : '') +
        (fused > 0 ? `, ${plural(fused, 'operation')} fused into an existing one` : '') +
        (retireAfter ? `, and "${job.name}" retired.` : '.')
      )
    } catch (err) {
      setFailure(toStructureFailure(err, 'Could not move these operations'))
      setSaving(false)
      resetLineTopologyCache()
      onChanged?.()
    }
  }

  const count = operations?.length ?? 0
  return (
    <Modal
      title={retireAfter ? `Retire "${job.name}"` : `Move ${count === 1 && operations ? `"${operations[0].name}"` : 'operations'} to another job`}
      onClose={saving ? () => {} : onClose} maxWidth={680}
      footer={(
        <>
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className={retireAfter ? 'btn-danger' : 'btn-primary'} onClick={confirm} disabled={!ready || saving}>
            {saving ? 'Working…' : retireAfter
              ? `Move ${plural(count, 'operation')} and retire job`
              : `Move ${plural(count, 'operation')}`}
          </button>
        </>
      )}
    >
      <p style={BODY_TEXT}>
        {retireAfter
          ? `"${job.name}" still holds ${plural(count, 'live operation')}. A retired job is hidden everywhere, so they have to move to another job first — otherwise they would be out of reach. Their recorded times and model links go with them.`
          : `Pick the live job ${count === 1 ? 'this operation belongs' : 'these operations belong'} to. Recorded times and model links go with ${count === 1 ? 'it' : 'them'}.`}
      </p>

      {loadError && <p style={ERR_BOX}>{loadError}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        <label className="label">Destination job</label>
        <select className="select" value={destinationId} disabled={saving} onChange={(e) => setDestinationId(e.target.value)}>
          <option value="">— Select a job —</option>
          {jobOptions.map((j) => (
            <option key={j.id} value={j.id}>{wholeLine ? `${j.sectionName} — ${j.name}` : j.name}</option>
          ))}
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-mid)', cursor: 'pointer' }}>
          <input type="checkbox" checked={wholeLine} disabled={saving} onChange={(e) => { setWholeLine(e.target.checked); setDestinationId('') }} />
          Show jobs in other sections on this production line
        </label>
        {jobOptions.length === 0 && !loadError && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {wholeLine ? 'There is no other live job on this line.' : 'There is no other live job in this section — tick the box above to pick one elsewhere on the line.'}
          </span>
        )}
      </div>

      {operations === null ? (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>Reading the operations…</p>
      ) : operations.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>There is no live operation to move.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--border)', borderRadius: 8 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={HEAD}>Operation</th>
              <th style={{ ...HEAD, textAlign: 'right' }}>Time records</th>
              <th style={{ ...HEAD, textAlign: 'right' }}>Model links</th>
            </tr>
          </thead>
          <tbody>
            {operations.map((op) => {
              const target = destByKey.get(operationNameKey(op.name))
              const res = resolutionFor(op)
              const problem = target && res.kind === 'rename' ? renameProblem(op, res.name) : null
              return (
                <tr key={op.id} style={{ borderBottom: '1px solid #f2f2f2' }}>
                  <td style={{ ...CELL, color: 'var(--text)' }}>
                    <span style={{ fontWeight: 600 }}>{op.name}</span>
                    {target && (
                      <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 8, background: 'var(--amber-bg)', border: '1px solid #fcd34d', color: '#92400e', fontSize: 12, lineHeight: 1.55 }}>
                        {`${destination?.name ?? 'That job'} already has ${target.isActive ? 'an operation' : 'a retired operation'} called "${target.name}", and a job can hold only one of each name.`}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, cursor: 'pointer' }}>
                          <input
                            type="radio" name={`res-${op.id}`} checked={res.kind === 'rename'} disabled={saving}
                            onChange={() => setResolutions((prev) => ({ ...prev, [op.id]: { kind: 'rename', name: `${op.name}${suffix}` } }))}
                          />
                          <strong>Rename</strong> and move it — nothing combines
                        </label>
                        {res.kind === 'rename' && (
                          <div style={{ margin: '4px 0 0 20px' }}>
                            <input
                              className="input" value={res.name} disabled={saving}
                              style={{ fontSize: 13, padding: '4px 8px', width: '100%', maxWidth: 360 }}
                              onChange={(e) => setResolutions((prev) => ({ ...prev, [op.id]: { kind: 'rename', name: e.target.value } }))}
                            />
                            {problem && <div style={{ color: 'var(--red)', marginTop: 3 }}>{problem}</div>}
                          </div>
                        )}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, cursor: 'pointer' }}>
                          <input
                            type="radio" name={`res-${op.id}`} checked={res.kind === 'fuse'} disabled={saving}
                            onChange={() => setResolutions((prev) => ({ ...prev, [op.id]: { kind: 'fuse' } }))}
                          />
                          <span>
                            <strong>Fuse</strong> into the existing &ldquo;{target.name}&rdquo; — {plural(op.times, 'time record')} re-pointed to it,
                            missing model links copied, and this operation retired. Cannot be undone.
                          </span>
                        </label>
                      </div>
                    )}
                  </td>
                  <td style={{ ...CELL, textAlign: 'right' }}>{op.times.toLocaleString()}</td>
                  <td style={{ ...CELL, textAlign: 'right' }}>{op.links.toLocaleString()}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {destination && destOperations && operations && operations.length > 0 && (
        <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, margin: '12px 0 0' }}>
          {clashes.length === 0
            ? `No name clashes — ${count === 1 ? 'it moves' : `all ${count} move`} to "${destination.name}" as ${count === 1 ? 'it is' : 'they are'}.`
            : `${plural(clashes.length, 'operation')} ${clashes.length === 1 ? 'clashes' : 'clash'} with a name already in "${destination.name}" — choose rename or fuse for each above.`}
          {' '}Recorded times are re-stamped to that job’s team.
          {retireAfter && ` "${job.name}" is then retired.`}
        </p>
      )}
      {failure && <StructureFailureBox failure={failure} />}
    </Modal>
  )
}
