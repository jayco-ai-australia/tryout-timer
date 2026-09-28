'use client'

import { useMemo, useState } from 'react'
import { searchOperators } from '@/lib/operators'

/**
 * The shared "who was timed?" picker — a search box over a select, used by every operator
 * choice on the two stopwatch screens (Start, Complete, and the manual-entry panels beside
 * them) so they all filter the same way.
 *
 * The list handed in is already scoped to the production line being walked (see
 * lib/operators' operatorsForLine); this narrows it further by name as it is typed, which is
 * what keeps a line's worth of operators pickable on a tablet without scrolling a dropdown.
 *
 * The currently selected operator is always kept in the list even when the search hides them:
 * a <select> whose value has no matching <option> silently displays the first one instead, so
 * typing a search after choosing somebody would appear to change the choice.
 */

export interface OperatorSelectOption { id: string; full_name: string }

const SEL: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
  border: '1.5px solid var(--border)', borderRadius: 8, padding: '7px 10px',
  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', outline: 'none', width: '100%',
}

export default function OperatorSelect({
  operators, value, onChange, disabled = false, emptyLabel = '— None —', selectStyle, ariaLabel,
}: {
  /** Already line-scoped by the caller. */
  operators: OperatorSelectOption[]
  /** '' means nobody chosen — a valid answer everywhere this is used. */
  value: string
  onChange: (operatorId: string) => void
  disabled?: boolean
  emptyLabel?: string
  selectStyle?: React.CSSProperties
  ariaLabel?: string
}) {
  const [query, setQuery] = useState('')

  const matches = useMemo(() => searchOperators(operators, query), [operators, query])

  const options = useMemo(() => {
    const selected = operators.find((o) => o.id === value)
    if (!selected || matches.some((o) => o.id === selected.id)) return matches
    return [selected, ...matches]
  }, [operators, matches, value])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input
        type="search"
        className="input"
        style={{ width: '100%', fontSize: 12, padding: '6px 9px' }}
        placeholder="Search operators…"
        aria-label="Search operators by name"
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        // These pickers sit inside dialogs and panels that have their own confirm button;
        // Enter here means "I've finished typing the name", never "save".
        onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
      />
      <select
        style={selectStyle ?? SEL}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{emptyLabel}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
      </select>
      {operators.length === 0 ? (
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          No operators on this production line yet.
        </span>
      ) : matches.length === 0 ? (
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          No operator on this line matches “{query.trim()}”.
        </span>
      ) : null}
    </div>
  )
}
