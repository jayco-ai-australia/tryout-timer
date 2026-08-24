import type { SupabaseClient } from '@supabase/supabase-js'
import type { Stage } from './types'

/**
 * The single stages module — every screen that reads or writes `stages` (/tryouts' "Add new
 * Stage" flow, /setup's stage manager) goes through the helpers here, so the walk-order rules
 * (what sort_order a new stage gets, how a reorder renumbers, what blocks a delete) can't drift
 * between screens.
 *
 * A stage is one step of the line's walk: Production Line → Team → Stage → Job → Operation.
 * Both production_line_id and team_id are NOT NULL on the table, so both are required here
 * rather than defaulted to null — an insert missing either is rejected by the database with a
 * constraint message no user can act on, which is why createStage checks them itself first.
 *
 * Only some lines have stages at all (today: Campervan does, Caravan and Motor Home don't), so
 * every caller must treat "this line has no stages" as a normal state, not an empty list to
 * scaffold over.
 */

/** Walk order: sort_order ascending with un-numbered stages last, then name as a tie-break so
 * the list can never flip around between renders. */
export function sortStages(stages: Stage[]): Stage[] {
  return [...stages].sort((a, b) => {
    const aOrder = a.sort_order ?? Number.MAX_SAFE_INTEGER
    const bOrder = b.sort_order ?? Number.MAX_SAFE_INTEGER
    if (aOrder !== bOrder) return aOrder - bOrder
    return a.name.localeCompare(b.name)
  })
}

export async function fetchStagesForLine(supabase: SupabaseClient, productionLineId: string): Promise<Stage[]> {
  const { data, error } = await supabase
    .from('stages')
    .select('*')
    .eq('production_line_id', productionLineId)
    .order('sort_order')
  if (error) throw new Error(error.message)
  return sortStages((data ?? []) as Stage[])
}

/**
 * Where a new stage lands in the line's walk: the end. Reads the current max rather than
 * counting rows, so a gap in sort_order (or a deleted stage) can't produce a duplicate.
 */
export async function nextStageSortOrder(supabase: SupabaseClient, productionLineId: string): Promise<number> {
  const { data, error } = await supabase
    .from('stages')
    .select('sort_order')
    .eq('production_line_id', productionLineId)
    .order('sort_order', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  return ((data?.[0]?.sort_order as number | null) ?? 0) + 1
}

export interface CreateStageInput {
  name: string
  productionLineId: string
  /** NOT NULL on the table — a stage always belongs to a team. */
  teamId: string
}

/** The only function anywhere that inserts into `stages`. */
export async function createStage(supabase: SupabaseClient, input: CreateStageInput): Promise<Stage> {
  const name = input.name.trim()
  if (!name) throw new Error('Stage name must not be empty')
  if (!input.productionLineId) throw new Error('A stage needs a production line')
  if (!input.teamId) throw new Error('Pick a team for this stage — every stage belongs to one')

  const sortOrder = await nextStageSortOrder(supabase, input.productionLineId)

  const { data, error } = await supabase
    .from('stages')
    .insert({ name, production_line_id: input.productionLineId, team_id: input.teamId, sort_order: sortOrder })
    .select('*')
    .single()
  if (error || !data) throw new Error(error?.message ?? 'Could not create stage')
  return data as Stage
}

/** The only function anywhere that updates stages.name. */
export async function renameStage(supabase: SupabaseClient, stageId: string, name: string): Promise<Stage> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Stage name must not be empty')

  const { data, error } = await supabase
    .from('stages').update({ name: trimmed }).eq('id', stageId).select('*')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error('That stage could not be renamed — the change was rejected by the database (check your permissions).')
  }
  return data[0] as Stage
}

/**
 * Renumbers a line's stages to the given order, writing sort_order = 1..n. Only rows whose
 * number actually changes are written.
 *
 * Renumbering the whole list — rather than swapping two rows' sort_order values — is deliberate:
 * existing data has stages with null or duplicated sort_order, and a value swap between two of
 * those is a no-op that silently leaves the order unchanged.
 */
export async function reorderStages(supabase: SupabaseClient, orderedStages: Stage[]): Promise<void> {
  for (let i = 0; i < orderedStages.length; i++) {
    const stage = orderedStages[i]
    const target = i + 1
    if (stage.sort_order === target) continue
    const { data, error } = await supabase
      .from('stages').update({ sort_order: target }).eq('id', stage.id).select('id')
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) {
      throw new Error(`"${stage.name}" could not be reordered — the change was rejected by the database (check your permissions).`)
    }
  }
}

