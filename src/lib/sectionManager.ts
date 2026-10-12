import type { SupabaseClient } from '@supabase/supabase-js'
import { READ_CHUNK, fetchLinksForOperations } from './modelOperations'
import { fetchAllChunked, fetchAllRows } from './supabaseRead'
import { plural } from './format'
import { restampTimesForOperations } from './operationTimes'
import { deleteOperationPermanently } from './operations'
import { NO_SECTION_NAME, deleteSection, isSectionTray, isUniqueViolation, setJobSection } from './sections'
import { deleteJobPermanently } from './jobs'
import type { Section } from './types'

/**
 * Section move and section merge — THE implementation, for every screen that offers either
 * (/setup, /line-config, /config, and the Sections pane wherever it is mounted).
 *
 * The rules, all of them:
 *
 *  1. NOTHING CROSSES A PRODUCTION LINE. A section moves between teams on its own line, and
 *     merges with sections on its own line. Both writes refuse anything else; no screen offers it.
 *  2. RECORDED TIMES ARE RE-STAMPED. operation_times carries its own team_id. Leave it behind on
 *     work that has changed team and the same minutes stay filed against the old one on every
 *     read that trusts the stamp. Every move and merge rewrites the stamp on the times it touches
 *     (lib/operationTimes' re-stamp).
 *  3. A SECTION MERGE MOVES JOBS; IT DOES NOT FUSE THEM. jobs carry no name uniqueness of any
 *     kind, so two same-named jobs sit side by side in the destination with their names
 *     untouched. Folding two jobs together is its own deliberate act — lib/jobs' mergeJobs, which
 *     is same-section only and is what fuses same-named OPERATIONS (operations ARE unique on
 *     (name, job_id)). A section merge never reaches it, and never changes a time's operation.
 *
 * The real uniqueness rules on the structure tables, for the record:
 *   teams       UNIQUE (name, production_line_id)
 *   sections    UNIQUE (name, team_id, production_line_id)   ← findSectionNameClash below
 *   operations  UNIQUE (name, job_id)                        ← lib/jobs' collision walk
 *   jobs        primary key only
 *
 * The tray rules, the single writer of jobs.section_id (setJobSection), the delete
 * (deleteSection) and the line-wide sort_order are lib/sections'.
 *
 * ── No transaction ─────────────────────────────────────────────────────────────────────────
 * Every write is its own request. Each action resolves its whole plan and checks every rule at
 * zero writes, then writes and keeps a log of what has landed. A failure stops there and throws
 * a SectionActionError carrying that log, so the screen can say exactly which steps completed.
 * Nothing is rolled back: a half-finished restructure that says what it did is something a person
 * can finish; one that guessed its way backwards is not.
 */

/** Thrown when an action stopped part-way. `completed` is every step that had already landed,
 * in order — empty when the failure was the very first write. */
export class SectionActionError extends Error {
  readonly completed: string[]

