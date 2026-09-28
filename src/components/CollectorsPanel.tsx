'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  COLLECTOR_DETAIL_LIMIT, fetchCollectorDetail, fetchCollectorSummary,
  type CollectorDetailRow, type CollectorSummary, type CollectorSummaryRow,
} from '@/lib/collectors'
import { COLLECTION_TIMEFRAMES, periodRangeLabel, type CollectionTimeframe } from '@/lib/periods'
import { fmtDateTime, fmtHours, fmtMinutes, plural } from '@/lib/format'

/**
 * Who's collecting — /dashboard's per-person view of the same operation_times the "Times
 * collected" cards above it count.
 *
 * The arithmetic is all in lib/collectors; this file is the panel. It holds three things: which
 * timeframe is showing, the summary for it, and a per-person detail cache that is only ever
 * populated by opening a row.
 *
 * ── Lazy by construction ──────────────────────────────────────────────────────────────────
 * The collapsed view costs two reads and no detail whatsoever. Opening somebody's row is what
 * fetches their operation/job/model labels, and the result is cached under
 * `timeframe:lineId:person` so re-opening the same row is free while changing either scope
 * discards the lot. On Overall the imported bucket is thousands of rows: only the newest
 * COLLECTOR_DETAIL_LIMIT are drawn, with the remainder stated rather than rendered.
 */

interface Props {
  /** The dashboard's production line filter. '' = all lines. */
  lineId: string
  lineName: string | null
}

const EMPTY: React.CSSProperties = {
  textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '28px 0',
}
const ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}

