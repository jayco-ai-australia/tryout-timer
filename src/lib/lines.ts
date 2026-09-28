import type { SupabaseClient } from '@supabase/supabase-js'
import { READ_CHUNK, fetchAllChunked, fetchAllRows, type RangeableQuery } from './supabaseRead'
import type { Product } from './types'

/**
 * THE answer to "which models belong to this production line" — one function, every screen.
 *
 * ── Why this module exists ────────────────────────────────────────────────────────────────
 * Until now every screen answered it the same obvious way: `products.production_line_id = <the
 * line>`. That is right for a BUILD line (Caravan, Motor Home, Campervan) and wrong for a
 * PRE-ASSEMBLY one.
 *
 * Pre-assembly lines — Chassis, Lamination, Saws, Sew, Filling, Training — own no products at
 * all. Nothing in `products` points at them, so the obvious query returns an empty list, and
 * every screen that asked it showed the same thing: no models to link, a "0 / 0 models" badge,
 * an empty coverage pane, a model picker with nothing in it. The work is real and gets timed;
 * it is the model list that was missing.
 *
 * What a pre-assembly line actually works on is the models of the build lines it FEEDS. Chassis
 * builds chassis for Caravan, so Chassis's models are Caravan's models. That mapping lives in
 * `production_line_feeds` (source_line_id → target_line_id), and `production_lines.is_pre_assembly`
 * marks which lines are asking the inherited question.
 *
 * ── The rule, in one place ────────────────────────────────────────────────────────────────
 *   normal line        → products.production_line_id = lineId
 *   pre-assembly line  → products.production_line_id IN (the lines it feeds)
 *   no line in scope   → every product
 *
 * Every model list in the app goes through modelsForLine below. The point is not tidiness: a
 * screen that kept the old query would silently disagree with the rest of the app about what a
 * pre-assembly line even contains, and the disagreement would look like missing data rather
 * than a bug.
 *
 * ── What this deliberately does NOT change ────────────────────────────────────────────────
 * Nothing downstream of the model list knows pre-assembly exists, and nothing needs to.
 * model_operations still links an operation to a product; operation_times still records against
 * an operation; recordOperationTime still stamps provenance from the JOB. An operation on a
 * Chassis job linked to a Caravan model is exactly as valid as any other pair — the applies-list
 * has never required the operation and the product to share a line, and lib/coverage counts
 * pairs, not lines. This module widens which products are OFFERED, and stops there.
 *
 * A consequence worth stating: for a pre-assembly line, the rows this returns carry a
 * `production_line_id` that is NOT lineId — it is the build line the model really belongs to.
 * Any caller tempted to re-filter the result by `production_line_id === lineId` would get an
 * empty list back and reintroduce the exact bug this module fixes. Nothing does; the two places
 * that used to (a count on /setup, a filter on /dashboard) now ask this instead.
 */

/** A production line, as this module needs it. `is_pre_assembly` defaults false in the database,
 * and is read as false when absent so a stale cached row can't turn a build line into one. */
interface LineRow {
  id: string
  name: string
  is_pre_assembly: boolean | null
}

interface FeedRow {
  source_line_id: string
  target_line_id: string
}

export interface LineTopology {
  /** Every line, by id. */
  linesById: Map<string, LineRow>
  /** source line id → the build lines it feeds, in the order read. */
  feedTargets: Map<string, string[]>
}

/**
 * The cache. ONE fetch per session, shared by every caller.
 *
 * Held as the PROMISE rather than the resolved value on purpose: several screens mount at once
 * and all ask on their first render, and caching the value would let all of them miss and fire
 * their own copy of the read before the first one landed. Caching the promise means the second
 * caller awaits the first caller's request.
 *
 * A failed load is not cached — the promise is dropped so the next caller retries rather than
 * every screen inheriting one transient network error for the life of the tab.
 */
let topologyPromise: Promise<LineTopology> | null = null

/** Drops the cache. For an admin screen that has just edited lines or feeds — the mapping
 * changes almost never, which is why it is cached at all, but "almost" is not "never". */