  constructor(message: string, completed: string[]) {
    super(message)
    this.name = 'SectionActionError'
    this.completed = completed
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'the write was rejected'
}

/** THE definition of "these two sections (or jobs) have the same name" on this screen: trimmed
 * and case-folded, which is wider than the database's byte-for-byte unique indexes on purpose. */
export function nameKey(name: string): string {
  return name.trim().toLowerCase()
}

/** A section already holding this name on this team, any is_active — the unique index has no
 * is_active predicate, so a merged-away section still occupies its name. */
export function findSectionNameClash<T extends { id: string; name: string; team_id: string | null }>(
  sections: T[], teamId: string, name: string, exceptId?: string
): T | null {
  const key = nameKey(name)
  return sections.find((s) => s.team_id === teamId && s.id !== exceptId && nameKey(s.name) === key) ?? null
}

// ── Counts ─────────────────────────────────────────────────────────────────────────────────

export interface SectionCounts {
  /** Live jobs. */
  jobs: number
  /** Live operations under those jobs. */
  operations: number
  /** Recorded times that COUNT (not retired, not hidden) under those operations. */
  timeRecords: number
  /** Distinct models those operations apply to. */
  models: number
}

/**
 * Every count the table shows, for every section on screen, in one batch: four bulk reads walked
 * down the hierarchy (jobs → operations → times and model links), never one request per row.
 * All paged and chunked (lib/supabaseRead) — a line's times and model links both run far past
 * the 1,000-row cap.
 *
 * LIVE ROWS ONLY, at every level. A retired job or operation is a soft delete that affects no
 * figure anywhere (lib/operationTimes' countsTowardLabour), so on this cleanup screen it is
 * simply absent: not counted, not listed, and — see the delete and retire paths below — never
 * the hidden reason something can't be done.
 */
export async function fetchSectionCounts(
  supabase: SupabaseClient, sectionIds: string[]
): Promise<Record<string, SectionCounts>> {
  const counts: Record<string, SectionCounts> = {}
  for (const id of sectionIds) counts[id] = { jobs: 0, operations: 0, timeRecords: 0, models: 0 }
  if (sectionIds.length === 0) return counts

  const jobs = (await fetchAllChunked<{ id: string; section_id: string; is_active?: boolean | null }>(
    sectionIds, READ_CHUNK,
    (chunk) => supabase.from('jobs').select('id, section_id, is_active').in('section_id', chunk).order('id'),
    { table: 'jobs' }
  )).filter((j) => j.is_active !== false)
  const sectionByJob = new Map<string, string>()
  for (const job of jobs) {
    if (!counts[job.section_id]) continue
    sectionByJob.set(job.id, job.section_id)
    counts[job.section_id].jobs++
  }

  const operations = (await fetchAllChunked<{ id: string; job_id: string; is_active?: boolean | null }>(
    [...sectionByJob.keys()], READ_CHUNK,
    (chunk) => supabase.from('operations').select('id, job_id, is_active').in('job_id', chunk).order('id'),
    { table: 'operations' }
  )).filter((o) => o.is_active !== false)
  const sectionByOperation = new Map<string, string>()
  for (const op of operations) {
    const sectionId = sectionByJob.get(op.job_id)
    if (!sectionId) continue
    sectionByOperation.set(op.id, sectionId)
    counts[sectionId].operations++
  }

  const operationIds = [...sectionByOperation.keys()]
  const [times, links] = await Promise.all([
    readLiveTimes(supabase, operationIds),
    fetchLinksForOperations(supabase, operationIds),
  ])
  for (const time of times) {
    const sectionId = sectionByOperation.get(time.operation_id)
    if (sectionId) counts[sectionId].timeRecords++
  }
  const modelsBySection = new Map<string, Set<string>>()
  for (const link of links) {
    const sectionId = sectionByOperation.get(link.operation_id)
    if (!sectionId) continue
    const set = modelsBySection.get(sectionId) ?? new Set<string>()
    set.add(link.product_id)
    modelsBySection.set(sectionId, set)
  }
  for (const [sectionId, set] of modelsBySection) counts[sectionId].models = set.size

  return counts
}

/** The time records under these operations that are themselves live — not retired, not hidden.
 * The operations handed in are already the live ones, under live jobs, so this is exactly the
 * set lib/operationTimes' countsTowardLabour counts. */
async function readLiveTimes(supabase: SupabaseClient, operationIds: string[]): Promise<{ operation_id: string }[]> {
  return fetchAllChunked<{ operation_id: string }>(
    operationIds, READ_CHUNK,
    (chunk) => supabase.from('operation_times').select('operation_id')
      .in('operation_id', chunk).not('is_active', 'is', false).eq('is_hidden', false).order('id'),
    { table: 'operation_times' }
  )
}

// ── The jobs inside one section ────────────────────────────────────────────────────────────

export interface SectionJob {
  id: string
  name: string
  section_id: string | null
  team_id: string | null
  production_line_id: string | null
  primary_operator_id: string | null
  /** Live operations under the job. */
  operations: number
  /** Recorded times that count, under those operations. */
  timeRecords: number
  /** Distinct models those operations apply to. */
  models: number
}

/**
 * The LIVE jobs filed in one section, with their counts — live operations, counted times, models.
 * Four reads for the whole section (jobs → operations → times and model links), never one per
 * job row. Retired jobs and operations are not returned at all: see fetchSectionCounts.
 */
export async function fetchSectionJobs(supabase: SupabaseClient, sectionId: string): Promise<SectionJob[]> {
  type JobRow = Omit<SectionJob, 'operations' | 'timeRecords' | 'models'> & { is_active?: boolean | null }
  const jobs = (await fetchAllRows<JobRow>(
    () => supabase.from('jobs').select('id, name, section_id, team_id, production_line_id, primary_operator_id, is_active')
      .eq('section_id', sectionId).order('id'),
    { table: 'jobs' }
  )).filter((j) => j.is_active !== false)
  const operations = (await fetchAllChunked<{ id: string; job_id: string; is_active?: boolean | null }>(
    jobs.map((j) => j.id), READ_CHUNK,
    (chunk) => supabase.from('operations').select('id, job_id, is_active').in('job_id', chunk).order('id'),
    { table: 'operations' }
  )).filter((o) => o.is_active !== false)
  const jobByOperation = new Map(operations.map((o) => [o.id, o.job_id]))
  const operationIds = operations.map((o) => o.id)
  const [times, links] = await Promise.all([
    readLiveTimes(supabase, operationIds),
    fetchLinksForOperations(supabase, operationIds),
  ])

  const rows = new Map<string, SectionJob>(jobs.map((j) => [j.id, {
    id: j.id, name: j.name, section_id: j.section_id, team_id: j.team_id,
    production_line_id: j.production_line_id, primary_operator_id: j.primary_operator_id,
    operations: 0, timeRecords: 0, models: 0,
  }]))
  for (const op of operations) { const row = rows.get(op.job_id); if (row) row.operations++ }
  for (const time of times) {
    const row = rows.get(jobByOperation.get(time.operation_id) ?? '')
    if (row) row.timeRecords++
  }
  const modelsByJob = new Map<string, Set<string>>()
  for (const link of links) {
    const jobId = jobByOperation.get(link.operation_id)
    if (!jobId) continue
    const set = modelsByJob.get(jobId) ?? new Set<string>()
    set.add(link.product_id)
    modelsByJob.set(jobId, set)
  }
  for (const [jobId, set] of modelsByJob) { const row = rows.get(jobId); if (row) row.models = set.size }

  return [...rows.values()].sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id))
}

