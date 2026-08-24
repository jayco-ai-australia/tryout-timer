'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import ConfirmDialog from '@/components/ConfirmDialog'
import { ModelSeriesPicker } from '@/components/ModelLinker'
import { addOperationTimeNote, recordOperationTime } from '@/lib/operationTimes'
import { chunked, linkOperationsToModels, READ_CHUNK } from '@/lib/modelOperations'
import { fmtMinutes } from '@/lib/format'
import type { createClient } from '@/lib/supabase/client'
import type { Product } from '@/lib/types'

type SupabaseClient = ReturnType<typeof createClient>

/**
 * Copy a model's collected work onto other models on the same line.
 *
 * The case this exists for: two models are the same van with a different fit-out, so the jobs
 * that were timed on one are the same jobs on the other. Re-timing them is hours of a team
 * leader's day spent reproducing numbers that already exist.
 *
 * A copy does two distinct things, and it is worth being precise about which is which:
 *
 *   1. APPLICABILITY — a model_operations row linking each of the source's applicable
 *      operations to each target. This happens for every operation in the selected jobs,
 *      including the ones that have never been timed. It is the structural half: afterwards the
 *      target model requires the same work, whether or not any figures came with it.
 *
 *   2. TIMES — one new operation_time per source RUN, per target. Not the average: the
 *      individual runs, so the target's average is computed from the same spread of real
 *      measurements the source's was, and a model with three runs doesn't end up looking like a
 *      model with one. Each copy is written with is_imported = true (it wasn't collected live)
 *      and carries a note naming the model it came from, so nobody later mistakes a copied
 *      figure for a measured one.
 *
 * Every write goes through the shared paths — recordOperationTime, addOperationTimeNote,
 * linkOperationsToModels — so a copied time is indistinguishable in shape from a collected one
 * and inherits the same team/line stamping (from the operation's job, not the operator).
 *
 * Nothing here can be auto-undone: the copies are ordinary operation_times rows once written.
 * That is what the confirmation exists to say.
 */

const ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}
const OK_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--green-bg)',
  border: '1px solid #bbf7d0', color: '#15803d', fontSize: 13,
}
const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'var(--text-muted)', marginBottom: 8, display: 'block',
}
const DRAWER_WIDTH: React.CSSProperties = { width: '46vw', minWidth: 380 }

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** One job of the source model, with the operations that actually apply to it. */
export interface CopyJob {
  jobId: string
  jobName: string
  operations: { id: string; name: string }[]
}

/** A single recorded run on the source model — copied one-for-one, never averaged. */
interface SourceRun {
  operationId: string
  totalMinutes: number | null
  operatorId: string | null
}

interface CopyOutcome {
  /** The models actually copied to — snapshotted, so editing the selection afterwards can't
   * rewrite the report of what already happened. */
  targets: Product[]
  linked: number
  created: number
  notes: number
  /** Runs with no usable total_minutes — recordOperationTime rejects <= 0, and a copy of a
   * blank is not worth writing. Counted so the total still adds up. */
  skipped: number
  failures: string[]
}

