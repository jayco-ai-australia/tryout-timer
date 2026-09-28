'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import ConfirmDialog from '@/components/ConfirmDialog'
import { ModelSeriesPicker } from '@/components/ModelLinker'
import {
  fetchLinksForOperations, fetchTimedPairs, linkOperationsToModels, unlinkOperationsFromModels,
} from '@/lib/modelOperations'
import { modelsForLine } from '@/lib/lines'
import type { Operation, Product } from '@/lib/types'

/**
 * The shared many-operations x many-models linker — /setup's bulk drawer and /collect's
 * "Link models to selected" open this same component, so the pair arithmetic, the Add/Replace
 * semantics, the timed-model guard and the result reporting can't drift between them.
 *
 * It is the UI counterpart of lib/modelOperations: that module owns the writes (upsert, chunked
 * delete, the "never unlink a pair that has recorded times" guard), and this owns the one
 * question a screen has to ask before calling them — which models, applied how.
 *
 * `allowReplace` is what separates the two callers. /setup is the structure screen and offers
 * both modes. /collect offers Add only: it is a collection screen, its user is building an
 * applies-list forward rather than correcting one, and Replace there would silently unlink
 * models from operations whose current links were never on screen to review.
 *
 * On /collect this is deliberately the ONLY surface that writes model_operations, and it is
 * deliberately a slide-over. That screen also shows a model checkbox list in its Models —
 * Coverage pane, and the two mean entirely different things: this one sets what the selected
 * operations APPLY TO (structural, written on Apply), while that one picks what the next
 * TIMING counts for (in-memory, one operation, written only when the time is saved). Keeping
 * this in a drawer is what stops them being on screen together looking like one list.
 */

/** Same slide-in pattern/width as the dashboard gap drawer (.gaps-drawer is hard-coded to
 * 25vw for the dashboard's gap drawer — overridden here to match). Exported so every screen
 * that slides this drawer in is the same width. */
export const DRAWER_WIDTH: React.CSSProperties = { width: '33.333vw' }

const ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * The slide-in choreography, in one place: `open` mounts the drawer, `visible` drives the
 * transition class one frame later, and closing reverses it and unmounts after the animation.
 * Escape closes. Both screens use this rather than each keeping their own copy of the rAF +
 * setTimeout dance, which is the sort of thing that ends up subtly different.
 */
export function useSlideOverDrawer() {
  const [open, setOpen] = useState(false)
  const [visible, setVisible] = useState(false)

  function openDrawer() {
    setOpen(true)
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
  }
  function closeDrawer() {
    setVisible(false)
    window.setTimeout(() => setOpen(false), 320)
  }

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closeDrawer() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return { open, visible, openDrawer, closeDrawer }
}

/** What an apply run did, so the drawer can report it (including partial failure) instead of
 * just closing. `kept` is the Replace-only list of links spared because they have times. */
interface BulkApplyResult {
  mode: 'add' | 'replace'
  inserted: number
  insertAttempted: number
  deleted: number
  deleteAttempted: number
  kept: { operationName: string; model: string }[]
  error: string | null
}

