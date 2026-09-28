import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllChunked, fetchAllRows, READ_CHUNK, type RangeableQuery } from './supabaseRead'

/**
 * The build schedule — which models are booked onto the line, and when.
 *
 * The source is the `chassis` table, and `chassis.dateonline` is a real Postgres `date` column.
 * That is worth stating plainly because an earlier version of this module didn't assume it: it
 * treated the value as possibly-text, possibly an Excel serial (days since 1899-12-30) carried
 * over from the spreadsheet import, and parsed accordingly. All of that is gone. The column is a
 * date; it is filtered as a date, by the database, and formatted as a date. There is no serial
 * conversion, no numeric coercion, and no empty-string handling anywhere below — a row with no
 * date has SQL NULL, which simply fails the `>= today` filter and is therefore not a future
 * build.
 *
 * The filtering happens SERVER-side, which is the other half of what went wrong before. Reading
 * the whole table and filtering in the browser looks equivalent and isn't: PostgREST caps an
 * unbounded select at 1,000 rows, `chassis` holds 5,660, and the page it returned was the
 * oldest rows — none of them future-dated. The section rendered "no future builds" against a
 * table with several hundred. Every query here carries its filters into the database and pages
 * through whatever comes back, so neither the cap nor the row count can produce a wrong answer
 * again.
 *
 * Models are joined through `chassis.product_id`, not by matching `chassis.model` text against
 * `products.model`. The foreign key is the real relationship; string equality between two
 * free-text columns is a guess that silently drops rows whose spelling drifted.
 */

/** Today as an ISO date, from the LOCAL calendar day — the comparison the database will make is
 * date-to-date, so this is a plain `YYYY-MM-DD` and never a timestamp. */
export function todayIsoDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * A `YYYY-MM-DD` date for display. Built through Date.UTC and formatted in UTC: a build is
 * booked for a DAY, and pushing a bare date through a local-timezone formatter is how
 * "19 Aug" renders as "18 Aug" for anyone west of Greenwich.
 */
export function fmtScheduleDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  if (!year || !month || !day) return iso
  return new Date(Date.UTC(year, month - 1, day))
    .toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export interface FutureBuildSummary {
  productId: string
  futureBuilds: number
  /** The soonest `dateonline` among this model's future builds, as `YYYY-MM-DD`. */
  nextOnLine: string
}

export interface FutureBuildsResult {
  /** One entry per model that has at least one build still ahead of it. */
  byProductId: Map<string, FutureBuildSummary>
  totalFutureBuilds: number
  /** Future-dated chassis rows with no product_id — real builds that can't be attributed to a
   * model, counted rather than silently dropped. */
  unlinkedBuilds: number
}

interface ChassisScheduleRow { product_id: string | null; dateonline: string | null }

/**
 * Every build still ahead, rolled up per model.
 *
 * `productIds` scopes to one production line's models; pass null for every model. Scoping by
 * product id rather than by a join filter keeps this to the same shape either way, and means
 * the line filter is applied in the database rather than by discarding rows afterwards.
 *
 * THE definition of "upcoming" for the whole app — /dashboard's "Collect these next" and
 * /labour-matrix's future-builds filter both read it, and a second derivation of the same
 * question is how two screens come to disagree about which models are booked.
 *
 * ── The paging used to be hand-rolled here ────────────────────────────────────────────────
 * This function's own loop was the only paged read in the app, and lib/supabaseRead is that loop
 * extracted (see the note atop that module). It now calls back into it rather than keeping the
 * copy it was extracted from, which removes a duplicate PAGE constant, a duplicate `.in(...)`
 * chunker, and — the part that mattered — a non-total sort order. The old query ordered by
 * `dateonline` alone; hundreds of builds share a date, and `.range()` paging over a non-total
 * order is free to repeat a row on one page and skip it on the next, which would have shown up
 * as a model's build count being wrong by a few in either direction. The `.order('id')`
 * tiebreaker below is what makes the order total, matching fetchScheduleWindow.
 */
