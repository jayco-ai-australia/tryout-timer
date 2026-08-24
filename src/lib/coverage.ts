/**
 * The single job×model coverage definition — /dashboard uses it today, the gaps view will
 * reuse it later. Coverage is assignment-independent (operator assignment plays no part) and
 * is defined entirely in terms of three junctions:
 *
 *   operations.job_id            → which job an operation belongs to
 *   model_operations              → which models an operation applies to (this is what makes
 *                                    a model "required" for a job)
 *   operation_time_models         → which model(s) a recorded operation_time is linked to
 *                                    (operation_times has no product_id column of its own)
 *
 * For a job J: requiredModels(J) is the distinct set of products linked, via
 * model_operations, to any operation whose job_id = J — regardless of who (if anyone) is
 * assigned to that operation. A model m in requiredModels(J) is "covered" if there exists an
 * operation_time, linked to m via operation_time_models, whose own operation also belongs to
 * job J.
 *
 * Everything here works off a flat list of (job, model) "combos" — see computeCoverageCombos
 * — so the three rollups (per-job, per-team, per-series) are just different groupings of the
 * same underlying set, never three separate calculations.
 */

export interface CoverageJobInput { id: string; name: string; team_id: string | null }
export interface CoverageOperationInput { id: string; job_id: string }
export interface CoverageModelOperationInput { operation_id: string; product_id: string }
export interface CoverageOperationTimeInput { id: string; operation_id: string }
export interface CoverageOperationTimeModelInput { operation_time_id: string; product_id: string }
export interface CoverageProductInput { id: string; product_series: string | null }

export interface CoverageCombo {
  jobId: string
  productId: string
  covered: boolean
}

export interface JobCoverage {
  jobId: string
  jobName: string
  teamId: string | null
  requiredCount: number
  coveredCount: number
  gapsCount: number
  /** null when requiredCount is 0 — nothing declared for this job, not a 0% gap. */
  coveragePct: number | null
}

export interface TeamCoverage {
  teamId: string
  requiredCount: number
  coveredCount: number
  coveragePct: number | null
}

export interface ModelCoverage {
  productId: string
  requiredCount: number
  coveredCount: number
  gapsCount: number
  /** null when requiredCount is 0 — nothing required of this model, not a 0% gap. */
  coveragePct: number | null
}

export interface SeriesCoverage {
  series: string
  requiredCount: number
  coveredCount: number
  coveragePct: number | null
}

export interface AggregateCoverage {
  totalRequired: number
  totalCovered: number
  gapsRemaining: number
  coveragePct: number | null
}

/**
 * Builds the flat (job, model) combo list every other function in this module works from.
 * One combo per distinct (job_id, product_id) pair declared via model_operations — deduped,
 * so an operation with 5 models under a job that already required those models via another
 * operation doesn't double-count.
 */
export function computeCoverageCombos(input: {
  operations: CoverageOperationInput[]
  modelOperations: CoverageModelOperationInput[]
  operationTimes: CoverageOperationTimeInput[]
  operationTimeModels: CoverageOperationTimeModelInput[]
}): CoverageCombo[] {
  const { operations, modelOperations, operationTimes, operationTimeModels } = input

  const jobIdByOperationId = new Map(operations.map((o) => [o.id, o.job_id]))

  const required = new Map<string, CoverageCombo>()
  for (const mo of modelOperations) {
    const jobId = jobIdByOperationId.get(mo.operation_id)
    if (!jobId) continue
    const key = `${jobId}:${mo.product_id}`
    if (!required.has(key)) required.set(key, { jobId, productId: mo.product_id, covered: false })
  }

  const jobIdByTimeId = new Map(
    operationTimes
      .map((t) => [t.id, jobIdByOperationId.get(t.operation_id)] as const)
      .filter((pair): pair is [string, string] => !!pair[1])
  )
  for (const tm of operationTimeModels) {
    const jobId = jobIdByTimeId.get(tm.operation_time_id)
    if (!jobId) continue
    const key = `${jobId}:${tm.product_id}`
    const combo = required.get(key)
    if (combo) combo.covered = true
  }

  return [...required.values()]
}

