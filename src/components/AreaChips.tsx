'use client'

/**
 * The pre-assembly area chips — "All areas" plus one chip per area — shared by /model-total and
 * /labour-matrix so the two screens narrow Pre-assembly labour with the same control.
 *
 * Presentational and fully controlled. WHICH areas are on offer is the host's decision, and both
 * hosts make it the same way: only areas that actually have work for what is on screen, so a chip
 * always narrows to something. '' is "All areas".
 */
export interface AreaChip {
  id: string
  name: string
}

export default function AreaChips({ areas, value, onChange }: {
  areas: AreaChip[]
  /** The selected area's line id, or '' for every area. */
  value: string
  onChange: (areaLineId: string) => void
}) {
  return (
    <div role="group" aria-label="Pre-assembly area" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <button
        type="button"
        aria-pressed={!value}
        className={'labour-chip' + (!value ? ' labour-chip-on' : '')}
        onClick={() => onChange('')}
      >
        All areas
      </button>
      {areas.map((a) => (
        <button
          key={a.id}
          type="button"
          aria-pressed={value === a.id}
          className={'labour-chip' + (value === a.id ? ' labour-chip-on' : '')}
          onClick={() => onChange(a.id)}
        >
          {a.name}
        </button>
      ))}
    </div>
  )
}
