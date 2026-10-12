import type { SupabaseClient } from '@supabase/supabase-js'
import { restampTimesForJob } from './operationTimes'
import { fetchAllRows } from './supabaseRead'
import type { Section } from './types'
import { selectIn } from './chunkedIn'

/**
 * The single sections module — every screen that reads or writes `sections` (/tryouts' "Add new
 * Section" flow, /setup's section manager) goes through the helpers here, so the walk-order rules
 * (what sort_order a new section gets, how a reorder renumbers, what blocks a delete) can't drift
 * between screens.
 *
 * A section is one step of the line's walk: Production Line → Team → Section → Job → Operation.
 * Both production_line_id and team_id are NOT NULL on the table, so both are required here
 * rather than defaulted to null — an insert missing either is rejected by the database with a
 * constraint message no user can act on, which is why createSection checks them itself first.
 * That holds for the unsorted trays too: there is one per team, each with a real team_id, and
 * isSectionTray below is the ONLY way anything here tells a tray from a step of the walk.
 *
 * Only some lines have sections at all (today: Campervan does, Caravan and Motor Home don't), so
 * every caller must treat "this line has no sections" as a normal state, not an empty list to
 * scaffold over.
 */

/**
 * The system name of the tray that holds jobs nobody has sorted into a real section yet. ONE
 * TRAY PER TEAM: every team on a line has its own, and every tray carries a real team_id
 * exactly like a section does. A real `sections` row, not a virtual bucket, so a job always has
 * a section_id and never a dangling null.
 *
 * It used to be one tray per LINE, with team_id null — and that is why nothing here may detect
 * a tray by its team any more. `team_id IS NULL` now matches no tray at all: the line-level
 * null-team rows that survive the migration are empty and being retired.
 */
export const NO_SECTION_NAME = 'No Section'

/**
 * THE tray predicate — the one definition of "this row is an unsorted tray, not a step of a
 * team's walk". Everything that treats a tray differently calls this: the rename, delete and
 * merge guards below, the walk order, and the pane row on /setup, /collect and /tryouts.
 *
 * Matched on the NAME, trimmed and case-insensitively, and on nothing else. The name is what
 * the database guarantees about these rows, and the scope comes free with the row: a tray is
 * the row called "No Section" within its own (team, production line) pair, and a row already
 * carries both — so there is no second lookup to do and no line- or team-level context to pass
 * in.
 *
 * Deliberately NOT matched on team_id. Every tray has a real team now (see NO_SECTION_NAME), so
 * a `!section.team_id` test finds none of them; worse, it would catch a real section left
 * without a team and quietly make it unrenamable, undeletable and unmergeable.
 */
export function isSectionTray(section: { name: string } | null | undefined): boolean {
  return section != null && section.name.trim().toLowerCase() === NO_SECTION_NAME.toLowerCase()
}

/**
 * The unsorted tray a job belongs in: the one on this production line owned by this team.
 *
 * The team is required scope, not a refinement. A line has as many trays as it has teams, so
 * "the line's tray" is no longer a thing that exists, and asking for a line alone could only
 * guess which team's inbox to use. A caller with no team in hand — an "All teams" filter, or a
 * job being moved to a line it has no team on yet — gets the line's tray only when that line has
 * exactly one, and null otherwise. null is the honest answer there, and every caller already
 * handles it as "no tray to land in".
 */
export function findSectionTray<T extends { name: string; production_line_id: string | null; team_id: string | null }>(
  sections: T[],
  productionLineId: string | null | undefined,
  teamId?: string | null
): T | null {
  if (!productionLineId) return null
  const trays = sections.filter((s) => s.production_line_id === productionLineId && isSectionTray(s))
  if (teamId) return trays.find((s) => s.team_id === teamId) ?? null
  return trays.length === 1 ? trays[0] : null
}

/** The minimum of a section needed to place it in the line's sequence. */
export interface SectionOrderRef { id: string; name: string; sort_order: number | null }

