'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllChunked, fetchAllRows, logSupabaseError, READ_CHUNK, type RangeableQuery } from '@/lib/supabaseRead'
import { isSectionTray, setJobSection, sortSections } from '@/lib/sections'
import { useSlideOverDrawer } from '@/components/BulkModelLinkDrawer'
// THE merge affordance — the same hook and the same four pieces of markup the Sections, Jobs and
// Operations panes mount. This screen is a new entry point to it, not a second implementation:
// the multi-select, the explicit keeper, the preflight, the blocker message and the confirmation
// all come from here, and lib/jobs' mergeJobs is still the only thing that writes.
import {
  MergeConfirm, MergeFooter, MergeNotices, MergeRowItem, useMergeMode, type MergeRow,
} from '@/components/MergeMode'
import { plural } from '@/lib/format'
import type { Job, Section } from '@/lib/types'

/**
 * ── Duplicate jobs ─────────────────────────────────────────────────────────────────────────
 *
 * 48 job names appear more than once in this structure, across about 120 jobs. Job merge is
 * SAME-SECTION ONLY — deliberately, because a job's team is its section's team and merging
 * across sections would silently re-team everything that moved (see lib/jobs) — so duplicates
 * scattered across sections cannot be reconciled until one of them is moved. Until now there was
 * no way to even see them.
 *
 * ── The counts are the screen, not decoration ──────────────────────────────────────────────
 * The intuition this exists to kill is "the copy in the unsorted tray is the stale straggler and
 * the one filed into a section is the real job". IT IS FALSE IN THIS DATA, and not marginally:
 *
 *   Internal Electrical (Motor Home Team 2)   tray 35 ops / 148 times   section 18 / 105
 *   Shower Build                              tray 17 ops /  79 times   section  1 /   8
 *
 * Both copies carry real collection. Which one is canonical is a judgement a human makes by
 * looking at how much work hangs off each, so every copy states its operation count and its time
 * count, and the groups are ordered by how much is at stake across them. Nothing here decides;
 * it makes the decision possible.
 *
 * ── Read-only until asked ──────────────────────────────────────────────────────────────────
 * No "merge all". Every one of these is a judgement call, and a bulk button over 48 groups is a
 * bulk mistake over 48 groups.
 *
 * ── Names are compared EXACTLY ─────────────────────────────────────────────────────────────
 * No trim, no case folding, no fuzzy matching. "Furniture To Wall" and "Furniture to Wall" are
 * both real and both distinct in this data, and presenting them as one group would invite a
 * merge that silently fuses two different jobs' recorded times. Near misses are surfaced — they
 * are worth a human's attention — in a separate list that offers no actions at all.
 */

/** One copy of a duplicated name. */
interface DuplicateCopy {
  /** The row itself, as the merge path wants it — mergeJobs and preflightJobMerge take Jobs,
   * and handing them a fabricated shape would be this screen deciding what a job is. */
  job: Job
  jobId: string
  sectionId: string | null
  sectionName: string
  /** In the team's unsorted tray, per lib/sections' isSectionTray — the one tray predicate. */
  isTray: boolean
  teamId: string | null
  teamName: string
  operationCount: number
  timeCount: number
}

/**
 * How a group can be acted on. The order below is the order of increasing human involvement.
 *
 *   same-section       every copy shares a section → merge is already available, nothing to move
 *   same-team-tray     one team, at least one copy in the tray → the common case: move, then merge
 *   same-team-sections one team, several real sections → move, then merge
 *   cross-team         more than one team → NOT auto-mergeable. May be a genuine handoff (two
 *                      teams really do both do "Fit Hatches"), so this is flagged for a person
 *                      and offered no merge path at all.
 *
 * "Different lines" isn't here because it cannot occur: the whole tool is scoped to one
 * production line, so two copies on different lines are never in the same group.
 */
type GroupKind = 'same-section' | 'same-team-tray' | 'same-team-sections' | 'cross-team'

