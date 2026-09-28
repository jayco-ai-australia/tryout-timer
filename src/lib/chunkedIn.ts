import { chunked, type SupabaseErrorLike } from './supabaseRead'

/**
 * `.in(...)` id lists, split so the request URL stays under Supabase's edge limit.
 *
 * PostgREST filters travel in the QUERY STRING, so an `.in('id', ids)` filter serialises every
 * id into the URL: `?id=in.(uuid,uuid,uuid,…)`. Supabase's edge rejects a request whose URL is
 * over roughly 16KB, and it does so with a bare 400 — no PostgREST error body, no message
 * naming the filter, just "Bad Request". A UUID plus its comma costs ~37 bytes, so:
 *
 *   100 UUIDs ≈  4KB   — the default here, a comfortable quarter of the budget
 *   ~430 UUIDs ≈ 16KB  — the cliff
 *   ~700 UUIDs ≈ 28KB  — /model-total on the Motor Home line, which is what fell off it
 *
 * The limit is on the whole URL, not just the filter, so the budget also has to absorb the
 * base path, the `select=` column list and any extra filters. 100 leaves room for all of it.
 *
 * Lines with fewer operations stayed under 16KB and worked, which is why this looked like a
 * Motor-Home-specific data problem rather than a URL-length one.
 *
 * ── RELATIONSHIP TO lib/supabaseRead's fetchAllChunked ──────────────────────────────────────
 * There are TWO independent limits on a bulk read (see the note atop lib/supabaseRead):
 *   - URL length caps how many ids fit in one filter  → this module.
 *   - The 1,000-row response cap limits what ONE request can RETURN → fetchAllChunked's paging.
 *
 * selectIn addresses only the first. That is sufficient — and complete — for a lookup keyed by
 * PRIMARY KEY (`.in('id', …)`), where a chunk of 100 ids can return at most 100 rows and the
 * response cap is unreachable by construction. For a fan-out read, where one id can match many
 * rows (a junction table, or `.in('job_id', …)`), a chunk CAN exceed the row cap and be
 * silently truncated; those reads want fetchAllChunked, which chunks and pages. Prefer
 * fetchAllChunked whenever the rows-per-id ratio is not 1.
 */
export async function selectIn<T>(
  ids: string[],
  fetchChunk: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: SupabaseErrorLike | null }>,
  chunkSize = 100,
): Promise<T[]> {
  // An empty `.in()` is its own bug, not an edge case worth serialising: PostgREST renders it as
  // `id=in.()`, which is a syntax error and comes back 400 — the same bare "Bad Request" this
  // module exists to prevent. Callers that legitimately have nothing to look up get [] without a
  // round trip; a caller that got here with an empty list by mistake sees an empty result rather
  // than an error blamed on the query.
  if (!ids || ids.length === 0) return []

  // De-duplicated first: a repeated id costs URL budget and buys nothing, since `IN` is a set
  // test. Callers mostly de-dupe already — doing it here means the chunk arithmetic is over the
  // ids actually sent, so `chunkSize` means what it says.
  const unique = [...new Set(ids)]

  // Chunks are independent reads with no ordering relationship, so they run concurrently. The
  // rows come back in chunk order, NOT in any order the query asked for — a caller that needs a
  // global sort has to apply it after this returns (see the callers that re-sort client-side).
  const results = await Promise.all(chunked(unique, chunkSize).map(fetchChunk))

  const rows: T[] = []
  for (const { data, error } of results) {
    // First error wins. Promise.all has already awaited every chunk by this point, so nothing is
    // left in flight — this just picks which failure to report.
    if (error) throw new Error(error.message ?? 'Request failed')
    if (data) rows.push(...data)
  }
  return rows
}
