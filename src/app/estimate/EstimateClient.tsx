'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { fetchEstimateGrid, markNotApplicable, removeEstimates, saveEstimates, type EstimateCellState, type EstimateRemoval, type EstimateGrid, type EstimateOperation, type EstimatePair, type EstimateWrite } from '@/lib/estimates'
import { modelsForLine } from '@/lib/lines'
import { operationProductKey } from '@/lib/operationTimes'
import { groupProducts } from '@/lib/productGroups'
import { fetchSectionsForLine } from '@/lib/sections'
import { fetchAllRows } from '@/lib/supabaseRead'
import { fmtDateTime, fmtMinutes, plural } from '@/lib/format'
import Modal from '@/components/Modal'
import { usePersistedFilter } from '@/lib/useLocalStorage'
import type { Product, ProductionLine, Section, Team } from '@/lib/types'

/**
 * ── /estimate ──────────────────────────────────────────────────────────────────────────────
 *
 * One JOB's operations down the side — or, with only a section chosen, every job in the section
 * stacked, each with its own heading and total — and a range of MODELS across the top. Measured cells are the
 * evidence and are read-only; empty cells are inputs; saved estimates are editable. Typed cells
 * are written by Save estimates; a column copy is written by its own confirmation dialog (see
 * CopyPlan). Either way each cell becomes one is_estimated operation_times record through the
 * shared writers — see lib/estimates for exactly what one cell writes.
 *
 * The four cell states, and why each looks the way it does:
 *   MEASURED   green tint, the Labour Matrix's "this figure was measured" colour. Read-only:
 *              nothing on this screen can overwrite, hide or supersede a measured time.
 *   ESTIMATED  orange tint, the Matrix's "inferred" colour. An input holding the saved figure;
 *              changing it updates that record, never adds a second.
 *   OPEN       an empty input — the operation applies, nothing is recorded. A real gap.
 *   UNDECIDED  a faint input: no model_operations row and no exclusion — nobody has said whether
 *              the work is done on this model. Typing a figure asserts that it is: Save links the
 *              operation to the model and records the estimate.
 *   EXCLUDED   hatched, "n/a" struck through: a model_operation_exclusions row — somebody DECIDED
 *              the work isn't done on this model, and it stays that way across reloads. Marking a
 *              cell (the × control, or typing "x") removes the link and writes that row; typing a
 *              figure into an excluded cell withdraws the decision and links it. Never allowed
 *              where a measured time exists.
 *   REMOVING   a saved estimate marked for removal (the bin control): red tint, red dashed edge,
 *              the figure struck through in red. Save HIDES the record (is_hidden, nothing
 *              deleted) and leaves the link — the cell becomes OPEN, a gap again. Not "not
 *              applicable", which removes the link. Never drawn on a measured cell, and
 *              lib/estimates' removeEstimates refuses one regardless.
 */

export interface EstimateTarget {
  lineId: string
  sectionId: string
  jobId: string
  /** The model whose Matrix cell was clicked — its range is shown and its column focused. */
  productId: string | null
}

interface Props {
  lines: ProductionLine[]
  userId: string
  target: EstimateTarget | null
}

interface JobOption { id: string; name: string }
type TeamRow = Pick<Team, 'id' | 'name' | 'production_line_id'>

/** A typed figure not yet saved. The pair travels with it so nothing has to take a key apart.
 * `remove` marks a saved estimate for removal instead — raw is then unused, and the cell is
 * read-only until the mark is undone (↺ or Esc). */
interface Draft { operationId: string; productId: string; raw: string; remove?: true }

/**
 * What a column copy will write, worked out once when Apply copy is pressed and shown in its
 * dialog. A snapshot, not live: what was inspected is exactly what Save writes, even if the grid
 * reloads underneath. Every in-range cell lands in `writes` or in one of the `skipped` counts —
 * nothing is dropped without being counted.
 */
interface CopyPlan {
  sourceModel: string
  factor: number
  /** Where the copied figures come from on the source model. `typed` = typed there, not saved. */
  sourceKinds: { measured: number; estimated: number; typed: number }
  rows: { operationId: string; name: string; minutes: number; models: number }[]
  writes: EstimateWrite[]
  /** Models receiving at least one figure, in column order. */
  targets: Product[]
  /** Models in range (ticked, or every one on screen) — some may receive nothing. */
  rangeCount: number
  /** model_operations links the save creates: the work applied to a model for the first time. */
  newLinks: number
  skipped: {
    measured: number
    notApplicable: number
    /** Already holds a figure — a saved estimate, or one typed and not saved. */
    filled: number
    /** Operations in the copy with no figure on the source model. */
    noSource: number
  }
}

const SEL: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
  border: '1.5px solid var(--border)', borderRadius: 8, padding: '7px 10px',
  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', outline: 'none', minWidth: 170,
}
const EMPTY: React.CSSProperties = { textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '40px 0' }
const NO_SERIES = '(no series)'
const NO_TYPE = '(no type)'

/** A typed figure as minutes, or null if it isn't one. Comma accepted as the decimal point —
 * the keypad on half the floor's tablets offers nothing else. */
