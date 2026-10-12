'use client'

import { Fragment, useState } from 'react'
import { fmtMinutes, plural } from '@/lib/format'
import { historyLabel, jobCompleteness } from '@/lib/operationTimes'
import { jobRollup, untimedCount, type JobNode, type LineNode, type Rollup } from './breakdownTree'

/**
 * /model-total's breakdown, in the shape of the structure: Team → Section → Job → Operation.
 *
 * The visual language is /config → Sections' and nothing else — the same .sections-card and
 * .sections-table (sticky header, bookended section rows, centred count columns), the same
 * .sec-group team rows, the same .lc-icon-btn ▸/▾ on a row that opens. What differs is what the
 * columns count: there, what a section HOLDS; here, how much of it is TIMED for one model.
 *
 * One table per production line, every one on the same fixed column widths (.mt-tree), so the
 * figures sit at the same x from the first card to the last and from a team row down to a job.
 *
 * Coverage states use the app's existing three: red = nothing timed, amber = partly, green =
 * fully (.badge-red / -amber / -green; --red on an untimed 0m, as before). The state itself is
 * lib/operationTimes' jobCompleteness — the same rule the printed sheets and the Labour Matrix
 * mark by.
 */

/** Reads on the X button's tooltip and heads its confirmation. */
export const UNLINK_LABEL = 'Doesn’t apply to this model'

const LINK: React.CSSProperties = { background: 'none', border: 'none', padding: '2px 5px', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--blue)', cursor: 'pointer' }
const MUTED: React.CSSProperties = { color: 'var(--text-muted)' }

const HEAD_HINTS = {
  jobs: 'Jobs with at least one timed operation, of the jobs that apply to this model',
  ops: 'Operations with a current recorded time, of the operations that apply to this model',
  untimed: 'Operations that apply to this model and have no recorded time yet',
  mins: 'The sum of each timed operation’s current recorded time',
}

export function CoverageBadge({ timedOps, totalOps }: { timedOps: number; totalOps: number }) {
  const state = jobCompleteness(timedOps, totalOps)
  if (state === 'none') return <span className="badge badge-red">Not timed</span>
  if (state === 'partial') return <span className="badge badge-amber">Partly timed</span>
  return <span className="badge badge-green">Timed</span>
}

/** The four figure cells every team, section and job row shares — one definition, so the three
 * levels cannot format the same number three ways. `jobs` is omitted on a job row. */
function FigureCells({ r, showJobs, className = '' }: { r: Rollup; showJobs: boolean; className?: string }) {
  const untimed = untimedCount(r)
  const cls = `sec-num ${className}`
  return (
    <>
      <td className={cls}>{showJobs ? `${r.jobsCovered} / ${r.jobCount}` : ''}</td>
      <td className={cls}>{r.timedOps} / {r.totalOps}</td>
      <td className={cls}>
        {untimed > 0
          ? <strong className="mt-untimed">{untimed}</strong>
          : <span style={MUTED}>0</span>}
      </td>
      <td className={cls}>
        <strong style={{ color: r.timedOps === 0 ? 'var(--red)' : 'var(--blue)' }}>{fmtMinutes(r.minutes)}m</strong>
      </td>
    </>
  )
}

