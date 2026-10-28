import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllChunked, fetchAllRows, READ_CHUNK, type RangeableQuery } from './supabaseRead'
import { selectCountedTimes } from './operationTimes'
import { fetchLinksForOperations } from './modelOperations'
import { groupSectionsByTeam, isSectionTray } from './sections'

/**
 * The Structure Review — a whole area's walk (Team → Section → Job → Operation) with, against
 * every operation, how many times were recorded, what they add up to, and how many models it is
 * linked to. Printed by /structure-review and taken onto the floor to be marked up by hand.
 *
 * ── The fan-out trap ──────────────────────────────────────────────────────────────────────
 * Times and model links are BOTH one-to-many off an operation. Read them in one joined pass and
 * every time is repeated once per model link, so the sums multiply by the link count — a SQL
 * version of this report once showed 25,466 minutes on Caravan where the truth was 9,222. So
 * they are two separate reads here, each aggregated to one number per operation_id on its own,
 * and only those per-operation numbers ever meet. The `avg × times = total` identity holds by
 * construction (avg is total / times over the same rows), which is the check that catches a
 * fan-out if one is ever reintroduced.
 *
 * ── What counts ───────────────────────────────────────────────────────────────────────────
 * Times: lib/operationTimes' selectCountedTimes, i.e. onlyCountedTimes — the record, its
 * operation and its job are live and the record isn't hidden. No second definition here.
 * Structure: live sections (is_active IS NOT FALSE) on the line, live jobs in them, live
 * operations under those. A "No Section" tray is included only when it holds jobs — an empty
 * tray is not structure anyone has to decide about. A job with no section at all is not on the
 * walk and is not in the document.
 *
 * Every operation counts in Times — current and superseded alike. That is deliberate and is what
 * the document means by "how many separate recordings exist"; the app's own labour figures take
 * the CURRENT record (see operationTimes' OperationTimeStat), not this average.
 */

export interface ReviewOperation {
  id: string
  name: string
  createdAt: string
  /** Counted time records. */
  times: number
  /** Sum of their total_minutes. */
  totalMinutes: number
  /** totalMinutes / times, or null when untimed. */
  avgMinutes: number | null
  /** model_operations rows — 0 means it can never show as a gap on any model. */
  models: number
}

export interface ReviewJob {
  id: string
  name: string
  operations: ReviewOperation[]
  totalMinutes: number
  untimed: number
}

export interface ReviewSection {
  id: string
  name: string
  sortOrder: number | null
  teamId: string | null
  teamName: string
  jobs: ReviewJob[]
  operationCount: number
  totalMinutes: number
}

export interface ReviewTeam {
  key: string
  name: string
  sections: ReviewSection[]
}

export interface ReviewSummary {
  sections: number
  jobs: number
  operations: number
  minutes: number
  jobsWithNoOperations: number
  operationsWithNoTime: number
  operationsWithNoModel: number
  teams: number
}

export interface StructureReview {
  teams: ReviewTeam[]
  summary: ReviewSummary
}

interface SectionRow { id: string; name: string; team_id: string | null; sort_order: number | null }
interface JobRow { id: string; name: string; section_id: string }
interface OperationRow { id: string; name: string; job_id: string; created_at: string }
interface TimeRow { id: string; operation_id: string; total_minutes: number | null }

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

