'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import ConfirmDialog from '@/components/ConfirmDialog'
import { TimeExclusionBadges } from '@/components/HiddenTimeBadge'
import { fmtDate, fmtMinutes } from '@/lib/format'
import { deleteOperationTime } from '@/lib/operationTimes'
import { MIN_PASSWORD_LENGTH, generatePassword } from '@/lib/newUser'
import type { ChangeRequestStatus, OperatorChangeRequest, Profile, OperationTimeWithRelations, UserRole } from '@/lib/types'

/** The role picker's options, in ascending authority. Labels are what an admin reads; the
 * values are the column's own. Typed as UserRole so widening the union surfaces here rather
 * than leaving a role nobody can be assigned. */
const ROLE_OPTIONS: { value: UserRole; label: string; hint: string }[] = [
  { value: 'user', label: 'User', hint: 'Edits their own recorded times. Cannot delete times.' },
  { value: 'manager', label: 'Manager', hint: 'Edits and deletes any recorded time. No Admin or Config access.' },
  { value: 'admin', label: 'Admin', hint: 'Everything a manager can do, plus Admin and Config.' },
]

/** A profile plus its login email, which lives in Auth and is read server-side in page.tsx. */
export type AdminUser = Profile & { email: string | null }

interface LineOption { id: string; name: string }

interface Props {
  profiles: AdminUser[]
  lines: LineOption[]
  records: OperationTimeWithRelations[]
  requests: OperatorChangeRequest[]
}

type Tab = 'users' | 'records' | 'requests'

/** Retired as lib/operationTimes' isRetiredTime means it: the record itself, or the operation
 * or job above it. Spelled against this page's own joined row, whose parent flags are optional
 * on the shared relation type. */
function retiredRecord(r: OperationTimeWithRelations): boolean {
  return r.is_active === false || r.operations?.is_active === false || r.operations?.jobs?.is_active === false
}

