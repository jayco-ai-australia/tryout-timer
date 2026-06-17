'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import Modal from '@/components/Modal'
import type { TryoutSession } from '@/lib/types'

interface Props {
  sessions: TryoutSession[]
  userId: string
}

export default function DashboardClient({ sessions: initial, userId }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const [sessions, setSessions] = useState(initial)
  const [showModal, setShowModal] = useState(false)
  const [chassisNum, setChassisNum] = useState('')
  const [notes, setNotes] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!chassisNum.trim()) return
    setCreating(true)
    setError(null)

    const { data, error: err } = await supabase
      .from('tryout_sessions')
      .insert({ chassis_number: chassisNum.trim(), notes: notes.trim() || null, created_by: userId })
      .select(`id, chassis_number, created_by, created_at, notes, profiles:created_by ( full_name )`)
      .single()

    if (err) {
      setError(err.message)
      setCreating(false)
      return
    }

    const profiles = Array.isArray(data.profiles) ? data.profiles[0] ?? null : data.profiles
    setSessions([{ ...data, profiles, operation_count: 0 }, ...sessions])
    setShowModal(false)
    setChassisNum('')
    setNotes('')
    setCreating(false)
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-AU', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
  }

  return (
    <main className="max-w-6xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sessions</h1>
          <p className="text-sm text-gray-500 mt-0.5">{sessions.length} tryout session{sessions.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 bg-[#0079c1] hover:bg-[#0068a8] text-white font-semibold px-4 py-2.5 rounded-lg transition-colors text-sm shadow-sm"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New Session
        </button>
      </div>

      {/* Grid */}
      {sessions.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <svg className="mx-auto mb-4 opacity-30" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="13" r="8" /><polyline points="12 9 12 13 14.5 15.5" /><path d="M9 3h6" /><path d="M12 3v2" />
          </svg>
          <p className="font-medium">No sessions yet</p>
          <p className="text-sm mt-1">Create your first tryout session</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => router.push(`/session/${session.id}`)}
              className="text-left bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md hover:border-[#0079c1]/30 transition-all p-4 group"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="bg-[#0079c1]/10 text-[#0079c1] text-xs font-bold px-2.5 py-1 rounded-md uppercase tracking-wide">
                  {session.chassis_number}
                </div>
                <svg className="text-gray-300 group-hover:text-[#0079c1] transition-colors mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-sm text-gray-500">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
                  </svg>
                  {formatDate(session.created_at)}
                </div>
                <div className="flex items-center gap-1.5 text-sm text-gray-500">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
                  </svg>
                  {(session.profiles as { full_name?: string })?.full_name ?? 'Unknown'}
                </div>
                <div className="flex items-center gap-1.5 text-sm text-gray-500">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="13" r="8" /><polyline points="12 9 12 13 14.5 15.5" /><path d="M9 3h6" /><path d="M12 3v2" />
                  </svg>
                  {session.operation_count} operation{session.operation_count !== 1 ? 's' : ''}
                </div>
              </div>
              {session.notes && (
                <p className="mt-3 text-xs text-gray-400 line-clamp-2 border-t border-gray-50 pt-2">{session.notes}</p>
              )}
            </button>
          ))}
        </div>
      )}

      {/* New Session Modal */}
      {showModal && (
        <Modal title="New Tryout Session" onClose={() => { setShowModal(false); setChassisNum(''); setNotes(''); setError(null) }}>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Chassis Number <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={chassisNum}
                onChange={(e) => setChassisNum(e.target.value)}
                required
                autoFocus
                className="w-full px-3.5 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#0079c1]/30 focus:border-[#0079c1] transition-colors font-mono uppercase"
                placeholder="e.g. JD24-001"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Notes <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full px-3.5 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#0079c1]/30 focus:border-[#0079c1] transition-colors resize-none"
                placeholder="Any additional notes…"
              />
            </div>
            {error && (
              <div className="bg-red-50 border border-red-100 text-red-600 text-sm rounded-lg px-3.5 py-2.5">{error}</div>
            )}
            <div className="flex gap-3 justify-end pt-1">
              <button
                type="button"
                onClick={() => { setShowModal(false); setChassisNum(''); setNotes(''); setError(null) }}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating}
                className="px-4 py-2 text-sm font-medium text-white bg-[#0079c1] hover:bg-[#0068a8] disabled:opacity-60 rounded-lg transition-colors"
              >
                {creating ? 'Creating…' : 'Create Session'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  )
}