/**
 * THE section order — the one comparator every screen sorts sections with: sort_order ascending
 * (un-numbered last), then name, then id so equal positions can never swap between loads.
 *
 * sort_order is ONE LINE-WIDE SEQUENCE, independent of team: Caravan runs 1 (CHASSIS PREP)
 * through 25 (PRE ASSEMBLE), with retired sections and the "No Section" trays parked at 99. So
 * nothing here looks at the team — not first, not as a group, not as a tie-break. It used to:
 * sort_order was numbered per team, and screens ordered team-first (by team NAME), which put
 * Quality's end-of-line Gate/Rework sections (21–23) above CHASSIS PREP (1). And the trays are no
 * longer pinned to the front; they sit where their 99 puts them, at the end.
 *
 * Used by sortSections below, and directly by /labour-matrix's Section grain and /model-total's
 * Section Detail sheet, so no screen can order sections differently from another.
 */
export function compareSections(a: SectionOrderRef, b: SectionOrderRef): number {
  const aOrder = a.sort_order ?? Number.MAX_SAFE_INTEGER
  const bOrder = b.sort_order ?? Number.MAX_SAFE_INTEGER
  if (aOrder !== bOrder) return aOrder - bOrder
  const byName = a.name.localeCompare(b.name)
  return byName !== 0 ? byName : a.id.localeCompare(b.id)
}

/** A sorted copy, in the line's sequence (compareSections). Every pane, picker and list of
 * sections goes through this. */
export function sortSections<T extends SectionOrderRef>(sections: T[]): T[] {
  return [...sections].sort(compareSections)
}

/** One team's sections, in the line's sequence. `key` is the team id, '' for "no team". */
export interface TeamSectionGroup<T> { key: string; teamId: string | null; name: string; sections: T[] }

/**
 * THE Team → Section grouping — /config's Sections table and /model-total's breakdown, so the
 * same structure reads in the same order on both.
 *
 * Team FIRST, then the line's sequence within the team (compareSections). sort_order is one
 * line-wide sequence, so sorting by it alone interleaves the teams and fragments each team's
 * span; grouping first is what keeps a team's sections together. Between teams: by where each
 * team first appears in that sequence (its first non-tray section — a tray is parked at 99 and
 * says nothing about where the team works), then name. Teams carry no sort_order of their own.
 */
export function groupSectionsByTeam<T extends SectionOrderRef & { team_id: string | null }>(
  sections: T[],
  teamName: (teamId: string | null) => string
): TeamSectionGroup<T>[] {
  const byTeam = new Map<string, T[]>()
  for (const section of sections) {
    const key = section.team_id ?? ''
    byTeam.set(key, [...(byTeam.get(key) ?? []), section])
  }
  return [...byTeam.entries()]
    .map(([key, rows]) => {
      const sorted = sortSections(rows)
      return { key, teamId: key || null, name: teamName(key || null), sections: sorted, first: sorted.find((s) => !isSectionTray(s)) ?? sorted[0] }
    })
    .sort((a, b) => compareSections(
      { id: a.key, name: a.name, sort_order: a.first.sort_order },
      { id: b.key, name: b.name, sort_order: b.first.sort_order }
    ))
    .map(({ key, teamId, name, sections: rows }) => ({ key, teamId, name, sections: rows }))
}

/** The minimum of a job needed to work out whose team it is: which section it sits in. */
export interface JobSectionRef { section_id?: string | null }

/**
 * Whose team a job's work belongs to: THE TEAM ON ITS SECTION, and nothing else.
 *
 * A section belongs to exactly one team, and a job belongs to exactly one section — so the
 * section is the only thing that has to be asked. jobs.team_id still exists in the database and
 * is still kept in sync on every write (see setJobSection), but it is redundant, it can lag
 * behind a section move, and nothing in the app reads it to decide what to show or filter.
 *
 * Returns null for a job with no section at all, and for a job whose section isn't in the
 * caller's map — "this job's team isn't known yet", a real state rather than a failure.
 *
 * A job sitting in an unsorted tray is NOT one of those cases any more: trays carry a real team
 * (see NO_SECTION_NAME), so unsorted work belongs to the team whose inbox it is sitting in and
 * shows under that team's filter. Only a job with no section_id is teamless now.
 *
 * The one definition of this rule. Everything that shows or filters a job's team goes through
 * it: the pane rows on /setup, /collect and /tryouts, those screens' Team filters, and the "Who
 * have I timed?" log's team filter.
 */
export function teamForJob(
  job: JobSectionRef,
  sectionsById: Map<string, { team_id: string | null }>
): string | null {
  if (!job.section_id) return null
  return sectionsById.get(job.section_id)?.team_id ?? null
}