const KIND_META: Record<GroupKind, { label: string; tone: string; note: string }> = {
  'same-section': {
    label: 'Mergeable now', tone: 'dj-badge-green',
    note: 'Every copy is in the same section, so job merge can fold them together as it stands.',
  },
  'same-team-tray': {
    label: 'Move out of the tray, then merge', tone: 'dj-badge-blue',
    note: 'One team, with a copy sitting in the unsorted tray. Move it into the section that holds the keeper, then merge — merge is same-section only.',
  },
  'same-team-sections': {
    label: 'Move, then merge', tone: 'dj-badge-blue',
    note: 'One team, copies in different sections. Move one into the other’s section first — merge is same-section only.',
  },
  'cross-team': {
    label: 'Different teams — needs a decision', tone: 'dj-badge-amber',
    note: 'These copies belong to different teams, so this is not an automatic merge: it may be a genuine handoff where both teams really do this work. Moving a job between teams changes its team, and no merge is offered here.',
  },
}

interface DuplicateGroup {
  name: string
  copies: DuplicateCopy[]
  totalTimes: number
  totalOperations: number
  kind: GroupKind
  /** Section keys holding two or more copies — the only places merge may be offered. Keyed the
   * way lib/jobs' jobMergeGroupKey keys them, so this cannot offer a merge that mergeJobs would
   * refuse. */
  mergeableSectionKeys: string[]
}

/** Names that differ only by case or surrounding whitespace. Shown, never actioned. */
interface SimilarNameGroup {
  key: string
  variants: { name: string; count: number }[]
}

interface OperationRow { id: string; job_id: string }
interface TimeRow { id: string; operation_id: string }
interface TeamRow { id: string; name: string }

