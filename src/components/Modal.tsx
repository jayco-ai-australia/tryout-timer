'use client'

import { useEffect, useRef } from 'react'

interface ModalProps {
  title: string
  onClose: () => void
  children: React.ReactNode
  maxWidth?: number
}

export default function Modal({ title, onClose, children, maxWidth = 480 }: ModalProps) {
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
      <div style={{
        background: 'var(--surface)',
        borderRadius: 14,
        boxShadow: '0 8px 32px rgba(0,0,0,0.14)',
        width: '100%',
        maxWidth,
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '18px 22px 16px',
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{title}</span>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: 4, borderRadius: 6,
              color: 'var(--text-muted)', lineHeight: 0,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* Body */}
        <div style={{ padding: '22px 22px 22px' }}>{children}</div>
      </div>
    </div>
  )
}
