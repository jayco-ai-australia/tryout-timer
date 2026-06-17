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
    const { error } = await supabase
      .from('profiles')
      .update({ role: newRole })
      .eq('id', userId)
    if (!error) {
      setProfiles((prev) => prev.map((p) => p.id === userId ? { ...p, role: newRole } : p))
    }
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
    <main className="max-w-5xl mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Admin</h1>
        <p className="text-sm text-gray-500 mt-0.5">Manage users, sessions, and operations</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-lg w-fit">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === t.key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
            <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
              tab === t.key ? 'bg-[#0079c1]/10 text-[#0079c1]' : 'bg-gray-200 text-gray-500'
            }`}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Users */}
      {tab === 'users' && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-5 py-3 font-medium">Name</th>
                <th className="text-left px-5 py-3 font-medium">Joined</th>
                <th className="text-left px-5 py-3 font-medium">Role</th>
                <th className="text-right px-5 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {profiles.map((profile) => (
                <tr key={profile.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3 font-medium text-gray-900">
                    {profile.full_name ?? <span className="text-gray-400 italic">No name</span>}
                  </td>
                  <td className="px-5 py-3 text-gray-500">{formatDate(profile.created_at)}</td>
                  <td className="px-5 py-3">
                    <select
                      value={profile.role}
                      onChange={(e) => handleRoleChange(profile.id, e.target.value as 'user' | 'admin')}
                      className="text-xs border border-gray-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-[#0079c1]/30 focus:border-[#0079c1]"
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => setConfirm({ type: 'user', id: profile.id })}
                      className="text-xs text-red-500 hover:text-red-700 font-medium transition-colors"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {profiles.length === 0 && (
            <p className="text-center text-gray-400 py-8 text-sm">No users found</p>
          )}
        </div>
      )}

      {/* Sessions */}
      {tab === 'sessions' && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-5 py-3 font-medium">Chassis #</th>
                <th className="text-left px-5 py-3 font-medium">Created By</th>
                <th className="text-left px-5 py-3 font-medium">Date</th>
                <th className="text-right px-5 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sessions.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3 font-mono font-semibold text-gray-900">{s.chassis_number}</td>
                  <td className="px-5 py-3 text-gray-500">
                    {s.profiles?.full_name ?? <span className="italic">Unknown</span>}
                  </td>
                  <td className="px-5 py-3 text-gray-500">{formatDate(s.created_at)}</td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => setConfirm({ type: 'session', id: s.id })}
                      className="text-xs text-red-500 hover:text-red-700 font-medium transition-colors"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sessions.length === 0 && (
            <p className="text-center text-gray-400 py-8 text-sm">No sessions found</p>
          )}
        </div>
      )}

      {/* Operations */}
      {tab === 'operations' && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-5 py-3 font-medium">Operation</th>
                <th className="text-left px-5 py-3 font-medium">Operator</th>
                <th className="text-left px-5 py-3 font-medium">Stage</th>
                <th className="text-right px-5 py-3 font-medium">Minutes</th>
                <th className="text-right px-5 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {operations.map((op) => (
                <tr key={op.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3 font-medium text-gray-900">{op.operation_name}</td>
                  <td className="px-5 py-3 text-gray-500">{op.operator_name}</td>
                  <td className="px-5 py-3 text-gray-500">{op.stage}</td>
                  <td className="px-5 py-3 text-right text-gray-700 tabular-nums">
                    {op.total_minutes !== null ? op.total_minutes.toFixed(1) : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => setConfirm({ type: 'operation', id: op.id })}
                      className="text-xs text-red-500 hover:text-red-700 font-medium transition-colors"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {operations.length === 0 && (
            <p className="text-center text-gray-400 py-8 text-sm">No operations found</p>
          )}
        </div>
      )}

      {/* Confirm dialog */}
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