export default function CollectorsPanel({ lineId, lineName }: Props) {
  const supabase = useMemo(() => createClient(), [])

  const [timeframe, setTimeframe] = useState<CollectionTimeframe>('today')
  const [summary, setSummary] = useState<CollectorSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [openKey, setOpenKey] = useState<string | null>(null)
  /** Keyed by `timeframe:lineId:personKey`, so a scope change can never show stale detail. */
  const [detail, setDetail] = useState<Record<string, CollectorDetailRow[]>>({})
  const [detailLoading, setDetailLoading] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  const rangeLabel = useMemo(() => periodRangeLabel(timeframe), [timeframe])

  /**
   * Same guard as /dashboard's own load, for the same reason and against the same failure.
   *
   * This panel takes its line from the dashboard's single `lineId` prop, so it can never filter
   * by a DIFFERENT line — but it can still show the WRONG one, because two loads overlap
   * whenever the scope changes and the slower one wins by finishing last. It is far less
   * dramatic here than on the page around it (one scoped summary read, not a full sweep), which
   * is exactly why this panel looked correct while the schedule table above it did not — but
   * switching to Overall, which reads thousands of rows, and straight back to Today is enough to
   * leave Overall's figures sitting under the Today heading.
   */
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const isCurrent = () => loadSeq.current === seq

    setLoading(true)
    setError(null)
    setOpenKey(null)
    setDetail({})
    setDetailError(null)
    try {
      const next = await fetchCollectorSummary(supabase, { timeframe, lineId: lineId || null })
      if (!isCurrent()) return
      setSummary(next)
    } catch (err) {
      if (!isCurrent()) return
      setError(err instanceof Error ? err.message : 'Could not load collection activity')
      setSummary(null)
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [supabase, timeframe, lineId])

  useEffect(() => { load() }, [load])

  async function toggleRow(row: CollectorSummaryRow) {
    if (openKey === row.key) { setOpenKey(null); return }
    setOpenKey(row.key)
    setDetailError(null)
    const cacheKey = `${timeframe}:${lineId}:${row.key}`
    if (detail[cacheKey]) return
    setDetailLoading(cacheKey)
    try {
      const rows = await fetchCollectorDetail(
        supabase, { timeframe, lineId: lineId || null, collectedBy: row.collectedBy }
      )
      setDetail((prev) => ({ ...prev, [cacheKey]: rows }))
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Could not load these times')
    } finally {
      setDetailLoading(null)
    }
  }

  const rows = summary?.rows ?? []

  return (
    <section className="card" style={{ marginBottom: 20, overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Who&rsquo;s collecting</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
          Who recorded the times on {lineName ?? 'every line'}, busiest first. Open a name to see
          exactly what they collected. Counted by who did the collecting, not by who was timed.
        </div>

        <div className="tabs" style={{ marginTop: 12, marginBottom: 0 }}>
          {COLLECTION_TIMEFRAMES.map((tf) => (
            <button
              key={tf.key}
              type="button"
              className={'tab' + (timeframe === tf.key ? ' tab-active' : '')}
              onClick={() => setTimeframe(tf.key)}
            >
              {tf.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
          {rangeLabel}
          {summary && summary.totalCount > 0 && (
            <> &middot; {summary.totalCount.toLocaleString()} time{summary.totalCount === 1 ? '' : 's'} across{' '}
            {plural(rows.length, 'collector')}</>
          )}
        </div>
      </div>

      {error && <div style={{ padding: '14px 20px' }}><p style={ERR_BOX}>{error}</p></div>}

      {loading ? (
        <p style={EMPTY}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={EMPTY}>
          Nobody collected anything on {lineName ?? 'any line'} {rangeLabel}.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Collector</th>
                <th className="center">Times collected</th>
                <th className="right">Total minutes</th>
                <th className="right" style={{ width: 1, whiteSpace: 'nowrap' }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const open = openKey === row.key
                const cacheKey = `${timeframe}:${lineId}:${row.key}`
                return (
                  <RowGroup
                    key={row.key}
                    row={row}
                    open={open}
                    detail={detail[cacheKey]}
                    loading={detailLoading === cacheKey}
                    error={open ? detailError : null}
                    onToggle={() => toggleRow(row)}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** One person's summary row plus, when open, the detail row beneath it. */
function RowGroup({
  row, open, detail, loading, error, onToggle,
}: {
  row: CollectorSummaryRow
  open: boolean
  detail: CollectorDetailRow[] | undefined
  loading: boolean
  error: string | null
  onToggle: () => void
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        style={{ cursor: 'pointer', ...(row.imported ? { background: '#fafbfc' } : null) }}
      >
        <td className="primary">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="finder-chevron" style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.12s' }}>›</span>
            {/* The ownerless bucket is deliberately not dressed as a person: muted name, grey
              * chip, and it always sits at the bottom of the list. */}
            <span style={row.imported ? { color: 'var(--text-muted)', fontWeight: 600 } : undefined}>
              {row.name}
            </span>
            {row.imported && (
              <span className="badge badge-grey" title="Historical imports with no collected_by — real recorded times, but nobody to attribute them to">
                imported history
              </span>
            )}
          </span>
        </td>
        <td className="center">{row.count.toLocaleString()}</td>
        <td
          className="right mono"
          title={
            `${fmtHours(row.totalMinutes)} h` +
            (row.untimed > 0 ? ` · ${plural(row.untimed, 'time')} have no minutes recorded and are not in this total` : '')
          }
        >
          {fmtMinutes(row.totalMinutes)}m
        </td>
        <td className="right" style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-muted)' }}>
          {open ? 'Hide' : 'Show'}
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={4} style={{ padding: 0, background: 'var(--bg)' }}>
            <div style={{ padding: '12px 20px 14px' }}>
              {error ? (
                <p style={ERR_BOX}>{error}</p>
              ) : loading || detail == null ? (
                <p style={{ ...EMPTY, padding: '12px 0' }}>Loading…</p>
              ) : detail.length === 0 ? (
                <p style={{ ...EMPTY, padding: '12px 0' }}>No times to show.</p>
              ) : (
                <>
                  {row.count > detail.length && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                      Showing {detail.length} of {row.count.toLocaleString()} — most recent first.
                      The remaining {(row.count - detail.length).toLocaleString()} are counted
                      above but not listed.
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {detail.map((d) => (
                      <div
                        key={d.id}
                        style={{
                          display: 'flex', gap: 16, justifyContent: 'space-between',
                          alignItems: 'flex-start', padding: '8px 0',
                          borderBottom: '1px solid var(--border)',
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', wordBreak: 'break-word' }}>
                            {d.operationName}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, wordBreak: 'break-word' }}>
                            {d.jobName}
                            {' · '}
                            {d.models.length > 0
                              ? d.models.join(', ')
                              : <span style={{ fontStyle: 'italic' }}>no model linked</span>}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', fontFamily: 'ui-monospace, "Cascadia Code", monospace' }}>
                            {d.minutes != null ? `${fmtMinutes(d.minutes)}m` : '—'}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                            {fmtDateTime(d.collectedAt)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
