/**
 * The markers for an operation_time that is excluded from every figure, wherever a history view
 * lists one — the times drawer, /setup's collected times, the dashboard feed, /reports' records,
 * the model linker, the unlink confirm, /admin. Excluded records are shown, never filtered out of
 * a history view; these are what stop one reading as a live figure. One file so the wording is the
 * same everywhere.
 *
 * Two flags, two badges (see lib/operationTimes' countsTowardLabour for the rule):
 *   is_hidden = true   → HiddenTimeBadge
 *   is_active = false, or a retired operation or job above it  → RetiredTimeBadge
 *     (lib/operationTimes' isRetiredTime)
 * A record can carry both. TimeExclusionBadges renders whichever apply.
 */
export const HIDDEN_TIME_LABEL = 'hidden — not counted in totals'
export const RETIRED_TIME_LABEL = 'retired — not counted in totals'

export default function HiddenTimeBadge() {
  return (
    <span
      className="badge badge-amber"
      title="This record is kept as history but excluded from every labour figure and coverage number."
    >
      {HIDDEN_TIME_LABEL}
    </span>
  )
}

export function RetiredTimeBadge() {
  return (
    <span
      className="badge badge-grey"
      title="This record was retired or superseded, or its operation or job has been retired. It is kept as history but excluded from every labour figure and coverage number."
    >
      {RETIRED_TIME_LABEL}
    </span>
  )
}

/** Whichever of the two markers apply to this record — nothing at all for one that counts. */
export function TimeExclusionBadges({ hidden, retired }: { hidden: boolean; retired: boolean }) {
  if (!hidden && !retired) return null
  return (
    <>
      {retired && <RetiredTimeBadge />}
      {retired && hidden && ' '}
      {hidden && <HiddenTimeBadge />}
    </>
  )
}
