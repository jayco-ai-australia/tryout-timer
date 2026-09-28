import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllChunked, fetchAllRows, READ_CHUNK, type RangeableQuery } from './supabaseRead'
import { periodBounds, timeframeWindow, type CollectionTimeframe, type PeriodWindow } from './periods'

/**
 * Who is collecting — per-person activity over operation_times, for /dashboard's
 * "Who's collecting" panel.
 *
 * ── "Who" is collected_by, and only collected_by ──────────────────────────────────────────
 * operation_times carries two person-shaped columns and they mean different things.
 * `operator_id` is WHO WAS TIMED — the person on the line doing the work — and on imported
 * history it is NULL on roughly 94% of rows. `collected_by` is WHO DID THE COLLECTING: the
 * profile of the user who stood there with the tablet and recorded it. This module answers the
 * second question, so it reads collected_by and joins it to profiles.full_name. Attributing a
 * collection to the operator would be wrong even where the column is populated.
 *
 * ── The ownerless rows are a bucket, not a rounding error ─────────────────────────────────
 * Around a thousand operation_times rows are historical imports with collected_by = NULL. They
 * are real recorded times and they must not be quietly dropped from the totals, but there is
 * nobody to attribute them to either. They aggregate into one clearly-labelled bucket keyed by
 * IMPORTED_COLLECTOR_KEY, sorted last regardless of size. On the Overall timeframe that bucket
 * dwarfs every real person — that is the honest picture of where the data came from, not a bug
 * to be hidden by filtering.
 *
 * ── Two reads for the summary, five more only on expand ───────────────────────────────────
 * The collapsed summary is a constant TWO logical reads no matter how many people appear in it:
 * one paged sweep of operation_times for `collected_by, total_minutes` alone, and one chunked
 * read of profiles for the names. Nothing per-person, and no detail — the operation, job and
 * model labels behind a person's rows cost four more reads and are fetched by
 * `fetchCollectorDetail` only when that person's row is actually opened.
 *
 * ── Paging is mandatory here ──────────────────────────────────────────────────────────────
 * Every read goes through lib/supabaseRead. On the Overall timeframe the summary sweep is well
 * past the 1,000-row response cap, and a capped response is a normal 200 with a short array —
 * an unpaged read would silently produce counts that are simply wrong, which is the exact bug
 * already fixed on this screen's coverage headline. Note also `is_active` is NOT filtered: on
 * this table it flags a superseded import batch, not a hidden row (see lib/operationTimes).
 */

/** The ownerless bucket's key. A real collector's key is their profile id, which is a uuid and
 * therefore can never collide with this. */
export const IMPORTED_COLLECTOR_KEY = '__imported__'

/** How many detail rows a single expanded person will render. Anything past this is counted but
 * not drawn — on Overall the imported bucket alone runs to four figures. Deliberately below the
 * 1,000-row response cap, so the capped detail read cannot itself be truncated. */
export const COLLECTOR_DETAIL_LIMIT = 100

/** What to call a profile row that exists but has no name on it. */
const UNNAMED_COLLECTOR = 'Unnamed user'

export interface CollectorSummaryRow {
  /** Profile id, or IMPORTED_COLLECTOR_KEY for the ownerless bucket. */
  key: string
  /** The value to filter `collected_by` by when fetching this row's detail — null means IS NULL. */
  collectedBy: string | null
  name: string
  /** True for the ownerless bucket. Callers render it distinctly and it always sorts last. */
  imported: boolean
  /** operation_times rows in the window. This is the "showing 100 of N" N. */
  count: number
  /** Sum of total_minutes across those rows, skipping the nulls. */
  totalMinutes: number
  /** Rows whose total_minutes is NULL — counted in `count`, absent from `totalMinutes`. */
  untimed: number
}

export interface CollectorSummary {
  /** Only people with activity in the window — a zero row is never emitted. Sorted by count
   * descending, with the imported bucket forced last. */
  rows: CollectorSummaryRow[]
  totalCount: number
  totalMinutes: number
}

export interface CollectorScope {
  timeframe: CollectionTimeframe
  /** Production line to scope to, matching the dashboard's filter. '' or null = every line. */
  lineId: string | null
}

/**
 * operation_times, narrowed to one period window and one production line — the same two filters
 * the "Times collected" cards apply, so the panel's totals and the cards' reconcile.
 *
 * The line filter is operation_times.production_line_id, exactly as the cards use it; there is
 * no second definition of "on this line" here.
 */
