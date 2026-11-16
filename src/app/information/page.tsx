import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import InformationClient from './InformationClient'
import './print.css'

/**
 * /information — how J-Motion works, for someone meeting it for the first time.
 *
 * Static copy, no data. Written for the handover to the BOM team and checked against how the
 * system behaves, so the wording is not to be paraphrased or "improved" here: if the code and
 * this page disagree, that is a question for whoever owns the copy, not an edit.
 */
export default async function InformationPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Nav />
      <InformationClient />
    </div>
  )
}