export async function fetchFutureBuilds(
  supabase: SupabaseClient,
  productIds: string[] | null
): Promise<FutureBuildsResult> {
  const today = todayIsoDate()
  const byProductId = new Map<string, FutureBuildSummary>()
  let totalFutureBuilds = 0

  const baseQuery = () => supabase
    .from('chassis')
    .select('product_id, dateonline')
    // A real date comparison, made by the database. Nothing is parsed client-side, and a NULL
    // dateonline fails this predicate — which is exactly right: it isn't a future build.
    .gte('dateonline', today)
    .order('dateonline').order('id') as unknown as RangeableQuery<ChassisScheduleRow>

  // A fan-out read either way — one product id matches many chassis rows — so the id list is
  // chunked for the URL AND each chunk is paged to exhaustion. Scoped to nothing, it is just
  // paged: `chassis` holds thousands of rows and an unpaged select stops at the 1,000-row cap
  // as a normal 200 with a short array.
  const rows: ChassisScheduleRow[] = productIds === null
    ? await fetchAllRows<ChassisScheduleRow>(baseQuery, { table: 'chassis (all future builds)' })
    : await fetchAllChunked<ChassisScheduleRow>(
      productIds, READ_CHUNK,
      (chunk) => supabase
        .from('chassis')
        .select('product_id, dateonline')
        .gte('dateonline', today)
        .in('product_id', chunk)
        .order('dateonline').order('id') as unknown as RangeableQuery<ChassisScheduleRow>,
      { table: 'chassis (future builds by product)' },
    )

  for (const row of rows) {
    if (!row.product_id || !row.dateonline) continue
    totalFutureBuilds += 1
    const entry = byProductId.get(row.product_id)
    if (!entry) {
      byProductId.set(row.product_id, {
        productId: row.product_id, futureBuilds: 1, nextOnLine: row.dateonline,
      })
    } else {
      entry.futureBuilds += 1
      // Both are YYYY-MM-DD, so a plain string compare is a correct date compare.
      if (row.dateonline < entry.nextOnLine) entry.nextOnLine = row.dateonline
    }
  }

  // Builds that are scheduled but attached to no model. Only a meaningful figure business-wide
  // — under a line filter such a row belongs to no line by definition — so the caller decides
  // whether to show it.
  const { count, error: unlinkedError } = await supabase
    .from('chassis')
    .select('id', { count: 'exact', head: true })
    .gte('dateonline', today)
    .is('product_id', null)
  if (unlinkedError) throw new Error(unlinkedError.message)

  return { byProductId, totalFutureBuilds, unlinkedBuilds: count ?? 0 }
}

/**
 * ── The scheduled window: WHICH models are booked, and between when ─────────────────────────
 *
 * fetchFutureBuilds above answers "how many builds does each model have left", which is the
 * question /dashboard asks. This answers the flatter one a coverage report needs: the DISTINCT
 * set of models with any build still ahead, the span of dates that set covers, and — reported
 * rather than dropped — how many scheduled chassis could not be attributed to a model at all.
 *
 * It is a separate function rather than another flag on fetchFutureBuilds because the two differ
 * in what they must not lose. fetchFutureBuilds skips a row with no product_id and counts the
 * total separately with a HEAD query; a report whose denominator IS this set has to state that
 * exclusion on the page, next to the numbers it changes, so the count comes back in the same
 * shape as everything else rather than from a second query that could be scoped differently.
 *
 * Read through lib/supabaseRead's paging for the reason stated at the top of this module:
 * `chassis` holds thousands of rows and an unpaged select stops at the 1,000-row cap as a normal
 * 200 with a short array. The order is (dateonline, id) — a total order, which .range() paging
 * requires to be sound.
 */
export interface ScheduleWindow {
  /** Distinct products with at least one build on or after `from`. THE report denominator. */
  productIds: string[]
  /** Builds ahead, per product — how many vans of that model the window actually holds. */
  buildsByProductId: Map<string, number>
  /** Earliest and latest `dateonline` across the MATCHED rows, as `YYYY-MM-DD`. Null when the
   * window is empty. Matched only: the window is the span of the denominator, and a row that
   * contributes no model to it cannot widen it either. */
  earliest: string | null
  latest: string | null
  /** Scheduled rows whose product_id is NULL — real builds that resolve to no model, so they
   * can be neither covered nor missing. Counted so a report can say so out loud. */
  unmatchedRows: number
  /** Scheduled rows that DID resolve to a model, for the same footnote's denominator. */
  matchedRows: number
}

export async function fetchScheduleWindow(
  supabase: SupabaseClient,
  from: string = todayIsoDate()
): Promise<ScheduleWindow> {
  const rows = await fetchAllRows<{ product_id: string | null; dateonline: string | null }>(
    () => supabase
      .from('chassis')
      .select('product_id, dateonline')
      // A real date comparison made by the database — see the module note. A NULL dateonline
      // fails this predicate and is therefore not in the window at all, matched or otherwise.
      .gte('dateonline', from)
      .order('dateonline').order('id') as unknown as RangeableQuery<{ product_id: string | null; dateonline: string | null }>,
    { table: 'chassis' }
  )

  const buildsByProductId = new Map<string, number>()
  let earliest: string | null = null
  let latest: string | null = null
  let unmatchedRows = 0
  let matchedRows = 0

  for (const row of rows) {
    if (!row.dateonline) continue
    if (!row.product_id) { unmatchedRows += 1; continue }
    matchedRows += 1
    buildsByProductId.set(row.product_id, (buildsByProductId.get(row.product_id) ?? 0) + 1)
    // Both are YYYY-MM-DD, so a string compare is a correct date compare.
    if (earliest === null || row.dateonline < earliest) earliest = row.dateonline
    if (latest === null || row.dateonline > latest) latest = row.dateonline
  }

  return { productIds: [...buildsByProductId.keys()], buildsByProductId, earliest, latest, unmatchedRows, matchedRows }
}