/*
 * NOT filtered to superseded_by is null anywhere in this module, deliberately. Everything here
 * counts COLLECTION ACTIVITY — who recorded what, and when — which is a fact about the past that
 * a later re-measure does not undo. Filtering to current records would quietly rewrite a
 * collector's history every time somebody superseded one of their runs. Labour content is the
 * separate question, and lib/operationTimes owns it.
 */
function scopedTimes(
  supabase: SupabaseClient,
  columns: string,
  window: PeriodWindow,
  lineId: string | null
) {
  let query = supabase.from('operation_times').select(columns)
  if (window.from) query = query.gte('created_at', window.from.toISOString())
  if (window.to) query = query.lt('created_at', window.to.toISOString())
  if (lineId) query = query.eq('production_line_id', lineId)
  return query
}

/**
 * The collapsed summary: one row per person who collected anything in the window.
 *
 * Two reads, constant in the number of people. There is no GROUP BY available over PostgREST
 * without a database function, so the grouping happens here — but only over two columns, never
 * over the detail.
 */
export async function fetchCollectorSummary(
  supabase: SupabaseClient,
  { timeframe, lineId }: CollectorScope,
  now: Date = new Date()
): Promise<CollectorSummary> {
  const window = timeframeWindow(timeframe, periodBounds(now))

  // Read 1 — the whole window, two columns. Ordered by the primary key because .range() paging
  // is only sound over a total order (see lib/supabaseRead); nothing downstream cares about it.
  const times = await fetchAllRows<{ collected_by: string | null; total_minutes: number | null }>(
    () => scopedTimes(supabase, 'collected_by, total_minutes', window, lineId)
      .order('id') as unknown as RangeableQuery<{ collected_by: string | null; total_minutes: number | null }>,
    { table: 'operation_times' }
  )

  interface Bucket { collectedBy: string | null; count: number; totalMinutes: number; untimed: number }
  const buckets = new Map<string, Bucket>()
  let totalCount = 0
  let totalMinutes = 0
  for (const row of times) {
    const key = row.collected_by ?? IMPORTED_COLLECTOR_KEY
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { collectedBy: row.collected_by, count: 0, totalMinutes: 0, untimed: 0 }
      buckets.set(key, bucket)
    }
    bucket.count += 1
    totalCount += 1
    if (row.total_minutes == null) bucket.untimed += 1
    else { bucket.totalMinutes += row.total_minutes; totalMinutes += row.total_minutes }
  }

  // Read 2 — names, for the real collectors only. Chunked because the id list is unbounded in
  // principle, and ordered because chunks are paged.
  const profileIds = [...buckets.keys()].filter((k) => k !== IMPORTED_COLLECTOR_KEY)
  const profiles = await fetchAllChunked<{ id: string; full_name: string | null }>(
    profileIds, READ_CHUNK,
    (chunk) => supabase.from('profiles').select('id, full_name').in('id', chunk)
      .order('id') as unknown as RangeableQuery<{ id: string; full_name: string | null }>,
    { table: 'profiles' }
  )
  const nameById = new Map(profiles.map((p) => [p.id, p.full_name]))

  const rows: CollectorSummaryRow[] = [...buckets.entries()].map(([key, bucket]) => {
    const imported = key === IMPORTED_COLLECTOR_KEY
    return {
      key,
      collectedBy: bucket.collectedBy,
      // A collected_by pointing at a profile that no longer exists still gets a row — the times
      // are real. It reads as unnamed rather than vanishing.
      name: imported ? 'Imported (no user)' : (nameById.get(key)?.trim() || UNNAMED_COLLECTOR),
      imported,
      count: bucket.count,
      totalMinutes: bucket.totalMinutes,
      untimed: bucket.untimed,
    }
  })

  // Busiest first. The imported bucket is pinned to the bottom whatever its size: it is not a
  // person and it should never head a leaderboard of people.
  rows.sort((a, b) => {
    if (a.imported !== b.imported) return a.imported ? 1 : -1
    if (b.count !== a.count) return b.count - a.count
    if (b.totalMinutes !== a.totalMinutes) return b.totalMinutes - a.totalMinutes
    return a.name.localeCompare(b.name)
  })

  return { rows, totalCount, totalMinutes }
}

export interface CollectorDetailRow {
  id: string
  operationName: string
  jobName: string
  /** Models this time is linked to, via operation_time_models — operation_times has no
   * product_id of its own. Empty when the time was never linked to a model. */
  models: string[]
  minutes: number | null
  /** created_at, ISO — the "when it was collected" the caller formats. */
  collectedAt: string
}

