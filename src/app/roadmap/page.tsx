import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import RoadmapClient from './RoadmapClient'
import type { RoadmapItem, RoadmapPhase } from '@/lib/types'

export default async function RoadmapPage({
  searchParams,
}: {
  searchParams: { debug?: string }
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Items come back flat and are joined to their phase in the client — one round trip each
  // beats a nested select here, and edit mode needs the two lists separately anyway.
  const [{ data: phases }, { data: items }, { data: profile, error: profileError }] = await Promise.all([
    supabase.from('roadmap_phases').select('*').order('phase_number'),
    supabase.from('roadmap_items').select('*').order('sort_order'),
    // Own row only — RLS lets any authenticated user read profiles, so a null here means the
    // row genuinely doesn't exist rather than that it was filtered out.
    supabase.from('profiles').select('role').eq('id', user.id).maybeSingle(),
  ])

  // Server-side half of the role diagnostic — shows up in the PM2 log, next to the browser
  // console line RoadmapClient prints for the same user.
  console.log('[roadmap] server role check:', JSON.stringify({
    userId: user.id,
    role: profile?.role ?? null,
    profileFound: profile != null,
    profileError: profileError?.message ?? null,
  }))

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Nav />
      <RoadmapClient
        initialPhases={(phases ?? []) as RoadmapPhase[]}
        initialItems={(items ?? []) as RoadmapItem[]}
        userId={user.id}
        role={profile?.role ?? null}
        forceEditIcons={searchParams.debug === 'roadmap'}
      />
    </div>
  )
}
