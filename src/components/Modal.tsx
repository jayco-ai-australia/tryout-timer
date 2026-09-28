'use client'

import { useEffect, useRef } from 'react'

interface ModalProps {
  title: string
  onClose: () => void
  children: React.ReactNode
  maxWidth?: number
  /** The dialog's actions — Cancel, Save — rendered in a region PINNED to the bottom of the
   * card, outside the scrolling body.
   *
   * This exists because a confirm step whose content is unbounded used to take its own Save
   * button off the screen with it. /collect's complete-timer dialog lists every model the run
   * banks against — 89 on the Caravan line — and on a 768px-tall tablet that list grew the
   * card past the bottom of the viewport, with the buttons below the list and therefore off
   * it. There was nothing to scroll either: the card had no scroller, and the page behind is
   * scroll-locked while a modal is open. The collector could not save the time they had just
   * stood on the floor and measured.
   *
   * Buttons passed here can't be pushed anywhere: the footer is `flex: none`, the body takes
   * the remaining height and scrolls itself. Leave it undefined and the card behaves as it
   * always did, with everything in one region — fine for a short fixed form, wrong for
   * anything that lists rows. */
  footer?: React.ReactNode
}

export default function Modal({ title, onClose, children, maxWidth = 480, footer }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)

  // onClose is read through a ref so the effect below can depend on NOTHING and therefore run
  // exactly once, on mount.
  //
  // It used to depend on [onClose], and callers almost always pass an inline arrow — a fresh
  // function identity on every render. On a screen that re-renders on a timer (e.g. /tryouts,
  // which ticks once a second while any stopwatch runs) that tore the effect down and set it up
  // again every second, which meant `document.body.style.overflow` was cleared and re-applied
  // once a second underneath an open dialog. The result is a page that visibly jumps behind the
  // modal — and a modal that looks like it is failing to open properly.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', handleKey)
    // Restored to whatever it was rather than blanked, so a modal opened over something that
    // had already locked scrolling doesn't unlock it on the way out.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = previousOverflow
    }
  }, [])

  return (
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
      style={{
        // Above the slide-over drawers (.gaps-drawer is 201): a ConfirmDialog is routinely
        // opened FROM inside a drawer — /setup's bulk model link and job reassign both do —
        // and at 100 the drawer painted over the right-hand side of the card, buttons included.
        position: 'fixed', inset: 0, zIndex: 300,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
        background: 'rgba(15, 23, 36, 0.45)',
      }}
    >
      {/* Three regions — see .modal-card in globals.css. Height is bounded there in dvh so the
        * footer stays inside the visible viewport under a tablet's browser chrome. */}
      <div className="modal-card" style={{ maxWidth }}>
        {/* Header — flex: none */}
        <div className="modal-card-header">
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{title}</span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: 10, margin: -10, borderRadius: 6,
              color: 'var(--text-muted)', lineHeight: 0, flexShrink: 0,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* Body — flex: 1, scrolls its own overflow */}
        <div className="modal-card-body">{children}</div>
        {/* Footer — flex: none, never scrolls away */}
        {footer && <div className="modal-card-footer">{footer}</div>}
      </div>
    </div>
  )
}
