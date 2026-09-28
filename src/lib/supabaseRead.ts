/**
 * Bulk reads that actually return everything.
 *
 * PostgREST caps a single response at `PAGE` rows (Supabase's "Max rows" setting, 1000 here).
 * A capped response is NOT an error: it comes back 200 with `error: null` and a short array, so
 * a read that asked for 5,000 rows and got 1,000 looks identical to one that asked for 5,000 and
 * found only 1,000. Every `.in(...)` bulk read in this app was written on the assumption that
 * one request returns the lot, and the ones over the cap were silently losing most of their
 * rows — /setup's coverage badge read "0 / 0" for nearly every operation and /dashboard's
 * headline read 0%, both from truncated input rather than from anything wrong with the
 * arithmetic. lib/schedule.ts' fetchFutureBuilds was the only read that ever paged; this module
 * is that loop, extracted so the rest of the app can use it.
 *
 * TWO SEPARATE LIMITS, both of which have to be respected — they are not the same thing:
 *   - URL length caps how many ids fit in one `.in(...)` filter → chunk the id list (READ_CHUNK).
 *   - The row cap limits what one request can RETURN → page each chunk with .range() (PAGE).
 * fetchAllChunked does both, in that order: chunk the filter, then page each chunk to exhaustion.
 *
 * ORDER MATTERS: paging with .range() is only sound over a deterministic order. Postgres makes
 * no promise about row order between two LIMIT/OFFSET queries without an ORDER BY, so an
 * unordered paged read can repeat rows on one page and skip them on the next. Every caller must
 * put a total order on the query — for these junction tables that means ordering by the full
 * primary key, which is index order and therefore free.
 */

/** Rows per request. Matches the server's cap (Supabase "Max rows"); a full page means there is
 * almost certainly more behind it. Kept identical to lib/schedule.ts' PAGE. */
export const PAGE = 1000

/** PostgREST caps how much a single `.in(...)` filter can carry in the URL, so bulk reads chunk
 * their id lists. Separate concern from PAGE — see the note above. */
export const READ_CHUNK = 150

export function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Runaway guard. 500 pages is 500k rows — far past anything this app legitimately reads in one
 * go, so hitting it means the loop isn't converging and throwing beats spinning the browser. */
const MAX_PAGES = 500

interface PagedResponse<T> { data: T[] | null; error: { message: string } | null }

/** Structural shape of a supabase-js select builder, narrowed to what paging needs. */
export interface RangeableQuery<T> {
  range(from: number, to: number): PromiseLike<PagedResponse<T>>
}

/**
 * The shape supabase-js hands back on a failed request. `message` is the only field the UI ever
 * shows; `details`, `hint` and `code` are where PostgREST says what was actually wrong, and they
 * are dropped on the floor by `throw new Error(error.message)`.
 */
export interface SupabaseErrorLike {
  message?: string | null
  details?: string | null
  hint?: string | null
  code?: string | null
}

/**
 * Put a failed query's WHOLE error in the console, not just its message.
 *
 * A PostgREST 400 for a column that doesn't exist reads `column operators.is_active does not
 * exist` in `message` — or, depending on where it is caught and re-thrown, as a bare "Bad
 * Request" with everything useful in `details`/`hint`/`code`. That is what made the
 * `is_active` filter on `operators` take a round of devtools archaeology to place: the screen
 * said "Bad Request", and the one line naming the column never reached anywhere a person looks.
 *
 * Called at the point of failure, where the table and the hop are still known — a caller that
 * re-throws loses both. Deliberately console-only: the banner keeps saying what it said, and
 * the diagnosis sits one keystroke away in the console rather than in front of the user.
 */
export function logSupabaseError(where: string, error: SupabaseErrorLike | null | undefined): void {
  if (!error) return
  console.error(
    `[supabase] ${where} FAILED —`,
    'message:', error.message ?? '(none)',
    '| details:', error.details ?? '(none)',
    '| hint:', error.hint ?? '(none)',
    '| code:', error.code ?? '(none)'
  )
}

/** What the log line names, so a truncated read can be traced back to its call site. */
export interface ReadContext {
  /** Table being read, for the log line. */
  table: string
  /** How many ids the `.in(...)` filter carried, where there is one. */
  filterSize?: number
}

/**
 * One query, read to exhaustion. `makeQuery` is called fresh for every page rather than reused,
 * because .range() writes onto the builder it is called on.
 *
 * The log line is the point of this function as much as the paging is: the bug it fixes was
 * invisible precisely because truncation is silent, so every time a page comes back exactly full
 * — i.e. every time the old single-request code would have dropped rows on the floor — it says
 * so, names the table and the filter size, and keeps reading.
 */
export async function fetchAllRows<T>(
  makeQuery: () => RangeableQuery<T>,
  context: ReadContext
): Promise<T[]> {
  const rows: T[] = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE
    const { data, error } = await makeQuery().range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as T[]
    rows.push(...batch)
    // A short page is the end of the data. A full one is not proof there's more, but it's
    // indistinguishable from truncation, so it's read on and reported.
    if (batch.length < PAGE) return rows
    // console.debug, not console.warn. A full page is NORMAL on any screen that legitimately
    // reads more than PAGE rows — /setup's coverage sweep hits it on every load — so at warn
    // level this was permanent noise that trained people to ignore the console. It is still
    // said, in the same words, because when a read HAS been truncated this is the line that
    // proves it: filter the console to Verbose to see them.
    console.debug(
      `[supabaseRead] ${context.table}: page ${page + 1} came back full at the ${PAGE}-row cap` +
      (context.filterSize === undefined ? '' : ` (filter carried ${context.filterSize} ids)`) +
      ` — reading on from row ${from + PAGE}. An unpaged read here would have silently dropped everything past this point.`
    )
  }
  throw new Error(
    `[supabaseRead] ${context.table}: still returning full pages after ${MAX_PAGES} of them ` +
    `(${MAX_PAGES * PAGE} rows). Giving up rather than looping — is the query missing a stable order?`
  )
}

/**
 * The full bulk-read shape: chunk an id list so each `.in(...)` filter fits in a URL, then page
 * each chunk so nothing is lost to the row cap. Returns every row across every chunk.
 *
 * `makeQuery` must apply a total order (see the module note) — for a junction table, its whole
 * primary key.
 */
export async function fetchAllChunked<T>(
  ids: string[],
  chunkSize: number,
  makeQuery: (chunk: string[]) => RangeableQuery<T>,
  context: { table: string }
): Promise<T[]> {
  const rows: T[] = []
  if (ids.length === 0) return rows
  for (const chunk of chunked(ids, chunkSize)) {
    rows.push(...await fetchAllRows<T>(
      () => makeQuery(chunk),
      { table: context.table, filterSize: chunk.length }
    ))
  }
  return rows
}
