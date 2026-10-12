'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * Pins a route's paper (`@page`) so it wins over every other route's, whatever order they loaded in.
 *
 * WHY THIS EXISTS. Each printable route sets its paper with a bare `@page` rule in a route-scoped
 * print.css: named pages would scope it properly but Safari ignores them, size and margins
 * included. Next.js never UNLOADS a route's CSS after a client-side navigation, though, so
 * every route visited in the tab stays in the document. Equal-specificity `@page` rules are then
 * decided by load order. Open /model-total, go to /labour-matrix in the sidebar, come back and
 * print, and the sheet comes out on Labour Matrix's A3 landscape. On A4 paper that is shrunk or
 * cropped down the left edge.
 *
 * The fix is order, not specificity: while the route is mounted, a <style> carrying its paper sits
 * LAST in <head>, so it is the rule that applies. It is moved to the end again right before
 * printing (`pin`), in case anything was appended after it, and removed on unmount so it can't
 * do to the next route what the others did to this one.
 *
 * The route's print.css keeps its own copy of the rule. That copy covers the first paint and a
 * print before hydration; this hook covers everything after.
 */
export function usePageSetup(pageCss: string): () => void {
  const styleRef = useRef<HTMLStyleElement | null>(null)

  useEffect(() => {
    const el = document.createElement('style')
    el.setAttribute('data-page-setup', '')
    el.textContent = pageCss
    document.head.appendChild(el)
    styleRef.current = el
    return () => { el.remove(); styleRef.current = null }
  }, [pageCss])

  // appendChild on a node already in the document MOVES it, so this re-asserts last place.
  return useCallback(() => {
    if (styleRef.current) document.head.appendChild(styleRef.current)
  }, [])
}
