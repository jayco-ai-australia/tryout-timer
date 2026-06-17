import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import Nav from '@/components/Nav'
import SessionClient from './SessionClient'
import type { Note } from '@/lib/types'

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

  const operationIds = (operations ?? []).map((o) => o.id)

  let notesByOperation: Record<string, Note[]> = {}

  if (operationIds.length > 0) {
    const { data: notes } = await supabase
      .from('notes')
      .select('id, operation_id, content, created_by, created_at, profiles:created_by ( full_name )')
      .in('operation_id', operationIds)
      .order('created_at', { ascending: true })

    for (const note of notes ?? []) {
      const n = {
        ...note,
        profiles: Array.isArray(note.profiles) ? note.profiles[0] ?? null : note.profiles,
      } as Note
      if (!notesByOperation[n.operation_id]) notesByOperation[n.operation_id] = []
      notesByOperation[n.operation_id].push(n)
    }
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', user.id)
    .single()

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <SessionClient
        session={session}
        initialOperations={operations ?? []}
        initialNotes={notesByOperation}
        userId={user.id}
        userFullName={profile?.full_name ?? null}
      />
    </div>
  )
}
