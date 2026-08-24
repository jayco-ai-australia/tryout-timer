import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import ProfileClient from './ProfileClient'
import type { Profile } from '@/lib/types'

export default async function ProfilePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: profile }, { data: lines }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).maybeSingle(),
    supabase.from('production_lines').select('*').order('name'),
  ])

  // Accounts created before the profiles-on-signup trigger existed (or any other
  // gap between auth.users and profiles) have no row here. The client normally
  // can't insert one — profiles only grants SELECT/UPDATE to authenticated users —
  // so self-heal with the service client, which bypasses RLS, instead of shipping
  // a null profile to the client component.
  let resolvedProfile = profile
  if (!resolvedProfile) {
    const service = createServiceClient()
    const { data: created } = await service
      .from('profiles')
      .upsert({ id: user.id, full_name: user.user_metadata?.full_name ?? null }, { onConflict: 'id' })
      .select('*')
      .single()
    resolvedProfile = created
  }
  if (!resolvedProfile) redirect('/dashboard')

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Nav />
      <ProfileClient
        profile={resolvedProfile as Profile}
        email={user.email ?? ''}
        lines={lines ?? []}
      />
    </div>
  )
}
