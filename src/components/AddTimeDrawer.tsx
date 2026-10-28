'use client'

import InfoPopover from '@/components/InfoPopover'
import SelectAllControl from '@/components/SelectAllControl'
import { type TimeParentFlags } from '@/lib/operationTimes'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Modal from './Modal'
import OperatorSelect from './OperatorSelect'
import { ModelSeriesPicker } from './ModelLinker'
import { createClient } from '@/lib/supabase/client'
import { fetchAllChunked, READ_CHUNK, type RangeableQuery } from '@/lib/supabaseRead'
import {
  JOB_PARENT_CHAIN, OPERATION_PARENT_CHAIN, isLiveJob, isLiveOperation,
  type JobLiveChain, type OperationLiveChain,
} from '@/lib/liveStructure'
import { fetchSectionsForLine } from '@/lib/sections'
import { createJob } from '@/lib/jobs'
import { createOperations, parseOperationNames } from '@/lib/operations'
import { modelsForLine } from '@/lib/lines'
import { fetchLinksForOperations, linkOperationsToModels } from '@/lib/modelOperations'
import {
  TIME_FLAG_COLUMNS, addOperationTimeNote, countsTowardLabour, currentForOperation, onlyCountedTimes,
  operationProductKey, recordOperationTime,
} from '@/lib/operationTimes'
import { fetchOperators, operatorsForLine, type OperatorOption } from '@/lib/operators'
import { buildReportHref } from '@/lib/reports'
import { plural } from '@/lib/format'
import type { Operation, Product, ProductionLine, Section } from '@/lib/types'

/**
 * Add Time — the one way to enter a time that was collected on paper.
 *
 * /collect and /tryouts both assume a live stopwatch: you press start, you press stop, and the
 * clock is the measurement. Neither has any way to type in a figure somebody wrote on a form an
 * hour ago, which is how most of this work is actually recorded. This is that path.
 *
 * ── One implementation, deliberately ──────────────────────────────────────────────────────
 * This component IS the add-a-time flow for the whole app. /model-total used to carry its own
 * private version — a slide-over with one operation, one minutes box and a mandatory operator —
 * and it is gone; that screen now opens this, pre-filled with its model. Anything else that
 * grows an "add a time" affordance opens this too, with whatever context it already knows. The
 * props exist so a caller can hand over what it knows and lock it, NOT so a caller can build a
 * different flow.
 *
 * ── The shape mirrors the paper form ──────────────────────────────────────────────────────
 * Step 4 is the reason for the whole design: a job's operations listed down the page with a
 * minutes box beside each one, which is what the time-study sheet looks like. A blank box means
 * "not collected" and writes nothing. That is why this is a four-step wizard rather than a
 * single form — the batch is per JOB, and the job has to be settled before the list exists.
 *
 * ── Every write goes through the existing single-writer helpers ───────────────────────────
 * recordOperationTime for the times (never a direct insert into operation_times — it is what
 * derives team/line provenance from the job and applies the save-time guards),
 * addOperationTimeNote for notes, createJob / createOperations for the structure
 * created along the way. Nothing here writes a table directly.
 */

/** Which context a caller handed over, and therefore which fields open locked. */
export interface AddTimeDrawerProps {
  productionLineId?: string
  teamId?: string
  sectionId?: string
  jobId?: string
  /** Pre-ticked models. /model-total passes the model in view. */
  productIds?: string[]
  /**
   * Closed. Carries what was written when anything was, so a host can refresh its own figures —
   * null when the drawer was dismissed without saving.
   */
  onDone: (result: AddTimeResult | null) => void
}

/** What this submit did to ONE model's applies-list. Reported per model because the two cases
 * behave completely differently — see ApplicabilityPlan. */
export interface ModelApplicabilityOutcome {
  productId: string
  model: string
  /** The job already applied to this model before the submit. */
  alreadyApplied: boolean
  /** model_operations rows the database confirmed for it — the read-back count from
   * linkOperationsToModels, not the size of the plan. */
  linked: number
  /** Operations linked ONLY because a time was entered against them (the case-b exception). */
  timedAdditions: string[]
  /**
   * Its applies-list write failed, so NO times were recorded against it and it is unchanged
   * beyond whatever links happened to land (which are correct — the upsert is idempotent). The
   * same guard as the copy panel's: writing the times anyway is what produces a recorded time for
   * a pair the model is not recorded as doing.
   */
  skippedForLinkFailure: boolean
  /** Why, when skipped. */
  linkError: string | null
}

export interface AddTimeResult {
  jobId: string
  jobName: string
  lineId: string
  /** operation_times rows actually created. */
  created: number
  totalMinutes: number
  modelCount: number
  notesWritten: number
  applicability: ModelApplicabilityOutcome[]
  /** Per-operation failures, reported rather than swallowed — the batch is not transactional. */
  failures: string[]
  /** Every selected model's link failed, so nothing at all was written. Distinct from a save that
   * ran with some failures: this one did not run. */
  nothingSaved: boolean
}

type Step = 1 | 2 | 3 | 4
const STEP_TITLES: Record<Step, string> = {
  1: 'Where was this collected?',
  2: 'Which job?',
  3: 'Which models?',
  4: 'Operations and minutes',
}

/** Which pre-filled fields the user has explicitly unlocked with "change". */
type LockKey = 'line' | 'team' | 'section' | 'job'

const SEL: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
  border: '1.5px solid var(--border)', borderRadius: 8, padding: '7px 10px',
  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', outline: 'none', width: '100%',
}
const LABEL: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 6,
}
const ERR_BOX: React.CSSProperties = {
  padding: '9px 12px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 12, margin: 0,
}
const WARN_BOX: React.CSSProperties = {
  padding: '9px 12px', borderRadius: 8, background: 'var(--amber-bg)',
  border: '1px solid #fcd34d', color: '#92400e', fontSize: 12, lineHeight: 1.55,
}
const OK_BOX: React.CSSProperties = {
  padding: '12px 14px', borderRadius: 8, background: 'var(--green-bg)',
  border: '1px solid #bbf7d0', color: '#15803d', fontSize: 13,
}
/* The step's content. It used to cap itself at 58vh and scroll inside the modal, which was two
 * problems: vh ignores a tablet browser's chrome, so the "58%" was of a taller box than the one
 * actually on screen, and the card around it was unbounded, so header + 58vh + footer could
 * still add up to more than the viewport and carry Save off the bottom. Scrolling is now the
 * modal body's job — bounded in dvh, with the Next/Save footer pinned outside it — and this is
 * plain flow content. */
const BODY: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 16,
}
const LINK_BTN: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--blue)', background: 'none',
  border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0,
}

/** "147" / "147.5" — a whole number of minutes shouldn't print a pointless .0 on a result line. */
function fmtTotal(minutes: number): string {
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1)
}

/**
 * A select with a search box over it — the same shape OperatorSelect uses for operators, made
 * generic here so the line, team, section and job pickers all narrow the same way rather than
 * being four bare <select>s (a line with sixty jobs is not pickable from a dropdown).
 *
 * The selected option is always kept in the list even when the search hides it: a <select> whose
 * value has no matching <option> silently displays the first one instead.
 */
function SearchSelect({
  options, value, onChange, placeholder, emptyLabel, disabled, searchable = true,
}: {
  options: { id: string; label: string }[]
  value: string
  onChange: (id: string) => void
  placeholder: string
  emptyLabel: string
  disabled?: boolean
  searchable?: boolean
}) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, query])
  const shown = useMemo(() => {
    const selected = options.find((o) => o.id === value)
    if (!selected || matches.some((o) => o.id === selected.id)) return matches
    return [selected, ...matches]
  }, [options, matches, value])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {searchable && options.length > 8 && (
        <input
          type="search" className="input"
          style={{ width: '100%', fontSize: 12, padding: '6px 9px' }}
          placeholder={placeholder}
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
        />
      )}
      <select style={SEL} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{emptyLabel}</option>
        {shown.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </div>
  )
}