export function aggregateCoverage(combos: CoverageCombo[]): AggregateCoverage {
  const totalRequired = combos.length
  const totalCovered = combos.filter((c) => c.covered).length
  return {
    totalRequired,
    totalCovered,
    gapsRemaining: totalRequired - totalCovered,
    coveragePct: totalRequired > 0 ? (totalCovered / totalRequired) * 100 : null,
  }
}

export function jobCoverageFromCombos(combos: CoverageCombo[], jobs: CoverageJobInput[]): JobCoverage[] {
  const byJob = new Map<string, { required: number; covered: number }>()
  for (const c of combos) {
    const entry = byJob.get(c.jobId) ?? { required: 0, covered: 0 }
    entry.required += 1
    if (c.covered) entry.covered += 1
    byJob.set(c.jobId, entry)
  }
  return jobs.map((j) => {
    const entry = byJob.get(j.id) ?? { required: 0, covered: 0 }
    return {
      jobId: j.id,
      jobName: j.name,
      teamId: j.team_id,
      requiredCount: entry.required,
      coveredCount: entry.covered,
      gapsCount: entry.required - entry.covered,
      coveragePct: entry.required > 0 ? (entry.covered / entry.required) * 100 : null,
    }
  })
}

/** Rolls combos up by the owning job's team_id. Jobs with no team are excluded (nothing
 * sensible to roll them into). */
export function teamCoverageFromCombos(combos: CoverageCombo[], jobs: CoverageJobInput[]): TeamCoverage[] {
  const teamIdByJobId = new Map(jobs.map((j) => [j.id, j.team_id]))
  const byTeam = new Map<string, { required: number; covered: number }>()
  for (const c of combos) {
    const teamId = teamIdByJobId.get(c.jobId)
    if (!teamId) continue
    const entry = byTeam.get(teamId) ?? { required: 0, covered: 0 }
    entry.required += 1
    if (c.covered) entry.covered += 1
    byTeam.set(teamId, entry)
  }
  return [...byTeam.entries()].map(([teamId, entry]) => ({
    teamId,
    requiredCount: entry.required,
    coveredCount: entry.covered,
    coveragePct: entry.required > 0 ? (entry.covered / entry.required) * 100 : null,
  }))
}

/**
 * Rolls combos up by MODEL — one entry per product that any job requires. The per-model
 * counterpart of jobCoverageFromCombos, and the grouping /dashboard's scorecard reads: "how
 * many of this model's required jobs have ever been timed for it", and by extension how many
 * models are fully covered.
 *
 * Only models that appear in `combos` are returned. A product nothing requires has no coverage
 * to report — that is a different thing from 0%, and inventing a row for it would drag the
 * "models at 100%" denominator up with every unlinked model in the catalogue.
 */
export function modelCoverageFromCombos(combos: CoverageCombo[]): ModelCoverage[] {
  const byProduct = new Map<string, { required: number; covered: number }>()
  for (const c of combos) {
    const entry = byProduct.get(c.productId) ?? { required: 0, covered: 0 }
    entry.required += 1
    if (c.covered) entry.covered += 1
    byProduct.set(c.productId, entry)
  }
  return [...byProduct.entries()].map(([productId, entry]) => ({
    productId,
    requiredCount: entry.required,
    coveredCount: entry.covered,
    gapsCount: entry.required - entry.covered,
    coveragePct: entry.required > 0 ? (entry.covered / entry.required) * 100 : null,
  }))
}

/** Rolls combos up by the model's product_series (unspecified series bucketed as "Other"). */
export function seriesCoverageFromCombos(combos: CoverageCombo[], products: CoverageProductInput[]): SeriesCoverage[] {
  const seriesByProductId = new Map(products.map((p) => [p.id, p.product_series?.trim() || 'Other']))
  const bySeries = new Map<string, { required: number; covered: number }>()
  for (const c of combos) {
    const series = seriesByProductId.get(c.productId) ?? 'Other'
    const entry = bySeries.get(series) ?? { required: 0, covered: 0 }
    entry.required += 1
    if (c.covered) entry.covered += 1
    bySeries.set(series, entry)
  }
  return [...bySeries.entries()].map(([series, entry]) => ({
    series,
    requiredCount: entry.required,
    coveredCount: entry.covered,
    coveragePct: entry.required > 0 ? (entry.covered / entry.required) * 100 : null,
  }))
}
