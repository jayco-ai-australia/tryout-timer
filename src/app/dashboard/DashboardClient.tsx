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

  function closeModal() {
    setShowModal(false); setChassisNum(''); setNotes(''); setError(null)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!chassisNum.trim()) return
    setCreating(true); setError(null)

    const { data, error: err } = await supabase
      .from('tryout_sessions')
      .insert({ chassis_number: chassisNum.trim(), notes: notes.trim() || null, created_by: userId })
      .select('id, chassis_number, created_by, created_at, notes, profiles:created_by ( full_name )')
      .single()

    if (err) { setError(err.message); setCreating(false); return }

    const profiles = Array.isArray(data.profiles) ? data.profiles[0] ?? null : data.profiles
    setSessions([{ ...data, profiles, operation_count: 0 }, ...sessions])
    closeModal()
    setCreating(false)
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  return (
    <main className="page">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Sessions</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
            {sessions.length} tryout session{sessions.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowModal(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New Session
        </button>
      </div>

      {/* Grid */}
      {sessions.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-muted)' }}>
          <svg style={{ display: 'block', margin: '0 auto 12px', opacity: 0.25 }} width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="13" r="8" /><polyline points="12 9 12 13 14.5 15.5" /><path d="M9 3h6" /><path d="M12 3v2" />
          </svg>
          <p style={{ fontWeight: 600, marginBottom: 4 }}>No sessions yet</p>
          <p style={{ fontSize: 13 }}>Create your first tryout session to get started</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => router.push(`/session/${session.id}`)}
              style={{
                textAlign: 'left',
                background: 'var(--surface)',
                border: '1.5px solid var(--border)',
                borderRadius: 12,
                boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
                padding: '16px 18px',
                cursor: 'pointer',
                transition: 'box-shadow 0.15s, border-color 0.15s, transform 0.1s',
                width: '100%',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.10)'
                e.currentTarget.style.borderColor = 'var(--blue)'
                e.currentTarget.style.transform = 'translateY(-1px)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.06)'
                e.currentTarget.style.borderColor = 'var(--border)'
                e.currentTarget.style.transform = 'translateY(0)'
              }}
            >
              {/* Chassis tag + arrow */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={{
                  background: 'var(--blue-light)',
                  color: 'var(--blue)',
                  fontSize: 12,
                  fontWeight: 700,
                  padding: '4px 10px',
                  borderRadius: 6,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  fontFamily: 'ui-monospace, monospace',
                }}>
                  {session.chassis_number}
                </span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </div>

              {/* Meta rows */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Row icon="calendar">
                  <span style={{ fontSize: 13, color: 'var(--text-mid)' }}>{formatDate(session.created_at)}</span>
                </Row>
                <Row icon="user">
                  <span style={{ fontSize: 13, color: 'var(--text-mid)' }}>
                    {(session.profiles as { full_name?: string })?.full_name ?? 'Unknown'}
                  </span>
                </Row>
                <Row icon="timer">
                  <span style={{ fontSize: 13, color: 'var(--text-mid)' }}>
                    {session.operation_count} operation{session.operation_count !== 1 ? 's' : ''}
                  </span>
                </Row>
              </div>

              {session.notes && (
                <p style={{
                  marginTop: 12,
                  paddingTop: 10,
                  borderTop: '1px solid var(--border)',
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  lineHeight: 1.5,
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}>
                  {session.notes}
                </p>
              )}
            </button>
          ))}
        </div>
      )}

      {/* New Session Modal */}
      {showModal && (
        <Modal title="New Tryout Session" onClose={closeModal}>
          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label className="label">Chassis Number <span style={{ color: 'var(--red)' }}>*</span></label>
              <input
                className="input"
                type="text"
                value={chassisNum}
                onChange={(e) => setChassisNum(e.target.value)}
                required
                autoFocus
                placeholder="e.g. JD24-001"
                style={{ textTransform: 'uppercase', fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}
              />
            </div>
            <div>
              <label className="label">Notes <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
              <textarea
                className="input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Any additional notes…"
                style={{ resize: 'none' }}
              />
            </div>
            {error && (
              <div style={{ background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13, borderRadius: 8, padding: '10px 14px' }}>
                {error}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
              <button type="button" className="btn-ghost" onClick={closeModal}>Cancel</button>
              <button type="submit" disabled={creating} className="btn-primary">
                {creating ? 'Creating…' : 'Create Session'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  )
}

function Row({ icon, children }: { icon: 'calendar' | 'user' | 'timer'; children: React.ReactNode }) {
  const icons = {
    calendar: <path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z" />,
    user: <><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
    timer: <><circle cx="12" cy="13" r="8" /><polyline points="12 9 12 13 14.5 15.5" /><path d="M9 3h6" /><path d="M12 3v2" /></>,
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2">
        {icons[icon]}
      </svg>
      {children}
    </div>
  )
}
