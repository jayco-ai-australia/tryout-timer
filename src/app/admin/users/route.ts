import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { canAccessAdminArea } from '@/lib/permissions'
import { MIN_PASSWORD_LENGTH } from '@/lib/newUser'
import type { UserRole } from '@/lib/types'

/**
 * POST /admin/users — create a login and its profile in one action. Admin only.
 * DELETE /admin/users — remove a login and its profile (see DELETE below). Admin only.
 *
 * Under /admin on purpose, so the middleware's admin gate covers it as well as the check below.
 * requireAdmin is the check that counts: both handlers run it before anything else, with the same
 * session read and the same canAccessAdminArea the /admin page itself uses.
 *
 * ── Secrets ────────────────────────────────────────────────────────────────────────────────
 * The service role key is read by createServiceClient from the server environment and never
 * leaves this file's process. The password is handed to Supabase and nothing else: it is not
 * logged, not stored, not returned. Errors are logged as code + status only, and every message
 * sent back is one of the fixed strings below, never a raw error.
 *
 * ── Not atomic ─────────────────────────────────────────────────────────────────────────────
 * The Auth user and the profiles row are written by two different services (Auth's admin API,
 * then PostgREST), so no transaction spans them. Making it atomic would take a database function,
 * which is a schema change. Instead: if the profile write fails after the login exists, the login
 * is deleted (profiles cascades from auth.users) and the admin is told nothing was created. If
 * that delete fails too, the response says so and names the email, so a half-made login is never
 * left behind silently.
 */

/** Supabase hashes with bcrypt, which ignores everything past 72 bytes. */
const MAX_PASSWORD_LENGTH = 72
const ROLES: UserRole[] = ['user', 'manager', 'admin']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

/** Logs what went wrong without anything that was sent: code and status only. */
function logFailure(step: string, err: { code?: string; status?: number } | null | undefined) {
  console.error(`[admin/users] ${step} failed`, { code: err?.code ?? null, status: err?.status ?? null })
}

/**
 * The gate both handlers open with, before they read the body or touch the service key: a signed-in
 * caller whose profile role passes canAccessAdminArea — the same session read and helper the /admin
 * page uses. Returns the caller's id and their session client, or the response to send instead.
 */
async function requireAdmin(action: string) {
  const supabase = await createClient()
  const { data: { user: caller } } = await supabase.auth.getUser()
  if (!caller) return { denied: fail(401, 'You’re not signed in.') } as const
  const { data: callerProfile } = await supabase.from('profiles').select('role').eq('id', caller.id).maybeSingle()
  if (!canAccessAdminArea((callerProfile?.role ?? null) as UserRole | null)) {
    return { denied: fail(403, `Only an admin can ${action}.`) } as const
  }
  return { callerId: caller.id, supabase } as const
}

/** The service client, or null when the key isn't in the server environment. Never logs the key. */
function serviceClientOrNull() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    logFailure('config: SUPABASE_SERVICE_ROLE_KEY missing', null)
    return null
  }
  return createServiceClient()
}

export async function POST(request: Request) {
  // ── 1. The caller must be an admin. Nothing else happens until this passes. ──
  const gate = await requireAdmin('add users')
  if ('denied' in gate) return gate.denied
  const { supabase } = gate

  // ── 2. Validate everything before calling Supabase. ──
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return fail(400, 'The form didn’t arrive. Try again.')
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : ''
  const role = body.role as UserRole
  const lineId = typeof body.production_line_id === 'string' ? body.production_line_id : ''

  if (!EMAIL_RE.test(email)) return fail(400, 'Enter a valid email address.')
  if (password.length < MIN_PASSWORD_LENGTH) return fail(400, `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`)
  if (password.length > MAX_PASSWORD_LENGTH) return fail(400, `The password can be at most ${MAX_PASSWORD_LENGTH} characters.`)
  if (!fullName) return fail(400, 'Enter their full name.')
  if (!ROLES.includes(role)) return fail(400, 'Choose a role.')
  if (!lineId) return fail(400, 'Choose a production line.')

  const { data: line } = await supabase.from('production_lines').select('id, name').eq('id', lineId).maybeSingle()
  if (!line) return fail(400, 'That production line doesn’t exist.')

  const service = serviceClientOrNull()
  if (!service) return fail(500, 'The server isn’t set up to create users.')

  // ── 3. The login. Fails cleanly (nothing created) on a duplicate email or a password Supabase rejects. ──
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  if (createError || !created?.user) {
    logFailure('createUser', createError)
    if (createError?.code === 'email_exists' || createError?.code === 'user_already_exists') {
      return fail(409, 'A user with that email already exists.')
    }
    if (createError?.code === 'weak_password') {
      return fail(400, 'Supabase rejected that password as too weak. Use Generate, or a longer one.')
    }
    return fail(502, 'Supabase couldn’t create the login. Nothing was created.')
  }
  const newId = created.user.id

  // ── 4. The profile. A signup trigger may already have made the row (as a plain user, no line),
  // so upsert rather than insert, and check what came back rather than trusting no-error. ──
  const { data: profile, error: profileError } = await service
    .from('profiles')
    .upsert({ id: newId, full_name: fullName, role, production_line_id: lineId }, { onConflict: 'id' })
    .select('id, full_name, role, production_line_id, created_at')
    .maybeSingle()

  if (profileError || !profile || profile.role !== role || profile.production_line_id !== lineId) {
    logFailure('profile upsert', profileError)
    const { error: undoError } = await service.auth.admin.deleteUser(newId)
    if (undoError) {
      logFailure('rollback deleteUser', undoError)
      return fail(500, `The login was created but its profile couldn’t be saved, and removing the login failed too. ${email} can sign in with no role set — delete it in Supabase before trying again.`)
    }
    return fail(500, 'Couldn’t save the profile, so the login was removed again. Nothing was created.')
  }

  return NextResponse.json(
    {
      user: {
        ...profile,
        email,
        production_lines: { id: line.id, name: line.name },
      },
    },
    { status: 201 },
  )
}

