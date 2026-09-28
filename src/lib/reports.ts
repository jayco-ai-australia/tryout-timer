import type { SupabaseClient } from '@supabase/supabase-js'
import { selectIn } from './chunkedIn'
import { fetchAllChunked, fetchAllRows, logSupabaseError, READ_CHUNK, type RangeableQuery } from './supabaseRead'
import { periodBounds, timeframeWindow, type PeriodWindow } from './periods'
import { teamForJob } from './sections'

/**
 * /reports — individual operation_times records, filtered and printable.
 *
 * The rebuild removed /records, /analytics and /gaps, which left no way to get a list of
 * collected times OUT of the app and onto paper for someone without a login. This module is the
 * read behind that page: one row per record, never averaged, never rolled up.
 *
 * ── What a "record" is here ───────────────────────────────────────────────────────────────
 * Every row is one operation_times row, EXCEPT the superseded ones. A run with
 * superseded_by set is a measurement that was replaced by a later one (see the superseded_by
 * note in lib/types) — it is history behind a current figure, not a separate piece of work, and
 * listing it would double-count the same job on a printed sheet. Nothing else is filtered out:
 * imported rows, rows with no operator and rows on retired operations all appear, because they
 * are all real records of work that was measured.
 *
 * ── The joins, and the three that have bitten us ──────────────────────────────────────────
 *  1. operation_times has NO product_id. Which model(s) a run counts for lives entirely in the
 *     operation_time_models junction, and one run can carry several. So "filter by model" is
 *     "find the operation_time_ids in the junction for that product, then read those times" —
 *     never a column comparison, and the Models column is a joined list, not a single value.
 *  2. operation_times.team_id / .production_line_id are stamped from the operation's JOB at
 *     write time, not from the operator. They are filtered on directly (indexed, and the only
 *     honest answer for a historical row); see the divergence note on `describeFilters`.
 *  3. Section comes from the job's section_id, and TEAM IS DERIVED FROM THAT SECTION —
 *     lib/sections' teamForJob, not jobs.team_id, which is legacy and can lag a section move.
 *
 * ── Two limits, two helpers ───────────────────────────────────────────────────────────────
 * Every id-list read here is chunked so its URL stays under Supabase's ~16KB cap (lib/chunkedIn,
 * which is what fixed Model Total on the Motor Home line). Reads whose rows-per-id ratio is 1 —
 * a lookup by PRIMARY KEY — use `selectIn`: a chunk of 100 ids returns at most 100 rows, so
 * chunking alone is complete. Reads that fan out (one time id → many notes, many models; one
 * operation id → many times) ALSO have to clear the 1,000-row response cap, so they go through
 * lib/supabaseRead's fetchAllChunked, which chunks AND pages. Getting that wrong is silent: a
 * truncated response comes back 200 with a short array, and the report would simply be missing
 * rows with nothing on screen to say so.
 */

/** Column list for the base read — everything a row needs plus the columns it is filtered by. */
const TIME_COLUMNS = 'id, operation_id, operator_id, total_minutes, created_at, team_id, production_line_id, chassis_id'

/**
 * operation_times as this page reads it.
 *
 * `operator_id` is nullable here and NOT in lib/types' OperationTime, which declares it
 * `string`. The table is the authority and the table allows null: roughly 94% of imported rows
 * carry no operator. The narrower type in lib/types is wrong rather than stricter, and trusting
 * it here would mean rendering "null" or dropping the row.
 */
interface RawTime {
  id: string
  operation_id: string
  operator_id: string | null
  total_minutes: number | null
  created_at: string
  team_id: string | null
  production_line_id: string | null
  chassis_id: string | null
}

/**
 * The Model filter's one non-product value: runs attached to NO model at all.
 *
 * operation_times has no product_id — a run's models live in operation_time_models — so a row
 * with zero rows in that junction is unattached. That state is not an anomaly to hunt down: it
 * pre-exists on historical imports, and /model-total's "doesn't apply to this model" unlink
 * (lib/modelLinks) creates more of it by design, because detaching a run must never delete it.
 * Without this option those runs are reachable from no filter on this screen, which is how a
 * record nobody can find starts looking like a record that was destroyed.
 *
 * A sentinel rather than a nullable field so it travels through the query string, the filter
 * state and the label builders as an ordinary Model value. It is not a product id and is never
 * sent to the database.
 */
