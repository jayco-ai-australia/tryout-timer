'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fmtMinutes, plural } from '@/lib/format'
import { usePageSetup } from '@/lib/usePageSetup'
import {
  fetchStructureReview, fmtAddedDate,
  type ReviewJob, type ReviewSection, type StructureReview,
} from '@/lib/structureReview'
import type { ProductionLine } from '@/lib/types'

/**
 * /structure-review — the document generator. Three controls and the document; nothing else.
 *
 * One document, two media: the markup below is what prints. print.css styles the sheets the same
 * way on screen, and in print only takes away the shell, the controls and the on-screen page
 * gaps — so what is checked on screen is what goes onto the floor.
 */

/** The paper, plus the running footer. Built per area/date because the footer's text has to be in
 * the @page rule itself — CSS margin boxes can't read the document. Pinned through usePageSetup so
 * another route's @page, left behind by client-side navigation, can't re-paper this one. Margin
 * boxes print in Chromium; Safari ignores them and prints without the footer. */
function pageCss(footer: string): string {
  const text = footer.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `@page { size: A4 portrait; margin: 12mm 12mm 14mm;
  @bottom-left { content: "${text}"; font: 7.5pt system-ui, sans-serif; color: #555; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7.5pt system-ui, sans-serif; color: #555; } }`
}

const KMD = ['K', 'M', 'D'] as const

