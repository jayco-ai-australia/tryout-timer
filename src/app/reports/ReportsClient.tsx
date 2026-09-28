'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { selectIn } from '@/lib/chunkedIn'
import { logSupabaseError } from '@/lib/supabaseRead'
import { fetchSectionsForLine, teamForJob } from '@/lib/sections'
import { modelsForLine } from '@/lib/lines'
import { fetchOperators, operatorsForLine, type OperatorOption } from '@/lib/operators'
import { fmtDate, fmtHours, fmtMinutes, plural } from '@/lib/format'
import {
  describeDateRange, describeEmptyResult, describeFilters, EMPTY_FILTERS, fetchReportRows,
  NONE, REPORT_DATE_PRESETS, resolveReportWindow, summariseReport, UNATTACHED_LABEL, UNATTACHED_PRODUCT_ID,
  type ReportDatePreset, type ReportFilterLabels, type ReportFilters, type ReportRow,
} from '@/lib/reports'
import type { ProductionLine, Section } from '@/lib/types'

/**
 * /reports — a filter-driven list of individual time records, built to be printed and handed to
 * someone who doesn't have a login.
 *
 * The page is deliberately a LIST, not an analysis: one row per operation_times record, nothing
 * averaged, nothing rolled up. /model-total already answers "what is the labour content of this
 * model"; this answers "show me what was actually recorded", which is the question the removed
 * /records screen used to take and which nothing has answered since.
 *
 * All the joining and every chunk/page decision lives in lib/reports — this file resolves ids to
 * names for the pickers, and renders.
 */

interface Props {
  lines: ProductionLine[]
  /** profiles.production_line_id — the line the page opens on. Blank when the viewer has none.
   * Kept alongside `initialFilters` because Reset returns to THIS, not to the deep link: once
   * you've cleared a link's filters, "reset" meaning "put the link back" would be a trap. */
  defaultLineId: string
  /** Resolved from the query string server-side (lib/reports' reportFiltersFromParams), so a
   * deep-linked report renders already filtered rather than flashing the default view first. */
  initialFilters: ReportFilters
}

const SEL: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
  border: '1.5px solid var(--border)', borderRadius: 8, padding: '7px 10px',
  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', outline: 'none', minWidth: 170,
}
const DATE_INPUT: React.CSSProperties = { ...SEL, minWidth: 140, cursor: 'text' }
const LABEL: React.CSSProperties = {
  display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 5,
}
const EMPTY: React.CSSProperties = {
  textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '40px 20px',
}

/** The print stamp's format — date AND time, because two reports of the same scope printed
 * either side of a morning's collection are different documents. */