export async function fetchSectionsForLine(supabase: SupabaseClient, productionLineId: string): Promise<Section[]> {
  const { data, error } = await supabase
    .from('sections')
    .select('*')
    .eq('production_line_id', productionLineId)
    // Merged-away sections are retired, not deleted (see mergeSections) — every read that feeds
    // a list, a pane or a picker filters them out, so they vanish from the app while their row
    // and everything that ever pointed at it survive.
    .eq('is_active', true)
    .order('sort_order')
  if (error) throw new Error(error.message)
  return sortSections((data ?? []) as Section[])
}

/**
 * Where a new section lands: the end of the LINE's sequence, whatever team it is on.
 *
 * sort_order is one line-wide sequence (see compareSections), so the max is read across the
 * whole line, not within the team. It used to be read per team, which gave a new section a
 * number from its own team's short list and dropped it into the middle of the line.
 *
 * The max is taken over ACTIVE, NON-TRAY sections only. Retired sections and the "No Section"
 * trays are parked at 99, outside the sequence, and counting them would put every new section at
 * 100, behind the trays. Reads the max rather than counting rows, so a gap in the sequence can't
 * produce a duplicate.
 */
export async function nextSectionSortOrder(supabase: SupabaseClient, productionLineId: string): Promise<number> {
  const rows = await fetchSectionsForLine(supabase, productionLineId)
  const numbers = rows.filter((r) => !isSectionTray(r)).map((r) => r.sort_order ?? 0)
  return (numbers.length > 0 ? Math.max(...numbers) : 0) + 1
}

export interface CreateSectionInput {
  name: string
  productionLineId: string
  /** NOT NULL on the table — a section always belongs to a team. */
  teamId: string
}

/** The only function anywhere that inserts into `sections`. */
export async function createSection(supabase: SupabaseClient, input: CreateSectionInput): Promise<Section> {
  const name = input.name.trim()
  if (!name) throw new Error('Section name must not be empty')
  if (!input.productionLineId) throw new Error('A section needs a production line')
  if (!input.teamId) throw new Error('Pick a team for this section — every section belongs to one')
  // Each team already has exactly one tray on the line. A second one named the same would be
  // indistinguishable from it and would split that team's unsorted jobs across two inboxes.
  if (isSectionTray({ name })) {
    throw new Error(`"${NO_SECTION_NAME}" is the name of the team's unsorted tray — pick another name.`)
  }

  const sortOrder = await nextSectionSortOrder(supabase, input.productionLineId)

  const { data, error } = await supabase
    .from('sections')
    .insert({ name, production_line_id: input.productionLineId, team_id: input.teamId, sort_order: sortOrder })
    .select('*')
    .single()
  if (error || !data) throw new Error(error?.message ?? 'Could not create section')
  return data as Section
}

/** The only function anywhere that updates sections.name. */
export async function renameSection(supabase: SupabaseClient, sectionId: string, name: string): Promise<Section> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Section name must not be empty')
  if (isSectionTray({ name: trimmed })) {
    throw new Error(`"${NO_SECTION_NAME}" is reserved for a team's unsorted tray — pick another name.`)
  }

  // A tray is what every one of its team's unsorted jobs points at; renaming it would strand
  // those jobs under a section nothing recognises as the inbox. The panes hide the control, and
  // this refuses it outright — the UI is not the only way in. Asked of the NAME through the
  // shared predicate: the row's team says nothing about whether it is a tray any more.
  const { data: subject } = await supabase.from('sections').select('name').eq('id', sectionId).single()
  if (isSectionTray(subject)) {
    throw new Error(`"${NO_SECTION_NAME}" is a team's unsorted tray and can't be renamed.`)
  }

  const { data, error } = await supabase
    .from('sections').update({ name: trimmed }).eq('id', sectionId).select('*')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error('That section could not be renamed — the change was rejected by the database (check your permissions).')
  }
  return data[0] as Section
}

/**
 * Renumbers a line's sequence to the given order, writing sort_order = 1..n. Only rows whose
 * number actually changes are written. Hand it the WHOLE line's active, non-tray sections —
 * moveSection does; a subset (one team's) would be renumbered 1..n on top of everyone else's
 * numbers, which is the per-team sequence this replaced.
 *
 * Renumbering the whole list — rather than swapping two rows' sort_order values — is deliberate:
 * existing data has sections with null or duplicated sort_order, and a value swap between two of
 * those is a no-op that silently leaves the order unchanged.
 */
