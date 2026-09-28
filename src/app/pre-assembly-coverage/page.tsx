import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import PreAssemblyCoverageClient from './PreAssemblyCoverageClient'
// The shared print treatment (shell reset, hairline tables, fragmentation) and this route's
// own paper. Split because @page cannot be scoped by selector — see both files.
import '@/app/report-print.css'
import './print.css'

/**
 * /pre-assembly-coverage — a printable coverage report per pre-assembly area.
 *
 * Not admin-gated: it reports on what has been collected, which anyone signed in may read. The
 * middleware already turns an anonymous request away; the redirect below is the belt to its
 * braces, matching /reports.
 *
 * Nothing is fetched here. Unlike /reports, this page has no filters to resolve from the query
 * string — its scope is fixed (every pre-assembly area, every model with a build still ahead of
 * it), so there is nothing a server round trip could pre-apply.
 */
export default async function PreAssemblyCoveragePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    // pac-shell, not an inline style: `min-height: 100vh` has to be turned OFF for print, and a
    // vh unit there is measured against the SCREEN viewport rather than the page box, which
    // leaves a shell taller than the sheet it is being printed onto. An inline style cannot be
    // overridden from the print stylesheet without !important on every rule that fights it.
    <div className="pac-shell rp-shell">
      <Nav />
      <PreAssemblyCoverageClient />
    </div>
  )
}
