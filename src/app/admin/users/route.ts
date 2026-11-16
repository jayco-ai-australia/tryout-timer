import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { canAccessAdminArea } from '@/lib/permissions'
import { MIN_PASSWORD_LENGTH } from '@/lib/newUser'
import type { UserRole } from '@/lib/types'

/**
 * POST /admin/users — create a login and its profile in one action. Admin only.
 *
 * Under /admin on purpose, so the middleware's admin gate covers it as well as the check below.
 * The check below is the one that counts: it runs before anything else, with the same session
 * read and the same canAccessAdminArea the /admin page itself uses.
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

export async function POST(request: Request) {
  // ── 1. The caller must be an admin. Nothing else happens until this passes. ──
  const supabase = await createClient()
  const { data: { user: caller } } = await supabase.auth.getUser()
  if (!caller) return fail(401, 'You’re not signed in.')
  const { data: callerProfile } = await supabase.from('profiles').select('role').eq('id', caller.id).maybeSingle()
  if (!canAccessAdminArea((callerProfile?.role ?? null) as UserRole | null)) {
    return fail(403, 'Only an admin can add users.')
  }

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

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    logFailure('config: SUPABASE_SERVICE_ROLE_KEY missing', null)
    return fail(500, 'The server isn’t set up to create users.')
  }
  const service = createServiceClient()

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
