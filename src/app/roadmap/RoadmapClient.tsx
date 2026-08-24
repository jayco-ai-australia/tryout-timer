'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import ConfirmDialog from '@/components/ConfirmDialog'
import { fmtDate, fmtLongDate } from '@/lib/format'
import type { RoadmapItem, RoadmapItemStatus, RoadmapPhase } from '@/lib/types'

interface Props {
  initialPhases: RoadmapPhase[]
  initialItems: RoadmapItem[]
  /** auth.uid() as the server saw it, so the client can confirm it read the same row. */
  userId: string
  /** profiles.role for the logged-in user, read server-side. null = no profiles row. */
  role: string | null
  /** ?debug=roadmap — renders the pencils regardless of role, to separate "the role check said
   * no" from "the icon isn't rendering at all". Writes are still governed by RLS, so a
   * non-admin who opens the drawer this way gets a permission error on Save. */
  forceEditIcons: boolean
}

/** What the drawer is editing. Tasks are the everyday case; the phase form exists so a phase
 * added with "+ Add phase" can be named — there is no full-page edit mode to do it in. */
type EditTarget = { kind: 'item' | 'phase'; id: string }

const PHASE_COLOURS = ['#0079c1', '#1d9e75', '#ef9f27', '#7f77dd']

/** `badge` is the on-screen chip, `print` its counterpart in the print sheet. Both are keyed
 * off the same row so the two views can never drift apart on which status is which colour.
 * A status with no modifier class — the statusMeta() fallback for anything unrecognised —
 * lands on the neutral outline in both. */
const STATUSES: { value: RoadmapItemStatus; label: string; badge: string; print: string }[] = [
  { value: 'not_started', label: 'Not started', badge: 'badge badge-grey', print: 'roadmap-print-status' },
  { value: 'in_progress', label: 'In progress', badge: 'badge badge-blue', print: 'roadmap-print-status roadmap-print-status-progress' },
  { value: 'done', label: 'Done', badge: 'badge badge-green', print: 'roadmap-print-status roadmap-print-status-done' },
]

const ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8,
  background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}
const EMPTY: React.CSSProperties = { textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '24px 0' }
const FIELD: React.CSSProperties = { marginBottom: 14 }
/** The shared .gaps-drawer class is already 25vw — only the floor for narrow screens is set here. */
const DRAWER_WIDTH: React.CSSProperties = { minWidth: 'min(340px, 100vw)' }
const OVERLAY_TINT: React.CSSProperties = { background: 'rgba(0,0,0,0.2)' }

/** The "Phase N" chip, taken from the editable `label` column so it can be renamed in the
 * drawer, falling back to the phase number only when the label is blank. The column can drift
 * out of step with phase_number — a phase numbered 2 once carried the label "Phase 3", which
 * read on the chart as Phase 2 vanishing and Phase 3 appearing twice — so it is worth a glance
 * whenever two rows show the same name. */
function phaseName(phase: RoadmapPhase): string {
  return phase.label.trim() || `Phase ${phase.phase_number}`
}

function phaseColour(phaseNumber: number): string {
  const i = (Math.max(1, phaseNumber) - 1) % PHASE_COLOURS.length
  return PHASE_COLOURS[i]
}

/** "Phase 1 runs from 1 August 2026 until 31 October 2026" — omitted entirely unless the
 * phase has both ends of the range. */
function dateRangeSentence(phase: RoadmapPhase): string | null {
  if (!phase.start_date || !phase.end_date) return null
  return `${phaseName(phase)} runs from ${fmtLongDate(phase.start_date)} until ${fmtLongDate(phase.end_date)}`
}

/** The same range, compacted for print — "1 August 2026 - 31 October 2026". The on-screen
 * sentence repeats the phase name, which is already the heading directly above it on the
 * printed page. A half-open range still says what it knows rather than dropping out. */
function printDateRange(phase: RoadmapPhase): string {
  if (phase.start_date && phase.end_date) return `${fmtLongDate(phase.start_date)} \u2013 ${fmtLongDate(phase.end_date)}`
  if (phase.start_date) return `From ${fmtLongDate(phase.start_date)}`
  if (phase.end_date) return `Until ${fmtLongDate(phase.end_date)}`
  return 'No dates set'
}

function statusMeta(status: RoadmapItemStatus) {
  return STATUSES.find((s) => s.value === status) ?? STATUSES[0]
}

/** Trim to null — a blank field should clear the column, not store an empty string. */
function trimOrNull(value: string): string | null {
  const v = value.trim()
  return v === '' ? null : v
}

/** The drawer's date fields are native pickers, which hand back either '' or a valid
 * YYYY-MM-DD — this stays as a backstop so a value that somehow arrives malformed is caught
 * here rather than coming back as a Postgres cast error. */
function parseIsoDate(raw: string): { ok: true; value: string | null } | { ok: false } {
  const v = raw.trim()
  if (v === '') return { ok: true, value: null }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false }
  const [y, m, d] = v.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const real = date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  return real ? { ok: true, value: v } : { ok: false }
}

