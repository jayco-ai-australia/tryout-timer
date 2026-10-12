'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import ConfirmDialog from '@/components/ConfirmDialog'
import Modal from '@/components/Modal'
import SectionMergeSummary from '@/components/SectionMergeSummary'
import SectionTeamMoveDialog from '@/components/SectionTeamMoveDialog'
import { StructureFailureBox, toStructureFailure, type StructureFailure } from '@/components/StructureFailure'
import { plural } from '@/lib/format'
import { STRUCTURE_LOCKED_REASON, canDeletePermanently, canEditStructure } from '@/lib/permissions'
import { useSlideOverDrawer } from '@/components/BulkModelLinkDrawer'
import JobOperationsPane from './JobOperationsPane'
import SectionJobs from './SectionJobs'
import { resetLineTopologyCache } from '@/lib/lines'
import {
  deleteSectionClearingRetired, fetchSectionCounts, fetchSectionJobs, findSectionNameClash, inspectSection,
  mergeSectionsInto, preflightSectionMergeInto,
  type SectionCounts, type SectionHoldings, type SectionJob, type SectionMergePlan,
} from '@/lib/sectionManager'
import {
  createSection, groupSectionsByTeam, isSectionTray, moveSection,
  renameSection, sortSections,
} from '@/lib/sections'
import { fetchAllRows } from '@/lib/supabaseRead'
import { usePersistedFilter } from '@/lib/useLocalStorage'
import type { ProductionLine, Section, Team, UserRole } from '@/lib/types'

/**
 * /config → Sections. Where a line's structure gets cleaned up: every section on the line, what
 * hangs off each one, the structural moves on it — add, rename, reorder, move to another team,
 * merge, delete — and, expanded, the jobs inside it (./SectionJobs), with each job's operations
 * in a slide-over (./JobOperationsPane). No model link or recorded time is edited here.
 *
 * Add, rename, reorder and the empty-section delete are lib/sections', unchanged, so they mean
 * here exactly what they mean on /line-config. Move, merge and delete-with-jobs are
 * lib/sectionManager's — the one implementation every screen uses. Nothing crosses a production
 * line; a move or merge between teams re-stamps the recorded times it takes with it.
 */

type TeamRow = Pick<Team, 'id' | 'name' | 'production_line_id'>

type Dialog =
  | { kind: 'add' }
  | { kind: 'rename'; section: Section }
  | { kind: 'move'; section: Section }
  | { kind: 'merge'; section: Section }
  | { kind: 'delete'; section: Section }

const EMPTY: React.CSSProperties = { textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '28px 0' }
const ERR_BOX: React.CSSProperties = { marginTop: 10, padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13, lineHeight: 1.55 }
const OK_BOX: React.CSSProperties = { marginTop: 10, padding: '9px 14px', borderRadius: 8, background: 'var(--green-bg)', border: '1px solid #86efac', color: '#15803d', fontSize: 13, lineHeight: 1.55 }
const WARN_BOX: React.CSSProperties = { marginTop: 12, padding: '9px 14px', borderRadius: 8, background: 'var(--amber-bg)', border: '1px solid #fcd34d', color: '#92400e', fontSize: 13, lineHeight: 1.55 }
const BODY_TEXT: React.CSSProperties = { fontSize: 14, color: 'var(--text-mid)', lineHeight: 1.6, margin: '0 0 12px' }
const FIELD: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }
const ROW_ACTION: React.CSSProperties = { background: 'none', border: 'none', padding: '4px 6px', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--blue)', cursor: 'pointer' }
const ROW_ACTION_OFF: React.CSSProperties = { ...ROW_ACTION, color: 'var(--text-muted)', opacity: 0.5, cursor: 'not-allowed' }

