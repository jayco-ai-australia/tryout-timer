import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllChunked, fetchAllRows, READ_CHUNK, type RangeableQuery } from './supabaseRead'
import {
  TIME_FLAG_COLUMNS, currentForOperation, fetchOperationTimeModelLinks, onlyCountedTimes, operationProductKey,
  type TimeRow,
} from './operationTimes'
import { fetchLinksForOperations } from './modelOperations'
import { groupSectionsByTeam, isSectionTray } from './sections'

/**
 * The Structure Review — a whole area's walk (Team → Section → Job → Operation) with, against
 * every operation, its typical labour per van, how many models that rests on and how many
 * recordings sit behind it. Printed by /structure-review and taken onto the floor to be marked
 * up by hand.
 *
 * ── The figures are the app's figures ─────────────────────────────────────────────────────
 * Nothing is summed from records here. Every figure is lib/operationTimes' currentForOperation —
 * the same per (operation, model) labour figure Model Total, the Labour Matrix and the times
 * drawer show — and this module only rolls those figures up:
 *
 *   Minutes   the AVERAGE of the operation's per-model figures — typical labour per van. Job and
 *             section minutes are the sum of their operations' averages: a typical van's job.
 *   Models    how many models have a figure (and, beside it, how many the operation is linked to)
 *   Times     how many distinct recordings make up those figures (stat.recordIds), so one record
 *             linked to forty models is one recording, not forty
 *
 * Until 28 Oct 2026 this document added up EVERY recording of an operation across every model,
 * superseded ones included, which agreed with no screen. Averaging per model is deliberate: the
 * models' figures differ (130 of Caravan's 290 operations), so a sum across them is labour for
 * the whole range, not a van, and picking one model's figure would be arbitrary. Not comparable to
 * the Labour Matrix's "across the grid", which adds every model together.
 *
 * ── The fan-out trap ──────────────────────────────────────────────────────────────────────
 * Times and model links are BOTH one-to-many off an operation. Read them in one joined pass and
 * every time is repeated once per model link, so the sums multiply by the link count — a SQL
 * version of this report once showed 25,466 minutes on Caravan where the truth was 9,222. So the
 * applies-list (model_operations) is a separate read from the times, and the times' own models
 * come from operation_time_models through the shared helper, keyed per pair.
 *
 * ── What counts ───────────────────────────────────────────────────────────────────────────
 * Times: onlyCountedTimes at the query and pickCurrent again inside currentForOperation — current,
 * live, not hidden. No second definition here.
 * Structure: live sections (is_active IS NOT FALSE) on the line, live jobs in them, live
 * operations under those. A "No Section" tray is included only when it holds jobs — an empty
 * tray is not structure anyone has to decide about. A job with no section at all is not on the
 * walk and is not in the document.
 */

export interface ReviewOperation {
  id: string
  name: string
  createdAt: string
  /** Average of the operation's current per-model figures — typical labour per van. null when
   * no model has a figure (untimed). */
  minutes: number | null
  /** Models with a figure — how many figures `minutes` averages. */
  models: number
  /** Distinct recordings behind those figures. */
  times: number
  /** model_operations rows — 0 means it can never show as a gap on any model. */
  linkedModels: number
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
      // Current, counted records only: nothing here shows history, so archived rows would be
      // fetched just for currentForOperation to drop. The minutes are the same either way.
      (chunk) => onlyCountedTimes(supabase.from('operation_times')
        .select(`id, operation_id, total_minutes, superseded_by, chassis_id, created_at, ${TIME_FLAG_COLUMNS}`)
        .in('operation_id', chunk).is('superseded_by', null))
        .order('id') as unknown as RangeableQuery<TimeRow>,
      { table: 'operation_times' },
    ),
    fetchLinksForOperations(supabase, operationIds),
  ])

  // The figures: one per (operation, model), from the shared rule. Then, per operation, the
  // average of its figures and the distinct recordings behind them.
  const timeModels = await fetchOperationTimeModelLinks(supabase, timeRows.map((t) => t.id))
  const stats = currentForOperation(timeRows, timeModels)
  const operationOf = new Map(timeRows.map((t) => [t.id, t.operation_id]))
  const pairKeysByOp = new Map<string, Set<string>>()
  for (const tm of timeModels) {
    const operationId = operationOf.get(tm.operation_time_id)
    if (!operationId) continue
    const keys = pairKeysByOp.get(operationId) ?? new Set<string>()
    keys.add(operationProductKey(operationId, tm.product_id))
    pairKeysByOp.set(operationId, keys)
  }
  const figuresByOp = new Map<string, { minutes: number | null; models: number; times: number }>()
  for (const [operationId, keys] of pairKeysByOp) {
    const figures = [...keys].map((k) => stats[k]).filter((s) => s != null)
    const recordings = new Set(figures.flatMap((s) => s.recordIds))
    figuresByOp.set(operationId, {
      minutes: figures.length > 0 ? figures.reduce((sum, s) => sum + s.minutes, 0) / figures.length : null,
      models: figures.length,
      times: recordings.size,
    })
  }
  const linkedByOp = new Map<string, number>()
  for (const l of links) linkedByOp.set(l.operation_id, (linkedByOp.get(l.operation_id) ?? 0) + 1)

  const opsByJob = new Map<string, ReviewOperation[]>()
  for (const o of operationRows) {
    const fig = figuresByOp.get(o.id)
    const op: ReviewOperation = {
      id: o.id,
      name: o.name,
      createdAt: o.created_at,
      minutes: fig?.minutes ?? null,
      models: fig?.models ?? 0,
      times: fig?.times ?? 0,
      linkedModels: linkedByOp.get(o.id) ?? 0,
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
      // A typical van's job: the sum of its operations' per-van averages.
      totalMinutes: operations.reduce((sum, o) => sum + (o.minutes ?? 0), 0),
      untimed: operations.filter((o) => o.minutes == null).length,
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
      minutes: operations.reduce((sum, o) => sum + (o.minutes ?? 0), 0),
      jobsWithNoOperations: jobs.filter((j) => j.operations.length === 0).length,
      operationsWithNoTime: operations.filter((o) => o.minutes == null).length,
      operationsWithNoModel: operations.filter((o) => o.linkedModels === 0).length,
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
