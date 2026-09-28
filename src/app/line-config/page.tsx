import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import LineConfigClient from './LineConfigClient'
import type { UserRole } from '@/lib/types'

/**
 * /line-config — Production Line Config. The same server shell /setup uses: authenticate, read
 * the role, hand down the production lines so the first paint already has the filter populated.
 *
 * Any signed-in user can open it. Role is used for ONE thing inside — deleting a section, which
 * is the only irreversible act on the page — exactly as /setup gates its deletes.
 */
export default async function LineConfigPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // production_line_id comes down with the role: it is the line this viewer works on, and the
  // page opens on it. Same profile column /dashboard and /reports open on, so all three agree
  // about "your line" rather than each guessing from list order.
  const { data: profile } = await supabase
    .from('profiles').select('role, production_line_id').eq('id', user.id).single()
  const role = (profile?.role ?? 'user') as UserRole

  const { data: lines } = await supabase.from('production_lines').select('*').order('name')

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Nav />
      <LineConfigClient
        lines={lines ?? []}
        role={role}
        userId={user.id}
        defaultLineId={profile?.production_line_id ?? ''}
      />
    </div>
  )
}
