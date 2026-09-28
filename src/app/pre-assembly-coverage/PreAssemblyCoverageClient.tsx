'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fmtScheduleDate } from '@/lib/schedule'
import { plural } from '@/lib/format'
import {
  fetchPreAssemblyCoverage,
  type AreaReport, type PreAssemblyCoverageReport, type SeriesRow,
} from '@/lib/preAssemblyCoverage'

/**
 * /pre-assembly-coverage — the report, rendered once.
 *
 * Every figure on this page comes from lib/preAssemblyCoverage, which is where the denominator,
 * the coverage rule and the per-area scoping live. This file renders; it derives nothing except
 * how a list of missing models is shortened to fit a column.
 *
 * ── One document, two media ───────────────────────────────────────────────────────────────
 * There is no hidden print-only copy of this report. The markup below IS what prints; the print
 * stylesheet takes away the nav and the Print button, flattens the colours and starts each area
 * on a fresh A4 sheet. That is a deliberate departure from /reports and /model-total, which each
 * render a second, separate block for print — the pattern that lets a print header describe a
 * different scope than the rows beneath it. Here the header, the schedule window and the numbers
 * are the same nodes in both media, so they cannot disagree.
 */

/** How many missing models a cell prints before it summarises the rest. Six fits the column at
 * 9pt on A4 portrait without wrapping past two lines. */
const MISSING_SHOWN = 6

/**
 * There is deliberately no per-model marker on the missing list any more.
 *
 * An earlier version suffixed a "°" to every missing model that had no applicable job in its
 * area, with a footnote explaining it. The distinction it drew is real and still reported (see
 * the per-area footnote below, which counts them) — but against the live data it applied to 302
 * of 302 missing models, so as a per-name marker it separated nothing and simply appended a
 * stray character to every model code on the page. A count in one sentence says the same thing
 * without touching the names.
 */