// ── The operations inside one job ──────────────────────────────────────────────────────────

export interface JobOperation {
  id: string
  name: string
  /** Recorded times that count toward labour (not retired, not hidden), and their minutes. */
  timeRecords: number
  minutes: number
  /** Distinct models it applies to. */
  models: number
  primaryOperator: string | null
  secondaryOperator: string | null
}

export interface JobOperations {
  /** The job's LIVE operations. */
  operations: JobOperation[]
  /**
   * Its RETIRED operations — never listed, but returned because `operations` is UNIQUE on
   * (name, job_id) and that index counts them: a retired operation still owns its name, and a
   * screen that hides it has to be able to say so when the name is refused.
   */
  retired: { id: string; name: string }[]
}

/** Everything the operations pane shows for one job, in one batch: the operations, then their
 * counted times, model links and operator names together. Never one read per operation. */
export async function fetchJobOperations(supabase: SupabaseClient, jobId: string): Promise<JobOperations> {
  const all = await fetchAllRows<{
    id: string; name: string; is_active?: boolean | null
    primary_operator_id: string | null; secondary_operator_id: string | null
  }>(
    () => supabase.from('operations').select('id, name, is_active, primary_operator_id, secondary_operator_id')
      .eq('job_id', jobId).order('id'),
    { table: 'operations' }
  )
  const live = all.filter((o) => o.is_active !== false)
  const ids = live.map((o) => o.id)
  const operatorIds = [...new Set(live.flatMap((o) => [o.primary_operator_id, o.secondary_operator_id]).filter((id): id is string => !!id))]
  const [times, links, operators] = await Promise.all([
    fetchAllChunked<{ operation_id: string; total_minutes: number | null }>(
      ids, READ_CHUNK,
      (chunk) => supabase.from('operation_times').select('operation_id, total_minutes')
        .in('operation_id', chunk).not('is_active', 'is', false).eq('is_hidden', false).order('id'),
      { table: 'operation_times' }
    ),
    fetchLinksForOperations(supabase, ids),
    fetchAllChunked<{ id: string; full_name: string }>(
      operatorIds, READ_CHUNK,
      (chunk) => supabase.from('operators').select('id, full_name').in('id', chunk).order('id'),
      { table: 'operators' }
    ),
  ])
  const operatorName = new Map(operators.map((o) => [o.id, o.full_name]))
  const rows = new Map<string, JobOperation>(live.map((o) => [o.id, {
    id: o.id, name: o.name, timeRecords: 0, minutes: 0, models: 0,
    primaryOperator: o.primary_operator_id ? operatorName.get(o.primary_operator_id) ?? null : null,
    secondaryOperator: o.secondary_operator_id ? operatorName.get(o.secondary_operator_id) ?? null : null,
  }]))
  for (const t of times) {
    const row = rows.get(t.operation_id)
    if (row) { row.timeRecords++; row.minutes += t.total_minutes ?? 0 }
  }
  const models = new Map<string, Set<string>>()
  for (const l of links) {
    const set = models.get(l.operation_id) ?? new Set<string>()
    set.add(l.product_id)
    models.set(l.operation_id, set)
  }
  for (const [id, set] of models) { const row = rows.get(id); if (row) row.models = set.size }
  return {
    operations: [...rows.values()].sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id)),
    retired: all.filter((o) => o.is_active === false).map((o) => ({ id: o.id, name: o.name })),
  }
}