function parseMinutes(raw: string): number | null {
  const n = Number(raw.trim().replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}
const round1 = (n: number) => Math.round(n * 10) / 10
/** What a cell holds when it has been marked not applicable — by the × control, or typed. */
const NA_TEXT = 'n/a'
const isNaText = (raw: string) => /^(x|-|n\/?a)$/i.test(raw.trim())
// Trimmed, like the Labour Matrix's series options, so a stray space can't split a range in two.
const typeOf = (p: Product) => p.product_type?.trim() || NO_TYPE
const seriesOf = (p: Product) => p.product_series?.trim() || NO_SERIES

export default function EstimateClient({ lines, userId, target }: Props) {
  const supabase = useMemo(() => createClient(), [])

  // ── What to work on ──────────────────────────────────────────────────────────────────────
  // Persisted like every other filter in the app, except when a Matrix click hands over a target:
  // that wins over whatever was last left here (usePersistedFilter's override).
  const [lineId, setLineId] = usePersistedFilter('estimate.lineId', '', target?.lineId || undefined)
  const [teamFilter, setTeamFilter] = usePersistedFilter('estimate.teamId', '')
  const [sectionId, setSectionId] = usePersistedFilter('estimate.sectionId', '', target?.sectionId || undefined)
  const [jobId, setJobId] = usePersistedFilter('estimate.jobId', '', target?.jobId || undefined)
  const [typeFilter, setTypeFilter] = usePersistedFilter('estimate.type', '')
  const [seriesFilter, setSeriesFilter] = usePersistedFilter('estimate.series', '')
  const [buildLineFilter, setBuildLineFilter] = usePersistedFilter('estimate.buildLine', '')
  const [hideTimedRaw, setHideTimedRaw] = usePersistedFilter('estimate.hideFullyTimed', '1')
  const hideFullyTimed = hideTimedRaw !== '0'

  const [sections, setSections] = useState<Section[]>([])
  const [teams, setTeams] = useState<TeamRow[]>([])
  /** The section's jobs, tagged with the section they were read for — so a switch of section
   * can't stack the previous section's jobs for a moment. */
  const [jobsRead, setJobsRead] = useState<{ sectionId: string; rows: JobOption[] } | null>(null)
  const [grid, setGrid] = useState<EstimateGrid | null>(null)
  /** Every model on the line — lib/lines' modelsForLine, so a pre-assembly area gets the models
   * of the lines it feeds. The columns are the RANGE, not just the models already linked to the
   * job: a model nothing links yet is exactly where applicability gets added. */
  const [lineModels, setLineModels] = useState<Product[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    if (!lineId) { setSections([]); return }
    let cancelled = false
    fetchSectionsForLine(supabase, lineId)
      .then((rows) => { if (!cancelled) setSections(rows) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load sections') })
    return () => { cancelled = true }
  }, [supabase, lineId])

  useEffect(() => {
    if (!lineId) { setLineModels([]); return }
    let cancelled = false
    modelsForLine(supabase, lineId)
      .then((rows) => { if (!cancelled) setLineModels(rows) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load models') })
    return () => { cancelled = true }
  }, [supabase, lineId])

  // Team → Section, as on Config → Sections: the line's teams, and a team narrows the sections to
  // its own (section.team_id). Read once; the line picks which apply.
  useEffect(() => {
    let cancelled = false
    fetchAllRows<TeamRow>(() => supabase.from('teams').select('id, name, production_line_id').order('name').order('id'), { table: 'teams' })
      .then((rows) => { if (!cancelled) setTeams(rows) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load teams') })
    return () => { cancelled = true }
  }, [supabase])
  const lineTeams = useMemo(() => teams.filter((t) => t.production_line_id === lineId), [teams, lineId])
  // A stored id that isn't on offer reads as not set — the same guard the Labour Matrix gives its
  // remembered series and team, so a value from another line can't drive a read.
  const activeTeamId = lineTeams.some((t) => t.id === teamFilter) ? teamFilter : ''
  const sectionOptions = useMemo(
    () => (activeTeamId ? sections.filter((s) => s.team_id === activeTeamId) : sections),
    [sections, activeTeamId],
  )
  const activeSectionId = sectionOptions.some((s) => s.id === sectionId) ? sectionId : ''
  // A Matrix click names a section; a remembered team that would hide it gives way.
  const teamSeededRef = useRef(false)
  useEffect(() => {
    if (teamSeededRef.current || !target?.sectionId || sections.length === 0) return
    teamSeededRef.current = true
    const team = sections.find((s) => s.id === target.sectionId)?.team_id
    if (teamFilter && team !== teamFilter) setTeamFilter('')
  }, [target, sections, teamFilter, setTeamFilter])

  useEffect(() => {
    if (!activeSectionId) return
    let cancelled = false
    fetchAllRows<JobOption>(
      () => supabase.from('jobs').select('id, name').eq('section_id', activeSectionId).eq('is_active', true)
        .order('name').order('id'),
      { table: 'jobs' },
    )
      .then((rows) => { if (!cancelled) setJobsRead({ sectionId: activeSectionId, rows }) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load jobs') })
    return () => { cancelled = true }
  }, [supabase, activeSectionId])
  const jobsReady = !!activeSectionId && jobsRead?.sectionId === activeSectionId
  const jobs = useMemo(() => (jobsReady ? jobsRead?.rows ?? [] : []), [jobsReady, jobsRead])

  const activeJobId = jobs.some((j) => j.id === jobId) ? jobId : ''
  const jobName = jobs.find((j) => j.id === activeJobId)?.name ?? ''
  /** The jobs on screen: the chosen one, or — Job left unset — every job in the section, stacked. */
  const viewJobs = useMemo(() => (activeJobId ? jobs.filter((j) => j.id === activeJobId) : jobs), [jobs, activeJobId])
  const viewJobKey = viewJobs.map((j) => j.id).join(',')

  useEffect(() => {
    const ids = viewJobKey ? viewJobKey.split(',') : []
    if (ids.length === 0) { setGrid(null); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchEstimateGrid(supabase, ids)
      .then((g) => { if (!cancelled) setGrid(g) })
      .catch((err) => {
        if (cancelled) return
        console.error('[estimate] grid read failed:', err)
        setError(err instanceof Error ? err.message : 'Could not load the job')
        setGrid(null)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [supabase, viewJobKey, reloadTick])

  // ── Drafts: everything typed and not yet saved ───────────────────────────────────────────
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map())
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set())
  /** Ticked operation rows — narrow the bulk tools to those rows. */
  const [selectedOps, setSelectedOps] = useState<Set<string>>(new Set())
  const [copySource, setCopySource] = useState('')
  /** With several jobs stacked, which one a column copy works within. */
  const [copyJobId, setCopyJobId] = useState('')
  /** One note for the whole save, written onto every record it writes. Optional. */
  const [saveNote, setSaveNote] = useState('')
  /** The notes popover for one cell's record, positioned off the clicked icon. */
  const [notesOpen, setNotesOpen] = useState<{ operationId: string; productId: string; top: number; left: number } | null>(null)
  const notesTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [factorRaw, setFactorRaw] = useState('1.0')
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)

  /** Asked before anything that would throw typed work away. */
  function confirmDiscard(): boolean {
    return drafts.size === 0 || window.confirm(`Discard ${plural(drafts.size, 'unsaved figure')}?`)
  }
  /** A tick is a choice about what is on screen; when what is on screen changes, it goes. */
  function clearTicks() {
    setSelectedTargets(new Set()); setSelectedOps(new Set())
  }
  function resetWork() {
    setDrafts(new Map()); clearTicks(); setCopySource(''); setCopyJobId(''); setSaveNote(''); setNotice(null); setNotesOpen(null)
  }

  // ── Cell facts, off the grid read ────────────────────────────────────────────────────────
  const stateOf = useCallback(
    (operationId: string, productId: string): EstimateCellState | undefined =>
      grid?.cells.get(operationProductKey(operationId, productId)),
    [grid],
  )
  /** model_operations says the operation applies to the model. */
  const isLinked = useCallback(
    (operationId: string, productId: string) => grid?.links.has(operationProductKey(operationId, productId)) ?? false,
    [grid],
  )
  /** Every cell is an input except a measured one — unlinked included; see the module note. */
  const isEditable = useCallback(
    (operationId: string, productId: string) => !!grid && stateOf(operationId, productId)?.kind !== 'measured',
    [grid, stateOf],
  )
  /** Ever measured, in any state — such a pair can't be marked not applicable. */
  const hasMeasured = useCallback(
    (operationId: string, productId: string) => grid?.measuredHistory.has(operationProductKey(operationId, productId)) ?? false,
    [grid],
  )
  /** Decided not applicable (model_operation_exclusions). A link outranks it: a pair linked again
   * elsewhere since is shown as applying, and the stale row is ignored. */
  const isExcluded = useCallback(
    (operationId: string, productId: string) => {
      const key = operationProductKey(operationId, productId)
      return (grid?.exclusions.has(key) ?? false) && !(grid?.links.has(key) ?? false)
    },
    [grid],
  )
  const isMarkedNa = useCallback(
    (operationId: string, productId: string) => isNaText(drafts.get(operationProductKey(operationId, productId))?.raw ?? ''),
    [drafts],
  )

  /** The figure a cell stands at right now: measured, else a valid draft, else the saved
   * estimate. null for nothing (or for a draft that isn't a number — flagged separately). */
  const valueOf = useCallback((operationId: string, productId: string): number | null => {
    const state = stateOf(operationId, productId)
    if (state?.kind === 'measured') return state.minutes
    const draft = drafts.get(operationProductKey(operationId, productId))
    if (draft?.remove) return null
    if (draft && draft.raw.trim() !== '') return parseMinutes(draft.raw)
    return state?.kind === 'estimated' ? state.minutes : null
  }, [stateOf, drafts])

  // ── The model filter ─────────────────────────────────────────────────────────────────────
  const lineName = useCallback((id: string | null) => lines.find((l) => l.id === id)?.name ?? 'No line', [lines])
  const products = useMemo(() => {
    if (!grid) return []
    const byId = new Map(lineModels.map((p) => [p.id, p]))
    // The job's own models too: one linked from another line still belongs on its grid.
    for (const p of grid.products) byId.set(p.id, p)
    return [...byId.values()].sort((a, b) => a.model.localeCompare(b.model))
  }, [grid, lineModels])

  const buildLineOptions = useMemo(
    () => [...new Set(products.map((p) => p.production_line_id ?? ''))]
      .map((id) => ({ id, name: lineName(id || null) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [products, lineName],
  )
  const activeBuildLine = buildLineOptions.some((b) => b.id === buildLineFilter) ? buildLineFilter : ''
  const afterBuildLine = useMemo(
    () => (activeBuildLine ? products.filter((p) => (p.production_line_id ?? '') === activeBuildLine) : products),
    [products, activeBuildLine],
  )
  const typeOptions = useMemo(() => [...new Set(afterBuildLine.map(typeOf))].sort(), [afterBuildLine])
  const activeType = typeOptions.includes(typeFilter) ? typeFilter : ''
  const afterType = useMemo(
    () => (activeType ? afterBuildLine.filter((p) => typeOf(p) === activeType) : afterBuildLine),
    [afterBuildLine, activeType],
  )
  const seriesOptions = useMemo(() => [...new Set(afterType.map(seriesOf))].sort(), [afterType])
  const activeSeries = seriesOptions.includes(seriesFilter) ? seriesFilter : ''
  const filteredProducts = useMemo(
    () => (activeSeries ? afterType.filter((p) => seriesOf(p) === activeSeries) : afterType),
    [afterType, activeSeries],
  )

  /**
   * "Hide fully timed": a model is hidden only when every operation of the job that APPLIES to it
   * has a counted time AND none of those times is measured — i.e. a model already finished by
   * estimates. A model with ANY measured time in this job is never hidden, whatever the filter
   * says: the measured columns are the evidence the rest of the grid is reasoned from. A model
   * with 2 of 10 timed stays on screen too, which is the model most worth looking at. "Applies" means linked, or already timed: an operation marked not
   * applicable has no time to wait for, and counting it would keep a finished model visible
   * forever. A model nothing in the job applies to yet stays visible — it is somewhere
   * applicability can still be added.
   *
   * Rows: an operation is hidden only when every visible model has a counted time for it AND at
   * least one of them is an estimate — a row of nothing but measured figures is evidence too, and
   * stays.
   */
  const isFullyTimed = useCallback((productId: string) => {
    if (!grid) return false
    const applicable = grid.operations.filter((o) => isLinked(o.id, productId) || stateOf(o.id, productId))
    if (applicable.length === 0 || !applicable.every((o) => stateOf(o.id, productId))) return false
    // Evidence is never hidden.
    return !grid.operations.some((o) => stateOf(o.id, productId)?.kind === 'measured')
  }, [grid, isLinked, stateOf])
  const visibleProducts = useMemo(
    () => (hideFullyTimed ? filteredProducts.filter((p) => !isFullyTimed(p.id)) : filteredProducts),
    [hideFullyTimed, filteredProducts, isFullyTimed],
  )
  const hiddenModelCount = filteredProducts.length - visibleProducts.length
  /** Every operation, in job order (the job list's), then by name within a job. Row indexes for
   * the keyboard run straight down this, job after job. */
  const allOps = useMemo(() => {
    if (!grid) return []
    const order = new Map(viewJobs.map((j, i) => [j.id, i]))
    return grid.operations
      .filter((o) => order.has(o.job_id))
      .sort((a, b) => (order.get(a.job_id) as number) - (order.get(b.job_id) as number) || a.name.localeCompare(b.name))
  }, [grid, viewJobs])
  const visibleOps = useMemo(() => {
    if (!hideFullyTimed) return allOps
    return allOps.filter((o) =>
      !visibleProducts.every((p) => stateOf(o.id, p.id))
      || visibleProducts.some((p) => stateOf(o.id, p.id)?.kind === 'measured'))
  }, [allOps, hideFullyTimed, visibleProducts, stateOf])
  const hiddenOpCount = allOps.length - visibleOps.length
  /** One block per job with rows on screen — its heading, its rows, its total. */
  const blocks = useMemo(() => viewJobs
    .map((job) => ({
      job,
      ops: visibleOps.filter((o) => o.job_id === job.id),
      hidden: allOps.filter((o) => o.job_id === job.id).length - visibleOps.filter((o) => o.job_id === job.id).length,
    }))
    .filter((b) => b.ops.length > 0), [viewJobs, visibleOps, allOps])

  /** Type → series, the Labour Matrix's own grouping, as column bands. */
  const groups = useMemo(() => groupProducts(visibleProducts), [visibleProducts])
  const columns = useMemo(() => groups.flatMap((g) => g.series.flatMap((s) => s.products)), [groups])

  // ── Arriving from the Matrix ─────────────────────────────────────────────────────────────
  // Narrow to the clicked model's range, once, when its job's grid first arrives — the click was
  // about that model, and "the Adventurer range" is the unit of reasoning here.
  const seededRef = useRef(false)
  const [focusProductId, setFocusProductId] = useState<string | null>(target?.productId ?? null)
  useEffect(() => {
    if (seededRef.current || !grid || !target?.productId || activeJobId !== target.jobId) return
    seededRef.current = true
    const p = products.find((x) => x.id === target.productId)
    if (!p) return
    setBuildLineFilter('')
    setTypeFilter(typeOf(p))
    setSeriesFilter(seriesOf(p))
  }, [grid, products, target, activeJobId, setBuildLineFilter, setTypeFilter, setSeriesFilter])

  // ── Keyboard: the grid is a spreadsheet ─────────────────────────────────────────────────
  const inputRefs = useRef(new Map<string, HTMLInputElement>())
  const lastFocusedRef = useRef<{ operationId: string; productId: string } | null>(null)

  useEffect(() => {
    if (!focusProductId || columns.length === 0) return
    const c = columns.findIndex((p) => p.id === focusProductId)
    if (c < 0) return
    for (let r = 0; r < visibleOps.length; r += 1) {
      const el = inputRefs.current.get(`${r}:${c}`)
      if (el) { el.focus(); el.scrollIntoView({ block: 'nearest', inline: 'center' }); break }
    }
    setFocusProductId(null)
  }, [focusProductId, columns, visibleOps])

  function move(r: number, c: number, dr: number, dc: number): boolean {
    for (let rr = r + dr, cc = c + dc; rr >= 0 && rr < visibleOps.length && cc >= 0 && cc < columns.length; rr += dr, cc += dc) {
      const el = inputRefs.current.get(`${rr}:${cc}`)
      if (el) { el.focus(); return true }
    }
    return false
  }
  function onCellKey(e: React.KeyboardEvent<HTMLInputElement>, r: number, c: number) {
    const el = e.currentTarget
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length
    const allSelected = el.selectionStart === 0 && el.selectionEnd === el.value.length
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); move(r, c, 1, 0) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(r, c, -1, 0) }
    // Left/right only leave the cell from its edge (or with the whole figure selected, which is how
    // focus arrives) — otherwise they move the caret, so a typo can be fixed in place.
    else if (e.key === 'ArrowRight' && (atEnd || allSelected)) { e.preventDefault(); move(r, c, 0, 1) }
    else if (e.key === 'ArrowLeft' && (atStart || allSelected)) { e.preventDefault(); move(r, c, 0, -1) }
    else if (e.key === 'Escape') {
      // Back to what was saved for this one cell.
      const key = operationProductKey(visibleOps[r].id, columns[c].id)
      setDrafts((prev) => { const next = new Map(prev); next.delete(key); return next })
    }
  }

  function setDraft(operationId: string, productId: string, raw: string) {
    const key = operationProductKey(operationId, productId)
    setDrafts((prev) => {
      const next = new Map(prev)
      next.set(key, { operationId, productId, raw })
      return next
    })
    setNotice(null)
  }

  /** Writes many drafts in one state update — the fast-fill tools below. */
  function setDraftsBulk(entries: { operationId: string; productId: string; minutes: number }[]) {
    if (entries.length === 0) return
    setDrafts((prev) => {
      const next = new Map(prev)
      for (const e of entries) {
        next.set(operationProductKey(e.operationId, e.productId), { operationId: e.operationId, productId: e.productId, raw: String(round1(e.minutes)) })
      }
      return next
    })
    setNotice(null)
  }

  // ── Filling fast ─────────────────────────────────────────────────────────────────────────
  const factor = parseMinutes(factorRaw)
  /**
   * The rows a bulk action works on. Bulk actions stay WITHIN A JOB: with several stacked, a
   * column copy works in one — the job its ticked rows belong to, else the one chosen beside it.
   * Ticked rows narrow it further; none ticked is every row of that job on screen.
   */
  const tickedOps = useMemo(() => visibleOps.filter((o) => selectedOps.has(o.id)), [visibleOps, selectedOps])
  const tickedJobIds = useMemo(() => [...new Set(tickedOps.map((o) => o.job_id))], [tickedOps])
  const copyJob = tickedJobIds.length === 1 ? tickedJobIds[0]
    : blocks.length === 1 ? blocks[0].job.id
      : blocks.some((b) => b.job.id === copyJobId) ? copyJobId : ''
  const copyBlocked = tickedJobIds.length > 1
  const copyOps: EstimateOperation[] = useMemo(() => (copyBlocked || !copyJob ? [] : visibleOps.filter((o) =>
    o.job_id === copyJob && (tickedOps.length === 0 || selectedOps.has(o.id)))), [copyBlocked, copyJob, visibleOps, tickedOps, selectedOps])
  /** What source counts and target counts are taken over: the copy's rows, or every row on screen
   * until a job is chosen. */
  const scopeOps = copyJob && !copyBlocked ? copyOps : visibleOps
  /** Models with something to copy FROM — any figure in the rows on screen. Measured first.
   * Drawn from the whole filtered range, NOT just the columns on screen: "hide fully timed" hides
   * a fully measured model, and that is precisely the model worth copying from. */
  const sourceOptions = useMemo(() => filteredProducts
    .map((p) => {
      const measured = scopeOps.filter((o) => stateOf(o.id, p.id)?.kind === 'measured').length
      const any = scopeOps.filter((o) => valueOf(o.id, p.id) != null).length
      return { product: p, measured, any }
    })
    .filter((s) => s.any > 0)
    .sort((a, b) => b.measured - a.measured || a.product.model.localeCompare(b.product.model)),
  [filteredProducts, scopeOps, stateOf, valueOf])
  const activeSource = sourceOptions.some((s) => s.product.id === copySource) ? copySource : ''

  /** A cell a bulk fill may write into: empty, linked or undecided alike. Never a measured cell
   * (not editable), never one decided not applicable (a decision already made — a bulk action
   * doesn't undo it), never one being marked not applicable now. Filling an undecided cell
   * applies the work to that model on save; the save bar counts those before anything is written. */
  const isFillable = useCallback(
    (operationId: string, productId: string) =>
      isEditable(operationId, productId) && !isExcluded(operationId, productId) &&
      valueOf(operationId, productId) == null && !isMarkedNa(operationId, productId) &&
      !drafts.get(operationProductKey(operationId, productId))?.remove,
    [isEditable, isExcluded, valueOf, isMarkedNa, drafts],
  )
  const selectedOnScreen = columns.filter((p) => selectedTargets.has(p.id) && p.id !== activeSource)
  /** Ticked model headings narrow both bulk tools; with none ticked they reach every model on screen. */
  const fillRange = useMemo(() => {
    const ticked = columns.filter((p) => selectedTargets.has(p.id) && p.id !== activeSource)
    return ticked.length > 0 ? ticked : columns.filter((p) => p.id !== activeSource)
  }, [columns, selectedTargets, activeSource])
  /** Models in range with at least one empty cell a column copy could fill. */
  const fillTargets = useMemo(
    () => fillRange.filter((p) => scopeOps.some((o) => isFillable(o.id, p.id))),
    [fillRange, scopeOps, isFillable],
  )

  /**
   * Copy a column across, optionally at a factor, into every empty cell in range — linked or
   * undecided. It never changes a figure somebody already typed or saved, never touches a
   * measured cell, and never overturns a not-applicable decision. Builds the plan the dialog
   * shows; nothing is written until Save inside it.
   */
  function planCopy(): CopyPlan | null {
    if (!activeSource || factor == null || !copyJob || copyBlocked || !grid) return null
    const sourceKinds = { measured: 0, estimated: 0, typed: 0 }
    const skipped = { measured: 0, notApplicable: 0, filled: 0, noSource: 0 }
    const rows: CopyPlan['rows'] = []
    const writes: EstimateWrite[] = []
    const hit = new Set<string>()
    for (const o of copyOps) {
      const src = valueOf(o.id, activeSource)
      if (src == null) { skipped.noSource += 1; continue }
      const srcState = stateOf(o.id, activeSource)
      const srcDraft = drafts.get(operationProductKey(o.id, activeSource))
      if (srcState?.kind === 'measured') sourceKinds.measured += 1
      else if (srcDraft && srcDraft.raw.trim() !== '' && !(srcState && Math.abs(srcState.minutes - src) < 1e-9)) sourceKinds.typed += 1
      else sourceKinds.estimated += 1
      const minutes = round1(src * factor)
      let models = 0
      for (const t of fillRange) {
        if (stateOf(o.id, t.id)?.kind === 'measured') { skipped.measured += 1; continue }
        if (isExcluded(o.id, t.id) || isMarkedNa(o.id, t.id)) { skipped.notApplicable += 1; continue }
        if (valueOf(o.id, t.id) != null || drafts.get(operationProductKey(o.id, t.id))?.remove) { skipped.filled += 1; continue }
        writes.push({
          operationId: o.id, productId: t.id, minutes, existing: null,
          linked: grid.links.has(operationProductKey(o.id, t.id)), excluded: false,
        })
        hit.add(t.id)
        models += 1
      }
      rows.push({ operationId: o.id, name: o.name, minutes, models })
    }
    return {
      sourceModel: filteredProducts.find((p) => p.id === activeSource)?.model ?? '',
      factor,
      sourceKinds,
      rows,
      writes,
      targets: fillRange.filter((p) => hit.has(p.id)),
      rangeCount: fillRange.length,
      newLinks: writes.filter((w) => !w.linked).length,
      skipped,
    }
  }
  const [copyPlan, setCopyPlan] = useState<CopyPlan | null>(null)
  /** Why this copy is being made — onto every record it writes. Its own, not the save bar's. */
  const [copyNote, setCopyNote] = useState('')
  function openCopy() {
    const plan = planCopy()
    if (!plan) return
    setCopyNote('')
    setNotice(null)
    setCopyPlan(plan)
  }

  /** The dialog's Save: straight to the database through saveEstimates — the same writer, and
   * the same note path, as Save estimates. Typed drafts elsewhere on the grid are left alone. */
  async function saveCopy() {
    if (!copyPlan || copyPlan.writes.length === 0 || saving) return
    const { writes, targets, sourceModel } = copyPlan
    setSaving({ done: 0, total: writes.length })
    try {
      const est = await saveEstimates(supabase, writes, userId, (done) => setSaving({ done, total: writes.length }), copyNote)
      const noteMiss = est.noteFailures > 0 ? ` The note could not be added to ${plural(est.noteFailures, 'record')}; the figures are saved.` : ''
      setCopyPlan(null)
      if (est.failures.length === 0) {
        clearTicks()
        setNotice({
          tone: est.noteFailures > 0 ? 'warn' : 'ok',
          text: `Saved ${plural(writes.length, 'estimate')} across ${plural(targets.length, 'model')} from ${sourceModel}.` + noteMiss,
        })
      } else {
        // Failed cells stay empty on the reload, so Apply copy again offers exactly those.
        const opName = (id: string) => grid?.operations.find((o) => o.id === id)?.name ?? 'operation'
        const model = (id: string) => products.find((p) => p.id === id)?.model ?? 'model'
        const first = est.failures[0]
        setNotice({
          tone: 'warn',
          text: `Saved ${est.saved} of ${writes.length}. ${plural(est.failures.length, 'cell')} could not be saved and ` +
            `${est.failures.length === 1 ? 'is' : 'are'} left empty — Apply copy again to retry them. e.g. ${opName(first.operationId)} on ${model(first.productId)}: ${first.message}` + noteMiss,
        })
      }
    } catch (err) {
      setCopyPlan(null)
      setNotice({ tone: 'warn', text: err instanceof Error ? err.message : 'Could not save the copy' })
    } finally {
      setSaving(null)
      setReloadTick((t) => t + 1)
    }
  }

  /** The figure a row fill copies: the cell last focused in that row if it holds one, else the
   * first measured figure across the row — on screen first, then on a model hidden as fully
   * timed — else the first figure of any kind. */
  const rowSource = useCallback((operationId: string): { minutes: number; model: string } | null => {
    const last = lastFocusedRef.current
    if (last && last.operationId === operationId) {
      const v = valueOf(operationId, last.productId)
      const p = columns.find((x) => x.id === last.productId)
      if (v != null && p) return { minutes: v, model: p.model }
    }
    const pool = [...columns, ...filteredProducts.filter((p) => !columns.includes(p))]
    const measured = pool.find((p) => stateOf(operationId, p.id)?.kind === 'measured')
    if (measured) return { minutes: valueOf(operationId, measured.id) as number, model: measured.model }
    const any = pool.find((p) => valueOf(operationId, p.id) != null)
    return any ? { minutes: valueOf(operationId, any.id) as number, model: any.model } : null
  }, [columns, filteredProducts, stateOf, valueOf])

  /** Copy a row across: one operation's figure into every empty cell in range on the row, linked
   * or undecided — the same targets and skips as a column copy. A row is one job's by nature. */
  function fillRow(operationId: string) {
    const src = rowSource(operationId)
    if (!src) return
    setDraftsBulk(fillRange
      .filter((p) => isFillable(operationId, p.id))
      .map((p) => ({ operationId, productId: p.id, minutes: src.minutes })))
  }

  /** Bulk remove: every saved estimate in the ticked rows × ticked models (either alone narrows
   * one axis; the other is everything on screen), marked for removal — still only on Save.
   * stateOf 'estimated' only, so a measured cell can't be swept in. */
  const removableInSelection = useMemo(() => {
    if (selectedOps.size === 0 && selectedTargets.size === 0) return []
    const rows = tickedOps.length > 0 ? tickedOps : visibleOps
    const cols = selectedTargets.size > 0 ? columns.filter((p) => selectedTargets.has(p.id)) : columns
    const out: Draft[] = []
    for (const o of rows) for (const p of cols) {
      const key = operationProductKey(o.id, p.id)
      if (stateOf(o.id, p.id)?.kind === 'estimated' && !drafts.has(key)) out.push({ operationId: o.id, productId: p.id, raw: '', remove: true })
    }
    return out
  }, [selectedOps, selectedTargets, tickedOps, visibleOps, columns, stateOf, drafts])
  function markSelectionForRemoval() {
    if (removableInSelection.length === 0) return
    setDrafts((prev) => {
      const next = new Map(prev)
      for (const d of removableInSelection) next.set(operationProductKey(d.operationId, d.productId), d)
      return next
    })
    setNotice(null)
  }

  // ── What Save would write ────────────────────────────────────────────────────────────────
  const pending = useMemo(() => {
    const writes: EstimateWrite[] = []
    const notApplicable: EstimatePair[] = []
    const removals: EstimateRemoval[] = []
    let invalid = 0
    for (const d of drafts.values()) {
      if (!isEditable(d.operationId, d.productId)) continue
      if (d.remove) {
        // Only a saved estimate can be removed; a mark left on a cell that no longer holds one
        // (a reload since) is nothing to do.
        const state = stateOf(d.operationId, d.productId)
        if (state?.kind === 'estimated') removals.push({ operationId: d.operationId, productId: d.productId, timeId: state.timeId })
        continue
      }
      if (d.raw.trim() === '') continue
      if (isNaText(d.raw)) {
        // Any cell not already decided can be marked — an undecided one included, since recording
        // the decision is the point. One with measured history can't be marked at all: flagged,
        // so it blocks the save.
        if (hasMeasured(d.operationId, d.productId)) invalid += 1
        else if (!isExcluded(d.operationId, d.productId)) notApplicable.push(d)
        continue
      }
      const minutes = parseMinutes(d.raw)
      if (minutes == null) { invalid += 1; continue }
      const state = stateOf(d.operationId, d.productId)
      const existing = state?.kind === 'estimated' ? state : null
      if (existing && Math.abs(existing.minutes - minutes) < 1e-9) continue
      writes.push({
        operationId: d.operationId,
        productId: d.productId,
        minutes,
        existing: existing ? { timeId: existing.timeId, fanOut: existing.fanOut } : null,
        linked: grid?.links.has(operationProductKey(d.operationId, d.productId)) ?? false,
        excluded: isExcluded(d.operationId, d.productId),
      })
    }
    return {
      writes,
      notApplicable,
      removals,
      invalid,
      models: new Set([...writes, ...notApplicable, ...removals].map((w) => w.productId)).size,
      updates: writes.filter((w) => w.existing).length,
      newLinks: writes.filter((w) => !w.linked && !w.excluded).length,
      reopened: writes.filter((w) => w.excluded).length,
      changes: writes.length + notApplicable.length + removals.length,
    }
  }, [drafts, isEditable, isExcluded, hasMeasured, stateOf, grid])

  // Typed work is not lost to a stray reload or a nav click.
  useEffect(() => {
    if (pending.changes === 0) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending.changes])

  async function save() {
    if (pending.changes === 0 || pending.invalid > 0 || saving) return
    const { writes, notApplicable, removals } = pending
    const total = writes.length + notApplicable.length + removals.length
    setSaving({ done: 0, total })
    setNotice(null)
    try {
      // Removals first, on cells no other write touches (a cell holds one draft). Each record and
      // its pair are re-read inside removeEstimates and refused if anything measured is there.
      const rm = await removeEstimates(supabase, removals, userId)
      // Not-applicable first: it is one guarded unlink per model, and it never touches a cell
      // the estimate writes below are about (a cell holds a figure or n/a, not both).
      setSaving({ done: removals.length, total })
      const na = await markNotApplicable(supabase, notApplicable, userId, saveNote)
      const before = removals.length + notApplicable.length
      setSaving({ done: before, total })
      const est = await saveEstimates(supabase, writes, userId, (done) => setSaving({ done: before + done, total }), saveNote)
      const result = {
        saved: est.saved + (notApplicable.length - na.failures.length) + rm.removed,
        failures: [...rm.failures, ...na.failures, ...est.failures],
      }
      const failed = new Set(result.failures.map((f) => operationProductKey(f.operationId, f.productId)))
      // Saved cells leave the drafts (the reload shows them as saved estimates); failed ones stay,
      // typed, so they can be retried.
      setDrafts((prev) => {
        const next = new Map<string, Draft>()
        for (const [k, d] of prev) if (failed.has(k)) next.set(k, d)
        return next
      })
      const noteMiss = est.noteFailures > 0 ? ` The note could not be added to ${plural(est.noteFailures, 'record')}; the figures are saved.` : ''
      if (result.failures.length === 0) {
        // Done: the next job starts clean, with nothing ticked for a bulk action to hit by accident.
        clearTicks()
        setSaveNote('')
        setNotice({
          tone: est.noteFailures > 0 ? 'warn' : 'ok',
          text: [
            writes.length > 0 ? `Saved ${plural(writes.length, 'estimate')}` : '',
            notApplicable.length > 0 ? `marked ${notApplicable.length} not applicable` : '',
            removals.length > 0 ? `removed ${plural(removals.length, 'estimate')}` : '',
          ].filter(Boolean).join(', ').replace(/^./, (c) => c.toUpperCase()) + '.' + noteMiss,
        })
      } else {
        const opName = (id: string) => grid?.operations.find((o) => o.id === id)?.name ?? 'operation'
        const model = (id: string) => products.find((p) => p.id === id)?.model ?? 'model'
        const first = result.failures[0]
        setNotice({
          tone: 'warn',
          text: `Saved ${result.saved} of ${total}. ${plural(result.failures.length, 'cell')} could not be saved and ` +
            `${result.failures.length === 1 ? 'is' : 'are'} still typed in — e.g. ${opName(first.operationId)} on ${model(first.productId)}: ${first.message}` + noteMiss,
        })
      }
    } catch (err) {
      setNotice({ tone: 'warn', text: err instanceof Error ? err.message : 'Could not save' })
    } finally {
      setSaving(null)
      setReloadTick((t) => t + 1)
    }
  }

  // ── Column totals: the whole job, not just the rows on screen ────────────────────────────
  // Over EVERY operation, so a measured column's total is that model's job figure — the same
  // number its Labour Matrix cell shows — and stays the anchor whatever "hide fully timed" hides.
  // "Applies" is linked or timed, plus an unlinked cell somebody has just typed a figure into;
  // a cell marked n/a drops out.
  // Keyed `${jobId}|${productId}` — each stacked job carries its own total.
  const totals = useMemo(() => {
    const out = new Map<string, { minutes: number; filled: number; applies: number; estimated: boolean }>()
    if (!grid) return out
    for (const job of viewJobs) for (const p of columns) {
      let minutes = 0, filled = 0, applies = 0, estimated = false
      for (const o of allOps) {
        if (o.job_id !== job.id) continue
        const state = stateOf(o.id, p.id)
        if (isMarkedNa(o.id, p.id)) continue
        const v = valueOf(o.id, p.id)
        if (isExcluded(o.id, p.id) && v == null) continue
        if (!state && !isLinked(o.id, p.id) && v == null) continue
        applies += 1
        if (v == null) continue
        minutes += v
        filled += 1
        if (state?.kind !== 'measured') estimated = true
      }
      out.set(`${job.id}|${p.id}`, { minutes, filled, applies, estimated })
    }
    return out
  }, [grid, viewJobs, allOps, columns, stateOf, isLinked, isExcluded, isMarkedNa, valueOf])

  // ── Notes on a figure ────────────────────────────────────────────────────────────────────
  // A note belongs to one recording: the cell whose record carries notes gets an "i", and the
  // popover lists that record's notes. Esc closes it and hands focus back to the icon.
  useEffect(() => {
    if (!notesOpen) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return
        setNotesOpen(null); notesTriggerRef.current?.focus(); return
      }
      if (e.type === 'mousedown' && (e.target as HTMLElement).closest?.('.est-notes-pop, .est-cell-info')) return
      setNotesOpen(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [notesOpen])
  function toggleNotes(operationId: string, productId: string, el: HTMLButtonElement) {
    if (notesOpen?.operationId === operationId && notesOpen.productId === productId) { setNotesOpen(null); return }
    notesTriggerRef.current = el
    const r = el.getBoundingClientRect()
    setNotesOpen({ operationId, productId, top: r.bottom + 6, left: Math.max(8, Math.min(r.right - 360, window.innerWidth - 368)) })
  }
  /** The "i" on a cell whose record has notes. Absolutely placed, so the figure and the column
   * width never move for it. Not offered while the cell holds an unsaved edit — the notes are the
   * saved record's, and the figure on screen no longer is. */
  function noteButton(o: EstimateOperation, p: Product, editing: boolean) {
    const notes = grid?.notes.get(operationProductKey(o.id, p.id))
    if (!notes || editing) return null
    const open = notesOpen?.operationId === o.id && notesOpen.productId === p.id
    return (
      <button
        type="button"
        className={`est-cell-info${open ? ' est-info-on' : ''}`}
        aria-label={`${plural(notes.length, 'note')} on ${o.name} for ${p.model}`}
        aria-expanded={open}
        title={plural(notes.length, 'note') + ' on this recording'}
        onClick={(e) => toggleNotes(o.id, p.id, e.currentTarget)}
      >
        i
      </button>
    )
  }

  // ── One cell, one total row ──────────────────────────────────────────────────────────────
  function renderCell(o: EstimateOperation, p: Product, r: number, c: number) {
    const key = operationProductKey(o.id, p.id)
    const state = stateOf(o.id, p.id)
    if (state?.kind === 'measured') {
      return (
        <td key={p.id} className="est-td est-measured" title={`${o.name} · ${p.model} — measured`}>
          {fmtMinutes(state.minutes)}
          {noteButton(o, p, false)}
        </td>
      )
    }
    const linked = isLinked(o.id, p.id)
    const excluded = isExcluded(o.id, p.id)
    const measuredBefore = hasMeasured(o.id, p.id)
    const draft = drafts.get(key)
    const saved = state?.kind === 'estimated' ? state.minutes : null
    const removing = !!draft?.remove && saved != null
    const markedNa = draft != null && !draft.remove && isNaText(draft.raw)
    const raw = draft && !draft.remove ? draft.raw : saved != null ? String(saved) : ''
    const parsed = raw.trim() === '' || markedNa ? null : parseMinutes(raw)
    // n/a over measured history is refused outright — flagged here, re-checked on save.
    const naBlocked = markedNa && measuredBefore
    const naPending = markedNa && !naBlocked && !excluded
    const invalid = (raw.trim() !== '' && !markedNa && parsed == null) || naBlocked
    const dirty = draft != null && !removing && raw.trim() !== '' && !markedNa && parsed !== saved
    // The stored decision, untouched: struck "n/a", hatched (typing "x" over it is no change).
    const showExcluded = excluded && !dirty && !invalid && (draft == null || markedNa || raw.trim() === '')
    const faint = !dirty && !naPending && !naBlocked && !showExcluded && saved == null && !linked
    const cls = ['est-td', 'est-td-input',
      showExcluded ? 'est-excluded' : '',
      saved != null && !dirty && !markedNa && !removing ? 'est-estimated' : '',
      removing ? 'est-rm-pending' : '',
      faint ? 'est-unlinked' : '',
      dirty ? 'est-dirty' : '',
      dirty && !linked ? 'est-dirty-new' : '',
      naPending ? 'est-na-pending' : '',
      invalid ? 'est-invalid' : ''].filter(Boolean).join(' ')
    const title = removing
      ? `Saved estimate ${fmtMinutes(saved as number)} marked for removal — Save hides it and leaves ${o.name} applying to ${p.model}, with no figure. Esc to undo.`
      : naBlocked
      ? `${o.name} has a measured time recorded against ${p.model}, so it can’t be marked not applicable — Esc to undo`
      : invalid ? 'Not a number of minutes'
        : naPending ? `Marked not applicable — Save records the decision${linked ? ` and removes ${o.name}’s link to ${p.model}` : ''}${saved != null ? ', detaching the saved estimate' : ''}. Esc to undo.`
          : showExcluded ? `Decided not applicable: ${o.name} isn’t done on ${p.model}. Type a figure to overturn that and apply it.`
            : dirty && excluded ? `Saving withdraws the not-applicable decision, links ${o.name} to ${p.model} and records this estimate`
            : dirty && !linked ? `Saving links ${o.name} to ${p.model} (it applies) and records this estimate`
            : saved != null ? `Saved estimate ${fmtMinutes(saved)} — Esc to revert`
              : linked ? `${o.name} applies to ${p.model}, nothing recorded — type an estimate`
                : `Undecided — nobody has said whether ${o.name} is done on ${p.model}. Type a figure to apply it, or × for not applicable.`
    // The × wherever the decision isn't already recorded — and NOT AT ALL over measured history
    // (not even disabled): measured work is proof the operation applies. Typing "x" there is
    // flagged instead, and markNotApplicable refuses the pair regardless.
    const canMarkNa = !excluded && !measuredBefore && !removing
    // The bin: a SAVED ESTIMATE only. Measured cells never reach this code — they return
    // read-only above — so there is no measured cell to draw it on, disabled or otherwise.
    const canRemove = saved != null && !markedNa && (!draft || removing)
    return (
      <td key={p.id} className={cls}>
        <input
          ref={(el) => {
            const k = `${r}:${c}`
            if (el) inputRefs.current.set(k, el)
            else inputRefs.current.delete(k)
          }}
          className="est-input"
          inputMode="decimal"
          aria-label={`${o.name} on ${p.model}, minutes`}
          placeholder={saved != null ? String(saved) : excluded ? NA_TEXT : ''}
          value={raw}
          readOnly={removing}
          onChange={(e) => setDraft(o.id, p.id, e.target.value)}
          onFocus={(e) => { lastFocusedRef.current = { operationId: o.id, productId: p.id }; e.currentTarget.select() }}
          onKeyDown={(e) => onCellKey(e, r, c)}
          title={title}
        />
        {noteButton(o, p, draft != null)}
        {canMarkNa && (
          <button
            type="button"
            className="est-na-btn"
            tabIndex={-1}
            aria-label={markedNa ? 'Undo not applicable' : `Mark ${o.name} not applicable to ${p.model}`}
            title={markedNa ? 'Undo — keep the link' : `Not done on ${p.model} — remove the link on save`}
            // Keep the cell's input focused: the × only shows inside the focused cell.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (markedNa) setDrafts((prev) => { const next = new Map(prev); next.delete(key); return next })
              else setDraft(o.id, p.id, NA_TEXT)
            }}
          >
            {markedNa ? '↺' : '×'}
          </button>
        )}
        {canRemove && (
          <button
            type="button"
            className="est-rm-btn"
            tabIndex={-1}
            aria-label={removing ? 'Undo remove' : `Remove the saved estimate for ${o.name} on ${p.model}`}
            title={removing ? 'Undo — keep the estimate' : 'Remove this estimate on save — the operation still applies, the cell becomes a gap. The record is hidden, not deleted.'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (removing) setDrafts((prev) => { const next = new Map(prev); next.delete(key); return next })
              else { setDrafts((prev) => new Map(prev).set(key, { operationId: o.id, productId: p.id, raw: '', remove: true })); setNotice(null) }
            }}
          >
            {removing ? '↺' : (
              <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.2">
                <path d="M0.5 2h8M3 2V0.8h3V2M1.5 2l.5 7.4h5L7.5 2M3.6 4v3.6M5.4 4v3.6" />
              </svg>
            )}
          </button>
        )}
      </td>
    )
  }

  /** A job's total row: inside its block when jobs are stacked, the sticky footer when one job. */
  function renderTotal(jobId: string, hidden: number, inBlock: boolean) {
    return (
      <tr className={inBlock ? 'est-job-total' : undefined}>
        <th scope="row" className="est-td-op est-tf-label">
          Job total{hidden > 0 ? <span className="est-tf-note">incl. {plural(hidden, 'hidden row')}</span> : null}
        </th>
        {columns.map((p) => {
          const t = totals.get(`${jobId}|${p.id}`)
          if (!t || t.filled === 0) return <td key={p.id} className="est-tf">—</td>
          const complete = t.filled === t.applies
          return (
            <td
              key={p.id}
              className={`est-tf${t.estimated ? ' est-tf-est' : ' est-tf-measured'}`}
              title={`${t.filled} of ${t.applies} operations have a figure${t.estimated ? ' — includes estimates' : ' — all measured'}`}
            >
              {fmtMinutes(t.minutes)}{complete ? '' : '*'}
              <span className="est-tf-count">{t.filled}/{t.applies}</span>
            </td>
          )
        })}
        <td />
      </tr>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────────────────────
  const scope = [activeType, activeSeries].filter(Boolean).join(' · ') || 'All models'

  return (
    <main className="page-wide">
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Estimate</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
          Fill in a job’s times across a range of models from the ones that were measured
        </p>
      </div>

      <div className="card est-controls">
        <select
          style={SEL}
          aria-label="Production line"
          value={lineId}
          onChange={(e) => { if (!confirmDiscard()) return; setLineId(e.target.value); setTeamFilter(''); setSectionId(''); setJobId(''); resetWork() }}
        >
          <option value="">— Production line —</option>
          {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select
          style={SEL}
          aria-label="Team"
          value={activeTeamId}
          disabled={!lineId || lineTeams.length === 0}
          onChange={(e) => {
            if (!confirmDiscard()) return
            const next = e.target.value
            setTeamFilter(next)
            // The section stays if it is the new team's; otherwise it, and its job, are cleared.
            if (next && sections.find((s) => s.id === activeSectionId)?.team_id !== next) { setSectionId(''); setJobId('') }
            resetWork()
          }}
        >
          <option value="">All teams</option>
          {lineTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select
          style={SEL}
          aria-label="Section"
          value={activeSectionId}
          disabled={!lineId}
          onChange={(e) => { if (!confirmDiscard()) return; setSectionId(e.target.value); setJobId(''); resetWork() }}
        >
          <option value="">— Section —</option>
          {sectionOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select
          style={SEL}
          aria-label="Job"
          value={activeJobId}
          disabled={!activeSectionId}
          onChange={(e) => { if (!confirmDiscard()) return; setJobId(e.target.value); resetWork() }}
        >
          <option value="">All jobs in the section</option>
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
        </select>

        <span className="est-controls-sep" aria-hidden />

        {buildLineOptions.length > 1 && (
          <select style={SEL} aria-label="Build line" value={activeBuildLine} disabled={!grid}
            onChange={(e) => { setBuildLineFilter(e.target.value); setTypeFilter(''); setSeriesFilter(''); clearTicks() }}>
            <option value="">All build lines</option>
            {buildLineOptions.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        <select style={SEL} aria-label="Product type" value={activeType} disabled={!grid}
          onChange={(e) => { setTypeFilter(e.target.value); setSeriesFilter(''); clearTicks() }}>
          <option value="">All types</option>
          {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select style={SEL} aria-label="Series" value={activeSeries} disabled={!grid}
          onChange={(e) => { setSeriesFilter(e.target.value); clearTicks() }}>
          <option value="">All series</option>
          {seriesOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label className="lm-future" title="Hide a model only when every operation on screen that applies to it has a counted time and none of them is measured. A partly timed model stays, and so does any model with a measured time. Rows hide only when every model on screen is timed for them.">
          <input type="checkbox" checked={hideFullyTimed} onChange={(e) => { setHideTimedRaw(e.target.checked ? '1' : '0'); clearTicks() }} />
          Hide fully timed
        </label>
      </div>

      {error && <div className="est-notice est-notice-warn">{error}</div>}

      {!lineId ? (
        <p style={EMPTY}>Select a production line, then a section</p>
      ) : !activeSectionId ? (
        <p style={EMPTY}>Select a section — leave Job unset to work down every job in it</p>
      ) : !jobsReady ? (
        <p style={EMPTY}>Reading the section’s jobs…</p>
      ) : viewJobs.length === 0 ? (
        <p style={EMPTY}>This section has no active jobs.</p>
      ) : loading && !grid ? (
        <p style={EMPTY}>Reading the operations, models and recorded times…</p>
      ) : !grid ? null : allOps.length === 0 ? (
        <p style={EMPTY}>{activeJobId ? 'This job has' : 'The jobs in this section have'} no operations.</p>
      ) : columns.length === 0 || visibleOps.length === 0 ? (
        <p style={EMPTY}>
          {hideFullyTimed && filteredProducts.length > 0
            ? <>Every model in {scope} is fully timed here. Untick <strong>Hide fully timed</strong> to see and edit the saved estimates.</>
            : <>No models in {scope}.</>}
        </p>
      ) : (
        <>
          <div className="est-summary">
            <strong>{activeJobId ? jobName : `${sections.find((s) => s.id === activeSectionId)?.name ?? 'Section'} · all jobs`}</strong>
            {!activeJobId && <span>{plural(blocks.length, 'job')}{viewJobs.length > blocks.length ? ` (${viewJobs.length - blocks.length} with every row hidden)` : ''}</span>}
            <span>{scope} · {plural(columns.length, 'model')}{hiddenModelCount > 0 ? ` (${hiddenModelCount} fully timed, hidden)` : ''}</span>
            <span>{plural(visibleOps.length, 'operation')}{hiddenOpCount > 0 ? ` (${hiddenOpCount} timed on every model shown, hidden)` : ''}</span>
          </div>

          <div className="card est-tools">
            <span className="est-tools-label">Copy column</span>
            <select style={{ ...SEL, minWidth: 140 }} aria-label="Copy from model" value={activeSource} onChange={(e) => setCopySource(e.target.value)}>
              <option value="">— from model —</option>
              {sourceOptions.map((s) => (
                <option key={s.product.id} value={s.product.id}>
                  {s.product.model}{s.measured > 0 ? ` · ${s.measured} measured` : ' · estimates'}{columns.includes(s.product) ? '' : ' · hidden (fully timed)'}
                </option>
              ))}
            </select>
            <label className="est-factor">
              ×
              <input
                className="est-factor-input"
                inputMode="decimal"
                aria-label="Factor"
                value={factorRaw}
                onChange={(e) => setFactorRaw(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
            <span className="est-tools-to">
              → {selectedOnScreen.length > 0
                ? <><strong>{plural(selectedOnScreen.length, 'ticked model')}</strong> ({fillTargets.length} with empty cells)</>
                : <><strong>every model on screen</strong> ({fillTargets.length} with empty cells)</>}
              {tickedOps.length > 0 && <>, <strong>{plural(tickedOps.length, 'ticked row')}</strong> only</>}
            </span>
            {blocks.length > 1 && (
              <label className="est-tools-job">
                in
                <select
                  style={{ ...SEL, minWidth: 160 }}
                  aria-label="Copy within job"
                  value={copyJob}
                  disabled={tickedJobIds.length > 0}
                  title={tickedJobIds.length > 0 ? 'Set by the ticked rows' : 'Bulk actions work within one job'}
                  onChange={(e) => setCopyJobId(e.target.value)}
                >
                  <option value="">— job —</option>
                  {blocks.map((b) => <option key={b.job.id} value={b.job.id}>{b.job.name}</option>)}
                </select>
              </label>
            )}
            {(copyBlocked || selectedTargets.size > 0 || selectedOps.size > 0) && (
              <div className="est-tools-apply">
                {copyBlocked && <span className="est-tools-warn">Rows are ticked in more than one job — bulk actions work within one job.</span>}
                {(selectedTargets.size > 0 || selectedOps.size > 0) && (
                  <span className="est-tick-count">
                    {[selectedTargets.size > 0 ? plural(selectedTargets.size, 'model') : '', selectedOps.size > 0 ? plural(selectedOps.size, 'operation') : ''].filter(Boolean).join(' and ')} ticked
                    <button type="button" className="est-link" onClick={clearTicks}>Clear selection</button>
                    {removableInSelection.length > 0 && (
                      <button
                        type="button"
                        className="est-link est-link-rm"
                        title="Marks them for removal — nothing changes until Save estimates. Measured times are never included."
                        onClick={markSelectionForRemoval}
                      >
                        Remove {plural(removableInSelection.length, 'saved estimate')} in selection…
                      </button>
                    )}
                  </span>
                )}
              </div>
            )}
            <span className="est-tools-hint">
              Set up a copy here, then <strong>Apply copy</strong> in the bar below — it shows what will be written and saves only when you confirm · Copy column and <strong>Fill →</strong> write into every empty cell, undecided ones included — skipping measured and not-applicable cells · tick model headings, a series, or operation rows to narrow them · ⇥ / arrows / Enter move · Esc reverts a cell ·
              {' '}<strong>×</strong> in the focused cell (or typing <strong>x</strong>) marks it not applicable
              {' '}· the <strong>bin</strong> on a saved estimate removes its figure, keeping the work applying
            </span>
          </div>

          <div className="est-legend">
            <span><span className="est-swatch est-measured" />Measured — the evidence, read-only</span>
            <span><span className="est-swatch est-estimated" />Saved estimate — editable</span>
            <span><span className="est-swatch" />Applies, nothing recorded — a gap to fill</span>
            <span><span className="est-swatch est-unlinked" />Undecided — not linked, nobody has said; type a figure to apply it</span>
            <span><span className="est-swatch est-excluded" />Decided not applicable — kept; type a figure to overturn it</span>
            <span><span className="est-swatch est-dirty" />Typed, not saved</span>
            <span><span className="est-swatch est-dirty est-dirty-new" />Typed into an unlinked cell — saving also links it</span>
            <span><span className="est-swatch est-na-pending" />Marked not applicable, not saved yet</span>
            <span><span className="est-swatch est-rm-pending" />Saved estimate marked for removal, not saved yet — the work still applies</span>
            <span><span className="est-cell-info est-info-legend" aria-hidden>i</span>Notes on that recording — click to read</span>
          </div>

          <div className="est-scroll">
            <table className="est-table">
              <thead>
                <tr>
                  <th className="est-th-corner" rowSpan={2}>Operation</th>
                  {groups.flatMap((g) => g.series.map((s) => {
                    const ids = s.products.map((p) => p.id)
                    const n = ids.filter((id) => selectedTargets.has(id)).length
                    const label = g.series.length > 1 || groups.length > 1 ? `${g.label} · ${s.label}` : s.label
                    return (
                      <th key={`${g.key}|${s.key}`} className="est-th-group" colSpan={s.products.length}>
                        <label className="est-group-tick" title={`Select every ${s.label} model on screen`}>
                          <input
                            type="checkbox"
                            aria-label={`Select all ${label}`}
                            checked={n === ids.length}
                            ref={(el) => { if (el) el.indeterminate = n > 0 && n < ids.length }}
                            onChange={() => setSelectedTargets((prev) => {
                              const next = new Set(prev)
                              if (n === ids.length) for (const id of ids) next.delete(id)
                              else for (const id of ids) next.add(id)
                              return next
                            })}
                          />
                          {label}
                        </label>
                      </th>
                    )
                  }))}
                  <th className="est-th-action" rowSpan={2} />
                </tr>
                <tr>
                  {columns.map((p) => {
                    const evidence = visibleOps.some((o) => stateOf(o.id, p.id)?.kind === 'measured')
                    const ticked = selectedTargets.has(p.id)
                    return (
                      <th key={p.id} className={`est-th-model${evidence ? ' est-th-evidence' : ''}${ticked ? ' est-th-selected' : ''}`}>
                        <label title={evidence ? `${p.model} has measured times` : `Select ${p.model} as a copy target`}>
                          <input
                            type="checkbox"
                            checked={ticked}
                            onChange={() => setSelectedTargets((prev) => {
                              const next = new Set(prev)
                              if (next.has(p.id)) next.delete(p.id)
                              else next.add(p.id)
                              return next
                            })}
                          />
                          <span>{p.model}</span>
                        </label>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              {blocks.map((block) => (
                <tbody key={block.job.id}>
                  {blocks.length > 1 && (
                    <tr className="est-job-head">
                      <th scope="rowgroup" className="est-td-op est-job-name" title={block.job.name}>{block.job.name}</th>
                      <td colSpan={columns.length + 1} />
                    </tr>
                  )}
                  {block.ops.map((o) => {
                    const r = visibleOps.indexOf(o)
                    const src = rowSource(o.id)
                    const rowHasEmpty = fillRange.some((p) => isFillable(o.id, p.id))
                    const rowTicked = selectedOps.has(o.id)
                    // With rows ticked, Fill → stays with them.
                    const rowOutOfScope = tickedOps.length > 0 && !rowTicked
                    return (
                      <tr key={o.id} className={rowTicked ? 'est-row-selected' : undefined}>
                        <th scope="row" className="est-td-op" title={o.name}>
                          <label className="est-op-label">
                            <input
                              type="checkbox"
                              aria-label={`Select ${o.name}`}
                              checked={rowTicked}
                              onChange={() => setSelectedOps((prev) => {
                                const next = new Set(prev)
                                if (next.has(o.id)) next.delete(o.id)
                                else next.add(o.id)
                                return next
                              })}
                            />
                            <span>{o.name}</span>
                          </label>
                        </th>
                        {columns.map((p, c) => renderCell(o, p, r, c))}
                        <td className="est-td-action">
                          <button
                            type="button"
                            className="est-link"
                            tabIndex={-1}
                            disabled={!src || !rowHasEmpty || rowOutOfScope}
                            title={rowOutOfScope ? 'Other rows are ticked — bulk actions apply to those'
                              : src ? `Fill every empty cell in this row with ${fmtMinutes(src.minutes)} (from ${src.model})` : 'Nothing in this row to copy'}
                            onClick={() => fillRow(o.id)}
                          >
                            Fill →
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                  {blocks.length > 1 && renderTotal(block.job.id, block.hidden, true)}
                </tbody>
              ))}
              {blocks.length === 1 && <tfoot>{renderTotal(blocks[0].job.id, hiddenOpCount, false)}</tfoot>}
            </table>
          </div>

          {notesOpen && (() => {
            const o = grid.operations.find((x) => x.id === notesOpen.operationId)
            const p = columns.find((x) => x.id === notesOpen.productId)
            const list = grid.notes.get(operationProductKey(notesOpen.operationId, notesOpen.productId))
            if (!o || !p || !list) return null
            const kind = stateOf(o.id, p.id)?.kind
            const rec = grid.records.get(operationProductKey(o.id, p.id))
            // collected_by is only worth a line when it isn't simply the operator timing themselves.
            const showCollector = rec?.collector != null && rec.collector.toLowerCase() !== rec.operator?.toLowerCase()
            return (
              <div className="est-notes-pop" role="dialog" aria-label={`Notes on ${o.name} for ${p.model}`} style={{ top: notesOpen.top, left: notesOpen.left }}>
                <div className="est-notes-head">
                  <div>
                    <strong>{o.name}</strong>
                    <div className="est-notes-sub">
                      {p.model}
                      {kind && <span className={`est-notes-kind est-notes-${kind}`}>{kind === 'measured' ? 'Measured' : 'Estimate'}</span>}
                    </div>
                  </div>
                  <button type="button" className="est-notes-close" aria-label="Close" onClick={() => { setNotesOpen(null); notesTriggerRef.current?.focus() }}>×</button>
                </div>
                {/* Who was timed, on which van — the pair that makes the figure interpretable. */}
                {rec && (
                  <div className="est-notes-who">
                    {kind === 'estimated' ? (
                      <div className="est-notes-who-name">Estimate — no operator was timed</div>
                    ) : (
                      <>
                        <div className="est-notes-who-label">Operator timed</div>
                        <div className={`est-notes-who-name${rec.operator ? '' : ' est-notes-who-none'}`}>{rec.operator ?? 'Operator not recorded'}</div>
                      </>
                    )}
                    {(showCollector || rec.chassis) && (
                      <div className="est-notes-who-meta">
                        {showCollector && <span>{kind === 'estimated' ? 'Entered by' : 'Stopwatch run by'} {rec.collector}</span>}
                        {rec.chassis && <span>Chassis {rec.chassis}</span>}
                      </div>
                    )}
                  </div>
                )}
                <ul className="est-notes-list">
                  {list.map((n, i) => (
                    <li key={i}>
                      <p>{n.content}</p>
                      <div className="est-notes-meta">{n.author ?? 'Unknown'} · {fmtDateTime(n.createdAt)}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })()}

          {copyPlan && (() => {
            const pl = copyPlan
            const { skipped: sk, sourceKinds: sc } = pl
            const nothing = pl.writes.length === 0
            const why = pl.rows.length === 0 ? `${pl.sourceModel} has no figure in the rows being copied`
              : 'Every cell in range is measured, not applicable, or already has a figure'
            const kinds = [
              sc.measured > 0 ? `${sc.measured} measured` : '',
              sc.estimated > 0 ? `${sc.estimated} saved ${sc.estimated === 1 ? 'estimate' : 'estimates'}` : '',
              sc.typed > 0 ? `${sc.typed} typed and not saved` : '',
            ].filter(Boolean)
            const close = () => { if (!saving) setCopyPlan(null) }
            return (
              <Modal
                title={nothing ? `Copy from ${pl.sourceModel}` : `Copy ${pl.sourceModel} into ${plural(pl.targets.length, 'model')}`}
                onClose={close}
                maxWidth={620}
                footer={<>
                  {saving && <span className="est-copy-progress">Saving {saving.done} / {saving.total}…</span>}
                  <button type="button" className="btn-ghost" disabled={!!saving} onClick={close}>Cancel</button>
                  <span title={nothing ? `Nothing to write — ${why.charAt(0).toLowerCase()}${why.slice(1)}.` : undefined}>
                    <button type="button" className="btn-primary" disabled={nothing || !!saving} onClick={saveCopy}>
                      {saving ? 'Saving…' : nothing ? 'Save' : `Save ${plural(pl.writes.length, 'estimate')}`}
                    </button>
                  </span>
                </>}
              >
                <div className="est-copy">
                  <p className="est-copy-source">
                    From <strong>{pl.sourceModel}</strong>
                    {kinds.length > 0 && <> — {sc.measured > 0 && kinds.length === 1 ? 'measured' : kinds.join(', ')}</>}
                    {pl.factor !== 1 && <>, scaled <strong>× {pl.factor}</strong></>}
                  </p>
                  {sc.typed > 0 && (
                    <p className="est-copy-warn">
                      {plural(sc.typed, 'figure')} on {pl.sourceModel} {sc.typed === 1 ? 'is' : 'are'} typed but not saved. The copies are saved now; {pl.sourceModel}{'’'}s own {sc.typed === 1 ? 'figure stays' : 'figures stay'} unsaved until Save estimates.
                    </p>
                  )}

                  {!nothing && <>
                    <div className="est-copy-label">To {plural(pl.targets.length, 'model')}</div>
                    <p className="est-copy-models">{pl.targets.map((t) => t.model).join(', ')}</p>

                    <div className="est-copy-label">What will be written</div>
                    <table className="est-copy-rows">
                      <tbody>
                        {pl.rows.map((r) => (
                          <tr key={r.operationId} className={r.models === 0 ? 'est-copy-row-none' : undefined}>
                            <td>{r.name}</td>
                            <td className="est-copy-min">{fmtMinutes(r.minutes)}</td>
                            <td className="est-copy-arrow">→</td>
                            <td className="est-copy-n">{r.models === 0 ? 'nothing to fill' : plural(r.models, 'model')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="est-copy-total">{plural(pl.writes.length, 'estimate')} across {plural(pl.targets.length, 'model')}</p>

                    {pl.newLinks > 0 && (
                      <p className="est-copy-links">
                        <strong>{pl.newLinks}</strong> will apply this work to a model for the first time
                        <span> — {pl.newLinks === 1 ? 'that operation isn\u2019t' : 'those operations aren\u2019t'} linked to {pl.newLinks === 1 ? 'that model' : 'those models'} yet, and saving links {pl.newLinks === 1 ? 'it' : 'them'}.</span>
                      </p>
                    )}
                  </>}
                  {nothing && <p className="est-copy-warn">Nothing to write — {why.charAt(0).toLowerCase()}{why.slice(1)}.</p>}

                  {(sk.measured + sk.notApplicable + sk.filled + sk.noSource > 0 || pl.targets.length < pl.rangeCount) && (
                    <>
                      <div className="est-copy-label">Skipped</div>
                      <ul className="est-copy-skips">
                        {sk.measured > 0 && <li>{plural(sk.measured, 'cell')} already measured — never overwritten</li>}
                        {sk.notApplicable > 0 && <li>{plural(sk.notApplicable, 'cell')} marked not applicable</li>}
                        {sk.filled > 0 && <li>{plural(sk.filled, 'cell')} already holding a figure (saved, typed, or marked for removal)</li>}
                        {sk.noSource > 0 && <li>{plural(sk.noSource, 'operation')} with no figure on {pl.sourceModel}</li>}
                        {pl.targets.length < pl.rangeCount && <li>{plural(pl.rangeCount - pl.targets.length, 'model')} in range receive nothing</li>}
                      </ul>
                    </>
                  )}

                  <label className="est-copy-label" htmlFor="est-copy-note">Why this copy (optional)</label>
                  <textarea
                    id="est-copy-note"
                    className="est-copy-note"
                    rows={2}
                    maxLength={500}
                    placeholder="e.g. scaled from 88A, same floor plan"
                    value={copyNote}
                    disabled={!!saving}
                    onChange={(e) => setCopyNote(e.target.value)}
                  />
                  <div className="est-copy-hint">Kept on every record this copy writes.</div>
                </div>
              </Modal>
            )
          })()}

          <div className={`est-savebar${pending.changes > 0 || pending.invalid > 0 ? ' est-savebar-on' : ''}`}>
            <span className="est-savebar-count">
              {saving
                ? <>Saving {saving.done} / {saving.total}…</>
                : pending.changes === 0
                  ? 'No unsaved changes'
                  : <>
                    {pending.writes.length > 0 && <>
                      <strong>{plural(pending.writes.length, 'estimate')}</strong>
                      {pending.updates > 0 || pending.reopened > 0
                        ? ` (${[pending.updates > 0 ? `${pending.updates} updating a saved one` : '', pending.reopened > 0 ? `${pending.reopened} overturning a not-applicable decision` : ''].filter(Boolean).join(', ')})`
                        : ''}
                    </>}
                    {pending.writes.length > 0 && pending.notApplicable.length > 0 && ' · '}
                    {pending.notApplicable.length > 0 && <><strong>{pending.notApplicable.length}</strong> marked not applicable</>}
                    {pending.removals.length > 0 && pending.writes.length + pending.notApplicable.length > 0 && ' · '}
                    {pending.removals.length > 0 && <span className="est-savebar-rm"><strong>{pending.removals.length}</strong> removed</span>}
                    {' '}across <strong>{plural(pending.models, 'model')}</strong>
                    {/* The number to stop and look at: a bulk fill into undecided cells asserts the
                        work applies to those models, and saving creates each link. */}
                    {pending.newLinks > 0 && (
                      <span className="est-savebar-links">
                        {' · '}<strong>{pending.newLinks}</strong> will apply this work to a model for the first time
                      </span>
                    )}
                  </>}
              {pending.invalid > 0 && <span className="est-savebar-invalid"> · {plural(pending.invalid, 'cell')} can’t be saved as typed — hover for why, or Esc to revert</span>}
            </span>
            {notice && <span className={`est-notice est-notice-${notice.tone}`}>{notice.text}</span>}
            {pending.changes > 0 && (
              <input
                className="est-savebar-note"
                aria-label="Note for this save"
                placeholder="Note for this save (optional) — e.g. scaled from 88A, same floor plan"
                value={saveNote}
                maxLength={500}
                disabled={!!saving}
                onChange={(e) => setSaveNote(e.target.value)}
                title="Kept on every record this save writes, so the reasoning is there when the figures are questioned"
              />
            )}
            {/* Apply copy opens its own confirm-and-save dialog; Save estimates writes the typed
                cells. Set apart, and secondary, so the two never read as a pair of equal buttons. */}
            <span className="est-savebar-apply">
              <button
                type="button"
                className="btn-ghost est-btn"
                disabled={!activeSource || factor == null || !copyJob || copyBlocked || !!saving}
                title={!activeSource ? 'Choose a model to copy from, at the top'
                  : copyBlocked ? 'The ticked rows are in more than one job — bulk actions work within one job'
                    : !copyJob ? 'Choose the job to copy within, at the top'
                      : `Review copying ${filteredProducts.find((x) => x.id === activeSource)?.model ?? ''}${factor != null && factor !== 1 ? ` × ${factor}` : ''} into empty cells — nothing is saved until you confirm`}
                onClick={openCopy}
              >
                Apply copy
              </button>
            </span>
            <span className="est-savebar-save">
              <button type="button" className="btn-ghost" disabled={drafts.size === 0 || !!saving} onClick={() => { if (confirmDiscard()) { setDrafts(new Map()); setNotice(null) } }}>
                Discard
              </button>
              <button type="button" className="btn-primary" disabled={pending.changes === 0 || pending.invalid > 0 || !!saving} onClick={save}>
                {saving ? 'Saving…' : 'Save estimates'}
              </button>
            </span>
          </div>
        </>
      )}

      <p className="est-foot">
        Each saved cell is one recorded time marked as estimated, with no start or finish. It counts
        toward labour exactly as a measured time does; a measured time recorded later replaces it.{' '}
        <Link href="/labour-matrix" className="est-link">Labour Matrix →</Link>
      </p>
    </main>
  )
}

