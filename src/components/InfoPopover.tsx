'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * A small info icon that opens a short popover — the app's one popover.
 *
 * For a fact worth having but not worth a line of text on every row: the icon carries the STATE
 * (tone + glyph + accessible label) and the popover carries the sentence.
 *
 * Reachable every way a person might ask for it: hover, keyboard focus (it is a real <button>
 * in the tab order, and the popover is its aria-describedby), and click or tap, which pins it
 * open until Escape, a second click, or a click anywhere else.
 *
 * Never colour alone. Each tone has its own glyph (i / ✓ / !), and `label` — a few words naming
 * the state — is the button's accessible name and its native tooltip.
 *
 * The popover is portalled to <body> and positioned `fixed` against the icon, because the lists
 * it lives in sit inside scrolling, overflow-hidden containers (a modal body, a drawer) that
 * would clip an absolutely positioned one.
 *
 * Tones are the design system's own semantic pairs from globals.css — the same ones .badge-blue,
 * .badge-green and .badge-amber use: --blue on --blue-light, #15803d on --green-bg, #92400e on
 * --amber-bg.
 */
export type InfoTone = 'info' | 'success' | 'warning'

const TONES: Record<InfoTone, { fg: string; bg: string; glyph: string }> = {
  info: { fg: 'var(--blue)', bg: 'var(--blue-light)', glyph: 'i' },
  success: { fg: '#15803d', bg: 'var(--green-bg)', glyph: '✓' },
  warning: { fg: '#92400e', bg: 'var(--amber-bg)', glyph: '!' },
}

const WIDTH = 260
const GAP = 6
const EDGE = 8

export default function InfoPopover({
  tone = 'info', label, children,
}: {
  tone?: InfoTone
  /** A few words naming the state — "Applies, nothing recorded". The accessible name. */
  label: string
  children: React.ReactNode
}) {
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const [pinned, setPinned] = useState(false)
  const open = hover || focus || pinned
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const place = useCallback(() => {
    const button = buttonRef.current
    if (!button) return
    const r = button.getBoundingClientRect()
    const height = popRef.current?.offsetHeight ?? 0
    const left = Math.min(Math.max(r.left + r.width / 2 - WIDTH / 2, EDGE), window.innerWidth - WIDTH - EDGE)
    // Below the icon unless that would run off the bottom of the viewport.
    const below = r.bottom + GAP
    const top = below + height > window.innerHeight - EDGE ? Math.max(r.top - GAP - height, EDGE) : below
    setPos({ top, left })
  }, [])

  // Placed once it has mounted (so its height is known), and kept in place while the list
  // behind it scrolls.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // This Escape is for the popover — not for the dialog it sits in.
      e.stopPropagation()
      setPinned(false); setHover(false); setFocus(false)
    }
    function onDown(e: MouseEvent) {
      if (buttonRef.current?.contains(e.target as Node) || popRef.current?.contains(e.target as Node)) return
      setPinned(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const t = TONES[tone]
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="info-pop-btn"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        title={open ? undefined : label}
        // Inside a <label> row: the click is for the popover, never for the row's checkbox.
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPinned((p) => !p) }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{ color: t.fg, background: t.bg, borderColor: t.fg }}
      >
        <span aria-hidden="true">{t.glyph}</span>
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popRef}
          id={id}
          role="tooltip"
          className="info-pop"
          style={{ width: WIDTH, top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden', borderTopColor: t.fg }}
        >
          <strong style={{ display: 'block', color: t.fg, marginBottom: 2 }}>{label}</strong>
          {children}
        </div>,
        document.body
      )}
    </>
  )
}
