'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import ConfirmDialog from './ConfirmDialog'
import {
  MergeConfirm, MergeFooter, MergeNotices, MergeRowItem, useMergeMode, type MergeRow,
} from './MergeMode'
import { plural } from '@/lib/format'
import {
  countJobsInSectionByState, createSection, deleteSection, isSectionTray, moveSection, renameSection,
  sectionMergeGroupKey, teamForJob,
} from '@/lib/sections'
import { jobMergeGroupKey } from '@/lib/jobs'
import type { Job, Operation, Section, Team } from '@/lib/types'

/**
 * The shared drill-down panes — the Finder-style columns /setup walks its structure with
 * (Sections → Jobs → Operations → Models) and /tryouts walks one van with (Sections → Jobs →
 * Operations, with running stopwatches instead of a fourth pane).
 *
 * Pane 1 and pane 2 are literally the same components on both screens: a section list that
 * creates/renames/reorders/deletes through lib/sections, and a job list whose row is "show me
 * this job's operations". Pane 3 differs (the two screens do genuinely different work with an
 * operation), so each owns its own — but both build it out of the `Pane` shell and the
 * .finder-row markup here, which is what keeps the columns looking and behaving like one
 * screen rather than two that resemble each other.
 *
 * Every callback a screen doesn't need is optional: /tryouts has no job-edit drawer and no
 * delete rights to offer, and passing nothing simply leaves those affordances off the row.
 */

type SupabaseClient = ReturnType<typeof createClient>

/** Inline row-edit input — the same look wherever a pane row turns into a text field. */
export const ROW_INPUT: React.CSSProperties = {
  fontSize: 13, fontWeight: 600, fontFamily: 'inherit', color: 'var(--text)',
  background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 6,
  padding: '2px 6px', width: '100%', minWidth: 0, outline: 'none',
}

export const PANE_ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}

/**
 * The virtual first-pane entry that holds every job with no section — either because the line
 * has no sections at all (Caravan, Motor Home), or because the job hasn't been placed in the walk
 * yet. It is not a `sections` row: it can't be renamed, reordered or deleted, and selecting it
 * means "section_id IS NULL" in the pane to its right.
 */
export const UNSECTIONED_KEY = '__unsectioned__'

/** One row of pane 1 — a real section, or the virtual Unsectioned bucket (section === null). */
export interface SectionEntry {
  key: string
  name: string
  section: Section | null
  /** Jobs under it within the current filter — i.e. exactly what pane 2 will list. */
  jobCount: number
}

/** Re-exported from lib/format, where it now lives — every existing `import { plural } from
 * '@/components/FinderPanes'` still resolves. */
export { plural }

/** The small ✎ that turns a pane row into an inline text field. */
export function RenameButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      className="finder-row-action"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      style={{ fontSize: 12 }}
    >
      ✎
    </button>
  )
}

/** The pulsing dot that marks a row with a stopwatch running somewhere beneath it — on the
 * operation itself, and on the job and section containing it, so navigating away from a running
 * timer still leaves a trail back to it. */
export function RunningDot({ title }: { title: string }) {
  return <span className="finder-running-dot" title={title} aria-label={title} />
}

/**
 * The shared pane filter box — the search field that sits above a pane's rows and narrows them
 * as it is typed. Pane 2's job search on all three screens (/setup, /tryouts, /collect) is this
 * one control, so the three can't drift into three slightly different ideas of what a search
 * does; it is styled and placed to match /setup's operation search in the filter bar above.
 *
 * It filters what is already loaded and never refetches — the list it narrows is the current
 * section/line/team scope's, already in hand, so it is instant and a cleared box restores the
 * full list with no round trip.
 */
export function PaneSearch({
  value, placeholder, ariaLabel, onChange,
}: {
  value: string
  placeholder: string
  ariaLabel: string
  onChange: (value: string) => void
}) {
  return (
    <div className="finder-pane-search">
      <input
        className="input"
        type="search"
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // These panes sit inside screens whose footers are real forms (add section, add job);
        // Enter in a filter box means "I've finished typing", never "submit".
        onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
      />
    </div>
  )
}

/**
 * A job's team, as a name — derived through its SECTION, which is where a team lives. One
 * function so every pane row, on all three screens, answers "whose job is this?" the same way.
 *
 * A job with no section at all reads "Unsorted", not "No team": it isn't a job somebody forgot
 * to staff, it is a job nobody has filed anywhere yet, and the two are worth telling apart. A job
 * sitting in a team's unsorted TRAY does read that team's name — a tray belongs to a team like
 * any other section (see lib/sections), so the work in it is already that team's, just unsorted.
 *
 * jobs.teams (the joined row behind jobs.team_id) is used ONLY when the caller supplies no
 * lookups — a legacy path no screen takes today.
 */
export function teamNameForJob(
  job: Job,
  sectionsById?: Map<string, { team_id: string | null }>,
  teamNameById?: Map<string, string>
): string {
  if (sectionsById && teamNameById) {
    const teamId = teamForJob(job, sectionsById)
    return teamId ? teamNameById.get(teamId) ?? 'No team' : 'Unsorted'
  }
  return job.teams?.name ?? 'No team'
}

