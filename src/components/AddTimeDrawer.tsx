'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Modal from './Modal'
import OperatorSelect from './OperatorSelect'
import { ModelSeriesPicker } from './ModelLinker'
import { createClient } from '@/lib/supabase/client'
import { fetchAllChunked, READ_CHUNK, type RangeableQuery } from '@/lib/supabaseRead'
import { createSection, fetchSectionsForLine } from '@/lib/sections'
import { createJob } from '@/lib/jobs'
import { createOperations, parseOperationNames } from '@/lib/operations'
import { modelsForLine } from '@/lib/lines'
import { fetchLinksForOperations, linkOperationsToModels } from '@/lib/modelOperations'
import { addOperationTimeNote, currentForOperation, operationProductKey, recordOperationTime } from '@/lib/operationTimes'
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
 * Step 3 is the reason for the whole design: a job's operations listed down the page with a
 * minutes box beside each one, which is what the time-study sheet looks like. A blank box means
 * "not collected" and writes nothing. That is why this is a four-step wizard rather than a
 * single form — the batch is per JOB, and the job has to be settled before the list exists.
 *
 * ── Every write goes through the existing single-writer helpers ───────────────────────────
 * recordOperationTime for the times (never a direct insert into operation_times — it is what
 * derives team/line provenance from the job and supersedes the previous current record),
 * addOperationTimeNote for notes, createSection / createJob / createOperations for the structure
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
  3: 'Operations and minutes',
  4: 'Models, operator and note',
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

  // ── Step 3/4 entry ──
  const [minutesByOperation, setMinutesByOperation] = useState<Record<string, string>>({})
  /**
   * The "Applies" tick per operation. Absent = ticked: every operation on a job applies to the
   * models being collected unless somebody says otherwise, which is the common case and the one
   * that should need no clicks.
   *
   * This exists because the drawer writes TWO tables that mean different things. A time writes
   * operation_time_models ("this run counts for these models"); applicability is
   * model_operations ("this operation is required for this model") and it is what coverage and
   * the gap report read. Linking only the operations that got a time would make the gap report
   * incapable of ever containing work that hasn't been done — which is the only thing a gap
   * report is for.
   */
  const [appliesByOperation, setAppliesByOperation] = useState<Record<string, boolean>>({})
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
    supabase.from('jobs').select('id, name').eq('section_id', section).eq('is_active', true).order('name')
      .then(({ data, error: e }) => {
        if (cancelled) return
        if (e) { setError(e.message); return }
        setJobs((data ?? []) as { id: string; name: string }[])
      })
    return () => { cancelled = true }
  }, [supabase, section])

  useEffect(() => {
    let cancelled = false
    if (!job) { setOperations([]); return }
    supabase.from('operations').select('*').eq('job_id', job).eq('is_active', true).order('name')
      .then(({ data, error: e }) => {
        if (cancelled) return
        if (e) { setError(e.message); return }
        setOperations((data ?? []) as Operation[])
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
        type RawTime = { id: string; operation_id: string; total_minutes: number | null; superseded_by: string | null; created_at: string }
        const times = await fetchAllChunked<RawTime>(
          opIds, READ_CHUNK,
          (chunk) => supabase.from('operation_times')
            .select('id, operation_id, total_minutes, superseded_by, created_at')
            .in('operation_id', chunk).order('id') as unknown as RangeableQuery<RawTime>,
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

        const productsWithTimes = new Set(links.map((l) => l.product_id))
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
        // which sends every model down case (a) and links every ticked operation — exactly the
        // silent restoration of deliberate exclusions this whole read exists to prevent. So the
        // step is blocked instead (see blockingReason) rather than guessed at.
        if (!cancelled) { setExistingLinks(new Map()); setLinksError(true) }
      })
    return () => { cancelled = true }
  }, [supabase, operations])

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

  /** Only operations with a real, positive number are written. A blank box is "not collected"
   * and is skipped in silence; a box with something unparseable in it is a typo and is named. */
  const entered = useMemo(() => {
    const ok: { operation: Operation; minutes: number }[] = []
    const bad: string[] = []
    for (const op of operations) {
      const raw = (minutesByOperation[op.id] ?? '').trim()
      if (!raw) continue
      const n = Number(raw)
      if (Number.isNaN(n) || n <= 0) { bad.push(op.name); continue }
      ok.push({ operation: op, minutes: n })
    }
    return { ok, bad }
  }, [operations, minutesByOperation])

  const runningTotal = entered.ok.reduce((sum, e) => sum + e.minutes, 0)

  /** Operations with real minutes — their applicability tick is forced on and disabled. */
  const timedOperationIds = useMemo(
    () => new Set(entered.ok.map((e) => e.operation.id)),
    [entered.ok]
  )

  /**
   * Whether an operation will be treated as applying. Timed operations are forced true and
   * cannot be unticked: a recorded time for an operation that doesn't apply is a contradiction,
   * and the way to untick it is to clear the minutes.
   */
  const appliesTo = useCallback(
    (operationId: string) => timedOperationIds.has(operationId) || (appliesByOperation[operationId] ?? true),
    [timedOperationIds, appliesByOperation]
  )

  /**
   * ── What this submit will do to each selected model's applies-list ────────────────────
   *
   * TWO CASES, and they are not variations of each other:
   *
   * (a) The job does NOT yet apply to the model — no operation of it is linked. Nothing has been
   *     decided about this model yet, so every TICKED operation is linked. This is the case that
   *     makes untimed work appear as a gap.
   *
   * (b) The job ALREADY applies — at least one operation is linked. Somebody has already said
   *     what this model does, and a partial list is a DECISION, not an incomplete one. Nothing is
   *     touched. The single exception is an operation you entered minutes for that isn't linked
   *     yet: a time for a non-applicable operation is a contradiction, so that one is linked and
   *     the confirmation says so by name.
   *
   * Applicability is only ever ADDED here. This drawer never deletes a model_operations row —
   * removing applicability is /model-total's unlink (lib/modelLinks), which is a separate,
   * confirmed, times-aware action.
   */
  const applicabilityPlan = useMemo(() => {
    const operationById = new Map(operations.map((o) => [o.id, o]))
    const tickedIds = operations.filter((o) => appliesTo(o.id)).map((o) => o.id)

    return [...selectedProductIds].map((productId) => {
      const product = products.find((p) => p.id === productId)
      const existing = existingLinks.get(productId) ?? new Set<string>()
      // "A job applies to a model iff at least one of its operations does" — the derived rule
      // from lib/modelOperations' jobsApplying. There is no job→model row to consult.
      const existingOnJob = operations.filter((o) => existing.has(o.id)).map((o) => o.id)
      const alreadyApplies = existingOnJob.length > 0

      const toLink = alreadyApplies
        // Case (b): ONLY the timed operations that aren't linked yet. Ticked-but-untimed
        // operations are deliberately left alone — that is the exclusion being preserved.
        ? [...timedOperationIds].filter((id) => !existing.has(id))
        // Case (a): every ticked operation. Timed ones are forced ticked, so they are included.
        : tickedIds

      return {
        productId,
        model: product?.model ?? '(unknown model)',
        alreadyApplies,
        existingCount: existingOnJob.length,
        totalOperations: operations.length,
        toLink,
        // Named in the confirmation, because this is the one thing case (b) changes.
        timedAdditions: alreadyApplies
          ? toLink.map((id) => operationById.get(id)?.name ?? '—')
          : [],
      }
    })
  }, [selectedProductIds, products, operations, existingLinks, timedOperationIds, appliesTo])

  /** How many operations the tick boxes currently say apply — what case (a) would link. */
  const tickedCount = useMemo(
    () => operations.filter((o) => appliesTo(o.id)).length,
    [operations, appliesTo]
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
   * The badge. Combined rather than one fact per badge, because the partial case is exactly the
   * one that is currently invisible: four models in production carry 1 of 8 operations on a job,
   * and under a "no time yet" badge alone they were indistinguishable from a model that simply
   * hasn't been walked yet.
   *
   * Colour follows the most actionable fact rather than the tier: blue where ticking would add
   * structure, amber for anything still to be filled in (a gap, or a partial applies-list),
   * muted grey for a model that is complete and recorded.
   */
  function modelBadge(productId: string): React.ReactNode {
    const st = modelStateFor(productId)
    if (!st.applies) {
      return (
        <span className="badge badge-blue" style={{ fontSize: 10 }} title="This job doesn’t apply to this model yet — ticking it will link the job’s operations to it as well as recording the times.">
          will link job · {plural(tickedCount, 'operation')}
        </span>
      )
    }
    const parts: string[] = []
    // "1 of 8 operations", spelled exactly as /setup's job model panel spells it. One phrase
    // for one concept: a reader who learns what it means in one screen should not have to
    // re-learn an abbreviation of it in another.
    if (st.partial) parts.push(`applies · ${st.appliedOps} of ${st.totalOps} operations`)
    if (!st.timed) parts.push('no time yet')
    else parts.push(st.minutes > 0 ? `${fmtTotal(st.minutes)}m recorded` : 'time recorded')
    const cls = st.partial || !st.timed ? 'badge-amber' : 'badge-grey'
    return (
      <span
        className={`badge ${cls}`}
        style={{ fontSize: 10 }}
        title={st.partial
          ? `This job applies to ${st.appliedOps} of its ${st.totalOps} operations on this model — the rest are deliberately excluded and this drawer will not restore them.`
          : undefined}
      >
        {parts.join(' · ')}
      </span>
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
  const [newSectionName, setNewSectionName] = useState('')
  const [newJobName, setNewJobName] = useState('')
  const [newOperationName, setNewOperationName] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleCreateSection() {
    if (!newSectionName.trim() || !lineId || !team) return
    setBusy(true); setError(null)
    try {
      const created = await createSection(supabase, {
        name: newSectionName.trim(), productionLineId: lineId, teamId: team,
      })
      setSections((prev) => [...prev, created])
      setSection(created.id)
      setNewSectionName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that section')
    } finally { setBusy(false) }
  }

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

  // ── Submit ────────────────────────────────────────────────────────────────────────────────
  /** Stated, never silently disabled — a dead button with no reason beside it is the thing this
   * whole screen exists to stop being. */
  const blockingReason = useMemo(() => {
    if (!userId) return 'Still identifying you — give it a moment and try again.'
    if (entered.bad.length > 0) {
      return `These operations have something that isn't a number of minutes in them: ${entered.bad.join(', ')}. Clear the box to skip an operation.`
    }
    if (entered.ok.length === 0) return 'Enter minutes against at least one operation on step 3 — a blank box means "not collected" and writes nothing.'
    if (selectedProductIds.size === 0) return 'Pick at least one model — a time has to be recorded against something.'
    // Fails closed: without the existing applies-list every model would be read as "job doesn't
    // apply yet" and every ticked operation linked, silently restoring deliberate exclusions.
    if (linksError) return 'Could not read this job’s existing model links, so it isn’t safe to write applicability — go back a step and forward again to retry.'
    return null
  }, [userId, entered, selectedProductIds, linksError])

  async function handleSubmit() {
    if (blockingReason) { setError(blockingReason); return }
    setSaving(true); setError(null)
    const models = [...selectedProductIds]
    const trimmedNote = note.trim()
    const out: AddTimeResult = {
      jobId: job, jobName, lineId, created: 0, totalMinutes: 0,
      modelCount: models.length, notesWritten: 0, applicability: [], failures: [],
      nothingSaved: false,
    }
    try {
      // ── 1. Applicability FIRST ──────────────────────────────────────────────────────
      // Before the times, so a run can never land against an operation the model isn't yet
      // recorded as doing. linkOperationsToModels is the single writer and upserts, so a pair
      // that already exists is a no-op rather than a duplicate-key error — nothing here can
      // delete a model_operations row.
      //
      // ONE WRITE PER MODEL, so a failure can be pinned to the model it belongs to. A model
      // whose links did not all land gets NO times — it is dropped from the models the times
      // are recorded against, and the rest still save. Banking four of five and naming the
      // fifth beats losing all five to one rejected write and inviting a duplicate re-entry.
      const savedModels: string[] = []
      for (const planned of applicabilityPlan) {
        const outcome: ModelApplicabilityOutcome = {
          productId: planned.productId,
          model: planned.model,
          alreadyApplied: planned.alreadyApplies,
          linked: 0,
          timedAdditions: planned.timedAdditions,
          skippedForLinkFailure: false,
          linkError: null,
        }
        out.applicability.push(outcome)
        if (planned.toLink.length > 0) {
          // A throw is the same failure as a returned error — see the copy panel's guard.
          let linkError: string | null
          try {
            const linkResult = await linkOperationsToModels(
              supabase, planned.toLink.map((operation_id) => ({ operation_id, product_id: planned.productId }))
            )
            outcome.linked = linkResult.linked
            linkError = linkResult.error
          } catch (err) {
            linkError = err instanceof Error ? err.message : 'the write was rejected'
          }
          if (linkError) {
            outcome.skippedForLinkFailure = true
            outcome.linkError = linkError
            out.failures.push(
              `${planned.model}: its applies-list could not be written (${linkError}), so NO times `
              + 'were saved against it. Fix that and enter the times again for this model only.'
            )
            continue
          }
        }
        savedModels.push(planned.productId)
      }

      // Every model's link failed: write nothing. A time recorded against no model is not a
      // smaller save, it is a record nothing can find.
      if (savedModels.length === 0) {
        out.nothingSaved = true
        setResult(out)
        return
      }

      // ── 2. Then the times — against the models whose applicability landed, only ────────
      for (const { operation, minutes } of entered.ok) {
        try {
          // THE single insert path. Never a direct .insert() into operation_times: this is what
          // derives the team/line provenance from the operation's job and supersedes whatever
          // was the current record for each (operation, model) pair.
          const created = await recordOperationTime(supabase, {
            operationId: operation.id,
            productIds: savedModels,
            operatorId: operatorId || null,
            collectedBy: userId as string,
            totalMinutes: minutes,
            // Not a try-out: a paper time is not attached to a particular van.
            chassisId: null,
          })
          out.created += 1
          out.totalMinutes += minutes
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
      setResult(out)
    } finally {
      setSaving(false)
    }
  }

  // ── Step gating ───────────────────────────────────────────────────────────────────────────
  const stepReason: string | null =
    step === 1 ? (!lineId ? 'Pick a production line.' : !section ? 'Pick a section — a job belongs to one, and a job’s team comes from it.' : null)
    : step === 2 ? (!job ? 'Pick a job, or create one.' : null)
    : step === 3 ? (entered.bad.length > 0 ? `Not a number: ${entered.bad.join(', ')}` : entered.ok.length === 0 ? 'Enter minutes against at least one operation.' : null)
    : null

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
                <strong>Nothing was saved.</strong> None of the selected models’ applies-lists could
                be written, so no times were recorded against any of them. Every model below is
                unchanged — fix the cause and enter the form again.
              </div>
            ) : (
              <div>
                Added {plural(result.created, 'time')} to <strong>{result.jobName || 'this job'}</strong> —{' '}
                {fmtTotal(result.totalMinutes)} minutes
                {result.applicability.some((a) => a.skippedForLinkFailure) && (
                  <>, against {plural(result.applicability.filter((a) => !a.skippedForLinkFailure).length, 'model')} of {result.modelCount} selected</>
                )}.
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
                      ? <><strong>{a.model}</strong> — <strong>skipped, no times saved</strong>: its applies-list could not be written{a.linkError ? <> ({a.linkError})</> : null}.</>
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
    <Modal
      title={`Add Time — ${STEP_TITLES[step]}`}
      onClose={close}
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
                <button type="button" className="btn-primary" disabled={!!stepReason} onClick={() => setStep((s) => (s + 1) as Step)}>
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={saving || !!blockingReason}
                  onClick={handleSubmit}
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
              {n}. {['Where', 'Job', 'Minutes', 'Models'][n - 1]}
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
                    placeholder="Search lines…" emptyLabel="— Select a production line —"
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
                    placeholder="Search teams…" emptyLabel="— All teams on this line —"
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
                    placeholder="Search sections…" emptyLabel="— Select a section —"
                    disabled={!lineId}
                  />
                  {/* A section belongs to exactly one team, so createSection needs one before it
                      can be offered. */}
                  {lineId && (
                    team ? (
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <input
                          className="input" style={{ flex: 1, fontSize: 12, padding: '6px 9px' }}
                          placeholder="New section name…"
                          value={newSectionName}
                          disabled={busy}
                          onChange={(e) => setNewSectionName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateSection() } }}
                        />
                        <button type="button" className="btn-ghost" disabled={busy || !newSectionName.trim()} onClick={handleCreateSection}>
                          {busy ? '…' : 'Create section'}
                        </button>
                      </div>
                    ) : (
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0 0' }}>
                        Pick a team above to create a new section — every section belongs to one.
                      </p>
                    )
                  )}
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

          {/* ── Step 3 — OPERATIONS AND MINUTES ──────────────────────────────────────── */}
          {step === 3 && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {jobName} · {plural(operations.length, 'operation')} · leave a box blank for anything
                not collected. <strong>Applies</strong> is separate from minutes: it says the
                operation is required for these models, which is what makes an untimed operation
                show up as a gap.
              </div>

              {operations.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                  This job has no operations yet — add them below.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {operations.map((op) => {
                    const timed = timedOperationIds.has(op.id)
                    return (
                      <div
                        key={op.id}
                        style={{
                          display: 'grid', gridTemplateColumns: '1fr 84px 96px', gap: 10, alignItems: 'center',
                          padding: '6px 0', borderBottom: '1px solid #f2f2f2',
                        }}
                      >
                        <span style={{ fontSize: 13, color: 'var(--text)', minWidth: 0 }}>{op.name}</span>
                        {/* Applicability, not minutes — this is what coverage and the gap report
                            read. Forced on and disabled once minutes are entered: a recorded time
                            means the operation applies, so the way to untick it is to clear the
                            box, not to contradict yourself here. */}
                        <label
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: timed ? 'var(--text-muted)' : 'var(--text-mid)', cursor: timed ? 'default' : 'pointer' }}
                          title={timed
                            ? 'You recorded a time for this operation, so it applies to the selected models. Clear the minutes to untick it.'
                            : 'Untick if this operation does not apply to the selected models.'}
                        >
                          <input
                            type="checkbox"
                            checked={appliesTo(op.id)}
                            disabled={timed}
                            onChange={(e) => setAppliesByOperation((prev) => ({ ...prev, [op.id]: e.target.checked }))}
                          />
                          Applies
                        </label>
                        <input
                          type="number" min={0} step="0.01" inputMode="decimal" placeholder="min"
                          className="input" style={{ width: '100%', textAlign: 'right', fontSize: 13 }}
                          value={minutesByOperation[op.id] ?? ''}
                          onChange={(e) => setMinutesByOperation((prev) => ({ ...prev, [op.id]: e.target.value }))}
                        />
                      </div>
                    )
                  })}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                    <span>
                      {plural(entered.ok.length, 'operation')} entered ·{' '}
                      {operations.filter((o) => appliesTo(o.id)).length} of {operations.length} apply
                    </span>
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
              </div>
            </>
          )}

          {/* ── Step 4 — MODELS, OPERATOR, NOTE ──────────────────────────────────────── */}
          {step === 4 && (
            <>
              <div>
                <span style={LABEL}>Models ({selectedProductIds.size} selected)</span>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 8px' }}>
                  One time is written per operation, linked to every model ticked here. The badge
                  says whether this job already applies to the model and what has been recorded —
                  gaps first, then models already covered, then models the job doesn&apos;t apply to
                  yet, which ticking would also link.
                </p>
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
                    renderRowStatus={(p) => modelBadge(p.id)}
                  />
                )}
              </div>

              {/* ── What this will do to applicability, per model ─────────────────────
                  Stated before submit rather than reported after, because the two cases are not
                  interchangeable and case (b) deliberately does LESS than it looks like it
                  should. A reader has to be able to see that a model with 1 of 8 operations is
                  staying that way. */}
              {applicabilityPlan.length > 0 && (
                <div>
                  <span style={LABEL}>Applicability</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {applicabilityPlan.map((planned) => (
                      <div key={planned.productId} style={{ fontSize: 12, lineHeight: 1.5 }}>
                        <strong style={{ color: 'var(--text)' }}>{planned.model}</strong>
                        {planned.alreadyApplies ? (
                          <>
                            {' '}— already applies, {planned.existingCount} of {planned.totalOperations} operations
                            {planned.toLink.length === 0 && <span style={{ color: 'var(--text-muted)' }}>, unchanged.</span>}
                            {planned.toLink.length > 0 && '.'}
                            {planned.timedAdditions.map((name) => (
                              <div key={name} style={{ color: 'var(--amber)', paddingLeft: 12 }}>
                                + {name} linked (you recorded a time for it).
                              </div>
                            ))}
                          </>
                        ) : (
                          <span style={{ color: 'var(--text-mid)' }}>
                            {' '}— job will be linked, {plural(planned.toLink.length, 'operation')}.
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0 0' }}>
                    A model that already has this job keeps exactly the operations it has — partial
                    lists are deliberate and are never restored from here. Nothing is ever unlinked
                    by this drawer.
                  </p>
                </div>
              )}

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
  )
}
