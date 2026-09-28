'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import AddTimeDrawer from '@/components/AddTimeDrawer'
import BulkModelLinkDrawer, { DRAWER_WIDTH, useSlideOverDrawer } from '@/components/BulkModelLinkDrawer'
import ModelUnlinkConfirm from '@/components/ModelUnlinkConfirm'
import OperationTimesDrawer from '@/components/OperationTimesDrawer'
import { fmtMinutes, plural } from '@/lib/format'
import { linkOperationsToModels } from '@/lib/modelOperations'
import { jobCompleteness } from '@/lib/operationTimes'
import { fetchAllRows, type RangeableQuery } from '@/lib/supabaseRead'
import type { Operation, Product, UserRole } from '@/lib/types'

/**
 * ── The Labour Matrix cell drawer ───────────────────────────────────────────────────────────
 *
 * One cell of the grid is one (COLUMN × MODEL) pair, and this is what opens behind it. Three
 * things can be done from here — apply the work to the model, unapply it, and enter times — and
 * NOT ONE of them is implemented in this file. Every action is an existing flow, opened with the
 * context the cell already knows:
 *
 *   apply            lib/modelOperations' linkOperationsToModels (the single upserting writer)
 *   apply, no ops    components/AddTimeDrawer — the app's add-a-time flow, which is also the one
 *                    place that creates operations and links them to the models in one pass
 *   unapply          components/ModelUnlinkConfirm → lib/modelLinks (times-aware, confirmed)
 *   enter a time     components/AddTimeDrawer, pre-filled with this job and this model
 *   edit a time      components/OperationTimesDrawer — the one time-record editor, which owns the
 *                    permission rules and the multi-model split
 *   all models       components/BulkModelLinkDrawer in job mode — the existing per-job panel
 *
 * ── It decides nothing about what a figure means ────────────────────────────────────────────
 * Applicability, minutes and coverage are all handed in by the matrix, which got them from the
 * same two shared helpers every screen uses (lib/operationTimes' currentForOperation and
 * lib/coverage's computeCoverageCombos). There is no second lookup here and no arithmetic beyond
 * counting rows in a list. The ONE read this file performs is the focused job's operation rows —
 * their names, which the grid has no use for and therefore never fetched.
 *
 * ── Grain ──────────────────────────────────────────────────────────────────────────────────
 * JOB grain opens straight onto the job. SECTION and TEAM grain open onto the jobs beneath the
 * cell, each with its own applies-state, minutes and coverage, and the user picks one. There are
 * deliberately NO aggregate actions at coarse grain: applicability and times attach to
 * OPERATIONS, so "apply this team to this model" would be a sentence about tens of jobs at once
 * with no way to state what it had done — and the coarse cell is a roll-up for reading, not a
 * handle for writing. See the matrix's own note on the roll-up.
 */

/** What the matrix knows about one (job, model) pair — the shape of its own cell, handed over
 * rather than recomputed. */
export interface CellFacts {
  minutes: number
  timedOps: number
  totalOps: number
  applies: boolean
}

/** The column's jobs, as the matrix already holds them. */
export interface DrawerJob {
  id: string
  name: string
  section_id: string | null
  production_line_id: string | null
}

