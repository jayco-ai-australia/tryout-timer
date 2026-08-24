export type UserRole = 'user' | 'admin'

export interface Profile {
  id: string
  full_name: string | null
  role: UserRole
  production_line_id: string | null
  created_at: string
  production_lines?: Pick<ProductionLine, 'id' | 'name'> | null
}

export interface ProductionLine {
  id: string
  name: string
  created_at: string
}

export interface Team {
  id: string
  name: string
  production_line_id: string
  available_hours_per_day: number
  created_at: string
}

export interface Operator {
  id: string
  full_name: string
  employee_id: string | null
  team_id: string | null
  production_line_id: string | null
  is_active: boolean
  created_at: string
  teams?: Pick<Team, 'id' | 'name'> | null
  production_lines?: Pick<ProductionLine, 'id' | 'name'> | null
}

export type ChangeRequestStatus = 'pending' | 'approved' | 'rejected'

export interface OperatorChangeRequest {
  id: string
  operator_id: string
  requested_by: string | null
  from_team_id: string | null
  to_team_id: string
  reason: string | null
  status: ChangeRequestStatus
  created_at: string
  operators?: Pick<Operator, 'id' | 'full_name'> | null
  from_team?: Pick<Team, 'id' | 'name'> | null
  to_team?: Pick<Team, 'id' | 'name'> | null
  requester?: Pick<Profile, 'full_name'> | null
}

export interface Product {
  id: string
  product_code: string
  model: string
  product_series: string | null
  year: number | null
  product_type: string | null
  productionfacility: string | null
  production_line_id: string | null
  created_at: string
}

export interface Chassis {
  id: string
  fk_order_id: string | null
  chassisnumber: string
  model: string | null
  dealer: string | null
  dateoffline: string | null
  dateonline: string | null
  runnumber: string | null
  despatchstatus: string | null
  product_id: string | null
  created_at: string
  products?: Pick<Product, 'id' | 'product_code' | 'model' | 'production_line_id'> | null
}

/** A step of the line's walk order — Production Line → Team → Stage → Job → Operation.
 * Jobs point at a stage via jobs.stage_id (nullable: an unstaged job still exists). */
export interface Stage {
  id: string
  name: string
  team_id: string | null
  production_line_id: string | null
  sort_order: number | null
  created_at: string
}

export interface Job {
  id: string
  name: string
  primary_operator_id: string | null
  team_id: string | null
  production_line_id: string | null
  /** Optional here because most screens select jobs without it — the Stage-grouped walk on
   * /tryouts is the one that reads it. */
  stage_id?: string | null
  created_at: string
  teams?: Pick<Team, 'id' | 'name'> | null
  primary_operator?: Pick<Operator, 'id' | 'full_name'> | null
}

export interface Operation {
  id: string
  name: string
  job_id: string
  primary_operator_id: string | null
  secondary_operator_id: string | null
  /** Soft-delete flag. false = retired (merged into another operation on /tryouts) — every
   * screen that lists operations filters to is_active = true, so a retired operation stops
   * appearing across the app without its row, or any history pointing at it, being destroyed.
   * Optional here because most selects don't ask for the column. */
  is_active?: boolean
  created_at: string
  jobs?: Pick<Job, 'id' | 'name' | 'team_id' | 'production_line_id'> | null
  primary_operator?: Pick<Operator, 'id' | 'full_name'> | null
  secondary_operator?: Pick<Operator, 'id' | 'full_name'> | null
}

export interface OperationTime {
  id: string
  operation_id: string
  operator_id: string
  chassis_id: string | null
  collected_by: string | null
  started_at: string | null
  paused_duration_seconds: number
  completed_at: string | null
  total_minutes: number | null
  is_imported: boolean
  /** NOT an "admin hid this" flag despite the name — it marks a superseded import batch, and
   * most rows in prod are false. Reads must not filter on it; see the is_active note at the top
   * of lib/operationTimes.ts. */
  is_active: boolean
  team_id: string | null
  production_line_id: string | null
  created_at: string
}

export interface OperationTimeModel {
  operation_time_id: string
  product_id: string
}

export interface OperationTimeNote {
  id: string
  operation_time_id: string
  content: string
  created_by: string | null
  created_at: string
  profiles?: Pick<Profile, 'full_name'> | null
}

/** Fully joined operation_time record, as used on /records and /admin. */
export interface OperationTimeWithRelations extends OperationTime {
  operations: (Pick<Operation, 'id' | 'name' | 'job_id' | 'primary_operator_id' | 'secondary_operator_id'> & {
    jobs?: (Pick<Job, 'id' | 'name' | 'team_id' | 'production_line_id'> & {
      teams?: Pick<Team, 'id' | 'name'> | null
      production_lines?: Pick<ProductionLine, 'id' | 'name'> | null
    }) | null
    primary_operator?: Pick<Operator, 'id' | 'full_name'> | null
    secondary_operator?: Pick<Operator, 'id' | 'full_name'> | null
  }) | null
  operators: Pick<Operator, 'id' | 'full_name'> | null
  chassis: (Pick<Chassis, 'id' | 'chassisnumber' | 'product_id'> & {
    products?: Pick<Product, 'id' | 'product_code' | 'model' | 'product_series'> | null
  }) | null
  teams?: Pick<Team, 'id' | 'name'> | null
  production_lines?: Pick<ProductionLine, 'id' | 'name'> | null
  collector?: Pick<Profile, 'full_name'> | null
  operation_time_notes?: OperationTimeNote[]
  operation_time_models?: (OperationTimeModel & {
    products?: Pick<Product, 'id' | 'product_code' | 'model' | 'product_series'> | null
  })[]
}

/** ── Roadmap ────────────────────────────────────────────────────────────
 * Delivery plan shown on /roadmap. Phases are the top-level buckets (Phase 1…N),
 * each holding an ordered list of tasks. Read-only for everyone; admins edit the
 * whole board in one batch save. */
export interface RoadmapPhase {
  id: string
  phase_number: number
  label: string
  title: string
  subtitle: string | null
  lead: string | null
  /** Date columns (YYYY-MM-DD). Both must be set for the card to show its date range. */
  start_date: string | null
  end_date: string | null
  created_at: string
}

export type RoadmapItemStatus = 'not_started' | 'in_progress' | 'done'

export interface RoadmapItem {
  id: string
  phase_id: string
  task: string
  description: string | null
  assigned_to: string | null
  due_date: string | null
  status: RoadmapItemStatus
  sort_order: number
  created_at: string
}