export async function reorderSections(
  supabase: SupabaseClient, orderedSections: Section[],
  /** The numbers to hand out, in order, instead of 1..n. moveSection passes the line's existing
   * numbers so a move keeps them (gaps included) and only re-deals them. */
  numbers?: number[],
): Promise<void> {
  for (let i = 0; i < orderedSections.length; i++) {
    const section = orderedSections[i]
    const target = numbers?.[i] ?? i + 1
    if (section.sort_order === target) continue
    const { data, error } = await supabase
      .from('sections').update({ sort_order: target }).eq('id', section.id).select('id')
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) {
      throw new Error(`"${section.name}" could not be reordered — the change was rejected by the database (check your permissions).`)
    }
  }
}

/**
 * Moves one section one place up or down and writes a LINE-WIDE sequence.
 *
 * `visibleSections` is the list the user is looking at, which may be one team's sections (Line
 * Config, or a pane under a team filter). It decides only WHICH section this one moves past: the
 * next one up or down IN THAT LIST, so a click always visibly does something. The write itself is
 * computed from the whole line, read fresh here rather than trusted from the caller: the section
 * is taken out of the line's sequence and put back immediately before (up) or after (down) that
 * neighbour. Other teams' sections keep their relative order.
 *
 * The line's EXISTING numbers are dealt back out in the new order, so a move changes only the
 * rows between the old and new positions, and the gaps and numbering people refer to ("Rework is
 * 23") survive. Only when those numbers can't be reused (a null or a duplicate, the state
 * reorderSections exists to repair) is the line renumbered 1..n.
 *
 * Trays never move and are never renumbered. They stay at 99, outside the sequence.
 *
 * It used to renumber whatever list it was handed. Line Config handed it one team's sections, so
 * a single click rewrote that team's steps as 1..n and the line-wide sequence was gone.
 */
export async function moveSection(
  supabase: SupabaseClient, visibleSections: Section[], sectionId: string, direction: -1 | 1
): Promise<void> {
  const moving = visibleSections.find((s) => s.id === sectionId)
  if (!moving || isSectionTray(moving) || !moving.production_line_id) return
  const visible = sortSections(
    visibleSections.filter((s) => !isSectionTray(s) && s.production_line_id === moving.production_line_id)
  )
  const neighbour = visible[visible.findIndex((s) => s.id === sectionId) + direction]
  if (!neighbour) return

  const line = (await fetchSectionsForLine(supabase, moving.production_line_id)).filter((s) => !isSectionTray(s))
  const self = line.find((s) => s.id === sectionId)
  const rest = line.filter((s) => s.id !== sectionId)
  const at = rest.findIndex((s) => s.id === neighbour.id)
  if (!self || at < 0) throw new Error('The sections on this line changed since the list was loaded — reload and try again.')
  rest.splice(direction < 0 ? at : at + 1, 0, self)
  const existing = line.map((s) => s.sort_order)
  const reusable = existing.every((n, i) => n != null && (i === 0 || n > (existing[i - 1] as number)))
  await reorderSections(supabase, rest, reusable ? (existing as number[]) : undefined)
}

/** How many jobs point at this section — the guard a delete has to clear. Counted across every
 * job, not just the ones a screen currently has loaded: a job can reference a section while its
 * own production_line_id is unset, and deleting out from under it would orphan the reference. */
export async function countJobsInSection(supabase: SupabaseClient, sectionId: string): Promise<number> {
  const { count, error } = await supabase
    .from('jobs').select('id', { count: 'exact', head: true }).eq('section_id', sectionId)
  if (error) throw new Error(error.message)
  return count ?? 0
}

/**
 * The same count, SPLIT by is_active — the two numbers a delete guard has to state separately.
 *
 * countJobsInSection above answers the only question the DELETE itself cares about ("does any row
 * still point here"), and it deliberately counts retired jobs: jobs.section_id is a real
 * reference whether or not the job is listed anywhere, and a section deleted out from under one
 * would strand it.
 *
 * But every jobs pane in the app lists `is_active = true` only, so a retired job is a blocker
 * NOBODY CAN SEE. A guard that reports one number can only say "1 job still points here" about a
 * section that visibly holds none, which is an error the user cannot act on — it was the actual
 * complaint about Motor Home Team 2's "Electrical (REMOVE)" and Caravan Team 5. Both numbers, so
 * the message can name which kind is in the way and send the user to the control that reveals it.
 */