export default function PreAssemblyCoverageClient() {
  const supabase = useMemo(() => createClient(), [])

  /**
   * Which area is on screen — and therefore which area prints. '' = every area.
   *
   * Session state, deliberately: not usePersistedFilter, not a URL param, not a column. A
   * remembered single-area filter would hand the next person a report that looks complete and
   * silently isn't, and this page exists to be printed and handed on.
   *
   * The filter is applied to the ONE document the page renders, so print inherits it for free —
   * there is no separate print block to keep in step (see the note above), and the header states
   * the narrowing so a single-area sheet cannot be mistaken for the whole report.
   */
  const [areaFilter, setAreaFilter] = useState('')

  const [report, setReport] = useState<PreAssemblyCoverageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchPreAssemblyCoverage(supabase)
      .then((r) => { if (!cancelled) setReport(r) })
      .catch((err) => {
        if (cancelled) return
        console.error('[pre-assembly-coverage] load failed:', err)
        setError(err instanceof Error ? err.message : 'Could not build the report')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [supabase])

  const visibleAreas = useMemo(
    () => (report ? report.areas.filter((a) => !areaFilter || a.lineId === areaFilter) : []),
    [report, areaFilter]
  )
  /** The selected area's name, for the header. Null while showing everything. */
  const selectedAreaName = useMemo(
    () => report?.areas.find((a) => a.lineId === areaFilter)?.name ?? null,
    [report, areaFilter]
  )
  // A filter pointing at an area the report no longer contains would render an empty document
  // with nothing on screen to say why.
  useEffect(() => {
    if (areaFilter && report && !report.areas.some((a) => a.lineId === areaFilter)) setAreaFilter('')
  }, [report, areaFilter])

  /**
   * Stamped when Print is pressed rather than at render: this component server-renders too, and
   * a date evaluated during render would differ between the server and client markup. Same rule
   * as /model-total's collection sheet.
   */
  const [printedAt, setPrintedAt] = useState<string | null>(null)
  function handlePrint() {
    setPrintedAt(new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }))
    // Two frames so the stamp is painted before the print dialog snapshots the page.
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()))
  }

  /** The schedule window, as one phrase. Used by the document header AND by every area's running
   * head, so a sheet printed on its own still says what window it was drawn from. */
  const windowLabel = useMemo(() => {
    if (!report) return ''
    const { earliest, latest } = report.window
    if (!earliest || !latest) return 'no builds scheduled'
    if (earliest === latest) return fmtScheduleDate(earliest)
    return `${fmtScheduleDate(earliest)} – ${fmtScheduleDate(latest)}`
  }, [report])

  return (
    <main className="page-wide pac-page rp-page">
      <div className="pac-screen-only rp-screen-only pac-controls">
        <span className="pac-controls-label">Area</span>
        <button
          type="button"
          aria-pressed={!areaFilter}
          className={'pac-chip' + (!areaFilter ? ' pac-chip-on' : '')}
          onClick={() => setAreaFilter('')}
        >
          All areas
        </button>
        {/* Every pre-assembly area, alphabetical — the order lib/lines returns them in, and the
            order they print in, so the chips read as the document's contents page. */}
        {(report?.areas ?? []).map((a) => (
          <button
            key={a.lineId}
            type="button"
            aria-pressed={areaFilter === a.lineId}
            className={'pac-chip' + (areaFilter === a.lineId ? ' pac-chip-on' : '')}
            onClick={() => setAreaFilter(a.lineId)}
          >
            {a.name}
          </button>
        ))}
        <button
          type="button"
          className="btn-ghost"
          style={{ marginLeft: 'auto' }}
          disabled={!report}
          title={
            !report ? 'Still loading'
              : selectedAreaName ? `Print the ${selectedAreaName} sheet`
                : 'Print one A4 sheet per pre-assembly area'
          }
          onClick={handlePrint}
        >
          Print report
        </button>
      </div>

      {error && (
        <p className="pac-screen-only rp-screen-only" style={{ margin: '0 0 20px', padding: '9px 12px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 12 }}>
          {error}
        </p>
      )}

      {!report ? (
        <p className="pac-screen-only rp-screen-only" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '40px 0' }}>
          {loading ? 'Building the report…' : 'No report'}
        </p>
      ) : (
        <div className="pac-doc rp-doc">
          {/* ── Document header ────────────────────────────────────────────────────────
              Screen and print read the identical nodes. The schedule window is stated here
              because it is the denominator of every figure below it — a coverage figure with
              no window is not checkable. */}
          <header className="pac-head rp-head">
            <h1 className="pac-head-title">Pre-Assembly Coverage</h1>
            <p className="pac-head-meta">
              Schedule window <strong>{windowLabel}</strong> ·{' '}
              <strong>{plural(report.scheduledModels, 'scheduled model')}</strong> across{' '}
              {/* "chassis" is its own plural — plural() would render "chassiss". */}
              {report.window.matchedRows} booked chassis
              {/* The filter, stated on the document itself. A single-area sheet that didn't say
                  so would read as the whole report with five areas missing. */}
              {selectedAreaName && <> · <strong>{selectedAreaName} only</strong></>}
            </p>
            {/* The exclusion, stated with the denominator it qualifies rather than only in the
                small print at the foot of each sheet. */}
            {report.window.unmatchedRows > 0 && (
              <p className="pac-head-meta pac-head-exclusion">
                {report.window.unmatchedRows} further scheduled chassis could not be matched to a
                model and are excluded from every figure below.
              </p>
            )}
            <p className="pac-head-meta">
              Coverage is job × model: a job counts as timed for a model when any of its operations
              has a recorded time for that model. Only jobs actually linked to a model count
              against it.
              {printedAt && <> · Printed {printedAt}</>}
            </p>
          </header>

          {visibleAreas.length === 0 ? (
            <p className="pac-foot rp-foot">No production line is marked as a pre-assembly area.</p>
          ) : (
            visibleAreas.map((area) => (
              <AreaSection
                key={area.lineId}
                area={area}
                windowLabel={windowLabel}
                unmatchedRows={report.window.unmatchedRows}
              />
            ))
          )}
        </div>
      )}
    </main>
  )
}