// ── Retired rows never block ───────────────────────────────────────────────────────────────
/**
 * A screen that hides retired rows cannot let one be the reason something is refused: a delete
 * blocked by a row nobody can see reads as a bug. So wherever a retired row would be in the way
 * it is dealt with as part of the action:
 *
 *   - holding NOTHING  → deleted outright (lib/operations' deleteOperationPermanently,
 *                        lib/jobs' deleteJobPermanently — the guarded hard deletes, unchanged).
 *   - holding SOMETHING → it comes along, still retired. Nothing recorded is ever destroyed.
 *
 * "Nothing", for a retired job, means every operation under it is itself retired and holds no
 * recorded time and no model link (or it has no operations at all).
 */
export interface SectionHoldings {
  liveJobs: number
  /** Retired jobs that hold recorded work — they move with the live ones. */
  retiredHolding: PlanJob[]
  /** Retired jobs that hold nothing — deleted rather than moved. */
  retiredEmpty: PlanJob[]
}

async function classifyJobs(supabase: SupabaseClient, jobs: PlanJob[]): Promise<SectionHoldings> {
  const retired = jobs.filter((j) => j.is_active === false)
  const operations = await fetchAllChunked<{ id: string; job_id: string; is_active?: boolean | null }>(
    retired.map((j) => j.id), READ_CHUNK,
    (chunk) => supabase.from('operations').select('id, job_id, is_active').in('job_id', chunk).order('id'),
    { table: 'operations' }
  )
  const operationIds = operations.map((o) => o.id)
  const [times, links] = await Promise.all([
    readTimes(supabase, operationIds),
    fetchLinksForOperations(supabase, operationIds),
  ])
  const holdingOperations = new Set([...times.map((t) => t.operation_id), ...links.map((l) => l.operation_id)])
  const holdingJobs = new Set(
    operations.filter((o) => o.is_active !== false || holdingOperations.has(o.id)).map((o) => o.job_id)
  )
  return {
    liveJobs: jobs.length - retired.length,
    retiredHolding: retired.filter((j) => holdingJobs.has(j.id)),
    retiredEmpty: retired.filter((j) => !holdingJobs.has(j.id)),
  }
}

/** What a section holds, split the way a delete needs it. Reads only. */
export async function inspectSection(supabase: SupabaseClient, sectionId: string): Promise<SectionHoldings> {
  return classifyJobs(supabase, await readJobs(supabase, [sectionId]))
}

/**
 * Deletes every RETIRED operation under a job that holds no recorded time and no model link.
 * Returns how many went. One that holds anything is left exactly as it is. Never throws for a
 * row it couldn't delete — this is tidying, and a refusal (a permission, say) must not turn the
 * action it follows into a failure.
 */
export async function clearEmptyRetiredOperations(supabase: SupabaseClient, jobId: string): Promise<number> {
  const operations = await fetchAllRows<{ id: string; is_active?: boolean | null }>(
    () => supabase.from('operations').select('id, is_active').eq('job_id', jobId).order('id'),
    { table: 'operations' }
  )
  let deleted = 0
  for (const op of operations) {
    if (op.is_active !== false) continue
    try {
      // The guard inside re-counts times and model links at the moment of writing.
      await deleteOperationPermanently(supabase, op.id)
      deleted++
    } catch { /* holds something, or not ours to delete — it stays */ }
  }
  return deleted
}

/** Deletes a retired job that holds nothing, clearing its empty retired operations first.
 * Returns false — leaving the job in place — if it turned out not to be empty or the delete
 * was refused. */
async function deleteEmptyRetiredJob(supabase: SupabaseClient, jobId: string): Promise<boolean> {
  try {
    await clearEmptyRetiredOperations(supabase, jobId)
    await deleteJobPermanently(supabase, jobId)
    return true
  } catch {
    return false
  }
}

/**
 * Deletes a section that holds no live job and no retired job with recorded work — clearing the
 * empty retired jobs still pointing at it first, so they are never the unseen reason it can't go.
 * Refuses (visibly) if anything turns out to need a destination; that is mergeSectionsInto's job.
 */
