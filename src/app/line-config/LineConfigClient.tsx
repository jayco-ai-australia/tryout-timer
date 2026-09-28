'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import ConfirmDialog from '@/components/ConfirmDialog'
import BulkModelLinkDrawer, { DRAWER_WIDTH, useSlideOverDrawer } from '@/components/BulkModelLinkDrawer'
import OperationEditDrawer from '@/components/OperationEditDrawer'
import { JobModelBadge } from '@/components/FinderPanes'
import {
  MergeConfirm, MergeNotices, useMergeMode, type MergeRow,
} from '@/components/MergeMode'
import { plural } from '@/lib/format'
import { usePersistedFilter } from '@/lib/useLocalStorage'
import { READ_CHUNK, fetchAllChunked, type RangeableQuery } from '@/lib/supabaseRead'
import {
  createSection, countJobsInSectionByState, deleteSection, fetchSectionsForLine, isSectionTray,
  JobNameConflictError, moveSection, renameSection, sectionMergeGroupKey, setJobSection,
  sortSections,
} from '@/lib/sections'
import DuplicateJobsDrawer from '@/components/DuplicateJobsDrawer'
import { createJob, deleteJobPermanently, jobMergeGroupKey, restoreJob, retireJob } from '@/lib/jobs'
import { canDeleteSection, canRestoreJob } from '@/lib/permissions'
import { modelsForLine } from '@/lib/lines'
import {
  createOperation, createOperations, parseOperationNames, retireOperation, setOperationJob,
} from '@/lib/operations'
import type { Job, Operation, ProductionLine, Section, Team, UserRole } from '@/lib/types'

/**
 * /line-config — "Production Line Config". STRUCTURE ONLY.
 *
 * The question this screen answers is "what teams, sections, jobs and operations exist on this
 * line, and does that match the org chart". It is configured once per line and then left alone.
 *
 * ── What it deliberately does NOT do ──────────────────────────────────────────────────────
 * No times. No minutes, no averages, no history, no coverage — not one number derived from
 * operation_times appears anywhere except the count inside a delete confirmation, which is
 * there to say what a delete would hide. The has-times DOT is not a value: it is a signal that
 * merging or deleting this row touches collected data, and it is deliberately not a count so
 * nobody starts reading this page for progress.
 *
 * No operation-level model linking either. The job-level "38 / 89 models" badge and the panel
 * behind it are the only model surface, and both are the existing ones.
 *
 * ── Sibling of /setup, not a replacement ──────────────────────────────────────────────────
 * /setup is untouched and still does everything it did. The two overlap on purpose while this
 * one proves out; one of them gets retired later. Everything structural here goes through the
 * SAME lib modules /setup writes through — sections.ts, jobs.ts, operations.ts, mergeOperations
 * via the shared merge hook — so there is no second writer for anything and the two screens
 * cannot drift into different ideas of what a rename, a move or a merge does.
 *
 * ── Why cards and not a fourth Finder pane ────────────────────────────────────────────────
 * The core flow is "are these two jobs the same job?", and answering it means reading both jobs'
 * operation lists AT ONCE. A pane shows one selection's children; a card list can have several
 * open together, side by side, which is why MORE THAN ONE JOB CAN BE EXPANDED. Job names on this
 * line run to "12V/240V Rough In - Offside" and nothing on this page truncates one.
 *
 * ── Model links survive everything here ───────────────────────────────────────────────────
 * Merge, move and rename all leave model_operations alone: those rows hang off operation_id, and
 * every write on this page changes operations.job_id, operations.name, jobs.section_id or an
 * is_active flag — never an operation's identity. Merging two jobs therefore UNIONS their
 * operations' model links onto the keeper by construction: the operations themselves move,
 * carrying their links. Nothing here removes applicability, and the one control that could
 * (the model panel) is the existing one, opened unchanged.
 *
 * ── Deletes are soft ──────────────────────────────────────────────────────────────────────
 * A job or operation deleted here is RETIRED — is_active = false, via lib/jobs' retireJob and
 * lib/operations' retireOperation. /setup hard-deletes and can therefore only offer it on rows
 * with no children and no times, because operation_times and model_operations cascade. Retiring
 * keeps all of it and can be undone in the database, which is what makes it offerable on a job
 * that HAS been timed — the common case on a line somebody is actually tidying.
 *
 * Sections are the exception: lib/sections' deleteSection is a real delete (a section owns no
 * history of its own — jobs point at it), guarded on "no jobs point here" and, like /setup,
 * offered to admins only.
 */

// ── Reads ───────────────────────────────────────────────────────────────────────────────────
/**
 * ONE fetch per scope change, and none of them inside a loop or a map. Six in total, split by
 * what they actually depend on so switching team does not re-read the line's reference data:
 *
 *   per LINE   1. sections          (lib/sections' fetchSectionsForLine)
 *              2. products          (lib/lines' modelsForLine — the "/ 89 models" denominator,
 *                                   which follows a pre-assembly line's feeds)
 *   per TEAM   3. jobs              .in('section_id', …) over the team's sections
 *              4. operations        .in('job_id', …)
 *              5. model_operations  .in('operation_id', …)   → the job model badges AND the panel
 *              6. operation_times   .in('operation_id', …)   → the has-times dots AND the counts
 *                                                             a delete confirmation quotes
 *
 * 5 and 6 run concurrently; both are derived entirely client-side afterwards, so no badge, dot
 * or confirmation costs a further read. /setup's runaway sweep came from fetching before the
 * persisted filters had restored — `filtersRestored` below is the same guard, for the same
 * reason.
 *
 * ── Which chunking helper, and why not all of them are selectIn ───────────────────────────
 * Every `.in()` on this page is chunked; none is raw. But the four reads above are FAN-OUT
 * reads — one section has many jobs, one operation has many times — so they go through
 * lib/supabaseRead's fetchAllChunked, which chunks the URL AND pages the response, rather than
 * lib/chunkedIn's selectIn, which only chunks. selectIn is complete for a lookup keyed by
 * primary key, where a chunk of 100 ids returns at most 100 rows; on a fan-out read a single
 * chunk can blow past the 1,000-row response cap and be silently truncated, which is exactly
 * how a job would go missing from this page with no error. operation_times on a busy line is
 * far past that cap. See the "RELATIONSHIP TO fetchAllChunked" note in lib/chunkedIn, which
 * says the same thing from the other side.
 */
interface StructureData {
  /**
   * The team's jobs, RETIRED ONES INCLUDED — split into the two lists below by the caller.
   *
   * The jobs read used to carry `.eq('is_active', true)`, and that is what made a retired job an
   * invisible blocker: `sections`' delete guard counts every row pointing at a section (it has
   * to — jobs.section_id is a real reference whether or not the job is listed), so a section
   * holding one merged-away job showed "0 jobs", offered its delete, and then refused it with a
   * count of a job on no screen in the app. Reading both states costs one filter and makes the
   * obstacle nameable; the pane still shows only live jobs until asked (see `showRetired`).
   */
  jobs: Job[]
  operationsByJob: Record<string, Operation[]>
  /** operation_id × product_id, kept whole: the job badges, the model panel's per-model
   * "3 of 8 operations" counts and nothing else all derive from this one read. */
  modelLinkPairs: { operation_id: string; product_id: string }[]
  /** operation_id → how many recorded times hang off it. The dot asks `> 0`; the delete
   * confirmations quote the number. One read, both jobs. Spans RETIRED operations too — see the
   * times read — so a retired job's totals below are the whole truth. */
  timeCountByOperation: Map<string, number>
  /**
   * job_id → everything a HARD delete of that job row would take with it: every operation filed
   * under it (retired included) and every recorded time under those.
   *
   * Separate from `operationsByJob` and `jobTimeCounts`, which are about what is on SCREEN, because
   * the two questions have different answers on exactly the rows that matter. A merged-away job
   * shows "0 ops" — its live operations left with the merge — while still holding retired ones whose
   * history would cascade away with the row. `{ operations: 0, times: 0 }` here is the only thing
   * that makes "this shell is empty" a safe claim.
   */
  contentsByJob: Map<string, { operations: number; times: number }>
}

const EMPTY_STRUCTURE: StructureData = {
  jobs: [], operationsByJob: {}, modelLinkPairs: [], timeCountByOperation: new Map(),
  contentsByJob: new Map(),
}

