import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import CollectClient from './CollectClient'

export default async function CollectPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: lines } = await supabase.from('production_lines').select('*').order('name')

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Nav />
      <CollectClient lines={lines ?? []} userId={user.id} />
    </div>
  )
}