export async function countJobsInSectionByState(
  supabase: SupabaseClient, sectionId: string
): Promise<{ total: number; active: number; retired: number }> {
  // Paged (lib/supabaseRead), ordered by the primary key so the paging is sound: this returns
  // rows rather than a head-count, and a capped response would undercount the very blocker the
  // caller is hunting for.
  const rows = await fetchAllRows<{ id: string; is_active?: boolean | null }>(
    () => supabase.from('jobs').select('id, is_active').eq('section_id', sectionId).order('id'),
    { table: 'jobs' }
  )
  // `is_active !== false` rather than `=== true`: the column is nullable in this database and a
  // null has always been treated as live everywhere else (see the Job type).
  const active = rows.filter((r) => r.is_active !== false).length
  return { total: rows.length, active, retired: rows.length - active }
}

/** Job counts for a batch of sections, keyed by section id — the list-view counterpart of
 * countJobsInSection, so a section list doesn't fire one head-count request per row. */
export async function countJobsBySection(supabase: SupabaseClient, sectionIds: string[]): Promise<Record<string, number>> {
  if (sectionIds.length === 0) return {}
  // Chunked (lib/chunkedIn): one id per section on the line, unbounded in principle. Pure
  // counting, so chunk-order concatenation makes no difference to the result.
  const data = await selectIn<{ section_id: string | null }>(sectionIds, (chunk) =>
    supabase.from('jobs').select('section_id').in('section_id', chunk))
  const counts: Record<string, number> = {}
  for (const id of sectionIds) counts[id] = 0
  for (const row of data) {
    if (row.section_id) counts[row.section_id] = (counts[row.section_id] ?? 0) + 1
  }
  return counts
}

/**
 * The only function anywhere that deletes from `sections`. Deliberately deletes nothing else —
 * a section with jobs must be emptied first (see countJobsInSection), never cascaded away, because
 * jobs.section_id is the only record of which step of the walk a job belongs to.
 *
 * A delete filtered out by RLS succeeds having removed nothing, so the deleted row is read back
 * and its absence reported rather than leaving a screen to refresh into an unchanged list with
 * no explanation.
 */
export async function deleteSection(supabase: SupabaseClient, sectionId: string): Promise<void> {
  // Same reasoning as renameSection, and the same shared predicate: without its tray, a team has
  // nowhere to put a job it hasn't sorted yet, and every job already in it would be orphaned.
  const { data: subject } = await supabase.from('sections').select('name').eq('id', sectionId).single()
  if (isSectionTray(subject)) {
    throw new Error(`"${NO_SECTION_NAME}" is a team's unsorted tray and can't be deleted.`)
  }

  const { data, error } = await supabase.from('sections').delete().eq('id', sectionId).select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error('That section could not be deleted — the database rejected it, which usually means deleting sections is restricted to admins.')
  }
}

// ── Move a section to another team ─────────────────────────────────────────────────────────
// Lives in lib/sectionManager (preflightSectionMove / moveSectionAcrossTeams): one implementation
// for every screen, which moves the section across teams AND lines and re-stamps the recorded
// times under it. The same-line-only move that used to live here is gone.

/**
 * The only function anywhere that writes jobs.section_id — every assignment and every move goes
 * through here, so "what does a job's team become?" has exactly one answer.
 *
 * Takes the whole Section rather than its id because placing a job in a section is not just a
 * section_id write: a section belongs to exactly one team on exactly one line, and the job has
 * to follow it. Moving a job into another team's section moves the job to that team — including
 * into that team's unsorted tray, which owns its unsorted work exactly like any other section of
 * its. That is the whole Team → Section → Job model, enforced in one place.
 *
 * The job's operations — and their recorded times — ride along untouched: both hang off
 * job_id/operation_id, not off the section or the team, so nothing has to be migrated.
 *
 * Passing null is the legacy "no section at all" state. It still works, but callers should
 * prefer the team's tray (findSectionTray) so that every job has a real section_id — a null
 * belongs to no line and no team, so it can't be shown under either.
 */
