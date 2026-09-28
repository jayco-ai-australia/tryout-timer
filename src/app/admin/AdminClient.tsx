'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import ConfirmDialog from '@/components/ConfirmDialog'
import { fmtDate, fmtMinutes } from '@/lib/format'
import { deleteOperationTime } from '@/lib/operationTimes'
import type { ChangeRequestStatus, OperatorChangeRequest, Profile, OperationTimeWithRelations, UserRole } from '@/lib/types'

/** The role picker's options, in ascending authority. Labels are what an admin reads; the
 * values are the column's own. Typed as UserRole so widening the union surfaces here rather
 * than leaving a role nobody can be assigned. */
const ROLE_OPTIONS: { value: UserRole; label: string; hint: string }[] = [
  { value: 'user', label: 'User', hint: 'Edits their own recorded times. Cannot delete times.' },
  { value: 'manager', label: 'Manager', hint: 'Edits and deletes any recorded time. No Admin or Config access.' },
  { value: 'admin', label: 'Admin', hint: 'Everything a manager can do, plus Admin and Config.' },
]

interface Props {
  profiles: Profile[]
  records: OperationTimeWithRelations[]
  requests: OperatorChangeRequest[]
}

type Tab = 'users' | 'records' | 'requests'

export default function AdminClient({ profiles: initialProfiles, records: initialRecords, requests: initialRequests }: Props) {
  const supabase = createClient()
  const [tab, setTab] = useState<Tab>('users')
  const [profiles, setProfiles] = useState(initialProfiles)
  const [records, setRecords] = useState(initialRecords)
  const [requests, setRequests] = useState(initialRequests)
  const [confirm, setConfirm] = useState<{ type: 'user' | 'record'; id: string } | null>(null)
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null)

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
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="data-table">
            <thead><tr><th>Name</th><th>Joined</th><th>Role</th><th className="right">Actions</th></tr></thead>
            <tbody>
              {profiles.map((profile) => (
                <tr key={profile.id}>
                  <td className="primary">{profile.full_name ?? <em style={{ color: 'var(--text-muted)' }}>No name</em>}</td>
                  <td>{fmtDate(profile.created_at)}</td>
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
                  <td className="right">
                    <button onClick={() => setConfirm({ type: 'user', id: profile.id })} style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {profiles.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '28px 0' }}>No users found</p>}
        </div>
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
                    <td className="blue">{fmtMinutes(r.total_minutes)}</td>
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
