import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import DashboardClient from './DashboardClient'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: sessions } = await supabase
    .from('tryout_sessions')
    .select(`
      id,
      chassis_number,
      created_by,
      created_at,
      notes,
      profiles:created_by ( full_name )
    `)
    .order('created_at', { ascending: false })

  // Get operation counts
  const { data: opCounts } = await supabase
    .from('operations')
    .select('session_id')

  const countMap: Record<string, number> = {}
  opCounts?.forEach((op) => {
    countMap[op.session_id] = (countMap[op.session_id] ?? 0) + 1
  })

  const enriched = (sessions ?? []).map((s) => ({
    ...s,
    profiles: Array.isArray(s.profiles) ? s.profiles[0] ?? null : s.profiles,
    operation_count: countMap[s.id] ?? 0,
  }))

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <DashboardClient sessions={enriched} userId={user.id} />
    </div>
  )
}