export default function BulkModelLinkDrawer({
  productionLineId, subjectLabel, operations, supabase, allowReplace = true, jobLinkCounts, onClose, onApplied,
}: {
  /** Whose products to offer. Null -> nothing to link against, and the drawer says so. */
  productionLineId: string | null
  /** What the selected operations belong to, for the header line (today: the job's name). */
  subjectLabel: string
  operations: Operation[]
  supabase: SupabaseClient
  /** Offer the destructive "make the model set exactly this" mode. Add-only when false. */
  allowReplace?: boolean
  /**
   * JOB MODE. Product id → how many of `operations` it is currently linked to, supplied by the
   * caller from data it already holds (never fetched here).
   *
   * Its presence turns this drawer into the per-job model panel /setup's Jobs pane opens: ticks
   * START at the current state instead of empty, Replace is the only behaviour (tick = link
   * every operation of the job, untick = unlink them), and a model linked to SOME of the job's
   * operations says so on its row. That partial state is the reason this mode exists — four
   * Caravan models carry 1 of 8 operations on one job, and until now that was invisible without
   * running SQL.
   *
   * Without it the drawer is unchanged: a pending Add/Replace choice over a hand-picked set of
   * operations, starting empty because those operations generally don't agree on one answer.
   */
  jobLinkCounts?: Map<string, number>
  onClose: () => void
  onApplied: () => Promise<void>
}) {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  // Starts empty by design — this is a pending choice, not the current link state of any one
  // operation (the selected operations generally don't agree on one).
  const jobMode = !!jobLinkCounts
  // Seeded from the current link state in job mode — the panel is a picture of what IS, which is
  // what makes unticking mean "unlink". Lazy initialiser: the drawer is mounted fresh each time
  // it opens, so this runs once per opening.
  const [pickedIds, setPickedIds] = useState<Set<string>>(
    () => new Set(jobLinkCounts ? [...jobLinkCounts.entries()].filter(([, n]) => n > 0).map(([id]) => id) : [])
  )
  const [mode, setMode] = useState<'add' | 'replace'>('add')
  // Replace can only ever be reached where it is offered — a caller turning it off mid-flight
  // must not leave a stale 'replace' armed behind a hidden radio. Job mode is always Replace:
  // its ticks describe the whole desired set, so Add would make unticking silently do nothing.
  const effectiveMode = jobMode ? 'replace' : allowReplace ? mode : 'add'
  const [confirming, setConfirming] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BulkApplyResult | null>(null)

  const opIds = useMemo(() => operations.map((o) => o.id), [operations])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      if (!productionLineId) {
        if (!cancelled) { setProducts([]); setLoading(false) }
        return
      }
      try {
        // THE model-list question, asked in the one place that knows the answer — a pre-assembly
        // line (Chassis, Sew, …) owns no products and inherits the models of the lines it feeds,
        // so the old `production_line_id = <this line>` query left this drawer with nothing to
        // tick on exactly the lines whose work most needs linking. See lib/lines.
        const rows = await modelsForLine(supabase, productionLineId)
        if (cancelled) return
        setProducts(rows)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not load this line’s models')
      }
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [supabase, productionLineId])

  function togglePicked(product: Product, isPicked: boolean) {
    setResult(null)
    setPickedIds((prev) => {
      const next = new Set(prev)
      if (isPicked) next.delete(product.id)
      else next.add(product.id)
      return next
    })
  }

  function toggleSeries(_series: string, seriesProducts: Product[], allSelected: boolean) {
    setResult(null)
    setPickedIds((prev) => {
      const next = new Set(prev)
      for (const p of seriesProducts) {
        if (allSelected) next.delete(p.id)
        else next.add(p.id)
      }
      return next
    })
  }

  async function handleApply() {
    setConfirming(false)
    setApplying(true); setError(null); setResult(null)

    const picked = [...pickedIds]
    const productById = new Map(products.map((p) => [p.id, p]))
    const opById = new Map(operations.map((o) => [o.id, o]))

    try {
      const existing = await fetchLinksForOperations(supabase, opIds)
      const linkedByOp = new Map<string, Set<string>>()
      for (const row of existing) {
        if (!linkedByOp.has(row.operation_id)) linkedByOp.set(row.operation_id, new Set())
        linkedByOp.get(row.operation_id)!.add(row.product_id)
      }
      // Only Replace deletes, so only Replace needs the timed guard — Add never removes a link
      // and has nothing to protect.
      const timed = effectiveMode === 'replace' ? await fetchTimedPairs(supabase, opIds) : new Set<string>()

      const toInsert: { operation_id: string; product_id: string }[] = []
      const toDelete: { operation_id: string; product_id: string }[] = []

      for (const opId of opIds) {
        const current = linkedByOp.get(opId) ?? new Set<string>()
        // Both modes insert exactly the missing links — Add stops there.
        for (const productId of picked) if (!current.has(productId)) toInsert.push({ operation_id: opId, product_id: productId })
        if (effectiveMode !== 'replace') continue
        for (const productId of current) {
          if (pickedIds.has(productId)) continue
          toDelete.push({ operation_id: opId, product_id: productId })
        }
      }

      // Both writes go through the shared applies-list helpers — including the "kept because
      // it has recorded times" split, which is unlinkOperationsFromModels' own job now rather
      // than something this drawer works out for itself.
      const linkResult = await linkOperationsToModels(supabase, toInsert)
      const unlinkResult = await unlinkOperationsFromModels(supabase, toDelete, timed)

      setResult({
        mode: effectiveMode,
        inserted: linkResult.linked,
        insertAttempted: linkResult.attempted,
        deleted: unlinkResult.unlinked,
        deleteAttempted: unlinkResult.attempted,
        kept: unlinkResult.kept.map((pair) => ({
          operationName: opById.get(pair.operation_id)?.name ?? 'Operation',
          model: productById.get(pair.product_id)?.model ?? 'Unknown model',
        })),
        error: linkResult.error ?? unlinkResult.error,
      })
      await onApplied()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply model links')
    } finally {
      setApplying(false)
    }
  }

  const opCount = operations.length
  const modelCount = pickedIds.size
  const addSummary = `Link ${plural(modelCount, 'model')} to ${plural(opCount, 'operation')} (${plural(modelCount * opCount, 'link')})`
  const replaceSummary = `Replace the model set on ${plural(opCount, 'operation')} with ${plural(modelCount, 'model')}`

  return (
    <>
      <div className="gaps-drawer-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="gaps-drawer-title">{jobMode ? 'Models this job applies to' : 'Link models'}</div>
          <div className="gaps-drawer-jobname">
            {subjectLabel} · {plural(opCount, 'operation')}{jobMode ? '' : ' selected'}
          </div>
        </div>
        <button className="gaps-drawer-close" onClick={onClose} aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* flex:1 + own scroll so the apply footer below stays pinned to the drawer's bottom. */}
      <div className="gaps-drawer-body" style={{ padding: '16px 20px', flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {error && <p style={{ ...ERR_BOX, marginBottom: 14 }}>{error}</p>}

        {result && (
          <div
            style={{
              marginBottom: 14, padding: '10px 14px', borderRadius: 8, fontSize: 12,
              background: result.error ? 'var(--red-bg)' : 'var(--bg)',
              border: '1px solid ' + (result.error ? '#fecaca' : 'var(--border)'),
              color: result.error ? 'var(--red)' : 'var(--text-mid)',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: result.kept.length > 0 || result.error ? 6 : 0 }}>
              {result.mode === 'add'
                ? `Added ${result.inserted} of ${plural(result.insertAttempted, 'new link')}`
                : `Added ${result.inserted} of ${plural(result.insertAttempted, 'link')}, removed ${result.deleted} of ${result.deleteAttempted}`}
            </div>
            {result.error && <div style={{ marginBottom: result.kept.length > 0 ? 6 : 0 }}>Some writes failed: {result.error}</div>}
            {result.kept.length > 0 && (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>
                  {plural(result.kept.length, 'link')} kept — already has recorded times:
                </div>
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {result.kept.slice(0, 12).map((k, i) => (
                    <li key={`${k.operationName}-${k.model}-${i}`}>{k.operationName} — {k.model}</li>
                  ))}
                  {result.kept.length > 12 && <li>+{result.kept.length - 12} more</li>}
                </ul>
              </div>
            )}
          </div>
        )}

        {jobMode ? (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 16px', lineHeight: 1.55 }}>
            Ticked models are the ones <strong>{subjectLabel}</strong> applies to. Ticking links every
            one of its {plural(opCount, 'operation')} to that model; unticking unlinks them.
            A model with recorded times is always kept.
          </p>
        ) : allowReplace ? (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 8 }}>
            How to apply
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer', marginBottom: 8 }}>
            <input type="radio" name="bulk-mode" checked={mode === 'add'} onChange={() => { setMode('add'); setResult(null) }} style={{ marginTop: 3 }} />
            <span>
              <strong>Add</strong>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>
                Link the ticked models to every selected operation. Existing links are left untouched.
              </span>
            </span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
            <input type="radio" name="bulk-mode" checked={mode === 'replace'} onChange={() => { setMode('replace'); setResult(null) }} style={{ marginTop: 3 }} />
            <span>
              <strong>Replace</strong>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>
                Make each selected operation&apos;s models exactly the ticked ones. Models with recorded times are always kept.
              </span>
            </span>
          </label>
        </div>
        ) : (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 16px', lineHeight: 1.55 }}>
            The ticked models are added to every selected operation &mdash; this is what those
            operations <strong>apply to</strong>, not what any timing counts for. Nothing is
            ever unlinked here, and models already linked are left as they are.
          </p>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
            Models — {modelCount} selected
          </div>
          {modelCount > 0 && (
            <button
              type="button"
              onClick={() => { setPickedIds(new Set()); setResult(null) }}
              style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mid)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Clear
            </button>
          )}
        </div>

        {loading ? (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>Loading…</p>
        ) : products.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {productionLineId
              ? 'No products found for this production line'
              : 'This job has no production line, so there are no models to link. Set one in Setup, under Line, first.'}
          </p>
        ) : (
          <ModelSeriesPicker
            products={products}
            selectedIds={pickedIds}
            onToggle={togglePicked}
            onToggleSeries={toggleSeries}
            renderRowStatus={jobMode ? (product) => {
              const linked = jobLinkCounts?.get(product.id) ?? 0
              // Only the PARTIAL case is worth a badge: nothing linked is already the unticked
              // state, and all-linked is the plain ticked one.
              if (linked === 0 || linked >= opCount) return null
              return (
                <span
                  className="badge badge-amber"
                  style={{ fontSize: 10 }}
                  title={`Only ${linked} of this job's ${opCount} operations are linked to ${product.model}. Leaving it ticked links the rest.`}
                >
                  {linked} of {plural(opCount, 'operation')}
                </span>
              )
            } : undefined}
          />
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 20px', display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', flexShrink: 0, background: 'var(--surface)' }}>
        <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
        <button
          type="button"
          className="btn-primary"
          disabled={applying || modelCount === 0 || opCount === 0}
          onClick={() => setConfirming(true)}
        >
          {applying ? 'Applying…' : effectiveMode === 'add' ? `Link to ${plural(opCount, 'operation')}` : `Replace on ${plural(opCount, 'operation')}`}
        </button>
      </div>

      {confirming && (
        <ConfirmDialog
          title={effectiveMode === 'add' ? 'Add model links' : 'Replace model sets'}
          message={effectiveMode === 'add'
            ? `${addSummary}. Links that already exist are skipped — nothing is removed.`
            : `${replaceSummary}. This overwrites each selected operation's model set: any model not ticked is unlinked, except models with recorded times, which are kept.`}
          confirmLabel={effectiveMode === 'add' ? 'Add links' : 'Replace'}
          danger={effectiveMode === 'replace'}
          onConfirm={handleApply}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  )
}
