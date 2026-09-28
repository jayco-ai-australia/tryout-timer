'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import ConfirmDialog from '@/components/ConfirmDialog'
import { ModelSeriesPicker } from '@/components/ModelLinker'
import { addOperationTimeNote, copiedNoteFor, recordOperationTime } from '@/lib/operationTimes'
import { buildReportHref } from '@/lib/reports'
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

/** How many job names the confirm dialog lists before collapsing the rest into "+ N more".
 * Six fits without the dialog scrolling; past that the list stops being scannable anyway and a
 * count is more use than a wall of names. */
const MAX_LISTED_JOBS = 6
/** The same idea in running prose, where six names is a paragraph. Used by the result sentence. */
const MAX_NAMED_IN_SENTENCE = 3
/** And for the result's per-target "view the times" links, for the same reason. */
const MAX_LISTED_TARGETS = 6

/** "A, B and C" / "A, B, C + 2 more" — job names for the result sentence. */
function jobNameLabel(names: string[]): string {
  if (names.length <= MAX_NAMED_IN_SENTENCE) {
    if (names.length <= 1) return names[0] ?? 'nothing'
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  }
  return `${names.slice(0, MAX_NAMED_IN_SENTENCE).join(', ')} + ${names.length - MAX_NAMED_IN_SENTENCE} more`
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** One job of the source model, with the operations that actually apply to it. */
export interface CopyJob {
  jobId: string
  jobName: string
  operations: { id: string; name: string }[]
}

/** One CURRENT record on the source model — copied one-for-one, never averaged. */
interface SourceRun {
  operationId: string
  totalMinutes: number | null
  operatorId: string | null
}

/** What landed on ONE target. Tracked per target rather than only in aggregate so the result
 * can name each model and say what it got, instead of reporting a total the reader then has to
 * divide up in their head. */
interface CopyOutcomeTarget {
  product: Product
  created: number
  linked: number
}

interface CopyOutcome {
  /** The models actually copied to — snapshotted, so editing the selection afterwards can't
   * rewrite the report of what already happened. */
  targets: Product[]
  /** Same snapshot rule: the job NAMES that were copied, captured at the moment the copy ran.
   * The result sentence names them, and the selection behind it stays editable. */
  jobNames: string[]
  perTarget: CopyOutcomeTarget[]
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

  // ── The source's current records ──────────────────────────────────────────────────────
  // Fetched here rather than reused from the page's modelTotal: that carries only (id,
  // operation_id) plus the per-operation figure, and a copy needs each record's own minutes
  // and operator.
  //
  // FILTERED to `superseded_by is null`, and this one matters. A copy means "give these models
  // the labour content this one has", and that content is now the current record per operation —
  // not every measurement ever taken. Unfiltered, an operation with three archived records would
  // write three times onto each target, each superseding the last, leaving the target's figure
  // set by whichever historical row happened to be written final. Copying history forward as
  // though it were current is exactly the error this filter prevents.
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
            .from('operation_times').select('operation_id, total_minutes, operator_id')
            .in('id', chunk).is('superseded_by', null)
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

  /**
   * Per-job figures for the confirm dialog — the names, which are what a person actually
   * verifies against, rather than the totals alone.
   *
   * Counted over COPYABLE runs, not every selected run, so these lines add up to the summary
   * underneath them: a job whose only run has no recorded minutes reads "0 runs" here and
   * contributes nothing below, which is exactly what will happen.
   */
  const selectedJobBreakdown = useMemo(() => selectedJobs.map((job) => {
    const opIds = new Set(job.operations.map((o) => o.id))
    const jobRuns = copyableRuns.filter((r) => opIds.has(r.operationId))
    return {
      jobId: job.jobId,
      jobName: job.jobName,
      operationCount: job.operations.length,
      runCount: jobRuns.length,
      minutes: jobRuns.reduce((sum, r) => sum + (r.totalMinutes ?? 0), 0),
    }
  }), [selectedJobs, copyableRuns])

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
      // NOT filtered to the current record: this is the "already timed" warning, and a target
      // whose only records are archived has still been timed. Same existence question coverage
      // asks — see lib/coverage.ts.
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
      jobNames: selectedJobs.map((j) => j.jobName),
      perTarget: [],
      linked: 0, created: 0, notes: 0,
      // Runs with no usable minutes are never attempted, so they're counted once here rather
      // than discovered inside the loop.
      skipped: (selectedRuns.length - copyableRuns.length) * targets.length,
      failures: [],
    }
    // The one definition of this string lives in lib/operationTimes beside the parser that reads
    // it back — see the note there. Same text as before; it is now recognisable afterwards.
    const note = copiedNoteFor(sourceProduct.model)
    const opIds = [...selectedOperationIds]

    try {
      for (const target of copiedTo) {
        const perTarget: CopyOutcomeTarget = { product: target, created: 0, linked: 0 }
        result.perTarget.push(perTarget)

        // 1. Applicability, in one batched upsert per target — every selected operation,
        //    timed or not. Existing links are no-ops.
        const linkResult = await linkOperationsToModels(
          supabase, opIds.map((operation_id) => ({ operation_id, product_id: target.id }))
        )
        result.linked += linkResult.linked
        perTarget.linked = linkResult.linked
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
            perTarget.created += 1
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

        {/* flex:1 + its own scroll so the Copy footer below stays pinned to the drawer's bottom,
          * the same three-region shape as the bulk-link and job-edit drawers. Without it the
          * target-model picker (89 rows on Caravan) pushed Copy off the bottom of a tablet — the
          * drawer as a whole could still be scrolled to reach it, so this was the survivable
          * version of /collect's blocking bug, but it is the same defect. */}
        <div className="gaps-drawer-body" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 18, flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {loadError && <p style={ERR_BOX}>{loadError}</p>}

          {/* ── Result ─────────────────────────────────────────────────────────────── */}
          {/*
            ── Result ────────────────────────────────────────────────────────────────────
            What actually happened, NAMED. This used to report the copy purely in totals
            ("N records across M models"), which left the one question a person has after
            pressing a destructive button — what did that just write, and where? — unanswered.
            It renders the outcome SNAPSHOT (jobNames, perTarget), not the live selection, so
            editing the panel afterwards can't rewrite the account of what already ran.
          */}
          {outcome && (
            <div style={outcome.failures.length > 0 ? ERR_BOX : OK_BOX}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                {outcome.failures.length > 0 ? 'Copied with problems' : 'Copy complete'}
              </div>

              {outcome.perTarget.length === 1 ? (
                // One target: one sentence, which is the common case and reads as a plain
                // statement rather than a report with a list of length one.
                <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                  Copied <strong>{jobNameLabel(outcome.jobNames)}</strong> to{' '}
                  <ModelButton product={outcome.perTarget[0].product} onOpenModel={onOpenModel} onClose={close} />
                  {' '}— {plural(outcome.perTarget[0].created, 'time record')},{' '}
                  {plural(outcome.perTarget[0].linked, 'operation')} linked.
                </div>
              ) : (
                <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                  Copied <strong>{jobNameLabel(outcome.jobNames)}</strong> to {plural(outcome.perTarget.length, 'model')}:
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {outcome.perTarget.map((t) => (
                      <li key={t.product.id}>
                        <ModelButton product={t.product} onOpenModel={onOpenModel} onClose={close} />
                        {' '}— {plural(t.created, 'time record')}, {plural(t.linked, 'operation')} linked.
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(outcome.skipped > 0 || outcome.notes < outcome.created) && (
                <div style={{ fontSize: 11, marginTop: 6, opacity: 0.85 }}>
                  {outcome.skipped > 0 && (
                    <>{outcome.skipped} run{outcome.skipped === 1 ? '' : 's'} skipped for having no recorded minutes. </>
                  )}
                  {outcome.notes < outcome.created && (
                    <>{outcome.created - outcome.notes} copy could not be noted with its source model. </>
                  )}
                </div>
              )}

              {outcome.failures.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
                  {outcome.failures.slice(0, 5).map((f, i) => <li key={i}>{f}</li>)}
                  {outcome.failures.length > 5 && <li>…and {outcome.failures.length - 5} more</li>}
                </ul>
              )}

              {/* The copies are ordinary time records, so the place that proves they exist is
                  /reports — deep-linked to the TARGET model over all time, because a copy is
                  written with no stopwatch timestamps and a "today" report would not obviously
                  contain it. One link per target: the report's Model filter is single-valued. */}
              <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {outcome.perTarget.slice(0, MAX_LISTED_TARGETS).map((t) => (
                  <Link
                    key={t.product.id}
                    className="finder-row-action"
                    href={buildReportHref({
                      lineId: sourceProduct.production_line_id ?? '',
                      productId: t.product.id,
                      preset: 'all',
                    })}
                  >
                    View the copied times
                    {outcome.perTarget.length > 1 && <> — {t.product.model}</>} →
                  </Link>
                ))}
                <button type="button" className="btn-ghost" onClick={close}>Done</button>
              </div>
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
          /* The irreversibility leads, because it is the one thing a person cannot recover from.
             The counts used to live here and now sit UNDER the job list — see below: the names
             are what somebody actually checks before pressing a destructive button, and putting
             totals above them made the dialog answer "how much?" before "what?". */
          message="This cannot be undone automatically — the copies are ordinary time records once written."
          confirmLabel={`Copy ${newRecords} record${newRecords === 1 ? '' : 's'}`}
          cancelLabel="Cancel"
          danger
          maxWidth={560}
          onConfirm={runCopy}
          onCancel={() => setConfirmState(null)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12, color: 'var(--text-mid)' }}>
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

            {/* ── What is being copied, BY NAME ─────────────────────────────────────────
                The whole point of this block: the dialog used to describe the copy purely in
                counts, so there was no way to tell "8 operations" of the right job from
                "8 operations" of the wrong one. */}
            <div>
              <span style={{ ...SECTION_LABEL, marginBottom: 4 }}>Copying</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {selectedJobBreakdown.slice(0, MAX_LISTED_JOBS).map((j) => (
                  <div
                    key={j.jobId}
                    style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}
                  >
                    <span style={{ fontWeight: 600, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {j.jobName}
                    </span>
                    <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {plural(j.operationCount, 'operation')} · {plural(j.runCount, 'run')} · {fmtMinutes(j.minutes)}m
                    </span>
                  </div>
                ))}
                {selectedJobBreakdown.length > MAX_LISTED_JOBS && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    + {selectedJobBreakdown.length - MAX_LISTED_JOBS} more
                  </span>
                )}
              </div>
            </div>

            <div>
              <span style={{ ...SECTION_LABEL, marginBottom: 4 }}>Targets</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {targets.map((t) => <span key={t.id} className="badge badge-blue">{t.model}</span>)}
              </div>
            </div>

            {/* The totals, kept word for word but demoted to a footnote under the names. */}
            <p style={{ margin: 0, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              {newRecords} new time record{newRecords === 1 ? '' : 's'} will be created across{' '}
              {plural(targets.length, 'model')} ({plural(copyableRuns.length, 'run')} × {targets.length}),
              and {plural(selectedOperationIds.size, 'operation')} linked to each target.
              Every copied record is marked as imported and noted with the model it came from.
              {copyableRuns.length > 0 && (
                <> Total copied labour per target:{' '}
                  {fmtMinutes(copyableRuns.reduce((sum, r) => sum + (r.totalMinutes ?? 0), 0))}m.
                </>
              )}
            </p>
          </div>
        </ConfirmDialog>
      )}
    </>
  )
}

/** A target model's name, clickable through to it in Model Total. The jump used to be a row of
 * "Open X →" buttons under the result; folding it onto the name keeps the capability without a
 * second action row competing with the two that matter (view the times, done). */
function ModelButton({ product, onOpenModel, onClose }: {
  product: Product
  onOpenModel: (product: Product) => void
  onClose: () => void
}) {
  return (
    <button
      type="button"
      title={`Open ${product.model} in Model Total to check the copy`}
      onClick={() => { onOpenModel(product); onClose() }}
      style={{
        font: 'inherit', fontWeight: 700, color: 'inherit', background: 'none', border: 0,
        padding: 0, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2,
      }}
    >
      {product.model}
    </button>
  )
}
