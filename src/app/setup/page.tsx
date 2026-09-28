import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import SetupClient from './SetupClient'
import { setupFocusFromParams } from '@/lib/setupLinks'
import type { UserRole } from '@/lib/types'

/** Focus is read from the query string HERE, on the server, and handed down — the same shape
 * /reports uses. It arrives before first paint, so a deep-linked merge opens on the right job
 * rather than flashing the remembered position and jumping. */
export default async function SetupPage({ searchParams }: {
  searchParams: Record<string, string | string[] | undefined>
}) {
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
      <SetupClient
        lines={lines ?? []}
        role={role}
        userId={user.id}
        initialFocus={setupFocusFromParams(searchParams)}
      />
    </div>
  )
}