/** What every pane search matches on: the term anywhere in the name, case-insensitive. A blank
 * term matches everything, so an empty box is the unfiltered list. */
export function filterByName<T extends { name: string }>(items: T[], search: string): T[] {
  const term = search.trim().toLowerCase()
  if (!term) return items
  return items.filter((i) => i.name.toLowerCase().includes(term))
}

/** One pane: fixed header, scrolling body, optional pinned footer of actions. */
export function Pane({
  title, subtitle, active, children, footer,
}: {
  title: string
  subtitle: React.ReactNode
  /** True once this pane has something selected — a quiet border cue, not a second selection. */
  active: boolean
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className={'finder-pane' + (active ? ' finder-pane-active' : '')}>
      <div className="finder-pane-header">
        <div className="finder-pane-title">{title}</div>
        <div className="finder-pane-sub">{subtitle}</div>
      </div>
      <div className="finder-pane-body">{children}</div>
      {footer && <div className="finder-pane-footer">{footer}</div>}
    </div>
  )
}

// ── Pane 1: Sections ─────────────────────────────────────────────────────────────────────────
/**
 * The line's walk order, plus the virtual "Unsectioned" bucket. Every write goes through the
 * shared lib/sections helpers, so the rules (what sort_order a new section gets, how a reorder
 * renumbers, what blocks a delete) live in one place.
 *
 * Both production_line_id and team_id are NOT NULL on the table, so with no line in scope there
 * is no section to create: the add form is replaced by a prompt to pick one. The Unsectioned entry
 * is not a row in `sections` and is never editable, reorderable or deletable.
 *
 * `readOnly` turns the pane into pure navigation — the line's sections in walk order, selectable,
 * with no add/rename/reorder/delete anywhere on it. A section is line-level structure, not
 * something to be restructured while walking a single van, and a Delete button sitting next to
 * the section you are drilling through is a footgun with no upside. Section editing lives on
 * /setup, which mounts the same component writable.
 *
 * `allowAdd` re-opens the footer's add form on top of `readOnly`, and nothing else: creating a
 * section only ever appends one, so it can't reorder or destroy anything already on the line.
 * That's how /tryouts mounts it — a van being walked can turn out to need a step the line
 * doesn't have yet, and having to leave for /setup mid-walk breaks the flow. Rename, reorder
 * and delete stay behind `readOnly`, off.
 */
