import { createClient } from '@/lib/supabase/server'
import Nav from '@/components/Nav'

export const revalidate = 60

export default async function AnalyticsPage() {
  const supabase = await createClient()

  const [
    { count: sessionCount },
    { count: opCount },
    { data: operations },
  ] = await Promise.all([
    supabase.from('tryout_sessions').select('*', { count: 'exact', head: true }),
    supabase.from('operations').select('*', { count: 'exact', head: true }),
    supabase.from('operations').select('operator_name, stage, total_minutes').not('total_minutes', 'is', null),
  ])

  const totalMinutes = (operations ?? []).reduce((sum, op) => sum + (op.total_minutes ?? 0), 0)

  const byOperator: Record<string, { total_minutes: number; operation_count: number }> = {}
  const byStage: Record<string, { total_minutes: number; operation_count: number }> = {}

  for (const op of operations ?? []) {
    if (!byOperator[op.operator_name]) byOperator[op.operator_name] = { total_minutes: 0, operation_count: 0 }
    byOperator[op.operator_name].total_minutes += op.total_minutes ?? 0
    byOperator[op.operator_name].operation_count += 1

    if (!byStage[op.stage]) byStage[op.stage] = { total_minutes: 0, operation_count: 0 }
    byStage[op.stage].total_minutes += op.total_minutes ?? 0
    byStage[op.stage].operation_count += 1
  }

  const operatorRows = Object.entries(byOperator).sort((a, b) => b[1].total_minutes - a[1].total_minutes)
  const stageRows = Object.entries(byStage).sort((a, b) => b[1].total_minutes - a[1].total_minutes)

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Nav />
      <main className="page-narrow">
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Analytics</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Live summary of all recorded tryout data</p>
        </div>

        {/* Summary cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 28 }}>
          <StatCard label="Total Sessions" value={sessionCount ?? 0} icon="calendar" />
          <StatCard label="Total Operations" value={opCount ?? 0} icon="check" />
          <StatCard label="Total Minutes" value={totalMinutes.toFixed(1)} icon="timer" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          {/* By Operator */}
          <DataTable
            title="Minutes by Operator"
            cols={['Operator', 'Ops', 'Minutes']}
            empty="No completed operations yet"
            rows={operatorRows.map(([name, d]) => [
              <span key="n" style={{ fontWeight: 600, color: 'var(--text)' }}>{name}</span>,
              <span key="c" style={{ color: 'var(--text-muted)' }}>{d.operation_count}</span>,
              <span key="m" style={{ fontWeight: 700, color: 'var(--blue)' }}>{d.total_minutes.toFixed(1)}</span>,
            ])}
          />

          {/* By Stage */}
          <DataTable
            title="Minutes by Stage / Work Centre"
            cols={['Stage', 'Ops', 'Minutes']}
            empty="No completed operations yet"
            rows={stageRows.map(([stage, d]) => [
              <span key="s" style={{ fontWeight: 600, color: 'var(--text)' }}>{stage}</span>,
              <span key="c" style={{ color: 'var(--text-muted)' }}>{d.operation_count}</span>,
              <span key="m" style={{ fontWeight: 700, color: 'var(--blue)' }}>{d.total_minutes.toFixed(1)}</span>,
            ])}
          />
        </div>
      </main>
    </div>
  )
}

function StatCard({ label, value, icon }: { label: string; value: string | number; icon: 'calendar' | 'check' | 'timer' }) {
  const paths = {
    calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
    check: <><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" /></>,
    timer: <><circle cx="12" cy="13" r="8" /><polyline points="12 9 12 13 14.5 15.5" /><path d="M9 3h6" /><path d="M12 3v2" /></>,
  }
  return (
    <div className="card" style={{ padding: '20px 22px' }}>
      <svg style={{ color: 'var(--blue)', display: 'block', marginBottom: 12 }} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        {paths[icon]}
      </svg>
      <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text)', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>{label}</div>
    </div>
  )
}

function DataTable({
  title, cols, rows, empty,
}: {
  title: string
  cols: string[]
  rows: React.ReactNode[][]
  empty: string
}) {
  const alignRight = (i: number) => i === cols.length - 1 || i === cols.length - 2

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', margin: 0 }}>{title}</h2>
      </div>
      {rows.length === 0 ? (
        <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '28px 0' }}>{empty}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={c} className={alignRight(i) ? 'right' : ''}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci} className={alignRight(ci) ? 'right' : ''}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