export default function LineConfigClient({ lines, role, userId, defaultLineId }: {
  lines: ProductionLine[]
  role: UserRole
  userId: string
  /** profiles.production_line_id — the viewer's own line, the same source /dashboard and
   * /reports open on. Blank when they have none set. */
  defaultLineId: string
}) {
  const supabase = useMemo(() => createClient(), [])

  /**
   * Where the page opens when nothing is stored: the viewer's OWN line, falling back to the
   * first line only if their profile has none (or names a line that no longer exists).
   *
   * It used to be `lines[0]`, which is alphabetical — Camper Trailer. That line's first team
   * has no sections, so a first-time user landed on a blank screen and reasonably concluded the
   * page was broken. The first row of a list is not a default; it is an accident of ordering.
   */
  const fallbackLineId = useMemo(
    () => (lines.some((l) => l.id === defaultLineId) ? defaultLineId : lines[0]?.id ?? ''),
    [lines, defaultLineId]
  )

  // ── Address: line, then team. Team is part of the address, not a refinement — "what sections
  // are in Team 1 on Caravan" is the question, so there is no "All teams".
  const [lineId, setLineId] = usePersistedFilter('lineconfig.line', fallbackLineId)
  const [teamId, setTeamId] = usePersistedFilter('lineconfig.team', '')
  const [sectionId, setSectionId] = usePersistedFilter('lineconfig.section', '')

  /** Same guard /setup needed: usePersistedFilter restores in a mount effect, so the first
   * render has no line and no team. Fetching then would read a scope nobody asked for and be
   * thrown away a tick later. */
  const [filtersRestored, setFiltersRestored] = useState(false)
  useEffect(() => { setFiltersRestored(true) }, [])

  const [teams, setTeams] = useState<Team[]>([])
  const [sections, setSections] = useState<Section[]>([])
  const [lineProductCount, setLineProductCount] = useState(0)
  const [structure, setStructure] = useState<StructureData>(EMPTY_STRUCTURE)
  const [loadingLine, setLoadingLine] = useState(false)
  const [loadingStructure, setLoadingStructure] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /** Bumped by every write, to re-run the loaders. One number rather than a callback threaded
   * through a dozen handlers. */
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])
  /** The applies-list changed but nothing structural did — re-read only what the badges need. */
  const [modelVersion, setModelVersion] = useState(0)

  const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(new Set())

  /**
   * ── "Show deleted jobs" ────────────────────────────────────────────────────────────────
   *
   * OFF by default and session-scoped, not persisted: a retired job is retired, and a remembered
   * ON would show the next person rows the rest of the app has agreed to hide, in a pane whose
   * counts deliberately exclude them.
   *
   * It exists because a retired job is not merely hidden — it still holds section_id, so it still
   * blocks a section delete, and it still occupies its name's slot in the jobs unique constraint,
   * so it still blocks a move. Both refusals were unexplainable while there was no way to see it.
   */
  const [showRetired, setShowRetired] = useState(false)

  /**
   * The duplicate-jobs finder, the SAME drawer /setup mounts — not a second one. It is the answer
   * to a name collision, so the collision message opens it, and it is also offered on its own
   * because a user who has just been told "the destination team already has one of these" should
   * not have to go to another screen to see both copies.
   */
  const [duplicatesOpen, setDuplicatesOpen] = useState(false)
  /** Set alongside pageError when a write failed on the jobs name/team uniqueness constraint —
   * it turns the banner into something with a way out. Cleared by every subsequent write. */
  const [conflictOffer, setConflictOffer] = useState<string | null>(null)

  /**
   * ── Drag a job onto a section ──────────────────────────────────────────────────────────
   * Native HTML5 drag events, no library. `dragging` is non-null only between dragstart and
   * dragend, and holds the jobs the drop will actually move — see `beginJobDrag` for why that
   * is not always the one card under the cursor.
   *
   * The ⇄ button on every card still does the same move through the same writer. Drag is the
   * fast path for a mouse; HTML5 drag does not fire on touch at all, so on a tablet the button
   * is the ONLY path and deleting it would have made this feature a regression.
   */
  const [dragging, setDragging] = useState<{ jobIds: string[]; label: string } | null>(null)
  /** The section row currently under the pointer, highlighted more strongly than the rest. */
  const [dragOverSectionId, setDragOverSectionId] = useState<string | null>(null)

  // ── Reference data: teams, once. ───────────────────────────────────────────────────────
  useEffect(() => {
    supabase.from('teams').select('*').order('name').then(({ data, error }) => {
      if (error) { setPageError(error.message); return }
      setTeams((data ?? []) as Team[])
    })
  }, [supabase])

  const lineTeams = useMemo(
    () => teams.filter((t) => t.production_line_id === lineId),
    [teams, lineId]
  )

  /**
   * THE STALENESS GUARD, on the line.
   *
   * localStorage remembers a line independently of whether that line still exists or is still
   * offered — rename it, retire it, or open the app against a different environment, and the
   * stored id restores into a select with no matching option. The page then renders a blank
   * control and an empty screen, which is exactly how /setup's Sections pane emptied itself.
   * A stored id that isn't among the current options is discarded, not honoured.
   */
  useEffect(() => {
    if (!filtersRestored || lines.length === 0) return
    if (!lines.some((l) => l.id === lineId)) setLineId(fallbackLineId)
  }, [filtersRestored, lines, lineId, fallbackLineId, setLineId])

  /**
   * Sections that are a real step of a team's walk — the tray excluded.
   *
   * The tray matters here because EVERY team on a line has one (see lib/sections), so "has any
   * sections row" is true of every team and would make the default below a no-op. A team whose
   * only section is its unsorted tray is precisely the blank screen this is avoiding.
   */
  const teamsWithSections = useMemo(() => {
    const withWalk = new Set(
      sections.filter((sec) => !isSectionTray(sec) && sec.team_id).map((sec) => sec.team_id as string)
    )
    return lineTeams.filter((t) => withWalk.has(t.id))
  }, [sections, lineTeams])

  /**
   * THE STALENESS GUARD, on the team — and the default that picks a team worth landing on.
   *
   * Never "all": a section belongs to one team, so there is no such view. The default is the
   * line's first team THAT ACTUALLY HAS A WALK, falling back to its first team only when no
   * team on the line has one (in which case every choice is equally empty and the honest thing
   * is to show one rather than none).
   *
   * Runs after sections load, so it re-picks once the line's walk is known. A stored team that
   * belongs to another line is discarded by the same `some(...)` test — that is the repair
   * /setup shipped without.
   */
  useEffect(() => {
    if (!filtersRestored || lineTeams.length === 0) return
    if (lineTeams.some((t) => t.id === teamId)) return
    // Waiting for the line's sections before choosing: picking now would land on the first team
    // and then never revisit it, which is the old behaviour with extra steps.
    if (loadingLine) return
    setTeamId((teamsWithSections[0] ?? lineTeams[0]).id)
  }, [filtersRestored, lineTeams, teamId, setTeamId, teamsWithSections, loadingLine])

  // ── Per LINE: sections and the model denominator. ──────────────────────────────────────
  useEffect(() => {
    if (!filtersRestored || !lineId) { setSections([]); setLineProductCount(0); return }
    let cancelled = false
    setLoadingLine(true)
    Promise.all([
      fetchSectionsForLine(supabase, lineId),
      // Through lib/lines, not a head-count by line: a pre-assembly line owns no products and
      // inherits the models of the lines it feeds, so counting `production_line_id = <this line>`
      // gave Chassis, Sew and the rest a denominator of 0 and a "n / 0 models" badge on every
      // job. The rows are counted rather than a COUNT header read — the resolver has to fetch
      // them either way to know which line's products to look at.
      modelsForLine(supabase, lineId).then((rows) => rows.length),
    ])
      .then(([sectionRows, productCount]) => {
        if (cancelled) return
        setSections(sectionRows)
        setLineProductCount(productCount)
      })
      .catch((err) => { if (!cancelled) setPageError(err instanceof Error ? err.message : 'Could not load this line') })
      .finally(() => { if (!cancelled) setLoadingLine(false) })
    return () => { cancelled = true }
  }, [supabase, filtersRestored, lineId, version])

  /** The team's own walk, in sort_order with its unsorted tray pinned first (lib/sections). */
  const teamSections = useMemo(
    () => sortSections(sections.filter((s) => s.team_id === teamId)),
    [sections, teamId]
  )
  /** Depended on as a string so the structure loader re-runs when the SET of sections changes,
   * not on every render that rebuilds an equal array. */
  const teamSectionKey = useMemo(() => teamSections.map((s) => s.id).join(','), [teamSections])

  // ── Per (LINE, TEAM): the four structural reads. ───────────────────────────────────────
  useEffect(() => {
    if (!filtersRestored || !lineId || !teamId) { setStructure(EMPTY_STRUCTURE); return }
    const sectionIds = teamSectionKey ? teamSectionKey.split(',') : []
    if (sectionIds.length === 0) { setStructure(EMPTY_STRUCTURE); return }

    let cancelled = false
    setLoadingStructure(true)
    ;(async () => {
      try {
        // 3. Jobs in this team's sections. Fan-out, so chunked AND paged.
        //    NOT filtered to is_active — see StructureData.jobs. The pane splits them.
        const jobRows = await fetchAllChunked<Job>(
          sectionIds, READ_CHUNK,
          (chunk) => supabase.from('jobs')
            .select('id, name, primary_operator_id, team_id, production_line_id, section_id, is_active, created_at')
            .in('section_id', chunk).order('id') as unknown as RangeableQuery<Job>,
          { table: 'jobs' }
        )
        const jobIds = jobRows.map((j) => j.id)

        // 4. Their operations.
        //
        // NOT filtered to is_active, and that is load-bearing rather than tidy. The pane still
        // LISTS only the live ones (`opRows` below), but "this retired job is an empty shell, so
        // deleting the row destroys nothing" is a claim about every operation ever filed under it —
        // and operations.job_id cascades on delete, with operation_times.operation_id cascading from
        // there. Counting only the live ones would let a job whose remaining operations are merely
        // hidden be deleted, taking their recorded history with it. /setup's own job delete guard
        // carries the same note for the same reason.
        const allOpRows = jobIds.length === 0 ? [] : await fetchAllChunked<Operation>(
          jobIds, READ_CHUNK,
          (chunk) => supabase.from('operations').select('*')
            .in('job_id', chunk).order('id') as unknown as RangeableQuery<Operation>,
          { table: 'operations' }
        )
        /** Every operation id under these jobs, retired included. The times AND the model links
         * both span this: every operation that gets LISTED on a card has to have its times and its
         * model links counted, and a retired job lists its retired operations (see operationsByJob
         * below). Narrowing either read to live operations is what made a retired job's row
         * disagree with the guard about it. */
        const allOpIds = allOpRows.map((o) => o.id)

        // 5 and 6, concurrently — neither feeds the other.
        const [pairs, timeRows] = await Promise.all([
          // Over EVERY operation, not just the live ones. jobModelCounts below resolves a pair to
          // a job through the operations a card actually LISTS, so a live job's badge is unchanged
          // by this (its retired operations are not listed, so their pairs are skipped) — what it
          // adds is the badge for a retired job, whose card lists its retired operations.
          allOpIds.length === 0 ? Promise.resolve([]) : fetchAllChunked<{ operation_id: string; product_id: string }>(
            allOpIds, READ_CHUNK,
            (chunk) => supabase.from('model_operations').select('operation_id, product_id')
              .in('operation_id', chunk)
              .order('operation_id').order('product_id') as unknown as RangeableQuery<{ operation_id: string; product_id: string }>,
            { table: 'model_operations' }
          ),
          // Times span EVERY operation, live or retired. This only ever adds entries to
          // timeCountByOperation — the dots and the delete confirmations read it by live operation
          // id and are unchanged — and it is what lets a retired job's "no recorded times" be true.
          allOpIds.length === 0 ? Promise.resolve([]) : fetchAllChunked<{ id: string; operation_id: string }>(
            allOpIds, READ_CHUNK,
            (chunk) => supabase.from('operation_times').select('id, operation_id')
              .in('operation_id', chunk).order('id') as unknown as RangeableQuery<{ id: string; operation_id: string }>,
            { table: 'operation_times' }
          ),
        ])
        if (cancelled) return

        /**
         * ── What each card LISTS, and the invariant that has to hold ──────────────────────
         *
         * A LIVE job lists its live operations — a retired operation was merged into a keeper and
         * its times went with it, so it is not part of that job any more.
         *
         * A RETIRED job lists ALL of its operations, retired ones included. That is the fix for a
         * row that read "0 ops" while the delete guard refused it for holding work: the badge was
         * counting live operations and the guard was counting every operation, both correctly, and
         * the screen showed the two side by side without saying they were answers to different
         * questions. For a retired job this list and `contentsByJob` below are now the SAME set, so
         * the row, the expanded list and the guard cannot disagree.
         */
        const retiredJobIds = new Set(jobRows.filter((j) => j.is_active === false).map((j) => j.id))
        const operationsByJob: Record<string, Operation[]> = {}
        for (const id of jobIds) operationsByJob[id] = []
        for (const op of allOpRows) {
          if (op.is_active === false && !retiredJobIds.has(op.job_id)) continue
          ;(operationsByJob[op.job_id] ??= []).push(op)
        }
        for (const list of Object.values(operationsByJob)) list.sort((a, b) => a.name.localeCompare(b.name))

        const timeCountByOperation = new Map<string, number>()
        for (const t of timeRows) {
          timeCountByOperation.set(t.operation_id, (timeCountByOperation.get(t.operation_id) ?? 0) + 1)
        }

        // What a hard delete would actually destroy, per job: EVERY operation filed under it and
        // every recorded time under those. The one question "is this shell empty?" turns on.
        //
        // For a retired job this is the same set operationsByJob lists, which is the point — the
        // badge on the row and the guard on the × are the same two numbers, not two counts of
        // different things that happen to sit next to each other.
        const contentsByJob = new Map<string, { operations: number; times: number }>()
        for (const id of jobIds) contentsByJob.set(id, { operations: 0, times: 0 })
        for (const op of allOpRows) {
          const entry = contentsByJob.get(op.job_id) ?? { operations: 0, times: 0 }
          entry.operations += 1
          entry.times += timeCountByOperation.get(op.id) ?? 0
          contentsByJob.set(op.job_id, entry)
        }

        setStructure({
          jobs: [...jobRows].sort((a, b) => a.name.localeCompare(b.name)),
          operationsByJob,
          modelLinkPairs: pairs,
          timeCountByOperation,
          contentsByJob,
        })
        setPageError(null)
      } catch (err) {
        if (!cancelled) setPageError(err instanceof Error ? err.message : 'Could not load this team’s structure')
      } finally {
        if (!cancelled) setLoadingStructure(false)
      }
    })()
    return () => { cancelled = true }
  }, [supabase, filtersRestored, lineId, teamId, teamSectionKey, version, modelVersion])

  // ── Derived: everything the page shows, from data already in hand. ─────────────────────
  const { jobs, operationsByJob, modelLinkPairs, timeCountByOperation } = structure

  /**
   * THE STALENESS GUARD, on the section — and the same "land somewhere worth landing" rule as
   * the team default above.
   *
   * A stored id from another team shows an empty column with no explanation, so it is discarded
   * rather than honoured. The fallback is the team's first REAL section, not simply its first:
   * sortSections pins the unsorted tray to the front of every walk, so `teamSections[0]` is
   * almost always "No Section" — usually empty — and the page opened on a blank Jobs column even
   * when the team had a perfectly good walk one row below. The tray is only chosen when it is
   * genuinely all this team has.
   */
  const activeSectionId = useMemo(() => {
    if (teamSections.some((s) => s.id === sectionId)) return sectionId
    const firstRealSection = teamSections.find((s) => !isSectionTray(s))
    return (firstRealSection ?? teamSections[0])?.id ?? ''
  }, [teamSections, sectionId])
  const activeSection = teamSections.find((s) => s.id === activeSectionId) ?? null

  /**
   * ── Live and retired, kept apart ───────────────────────────────────────────────────────
   *
   * `is_active !== false` is the live test, not `=== true`: the column is nullable and a null has
   * always been treated as live everywhere else in this app (see the Job type).
   *
   * Everything downstream that means "the jobs of this section" uses the live list, so nothing
   * about counts, merges, models or the walk changes. The retired list exists for exactly two
   * things: the delete guard's explanation, and the pane's opt-in reveal.
   */
  const jobsBySection = useMemo(() => {
    const map = new Map<string, Job[]>()
    for (const job of jobs) {
      if (job.is_active === false) continue
      const key = job.section_id ?? ''
      const list = map.get(key)
      if (list) list.push(job)
      else map.set(key, [job])
    }
    return map
  }, [jobs])

  const retiredJobsBySection = useMemo(() => {
    const map = new Map<string, Job[]>()
    for (const job of jobs) {
      if (job.is_active !== false) continue
      const key = job.section_id ?? ''
      const list = map.get(key)
      if (list) list.push(job)
      else map.set(key, [job])
    }
    return map
  }, [jobs])

  const jobsInSection = useMemo(
    () => jobsBySection.get(activeSectionId) ?? [],
    [jobsBySection, activeSectionId]
  )

  const retiredJobsInSection = useMemo(
    () => retiredJobsBySection.get(activeSectionId) ?? [],
    [retiredJobsBySection, activeSectionId]
  )

  /**
   * ── Is this retired job an EMPTY SHELL? ────────────────────────────────────────────────
   *
   * The one question that decides whether a permanent delete is safe, and the only question the ×
   * on a retired row is allowed to turn on. Empty means no operations AT ALL — retired ones
   * included, because operations.job_id cascades and operation_times.operation_id cascades from
   * there — and no recorded times under any of them.
   *
   * FAILS SAFE. A job with no entry in the map has not been counted (mid-load, or a row that
   * arrived outside the structure read), and an uncounted job is treated as NOT empty. The opposite
   * default would let a missing number authorise a destructive delete.
   */
  const jobContents = useCallback(
    (job: Job) => structure.contentsByJob.get(job.id) ?? null,
    [structure.contentsByJob]
  )
  const isEmptyShell = useCallback(
    (job: Job) => {
      const c = jobContents(job)
      return c !== null && c.operations === 0 && c.times === 0
    },
    [jobContents]
  )

  /** Why this retired job may NOT be deleted outright, or null when it may. The sentence names what
   * would be destroyed, because "3 operations" and "3 operations and 148 recorded times" are
   * different warnings to whoever is reading them. */
  const purgeBlockedReason = useCallback(
    (job: Job): string | null => {
      const c = jobContents(job)
      if (c === null) return 'Still counting what this job holds — try again in a moment.'
      if (c.operations === 0 && c.times === 0) return null
      return (
        `“${job.name}” is not empty: it holds ${plural(c.operations, 'operation')}`
        + (c.times > 0 ? ` and ${plural(c.times, 'recorded time')}` : ' (retired, so not listed above)')
        + '. Deleting the row would destroy '
        + (c.times > 0 ? 'that collected work' : 'them') + ' for good. '
        + 'Merge it into the live job that replaced it — that moves all of it across — or restore it.'
      )
    },
    [jobContents]
  )

  /**
   * The revealed retired jobs of this section, in THREE states — not two.
   *
   * `unknown` is the state that was previously folded into `holding`, and folding it there is what
   * made the fail-safe default unfalsifiable: a job whose count had not arrived was described as
   * holding operations and recorded times, which is an assertion about data nobody had read. The
   * safe default is unchanged (no count ⇒ × stays disabled); what changes is that it now says
   * "checking" instead of claiming there is work to rescue.
   */
  const retiredSplit = useMemo(() => {
    const empty: Job[] = []
    const holding: Job[] = []
    const unknown: Job[] = []
    for (const j of retiredJobsInSection) {
      const c = jobContents(j)
      if (c === null) unknown.push(j)
      else if (c.operations === 0 && c.times === 0) empty.push(j)
      else holding.push(j)
    }
    return { empty, holding, unknown }
  }, [retiredJobsInSection, jobContents])

  /** Job → the distinct models any of its operations applies to. The badge's numerator, and the
   * same rows the model panel narrows for its per-model counts — /setup derives both from one
   * sweep for the same reason, so the two can never disagree and neither costs a read. */
  const jobModelCounts = useMemo(() => {
    const jobByOperation = new Map<string, string>()
    for (const [jid, ops] of Object.entries(operationsByJob)) for (const o of ops) jobByOperation.set(o.id, jid)
    const byJob = new Map<string, Set<string>>()
    for (const pair of modelLinkPairs) {
      const jid = jobByOperation.get(pair.operation_id)
      if (!jid) continue
      const set = byJob.get(jid)
      if (set) set.add(pair.product_id)
      else byJob.set(jid, new Set([pair.product_id]))
    }
    const counts = new Map<string, number>()
    for (const [jid, set] of byJob) counts.set(jid, set.size)
    return counts
  }, [operationsByJob, modelLinkPairs])

  /** Times attached to a whole job — the number its delete confirmation has to state. */
  const jobTimeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const [jid, ops] of Object.entries(operationsByJob)) {
      let total = 0
      for (const o of ops) total += timeCountByOperation.get(o.id) ?? 0
      counts.set(jid, total)
    }
    return counts
  }, [operationsByJob, timeCountByOperation])

  const jobCountBySection = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of teamSections) counts.set(s.id, (jobsBySection.get(s.id) ?? []).length)
    return counts
  }, [teamSections, jobsBySection])

  /** The other half of the delete guard: how many DELETED jobs still point at each section. The
   * number that used to be invisible, and the whole reason a delete could be refused on a section
   * showing "0 jobs". */
  const retiredCountBySection = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of teamSections) counts.set(s.id, (retiredJobsBySection.get(s.id) ?? []).length)
    return counts
  }, [teamSections, retiredJobsBySection])

  /** Sections whose retired blockers are ALL empty shells — so the way out is a delete, not a
   * judgement about work. The delete tooltip says a different sentence for these, and it is a
   * shorter one. */
  const retiredEmptyOnlySections = useMemo(() => {
    const out = new Set<string>()
    for (const s of teamSections) {
      const blockers = retiredJobsBySection.get(s.id) ?? []
      if (blockers.length > 0 && blockers.every((j) => isEmptyShell(j))) out.add(s.id)
    }
    return out
  }, [teamSections, retiredJobsBySection, isEmptyShell])

  // ── Merge: the shared hook, twice. ─────────────────────────────────────────────────────
  // Rendered as cards and inline rows rather than Finder pane rows, but the selection rules, the
  // preflight, the confirmation and the write are all the shared module's — including the
  // operation-level time-ownership guard, which is untouched and lives in lib/mergeOperations.
  //
  // The hook's own `active` mode is not used: on this page the checkboxes are always there and a
  // merge action simply appears once two rows are ticked, which is the flow asked for. Nothing
  // else about the hook changes — `toggle`, `setPrimary`, `disabledReason` and `_requestMerge`
  // behave identically whether or not the mode was formally started.
  /**
   * REVEALED RETIRED JOBS ARE MERGE CANDIDATES. This is the resolution that matters for a deleted
   * job: it still holds its operations and their recorded times, and folding them into the live job
   * that superseded it is the only action that rescues them — moving it to the tray just relocates
   * the obstacle.
   *
   * They join the SAME rows list rather than getting a merge of their own, so the selection rules,
   * the keeper radio, the preflight, the ownership blockers and the confirmation are all the
   * existing ones. `jobMergeGroupKey` is the section, so a retired job is a candidate exactly when
   * it sits in the same section as the live job it is being folded into — which is why Move comes
   * first when the live copy is filed elsewhere.
   *
   * Only while revealed: `useMergeMode` prunes its selection to rows still present, so a hidden
   * ticked row could never be written to — but it would still be counted in the merge bar, and a
   * bar saying "2 jobs ticked" over one visible tick is a bar nobody should have to work out.
   */
  const jobMergeRows: MergeRow<Job>[] = useMemo(
    () => [...jobsInSection, ...(showRetired ? retiredJobsInSection : [])]
      .map((j) => ({ id: j.id, name: j.name, groupKey: jobMergeGroupKey(j), subject: j })),
    [jobsInSection, retiredJobsInSection, showRetired]
  )

  /** The keeper, captured at the moment Merge is pressed. The hook clears the selection on
   * success, and this page has to land on the keeper — expanded — so the duplicate OPERATIONS
   * the merge just piled up under it can be folded together straight away. That second step is
   * the whole reason the sequence exists; making the user find the job again would break it. */
  const jobKeeperRef = useRef<string | null>(null)
  const opKeeperJobRef = useRef<string | null>(null)

  const jobMerge = useMergeMode({
    level: 'job',
    supabase,
    // A job merge folds same-named operations together, and a fold moves recorded times — the
    // ownership guard applies at this level too. See lib/jobs.
    userId,
    rows: jobMergeRows,
    onMerged: async () => {
      const keeper = jobKeeperRef.current
      if (keeper) setExpandedJobIds((prev) => new Set(prev).add(keeper))
      reload()
    },
  })

  /**
   * SECTION merge — the third level, the same shared hook as the two below.
   *
   * `sectionMergeGroupKey` is what makes the unsorted tray unmergeable: it returns null for a
   * tray, `useMergeMode` renders a null-group row's checkbox disabled with the reason on hover,
   * and lib/sections' mergeSections re-checks the same predicate before writing. Two independent
   * refusals, one definition — the UI is not the only way in.
   */
  const sectionMergeRows: MergeRow<Section>[] = useMemo(
    () => teamSections.map((sec) => ({
      id: sec.id,
      name: sec.name,
      groupKey: sectionMergeGroupKey(sec),
      ineligibleReason: isSectionTray(sec)
        ? 'This is the team’s unsorted tray — it has to survive, so it can be neither side of a merge.'
        : 'This section has no team, so there is nothing that could safely be merged with it.',
      subject: sec,
    })),
    [teamSections]
  )

  /** The keeper, captured when Merge is pressed — selected afterwards so the combined section is
   * what the user is looking at when the list reloads. */
  const sectionKeeperRef = useRef<string | null>(null)

  const sectionMerge = useMergeMode({
    level: 'section',
    supabase,
    rows: sectionMergeRows,
    onMerged: async () => {
      const keeper = sectionKeeperRef.current
      if (keeper) setSectionId(keeper)
      reload()
    },
  })

  /** Every operation in the SECTION, not just the expanded cards — a card collapsing under a
   * ticked row must not silently drop it from the selection. The groupKey is the job, so the
   * hook's own group lock is what enforces "within one job"; there is no second rule here. */
  const operationMergeRows: MergeRow<Operation>[] = useMemo(
    () => jobsInSection.flatMap((job) => (operationsByJob[job.id] ?? []).map((op) => ({
      id: op.id, name: op.name, groupKey: `job:${job.id}`, subject: op,
    }))),
    [jobsInSection, operationsByJob]
  )

  const operationMerge = useMergeMode({
    level: 'operation',
    supabase,
    userId,
    rows: operationMergeRows,
    onMerged: async () => {
      const job = opKeeperJobRef.current
      if (job) setExpandedJobIds((prev) => new Set(prev).add(job))
      reload()
    },
  })

  /** Which job the ticked operations belong to — named in the merge bar so it is never ambiguous
   * which card the action applies to when several are open. */
  const operationMergeJob = useMemo(() => {
    for (const id of operationMerge.selectedIds) {
      const row = operationMergeRows.find((r) => r.id === id)
      if (row) return jobsInSection.find((j) => `job:${j.id}` === row.groupKey) ?? null
    }
    return null
  }, [operationMerge.selectedIds, operationMergeRows, jobsInSection])

  /**
   * Why a revealed retired job cannot be ticked for a merge, or null when it can.
   *
   * One reason, and it is the common one: a merge folds a job INTO another job in the same section,
   * and the section holding a retired job often holds nothing else — "Electrical (REMOVE)" is
   * exactly that, 0 live jobs and 1 deleted. Saying so on the checkbox, with the next step named,
   * is the difference between a dead end and a two-click repair.
   */
  const retiredMergeBlockedReason = useMemo(
    () => (jobsInSection.length > 0
      ? null
      : 'No live job in this section to merge into. Move it to the section that holds the live copy '
        + 'first — the Move list marks which section that is — then tick both and merge.'),
    [jobsInSection.length]
  )

  /**
   * The keeper must be the LIVE job. A merge retires whatever it folds away, so keeping the deleted
   * side would hide the live job and leave the shell standing — the exact opposite of the repair.
   *
   * Refused in two places for the usual reason: the radio is disabled on a retired card, and this
   * checks again before the preflight in case a row went retired under an open selection.
   */
  const allSectionJobs = useMemo(
    () => [...jobsInSection, ...retiredJobsInSection],
    [jobsInSection, retiredJobsInSection]
  )

  function requestJobMerge() {
    const keeper = jobMerge.primaryId
      ? allSectionJobs.find((j) => j.id === jobMerge.primaryId) ?? null
      : null
    if (keeper && keeper.is_active === false) {
      setPageError(
        `“${keeper.name}” is a deleted job, so it can’t be the one that survives — keeping it would `
        + 'hide the live job and leave the deleted shell in its place. Tick “Keep this name” on the '
        + 'live job instead; the deleted job’s operations and recorded times move onto it.'
      )
      return
    }
    jobKeeperRef.current = jobMerge.primaryId
    jobMerge._requestMerge()
  }

  // ── The job's model panel: the existing drawer, in the existing job mode. ───────────────
  const [modelJob, setModelJob] = useState<Job | null>(null)
  const {
    open: modelOpen, visible: modelVisible, openDrawer: showModels, closeDrawer: hideModels,
  } = useSlideOverDrawer()
  const modelJobOperations = useMemo(
    () => (modelJob ? operationsByJob[modelJob.id] ?? [] : []),
    [modelJob, operationsByJob]
  )
  const modelJobLinkCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (!modelJob) return counts
    const opIds = new Set(modelJobOperations.map((o) => o.id))
    for (const pair of modelLinkPairs) {
      if (!opIds.has(pair.operation_id)) continue
      counts.set(pair.product_id, (counts.get(pair.product_id) ?? 0) + 1)
    }
    return counts
  }, [modelJob, modelJobOperations, modelLinkPairs])

  // ── Dialogs and drawers ────────────────────────────────────────────────────────────────
  const [editOperation, setEditOperation] = useState<{ operation: Operation; jobName: string } | null>(null)
  const {
    open: editOpen, visible: editVisible, openDrawer: showEdit, closeDrawer: hideEdit,
  } = useSlideOverDrawer()
  const [deleteJobTarget, setDeleteJobTarget] = useState<Job | null>(null)
  /** A retired, empty job about to be destroyed for real — kept apart from `deleteJobTarget`
   * because the two are different acts with different consequences and must not share a dialog. */
  const [purgeJobTarget, setPurgeJobTarget] = useState<Job | null>(null)
  const [deleteOperationTarget, setDeleteOperationTarget] = useState<{ operation: Operation; jobName: string } | null>(null)
  const [deleteSectionTarget, setDeleteSectionTarget] = useState<Section | null>(null)
  const [moveJobTarget, setMoveJobTarget] = useState<Job | null>(null)
  const [moveOperationTarget, setMoveOperationTarget] = useState<{ operation: Operation; jobName: string } | null>(null)
  const [busy, setBusy] = useState(false)

  /** Every write goes through here: one place that clears the banner, reports the failure and
   * reloads, so no handler can forget one of the three. */
  const run = useCallback(async (label: string, fn: () => Promise<string | void>) => {
    setBusy(true); setPageError(null); setNotice(null); setConflictOffer(null)
    try {
      const message = await fn()
      if (message) setNotice(message)
      reload()
    } catch (err) {
      // A name/team collision is already a sentence naming the job and what is in the way (see
      // lib/sections' JobNameConflictError), so it is shown WITHOUT the "Moving the job:" prefix —
      // and with the finder that resolves it. Everything else keeps the prefix, which is what says
      // which action failed.
      if (err instanceof JobNameConflictError) {
        setPageError(err.message)
        setConflictOffer(err.allRetired ? 'retired' : 'live')
      } else {
        setPageError(`${label}: ${err instanceof Error ? err.message : 'failed'}`)
      }
    } finally {
      setBusy(false)
    }
  }, [reload])

  /**
   * What a drag actually moves. MULTI-SELECT AWARE: dragging a card that is one of several
   * ticked ones moves ALL of them, because the ticks are already how this page expresses "these
   * jobs, together". Dragging an unticked card moves that card alone and leaves the selection
   * untouched — otherwise a tick made for a merge would silently drag work with it.
   */
  function beginJobDrag(job: Job, event: React.DragEvent) {
    const ticked = jobMerge.selectedIds
    // Over allSectionJobs, not the live list: a revealed retired card can be ticked (it is a merge
    // candidate now), and resolving the drag against live jobs only would drag the LIVE job while
    // the pointer carried the deleted one.
    const ids = ticked.has(job.id) && ticked.size > 1
      ? allSectionJobs.filter((j) => ticked.has(j.id)).map((j) => j.id)
      : [job.id]
    setDragging({
      jobIds: ids,
      label: ids.length === 1 ? `Moving “${job.name}”` : `Moving ${plural(ids.length, 'job')}`,
    })
    event.dataTransfer.effectAllowed = 'move'
    // A payload is set because some browsers refuse to start a drag without one. Nothing reads
    // it back — `dragging` above is the source of truth, and it can hold several ids.
    event.dataTransfer.setData('text/plain', ids.join(','))
  }

  function endJobDrag() {
    setDragging(null)
    setDragOverSectionId(null)
  }

  /**
   * The drop. OPTIMISTIC: the jobs leave the current list immediately, then the writes run, and
   * a failure puts them back exactly where they were.
   *
   * The snapshot is taken from state rather than rebuilt afterwards, because "where it was" has
   * to survive a partial failure — three jobs where the second write is rejected must not leave
   * the first showing in a section it did reach and the third in one it did not. Either all of
   * them show as moved or none do, and the error names what happened.
   *
   * Model links and recorded times are untouched by construction: this writes jobs.section_id
   * and nothing else, and both hang off operation_id.
   */
  async function dropJobsOnSection(target: Section) {
    const drag = dragging
    endJobDrag()
    if (!drag) return

    const moving = structure.jobs.filter((j) => drag.jobIds.includes(j.id) && j.section_id !== target.id)
    if (moving.length === 0) return

    const snapshot = structure.jobs
    setStructure((prev) => ({
      ...prev,
      jobs: prev.jobs.map((j) => (drag.jobIds.includes(j.id) ? { ...j, section_id: target.id } : j)),
    }))
    setBusy(true); setPageError(null); setNotice(null); setConflictOffer(null)
    try {
      for (const job of moving) {
        // The one writer of jobs.section_id, the same one the ⇄ button and every merge use.
        await setJobSection(supabase, job.id, target)
      }
      setNotice(moving.length === 1
        ? `“${moving[0].name}” moved to ${target.name}.`
        : `${plural(moving.length, 'job')} moved to ${target.name}.`)
      reload()
    } catch (err) {
      // Visibly back where it started — not left showing in a section it never reached.
      setStructure((prev) => ({ ...prev, jobs: snapshot }))
      // Trailing stop stripped before the sentence below is appended — the writers in lib/
      // already end their messages with one, and "permissions).. The job is" reads like a typo.
      const reason = (err instanceof Error ? err.message : 'failed').replace(/\.\s*$/, '')
      if (err instanceof JobNameConflictError) {
        // Already names the job, so it does not get the destination prefix — but a drag CAN carry
        // several jobs, and which of them was refused is not otherwise obvious.
        setPageError(
          `${reason}. ${moving.length === 1 ? 'The job is' : 'Every job in the drag is'} back where it was.`
        )
        setConflictOffer(err.allRetired ? 'retired' : 'live')
      } else {
        setPageError(
          `Moving to ${target.name}: ${reason}. ` +
          `${moving.length === 1 ? 'The job is' : 'The jobs are'} back where it was.`
        )
      }
    } finally {
      setBusy(false)
    }
  }

  function toggleExpanded(jobId: string) {
    setExpandedJobIds((prev) => {
      const next = new Set(prev)
      if (next.has(jobId)) next.delete(jobId)
      else next.add(jobId)
      return next
    })
  }

  const lineName = lines.find((l) => l.id === lineId)?.name ?? ''
  const teamName = lineTeams.find((t) => t.id === teamId)?.name ?? ''

  /** Names both halves of the address, because "this team has no sections yet" does not tell a
   * user which of the two selects above put them here. */
  /**
   * The sentence the section-merge confirmation needs and the shared dialog can't produce: each
   * LOSING section named against the keeper, with how many jobs move out of it.
   *
   * Counts come from `jobCountBySection`, which is derived from jobs already loaded for this
   * (line, team) — so this costs no read. It counts the ACTIVE jobs on screen; the dialog's own
   * headline count comes from the preflight, which also moves retired ones. Both numbers are
   * true of different questions, and the dialog states each next to the other.
   */
  const sectionMergeDetail = useMemo(() => {
    const keeper = teamSections.find((sec) => sec.id === sectionMerge.primaryId)
    if (!keeper) return null
    const losing = teamSections.filter(
      (sec) => sectionMerge.selectedIds.has(sec.id) && sec.id !== keeper.id
    )
    if (losing.length === 0) return null
    return (
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        {losing.map((sec) => {
          const n = jobCountBySection.get(sec.id) ?? 0
          return (
            <div key={sec.id}>
              {n === 0
                ? <><strong>{sec.name}</strong> has no jobs. It is then removed.</>
                : <>All {plural(n, 'job')} in <strong>{sec.name}</strong> move to{' '}
                  <strong>{keeper.name}</strong>. <strong>{sec.name}</strong> is then removed.</>}
            </div>
          )
        })}
        <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 12 }}>
          <strong>{keeper.name}</strong> keeps its name and its place in the walk, and ends up with{' '}
          {plural(
            (jobCountBySection.get(keeper.id) ?? 0) + losing.reduce((t, sec) => t + (jobCountBySection.get(sec.id) ?? 0), 0),
            'job'
          )}.
        </div>
      </div>
    )
  }, [teamSections, sectionMerge.primaryId, sectionMerge.selectedIds, jobCountBySection])

  const emptySectionsLabel = teamName && lineName
    ? `${teamName} has no sections yet on ${lineName}.`
    : 'This team has no sections yet.'

  return (
    <main className="page-wide">
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 4px', color: 'var(--text)' }}>
          Production Line Config
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0, lineHeight: 1.55, maxWidth: 760 }}>
          The structure of a line: which sections a team walks, which jobs are in them, and which
          operations are in those. No times are shown or changed here — a{' '}
          <span className="lc-dot" style={{ verticalAlign: 'middle' }} /> marks a job or operation
          that has collected data behind it.
        </p>
      </div>

      {/* ── The address: line, then team ──────────────────────────────────────────────────
          Two identical control columns — label above, same .label, same .select, same height —
          on one baseline, the shape /setup's filter bar already has. It used to align the row on
          `flex-end` with the helper sentence living INSIDE the Team column, which made that
          column taller than the Line column and so pushed the Team select up off the shared
          baseline. The sentence is about the row as a whole, not about the Team control, and now
          sits under both. */}
      <div className="card lc-filters">
        <div className="lc-filter-row">
          <div className="lc-filter-field">
            <label className="label" htmlFor="lc-line">Production line</label>
            <select
              id="lc-line" className="select"
              value={lineId} onChange={(e) => { setLineId(e.target.value); setSectionId('') }}
            >
              {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="lc-filter-field">
            <label className="label" htmlFor="lc-team">Team</label>
            <select
              id="lc-team" className="select"
              value={teamId} disabled={lineTeams.length === 0}
              onChange={(e) => { setTeamId(e.target.value); setSectionId('') }}
            >
              {lineTeams.length === 0 && <option value="">No teams on this line</option>}
              {lineTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          {/* The same finder /setup carries, on the screen where the collision that needs it is
              actually produced. Scoped to ONE line, because a duplicate name is only meaningful
              within one — which is why it hangs off the line select rather than the team select. */}
          <div className="lc-filter-field" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button" className="btn-ghost" style={{ fontSize: 12 }}
              disabled={!lineId}
              title="Every job name that appears more than once on this line, with how much work hangs off each copy"
              onClick={() => setDuplicatesOpen(true)}
            >
              Duplicate jobs
            </button>
          </div>
          {(loadingLine || loadingStructure) && (
            <span className="lc-filter-note" style={{ alignSelf: 'center', paddingTop: 22 }}>Loading…</span>
          )}
        </div>
        {/* Said out loud because it is a deliberate difference from every other filter in the
            app: there is no "All teams" here. A section belongs to exactly one team, so "all"
            would show several teams' walks interleaved as if they were one. */}
        <p className="lc-filter-note">
          A section belongs to one team, so Team is part of the address rather than a filter.
        </p>
      </div>

      {pageError && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13, marginBottom: 14, lineHeight: 1.55 }}>
          {pageError}
          {/* A refusal with a way out. The two cases need different exits: a live duplicate is
              reconciled in the finder, a retired one can only be seen by revealing it — and if the
              reveal is already on, saying so again would be noise. */}
          {conflictOffer && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <button
                type="button" className="btn-ghost" style={{ fontSize: 12 }}
                title="Every job name that appears more than once on this line, with how much work hangs off each copy"
                onClick={() => setDuplicatesOpen(true)}
              >
                Find duplicate jobs
              </button>
              {conflictOffer === 'retired' && !showRetired && (
                <button
                  type="button" className="btn-ghost" style={{ fontSize: 12 }}
                  title="Reveal the deleted jobs still filed on this team's sections"
                  onClick={() => setShowRetired(true)}
                >
                  Show deleted jobs
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {notice && (
        <p
          style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--green-bg)', border: '1px solid #bbf7d0', color: '#15803d', fontSize: 13, marginBottom: 14, cursor: 'pointer' }}
          title="Dismiss" onClick={() => setNotice(null)}
        >
          {notice}
        </p>
      )}

      <div className="lc-columns">
        <SectionsColumn
          sections={teamSections}
          activeSectionId={activeSectionId}
          jobCountBySection={jobCountBySection}
          retiredCountBySection={retiredCountBySection}
          retiredEmptyOnlySections={retiredEmptyOnlySections}
          // lib/permissions, not `role === 'admin'` inline — that module is where the UI's copy of
          // every RLS rule lives, and a screen spelling one out itself is a screen that drifts.
          canDelete={canDeleteSection(role)}
          busy={busy}
          emptyLabel={emptySectionsLabel}
          merge={sectionMerge}
          onRequestMerge={() => { sectionKeeperRef.current = sectionMerge.primaryId; sectionMerge._requestMerge() }}
          dragging={dragging !== null}
          dragOverSectionId={dragOverSectionId}
          onDragOverSection={setDragOverSectionId}
          onDropOnSection={dropJobsOnSection}
          onSelect={setSectionId}
          onAdd={(name) => run('Adding the section', async () => {
            if (!lineId || !teamId) throw new Error('Pick a line and a team first')
            const created = await createSection(supabase, { name, productionLineId: lineId, teamId })
            setSectionId(created.id)
            return `Section "${created.name}" added to the end of this team’s walk.`
          })}
          onRename={(section, name) => run('Renaming the section', async () => {
            await renameSection(supabase, section.id, name)
            return `Section renamed to "${name.trim()}".`
          })}
          onMove={(section, direction) => run('Reordering the sections', async () => {
            // Reorders within THIS TEAM's walk only — sort_order is per team (lib/sections), so
            // handing it the line's whole list would renumber other teams' steps too.
            await moveSection(supabase, teamSections, section.id, direction)
          })}
          onDeleteRequest={setDeleteSectionTarget}
        />

        <div>
          <JobsColumn
            section={activeSection}
            jobs={jobsInSection}
            retiredJobs={retiredJobsInSection}
            showRetired={showRetired}
            retiredMergeBlockedReason={retiredMergeBlockedReason}
            retiredEmptyCount={retiredSplit.empty.length}
            retiredHoldingCount={retiredSplit.holding.length}
            retiredUnknownCount={retiredSplit.unknown.length}
            purgeBlockedReason={purgeBlockedReason}
            // THE count the row shows and the count the × turns on, as one value. Passing the entry
            // rather than a number keeps "not counted yet" (null) distinguishable from "counted, and
            // it is zero" — the distinction the guard text now makes.
            contentsFor={jobContents}
            onPurgeJob={setPurgeJobTarget}
            canRestore={canRestoreJob(role)}
            // Hiding the retired rows drops any tick they held: the hook prunes its selection to
            // visible rows before writing, but the merge bar counts the ticks, and a count that
            // outlived the row it referred to is a count nobody can reconcile.
            onToggleRetired={() => setShowRetired((on) => { if (on) jobMerge.cancel(); return !on })}
            onRestoreJob={(job) => run('Restoring the job', async () => {
              await restoreJob(supabase, job.id)
              // Expanded, because a job that has just come back is one somebody is about to look
              // inside — and its operations are the reason they wanted it back.
              setExpandedJobIds((prev) => new Set(prev).add(job.id))
              return `“${job.name}” restored. It is a live job again and can be renamed, merged or re-filed like any other.`
            })}
            operationsByJob={operationsByJob}
            expandedJobIds={expandedJobIds}
            jobModelCounts={jobModelCounts}
            lineProductCount={lineProductCount}
            timeCountByOperation={timeCountByOperation}
            jobTimeCounts={jobTimeCounts}
            loading={loadingStructure}
            busy={busy}
            jobMerge={jobMerge}
            operationMerge={operationMerge}
            onToggleExpanded={toggleExpanded}
            onOpenModels={(job) => { setModelJob(job); showModels() }}
            onAddJob={(name) => run('Adding the job', async () => {
              if (!activeSection) throw new Error('Pick a section first')
              const created = await createJob(supabase, { name, section: activeSection })
              setExpandedJobIds((prev) => new Set(prev).add(created.id))
              return `Job "${created.name}" added to ${activeSection.name}.`
            })}
            onAddOperation={(job, names) => run('Adding the operation', async () => {
              if (names.length === 1) {
                await createOperation(supabase, { name: names[0], jobId: job.id })
                return `"${names[0]}" added to ${job.name}.`
              }
              const { created, attempted, error } = await createOperations(supabase, job.id, names)
              if (error) throw new Error(`created ${created.length} of ${attempted} — ${error}`)
              return `${plural(created.length, 'operation')} added to ${job.name}.`
            })}
            onEditOperation={(operation, jobName) => { setEditOperation({ operation, jobName }); showEdit() }}
            onMoveOperation={(operation, jobName) => setMoveOperationTarget({ operation, jobName })}
            onDeleteOperation={(operation, jobName) => setDeleteOperationTarget({ operation, jobName })}
            onMoveJob={setMoveJobTarget}
            onDeleteJob={setDeleteJobTarget}
            onRequestJobMerge={requestJobMerge}
            onRequestOperationMerge={() => {
              opKeeperJobRef.current = operationMergeJob?.id ?? null
              operationMerge._requestMerge()
            }}
            operationMergeJobName={operationMergeJob?.name ?? null}
            onJobDragStart={beginJobDrag}
            onJobDragEnd={endJobDrag}
          />
        </div>
      </div>

      {/* Both merge confirmations are the shared one — it states the keeper, the retired rows,
          how much moves and (for a job merge) which operations will COMBINE with a same-named
          operation on the keeper, by name, before it happens. */}
      {/* The section confirmation carries an extra block naming each losing section against the
          keeper with its job count — "All 3 jobs in Flooring move to Floors." Built from counts
          already on screen, so it costs no read; the shared dialog states the rest. */}
      <MergeConfirm
        merge={sectionMerge}
        detail={sectionMergeDetail}
      />
      <MergeConfirm merge={jobMerge} />
      <MergeConfirm merge={operationMerge} />

      {/* What the drag is carrying, said out loud — a drag that silently moves three jobs when
          the pointer is over one card is not something to discover afterwards. */}
      {dragging && (
        <div className="lc-drag-pill" role="status" aria-live="polite">
          {dragging.label} — drop on a section
        </div>
      )}

      {/* ── The job's model panel: BulkModelLinkDrawer in job mode, unchanged ───────────── */}
      {modelOpen && modelJob && (
        <>
          <div className={'gaps-drawer-overlay' + (modelVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={hideModels} />
          <div className={'gaps-drawer' + (modelVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <BulkModelLinkDrawer
              productionLineId={modelJob.production_line_id ?? lineId}
              subjectLabel={modelJob.name}
              operations={modelJobOperations}
              jobLinkCounts={modelJobLinkCounts}
              supabase={supabase}
              onClose={hideModels}
              // Only the applies-list moved. Re-read the structure so the badge is right; there
              // is nothing else on this page that a model link changes.
              onApplied={async () => { setModelVersion((v) => v + 1) }}
            />
          </div>
        </>
      )}

      {/* ── Duplicate jobs: the SAME drawer /setup mounts, unchanged ──────────────────────
          Mounted only while open — it reads every job, operation and recorded time on the line.
          It writes through lib/sections' setJobSection and lib/jobs' mergeJobs, the same two
          writers this page uses, so a move made in there and a move made out here cannot differ. */}
      {duplicatesOpen && lineId && (
        <DuplicateJobsDrawer
          supabase={supabase}
          userId={userId}
          productionLineId={lineId}
          productionLineName={lineName || 'This line'}
          onClose={() => setDuplicatesOpen(false)}
          onChanged={() => { setConflictOffer(null); reload() }}
        />
      )}

      {/* ── Rename an operation: the shared editor ──────────────────────────────────────── */}
      {editOpen && editOperation && (
        <>
          <div className={'gaps-drawer-overlay' + (editVisible ? ' gaps-drawer-overlay-visible' : '')} onClick={hideEdit} />
          <div className={'gaps-drawer' + (editVisible ? ' gaps-drawer-visible' : '')} style={DRAWER_WIDTH}>
            <OperationEditDrawer
              operation={editOperation.operation}
              jobName={editOperation.jobName}
              // Empty on purpose: who is assigned to an operation is staffing, not structure, and
              // this page answers "what exists". The drawer hides the block entirely when it is
              // empty, and /setup remains the screen that assigns operators.
              operators={[]}
              supabase={supabase}
              onSaved={async () => { reload() }}
              onClose={hideEdit}
            />
          </div>
        </>
      )}

      {/* ── Move a job to another section ───────────────────────────────────────────────── */}
      {moveJobTarget && (
        <MovePicker
          title={`Move "${moveJobTarget.name}"`}
          message={
            moveJobTarget.is_active === false
              // A retired job's move has one purpose — get it next to the live job it should fold
              // into, or out of a section somebody wants to delete — so the options stay on THIS
              // TEAM. Crossing teams would rewrite jobs.team_id and can collide with the name it
              // already holds there, which is the failure this whole flow exists to get out of.
              ? 'This job is deleted. Moving it clears the section it is sitting in, and putting it ' +
                'in the same section as the live job that replaced it is what makes a merge possible ' +
                '— the list marks which section holds a live job of the same name. Only this team’s ' +
                'sections are offered.'
              : 'Pick the section this job belongs in. A section belongs to one team, so moving the ' +
                'job between teams’ sections moves the job to that team — its operations, their ' +
                'recorded times and their model links all ride along untouched.'
          }
          label="Section"
          options={(moveJobTarget.is_active === false ? teamSections : sections).map((s) => {
            // Exact name equality, matching every other name comparison in this codebase — no trim,
            // no case folding. A marker that claimed a match the merge path wouldn't make would send
            // the user to a section where the merge then refuses to fold anything.
            const twin = moveJobTarget.is_active === false
              ? (jobsBySection.get(s.id) ?? []).some((j) => j.name === moveJobTarget.name)
              : false
            return {
              value: s.id,
              label: moveJobTarget.is_active === false
                ? `${s.name}${twin ? ` · holds a live “${moveJobTarget.name}”` : ''}`
                : `${teams.find((t) => t.id === s.team_id)?.name ?? 'No team'} · ${s.name}`,
              disabled: s.id === moveJobTarget.section_id,
            }
          })}
          confirmLabel="Move job"
          busy={busy}
          onCancel={() => setMoveJobTarget(null)}
          onConfirm={(targetId) => {
            const job = moveJobTarget
            const target = sections.find((s) => s.id === targetId)
            setMoveJobTarget(null)
            run('Moving the job', async () => {
              if (!target) throw new Error('Pick a section')
              await setJobSection(supabase, job.id, target)
              if (job.is_active === false) {
                // Follow it. A deleted row that vanishes from the section you were clearing and
                // reappears in one you aren't looking at is indistinguishable from it having gone
                // for good — and the next step (the merge) happens where it landed.
                setSectionId(target.id)
                return `“${job.name}” moved to ${target.name}. It is still deleted — tick it and the live job there, keep the live one, and its operations and recorded times move across.`
              }
              return `"${job.name}" moved to ${target.name}.`
            })
          }}
        />
      )}

      {/* ── Move an operation to another job ────────────────────────────────────────────── */}
      {moveOperationTarget && (
        <MovePicker
          title={`Move "${moveOperationTarget.operation.name}"`}
          message={
            `Pick the job this operation belongs to. Its recorded times, notes and model links ` +
            `hang off the operation itself, so all of them move with it and none of them change.`
          }
          label="Job"
          options={teamSections.flatMap((s) => (jobsBySection.get(s.id) ?? []).map((j) => ({
            value: j.id,
            label: `${s.name} · ${j.name}`,
            disabled: j.id === moveOperationTarget.operation.job_id,
          })))}
          confirmLabel="Move operation"
          busy={busy}
          onCancel={() => setMoveOperationTarget(null)}
          onConfirm={(targetId) => {
            const { operation } = moveOperationTarget
            const target = jobs.find((j) => j.id === targetId)
            setMoveOperationTarget(null)
            run('Moving the operation', async () => {
              if (!target) throw new Error('Pick a job')
              await setOperationJob(supabase, operation.id, target.id)
              setExpandedJobIds((prev) => new Set(prev).add(target.id))
              return `"${operation.name}" moved to ${target.name}.`
            })
          }}
        />
      )}

      {/* ── Deletes. All three name the subject and what is attached to it. ─────────────── */}
      {/* ── Destroying an empty shell ─────────────────────────────────────────────────────
          Its own dialog, not the soft-delete one. Every other delete on this page is a retire that
          keeps every row and can be undone in the database; this one is `DELETE FROM jobs` and
          cannot, so the wording says that in as few words as possible and the button says Delete
          permanently rather than Delete. The guard is re-run inside deleteJobPermanently — this
          dialog is consent, not the check. */}
      {purgeJobTarget && (
        <ConfirmDialog
          title={`Permanently delete "${purgeJobTarget.name}"`}
          message={
            `“${purgeJobTarget.name}” is deleted and holds nothing — no operations, no recorded `
            + 'times. This removes the job row from the database for good: it is not a retire, there '
            + 'is nothing left to keep, and it cannot be undone. The section it sits in is then clear.'
          }
          confirmLabel={busy ? 'Deleting…' : 'Delete permanently'}
          danger
          maxWidth={520}
          onConfirm={() => {
            const job = purgeJobTarget
            setPurgeJobTarget(null)
            run('Deleting the job permanently', async () => {
              await deleteJobPermanently(supabase, job.id)
              setExpandedJobIds((prev) => { const n = new Set(prev); n.delete(job.id); return n })
              return `“${job.name}” deleted permanently. The row is gone; nothing pointed at it.`
            })
          }}
          onCancel={() => setPurgeJobTarget(null)}
        />
      )}

      {deleteJobTarget && (
        <ConfirmDialog
          title={`Delete "${deleteJobTarget.name}"`}
          message={deleteMessage(
            'job',
            deleteJobTarget.name,
            (operationsByJob[deleteJobTarget.id] ?? []).length,
            'operation',
            jobTimeCounts.get(deleteJobTarget.id) ?? 0
          )}
          confirmLabel={busy ? 'Deleting…' : 'Delete job'}
          danger
          maxWidth={520}
          onConfirm={() => {
            const job = deleteJobTarget
            setDeleteJobTarget(null)
            run('Deleting the job', async () => {
              await retireJob(supabase, job.id)
              setExpandedJobIds((prev) => { const n = new Set(prev); n.delete(job.id); return n })
              return `"${job.name}" deleted. Its operations and their recorded times are kept and can be restored in the database.`
            })
          }}
          onCancel={() => setDeleteJobTarget(null)}
        />
      )}

      {deleteOperationTarget && (
        <ConfirmDialog
          title={`Delete "${deleteOperationTarget.operation.name}"`}
          message={deleteMessage(
            'operation',
            deleteOperationTarget.operation.name,
            0,
            null,
            timeCountByOperation.get(deleteOperationTarget.operation.id) ?? 0
          )}
          confirmLabel={busy ? 'Deleting…' : 'Delete operation'}
          danger
          maxWidth={520}
          onConfirm={() => {
            const { operation } = deleteOperationTarget
            setDeleteOperationTarget(null)
            run('Deleting the operation', async () => {
              await retireOperation(supabase, operation.id)
              return `"${operation.name}" deleted. Its recorded times and model links are kept and can be restored in the database.`
            })
          }}
          onCancel={() => setDeleteOperationTarget(null)}
        />
      )}

      {deleteSectionTarget && (
        <ConfirmDialog
          title={`Delete "${deleteSectionTarget.name}"`}
          message={
            `Delete the section "${deleteSectionTarget.name}" from this team's walk? ` +
            'A section holds no recorded work of its own — its jobs do — so this one is a real ' +
            'delete rather than a retire, and it is only allowed while no job points at it.'
          }
          confirmLabel={busy ? 'Deleting…' : 'Delete section'}
          danger
          maxWidth={520}
          onConfirm={() => {
            const section = deleteSectionTarget
            setDeleteSectionTarget(null)
            run('Deleting the section', async () => {
              // Re-checked against the DATABASE, not the loaded list: a job filed here from another
              // team's pane still points at the section and would be orphaned by the delete.
              //
              // SPLIT by is_active, because the two cases are not the same problem. Live jobs are
              // on screen and the user moves them. A DELETED job is on no screen in the app, and
              // the old single count could only say "1 job still points at this section" about a
              // section showing none — true, unactionable, and the complaint that produced this
              // change. Now it names which kind and which control reveals it.
              const { active, retired } = await countJobsInSectionByState(supabase, section.id)
              if (active > 0) {
                throw new Error(
                  `${plural(active, 'job')} still ${active === 1 ? 'sits' : 'sit'} in this section. ` +
                  `Move ${active === 1 ? 'it' : 'them'} to another section first — deleting a section ` +
                  'never touches its jobs.'
                )
              }
              if (retired > 0) {
                // NAMED, and with the way out. The names come from rows already loaded for this
                // team, so this costs no read; the count comes from the database, so if the two ever
                // disagree the number is the one to trust and the names are what is on screen.
                const blockers = retiredJobsBySection.get(section.id) ?? []
                const names = blockers.map((j) => `“${j.name}”`)
                const named = names.length > 0 ? ` — ${names.join(', ')}` : ''
                // Nothing under any of them: the answer is a delete, and the long argument about
                // rescuing operations and recorded times would be about work that does not exist.
                if (blockers.length > 0 && blockers.every((j) => isEmptyShell(j))) {
                  throw new Error(
                    `${plural(retired, 'deleted job')} still ${retired === 1 ? 'points' : 'point'} at ` +
                    `this section${named}, holding nothing at all. Turn on “Show deleted jobs” in the ` +
                    `Jobs column and press × to delete ${retired === 1 ? 'it' : 'them'}, then delete ` +
                    'this section.'
                  )
                }
                throw new Error(
                  `no live jobs are in this section, but ${plural(retired, 'DELETED job')} still ` +
                  `${retired === 1 ? 'points' : 'point'} at it${named}. ` +
                  `Deleting the section would leave ${retired === 1 ? 'that row' : 'those rows'} — and ` +
                  `every operation and recorded time under ${retired === 1 ? 'it' : 'them'} — filed ` +
                  'against a section that no longer exists. Turn on “Show deleted jobs” in the Jobs ' +
                  `column: from there ${retired === 1 ? 'it' : 'each one'} can be MERGED into the live ` +
                  'job that replaced it (which keeps the operations and recorded times), RESTORED as a ' +
                  'live job, or MOVED to another section on this team.'
                )
              }
              await deleteSection(supabase, section.id)
              if (sectionId === section.id) setSectionId('')
              return `Section "${section.name}" deleted.`
            })
          }}
          onCancel={() => setDeleteSectionTarget(null)}
        />
      )}
    </main>
  )
}

/** The one wording for what a delete hides, at either level. Says the number of recorded times
 * because that is the thing a person cannot see from the row itself — the dot only says "some". */
function deleteMessage(
  noun: string,
  name: string,
  childCount: number,
  childNoun: string | null,
  timeCount: number
): string {
  const children = childNoun && childCount > 0
    ? ` It holds ${plural(childCount, childNoun)}, which are hidden with it.`
    : ''
  const times = timeCount > 0
    ? ` ${plural(timeCount, 'recorded time')} ${timeCount === 1 ? 'is' : 'are'} attached and ${timeCount === 1 ? 'stays' : 'stay'} in the database.`
    : ' Nothing has been timed against it.'
  return (
    `"${name}" stops appearing anywhere in the app.${children}${times} ` +
    `This is a soft delete — the ${noun} is marked inactive, not destroyed, and reactivating the ` +
    'row in the database brings it back exactly as it was.'
  )
}

// ── Sections column ─────────────────────────────────────────────────────────────────────────
/**
 * The team's walk, in order. Narrow on purpose: the width belongs to the jobs, which is where
 * the long names are.
 *
 * The unsorted tray ("No Section") is listed because jobs really do live in it, but it can't be
 * renamed, reordered or deleted — it is the team's inbox, and lib/sections refuses all three at
 * the write path too. The controls are disabled with the reason on hover rather than hidden, so
 * the tray doesn't look like a section that is somehow missing its tools.
 */
function SectionsColumn({
  sections, activeSectionId, jobCountBySection, retiredCountBySection, retiredEmptyOnlySections,
  canDelete, busy, emptyLabel,
  merge, dragging, dragOverSectionId,
  onRequestMerge, onDragOverSection, onDropOnSection,
  onSelect, onAdd, onRename, onMove, onDeleteRequest,
}: {
  sections: Section[]
  activeSectionId: string
  jobCountBySection: Map<string, number>
  /** Deleted jobs still pointing at each section. They block the delete exactly as live jobs do
   * — jobs.section_id is a real reference either way — and they appear in no pane unless the Jobs
   * column's reveal is on, which is why the row has to say so rather than let the delete fail. */
  retiredCountBySection: Map<string, number>
  /** Sections whose retired blockers all hold nothing — the delete tooltip then points at × rather
   * than at a merge, because there is no work to weigh up. */
  retiredEmptyOnlySections: Set<string>
  canDelete: boolean
  busy: boolean
  /** "Cab has no sections yet on Camper Trailer." — built by the host, which is the only place
   * that knows both names. */
  emptyLabel: string
  merge: ReturnType<typeof useMergeMode>
  /** A job drag is in flight, so every row is a candidate target. */
  dragging: boolean
  dragOverSectionId: string | null
  onRequestMerge: () => void
  onDragOverSection: (id: string | null) => void
  onDropOnSection: (section: Section) => void
  onSelect: (id: string) => void
  onAdd: (name: string) => void
  onRename: (section: Section, name: string) => void
  onMove: (section: Section, direction: -1 | 1) => void
  onDeleteRequest: (section: Section) => void
}) {
  const [adding, setAdding] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  function commitAdd() {
    const name = adding.trim()
    if (!name) return
    setAdding('')
    onAdd(name)
  }

  return (
    <div className="lc-panel">
      <div className="lc-panel-header">
        <span className="lc-panel-title">Sections</span>
        <span className="lc-panel-title" style={{ letterSpacing: 0 }}>{sections.length}</span>
      </div>
      <div className="lc-panel-body">
        {sections.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 10px', margin: 0, lineHeight: 1.55 }}>
            {/* Named, not generic. "This team has no sections yet" on a screen the user did not
              * choose to be on reads as a broken page; naming the team and the line says which
              * of the two selects above to change. */}
            {emptyLabel} Add the first step of its walk below.
          </p>
        )}

        {sections.map((section, index) => {
          const tray = isSectionTray(section)
          const count = jobCountBySection.get(section.id) ?? 0
          const retiredCount = retiredCountBySection.get(section.id) ?? 0
          const trayReason = tray ? 'This is the team’s unsorted tray — it can’t be renamed, reordered or deleted.' : null

          if (renamingId === section.id) {
            return (
              <div key={section.id} style={{ display: 'flex', gap: 6, padding: '6px 4px' }}>
                <input
                  className="input" style={{ flex: 1, minWidth: 0, fontSize: 13 }}
                  autoFocus value={renameValue} disabled={busy}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); setRenamingId(null); onRename(section, renameValue) }
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                />
                <button
                  type="button" className="btn-primary" style={{ padding: '6px 10px', fontSize: 12 }}
                  disabled={busy || !renameValue.trim()}
                  onClick={() => { setRenamingId(null); onRename(section, renameValue) }}
                >
                  Save
                </button>
              </div>
            )
          }

          const ticked = merge.selectedIds.has(section.id)
          const isKeeper = merge.primaryId === section.id
          const mergeDisabled = merge.disabledReason(section.id)

          return (
            <div
              key={section.id}
              className={
                'lc-section'
                + (section.id === activeSectionId ? ' lc-section-active' : '')
                + (ticked ? ' lc-section-ticked' : '')
                + (isKeeper ? ' lc-section-keeper' : '')
                // Every row lights up as a candidate while a drag is in flight; the one under
                // the pointer lights up harder. Without the first, a drag gives no clue where it
                // can be dropped; without the second, no clue where it is about to land.
                + (dragging ? ' lc-section-droppable' : '')
                + (dragOverSectionId === section.id ? ' lc-section-dropover' : '')
              }
              onClick={() => onSelect(section.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(section.id) } }}
              // preventDefault on dragover is what MAKES an element a drop target — without it
              // the browser refuses the drop and the drag snaps back with no explanation.
              onDragOver={(e) => { if (dragging) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}
              onDragEnter={(e) => { if (dragging) { e.preventDefault(); onDragOverSection(section.id) } }}
              onDragLeave={(e) => {
                // Only when the pointer has actually left the row, not when it crosses onto a
                // child of it — dragleave fires for both.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDragOverSection(null)
              }}
              onDrop={(e) => { if (dragging) { e.preventDefault(); onDropOnSection(section) } }}
            >
              {/* Name and count STACKED, not side by side: this column is 280px and has to carry
                  a checkbox and four tools as well, which left a name like "Gas heater
                  installation" about 55px and broke it one letter per line. */}
              <div className="lc-section-main">
                <input
                  type="checkbox"
                  className="lc-check lc-check-sm"
                  checked={ticked}
                  disabled={Boolean(mergeDisabled) || merge.busy || busy}
                  title={mergeDisabled ?? 'Tick two or more sections to merge them'}
                  aria-label={`Select ${section.name}`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => merge.toggle(section.id)}
                />
                <span className="lc-section-label">
                  <span className="lc-section-name">{section.name}</span>
                  {/* The deleted tally is stated on the row, not only in the delete tooltip: it is
                      the difference between "this section is empty" and "this section looks
                      empty", and a user reading the column should not have to hover to find out
                      which one they are looking at. */}
                  <span className="lc-section-count">
                    {plural(count, 'job')}
                    {retiredCount > 0 && (
                      <span title={`${plural(retiredCount, 'deleted job')} still filed here — hidden until “Show deleted jobs” is on`}>
                        {' · '}+{retiredCount} deleted
                      </span>
                    )}
                  </span>
                </span>
                <span className="lc-section-tools" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button" className="lc-icon-btn" aria-label={`Move ${section.name} up`}
                  title={trayReason ?? 'Move up the walk'}
                  disabled={busy || tray || index === 0 || isSectionTray(sections[index - 1])}
                  onClick={() => onMove(section, -1)}
                >
                  ↑
                </button>
                <button
                  type="button" className="lc-icon-btn" aria-label={`Move ${section.name} down`}
                  title={trayReason ?? 'Move down the walk'}
                  disabled={busy || tray || index === sections.length - 1}
                  onClick={() => onMove(section, 1)}
                >
                  ↓
                </button>
                <button
                  type="button" className="lc-icon-btn" aria-label={`Rename ${section.name}`}
                  title={trayReason ?? 'Rename'}
                  disabled={busy || tray}
                  onClick={() => { setRenamingId(section.id); setRenameValue(section.name) }}
                >
                  ✎
                </button>
                <button
                  type="button" className="lc-icon-btn" aria-label={`Delete ${section.name}`}
                  // The disabled reason is the whole point of the control here — a section with
                  // jobs in it is the common case, and "why is this greyed out" has to answer
                  // itself on hover rather than send somebody looking.
                  title={
                    trayReason
                      ?? (!canDelete ? 'Deleting a section is restricted to admins'
                        : count > 0 ? `"${section.name}" still holds ${plural(count, 'job')} — move them to another section first`
                          // The state that used to enable this button and then fail: no live jobs,
                          // so the row reads "0 jobs", but a deleted job still points here. Said
                          // on the control rather than discovered after pressing it.
                          : retiredCount > 0
                            ? retiredEmptyOnlySections.has(section.id)
                              // Nothing under them, so the route out is one button and the tooltip
                              // says which one.
                              ? `"${section.name}" holds no live jobs, but ${plural(retiredCount, 'deleted job')} still ${retiredCount === 1 ? 'points' : 'point'} at it, holding nothing — turn on “Show deleted jobs” in the Jobs column and press × to delete ${retiredCount === 1 ? 'it' : 'them'}`
                              : `"${section.name}" holds no live jobs, but ${plural(retiredCount, 'deleted job')} still ${retiredCount === 1 ? 'points' : 'point'} at it — turn on “Show deleted jobs” in the Jobs column, where ${retiredCount === 1 ? 'it' : 'each one'} can be merged into the live job that replaced it, restored, or moved to another section`
                            : 'Delete this section')
                  }
                  disabled={busy || tray || !canDelete || count > 0 || retiredCount > 0}
                  onClick={() => onDeleteRequest(section)}
                >
                    ×
                  </button>
                </span>
              </div>
              {/* Its own line, under the row — the same shape a ticked job card uses, and the
                  only way it fits here at all. Unset on every ticked row: which section's NAME
                  survives is the one decision a merge cannot take back, so it is never inferred
                  from order. */}
              {ticked && (
                <label
                  className={'lc-keeper lc-keeper-sm' + (isKeeper ? ' lc-keeper-on' : '')}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="radio"
                    name="lc-section-keeper"
                    checked={isKeeper}
                    disabled={merge.busy}
                    style={{ width: 16, height: 16, accentColor: 'var(--blue)', cursor: 'pointer' }}
                    onChange={() => merge.setPrimary(section.id)}
                  />
                  Keep this name
                </label>
              )}
            </div>
          )
        })}

        <div style={{ display: 'flex', gap: 6, padding: '10px 4px 4px', borderTop: '1px solid var(--border)', marginTop: 8 }}>
          <input
            className="input" style={{ flex: 1, minWidth: 0, fontSize: 13 }}
            placeholder="New section…" value={adding} disabled={busy}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitAdd() } }}
          />
          <button
            type="button" className="btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }}
            disabled={busy || !adding.trim()} onClick={commitAdd}
          >
            Add
          </button>
        </div>

        <MergeBar
          merge={merge}
          noun="section"
          scopeLabel=""
          onRequest={onRequestMerge}
        />
      </div>
    </div>
  )
}

