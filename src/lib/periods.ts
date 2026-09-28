/**
 * The app's collection period boundaries — one definition of "today", "yesterday", "this week"
 * and "last week", shared by everything on /dashboard that counts by period.
 *
 * `periodBounds` used to be a local function inside DashboardClient, feeding the "Times
 * collected" cards only. It lives here now because the "Who's collecting" panel counts over the
 * same windows: two copies of "which Monday?" that happen to agree today is exactly how the
 * panel's per-person totals would one day stop reconciling with the cards above them. There is
 * one Monday, computed once, and both readers import it.
 *
 * ── Local, not UTC ────────────────────────────────────────────────────────────────────────
 * "Collected today" means the collector's today, at the tablet in the shed. The bounds are
 * built from the local calendar day and converted to instants at query time;
 * operation_times.created_at is a timestamptz, so the comparison is exact either way.
 *
 * ── The windows are not like-for-like, on purpose ─────────────────────────────────────────
 * "This week" runs from Monday to NOW — a partial week, because it is a progress figure.
 * "Last week" is the full Monday–Sunday before it. Comparing the two directly on a Tuesday
 * flatters last week, which is why every reader prints the window it counted (`periodRangeLabel`)
 * rather than just its name.
 */

/** The five windows the collection panel offers. The first four are period-bounded; `overall`
 * is unbounded in both directions and counts every row ever recorded. */
export type CollectionTimeframe = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'overall'

export const COLLECTION_TIMEFRAMES: { key: CollectionTimeframe; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'thisWeek', label: 'This week' },
  { key: 'lastWeek', label: 'Last week' },
  { key: 'overall', label: 'Overall' },
]

export interface PeriodBounds {
  /** Local midnight this morning. */
  todayStart: Date
  /** Local midnight yesterday morning — yesterday is [yesterdayStart, todayStart). */
  yesterdayStart: Date
  /** Local midnight on the Monday of the current week. */
  thisWeekStart: Date
  /** Local midnight on the Monday before that. */
  lastWeekStart: Date
}

/**
 * Local midnight today, yesterday, and the Monday-start week boundaries around them.
 *
 * `now` is injectable purely so a caller can hold one instant across several derived windows;
 * it defaults to the current time and no caller in the app passes it anything else.
 */
export function periodBounds(now: Date = new Date()): PeriodBounds {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(todayStart.getDate() - 1)
  // getDay(): 0 = Sunday. Shift so Monday is the first day of the week.
  const daysSinceMonday = (todayStart.getDay() + 6) % 7
  const thisWeekStart = new Date(todayStart)
  thisWeekStart.setDate(todayStart.getDate() - daysSinceMonday)
  const lastWeekStart = new Date(thisWeekStart)
  lastWeekStart.setDate(thisWeekStart.getDate() - 7)
  return { todayStart, yesterdayStart, thisWeekStart, lastWeekStart }
}

/** A half-open window over `created_at`: `from` inclusive, `to` exclusive. A null bound is
 * genuinely unbounded — no filter is applied on that side at all. */
export interface PeriodWindow {
  from: Date | null
  to: Date | null
}

/** The `created_at` window a timeframe selects. Half-open throughout — `>= from` and `< to` —
 * so consecutive windows tile the timeline without double-counting the midnight row. */
export function timeframeWindow(
  timeframe: CollectionTimeframe,
  bounds: PeriodBounds = periodBounds()
): PeriodWindow {
  switch (timeframe) {
    case 'today': return { from: bounds.todayStart, to: null }
    case 'yesterday': return { from: bounds.yesterdayStart, to: bounds.todayStart }
    case 'thisWeek': return { from: bounds.thisWeekStart, to: null }
    case 'lastWeek': return { from: bounds.lastWeekStart, to: bounds.thisWeekStart }
    case 'overall': return { from: null, to: null }
  }
}

/** "25 Aug" — the day format the period labels are built from. */
export function fmtPeriodDay(d: Date): string {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}

/**
 * The window a timeframe actually counted, in words — printed under every figure derived from
 * it so the boundary is verifiable at a glance rather than taken on trust.
 */
export function periodRangeLabel(
  timeframe: CollectionTimeframe,
  bounds: PeriodBounds = periodBounds()
): string {
  const { todayStart, yesterdayStart, thisWeekStart, lastWeekStart } = bounds
  const lastWeekEnd = new Date(thisWeekStart)
  lastWeekEnd.setDate(thisWeekStart.getDate() - 1)
  switch (timeframe) {
    case 'today': return `since midnight, ${fmtPeriodDay(todayStart)}`
    case 'yesterday': return `${fmtPeriodDay(yesterdayStart)}, midnight to midnight`
    case 'thisWeek': return `${fmtPeriodDay(thisWeekStart)} — today`
    case 'lastWeek': return `${fmtPeriodDay(lastWeekStart)} — ${fmtPeriodDay(lastWeekEnd)}`
    case 'overall': return 'every time ever recorded'
  }
}
