import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import ModelTotalClient from './ModelTotalClient'
import type { UserRole } from '@/lib/types'
// The shared print treatment (shell reset, hairline tables, fragmentation) and this route's own
// paper. Split because @page cannot be scoped by selector — see both files.
import '@/app/report-print.css'
import './print.css'

export default async function ModelTotalPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // The role rides down from the server so the time drawer can decide what to OFFER before the
  // user clicks it — read here rather than re-fetched client-side, which would leave the drawer
  // briefly showing controls at the least-privileged setting and then popping them in.
  const [{ data: lines }, { data: profile }] = await Promise.all([
    supabase.from('production_lines').select('*').order('name'),
    supabase.from('profiles').select('role').eq('id', user.id).maybeSingle(),
  ])

  return (
    // rp-shell, not an inline style: `min-height: 100vh` has to be switched OFF for print — a vh
    // unit there is measured against the screen viewport, not the sheet — and an inline style
    // cannot be overridden from a stylesheet without !important on every rule that fights it.
    <div className="rp-shell">
      <Nav />
      <ModelTotalClient
        lines={lines ?? []}
        userId={user.id}
        role={(profile?.role ?? null) as UserRole | null}
      />
    </div>
  )
}
