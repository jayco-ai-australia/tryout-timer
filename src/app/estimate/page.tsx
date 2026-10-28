import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Nav from '@/components/Nav'
import EstimateClient, { type EstimateTarget } from './EstimateClient'
import { fetchAllRows } from '@/lib/supabaseRead'
import type { ProductionLine } from '@/lib/types'

/**
 * /estimate — fill in a job's times across a range of models from the ones that were measured.
 *
 * Reached from the Collecting nav and from an untimed Labour Matrix cell, which links here as
 * `?job=<id>&model=<id>`. Only the job and the model travel in the URL: the line and section are
 * resolved here from the job itself, so the link can't name a section the job isn't in.
 *
 * Not admin-gated: anyone who can record a time on /collect can record an estimate, and every
 * write goes through the same writers under the same RLS.
 */
export default async function EstimatePage({ searchParams }: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const lines = await fetchAllRows<ProductionLine>(
    () => supabase.from('production_lines').select('*').order('name'),
    { table: 'production_lines' },
  )

  const param = (key: string) => {
    const v = searchParams[key]
    return typeof v === 'string' && v ? v : null
  }
  const jobId = param('job')
  let target: EstimateTarget | null = null
  if (jobId) {
    const { data: job } = await supabase
      .from('jobs').select('id, section_id, production_line_id').eq('id', jobId).maybeSingle()
    if (job) {
      let lineId = (job.production_line_id as string | null) ?? null
      if (job.section_id) {
        const { data: section } = await supabase
          .from('sections').select('production_line_id').eq('id', job.section_id).maybeSingle()
        lineId = (section?.production_line_id as string | null) ?? lineId
      }
      target = {
        lineId: lineId ?? '',
        sectionId: (job.section_id as string | null) ?? '',
        jobId: job.id as string,
        productId: param('model'),
      }
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Nav />
      {/* Keyed on the target so a second Matrix click while the page is open re-seeds the
          selection instead of being ignored by state that has already initialised. */}
      <EstimateClient
        key={target ? `${target.jobId}:${target.productId ?? ''}` : 'none'}
        lines={lines}
        userId={user.id}
        target={target}
      />
    </div>
  )
}