/** One area — one printed sheet. */
function AreaSection({ area, windowLabel, unmatchedRows }: {
  area: AreaReport
  windowLabel: string
  /** Scheduled chassis that resolve to no model. Repeated per area on purpose: the footnote has
   * to sit on the same sheet as the numbers it qualifies, and each area prints on its own. */
  unmatchedRows: number
}) {
  // The marker's meaning, kept as a count rather than as a symbol on every name: how many of
  // this area's missing models are missing because nothing links them to the area at all. That
  // is a Setup gap — fixed by linking the job to the model — not work waiting on a stopwatch,
  // and the two want different people.
  let missingTotal = 0
  let noApplicableTotal = 0
  for (const line of area.buildLines) {
    for (const row of line.series) {
      missingTotal += row.missingModels.length
      noApplicableTotal += row.noApplicableJobs.length
    }
  }

  return (
    <section className="pac-area rp-section">
      {/* Print-only running head: each area starts a new sheet, so this is what carries the
          report's identity and its schedule window onto pages 2, 3, 4… */}
      <p className="pac-runhead">Pre-Assembly Coverage · {windowLabel} · {area.name}</p>

      <div className="pac-area-head">
        <h2 className="pac-area-name">{area.name}</h2>
        <span className="pac-area-coverage">
          Coverage: {area.covered} of {area.scheduled} scheduled models
        </span>
      </div>

      {area.scheduled === 0 ? (
        <p className="pac-area-note">
          {area.buildLines.length === 0 && area.jobCount === 0
            ? 'No jobs are set up on this area, and it feeds no build line with a model booked in this window.'
            : 'No scheduled models — this area feeds no build line with a model booked in this window.'}
        </p>
      ) : (
        <>
          {!area.hasTimes && (
            <p className="pac-area-note">
              <strong>No times collected.</strong>{' '}
              {area.jobCount === 0
                ? 'No jobs are set up on this area yet, so there is nothing to record against.'
                : `${plural(area.jobCount, 'job')} set up on this area, none of them timed for any scheduled model.`}
            </p>
          )}

          {area.buildLines.map((line) => (
            <div key={line.lineId}>
              {/* Grouped by build line first, then by series within it — a model always sits
                  under the line that builds it, never under the area that feeds it. */}
              <p className="pac-line-name">
                {line.lineName} — {line.covered} of {line.scheduled} models
              </p>
              <table className="pac-table rp-table">
                <thead>
                  {/* One class per column: table-layout is fixed, and these carry the widths
                      (22/10/9/10/8/41). pac-num right-aligns the four figures. */}
                  <tr>
                    <th className="pac-col-series">Series</th>
                    <th className="pac-col-avg pac-num rp-num">Avg mins</th>
                    <th className="pac-col-covered pac-num rp-num">Covered</th>
                    <th className="pac-col-scheduled pac-num rp-num">Scheduled</th>
                    <th className="pac-col-partial pac-num rp-num">Partial</th>
                    <th className="pac-col-missing">Missing models</th>
                  </tr>
                </thead>
                <tbody>
                  {line.series.map((row) => (
                    <tr key={row.series}>
                      <td className="pac-series">{row.series}</td>
                      {/* One decimal place, always — a mean of measured minutes, and "412" would
                          read as a count rather than an average. Em dash where nothing in the
                          series is covered: there is no mean of an empty set, and 0.0 would
                          claim the work takes no time. */}
                      <td className="pac-num rp-num">{row.avgMinutes === null ? '—' : row.avgMinutes.toFixed(1)}</td>
                      <td className="pac-num rp-num">{row.covered}</td>
                      <td className="pac-num rp-num">{row.scheduled}</td>
                      <td className="pac-num rp-num">{row.partial}</td>
                      <td className={row.missingModels.length === 0 ? 'pac-missing pac-missing-none' : 'pac-missing'}>
                        {missingLabel(row)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}

      <p className="pac-foot rp-foot">
        {unmatchedRows > 0 && (
          <>
            {unmatchedRows} scheduled chassis could not be matched to a model and are excluded.
            <br />
          </>
        )}
        {noApplicableTotal > 0 && (
          <>
            {noApplicableTotal === missingTotal
              ? `None of the ${missingTotal} missing models has a job on this area linked to it yet`
              : `${noApplicableTotal} of the ${missingTotal} missing models have no job on this area linked to them yet`}
            {' '}— a Setup gap rather than untimed work, so they are not counted as partial.
            <br />
          </>
        )}
        Partial counts covered models where some, but not all, of their applicable jobs are timed.
        Avg mins is the mean total {area.name.toLowerCase()} minutes across covered models only.
      </p>
    </section>
  )
}

/**
 * The gap list for one row: up to MISSING_SHOWN models, then a count of the rest.
 *
 * The truncation is on the PRINTED list only — lib/preAssemblyCoverage returns every missing
 * model, so the "+N more" is a display decision and the number behind it is real.
 */
function missingLabel(row: SeriesRow): string {
  if (row.missingModels.length === 0) return 'None'
  const shown = row.missingModels.slice(0, MISSING_SHOWN)
  const rest = row.missingModels.length - shown.length
  const list = shown.join(', ')
  return rest > 0 ? `${list}, +${rest} more` : list
}