export const UNATTACHED_PRODUCT_ID = '__unattached__'
export const UNATTACHED_LABEL = 'Unattached (no model)'

export type ReportDatePreset = 'today' | 'thisWeek' | 'lastWeek' | 'all' | 'custom'

export const REPORT_DATE_PRESETS: { key: ReportDatePreset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'thisWeek', label: 'This week' },
  { key: 'lastWeek', label: 'Last week' },
  { key: 'all', label: 'All time' },
]

/** Every filter the page offers. Blank string = "not filtered by this", throughout — the same
 * convention the select elements themselves use, so no separate null-vs-empty question exists. */
export interface ReportFilters {
  preset: ReportDatePreset
  /** YYYY-MM-DD. Only read when preset is 'custom'. */
  customFrom: string
  customTo: string
  lineId: string
  productId: string
  teamId: string
  jobId: string
  operatorId: string
  /** tryouts.id — resolved to its chassis_id before the query runs, since operation_times
   * carries chassis_id and knows nothing about the tryouts table. */
  tryoutId: string
}

export const EMPTY_FILTERS: ReportFilters = {
  preset: 'today', customFrom: '', customTo: '',
  lineId: '', productId: '', teamId: '', jobId: '', operatorId: '', tryoutId: '',
}

/** One printed line. Every label is resolved to a string here — the table renders, it doesn't
 * look anything up — so what prints and what is on screen cannot drift apart. */
export interface ReportRow {
  id: string
  createdAt: string
  teamName: string
  sectionName: string
  jobName: string
  operationName: string
  operatorName: string
  minutes: number | null
  /** Comma-separated on screen and in print. Empty when the run was never linked to a model. */
  models: string[]
  /** Joined with "; ". Empty when the run has no notes. */
  notes: string[]
}

export interface ReportTotals {
  recordCount: number
  totalMinutes: number
  operationCount: number
  jobCount: number
}

/** Shown wherever a name is missing — an absent operator, an unsectioned job, a run linked to
 * no model. Never a blank cell: on paper, blank reads as "the printer missed it". */
export const NONE = '—'

// ── Date range ──────────────────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' → local midnight that morning. Built from the parts rather than
 * `new Date(iso)`, which reads a bare date as UTC and lands on the previous day here. */