export default function BreakdownTable({
  lines, showLineHeadings, modelName, total, totalLabel, collapsedSections, onToggleSection, expandedJobs, onToggleJob,
  operatorLabelFor, copiedSourceByOperation, onAddTime, onEditTimes, onUnlinkJob, onUnlinkOperation,
}: {
  lines: LineNode[]
  showLineHeadings: boolean
  modelName: string
  /** The whole breakdown's figures — the sum of the lines above it; must equal the headline. */
  total: Rollup
  totalLabel: React.ReactNode
  /** Sections are OPEN unless listed here — the point of the screen is to see the gaps. */
  collapsedSections: Set<string>
  onToggleSection: (key: string) => void
  expandedJobs: Set<string>
  onToggleJob: (jobId: string) => void
  operatorLabelFor: (operatorIds: string[]) => string
  copiedSourceByOperation: Record<string, string>
  onAddTime: (jobId: string, jobName: string, operationId?: string) => void
  onEditTimes: (operationId: string, operationName: string) => void
  onUnlinkJob: (jobId: string, jobName: string) => void
  onUnlinkOperation: (jobId: string, jobName: string, operationId: string, operationName: string) => void
}) {
  return (
    <>
      {lines.map((line) => (
        <div key={line.key} style={{ marginBottom: 16 }}>
          {showLineHeadings && <LineHeading line={line} />}
          {/* No overflow on the card: the header row is sticky against the PAGE (see /config). */}
          <div className="card sections-card">
            <table className="data-table sections-table mt-tree">
              <colgroup>
                <col /><col className="mt-c-jobs" /><col className="mt-c-ops" /><col className="mt-c-untimed" />
                <col className="mt-c-mins" /><col className="mt-c-state" /><col className="mt-c-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th className="sec-name">Team · section · job</th>
                  <th className="sec-num" title={HEAD_HINTS.jobs}>Jobs timed</th>
                  <th className="sec-num" title={HEAD_HINTS.ops}>Ops timed</th>
                  <th className="sec-num" title={HEAD_HINTS.untimed}>Untimed</th>
                  <th className="sec-num" title={HEAD_HINTS.mins}>Mins</th>
                  <th className="sec-num">Status</th>
                  <th className="sec-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {line.teams.map((team) => (
                  <Fragment key={team.key}>
                    <tr>
                      <td className="sec-group mt-team-name" title={team.name}>
                        {team.name} · {plural(team.sectionCount, 'section')}
                      </td>
                      <FigureCells r={team} showJobs className="sec-group" />
                      <td className="sec-num sec-group"><CoverageBadge timedOps={team.timedOps} totalOps={team.totalOps} /></td>
                      <td className="sec-group" />
                    </tr>
                    {team.sections.map((section) => {
                      const sectionKey = `${line.key}|${section.key}`
                      const isOpen = !collapsedSections.has(sectionKey)
                      const state = jobCompleteness(section.timedOps, section.totalOps)
                      return (
                        <Fragment key={section.key}>
                          <tr className={`mt-section mt-state-${state}`}>
                            <td
                              className="primary sec-name" style={{ cursor: 'pointer', userSelect: 'none' }}
                              title={`${section.name} — ${isOpen ? 'hide' : 'show'} its jobs`}
                              onClick={() => onToggleSection(sectionKey)}
                            >
                              <button
                                type="button" className="lc-icon-btn" aria-expanded={isOpen}
                                aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${section.name}`}
                                style={{ marginRight: 6, verticalAlign: 'middle' }}
                                onClick={(e) => { e.stopPropagation(); onToggleSection(sectionKey) }}
                              >
                                {isOpen ? '▾' : '▸'}
                              </button>
                              {section.name}
                              {section.tray && <span className="badge badge-grey" style={{ marginLeft: 8 }}>Unsorted tray</span>}
                            </td>
                            <FigureCells r={section} showJobs />
                            <td className="sec-num"><CoverageBadge timedOps={section.timedOps} totalOps={section.totalOps} /></td>
                            <td className="sec-actions" />
                          </tr>
                          {isOpen && section.jobs.map((job) => (
                            <JobRows
                              key={job.jobId} job={job} modelName={modelName}
                              open={expandedJobs.has(job.jobId)} onToggle={() => onToggleJob(job.jobId)}
                              operatorLabel={operatorLabelFor(job.operatorIds)}
                              copiedSourceByOperation={copiedSourceByOperation}
                              onAddTime={onAddTime} onEditTimes={onEditTimes}
                              onUnlinkJob={onUnlinkJob} onUnlinkOperation={onUnlinkOperation}
                            />
                          ))}
                        </Fragment>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {/* Same columns again, so the totals sit under the figures they add up. */}
      <div className="card sections-card">
        <table className="data-table sections-table mt-tree">
          <colgroup>
            <col /><col className="mt-c-jobs" /><col className="mt-c-ops" /><col className="mt-c-untimed" />
            <col className="mt-c-mins" /><col className="mt-c-state" /><col className="mt-c-actions" />
          </colgroup>
          <tbody>
            <tr className="mt-grand">
              <td className="mt-name">{totalLabel}</td>
              <FigureCells r={total} showJobs />
              <td className="sec-num"><CoverageBadge timedOps={total.timedOps} totalOps={total.totalOps} /></td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </>
  )
}

/** A job's row and, when open, its operations — one keyed unit, so opening a job never remounts
 * its neighbours. */
function JobRows({
  job, modelName, open, onToggle, operatorLabel, copiedSourceByOperation,
  onAddTime, onEditTimes, onUnlinkJob, onUnlinkOperation,
}: {
  job: JobNode
  modelName: string
  open: boolean
  onToggle: () => void
  operatorLabel: string
  copiedSourceByOperation: Record<string, string>
  onAddTime: (jobId: string, jobName: string, operationId?: string) => void
  onEditTimes: (operationId: string, operationName: string) => void
  onUnlinkJob: (jobId: string, jobName: string) => void
  onUnlinkOperation: (jobId: string, jobName: string, operationId: string, operationName: string) => void
}) {
  return (
    <>
      <tr className="mt-job">
        <td
          className="mt-name mt-job-name" style={{ cursor: 'pointer', userSelect: 'none' }}
          title={`${job.jobName}${operatorLabel ? ` — ${operatorLabel}` : ''} — ${open ? 'hide' : 'show'} its operations`}
          onClick={onToggle}
        >
          <button
            type="button" className="lc-icon-btn" aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${job.jobName}`}
            style={{ marginRight: 6, verticalAlign: 'middle' }}
            onClick={(e) => { e.stopPropagation(); onToggle() }}
          >
            {open ? '▾' : '▸'}
          </button>
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{job.jobName}</span>
          {operatorLabel && <span style={{ ...MUTED, fontSize: 12, fontStyle: 'italic', marginLeft: 8 }}>{operatorLabel}</span>}
        </td>
        <FigureCells r={jobRollup(job)} showJobs={false} />
        <td className="sec-num"><CoverageBadge timedOps={job.timedOps} totalOps={job.totalOps} /></td>
        <td className="sec-actions">
          {job.missing.length > 0 && (
            <button type="button" style={LINK} onClick={() => onAddTime(job.jobId, job.jobName)}>Add Time</button>
          )}
          <UnlinkButton
            onUnlink={() => onUnlinkJob(job.jobId, job.jobName)}
            title={`${UNLINK_LABEL} — remove ${job.jobName} from ${modelName}. The job, its operations and every recorded time are kept.`}
          />
        </td>
      </tr>
      {/* A timed row drills into its records; the whole row is the target. */}
      {open && job.rows.map((r) => (
        <tr
          key={r.operationId} className="mt-op" style={{ cursor: 'pointer' }}
          title={`Current time for this model — ${historyLabel({ minutes: r.minutes, currentId: '', archived: r.archived })}. Open to edit or promote an earlier record.`}
          onClick={() => onEditTimes(r.operationId, r.operationName)}
        >
          <td className="mt-name mt-op-name">
            {r.operationName}
            {copiedSourceByOperation[r.operationId] && (
              <span
                className="mt-copied"
                title={`Copied from ${copiedSourceByOperation[r.operationId]} — this figure was copied from another model, not measured on this one.`}
              >
                copied
              </span>
            )}
          </td>
          <td /><td /><td />
          <td className="sec-num">{fmtMinutes(r.minutes)}m</td>
          <td className="sec-num" style={{ ...MUTED, fontSize: 12 }}>{r.archived === 0 ? 'current' : `current · +${r.archived}`}</td>
          <td className="sec-actions">
            <button type="button" style={LINK} onClick={(e) => { e.stopPropagation(); onEditTimes(r.operationId, r.operationName) }}>Edit times</button>
            <UnlinkButton
              onUnlink={() => onUnlinkOperation(job.jobId, job.jobName, r.operationId, r.operationName)}
              title={`${UNLINK_LABEL} — remove ${r.operationName} from ${modelName}. Its recorded times are kept, they just stop counting for this model.`}
            />
          </td>
        </tr>
      ))}
      {open && job.missing.map((m) => (
        <tr key={m.operationId} className="mt-op mt-op-untimed">
          <td className="mt-name mt-op-name" title={m.operationName}>{m.operationName}</td>
          <td /><td /><td />
          <td className="sec-num" style={MUTED}>—</td>
          <td className="sec-num"><span className="mt-untimed" style={{ fontSize: 12 }}>not timed</span></td>
          <td className="sec-actions">
            <button type="button" style={LINK} onClick={() => onAddTime(job.jobId, job.jobName, m.operationId)}>Add Time</button>
            <UnlinkButton
              onUnlink={() => onUnlinkOperation(job.jobId, job.jobName, m.operationId, m.operationName)}
              title={`${UNLINK_LABEL} — remove ${m.operationName} from ${modelName}. The operation itself is not deleted.`}
            />
          </td>
        </tr>
      ))}
    </>
  )
}

/**
 * "Not yet timed", as a work plan: every operation that applies to the model and has no recorded
 * time, under its team, section and job. `lines` is the breakdown tree narrowed to the jobs
 * with a gap, so each count here is that level's untimed operations and nothing else.
 */
export function NotYetTimedTable({
  lines, showLineHeadings, onAddTime,
}: {
  lines: LineNode[]
  showLineHeadings: boolean
  onAddTime: (jobId: string, jobName: string, operationId?: string) => void
}) {
  return (
    <>
      {lines.map((line) => (
        <div key={line.key} style={{ marginBottom: 16 }}>
          {showLineHeadings && <LineHeading line={line} gapsOnly />}
          <div className="card sections-card">
            <table className="data-table sections-table mt-tree mt-gaps">
              <colgroup><col /><col className="mt-c-count" /><col className="mt-c-actions" /></colgroup>
              <thead>
                <tr>
                  <th className="sec-name">Team · section · job · operation</th>
                  <th className="sec-num">Untimed operations</th>
                  <th className="sec-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {line.teams.map((team) => (
                  <Fragment key={team.key}>
                    <tr>
                      <td className="sec-group mt-team-name">{team.name} · {plural(team.sectionCount, 'section')}</td>
                      <td className="sec-num sec-group"><strong className="mt-untimed">{untimedCount(team)}</strong></td>
                      <td className="sec-group" />
                    </tr>
                    {team.sections.map((section) => (
                      <Fragment key={section.key}>
                        <tr className="mt-section">
                          <td className="primary sec-name" title={section.name}>
                            {section.name}
                            {section.tray && <span className="badge badge-grey" style={{ marginLeft: 8 }}>Unsorted tray</span>}
                            <span style={{ ...MUTED, fontWeight: 400, fontSize: 12, marginLeft: 8 }}>{plural(section.jobs.length, 'job')}</span>
                          </td>
                          <td className="sec-num"><strong className="mt-untimed">{untimedCount(section)}</strong></td>
                          <td className="sec-actions" />
                        </tr>
                        {section.jobs.map((job) => (
                          <Fragment key={job.jobId}>
                            <tr className="mt-job">
                              <td className="mt-name mt-job-name" title={job.jobName}>
                                <span style={{ fontWeight: 600, color: 'var(--text)' }}>{job.jobName}</span>
                                {job.timedOps === 0 && <span style={{ ...MUTED, fontSize: 12, marginLeft: 8 }}>nothing timed</span>}
                              </td>
                              <td className="sec-num">{job.missing.length} of {job.totalOps}</td>
                              <td className="sec-actions">
                                <button type="button" style={LINK} onClick={() => onAddTime(job.jobId, job.jobName)}>Add Time</button>
                              </td>
                            </tr>
                            {job.missing.map((m) => (
                              <tr key={m.operationId} className="mt-op">
                                <td className="mt-name mt-op-name" title={m.operationName}>{m.operationName}</td>
                                <td />
                                <td className="sec-actions">
                                  <button type="button" style={LINK} onClick={() => onAddTime(job.jobId, job.jobName, m.operationId)}>Add Time</button>
                                </td>
                              </tr>
                            ))}
                          </Fragment>
                        ))}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  )
}

/** The production line above its table — a rule with the name on the left and the line's
 * figures on the right, not a card of its own. */
function LineHeading({ line, gapsOnly = false }: { line: LineNode; gapsOnly?: boolean }) {
  return (
    <div className="labour-line-head" style={{ marginBottom: 8 }}>
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-mid)' }}>
        {line.lineName}
      </span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
        {gapsOnly
          ? <>{plural(untimedCount(line), 'operation')} to time in {plural(line.jobCount, 'job')}</>
          : <>{plural(line.jobCount, 'job')} · {untimedCount(line)} untimed · <strong style={{ color: 'var(--blue)' }}>{fmtMinutes(line.minutes)}m</strong></>}
      </span>
    </div>
  )
}

/**
 * The unlink X — "Doesn't apply to this model".
 *
 * Muted until hovered, then red: the colour arrives on intent rather than sitting on the row,
 * because a breakdown with twenty operations would otherwise read as twenty warnings. It is
 * still not a delete — nothing is destroyed, and the confirmation it opens is what says so.
 *
 * stopPropagation because the rows around it are themselves clickable.
 */
function UnlinkButton({ onUnlink, title }: { onUnlink: () => void; title: string }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => { e.stopPropagation(); onUnlink() }}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 6, border: '1px solid transparent', padding: 0, cursor: 'pointer', verticalAlign: 'middle',
        background: hover ? 'var(--red-bg)' : 'none',
        color: hover ? 'var(--red)' : 'var(--text-muted)',
        transition: 'color 0.12s, background 0.12s',
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  )
}