export default function AdminClient({ profiles: initialProfiles, lines, records: initialRecords, requests: initialRequests }: Props) {
  const supabase = createClient()
  const [tab, setTab] = useState<Tab>('users')
  const [profiles, setProfiles] = useState(initialProfiles)
  const [records, setRecords] = useState(initialRecords)
  const [requests, setRequests] = useState(initialRequests)
  const [confirm, setConfirm] = useState<{ type: 'user' | 'record'; id: string } | null>(null)
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  async function handleRoleChange(userId: string, newRole: UserRole) {
    const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', userId)
    if (!error) setProfiles((prev) => prev.map((p) => p.id === userId ? { ...p, role: newRole } : p))
  }

  async function handleDeleteUser(userId: string) {
    setConfirm(null)
    const { error } = await supabase.from('profiles').delete().eq('id', userId)
    if (!error) setProfiles((prev) => prev.filter((p) => p.id !== userId))
  }

  async function handleDeleteRecord(recordId: string) {
    setConfirm(null)
    // Same helper the /tryouts time-detail pane deletes through, so there's one delete path for
    // operation_times rather than an inline copy per screen.
    try {
      await deleteOperationTime(supabase, recordId)
      setRecords((prev) => prev.filter((r) => r.id !== recordId))
    } catch {
      // Matches this screen's existing behaviour: a failed delete leaves the row in place.
    }
  }

  async function handleApprove(req: OperatorChangeRequest) {
    setBusyRequestId(req.id)
    const { error: opErr } = await supabase.from('operators').update({ team_id: req.to_team_id }).eq('id', req.operator_id)
    if (!opErr) {
      const { error } = await supabase.from('operator_change_requests').update({ status: 'approved' as ChangeRequestStatus }).eq('id', req.id)
      if (!error) setRequests((prev) => prev.map((r) => r.id === req.id ? { ...r, status: 'approved' } : r))
    }
    setBusyRequestId(null)
  }

  async function handleReject(req: OperatorChangeRequest) {
    setBusyRequestId(req.id)
    const { error } = await supabase.from('operator_change_requests').update({ status: 'rejected' as ChangeRequestStatus }).eq('id', req.id)
    if (!error) setRequests((prev) => prev.map((r) => r.id === req.id ? { ...r, status: 'rejected' } : r))
    setBusyRequestId(null)
  }

  const pendingCount = requests.filter((r) => r.status === 'pending').length
  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'users', label: 'Users', count: profiles.length },
    { key: 'records', label: 'Operation Times', count: records.length },
    { key: 'requests', label: 'Change Requests', count: pendingCount },
  ]

  const statusBadge: Record<ChangeRequestStatus, string> = { pending: 'badge-amber', approved: 'badge-green', rejected: 'badge-grey' }

  return (
    <main className="page">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Admin</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Manage users, operation times, and change requests</p>
      </div>

      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={tab === t.key ? 'tab tab-active' : 'tab'}>
            {t.label} <span className="tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      {tab === 'users' && (
        <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          {!adding && <button type="button" className="btn-primary" onClick={() => setAdding(true)}>Add user</button>}
        </div>
        {adding && (
          <AddUserForm
            lines={lines}
            onCreated={(u) => setProfiles((prev) => [u, ...prev])}
            onClose={() => setAdding(false)}
          />
        )}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Line</th><th>Joined</th><th className="right">Actions</th></tr></thead>
            <tbody>
              {profiles.map((profile) => (
                <tr key={profile.id}>
                  <td className="primary">{profile.full_name ?? <em style={{ color: 'var(--text-muted)' }}>No name</em>}</td>
                  <td>{profile.email ?? <em style={{ color: 'var(--text-muted)' }}>—</em>}</td>
                  <td>
                    <select
                      className="select"
                      style={{ minWidth: 0, padding: '4px 8px', fontSize: 12 }}
                      value={profile.role}
                      title={ROLE_OPTIONS.find((r) => r.value === profile.role)?.hint}
                      onChange={(e) => handleRoleChange(profile.id, e.target.value as UserRole)}
                    >
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r.value} value={r.value} title={r.hint}>{r.label}</option>
                      ))}
                    </select>
                  </td>
                  <td>{profile.production_lines?.name ?? <em style={{ color: 'var(--text-muted)' }}>None</em>}</td>
                  <td>{fmtDate(profile.created_at)}</td>
                  <td className="right">
                    <button onClick={() => setConfirm({ type: 'user', id: profile.id })} style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {profiles.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '28px 0' }}>No users found</p>}
        </div>
        </>
      )}

      {tab === 'records' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Operation</th><th>Operator</th><th>Chassis</th><th className="right">Minutes</th><th>Date</th><th className="right">Actions</th></tr></thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id}>
                    <td className="primary">{r.operations?.name ?? '—'}</td>
                    <td>{r.operators?.full_name ?? '—'}</td>
                    <td className="mono">{r.chassis?.chassisnumber ?? '—'}</td>
                    <td className={r.is_hidden || retiredRecord(r) ? undefined : 'blue'} style={r.is_hidden || retiredRecord(r) ? { color: 'var(--text-muted)' } : undefined}>
                      {fmtMinutes(r.total_minutes)}
                      {(r.is_hidden || retiredRecord(r)) && <>{' '}<TimeExclusionBadges hidden={r.is_hidden} retired={retiredRecord(r)} /></>}
                    </td>
                    <td>{fmtDate(r.completed_at ?? r.created_at)}</td>
                    <td className="right">
                      <button onClick={() => setConfirm({ type: 'record', id: r.id })} style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {records.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '28px 0' }}>No operation time records found</p>}
        </div>
      )}

      {tab === 'requests' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="data-table">
            <thead><tr><th>Operator</th><th>From</th><th>To</th><th>Reason</th><th>Status</th><th className="right">Actions</th></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="primary">{r.operators?.full_name ?? '—'}</td>
                  <td>{r.from_team?.name ?? '—'}</td>
                  <td>{r.to_team?.name ?? '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.reason ?? '—'}</td>
                  <td><span className={'badge ' + statusBadge[r.status]}>{r.status}</span></td>
                  <td className="right">
                    {r.status === 'pending' ? (
                      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                        <button disabled={busyRequestId === r.id} onClick={() => handleReject(r)} style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>Reject</button>
                        <button disabled={busyRequestId === r.id} onClick={() => handleApprove(r)} style={{ fontSize: 12, fontWeight: 600, color: 'var(--green)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>Approve</button>
                      </div>
                    ) : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {requests.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '28px 0' }}>No change requests</p>}
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.type === 'user' ? 'Delete User' : 'Delete Record'}
          message="This will permanently delete this record. This cannot be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => confirm.type === 'user' ? handleDeleteUser(confirm.id) : handleDeleteRecord(confirm.id)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </main>
  )
}

