'use client'

import { useState } from 'react'
import { plural } from '@/lib/format'

// ── The confirm step's "Banking against" list ──────────────────────────────────────────────
/**
 * Which models the run about to be saved counts for, inside the complete-timer dialog.
 *
 * COLLAPSED BY DEFAULT, and that is the point rather than a nicety. The models were chosen in
 * the coverage pane before Start; by the time this dialog opens the collector has already made
 * the decision and is confirming a number, not re-reading a list. On the Caravan line that list
 * is 89 models, and rendering all of them unasked used to grow the dialog past the bottom of a
 * tablet and take the Save button with it — the collector could not bank the time they had just
 * measured. The count is what needs confirming; the names are one tap away when they don't
 * match what was expected.
 *
 * Expanded, it lays out as a responsive grid rather than a wrapped row of badges, so 89 models
 * use the dialog's width instead of running 89 lines down it. It sits inside the modal's
 * scrolling body either way, and the footer holding Save is pinned outside that — see Modal.
 */
export default function BankingAgainstList({ models }: { models: { productId: string; model: string }[] }) {
  const [expanded, setExpanded] = useState(false)

  if (models.length === 0) return null

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
          Banking against
        </span>
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: 12, padding: '8px 12px', minHeight: 44 }}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Hide list' : `Show all ${models.length}`}
        </button>
      </div>
      <p style={{ fontSize: 14, color: 'var(--text)', fontWeight: 600, margin: 0 }}>
        {plural(models.length, 'model')} selected
      </p>
      {expanded && (
        <div className="model-grid" style={{ marginTop: 8 }}>
          {models.map((m) => (
            <span key={m.productId} className="model-grid-item">{m.model}</span>
          ))}
        </div>
      )}
    </div>
  )
}