// ── Jobs column ─────────────────────────────────────────────────────────────────────────────
function JobsColumn({
  section, jobs, retiredJobs, showRetired, retiredMergeBlockedReason, retiredEmptyCount,
  retiredHoldingCount, retiredUnknownCount, purgeBlockedReason, contentsFor,
  onPurgeJob, canRestore, onToggleRetired,
  onRestoreJob, operationsByJob, expandedJobIds,
  jobModelCounts, lineProductCount,
  timeCountByOperation, jobTimeCounts, loading, busy, jobMerge, operationMerge,
  onToggleExpanded, onOpenModels, onAddJob, onAddOperation, onEditOperation, onMoveOperation,
  onDeleteOperation, onMoveJob, onDeleteJob, onRequestJobMerge, onRequestOperationMerge,
  operationMergeJobName, onJobDragStart, onJobDragEnd,
}: {
  section: Section | null
  jobs: Job[]
  /** Deleted jobs still filed in this section. Listed only when `showRetired` is on, and never
   * counted in the header — they are retired, and the pane's number is what the team has. */
  retiredJobs: Job[]
  showRetired: boolean
  /** Why a revealed retired row can't be ticked for a merge, or null when it can — the host owns
   * this because the answer is about the SECTION (does it hold a live job at all), not the row. */
  retiredMergeBlockedReason: string | null
  /** How many of the revealed retired jobs hold nothing at all, and how many hold operations or
   * recorded times. The explanation branches on these: an empty shell needs one line and the ×, a
   * shell holding real collection needs the merge / restore / move judgement. */
  retiredEmptyCount: number
  retiredHoldingCount: number
  /** Revealed retired jobs whose contents have not been counted yet. They are neither claimed to
   * be empty nor claimed to hold work — see retiredSplit. */
  retiredUnknownCount: number
  /** Why this retired job can't be destroyed outright, or null when it can. */
  purgeBlockedReason: (job: Job) => string | null
  /** Everything filed under a job — operations (retired included) and the recorded times under
   * them — or null when it has not been counted yet. The retired row's badge and its × read this
   * same value, which is what stops the two disagreeing on screen. */
  contentsFor: (job: Job) => { operations: number; times: number } | null
  onPurgeJob: (job: Job) => void
  canRestore: boolean
  onToggleRetired: () => void
  onRestoreJob: (job: Job) => void
  operationsByJob: Record<string, Operation[]>
  expandedJobIds: Set<string>
  jobModelCounts: Map<string, number>
  lineProductCount: number
  timeCountByOperation: Map<string, number>
  jobTimeCounts: Map<string, number>
  loading: boolean
  busy: boolean
  jobMerge: ReturnType<typeof useMergeMode>
  operationMerge: ReturnType<typeof useMergeMode>
  onToggleExpanded: (jobId: string) => void
  onOpenModels: (job: Job) => void
  onAddJob: (name: string) => void
  onAddOperation: (job: Job, names: string[]) => void
  onEditOperation: (operation: Operation, jobName: string) => void
  onMoveOperation: (operation: Operation, jobName: string) => void
  onDeleteOperation: (operation: Operation, jobName: string) => void
  onMoveJob: (job: Job) => void
  onDeleteJob: (job: Job) => void
  onRequestJobMerge: () => void
  onRequestOperationMerge: () => void
  operationMergeJobName: string | null
  onJobDragStart: (job: Job, event: React.DragEvent) => void
  onJobDragEnd: () => void
}) {
  const [adding, setAdding] = useState('')

  function commitAdd() {
    const name = adding.trim()
    if (!name) return
    setAdding('')
    onAddJob(name)
  }

  const allExpanded = jobs.length > 0 && jobs.every((j) => expandedJobIds.has(j.id))

  return (
    <div className="lc-panel">
      <div className="lc-panel-header">
        <span className="lc-panel-title">
          Jobs{section ? ` — ${section.name}` : ''}
        </span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="lc-panel-title" style={{ letterSpacing: 0 }}>{jobs.length}</span>
          {/* Offered whenever the section HAS retired jobs, and offered as an "off" switch
              whenever it is on — so it is never possible to be looking at retired rows with no
              control in sight to put them away. */}
          {(retiredJobs.length > 0 || showRetired) && (
            <button
              type="button"
              className="btn-ghost"
              style={{ padding: '5px 9px', fontSize: 11 }}
              aria-pressed={showRetired}
              title={showRetired
                ? 'Hide deleted jobs again'
                : `${plural(retiredJobs.length, 'deleted job')} still filed in this section — they block a section delete and hold their name against this team, so they are worth seeing`}
              onClick={onToggleRetired}
            >
              {showRetired
                ? 'Hide deleted'
                : `Show ${retiredJobs.length} deleted`}
            </button>
          )}
          {jobs.length > 0 && (
            <button
              type="button" className="btn-ghost" style={{ padding: '5px 9px', fontSize: 11 }}
              // Opening several at once is what this page is for — comparing two suspected
              // duplicates means reading both operation lists side by side.
              onClick={() => jobs.forEach((j) => {
                if (allExpanded === expandedJobIds.has(j.id)) onToggleExpanded(j.id)
              })}
            >
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </span>
      </div>

      <MergeNotices merge={jobMerge} />
      <MergeNotices merge={operationMerge} />

      <div className="lc-panel-body">
        {!section && !loading && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', padding: '16px 10px', margin: 0 }}>
            Pick a section on the left to see its jobs.
          </p>
        )}
        {section && jobs.length === 0 && !loading && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', padding: '16px 10px', margin: 0 }}>
            No jobs in {section.name} yet.
            {/* The sentence that used to be missing entirely: "no jobs" and "nothing points here"
                are different claims, and only the second one lets the section be deleted. */}
            {retiredJobs.length > 0 && !showRetired && (
              <> {plural(retiredJobs.length, 'deleted job')} still {retiredJobs.length === 1 ? 'points' : 'point'} at
                it, which is enough to block deleting the section — press <strong>Show {retiredJobs.length} deleted</strong> above.</>
            )}
          </p>
        )}

        {jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            operations={operationsByJob[job.id] ?? []}
            expanded={expandedJobIds.has(job.id)}
            modelCount={jobModelCounts.get(job.id) ?? 0}
            lineProductCount={lineProductCount}
            hasTimes={(jobTimeCounts.get(job.id) ?? 0) > 0}
            timeCountByOperation={timeCountByOperation}
            loading={loading}
            busy={busy}
            jobMerge={jobMerge}
            operationMerge={operationMerge}
            onToggleExpanded={() => onToggleExpanded(job.id)}
            onOpenModels={() => onOpenModels(job)}
            onAddOperation={(names) => onAddOperation(job, names)}
            onEditOperation={(op) => onEditOperation(op, job.name)}
            onMoveOperation={(op) => onMoveOperation(op, job.name)}
            onDeleteOperation={(op) => onDeleteOperation(op, job.name)}
            onMove={() => onMoveJob(job)}
            onDelete={() => onDeleteJob(job)}
            onDragStart={(e) => onJobDragStart(job, e)}
            onDragEnd={onJobDragEnd}
          />
        ))}

        {/* ── The retired jobs, below the live ones and marked ──────────────────────────────
            Deliberately the SAME card, with `retired` set rather than a second, read-only row
            type: the whole point of revealing them is that the user can act — move one out so the
            section can be deleted, or rename one so a name collision clears — and a card that
            looked different but behaved the same would just be a second thing to maintain. Delete
            and merge are the two actions that make no sense on an already-retired row, and the
            card turns both off. */}
        {showRetired && retiredJobs.length > 0 && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
            {/* ── The explanation, branched on whether there is anything to rescue ──────────
                An empty shell gets ONE line. The long version below argues that a merge saves the
                operations and recorded times, which is the right argument when there are some and
                pure noise when there are none — and a paragraph nobody reads is the same dead end
                as no paragraph at all. */}
            {retiredHoldingCount === 0 && retiredUnknownCount > 0 && retiredEmptyCount === 0 ? (
              // Neither claim made. The count has not arrived, so the row says so rather than
              // asserting there is work to rescue — the state that used to be indistinguishable.
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px', lineHeight: 1.55 }}>
                Checking what {retiredUnknownCount === 1 ? 'this deleted job holds' : 'these deleted jobs hold'}…
              </p>
            ) : retiredHoldingCount === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px', lineHeight: 1.55 }}>
                <strong>{plural(retiredEmptyCount, 'deleted job')}</strong>, holding no operations and
                no recorded times. Nothing to rescue — press <strong>×</strong> to delete the row and
                this section is clear.
                {retiredUnknownCount > 0 && (
                  <> {' '}({retiredUnknownCount} more still being counted.)</>
                )}
              </p>
            ) : (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px', lineHeight: 1.55 }}>
                <strong>{plural(retiredHoldingCount, 'deleted job')}</strong> here still{' '}
                {retiredHoldingCount === 1 ? 'holds' : 'hold'} operations or recorded times, which is
                why {retiredHoldingCount === 1 ? 'it blocks' : 'they block'} deleting this section.
                {' '}<strong>Merge</strong> folds that work onto the live job that replaced it — the
                only route that keeps it; <strong>Restore</strong> brings the job back live;{' '}
                <strong>Move</strong> ⇄ relocates it without deciding anything.
                {retiredMergeBlockedReason && (
                  <> {' '}A merge needs a live job in the same section, and this one has none — the
                    Move list marks which section holds a live copy.</>
                )}
                {retiredEmptyCount > 0 && (
                  <> {' '}The other {retiredEmptyCount === 1 ? 'one holds' : `${retiredEmptyCount} hold`} nothing
                    and can be deleted outright with <strong>×</strong>.</>
                )}
                {retiredUnknownCount > 0 && (
                  <> {' '}{retiredUnknownCount} {retiredUnknownCount === 1 ? 'is' : 'are'} still being counted.</>
                )}
              </p>
            )}
            {retiredJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                retired
                retiredMergeBlockedReason={retiredMergeBlockedReason}
                purgeBlockedReason={purgeBlockedReason(job)}
                contents={contentsFor(job)}
                onPurge={() => onPurgeJob(job)}
                canRestore={canRestore}
                onRestore={() => onRestoreJob(job)}
                operations={operationsByJob[job.id] ?? []}
                expanded={expandedJobIds.has(job.id)}
                modelCount={jobModelCounts.get(job.id) ?? 0}
                lineProductCount={lineProductCount}
                hasTimes={(jobTimeCounts.get(job.id) ?? 0) > 0}
                timeCountByOperation={timeCountByOperation}
                loading={loading}
                busy={busy}
                jobMerge={jobMerge}
                operationMerge={operationMerge}
                onToggleExpanded={() => onToggleExpanded(job.id)}
                onOpenModels={() => onOpenModels(job)}
                onAddOperation={(names) => onAddOperation(job, names)}
                onEditOperation={(op) => onEditOperation(op, job.name)}
                onMoveOperation={(op) => onMoveOperation(op, job.name)}
                onDeleteOperation={(op) => onDeleteOperation(op, job.name)}
                onMove={() => onMoveJob(job)}
                onDelete={() => onDeleteJob(job)}
                onDragStart={(e) => onJobDragStart(job, e)}
                onDragEnd={onJobDragEnd}
              />
            ))}
          </div>
        )}

        {section && (
          <div style={{ display: 'flex', gap: 6, padding: '10px 2px 2px', borderTop: '1px solid var(--border)', marginTop: 4 }}>
            <input
              className="input" style={{ flex: 1, minWidth: 0, fontSize: 13 }}
              placeholder={`New job in ${section.name}…`} value={adding} disabled={busy}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitAdd() } }}
            />
            <button
              type="button" className="btn-ghost" style={{ padding: '6px 12px', fontSize: 12 }}
              disabled={busy || !adding.trim()} onClick={commitAdd}
            >
              Add job
            </button>
          </div>
        )}

        {/* ── The merge actions. Both appear only once two rows are ticked. ─────────────── */}
        <MergeBar
          merge={jobMerge}
          noun="job"
          scopeLabel={section ? `in ${section.name}` : ''}
          onRequest={onRequestJobMerge}
        />
        <MergeBar
          merge={operationMerge}
          noun="operation"
          scopeLabel={operationMergeJobName ? `in ${operationMergeJobName}` : ''}
          onRequest={onRequestOperationMerge}
        />
      </div>
    </div>
  )
}