export async function deleteSectionClearingRetired(
  supabase: SupabaseClient, sectionId: string, { purgeEmptyRetired }: { purgeEmptyRetired: boolean }
): Promise<void> {
  const holdings = await inspectSection(supabase, sectionId)
  if (purgeEmptyRetired) {
    for (const job of holdings.retiredEmpty) await deleteEmptyRetiredJob(supabase, job.id)
  }
  const left = await readJobs(supabase, [sectionId])
  if (left.length > 0) {
    const live = left.filter((j) => j.is_active !== false).length
    throw new Error(
      live > 0
        ? `it still holds ${plural(live, 'job')} — pick a section to move ${live === 1 ? 'it' : 'them'} to`
        : `${plural(left.length, 'retired job')} still filed here could not be cleared — delete the section again and pick a section to move ${left.length === 1 ? 'it' : 'them'} to`
    )
  }
  await deleteSection(supabase, sectionId)
}

// ── Shared reads and writes ────────────────────────────────────────────────────────────────

interface PlanJob {
  id: string
  name: string
  section_id: string | null
  team_id: string | null
  primary_operator_id: string | null
  is_active?: boolean | null
}

interface TeamRef { id: string; name: string; production_line_id: string }

async function readSection(supabase: SupabaseClient, sectionId: string): Promise<Section> {
  const { data, error } = await supabase.from('sections').select('*').eq('id', sectionId).single()
  if (error || !data) throw new Error(error?.message ?? 'That section no longer exists — reload and try again.')
  return data as Section
}

async function readTeam(supabase: SupabaseClient, teamId: string): Promise<TeamRef> {
  const { data, error } = await supabase
    .from('teams').select('id, name, production_line_id').eq('id', teamId).single()
  if (error || !data) throw new Error(error?.message ?? 'That team no longer exists — reload and try again.')
  return data as TeamRef
}

/** Every job filed in these sections — deleted ones included, because jobs.section_id is a real
 * reference whatever is_active says and every one of them has to follow its section. */
async function readJobs(supabase: SupabaseClient, sectionIds: string[]): Promise<PlanJob[]> {
  return fetchAllChunked<PlanJob>(
    sectionIds, READ_CHUNK,
    (chunk) => supabase.from('jobs').select('id, name, section_id, team_id, primary_operator_id, is_active')
      .in('section_id', chunk).order('id'),
    { table: 'jobs' }
  )
}

async function readOperations(supabase: SupabaseClient, jobIds: string[]): Promise<{ id: string; job_id: string }[]> {
  return fetchAllChunked<{ id: string; job_id: string }>(
    jobIds, READ_CHUNK,
    (chunk) => supabase.from('operations').select('id, job_id').in('job_id', chunk).order('id'),
    { table: 'operations' }
  )
}

async function readTimes(
  supabase: SupabaseClient, operationIds: string[]
): Promise<{ id: string; operation_id: string; total_minutes: number | null }[]> {
  return fetchAllChunked<{ id: string; operation_id: string; total_minutes: number | null }>(
    operationIds, READ_CHUNK,
    (chunk) => supabase.from('operation_times').select('id, operation_id, total_minutes')
      .in('operation_id', chunk).order('id'),
    { table: 'operation_times' }
  )
}

function sumMinutes(times: { total_minutes: number | null }[]): number {
  return times.reduce((sum, t) => sum + (t.total_minutes ?? 0), 0)
}

// ── Move to another team ───────────────────────────────────────────────────────────────────

export interface SectionMovePlan {
  section: Section
  targetTeam: TeamRef
  activeJobCount: number
  retiredJobCount: number
  operationCount: number
  /** Recorded times under the section — every one is re-stamped with the new team. */
  timeRecordCount: number
  totalMinutes: number
  /** Why the move can't happen. null = it can. */
  blockedReason: string | null
  /** Carried from the read so the write re-stamps exactly what the plan counted. */
  operationIds: string[]
}

/**
 * Everything the Move confirm states, and everything that would refuse the write. Reads only.
 *
 * SAME PRODUCTION LINE ONLY. Nothing crosses a line — that is a business rule, not a technical
 * limit — so a team on another line is refused here outright. The dialog never offers one; this
 * is the check for every other way in.
 *
 * The one name rule is the real one: sections are UNIQUE on (name, team_id, production_line_id),
 * so a section can't join a team that already holds its name. Jobs carry no name uniqueness of
 * any kind and are never a reason to refuse.
 */