/**
 * ── The unique constraint on jobs, and why a move trips over it ─────────────────────────────
 *
 * `jobs_name_team_id_operator_key` is UNIQUE (name, team_id, primary_operator_id). Moving a job
 * into a section owned by a different team rewrites jobs.team_id (see the payload below), so the
 * row lands in a new uniqueness bucket — and if that bucket is taken, Postgres rejects the UPDATE
 * with `23505` and a message naming the constraint.
 *
 * The raw message is unusable: it names an internal index and neither the job nor the row it
 * collided with. Worse, the row it collided with may be RETIRED — the constraint has no
 * is_active predicate, so a job merged away months ago still occupies the bucket while appearing
 * on no screen. That is the same invisible-blocker shape as the section delete guard above, and
 * the reason this error carries the conflicting rows rather than a sentence: only the caller knows
 * whether it can offer the duplicate-jobs finder, and it can only name the obstacle if it is told
 * what the obstacle is.
 *
 * This type is thrown INSTEAD of the raw error, never as well as it, so every caller either
 * handles it or shows a message that at least names the job and the team.
 */
export class JobNameConflictError extends Error {
  /** The job being moved, as the database has it. */
  readonly jobName: string
  /** The team the job would have landed on — the other half of the bucket. */
  readonly teamId: string | null
  /** Every row already in that bucket. Retired ones included, and flagged: they are invisible on
   * every pane in the app and are the case a user cannot otherwise explain. */
  readonly conflicts: { id: string; name: string; section_id: string | null; is_active?: boolean | null }[]

  constructor(args: {
    message: string
    jobName: string
    teamId: string | null
    conflicts: { id: string; name: string; section_id: string | null; is_active?: boolean | null }[]
  }) {
    super(args.message)
    this.name = 'JobNameConflictError'
    this.jobName = args.jobName
    this.teamId = args.teamId
    this.conflicts = args.conflicts
  }

  /** Whether every row in the way is retired — the case where nothing the user can see explains
   * the refusal, and the one worth saying out loud. */
  get allRetired(): boolean {
    return this.conflicts.length > 0 && this.conflicts.every((c) => c.is_active === false)
  }
}

/** Postgres unique_violation, however PostgREST chose to phrase it this week. The code is the
 * reliable half; the message test is there for the wrappers that drop `code`.
 *
 * Exported because lib/jobs' restoreJob faces the same index from the other direction — bringing a
 * retired job back can collide with a live one holding its name — and two copies of this test
 * would be two chances to stop recognising the error. */
export function isUniqueViolation(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false
  return error.code === '23505'
    || /duplicate key value violates unique constraint/i.test(error.message ?? '')
}

export async function setJobSection(supabase: SupabaseClient, jobId: string, section: Section | null): Promise<void> {
  // NOTHING CROSSES A PRODUCTION LINE. A job already on a line only moves between that line's
  // sections; no screen offers anything else, and this is the check for every other way in. A job
  // with no line yet (never filed) takes its line from the section, as it always has.
  if (section?.production_line_id) {
    const { data: current } = await supabase.from('jobs').select('name, production_line_id').eq('id', jobId).single()
    if (current?.production_line_id && current.production_line_id !== section.production_line_id) {
      throw new Error(`"${current.name}" is on a different production line from "${section.name}" — a job only moves between sections on its own line.`)
    }
  }

  const payload: Record<string, unknown> = { section_id: section?.id ?? null }
  // The section owns the team, so the job's redundant team_id is synced to whatever the section
  // says — a tray included, which now carries a real team of its own rather than null. Nothing
  // reads this column to decide what to show any more (teamForJob asks the section), but leaving
  // a stale team on a job that has been moved would keep it filed under a team that no longer
  // claims it, which is exactly the drift this model exists to end.
  if (section) payload.team_id = section.team_id ?? null
  if (section?.production_line_id) payload.production_line_id = section.production_line_id

  const { data, error } = await supabase
    .from('jobs').update(payload).eq('id', jobId).select('id')
  if (error) {
    // Two extra reads, on the failure path only: without them the caller has an index name and
    // nothing else to show. See JobNameConflictError.
    if (isUniqueViolation(error)) throw await describeJobNameConflict(supabase, jobId, section, error.message)
    throw new Error(error.message)
  }
  if (!data || data.length === 0) {
    throw new Error("That job's section could not be changed — the change was rejected by the database (check your permissions).")
  }

  // The job's recorded times carry their own copy of its team and line. Re-stamped here, in the
  // single writer, so no caller can move a job and leave its labour banked where it used to be.
  // After the job write on purpose: that is the write a constraint can refuse, and refusing it
  // must leave the times untouched.
  if (section) {
    try {
      await restampTimesForJob(supabase, jobId)
    } catch (err) {
      throw new Error(
        `The job moved to "${section.name}", but its recorded times could not all be re-stamped: ` +
        `${err instanceof Error ? err.message : 'rejected'}. Move it again to retry.`
      )
    }
  }
}

