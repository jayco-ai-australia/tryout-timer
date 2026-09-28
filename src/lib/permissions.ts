import type { UserRole } from './types'

/**
 * THE permissions module — every "may this person do that?" in the app is answered here.
 *
 * These functions mirror the RLS policies on the database, and that is the whole point of them
 * existing. RLS is the enforcement; this is the UI's copy of the same rules, used to decide what
 * to OFFER. When the two disagree the user gets a control that produces an error, which reads as
 * the app being broken rather than as permission being denied — so the rules live in one file,
 * are stated once, and every screen imports them rather than writing `role === '…'` inline.
 *
 * ── The three roles ────────────────────────────────────────────────────────────────────────
 *   user    — UPDATE only their own operation_times rows (collected_by = their id) or ownerless
 *             ones (collected_by is null). No DELETE.
 *   manager — UPDATE and DELETE any operation_times row.
 *   admin   — everything a manager can, plus /admin and /config.
 *
 * A MANAGER IS NOT A JUNIOR ADMIN. The two tiers answer different questions: manager is authority
 * over recorded work, admin is authority over the application. /admin and /config stay admin-only,
 * and canAccessAdminArea below is deliberately a separate function from canDeleteTime so that
 * widening one can never quietly widen the other.
 *
 * ── What is NOT here ───────────────────────────────────────────────────────────────────────
 * operation_time_notes keeps its own-author rule for update and delete, for every role including
 * manager and admin: a note is somebody's written comment, not a measurement, and a manager
 * correcting a figure has no business rewriting what a collector said about it. That rule is
 * enforced in the drawer against `note.created_by === userId` directly, with no helper here to
 * import, precisely so nobody reaches for a role check when adding to it.
 */

/** The viewer, as every rule below sees them. Nothing else about the profile matters. */
export interface PermissionActor {
  userId: string
  /** null while the profile is still loading, or when there is no profiles row. Treated as the
   * least privileged answer everywhere — an unknown role must never unlock a control. */
  role: UserRole | null
}

/** The only part of an operation_times row the rules read: who collected it. */
export interface TimeOwnership {
  collected_by: string | null
}

/**
 * Manager or admin — the tier that may act on other people's recorded work.
 *
 * Not exported as "isAdmin"-anything on purpose. Every caller has to say which of the two
 * questions it is asking, because they have different answers.
 */
export function canManageTimes(role: UserRole | null): boolean {
  return role === 'manager' || role === 'admin'
}

/**
 * /admin and /config. Admin ONLY — a manager is redirected exactly as a plain user is.
 *
 * Kept as its own function rather than folded into canManageTimes so that the day somebody wants
 * managers to delete times faster, they cannot do it by loosening a check that also opens the
 * admin area.
 */
export function canAccessAdminArea(role: UserRole | null): boolean {
  return role === 'admin'
}

/**
 * ── Structure: who may delete a section ────────────────────────────────────────────────────
 *
 * Admin only, and it is the ONE role check on /line-config and /setup's Sections pane — because
 * it is the one structural act in the app that is a real DELETE. Everything else structural is
 * either reversible (a rename, a move) or a soft delete that keeps every row (retiring a job or an
 * operation, merging either), and all of those are offered to every signed-in user.
 *
 * Stated here rather than as `role === 'admin'` inside a component, per the note at the top of this
 * file: the UI's copy of an RLS rule belongs in one place, and a screen that spells it out inline
 * is a screen that will disagree with the next one.
 *
 * Deliberately NOT canManageTimes: a manager's authority is over recorded work, and a section
 * holds none of its own.
 */
export function canDeleteSection(role: UserRole | null): boolean {
  return role === 'admin'
}

/**
 * ── …and who may bring a retired job back ──────────────────────────────────────────────────
 *
 * Everyone who can retire one, which on /line-config is every signed-in user. This exists as a
 * function rather than as an unwritten assumption because the asymmetry is the trap: a flag anyone
 * can set and only an admin can clear hides the job from every list in the app, leaves it blocking
 * the section it sits in, and denies the person who hid it any way to undo it. If this is ever
 * narrowed, retireJob's caller has to be narrowed in the same commit — see lib/jobs' restoreJob.
 */
export function canRestoreJob(role: UserRole | null): boolean {
  return role !== null
}

/**
 * May this person change this recorded time — its minutes, its operator, its superseded_by
 * pointer? Mirrors the UPDATE policy on operation_times exactly.
 *
 * An OWNERLESS record (collected_by null) is editable by anyone. Those are imported rows with no
 * collector attached; nobody's work is being overwritten, and leaving them frozen would make a
 * large slice of historical data permanently uncorrectable.
 */
export function canEditTime(actor: PermissionActor, record: TimeOwnership): boolean {
  if (canManageTimes(actor.role)) return true
  if (record.collected_by === null) return true
  return record.collected_by === actor.userId
}

/**
 * May this person delete a recorded time? Manager and admin only — deletion is not something a
 * collector may do even to their own work, which is why this takes no record at all: there is no
 * ownership case that would change the answer, and accepting one would imply there was.
 */
export function canDeleteTime(actor: PermissionActor): boolean {
  return canManageTimes(actor.role)
}

/**
 * ── PROMOTE NEEDS WRITE ACCESS TO TWO RECORDS ──────────────────────────────────────────────
 *
 * Making an archived record current is not one write. It clears superseded_by on the record being
 * promoted AND sets superseded_by on whatever is current now — and those two rows can belong to
 * different people. A collector promoting their own old measurement over a manager's current one
 * passes any check that looks only at the record being promoted, then gets half the operation
 * done: their record goes current, the other one is refused by RLS, and the pair is left with TWO
 * current records and a labour figure that depends on row order.
 *
 * So both rows are checked, and `currentRecord` is required rather than optional — a caller that
 * hasn't looked it up has not asked the right question. Pass null only when the pair genuinely
 * has no current record (every record archived), where there is no second write to authorise.
 */
export function canPromoteTime(
  actor: PermissionActor,
  promotedRecord: TimeOwnership,
  currentRecord: TimeOwnership | null
): boolean {
  if (!canEditTime(actor, promotedRecord)) return false
  if (currentRecord === null) return true
  return canEditTime(actor, currentRecord)
}

/**
 * Why a control is disabled, in words a collector can act on — or null when it isn't.
 *
 * Returned from here rather than written at each control so the phrasing is identical everywhere
 * and can't drift into three different explanations of one rule. `collectorName` is optional
 * because the name is a lookup that can fail; the sentence still works without it.
 */
export function timeEditBlockedReason(
  actor: PermissionActor,
  record: TimeOwnership,
  collectorName?: string | null
): string | null {
  if (canEditTime(actor, record)) return null
  return collectorName
    ? `Collected by ${collectorName} — only they or a manager can change this.`
    : 'Collected by someone else — only they or a manager can change this.'
}

/** The promote-specific version, which has a second record to blame. */
export function promoteBlockedReason(
  actor: PermissionActor,
  promotedRecord: TimeOwnership,
  currentRecord: TimeOwnership | null,
  names?: { promoted?: string | null; current?: string | null }
): string | null {
  if (canPromoteTime(actor, promotedRecord, currentRecord)) return null

  if (!canEditTime(actor, promotedRecord)) {
    return timeEditBlockedReason(actor, promotedRecord, names?.promoted)
  }
  // The subtle case: the record being promoted is theirs, the one it would archive is not.
  return names?.current
    ? `Promoting this would archive a record collected by ${names.current}, which only they or a manager can do.`
    : 'Promoting this would archive a record collected by someone else, which only they or a manager can do.'
}
