import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import ReportsClient from './ReportsClient'
import { reportFiltersFromParams } from '@/lib/reports'
// The shared print treatment (shell reset, hairline tables, fragmentation) and this route's own
// paper. Split because @page cannot be scoped by selector — see both files.
import '@/app/report-print.css'
import './print.css'

/**
 * Filters are read from the QUERY STRING here on the server, not with useSearchParams in the
 * client. Two reasons: a deep-linked report renders with its filters already applied instead of
 * flashing the default view and re-fetching, and useSearchParams would put the whole client
 * component behind a Suspense boundary for no gain.
 */
export default async function ReportsPage({ searchParams }: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Not admin-gated — anyone signed in can pull a list of what was recorded. The middleware
  // already turns an anonymous request away, so the redirect above is the belt to its braces.
  //
  // The viewer's preferred line rides down from the server so the page opens already scoped to
  // the line they work on, rather than rendering "All lines", fetching everything, and then
  // narrowing once a client-side profile read lands.
  const [{ data: lines }, { data: profile }] = await Promise.all([
    supabase.from('production_lines').select('*').order('name'),
    supabase.from('profiles').select('production_line_id').eq('id', user.id).maybeSingle(),
  ])

  const defaultLineId = profile?.production_line_id ?? ''

  return (
    // A class pair, not the inline style this used to carry: `min-height: 100vh` has to be
    // switched OFF for print — a vh unit there is measured against the SCREEN viewport, not the
    // sheet, which leaves a wrapper taller than the paper and a blank trailing page after the
    // last record — and an inline style cannot be overridden from a stylesheet without
    // !important on every rule that fights it. .reports-shell carries the screen half,
    // .rp-shell is what report-print.css zeroes. Same split as /pre-assembly-coverage.
    <div className="reports-shell rp-shell">
      <Nav />
      <ReportsClient
        lines={lines ?? []}
        defaultLineId={defaultLineId}
        initialFilters={reportFiltersFromParams(searchParams, defaultLineId)}
      />
    </div>
  )
}
