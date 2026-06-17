'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import ConfirmDialog from '@/components/ConfirmDialog'
import type { Profile } from '@/lib/types'

interface AdminSession {
  id: string
  chassis_number: string
  created_at: string
  profiles: { full_name: string | null } | null
}

interface AdminOperation {
  id: string
  operator_name: string
  stage: string
  operation_name: string
  total_minutes: number | null
  completed_at: string | null
  session_id: string
}

interface Props {
  profiles: Profile[]
  sessions: AdminSession[]
  operations: AdminOperation[]
}

type Tab = 'users' | 'sessions' | 'operations'

export default function AdminClient({ profiles: initialProfiles, sessions: initialSessions, operations: initialOperations }: Props) {
  const supabase = createClient()
  const [tab, setTab] = useState<Tab>('users')
  const [profiles, setProfiles] = useState(initialProfiles)
  const [sessions, setSessions] = useState(initialSessions)
  const [operations, setOperations] = useState(initialOperations)
  const [confirm, setConfirm] = useState<{ type: 'user' | 'session' | 'operation'; id: string } | null>(null)

  async function handleRoleChange(userId: string, newRole: 'user' | 'admin') {
    const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', userId)
    if (!error) setProfiles((prev) => prev.map((p) => p.id === userId ? { ...p, role: newRole } : p))
  }

  async function handleDeleteUser(userId: string) {
    setConfirm(null)
    const { error } = await supabase.from('profiles').delete().eq('id', userId)
    if (!error) setProfiles((prev) => prev.filter((p) => p.id !== userId))
  }

  async function handleDeleteSession(sessionId: string) {
    setConfirm(null)
    const { error } = await supabase.from('tryout_sessions').delete().eq('id', sessionId)
    if (!error) {
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
      setOperations((prev) => prev.filter((o) => o.session_id !== sessionId))
    }
  }

  async function handleDeleteOperation(opId: string) {
    setConfirm(null)
    const { error } = await supabase.from('operations').delete().eq('id', opId)
    if (!error) setOperations((prev) => prev.filter((o) => o.id !== opId))
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'users', label: 'Users', count: profiles.length },
    { key: 'sessions', label: 'Sessions', count: sessions.length },
    { key: 'operations', label: 'Operations', count: operations.length },
  ]

  return (
    <main className="page-narrow">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Admin</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Manage users, sessions, and operations</p>
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex',
        gap: 4,
        marginBottom: 20,
        background: '#eef0f3',
        padding: 4,
        borderRadius: 10,
        width: 'fit-content',
      }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '7px 16px',
              borderRadius: 7,
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
              transition: 'background 0.12s, box-shadow 0.12s',
              background: tab === t.key ? 'var(--surface)' : 'transparent',
              color: tab === t.key ? 'var(--text)' : 'var(--text-muted)',
              boxShadow: tab === t.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {t.label}
            <span style={{
              fontSize: 11,
              fontWeight: 700,
              padding: '1px 6px',
              borderRadius: 20,
              background: tab === t.key ? 'var(--blue-light)' : '#e0e2e6',
              color: tab === t.key ? 'var(--blue)' : 'var(--text-muted)',
            }}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Users */}
      {tab === 'users' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Joined</th>
                <th>Role</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((profile) => (
                <tr key={profile.id}>
                  <td className="primary">{profile.full_name ?? <em style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No name</em>}</td>
                  <td>{formatDate(profile.created_at)}</td>
                  <td>
                    <select
                      value={profile.role}
                      onChange={(e) => handleRoleChange(profile.id, e.target.value as 'user' | 'admin')}
                      style={{
                        fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                        border: '1.5px solid var(--border)', borderRadius: 6,
                        padding: '4px 8px', background: 'var(--surface)',
                        color: 'var(--text-mid)', cursor: 'pointer',
                        outline: 'none',
                      }}
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td className="right">
                    <button
                      onClick={() => setConfirm({ type: 'user', id: profile.id })}
                      style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                    >
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

      {/* Sessions */}
      {tab === 'sessions' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Chassis #</th>
                <th>Created By</th>
                <th>Date</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.chassis_number}</td>
                  <td>{s.profiles?.full_name ?? <em style={{ color: 'var(--text-muted)' }}>Unknown</em>}</td>
                  <td>{formatDate(s.created_at)}</td>
                  <td className="right">
                    <button
                      onClick={() => setConfirm({ type: 'session', id: s.id })}
                      style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sessions.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '28px 0' }}>No sessions found</p>}
        </div>
      )}

      {/* Operations */}
      {tab === 'operations' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Operation</th>
                <th>Operator</th>
                <th>Stage</th>
                <th className="right">Minutes</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((op) => (
                <tr key={op.id}>
                  <td className="primary">{op.operation_name}</td>
                  <td>{op.operator_name}</td>
                  <td>{op.stage}</td>
                  <td className="right" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: op.total_minutes !== null ? 'var(--blue)' : 'var(--text-muted)' }}>
                    {op.total_minutes !== null ? op.total_minutes.toFixed(1) : '—'}
                  </td>
                  <td className="right">
                    <button
                      onClick={() => setConfirm({ type: 'operation', id: op.id })}
                      style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {operations.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '28px 0' }}>No operations found</p>}
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={`Delete ${confirm.type === 'user' ? 'User' : confirm.type === 'session' ? 'Session' : 'Operation'}`}
          message={
            confirm.type === 'session'
              ? 'This will permanently delete the session and all its operations. This cannot be undone.'
              : 'This will permanently delete this record. This cannot be undone.'
          }
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            if (confirm.type === 'user') handleDeleteUser(confirm.id)
            else if (confirm.type === 'session') handleDeleteSession(confirm.id)
            else handleDeleteOperation(confirm.id)
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </main>
  )
}