export async function preflightSectionMove(
  supabase: SupabaseClient, sectionId: string, targetTeamId: string
): Promise<SectionMovePlan> {
  const section = await readSection(supabase, sectionId)
  if (isSectionTray(section)) {
    throw new Error(`"${NO_SECTION_NAME}" is a team's unsorted tray — every team has its own, so it can't move between teams.`)
  }
  if (!targetTeamId) throw new Error('Pick the team to move this section to')
  if (section.team_id === targetTeamId) throw new Error(`"${section.name}" is already on that team`)
  const targetTeam = await readTeam(supabase, targetTeamId)
  if (targetTeam.production_line_id !== section.production_line_id) {
    throw new Error(`${targetTeam.name} is on a different production line — a section only moves between teams on its own line.`)
  }

  const { data: teamSections, error: teamSectionsErr } = await supabase
    .from('sections').select('id, name, team_id, is_active').eq('team_id', targetTeamId)
  if (teamSectionsErr) throw new Error(teamSectionsErr.message)
  const clash = findSectionNameClash(
    (teamSections ?? []) as { id: string; name: string; team_id: string | null; is_active?: boolean | null }[],
    targetTeamId, section.name, section.id
  )

  const jobs = await readJobs(supabase, [section.id])
  const operations = await readOperations(supabase, jobs.map((j) => j.id))
  const operationIds = operations.map((o) => o.id)
  const times = await readTimes(supabase, operationIds)

  const blockedReason = !clash ? null
    : clash.is_active === false
      ? `${targetTeam.name} already has a section called "${clash.name}" — a merged-away one, so it is on no ` +
        `screen, but it still holds the name. Rename "${section.name}" first, then move it.`
      : `${targetTeam.name} already has a section called "${clash.name}". Two sections of the same name on one ` +
        `team is what Merge is for — merge "${section.name}" into it instead of moving it.`

  const activeJobCount = jobs.filter((j) => j.is_active !== false).length
  return {
    section, targetTeam,
    activeJobCount, retiredJobCount: jobs.length - activeJobCount,
    operationCount: operations.length,
    timeRecordCount: times.length, totalMinutes: sumMinutes(times),
    blockedReason, operationIds,
  }
}

export interface SectionMoveResult {
  plan: SectionMovePlan
  completed: string[]
}

/**
 * Moves a section to another team ON ITS OWN LINE, and keeps the copies of its team in step:
 * operation_times.team_id (re-stamped, with the line it already had), jobs.team_id and the
 * section itself. Deepest first, so the row every screen navigates by — the section — only
 * changes once everything under it already agrees with where it is going. sort_order is kept:
 * it is one line-wide sequence, and the section has not left the line.
 */
export async function moveSectionAcrossTeams(
  supabase: SupabaseClient, sectionId: string, targetTeamId: string
): Promise<SectionMoveResult> {
  // Re-read, not the confirm's copy: this is the plan that actually runs.
  const plan = await preflightSectionMove(supabase, sectionId, targetTeamId)
  if (plan.blockedReason) throw new Error(plan.blockedReason)
  const { section, targetTeam } = plan
  const completed: string[] = []

  try {
    if (plan.timeRecordCount > 0) {
      const n = await restampTimesForOperations(
        supabase, plan.operationIds, { teamId: targetTeam.id, productionLineId: targetTeam.production_line_id }
      )
      completed.push(`Re-stamped ${plural(n, 'recorded time')} to ${targetTeam.name}`)
    }

    const jobTotal = plan.activeJobCount + plan.retiredJobCount
    if (jobTotal > 0) {
      const { count, error } = await supabase
        .from('jobs')
        .update({ team_id: targetTeam.id, production_line_id: targetTeam.production_line_id }, { count: 'exact' })
        .eq('section_id', section.id)
      if (error) throw new Error(`updating its jobs failed: ${error.message}`)
      if ((count ?? 0) < jobTotal) {
        throw new Error(`only ${count ?? 0} of its ${plural(jobTotal, 'job')} could be updated (check your permissions)`)
      }
      completed.push(`Moved ${plural(jobTotal, 'job')} to ${targetTeam.name}`)
    }

    const { data, error } = await supabase
      .from('sections').update({ team_id: targetTeam.id }).eq('id', section.id).select('id')
    if (error) {
      throw new Error(isUniqueViolation(error)
        ? `${targetTeam.name} already has a section called "${section.name}"`
        : `updating the section failed: ${error.message}`)
    }
    if (!data || data.length === 0) {
      throw new Error('the section itself could not be updated — the change was rejected by the database (check your permissions)')
    }
    completed.push(`Moved section "${section.name}" to ${targetTeam.name}`)
  } catch (err) {
    throw new SectionActionError(`Moving "${section.name}" to ${targetTeam.name} stopped: ${messageOf(err)}.`, completed)
  }

  return { plan, completed }
}