/**
 * The action that appears once two rows are ticked. Nothing else on this page starts a merge:
 * there is no mode to enter, because a card list can carry checkboxes all the time without them
 * competing with a row's navigation the way a Finder pane's would.
 *
 * The keeper is chosen on the CARD, not here — see "Keep this name" — because which row survives
 * is the one irreversible decision in a merge and it belongs next to the name it names. This bar
 * refuses to arm until one is picked, and says which step is outstanding.
 */
function MergeBar({ merge, noun, scopeLabel, onRequest }: {
  merge: ReturnType<typeof useMergeMode>
  noun: string
  scopeLabel: string
  onRequest: () => void
}) {
  if (merge.count < 2) return null
  const ready = merge.primaryId !== null

  return (
    <div className="lc-mergebar">
      <span style={{ fontSize: 12, color: 'var(--text-mid)', flex: 1, minWidth: 200, lineHeight: 1.5 }}>
        {plural(merge.count, noun)} ticked{scopeLabel ? ` ${scopeLabel}` : ''}.{' '}
        {ready
          ? `Keeping one; the other ${plural(merge.count - 1, noun)} will be retired.`
          : `Now tick “Keep this name” on the ${noun} that should survive.`}
      </span>
      <button type="button" className="btn-ghost" disabled={merge.busy} onClick={merge.cancel}>
        Clear
      </button>
      <button
        type="button"
        className="btn-danger"
        disabled={merge.busy || !ready}
        title={ready ? undefined : `Choose which ${noun} to keep first`}
        onClick={onRequest}
      >
        {merge.busy ? 'Checking…' : `Merge ${plural(merge.count, noun)}`}
      </button>
    </div>
  )
}