export default function SectionsTab({
  supabase, lines, userId, role,
}: {
  supabase: SupabaseClient
  lines: ProductionLine[]
  userId: string
  role: UserRole | null
}) {
  /** Manager or admin — the ONE gate on every action on this tab. Everyone else can filter,
   * expand and read, and nothing else. */
  const canEdit = canEditStructure(role)
  const lockedReason = canEdit ? null : STRUCTURE_LOCKED_REASON
  // The two filters are remembered across navigation, a refresh and a switch of Config tab —
  // lib/useLocalStorage's usePersistedFilter, the same hook /labour-matrix, /setup, /line-config
  // and the rest keep theirs in. '' is "no line picked" and "All teams" respectively.
  //
  // ONLY the filters. Which sections are open and which jobs are ticked are working state for
  // one sitting and stay in plain component state below: restoring yesterday's half-ticked
  // checkboxes would be worse than losing them.
  const [lineId, setLineId] = usePersistedFilter('configSections.lineId', '')
  const [teamId, setTeamId] = usePersistedFilter('configSections.teamId', '')
  /** True once teams and sections have been read at least once — until then a remembered id
   * can't be told apart from a dead one. */
  const [structureLoaded, setStructureLoaded] = useState(false)
  const [teams, setTeams] = useState<TeamRow[]>([])
  /** Every section on every line, merged-away ones included: the merge and delete pickers reach
   * across lines, and a merged-away section still occupies its name on its team. */
  const [sections, setSections] = useState<Section[]>([])
  const [counts, setCounts] = useState<Record<string, SectionCounts> | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<StructureFailure | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)

  // ── The operations side pane ─────────────────────────────────────────────────────────────
  // The app's existing slide-over (components/BulkModelLinkDrawer's useSlideOverDrawer and the
  // .gaps-drawer chrome). One pane for the whole tab; the table behind keeps its scroll position
  // and its open sections, because nothing about it is unmounted or re-keyed.
  const operationsDrawer = useSlideOverDrawer()
  const [operationsFor, setOperationsFor] = useState<{ job: SectionJob; section: Section } | null>(null)

  // ── Expanded sections and the jobs inside them ───────────────────────────────────────────
  /** Which sections are open. Kept across every refetch: an action inside an open section
   * re-reads its rows in place, it never closes it. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** Jobs per section, loaded the first time a section is opened and kept — re-opening is
   * instant, and a re-read replaces the rows without blanking them first. */
  const [jobsBySection, setJobsBySection] = useState<Record<string, SectionJob[]>>({})
  const [jobsErrorBySection, setJobsErrorBySection] = useState<Record<string, string>>({})
  /** Ticked jobs per open section, reported up by each panel — what enables the section row's
   * own "Move jobs" action. */
  const [selectionBySection, setSelectionBySection] = useState<Record<string, number>>({})
  const [moveRequestBySection, setMoveRequestBySection] = useState<Record<string, number>>({})

  const loadSectionJobs = useCallback(async (sectionId: string) => {
    try {
      const rows = await fetchSectionJobs(supabase, sectionId)
      setJobsBySection((prev) => ({ ...prev, [sectionId]: rows }))
      setJobsErrorBySection((prev) => { const next = { ...prev }; delete next[sectionId]; return next })
    } catch (err) {
      setJobsErrorBySection((prev) => ({ ...prev, [sectionId]: err instanceof Error ? err.message : 'Could not load this section’s jobs' }))
      // Leave whatever was there; a first load that failed shows an empty list with the error.
      setJobsBySection((prev) => (sectionId in prev ? prev : { ...prev, [sectionId]: [] }))
    }
  }, [supabase])

  function toggleExpanded(sectionId: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
    if (!expanded.has(sectionId) && !(sectionId in jobsBySection)) loadSectionJobs(sectionId)
  }

  // After any write, every OPEN section re-reads its jobs — a job moved from one open section to
  // another has to leave the first and arrive in the second. Closed ones are dropped from the
  // cache instead, so they load fresh when next opened rather than showing a stale list.
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const firstReload = useRef(true)
  useEffect(() => {
    if (firstReload.current) { firstReload.current = false; return }
    const open = expandedRef.current
    setJobsBySection((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => open.has(id))))
    for (const id of open) loadSectionJobs(id)
  }, [reloadKey, loadSectionJobs])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      supabase.from('teams').select('id, name, production_line_id').order('name'),
      fetchAllRows<Section>(() => supabase.from('sections').select('*').order('id'), { table: 'sections' }),
    ]).then(([teamRes, sectionRows]) => {
      if (cancelled) return
      if (teamRes.error) throw new Error(teamRes.error.message)
      setTeams((teamRes.data ?? []) as TeamRow[])
      setSections(sectionRows)
      setStructureLoaded(true)
    }).catch((err) => {
      if (!cancelled) setFailure(toStructureFailure(err, 'Could not load sections'))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [supabase, reloadKey])

  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams])
  const lineTeams = useMemo(() => teams.filter((t) => t.production_line_id === lineId), [teams, lineId])
  const teamName = useCallback((id: string | null) => (id ? teamsById.get(id)?.name : null) ?? 'No team', [teamsById])

  // A remembered line or team that no longer exists — deleted, or no longer visible to this user
  // — falls back to the default instead of rendering an empty table against a dead id. Checked
  // only once the lists it is checked against have actually arrived.
  useEffect(() => {
    if (lineId && lines.length > 0 && !lines.some((l) => l.id === lineId)) { setLineId(''); setTeamId(''); return }
    if (teamId && structureLoaded && lines.length > 0) {
      const team = teamsById.get(teamId)
      if (!team || team.production_line_id !== lineId) setTeamId('')
    }
    // The setters are stable in effect; listing them would re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId, teamId, lines, teamsById, structureLoaded])

  const visible = useMemo(
    () => sections.filter((s) =>
      s.is_active !== false && s.production_line_id === lineId && (!teamId || s.team_id === teamId)),
    [sections, lineId, teamId]
  )

  /** One group per team, team first and then the line's sequence within it — lib/sections'
   * groupSectionsByTeam, shared with /model-total's breakdown. */
  const groups = useMemo(() => groupSectionsByTeam(visible, teamName), [visible, teamName])

  // One batch for everything on screen — see fetchSectionCounts. Keyed on the ids, so a reorder
  // (same sections, new order) doesn't re-read thousands of rows to arrive at the same numbers.
  const visibleKey = useMemo(() => visible.map((s) => s.id).sort().join(','), [visible])
  // The previous numbers stay on screen while a re-read is in flight: after an action the table
  // must not flicker to "…" and back. They are only cleared when the SET of sections changes.
  useEffect(() => { setCounts(null) }, [visibleKey])
  useEffect(() => {
    if (!visibleKey) return
    let cancelled = false
    fetchSectionCounts(supabase, visibleKey.split(','))
      .then((result) => { if (!cancelled) setCounts(result) })
      .catch((err) => { if (!cancelled) setFailure(toStructureFailure(err, 'Could not load the counts')) })
    return () => { cancelled = true }
  }, [supabase, visibleKey, reloadKey])

  /** After anything that wrote — a completed action, or one that stopped part-way. The Labour
   * Matrix and Model Total read line topology through lib/lines' cache, so it is dropped here. */
  const changed = useCallback(() => {
    resetLineTopologyCache()
    setReloadKey((k) => k + 1)
  }, [])

  /** What an expanded section's job panel calls after a write. */
  function jobsChanged(message?: string) {
    if (message) { setFailure(null); setNotice(message) }
    changed()
  }

  function done(message: string) {
    setDialog(null); setFailure(null); setNotice(message)
    changed()
  }

  async function reorder(group: Section[], section: Section, direction: -1 | 1) {
    setBusy(true); setFailure(null); setNotice(null)
    try {
      // `group` only says which section this one steps past — the next of ITS TEAM's. moveSection
      // reads the whole line and writes the line-wide sequence.
      await moveSection(supabase, group, section.id, direction)
    } catch (err) {
      setFailure(toStructureFailure(err, 'Could not reorder the sections'))
    }
    changed()
    setBusy(false)
  }

  const showTeamHeaders = !teamId
  const columnCount = 8

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ maxWidth: 240, flex: 1 }}>
          <label className="label">Production Line</label>
          <select className="select" style={{ width: '100%' }} value={lineId} onChange={(e) => { setLineId(e.target.value); setTeamId('') }}>
            <option value="">— Select —</option>
            {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        {lineId && (
          <div style={{ maxWidth: 240, flex: 1 }}>
            <label className="label">Team</label>
            <select className="select" style={{ width: '100%' }} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">All teams</option>
              {lineTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        {lineId && (
          <button className="btn-primary" disabled={busy || !canEdit || lineTeams.length === 0} title={lockedReason ?? undefined} onClick={() => setDialog({ kind: 'add' })}>
            + Add Section
          </button>
        )}
      </div>

      {lockedReason && lineId && (
        <p style={{ ...WARN_BOX, marginTop: 0 }}>View only — {lockedReason.toLowerCase()}. Every action on this tab is disabled for your role.</p>
      )}
      {notice && <p style={OK_BOX}>{notice}</p>}
      {failure && <StructureFailureBox failure={failure} />}

      {lineId && (
        // No overflow on the card: the header row is position: sticky against the PAGE, and any
        // overflow here would make this box its scroll container and pin the header to nothing.
        <div className="card sections-card" style={{ marginTop: 16 }}>
          {loading && sections.length === 0 ? <p style={EMPTY}>Loading…</p> : (
            <table className="data-table sections-table">
              <thead>
                <tr>
                  <th className="sec-order" style={{ width: 72 }}>Order</th>
                  <th className="sec-name">Section</th>
                  <th>Team</th>
                  <th className="sec-num">Jobs</th>
                  <th className="sec-num">Operations</th>
                  <th className="sec-num">Time records</th>
                  <th className="sec-num">Models</th>
                  <th className="sec-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <GroupRows
                    key={group.key}
                    header={showTeamHeaders ? `${group.name} · ${plural(group.sections.filter((s) => !isSectionTray(s)).length, 'section')}` : null}
                    columnCount={columnCount}
                  >
                    {group.sections.map((section, index) => {
                      const tray = isSectionTray(section)
                      const c = counts?.[section.id]
                      const trayReason = lockedReason ?? (tray ? 'A team’s unsorted tray keeps its place — its jobs can still be moved, merged, renamed and retired' : undefined)
                      const isOpen = expanded.has(section.id)
                      const tickedJobs = isOpen ? selectionBySection[section.id] ?? 0 : 0
                      const figure = (n: number | undefined) => (n === undefined ? '…' : n.toLocaleString())
                      const action = (label: string, kind: 'rename' | 'move' | 'merge' | 'delete') => (
                        <button
                          type="button" title={trayReason} disabled={busy || tray || !canEdit}
                          style={busy || tray || !canEdit ? ROW_ACTION_OFF : kind === 'delete' ? { ...ROW_ACTION, color: 'var(--red)' } : ROW_ACTION}
                          onClick={() => { setNotice(null); setFailure(null); setDialog({ kind, section }) }}
                        >
                          {label}
                        </button>
                      )
                      return (
                        <SectionRows key={section.id}>
                        <tr style={isOpen ? { background: '#fafbfc' } : undefined}>
                          <td className="sec-order">
                            {!tray && <span style={{ display: 'inline-flex', gap: 2 }}>
                              <button
                                type="button" className="lc-icon-btn" aria-label={`Move ${section.name} up`}
                                title={trayReason ?? 'Move up within this team'}
                                disabled={busy || tray || !canEdit || !group.sections.slice(0, index).some((s) => !isSectionTray(s))}
                                onClick={() => reorder(group.sections, section, -1)}
                              >
                                ↑
                              </button>
                              <button
                                type="button" className="lc-icon-btn" aria-label={`Move ${section.name} down`}
                                title={trayReason ?? 'Move down within this team'}
                                disabled={busy || tray || !canEdit || !group.sections.slice(index + 1).some((s) => !isSectionTray(s))}
                                onClick={() => reorder(group.sections, section, 1)}
                              >
                                ↓
                              </button>
                            </span>}
                          </td>
                          <td
                            className="primary sec-name" style={{ cursor: 'pointer', userSelect: 'none' }}
                            // The full name, for the rare one long enough to be truncated.
                            title={`${section.name} — ${isOpen ? 'hide' : 'show'} its jobs`}
                            onClick={() => toggleExpanded(section.id)}
                          >
                            <button
                              type="button" className="lc-icon-btn" aria-expanded={isOpen}
                              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${section.name}`}
                              style={{ marginRight: 6, verticalAlign: 'middle' }}
                              onClick={(e) => { e.stopPropagation(); toggleExpanded(section.id) }}
                            >
                              {isOpen ? '▾' : '▸'}
                            </button>
                            {section.name}
                            {tray && <span className="badge badge-grey" style={{ marginLeft: 8 }}>Unsorted tray</span>}
                          </td>
                          <td className="sec-team">{teamName(section.team_id)}</td>
                          <td className="sec-num">
                            {figure(c?.jobs)}
                          </td>
                          <td className="sec-num">{figure(c?.operations)}</td>
                          <td className="sec-num">{figure(c?.timeRecords)}</td>
                          <td className="sec-num">{figure(c?.models)}</td>
                          <td className="sec-actions">
                            {isOpen && (
                              <>
                                <button
                                  type="button"
                                  style={busy || !canEdit || tickedJobs === 0 ? ROW_ACTION_OFF : ROW_ACTION}
                                  disabled={busy || !canEdit || tickedJobs === 0}
                                  title={lockedReason ?? (tickedJobs === 0
                                    ? 'Tick one or more jobs below, then move them to another section on this line'
                                    : `Move the ${plural(tickedJobs, 'ticked job')} to another section on this line`)}
                                  onClick={() => setMoveRequestBySection((prev) => ({ ...prev, [section.id]: (prev[section.id] ?? 0) + 1 }))}
                                >
                                  {tickedJobs > 0 ? `Move ${plural(tickedJobs, 'job')}` : 'Move jobs'}
                                </button>
                                ·
                              </>
                            )}
                            {tray ? (
                              // No dead controls: a tray is fixed, and the row says so.
                              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Fixed — the team’s unsorted tray</span>
                            ) : (
                              <>{action('Rename', 'rename')}·{action('Move', 'move')}·{action('Merge', 'merge')}·{action('Delete', 'delete')}</>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={columnCount} className="sec-panel">
                              <SectionJobs
                                supabase={supabase} userId={userId} role={role}
                                section={section} sections={sections}
                                jobs={jobsBySection[section.id] ?? null}
                                loadError={jobsErrorBySection[section.id] ?? null}
                                teamName={teamName}
                                moveRequest={moveRequestBySection[section.id] ?? 0}
                                onOpenOperations={(job) => { setOperationsFor({ job, section }); operationsDrawer.openDrawer() }}
                                onSelectionCount={(count) => setSelectionBySection((prev) => (prev[section.id] === count ? prev : { ...prev, [section.id]: count }))}
                                onChanged={jobsChanged}
                              />
                            </td>
                          </tr>
                        )}
                        </SectionRows>
                      )
                    })}
                  </GroupRows>
                ))}
              </tbody>
            </table>
          )}
          {!loading && visible.length === 0 && (
            <p style={EMPTY}>{teamId ? 'No sections on this team' : 'No sections on this line'}</p>
          )}
        </div>
      )}

      {operationsDrawer.open && operationsFor && (
        <>
          <div
            className={'gaps-drawer-overlay' + (operationsDrawer.visible ? ' gaps-drawer-overlay-visible' : '')}
            onClick={operationsDrawer.closeDrawer}
          />
          {/* A third of the viewport, never narrower than its controls need. */}
          <div
            className={'gaps-drawer' + (operationsDrawer.visible ? ' gaps-drawer-visible' : '')}
            style={{ width: '33.333vw', minWidth: 'min(420px, 100vw)' }}
          >
            <JobOperationsPane
              key={operationsFor.job.id}
              supabase={supabase} userId={userId} role={role}
              job={operationsFor.job} section={operationsFor.section}
              teamName={teamName(operationsFor.section.team_id)}
              onChanged={changed}
              onClose={operationsDrawer.closeDrawer}
            />
          </div>
        </>
      )}

      {dialog?.kind === 'add' && (
        <AddSectionDialog
          supabase={supabase} teams={lineTeams} sections={sections} defaultTeamId={teamId}
          onClose={() => setDialog(null)} onDone={done}
        />
      )}
      {dialog?.kind === 'rename' && (
        <RenameSectionDialog
          supabase={supabase} section={dialog.section} sections={sections}
          onClose={() => setDialog(null)} onDone={done}
        />
      )}
      {dialog?.kind === 'move' && (
        <SectionTeamMoveDialog
          supabase={supabase} section={dialog.section} teams={teams}
          onClose={() => setDialog(null)} onMoved={(_outcome, summary) => done(summary)} onChanged={changed}
        />
      )}
      {dialog?.kind === 'merge' && (
        <MergeSectionDialog
          supabase={supabase} mode="merge" section={dialog.section} purgeEmptyRetired={canDeletePermanently(role)}
          teams={teams} sections={sections}
          onClose={() => setDialog(null)} onDone={done} onChanged={changed}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteSectionDialog
          supabase={supabase} section={dialog.section} purgeEmptyRetired={canDeletePermanently(role)}
          teams={teams} sections={sections}
          onClose={() => setDialog(null)} onDone={done} onChanged={changed}
        />
      )}
    </div>
  )
}

/** A section's own row plus, when open, the row holding its jobs — one keyed unit, so opening a
 * section never remounts its neighbours. */
function SectionRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

function GroupRows({ header, columnCount, children }: { header: string | null; columnCount: number; children: React.ReactNode }) {
  return (
    <>
      {header && (
        <tr>
          <td
            colSpan={columnCount} className="sec-group"
            style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '8px 20px' }}
          >
            {header}
          </td>
        </tr>
      )}
      {children}
    </>
  )
}

// ── Add ─────────────────────────────────────────────────────────────────────────────────────
function AddSectionDialog({
  supabase, teams, sections, defaultTeamId, onClose, onDone,
}: {
  supabase: SupabaseClient
  teams: TeamRow[]
  sections: Section[]
  defaultTeamId: string
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [name, setName] = useState('')
  const [teamId, setTeamId] = useState(defaultTeamId || (teams.length === 1 ? teams[0].id : ''))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const team = teams.find((t) => t.id === teamId) ?? null
  const clash = team && name.trim() ? findSectionNameClash(sections, team.id, name) : null
  const clashMessage = clash
    ? `${team?.name} already has a section called "${clash.name}"${clash.is_active === false ? ' (merged away, but it still holds the name)' : ''}.`
    : null

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!team || !name.trim() || clash) return
    setSaving(true); setError(null)
    try {
      const created = await createSection(supabase, { name, productionLineId: team.production_line_id, teamId: team.id })
      onDone(`Section "${created.name}" added to ${team.name}, at the end of the line’s sequence.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the section')
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Add a section" onClose={saving ? () => {} : onClose}
      footer={(
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="section-add-form" className="btn-primary" disabled={saving || !team || !name.trim() || Boolean(clash)}>
            {saving ? 'Adding…' : 'Add Section'}
          </button>
        </>
      )}
    >
      <form id="section-add-form" onSubmit={save}>
        <div style={FIELD}>
          <label className="label">Section name *</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </div>
        <div style={FIELD}>
          <label className="label">Team *</label>
          <select className="select" value={teamId} onChange={(e) => setTeamId(e.target.value)} required>
            <option value="">— Select a team —</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        {(clashMessage || error) && <p style={ERR_BOX}>{clashMessage ?? error}</p>}
      </form>
    </Modal>
  )
}

// ── Rename ──────────────────────────────────────────────────────────────────────────────────
function RenameSectionDialog({
  supabase, section, sections, onClose, onDone,
}: {
  supabase: SupabaseClient
  section: Section
  sections: Section[]
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [name, setName] = useState(section.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = name.trim()
  const clash = section.team_id && trimmed ? findSectionNameClash(sections, section.team_id, name, section.id) : null
  const clashMessage = clash
    ? `This team already has a section called "${clash.name}"${clash.is_active === false ? ' (merged away, but it still holds the name)' : ''}.`
    : null
  const unchanged = trimmed === section.name

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!trimmed || clash || unchanged) return
    setSaving(true); setError(null)
    try {
      const renamed = await renameSection(supabase, section.id, name)
      onDone(`"${section.name}" renamed to "${renamed.name}".`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename the section')
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Rename "${section.name}"`} onClose={saving ? () => {} : onClose}
      footer={(
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="section-rename-form" className="btn-primary" disabled={saving || !trimmed || Boolean(clash) || unchanged}>
            {saving ? 'Renaming…' : 'Rename'}
          </button>
        </>
      )}
    >
      <form id="section-rename-form" onSubmit={save}>
        <div style={FIELD}>
          <label className="label">Section name *</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </div>
        {(clashMessage || error) && <p style={ERR_BOX}>{clashMessage ?? error}</p>}
      </form>
    </Modal>
  )
}

// ── Merge, and delete-with-jobs ─────────────────────────────────────────────────────────────
/**
 * One dialog, two directions.
 *
 *   merge  — `section` is the DESTINATION; the user ticks one or more sources to fold into it.
 *   delete — `section` is the SOURCE; the user picks the one destination its jobs go to.
 *
 * Both run lib/sectionManager's mergeSectionsInto, and both state the same plan before the user
 * commits — read from the database each time the selection changes, never estimated.
 */
function MergeSectionDialog({
  supabase, mode, section, purgeEmptyRetired, teams, sections, heldJobs, onClose, onDone, onChanged,
}: {
  supabase: SupabaseClient
  mode: 'merge' | 'delete'
  section: Section
  /** Delete the source's EMPTY retired jobs rather than carrying them across. True for a user
   * who may delete permanently; otherwise they move with the rest. Either way nothing blocks. */
  purgeEmptyRetired: boolean
  teams: TeamRow[]
  sections: Section[]
  /** Delete only: the job counts that made a plain delete impossible, read when Delete was pressed. */
  heldJobs?: { live: number; retiredToMove: number }
  onClose: () => void
  onDone: (message: string) => void
  onChanged: () => void
}) {
  const [picked, setPicked] = useState<string[]>([])
  const [plan, setPlan] = useState<SectionMergePlan | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<StructureFailure | null>(null)

  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? 'No team'

  // The section's OWN LINE only — nothing crosses a production line, so sections on other lines
  // are simply not offered. Any team on this line is fine.
  const candidates = useMemo(
    () => sortSections(sections.filter((s) =>
      s.id !== section.id && s.is_active !== false && !isSectionTray(s)
      && s.production_line_id === section.production_line_id
    )).sort((a, b) => teamName(a.team_id).localeCompare(teamName(b.team_id))),
    // teamName reads `teams`, which is what the dependency list names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections, section.id, section.production_line_id, teams]
  )
  const pickedSections = picked.map((id) => sections.find((s) => s.id === id)).filter((s): s is Section => Boolean(s))
  const otherTeam = pickedSections.filter((s) => s.team_id !== section.team_id)

  const destinationId = mode === 'merge' ? section.id : picked[0] ?? ''
  const sourceKey = mode === 'merge' ? picked.join(',') : section.id

  useEffect(() => {
    setPlan(null); setFailure(null)
    if (!destinationId || !sourceKey) return
    let cancelled = false
    setChecking(true)
    preflightSectionMergeInto(supabase, { destinationId, sourceIds: sourceKey.split(','), purgeEmptyRetired })
      .then((p) => { if (!cancelled) setPlan(p) })
      .catch((err) => { if (!cancelled) setFailure(toStructureFailure(err, 'Could not check this merge')) })
      .finally(() => { if (!cancelled) setChecking(false) })
    return () => { cancelled = true }
  }, [supabase, destinationId, sourceKey, purgeEmptyRetired])

  async function confirm() {
    if (!plan) return
    setSaving(true); setFailure(null)
    try {
      const outcome = await mergeSectionsInto(supabase, { destinationId, sourceIds: sourceKey.split(','), purgeEmptyRetired })
      const ran = outcome.plan
      const gone = outcome.deletedSections.map((n) => `"${n}"`).join(', ')
      onDone(
        `${gone} ${mode === 'delete' ? 'deleted' : `merged into "${ran.destination.name}"`}: ` +
        `${plural(ran.movingJobs.length - ran.retiredMovingCount, 'job')} moved` +
        (mode === 'delete' ? ` to "${ran.destination.name}"` : '') + ', nothing combined.' +
        (ran.sameNameJobCount > 0
          ? ` ${plural(ran.sameNameJobCount, 'job')} now ${ran.sameNameJobCount === 1 ? 'sits' : 'sit'} alongside a job of the same name (${ran.sameNameJobNames.join(', ')}).`
          : '')
      )
    } catch (err) {
      setFailure(toStructureFailure(err, mode === 'delete' ? 'Could not delete this section' : 'Could not merge these sections'))
      setSaving(false)
      onChanged()
    }
  }

  const title = mode === 'merge' ? `Merge sections into "${section.name}"` : `Delete "${section.name}"`
  const confirmLabel = saving
    ? (mode === 'merge' ? 'Merging…' : 'Deleting…')
    : mode === 'merge'
      ? (picked.length > 0 ? `Merge ${plural(picked.length, 'section')} into "${section.name}"` : 'Merge')
      : (plan ? `Move its jobs to "${plan.destination.name}" and delete` : 'Delete')

  return (
    <Modal
      title={title} onClose={saving ? () => {} : onClose} maxWidth={620}
      footer={(
        <>
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-danger" onClick={confirm} disabled={!plan || checking || saving}>
            {confirmLabel}
          </button>
        </>
      )}
    >
      <p style={BODY_TEXT}>
        {mode === 'merge'
          ? `Pick the sections on this line to fold into "${section.name}" (${teamName(section.team_id)}). Their jobs move here as they are, and each picked section is deleted once it is empty.`
          : (heldJobs?.live ?? 0) > 0
            ? `"${section.name}" (${teamName(section.team_id)}) holds ${plural(heldJobs?.live ?? 0, 'job')}. A section is never deleted out from under its jobs, so pick the section on this line ${heldJobs?.live === 1 ? 'it goes' : 'they go'} to — nothing under ${heldJobs?.live === 1 ? 'it' : 'them'} is deleted.`
            : `"${section.name}" (${teamName(section.team_id)}) holds no live jobs, but ${plural(heldJobs?.retiredToMove ?? 0, 'retired job')} still filed here ${heldJobs?.retiredToMove === 1 ? 'has' : 'have'} to go somewhere before it can be deleted. Pick the section on this line ${heldJobs?.retiredToMove === 1 ? 'it moves' : 'they move'} to — ${heldJobs?.retiredToMove === 1 ? 'it stays' : 'they stay'} retired.`}
      </p>

      {mode === 'delete' ? (
        <div style={FIELD}>
          <label className="label">Destination section</label>
          <select className="select" value={picked[0] ?? ''} disabled={saving} onChange={(e) => setPicked(e.target.value ? [e.target.value] : [])}>
            <option value="">— Select a section —</option>
            {candidates.map((s) => <option key={s.id} value={s.id}>{`${teamName(s.team_id)} — ${s.name}`}</option>)}
          </select>
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, maxHeight: 220, overflowY: 'auto' }}>
          {candidates.length === 0 && <p style={{ ...EMPTY, padding: '16px 0' }}>No other sections on this line</p>}
          {candidates.map((s) => (
            <label
              key={s.id}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', fontSize: 14, color: 'var(--text)', cursor: saving ? 'default' : 'pointer', borderBottom: '1px solid #f2f2f2' }}
            >
              <input
                type="checkbox" checked={picked.includes(s.id)} disabled={saving}
                onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id)))}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{s.name}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{` · ${teamName(s.team_id)}`}</span>
              </span>
              {s.team_id !== section.team_id && <span className="badge badge-amber">Different team</span>}
            </label>
          ))}
        </div>
      )}

      {otherTeam.length > 0 && (
        <p style={WARN_BOX}>
          {mode === 'merge'
            ? `${otherTeam.map((s) => `"${s.name}" is on ${teamName(s.team_id)}`).join('; ')} — not ${teamName(section.team_id)}. Every job and recorded time merged from ${otherTeam.length === 1 ? 'it' : 'them'} will change team.`
            : `"${otherTeam[0].name}" is on ${teamName(otherTeam[0].team_id)} — not ${teamName(section.team_id)}. Every job and recorded time in "${section.name}" will change team.`}
        </p>
      )}

      {checking && <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '12px 0 0' }}>Checking what this would change…</p>}
      {plan && <SectionMergeSummary plan={plan} />}
      {failure && <StructureFailureBox failure={failure} />}
    </Modal>
  )
}

// ── Delete ──────────────────────────────────────────────────────────────────────────────────
/** Reads what the section holds the moment Delete is pressed, then shows the dialog that fits:
 * a plain confirm for an empty section, reassign-then-delete for one that still has jobs. */
function DeleteSectionDialog({
  supabase, section, purgeEmptyRetired, teams, sections, onClose, onDone, onChanged,
}: {
  supabase: SupabaseClient
  section: Section
  purgeEmptyRetired: boolean
  teams: TeamRow[]
  sections: Section[]
  onClose: () => void
  onDone: (message: string) => void
  onChanged: () => void
}) {
  const [holdings, setHoldings] = useState<SectionHoldings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    inspectSection(supabase, section.id)
      .then((result) => { if (!cancelled) setHoldings(result) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not check this section') })
    return () => { cancelled = true }
  }, [supabase, section.id])

  if (!holdings) {
    return (
      <Modal title={`Delete "${section.name}"`} onClose={onClose} footer={<button className="btn-ghost" onClick={onClose}>Close</button>}>
        {error ? <p style={{ ...ERR_BOX, marginTop: 0 }}>{error}</p> : <p style={{ ...BODY_TEXT, margin: 0 }}>Checking what this section holds…</p>}
      </Modal>
    )
  }

  // Anything that needs somewhere to go: live jobs, retired jobs that still hold recorded work,
  // and — for a user who may not delete permanently — the empty retired ones too. Retired jobs
  // are not shown on this tab, so they are never left to be the unseen reason a delete fails.
  const needDestination = holdings.liveJobs + holdings.retiredHolding.length
    + (purgeEmptyRetired ? 0 : holdings.retiredEmpty.length)
  if (needDestination > 0) {
    return (
      <MergeSectionDialog
        supabase={supabase} mode="delete" section={section} purgeEmptyRetired={purgeEmptyRetired}
        heldJobs={{ live: holdings.liveJobs, retiredToMove: needDestination - holdings.liveJobs }}
        teams={teams} sections={sections}
        onClose={onClose} onDone={onDone} onChanged={onChanged}
      />
    )
  }

  async function confirm() {
    if (deleting) return
    setDeleting(true)
    try {
      await deleteSectionClearingRetired(supabase, section.id, { purgeEmptyRetired })
      onDone(`Section "${section.name}" deleted.`)
    } catch (err) {
      setError(err instanceof Error ? `"${section.name}" was not deleted: ${err.message}.` : 'Could not delete this section')
      setDeleting(false)
      onChanged()
    }
  }

  return (
    <ConfirmDialog
      title={`Delete "${section.name}"?`}
      message={`"${section.name}" holds no jobs, so only the section itself is removed. No job, operation or time record changes.`}
      confirmLabel={deleting ? 'Deleting…' : 'Delete section'}
      danger
      onConfirm={confirm}
      onCancel={onClose}
    >
      {error && <p style={{ ...ERR_BOX, marginTop: 0 }}>{error}</p>}
    </ConfirmDialog>
  )
}
