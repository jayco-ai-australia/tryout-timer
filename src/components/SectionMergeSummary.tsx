import { fmtHours, plural } from '@/lib/format'
import type { SectionMergePlan } from '@/lib/sectionManager'

export function fmtMinutesTotal(minutes: number): string {
  return `${Math.round(minutes).toLocaleString()} min (${fmtHours(minutes)} h)`
}

/**
 * What a section merge will do, stated from the plan the database just returned — the one
 * summary every merge confirm shows, on /setup, /line-config and /config alike.
 *
 * A section merge moves jobs and combines nothing. The same-name line is information, not a
 * warning: both jobs keep their names and sit side by side until somebody merges them on purpose.
 */
export default function SectionMergeSummary({ plan }: { plan: SectionMergePlan }) {
  const row: React.CSSProperties = { fontSize: 14, color: 'var(--text)', lineHeight: 1.6, margin: '10px 0 0' }
  const retired = plan.retiredMovingCount
  const live = plan.movingJobs.length - retired
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-mid)' }}>
        {`What will change in "${plan.destination.name}"`}
      </div>
      <p style={row}>
        <strong>{plural(live, 'job')}</strong> will move across as {live === 1 ? 'it is' : 'they are'}
        {retired > 0 && `, and ${plural(retired, 'retired job')} will move with them`}. Nothing is combined.
      </p>
      {plan.sameNameJobCount > 0 && (
        <p style={{ ...row, padding: '9px 12px', borderRadius: 8, background: 'var(--blue-light)', border: '1px solid #bcdff2', color: 'var(--blue-dark)', fontSize: 13 }}>
          {plural(plan.sameNameJobCount, 'job')} will sit alongside existing jobs of the same name: {plan.sameNameJobNames.join(', ')}.
          {' '}You can merge them afterwards.
        </p>
      )}
      <p style={row}>
        <strong>{plural(plan.affectedTimeCount, 'time record')}</strong> ({fmtMinutesTotal(plan.affectedMinutes)}) go with those jobs.
        {plan.restampTimeCount > 0
          ? ` ${plural(plan.restampTimeCount, 'time record')} will change team, and be re-stamped to ${plan.destinationTeam.name}.`
          : ' None changes team.'}
      </p>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: '10px 0 0' }}>
        No job, operation or time record is changed or destroyed — jobs only change which section they are filed in.
      </p>
    </div>
  )
}
