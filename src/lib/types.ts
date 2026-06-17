export type UserRole = 'user' | 'admin'

export interface Profile {
  id: string
  full_name: string | null
  role: UserRole
  created_at: string
}

export interface TryoutSession {
  id: string
  chassis_number: string
  created_by: string | null
  created_at: string
  notes: string | null
  profiles?: Pick<Profile, 'full_name'>
  operation_count?: number
}

export interface Operation {
  id: string
  session_id: string
  operator_name: string
  stage: string
  operation_name: string
  started_at: string | null
  paused_duration_seconds: number
  completed_at: string | null
  total_minutes: number | null
  notes: string | null
  created_by: string | null
  created_at: string
}

export type OperationStatus = 'idle' | 'running' | 'paused' | 'complete'
