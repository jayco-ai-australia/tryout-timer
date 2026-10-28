import type { Product } from './types'

/** A product series under its type, holding the rows in the order they arrived. */
export interface SeriesGroup { key: string; label: string; products: Product[] }
/** A product type and its series — the two row breaks down the left of the grid. */
export interface TypeGroup { key: string; label: string; count: number; series: SeriesGroup[] }

/**
 * The visible rows, regrouped by products.product_type and then product_series — a 215-row flat
 * list is a wall, and type → series is how the floor already thinks about the range.
 *
 * A REGROUPING, NOT A FILTER. Every row handed in comes back out exactly once and nothing is
 * counted here: on /labour-matrix the summary, the coverage and the grid total all keep reading
 * visibleProducts. /estimate groups its model columns with it too, so "the Adventurer range" is
 * the same set of models on both screens.
 * Within a series the rows keep the order they arrived in (visibleProducts' model order), because
 * that is the order people find a model by.
 *
 * Types and series sort A–Z; a missing value sorts LAST under a plain label rather than being
 * dropped or landing mid-list as "(no series)" would. Trimmed, matching seriesOptions, so a stray
 * space can't split one series into two groups.
 */
export function groupProducts(products: Product[]): TypeGroup[] {
  const byType = new Map<string, Map<string, Product[]>>()
  for (const p of products) {
    const type = p.product_type?.trim() ?? ''
    const series = p.product_series?.trim() ?? ''
    let seriesMap = byType.get(type)
    if (!seriesMap) byType.set(type, (seriesMap = new Map()))
    const rows = seriesMap.get(series)
    if (rows) rows.push(p)
    else seriesMap.set(series, [p])
  }
  // Blank last, everything else A–Z.
  const order = (a: string, b: string) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0) || a.localeCompare(b)
  return [...byType.keys()].sort(order).map((type) => {
    const seriesMap = byType.get(type)!
    const series = [...seriesMap.keys()].sort(order).map((s) => ({
      key: s, label: s || 'No series', products: seriesMap.get(s)!,
    }))
    return {
      key: type,
      label: type || 'No type',
      count: series.reduce((n, s) => n + s.products.length, 0),
      series,
    }
  })
}
