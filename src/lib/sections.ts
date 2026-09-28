import type { SupabaseClient } from '@supabase/supabase-js'
import { READ_CHUNK, chunked } from './modelOperations'
import { fetchAllChunked, fetchAllRows } from './supabaseRead'
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

/**
 * Walk order: unsorted trays first, then sort_order ascending with un-numbered sections last,
 * and name — then id — as tie-breaks so the list can never flip around between renders.
 *
 * A tray is pinned to the front here rather than left to its sort_order — it is the inbox, and a
 * walk starts by clearing what hasn't been sorted yet. Pinning it in the comparator means it
 * lands first even if a row's sort_order was never set to 0.
 *
 * An unfiltered line now yields SEVERAL trays, one per team, which every tie-break above ties on
 * (same name, same sort_order 0). The id tie-break is what keeps their order stable between
 * renders; the pane tells them apart by showing each tray's team.
 */
export function sortSections(sections: Section[]): Section[] {
  return [...sections].sort((a, b) => {
    const aTray = isSectionTray(a)
    const bTray = isSectionTray(b)
    if (aTray !== bTray) return aTray ? -1 : 1
    const aOrder = a.sort_order ?? Number.MAX_SAFE_INTEGER
    const bOrder = b.sort_order ?? Number.MAX_SAFE_INTEGER
    if (aOrder !== bOrder) return aOrder - bOrder
    const byName = a.name.localeCompare(b.name)
    return byName !== 0 ? byName : a.id.localeCompare(b.id)
  })
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
 * Where a new section lands in that TEAM's walk: the end of it.
 *
 * Sort order is per team, not per line. Each team on the line numbers its own steps from 1 with
 * its tray at 0, so the max has to be read within the team as well as the line — scoped to the
 * line alone, a new section on a quiet team would inherit a number from the busiest team on the
 * line and land far past its own last step. (Scoping to the line was safe only while a line had
 * one tray and one walk; it has one walk per team now.)
 *
 * Reads the current max rather than counting rows, so a gap in sort_order (or a deleted section)
 * can't produce a duplicate.
 *
 * Deliberately NOT filtered to is_active: a retired section still holds its sort_order, and
 * ignoring it here would hand its number to a new section. Two rows sharing a number is exactly
 * the state reorderSections exists to repair, and a merged-away section could be reactivated in
 * the database at any time.
 */
export async function nextSectionSortOrder(
  supabase: SupabaseClient, productionLineId: string, teamId: string
): Promise<number> {
  const { data, error } = await supabase
    .from('sections')
    .select('sort_order')
    .eq('production_line_id', productionLineId)
    .eq('team_id', teamId)
    .order('sort_order', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  return ((data?.[0]?.sort_order as number | null) ?? 0) + 1
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

  const sortOrder = await nextSectionSortOrder(supabase, input.productionLineId, input.teamId)

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
 * Renumbers a line's sections to the given order, writing sort_order = 1..n. Only rows whose
 * number actually changes are written.
 *
 * Renumbering the whole list — rather than swapping two rows' sort_order values — is deliberate:
 * existing data has sections with null or duplicated sort_order, and a value swap between two of
 * those is a no-op that silently leaves the order unchanged.
 */
export async function reorderSections(supabase: SupabaseClient, orderedSections: Section[]): Promise<void> {
  for (let i = 0; i < orderedSections.length; i++) {
    const section = orderedSections[i]
    const target = i + 1
    if (section.sort_order === target) continue
    const { data, error } = await supabase
      .from('sections').update({ sort_order: target }).eq('id', section.id).select('id')
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) {
      throw new Error(`"${section.name}" could not be reordered — the change was rejected by the database (check your permissions).`)
    }
  }
}

/** Moves one section one place up or down the walk and writes the resulting order. Returns the
 * new order so a caller can render it without a re-fetch. */
export async function moveSection(supabase: SupabaseClient, sections: Section[], sectionId: string, direction: -1 | 1): Promise<Section[]> {
  const ordered = sortSections(sections)
  const index = ordered.findIndex((s) => s.id === sectionId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= ordered.length) return ordered

  const next = [...ordered]
  ;[next[index], next[target]] = [next[target], next[index]]
  await reorderSections(supabase, next)
  return next.map((s, i) => ({ ...s, sort_order: i + 1 }))
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
/**
 * Section merge: fold several sections' jobs into one keeper and retire the emptied ones.
 *
 * ONE primitive per level of the walk, and the user composes them. This one moves JOBS and
 * nothing else — it repoints jobs.section_id and stops. Operations, recorded times, notes and
 * model links all hang off job_id/operation_id rather than off the section, so they follow their
 * job with nothing to migrate, exactly as setJobSection's own note describes.
 *
 * NO TIME-OWNERSHIP GUARD, deliberately — and this is a change from how it used to work. An
 * earlier version ran lib/mergeOperations' preflightMerge over every time under the section and
 * refused the merge if any belonged to another user. That guard exists because an OPERATION
 * merge moves operation_times rows, and a time collected by somebody else is not ours to move. A
 * section merge never touches operation_times: it writes jobs.section_id and sections.is_active,
 * both of which are structure, not somebody's recorded work. Refusing to tidy two duplicate
 * sections because two collectors had timed work somewhere underneath them blocked exactly the
 * cleanup this exists for. The guard belongs one — in fact two — levels down, and stays there.
 *
 * It deliberately does NOT fuse same-named jobs. If both sections hold a "Fit Hatches", the
 * keeper ends up with two jobs called "Fit Hatches" sitting side by side, and the user folds
 * them together afterwards with a job merge. No name matching, no dedupe, no case-insensitive
 * comparison anywhere in the write path — guessing that two same-named jobs are the same work is
 * exactly the kind of silent decision this codebase makes the user take explicitly. The one place
 * names are compared at all is the preflight's `duplicateNames`, which exists solely so the
 * confirmation can warn that a follow-up job merge is coming, and it compares names literally.
 *
 * SAME TEAM ONLY. A section belongs to exactly one team and a job's team IS its section's team
 * (see teamForJob), so merging across teams would silently re-team every job that moved. The
 * pane's selection (built from sectionMergeGroupKey) never offers a cross-team row and
 * mergeSections refuses one
 * outright — the UI is not the only way in. Because the team can't change, jobs.team_id — legacy
 * and redundant, but still written by setJobSection — comes out of the merge holding the value it
 * went in with.
 *
 * The merged-away sections are SOFT-deleted (is_active = false), never dropped: sort_order,
 * created_at and the rows themselves survive, and reactivating one in the database brings it back
 * (empty — its jobs stay where the merge put them).
 */

/** An unsorted tray can be neither side of a merge. Merging it away leaves its team with no
 * inbox for unsorted work; merging INTO it would file sorted work back as unsorted. Asked of the
 * shared predicate, so this can't drift from what the pane offers. */
function assertMergeable(section: Section, role: 'keeper' | 'merged'): void {
  if (isSectionTray(section)) {
    throw new Error(
      `"${NO_SECTION_NAME}" is a team's unsorted tray, not a step of the walk — it can't be ` +
      (role === 'merged' ? 'merged away.' : 'merged into.')
    )
  }
}

/**
 * THE definition of "which sections may be merged together": two sections are valid partners
 * exactly when this returns the same non-null string for both.
 *
 * null means the section can be neither side of a merge — an unsorted tray (asked of the shared
 * predicate, never of team_id, which every tray now has), or a section with no team at all (a
 * job's team IS its section's team, so there would be nothing to preserve).
 *
 * One function, both sides of the fence: components/MergeMode builds each row's `groupKey` from
 * it and disables anything outside the ticked group, and mergeSections re-checks it before
 * writing. The UI is not the only way in, and the two cannot drift into different ideas of what
 * a legal merge is.
 */
export function sectionMergeGroupKey(section: Section): string | null {
  if (isSectionTray(section) || !section.team_id) return null
  return `${section.team_id}:${section.production_line_id ?? ''}`
}

export interface SectionMergePreflight {
  /**
   * EVERY job that would move, retired ones included, with the section each currently belongs
   * to. The write below moves all of them: `jobs.section_id` is not filtered by is_active, and
   * leaving a retired job behind would strand it under a section about to be retired — which
   * the post-move count would (rightly) refuse to complete.
   */
  movingJobs: { id: string; name: string; section_id: string | null; is_active?: boolean }[]
  /** Of those, the ones a screen can actually show — what the confirmation counts and lists. A
   * retired job is real work being re-filed, but naming it would name a row the user already
   * merged away and can't see anywhere. */
  visibleJobs: { id: string; name: string }[]
  /** Active operations under those jobs. They move with their job; counted so the confirm can
   * say how much work is being re-filed. */
  operationCount: number
  /**
   * Job names that would appear TWICE in the keeper once the merge is done — the note that a
   * follow-up job merge is needed. Compared literally (exact string equality: no trimming, no
   * case folding), because the merge itself does no name matching and this warning must not
   * imply a match the write path wouldn't make.
   */
  duplicateNames: string[]
}

/**
 * What a section merge would move. Reads only — safe to call while a confirmation is open, which
 * is where it belongs: the numbers it returns are what that dialog states.
 *
 * There is no `blockers` field and no user to check against, and that is the point — see the
 * guard note above. A section merge cannot be refused on ownership grounds because it never
 * touches a recorded time.
 *
 * Reads every job, retired ones included, because every one of them has to MOVE — see
 * movingJobs. Only the active ones are counted and listed.
 */
export async function preflightSectionMerge(
  supabase: SupabaseClient,
  { keeper, merged }: { keeper: Section; merged: Section[] }
): Promise<SectionMergePreflight> {
  const movingJobs = await fetchAllChunked<{ id: string; name: string; section_id: string | null; is_active?: boolean }>(
    merged.map((s) => s.id), READ_CHUNK,
    (chunk) => supabase.from('jobs').select('id, name, section_id, is_active')
      .in('section_id', chunk).order('id'),
    { table: 'jobs' }
  )
  const visible = movingJobs.filter((j) => j.is_active !== false)
  const keeperJobs = await fetchAllRows<{ id: string; name: string }>(
    () => supabase.from('jobs').select('id, name')
      .eq('section_id', keeper.id).eq('is_active', true).order('id'),
    { table: 'jobs' }
  )

  // Literal equality, deliberately — see duplicateNames. Names repeated ACROSS the merged
  // sections count too: two "Fit Hatches" arriving from two different sections collide in the
  // keeper just as surely as one arriving alongside the keeper's own.
  const seen = new Map<string, number>()
  for (const job of keeperJobs) seen.set(job.name, (seen.get(job.name) ?? 0) + 1)
  for (const job of visible) seen.set(job.name, (seen.get(job.name) ?? 0) + 1)
  const duplicateNames = [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name).sort()

  // Chunked, because a URL can only carry so many ids in one `.in(...)` filter — the same rule
  // every bulk read in this app follows (see lib/supabaseRead). head:true so this costs a count
  // and no rows: the confirmation only ever states the number.
  let operationCount = 0
  for (const chunk of chunked(visible.map((j) => j.id), READ_CHUNK)) {
    const { count, error } = await supabase
      .from('operations').select('id', { count: 'exact', head: true })
      .in('job_id', chunk).eq('is_active', true)
    if (error) throw new Error(`Checking what would move: ${error.message}`)
    operationCount += count ?? 0
  }

  return {
    movingJobs,
    visibleJobs: [...visible].sort((a, b) => a.name.localeCompare(b.name)),
    operationCount,
    duplicateNames,
  }
}

export interface SectionMergeResult {
  movedJobs: number
  /** Echoed from the preflight so a caller can repeat the "these need merging separately" line
   * in its success message without re-reading anything. */
  duplicateNames: string[]
  /** Sections left ACTIVE because jobs were still on them after the move. Empty on a clean
   * merge; never silently dropped. */
  stranded: string[]
}

/**
 * The only function anywhere that merges sections. Many into one.
 *
 * Every job move goes through setJobSection — the only function anywhere that writes
 * jobs.section_id — rather than one bulk UPDATE, so a merge files a job exactly the way a manual
 * reassignment does, read-back check included. A section is a handful of jobs; the extra round
 * trips buy a guarantee that this path can't drift from the single-writer rule.
 *
 * All-or-nothing on its own writes: the rules are checked before anything is written, and each
 * merged section is only retired after its own jobs are confirmed moved.
 */
export async function mergeSections(
  supabase: SupabaseClient,
  { keeper, merged }: { keeper: Section; merged: Section[] }
): Promise<SectionMergeResult> {
  if (merged.length === 0) return { movedJobs: 0, duplicateNames: [], stranded: [] }
  if (merged.some((s) => s.id === keeper.id)) throw new Error('A section can’t be merged into itself.')
  assertMergeable(keeper, 'keeper')
  // Re-checked against the SAME rule the picker used — see sectionMergeGroupKey. The UI is not
  // the only way in, and a section retimed or re-lined between opening the pane and confirming
  // would otherwise slip through.
  const keeperGroup = sectionMergeGroupKey(keeper)
  if (!keeperGroup) {
    throw new Error(`"${keeper.name}" has no team, so there is nothing that can safely be merged into it.`)
  }
  for (const section of merged) {
    assertMergeable(section, 'merged')
    if (sectionMergeGroupKey(section) !== keeperGroup) {
      throw new Error(
        `"${section.name}" and "${keeper.name}" are not on the same team and production line. A section ` +
        'can only be merged into another section on the same team — moving jobs between teams is a ' +
        'reassignment, not a merge.'
      )
    }
  }

  const preflight = await preflightSectionMerge(supabase, { keeper, merged })

  const stranded: string[] = []
  for (const section of merged) {
    const moving = preflight.movingJobs.filter((j) => j.section_id === section.id)
    for (const job of moving) {
      try {
        await setJobSection(supabase, job.id, keeper)
      } catch (err) {
        throw new Error(
          `Moving "${job.name}" into "${keeper.name}" failed: ${err instanceof Error ? err.message : 'rejected'}. ` +
          `"${section.name}" has been left active with whatever jobs remain on it — nothing is lost, and re-running the merge is safe.`
        )
      }
    }

    // The same shape mergeOperations uses: prove the move actually happened before retiring the
    // row, or a job left behind ends up filed under a section no screen lists any more. Counts
    // retired jobs too — the move above only shifted the active ones.
    const left = await countJobsInSection(supabase, section.id)
    if (left > 0) {
      stranded.push(`${section.name} (${left === 1 ? '1 job' : `${left} jobs`} left behind)`)
      continue
    }

    const { data: retired, error: retireError } = await supabase
      .from('sections').update({ is_active: false }).eq('id', section.id).select('id')
    if (retireError) throw new Error(`Retiring "${section.name}": ${retireError.message}`)
    if (!retired || retired.length === 0) {
      throw new Error(
        `"${section.name}" could not be retired — the update was rejected, which usually means ` +
        'changing sections is restricted to admins in this environment. Its jobs have already ' +
        `moved to "${keeper.name}"; the empty section is still listed.`
      )
    }
  }

  // Counts the jobs a screen can see, matching what the confirmation promised — the retired ones
  // moved too, but reporting them would name rows the user can't find anywhere.
  return { movedJobs: preflight.visibleJobs.length, duplicateNames: preflight.duplicateNames, stranded }
}

/** The line a caller shows when a section merge completed but left a section behind.
 * Deliberately does not name a cause: nothing here checks ownership, so a strand at this point
 * is the database refusing the write for a reason this module can't see. */
export function strandedSectionMergeMessage(stranded: string[]): string {
  return (
    'Kept active — the database refused to move every job off them, so retiring them would have ' +
    `stranded real work under a section no screen shows: ${stranded.join(', ')}. ` +
    'Everything else in the selection was merged. Nothing was lost.'
  )
}