export default function MatrixCellDrawer({
  supabase, userId, role, product, grainLabel, columnLabel, jobs, isJobGrain,
  cellFor, linkedOperationIds, minutesFor, jobLinkCountsFor, lineId, teamIdOf,
  onChanged, onClose,
}: {
  supabase: SupabaseClient
  userId: string
  /** profiles.role. Passed straight through to OperationTimesDrawer, which is where the
   * permission rules for editing somebody else's recorded time actually live. */
  role: UserRole | null
  /** The row. Labelled by products.model everywhere, never product_code. */
  product: Product
  /** "Job" / "Section" / "Team" — what the column IS, for the header. */
  grainLabel: string
  columnLabel: string
  /** The VISIBLE jobs beneath this cell — already past the matrix's Show and Team filters, so
   * this drawer can never act on a job the grid was hiding. */
  jobs: DrawerJob[]
  isJobGrain: boolean
  cellFor: (jobId: string) => CellFacts | undefined
  /** Operation ids linked to THIS model (model_operations). The applies-list, as the matrix read
   * it. */
  linkedOperationIds: Set<string>
  /** The CURRENT recorded figure for (operation, this model), or null when nothing is timed —
   * lib/operationTimes' stats map, asked by its own key function in the matrix. */
  minutesFor: (operationId: string) => number | null
  /** product id → how many of that job's operations are linked, for BulkModelLinkDrawer's job
   * mode. Computed by the matrix from rows it already has; never fetched here. */
  jobLinkCountsFor: (jobId: string) => Map<string, number>
  lineId: string
  teamIdOf: (jobId: string) => string | null
  /** Something was written. The matrix re-reads, so the cell, the row total, the header counts and
   * the coverage figure all move together — and this drawer stays open on top of the new numbers. */
  onChanged: () => void
  onClose: () => void
}) {
  const { visible, openDrawer, closeDrawer } = useSlideOverDrawer()
  useEffect(() => { openDrawer() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  function dismiss() {
    closeDrawer()
    window.setTimeout(onClose, 320)
  }

  /**
   * Which job is being acted on. At job grain there is exactly one and it is chosen for you; at
   * coarse grain this starts null and the drawer lists the jobs beneath the cell.
   */
  const [focusedJobId, setFocusedJobId] = useState<string | null>(
    isJobGrain ? jobs[0]?.id ?? null : null
  )
  const focusedJob = jobs.find((j) => j.id === focusedJobId) ?? null

  /** Bumped after anything this drawer opened wrote, so the operation list below re-reads — a
   * newly created operation has to appear without closing the drawer. */
  const [opsTick, setOpsTick] = useState(0)
  const [operations, setOperations] = useState<Operation[]>([])
  const [opsLoading, setOpsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** Everything written from here goes through onChanged AND opsTick: the first moves the grid's
   * numbers, the second moves this drawer's own list. */
  const refresh = useCallback(() => {
    setOpsTick((t) => t + 1)
    onChanged()
  }, [onChanged])

  /**
   * THE only read in this file: the focused job's live operations, for their NAMES. The grid
   * selects `id, job_id` and nothing else — a name per operation is bytes it has no use for
   * across 9,000 cells — so the one screen that needs them fetches them for the one job in view.
   *
   * Paged through lib/supabaseRead like every other read in this app, ordered by the primary key
   * because paging requires a total order. is_active = true, matching every other operation list
   * in the app: a retired operation is merged away and its times live on its keeper.
   */
  useEffect(() => {
    if (!focusedJobId) { setOperations([]); return }
    let cancelled = false
    setOpsLoading(true)
    fetchAllRows<Operation>(
      () => supabase.from('operations').select('*')
        .eq('job_id', focusedJobId).eq('is_active', true)
        .order('id') as unknown as RangeableQuery<Operation>,
      { table: 'operations' },
    )
      .then((rows) => {
        if (cancelled) return
        setOperations([...rows].sort((a, b) => a.name.localeCompare(b.name)))
        setError(null)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read this job’s operations')
      })
      .finally(() => { if (!cancelled) setOpsLoading(false) })
    return () => { cancelled = true }
  }, [supabase, focusedJobId, opsTick])

  /** The job's operations that this model claims — the applies-list, narrowed to this job. */
  const linkedHere = useMemo(
    () => operations.filter((o) => linkedOperationIds.has(o.id)),
    [operations, linkedOperationIds]
  )

  /**
   * What a job-level unlink has to cover: the UNION of what the model REQUIRES and what it has
   * TIMED. The two drift — a run whose applies-list row was removed elsewhere still counts
   * minutes — and unlinking only the required set would leave those runs counting towards a model
   * that no longer does the work. This is the same union /model-total's operationIdsForJob takes,
   * for the same reason.
   */
  const unlinkableOperationIds = useMemo(() => {
    const ids = new Set<string>()
    for (const o of operations) {
      if (linkedOperationIds.has(o.id) || minutesFor(o.id) !== null) ids.add(o.id)
    }
    return [...ids]
  }, [operations, linkedOperationIds, minutesFor])

  const jobApplies = focusedJob ? (cellFor(focusedJob.id)?.applies ?? false) : false

  // ── What this drawer opens on top of itself ──────────────────────────────────────────────
  const [unlinkTarget, setUnlinkTarget] = useState<
    { operationIds: string[]; operationName?: string } | null
  >(null)
  const [addTimeOpen, setAddTimeOpen] = useState(false)
  const [editTimesFor, setEditTimesFor] = useState<{ id: string; name: string } | null>(null)
  const [modelsOpen, setModelsOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  /**
   * Apply — link operations to this model through the single upserting writer. Never an insert
   * here, and never a second "is it applied?" rule: applicability IS a model_operations row, and
   * linkOperationsToModels is the only function that writes one.
   */
  async function link(operationIds: string[], what: string) {
    if (operationIds.length === 0) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const res = await linkOperationsToModels(
        supabase, operationIds.map((operation_id) => ({ operation_id, product_id: product.id }))
      )
      if (res.error) throw new Error(res.error)
      setNotice(`${what} now applies to ${product.model}.`)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply this to the model')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Apply a job that has NO operations yet. There is nothing to link — applicability lives on
   * operations — so this opens the add-a-time flow with the job and the model already chosen,
   * which is the one place in the app that creates operations and links them to a model in the
   * same pass. You cannot apply nothing.
   */
  function applyJob() {
    if (!focusedJob) return
    if (operations.length === 0) { setAddTimeOpen(true); return }
    void link(operations.map((o) => o.id), `“${focusedJob.name}”`)
  }

  const headerModel = `${product.model}`

  return (
    <>
      <div
        className={'gaps-drawer-overlay' + (visible ? ' gaps-drawer-overlay-visible' : '')}
        onClick={dismiss}
      />
      <div className={'gaps-drawer' + (visible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
        <div className="gaps-drawer-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="gaps-drawer-title">
              {focusedJob ? focusedJob.name : `${grainLabel}: ${columnLabel}`}
            </div>
            {/* products.model, always — the name on the grid's left-hand column and in every
                picker in the app. */}
            <div className="gaps-drawer-model">
              for {headerModel}
              {focusedJob && !isJobGrain && <> · in {columnLabel}</>}
            </div>
          </div>
          <button className="gaps-drawer-close" onClick={dismiss} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="gaps-drawer-body" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && (
            <p style={{ margin: 0, padding: '9px 12px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 12 }}>
              {error}
            </p>
          )}
          {notice && (
            <p
              style={{ margin: 0, padding: '9px 12px', borderRadius: 8, background: 'var(--green-bg)', border: '1px solid #bbf7d0', color: '#15803d', fontSize: 12, cursor: 'pointer' }}
              title="Dismiss" onClick={() => setNotice(null)}
            >
              {notice}
            </p>
          )}

          {/* ── Coarse grain: pick a job ────────────────────────────────────────────────
              The cell is a sum of these, so the list states each job's own figures rather than
              repeating the total the grid already showed. No apply-all, no time-all: see the
              module note. */}
          {!focusedJob && (
            <>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                This cell is the sum of {plural(jobs.length, 'job')} beneath{' '}
                <strong>{columnLabel}</strong>. Applicability and recorded times attach to a job’s
                OPERATIONS, so there is nothing to act on at {grainLabel.toLowerCase()} level — pick
                the job you mean.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {jobs.map((j) => {
                  const cell = cellFor(j.id)
                  const state = cell && cell.applies
                    ? jobCompleteness(cell.timedOps, cell.totalOps)
                    : null
                  return (
                    <button
                      key={j.id}
                      type="button"
                      className="lm-cell-job"
                      onClick={() => { setFocusedJobId(j.id); setNotice(null); setError(null) }}
                    >
                      <span className="lm-cell-job-name">{j.name}</span>
                      <span className="lm-cell-job-meta">
                        {!cell || !cell.applies ? (
                          <span className="lm-cell-tag">doesn’t apply</span>
                        ) : (
                          <>
                            <span className={
                              'lm-cell-fig'
                              + (state === 'none' ? ' lm-cell-fig-none' : state === 'partial' ? ' lm-cell-fig-partial' : ' lm-cell-fig-timed')
                            }>
                              {fmtMinutes(cell.minutes)}m
                            </span>
                            <span className="lm-cell-tag">{cell.timedOps} / {cell.totalOps} timed</span>
                          </>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {/* ── The job ─────────────────────────────────────────────────────────────── */}
          {focusedJob && (
            <>
              {!isJobGrain && (
                <button
                  type="button"
                  className="lm-cell-back"
                  onClick={() => { setFocusedJobId(null); setNotice(null); setError(null) }}
                >
                  ← all {plural(jobs.length, 'job')} in {columnLabel}
                </button>
              )}

              {/* Applies, at job level. The definition is not restated here: the matrix handed it
                  over, and it came from lib/coverage. */}
              <div className="lm-cell-applies">
                <span>
                  <strong>{jobApplies ? 'Applies' : 'Does not apply'}</strong> to {product.model}
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' '}— {linkedHere.length} of {plural(operations.length, 'operation')} linked
                  </span>
                </span>
                {jobApplies ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    style={{ fontSize: 12 }}
                    disabled={busy || unlinkableOperationIds.length === 0}
                    title="Remove this job from this model — an unlink, never a delete"
                    onClick={() => setUnlinkTarget({ operationIds: unlinkableOperationIds })}
                  >
                    Doesn’t apply
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ fontSize: 12, padding: '6px 12px' }}
                    disabled={busy || opsLoading}
                    title={operations.length === 0
                      ? 'This job has no operations yet — applicability lives on operations, so this opens the flow that adds them with this model already linked'
                      : `Link all ${operations.length} operations to ${product.model}`}
                    onClick={applyJob}
                  >
                    {operations.length === 0 ? 'Add operations & apply' : 'Apply to this model'}
                  </button>
                )}
              </div>

              {/* ── Operations: applies, and the current figure ─────────────────────── */}
              <div>
                <div className="lm-cell-sect">
                  <span>Operations</span>
                  <span style={{ display: 'flex', gap: 10 }}>
                    <button
                      type="button" className="lm-models-action" disabled={busy}
                      title="Enter or correct minutes for this job against this model — the app’s one add-a-time flow, pre-filled"
                      onClick={() => setAddTimeOpen(true)}
                    >
                      Enter times
                    </button>
                    <button
                      type="button" className="lm-models-action" disabled={busy}
                      title="Every model this job applies to — the per-job model panel from Setup"
                      onClick={() => setModelsOpen(true)}
                    >
                      All models…
                    </button>
                  </span>
                </div>

                {opsLoading ? (
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>Reading this job’s operations…</p>
                ) : operations.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    This job has no operations. A job applies to a model through its operations, so
                    there is nothing here to link or time yet — <strong>Add operations &amp; apply</strong>{' '}
                    creates them with {product.model} already ticked.
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {operations.map((op) => {
                      const linked = linkedOperationIds.has(op.id)
                      const minutes = minutesFor(op.id)
                      return (
                        <div key={op.id} className="lm-cell-op">
                          {/* The per-operation applies control. Ticking writes a
                              model_operations row through the shared writer; unticking opens the
                              confirmed, times-aware unlink rather than deleting the row here. */}
                          <label className="lm-cell-op-tick" title={linked
                            ? `${op.name} applies to ${product.model} — untick to remove it`
                            : `${op.name} does not apply to ${product.model} — tick to link it`}>
                            <input
                              type="checkbox"
                              checked={linked}
                              disabled={busy}
                              onChange={() => {
                                if (linked) setUnlinkTarget({ operationIds: [op.id], operationName: op.name })
                                else void link([op.id], `“${op.name}”`)
                              }}
                            />
                            <span className="lm-cell-op-name">{op.name}</span>
                          </label>
                          <span className="lm-cell-op-time">
                            {minutes === null
                              ? <span className="lm-cell-tag lm-cell-tag-none">not yet timed</span>
                              : <span className="lm-cell-fig lm-cell-fig-timed">{fmtMinutes(minutes)}m</span>}
                            <button
                              type="button"
                              className="lm-models-action"
                              disabled={busy}
                              title={minutes === null
                                ? 'Enter a time for this operation against this model'
                                : 'Every run behind this figure — edit, supersede, split or delete'}
                              onClick={() => {
                                if (minutes === null) setAddTimeOpen(true)
                                else setEditTimesFor({ id: op.id, name: op.name })
                              }}
                            >
                              {minutes === null ? 'Add time' : 'Edit'}
                            </button>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                A figure is the CURRENT recorded time for that operation and this model; superseded
                runs are kept and never counted. Unapplying is an unlink — no job, operation, time
                record or note is ever deleted from here.
              </p>
            </>
          )}
        </div>
      </div>

      {/* ── What opens on top ───────────────────────────────────────────────────────────── */}

      {/* The shared "doesn't apply" confirmation — the same component /model-total mounts, so the
          safeguards, the named list of affected runs and the wording cannot drift between the two
          screens. */}
      {unlinkTarget && focusedJob && (
        <ModelUnlinkConfirm
          supabase={supabase}
          productId={product.id}
          modelName={product.model}
          jobName={focusedJob.name}
          operationName={unlinkTarget.operationName}
          operationIds={unlinkTarget.operationIds}
          onCancel={() => setUnlinkTarget(null)}
          onDone={(res) => {
            setUnlinkTarget(null)
            setNotice(
              `${unlinkTarget.operationName ?? focusedJob.name} no longer applies to ${product.model}`
              + (res.timeLinksRemoved > 0 ? ` — ${plural(res.timeLinksRemoved, 'recorded time')} detached` : '')
              + (res.unattachedTimes > 0 ? `, ${res.unattachedTimes} now attached to no model` : '')
              + '.'
            )
            if (res.failures.length > 0) setError(res.failures.join(' '))
            refresh()
          }}
        />
      )}

      {/* The app's one add-a-time flow, handed the context this cell already is: the line, the
          team, the section, the job and the model. It is also the only flow that creates
          operations and links them to a model in one pass, which is what "apply a job with no
          operations" needs. */}
      {addTimeOpen && focusedJob && (
        <AddTimeDrawer
          productionLineId={focusedJob.production_line_id ?? lineId}
          teamId={teamIdOf(focusedJob.id) ?? undefined}
          sectionId={focusedJob.section_id ?? undefined}
          jobId={focusedJob.id}
          productIds={[product.id]}
          onDone={(result) => {
            setAddTimeOpen(false)
            if (result) {
              setNotice(
                `${plural(result.created, 'time')} recorded for ${product.model}`
                + (result.totalMinutes > 0 ? ` — ${fmtMinutes(result.totalMinutes)}m` : '') + '.'
              )
              if (result.failures.length > 0) setError(result.failures.join(' '))
              refresh()
            }
          }}
        />
      )}

      {/* THE time-record editor. Parameterised by (operationId, productId) and nothing else, and
          it owns the permission rules: a user who may not edit somebody else's record sees it
          read-only with the reason, rather than failing on save (lib/permissions). */}
      {editTimesFor && (
        <OperationTimesDrawer
          supabase={supabase}
          userId={userId}
          role={role}
          operationId={editTimesFor.id}
          operationName={editTimesFor.name}
          productId={product.id}
          onClose={() => setEditTimesFor(null)}
          onChanged={async () => { refresh() }}
        />
      )}

      {/* The per-job model panel from Setup, unchanged and in its existing job mode: ticks start
          at the current state, and a model linked to only some of the job's operations says so.
          This is the "all models" view the cell can't give — the cell is one model. */}
      {modelsOpen && focusedJob && (
        <>
          <div className="gaps-drawer-overlay gaps-drawer-overlay-visible" onClick={() => setModelsOpen(false)} />
          <div className="gaps-drawer gaps-drawer-visible" style={DRAWER_WIDTH}>
            <BulkModelLinkDrawer
              productionLineId={focusedJob.production_line_id ?? lineId}
              subjectLabel={focusedJob.name}
              operations={operations}
              jobLinkCounts={jobLinkCountsFor(focusedJob.id)}
              supabase={supabase}
              onClose={() => setModelsOpen(false)}
              onApplied={async () => { refresh() }}
            />
          </div>
        </>
      )}
    </>
  )
}