// ── Merge (and reassign-then-delete, which is the same thing) ──────────────────────────────

export interface SectionMergePlan {
  destination: Section
  destinationTeam: TeamRef
  sources: Section[]
  /** Every job that moves: the live ones, and any retired job that still holds recorded work.
   * None is combined. */
  movingJobs: PlanJob[]
  /** Of those, the retired ones — the one line the confirm adds, and only when there are any. */
  retiredMovingCount: number
  /** Retired jobs holding nothing, which are deleted instead of moved. Only ever non-empty when
   * the caller asked for `purgeEmptyRetired`. */
  purgingJobs: PlanJob[]
  /**
   * Names that will appear more than once in the destination afterwards — a moving job landing
   * beside a job of the same name (trimmed, case-insensitive). Information, not a problem: jobs
   * carry no name uniqueness, both keep their names exactly as they are, and merging them is a
   * separate, deliberate act (lib/jobs' mergeJobs).
   */
  sameNameJobCount: number
  sameNameJobNames: string[]
  /** Every recorded time under the source sections. None changes operation. */
  affectedTimeCount: number
  affectedMinutes: number
  /** Of those, the ones under a source section on a DIFFERENT TEAM from the destination — their
   * team stamp changes. (setJobSection re-stamps every moved job's times; these are the ones
   * whose stamp ends up different.) */
  restampTimeCount: number
}

/**
 * What merging these sections into the destination would do. Reads only — it is what the confirm
 * states, and what the write replays.
 *
 * A section merge MOVES JOBS AND NOTHING ELSE. No job is fused with another and no operation is
 * touched, so no recorded time changes operation. Same-named jobs end up side by side; the plan
 * names them so the confirm can say so.
 *
 * SAME PRODUCTION LINE ONLY — a source on another line is refused. Another team on the same
 * line is fine, and is why the moved times are re-stamped.
 */
export async function preflightSectionMergeInto(
  supabase: SupabaseClient,
  { destinationId, sourceIds, purgeEmptyRetired = false }: {
    destinationId: string; sourceIds: string[]
    /** Delete the source sections' EMPTY retired jobs instead of carrying them across — for a
     * screen that hides retired rows and may delete permanently. Left off, every job moves. */
    purgeEmptyRetired?: boolean
  }
): Promise<SectionMergePlan> {
  const ids = [...new Set(sourceIds)]
  if (ids.length === 0) throw new Error('Pick at least one section to merge')
  if (ids.includes(destinationId)) throw new Error('A section can’t be merged into itself.')

  const destination = await readSection(supabase, destinationId)
  const sources: Section[] = []
  for (const id of ids) sources.push(await readSection(supabase, id))

  if (isSectionTray(destination)) {
    throw new Error(`"${NO_SECTION_NAME}" is a team's unsorted tray, not a step of the walk — it can't be merged into.`)
  }
  if (destination.is_active === false) throw new Error(`"${destination.name}" has been merged away — pick a live section.`)
  if (!destination.team_id || !destination.production_line_id) {
    throw new Error(`"${destination.name}" has no team or line, so nothing can safely be merged into it.`)
  }
  for (const source of sources) {
    if (isSectionTray(source)) {
      throw new Error(`"${NO_SECTION_NAME}" is a team's unsorted tray — it can't be merged away or deleted.`)
    }
    if (source.production_line_id !== destination.production_line_id) {
      throw new Error(`"${source.name}" is on a different production line from "${destination.name}" — sections only merge within one line.`)
    }
  }
  const destinationTeam = await readTeam(supabase, destination.team_id)

  const sourceJobs = await readJobs(supabase, ids)
  const purgingJobs = purgeEmptyRetired ? (await classifyJobs(supabase, sourceJobs)).retiredEmpty : []
  const purgingIds = new Set(purgingJobs.map((j) => j.id))
  const movingJobs = sourceJobs.filter((j) => !purgingIds.has(j.id))
  const destinationJobs = await readJobs(supabase, [destination.id])

  // Live names only, on both sides: a retired job is on no screen, so it is not something a
  // moving job will be seen "alongside". Counted against the destination's own jobs AND the
  // other arrivals — two sources both holding "Fit Hatches" land side by side just the same.
  const seen = new Map<string, { name: string; count: number }>()
  for (const job of destinationJobs) {
    if (job.is_active === false) continue
    const key = nameKey(job.name)
    seen.set(key, { name: seen.get(key)?.name ?? job.name, count: (seen.get(key)?.count ?? 0) + 1 })
  }
  let sameNameJobCount = 0
  const sameNames = new Set<string>()
  for (const job of movingJobs) {
    if (job.is_active === false) continue
    const key = nameKey(job.name)
    const entry = seen.get(key)
    if (entry) { sameNameJobCount++; sameNames.add(entry.name); entry.count++ }
    else seen.set(key, { name: job.name, count: 1 })
  }

  const operations = await readOperations(supabase, movingJobs.map((j) => j.id))
  const times = await readTimes(supabase, operations.map((o) => o.id))
  const otherTeamSections = new Set(sources.filter((s) => s.team_id !== destination.team_id).map((s) => s.id))
  const otherTeamJobs = new Set(movingJobs.filter((j) => j.section_id && otherTeamSections.has(j.section_id)).map((j) => j.id))
  const otherTeamOperations = new Set(operations.filter((o) => otherTeamJobs.has(o.job_id)).map((o) => o.id))

  return {
    destination, destinationTeam, sources, movingJobs,
    retiredMovingCount: movingJobs.filter((j) => j.is_active === false).length,
    purgingJobs,
    sameNameJobCount,
    sameNameJobNames: [...sameNames].sort((a, b) => a.localeCompare(b)),
    affectedTimeCount: times.length, affectedMinutes: sumMinutes(times),
    restampTimeCount: times.filter((t) => otherTeamOperations.has(t.operation_id)).length,
  }
}

