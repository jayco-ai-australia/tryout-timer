import type { LineSplit } from '@/lib/lines'
import type { ModelTotalOperationRow } from '@/lib/operationTimes'
import { groupSectionsByTeam, isSectionTray, type SectionOrderRef } from '@/lib/sections'

/**
 * /model-total's breakdown as the structure itself: Production line → Team → Section → Job.
 *
 * GROUPING ONLY. No time is read and no figure is derived here — the leaves are the job groups
 * ModelTotalClient already builds from fetchModelTotal (lib/operationTimes, the one place that
 * decides which records count) and the applies-list, and every level above a job is a plain sum
 * of the level below. So a section is its jobs summed, a team its sections, a line its teams,
 * and the lines sum to the on-screen total.
 *
 * Applicability falls out of the same shape: a job is here because at least one of its
 * operations applies to the model, a section because at least one of its jobs is, a team because
 * at least one of its sections is. Nothing that applies to nothing gets a row.
 *
 * The screen, the "Not yet timed" list and the printed sheets all read this one tree, so a job
 * sits under the same team and section wherever it is read.
 */

/** An operation that applies to the model and has no current record. */
export interface MissingOpRow { operationId: string; operationName: string; primaryOperatorId: string | null; secondaryOperatorId: string | null }

/** A section as the hierarchy read returns it: enough to order it and to find its team. */
export type HierarchySection = SectionOrderRef & { team_id: string | null }

/** The figures every level carries. `totalOps - timedOps` is the untimed count. */
export interface Rollup {
  /** Jobs that apply to the model. */
  jobCount: number
  /** …of which at least one operation is timed — coverage's meaning of "covered". */
  jobsCovered: number
  totalOps: number
  timedOps: number
  minutes: number
}

export interface JobNode {
  jobId: string
  jobName: string
  lineId: string | null
  /** Operations with a current record, and the applicable ones without. */
  rows: ModelTotalOperationRow[]
  missing: MissingOpRow[]
  minutes: number
  timedOps: number
  totalOps: number
  operatorIds: string[]
}

export interface SectionNode extends Rollup {
  key: string
  name: string
  /** A team's "No Section" tray — a real section row, labelled as the tray rather than hidden. */
  tray: boolean
  jobs: JobNode[]
}

export interface TeamNode extends Rollup {
  key: string
  name: string
  /** Sections that are steps of the team's walk — the tray is not one (as on /config). */
  sectionCount: number
  sections: SectionNode[]
}

export interface LineNode extends Rollup {
  key: string
  lineId: string | null
  lineName: string
  teams: TeamNode[]
}

/** A job with no section_id at all — a real state, so it lands in a visible row. */
const NO_SECTION_KEY = '__no-section__'
const NO_TEAM_NAME = 'No team'

const ZERO: Rollup = { jobCount: 0, jobsCovered: 0, totalOps: 0, timedOps: 0, minutes: 0 }

/** THE addition — the only one any level above a job performs. */
function sum(parts: Rollup[]): Rollup {
  return parts.reduce((acc, p) => ({
    jobCount: acc.jobCount + p.jobCount,
    jobsCovered: acc.jobsCovered + p.jobsCovered,
    totalOps: acc.totalOps + p.totalOps,
    timedOps: acc.timedOps + p.timedOps,
    minutes: acc.minutes + p.minutes,
  }), ZERO)
}

export function jobRollup(job: JobNode): Rollup {
  return { jobCount: 1, jobsCovered: job.timedOps > 0 ? 1 : 0, totalOps: job.totalOps, timedOps: job.timedOps, minutes: job.minutes }
}

export function untimedCount(r: { totalOps: number; timedOps: number }): number {
  return r.totalOps - r.timedOps
}

export function buildBreakdownTree(input: {
  jobs: JobNode[]
  sectionIdOfJob: Map<string, string | null>
  sectionsById: Map<string, HierarchySection>
  /** null only for "no team". */
  teamName: (teamId: string | null) => string | null
  split: LineSplit | null
}): LineNode[] {
  const { jobs, sectionIdOfJob, sectionsById, teamName, split } = input

  // '' keys the "no line at all" bucket — a job created before lines existed still has to land
  // somewhere visible.
  const jobsByLine = new Map<string, JobNode[]>()
  for (const job of jobs) {
    const key = job.lineId ?? ''
    jobsByLine.set(key, [...(jobsByLine.get(key) ?? []), job])
  }

  const lines = [...jobsByLine.entries()].map(([lineKey, lineJobs]): LineNode => {
    const jobsBySection = new Map<string, JobNode[]>()
    for (const job of lineJobs) {
      const sectionId = sectionIdOfJob.get(job.jobId) ?? null
      const key = sectionId && sectionsById.has(sectionId) ? sectionId : NO_SECTION_KEY
      jobsBySection.set(key, [...(jobsBySection.get(key) ?? []), job])
    }

    const sectionNode = (key: string, name: string, tray: boolean): SectionNode => {
      const sorted = [...(jobsBySection.get(key) ?? [])].sort((a, b) => a.jobName.localeCompare(b.jobName))
      return { key, name, tray, jobs: sorted, ...sum(sorted.map(jobRollup)) }
    }
    const teamNode = (key: string, name: string, sections: SectionNode[]): TeamNode => ({
      key, name, sections, sectionCount: sections.filter((s) => !s.tray).length, ...sum(sections),
    })

    // Team first, then sections.sort_order, then job name — lib/sections' groupSectionsByTeam,
    // the same grouping and order as /config's Sections table.
    const present = [...jobsBySection.keys()]
      .filter((key) => key !== NO_SECTION_KEY)
      .map((id) => sectionsById.get(id)!)
    const teams = groupSectionsByTeam(present, (id) => teamName(id) ?? NO_TEAM_NAME).map((group) => teamNode(
      group.key, group.name,
      group.sections.map((s) => sectionNode(s.id, s.name, isSectionTray(s))),
    ))

    // Jobs with no section have no team either (lib/sections' teamForJob), so they join the
    // teamless group — last, if they are what creates it.
    if (jobsBySection.has(NO_SECTION_KEY)) {
      const loose = sectionNode(NO_SECTION_KEY, 'No section', false)
      const at = teams.findIndex((t) => t.key === '')
      if (at >= 0) teams[at] = teamNode('', teams[at].name, [...teams[at].sections, loose])
      else teams.push(teamNode('', NO_TEAM_NAME, [loose]))
    }

    return { key: lineKey, lineId: lineKey || null, lineName: split?.name(lineKey || null) ?? '—', teams, ...sum(teams) }
  })

  // Line labour first and pre-assembly after it, each half A–Z: the build line's own work reads
  // as the body of the model, with the fed-in pre-assembly areas beneath it.
  return lines.sort((a, b) => {
    const aPre = split?.isPreAssembly(a.lineId) ?? false
    const bPre = split?.isPreAssembly(b.lineId) ?? false
    if (aPre !== bPre) return aPre ? 1 : -1
    return a.lineName.localeCompare(b.lineName)
  })
}

/** The whole tree's figures — the grand total row. */
export function treeRollup(lines: LineNode[]): Rollup {
  return sum(lines)
}
