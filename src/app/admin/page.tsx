import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import AdminClient from './AdminClient'

export default async function AdminPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'admin') redirect('/dashboard')

  const [{ data: profiles }, { data: sessions }, { data: operations }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, full_name, role, created_at')
      .order('created_at', { ascending: false }),
    supabase
      .from('tryout_sessions')
      .select('id, chassis_number, created_at, profiles:created_by ( full_name )')
      .order('created_at', { ascending: false }),
    supabase
      .from('operations')
      .select('id, operator_name, stage, operation_name, total_minutes, completed_at, session_id')
      .order('created_at', { ascending: false }),
  ])

  // Supabase returns joined relations as arrays; normalise to single object
  const normalisedSessions = (sessions ?? []).map((s) => ({
    ...s,
    profiles: Array.isArray(s.profiles) ? s.profiles[0] ?? null : s.profiles,
  }))

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <AdminClient
        profiles={(profiles ?? []) as import('@/lib/types').Profile[]}
        sessions={normalisedSessions}
        operations={operations ?? []}
      />
    </div>
  )
}