export function resetLineTopologyCache(): void {
  topologyPromise = null
}

export function loadLineTopology(supabase: SupabaseClient): Promise<LineTopology> {
  if (topologyPromise) return topologyPromise
  topologyPromise = (async () => {
    const [{ data: lineRows, error: lineError }, { data: feedRows, error: feedError }] = await Promise.all([
      supabase.from('production_lines').select('id, name, is_pre_assembly').order('name'),
      supabase.from('production_line_feeds').select('source_line_id, target_line_id'),
    ])
    if (lineError) throw new Error(lineError.message)
    // A feeds table that can't be read is not survivable by guessing: falling back to "no feeds"
    // would quietly render every pre-assembly line as having no models, which is precisely the
    // symptom this module removes and would be indistinguishable from it.
    if (feedError) throw new Error(feedError.message)

    const linesById = new Map<string, LineRow>()
    for (const l of (lineRows ?? []) as LineRow[]) linesById.set(l.id, l)

    const feedTargets = new Map<string, string[]>()
    for (const f of (feedRows ?? []) as FeedRow[]) {
      const list = feedTargets.get(f.source_line_id)
      if (list) list.push(f.target_line_id)
      else feedTargets.set(f.source_line_id, [f.target_line_id])
    }

    return { linesById, feedTargets }
  })()

  // Drop a rejected promise so the failure isn't cached for the session.
  topologyPromise.catch(() => { topologyPromise = null })
  return topologyPromise
}

/** Whether this line inherits its models rather than owning them. False for an unknown id: a
 * line nothing knows about is treated as a normal one, which degrades to the old behaviour
 * rather than to an empty model list. */
export async function isPreAssemblyLine(supabase: SupabaseClient, lineId: string | null | undefined): Promise<boolean> {
  if (!lineId) return false
  const { linesById } = await loadLineTopology(supabase)
  return linesById.get(lineId)?.is_pre_assembly === true
}

/**
 * The build lines this line feeds — empty for a normal line, and empty for a pre-assembly line
 * with no feeds configured yet.
 *
 * That second empty is a real and legitimate state (a new pre-assembly line before anybody has
 * said what it feeds), and it is why modelsForLine treats "pre-assembly with no targets" as "no
 * models" rather than falling back to the line's own products: the fallback would return the
 * empty list anyway, and pretending otherwise would hide an unconfigured line.
 */
export async function feedTargetsForLine(supabase: SupabaseClient, lineId: string | null | undefined): Promise<string[]> {
  if (!lineId) return []
  const { linesById, feedTargets } = await loadLineTopology(supabase)
  if (linesById.get(lineId)?.is_pre_assembly !== true) return []
  return feedTargets.get(lineId) ?? []
}

/**
 * The models a line works on. THE resolver — see the module note.
 *
 * `lineId` empty/null means "no line in scope" and yields every product, which is what the
 * unfiltered ("All production lines") views on /dashboard and /reports mean by it.
 *
 * Always PAGED (lib/supabaseRead), never a bare select: a build line runs to ~90 models and the
 * unscoped call to every product in the database is far past PostgREST's 1,000-row cap, which
 * truncates as a normal 200 with a short array. A short read here shrinks a coverage denominator
 * or drops models out of a picker with nothing on screen to say so.
 *
 * Sorted by `products.model` in JS rather than left to the query. For a pre-assembly line the
 * rows arrive as several chunks, each sorted only within itself (see lib/supabaseRead), so the
 * concatenation of sorted runs is not itself sorted — and every caller renders this in array
 * order.
 */
