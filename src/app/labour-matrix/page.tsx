import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import LabourMatrixClient from './LabourMatrixClient'
import { fetchAllRows } from '@/lib/supabaseRead'
import type { ProductionLine, UserRole } from '@/lib/types'
// The shared print treatment (shell reset, screen/print toggles) and this route's own paper.
// Split because @page cannot be scoped by selector — see both files.
import '@/app/report-print.css'
import './print.css'

/**
 * /labour-matrix — every model on a line against every job, one cell per pair.
 *
 * "Model Total for all of them at once": /model-total answers "what is the labour content of
 * THIS model, broken down by job", and this answers the same question for a whole line in one
 * grid. The two are held to the same numbers by construction — both read their figures through
 * lib/operationTimes' current-record helpers and their applicability through lib/coverage — so
 * a cell here and a job row there are the same addition, not two that agree by luck.
 *
 * Not admin-gated: it reports on what has been collected, which anyone signed in may read. The
 * middleware already turns an anonymous request away; the redirect below is the belt to its
 * braces, matching /reports and /pre-assembly-coverage.
 */
export default async function LabourMatrixPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Paged, like every other read this screen makes. production_lines is a dozen rows and will
  // never approach the 1000-row cap — but "small table" is exactly the assumption that made the
  // truncation bug in lib/supabaseRead's note invisible for as long as it was, and a read that
  // pages costs one extra round trip only once it actually needs one.
  const lines = await fetchAllRows<ProductionLine>(
    () => supabase.from('production_lines').select('*').order('name'),
    { table: 'production_lines' },
  )

  // The viewer, for the cell drawer. It is not used to gate the GRID — anyone signed in may read
  // what has been collected — but the drawer can open the shared time-record editor, and that
  // editor decides what is editable from these two values through lib/permissions. A missing
  // profiles row yields 'user', the least privileged answer.
  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single()
  const role = (profile?.role ?? 'user') as UserRole

  return (
    // rp-shell, not an inline style: `min-height: 100vh` has to be switched OFF for print — a vh
    // unit there is measured against the SCREEN viewport, not the sheet — and an inline style
    // cannot be overridden from a stylesheet without !important on every rule that fights it.
    <div className="rp-shell">
      <Nav />
      <LabourMatrixClient lines={lines} userId={user.id} role={role} />
    </div>
  )
}
