'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import ConfirmDialog from '@/components/ConfirmDialog'
import {
  addOperationTimeNote, averageForOperation, deleteOperationTimeNote, fetchOperationTimeNotes,
  operationProductKey, recordOperationTime, updateOperationTimeNote, type OperationTimeStat,
} from '@/lib/operationTimes'
import { linkOperationsToModels, unlinkOperationsFromModels } from '@/lib/modelOperations'
import { fmtDate, fmtMinutes } from '@/lib/format'
import type { OperationTimeNote, Product } from '@/lib/types'

/**
 * The series-grouped "which models does this operation apply to" UI — shared by /model-total's
 * edit drawer and /setup's models drawer so the two can't drift. Fully self-contained: given
 * an operationId + productionLineId it fetches its own products/links/stats and owns every
 * write (link/unlink, select-all/deselect-all, and — when enabled — manual time entry).
 *
 * `onChange` fires after any successful write so a host screen can refresh whatever coverage
 * counts/averages it shows outside this component (this component doesn't know about them).
 */
export interface ModelLinkerProps {
  operationId: string
  /** Used only in the "can't unlink" guard message. */
  operationName: string
  /** Which line's products to list. No line → no products to show. */
  productionLineId: string | null
  /** Show the click-to-reveal minutes + Save control on timed-status rows. */
  enableTimeEntry: boolean
  /** Required when enableTimeEntry is true — who a manually-entered time is recorded against. */
  operatorId?: string
  /** Required when enableTimeEntry is true — who collected a manually-entered time. */
  userId?: string
  onChange?: () => void
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
function XIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

/** One operation_times row as shown per-run in the expanded model row — the fields the
 * "left = the time itself" column needs, already flattened out of the raw join shape. */
interface TimeDetailRow {
  id: string
  total_minutes: number | null
  created_at: string
  collectedByName: string | null
}

/**
 * The notes column for a single time record — lists existing notes (inline-editable, with a
 * small delete), plus an "add note" input. Every write goes through the shared
 * add/update/deleteOperationTimeNote helpers and then calls onRefresh so the list can't drift
 * from what's actually in the database (an edit rejected by RLS, for instance, must not appear
 * to have "worked" locally).
 *
 * Exported because /tryouts' time-detail pane needs the same thread against the same helpers —
 * it takes only (timeId, notes, userId, onRefresh), so nothing here is screen-specific.
 */
export function NoteThread({
  supabase, timeId, notes, userId, onRefresh,
}: {
  supabase: SupabaseClient
  timeId: string
  notes: OperationTimeNote[]
  userId?: string
  onRefresh: () => Promise<void>
}) {
  const [newDraft, setNewDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleAdd() {
    if (!userId || !newDraft.trim()) return
    setError(null); setAdding(true)
    try {
      await addOperationTimeNote(supabase, timeId, newDraft, userId)
      setNewDraft('')
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save note')
    } finally {
      setAdding(false)
    }
  }

  async function handleSaveEdit(noteId: string) {
    if (!editDraft.trim()) return
    setError(null); setBusyId(noteId)
    try {
      await updateOperationTimeNote(supabase, noteId, editDraft)
      setEditingId(null)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update note')
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete(noteId: string) {
    setError(null); setBusyId(noteId)
    try {
      await deleteOperationTimeNote(supabase, noteId)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete note')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
      {notes.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>No notes</span>}
      {notes.map((note) => {
        const isEditing = editingId === note.id
        const isBusy = busyId === note.id
        return (
          <div key={note.id}>
            {isEditing ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  autoFocus
                  className="input"
                  style={{ flex: 1, fontSize: 12, padding: '4px 8px', minWidth: 0 }}
                  value={editDraft}
                  disabled={isBusy}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveEdit(note.id)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                />
                <button type="button" className="btn-primary" style={{ padding: '4px 10px', fontSize: 11 }} disabled={isBusy} onClick={() => handleSaveEdit(note.id)}>
                  {isBusy ? '…' : 'Save'}
                </button>
                <button type="button" style={{ background: 'none', border: 'none', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit' }} disabled={isBusy} onClick={() => setEditingId(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text)', wordBreak: 'break-word' }}>
                  {note.content}
                  {note.profiles?.full_name && <span style={{ color: 'var(--text-muted)' }}> — {note.profiles.full_name}</span>}
                </span>
                <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button
                    type="button" title="Edit note" disabled={isBusy}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12 }}
                    onClick={() => { setEditingId(note.id); setEditDraft(note.content); setError(null) }}
                  >
                    ✎
                  </button>
                  <button
                    type="button" title="Delete note" disabled={isBusy}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }}
                    onClick={() => handleDelete(note.id)}
                  >
                    {isBusy ? '…' : '×'}
                  </button>
                </span>
              </div>
            )}
          </div>
        )
      })}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          className="input"
          placeholder="Add a note…"
          style={{ flex: 1, fontSize: 12, padding: '4px 8px', minWidth: 0 }}
          value={newDraft}
          disabled={adding}
          onChange={(e) => setNewDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
        />
        <button type="button" className="btn-primary" style={{ padding: '4px 10px', fontSize: 11 }} disabled={adding || !newDraft.trim()} onClick={handleAdd}>
          {adding ? '…' : 'Add'}
        </button>
      </div>
      {error && <span style={{ fontSize: 11, color: 'var(--red)' }}>{error}</span>}
    </div>
  )
}

/**
 * Group by product_series — series sorted alphabetically, unspecified series forced to the
 * bottom under "Other"; models within a series sorted by their model field. Exported so every
 * series-grouped model list in the app orders itself identically.
 */
export function groupProductsBySeries(
  products: Product[],
  /** Optional within-series ordering. Defaults to model name; /collect passes a comparator that
   * floats untimed models to the top, because on a coverage screen the gaps are the work. */
  compare: (a: Product, b: Product) => number = (a, b) => a.model.localeCompare(b.model)
): { series: string; products: Product[] }[] {
  const groups = new Map<string, Product[]>()
  for (const p of products) {
    const series = p.product_series?.trim() || 'Other'
    if (!groups.has(series)) groups.set(series, [])
    groups.get(series)!.push(p)
  }
  return [...groups.entries()]
    .map(([series, group]) => ({ series, products: [...group].sort(compare) }))
    .sort((a, b) => {
      if (a.series === 'Other' && b.series !== 'Other') return 1
      if (b.series === 'Other' && a.series !== 'Other') return -1
      return a.series.localeCompare(b.series)
    })
}

export interface ModelSeriesPickerProps {
  products: Product[]
  /** Which products are ticked. What "ticked" means is the host's business — a live
   * model_operations link in ModelLinker, a pending choice in /setup's bulk drawer. */
  selectedIds: Set<string>
  onToggle: (product: Product, isSelected: boolean) => void
  /** The series header's select-all / deselect-all. `allSelected` says which way it should go. */
  onToggleSeries: (series: string, seriesProducts: Product[], allSelected: boolean) => void
  /** Series whose header action is mid-write — its button shows "…" and is disabled. */
  busySeries?: string | null
  /** Optional per-series line under the header, e.g. "2 models kept — has recorded times". */
  seriesNotes?: Record<string, string>
  /** Right-hand side of a model row (ModelLinker's timed/not-timed badge). */
  renderRowStatus?: (product: Product, isSelected: boolean) => React.ReactNode
  /** Extra content rendered under a model row (ModelLinker's expanded time-entry block). */
  renderRowExtra?: (product: Product, isSelected: boolean) => React.ReactNode
  /** Within-series ordering — see groupProductsBySeries. */
  sortWithinSeries?: (a: Product, b: Product) => number
}

/**
 * The series-grouped checkbox list itself — presentational and fully controlled, so it owns no
 * data and performs no writes. ModelLinker drives it against live model_operations links;
 * /setup's bulk-link drawer drives it against a pending selection. Anything that needs this
 * list should render this rather than rebuild it.
 */
export function ModelSeriesPicker({
  products, selectedIds, onToggle, onToggleSeries, busySeries, seriesNotes, renderRowStatus,
  renderRowExtra, sortWithinSeries,
}: ModelSeriesPickerProps) {
  const groups = useMemo(
    () => groupProductsBySeries(products, sortWithinSeries),
    [products, sortWithinSeries]
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {groups.map((group) => {
        const allSelected = group.products.every((p) => selectedIds.has(p.id))
        const seriesBusy = busySeries === group.series
        return (
          <div key={group.series}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)' }}>{group.series}</span>
              <button
                type="button"
                disabled={seriesBusy}
                onClick={() => onToggleSeries(group.series, group.products, allSelected)}
                style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mid)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                {seriesBusy ? '…' : allSelected ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            {seriesNotes?.[group.series] && (
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 6px' }}>{seriesNotes[group.series]}</p>
            )}
            <div className="checkbox-list" style={{ maxHeight: 'none' }}>
              {group.products.map((p) => {
                const isSelected = selectedIds.has(p.id)
                const extra = renderRowExtra?.(p, isSelected)
                return (
                  <div key={p.id} className="checkbox-row" style={{ flexDirection: 'column', alignItems: 'stretch', cursor: 'default', gap: 6 }}>
                    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, cursor: 'pointer' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="checkbox" checked={isSelected} onChange={() => onToggle(p, isSelected)} />
                        {p.model}
                      </span>
                      {renderRowStatus?.(p, isSelected)}
                    </label>
                    {extra}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function ModelLinker({ operationId, operationName, productionLineId, enableTimeEntry, operatorId, userId, onChange }: ModelLinkerProps) {
  const supabase = useMemo(() => createClient(), [])

  const [products, setProducts] = useState<Product[]>([])
  const [linkedProductIds, setLinkedProductIds] = useState<Set<string>>(new Set())
  const [stats, setStats] = useState<Record<string, OperationTimeStat>>({})
  const [loading, setLoading] = useState(false)

  // Per-run detail (enableTimeEntry screens only — /setup never fetches or shows these):
  // timeDetails is every operation_times row for this operation, timeModelLinks says which
  // product(s) each one belongs to, notesByTime is that operation's operation_time_notes
  // grouped by operation_time_id.
  const [timeDetails, setTimeDetails] = useState<TimeDetailRow[]>([])
  const [timeModelLinks, setTimeModelLinks] = useState<{ operation_time_id: string; product_id: string }[]>([])
  const [notesByTime, setNotesByTime] = useState<Record<string, OperationTimeNote[]>>({})

  const [fieldError, setFieldError] = useState<string | null>(null)
  const [blockedUnlink, setBlockedUnlink] = useState<{ productLabel: string } | null>(null)

  const [bulkBusySeries, setBulkBusySeries] = useState<string | null>(null)
  const [keptNotes, setKeptNotes] = useState<Record<string, string>>({})

  // Manual time entry, keyed by product_id — one draft value per linked model row.
  const [manualMinutes, setManualMinutes] = useState<Record<string, string>>({})
  const [savingTimeProductId, setSavingTimeProductId] = useState<string | null>(null)
  // Which model row's minutes input is revealed — only one at a time, hidden by default.
  const [openTimeProductId, setOpenTimeProductId] = useState<string | null>(null)

  async function loadData() {
    setLoading(true)
    setFieldError(null)
    const loadErrors: string[] = []

    const [
      { data: prodRows, error: prodError },
      { data: modelOps, error: modelOpsError },
      { data: times, error: timesError },
    ] = await Promise.all([
      productionLineId
        ? supabase.from('products').select('*').eq('production_line_id', productionLineId).order('model')
        : Promise.resolve({ data: [] as Product[], error: null }),
      supabase.from('model_operations').select('product_id').eq('operation_id', operationId),
      // Flat select, no embedded relationship — collected_by's name (when needed) is merged in
      // below from a separate profiles query, so this can't fail because a relationship name
      // doesn't resolve.
      supabase
        .from('operation_times')
        .select('id, total_minutes, created_at, collected_by')
        .eq('operation_id', operationId)
        .order('created_at', { ascending: false }),
    ])
    if (prodError) loadErrors.push(prodError.message)
    if (modelOpsError) loadErrors.push(modelOpsError.message)
    if (timesError) loadErrors.push(timesError.message)

    const timeIds = (times ?? []).map((t) => t.id)
    const [{ data: timeModels, error: timeModelsError }, notesResult] = await Promise.all([
      timeIds.length > 0
        ? supabase.from('operation_time_models').select('operation_time_id, product_id').in('operation_time_id', timeIds)
        : Promise.resolve({ data: [] as { operation_time_id: string; product_id: string }[], error: null }),
      // Notes are only ever shown behind the time-entry drawer (/model-total) — /setup has no UI
      // for them, so skip the extra round trip there entirely. A failure here is caught and
      // surfaced rather than left to throw, so the rest of the drawer still loads.
      enableTimeEntry
        ? fetchOperationTimeNotes(supabase, timeIds)
            .then((data) => ({ data, error: null as string | null }))
            .catch((err) => ({ data: [] as OperationTimeNote[], error: err instanceof Error ? err.message : 'Could not load notes' }))
        : Promise.resolve({ data: [] as OperationTimeNote[], error: null as string | null }),
    ])
    if (timeModelsError) loadErrors.push(timeModelsError.message)
    if (notesResult.error) loadErrors.push(notesResult.error)
    const notes = notesResult.data

    // Names for operation_times.collected_by / operation_time_notes.created_by, fetched flat
    // and merged in below — one lookup covers both instead of two embedded joins.
    const profileIds = new Set<string>()
    for (const t of times ?? []) if (t.collected_by) profileIds.add(t.collected_by)
    for (const n of notes) if (n.created_by) profileIds.add(n.created_by)
    const nameById = new Map<string, string | null>()
    if (profileIds.size > 0) {
      const { data: profileRows, error: profilesError } = await supabase
        .from('profiles').select('id, full_name').in('id', [...profileIds])
      if (profilesError) loadErrors.push(profilesError.message)
      for (const row of profileRows ?? []) nameById.set(row.id, row.full_name)
    }

    // Re-shape the (operation_id, times) rows the shared averager expects, so this stays on
    // the exact same math as every other screen — then remap its "operationId:productId" keys
    // down to plain productId, since this component is always scoped to one operation.
    const rawTimes = (times ?? []).map((t) => ({ id: t.id, operation_id: operationId, total_minutes: t.total_minutes }))
    const pairStats = averageForOperation(rawTimes, timeModels ?? [])
    const nextStats: Record<string, OperationTimeStat> = {}
    for (const p of prodRows ?? []) {
      const s = pairStats[operationProductKey(operationId, p.id)]
      if (s) nextStats[p.id] = s
    }

    const nextNotesByTime: Record<string, OperationTimeNote[]> = {}
    for (const note of notes) {
      const withAuthor = note.created_by ? { ...note, profiles: { full_name: nameById.get(note.created_by) ?? null } } : note
      ;(nextNotesByTime[note.operation_time_id] ??= []).push(withAuthor)
    }

    setProducts(prodRows ?? [])
    setLinkedProductIds(new Set((modelOps ?? []).map((r) => r.product_id)))
    setStats(nextStats)
    setTimeDetails((times ?? []).map((t) => ({
      id: t.id,
      total_minutes: t.total_minutes,
      created_at: t.created_at,
      collectedByName: t.collected_by ? nameById.get(t.collected_by) ?? null : null,
    })))
    setTimeModelLinks(timeModels ?? [])
    setNotesByTime(nextNotesByTime)
    if (loadErrors.length > 0) setFieldError(loadErrors[0])
    setLoading(false)
  }

  useEffect(() => {
    loadData()
    setManualMinutes({}); setOpenTimeProductId(null); setKeptNotes({}); setFieldError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, operationId, productionLineId])

  async function toggleModelLink(product: Product, isLinked: boolean) {
    setFieldError(null)
    if (isLinked) {
      const stat = stats[product.id]
      if (stat && stat.runs > 0) {
        setBlockedUnlink({ productLabel: `${product.product_code} — ${product.model}` })
        return
      }
      // The timed guard was already applied above (stats.runs), so nothing is held back here.
      const { error } = await unlinkOperationsFromModels(
        supabase, [{ operation_id: operationId, product_id: product.id }], new Set()
      )
      if (error) { setFieldError(error); return }
      setLinkedProductIds((prev) => { const next = new Set(prev); next.delete(product.id); return next })
    } else {
      const { error } = await linkOperationsToModels(supabase, [{ operation_id: operationId, product_id: product.id }])
      if (error) { setFieldError(error); return }
      setLinkedProductIds((prev) => new Set(prev).add(product.id))
    }
    onChange?.()
  }

  async function selectAllInSeries(seriesKey: string, seriesProducts: Product[]) {
    const toLink = seriesProducts.filter((p) => !linkedProductIds.has(p.id))
    if (toLink.length === 0) return
    setFieldError(null); setBulkBusySeries(seriesKey)
    const { error } = await linkOperationsToModels(
      supabase, toLink.map((p) => ({ operation_id: operationId, product_id: p.id }))
    )
    setBulkBusySeries(null)
    if (error) { setFieldError(error); return }
    setLinkedProductIds((prev) => { const next = new Set(prev); for (const p of toLink) next.add(p.id); return next })
    setKeptNotes((prev) => { const next = { ...prev }; delete next[seriesKey]; return next })
    onChange?.()
  }

  async function deselectAllInSeries(seriesKey: string, seriesProducts: Product[]) {
    const linked = seriesProducts.filter((p) => linkedProductIds.has(p.id))
    // Same integrity guard as a single unlink — a model with recorded times is kept, not
    // silently dropped, and we say so.
    const kept = linked.filter((p) => (stats[p.id]?.runs ?? 0) > 0)
    const toUnlink = linked.filter((p) => !kept.some((k) => k.id === p.id))

    const note = kept.length > 0 ? `${kept.length} model${kept.length !== 1 ? 's' : ''} kept — has recorded times` : null
    setKeptNotes((prev) => { const next = { ...prev }; if (note) next[seriesKey] = note; else delete next[seriesKey]; return next })
    if (toUnlink.length === 0) return

    setFieldError(null); setBulkBusySeries(seriesKey)
    // `kept` is already split out above from the same stats the single toggle uses, so the
    // helper's own guard has nothing left to hold back.
    const { error } = await unlinkOperationsFromModels(
      supabase, toUnlink.map((p) => ({ operation_id: operationId, product_id: p.id })), new Set()
    )
    setBulkBusySeries(null)
    if (error) { setFieldError(error); return }
    setLinkedProductIds((prev) => { const next = new Set(prev); for (const p of toUnlink) next.delete(p.id); return next })
    onChange?.()
  }

  /** The currently-viewed operator is who the time is recorded against, the signed-in user is
   * who collected it. Goes through the shared recordOperationTime helper so this can't drift
   * from any other screen's insert. */
  async function saveManualTime(product: Product) {
    if (!operatorId || !userId) return
    const raw = manualMinutes[product.id] ?? ''
    const minutes = Number(raw)
    if (!raw.trim() || Number.isNaN(minutes) || minutes <= 0) {
      setFieldError('Enter a valid number of minutes')
      return
    }
    setFieldError(null)
    setSavingTimeProductId(product.id)
    try {
      await recordOperationTime(supabase, {
        operationId, productIds: [product.id], operatorId, collectedBy: userId, totalMinutes: minutes,
      })
      setManualMinutes((prev) => ({ ...prev, [product.id]: '' }))
      setOpenTimeProductId(null)
      await loadData()
      onChange?.()
    } catch (err) {
      setFieldError(err instanceof Error ? err.message : 'Could not save time')
    } finally {
      setSavingTimeProductId(null)
    }
  }

  // Every operation_times row for a given product, newest first — the "individual time
  // records" list under an expanded model row. operation_times has no product_id of its own,
  // so this joins through timeModelLinks the same way averageForOperation does internally.
  const recordsByProduct = useMemo(() => {
    const detailById = new Map(timeDetails.map((t) => [t.id, t]))
    const map = new Map<string, TimeDetailRow[]>()
    for (const tm of timeModelLinks) {
      const detail = detailById.get(tm.operation_time_id)
      if (!detail) continue
      if (!map.has(tm.product_id)) map.set(tm.product_id, [])
      map.get(tm.product_id)!.push(detail)
    }
    for (const arr of map.values()) arr.sort((a, b) => b.created_at.localeCompare(a.created_at))
    return map
  }, [timeDetails, timeModelLinks])

  if (loading) {
    return <p style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>Loading…</p>
  }
  if (products.length === 0) {
    return <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No products found for this production line</p>
  }

  return (
    <div>
      {fieldError && (
        <p style={{ margin: '0 0 12px', padding: '9px 12px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 12 }}>
          {fieldError}
        </p>
      )}
      <ModelSeriesPicker
        products={products}
        selectedIds={linkedProductIds}
        onToggle={toggleModelLink}
        onToggleSeries={(series, seriesProducts, allSelected) =>
          allSelected ? deselectAllInSeries(series, seriesProducts) : selectAllInSeries(series, seriesProducts)}
        busySeries={bulkBusySeries}
        seriesNotes={keptNotes}
        renderRowStatus={(p, isLinked) => {
          if (!isLinked) return null
          const stat = stats[p.id]
          const badge = stat ? (
            <><CheckIcon /> {stat.avg.toFixed(1)}m · {stat.runs} run{stat.runs !== 1 ? 's' : ''}</>
          ) : (
            <><XIcon /> Not timed</>
          )
          const cls = 'gaps-drawer-item-status ' + (stat ? 'gaps-drawer-item-status-ok' : 'gaps-drawer-item-status-missing')
          return enableTimeEntry ? (
            <button
              type="button"
              className={cls}
              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }}
              title={stat ? 'Click to add another time' : 'Click to add a time'}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpenTimeProductId((cur) => (cur === p.id ? null : p.id)) }}
            >
              {badge}
              <span style={{ opacity: 0.55, fontWeight: 400 }}>✎</span>
            </button>
          ) : (
            <span className={cls}>{badge}</span>
          )
        }}
        renderRowExtra={(p, isLinked) => {
          if (!enableTimeEntry || !isLinked || openTimeProductId !== p.id) return null
          const stat = stats[p.id]
          const draft = manualMinutes[p.id] ?? ''
          const isSavingTime = savingTimeProductId === p.id
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 24 }}>
              {(recordsByProduct.get(p.id) ?? []).map((record) => (
                <div
                  key={record.id}
                  style={{ display: 'flex', gap: 12, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}
                >
                  <div style={{ width: 130, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{fmtMinutes(record.total_minutes)}m</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(record.created_at)}</span>
                    {record.collectedByName && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>by {record.collectedByName}</span>
                    )}
                  </div>
                  <NoteThread
                    supabase={supabase}
                    timeId={record.id}
                    notes={notesByTime[record.id] ?? []}
                    userId={userId}
                    onRefresh={loadData}
                  />
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="number" min={0} step="0.1" placeholder="min" autoFocus={!stat}
                  className="input"
                  style={{ width: 72, padding: '4px 8px', fontSize: 12 }}
                  value={draft}
                  disabled={isSavingTime}
                  onChange={(e) => setManualMinutes((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveManualTime(p) }}
                />
                <button
                  type="button"
                  className="btn-primary"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                  disabled={isSavingTime || !draft.trim()}
                  onClick={() => saveManualTime(p)}
                >
                  {isSavingTime ? '…' : 'Save'}
                </button>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>add another time</span>
              </div>
            </div>
          )
        }}
      />


      {blockedUnlink && (
        <ConfirmDialog
          title="Can't unlink this model"
          message={`"${operationName}" has recorded times for ${blockedUnlink.productLabel}. Remove those recorded times in Admin first, then unlink the model here.`}
          confirmLabel="Got it"
          cancelLabel="Close"
          onConfirm={() => setBlockedUnlink(null)}
          onCancel={() => setBlockedUnlink(null)}
        />
      )}
    </div>
  )
}