export default function StructureReviewClient({ lines, initialLineId, initialTeamId }: {
  lines: ProductionLine[]
  initialLineId: string
  initialTeamId: string
}) {
  const supabase = useMemo(() => createClient(), [])
  const [lineId, setLineId] = useState(lines.some((l) => l.id === initialLineId) ? initialLineId : '')
  const [teamId, setTeamId] = useState(initialTeamId)
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([])
  const [review, setReview] = useState<StructureReview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Set after mount: a date evaluated during render would differ between server and client. */
  const [today, setToday] = useState('')
  useEffect(() => {
    setToday(new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }))
  }, [])

  const line = lines.find((l) => l.id === lineId) ?? null
  const team = teams.find((t) => t.id === teamId) ?? null
  const areaName = line ? (team ? `${line.name} — ${team.name}` : line.name) : ''

  // The scope lives in the URL so a review can be bookmarked or linked. replaceState rather than
  // the router: nothing on the server needs to re-render for a filter change.
  useEffect(() => {
    const params = new URLSearchParams()
    if (lineId) params.set('line', lineId)
    if (lineId && teamId) params.set('team', teamId)
    const qs = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
  }, [lineId, teamId])

  useEffect(() => {
    setTeams([])
    if (!lineId) return
    let cancelled = false
    supabase.from('teams').select('id, name').eq('production_line_id', lineId).order('name')
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) { setError(err.message); return }
        const rows = (data ?? []) as { id: string; name: string }[]
        setTeams(rows)
        // A linked team that isn't on this line falls back to all teams rather than an empty document.
        setTeamId((current) => (current && !rows.some((t) => t.id === current) ? '' : current))
      })
    return () => { cancelled = true }
  }, [supabase, lineId])

  useEffect(() => {
    setReview(null)
    setError(null)
    if (!lineId) return
    let cancelled = false
    setLoading(true)
    fetchStructureReview(supabase, lineId, teamId || null)
      .then((r) => { if (!cancelled) setReview(r) })
      .catch((err) => {
        if (cancelled) return
        console.error('[structure-review] load failed:', err)
        setError(err instanceof Error ? err.message : 'Could not build the review')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [supabase, lineId, teamId])

  const pinPageSetup = usePageSetup(pageCss(areaName ? `${areaName} · Structure Review · ${today}` : 'Structure Review'))
  function handlePrint() {
    pinPageSetup()
    window.print()
  }

  return (
    <main className="page-wide rp-page">
      <div className="rp-screen-only sr-controls">
        <div>
          <label className="label">Production line</label>
          <select className="select" value={lineId} onChange={(e) => { setLineId(e.target.value); setTeamId('') }}>
            <option value="">— Select —</option>
            {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Team</label>
          <select className="select" value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={!lineId}>
            <option value="">All teams</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <button type="button" className="btn-primary" disabled={!review} onClick={handlePrint}>Print</button>
      </div>

      {error && <p className="rp-screen-only sr-message sr-error">{error}</p>}
      {!lineId && <p className="rp-screen-only sr-message">Pick a production line to build its structure review.</p>}
      {lineId && !review && !error && <p className="rp-screen-only sr-message">{loading ? 'Building the review…' : ''}</p>}

      {review && line && (
        <div className="sr-doc">
          <Cover review={review} areaName={areaName} today={today} />
          <Contents review={review} />
          {review.teams.flatMap((t) => t.sections).map((s) => <SectionSheet key={s.id} section={s} />)}
        </div>
      )}
    </main>
  )
}

function Cover({ review, areaName, today }: { review: StructureReview; areaName: string; today: string }) {
  const s = review.summary
  const figures: [string, string, boolean][] = [
    ['Sections', String(s.sections), false],
    ['Jobs', String(s.jobs), false],
    ['Operations', String(s.operations), false],
    ['Minutes recorded', s.minutes.toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }), false],
    ['Jobs with no operations', String(s.jobsWithNoOperations), s.jobsWithNoOperations > 0],
    ['Operations with no time', String(s.operationsWithNoTime), s.operationsWithNoTime > 0],
    ['Operations linked to no model', String(s.operationsWithNoModel), s.operationsWithNoModel > 0],
    ['Teams', String(s.teams), false],
  ]
  return (
    <section className="sr-sheet sr-cover">
      <p className="sr-kicker">Structure Review</p>
      <h1 className="sr-title">{areaName}</h1>
      <p className="sr-date">{today}</p>

      <div className="sr-figures">
        {figures.map(([label, value, flag]) => (
          <div key={label} className="sr-figure">
            <div className={'sr-figure-value' + (flag ? ' sr-flag-text' : '')}>{value}</div>
            <div className="sr-figure-label">{label}</div>
          </div>
        ))}
      </div>

      <div className="sr-howto">
        <h2>How to use this</h2>
        <ul>
          <li>Every section starts on a new page.</li>
          <li>A job shaded <span className="sr-flag-swatch">amber</span> with <em>no operations</em> has nothing to record time against. Decide: add operations, or delete the job.</li>
          <li>Operations in <span className="sr-flag-swatch">amber</span> have no time recorded.</li>
          <li>A red <span className="sr-zero">0</span> in Models means the operation is linked to no model at all, so it can never show as a gap.</li>
          <li>Tick <strong>K</strong> keep, <strong>M</strong> merge, <strong>D</strong> delete. Write the merge target in Notes.</li>
          <li><strong>Times</strong> is how many separate recordings exist; <strong>Avg</strong> is their average. The app&rsquo;s own totals use each operation&rsquo;s current recording, so Avg can differ from Model Total.</li>
          <li><strong>Added</strong> is the date the operation was created — useful for spotting one-off entries made during a van walk.</li>
        </ul>
      </div>
    </section>
  )
}

function jobFlag(job: ReviewJob) {
  if (job.operations.length === 0) return <em className="sr-flag-text">no operations</em>
  if (job.untimed > 0) return <span className="sr-flag-text">{job.untimed} untimed</span>
  return null
}

function sectionRollup(section: ReviewSection): string {
  return `${plural(section.jobs.length, 'job')} · ${plural(section.operationCount, 'op')} · ${fmtMinutes(section.totalMinutes)} min`
}

function Contents({ review }: { review: StructureReview }) {
  return (
    <section className="sr-sheet sr-contents">
      <h2 className="sr-h2">Contents</h2>
      <table className="sr-table">
        <colgroup>
          <col style={{ width: '13%' }} /><col style={{ width: '5%' }} /><col style={{ width: '22%' }} />
          <col style={{ width: '26%' }} /><col style={{ width: '11%' }} /><col style={{ width: '9%' }} />
          <col style={{ width: '14%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Team</th><th className="sr-num">Ord</th><th>Section</th><th>Job</th>
            <th className="sr-num">Operations</th><th className="sr-num">Minutes</th><th>Flag</th>
          </tr>
        </thead>
        {review.teams.map((team) => {
          const teamRows = team.sections.reduce((n, s) => n + Math.max(1, s.jobs.length), 0)
          // One tbody per team, so a team's rowspan never has to cross into another's group.
          return (
            <tbody key={team.key} className="sr-team-group">
              {team.sections.map((section, si) => {
                const rows = section.jobs.length > 0 ? section.jobs : [null]
                return rows.map((job, ji) => (
                  <tr key={`${section.id}:${job?.id ?? 'none'}`}>
                    {si === 0 && ji === 0 && <td rowSpan={teamRows} className="sr-span sr-team-cell">{team.name}</td>}
                    {ji === 0 && <td rowSpan={rows.length} className="sr-span sr-num">{section.sortOrder ?? '—'}</td>}
                    {ji === 0 && (
                      <td rowSpan={rows.length} className="sr-span">
                        <strong>{section.name}</strong>
                        <div className="sr-rollup">{sectionRollup(section)}</div>
                      </td>
                    )}
                    {job ? (
                      <>
                        <td className="sr-job-cell">{job.name}</td>
                        <td className="sr-num">{job.operations.length}</td>
                        <td className="sr-num">{fmtMinutes(job.totalMinutes)}</td>
                        <td>{jobFlag(job)}</td>
                      </>
                    ) : (
                      <>
                        <td className="sr-job-cell sr-muted">—</td><td /><td /><td><em className="sr-flag-text">no jobs</em></td>
                      </>
                    )}
                  </tr>
                ))
              })}
            </tbody>
          )
        })}
      </table>
    </section>
  )
}

function SectionSheet({ section }: { section: ReviewSection }) {
  return (
    <section className="sr-sheet sr-section">
      <header className="sr-section-head">
        <h2 className="sr-h2">{section.name}</h2>
        <p className="sr-meta">
          {section.teamName} · Ord {section.sortOrder ?? '—'} · {plural(section.jobs.length, 'job')} ·{' '}
          {plural(section.operationCount, 'operation')} · {fmtMinutes(section.totalMinutes)} min
        </p>
      </header>
      {section.jobs.length === 0 && <p className="sr-meta"><em className="sr-flag-text">No jobs in this section.</em></p>}
      {section.jobs.map((job) => <JobBlock key={job.id} job={job} />)}
    </section>
  )
}

function Boxes({ only }: { only?: readonly string[] }) {
  return (
    <span className="sr-boxes">
      {KMD.map((k) => (
        <span key={k} className="sr-box-slot">
          {(!only || only.includes(k)) && <><span className="sr-box" aria-hidden /><span className="sr-box-key">{k}</span></>}
        </span>
      ))}
    </span>
  )
}

function JobBlock({ job }: { job: ReviewJob }) {
  const empty = job.operations.length === 0
  return (
    <div className="sr-job">
      <h3 className={'sr-h3' + (empty ? ' sr-flag-row' : '')}>
        {job.name}
        <span className="sr-job-meta">
          {plural(job.operations.length, 'operation')} · {fmtMinutes(job.totalMinutes)} min
          {job.untimed > 0 && <> · <span className="sr-flag-text">{job.untimed} untimed</span></>}
        </span>
      </h3>
      <table className="sr-table sr-ops">
        <colgroup>
          <col style={{ width: '28%' }} /><col style={{ width: '8%' }} /><col style={{ width: '6%' }} />
          <col style={{ width: '8%' }} /><col style={{ width: '8%' }} /><col style={{ width: '8%' }} />
          <col style={{ width: '10%' }} /><col style={{ width: '24%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Operation</th><th>Added</th><th className="sr-num">Times</th><th className="sr-num">Total min</th>
            <th className="sr-num">Avg min</th><th className="sr-num">Models</th><th className="sr-center">K / M / D</th><th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {empty ? (
            <tr className="sr-flag-row">
              <td colSpan={6}><em>No operations — nothing can be timed against this job.</em></td>
              <td className="sr-center"><Boxes only={['K', 'D']} /></td>
              <td className="sr-notes" />
            </tr>
          ) : job.operations.map((op) => (
            <tr key={op.id} className={op.times === 0 ? 'sr-flag-row' : undefined}>
              <td>{op.name}</td>
              <td>{fmtAddedDate(op.createdAt)}</td>
              <td className="sr-num">{op.times}</td>
              <td className="sr-num">{op.times > 0 ? fmtMinutes(op.totalMinutes) : '—'}</td>
              <td className="sr-num">{op.avgMinutes != null ? fmtMinutes(op.avgMinutes) : '—'}</td>
              <td className={'sr-num' + (op.models === 0 ? ' sr-zero' : '')}>{op.models}</td>
              <td className="sr-center"><Boxes /></td>
              <td className="sr-notes" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
