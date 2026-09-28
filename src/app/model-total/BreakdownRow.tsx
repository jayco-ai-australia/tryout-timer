'use client'

import { useState } from 'react'

/**
 * The ONE row layout in /model-total's breakdown — job headers and operation rows both.
 *
 * They used to be four separate blocks of markup that happened to share a grid constant, and
 * they drifted exactly as you would expect: the ACTIONS content was added inline to the label
 * cell of some of them, so "Doesn't apply to this model" rendered on top of the MINS figure and
 * "Add Time" wrapped onto two lines. There was no actions column; there was a label column with
 * things stuffed after the label.
 *
 * So the columns are declared once, here, and every row is this component:
 *
 *   OPERATION   1fr    truncates with an ellipsis — the only flexible column
 *   MINS      100px    right-aligned
 *   HISTORY    70px    right-aligned
 *   ACTIONS    44px    the unlink X, and nothing else ever
 *
 * ACTIONS briefly held a "…" overflow menu; it is gone. The row offers exactly one thing at the
 * end — "Doesn't apply to this model" — and a menu to reach one item is a click nobody needs.
 * Add Time went back to being an inline link in the OPERATION cell, where it was, which is also
 * why the label column truncates: it is the only column allowed to absorb variable content.
 *
 * Fixed pixel widths on the last three, so the label column absorbs every viewport change and
 * nothing in ACTIONS can grow back into MINS. No floats, no absolute positioning, no negative
 * margins. The three fixed columns plus gaps come to 250px, which leaves the label ~700px inside
 * the card at 1280 and ~450px at 1024 — the label ellipsises, the figures never move.
 */
export const GRID_COLS = '1fr 100px 70px 44px'
export const GRID_GAP = 12

/** Shared by the row, the column header and the grand-total line, so all three line up. */
export const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: GRID_COLS,
  gap: GRID_GAP,
  alignItems: 'center',
}

/** One column of truncating text. The label cell is the only one that can overflow. */
const TRUNCATE: React.CSSProperties = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

export default function BreakdownRow({
  label, minutes, history, onUnlink, unlinkTitle,
  variant = 'operation', onClick, onKeyDown, title, expanded, style, minutesStyle,
}: {
  /** Name plus whatever badges belong beside it. Truncates. */
  label: React.ReactNode
  minutes: React.ReactNode
  history?: React.ReactNode
  /** "Doesn't apply to this model". Omitted on rows that can't be unlinked — the column still
   * reserves its width so the figures stay aligned with the rows that can. */
  onUnlink?: () => void
  /** What the X says on hover and to a screen reader — names the job or operation. */
  unlinkTitle?: string
  /** `header` is the job row (heavier, tinted); `operation` is indented under it. */
  variant?: 'header' | 'operation'
  onClick?: () => void
  onKeyDown?: (e: React.KeyboardEvent) => void
  title?: string
  expanded?: boolean
  style?: React.CSSProperties
  minutesStyle?: React.CSSProperties
}) {
  const isHeader = variant === 'header'
  const interactive = !!onClick
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={expanded}
      title={title}
      onClick={onClick}
      onKeyDown={onKeyDown}
      style={{
        ...gridStyle,
        padding: isHeader ? '12px 14px' : '10px 14px 10px 40px',
        background: isHeader ? '#fafafa' : undefined,
        borderTop: isHeader ? undefined : '1px solid #f2f2f2',
        fontSize: isHeader ? undefined : 13,
        cursor: interactive ? 'pointer' : undefined,
        ...style,
      }}
    >
      <span style={TRUNCATE}>{label}</span>
      <span style={{ textAlign: 'right', ...TRUNCATE, ...minutesStyle }}>{minutes}</span>
      <span style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-muted)', ...TRUNCATE }}>
        {history}
      </span>
      {/* Always rendered, even when empty: an omitted cell would let MINS and HISTORY slide
          right on rows without an X and stop lining up with the rows that have one. */}
      <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {onUnlink && <UnlinkButton onUnlink={onUnlink} title={unlinkTitle} />}
      </span>
    </div>
  )
}

/**
 * The unlink X.
 *
 * Muted until hovered, then red — the colour arrives on intent rather than sitting on the row,
 * because a breakdown with twenty operations would otherwise read as twenty warnings. It is
 * still not a delete: nothing is destroyed, and the confirmation it opens is what says so.
 *
 * stopPropagation because the rows around it are themselves clickable — a timed row opens its
 * times drawer, a job header expands.
 */
function UnlinkButton({ onUnlink, title }: { onUnlink: () => void; title?: string }) {
  const [hover, setHover] = useState(false)
  const label = title ?? 'Doesn’t apply to this model'
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onUnlink() }}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 6, border: '1px solid transparent', padding: 0, cursor: 'pointer',
        background: hover ? 'var(--red-bg)' : 'none',
        color: hover ? 'var(--red)' : 'var(--text-muted)',
        transition: 'color 0.12s, background 0.12s',
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  )
}