// ── One job card ────────────────────────────────────────────────────────────────────────────
/**
 * Collapsed it is an identity: the name at full length, how many operations, what it applies to,
 * and whether anything has been timed against it. Expanded it additionally lists its operations
 * inline — and SEVERAL cards can be expanded at once, which is the reason this is a card and not
 * a pane row. Comparing two suspected duplicates means reading both lists together.
 */
function JobCard({
  job, retired = false, retiredMergeBlockedReason = null, purgeBlockedReason = null,
  contents = null, onPurge, canRestore = true, onRestore,
  operations, expanded, modelCount, lineProductCount, hasTimes,
  timeCountByOperation,
  loading, busy, jobMerge, operationMerge, onToggleExpanded, onOpenModels, onAddOperation,
  onEditOperation, onMoveOperation, onDeleteOperation, onMove, onDelete,
  onDragStart, onDragEnd,
}: {
  job: Job
  /** This job is already deleted (is_active = false) and is only on screen because the Jobs
   * column's reveal is on. It can still be MOVED — that is the point — but it cannot be deleted
   * again and it is not a merge candidate. */
  retired?: boolean
  /** Why this retired row can't be ticked for a merge, or null when it can. Only read when
   * `retired` — a live job's merge eligibility is the shared hook's own answer. */
  retiredMergeBlockedReason?: string | null
  /**
   * Why × may not destroy this retired row, or null when it may. Only read when `retired`: on a live
   * job × is the soft delete and is always offered.
   *
   * The × on a retired row USED TO BE DISABLED outright ("Already deleted") — and the handler behind
   * it was the soft delete, which on an is_active = false row writes false over false and changes
   * nothing. Either way it was a dead control on the one row that had no other way out.
   */
  purgeBlockedReason?: string | null
  /**
   * Everything filed under this job — operations (retired included) and recorded times — or null
   * while it is still being counted. Only read on a RETIRED row, and it is THE number that row
   * shows: the badge used to count `operations` (live only) while the × and the guard counted this,
   * so a job holding two retired operations displayed "0 ops" next to "still holds operations".
   * Both now read this one value, and the expanded list below is the same set.
   */
  contents?: { operations: number; times: number } | null
  onPurge?: () => void
  /** lib/permissions' canRestoreJob. False disables Restore WITH THE REASON rather than hiding it:
   * a control that vanishes teaches nothing, and the user needs to know the action exists. */
  canRestore?: boolean
  onRestore?: () => void
  operations: Operation[]
  expanded: boolean
  modelCount: number
  lineProductCount: number
  hasTimes: boolean
  timeCountByOperation: Map<string, number>
  loading: boolean
  busy: boolean
  jobMerge: ReturnType<typeof useMergeMode>
  operationMerge: ReturnType<typeof useMergeMode>
  onToggleExpanded: () => void
  onOpenModels: () => void
  onAddOperation: (names: string[]) => void
  onEditOperation: (operation: Operation) => void
  onMoveOperation: (operation: Operation) => void
  onDeleteOperation: (operation: Operation) => void
  onMove: () => void
  onDelete: () => void
  onDragStart: (event: React.DragEvent) => void
  onDragEnd: () => void
}) {
  const [addText, setAddText] = useState('')
  /** The card element, used only as the drag image so the grip drags the whole row visually. */
  const cardRef = useRef<HTMLDivElement>(null)

  const ticked = jobMerge.selectedIds.has(job.id)
  const isKeeper = jobMerge.primaryId === job.id
  const disabledReason = jobMerge.disabledReason(job.id)

  const parsed = parseOperationNames(addText)
  const isPaste = parsed.names.length > 1

  function commitAdd() {
    if (parsed.names.length === 0) return
    setAddText('')
    onAddOperation(parsed.names)
  }

  return (
    <div
      className={'lc-job' + (isKeeper ? ' lc-job-keeper' : ticked ? ' lc-job-ticked' : '')}
      // Inline rather than a class: it is one visual state on one page, and the palette variables
      // are what the rest of this file reaches for anyway.
      style={retired ? { opacity: 0.72, borderStyle: 'dashed' } : undefined}
    >
      <div className="lc-job-head" ref={cardRef}>
        {/* THE GRIP. `draggable` lives here and not on the card, so a click anywhere else on the
            row still expands it — making the whole card draggable turns every attempt to open a
            job into a half-started drag. The drag IMAGE is set to the whole card below, so what
            follows the cursor is the job, not this little handle. */}
        <span
          className="lc-grip"
          draggable
          role="button"
          tabIndex={-1}
          aria-label={`Drag ${job.name} to another section`}
          title="Drag onto a section on the left to move this job"
          onClick={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            if (cardRef.current) {
              // Offset roughly under the grip so the card doesn't jump away from the pointer.
              e.dataTransfer.setDragImage(cardRef.current, 24, 20)
            }
            onDragStart(e)
          }}
          onDragEnd={onDragEnd}
        >
          <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true">
            <g fill="currentColor">
              <circle cx="3.5" cy="3" r="1.4" /><circle cx="8.5" cy="3" r="1.4" />
              <circle cx="3.5" cy="8" r="1.4" /><circle cx="8.5" cy="8" r="1.4" />
              <circle cx="3.5" cy="13" r="1.4" /><circle cx="8.5" cy="13" r="1.4" />
            </g>
          </svg>
        </span>
        <input
          type="checkbox"
          className="lc-check"
          checked={ticked}
          // A retired job IS a merge candidate — as the side that gets folded away. That is the
          // action that rescues its operations and recorded times. It is refused only when the
          // section holds no live job to fold it into (the host's answer, not this row's).
          disabled={Boolean(retired && retiredMergeBlockedReason) || Boolean(disabledReason) || jobMerge.busy}
          title={retired
            ? retiredMergeBlockedReason
              ?? 'Tick this and the live job it belongs to, then keep the LIVE one — its operations and recorded times move across'
            : disabledReason ?? 'Tick two or more jobs to merge them'}
          aria-label={`Select ${job.name}`}
          onChange={() => jobMerge.toggle(job.id)}
        />
        <button
          type="button"
          className="lc-job-name"
          aria-expanded={expanded}
          title={expanded ? 'Hide operations' : 'Show operations'}
          onClick={onToggleExpanded}
        >
          <span style={{ color: 'var(--text-muted)', marginRight: 8, fontWeight: 400 }}>
            {expanded ? '▾' : '▸'}
          </span>
          {job.name}
          {retired && <span className="badge" style={{ marginLeft: 8, fontSize: 10 }}>Deleted</span>}
        </button>
        <span className="lc-job-meta">
          {hasTimes && (
            <span
              className="lc-dot"
              // The signal, not a value — see .lc-dot. It exists so a merge or a delete is never
              // made in ignorance of collected data behind the row.
              title="Has recorded times — merging or deleting this touches collected data"
            />
          )}
          <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {/* A live job's count is the operations it has. A RETIRED job's is everything still
                filed under it, which is what its × and the pane's guard are about — one number, so
                the row can't say "0 ops" while the guard says it holds work. */}
            {retired
              ? contents === null
                ? 'counting…'
                : plural(contents.operations, 'op')
              : plural(operations.length, 'op')}
            {retired && contents !== null && contents.times > 0 && (
              <> · {plural(contents.times, 'time')}</>
            )}
          </span>
          <JobModelBadge
            applies={modelCount}
            total={lineProductCount}
            loading={loading}
            onOpen={onOpenModels}
          />
          {/* Restore sits FIRST on a retired row and is a worded button rather than a glyph: the
              other three tools are icons because their meaning is conventional, and "bring this
              deleted job back" is not something an icon can say. Disabled with the reason when the
              role can't, never hidden. */}
          {retired && (
            <button
              type="button"
              className="btn-ghost"
              style={{ padding: '4px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
              disabled={busy || !canRestore}
              title={canRestore
                ? 'Bring this job back as a live job — it can then be renamed, merged or re-filed like any other'
                : 'Restoring a deleted job is not available to your role'}
              onClick={onRestore}
            >
              Restore
            </button>
          )}
          <button
            type="button" className="lc-icon-btn"
            title={retired
              ? 'Move this deleted job to another section on this team — that is what clears the block on deleting this one'
              : 'Move to another section'}
            aria-label={`Move ${job.name}`} disabled={busy} onClick={onMove}
          >
            ⇄
          </button>
          {/* One glyph, two acts, and the row decides which. On a LIVE job × is the soft delete
              (retire), which keeps everything. On a RETIRED job it is the permanent one, offered
              only on a shell that holds nothing — a retire there would write false over false and
              do nothing at all, which is what made this button dead. */}
          <button
            type="button"
            className="lc-icon-btn"
            title={retired
              ? purgeBlockedReason ?? `Permanently delete the "${job.name}" row — it holds nothing, and this cannot be undone`
              : 'Delete this job'}
            aria-label={retired ? `Permanently delete ${job.name}` : `Delete ${job.name}`}
            disabled={busy || (retired && Boolean(purgeBlockedReason))}
            onClick={retired ? onPurge : onDelete}
          >
            ×
          </button>
        </span>
      </div>

      {/* Only on a ticked card, and it starts unset on every one of them — the shared merge
          module's rule, and the reason it exists: which row survives is never guessed from
          ordering. */}
      {ticked && (
        <div style={{ padding: '0 12px 8px 12px' }}>
          {/* A DELETED job may never be the survivor: a merge retires whatever it folds away, so
              keeping this side would hide the live job and leave the shell standing — the exact
              inverse of the repair. Disabled here and re-checked before the preflight, because the
              UI is not the only way in. */}
          <label
            className={'lc-keeper' + (isKeeper ? ' lc-keeper-on' : '')}
            title={retired
              ? 'A deleted job can’t be the one that survives — keep the live job instead'
              : undefined}
            style={retired ? { opacity: 0.6 } : undefined}
          >
            <input
              type="radio"
              name="lc-job-keeper"
              checked={isKeeper}
              disabled={retired || jobMerge.busy}
              style={{ width: 18, height: 18, accentColor: 'var(--blue)', cursor: 'pointer' }}
              onChange={() => jobMerge.setPrimary(job.id)}
            />
            {retired ? 'Can’t keep a deleted job' : 'Keep this name'}
          </label>
        </div>
      )}

      {expanded && (
        <div className="lc-job-body">
          {operations.length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
              No operations on this job yet.
            </p>
          )}

          {operations.map((op) => {
            const opTicked = operationMerge.selectedIds.has(op.id)
            const opKeeper = operationMerge.primaryId === op.id
            const opDisabled = operationMerge.disabledReason(op.id)
            const opTimes = timeCountByOperation.get(op.id) ?? 0
            return (
              <div key={op.id} className={'lc-op' + (opTicked ? ' lc-op-ticked' : '')}>
                <input
                  type="checkbox"
                  className="lc-check"
                  checked={opTicked}
                  // A retired job's operations are not in the merge hook's row list at all (the
                  // list is built from the live jobs), so an enabled checkbox here would tick and
                  // then be silently ignored by the plan. Off, with the reason.
                  disabled={retired || Boolean(opDisabled) || operationMerge.busy}
                  title={retired
                    ? 'This job is deleted — merge its operations after moving the job back into a section'
                    : opDisabled ?? 'Tick two or more operations in this job to merge them'}
                  aria-label={`Select ${op.name}`}
                  onChange={() => operationMerge.toggle(op.id)}
                />
                <span className="lc-op-name">
                  {op.name}
                  {/* A retired job now lists its retired operations — they are what its badge counts
                      and what its × is guarded on, so they have to be visible and labelled rather
                      than silently padding the list. */}
                  {op.is_active === false && (
                    <span className="badge" style={{ marginLeft: 6, fontSize: 10 }}>Deleted</span>
                  )}
                  {opKeeper && <span className="badge badge-blue" style={{ marginLeft: 6 }}>Keeping</span>}
                </span>
                {opTimes > 0 && (
                  <span className="lc-dot" title="Has recorded times — merging or deleting this touches collected data" />
                )}
                <span className="lc-op-tools">
                  <button
                    type="button" className="lc-icon-btn" title="Rename this operation"
                    aria-label={`Rename ${op.name}`} disabled={busy} onClick={() => onEditOperation(op)}
                  >
                    ✎
                  </button>
                  <button
                    type="button" className="lc-icon-btn" title="Move to another job"
                    aria-label={`Move ${op.name}`} disabled={busy} onClick={() => onMoveOperation(op)}
                  >
                    ⇄
                  </button>
                  <button
                    type="button" className="lc-icon-btn"
                    // Already retired: retireOperation would write false over false and change
                    // nothing — the same dead-button shape the job-level × had.
                    title={op.is_active === false ? 'Already deleted' : 'Delete this operation'}
                    aria-label={`Delete ${op.name}`}
                    disabled={busy || op.is_active === false}
                    onClick={() => onDeleteOperation(op)}
                  >
                    ×
                  </button>
                </span>
                {opTicked && (
                  <label className={'lc-keeper' + (opKeeper ? ' lc-keeper-on' : '')} style={{ flexShrink: 0 }}>
                    <input
                      type="radio"
                      name="lc-op-keeper"
                      checked={opKeeper}
                      disabled={operationMerge.busy}
                      style={{ width: 18, height: 18, accentColor: 'var(--blue)', cursor: 'pointer' }}
                      onChange={() => operationMerge.setPrimary(op.id)}
                    />
                    Keep this name
                  </label>
                )}
              </div>
            )
          })}

          {/* One box for both shapes: a name and Enter for one operation, a pasted list for
              many. parseOperationNames is what decides which it was — the same parser /collect's
              paste row uses, dropping blanks and repeats within the paste. */}
          <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'flex-start' }}>
            <textarea
              className="input"
              rows={isPaste ? 4 : 1}
              style={{ flex: 1, minWidth: 0, fontSize: 13, resize: 'vertical' }}
              placeholder="New operation… (or paste a list, one per line)"
              value={addText}
              disabled={busy}
              onChange={(e) => setAddText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !isPaste) { e.preventDefault(); commitAdd() }
              }}
            />
            <button
              type="button" className="btn-ghost" style={{ padding: '6px 12px', fontSize: 12, whiteSpace: 'nowrap' }}
              disabled={busy || parsed.names.length === 0} onClick={commitAdd}
            >
              {parsed.names.length > 1 ? `Add ${plural(parsed.names.length, 'operation')}` : 'Add'}
            </button>
          </div>
          {parsed.duplicatesDropped > 0 && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
              {plural(parsed.duplicatesDropped, 'repeated name')} in the paste will be added once.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── A confirm dialog wrapped round a picker ─────────────────────────────────────────────────
/** Both moves — job to section, operation to job — are the same shape: choose a destination,
 * read what rides along, confirm. */
function MovePicker({
  title, message, label, options, confirmLabel, busy, onConfirm, onCancel,
}: {
  title: string
  message: string
  label: string
  options: { value: string; label: string; disabled?: boolean }[]
  confirmLabel: string
  busy: boolean
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')

  return (
    <ConfirmDialog
      title={title}
      message={message}
      confirmLabel={busy ? 'Moving…' : confirmLabel}
      maxWidth={520}
      onConfirm={() => { if (value && !busy) onConfirm(value) }}
      onCancel={onCancel}
    >
      <div>
        <label className="label">{label}</label>
        <select
          className="select" style={{ width: '100%' }} autoFocus
          value={value} onChange={(e) => setValue(e.target.value)}
        >
          <option value="">— Choose —</option>
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}{o.disabled ? ' (where it is now)' : ''}
            </option>
          ))}
        </select>
        {options.every((o) => o.disabled) && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0' }}>
            There is nowhere else to move it to yet.
          </p>
        )}
      </div>
    </ConfirmDialog>
  )
}
