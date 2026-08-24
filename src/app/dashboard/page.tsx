import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import DashboardClient from './DashboardClient'
import type { UserRole } from '@/lib/types'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: profile }, { data: lines }] = await Promise.all([
    supabase.from('profiles').select('role, production_line_id').eq('id', user.id).single(),
    supabase.from('production_lines').select('*').order('name'),
  ])

  const role = (profile?.role ?? 'user') as UserRole
  // Admins always start unfiltered, regardless of any saved preference.
  const initialLineId = role === 'admin' ? '' : (profile?.production_line_id ?? '')

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Nav />
      <DashboardClient
        userId={user.id}
        role={role}
        lines={lines ?? []}
        initialLineId={initialLineId}
      />
    </div>
  )
}