export async function modelsForLine(supabase: SupabaseClient, lineId: string | null | undefined): Promise<Product[]> {
  const byModel = (a: Product, b: Product) => a.model.localeCompare(b.model)

  if (!lineId) {
    const all = await fetchAllRows<Product>(
      () => supabase.from('products').select('*').order('id') as unknown as RangeableQuery<Product>,
      { table: 'products' }
    )
    return all.sort(byModel)
  }

  const targets = await feedTargetsForLine(supabase, lineId)

  if (await isPreAssemblyLine(supabase, lineId)) {
    // Configured with nothing to feed: it genuinely has no models yet, and saying so is better
    // than falling back to its own products, which are none by definition.
    if (targets.length === 0) return []
    const inherited = await fetchAllChunked<Product>(
      targets, READ_CHUNK,
      (chunk) => supabase.from('products').select('*')
        .in('production_line_id', chunk).order('id') as unknown as RangeableQuery<Product>,
      { table: 'products' }
    )
    // Two feeds can't share a product (a product has one line), so no de-duplication is needed —
    // but the chunks still have to be re-sorted as one list. See the note above.
    return inherited.sort(byModel)
  }

  const own = await fetchAllRows<Product>(
    () => supabase.from('products').select('*')
      .eq('production_line_id', lineId).order('id') as unknown as RangeableQuery<Product>,
    { table: 'products' }
  )
  return own.sort(byModel)
}

/**
 * ── The line-level split: is this line's labour pre-assembly, or line labour? ──────────────
 *
 * `isPreAssemblyLine` above answers that too, but asynchronously — one await per question. A
 * screen that has to ask it of every job it renders (see /model-total's labour-source filter)
 * needs the answer synchronously, inside a `useMemo` over a list of jobs, not as N promises.
 *
 * So this loads the same cached topology ONCE and hands back a plain synchronous view over it.
 * Same cache, same rows, same rule as everything else in this module — the point is that the
 * `is_pre_assembly` check itself stays here rather than being re-read off a locally-fetched
 * `production_lines` row in a component, which is how two screens end up disagreeing about what
 * a pre-assembly line is.
 */
export interface LineSplit {
  /**
   * Whether labour on this line is pre-assembly. FALSE for a null/unknown id — a job whose
   * line nothing knows about is treated as ordinary line labour, matching isPreAssemblyLine's
   * own degradation and keeping such a job visible under "Line labour" rather than vanishing
   * from both halves of a split that is meant to partition everything.
   */
  isPreAssembly(lineId: string | null | undefined): boolean
  /** The line's name, or a readable placeholder — never an empty string, since callers render
   * this as a heading. */
  name(lineId: string | null | undefined): string
}

export async function loadLineSplit(supabase: SupabaseClient): Promise<LineSplit> {
  const { linesById } = await loadLineTopology(supabase)
  return {
    isPreAssembly: (lineId) => (lineId ? linesById.get(lineId)?.is_pre_assembly === true : false),
    name: (lineId) => (lineId ? linesById.get(lineId)?.name ?? 'Unknown line' : 'No production line'),
  }
}

/**
 * Every pre-assembly area, A–Z, with the build lines it feeds.
 *
 * The list is the whole point: a report that enumerates areas by walking the JOBS it found would
 * silently omit an area nobody has recorded anything against, which is exactly the area an
 * operations manager most needs to see. So the areas come from `production_lines` — every line
 * flagged `is_pre_assembly`, whether or not anything downstream knows about it — and the caller
 * renders "no times collected" rather than nothing at all.
 *
 * `feeds` is feedTargetsForLine's answer, carried along so a caller scoping a model set per area
 * doesn't make N more round trips for a mapping that is already in the cached topology. An area
 * with no feeds configured yet comes back with an empty array, which is a real state and not an
 * error — see feedTargetsForLine.
 */
export interface PreAssemblyArea {
  id: string
  name: string
  /** Build line ids this area feeds. Empty when nothing has been configured for it. */
  feeds: string[]
}

export async function listPreAssemblyAreas(supabase: SupabaseClient): Promise<PreAssemblyArea[]> {
  const { linesById, feedTargets } = await loadLineTopology(supabase)
  return [...linesById.values()]
    .filter((l) => l.is_pre_assembly === true)
    .map((l) => ({ id: l.id, name: l.name, feeds: feedTargets.get(l.id) ?? [] }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