/** Same basePath trap as app/layout's BASE_PATH: fetch() doesn't get next.config's prefix. */
const ADD_USER_URL = '/jmotion/admin/users'

/**
 * Add user — creates the login and the profile in one call to app/admin/users/route.ts, which
 * checks the caller is an admin and does the work with the service key. Nothing here touches
 * Supabase directly. The password is shown back once on success, then cleared with the form.
 */
function AddUserForm({ lines, onCreated, onClose }: {
  lines: LineOption[]
  onCreated: (user: AdminUser) => void
  onClose: () => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<UserRole>('user')
  const [lineId, setLineId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ email: string; name: string; password: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH
  const ready = email.trim() && fullName.trim() && password.length >= MIN_PASSWORD_LENGTH && lineId && !busy

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(ADD_USER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, full_name: fullName, role, production_line_id: lineId }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.user) {
        setError(json?.error ?? 'Something went wrong. Nothing was created.')
        return
      }
      onCreated(json.user as AdminUser)
      setDone({ email: json.user.email, name: json.user.full_name ?? fullName, password })
      setEmail(''); setPassword(''); setFullName(''); setRole('user'); setLineId('')
    } catch {
      setError('Couldn’t reach the server. Nothing was created.')
    } finally {
      setBusy(false)
    }
  }

  function finish() {
    setDone(null)
    onClose()
  }

  if (done) {
    return (
      <div className="card" style={{ padding: 20, marginBottom: 16, borderLeft: '4px solid var(--green)' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: 'var(--text)' }}>{done.name} can sign in now</h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '6px 0 14px' }}>
          Pass these on. The password is shown only this once — it isn’t stored anywhere you can see it again.
        </p>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', margin: 0, fontSize: 14 }}>
          <dt style={{ color: 'var(--text-mid)', fontWeight: 600 }}>Email</dt>
          <dd style={{ margin: 0 }}>{done.email}</dd>
          <dt style={{ color: 'var(--text-mid)', fontWeight: 600 }}>Password</dt>
          <dd style={{ margin: 0, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <code style={{ fontSize: 16, fontWeight: 700, letterSpacing: '0.04em' }}>{done.password}</code>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                navigator.clipboard?.writeText(done.password).then(() => setCopied(true), () => setCopied(false))
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </dd>
        </dl>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn-primary" onClick={finish}>Done</button>
        </div>
      </div>
    )
  }

  return (
    <form className="card" style={{ padding: 20, marginBottom: 16 }} onSubmit={submit} autoComplete="off">
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 14px', color: 'var(--text)' }}>Add user</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        <div>
          <label className="label" htmlFor="nu-name">Full name</label>
          <input id="nu-name" className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor="nu-email">Email</label>
          <input id="nu-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor="nu-password">Password</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="nu-password"
              className="input"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              aria-describedby="nu-password-hint"
            />
            <button type="button" className="btn-ghost" onClick={() => setPassword(generatePassword())}>Generate</button>
          </div>
          <p id="nu-password-hint" style={{ fontSize: 12, margin: '4px 0 0', color: tooShort ? 'var(--red)' : 'var(--text-muted)' }}>
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="nu-role">Role</label>
          <select id="nu-role" className="select" style={{ width: '100%' }} value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <p style={{ fontSize: 12, margin: '4px 0 0', color: 'var(--text-muted)' }}>{ROLE_OPTIONS.find((r) => r.value === role)?.hint}</p>
        </div>
        <div>
          <label className="label" htmlFor="nu-line">Production line</label>
          <select id="nu-line" className="select" style={{ width: '100%' }} value={lineId} onChange={(e) => setLineId(e.target.value)}>
            <option value="">Choose a line…</option>
            {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      </div>
      {error && (
        <p role="alert" style={{ margin: '14px 0 0', padding: '10px 12px', borderRadius: 8, background: 'var(--red-bg)', color: 'var(--red)', fontSize: 13, fontWeight: 600 }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={!ready}>{busy ? 'Adding…' : 'Add user'}</button>
      </div>
    </form>
  )
}