export async function fetchStructureReview(
  supabase: SupabaseClient,
  lineId: string,
  teamId: string | null,
): Promise<StructureReview> {
  // Batched end to end: one read per level, each chunked/paged over the ids of the level above.
  const [teamRes, sectionRows] = await Promise.all([
    supabase.from('teams').select('id, name').eq('production_line_id', lineId),
    fetchAllRows<SectionRow>(() => {
      let q = supabase.from('sections').select('id, name, team_id, sort_order')
        .eq('production_line_id', lineId).not('is_active', 'is', false)
      if (teamId) q = q.eq('team_id', teamId)
      return q.order('id')
    }, { table: 'sections' }),
  ])
  if (teamRes.error) throw new Error(teamRes.error.message)
  const teamNames = new Map(((teamRes.data ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]))

  const jobRows = await fetchAllChunked<JobRow>(
    sectionRows.map((s) => s.id), READ_CHUNK,
    (chunk) => supabase.from('jobs').select('id, name, section_id')
      .in('section_id', chunk).not('is_active', 'is', false).order('id'),
    { table: 'jobs' },
  )
  const operationRows = await fetchAllChunked<OperationRow>(
    jobRows.map((j) => j.id), READ_CHUNK,
    (chunk) => supabase.from('operations').select('id, name, job_id, created_at')
      .in('job_id', chunk).not('is_active', 'is', false).order('id'),
    { table: 'operations' },
  )
  const operationIds = operationRows.map((o) => o.id)

  // The two one-to-many reads, kept apart — see the fan-out note above.
  const [timeRows, links] = await Promise.all([
    fetchAllChunked<TimeRow>(
      operationIds, READ_CHUNK,
      // The select string is built from a template, so supabase-js can't infer the row type —
      // cast, as model-total's CopyToModelsPanel does.
      (chunk) => selectCountedTimes(supabase, 'id, operation_id, total_minutes')
        .in('operation_id', chunk).order('id') as unknown as RangeableQuery<TimeRow>,
      { table: 'operation_times' },
    ),
    fetchLinksForOperations(supabase, operationIds),
  ])

  const timesByOp = new Map<string, { count: number; minutes: number }>()
  for (const t of timeRows) {
    const agg = timesByOp.get(t.operation_id) ?? { count: 0, minutes: 0 }
    agg.count += 1
    agg.minutes += t.total_minutes ?? 0
    timesByOp.set(t.operation_id, agg)
  }
  const modelsByOp = new Map<string, number>()
  for (const l of links) modelsByOp.set(l.operation_id, (modelsByOp.get(l.operation_id) ?? 0) + 1)

  const opsByJob = new Map<string, ReviewOperation[]>()
  for (const o of operationRows) {
    const agg = timesByOp.get(o.id)
    const op: ReviewOperation = {
      id: o.id,
      name: o.name,
      createdAt: o.created_at,
      times: agg?.count ?? 0,
      totalMinutes: agg?.minutes ?? 0,
      avgMinutes: agg && agg.count > 0 ? agg.minutes / agg.count : null,
      models: modelsByOp.get(o.id) ?? 0,
    }
    opsByJob.set(o.job_id, [...(opsByJob.get(o.job_id) ?? []), op])
  }

  const jobsBySection = new Map<string, ReviewJob[]>()
  for (const j of jobRows) {
    const operations = (opsByJob.get(j.id) ?? []).sort(byName)
    const job: ReviewJob = {
      id: j.id,
      name: j.name,
      operations,
      totalMinutes: operations.reduce((sum, o) => sum + o.totalMinutes, 0),
      untimed: operations.filter((o) => o.times === 0).length,
    }
    jobsBySection.set(j.section_id, [...(jobsBySection.get(j.section_id) ?? []), job])
  }

  const teamName = (id: string | null) => (id ? teamNames.get(id) : null) ?? 'No team'
  const inScope = sectionRows.filter((s) => !isSectionTray(s) || (jobsBySection.get(s.id)?.length ?? 0) > 0)

  // Team first, then the line's sort_order within it — sort_order is one line-wide sequence, so
  // ordering by it alone would fragment each team's span. The same grouping /config uses.
  const teams: ReviewTeam[] = groupSectionsByTeam(inScope, teamName).map((group) => ({
    key: group.key,
    name: group.name,
    sections: group.sections.map((s) => {
      const jobs = (jobsBySection.get(s.id) ?? []).sort(byName)
      return {
        id: s.id,
        name: s.name,
        sortOrder: s.sort_order,
        teamId: s.team_id,
        teamName: group.name,
        jobs,
        operationCount: jobs.reduce((n, j) => n + j.operations.length, 0),
        totalMinutes: jobs.reduce((sum, j) => sum + j.totalMinutes, 0),
      }
    }),
  }))

  const sections = teams.flatMap((t) => t.sections)
  const jobs = sections.flatMap((s) => s.jobs)
  const operations = jobs.flatMap((j) => j.operations)
  return {
    teams,
    summary: {
      sections: sections.length,
      jobs: jobs.length,
      operations: operations.length,
      minutes: operations.reduce((sum, o) => sum + o.totalMinutes, 0),
      jobsWithNoOperations: jobs.filter((j) => j.operations.length === 0).length,
      operationsWithNoTime: operations.filter((o) => o.times === 0).length,
      operationsWithNoModel: operations.filter((o) => o.models === 0).length,
      teams: teams.length,
    },
  }
}

/** A fixed list rather than toLocaleDateString: en-AU abbreviates September to "Sept". */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "31-Aug" — the Added column. Day then short month, no year. */
export function fmtAddedDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getDate()}-${MONTHS[d.getMonth()]}`
}