/**
 * Every column that points at a user without ON DELETE (checked live 2026-11-17: a collected time
 * makes Auth's deleteUser fail outright and changes nothing). Counted first so the admin is told
 * why in words, rather than getting Supabase's empty 500. Not changed here on purpose: who
 * recorded what stays attached to the record.
 */
const USER_REFERENCES: { table: string; column: string; noun: [string, string] }[] = [
  { table: 'operation_times', column: 'collected_by', noun: ['recorded time', 'recorded times'] },
  { table: 'operation_time_notes', column: 'created_by', noun: ['note on a time', 'notes on times'] },
  { table: 'notes', column: 'created_by', noun: ['operation note', 'operation notes'] },
  { table: 'operator_change_requests', column: 'requested_by', noun: ['change request', 'change requests'] },
  { table: 'tryout_sessions', column: 'created_by', noun: ['try-out session', 'try-out sessions'] },
  { table: 'stopwatch_notes', column: 'created_by', noun: ['stopwatch note', 'stopwatch notes'] },
]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * DELETE /admin/users — remove a person's login and their profile. Admin only, never yourself.
 *
 * Login first, then profile: a login with no profile can do nothing, a profile with no login is a
 * ghost row. In practice the first step does both — profiles.id cascades from auth.users — so the
 * second only runs if the profile somehow survived, and the response says which steps succeeded.
 */
export async function DELETE(request: Request) {
  const gate = await requireAdmin('delete users')
  if ('denied' in gate) return gate.denied
  const { callerId } = gate

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return fail(400, 'The request didn’t arrive. Try again.')
  }
  const id = typeof body.id === 'string' ? body.id : ''
  if (!UUID_RE.test(id)) return fail(400, 'That isn’t a user.')
  if (id === callerId) return fail(400, 'You can’t delete your own account.')

  const service = serviceClientOrNull()
  if (!service) return fail(500, 'The server isn’t set up to delete users.')

  const [{ data: authUser }, { data: profile }] = await Promise.all([
    service.auth.admin.getUserById(id),
    service.from('profiles').select('id, full_name').eq('id', id).maybeSingle(),
  ])
  const hasLogin = !!authUser?.user
  if (!hasLogin && !profile) return fail(404, 'That user no longer exists.')
  const name = profile?.full_name || authUser?.user?.email || 'This user'

  // ── Anything they recorded blocks the delete. Say what, and stop before touching anything. ──
  const counts = await Promise.all(USER_REFERENCES.map(async (ref) => {
    const { count, error } = await service.from(ref.table).select('id', { count: 'exact', head: true }).eq(ref.column, id)
    return { ref, count: error ? 0 : count ?? 0 }
  }))
  const blocking = counts.filter((c) => c.count > 0)
  if (blocking.length) {
    const list = blocking.map((c) => `${c.count} ${c.ref.noun[c.count === 1 ? 0 : 1]}`).join(', ')
    return fail(409, `${name} can’t be deleted: they have ${list} against their name, and deleting them would lose who recorded it. Nothing was deleted.`)
  }

  // ── 1. The login. ──
  if (hasLogin) {
    const { error: loginError } = await service.auth.admin.deleteUser(id)
    if (loginError) {
      logFailure('deleteUser', loginError)
      return fail(502, `Supabase wouldn’t delete ${name}’s login. Nothing was deleted, and they can still sign in.`)
    }
  }

  // ── 2. The profile — normally already gone by cascade; removed here if not. ──
  const { data: leftover } = await service.from('profiles').select('id').eq('id', id).maybeSingle()
  if (leftover) {
    const { error: profileError } = await service.from('profiles').delete().eq('id', id)
    if (profileError) {
      logFailure('profile delete', profileError)
      return fail(500, hasLogin
        ? `${name}’s login was deleted, so they can no longer sign in, but their profile row couldn’t be removed.`
        : `${name} had no login, and their profile row couldn’t be removed.`)
    }
  }

  return NextResponse.json({ deleted: id, login: hasLogin ? 'deleted' : 'none' })
}