export default function DuplicateJobsDrawer({
  supabase, userId, productionLineId, productionLineName, onClose, onChanged,
}: {
  supabase: SupabaseClient
  /** Whose merge this is. A job merge FOLDS same-named operations together, and a fold moves
   * recorded times — so the operation-level ownership guard applies and needs to know who is
   * asking. Passed straight through to useMergeMode. */
  userId: string
  productionLineId: string
  productionLineName: string
  onClose: () => void
  /** Bumped after a move so the host's panes re-read — a job that has changed section has moved
   * column on the screen behind this drawer. */
  onChanged: () => void
}) {
  const { visible, openDrawer, closeDrawer } = useSlideOverDrawer()

  const [groups, setGroups] = useState<DuplicateGroup[]>([])
  const [similar, setSimilar] = useState<SimilarNameGroup[]>([])
  const [sections, setSections] = useState<Section[]>([])
  const [jobCount, setJobCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [notice, setNotice] = useState<string | null>(null)
  /** A reload triggered BY an action, which must not blank the list: the pane stays where it is,
   * the rows swap underneath, and the scroll position survives. Only the first read shows
   * "Reading…". */
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => { openDrawer() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  function handleClose() {
    closeDrawer()
    window.setTimeout(onClose, 320)
  }

  /**
   * ── The read ───────────────────────────────────────────────────────────────────────────
   *
   * Five reads, every one of them through lib/supabaseRead, and the last two are the reason the
   * module exists: `operation_times` under 120 duplicate jobs runs to thousands of rows, and a
   * capped response is a normal 200 with a short array — an unpaged read here would not fail, it
   * would under-report exactly the counts a person is about to make a decision on. That is the
   * failure this codebase has already had twice.
   *
   * The operations and times reads are deliberately scoped to the DUPLICATE jobs only, not to
   * every job on the line: the duplicate names are known after read 3, so reads 4 and 5 carry a
   * filter of ~120 job ids instead of ~1,200. Same answer, a fraction of the rows.
   */
  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      // 1. Sections on the line. Read through fetchAllRows rather than lib/sections'
      //    fetchSectionsForLine, which is a single unpaged request — the filters and the ordering
      //    are still that module's (same is_active rule, same sortSections), only the read is
      //    paged. A line's section count is nowhere near the cap today; "nowhere near the cap
      //    today" is what every truncated read in this codebase was before it wasn't.
      const sectionRows = await fetchAllRows<Section>(
        () => supabase
          .from('sections').select('*')
          .eq('production_line_id', productionLineId).eq('is_active', true)
          .order('sort_order').order('id') as unknown as RangeableQuery<Section>,
        { table: 'sections' },
      )
      const sortedSections = sortSections(sectionRows)

      // 2. Teams, to name the team each section belongs to.
      const teamRows = await fetchAllRows<TeamRow>(
        () => supabase
          .from('teams').select('id, name')
          .eq('production_line_id', productionLineId)
          .order('name').order('id') as unknown as RangeableQuery<TeamRow>,
        { table: 'teams' },
      )
      const teamNameById = new Map(teamRows.map((t) => [t.id, t.name]))

      // 3. Active jobs on the line. is_active = true: a merged-away job is not a duplicate to
      //    reconcile, it is one that already was.
      // Every column lib/types' Job declares, because these rows are handed straight to
      // preflightJobMerge and mergeJobs. Selecting three columns and padding out the rest would
      // mean this screen inventing values for fields the merge path may one day read.
      const jobs = await fetchAllRows<Job>(
        () => supabase
          .from('jobs').select('id, name, section_id, team_id, production_line_id, primary_operator_id, is_active, created_at')
          .eq('production_line_id', productionLineId).eq('is_active', true)
          .order('name').order('id') as unknown as RangeableQuery<Job>,
        { table: 'jobs' },
      )

      // EXACT string equality. No trim, no toLowerCase, no normalisation of any kind — see the
      // module note. The Map key IS the name.
      const byName = new Map<string, Job[]>()
      for (const j of jobs) {
        const list = byName.get(j.name)
        if (list) list.push(j)
        else byName.set(j.name, [j])
      }
      const duplicateNames = [...byName.entries()].filter(([, list]) => list.length > 1)
      const duplicateJobs = duplicateNames.flatMap(([, list]) => list)
      const duplicateJobIds = duplicateJobs.map((j) => j.id)

      // 4. Active operations under those jobs. A fan-out read — one job matches many operations
      //    — so the id list is chunked for the URL AND each chunk paged to exhaustion.
      const operations = duplicateJobIds.length === 0 ? [] : await fetchAllChunked<OperationRow>(
        duplicateJobIds, READ_CHUNK,
        (chunk) => supabase
          .from('operations').select('id, job_id')
          .in('job_id', chunk).eq('is_active', true)
          .order('job_id').order('id') as unknown as RangeableQuery<OperationRow>,
        { table: 'operations' },
      )

      // 5. THE BIG ONE: every recorded time under those operations. Thousands of rows across a
      //    filter of hundreds of operation ids. Chunked and paged; the order is (operation_id,
      //    id), a total order, which .range() paging requires to be sound.
      const operationIds = operations.map((o) => o.id)
      const times = operationIds.length === 0 ? [] : await fetchAllChunked<TimeRow>(
        operationIds, READ_CHUNK,
        (chunk) => supabase
          .from('operation_times').select('id, operation_id')
          .in('operation_id', chunk)
          .order('operation_id').order('id') as unknown as RangeableQuery<TimeRow>,
        { table: 'operation_times' },
      )

      // ── Roll the counts up: time → operation → job ──────────────────────────────────
      const timesByOperation = new Map<string, number>()
      for (const t of times) {
        timesByOperation.set(t.operation_id, (timesByOperation.get(t.operation_id) ?? 0) + 1)
      }
      const opCountByJob = new Map<string, number>()
      const timeCountByJob = new Map<string, number>()
      for (const o of operations) {
        opCountByJob.set(o.job_id, (opCountByJob.get(o.job_id) ?? 0) + 1)
        timeCountByJob.set(o.job_id, (timeCountByJob.get(o.job_id) ?? 0) + (timesByOperation.get(o.id) ?? 0))
      }

      const sectionById = new Map(sortedSections.map((s) => [s.id, s]))

      const built: DuplicateGroup[] = duplicateNames.map(([name, list]) => {
        const copies: DuplicateCopy[] = list.map((j) => {
          const section = j.section_id ? sectionById.get(j.section_id) ?? null : null
          const teamId = section?.team_id ?? null
          return {
            job: j,
            jobId: j.id,
            sectionId: j.section_id ?? null,
            // A job whose section_id points at a retired section, or at nothing, is a real
            // state — it is named as such rather than silently folded in with the tray, which
            // is a different thing with a real team behind it.
            sectionName: section ? section.name : j.section_id ? 'Section no longer active' : 'Not filed into any section',
            isTray: isSectionTray(section),
            teamId,
            teamName: teamId ? teamNameById.get(teamId) ?? 'Unknown team' : 'No team',
            operationCount: opCountByJob.get(j.id) ?? 0,
            timeCount: timeCountByJob.get(j.id) ?? 0,
          }
        }).sort((a, b) => b.timeCount - a.timeCount || b.operationCount - a.operationCount)

        const teamIds = new Set(copies.map((c) => c.teamId ?? '__none__'))
        // Keyed exactly as lib/jobs' jobMergeGroupKey keys a merge group, so a merge offered
        // here is one mergeJobs would accept. Both-unsectioned is ONE bucket, not many.
        const bySectionKey = new Map<string, number>()
        for (const c of copies) {
          const key = `section:${c.sectionId ?? ''}`
          bySectionKey.set(key, (bySectionKey.get(key) ?? 0) + 1)
        }
        const mergeableSectionKeys = [...bySectionKey.entries()].filter(([, n]) => n > 1).map(([k]) => k)

        const kind: GroupKind = teamIds.size > 1 ? 'cross-team'
          : bySectionKey.size === 1 ? 'same-section'
            : copies.some((c) => c.isTray) ? 'same-team-tray'
              : 'same-team-sections'

        return {
          name,
          copies,
          totalTimes: copies.reduce((s, c) => s + c.timeCount, 0),
          totalOperations: copies.reduce((s, c) => s + c.operationCount, 0),
          kind,
          mergeableSectionKeys,
        }
      })

      // Most data at stake first — the expensive reconciliations are the ones worth a person's
      // attention, and the cheap ones will still be here tomorrow.
      built.sort((a, b) => b.totalTimes - a.totalTimes || b.totalOperations - a.totalOperations || a.name.localeCompare(b.name))

      // ── Near misses, listed and never actioned ──────────────────────────────────────
      // Grouped on a normalised key ONLY to find them. The names themselves are never altered,
      // never merged and offer no buttons: the whole point is that they are distinct.
      const byLoose = new Map<string, Map<string, number>>()
      for (const [name, list] of byName) {
        const key = name.trim().toLowerCase().replace(/\s+/g, ' ')
        const variants = byLoose.get(key) ?? new Map<string, number>()
        variants.set(name, (variants.get(name) ?? 0) + list.length)
        byLoose.set(key, variants)
      }
      const similarGroups: SimilarNameGroup[] = [...byLoose.entries()]
        .filter(([, variants]) => variants.size > 1)
        .map(([key, variants]) => ({
          key,
          variants: [...variants.entries()]
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.key.localeCompare(b.key))

      setSections(sortedSections)
      setGroups(built)
      setSimilar(similarGroups)
      setJobCount(duplicateJobs.length)
    } catch (err) {
      logSupabaseError('duplicate jobs', err as { message?: string })
      setError(err instanceof Error ? err.message : 'Could not read this line’s jobs')
      setGroups([])
      setSimilar([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [supabase, productionLineId])

  // The first read only. Every later one is a quiet refresh driven by an action — see resolve().
  useEffect(() => { void load() }, [load])

  /**
   * What happens after a merge or a move: re-read, IN PLACE.
   *
   * Everything the list shows is derived from the five reads, so re-running them is what makes a
   * merged-away copy disappear, the survivor's operation and time counts go up, a group with one
   * copy left drop out of the list entirely, and the header's "16 duplicated names across 35
   * jobs" recalculate. Nothing is patched locally — a screen that adjusted its own counts after a
   * merge would be a second, quieter implementation of what the merge actually did.
   *
   * `quiet` is the whole point: the list is not replaced by a spinner, so the pane does not jump
   * and 16 groups' worth of scrolling is not lost. The summary is held at DRAWER level rather
   * than in the group's own card, because the card it came from may be about to unmount.
   */
  const resolve = useCallback(async (message: string) => {
    if (message) setNotice(message)
    await load(true)
    onChanged()
  }, [load, onChanged])

  const totalTimesAtStake = useMemo(() => groups.reduce((s, g) => s + g.totalTimes, 0), [groups])

  return (
    <>
      <div
        className={`gaps-drawer-overlay${visible ? ' gaps-drawer-overlay-visible' : ''}`}
        onClick={handleClose}
      />
      <aside className={`gaps-drawer${visible ? ' gaps-drawer-visible' : ''}`} style={{ width: '50vw' }}>
        <div className="gaps-drawer-header">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div className="gaps-drawer-title">Duplicate jobs</div>
              <div className="gaps-drawer-jobname">{productionLineName}</div>
            </div>
            <button type="button" className="gaps-drawer-close" onClick={handleClose} aria-label="Close">×</button>
          </div>
          {!loading && !error && (
            <p className="dj-summary">
              <strong>{plural(groups.length, 'duplicated name')}</strong> across{' '}
              <strong>{plural(jobCount, 'job')}</strong>, holding{' '}
              <strong>{plural(totalTimesAtStake, 'time record')}</strong> between them.
              Ordered by how much is at stake.
            </p>
          )}
        </div>

        <div className="gaps-drawer-body dj-body">
          {error && <p className="dj-error">{error}</p>}
          {notice && (
            <p className="dj-notice">
              {notice}
              <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
            </p>
          )}

          {loading ? (
            <p className="dj-empty">Reading the line’s jobs, operations and time records…</p>
          ) : groups.length === 0 && similar.length === 0 ? (
            <p className="dj-empty">No job name appears twice on this line.</p>
          ) : (
            <>
              {/* Said before the list, because the counts are the one thing a reader is likely
                  to skim past and the one thing the decision turns on. */}
              <p className="dj-preamble">
                A copy in the unsorted tray is <strong>not</strong> automatically the stale one —
                on this data the tray copy is often the one carrying most of the collection. Read
                the operation and time counts before deciding which copy is canonical.
                Nothing here changes anything until you press something.
              </p>

              {groups.map((group) => (
                <DuplicateGroupCard
                  key={group.name}
                  group={group}
                  sections={sections}
                  supabase={supabase}
                  userId={userId}
                  busy={refreshing}
                  onResolved={resolve}
                />
              ))}

              {/* ── Near misses ─────────────────────────────────────────────────────────
                  Deliberately last, deliberately styled apart, and deliberately without a single
                  button. These names are DIFFERENT. They are here because a person may want to
                  rename one, which is a decision made on the job itself, not a merge. */}
              {similar.length > 0 && (
                <section className="dj-similar">
                  <h3 className="dj-similar-head">Similar names ({similar.length})</h3>
                  <p className="dj-similar-note">
                    These differ only by capitalisation or spacing, so they are <strong>not</strong> duplicates
                    and nothing here will act on them — names are matched exactly, on purpose.
                    “Furniture To Wall” and “Furniture to Wall” are two real, distinct jobs in this
                    data. If one is genuinely a typo, rename it on the job itself and it will
                    appear above.
                  </p>
                  {similar.map((s) => (
                    <div key={s.key} className="dj-similar-row">
                      {s.variants.map((v) => (
                        <span key={v.name} className="dj-similar-variant">
                          {v.name} <span className="dj-similar-count">×{v.count}</span>
                        </span>
                      ))}
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  )
}

/**
 * ── One duplicated name, and everything you can do about it ────────────────────────────────
 *
 * A component per group so each carries its OWN merge mode. That matters: useMergeMode locks
 * onto the first ticked row's `groupKey` and disables anything outside it, so one instance per
 * group means ticking "Furniture To Wall"'s copies can never reach "Shower Build"'s, even though
 * both are jobs in the same section and lib/jobs would happily merge them. The scope a person
 * expects — "these copies of this name" — is enforced by the component boundary rather than by
 * remembering to check.
 *
 * Nothing about merge is reimplemented here. useMergeMode owns the selection, the explicit
 * keeper, the preflight, the ownership blocker and the write; MergeFooter, MergeRowItem,
 * MergeNotices and MergeConfirm are its markup; lib/jobs' mergeJobs does the writing and
 * re-checks the same-section rule itself. This file contributes rows and a detail block.
 */
function DuplicateGroupCard({ group, sections, supabase, userId, busy, onResolved }: {
  group: DuplicateGroup
  sections: Section[]
  supabase: SupabaseClient
  userId: string
  /** A refresh is in flight — the card's own buttons stand down rather than acting on rows that
   * are about to be replaced. */
  busy: boolean
  onResolved: (message: string) => Promise<void>
}) {
  const meta = KIND_META[group.kind]
  const [moveTarget, setMoveTarget] = useState<{ jobId: string; sectionId: string } | null>(null)
  const [movingJobId, setMovingJobId] = useState<string | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)

  /**
   * The rows merge mode offers.
   *
   * `groupKey` is keyed exactly as lib/jobs' jobMergeGroupKey keys a merge group, so the locking
   * the hook does and the check mergeJobs performs before writing are the same rule — the UI
   * cannot offer a merge the write path would refuse.
   *
   * The NAME carries the section, which it would not need to anywhere else in the app: every
   * copy here has the same job name by definition, so a confirmation reading "Retiring 3 jobs:
   * Furniture To Wall, Furniture To Wall, Furniture To Wall" would name nothing. Qualifying it is
   * the only way the dialog can say which row survives.
   */
  const rows: MergeRow<Job>[] = useMemo(
    () => group.copies.map((c) => ({
      id: c.jobId,
      name: `${c.job.name} · ${c.sectionName}${c.isTray ? ' (tray)' : ''}`,
      groupKey: `section:${c.sectionId ?? ''}`,
      subject: c.job,
    })),
    [group.copies],
  )

  const merge = useMergeMode({ level: 'job', supabase, userId, rows, onMerged: onResolved })

  const copyById = useMemo(() => new Map(group.copies.map((c) => [c.jobId, c])), [group.copies])

  /** Same-team sections this copy could move to, minus the one it is already in. A copy whose
   * section has no team has nothing to scope against and is offered no move — moving it is a
   * filing decision that needs a team chosen first, on the job's own panel. */
  function targetsFor(copy: DuplicateCopy): Section[] {
    if (!copy.teamId) return []
    return sections.filter((s) => s.team_id === copy.teamId && s.id !== copy.sectionId)
  }

  /**
   * MOVE — through setJobSection, the single writer of jobs.section_id, which is also the one
   * place that knows the section dictates team_id and production_line_id. Nothing here writes a
   * jobs row itself.
   *
   * In place, like the merge beside it: the picker is inline, the write is one call, and the
   * result is the same quiet re-read. No navigation, and the pane does not move.
   *
   * Targets are scoped to the copy's OWN TEAM — a job's team is its section's team, so moving
   * across teams is a reassignment rather than a tidy-up, and that belongs on the job's own edit
   * panel where it can be stated as such.
   */
  async function handleMove(copy: DuplicateCopy) {
    if (!moveTarget || moveTarget.jobId !== copy.jobId) return
    const section = sections.find((s) => s.id === moveTarget.sectionId)
    if (!section) return
    setMovingJobId(copy.jobId)
    setMoveError(null)
    try {
      await setJobSection(supabase, copy.jobId, section)
      setMoveTarget(null)
      await onResolved(`“${copy.job.name}” moved into ${section.name}. Its copies there can now be merged.`)
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : 'Could not move that job')
    } finally {
      setMovingJobId(null)
    }
  }

  return (
    <section className="dj-group">
      <header className="dj-group-head">
        <span className="dj-group-name">{group.name}</span>
        <span className={`dj-badge ${meta.tone}`}>{meta.label}</span>
      </header>
      <p className="dj-group-stats">
        {group.copies.length} copies · {plural(group.totalOperations, 'operation')} ·{' '}
        <strong>{plural(group.totalTimes, 'time record')}</strong>
      </p>
      <p className="dj-group-note">{meta.note}</p>

      {/* The shared refusal/result lines — including the time-ownership blocker, which is what
          a merge is stopped by when somebody else collected the times underneath it. It is shown
          HERE, on the group, and the flow stays exactly where it was: nothing closes, nothing
          navigates, and the ticks survive so the selection can be narrowed and retried. */}
      <MergeNotices merge={merge} />
      {moveError && <p className="dj-error" style={{ margin: '8px 0' }}>{moveError}</p>}

      {merge.active ? (
        // In merge mode the pane swaps its normal rows for the shared ones wholesale — the same
        // thing the Sections, Jobs and Operations panes do, and for the same reason: in merge
        // mode a row's only job is to be ticked, so Move… is gone rather than merely ignored.
        <div className="dj-merge-rows">
          {rows.map((row) => {
            const copy = copyById.get(row.id)
            return (
              <MergeRowItem
                key={row.id}
                merge={merge}
                row={row}
                meta={copy && (
                  <>
                    {copy.teamName}
                    {copy.isTray && ' · unsorted tray'}
                    {' · '}<strong>{copy.operationCount}</strong> ops
                    {' · '}<strong>{copy.timeCount}</strong> times
                  </>
                )}
              />
            )
          })}
        </div>
      ) : (
        group.copies.map((copy) => {
          const targets = targetsFor(copy)
          const picking = moveTarget?.jobId === copy.jobId
          return (
            <div key={copy.jobId} className="dj-copy">
              <div className="dj-copy-where">
                <span className="dj-copy-section">
                  {copy.sectionName}
                  {copy.isTray && <span className="dj-tray">unsorted tray</span>}
                </span>
                <span className="dj-copy-team">{copy.teamName}</span>
              </div>
              {/* The two figures the decision is made on, given the most weight in the row
                  rather than tucked at the end of a sentence. */}
              <div className="dj-copy-counts">
                <span><strong>{copy.operationCount}</strong> ops</span>
                <span className={copy.timeCount > 0 ? 'dj-count-hot' : undefined}>
                  <strong>{copy.timeCount}</strong> times
                </span>
              </div>
              <div className="dj-copy-actions">
                {targets.length > 0 ? (
                  picking ? (
                    <span className="dj-move-row">
                      <select
                        className="dj-move-select"
                        value={moveTarget?.sectionId ?? ''}
                        onChange={(e) => setMoveTarget({ jobId: copy.jobId, sectionId: e.target.value })}
                      >
                        <option value="">— Move to —</option>
                        {targets.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}{isSectionTray(s) ? ' (tray)' : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="dj-action dj-action-go"
                        disabled={!moveTarget?.sectionId || movingJobId === copy.jobId || busy}
                        onClick={() => handleMove(copy)}
                      >
                        {movingJobId === copy.jobId ? 'Moving…' : 'Move'}
                      </button>
                      <button type="button" className="dj-action" onClick={() => setMoveTarget(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="dj-action"
                      disabled={busy}
                      title={`Move this copy to another section in ${copy.teamName}`}
                      onClick={() => setMoveTarget({ jobId: copy.jobId, sectionId: '' })}
                    >
                      Move…
                    </button>
                  )
                ) : (
                  <span className="dj-action-none" title="A job's team comes from its section — this copy has no team to scope a move against">
                    No move target
                  </span>
                )}
              </div>
            </div>
          )
        })
      )}

      {/* The shared Merge button and, once armed, the shared instruction line and Cancel. It
          disables itself with a reason when there is nothing here that could be folded, rather
          than disappearing — see MergeFooter. */}
      <div className="dj-merge-footer">
        <MergeFooter merge={merge} />
      </div>

      {/* The shared confirmation. `detail` is MergeMode's own extension point for a host that
          can say something the module can't: here, what each copy is carrying into the merge —
          which is the whole reason this screen exists, and the last moment it can be read before
          the decision is irreversible. */}
      <MergeConfirm
        merge={merge}
        detail={
          <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>What each copy is carrying:</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {group.copies
                .filter((c) => merge.selectedIds.has(c.jobId))
                .map((c) => (
                  <li key={c.jobId}>
                    {c.sectionName}{c.isTray ? ' (tray)' : ''} · {c.teamName} —{' '}
                    <strong>{plural(c.operationCount, 'operation')}</strong>,{' '}
                    <strong>{plural(c.timeCount, 'time record')}</strong>
                    {merge.primaryId === c.jobId && <> — <strong>keeping this one</strong></>}
                  </li>
                ))}
            </ul>
          </div>
        }
      />
    </section>
  )
}