/** A pre-filled value the caller locked, with the escape hatch beside it. */
function LockedChip({ label, value, onChange }: { label: string; value: string; onChange: () => void }) {
  return (
    <div>
      <span style={LABEL}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="badge badge-blue" style={{ fontSize: 12 }}>{value}</span>
        <button type="button" style={LINK_BTN} onClick={onChange}>change</button>
      </div>
    </div>
  )
}

export default function AddTimeDrawer({
  productionLineId, teamId, sectionId, jobId, productIds, onDone,
}: AddTimeDrawerProps) {
  const supabase = useMemo(() => createClient(), [])

  const [step, setStep] = useState<Step>(1)
  const [error, setError] = useState<string | null>(null)

  // Who is recording. Read here rather than taken as a prop: this opens from the nav on every
  // page, and threading a userId through every host just to reach recordOperationTime's
  // collectedBy would be five more places to forget.
  const [userId, setUserId] = useState<string | null>(null)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null))
  }, [supabase])

  // ── Selection ──
  const [lineId, setLineId] = useState(productionLineId ?? '')
  const [team, setTeam] = useState(teamId ?? '')
  const [section, setSection] = useState(sectionId ?? '')
  const [job, setJob] = useState(jobId ?? '')
  const [unlocked, setUnlocked] = useState<Set<LockKey>>(new Set())
  const isLocked = useCallback(
    (key: LockKey, provided: string | undefined) => !!provided && !unlocked.has(key),
    [unlocked]
  )
  function unlock(key: LockKey) { setUnlocked((prev) => new Set(prev).add(key)) }

  // ── Options ──
  const [lines, setLines] = useState<ProductionLine[]>([])
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([])
  const [sections, setSections] = useState<Section[]>([])
  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([])
  const [operations, setOperations] = useState<Operation[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [operators, setOperators] = useState<OperatorOption[]>([])
  /** Models that already have a recorded time somewhere under this job — everything else is a
   * gap, and gaps sort to the top (see sortByGapFirst). */
  const [timedProductIds, setTimedProductIds] = useState<Set<string>>(new Set())
  /** Recorded labour for this job, per model — the figure the "47m recorded" badge shows. Summed
   * from the CURRENT record per (operation, model) pair via the shared currentForOperation, so it
   * is the same rule /model-total's total uses rather than a second definition of "recorded". */
  const [recordedMinutes, setRecordedMinutes] = useState<Map<string, number>>(new Map())

  // ── Time entry (step 4) ──
  const [minutesByOperation, setMinutesByOperation] = useState<Record<string, string>>({})
  /**
   * Operations ticked FOR TIME ENTRY — which ones a duration is being recorded against right now.
   * Opens empty. It is not applicability and never becomes it: an operation can apply and have
   * no time (that is what a gap is), so ticking one here links nothing and unticking unlinks
   * nothing.
   *
   * The drawer deals with two tables that mean different things, and keeps them apart:
   *   model_operations       "this operation is required for this model" — what coverage and the
   *                          gap report read. Written ONLY by the apply prompt (applyJob) and by
   *                          the explicit "link and save" answer to the unlinked-time warning.
   *   operation_time_models  "this run counts for these models" — written by recordOperationTime.
   */
  const [timeTicks, setTimeTicks] = useState<Set<string>>(new Set())
  /** The apply prompt: open when set. `choosing` is the "Choose which apply" list, `picked` its ticks. */
  const [applyPrompt, setApplyPrompt] = useState<{ choosing: boolean; picked: Set<string> } | null>(null)
  const [applying, setApplying] = useState(false)
  /** `job|model` pairs the prompt has been answered for — linked, partly linked or left as is.
   * Lives as long as the drawer is open, which is the session "don't ask again" means. */
  const [answered, setAnswered] = useState<Set<string>>(new Set())
  /** The Save-time warning that a timed operation doesn't apply to a selected model. */
  const [unlinkedConfirm, setUnlinkedConfirm] = useState(false)
  /** Bumped to re-read the applies-list after a write that may have landed only partly. */
  const [linksVersion, setLinksVersion] = useState(0)
  /** Existing model_operations rows for this job's operations, keyed product → operation ids.
   * Read before the write so case (b) below can leave deliberate exclusions alone. */
  const [existingLinks, setExistingLinks] = useState<Map<string, Set<string>>>(new Map())
  /** The applies-list read failed. Blocks submit — see the catch above for why guessing is worse. */
  const [linksError, setLinksError] = useState(false)
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set(productIds ?? []))
  const [operatorId, setOperatorId] = useState('')
  const [note, setNote] = useState('')

  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<AddTimeResult | null>(null)

  // ── Loads ─────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.from('production_lines').select('*').order('name')
      .then(({ data }) => setLines((data ?? []) as ProductionLine[]))
  }, [supabase])

  useEffect(() => {
    let cancelled = false
    if (!lineId) { setTeams([]); setSections([]); setProducts([]); setOperators([]); return }
    async function run() {
      try {
        const [teamRows, sectionRows, productRows, operatorRows] = await Promise.all([
          supabase.from('teams').select('id, name').eq('production_line_id', lineId).order('name')
            .then(({ data, error: e }) => { if (e) throw new Error(e.message); return (data ?? []) as { id: string; name: string }[] }),
          fetchSectionsForLine(supabase, lineId),
          // lib/lines: a pre-assembly line's models are the models of the lines it feeds, so
          // this can't be a products-by-line query without leaving Chassis, Sew and the rest
          // with an empty model step — and step 4 is where a time is bound to its models.
          modelsForLine(supabase, lineId),
          fetchOperators(supabase),
        ])
        if (cancelled) return
        setTeams(teamRows)
        setSections(sectionRows)
        setProducts(productRows)
        setOperators(operatorsForLine(operatorRows, lineId))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load this line')
      }
    }
    run()
    return () => { cancelled = true }
  }, [supabase, lineId])

  // Jobs in the chosen section. Merged-away jobs are filtered out — this is a picker, and
  // offering a retired job would be offering a dead end.
  useEffect(() => {
    let cancelled = false
    if (!section) { setJobs([]); return }
    // The section's own flag rides along: a host can pre-fill a section id (Labour Matrix passes
    // its focused job's), and the section list above hides retired ones but the id would still
    // reach here — a live job inside a retired section is retired structure (lib/liveStructure).
    supabase.from('jobs').select(`id, name, is_active, ${JOB_PARENT_CHAIN}`).eq('section_id', section).eq('is_active', true).order('name')
      .then(({ data, error: e }) => {
        if (cancelled) return
        if (e) { setError(e.message); return }
        const rows = (data ?? []) as unknown as ({ id: string; name: string } & JobLiveChain)[]
        setJobs(rows.filter(isLiveJob).map((j) => ({ id: j.id, name: j.name })))
      })
    return () => { cancelled = true }
  }, [supabase, section])

  useEffect(() => {
    let cancelled = false
    if (!job) { setOperations([]); return }
    // The whole chain, not just the operation's flag: a pre-filled job id skips the job picker,
    // so a retired job (or one in a retired section) would otherwise list its live operations.
    supabase.from('operations').select(`*, ${OPERATION_PARENT_CHAIN}`).eq('job_id', job).eq('is_active', true).order('name')
      .then(({ data, error: e }) => {
        if (cancelled) return
        if (e) { setError(e.message); return }
        const rows = (data ?? []) as unknown as (Operation & OperationLiveChain)[]
        setOperations(rows.filter(isLiveOperation).map((op) => ({ ...op, jobs: null })))
      })
    return () => { cancelled = true }
  }, [supabase, job])

  /**
   * Which models already have a time under this job — the "covered" half of the gap ordering.
   *
   * Two fan-out hops (job's operations → their times → those times' models), so both are chunked
   * AND paged via fetchAllChunked: one operation has many runs and one run has many models, so a
   * chunk can overrun the 1,000-row cap and a truncated read would silently promote a covered
   * model to the top as though it were a gap.
   */
  useEffect(() => {
    let cancelled = false
    const opIds = operations.map((o) => o.id)
    if (opIds.length === 0) { setTimedProductIds(new Set()); return }
    async function run() {
      try {
        // superseded_by and total_minutes ride along so currentForOperation can pick the current
        // record per pair — the badge shows labour content, not the sum of every run ever taken.
        // Retired and hidden records are filtered at the query (onlyCountedTimes): this read only
        // feeds a badge, and a model whose only records are excluded has to keep reading as a gap.
        type RawTime = { id: string; operation_id: string; total_minutes: number | null; superseded_by: string | null; chassis_id: string | null; is_active: boolean | null; is_hidden: boolean; operations: TimeParentFlags | null; created_at: string }
        const times = await fetchAllChunked<RawTime>(
          opIds, READ_CHUNK,
          (chunk) => onlyCountedTimes(supabase.from('operation_times')
            .select(`id, operation_id, total_minutes, superseded_by, chassis_id, ${TIME_FLAG_COLUMNS}, created_at`)
            .in('operation_id', chunk)).order('id') as unknown as RangeableQuery<RawTime>,
          { table: 'operation_times' }
        )
        const timeIds = times.map((t) => t.id)
        if (timeIds.length === 0) {
          if (!cancelled) { setTimedProductIds(new Set()); setRecordedMinutes(new Map()) }
          return
        }
        const links = await fetchAllChunked<{ operation_time_id: string; product_id: string }>(
          timeIds, READ_CHUNK,
          (chunk) => supabase.from('operation_time_models').select('operation_time_id, product_id')
            .in('operation_time_id', chunk)
            .order('operation_time_id').order('product_id') as unknown as RangeableQuery<{ operation_time_id: string; product_id: string }>,
          { table: 'operation_time_models' }
        )
        if (cancelled) return

        const hiddenTimeIds = new Set(times.filter((t) => !countsTowardLabour(t)).map((t) => t.id))
        const productsWithTimes = new Set(links.filter((l) => !hiddenTimeIds.has(l.operation_time_id)).map((l) => l.product_id))
        // The shared per-pair rule. Summed across this job's operations only, which is what the
        // badge claims — not the model's whole labour content.
        const pairStats = currentForOperation(times, links)
        const minutes = new Map<string, number>()
        for (const productId of productsWithTimes) {
          let total = 0
          for (const op of opIds) total += pairStats[operationProductKey(op, productId)]?.minutes ?? 0
          minutes.set(productId, total)
        }
        setTimedProductIds(productsWithTimes)
        setRecordedMinutes(minutes)
      } catch {
        // Presentational only — losing this loses the badges and the ordering, never a model.
        if (!cancelled) { setTimedProductIds(new Set()); setRecordedMinutes(new Map()) }
      }
    }
    run()
    return () => { cancelled = true }
  }, [supabase, operations])

  /**
   * The job's existing applies-list, across every model — read once per job rather than per
   * selected model, so ticking a different model costs nothing.
   *
   * This is the read that makes the "don't touch what's already there" rule possible. Four models
   * in production carry only 1 of 8 operations on a job; those are deliberate exclusions, and a
   * submit that re-linked the missing seven would silently undo somebody's work with no record
   * that it had happened.
   */
  useEffect(() => {
    let cancelled = false
    const opIds = operations.map((o) => o.id)
    setLinksError(false)
    if (opIds.length === 0) { setExistingLinks(new Map()); return }
    fetchLinksForOperations(supabase, opIds)
      .then((pairs) => {
        if (cancelled) return
        const byProduct = new Map<string, Set<string>>()
        for (const pair of pairs) {
          const set = byProduct.get(pair.product_id)
          if (set) set.add(pair.operation_id)
          else byProduct.set(pair.product_id, new Set([pair.operation_id]))
        }
        setExistingLinks(byProduct)
      })
      .catch(() => {
        // FAILS CLOSED, deliberately. An empty map reads as "this job applies to nothing yet",
        // which would offer to apply the whole job to models that already carry a deliberate
        // partial list. So the step is blocked instead (see stepReason) rather than guessed at.
        if (!cancelled) { setExistingLinks(new Map()); setLinksError(true) }
      })
    return () => { cancelled = true }
  }, [supabase, operations, linksVersion])

  // ── Derived ───────────────────────────────────────────────────────────────────────────────
  const lineName = lines.find((l) => l.id === lineId)?.name ?? ''
  const teamName = teams.find((t) => t.id === team)?.name ?? ''
  const sectionName = sections.find((s) => s.id === section)?.name ?? ''
  const jobName = jobs.find((j) => j.id === job)?.name ?? ''
  const sectionRow = sections.find((s) => s.id === section) ?? null

  /** Sections belong to a team, so choosing one narrows the list. With no team chosen every
   * section on the line is offered rather than none — an empty picker reads as broken. */
  const sectionOptions = useMemo(
    () => (team ? sections.filter((s) => s.team_id === team) : sections),
    [sections, team]
  )

  // ── Applicability, read-only ──────────────────────────────────────────────────────────────
  const selectedModels = useMemo(
    () => products.filter((p) => selectedProductIds.has(p.id)),
    [products, selectedProductIds]
  )
  /** What model_operations says about one (model, operation) pair. */
  const linkedTo = useCallback(
    (productId: string, operationId: string) => existingLinks.get(productId)?.has(operationId) ?? false,
    [existingLinks]
  )
  /**
   * The selected models the apply prompt is about: every one where this job's operations are
   * not ALL linked — none of them (the job doesn't apply yet) or only some (it applies partly) —
   * with how many are linked and which are missing. A fully linked model never sees the prompt,
   * and neither does one already answered for this job in this drawer (see `answered`): a
   * partial list can be deliberate, and "Leave as is" has to stay answered.
   */
  const answerKey = useCallback((productId: string) => `${job}|${productId}`, [job])
  const modelsToApply = useMemo(
    () => selectedModels
      .filter((m) => !answered.has(answerKey(m.id)))
      .map((model) => {
        const missing = operations.filter((o) => !linkedTo(model.id, o.id))
        return { model, missing, linked: operations.length - missing.length }
      })
      .filter((t) => t.missing.length > 0),
    [selectedModels, operations, linkedTo, answered, answerKey]
  )
  /** Every model in the prompt is one the job isn't on at all — the plain "Apply" wording. */
  const promptAllNew = modelsToApply.every((t) => t.linked === 0)
  /** Operations "Choose which apply" can tick: those missing from at least one model asked about. */
  const choosable = useMemo(
    () => operations.filter((o) => modelsToApply.some((t) => t.missing.includes(o))),
    [operations, modelsToApply]
  )
  const pickedToApply = useMemo(
    () => choosable.filter((o) => applyPrompt?.picked.has(o.id)).map((o) => o.id),
    [choosable, applyPrompt]
  )

  // ── Time entry ────────────────────────────────────────────────────────────────────────────
  const tickedCount = useMemo(() => operations.filter((o) => timeTicks.has(o.id)).length, [operations, timeTicks])

  /** Only TICKED operations are considered, and only one with a real, positive number is
   * written. A ticked box left blank is named so it can be filled or unticked; something
   * unparseable is a typo and is named too. */
  const entered = useMemo(() => {
    const ok: { operation: Operation; minutes: number }[] = []
    const bad: string[] = []
    const blank: string[] = []
    for (const op of operations) {
      if (!timeTicks.has(op.id)) continue
      const raw = (minutesByOperation[op.id] ?? '').trim()
      if (!raw) { blank.push(op.name); continue }
      const n = Number(raw)
      if (Number.isNaN(n) || n <= 0) { bad.push(op.name); continue }
      ok.push({ operation: op, minutes: n })
    }
    return { ok, bad, blank }
  }, [operations, minutesByOperation, timeTicks])

  const runningTotal = entered.ok.reduce((sum, e) => sum + e.minutes, 0)

  /** Timed operations that don't apply to one or more selected models — each with the models it
   * is missing from. Warned about on the row and named again at Save; never linked silently. */
  const unlinkedTimed = useMemo(
    () => entered.ok
      .map(({ operation }) => ({ operation, models: selectedModels.filter((m) => !linkedTo(m.id, operation.id)) }))
      .filter((u) => u.models.length > 0),
    [entered.ok, selectedModels, linkedTo]
  )

  /**
   * ── What a model row's badge has to say ───────────────────────────────────────────────
   *
   * Two independent facts, and after the applicability amendment they are different outcomes
   * for the same click:
   *
   *   APPLIES — is this job on this model's applies-list at all, and how much of it? Read from
   *     existingLinks (model_operations for this job's operations, every model). A model the job
   *     doesn't apply to yet gains structure when you tick it, and that has to be visible BEFORE
   *     it happens rather than reported after.
   *   RECORDED — has anything been timed for it, and how much? Read from the times above.
   *
   * `tier` is the ordering: gaps first (the common action), then models already covered, then
   * models the job doesn't apply to at all (the deliberate one, extending structure). The
   * not-applicable rows used to sort WITH the gaps, because they also have no time — which put
   * "this will restructure the model" and "this just needs a number" side by side.
   */
  const modelStateFor = useCallback((productId: string) => {
    const existing = existingLinks.get(productId) ?? new Set<string>()
    const appliedOps = operations.filter((o) => existing.has(o.id)).length
    const totalOps = operations.length
    // The derived rule from lib/modelOperations' jobsApplying: a job applies to a model iff at
    // least one of its operations does. There is no job→model row to read.
    const applies = appliedOps > 0
    const timed = timedProductIds.has(productId)
    const minutes = recordedMinutes.get(productId) ?? 0
    return {
      applies,
      appliedOps,
      totalOps,
      partial: applies && appliedOps < totalOps,
      timed,
      minutes,
      tier: (!applies ? 2 : timed ? 1 : 0) as 0 | 1 | 2,
    }
  }, [existingLinks, operations, timedProductIds, recordedMinutes])

  const sortByGapFirst = useCallback((a: Product, b: Product) => {
    const at = modelStateFor(a.id).tier
    const bt = modelStateFor(b.id).tier
    if (at !== bt) return at - bt
    return a.model.localeCompare(b.model)
  }, [modelStateFor])

  /**
   * A model tile's info icon. The tile is the model and its checkbox; everything the long text
   * badge used to say is one click, hover or focus away, and the icon's tone says which of the
   * three states this is before it is opened:
   *
   *   blue   (info)     the job doesn't apply to this model yet
   *   amber  (warning)  it applies and nothing is recorded — a gap
   *   green  (success)  it applies and time is recorded
   *
   * Every count is "of this job's N operations" — what model_operations holds for this job on
   * this model. Nothing here counts the operations being timed; they aren't chosen until the
   * next step.
   */
  function modelInfo(productId: string): React.ReactNode {
    const st = modelStateFor(productId)
    const ofJob = `of this job’s ${plural(st.totalOps, 'operation')}`
    if (!st.applies) {
      return (
        <InfoPopover tone="info" label="Job doesn’t apply yet">
          This job doesn’t apply to this model yet. Picking it asks, once, which {ofJob} to
          link — or to leave it as it is — before any time is entered.
        </InfoPopover>
      )
    }
    const linked = `${st.appliedOps} ${ofJob} ${st.appliedOps === 1 ? 'is' : 'are'} linked`
    const partialNote = st.partial ? ` Picking it asks whether to link the other ${st.totalOps - st.appliedOps}.` : ''
    if (!st.timed) {
      return (
        <InfoPopover tone="warning" label="Applies, nothing recorded">
          This job applies to this model. {linked}. Nothing recorded yet.{partialNote}
        </InfoPopover>
      )
    }
    return (
      <InfoPopover tone="success" label="Applies, time recorded">
        This job applies to this model. {linked}, {st.minutes > 0 ? `${fmtTotal(st.minutes)}m recorded` : 'time recorded'}.{partialNote}
      </InfoPopover>
    )
  }

  function toggleModel(product: Product, isSelected: boolean) {
    setSelectedProductIds((prev) => {
      const next = new Set(prev)
      if (isSelected) next.delete(product.id)
      else next.add(product.id)
      return next
    })
  }
  function toggleSeries(_series: string, seriesProducts: Product[], allSelected: boolean) {
    setSelectedProductIds((prev) => {
      const next = new Set(prev)
      for (const p of seriesProducts) { if (allSelected) next.delete(p.id); else next.add(p.id) }
      return next
    })
  }

  // ── Inline creation ───────────────────────────────────────────────────────────────────────
  const [newJobName, setNewJobName] = useState('')
  const [newOperationName, setNewOperationName] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleCreateJob() {
    if (!newJobName.trim() || !sectionRow) return
    setBusy(true); setError(null)
    try {
      // createJob REQUIRES a section (lib/jobs) — a job's team is its section's team, so a
      // sectionless job created here would file every time under it against no team at all.
      const created = await createJob(supabase, { name: newJobName.trim(), section: sectionRow })
      setJobs((prev) => [...prev, { id: created.id, name: created.name }])
      setJob(created.id)
      setNewJobName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that job')
    } finally { setBusy(false) }
  }

  /** Both the single add and the bulk paste go through createOperations — one name or twenty is
   * the same write, and parseOperationNames owns the "one per line, de-duplicated" rule. */
  async function handleAddOperations(names: string[]) {
    if (names.length === 0 || !job) return
    setBusy(true); setError(null)
    try {
      const { created, attempted, error: err } = await createOperations(supabase, job, names)
      setOperations((prev) => [...prev, ...created])
      if (err) setError(`Created ${created.length} of ${attempted} operations — ${err}`)
      setNewOperationName('')
      setPasteText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add operations')
    } finally { setBusy(false) }
  }

  // ── Applying the job ──────────────────────────────────────────────────────────────────────
  /**
   * Writes model_operations and nothing else, through linkOperationsToModels — the app's only
   * insert into that table. `operationIds` null is "Link all"; either way each model is sent only
   * the operations it is missing, so nothing already linked is rewritten and nothing is ever
   * unlinked. One write per model, so a failure is pinned to the model it belongs to.
   */
  async function applyJob(operationIds: string[] | null) {
    setApplying(true); setError(null)
    const failed: string[] = []
    const next = new Map(existingLinks)
    for (const { model, missing } of modelsToApply) {
      const ids = missing.filter((o) => operationIds === null || operationIds.includes(o.id)).map((o) => o.id)
      if (ids.length === 0) continue
      let linkError: string | null
      try {
        const linkResult = await linkOperationsToModels(
          supabase, ids.map((operation_id) => ({ operation_id, product_id: model.id }))
        )
        linkError = linkResult.error
      } catch (err) {
        linkError = err instanceof Error ? err.message : 'the write was rejected'
      }
      if (linkError) { failed.push(`${model.model} (${linkError})`); continue }
      next.set(model.id, new Set([...(next.get(model.id) ?? []), ...ids]))
    }
    setExistingLinks(next)
    setApplying(false)
    setApplyPrompt(null)
    if (failed.length > 0) {
      // A short write may still have landed some rows — re-read rather than guess.
      setLinksVersion((v) => v + 1)
      setError(`Could not link ${jobName || 'this job'} to ${failed.join('; ')}. No time has been recorded.`)
      return
    }
    // A model given only SOME of its missing operations is a deliberate partial list now, so it
    // is answered — not asked again any more than one left as it was. "Link all" leaves nothing
    // to ask about, and stays unanswered so an operation added later is still offered.
    if (operationIds !== null) {
      setAnswered((prev) => new Set([...prev, ...modelsToApply.map((t) => answerKey(t.model.id))]))
    }
    setStep(4)
  }

  /** "Leave as is" — a real answer, not a cancel. Writes nothing, remembers the answer for each
   * model asked about, and carries on to the Minutes step. */
  function leaveAsIs() {
    setAnswered((prev) => new Set([...prev, ...modelsToApply.map((t) => answerKey(t.model.id))]))
    setApplyPrompt(null)
    setStep(4)
  }

  // ── Submit ────────────────────────────────────────────────────────────────────────────────
  /** Stated, never silently disabled — a dead button with no reason beside it is the thing this
   * whole screen exists to stop being. */
  const blockingReason = useMemo(() => {
    if (!userId) return 'Still identifying you — give it a moment and try again.'
    if (selectedProductIds.size === 0) return 'Pick at least one model on step 3 — a time has to be recorded against something.'
    if (tickedCount === 0) return 'Tick at least one operation to record a time against.'
    if (entered.bad.length > 0) {
      return `These operations have something that isn't a number of minutes in them: ${entered.bad.join(', ')}.`
    }
    if (entered.blank.length > 0) {
      return `Enter minutes for ${entered.blank.join(', ')}, or untick ${entered.blank.length === 1 ? 'it' : 'them'}.`
    }
    // Fails closed: without the applies-list a time could be offered against a pair it can't be
    // recorded for, with no warning.
    if (linksError) return 'Could not read this job’s existing model links — go back a step and forward again to retry.'
    return null
  }, [userId, entered, tickedCount, selectedProductIds, linksError])

  /** Save, by way of the warning when a timed operation doesn't apply somewhere. */
  function requestSave() {
    if (blockingReason) { setError(blockingReason); return }
    if (unlinkedTimed.length > 0) { setUnlinkedConfirm(true); return }
    void save(false)
  }

  /**
   * Records the times. `linkUnlinked` is the answer to the warning dialog and the ONLY way this
   * function writes model_operations: true links exactly the (timed operation, model) pairs the
   * dialog named; false links nothing and records each time only where its operation applies.
   */
  async function save(linkUnlinked: boolean) {
    setUnlinkedConfirm(false)
    setSaving(true); setError(null)
    const models = selectedModels
    const trimmedNote = note.trim()
    const out: AddTimeResult = {
      jobId: job, jobName, lineId, created: 0, totalMinutes: 0,
      modelCount: models.length, notesWritten: 0, applicability: [], failures: [],
      nothingSaved: false,
    }
    /** product → operations that apply to it, as of this save. */
    const appliesNow = new Map(models.map((m) => [m.id, new Set(existingLinks.get(m.id) ?? [])]))
    try {
      // ── 1. The named pairs, only if the user chose to link them ──────────────────────────
      if (linkUnlinked) {
        for (const model of models) {
          const ops = unlinkedTimed.filter((u) => u.models.some((m) => m.id === model.id)).map((u) => u.operation)
          if (ops.length === 0) continue
          const outcome: ModelApplicabilityOutcome = {
            productId: model.id, model: model.model, alreadyApplied: true, linked: 0,
            timedAdditions: [], skippedForLinkFailure: false, linkError: null,
          }
          out.applicability.push(outcome)
          let linkError: string | null
          try {
            const linkResult = await linkOperationsToModels(
              supabase, ops.map((o) => ({ operation_id: o.id, product_id: model.id }))
            )
            outcome.linked = linkResult.linked
            linkError = linkResult.error
          } catch (err) {
            linkError = err instanceof Error ? err.message : 'the write was rejected'
          }
          if (linkError) {
            outcome.skippedForLinkFailure = true
            outcome.linkError = linkError
            continue
          }
          outcome.timedAdditions = ops.map((o) => o.name)
          for (const o of ops) appliesNow.get(model.id)?.add(o.id)
        }
      }

      // ── 2. The times — each against the models its operation applies to, and no others ────
      for (const { operation, minutes } of entered.ok) {
        const targets = models.filter((m) => appliesNow.get(m.id)?.has(operation.id))
        const left = models.filter((m) => !appliesNow.get(m.id)?.has(operation.id))
        if (targets.length === 0) {
          out.failures.push(`${operation.name}: not recorded — it doesn’t apply to ${models.length === 1 ? models[0].model : 'any selected model'}.`)
          continue
        }
        try {
          // THE single insert path. Never a direct .insert() into operation_times: this is what
          // derives the team/line provenance from the operation's job and applies the save-time
          // guards. It archives nothing: the new record stands beside what is already there.
          const { created, refusedProductIds } = await recordOperationTime(supabase, {
            operationId: operation.id,
            productIds: targets.map((m) => m.id),
            operatorId: operatorId || null,
            collectedBy: userId as string,
            totalMinutes: minutes,
            // Not a try-out: a paper time is not attached to a particular van.
            chassisId: null,
          })
          out.created += 1
          out.totalMinutes += minutes
          const missed = [...left.map((m) => m.model), ...refusedProductIds.map((id) => products.find((p) => p.id === id)?.model ?? 'a model')]
          if (missed.length > 0) {
            out.failures.push(`${operation.name}: recorded, but not against ${missed.join(', ')} — it doesn’t apply there.`)
          }
          if (trimmedNote) {
            try {
              await addOperationTimeNote(supabase, created.id, trimmedNote, userId as string)
              out.notesWritten += 1
            } catch (noteErr) {
              // The time is committed and is the thing that matters.
              out.failures.push(`Note on ${operation.name}: ${noteErr instanceof Error ? noteErr.message : 'failed'}`)
            }
          }
        } catch (err) {
          out.failures.push(`${operation.name}: ${err instanceof Error ? err.message : 'could not be saved'}`)
        }
      }
      out.nothingSaved = out.created === 0
      setResult(out)
    } finally {
      setSaving(false)
    }
  }

  // ── Step gating ───────────────────────────────────────────────────────────────────────────
  const stepReason: string | null =
    step === 1 ? (!lineId ? 'Pick a production line.' : !section ? 'Pick a section — a job belongs to one, and a job’s team comes from it.' : null)
    : step === 2 ? (!job ? 'Pick a job, or create one.' : null)
    : step === 3 ? (
      selectedProductIds.size === 0 ? 'Pick at least one model — a time has to be recorded against something.'
        // Fails closed: without the applies-list there is no telling which models need the job applied.
        : linksError ? 'Could not read this job’s existing model links — go back a step and forward again to retry.'
          : null)
    : null

  /** Leaving the Models step is the point of applying: any selected model the job isn't fully
   * on, and that hasn't been answered for, gets the one prompt before the wizard moves on. A job with no operations has nothing to link
   * yet — step 4 offers it again once it has. */
  function goNext() {
    if (stepReason) return
    if (step === 3 && modelsToApply.length > 0 && operations.length > 0) {
      setApplyPrompt({ choosing: false, picked: new Set() })
      return
    }
    setStep((s) => (s + 1) as Step)
  }

  function close() { onDone(result) }

  // ── Result ────────────────────────────────────────────────────────────────────────────────
  if (result) {
    return (
      <Modal
        title={result.nothingSaved ? 'Nothing saved' : 'Time added'}
        onClose={close}
        maxWidth={560}
        // The applicability report is one line per model — 89 of them on Caravan — so Done goes
        // in the pinned footer for the same reason as the wizard's Save.
        footer={(
          <>
            {/* Deep-linked to this job, today — which is when these were just written, whatever
                date was on the paper form. */}
            <Link
              className="btn-ghost"
              href={buildReportHref({ lineId: result.lineId, jobId: result.jobId, preset: 'today' })}
              onClick={close}
            >
              View these times
            </Link>
            <button type="button" className="btn-primary" onClick={close}>Done</button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={result.failures.length > 0 ? { ...ERR_BOX, fontSize: 13 } : OK_BOX}>
            {result.nothingSaved ? (
              <div>
                <strong>No time was recorded.</strong> Each one is listed below with the reason.
              </div>
            ) : (
              <div>
                Added {plural(result.created, 'time')} to <strong>{result.jobName || 'this job'}</strong> —{' '}
                {fmtTotal(result.totalMinutes)} minutes
                {' '}across {plural(result.modelCount, 'model')}.
                {result.notesWritten > 0 && <> Note saved on {plural(result.notesWritten, 'record')}.</>}
              </div>
            )}
            {/* Reported separately from the times because it is a separate table with separate
                meaning — this is the half that decides whether untimed work shows as a gap. */}
            {result.applicability.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {result.applicability.map((a) => (
                  <div key={a.productId}>
                    {/* A skipped model is named as SKIPPED, not as "unchanged" alone — "no
                        times were saved here, deliberately" is the thing the reader must not
                        miss when the rest of the box says times were added. */}
                    {a.skippedForLinkFailure
                      ? <><strong>{a.model}</strong> — <strong>could not be linked</strong>{a.linkError ? <> ({a.linkError})</> : null}, so the times for the operations that don’t apply to it were left off it.</>
                      : a.linked > 0
                        ? <>Linked {plural(a.linked, 'operation')} to <strong>{a.model}</strong>.</>
                        : <><strong>{a.model}</strong> unchanged.</>}
                    {!a.skippedForLinkFailure && a.alreadyApplied && a.timedAdditions.map((name) => (
                      <div key={name} style={{ paddingLeft: 12 }}>
                        + {name} linked (you recorded a time for it).
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          {result.failures.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--red)' }}>
              {result.failures.slice(0, 5).map((f, i) => <li key={i}>{f}</li>)}
              {result.failures.length > 5 && <li>…and {result.failures.length - 5} more</li>}
            </ul>
          )}
        </div>
      </Modal>
    )
  }

  return (
    <>
    <Modal
      title={`Add Time — ${STEP_TITLES[step]}`}
      // A prompt open on top owns Escape and the backdrop; this one must not close under it.
      onClose={applyPrompt || unlinkedConfirm ? () => {} : close}
      maxWidth={720}
      // Back / Next / Save are pinned, not appended after the step's content. Step 4 lists every
      // model on the line (89 on Caravan) and on a tablet that ran the Save button off the
      // bottom of the screen. The step scrolls; these do not.
      footer={(
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
          {(step === 4 ? blockingReason : stepReason) && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
              {step === 4 ? blockingReason : stepReason}
            </p>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center' }}>
            <button type="button" className="btn-ghost" onClick={close} disabled={saving}>Cancel</button>
            <div style={{ display: 'flex', gap: 10 }}>
              {step > 1 && (
                <button type="button" className="btn-ghost" disabled={saving} onClick={() => setStep((s) => (s - 1) as Step)}>
                  Back
                </button>
              )}
              {/* The save button names BOTH dimensions, because both are required and either can
                  be zero — it used to read "Save 3 times" with no model ticked, which is not a
                  thing that can happen. Disabled whenever blockingReason has something to say;
                  the sentence above is what says it. */}
              {step < 4 ? (
                <button type="button" className="btn-primary" disabled={!!stepReason} title={stepReason ?? undefined} onClick={goNext}>
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={saving || !!blockingReason}
                  title={blockingReason ?? undefined}
                  onClick={requestSave}
                >
                  {saving
                    ? 'Saving…'
                    : `Save ${plural(entered.ok.length, 'time')} to ${plural(selectedProductIds.size, 'model')}`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Step rail */}
        <div style={{ display: 'flex', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
          {([1, 2, 3, 4] as Step[]).map((n) => (
            <span
              key={n}
              style={{
                flex: 1, textAlign: 'center', padding: '5px 4px', borderRadius: 6,
                background: n === step ? 'var(--blue-light)' : 'var(--bg)',
                color: n === step ? 'var(--blue)' : 'var(--text-muted)',
              }}
            >
              {n}. {['Where', 'Job', 'Models', 'Minutes'][n - 1]}
            </span>
          ))}
        </div>

        {error && <p style={ERR_BOX}>{error}</p>}

        <div style={BODY}>
          {/* ── Step 1 — WHERE ───────────────────────────────────────────────────────── */}
          {step === 1 && (
            <>
              {isLocked('line', productionLineId) ? (
                <LockedChip label="Production line" value={lineName || '—'} onChange={() => unlock('line')} />
              ) : (
                <div>
                  <span style={LABEL}>Production line</span>
                  <SearchSelect
                    options={lines.map((l) => ({ id: l.id, label: l.name }))}
                    value={lineId}
                    onChange={(v) => { setLineId(v); setTeam(''); setSection(''); setJob(''); setSelectedProductIds(new Set()) }}
                    placeholder="Search lines…" emptyLabel="— Select a production line —" searchable={false}
                  />
                </div>
              )}

              {isLocked('team', teamId) ? (
                <LockedChip label="Team" value={teamName || '—'} onChange={() => unlock('team')} />
              ) : (
                <div>
                  <span style={LABEL}>Team</span>
                  <SearchSelect
                    options={teams.map((t) => ({ id: t.id, label: t.name }))}
                    value={team}
                    onChange={(v) => { setTeam(v); setSection(''); setJob('') }}
                    placeholder="Search teams…" emptyLabel="— All teams on this line —" searchable={false}
                    disabled={!lineId}
                  />
                </div>
              )}

              {isLocked('section', sectionId) ? (
                <LockedChip label="Section" value={sectionName || '—'} onChange={() => unlock('section')} />
              ) : (
                <div>
                  <span style={LABEL}>Section</span>
                  <SearchSelect
                    options={sectionOptions.map((s) => ({ id: s.id, label: s.name }))}
                    value={section}
                    onChange={(v) => { setSection(v); setJob('') }}
                    placeholder="Search sections…" emptyLabel="— Select a section —" searchable={false}
                    disabled={!lineId}
                  />
                </div>
              )}
            </>
          )}

          {/* ── Step 2 — JOB ─────────────────────────────────────────────────────────── */}
          {step === 2 && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {lineName}{teamName && <> · {teamName}</>}{sectionName && <> · {sectionName}</>}
              </div>
              {isLocked('job', jobId) ? (
                <LockedChip label="Job" value={jobName || '—'} onChange={() => unlock('job')} />
              ) : (
                <div>
                  <span style={LABEL}>Job</span>
                  <SearchSelect
                    options={jobs.map((j) => ({ id: j.id, label: j.name }))}
                    value={job}
                    onChange={setJob}
                    placeholder="Search jobs…" emptyLabel="— Select a job —"
                    disabled={!section}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <input
                      className="input" style={{ flex: 1, fontSize: 12, padding: '6px 9px' }}
                      placeholder="New job name…"
                      value={newJobName}
                      disabled={busy || !sectionRow}
                      onChange={(e) => setNewJobName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateJob() } }}
                    />
                    <button type="button" className="btn-ghost" disabled={busy || !newJobName.trim() || !sectionRow} onClick={handleCreateJob}>
                      {busy ? '…' : 'Create job'}
                    </button>
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
                    A new job is created in <strong>{sectionName || 'the selected section'}</strong> and
                    takes that section&apos;s team.
                  </p>
                </div>
              )}
            </>
          )}

          {/* ── Step 3 — MODELS ──────────────────────────────────────────────────────── */}
          {step === 3 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 6 }}>
                <span style={{ ...LABEL, marginBottom: 0 }}>Models ({selectedProductIds.size} selected)</span>
                <InfoPopover tone="info" label="About this list">
                  Tick the models these times were collected for. One time is written per
                  operation, recorded against every model ticked here that the operation applies
                  to. Gaps are listed first, then models already covered, then models{' '}
                  {jobName || 'this job'} doesn’t apply to yet. Each model’s icon says which it is.
                </InfoPopover>
              </div>
              {products.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                  No models on this production line.
                </p>
              ) : (
                <ModelSeriesPicker
                  products={products}
                  selectedIds={selectedProductIds}
                  onToggle={toggleModel}
                  onToggleSeries={toggleSeries}
                  sortWithinSeries={sortByGapFirst}
                  renderRowStatus={(p) => modelInfo(p.id)}
                />
              )}
            </div>
          )}

          {/* ── Step 4 — OPERATIONS AND MINUTES, OPERATOR, NOTE ─────────────────────────── */}
          {step === 4 && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {jobName} · {plural(operations.length, 'operation')} · for{' '}
                {selectedModels.length === 1 ? <strong>{selectedModels[0].model}</strong> : <strong>{plural(selectedModels.length, 'model')}</strong>}.
                Tick the operations you are recording a time for and enter the minutes. The tick is
                about <strong>this entry only</strong> — it never changes which operations apply.
              </div>

              {/* Operations the apply step never covered — created just now, or the job had none
                  when the models were picked. Offered, never done silently, and not for a model
                  already answered "Leave as is". */}
              {modelsToApply.length > 0 && operations.length > 0 && (
                <div style={WARN_BOX}>
                  {plural(modelsToApply.reduce((n, t) => Math.max(n, t.missing.length), 0), 'operation')} of{' '}
                  <strong>{jobName}</strong> {modelsToApply.length === 1 ? `aren’t linked to ${modelsToApply[0].model.model}` : `aren’t linked to ${plural(modelsToApply.length, 'selected model')}`},
                  so they won’t show as gaps there.{' '}
                  <button type="button" style={LINK_BTN} onClick={() => setApplyPrompt({ choosing: false, picked: new Set() })}>
                    Review…
                  </button>
                </div>
              )}

              {operations.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                  This job has no operations yet — add them below.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <SelectAllControl
                    noun="operation" total={operations.length} selected={tickedCount}
                    title="Ticks or clears every operation for time entry. It does not change which operations apply."
                    onSetAll={(select) => setTimeTicks(select ? new Set(operations.map((o) => o.id)) : new Set())}
                    style={{ padding: '2px 0 8px', borderBottom: '1px solid var(--border)' }}
                  />
                  {operations.map((op) => {
                    const ticked = timeTicks.has(op.id)
                    const appliesCount = selectedModels.filter((m) => linkedTo(m.id, op.id)).length
                    const missing = selectedModels.filter((m) => !linkedTo(m.id, op.id))
                    return (
                      <div key={op.id} style={{ padding: '6px 0', borderBottom: '1px solid #f2f2f2' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 96px', gap: 10, alignItems: 'center' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text)', minWidth: 0, cursor: 'pointer' }}>
                            <input
                              type="checkbox" checked={ticked} aria-label={`Record a time for ${op.name}`}
                              style={{ width: 16, height: 16, accentColor: 'var(--blue)', flexShrink: 0 }}
                              onChange={() => setTimeTicks((prev) => {
                                const next = new Set(prev)
                                if (next.has(op.id)) next.delete(op.id)
                                else next.add(op.id)
                                return next
                              })}
                            />
                            <span style={{ minWidth: 0 }}>{op.name}</span>
                          </label>
                          {/* What model_operations says, read-only. Nothing on this row writes it. */}
                          {linksError ? <span /> : appliesCount === selectedModels.length ? (
                            <span className="badge badge-green" style={{ fontSize: 10 }} title="This operation applies to every selected model">Applies</span>
                          ) : appliesCount === 0 ? (
                            <span className="badge badge-grey" style={{ fontSize: 10 }} title={`This operation is not linked to ${selectedModels.length === 1 ? 'this model' : 'any selected model'}`}>Doesn’t apply</span>
                          ) : (
                            <span className="badge badge-amber" style={{ fontSize: 10 }} title={`Not linked to: ${missing.map((m) => m.model).join(', ')}`}>
                              Applies to {appliesCount} of {selectedModels.length}
                            </span>
                          )}
                          <input
                            type="number" min={0} step="0.01" inputMode="decimal" placeholder="min"
                            className="input" style={{ width: '100%', textAlign: 'right', fontSize: 13 }}
                            aria-label={`Minutes for ${op.name}`}
                            value={minutesByOperation[op.id] ?? ''}
                            onChange={(e) => {
                              const value = e.target.value
                              setMinutesByOperation((prev) => ({ ...prev, [op.id]: value }))
                              // Typing a figure is choosing the operation; clearing it leaves the tick alone.
                              if (value.trim()) setTimeTicks((prev) => (prev.has(op.id) ? prev : new Set(prev).add(op.id)))
                            }}
                          />
                        </div>
                        {ticked && !linksError && missing.length > 0 && (
                          <p style={{ margin: '4px 0 0 24px', fontSize: 11, color: '#92400e', lineHeight: 1.5 }}>
                            ⚠ Doesn’t apply to {missing.length <= 2 ? missing.map((m) => m.model).join(' or ') : plural(missing.length, 'selected model')} —
                            a time can’t be recorded there unless it is linked. You’ll be asked when you save.
                          </p>
                        )}
                      </div>
                    )
                  })}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                    <span>{plural(entered.ok.length, 'time')} entered</span>
                    <span>{fmtTotal(runningTotal)}m</span>
                  </div>
                </div>
              )}

              <div>
                <span style={LABEL}>Add an operation</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input" style={{ flex: 1, fontSize: 12, padding: '6px 9px' }}
                    placeholder="Operation name…"
                    value={newOperationName}
                    disabled={busy}
                    onChange={(e) => setNewOperationName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddOperations([newOperationName.trim()].filter(Boolean)) } }}
                  />
                  <button type="button" className="btn-ghost" disabled={busy || !newOperationName.trim()} onClick={() => handleAddOperations([newOperationName.trim()])}>
                    {busy ? '…' : 'Add'}
                  </button>
                </div>
                <textarea
                  className="input" rows={3} style={{ resize: 'vertical', width: '100%', marginTop: 8, fontSize: 12 }}
                  placeholder="…or paste a list, one operation per line"
                  value={pasteText}
                  disabled={busy}
                  onChange={(e) => setPasteText(e.target.value)}
                />
                {pasteText.trim() && (
                  <button
                    type="button" className="btn-ghost" style={{ marginTop: 6 }} disabled={busy}
                    onClick={() => handleAddOperations(parseOperationNames(pasteText).names)}
                  >
                    Add {plural(parseOperationNames(pasteText).names.length, 'operation')}
                  </button>
                )}
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
                  A new operation is added to the job only. It doesn’t apply to any model until it is linked.
                </p>
              </div>

              <div>
                <span style={LABEL}>Operator (optional)</span>
                <OperatorSelect
                  operators={operators}
                  value={operatorId}
                  onChange={setOperatorId}
                  emptyLabel="— Not recorded —"
                  ariaLabel="Operator for these times"
                />
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
                  Applies to every time in this batch. Leave it blank if the form doesn&apos;t say.
                </p>
              </div>

              <div>
                <span style={LABEL}>Note (optional)</span>
                <textarea
                  className="input" rows={3} style={{ resize: 'vertical', width: '100%' }}
                  placeholder="Anything worth flagging about this batch…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
                  Saved against every time written.
                </p>
              </div>
            </>
          )}
        </div>

      </div>
    </Modal>

      {/* ── 1. APPLICABILITY — asked once, at the point of applying ────────────────────────
          A job the model doesn't have yet is being applied to it. That is a decision about
          model_operations and nothing else, so it is asked on its own, before any time is
          entered, and written by the shared linkOperationsToModels. */}
      {applyPrompt && (
        <Modal
          title={`${promptAllNew ? 'Apply' : 'Link the rest of'} ${jobName || 'this job'}`}
          // Closing it is not an answer: it stays on the step it was opened from and asks again.
          onClose={applying ? () => {} : () => setApplyPrompt(null)}
          maxWidth={560}
          footer={applyPrompt.choosing ? (
            <>
              <button type="button" className="btn-ghost" disabled={applying} onClick={() => setApplyPrompt({ choosing: false, picked: applyPrompt.picked })}>Back</button>
              <button
                type="button" className="btn-primary"
                disabled={applying || pickedToApply.length === 0}
                title={pickedToApply.length === 0 ? 'Tick at least one operation to link first — or go back and choose Leave as is' : undefined}
                onClick={() => applyJob(pickedToApply)}
              >
                {applying ? 'Linking…' : `Link ${plural(pickedToApply.length, 'operation')}`}
              </button>
            </>
          ) : (
            <>
              <button
                type="button" className="btn-ghost" disabled={applying}
                title="Writes nothing and carries on. You won’t be asked about this again while the drawer is open."
                onClick={leaveAsIs}
              >
                Leave as is
              </button>
              <button type="button" className="btn-ghost" disabled={applying} onClick={() => setApplyPrompt({ choosing: true, picked: applyPrompt.picked })}>
                Choose which apply
              </button>
              <button type="button" className="btn-primary" disabled={applying} onClick={() => applyJob(null)}>
                {applying ? 'Linking…' : modelsToApply.length === 1 ? `Link all ${plural(modelsToApply[0].missing.length, 'operation')}` : 'Link all'}
              </button>
            </>
          )}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 14, color: 'var(--text-mid)', lineHeight: 1.6 }}>
            {modelsToApply.length === 1 ? (
              <p style={{ margin: 0, color: 'var(--text)' }}>
                {modelsToApply[0].linked === 0 ? (
                  <>
                    Apply <strong>{jobName}</strong> to <strong>{modelsToApply[0].model.model}</strong>?{' '}
                    {plural(applyPrompt.choosing ? pickedToApply.length : operations.length, 'operation')} will be linked.
                  </>
                ) : (
                  <>
                    <strong>{jobName}</strong> applies to <strong>{modelsToApply[0].model.model}</strong> on{' '}
                    {modelsToApply[0].linked} of its {plural(operations.length, 'operation')}.{' '}
                    {applyPrompt.choosing
                      ? <>{plural(pickedToApply.length, 'more operation')} will be linked.</>
                      : <>Link the other {modelsToApply[0].missing.length}?</>}
                  </>
                )}
              </p>
            ) : (
              <>
                <p style={{ margin: 0, color: 'var(--text)' }}>
                  <strong>{jobName}</strong> doesn’t fully apply to {modelsToApply.length} of the selected models.{' '}
                  {applyPrompt.choosing
                    ? <>The ticked operations will be linked to each, where they aren’t already.</>
                    : <>Link the rest of its {plural(operations.length, 'operation')} to each?</>}
                </p>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, maxHeight: 160, overflowY: 'auto' }}>
                  {modelsToApply.map((t) => (
                    <li key={t.model.id}>
                      <strong style={{ color: 'var(--text)' }}>{t.model.model}</strong> —{' '}
                      {t.linked === 0
                        ? <>doesn’t apply yet; {plural(t.missing.length, 'operation')} would be linked</>
                        : <>applies on {t.linked} of {operations.length}; the other {t.missing.length} would be linked</>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {applyPrompt.choosing ? (
              <>
                <SelectAllControl
                  noun="operation" total={choosable.length} selected={pickedToApply.length}
                  onSetAll={(select) => setApplyPrompt({ choosing: true, picked: select ? new Set(choosable.map((o) => o.id)) : new Set() })}
                  style={{ paddingBottom: 8, borderBottom: '1px solid var(--border)' }}
                />
                <div className="checkbox-list" style={{ maxHeight: 'none' }}>
                  {operations.map((op) => {
                    // Linked on every model being asked about: nothing to decide, and this
                    // prompt never unlinks — shown ticked and fixed so the list is still the job.
                    const already = !choosable.includes(op)
                    return (
                      <label key={op.id} className="checkbox-row" style={{ cursor: already ? 'default' : 'pointer', justifyContent: 'space-between' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <input
                            type="checkbox" checked={already || applyPrompt.picked.has(op.id)} disabled={applying || already}
                            onChange={() => {
                              const picked = new Set(applyPrompt.picked)
                              if (picked.has(op.id)) picked.delete(op.id)
                              else picked.add(op.id)
                              setApplyPrompt({ choosing: true, picked })
                            }}
                          />
                          <span style={{ minWidth: 0, color: already ? 'var(--text-muted)' : undefined }}>{op.name}</span>
                        </span>
                        {already && <span className="badge badge-green" style={{ fontSize: 10 }}>Already linked</span>}
                      </label>
                    )
                  })}
                </div>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
                  Only the ticked operations are added. The rest stay off {modelsToApply.length === 1 ? 'this model' : 'these models'} and
                  will not show as gaps. Nothing is unlinked here.
                </p>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
                Linking says the work is required for {modelsToApply.length === 1 ? 'this model' : 'these models'} — every
                operation without a recorded time then shows as a gap, which is the point. It records
                nothing about time. <strong>Leave as is</strong> if the job really does less work
                here: it writes nothing, and you won’t be asked again while this drawer is open.
              </p>
            )}
          </div>
        </Modal>
      )}

      {/* ── A time against an operation that doesn't apply ─────────────────────────────────
          Ticking for time entry never links anything. A time can only be recorded against an
          operation the model is recorded as doing, so the pairs are named here and the user
          chooses — linking is its own, stated act, never a side effect of saving. */}
      {unlinkedConfirm && (
        <Modal
          title="Some of these operations don’t apply"
          onClose={() => setUnlinkedConfirm(false)}
          maxWidth={540}
          footer={(
            <>
              <button type="button" className="btn-ghost" onClick={() => setUnlinkedConfirm(false)}>Cancel</button>
              <button
                type="button" className="btn-ghost"
                title="Records each time only against the models its operation already applies to. Nothing is linked."
                onClick={() => save(false)}
              >
                Save without them
              </button>
              <button type="button" className="btn-primary" onClick={() => save(true)}>
                Link {plural(unlinkedTimed.reduce((n, u) => n + u.models.length, 0), 'pair')} and save
              </button>
            </>
          )}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6 }}>
            <p style={{ margin: 0 }}>
              You entered a time for {plural(unlinkedTimed.length, 'operation')} that{' '}
              {unlinkedTimed.length === 1 ? 'doesn’t' : 'don’t'} apply to every selected model. A time can
              only be recorded where the operation applies.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 220, overflowY: 'auto' }}>
              {unlinkedTimed.map((u) => (
                <li key={u.operation.id}>
                  <strong style={{ color: 'var(--text)' }}>{u.operation.name}</strong> — doesn’t apply to{' '}
                  {u.models.length <= 3 ? u.models.map((m) => m.model).join(', ') : plural(u.models.length, 'model')}
                </li>
              ))}
            </ul>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              <strong>Link and save</strong> adds those operations to those models, then records the times.{' '}
              <strong>Save without them</strong> links nothing and leaves those times off those models.
            </p>
          </div>
        </Modal>
      )}
    </>
  )
}
