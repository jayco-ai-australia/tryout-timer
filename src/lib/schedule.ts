import type { SupabaseClient } from '@supabase/supabase-js'

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

const PAGE = 1000

/** PostgREST caps how much a single `.in(...)` filter can carry in the URL. */
const IN_CHUNK = 150

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Every build still ahead, rolled up per model.
 *
 * `productIds` scopes to one production line's models; pass null for every model. Scoping by
 * product id rather than by a join filter keeps this to the same shape either way, and means
 * the line filter is applied in the database rather than by discarding rows afterwards.
 */
export async function fetchFutureBuilds(
  supabase: SupabaseClient,
  productIds: string[] | null
): Promise<FutureBuildsResult> {
  const today = todayIsoDate()
  const byProductId = new Map<string, FutureBuildSummary>()
  let totalFutureBuilds = 0

  /** Reads one filtered slice, paging until the server stops returning full pages. */
  async function collect(applyScope: (q: ReturnType<typeof baseQuery>) => ReturnType<typeof baseQuery>) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await applyScope(baseQuery()).range(from, from + PAGE - 1)
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as { product_id: string | null; dateonline: string | null }[]
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
      if (rows.length < PAGE) break
    }
  }

  function baseQuery() {
    return supabase
      .from('chassis')
      .select('product_id, dateonline')
      // A real date comparison, made by the database. Nothing is parsed client-side, and a NULL
      // dateonline fails this predicate — which is exactly right: it isn't a future build.
      .gte('dateonline', today)
      .order('dateonline')
  }

  if (productIds === null) {
    await collect((q) => q)
  } else if (productIds.length > 0) {
    for (const chunk of chunked(productIds, IN_CHUNK)) {
      await collect((q) => q.in('product_id', chunk))
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