export default function RoadmapClient({ initialPhases, initialItems, userId, role, forceEditIcons }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()

  const isAdmin = role === 'admin'
  const showEditIcons = isAdmin || forceEditIcons

  // Role diagnostic: the server's answer, then the same lookup repeated in the browser against
  // auth.uid(). If the two disagree the session and the rendered page are out of step; if they
  // agree and role isn't 'admin', the account simply isn't an admin.
  useEffect(() => {
    console.log('[roadmap] role from server:', role, '| isAdmin:', isAdmin, '| userId:', userId)
    if (forceEditIcons) console.log('[roadmap] ?debug=roadmap — edit icons forced on regardless of role')

    supabase.auth.getUser().then(({ data: { user }, error }) => {
      if (error || !user) {
        console.log('[roadmap] client auth.getUser() failed:', error?.message ?? 'no user')
        return
      }
      console.log('[roadmap] client auth.uid():', user.id, '| matches server userId:', user.id === userId)

      supabase
        .from('profiles')
        .select('id, full_name, role')
        .eq('id', user.id)
        .maybeSingle()
        .then(({ data, error: err }) => {
          console.log('[roadmap] client profiles row for auth.uid():', data, '| error:', err?.message ?? null)
        })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [phases, setPhases] = useState<RoadmapPhase[]>(initialPhases)
  const [items, setItems] = useState<RoadmapItem[]>(initialItems)
  const [error, setError] = useState<string | null>(null)

  // `target` keeps the drawer mounted; `visible` drives the transform, and lags it by a frame on
  // open and by the transition length on close so the slide plays in both directions.
  const [target, setTarget] = useState<EditTarget | null>(null)
  const [visible, setVisible] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<EditTarget | null>(null)

  const editingItem = target?.kind === 'item' ? items.find((i) => i.id === target.id) ?? null : null
  const editingPhase = target?.kind === 'phase' ? phases.find((p) => p.id === target.id) ?? null : null

  function openDrawer(next: EditTarget) {
    setError(null)
    setTarget(next)
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
  }

  function closeDrawer() {
    setVisible(false)
    window.setTimeout(() => setTarget(null), 320)
  }

  useEffect(() => {
    if (!target) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closeDrawer() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  function itemsOf(phaseId: string) {
    return items.filter((i) => i.phase_id === phaseId)
  }

  // ── Print ─────────────────────────────────────────────────────────────
  // Stamped when Print is pressed rather than at render: this component server-renders too,
  // and a date evaluated during render would differ between server and client markup.
  const [printedAt, setPrintedAt] = useState<string | null>(null)
  function handlePrint() {
    setPrintedAt(new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }))
    // Two frames so the stamp is painted before the print dialog snapshots the page.
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()))
  }

  const doneCount = items.filter((i) => i.status === 'done').length

  // ── Writes — each one goes straight to Supabase ───────────────────────
  /** Returns an error message for the drawer to show, or null on success. */
  async function saveItem(id: string, patch: Omit<RoadmapItem, 'id' | 'created_at' | 'sort_order'>): Promise<string | null> {
    const current = items.find((i) => i.id === id)
    // Moved to another phase: land at the end of it rather than keeping a position that
    // already belongs to one of the destination's tasks.
    const movedPhase = current != null && current.phase_id !== patch.phase_id
    const sort_order = movedPhase ? itemsOf(patch.phase_id).length : current?.sort_order ?? 0

    const { data, error: err } = await supabase
      .from('roadmap_items')
      .update({ ...patch, sort_order })
      .eq('id', id)
      .select('*')
      .single()

    if (err) return err.message
    setItems((prev) => prev.map((i) => (i.id === id ? (data as RoadmapItem) : i)))
    router.refresh()
    return null
  }

  async function savePhase(id: string, patch: Pick<RoadmapPhase, 'label' | 'title' | 'subtitle' | 'lead' | 'start_date' | 'end_date'>): Promise<string | null> {
    const { data, error: err } = await supabase
      .from('roadmap_phases')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single()

    if (err) return err.message
    setPhases((prev) => prev.map((p) => (p.id === id ? (data as RoadmapPhase) : p)))
    router.refresh()
    return null
  }

  async function addItem(phaseId: string) {
    setError(null)
    const { data, error: err } = await supabase
      .from('roadmap_items')
      .insert({
        phase_id: phaseId,
        task: 'New task',
        status: 'not_started' as RoadmapItemStatus,
        sort_order: itemsOf(phaseId).length,
      })
      .select('*')
      .single()

    if (err) { setError(err.message); return }
    const created = data as RoadmapItem
    setItems((prev) => [...prev, created])
    router.refresh()
    openDrawer({ kind: 'item', id: created.id })
  }

  async function addPhase() {
    setError(null)
    const nextNumber = phases.reduce((max, p) => Math.max(max, p.phase_number), 0) + 1
    const { data, error: err } = await supabase
      .from('roadmap_phases')
      .insert({ phase_number: nextNumber, label: `Phase ${nextNumber}`, title: 'New phase' })
      .select('*')
      .single()

    if (err) { setError(err.message); return }
    const created = data as RoadmapPhase
    setPhases((prev) => [...prev, created])
    router.refresh()
    openDrawer({ kind: 'phase', id: created.id })
  }

  async function runDelete(t: EditTarget) {
    setConfirmDelete(null)
    setError(null)

    if (t.kind === 'item') {
      const { error: err } = await supabase.from('roadmap_items').delete().eq('id', t.id)
      if (err) { setError(err.message); return }
      setItems((prev) => prev.filter((i) => i.id !== t.id))
    } else {
      // Its tasks go with it — removed explicitly rather than relying on a cascade.
      const { error: itemErr } = await supabase.from('roadmap_items').delete().eq('phase_id', t.id)
      if (itemErr) { setError(itemErr.message); return }
      const { error: err } = await supabase.from('roadmap_phases').delete().eq('id', t.id)
      if (err) { setError(err.message); return }
      setItems((prev) => prev.filter((i) => i.phase_id !== t.id))
      setPhases((prev) => prev.filter((p) => p.id !== t.id))
    }

    router.refresh()
    closeDrawer()
  }

  return (
    <main className="page-wide roadmap-page">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Roadmap</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
            Delivery phases, tasks and owners for J-Motion
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
          <button className="btn-ghost" onClick={handlePrint}>Print</button>
          {showEditIcons && <button className="btn-primary" onClick={addPhase}>+ Add phase</button>}
        </div>
      </div>

      <DueTodayStrip items={items} />

      {error && <p style={{ ...ERR_BOX, marginBottom: 16 }}>{error}</p>}

      <PhaseTimeline phases={phases} items={items} />

      {phases.length === 0 && (
        <div className="card" style={{ padding: 32 }}>
          <p style={EMPTY}>No roadmap phases yet</p>
        </div>
      )}

      <div className="roadmap-grid">
        {phases.map((phase) => (
          <PhaseCard
            key={phase.id}
            phase={phase}
            items={itemsOf(phase.id)}
            isAdmin={showEditIcons}
            onEditPhase={() => openDrawer({ kind: 'phase', id: phase.id })}
            onEditItem={(id) => openDrawer({ kind: 'item', id })}
            onAddItem={() => addItem(phase.id)}
          />
        ))}
      </div>

      {/* ── Printable roadmap (A3 landscape) ───────────────────────────────
          Never visible on screen (.roadmap-print is display:none until @media print) and a
          direct child of .roadmap-page, which is what the print rule keys off to hide
          everything else — and which carries the named @page giving this one page A3
          landscape without disturbing the A4 collection sheet on /model-total.

          A3 landscape is wide enough for the real chart, so the print copy is close to the
          screen layout: the Gantt across the full width, then the phase blocks in a row of
          columns beneath it. */}
      <div className="roadmap-print">
        <div className="roadmap-print-header">
          <h1 className="roadmap-print-title">J-Motion Roadmap</h1>
          <p className="roadmap-print-meta">Delivery phases, tasks and owners</p>
          <p className="roadmap-print-meta">
            {phases.length} phase{phases.length !== 1 ? 's' : ''}
            {' · '}{items.length} task{items.length !== 1 ? 's' : ''}
            {' · '}{doneCount} done
            {printedAt ? ` · generated ${printedAt}` : ''}
          </p>
        </div>

        {phases.length === 0 && <p className="roadmap-print-empty">No roadmap phases yet.</p>}

        {/* The same component the screen renders, in its print variant — one source of truth
            for the axis maths, the RDO bands and the Today marker. */}
        <PhaseTimeline phases={phases} items={items} forPrint />

        <div className="roadmap-print-legend">
          <span className="roadmap-print-legend-item">
            <span className="roadmap-print-swatch roadmap-print-swatch-done" />Done
          </span>
          <span className="roadmap-print-legend-item">
            <span className="roadmap-print-swatch roadmap-print-swatch-progress" />In progress
          </span>
          <span className="roadmap-print-legend-item">
            <span className="roadmap-print-swatch roadmap-print-swatch-todo" />Not started
          </span>
          <span className="roadmap-print-legend-item">
            <span className="roadmap-print-swatch roadmap-print-swatch-rdo" />RDO / shutdown
          </span>
          <span className="roadmap-print-legend-item">
            <span className="roadmap-print-swatch roadmap-print-swatch-today" />Today
          </span>
          <span className="roadmap-print-legend-note">
            Each bar is shaded left to right by the share of that phase&rsquo;s tasks in each status.
          </span>
        </div>

        <div className="roadmap-print-phases">
        {phases.map((phase) => {
          const phaseItems = itemsOf(phase.id)
          const phaseDone = phaseItems.filter((i) => i.status === 'done').length
          return (
            <section key={phase.id} className="roadmap-print-phase">
              {/* The only surviving colour — a thin rule in the phase's chart colour, so the
                  phases stay tellable apart without tinting anything a printer has to fill. */}
              <div className="roadmap-print-phase-head" style={{ borderLeftColor: phaseColour(phase.phase_number) }}>
                <h2 className="roadmap-print-phase-title">
                  {phaseName(phase)}{phase.title ? ` — ${phase.title}` : ''}
                </h2>
                {phase.subtitle && <p className="roadmap-print-phase-sub">{phase.subtitle}</p>}
                <p className="roadmap-print-phase-facts">
                  {printDateRange(phase)}
                  {phase.lead ? ` · Lead: ${phase.lead}` : ''}
                  {' · '}{phaseItems.length} task{phaseItems.length !== 1 ? 's' : ''}
                  {phaseItems.length > 0 ? `, ${phaseDone} done` : ''}
                </p>
              </div>

              {phaseItems.length === 0 ? (
                <p className="roadmap-print-empty">No tasks in this phase</p>
              ) : (
                phaseItems.map((item) => (
                  <div key={item.id} className="roadmap-print-task">
                    <div className="roadmap-print-task-head">
                      <span className="roadmap-print-task-name">{item.task}</span>
                      <span className={statusMeta(item.status).print}>{statusMeta(item.status).label}</span>
                    </div>
                    {item.description && <p className="roadmap-print-task-desc">{item.description}</p>}
                    {(item.assigned_to || item.due_date) && (
                      <p className="roadmap-print-task-meta">
                        {item.assigned_to ?? 'Unassigned'}
                        {item.due_date ? ` · Due ${fmtDate(item.due_date)}` : ''}
                      </p>
                    )}
                  </div>
                ))
              )}
            </section>
          )
        })}
        </div>
      </div>

      {target && (
        <>
          <div
            className={'gaps-drawer-overlay' + (visible ? ' gaps-drawer-overlay-visible' : '')}
            style={OVERLAY_TINT}
            onClick={closeDrawer}
          />
          <div className={'gaps-drawer' + (visible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            {editingItem && (
              <TaskForm
                key={editingItem.id}
                item={editingItem}
                phases={phases}
                onSave={(patch) => saveItem(editingItem.id, patch)}
                onDelete={() => setConfirmDelete({ kind: 'item', id: editingItem.id })}
                onClose={closeDrawer}
              />
            )}
            {editingPhase && (
              <PhaseForm
                key={editingPhase.id}
                phase={editingPhase}
                onSave={(patch) => savePhase(editingPhase.id, patch)}
                onDelete={() => setConfirmDelete({ kind: 'phase', id: editingPhase.id })}
                onClose={closeDrawer}
              />
            )}
          </div>
        </>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={confirmDelete.kind === 'item' ? 'Delete task' : 'Delete phase'}
          message={
            confirmDelete.kind === 'item'
              ? 'This task will be removed from the roadmap. This cannot be undone.'
              : 'This phase and every task in it will be removed from the roadmap. This cannot be undone.'
          }
          confirmLabel="Delete"
          danger
          onConfirm={() => runDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </main>
  )
}

// ── Due today strip ───────────────────────────────────────────────────
function DueTodayStrip({ items }: { items: RoadmapItem[] }) {
  const todayIso = useTodayIso()
  // Completed work isn't outstanding, so a task due today that is already done drops out —
  // and if that empties the list, the strip hides just as it does when nothing is due.
  const due = todayIso == null ? [] : items.filter((i) => i.due_date === todayIso && i.status !== 'done')
  if (due.length === 0) return null

  return (
    <div className="roadmap-due-today">
      <span className="roadmap-due-today-label">Due today</span>
      {due.map((item) => (
        <span key={item.id} className="roadmap-due-today-pill">
          {item.assigned_to ? `${item.task} — ${item.assigned_to}` : item.task}
        </span>
      ))}
    </div>
  )
}

// ── Timeline (Gantt) ───────────────────────────────────────────────────
const MS_PER_DAY = 86_400_000
/** Matches .roadmap-timeline-label in globals.css — the bar text needs the track's pixel width
 * to know whether a bar is wide enough to label. */
const TIMELINE_LABEL_COLUMN = 80
/** Print gets a wider gutter: A3 landscape has room for it, and the phase title moves out of
 * the bar and into the label so it is black-on-white rather than white on whatever alpha the
 * bar's leading status segment happens to be. */
const PRINT_LABEL_COLUMN = 170
/** Below this a bar can only show a couple of characters before the ellipsis, so it stays bare. */
const MIN_BAR_LABEL_PX = 80
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Whole days since the epoch. Everything on the axis is measured in these so a bar's position
 * is plain arithmetic, and reading the date parts directly keeps a YYYY-MM-DD column off the
 * timezone shift `new Date(iso)` would apply. */
function isoToDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, m - 1, d) / MS_PER_DAY
}

/** Company RDO / shutdown days, hard-coded for now. Consecutive days are merged into one band
 * so a shutdown week reads as a single block rather than five adjacent slivers. */
const RDO_DATES = [
  '2026-08-14', '2026-08-28', '2026-09-11',
  '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25',
  '2026-10-09', '2026-10-23',
  '2026-11-02', '2026-11-03', '2026-11-20',
  '2026-12-23', '2026-12-24', '2026-12-25', '2026-12-28', '2026-12-29',
]

/** Weekends are shaded from the start of the chart up to this date. */
const WEEKEND_SHADING_END = '2026-12-31'

/** Every Saturday and Sunday in the range, as [start, end) day runs. Sunday follows Saturday,
 * so the merge below folds each weekend into one two-day band without a seam. */
function weekendRuns(fromDay: number, toDay: number): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = []
  for (let day = fromDay; day <= toDay; day++) {
    const weekday = new Date(day * MS_PER_DAY).getUTCDay()
    if (weekday !== 0 && weekday !== 6) continue
    const last = runs[runs.length - 1]
    if (last && day === last.end) last.end = day + 1
    else runs.push({ start: day, end: day + 1 })
  }
  return runs
}

/** Day runs as [start, end) in day numbers — end is exclusive, so a single day spans one day. */
function mergeConsecutive(isoDates: string[]): { start: number; end: number }[] {
  const days = [...new Set(isoDates.map(isoToDay))].sort((a, b) => a - b)
  const runs: { start: number; end: number }[] = []
  for (const day of days) {
    const last = runs[runs.length - 1]
    if (last && day === last.end) last.end = day + 1
    else runs.push({ start: day, end: day + 1 })
  }
  return runs
}

interface TimelineAxis {
  start: number
  /** Exclusive — the first day of the month after the last phase ends. */
  end: number
  total: number
  months: { key: string; label: string; left: number }[]
}

/** The axis spans the earliest start to the latest end, rounded out to whole months so the
 * labels line up with real month boundaries. Null when no phase has both dates. */
function buildAxis(phases: RoadmapPhase[]): TimelineAxis | null {
  const dated = phases.filter((p) => p.start_date && p.end_date)
  if (dated.length === 0) return null

  const earliest = Math.min(...dated.map((p) => isoToDay(p.start_date as string)))
  const latest = Math.max(...dated.map((p) => isoToDay(p.end_date as string)))

  const first = new Date(earliest * MS_PER_DAY)
  const start = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1) / MS_PER_DAY
  const last = new Date(latest * MS_PER_DAY)
  const end = Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1) / MS_PER_DAY
  const total = end - start

  const months: TimelineAxis['months'] = []
  let cursor = start
  while (cursor < end) {
    const at = new Date(cursor * MS_PER_DAY)
    const year = at.getUTCFullYear()
    const month = at.getUTCMonth()
    months.push({
      key: `${year}-${month}`,
      // The year is only repeated where it changes, and on the very first label.
      label: months.length === 0 || month === 0 ? `${MONTH_NAMES[month]} ${year}` : MONTH_NAMES[month],
      left: (cursor - start) / total,
    })
    cursor = Date.UTC(year, month + 1, 1) / MS_PER_DAY
  }

  return { start, end, total, months }
}

/** The phase colours are flat hex, so the 30% background layer is mixed here rather than with
 * opacity on the element — an opaque fill has to sit on top of it without inheriting it. */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(4)}%`
}

/** Today as YYYY-MM-DD, resolved after mount: the server and the browser can disagree about
 * the date across a timezone boundary or over midnight, so anything keyed on "today" would be
 * a hydration mismatch if rendered during SSR. */
function useTodayIso(): string | null {
  const [today, setToday] = useState<string | null>(null)
  useEffect(() => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    setToday(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
  }, [])
  return today
}

function PhaseTimeline({ phases, items, forPrint = false }: {
  phases: RoadmapPhase[]
  items: RoadmapItem[]
  /** Renders the print copy: a wider label gutter, the phase title in that gutter rather than
   * inside the bar, and no width measurement (the print block is display:none right up until
   * the browser snapshots the page, so there is nothing to measure). */
  forPrint?: boolean
}) {
  const axis = useMemo(() => buildAxis(phases), [phases])
  // Every gridline, band and marker is positioned with this, so it has to be the same number
  // the label div is actually laid out at — hence one variable rather than the bare 80s.
  const labelColumn = forPrint ? PRINT_LABEL_COLUMN : TIMELINE_LABEL_COLUMN

  /** phase id → the share of its tasks in each status, as fractions of the bar. A phase with
   * no tasks gets all zeros, leaving the bar's own 20% background showing. */
  const breakdown = useMemo(() => {
    const byPhase = new Map<string, { done: number; inProgress: number; notStarted: number }>()
    for (const phase of phases) {
      const mine = items.filter((i) => i.phase_id === phase.id)
      const total = mine.length
      byPhase.set(phase.id, total === 0 ? { done: 0, inProgress: 0, notStarted: 0 } : {
        done: mine.filter((i) => i.status === 'done').length / total,
        inProgress: mine.filter((i) => i.status === 'in_progress').length / total,
        notStarted: mine.filter((i) => i.status === 'not_started').length / total,
      })
    }
    return byPhase
  }, [phases, items])

  // Bar widths are percentages, but the "is it wide enough to label" test is in pixels — so the
  // track is measured, and re-measured whenever the card resizes.
  const innerRef = useRef<HTMLDivElement>(null)
  const [trackWidth, setTrackWidth] = useState(0)
  useEffect(() => {
    if (forPrint) return
    const el = innerRef.current
    if (!el) return
    const measure = () => setTrackWidth(Math.max(0, el.clientWidth - TIMELINE_LABEL_COLUMN))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [forPrint])

  const todayIso = useTodayIso()
  const today = todayIso == null ? null : isoToDay(todayIso)

  // Every seventh day from the start of the axis, labelled with the day-of-month it begins on.
  // The boundary line at offset 0 is skipped — it would sit on the chart's left edge — but its
  // label is kept, since that week does start the axis.
  const weeks = useMemo(() => {
    if (!axis) return []
    const out: { key: string; left: number; label: string }[] = []
    for (let day = axis.start; day < axis.end; day += 7) {
      out.push({
        key: `${day}`,
        left: (day - axis.start) / axis.total,
        label: String(new Date(day * MS_PER_DAY).getUTCDate()),
      })
    }
    return out
  }, [axis])

  const weekendBands = useMemo(() => {
    if (!axis) return []
    const until = Math.min(isoToDay(WEEKEND_SHADING_END), axis.end - 1)
    return weekendRuns(axis.start, until).map((run) => ({
      key: `${run.start}`,
      left: (run.start - axis.start) / axis.total,
      width: (run.end - run.start) / axis.total,
    }))
  }, [axis])

  const rdoBands = useMemo(() => {
    if (!axis) return []
    return mergeConsecutive(RDO_DATES)
      .filter((run) => run.end > axis.start && run.start < axis.end)
      .map((run) => ({
        key: `${run.start}`,
        left: (run.start - axis.start) / axis.total,
        width: (run.end - run.start) / axis.total,
      }))
  }, [axis])

  if (!axis) return null

  const todayFraction = today == null ? null : (today - axis.start) / axis.total
  const showToday = todayFraction != null && todayFraction >= 0 && todayFraction <= 1

  return (
    <section className={forPrint ? 'roadmap-timeline roadmap-timeline-print' : 'card roadmap-timeline'}>
      <div className="roadmap-timeline-scroll">
        <div className="roadmap-timeline-inner" ref={innerRef}>
          {/* Underlay: these come first so the bars, month labels and today marker — all
              positioned elements too — paint over them. */}
          {weekendBands.map((band) => (
            <div
              key={`weekend-${band.key}`}
              className="roadmap-timeline-rdo"
              style={{
                left: `calc(${labelColumn}px + (100% - ${labelColumn}px) * ${band.left})`,
                width: `calc((100% - ${labelColumn}px) * ${band.width})`,
              }}
            />
          ))}
          {rdoBands.map((band) => (
            <div
              key={`rdo-${band.key}`}
              className="roadmap-timeline-rdo"
              style={{
                left: `calc(${labelColumn}px + (100% - ${labelColumn}px) * ${band.left})`,
                width: `calc((100% - ${labelColumn}px) * ${band.width})`,
              }}
            />
          ))}
          {weeks.filter((w) => w.left > 0).map((w) => (
            <div
              key={`week-${w.key}`}
              className="roadmap-timeline-week"
              style={{ left: `calc(${labelColumn}px + (100% - ${labelColumn}px) * ${w.left})` }}
            />
          ))}
          {axis.months.filter((m) => m.left > 0).map((m) => (
            <div
              key={`month-line-${m.key}`}
              className="roadmap-timeline-month-line"
              style={{ left: `calc(${labelColumn}px + (100% - ${labelColumn}px) * ${m.left})` }}
            />
          ))}

          <div className="roadmap-timeline-row roadmap-timeline-months">
            <div className="roadmap-timeline-label" style={{ width: labelColumn }} />
            <div className="roadmap-timeline-track" style={{ height: 18 }}>
              {axis.months.map((m) => (
                <span key={m.key} className="roadmap-timeline-month" style={{ left: pct(m.left) }}>
                  {m.label}
                </span>
              ))}
            </div>
          </div>

          <div className="roadmap-timeline-row roadmap-timeline-weeks">
            <div className="roadmap-timeline-label" style={{ width: labelColumn }} />
            <div className="roadmap-timeline-track" style={{ height: 13 }}>
              {weeks.map((w) => (
                <span key={w.key} className="roadmap-timeline-week-label" style={{ left: pct(w.left) }}>
                  {w.label}
                </span>
              ))}
            </div>
          </div>

          {phases.map((phase) => {
            const hasDates = Boolean(phase.start_date && phase.end_date)
            const from = hasDates ? isoToDay(phase.start_date as string) : 0
            // Inclusive of the end date — a phase ending on the 31st fills the 31st.
            const to = hasDates ? isoToDay(phase.end_date as string) + 1 : 0
            const widthFraction = hasDates ? (to - from) / axis.total : 0
            // In print the title lives in the gutter, so the in-bar label is never drawn — it is
            // white text over whichever status segment happens to sit under it, which is a
            // coin-toss for contrast once the pale "not started" shade is the one underneath.
            const showBarLabel = !forPrint && Boolean(phase.title) && widthFraction * trackWidth >= MIN_BAR_LABEL_PX

            return (
              <div key={phase.id} className="roadmap-timeline-row roadmap-timeline-bars">
                <div className="roadmap-timeline-label" style={{ width: labelColumn }}>
                  {forPrint && phase.title ? `${phaseName(phase)} — ${phase.title}` : (phase.label || `Phase ${phase.phase_number}`)}
                </div>
                <div className="roadmap-timeline-track" style={{ height: 36 }}>
                  {hasDates ? (
                    <div
                      className="roadmap-timeline-bar"
                      style={{
                        left: pct((from - axis.start) / axis.total),
                        width: pct(widthFraction),
                        background: withAlpha(phaseColour(phase.phase_number), 0.2),
                      }}
                      title={`${phase.title || phaseName(phase)} — ${dateRangeSentence(phase) ?? ''}`}
                    >
                      <span className="roadmap-timeline-bar-segments">
                        {(() => {
                          const share = breakdown.get(phase.id) ?? { done: 0, inProgress: 0, notStarted: 0 }
                          const colour = phaseColour(phase.phase_number)
                          // Laid out as a flex row so the three shares tile the bar exactly,
                          // with no sub-pixel seam between them.
                          return ([
                            ['done', share.done, 1],
                            ['in-progress', share.inProgress, 0.6],
                            ['not-started', share.notStarted, 0.2],
                          ] as const).map(([key, fraction, alpha]) => (
                            <span
                              key={key}
                              className="roadmap-timeline-bar-segment"
                              style={{ width: pct(fraction), background: withAlpha(colour, alpha) }}
                            />
                          ))
                        })()}
                      </span>
                      {showBarLabel && <span className="roadmap-timeline-bar-label">{phase.title}</span>}
                    </div>
                  ) : (
                    <span className="roadmap-timeline-empty">No dates set</span>
                  )}
                </div>
              </div>
            )
          })}

          {showToday && (
            <div
              className="roadmap-timeline-today"
              style={{ left: `calc(${labelColumn}px + (100% - ${labelColumn}px) * ${todayFraction})` }}
            >
              <span className="roadmap-timeline-today-label">Today</span>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

// ── Phase card ─────────────────────────────────────────────────────────
function PhaseCard({
  phase, items, isAdmin, onEditPhase, onEditItem, onAddItem,
}: {
  phase: RoadmapPhase
  items: RoadmapItem[]
  isAdmin: boolean
  onEditPhase: () => void
  onEditItem: (id: string) => void
  onAddItem: () => void
}) {
  const dates = dateRangeSentence(phase)

  return (
    <section className="card roadmap-card">
      <div className="roadmap-card-header">
        <div className="roadmap-card-pill-row">
          <span className="roadmap-phase-pill" style={{ background: phaseColour(phase.phase_number) }}>
            {phaseName(phase)}
          </span>
          {isAdmin && (
            <button className="row-icon-button" onClick={onEditPhase} title="Edit phase" aria-label="Edit phase">
              <PencilIcon />
            </button>
          )}
        </div>

        <h2 className="roadmap-card-title">{phase.title || '—'}</h2>
        {phase.subtitle && <p className="roadmap-card-subtitle">{phase.subtitle}</p>}
        {dates && <p className="roadmap-card-dates">{dates}</p>}
        {phase.lead && (
          <p className="roadmap-card-lead">
            <span style={{ color: 'var(--text-muted)' }}>Lead: </span>
            <strong style={{ fontWeight: 600 }}>{phase.lead}</strong>
          </p>
        )}
      </div>

      <div className="roadmap-tasks">
        {items.map((item) => (
          <div key={item.id} className="roadmap-task">
            <div className="roadmap-task-head">
              <span className="roadmap-task-name">{item.task}</span>
              {isAdmin && (
                <button
                  className="row-icon-button" onClick={() => onEditItem(item.id)}
                  title="Edit task" aria-label={`Edit ${item.task}`}
                >
                  <PencilIcon />
                </button>
              )}
            </div>

            {item.description && <p className="roadmap-task-desc">{item.description}</p>}

            <div className="roadmap-task-meta">
              <span className={statusMeta(item.status).badge}>{statusMeta(item.status).label}</span>
              {item.assigned_to && <span className="roadmap-task-meta-text">{item.assigned_to}</span>}
              {item.due_date && <span className="roadmap-task-meta-text">Due {fmtDate(item.due_date)}</span>}
            </div>
          </div>
        ))}

        {items.length === 0 && <p style={EMPTY}>No tasks in this phase</p>}
      </div>

      {isAdmin && (
        <div className="roadmap-card-footer">
          <button className="btn-ghost" onClick={onAddItem}>+ Add task</button>
        </div>
      )}
    </section>
  )
}

// ── Drawer: task form ──────────────────────────────────────────────────
function TaskForm({
  item, phases, onSave, onDelete, onClose,
}: {
  item: RoadmapItem
  phases: RoadmapPhase[]
  onSave: (patch: Omit<RoadmapItem, 'id' | 'created_at' | 'sort_order'>) => Promise<string | null>
  onDelete: () => void
  onClose: () => void
}) {
  const [task, setTask] = useState(item.task)
  const [description, setDescription] = useState(item.description ?? '')
  const [assignedTo, setAssignedTo] = useState(item.assigned_to ?? '')
  const [due, setDue] = useState(item.due_date ?? '')
  const [status, setStatus] = useState<RoadmapItemStatus>(item.status)
  const [phaseId, setPhaseId] = useState(item.phase_id)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (task.trim() === '') { setError('A task needs a name.'); return }
    const parsedDue = parseIsoDate(due)
    if (!parsedDue.ok) { setError('Due date must be a real date in YYYY-MM-DD format.'); return }

    setSaving(true)
    setError(null)
    const message = await onSave({
      phase_id: phaseId,
      task: task.trim(),
      description: trimOrNull(description),
      assigned_to: trimOrNull(assignedTo),
      due_date: parsedDue.value,
      status,
    })
    setSaving(false)
    if (message) setError(message)
    else onClose()
  }

  return (
    <DrawerShell title="Edit task" subtitle={item.task} onClose={onClose} onDelete={onDelete} deleteLabel="Delete task" saving={saving} onSave={handleSave}>
      {error && <p style={{ ...ERR_BOX, marginBottom: 14 }}>{error}</p>}

      <div style={FIELD}>
        <label className="label" htmlFor="rm-task">Task</label>
        <input id="rm-task" className="input" value={task} onChange={(e) => setTask(e.target.value)} disabled={saving} />
      </div>

      <div style={FIELD}>
        <label className="label" htmlFor="rm-description">Description</label>
        <textarea
          id="rm-description" className="input" rows={4} value={description}
          onChange={(e) => setDescription(e.target.value)} disabled={saving}
          style={{ resize: 'vertical', lineHeight: 1.5 }}
        />
      </div>

      <div style={FIELD}>
        <label className="label" htmlFor="rm-assigned">Assigned to</label>
        <input id="rm-assigned" className="input" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} placeholder="Name" disabled={saving} />
      </div>

      <div style={FIELD}>
        <label className="label" htmlFor="rm-due">Due date</label>
        <input id="rm-due" type="date" className="input" value={due} onChange={(e) => setDue(e.target.value)} disabled={saving} />
      </div>

      <div style={FIELD}>
        <label className="label" htmlFor="rm-status">Status</label>
        <select
          id="rm-status" className="select" style={{ width: '100%' }} value={status}
          onChange={(e) => setStatus(e.target.value as RoadmapItemStatus)} disabled={saving}
        >
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      <div style={FIELD}>
        <label className="label" htmlFor="rm-phase">Move to phase</label>
        <select
          id="rm-phase" className="select" style={{ width: '100%' }} value={phaseId}
          onChange={(e) => setPhaseId(e.target.value)} disabled={saving}
        >
          {phases.map((p) => (
            <option key={p.id} value={p.id}>
              {phaseName(p) + (p.title ? ` — ${p.title}` : '')}
            </option>
          ))}
        </select>
      </div>
    </DrawerShell>
  )
}

// ── Drawer: phase form ─────────────────────────────────────────────────
function PhaseForm({
  phase, onSave, onDelete, onClose,
}: {
  phase: RoadmapPhase
  onSave: (patch: Pick<RoadmapPhase, 'label' | 'title' | 'subtitle' | 'lead' | 'start_date' | 'end_date'>) => Promise<string | null>
  onDelete: () => void
  onClose: () => void
}) {
  const [label, setLabel] = useState(phase.label)
  const [title, setTitle] = useState(phase.title)
  const [subtitle, setSubtitle] = useState(phase.subtitle ?? '')
  const [lead, setLead] = useState(phase.lead ?? '')
  const [startDate, setStartDate] = useState(phase.start_date ?? '')
  const [endDate, setEndDate] = useState(phase.end_date ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (label.trim() === '') { setError('A phase needs a pill label.'); return }
    const parsedStart = parseIsoDate(startDate)
    const parsedEnd = parseIsoDate(endDate)
    if (!parsedStart.ok || !parsedEnd.ok) {
      setError('Dates must be real dates in YYYY-MM-DD format.')
      return
    }
    if (parsedStart.value && parsedEnd.value && parsedEnd.value < parsedStart.value) {
      setError('The end date is before the start date.')
      return
    }

    setSaving(true)
    setError(null)
    const message = await onSave({
      label: label.trim(),
      title: title.trim(),
      subtitle: trimOrNull(subtitle),
      lead: trimOrNull(lead),
      start_date: parsedStart.value,
      end_date: parsedEnd.value,
    })
    setSaving(false)
    if (message) setError(message)
    else onClose()
  }

  return (
    <DrawerShell title="Edit phase" subtitle={phase.title} onClose={onClose} onDelete={onDelete} deleteLabel="Delete phase" saving={saving} onSave={handleSave}>
      {error && <p style={{ ...ERR_BOX, marginBottom: 14 }}>{error}</p>}

      <div style={FIELD}>
        <label className="label" htmlFor="rm-label">Pill label</label>
        <input id="rm-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Phase 1" disabled={saving} />
      </div>

      <div style={FIELD}>
        <label className="label" htmlFor="rm-title">Title</label>
        <input id="rm-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} />
      </div>

      <div style={FIELD}>
        <label className="label" htmlFor="rm-subtitle">Subtitle</label>
        <input id="rm-subtitle" className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} disabled={saving} />
      </div>

      <div style={FIELD}>
        <label className="label" htmlFor="rm-lead">Lead</label>
        <input id="rm-lead" className="input" value={lead} onChange={(e) => setLead(e.target.value)} placeholder="Name" disabled={saving} />
      </div>

      <div style={FIELD}>
        <label className="label" htmlFor="rm-start">Start date</label>
        <input id="rm-start" type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={saving} />
      </div>

      <div style={FIELD}>
        <label className="label" htmlFor="rm-end">End date</label>
        <input id="rm-end" type="date" className="input" value={endDate} onChange={(e) => setEndDate(e.target.value)} disabled={saving} />
      </div>
    </DrawerShell>
  )
}

// ── Drawer chrome shared by both forms ─────────────────────────────────
function DrawerShell({
  title, subtitle, saving, deleteLabel, onSave, onDelete, onClose, children,
}: {
  title: string
  subtitle?: string | null
  saving: boolean
  deleteLabel: string
  onSave: () => void
  onDelete: () => void
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <>
      <div className="gaps-drawer-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="gaps-drawer-title">{title}</div>
          {subtitle && <div className="gaps-drawer-jobname">{subtitle}</div>}
        </div>
        <button className="gaps-drawer-close" onClick={onClose} aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="gaps-drawer-body" style={{ padding: '16px 20px', flex: 1 }}>{children}</div>

      <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="btn-ghost" onClick={onDelete} disabled={saving} style={{ color: 'var(--red)' }}>{deleteLabel}</button>
        <button className="btn-primary" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </>
  )
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}
