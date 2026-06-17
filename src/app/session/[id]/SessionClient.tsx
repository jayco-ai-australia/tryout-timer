'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'
import type { Operation, TryoutSession, Note } from '@/lib/types'

interface Props {
  session: TryoutSession
  initialOperations: Operation[]
  initialNotes: Record<string, Note[]>
  userId: string
  userFullName: string | null
}

interface TimerState {
  running: boolean
  pausedAt: number | null
  accumulatedPause: number
}

type Status = 'idle' | 'running' | 'paused' | 'complete'

export default function SessionClient({ session, initialOperations, initialNotes, userId, userFullName }: Props) {
  const supabase = createClient()
  const [operations, setOperations] = useState<Operation[]>(initialOperations)
  const [notes, setNotes] = useState<Record<string, Note[]>>(initialNotes)
  const [newNoteText, setNewNoteText] = useState<Record<string, string>>({})
  const [addingNote, setAddingNote] = useState<Record<string, boolean>>({})
  const [timers, setTimers] = useState<Record<string, number>>({})
  const [timerStates, setTimerStates] = useState<Record<string, TimerState>>({})
  const [showAddModal, setShowAddModal] = useState(false)
  const [confirmCompleteId, setConfirmCompleteId] = useState<string | null>(null)
  const [addForm, setAddForm] = useState({ operator_name: '', stage: '', operation_name: '' })
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setTimers((prev) => {
        const next = { ...prev }
        Object.keys(timerStates).forEach((id) => {
          const state = timerStates[id]
          if (state.running && !state.pausedAt) next[id] = (next[id] ?? 0) + 1
        })
        return next
      })
    }, 1000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [timerStates])

  useEffect(() => {
    const states: Record<string, TimerState> = {}
    const ticks: Record<string, number> = {}
    operations.forEach((op) => {
      if (op.started_at && !op.completed_at) {
        const elapsed = Math.floor((Date.now() - new Date(op.started_at).getTime()) / 1000) - op.paused_duration_seconds
        ticks[op.id] = Math.max(0, elapsed)
        states[op.id] = { running: true, pausedAt: null, accumulatedPause: op.paused_duration_seconds }
      }
    })
    setTimerStates(states)
    setTimers(ticks)
  }, [])

  function fmt(seconds: number) {
    return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  function formatNoteTime(iso: string) {
    return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  }

  function getStatus(op: Operation): Status {
    if (op.completed_at) return 'complete'
    if (!op.started_at) return 'idle'
    const state = timerStates[op.id]
    if (state?.pausedAt) return 'paused'
    if (state?.running) return 'running'
    return 'idle'
  }

  async function handleStart(op: Operation) {
    const now = new Date().toISOString()
    const { error } = await supabase.from('operations').update({ started_at: now }).eq('id', op.id)
    if (error) return
    setOperations((prev) => prev.map((o) => o.id === op.id ? { ...o, started_at: now } : o))
    setTimers((prev) => ({ ...prev, [op.id]: 0 }))
    setTimerStates((prev) => ({ ...prev, [op.id]: { running: true, pausedAt: null, accumulatedPause: 0 } }))
  }

  async function handlePause(op: Operation) {
    const state = timerStates[op.id]
    if (!state) return
    if (state.pausedAt) {
      const pauseDuration = Math.floor((Date.now() - state.pausedAt) / 1000)
      const newAccumulated = state.accumulatedPause + pauseDuration
      await supabase.from('operations').update({ paused_duration_seconds: newAccumulated }).eq('id', op.id)
      setTimerStates((prev) => ({ ...prev, [op.id]: { running: true, pausedAt: null, accumulatedPause: newAccumulated } }))
    } else {
      setTimerStates((prev) => ({ ...prev, [op.id]: { ...state, pausedAt: Date.now() } }))
    }
  }

  async function handleComplete(opId: string) {
    setConfirmCompleteId(null)
    const op = operations.find((o) => o.id === opId)
    if (!op) return
    const state = timerStates[opId]
    let finalPause = state?.accumulatedPause ?? op.paused_duration_seconds
    if (state?.pausedAt) finalPause += Math.floor((Date.now() - state.pausedAt) / 1000)
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('operations').update({ completed_at: now, paused_duration_seconds: finalPause })
      .eq('id', opId).select('*').single()
    if (error) return
    setOperations((prev) => prev.map((o) => o.id === opId ? data : o))
    setTimerStates((prev) => { const n = { ...prev }; delete n[opId]; return n })
    setTimers((prev) => { const n = { ...prev }; delete n[opId]; return n })
  }

  async function handleAddNote(opId: string) {
    const content = (newNoteText[opId] ?? '').trim()
    if (!content) return
    setAddingNote((prev) => ({ ...prev, [opId]: true }))
    const { data, error } = await supabase
      .from('notes').insert({ operation_id: opId, content, created_by: userId })
      .select('id, operation_id, content, created_by, created_at').single()
    if (error) { setAddingNote((prev) => ({ ...prev, [opId]: false })); return }
    const newNote: Note = { ...data, profiles: { full_name: userFullName } }
    setNotes((prev) => ({ ...prev, [opId]: [...(prev[opId] ?? []), newNote] }))
    setNewNoteText((prev) => ({ ...prev, [opId]: '' }))
    setAddingNote((prev) => ({ ...prev, [opId]: false }))
  }

  async function handleAddOperation(e: React.FormEvent) {
    e.preventDefault()
    if (!addForm.operator_name.trim() || !addForm.stage.trim() || !addForm.operation_name.trim()) return
    setAdding(true); setAddError(null)
    const { data, error } = await supabase
      .from('operations')
      .insert({ session_id: session.id, operator_name: addForm.operator_name.trim(), stage: addForm.stage.trim(), operation_name: addForm.operation_name.trim(), created_by: userId })
      .select('*').single()
    if (error) { setAddError(error.message); setAdding(false); return }
    setOperations((prev) => [...prev, data])
    setShowAddModal(false)
    setAddForm({ operator_name: '', stage: '', operation_name: '' })
    setAdding(false)
  }

  const statusConfig: Record<Status, { label: string; bg: string; color: string; border: string }> = {
    idle:     { label: 'Not started', bg: '#f4f4f4',         color: '#888',            border: 'var(--border)' },
    running:  { label: 'Running',     bg: 'var(--green-bg)', color: '#15803d',         border: '#86efac' },
    paused:   { label: 'Paused',      bg: 'var(--amber-bg)', color: '#92400e',         border: '#fcd34d' },
    complete: { label: 'Complete',    bg: 'var(--blue-light)', color: 'var(--blue)',   border: '#93c5fd' },
  }

  return (
    <main className="page-narrow">
      {/* Back + header */}
      <div style={{ marginBottom: 24 }}>
        <Link href="/dashboard" style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontSize: 13, fontWeight: 500, color: 'var(--text-muted)',
          textDecoration: 'none', marginBottom: 12,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          All Sessions
        </Link>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0, fontFamily: 'ui-monospace, monospace' }}>
              {session.chassis_number}
            </h1>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 5 }}>
              Started {formatDate(session.created_at)} · {operations.length} operation{operations.length !== 1 ? 's' : ''}
            </p>
            {session.notes && (
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>{session.notes}</p>
            )}
          </div>
          <button className="btn-primary" onClick={() => setShowAddModal(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add Operation
          </button>
        </div>
      </div>

      {/* Operations */}
      {operations.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-muted)' }}>
          <svg style={{ display: 'block', margin: '0 auto 12px', opacity: 0.25 }} width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="13" r="8" /><polyline points="12 9 12 13 14.5 15.5" /><path d="M9 3h6" /><path d="M12 3v2" />
          </svg>
          <p style={{ fontWeight: 600, marginBottom: 4 }}>No operations yet</p>
          <p style={{ fontSize: 13 }}>Add the first operation to start timing</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {operations.map((op) => {
            const status = getStatus(op)
            const cfg = statusConfig[status]
            const elapsed = timers[op.id] ?? 0
            const opNotes = notes[op.id] ?? []

            return (
              <div key={op.id} style={{
                background: 'var(--surface)',
                border: `1.5px solid ${cfg.border}`,
                borderRadius: 12,
                boxShadow: status === 'running' ? '0 2px 12px rgba(34,163,90,0.10)' : '0 1px 4px rgba(0,0,0,0.06)',
                overflow: 'hidden',
              }}>
                {/* Status bar */}
                <div style={{ background: cfg.bg, borderBottom: `1px solid ${cfg.border}`, padding: '7px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    {status === 'running' && <span className="live-dot" />}
                    <span style={{ fontSize: 11, fontWeight: 700, color: cfg.color, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      {cfg.label}
                    </span>
                    <span style={{
                      fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
                      background: 'rgba(0,0,0,0.05)', padding: '2px 7px', borderRadius: 4,
                    }}>
                      {op.stage}
                    </span>
                  </div>

                  {/* Timer / total */}
                  {(status === 'running' || status === 'paused') && (
                    <span style={{
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: 22, fontWeight: 700,
                      color: status === 'running' ? 'var(--green)' : 'var(--amber)',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {fmt(elapsed)}
                    </span>
                  )}
                  {status === 'complete' && op.total_minutes !== null && (
                    <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--blue)' }}>
                      {op.total_minutes.toFixed(1)} <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-muted)' }}>min</span>
                    </span>
                  )}
                </div>

                {/* Body */}
                <div style={{ padding: '14px 18px' }}>
                  <div style={{ marginBottom: status === 'idle' ? 14 : 12 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{op.operation_name}</div>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3 }}>{op.operator_name}</div>
                  </div>

                  {/* Action buttons */}
                  {status === 'idle' && (
                    <button
                      onClick={() => handleStart(op)}
                      style={{
                        width: '100%', padding: '13px', border: 'none', borderRadius: 9,
                        background: 'var(--green)', color: '#fff',
                        fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                        letterSpacing: '0.02em',
                      }}
                    >
                      ▶ START
                    </button>
                  )}

                  {(status === 'running' || status === 'paused') && (
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button
                        onClick={() => handlePause(op)}
                        style={{
                          flex: 1, padding: '11px', borderRadius: 9,
                          border: status === 'paused' ? 'none' : '1.5px solid #fcd34d',
                          background: status === 'paused' ? 'var(--green)' : 'var(--amber-bg)',
                          color: status === 'paused' ? '#fff' : 'var(--amber)',
                          fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        {status === 'paused' ? '▶ Resume' : '⏸ Pause'}
                      </button>
                      <button
                        onClick={() => setConfirmCompleteId(op.id)}
                        style={{
                          flex: 1, padding: '11px', border: 'none', borderRadius: 9,
                          background: 'var(--blue)', color: '#fff',
                          fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        ✓ Complete
                      </button>
                    </div>
                  )}

                  {/* Notes */}
                  <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 10 }}>
                      Notes {opNotes.length > 0 && `(${opNotes.length})`}
                    </div>

                    {opNotes.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                        {opNotes.map((note) => (
                          <div key={note.id} style={{
                            background: 'var(--bg)',
                            border: '1px solid var(--border)',
                            borderRadius: 8,
                            padding: '9px 12px',
                          }}>
                            <p style={{ fontSize: 13, color: 'var(--text)', margin: 0, lineHeight: 1.5 }}>{note.content}</p>
                            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5, marginBottom: 0 }}>
                              {note.profiles?.full_name ?? 'Unknown'} · {formatNoteTime(note.created_at)}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        className="input"
                        type="text"
                        value={newNoteText[op.id] ?? ''}
                        onChange={(e) => setNewNoteText((prev) => ({ ...prev, [op.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleAddNote(op.id) }}
                        placeholder="Add a note…"
                        style={{ flex: 1, padding: '8px 12px', fontSize: 13 }}
                      />
                      <button
                        onClick={() => handleAddNote(op.id)}
                        disabled={addingNote[op.id] || !(newNoteText[op.id] ?? '').trim()}
                        style={{
                          padding: '8px 14px', borderRadius: 8, border: 'none',
                          background: 'var(--blue)', color: '#fff',
                          fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                          opacity: addingNote[op.id] || !(newNoteText[op.id] ?? '').trim() ? 0.45 : 1,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {addingNote[op.id] ? '…' : 'Add Note'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Add Operation Modal */}
      {showAddModal && (
        <Modal title="Add Operation" onClose={() => { setShowAddModal(false); setAddError(null) }}>
          <form onSubmit={handleAddOperation} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label className="label">Operator Name <span style={{ color: 'var(--red)' }}>*</span></label>
              <input className="input" type="text" value={addForm.operator_name}
                onChange={(e) => setAddForm((f) => ({ ...f, operator_name: e.target.value }))}
                required autoFocus placeholder="e.g. John Smith" />
            </div>
            <div>
              <label className="label">Stage / Work Centre <span style={{ color: 'var(--red)' }}>*</span></label>
              <input className="input" type="text" value={addForm.stage}
                onChange={(e) => setAddForm((f) => ({ ...f, stage: e.target.value }))}
                required placeholder="e.g. Body Electrical" />
            </div>
            <div>
              <label className="label">Operation Name <span style={{ color: 'var(--red)' }}>*</span></label>
              <input className="input" type="text" value={addForm.operation_name}
                onChange={(e) => setAddForm((f) => ({ ...f, operation_name: e.target.value }))}
                required placeholder="e.g. Wiring harness check" />
            </div>
            {addError && (
              <div style={{ background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13, borderRadius: 8, padding: '10px 14px' }}>
                {addError}
              </div>
            )}
            <button type="submit" disabled={adding} style={{
              width: '100%', marginTop: 4, padding: '13px', border: 'none', borderRadius: 9,
              background: 'var(--green)', color: '#fff',
              fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
              opacity: adding ? 0.6 : 1,
            }}>
              {adding ? 'Adding…' : '▶ START'}
            </button>
          </form>
        </Modal>
      )}

      {confirmCompleteId && (
        <ConfirmDialog
          title="Complete Operation"
          message="Mark this operation as complete? The timer will stop and total time will be recorded."
          confirmLabel="Yes, Complete"
          onConfirm={() => handleComplete(confirmCompleteId)}
          onCancel={() => setConfirmCompleteId(null)}
        />
      )}
    </main>
  )
}