function parseLocalDate(value: string): Date | null {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

/**
 * The `created_at` window the filters select, half-open (`>= from`, `< to`) like every other
 * window in the app — see lib/periods, whose bounds the four presets reuse rather than
 * recomputing "which Monday?" a second time.
 *
 * A custom range is INCLUSIVE of its end date, which is what the two date inputs look like they
 * mean: the exclusive bound is midnight the following morning.
 */
export function resolveReportWindow(filters: ReportFilters, now: Date): PeriodWindow {
  const bounds = periodBounds(now)
  switch (filters.preset) {
    case 'today': return timeframeWindow('today', bounds)
    case 'thisWeek': return timeframeWindow('thisWeek', bounds)
    case 'lastWeek': return timeframeWindow('lastWeek', bounds)
    case 'all': return timeframeWindow('overall', bounds)
    case 'custom': {
      const from = parseLocalDate(filters.customFrom)
      const end = parseLocalDate(filters.customTo)
      const to = end ? new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1) : null
      return { from, to }
    }
  }
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * The window in words, for the filter summary and the print header: "26 Aug 2026",
 * "17 – 23 Aug 2026", "28 Jul – 23 Aug 2026", "All time".
 *
 * Derived from the resolved window rather than from the preset name, so a preset and the custom
 * range that reproduces it always describe themselves identically. An open-ended window (Today,
 * This week) runs to `now`, which is what those presets mean — a partial period.
 */
export function describeDateRange(window: PeriodWindow, now: Date): string {
  if (!window.from) return 'All time'
  // The last instant actually included, so an inclusive label can be printed from a half-open
  // window without the end date reading one day late.
  const end = window.to ? new Date(window.to.getTime() - 1) : now
  const sameDay = window.from.toDateString() === end.toDateString()
  if (sameDay) return fmtDay(window.from)
  const sameYear = window.from.getFullYear() === end.getFullYear()
  const sameMonth = sameYear && window.from.getMonth() === end.getMonth()
  if (sameMonth) return `${window.from.getDate()} – ${fmtDay(end)}`
  const startOpts: Intl.DateTimeFormatOptions = sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' }
  return `${window.from.toLocaleDateString('en-AU', startOpts)} – ${fmtDay(end)}`
}

// ── Deep links ──────────────────────────────────────────────────────────────────────────────

/**
 * The query-string names for the filters. Short, stable, and the ONE place they are spelled —
 * the parser and the link builder below both read this map, so a link can never be written with
 * a key the page doesn't read back.
 *
 * Added for /model-total's "View the copied times" action, which needs to hand someone a report
 * of one model with no filtering left to do by hand. Model Total's own per-model report link
 * will use the same mechanism rather than inventing a second one.
 */
const PARAM_KEYS = {
  line: 'line', model: 'model', team: 'team', job: 'job',
  operator: 'operator', tryout: 'tryout', range: 'range', from: 'from', to: 'to',
} as const

const VALID_PRESETS: ReportDatePreset[] = ['today', 'thisWeek', 'lastWeek', 'all', 'custom']

/** Next's searchParams shape: a value can arrive repeated (`?line=a&line=b`), in which case the
 * first wins — a filter is single-valued, and guessing between two is worse than taking one. */
type ParamValue = string | string[] | undefined
function one(value: ParamValue): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

/**
 * Filters from a URL, falling back to the viewer's own line when the link says nothing about one.
 *
 * Unrecognised values are dropped rather than rejected: a stale or hand-edited link should open
 * a usable report, not an error page. An unknown `range` falls back to the default 'today'; a
 * `from`/`to` pair implies a custom range even if `range` was left off, because two dates in a
 * URL can't mean anything else.
 */
export function reportFiltersFromParams(
  params: Record<string, ParamValue>,
  defaultLineId: string
): ReportFilters {
  const rawRange = one(params[PARAM_KEYS.range]) as ReportDatePreset
  const customFrom = one(params[PARAM_KEYS.from])
  const customTo = one(params[PARAM_KEYS.to])
  const hasCustomDates = !!(customFrom || customTo)
  const preset: ReportDatePreset = VALID_PRESETS.includes(rawRange)
    ? rawRange
    : (hasCustomDates ? 'custom' : EMPTY_FILTERS.preset)

  const lineParam = one(params[PARAM_KEYS.line])
  return {
    preset,
    customFrom,
    customTo,
    // Only an ABSENT line param falls back to the profile default. An explicit empty one
    // (`?line=`) is a deliberate "all lines" and is honoured as written.
    lineId: params[PARAM_KEYS.line] === undefined ? defaultLineId : lineParam,
    productId: one(params[PARAM_KEYS.model]),
    teamId: one(params[PARAM_KEYS.team]),
    jobId: one(params[PARAM_KEYS.job]),
    operatorId: one(params[PARAM_KEYS.operator]),
    tryoutId: one(params[PARAM_KEYS.tryout]),
  }
}

/**
 * The inverse: a /reports href for a set of filters. Only what is actually set is written, so
 * the URL stays readable and a link carrying just a model reads as one.
 *
 * `line` is written whenever it is given even though the page would default it — a link that
 * relies on the recipient's profile line would open a different report for different people,
 * which is the opposite of what handing someone a link is for.
 */
export function buildReportHref(filters: Partial<ReportFilters>): string {
  const q = new URLSearchParams()
  if (filters.lineId) q.set(PARAM_KEYS.line, filters.lineId)
  if (filters.productId) q.set(PARAM_KEYS.model, filters.productId)
  if (filters.teamId) q.set(PARAM_KEYS.team, filters.teamId)
  if (filters.jobId) q.set(PARAM_KEYS.job, filters.jobId)
  if (filters.operatorId) q.set(PARAM_KEYS.operator, filters.operatorId)
  if (filters.tryoutId) q.set(PARAM_KEYS.tryout, filters.tryoutId)
  if (filters.preset && filters.preset !== EMPTY_FILTERS.preset) q.set(PARAM_KEYS.range, filters.preset)
  if (filters.customFrom) q.set(PARAM_KEYS.from, filters.customFrom)
  if (filters.customTo) q.set(PARAM_KEYS.to, filters.customTo)
  const qs = q.toString()
  return qs ? `/reports?${qs}` : '/reports'
}

// ── Active-filter summary ───────────────────────────────────────────────────────────────────

/** Resolved names for whatever is selected — the ids live in ReportFilters, the labels are only
 * known to the page that loaded the option lists, so they are passed back in rather than
 * re-fetched. A blank or null entry is simply left out of the summary. */
export interface ReportFilterLabels {
  lineName?: string | null
  modelName?: string | null
  teamName?: string | null
  jobName?: string | null
  operatorName?: string | null
  tryoutLabel?: string | null
  dateLabel: string
}

/**
 * "Motor Home · FA.25-2.RT-MY26 · 26 Aug 2026" — what was asked for, in the order a person
 * would say it, with the date last. This exact string appears above the table on screen AND in
 * the print header, from this one function, so a printed sheet can never claim a different
 * scope from the screen it was printed off.
 *
 * "All lines" is stated rather than omitted: on a sheet handed to someone who wasn't there when
 * it was run, a missing line reads as an oversight, not as "every line".
 *
 * NOTE ON TEAM: the Team filter is applied to operation_times.team_id (stamped from the job at
 * write time), while the Team COLUMN is derived from the job's current section. For a job that
 * has since moved to another team's section, those two disagree — a historical row keeps the
 * team it was recorded under, and the column shows where its job sits today. Both are correct
 * answers to different questions and neither is silently rewritten.
 */
export function describeFilters(labels: ReportFilterLabels): string {
  const parts = [
    labels.lineName || 'All lines',
    labels.modelName,
    labels.teamName,
    labels.jobName,
    labels.operatorName,
    labels.tryoutLabel,
    labels.dateLabel,
  ]
  return parts.filter((p): p is string => !!p && p.trim() !== '').join(' · ')
}

/** The empty state, echoing the filters back rather than leaving a blank table. "All time" reads
 * badly after "on", so an unbounded report drops the clause instead of printing "on All time". */
export function describeEmptyResult(labels: ReportFilterLabels): string {
  const scope = [labels.lineName || 'All lines', labels.modelName, labels.teamName, labels.jobName, labels.operatorName, labels.tryoutLabel]
    .filter((p): p is string => !!p && p.trim() !== '')
    .join(' · ')
  if (labels.dateLabel === 'All time') return `No times recorded for ${scope}.`
  return `No times recorded for ${scope} on ${labels.dateLabel}.`
}

// ── The read ────────────────────────────────────────────────────────────────────────────────

/**
 * The scalar half of the filter set, applied server-side on operation_times' own columns.
 *
 * Called fresh for every chunk and every page rather than reused: a supabase builder is mutable,
 * and `.range()`/`.in()` write onto the object they are called on.
 */
function scopedTimes(
  supabase: SupabaseClient,
  filters: ReportFilters,
  window: PeriodWindow,
  chassisId: string | null
) {
  let q = supabase
    .from('operation_times')
    .select(TIME_COLUMNS)
    // Superseded runs are history behind a current record, not separate work — see the module
    // note. This is the ONLY row-level exclusion on this page.
    .is('superseded_by', null)
  if (window.from) q = q.gte('created_at', window.from.toISOString())
  if (window.to) q = q.lt('created_at', window.to.toISOString())
  // Stamped from the JOB, not the operator (module note 2) — a direct column comparison is the
  // whole filter, no join required.
  if (filters.lineId) q = q.eq('production_line_id', filters.lineId)
  if (filters.teamId) q = q.eq('team_id', filters.teamId)
  if (filters.operatorId) q = q.eq('operator_id', filters.operatorId)
  if (chassisId) q = q.eq('chassis_id', chassisId)
  return q
}

/**
 * The base read, under at most ONE id restriction.
 *
 * Two of the filters can't be expressed as a column comparison on operation_times, and each
 * turns into an id list. They are never applied as two `.in()` filters on one query: two id
 * lists in one URL is the ~16KB problem again, from the other direction. The model restriction
 * wins when both are set (it keys on the PRIMARY KEY, so its chunks can't overrun the row cap)
 * and the job filter is then applied client-side, over the operations join the table needs for
 * its Job column anyway — no extra round trip, no second filter in the URL.
 */
async function fetchTimes(
  supabase: SupabaseClient,
  filters: ReportFilters,
  window: PeriodWindow,
  chassisId: string | null
): Promise<RawTime[]> {
  // Model: operation_times has no product_id, so the junction is the filter (module note 1).
  // Paged, because a popular model on an unbounded date range has far more than 1,000 links.
  //
  // The unattached sentinel is the one Model value with no junction rows to start from — there
  // is no "id IN (the times with no links)" to ask for. It falls through to the unrestricted
  // read below and is applied where the model names are already known, at row-build time.
  if (filters.productId && filters.productId !== UNATTACHED_PRODUCT_ID) {
    const links = await fetchAllRows<{ operation_time_id: string }>(
      () => supabase
        .from('operation_time_models').select('operation_time_id')
        .eq('product_id', filters.productId)
        .order('operation_time_id') as unknown as RangeableQuery<{ operation_time_id: string }>,
      { table: 'operation_time_models' }
    )
    const timeIds = [...new Set(links.map((l) => l.operation_time_id))]
    // Guarded, not just an optimisation: `id=in.()` is a PostgREST syntax error and comes back
    // as the same bare 400 the chunking exists to prevent.
    if (timeIds.length === 0) return []
    // selectIn, not fetchAllChunked: `.in('id', …)` is a primary-key lookup, so 100 ids return
    // at most 100 rows and the response cap is unreachable. Chunking alone is complete here.
    return selectIn<RawTime>(timeIds, async (chunk) => {
      const res = await scopedTimes(supabase, filters, window, chassisId).in('id', chunk)
      if (res.error) logSupabaseError('reports — operation_times WHERE id IN (…)', res.error)
      return res as unknown as { data: RawTime[] | null; error: { message: string } | null }
    })
  }

  // Job: operation_times has no job_id either — it points at an operation, which points at the
  // job. One hop, then a fan-out read.
  if (filters.jobId) {
    const ops = await fetchAllRows<{ id: string }>(
      () => supabase
        .from('operations').select('id')
        .eq('job_id', filters.jobId)
        .order('id') as unknown as RangeableQuery<{ id: string }>,
      { table: 'operations' }
    )
    const opIds = ops.map((o) => o.id)
    if (opIds.length === 0) return []
    // fetchAllChunked, NOT selectIn: this fans out — one operation has many recorded runs, so a
    // chunk of 100 operations can return well past the 1,000-row cap and would be truncated
    // silently. Chunked AND paged, ordered by primary key because paging needs a total order.
    return fetchAllChunked<RawTime>(
      opIds, READ_CHUNK,
      (chunk) => scopedTimes(supabase, filters, window, chassisId)
        .in('operation_id', chunk)
        .order('id') as unknown as RangeableQuery<RawTime>,
      { table: 'operation_times' }
    )
  }

  // No id restriction at all — every row in the window. Still paged: "All time" on a line is
  // thousands of rows, and an unpaged read would quietly stop at 1,000.
  return fetchAllRows<RawTime>(
    () => scopedTimes(supabase, filters, window, chassisId)
      .order('id') as unknown as RangeableQuery<RawTime>,
    { table: 'operation_times' }
  )
}

/**
 * The whole page's data: filters in, printable rows out.
 *
 * `now` is passed in rather than read here so the window, the summary line and the print header
 * are all describing one instant — and so the caller can hold it until after hydration, since a
 * date evaluated during render differs between server and client markup.
 */
export async function fetchReportRows(
  supabase: SupabaseClient,
  filters: ReportFilters,
  now: Date
): Promise<ReportRow[]> {
  const window = resolveReportWindow(filters, now)

  // Try Out → chassis. The tryouts table is per-chassis and operation_times carries chassis_id,
  // so the tryout only ever needs resolving to that one id.
  let chassisId: string | null = null
  if (filters.tryoutId) {
    const { data, error } = await supabase
      .from('tryouts').select('chassis_id').eq('id', filters.tryoutId).maybeSingle()
    if (error) { logSupabaseError('reports — tryouts WHERE id', error); throw new Error(error.message) }
    // A tryout that no longer exists filters to nothing rather than silently widening to every
    // van, which is what dropping the filter would do.
    if (!data) return []
    chassisId = data.chassis_id as string
  }

  const times = await fetchTimes(supabase, filters, window, chassisId)
  if (times.length === 0) return []

  const timeIds = times.map((t) => t.id)
  const operationIds = [...new Set(times.map((t) => t.operation_id))]

  // ── Labels ──
  // None of these identity lookups filter on is_active. A retired operation, a merged-away job
  // and a merged-away section all still label real recorded history; excluding them would drop
  // rows off a report of work that genuinely happened. Same rule the identity lookups in
  // lib/jobs and lib/operationTimes' hop 3 already follow.
  //
  // Every one is a primary-key lookup, so selectIn (chunk only) is sufficient and complete.
  const operations = await selectIn<{ id: string; name: string; job_id: string }>(
    operationIds,
    (chunk) => supabase.from('operations').select('id, name, job_id').in('id', chunk)
  )
  const operationById = new Map(operations.map((o) => [o.id, o]))

  const jobIds = [...new Set(operations.map((o) => o.job_id).filter(Boolean))]
  const jobs = await selectIn<{ id: string; name: string; section_id: string | null }>(
    jobIds,
    (chunk) => supabase.from('jobs').select('id, name, section_id').in('id', chunk)
  )
  const jobById = new Map(jobs.map((j) => [j.id, j]))

  const sectionIds = [...new Set(jobs.map((j) => j.section_id).filter((id): id is string => !!id))]
  const sections = await selectIn<{ id: string; name: string; team_id: string | null }>(
    sectionIds,
    (chunk) => supabase.from('sections').select('id, name, team_id').in('id', chunk)
  )
  const sectionById = new Map(sections.map((s) => [s.id, s]))

  // Team is derived from the SECTION (module note 3), so the team ids to look up come from the
  // sections above — never from jobs.team_id and never from operation_times.team_id.
  const teamIds = [...new Set(sections.map((s) => s.team_id).filter((id): id is string => !!id))]
  const teams = await selectIn<{ id: string; name: string }>(
    teamIds,
    (chunk) => supabase.from('teams').select('id, name').in('id', chunk)
  )
  const teamNameById = new Map(teams.map((t) => [t.id, t.name]))

  const operatorIds = [...new Set(times.map((t) => t.operator_id).filter((id): id is string => !!id))]
  const operators = await selectIn<{ id: string; full_name: string }>(
    operatorIds,
    (chunk) => supabase.from('operators').select('id, full_name').in('id', chunk)
  )
  const operatorNameById = new Map(operators.map((o) => [o.id, o.full_name]))

  // ── Fan-out reads: chunked AND paged ──
  // One time can carry several models and several notes, so a chunk of 100 time ids can return
  // many more than 100 rows. selectIn would be wrong here for the same reason it is right above.
  const timeModels = await fetchAllChunked<{ operation_time_id: string; product_id: string }>(
    timeIds, READ_CHUNK,
    (chunk) => supabase
      .from('operation_time_models').select('operation_time_id, product_id')
      .in('operation_time_id', chunk)
      .order('operation_time_id').order('product_id') as unknown as RangeableQuery<{ operation_time_id: string; product_id: string }>,
    { table: 'operation_time_models' }
  )

  const productIds = [...new Set(timeModels.map((tm) => tm.product_id))]
  const products = await selectIn<{ id: string; model: string }>(
    productIds,
    (chunk) => supabase.from('products').select('id, model').in('id', chunk)
  )
  const modelById = new Map(products.map((p) => [p.id, p.model]))

  const modelsByTime = new Map<string, string[]>()
  for (const tm of timeModels) {
    const name = modelById.get(tm.product_id)
    if (!name) continue
    const list = modelsByTime.get(tm.operation_time_id)
    if (list) list.push(name)
    else modelsByTime.set(tm.operation_time_id, [name])
  }
  // Sorted per time so a multi-model run reads the same way every print.
  for (const list of modelsByTime.values()) list.sort((a, b) => a.localeCompare(b))

  const notes = await fetchAllChunked<{ operation_time_id: string; content: string; created_at: string }>(
    timeIds, READ_CHUNK,
    (chunk) => supabase
      .from('operation_time_notes').select('operation_time_id, content, created_at')
      .in('operation_time_id', chunk)
      .order('operation_time_id').order('created_at') as unknown as RangeableQuery<{ operation_time_id: string; content: string; created_at: string }>,
    { table: 'operation_time_notes' }
  )
  const notesByTime = new Map<string, string[]>()
  for (const n of notes) {
    const text = (n.content ?? '').trim()
    if (!text) continue
    const list = notesByTime.get(n.operation_time_id)
    if (list) list.push(text)
    else notesByTime.set(n.operation_time_id, [text])
  }

  // ── Rows ──
  const rows: ReportRow[] = []
  for (const t of times) {
    const op = operationById.get(t.operation_id)
    const job = op ? jobById.get(op.job_id) : undefined
    // teamForJob (lib/sections) is the ONE definition of whose team a job's work is: the team on
    // its section. jobs.team_id is not consulted anywhere on this page.
    const teamId = job ? teamForJob(job, sectionById) : null
    const section = job?.section_id ? sectionById.get(job.section_id) : undefined

    // Applied here, not in the URL, only when a model filter already claimed the one `.in()`
    // slot — see fetchTimes. When the job filter ran server-side this is a no-op.
    if (filters.jobId && filters.productId && op?.job_id !== filters.jobId) continue

    // The unattached filter, applied where the answer is already known: this run's model list.
    // Zero models IS the filter — see UNATTACHED_PRODUCT_ID.
    if (filters.productId === UNATTACHED_PRODUCT_ID && (modelsByTime.get(t.id) ?? []).length > 0) continue

    rows.push({
      id: t.id,
      createdAt: t.created_at,
      teamName: (teamId && teamNameById.get(teamId)) || NONE,
      sectionName: section?.name || NONE,
      jobName: job?.name || NONE,
      operationName: op?.name || NONE,
      // NULL on ~94% of imported rows. Rendered as an em dash — never blank, never "null", and
      // never a reason to drop the record.
      operatorName: (t.operator_id && operatorNameById.get(t.operator_id)) || NONE,
      minutes: t.total_minutes,
      models: modelsByTime.get(t.id) ?? [],
      notes: notesByTime.get(t.id) ?? [],
    })
  }

  // Date desc, then job, then operation. Sorted here rather than by the query: the rows arrive
  // chunk by chunk and page by page, so any per-request ordering only looks sorted.
  rows.sort((a, b) => {
    const byDate = b.createdAt.localeCompare(a.createdAt)
    if (byDate !== 0) return byDate
    const byJob = a.jobName.localeCompare(b.jobName)
    if (byJob !== 0) return byJob
    return a.operationName.localeCompare(b.operationName)
  })
  return rows
}

/** The summary bar, and the same figures repeated in the print header. Minutes are summed over
 * the rows that have one — an untimed record still counts as a record. */
export function summariseReport(rows: ReportRow[]): ReportTotals {
  let totalMinutes = 0
  const operations = new Set<string>()
  const jobs = new Set<string>()
  for (const r of rows) {
    totalMinutes += r.minutes ?? 0
    if (r.operationName !== NONE) operations.add(`${r.jobName}::${r.operationName}`)
    if (r.jobName !== NONE) jobs.add(r.jobName)
  }
  return { recordCount: rows.length, totalMinutes, operationCount: operations.size, jobCount: jobs.size }
}
