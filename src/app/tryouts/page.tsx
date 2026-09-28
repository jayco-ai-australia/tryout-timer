import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import TryOutsClient from './TryOutsClient'
import type { UserRole } from '@/lib/types'

export default async function TryOutsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Read server-side so the van's time-detail panel knows what to OFFER on first paint, rather
  // than rendering everyone's controls and then removing them.
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Nav />
      <TryOutsClient userId={user.id} role={(profile?.role ?? null) as UserRole | null} />
    </div>
  )
}