function stampNow(): string {
  return new Date().toLocaleString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

interface ProductOption { id: string; model: string }
interface TeamOption { id: string; name: string }
interface JobOption { id: string; name: string; section_id: string | null }
interface TryoutOption { id: string; chassisNumber: string; productionLineId: string | null }

/** The pickers, all scoped to the line in view. Loaded together so a line change swaps the whole
 * set in one pass rather than letting five lists arrive independently and briefly disagree. */
interface Options {
  products: ProductOption[]
  teams: TeamOption[]
  sections: Section[]
  jobs: JobOption[]
  operators: OperatorOption[]
  tryouts: TryoutOption[]
}
const NO_OPTIONS: Options = { products: [], teams: [], sections: [], jobs: [], operators: [], tryouts: [] }

export default function ReportsClient({ lines, defaultLineId, initialFilters }: Props) {
  const supabase = useMemo(() => createClient(), [])

  const [filters, setFilters] = useState<ReportFilters>(initialFilters)
  const [options, setOptions] = useState<Options>(NO_OPTIONS)
  const [optionsError, setOptionsError] = useState<string | null>(null)

  /**
   * "Now", stamped once after mount rather than read during render.
   *
   * Every date label on this page derives from it, and a date evaluated during render differs
   * between the server pass and the client pass — which React reports as a hydration mismatch.
   * Null until mounted, and the results area shows its loading state meanwhile; the data fetch
   * is client-side anyway, so nothing is actually delayed by waiting for it.
   */
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => { setNow(new Date()) }, [])

  /** Rows and the filter labels they were fetched under, held TOGETHER. The print header reads
   * these labels, not the live filters, so a sheet can never describe a scope its rows don't
   * match — which is exactly what would happen if someone changed a filter mid-print. */
  const [result, setResult] = useState<{ rows: ReportRow[]; labels: ReportFilterLabels } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Pickers, scoped to the line ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const lineId = filters.lineId

    async function run() {
      setOptionsError(null)
      try {
        // `sections` is fetched for the line because it is what a job's TEAM is derived from
        // (lib/sections' teamForJob) — the Job picker narrows by team through it, and nothing
        // on this page reads jobs.team_id.
        const [products, teams, sections, jobs, operators, tryouts] = await Promise.all([
          // The Model filter's options. Through lib/lines because a pre-assembly line's times are
          // recorded against models it does not own — they belong to the build lines it feeds —
          // so a products-by-line query left this dropdown empty on exactly the lines whose
          // reports somebody would then be unable to narrow.
          lineId
            ? modelsForLine(supabase, lineId).then((rows) => rows as ProductOption[])
            : Promise.resolve([] as ProductOption[]),
          lineId
            ? supabase.from('teams').select('id, name').eq('production_line_id', lineId).order('name')
              .then(({ data, error }) => { if (error) throw new Error(error.message); return (data ?? []) as TeamOption[] })
            : Promise.resolve([] as TeamOption[]),
          lineId ? fetchSectionsForLine(supabase, lineId) : Promise.resolve([] as Section[]),
          // Merged-away jobs ARE filtered out here, unlike the label lookups in lib/reports: this
          // is a picker, and offering a retired job to filter by would be offering a dead end.
          (lineId
            ? supabase.from('jobs').select('id, name, section_id').eq('production_line_id', lineId).eq('is_active', true).order('name')
            : supabase.from('jobs').select('id, name, section_id').eq('is_active', true).order('name')
          ).then(({ data, error }) => { if (error) throw new Error(error.message); return (data ?? []) as JobOption[] }),
          fetchOperators(supabase),
          loadTryouts(),
        ])
        if (cancelled) return
        setOptions({
          products, teams, sections, jobs,
          // With no line in scope there is nothing to scope BY, so the full list stands — the
          // same rule lib/operators documents for the stopwatch pickers.
          operators: operatorsForLine(operators, lineId || null),
          tryouts: lineId ? tryouts.filter((t) => t.productionLineId === lineId) : tryouts,
        })
      } catch (err) {
        if (cancelled) return
        setOptions(NO_OPTIONS)
        setOptionsError(err instanceof Error ? err.message : 'Could not load the filter lists')
      }
    }

    /** Try Outs, labelled by chassis number and tagged with the line their model sits on so the
     * picker can narrow with the rest. Two hops because `tryouts` carries only a chassis_id. */
    async function loadTryouts(): Promise<TryoutOption[]> {
      const { data: rows, error } = await supabase
        .from('tryouts').select('id, chassis_id').order('started_at', { ascending: false })
      if (error) throw new Error(error.message)
      const tryouts = (rows ?? []) as { id: string; chassis_id: string }[]
      if (tryouts.length === 0) return []
      // Chunked (lib/chunkedIn) — a season's try-outs is an unbounded id list, and it is a
      // primary-key lookup, so selectIn is both sufficient and complete.
      const chassis = await selectIn<{ id: string; chassisnumber: string; product_id: string | null }>(
        [...new Set(tryouts.map((t) => t.chassis_id))],
        (chunk) => supabase.from('chassis').select('id, chassisnumber, product_id').in('id', chunk)
      )
      const chassisById = new Map(chassis.map((c) => [c.id, c]))
      const products = await selectIn<{ id: string; production_line_id: string | null }>(
        [...new Set(chassis.map((c) => c.product_id).filter((id): id is string => !!id))],
        (chunk) => supabase.from('products').select('id, production_line_id').in('id', chunk)
      )
      const lineByProduct = new Map(products.map((p) => [p.id, p.production_line_id]))
      return tryouts.flatMap((t) => {
        const c = chassisById.get(t.chassis_id)
        if (!c) return []
        return [{
          id: t.id,
          chassisNumber: c.chassisnumber,
          productionLineId: c.product_id ? lineByProduct.get(c.product_id) ?? null : null,
        }]
      })
    }

    run()
    return () => { cancelled = true }
  }, [supabase, filters.lineId])

  // ── Job picker, narrowed by the selected team ─────────────────────────────────────────────
  // Through the job's SECTION, never jobs.team_id — see lib/sections' teamForJob, which is the
  // one definition of this rule everywhere in the app.
  const sectionById = useMemo(
    () => new Map(options.sections.map((s) => [s.id, { team_id: s.team_id }])),
    [options.sections]
  )
  const jobOptions = useMemo(() => {
    if (!filters.teamId) return options.jobs
    return options.jobs.filter((j) => teamForJob(j, sectionById) === filters.teamId)
  }, [options.jobs, filters.teamId, sectionById])

  // ── Labels for the summary line ───────────────────────────────────────────────────────────
  const labels: ReportFilterLabels | null = useMemo(() => {
    if (!now) return null
    const tryout = options.tryouts.find((t) => t.id === filters.tryoutId)
    return {
      lineName: lines.find((l) => l.id === filters.lineId)?.name ?? null,
      modelName: filters.productId === UNATTACHED_PRODUCT_ID
        ? UNATTACHED_LABEL
        : options.products.find((p) => p.id === filters.productId)?.model ?? null,
      teamName: options.teams.find((t) => t.id === filters.teamId)?.name ?? null,
      jobName: options.jobs.find((j) => j.id === filters.jobId)?.name ?? null,
      operatorName: options.operators.find((o) => o.id === filters.operatorId)?.full_name ?? null,
      tryoutLabel: tryout ? `Try Out ${tryout.chassisNumber}` : null,
      dateLabel: describeDateRange(resolveReportWindow(filters, now), now),
    }
  }, [now, filters, lines, options])

  // ── The report ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!now || !labels) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchReportRows(supabase, filters, now)
      .then((rows) => { if (!cancelled) setResult({ rows, labels }) })
      .catch((err) => {
        if (cancelled) return
        logSupabaseError('reports — fetchReportRows', err)
        setResult(null)
        setError(err instanceof Error ? err.message : 'Could not load the report')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // `labels` is derived from `filters` + `now` and changes with them; it is read rather than
    // depended on so a re-render that only re-creates the object doesn't re-run the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, filters, now])

  const rows = result?.rows ?? []
  const totals = useMemo(() => summariseReport(rows), [rows])
  const summaryLine = result ? describeFilters(result.labels) : (labels ? describeFilters(labels) : '')

  // ── Filter helpers ────────────────────────────────────────────────────────────────────────
  /** Changing a filter clears everything scoped BENEATH it, so a stale narrower selection can't
   * survive into a scope where it means nothing (a Motor Home job left set while the Caravan
   * line is selected would silently return no rows and look like missing data). */
  function update(patch: Partial<ReportFilters>) {
    setFilters((prev) => {
      const next = { ...prev, ...patch }
      if (patch.lineId !== undefined && patch.lineId !== prev.lineId) {
        next.productId = ''; next.teamId = ''; next.jobId = ''; next.operatorId = ''; next.tryoutId = ''
      }
      if (patch.teamId !== undefined && patch.teamId !== prev.teamId) next.jobId = ''
      return next
    })
  }

  function setPreset(preset: ReportDatePreset) {
    update({ preset, customFrom: '', customTo: '' })
  }

  /** Typing in either date box IS choosing a custom range — no separate "Custom" button to press
   * first, which is a step people forget and then read the wrong dates off the result. */
  function setCustomDate(patch: { customFrom?: string; customTo?: string }) {
    update({ ...patch, preset: 'custom' })
  }

  const anyFilterSet = !!(filters.lineId || filters.productId || filters.teamId || filters.jobId
    || filters.operatorId || filters.tryoutId || filters.preset !== 'today')

  // ── Print ─────────────────────────────────────────────────────────────────────────────────
  /**
   * The "Printed …" stamp on the sheet.
   *
   * Held in state rather than read during render, for the same server/client reason as `now`: a
   * date evaluated during render differs between the two passes and React reports a hydration
   * mismatch.
   *
   * Stamped ON MOUNT as well as on the button, which the earlier version did not do — it was set
   * only by handlePrint, so a sheet sent with ⌘P or File ▸ Print (which is how a report already
   * open on screen usually gets printed) came out with no date on it at all. Refreshed on the
   * button so a page left open all morning still stamps the minute it was actually printed.
   */
  const [printedAt, setPrintedAt] = useState<string | null>(null)
  useEffect(() => { setPrintedAt(stampNow()) }, [])
  function handlePrint() {
    setPrintedAt(stampNow())
    // Two frames, so the stamp is painted before the print dialog snapshots the page.
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()))
  }

  const totalsLine = `${plural(totals.recordCount, 'record')} · ${fmtMinutes(totals.totalMinutes)} minutes (${fmtHours(totals.totalMinutes)}h) · ${plural(totals.operationCount, 'operation')} · ${plural(totals.jobCount, 'job')}`
  const emptyMessage = result ? describeEmptyResult(result.labels) : 'No times recorded.'

  return (
    <main className="page-wide rp-page">
      {/* Every direct child of <main> below is .rp-screen-only — controls, filters, cards and
          the on-screen table are all hidden by report-print.css when printing, leaving the
          .rp-doc at the bottom alone on the paper. Marked one by one rather than with a
          `> *:not(.print)` rule, which is what this page used to carry: the negation silently
          hid anything added later that wasn't given the magic class. */}
      <div className="rp-screen-only" style={{ marginBottom: 20, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Reports</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
            Individual time records — every run as it was collected, not averaged
          </p>
        </div>
        <button type="button" className="btn-ghost" onClick={handlePrint} disabled={!result}>
          Print
        </button>
      </div>

      {/* ── Filters ──────────────────────────────────────────────────────────────────────── */}
      <div className="card rp-screen-only" style={{ padding: '16px 20px', marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <span style={LABEL}>Date range</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {REPORT_DATE_PRESETS.map((p) => {
                const active = filters.preset === p.key
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setPreset(p.key)}
                    style={{
                      fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                      padding: '7px 12px', borderRadius: 8,
                      border: `1.5px solid ${active ? 'var(--blue)' : 'var(--border)'}`,
                      background: active ? 'var(--blue-light)' : 'var(--surface)',
                      color: active ? 'var(--blue)' : 'var(--text-mid)',
                    }}
                  >
                    {p.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <span style={LABEL}>From</span>
            <input
              type="date" style={DATE_INPUT} value={filters.customFrom}
              onChange={(e) => setCustomDate({ customFrom: e.target.value })}
            />
          </div>
          <div>
            <span style={LABEL}>To</span>
            <input
              type="date" style={DATE_INPUT} value={filters.customTo}
              onChange={(e) => setCustomDate({ customTo: e.target.value })}
            />
          </div>

          <div>
            <span style={LABEL}>Production line</span>
            <select style={SEL} value={filters.lineId} onChange={(e) => update({ lineId: e.target.value })}>
              <option value="">All lines</option>
              {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>

          <div>
            <span style={LABEL}>Model</span>
            <select style={SEL} value={filters.productId} onChange={(e) => update({ productId: e.target.value })} disabled={!filters.lineId}>
              <option value="">All models</option>
              {/* Not a product — see UNATTACHED_PRODUCT_ID. Pinned above the models rather than
                  sorted among them: it is a different kind of answer, and it is the only way to
                  reach a run that no longer belongs to any model. */}
              <option value={UNATTACHED_PRODUCT_ID}>{UNATTACHED_LABEL}</option>
              {options.products.map((p) => <option key={p.id} value={p.id}>{p.model}</option>)}
            </select>
          </div>

          <div>
            <span style={LABEL}>Team</span>
            <select style={SEL} value={filters.teamId} onChange={(e) => update({ teamId: e.target.value })} disabled={!filters.lineId}>
              <option value="">All teams</option>
              {options.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>

          <div>
            <span style={LABEL}>Job</span>
            <select style={SEL} value={filters.jobId} onChange={(e) => update({ jobId: e.target.value })}>
              <option value="">All jobs</option>
              {jobOptions.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
          </div>

          <div>
            <span style={LABEL}>Operator</span>
            <select style={SEL} value={filters.operatorId} onChange={(e) => update({ operatorId: e.target.value })}>
              <option value="">All operators</option>
              {options.operators.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
            </select>
          </div>

          <div>
            <span style={LABEL}>Try Out</span>
            <select style={SEL} value={filters.tryoutId} onChange={(e) => update({ tryoutId: e.target.value })}>
              <option value="">All try-outs</option>
              {options.tryouts.map((t) => <option key={t.id} value={t.id}>{t.chassisNumber}</option>)}
            </select>
          </div>

          {anyFilterSet && (
            <button
              type="button"
              onClick={() => setFilters({ ...EMPTY_FILTERS, lineId: defaultLineId })}
              style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mid)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: '7px 0' }}
            >
              Reset
            </button>
          )}
        </div>

        {optionsError && (
          <p style={{ fontSize: 12, color: 'var(--red)', margin: '12px 0 0' }}>
            Some filter lists could not be loaded: {optionsError}
          </p>
        )}
      </div>

      {/* ── Totals ───────────────────────────────────────────────────────────────────────── */}
      {/* On paper these four become one line in the print header — see `totalsLine`. Four
          boxes would cost a third of the first sheet to say what a line of type says. */}
      <div className="grid-4 rp-screen-only" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-card-label">Records</div>
          <div className="stat-card-value">{totals.recordCount}</div>
          <div className="stat-card-sub">individual times, not averaged</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">Total minutes</div>
          <div className="stat-card-value">{fmtMinutes(totals.totalMinutes)}</div>
          <div className="stat-card-sub">{fmtHours(totals.totalMinutes)}h</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">Operations</div>
          <div className="stat-card-value">{totals.operationCount}</div>
          <div className="stat-card-sub">distinct operations covered</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">Jobs</div>
          <div className="stat-card-value">{totals.jobCount}</div>
          <div className="stat-card-sub">distinct jobs covered</div>
        </div>
      </div>

      {/* ── Results ──────────────────────────────────────────────────────────────────────── */}
      <div className="card rp-screen-only" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Time records</span>
          {/* The active-filter summary — the same string, from the same function, that heads the
              printed sheet. */}
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '3px 0 0' }}>{summaryLine}</p>
        </div>

        {error ? (
          <p style={{ ...EMPTY, color: 'var(--red)' }}>{error}</p>
        ) : loading || !result ? (
          <p style={EMPTY}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={EMPTY}>{emptyMessage}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th><th>Team</th><th>Section</th><th>Job</th><th>Operation</th>
                  <th>Operator</th><th className="right">Minutes</th><th>Models</th><th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.createdAt)}</td>
                    <td>{r.teamName}</td>
                    <td>{r.sectionName}</td>
                    <td className="primary">{r.jobName}</td>
                    <td className="primary">{r.operationName}</td>
                    <td>{r.operatorName}</td>
                    <td className="right">{fmtMinutes(r.minutes)}</td>
                    {/* Never blank: a run with no model is in a STATE, and an empty cell reads
                        as a rendering fault rather than as the thing the unattached filter finds. */}
                    <td>
                      {r.models.length > 0
                        ? r.models.join(', ')
                        : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>{NONE} unattached</span>}
                    </td>
                    <td>{r.notes.length > 0 ? r.notes.join('; ') : NONE}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/*
        ── Printed sheet ──────────────────────────────────────────────────────────────────
        Never visible on screen (.rp-print-only is display:none until @media print), while
        every sibling above it is .rp-screen-only and goes the other way. Structure, rules and
        fragmentation come from app/report-print.css via the .rp-* classes — the same module the
        Model Total recorded-times sheet and the coverage report print through; the column
        widths and this report's few particulars are in globals.css, the paper in ./print.css.

        It renders `result` — the rows AND the labels they were fetched under — so the header
        can only ever describe the rows printed beneath it.
      */}
      <div className="rp-doc rp-print-only reports-doc">
        <header className="rp-head">
          <h1 className="rp-title">J-Motion — Time Records</h1>
          {/* THE SAME STRING THE SCREEN SHOWS — `summaryLine`, the one the results card is
              headed with — and not a second description assembled for print. A sheet handed to
              someone without a login says what it is a report OF or it is a page of numbers,
              and the two descriptions drifting apart is how it ends up claiming a scope its
              rows were never filtered to.

              It cannot drift here: `summaryLine` reads result.labels — the labels the rows were
              FETCHED under, held in the same state object as the rows — for as long as there is
              a result, and `rows` is that same result's rows. It falls back to the live filters
              only when there is no result at all, which is also the case in which no row prints
              and the empty line below says so. */}
          <p className="rp-meta">{summaryLine}</p>
          {/* The four summary cards, as one line. */}
          <p className="rp-meta reports-totals">{totalsLine}</p>
          {printedAt && <p className="rp-meta">Printed {printedAt}</p>}
        </header>

        {rows.length === 0 ? (
          <p className="reports-empty">{emptyMessage}</p>
        ) : (
          <table className="rp-table reports-table">
            {/* display:table-header-group in report-print.css — the headings repeat at the top
                of every sheet, so page four is readable on its own. The widths live on the th
                cells (globals.css) because .rp-table is table-layout: fixed and takes its
                measure from the first row. */}
            <thead>
              <tr>
                <th className="rep-col-date">Date</th>
                <th className="rep-col-team">Team</th>
                <th className="rep-col-section">Section</th>
                <th className="rep-col-job">Job</th>
                <th className="rep-col-operation">Operation</th>
                <th className="rep-col-operator">Operator</th>
                <th className="rep-col-minutes rp-num">Mins</th>
                <th className="rep-col-models">Models</th>
                <th className="rep-col-notes">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="rep-date">{fmtDate(r.createdAt)}</td>
                  <td>{r.teamName}</td>
                  <td>{r.sectionName}</td>
                  <td>{r.jobName}</td>
                  <td>{r.operationName}</td>
                  <td>{r.operatorName}</td>
                  <td className="rp-num">{fmtMinutes(r.minutes)}</td>
                  {/* Never blank, and italic rather than grey — the same reason as on screen,
                      except that here grey would not survive the photocopier either. */}
                  <td className={'rep-models' + (r.models.length > 0 ? '' : ' reports-none')}>
                    {r.models.length > 0 ? r.models.join(', ') : `${NONE} unattached`}
                  </td>
                  <td className={'rep-notes' + (r.notes.length > 0 ? '' : ' reports-none')}>
                    {r.notes.length > 0 ? r.notes.join('; ') : NONE}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  )
}
