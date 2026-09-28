import type { SupabaseClient } from '@supabase/supabase-js'
import { logSupabaseError } from './supabaseRead'

/**
 * The single operators module — every screen that offers "who was timed?" (the Start and
 * Complete dialogs behind both stopwatch screens, the manual-entry panels beside them) reads
 * its list through here, so the two rules that make a long operator list usable — scope it to
 * the line being walked, and let it be typed down by name — can't drift between screens.
 *
 * Scoping is by operators.production_line_id, the operator's own line. A van's line comes from
 * its chassis → product; /collect's comes from the line/team filter. Operators from another
 * line are not offered: a run banked against the wrong line's operator is invisible in every
 * per-line rollup that reads it back.
 */

/** The minimum every picker needs, plus the line an operator belongs to. */
export interface OperatorOption {
  id: string
  full_name: string
  production_line_id: string | null
}

/**
 * Every operator, in name order — the one query both stopwatch screens run.
 *
 * NO is_active FILTER, because `operators` HAS NO is_active COLUMN. It carried
 * `.eq('is_active', true)` and PostgREST answered every call with a 400; the soft-delete flag
 * that sweep was following lives on `sections`, `jobs` and `operations` only. The function is
 * named for what it returns rather than `fetchActiveOperators`, so the next person tidying up
 * soft-deletes isn't invited to "restore" a filter this table can't answer.
 */
export async function fetchOperators(supabase: SupabaseClient): Promise<OperatorOption[]> {
  const { data, error } = await supabase
    .from('operators')
    .select('id, full_name, production_line_id')
    .order('full_name')
  if (error) {
    logSupabaseError('operators (picker list)', error)
    throw new Error(error.message)
  }
  return (data ?? []) as OperatorOption[]
}

/**
 * The operators belonging to one production line.
 *
 * With no line in scope — /collect's "All lines", or a van whose model isn't on a line — there
 * is nothing to scope BY, so the full list is returned rather than an empty one: an empty
 * operator picker reads as "this screen is broken", not as "you haven't chosen a line".
 */
export function operatorsForLine<T extends { production_line_id: string | null }>(
  operators: T[],
  lineId: string | null | undefined
): T[] {
  if (!lineId) return operators
  return operators.filter((o) => o.production_line_id === lineId)
}

/** Name search, case-insensitive substring — what the search box above a picker filters by.
 * A blank query matches everything, so the box starts showing the whole list. */
export function searchOperators<T extends { full_name: string }>(operators: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return operators
  return operators.filter((o) => o.full_name.toLowerCase().includes(q))
}
