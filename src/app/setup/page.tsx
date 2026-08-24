import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import SetupClient from './SetupClient'
import type { UserRole } from '@/lib/types'

export default async function SetupPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Any authenticated user can use this screen — role is only used to hide/show the
  // delete controls (admin-only), not to gate the page itself.
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  const role = (profile?.role ?? 'user') as UserRole

  const { data: lines } = await supabase.from('production_lines').select('*').order('name')

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Nav />
      <SetupClient lines={lines ?? []} role={role} userId={user.id} />
    </div>
  )
}