export default function CopyToModelsPanel({
  supabase, sourceProduct, targetProducts, jobs, userId, onClose, onCompleted, onOpenModel,
}: {
  supabase: SupabaseClient
  sourceProduct: Product
  /** Every other product on the source's production line. */
  targetProducts: Product[]
  /** The source model's jobs and their applicable operations. */
  jobs: CopyJob[]
  userId: string
  onClose: () => void
  /** Called after a copy finishes so the host can refresh its own figures. */
  onCompleted: () => void
  /** Jump the page to a target model, to check the copy landed. */
  onOpenModel: (product: Product) => void
}) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
  }, [])

  function close() {
    setVisible(false)
    window.setTimeout(onClose, 320)
  }

  const [targetIds, setTargetIds] = useState<Set<string>>(new Set())
  // Every job selected by default — the common case is "this model is that model", and
  // deselecting the few that differ is less work than ticking the many that don't.
  const [jobIds, setJobIds] = useState<Set<string>>(() => new Set(jobs.map((j) => j.jobId)))

  const [runs, setRuns] = useState<SourceRun[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [confirmState, setConfirmState] = useState<{ alreadyTimed: number } | null>(null)
  const [checking, setChecking] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null)

  // ── The source's individual runs ──────────────────────────────────────────────────────
  // Fetched here rather than reused from the page's modelTotal: that carries only (id,
  // operation_id) plus per-operation averages, and a copy needs each run's own minutes and
  // operator.
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const { data: links, error: linkError } = await supabase
          .from('operation_time_models').select('operation_time_id').eq('product_id', sourceProduct.id)
        if (linkError) throw new Error(linkError.message)
        const timeIds = [...new Set((links ?? []).map((l) => l.operation_time_id as string))]

        const rows: SourceRun[] = []
        for (const chunk of chunked(timeIds, READ_CHUNK)) {
          const { data, error } = await supabase
            .from('operation_times').select('operation_id, total_minutes, operator_id').in('id', chunk)
          if (error) throw new Error(error.message)
          for (const r of (data ?? []) as { operation_id: string; total_minutes: number | null; operator_id: string | null }[]) {
            rows.push({ operationId: r.operation_id, totalMinutes: r.total_minutes, operatorId: r.operator_id })
          }
        }
        if (!cancelled) setRuns(rows)
      } catch (err) {
        if (!cancelled) { setRuns([]); setLoadError(err instanceof Error ? err.message : 'Could not load this model’s recorded runs') }
      }
    }
    load()
    return () => { cancelled = true }
  }, [supabase, sourceProduct.id])

  // ── Selection maths ───────────────────────────────────────────────────────────────────
  const selectedJobs = useMemo(() => jobs.filter((j) => jobIds.has(j.jobId)), [jobs, jobIds])
  const selectedOperationIds = useMemo(
    () => new Set(selectedJobs.flatMap((j) => j.operations.map((o) => o.id))),
    [selectedJobs]
  )
  const selectedRuns = useMemo(
    () => (runs ?? []).filter((r) => selectedOperationIds.has(r.operationId)),
    [runs, selectedOperationIds]
  )
  /** Only runs with real minutes become records — the rest are reported as skipped. */
  const copyableRuns = useMemo(() => selectedRuns.filter((r) => (r.totalMinutes ?? 0) > 0), [selectedRuns])

  const targets = useMemo(() => targetProducts.filter((p) => targetIds.has(p.id)), [targetProducts, targetIds])
  const newRecords = copyableRuns.length * targets.length
  const newLinks = selectedOperationIds.size * targets.length
  const canCopy = targets.length > 0 && selectedJobs.length > 0 && !running

  function toggleTarget(product: Product, isSelected: boolean) {
    setTargetIds((prev) => {
      const next = new Set(prev)
      if (isSelected) next.delete(product.id)
      else next.add(product.id)
      return next
    })
  }
  function toggleTargetSeries(_series: string, seriesProducts: Product[], allSelected: boolean) {
    setTargetIds((prev) => {
      const next = new Set(prev)
      for (const p of seriesProducts) { if (allSelected) next.delete(p.id); else next.add(p.id) }
      return next
    })
  }

  // ── Pre-flight: does any target already hold times for these operations? ──────────────
  /** Not a blocker — a copy alongside existing runs is legitimate, it just adds more of them.
   * Stated up front so nobody discovers it afterwards in an average that moved. */
  const openConfirm = useCallback(async () => {
    setChecking(true)
    try {
      const targetProductIds = targets.map((p) => p.id)
      const linkRows: { operation_time_id: string; product_id: string }[] = []
      for (const chunk of chunked(targetProductIds, READ_CHUNK)) {
        const { data, error } = await supabase
          .from('operation_time_models').select('operation_time_id, product_id').in('product_id', chunk)
        if (error) throw new Error(error.message)
        linkRows.push(...((data ?? []) as { operation_time_id: string; product_id: string }[]))
      }
      const timeIds = [...new Set(linkRows.map((l) => l.operation_time_id))]
      const opByTimeId = new Map<string, string>()
      for (const chunk of chunked(timeIds, READ_CHUNK)) {
        const { data, error } = await supabase
          .from('operation_times').select('id, operation_id').in('id', chunk)
        if (error) throw new Error(error.message)
        for (const r of (data ?? []) as { id: string; operation_id: string }[]) opByTimeId.set(r.id, r.operation_id)
      }
      const existing = new Set<string>()
      for (const l of linkRows) {
        const opId = opByTimeId.get(l.operation_time_id)
        if (opId && selectedOperationIds.has(opId)) existing.add(`${l.product_id}:${opId}`)
      }
      setConfirmState({ alreadyTimed: existing.size })
    } catch (err) {
      // A failed pre-flight must not block the copy — it only removes the warning, so say so
      // rather than pretending the check passed.
      setConfirmState({ alreadyTimed: -1 })
      console.error('[copy] could not pre-check target times:', err)
    } finally {
      setChecking(false)
    }
  }, [supabase, targets, selectedOperationIds])

  // ── Execute ───────────────────────────────────────────────────────────────────────────
  async function runCopy() {
    setConfirmState(null)
    setRunning(true)
    setOutcome(null)
    setProgress({ done: 0, total: newRecords })

    const copiedTo = targets
    const result: CopyOutcome = {
      targets: copiedTo,
      linked: 0, created: 0, notes: 0,
      // Runs with no usable minutes are never attempted, so they're counted once here rather
      // than discovered inside the loop.
      skipped: (selectedRuns.length - copyableRuns.length) * targets.length,
      failures: [],
    }
    const note = `Copied from ${sourceProduct.model}`
    const opIds = [...selectedOperationIds]

    try {
      for (const target of copiedTo) {
        // 1. Applicability, in one batched upsert per target — every selected operation,
        //    timed or not. Existing links are no-ops.
        const linkResult = await linkOperationsToModels(
          supabase, opIds.map((operation_id) => ({ operation_id, product_id: target.id }))
        )
        result.linked += linkResult.linked
        if (linkResult.error) result.failures.push(`Linking operations to ${target.model}: ${linkResult.error}`)

        // 2. One new time per copyable source run. Sequential on purpose: recordOperationTime
        //    does several round trips of its own, and firing hundreds concurrently is how a
        //    copy turns into a rate-limit failure halfway through.
        //
        //    Iterates copyableRuns, not selectedRuns: the skipped ones are accounted for once
        //    below, and stepping the progress bar for a run that was never written would push
        //    `done` past `total`.
        for (const run of copyableRuns) {
          try {
            const created = await recordOperationTime(supabase, {
              operationId: run.operationId,
              productIds: [target.id],
              operatorId: run.operatorId,
              collectedBy: userId,
              totalMinutes: run.totalMinutes as number,
              // No timestamps: this is a copy, not a stopwatch run.
              isImported: true,
            })
            result.created += 1
            try {
              await addOperationTimeNote(supabase, created.id, note, userId)
              result.notes += 1
            } catch (noteErr) {
              // The time is committed and is the thing that matters — a missing note is worth
              // reporting, not worth failing the record over.
              result.failures.push(`Note on a ${target.model} copy: ${noteErr instanceof Error ? noteErr.message : 'failed'}`)
            }
          } catch (err) {
            result.failures.push(`${target.model}: ${err instanceof Error ? err.message : 'could not copy a record'}`)
          }
          setProgress((p) => ({ ...p, done: p.done + 1 }))
        }
      }
    } finally {
      setOutcome(result)
      setRunning(false)
      onCompleted()
    }
  }

  const allJobsSelected = jobs.length > 0 && jobIds.size === jobs.length
  const loadingRuns = runs === null

  return (
    <>
      <div className={'gaps-drawer-overlay' + (visible ? ' gaps-drawer-overlay-visible' : '')} onClick={() => { if (!running) close() }} />
      <div className={'gaps-drawer' + (visible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
        <div className="gaps-drawer-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="gaps-drawer-title">Copy to other models</div>
            <div className="gaps-drawer-jobname">
              From {sourceProduct.model}
              {sourceProduct.product_code && <> · {sourceProduct.product_code}</>}
            </div>
          </div>
          <button className="gaps-drawer-close" onClick={() => { if (!running) close() }} aria-label="Close" disabled={running}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="gaps-drawer-body" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {loadError && <p style={ERR_BOX}>{loadError}</p>}

          {/* ── Result ─────────────────────────────────────────────────────────────── */}
          {outcome && (
            <div style={outcome.failures.length > 0 ? ERR_BOX : OK_BOX}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {outcome.failures.length > 0 ? 'Copied with problems' : 'Copy complete'}
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                {plural(outcome.created, 'time record')} created across {plural(outcome.targets.length, 'model')}
                {outcome.notes < outcome.created && <> ({outcome.notes} noted)</>}
                , {plural(outcome.linked, 'operation link')} written
                {outcome.skipped > 0 && <>, {outcome.skipped} run{outcome.skipped === 1 ? '' : 's'} skipped for having no recorded minutes</>}.
              </div>
              {outcome.failures.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
                  {outcome.failures.slice(0, 5).map((f, i) => <li key={i}>{f}</li>)}
                  {outcome.failures.length > 5 && <li>…and {outcome.failures.length - 5} more</li>}
                </ul>
              )}
              {outcome.targets.length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {outcome.targets.slice(0, 6).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="finder-row-action"
                      title={`Open ${t.model} in Model Total to check the copy`}
                      onClick={() => { onOpenModel(t); close() }}
                    >
                      Open {t.model} →
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Progress ───────────────────────────────────────────────────────────── */}
          {running && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
                Copying… {progress.done} of {progress.total} records
              </div>
              <div className="coverage-bar">
                <div
                  className="coverage-fill"
                  style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
                />
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
                Leave this panel open until it finishes — closing it won&apos;t undo what has already
                been written.
              </p>
            </div>
          )}

          {/* ── Targets ────────────────────────────────────────────────────────────── */}
          <div>
            <span style={SECTION_LABEL}>
              Target models ({targets.length} of {targetProducts.length} selected)
            </span>
            {targetProducts.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                There are no other models on this production line to copy to.
              </p>
            ) : (
              <ModelSeriesPicker
                products={targetProducts}
                selectedIds={targetIds}
                onToggle={toggleTarget}
                onToggleSeries={toggleTargetSeries}
              />
            )}
          </div>

          {/* ── Jobs ───────────────────────────────────────────────────────────────── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <span style={SECTION_LABEL}>Jobs to copy ({selectedJobs.length} of {jobs.length})</span>
              <button
                type="button"
                className="finder-row-action"
                onClick={() => setJobIds(allJobsSelected ? new Set() : new Set(jobs.map((j) => j.jobId)))}
              >
                {allJobsSelected ? 'Select none' : 'Select all'}
              </button>
            </div>
            {jobs.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                No jobs apply to {sourceProduct.model} yet, so there is nothing to copy.
              </p>
            ) : (
              <div className="checkbox-list" style={{ maxHeight: 'none' }}>
                {jobs.map((job) => {
                  const jobRuns = (runs ?? []).filter((r) => job.operations.some((o) => o.id === r.operationId))
                  return (
                    <label key={job.jobId} className="checkbox-row" style={{ cursor: 'pointer' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <input
                          type="checkbox"
                          checked={jobIds.has(job.jobId)}
                          onChange={() => setJobIds((prev) => {
                            const next = new Set(prev)
                            if (next.has(job.jobId)) next.delete(job.jobId)
                            else next.add(job.jobId)
                            return next
                          })}
                        />
                        <span style={{ minWidth: 0 }}>{job.jobName}</span>
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {plural(job.operations.length, 'op')} · {loadingRuns ? '…' : plural(jobRuns.length, 'run')}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>

          {/* ── Preview ────────────────────────────────────────────────────────────── */}
          <div className="card" style={{ padding: '12px 16px', background: 'var(--bg)' }}>
            <span style={SECTION_LABEL}>What this will do</span>
            {loadingRuns ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>Counting recorded runs…</p>
            ) : targets.length === 0 || selectedJobs.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                Pick at least one target model and one job.
              </p>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--text-mid)', margin: 0, lineHeight: 1.7 }}>
                Copy <strong style={{ color: 'var(--text)' }}>{plural(selectedJobs.length, 'job')}</strong>{' '}
                ({plural(selectedOperationIds.size, 'operation')}, {plural(copyableRuns.length, 'time record')})
                from <strong style={{ color: 'var(--text)' }}>{sourceProduct.model}</strong> →{' '}
                <strong style={{ color: 'var(--text)' }}>{plural(targets.length, 'target model')}</strong>.
                This will create <strong style={{ color: 'var(--text)' }}>{newRecords}</strong> new time
                record{newRecords === 1 ? '' : 's'} ({copyableRuns.length} × {targets.length}), each noted
                &ldquo;Copied from {sourceProduct.model}&rdquo;, and link all{' '}
                {plural(selectedOperationIds.size, 'operation')} to each target
                ({newLinks} link{newLinks === 1 ? '' : 's'}).
                {selectedRuns.length > copyableRuns.length && (
                  <>
                    {' '}
                    <span style={{ color: 'var(--text-muted)' }}>
                      {selectedRuns.length - copyableRuns.length} source run
                      {selectedRuns.length - copyableRuns.length === 1 ? '' : 's'} have no recorded
                      minutes and will be skipped.
                    </span>
                  </>
                )}
              </p>
            )}
          </div>
        </div>

        <div className="finder-pane-footer" style={{ padding: '12px 20px' }}>
          <button
            type="button"
            className="btn-primary"
            disabled={!canCopy || loadingRuns || checking}
            onClick={openConfirm}
          >
            {checking ? 'Checking…' : running ? 'Copying…' : `Copy to ${plural(targets.length, 'model')}`}
          </button>
          <button type="button" className="btn-ghost" disabled={running} onClick={close}>
            {outcome ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>

      {confirmState && (
        <ConfirmDialog
          title="Copy this model's work?"
          message={
            `${newRecords} new time record${newRecords === 1 ? '' : 's'} will be created across ` +
            `${plural(targets.length, 'model')} (${plural(copyableRuns.length, 'run')} × ${targets.length}), ` +
            `and ${plural(selectedOperationIds.size, 'operation')} linked to each target. ` +
            'Every copied record is marked as imported and noted with the model it came from. ' +
            'This cannot be undone automatically — the copies are ordinary time records once written.'
          }
          confirmLabel={`Copy ${newRecords} record${newRecords === 1 ? '' : 's'}`}
          cancelLabel="Cancel"
          danger
          maxWidth={560}
          onConfirm={runCopy}
          onCancel={() => setConfirmState(null)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: 'var(--text-mid)' }}>
            {confirmState.alreadyTimed > 0 && (
              <p style={{ margin: 0 }}>
                <strong>{confirmState.alreadyTimed} target operation{confirmState.alreadyTimed === 1 ? '' : 's'} already
                {confirmState.alreadyTimed === 1 ? ' has' : ' have'} times</strong> — copies will be added
                alongside them, not replace them.
              </p>
            )}
            {confirmState.alreadyTimed === -1 && (
              <p style={{ margin: 0, color: 'var(--red)' }}>
                Couldn&apos;t check whether the targets already have times — the copy will still run,
                and would add to any that do.
              </p>
            )}
            <div>
              <span style={{ ...SECTION_LABEL, marginBottom: 4 }}>Targets</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {targets.map((t) => <span key={t.id} className="badge badge-blue">{t.model}</span>)}
              </div>
            </div>
            {copyableRuns.length > 0 && (
              <span style={{ color: 'var(--text-muted)' }}>
                Total copied labour per target: {fmtMinutes(copyableRuns.reduce((sum, r) => sum + (r.totalMinutes ?? 0), 0))}m
                across {plural(copyableRuns.length, 'run')}.
              </span>
            )}
          </div>
        </ConfirmDialog>
      )}
    </>
  )
}
