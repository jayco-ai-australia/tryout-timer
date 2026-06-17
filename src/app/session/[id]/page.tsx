import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import Nav from '@/components/Nav'
import SessionClient from './SessionClient'

interface Props {
  params: { id: string }
}

export default async function SessionPage({ params }: Props) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: session } = await supabase
    .from('tryout_sessions')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!session) notFound()

  const { data: operations } = await supabase
    .from('operations')
    .select('*')
    .eq('session_id', params.id)
    .order('created_at', { ascending: true })

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <SessionClient session={session} initialOperations={operations ?? []} userId={user.id} />
    </div>
  )
}
