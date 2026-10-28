import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import StructureReviewClient from './StructureReviewClient'
import type { ProductionLine } from '@/lib/types'
// The shared shell reset for printing (nav off, padding off) and this route's own paper and
// document styles. The document styles apply on screen too — the screen IS the print preview.
import '@/app/report-print.css'
import './print.css'

/**
 * /structure-review?line=<id>&team=<id> — a printable walkthrough of one area's structure, for
 * reviewing on the floor with the area managers and marking up by hand.
 *
 * Not admin-gated: it reads structure, which anyone signed in may read, and it is meant to be run
 * by whoever is doing the review. Config → Sections links here carrying its line and team filters;
 * the query string makes any one area's review bookmarkable.
 *
 * Every production line is offered, pre-assembly areas included, with no special case: a
 * pre-assembly area's walk is the same shape as a build line's.
 */
export default async function StructureReviewPage({ searchParams }: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: lines } = await supabase.from('production_lines').select('id, name, is_pre_assembly, created_at').order('name')
  const param = (key: string) => {
    const value = searchParams[key]
    return typeof value === 'string' ? value : ''
  }

  return (
    <div className="sr-shell rp-shell">
      <Nav />
      <StructureReviewClient
        lines={(lines ?? []) as ProductionLine[]}
        initialLineId={param('line')}
        initialTeamId={param('team')}
      />
    </div>
  )
}
