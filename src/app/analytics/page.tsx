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
    supabase
      .from('operations')
      .select('operator_name, stage, total_minutes')
      .not('total_minutes', 'is', null),
  ])

  const totalMinutes = (operations ?? []).reduce(
    (sum, op) => sum + (op.total_minutes ?? 0), 0
  )

  // By operator
  const byOperator: Record<string, { total_minutes: number; operation_count: number }> = {}
  for (const op of operations ?? []) {
    if (!byOperator[op.operator_name]) {
      byOperator[op.operator_name] = { total_minutes: 0, operation_count: 0 }
    }
    byOperator[op.operator_name].total_minutes += op.total_minutes ?? 0
    byOperator[op.operator_name].operation_count += 1
  }

  // By stage
  const byStage: Record<string, { total_minutes: number; operation_count: number }> = {}
  for (const op of operations ?? []) {
    if (!byStage[op.stage]) {
      byStage[op.stage] = { total_minutes: 0, operation_count: 0 }
    }
    byStage[op.stage].total_minutes += op.total_minutes ?? 0
    byStage[op.stage].operation_count += 1
  }

  const operatorRows = Object.entries(byOperator).sort(
    (a, b) => b[1].total_minutes - a[1].total_minutes
  )
  const stageRows = Object.entries(byStage).sort(
    (a, b) => b[1].total_minutes - a[1].total_minutes
  )

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <main className="max-w-5xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <p className="text-sm text-gray-500 mt-0.5">Live summary of all recorded tryout data</p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <StatCard
            label="Total Sessions"
            value={sessionCount ?? 0}
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
            }
          />
          <StatCard
            label="Total Operations"
            value={opCount ?? 0}
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
              </svg>
            }
          />
          <StatCard
            label="Total Minutes"
            value={totalMinutes.toFixed(1)}
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="13" r="8" /><polyline points="12 9 12 13 14.5 15.5" /><path d="M9 3h6" /><path d="M12 3v2" />
              </svg>
            }
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* By Operator */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-50">
              <h2 className="font-semibold text-gray-900">Minutes by Operator</h2>
            </div>
            {operatorRows.length === 0 ? (
              <p className="text-center text-gray-400 py-8 text-sm">No completed operations yet</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-5 py-3 font-medium">Operator</th>
                    <th className="text-right px-5 py-3 font-medium">Ops</th>
                    <th className="text-right px-5 py-3 font-medium">Minutes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {operatorRows.map(([name, data]) => (
                    <tr key={name} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3 font-medium text-gray-800">{name}</td>
                      <td className="px-5 py-3 text-right text-gray-500">{data.operation_count}</td>
                      <td className="px-5 py-3 text-right font-semibold text-[#0079c1]">
                        {data.total_minutes.toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* By Stage */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-50">
              <h2 className="font-semibold text-gray-900">Minutes by Stage / Work Centre</h2>
            </div>
            {stageRows.length === 0 ? (
              <p className="text-center text-gray-400 py-8 text-sm">No completed operations yet</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-5 py-3 font-medium">Stage</th>
                    <th className="text-right px-5 py-3 font-medium">Ops</th>
                    <th className="text-right px-5 py-3 font-medium">Minutes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {stageRows.map(([stage, data]) => (
                    <tr key={stage} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3 font-medium text-gray-800">{stage}</td>
                      <td className="px-5 py-3 text-right text-gray-500">{data.operation_count}</td>
                      <td className="px-5 py-3 text-right font-semibold text-[#0079c1]">
                        {data.total_minutes.toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string
  value: string | number
  icon: React.ReactNode
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-center gap-2 text-[#0079c1] mb-3">{icon}</div>
      <div className="text-2xl font-bold text-gray-900 tabular-nums">{value}</div>
      <div className="text-sm text-gray-500 mt-0.5">{label}</div>
    </div>
  )
}
