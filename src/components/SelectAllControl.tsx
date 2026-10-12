'use client'

import { useEffect, useRef } from 'react'

/**
 * The select-all at the head of every multi-select list in the app, and the count beside it.
 *
 * ONE control so the pickers cannot drift: three states (empty, indeterminate when some are
 * ticked, checked when all are), acting only on the rows the caller passes as `total` — so on a
 * filtered or searched list it ticks what is SHOWN and says so in its label — and "6 of 41
 * selected" next to it, so it is never ambiguous how much is about to be written.
 *
 * Presentational and controlled: the caller owns the selection and decides what "all" is.
 * Ticking from the indeterminate state selects everything, the convention for a tri-state box.
 */
export default function SelectAllControl({
  total, selected, onSetAll, noun, filtered = false, disabled = false, title, style,
}: {
  /** Rows the control acts on — the visible ones. */
  total: number
  /** How many of those are ticked. */
  selected: number
  onSetAll: (select: boolean) => void
  /** Singular, for the screen reader label: "operation", "model", "job". */
  noun: string
  /** A filter or search is narrowing the list: the label and count say "shown". */
  filtered?: boolean
  disabled?: boolean
  title?: string
  style?: React.CSSProperties
}) {
  const ref = useRef<HTMLInputElement>(null)
  const all = total > 0 && selected >= total
  const some = selected > 0 && !all
  // `indeterminate` is a DOM property with no attribute, so React cannot set it from JSX.
  useEffect(() => { if (ref.current) ref.current.indeterminate = some }, [some])

  const off = disabled || total === 0
  const label = filtered ? 'Select all shown' : 'Select all'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', ...style }}>
      <label
        title={title ?? (filtered
          ? `Ticks or clears the ${total} ${noun}${total === 1 ? '' : 's'} shown — rows hidden by the filter are left as they are`
          : `Ticks or clears every ${noun} in this list`)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: off ? 'var(--text-muted)' : 'var(--text-mid)', cursor: off ? 'default' : 'pointer' }}
      >
        <input
          ref={ref}
          type="checkbox"
          aria-label={`${label} ${noun}s`}
          aria-checked={some ? 'mixed' : all}
          checked={all}
          disabled={off}
          onChange={() => onSetAll(!all)}
          style={{ width: 16, height: 16, accentColor: 'var(--blue)', cursor: off ? 'default' : 'pointer' }}
        />
        {label}
      </label>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
        {selected} of {total}{filtered ? ' shown' : ''} selected
      </span>
    </div>
  )
}
