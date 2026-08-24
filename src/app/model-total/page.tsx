import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import ModelTotalClient from './ModelTotalClient'

export default async function ModelTotalPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: lines } = await supabase.from('production_lines').select('*').order('name')

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Nav />
      <ModelTotalClient lines={lines ?? []} userId={user.id} />
    </div>
  )
}