/**
 * Turns a 23505 on the jobs table into a sentence that names the job, the team and the row in the
 * way. Reads only, and only after a write has already failed.
 *
 * Deliberately tolerant of surprises: if either read comes back empty — the constraint could be on
 * a column pairing this doesn't know about — it falls back to a message that still says what was
 * attempted and still routes the user to the duplicate-jobs finder, rather than re-throwing the
 * index name it was called to replace.
 */
async function describeJobNameConflict(
  supabase: SupabaseClient, jobId: string, section: Section | null, raw: string
): Promise<JobNameConflictError> {
  const { data: subject } = await supabase.from('jobs').select('name').eq('id', jobId).single()
  const jobName = (subject as { name?: string } | null)?.name ?? 'That job'
  const teamId = section?.team_id ?? null

  let conflicts: { id: string; name: string; section_id: string | null; is_active?: boolean | null }[] = []
  if (teamId) {
    // Same name, same destination team, any state — the bucket the constraint is guarding. The
    // operator half of the key is not filtered on: the point is to show the user every row that
    // could plausibly be the obstacle, and a job matching on two of three columns is worth seeing.
    const { data } = await supabase
      .from('jobs').select('id, name, section_id, is_active')
      .eq('name', jobName).eq('team_id', teamId).neq('id', jobId)
    conflicts = (data ?? []) as typeof conflicts
  }

  const retired = conflicts.filter((c) => c.is_active === false)
  const live = conflicts.filter((c) => c.is_active !== false)

  let message: string
  if (conflicts.length === 0) {
    message =
      `${jobName} could not be moved: the database already has a job filed under that name on the ` +
      'destination team, and it enforces one job per name per team. It is not on this page — use ' +
      `Duplicate jobs to find it. (${raw})`
  } else if (live.length > 0) {
    message =
      `${jobName} could not be moved: the destination team already has a job called "${jobName}", ` +
      'and the database enforces one job per name per team. This is a genuine duplicate — merge ' +
      'the two with Duplicate jobs, or rename one of them, then move.'
  } else {
    message =
      `${jobName} could not be moved: a DELETED job called "${jobName}" is still filed on the ` +
      `destination team${retired.length > 1 ? ` (${retired.length} of them)` : ''}, and the ` +
      'database enforces one job per name per team whether or not the job has been deleted. ' +
      'Nothing on screen shows it, because deleted jobs are hidden everywhere. Either rename the ' +
      'job you are moving, or have the retired row cleared in the database — the constraint ' +
      'counts it, the app does not.'
  }

  return new JobNameConflictError({ message, jobName, teamId, conflicts })
}

// ── Merge ──────────────────────────────────────────────────────────────────────────────────
// Lives in lib/sectionManager (preflightSectionMergeInto / mergeSectionsInto): one implementation
// for every screen. It fuses same-named jobs and operations and re-stamps recorded times; the
// move-jobs-only merge that used to live here is gone.

/**
 * THE definition of "which sections may be ticked together for a merge": two sections are valid
 * partners exactly when this returns the same non-null string for both — that is, when they are
 * on the same production line. Team no longer matters: a merge re-stamps every recorded time it
 * moves, so folding a section into another team's is a stated act rather than a silent drift.
 *
 * null means the section can be neither side of a merge — an unsorted tray (asked of the shared
 * predicate), or a section with no team at all.
 */
export function sectionMergeGroupKey(section: Section): string | null {
  if (isSectionTray(section) || !section.team_id) return null
  return `line:${section.production_line_id ?? ''}`
}