/**
 * One person's rows in the window, most recent first, capped at COLLECTOR_DETAIL_LIMIT.
 *
 * Called lazily, when a summary row is opened — never as part of the summary. The caller
 * already knows the true total from `CollectorSummaryRow.count`, so this returns only what is
 * drawable and leaves the "showing 100 of N" arithmetic to it.
 *
 * `collectedBy: null` fetches the ownerless bucket via IS NULL — the same rows
 * `fetchCollectorSummary` grouped under IMPORTED_COLLECTOR_KEY.
 */
export async function fetchCollectorDetail(
  supabase: SupabaseClient,
  { timeframe, lineId, collectedBy }: CollectorScope & { collectedBy: string | null },
  now: Date = new Date()
): Promise<CollectorDetailRow[]> {
  const window = timeframeWindow(timeframe, periodBounds(now))

  // The one read here that is deliberately NOT paged: .limit() IS the cap, and it is set well
  // under the 1,000-row response cap, so there is nothing behind it to be silently truncated.
  // Reading it to exhaustion would defeat the point of capping it.
  let query = scopedTimes(supabase, 'id, operation_id, total_minutes, created_at', window, lineId)
  query = collectedBy === null ? query.is('collected_by', null) : query.eq('collected_by', collectedBy)
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(COLLECTOR_DETAIL_LIMIT)
  if (error) throw new Error(error.message)
  const times = (data ?? []) as unknown as {
    id: string; operation_id: string; total_minutes: number | null; created_at: string
  }[]
  if (times.length === 0) return []

  // Labels for those rows. Every id-list read below is chunked AND paged, and ordered by its
  // full primary key because paging requires a total order.
  const timeIds = times.map((t) => t.id)
  const timeModels = await fetchAllChunked<{ operation_time_id: string; product_id: string }>(
    timeIds, READ_CHUNK,
    (chunk) => supabase.from('operation_time_models').select('operation_time_id, product_id')
      .in('operation_time_id', chunk)
      .order('operation_time_id').order('product_id') as unknown as RangeableQuery<{ operation_time_id: string; product_id: string }>,
    { table: 'operation_time_models' }
  )

  const productIds = [...new Set(timeModels.map((tm) => tm.product_id))]
  const products = await fetchAllChunked<{ id: string; model: string }>(
    productIds, READ_CHUNK,
    (chunk) => supabase.from('products').select('id, model').in('id', chunk)
      .order('id') as unknown as RangeableQuery<{ id: string; model: string }>,
    { table: 'products' }
  )
  const modelById = new Map(products.map((p) => [p.id, p.model]))

  // NOT filtered to is_active: a retired operation still has history, and dropping it here
  // would leave a real collected time labelled with a blank name.
  const operationIds = [...new Set(times.map((t) => t.operation_id))]
  const operations = await fetchAllChunked<{ id: string; name: string; job_id: string }>(
    operationIds, READ_CHUNK,
    (chunk) => supabase.from('operations').select('id, name, job_id').in('id', chunk)
      .order('id') as unknown as RangeableQuery<{ id: string; name: string; job_id: string }>,
    { table: 'operations' }
  )
  const operationById = new Map(operations.map((o) => [o.id, o]))

  const jobIds = [...new Set(operations.map((o) => o.job_id).filter(Boolean))]
  const jobs = await fetchAllChunked<{ id: string; name: string }>(
    jobIds, READ_CHUNK,
    // Identity lookup by id — NOT filtered to is_active, for the same reason operations aren't
    // above: a retired job still labels the collected history that points at it.
    (chunk) => supabase.from('jobs').select('id, name').in('id', chunk)
      .order('id') as unknown as RangeableQuery<{ id: string; name: string }>,
    { table: 'jobs' }
  )
  const jobNameById = new Map(jobs.map((j) => [j.id, j.name]))

  const modelsByTimeId = new Map<string, string[]>()
  for (const tm of timeModels) {
    const model = modelById.get(tm.product_id)
    if (!model) continue
    const list = modelsByTimeId.get(tm.operation_time_id)
    if (list) list.push(model)
    else modelsByTimeId.set(tm.operation_time_id, [model])
  }
  for (const list of modelsByTimeId.values()) list.sort((a, b) => a.localeCompare(b))

  return times.map((t) => {
    const operation = operationById.get(t.operation_id)
    return {
      id: t.id,
      operationName: operation?.name ?? 'Unknown operation',
      jobName: (operation && jobNameById.get(operation.job_id)) ?? 'Unknown job',
      models: modelsByTimeId.get(t.id) ?? [],
      minutes: t.total_minutes,
      collectedAt: t.created_at,
    }
  })
}