export function SectionsPane({
  supabase, entries, sections, productionLineId, productionLineName, teams, selectedKey,
  runningKeys, readOnly = false, allowAdd = false, allowMerge = false,
  defaultTeamId = '', onSelect, onChanged,
}: {
  supabase: SupabaseClient
  entries: SectionEntry[]
  /** The real sections behind those entries, in walk order — what a reorder writes against. */
  sections: Section[]
  productionLineId: string
  productionLineName: string | null
  /** The scoped line's teams — a section's team is required, so an empty list blocks creation. */
  teams: Team[]
  selectedKey: string
  /** Entry keys with a stopwatch running somewhere under them. */
  runningKeys?: Set<string>
  /** Navigation only — no add form, no per-row rename/reorder/delete. */
  readOnly?: boolean
  /** With `readOnly`, brings back the add form alone — create-only, still no rename/reorder/delete. */
  allowAdd?: boolean
  /**
   * Brings back the footer's Merge button on top of `readOnly`, the same way `allowAdd` brings
   * back the add form — and for the same reason. A merge is not a restructure of the walk: it
   * folds several sections' jobs into one section on the SAME team and retires the emptied ones,
   * so no job changes team, nothing is deleted, and the walk a van is mid-way through keeps every
   * step it had. All three screens that mount this pane pass it, because finding two sections
   * that should be one happens while walking a van or collecting coverage at least as often as it
   * does on /setup, and sending the user to another screen to fix it loses the flow.
   *
   * No user is needed: a section merge repoints jobs.section_id and flips sections.is_active, and
   * never touches a recorded time — so the time-ownership guard that gates an OPERATION merge
   * does not apply here. See the note at the top of lib/sections.
   */
  allowMerge?: boolean
  /**
   * The team the host screen is already filtered to. When set, the add form uses it and stops
   * asking: on /tryouts the team is chosen in the filter bar above these panes, and asking for
   * it again is a question the screen already knows the answer to — one that can also be
   * answered differently, producing a section under a team the filter then hides.
   *
   * '' (the "All teams" filter, and /setup's default) means there is no answer to inherit, so
   * the team select comes back and a section still can't be created without one.
   */
  defaultTeamId?: string
  onSelect: (key: string) => void
  onChanged: () => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [busySectionId, setBusySectionId] = useState<string | null>(null)

  const [addingOpen, setAddingOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newTeamId, setNewTeamId] = useState('')
  const [creating, setCreating] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const [blockedDelete, setBlockedDelete] = useState<
    { name: string; jobCount: number; retiredCount: number } | null
  >(null)
  const [confirmDelete, setConfirmDelete] = useState<Section | null>(null)

  // One team on the line → nothing to choose, so preselect it.
  useEffect(() => {
    if (teams.length === 1) setNewTeamId(teams[0].id)
    else if (!teams.some((t) => t.id === newTeamId)) setNewTeamId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams])

  const teamNameById = useMemo(() => new Map(teams.map((t) => [t.id, t.name])), [teams])

  /** The inherited team, once it's confirmed to be one of this line's — a filter left over from
   * another line must not silently stamp a section with a team that doesn't belong to it. */
  const pinnedTeamId = defaultTeamId && teams.some((t) => t.id === defaultTeamId) ? defaultTeamId : ''
  /** What a new section will actually be created under: the inherited team, or the one picked here. */
  const createTeamId = pinnedTeamId || newTeamId

  const sectionIndex = useMemo(() => new Map(sections.map((s, i) => [s.id, i])), [sections])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim() || !createTeamId) return
    setCreating(true); setError(null)
    try {
      const created = await createSection(supabase, { name: newName, productionLineId, teamId: createTeamId })
      setNewName('')
      setAddingOpen(false)
      await onChanged()
      // Land on what was just created: a new section is empty by definition, so the next thing
      // wanted is always the pane to the right of it.
      onSelect(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create section')
    } finally {
      setCreating(false)
    }
  }

  async function handleRename(section: Section) {
    const trimmed = editDraft.trim()
    if (!trimmed || trimmed === section.name) { setEditingId(null); return }
    setBusySectionId(section.id); setError(null)
    try {
      await renameSection(supabase, section.id, trimmed)
      setEditingId(null)
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename section')
    } finally {
      setBusySectionId(null)
    }
  }

  async function handleMove(section: Section, direction: -1 | 1) {
    setBusySectionId(section.id); setError(null)
    try {
      await moveSection(supabase, sections, section.id, direction)
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reorder sections')
    } finally {
      setBusySectionId(null)
    }
  }

  /** Re-counts before asking: the pane's count is scoped to the current filter, and a section
   * deleted out from under jobs the filter hides would leave them pointing at nothing. */
  async function requestDelete(section: Section) {
    setBusySectionId(section.id); setError(null)
    try {
      // SPLIT by is_active, because the two blockers need different sentences: this pane lists
      // live jobs only, so a retired one blocking the delete is invisible here and "still has 1
      // job assigned" is an instruction the user cannot follow. /line-config is the screen that
      // can reveal and move them; this one says so.
      const { active, retired } = await countJobsInSectionByState(supabase, section.id)
      if (active > 0 || retired > 0) {
        setBlockedDelete({ name: section.name, jobCount: active, retiredCount: retired })
      } else setConfirmDelete(section)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check this section for jobs')
    } finally {
      setBusySectionId(null)
    }
  }

  async function handleDelete(section: Section) {
    setConfirmDelete(null)
    setBusySectionId(section.id); setError(null)
    try {
      await deleteSection(supabase, section.id)
      await onChanged()
    } catch (err) {
      // Includes an RLS rejection: the delete succeeds having removed nothing, which
      // deleteSection turns into this message rather than letting the list quietly refresh
      // unchanged.
      setError(err instanceof Error ? err.message : 'Could not delete section')
    } finally {
      setBusySectionId(null)
    }
  }

  /** Creating appends and can't disturb the existing walk, so it survives `readOnly` when a
   * caller asks for it — unlike rename/reorder/delete, which stay gated on `readOnly` alone. */
  const canAdd = !readOnly || allowAdd

  /**
   * The rows merge mode may offer. Only real sections: an unsorted tray can be neither side of a
   * merge (merging it away leaves its team with no inbox; merging INTO it files sorted work back
   * as unsorted), so it is carried with a null groupKey and the reason, rather than hidden — a
   * row that can't be ticked should say why. Which rows are trays is asked of lib/sections'
   * isSectionTray, never of team_id: every tray has a real team now.
   *
   * The group is team + line, which is the whole same-team rule: a job's team IS its section's
   * team, so folding across teams would silently re-team every job that moved.
   */
  const mergeRows = useMemo<MergeRow<Section>[]>(() => (
    entries.flatMap((entry) => {
      const section = entry.section
      if (!section) return []
      if (isSectionTray(section)) {
        return [{
          id: entry.key, name: entry.name, groupKey: null, subject: section,
          ineligibleReason: 'This is the team’s unsorted tray, not a step of the walk — it can’t be merged.',
        }]
      }
      return [{
        id: entry.key,
        name: entry.name,
        // The rule itself, straight from lib/sections — the same function mergeSections
        // re-checks with, so the pane can't offer a merge the write path would refuse.
        groupKey: sectionMergeGroupKey(section),
        subject: section,
        ineligibleReason: 'This section has no team, so there is nothing it can safely be merged with.',
      }]
    })
  ), [entries])

  const merge = useMergeMode({ level: 'section', supabase, rows: mergeRows, onMerged: async () => { await onChanged() } })
  const canMerge = allowMerge

  /**
   * The count in the header is the count of `sections` ROWS RENDERED — trays included.
   *
   * It used to exclude them, on the reasoning that a tray isn't a step of the walk, and the
   * header then disagreed with the pane under it: /setup → Motor Home → Cab rendered the Cab
   * team's tray and its one real section and called that "1 section". A header that contradicts
   * the rows it sits above reads as a bug in the list, and the tray is a row the user selects and
   * works in like any other — so the number counts what is on screen.
   *
   * The one row it can't count is the virtual "No section" / "All jobs" bucket (entry.section
   * null), which is not a row in `sections` at all — no id, nothing to add up. A line whose only
   * row is that bucket still reads "no sections", which is exactly what it has.
   */
  const sectionRowCount = entries.filter((entry) => entry.section).length
  const subtitle = merge.active
    ? `${productionLineName ?? 'All lines'} · ${merge.subtitle}`
    : productionLineName
      ? `${productionLineName} · ${sectionRowCount === 0 ? 'no sections' : plural(sectionRowCount, 'section')}`
      : 'All production lines'

  return (
    <>
      <Pane
        title="Sections"
        subtitle={subtitle}
        active={merge.active ? merge.count > 0 : Boolean(selectedKey)}
        footer={
          // Merge mode owns the whole footer while it is on: the add form and the walk's
          // reorder/delete affordances have no meaning mid-selection.
          merge.active ? <MergeFooter merge={merge} />
          : !canAdd ? (canMerge ? <MergeFooter merge={merge} /> : undefined) : productionLineId ? (
            addingOpen ? (
              <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                <input
                  autoFocus
                  className="input"
                  placeholder="Section name"
                  style={{ fontSize: 12, padding: '5px 8px' }}
                  value={newName}
                  disabled={creating}
                  onChange={(e) => setNewName(e.target.value)}
                />
                {/* Nothing to ask when the host screen is already filtered to a team — it is
                    stated instead, so the section's team is still visible before it's created. */}
                {pinnedTeamId ? (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Team: <strong style={{ color: 'var(--text-mid)' }}>{teamNameById.get(pinnedTeamId)}</strong> — from the filter above.
                  </span>
                ) : (
                  <select
                    className="select"
                    style={{ fontSize: 12, padding: '5px 8px', width: '100%' }}
                    value={newTeamId}
                    disabled={creating}
                    onChange={(e) => setNewTeamId(e.target.value)}
                  >
                    <option value="">— Select a team —</option>
                    {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="submit" className="btn-primary" style={{ padding: '6px 11px', fontSize: 12 }} disabled={creating || !newName.trim() || !createTeamId}>
                    {creating ? 'Adding…' : 'Add section'}
                  </button>
                  <button type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} disabled={creating} onClick={() => { setAddingOpen(false); setNewName('') }}>
                    Cancel
                  </button>
                </div>
                {teams.length === 0 && !pinnedTeamId && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    This line has no teams yet — a section needs one, so add a team first.
                  </span>
                )}
              </form>
            ) : (
              // The two bottom-of-pane actions, side by side — the one place a merge is started.
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => { setAddingOpen(true); setError(null) }}>
                  + Add section
                </button>
                {canMerge && <MergeFooter merge={merge} />}
              </div>
            )
          ) : readOnly ? undefined : (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Pick a production line above to add, reorder or delete sections.
            </span>
          )
        }
      >
        {error && <p style={{ ...PANE_ERR_BOX, margin: '10px 12px', fontSize: 12 }}>{error}</p>}
        <MergeNotices merge={merge} />

        {entries.length === 0 ? (
          <p className="finder-pane-empty">
            {productionLineId
              ? 'This line has no sections and no jobs yet.'
              : 'Select a production line to see its sections.'}
          </p>
        ) : merge.active ? (
          mergeRows.map((row) => (
            <MergeRowItem
              key={row.id}
              merge={merge}
              row={row}
              meta={`${teamNameById.get(row.subject.team_id ?? '') ?? 'No team'} · ${plural(entries.find((e) => e.key === row.id)?.jobCount ?? 0, 'job')}`}
            />
          ))
        ) : (
          entries.map((entry) => {
            const section = entry.section
            const isSelected = entry.key === selectedKey
            const isBusy = section ? busySectionId === section.id : false
            const index = section ? sectionIndex.get(section.id) ?? 0 : -1
            // An unsorted tray is a real row, but it is system structure, not a step of the
            // walk: it can't be renamed, reordered or deleted, and it is marked so it doesn't
            // read as just another section that happens to be called "No Section". Asked of
            // lib/sections' isSectionTray — the one definition — and never of team_id, which
            // every tray now has.
            const isTray = isSectionTray(section)
            // The section when it may be edited, null otherwise — carried as the row itself
            // rather than a boolean so the JSX below keeps its non-null narrowing.
            const editableSection = !readOnly && !isTray ? section : null

            return (
              <div
                key={entry.key}
                className={'finder-row' + (isSelected ? ' finder-row-selected' : '')}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(entry.key)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(entry.key) } }}
              >
                <span className="finder-row-main">
                  {editableSection && (
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button" title="Move up" disabled={isBusy || index === 0}
                        onClick={() => handleMove(editableSection, -1)}
                        style={{ background: 'none', border: 'none', padding: 0, lineHeight: 1, fontSize: 10, cursor: index === 0 ? 'default' : 'pointer', color: index === 0 ? 'var(--border)' : 'var(--text-muted)' }}
                      >
                        ▲
                      </button>
                      <button
                        type="button" title="Move down" disabled={isBusy || index === sections.length - 1}
                        onClick={() => handleMove(editableSection, 1)}
                        style={{ background: 'none', border: 'none', padding: 0, lineHeight: 1, fontSize: 10, cursor: index === sections.length - 1 ? 'default' : 'pointer', color: index === sections.length - 1 ? 'var(--border)' : 'var(--text-muted)' }}
                      >
                        ▼
                      </button>
                    </span>
                  )}
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                    {editableSection && editingId === editableSection.id ? (
                      <input
                        autoFocus
                        style={ROW_INPUT}
                        value={editDraft}
                        disabled={isBusy}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') { e.preventDefault(); handleRename(editableSection) }
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        onBlur={() => handleRename(editableSection)}
                      />
                    ) : (
                      <>
                        <span className="finder-row-name">
                          {entry.name}
                          {isTray && <span className="badge badge-grey" style={{ marginLeft: 6 }}>Unsorted</span>}
                          {runningKeys?.has(entry.key) && <RunningDot title="A timer is running in this section" />}
                        </span>
                        <span className="finder-row-meta">
                          {/* A tray names its team like every other row. It has one now — one
                              tray per team — and with no Team filter on, a line shows several
                              trays at the top of the pane that are otherwise identical. */}
                          {isTray && section
                            ? `${teamNameById.get(section.team_id ?? '') ?? 'No team'} · not sorted yet · ${plural(entry.jobCount, 'job')}`
                            : section
                              ? `${teamNameById.get(section.team_id ?? '') ?? 'No team'} · ${plural(entry.jobCount, 'job')}`
                              : `${productionLineId ? 'Jobs with no section' : 'Pick a line to see its sections'} · ${plural(entry.jobCount, 'job')}`}
                        </span>
                      </>
                    )}
                  </span>
                </span>
                <span className="finder-row-actions">
                  {editableSection && editingId !== editableSection.id && (
                    <>
                      <RenameButton title="Rename section" onClick={() => { setEditingId(editableSection.id); setEditDraft(editableSection.name) }} />
                      <button
                        type="button"
                        className="finder-row-action finder-row-action-danger"
                        disabled={isBusy}
                        title="Delete section"
                        onClick={(e) => { e.stopPropagation(); requestDelete(editableSection) }}
                      >
                        {isBusy ? '…' : 'Delete'}
                      </button>
                    </>
                  )}
                  <span className="finder-chevron">›</span>
                </span>
              </div>
            )
          })
        )}
      </Pane>

      {blockedDelete && (
        <ConfirmDialog
          title="Can't delete this section"
          message={
            blockedDelete.jobCount > 0
              ? `"${blockedDelete.name}" still has ${plural(blockedDelete.jobCount, 'job')} assigned`
                + (blockedDelete.retiredCount > 0 ? `, plus ${plural(blockedDelete.retiredCount, 'deleted job')} still pointing at it` : '')
                + `. Reassign or unsection ${blockedDelete.jobCount === 1 && blockedDelete.retiredCount === 0 ? 'it' : 'them'} first — deleting the section here never touches them.`
              // The case this pane cannot show and therefore cannot ask the user to fix: every
              // blocker is a deleted job, hidden on every screen but this pane's counterpart.
              : `"${blockedDelete.name}" holds no live jobs, but ${plural(blockedDelete.retiredCount, 'deleted job')} still `
                + `${blockedDelete.retiredCount === 1 ? 'points' : 'point'} at it — and deleting the section would leave `
                + `${blockedDelete.retiredCount === 1 ? 'that row' : 'those rows'} filed against a section that no longer exists. `
                + 'Deleted jobs are hidden on this screen. Open Production Line Config, turn on '
                + '"Show deleted jobs" in the Jobs column, and move '
                + `${blockedDelete.retiredCount === 1 ? 'it' : 'them'} into the team's No Section tray first.`
          }
          confirmLabel="Got it"
          cancelLabel="Close"
          onConfirm={() => setBlockedDelete(null)}
          onCancel={() => setBlockedDelete(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete Section"
          message={`Delete "${confirmDelete.name}"? No jobs are assigned to it. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {/* One confirmation, one lib, three screens — see components/MergeMode. */}
      <MergeConfirm merge={merge} />
    </>
  )
}

// ── Pane 2: Jobs ───────────────────────────────────────────────────────────────────────────
/**
 * Optional per-job applicability, for a screen scoped to one thing a job can apply to (today:
 * /tryouts, scoped to one van's model). Applicability itself is always DERIVED — the pane is
 * handed the set of job ids that currently apply and never computes or stores one — so this is
 * a display + toggle contract, not a second source of truth.
 */
/**
 * The per-job "9 / 29 models" badge.
 *
 * READ THIS BEFORE TOUCHING EITHER BADGE. /setup shows two model counts one pane apart and they
 * mean different things:
 *
 *   JOBS pane (this one)  "9 / 29 models"  — models this JOB APPLIES TO, out of every model on
 *                                            the line. Applicability: does this work belong to
 *                                            that van at all?
 *   OPERATIONS pane       "1 / 29"         — models this OPERATION has been TIMED on, out of the
 *                                            models it is LINKED to. Collection progress.
 *
 * Different numerator, different denominator, different question. The word "models" and a
 * spelled-out tooltip are on this one specifically so the two can't be read as the same figure.
 */
export interface JobModelApplicability {
  /** Job id → how many models on the line it applies to. Derived by the host from the
   * applies-list it already holds; this component never fetches. */
  countByJobId: Map<string, number>
  /** Models on the line — the denominator, shared by every row. */
  total: number
  loading: boolean
  /** Opens the host's model panel for that job. */
  onOpen: (job: Job) => void
}

/** Muted when the job applies to every model on the line (nothing to decide), amber when it is
 * a partial set (a real, deliberate state — four Caravan models carry 1 of 8 operations on one
 * job), red at zero: a job that applies to nothing is not "not set up yet", it is a job whose
 * work is attributed to no van at all. */
function jobModelBadgeClass(applies: number, total: number): string {
  if (total === 0) return 'badge-grey'
  if (applies === 0) return 'badge-red'
  if (applies >= total) return 'badge-grey'
  return 'badge-amber'
}

/**
 * The badge itself, as one component so a second screen can't grow a second version of it.
 *
 * Extracted from the JobsPane row below — which now renders this and nothing else — when
 * /line-config needed the same "38 / 89 models" chip on its job cards. Both screens derive
 * `applies` and `total` the same way (distinct product ids across the job's operations, over
 * every product on the line) and both open the same panel from it: BulkModelLinkDrawer in job
 * mode. The colour rule, the tooltip that spells out WHICH model question this answers, and the
 * loading dash live here rather than at either call site.
 */
export function JobModelBadge({
  applies, total, loading, onOpen,
}: {
  applies: number
  total: number
  loading: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className={'badge ' + jobModelBadgeClass(applies, total)}
      title={total === 0
        ? 'No models on this production line yet'
        : `Applies to ${applies} of ${total} models on this line — click to change which`}
      onClick={(e) => { e.stopPropagation(); onOpen() }}
      style={{ border: 0, cursor: 'pointer', fontFamily: 'inherit' }}
    >
      {loading && applies === 0 ? '…' : `${applies} / ${total} models`}
    </button>
  )
}

export interface JobApplicability {
  /** Job ids that currently apply. */
  appliesIds: Set<string>
  /** What they apply to, for labels and tooltips — e.g. the model name. */
  targetLabel: string
  /** The job whose toggle is in flight, if any. */
  busyJobId: string | null
  /** Jobs that can't be toggled at all (e.g. the screen hasn't resolved what they'd apply to).
   * Keyed by job id → why. */
  disabledReasons?: Record<string, string>
  /** Per-job tooltip override for a toggle that STAYS enabled, for a row where ticking does
   * something other than the plain link/unlink — /tryouts uses it for a job with no operations,
   * where ticking starts adding its first one. Keyed by job id → what ticking will do. */
  toggleHints?: Record<string, string>
  onToggle: (job: Job, currentlyApplies: boolean) => void
}

/**
 * The selected section's jobs, with a search box above them. The search lives HERE rather than on
 * each screen precisely because all three mount this component: /setup, /tryouts and /collect
 * get the same filter, in the same place, behaving the same way, without three copies of it.
 * It narrows the jobs already handed in — i.e. the current section/line/team scope — so it is
 * instant, never refetches, and an emptied box is the full list again.
 *
 * Adding here places the job in that section directly (section_id set, line/team from the pane
 * context).
 *
 * Renaming and re-staging live in the caller's slide-over behind each row's ✎ — deliberately
 * not on the row and not in this footer. Moving a job between sections also moves it between
 * teams (see sections.ts' setJobSection), which is too consequential to sit behind an unconfirmed
 * dropdown change. A caller that offers no such drawer (e.g. /tryouts, which walks the
 * structure rather than editing it) simply passes no onEdit, and the row shows no ✎.
 */
export function JobsPane({
  supabase, userId, entry, jobs, loading, operationsByJob, selectedJobId, canDelete, runningJobIds, applicability,
  sectionsById, teamNameById, autoStartMergeJobId, modelApplicability, editHint,
  onSelect, onAdd, onEdit, onEditLine, onDeleteRequest, onChanged,
}: {
  /** Needed by merge mode alone — the job-merge write path lives in lib/jobs. */
  supabase: SupabaseClient
  /** Needed by merge mode alone. A job merge folds same-named operations together and a fold
   * moves recorded times, so the operation-level ownership guard applies here. See lib/jobs. */
  userId: string
  entry: SectionEntry | null
  jobs: Job[]
  loading: boolean
  operationsByJob: Record<string, Operation[]>
  selectedJobId: string
  canDelete?: boolean
  /**
   * The two lookups a row's team is derived through: the job's section owns its team (see
   * teamForJob), so the row reads the team off the section rather than off jobs.team_id,
   * which can lag behind a section move. Both optional — without them the row falls back to
   * the joined jobs.teams, which is what it always used.
   */
  sectionsById?: Map<string, { team_id: string | null }>
  teamNameById?: Map<string, string>
  /** Job ids with a stopwatch running on one of their operations. */
  runningJobIds?: Set<string>
  /**
   * Open merge mode with this job already ticked, once — for /setup's `?merge=job` deep link
   * from /model-total's row menu. The pane owns its merge state (it mounts its own useMergeMode),
   * so arming it is a prop rather than something the host can reach in and do.
   *
   * Only the SOURCE is ticked. The target is chosen here, on the screen that owns the structure:
   * a job merge moves times and notes and retires a row across every model on the line, which is
   * not a decision a single model's breakdown should be able to make.
   */
  autoStartMergeJobId?: string
  /** Set to show — and toggle — whether each job applies to whatever the screen is scoped to. */
  applicability?: JobApplicability
  /** Set to show the per-job "N / M models" badge. Distinct from `applicability` above, which is
   * a yes/no toggle against ONE target model on /tryouts. See JobModelApplicability. */
  modelApplicability?: JobModelApplicability
  /** What the ✎ says it does. Defaults to /setup's and /collect's full editor; /tryouts opens
   * the SAME drawer with the section control off (nameOnly), so it says rename and means it. */
  editHint?: string
  onSelect: (id: string) => void
  onAdd: (name: string) => Promise<void>
  /** Opens the caller's edit/reassign slide-over. Distinct from onSelect so the row's click
   * can stay "show me this job's operations" — selecting and editing must not collide. */
  onEdit?: (job: Job) => void
  onEditLine?: (job: Job) => void
  onDeleteRequest?: (job: Job) => void
  /** Reload the host screen's structure — called after a merge. */
  onChanged: () => Promise<void>
}) {
  const [addingOpen, setAddingOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  // Deliberately not persisted, and reset below whenever the pane changes section — a search term
  // is a momentary "find me this one job", the same call /setup's operation search makes.
  const [search, setSearch] = useState('')

  const entryKey = entry?.key ?? null
  useEffect(() => { setSearch('') }, [entryKey])

  const shownJobs = useMemo(() => filterByName(jobs, search), [jobs, search])
  const searching = search.trim().length > 0

  /** Looked up in the FULL list, not the filtered one: a job stays selected — and its footer
   * actions stay reachable — while a search that doesn't match it narrows the rows. */
  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null
  const hasJobActions = Boolean(onEdit || onEditLine || (canDelete && onDeleteRequest))

  /**
   * The rows merge mode may offer: every job the pane is showing, grouped by SECTION. The pane is
   * already scoped to one section entry, so in practice they all share a group — the key is
   * computed properly anyway, because that is the rule the write path enforces and the two must
   * not be able to disagree. A null section_id (the legacy "not filed into the walk at all"
   * state) is one bucket, not many.
   */
  const mergeRows = useMemo<MergeRow<Job>[]>(() => shownJobs.map((job) => ({
    id: job.id,
    name: job.name,
    // The rule itself, straight from lib/jobs — the same function mergeJobs re-checks with.
    groupKey: jobMergeGroupKey(job),
    subject: job,
  })), [shownJobs])

  const merge = useMergeMode({ level: 'job', supabase, userId, rows: mergeRows, onMerged: async () => { await onChanged() } })

  /** Fires once, and only once the job is actually in `mergeRows` — merge.toggle looks the row
   * up by id and ignores one it can't find, so arming before the pane has loaded would open an
   * empty merge mode with nothing ticked. */
  const armedMerge = useRef(false)
  useEffect(() => {
    if (armedMerge.current || !autoStartMergeJobId) return
    if (!mergeRows.some((r) => r.id === autoStartMergeJobId)) return
    armedMerge.current = true
    merge.start()
    merge.toggle(autoStartMergeJobId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergeRows, autoStartMergeJobId])

  async function commitAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setBusy(true)
    try { await onAdd(newName) } finally { setBusy(false); setNewName(''); setAddingOpen(false) }
  }

  return (
    <Pane
      title="Jobs"
      subtitle={
        !entry
          ? 'No section selected'
          : merge.active
            ? `${entry.name} · ${merge.subtitle}`
            : `${entry.name} · ${searching ? `${shownJobs.length} of ${plural(jobs.length, 'job')}` : plural(jobs.length, 'job')}`
      }
      active={merge.active ? merge.count > 0 : Boolean(selectedJobId)}
      footer={
        entry ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            {/* Merge mode owns the whole footer while it is on — the add form and the selected
                job's actions have no meaning mid-selection. */}
            {merge.active ? <MergeFooter merge={merge} /> : addingOpen ? (
              <form onSubmit={commitAdd} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input
                  autoFocus
                  className="input"
                  placeholder="Job name"
                  style={{ fontSize: 12, padding: '5px 8px' }}
                  value={newName}
                  disabled={busy}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="submit" className="btn-primary" style={{ padding: '6px 11px', fontSize: 12 }} disabled={busy || !newName.trim()}>
                    {busy ? 'Adding…' : 'Add job'}
                  </button>
                  <button type="button" className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} disabled={busy} onClick={() => { setAddingOpen(false); setNewName('') }}>
                    Cancel
                  </button>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Added under {entry.name}
                </span>
              </form>
            ) : (
              // The two bottom-of-pane actions, side by side — the one place a merge is started.
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => setAddingOpen(true)}>
                  + Add job
                </button>
                <MergeFooter merge={merge} />
              </div>
            )}

            {!merge.active && selectedJob && hasJobActions && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>{selectedJob.name}</span>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {onEdit && (
                    <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => onEdit(selectedJob)}>
                      Edit / reassign
                    </button>
                  )}
                  {onEditLine && (
                    <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => onEditLine(selectedJob)}>
                      Line
                    </button>
                  )}
                  {canDelete && onDeleteRequest && (
                    <button className="btn-ghost" style={{ padding: '6px 11px', fontSize: 12, color: 'var(--red)' }} onClick={() => onDeleteRequest(selectedJob)}>
                      Delete job
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : undefined
      }
    >
      {entry && !loading && jobs.length > 0 && (
        <PaneSearch
          value={search}
          placeholder="Search jobs by name…"
          ariaLabel="Search jobs by name"
          onChange={setSearch}
        />
      )}

      <MergeNotices merge={merge} />

      {!entry ? (
        <p className="finder-pane-empty">Select a section.</p>
      ) : loading ? (
        <p className="finder-pane-empty">Loading…</p>
      ) : merge.active ? (
        mergeRows.map((row) => (
          <MergeRowItem
            key={row.id}
            merge={merge}
            row={row}
            meta={`${teamNameForJob(row.subject, sectionsById, teamNameById)} · ${plural((operationsByJob[row.id] ?? []).length, 'operation')}`}
          />
        ))
      ) : jobs.length === 0 ? (
        <p className="finder-pane-empty">
          No jobs in {entry.name} yet — add one below, or move a job here from another section.
        </p>
      ) : shownJobs.length === 0 ? (
        <p className="finder-pane-empty">
          No job in {entry.name} matches &ldquo;{search.trim()}&rdquo;. Clear the search to see all {plural(jobs.length, 'job')}.
        </p>
      ) : (
        shownJobs.map((job) => {
          const isSelected = job.id === selectedJobId
          const opCount = (operationsByJob[job.id] ?? []).length
          const applies = applicability?.appliesIds.has(job.id) ?? true
          const toggleDisabled = applicability
            ? applicability.busyJobId !== null || Boolean(applicability.disabledReasons?.[job.id])
            : false
          return (
            <div
              key={job.id}
              className={'finder-row' + (isSelected ? ' finder-row-selected' : '')}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(job.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(job.id) } }}
              // A job that doesn't apply is still listed (that's how it gets turned back on),
              // just visibly stood down from the ones that do.
              style={applicability && !applies ? { opacity: 0.62 } : undefined}
            >
              <span className="finder-row-main">
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                  <span className="finder-row-name">
                    {job.name}
                    {runningJobIds?.has(job.id) && <RunningDot title="A timer is running in this job" />}
                  </span>
                  <span className="finder-row-meta">
                    {teamNameForJob(job, sectionsById, teamNameById)} · {plural(opCount, 'operation')}
                  </span>
                </span>
              </span>
              <span className="finder-row-actions">
                {modelApplicability && (
                  <JobModelBadge
                    applies={modelApplicability.countByJobId.get(job.id) ?? 0}
                    total={modelApplicability.total}
                    loading={modelApplicability.loading}
                    onOpen={() => modelApplicability.onOpen(job)}
                  />
                )}
                {/* BEFORE the Applies toggle, deliberately. Applies is the primary action on
                    this row — on /tryouts it is what the whole walk is doing — so the ✎ sits
                    between the name and it rather than after, where it would be the last thing
                    the eye lands on and the easiest thing to hit by mistake. It is muted
                    (.finder-row-action) and Applies keeps its badge; the two do not compete.
                    RenameButton stops its own click, so the row still selects everywhere else. */}
                {onEdit && (
                  <RenameButton
                    title={editHint ?? 'Edit / reassign this job'}
                    onClick={() => onEdit(job)}
                  />
                )}
                {applicability && (
                  <label
                    title={
                      applicability.disabledReasons?.[job.id]
                        ?? applicability.toggleHints?.[job.id]
                        ?? (applies
                          ? `Stop this job applying to ${applicability.targetLabel}`
                          : `Make this job apply to ${applicability.targetLabel}`)
                    }
                    style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: toggleDisabled ? 'default' : 'pointer' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={applies}
                      disabled={toggleDisabled}
                      onChange={() => applicability.onToggle(job, applies)}
                      style={{ width: 14, height: 14, accentColor: 'var(--blue)', cursor: toggleDisabled ? 'default' : 'pointer' }}
                    />
                    <span className={'badge ' + (applies ? 'badge-green' : 'badge-grey')}>
                      {applicability.busyJobId === job.id ? '…' : applies ? 'Applies' : 'Doesn’t apply'}
                    </span>
                  </label>
                )}
                <span className="finder-chevron">›</span>
              </span>
            </div>
          )
        })
      )}

      {/* One confirmation, one lib, three screens — see components/MergeMode. */}
      <MergeConfirm merge={merge} />
    </Pane>
  )
}
