import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import ConfigClient from './ConfigClient'
import type { UserRole } from '@/lib/types'

export default async function ConfigPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  // The role gates the structure actions on the Sections tab (lib/permissions' canEditStructure).
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
  const role = (profile?.role ?? null) as UserRole | null

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Nav />
      <ConfigClient userId={user.id} role={role} />
    </div>
  )
}