/** Moves one stage one place up or down the walk and writes the resulting order. Returns the
 * new order so a caller can render it without a re-fetch. */
export async function moveStage(supabase: SupabaseClient, stages: Stage[], stageId: string, direction: -1 | 1): Promise<Stage[]> {
  const ordered = sortStages(stages)
  const index = ordered.findIndex((s) => s.id === stageId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= ordered.length) return ordered

  const next = [...ordered]
  ;[next[index], next[target]] = [next[target], next[index]]
  await reorderStages(supabase, next)
  return next.map((s, i) => ({ ...s, sort_order: i + 1 }))
}

/** How many jobs point at this stage — the guard a delete has to clear. Counted across every
 * job, not just the ones a screen currently has loaded: a job can reference a stage while its
 * own production_line_id is unset, and deleting out from under it would orphan the reference. */
export async function countJobsInStage(supabase: SupabaseClient, stageId: string): Promise<number> {
  const { count, error } = await supabase
    .from('jobs').select('id', { count: 'exact', head: true }).eq('stage_id', stageId)
  if (error) throw new Error(error.message)
  return count ?? 0
}

/** Job counts for a batch of stages, keyed by stage id — the list-view counterpart of
 * countJobsInStage, so a stage list doesn't fire one head-count request per row. */
export async function countJobsByStage(supabase: SupabaseClient, stageIds: string[]): Promise<Record<string, number>> {
  if (stageIds.length === 0) return {}
  const { data, error } = await supabase.from('jobs').select('stage_id').in('stage_id', stageIds)
  if (error) throw new Error(error.message)
  const counts: Record<string, number> = {}
  for (const id of stageIds) counts[id] = 0
  for (const row of (data ?? []) as { stage_id: string | null }[]) {
    if (row.stage_id) counts[row.stage_id] = (counts[row.stage_id] ?? 0) + 1
  }
  return counts
}

/**
 * The only function anywhere that deletes from `stages`. Deliberately deletes nothing else —
 * a stage with jobs must be emptied first (see countJobsInStage), never cascaded away, because
 * jobs.stage_id is the only record of which step of the walk a job belongs to.
 *
 * A delete filtered out by RLS succeeds having removed nothing, so the deleted row is read back
 * and its absence reported rather than leaving a screen to refresh into an unchanged list with
 * no explanation.
 */
export async function deleteStage(supabase: SupabaseClient, stageId: string): Promise<void> {
  const { data, error } = await supabase.from('stages').delete().eq('id', stageId).select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error('That stage could not be deleted — the database rejected it, which usually means deleting stages is restricted to admins.')
  }
}

/**
 * The only function anywhere that writes jobs.stage_id. Passing null unstages the job, which is
 * a real state (a job that exists but hasn't been placed in the walk yet), not an error.
 *
 * Takes the whole Stage rather than its id because placing a job in a stage is not just a
 * stage_id write: a stage belongs to exactly one team on exactly one line, and a job sitting
 * under it has to agree, or the walk contradicts itself — the job would render under a Team 2
 * stage while still reporting Team 1 everywhere team is read (/dashboard rollups, the Team
 * filter on /setup, and now the team stamped onto every time recorded against its operations,
 * see lib/operationTimes.ts). So team_id and production_line_id are synced FROM the target
 * stage, and moving a job to another team's stage moves the job to that team.
 *
 * The job's operations — and their recorded times — ride along untouched: both hang off
 * job_id/operation_id, not off the stage or the team, so nothing has to be migrated.
 *
 * Unstaging (stage === null) deliberately leaves team_id/production_line_id alone. A job that
 * has left the walk still belongs to whoever owned it; nulling that out would lose information
 * this function has no replacement for.
 *
 * A stage missing a team or line (both are NOT NULL on the table, so this shouldn't happen)
 * syncs only the field it does have, rather than writing a null over the job's current value.
 */
export async function setJobStage(supabase: SupabaseClient, jobId: string, stage: Stage | null): Promise<void> {
  const payload: Record<string, unknown> = { stage_id: stage?.id ?? null }
  if (stage?.team_id) payload.team_id = stage.team_id
  if (stage?.production_line_id) payload.production_line_id = stage.production_line_id

  const { data, error } = await supabase
    .from('jobs').update(payload).eq('id', jobId).select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    throw new Error("That job's stage could not be changed — the change was rejected by the database (check your permissions).")
  }
}
