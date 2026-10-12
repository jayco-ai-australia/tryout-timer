import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import AdminClient from './AdminClient'
import { canAccessAdminArea } from '@/lib/permissions'
import type { Profile, OperationTimeWithRelations, OperatorChangeRequest, UserRole } from '@/lib/types'

export default async function AdminPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  // The server-side half of the middleware gate — same helper, same answer, so a manager is
  // turned away here too even if the middleware were ever bypassed.
  if (!canAccessAdminArea((profile?.role ?? null) as UserRole | null)) redirect('/dashboard')

  const [{ data: profiles }, { data: records }, { data: requests }] = await Promise.all([
    supabase.from('profiles').select('id, full_name, role, created_at').order('created_at', { ascending: false }),
    // Not filtered on is_active or is_hidden: this list is every recorded time, newest first, and
    // AdminClient marks the retired and hidden ones (see lib/operationTimes.ts) — including a
    // record whose operation or job is retired, which is why both parents' is_active ride along.
    supabase.from('operation_times').select(`
      *,
      operations ( id, name, job_id, is_active, jobs ( id, name, is_active ) ),
      operators ( id, full_name ),
      chassis ( id, chassisnumber, product_id, products ( id, product_code, model ) ),
      collector:profiles!collected_by ( full_name )
    `).order('created_at', { ascending: false }).limit(200),
    supabase.from('operator_change_requests')
      .select('*, operators ( id, full_name ), from_team:from_team_id ( id, name ), to_team:to_team_id ( id, name ), requester:requested_by ( full_name )')
      .order('created_at', { ascending: false }),
  ])

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Nav />
      <AdminClient
        profiles={(profiles ?? []) as Profile[]}
        records={(records ?? []) as unknown as OperationTimeWithRelations[]}
        requests={(requests ?? []) as unknown as OperatorChangeRequest[]}
      />
    </div>
  )
}