export interface SectionMergeOutcome {
  plan: SectionMergePlan
  completed: string[]
  /** Source sections removed — every one of them, once its jobs have moved. */
  deletedSections: string[]
}

/**
 * Merges the source sections into the destination: every job moves across as it is, and the
 * emptied sources are deleted. Delete-with-jobs is this function with one source and a picked
 * destination.
 *
 * Every move goes through lib/sections' setJobSection — the single writer of jobs.section_id —
 * which syncs the job's team and line from the destination and re-stamps the recorded times
 * under it. Nothing here writes to operations or to operation_times.operation_id.
 */
export async function mergeSectionsInto(
  supabase: SupabaseClient,
  args: { destinationId: string; sourceIds: string[]; purgeEmptyRetired?: boolean }
): Promise<SectionMergeOutcome> {
  // Re-read, not the confirm's copy: this is the plan that actually runs.
  const plan = await preflightSectionMergeInto(supabase, args)
  const { destination } = plan
  const completed: string[] = []
  const deletedSections: string[] = []

  try {
    // Empty retired jobs go rather than move. One that can't be deleted after all (it gained
    // something, or the delete was refused) simply moves with the rest — it never blocks.
    const moving = [...plan.movingJobs]
    for (const job of plan.purgingJobs) {
      if (!(await deleteEmptyRetiredJob(supabase, job.id))) moving.push(job)
    }

    let moved = 0
    try {
      for (const job of moving) {
        try {
          await setJobSection(supabase, job.id, destination)
        } catch (err) {
          throw new Error(`moving job "${job.name}" failed: ${messageOf(err)}`)
        }
        moved++
      }
    } finally {
      if (moved > 0) completed.push(`Moved ${plural(moved, 'job')} into "${destination.name}"`)
    }

    for (const source of plan.sources) {
      // Proved empty before it goes: a job filed here since the dialog opened was not part of
      // this merge, and deleting the section out from under it would orphan it.
      const remaining = await fetchAllRows<{ id: string }>(
        () => supabase.from('jobs').select('id').eq('section_id', source.id).order('id'),
        { table: 'jobs' }
      )
      if (remaining.length > 0) {
        throw new Error(
          `"${source.name}" still holds ${plural(remaining.length, 'job')} that ${remaining.length === 1 ? 'was' : 'were'} not part of this merge ` +
          '(filed there since the dialog opened?), so it was left in place'
        )
      }
      await deleteSection(supabase, source.id)
      deletedSections.push(source.name)
      completed.push(`Deleted section "${source.name}"`)
    }
  } catch (err) {
    throw new SectionActionError(`Merging into "${destination.name}" stopped: ${messageOf(err)}.`, completed)
  }

  return { plan, completed, deletedSections }
}
