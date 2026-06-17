'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'
import type { Operation, TryoutSession } from '@/lib/types'

interface Props {
  session: TryoutSession
  initialOperations: Operation[]
  userId: string
}

interface TimerState {
  running: boolean
  pausedAt: number | null
  accumulatedPause: number
}

export default function SessionClient({ session, initialOperations, userId }: Props) {
  const supabase = createClient()
  const [operations, setOperations] = useState<Operation[]>(initialOperations)
  const [timers, setTimers] = useState<Record<string, number>>({})
  const [timerStates, setTimerStates] = useState<Record<string, TimerState>>({})
  const [showAddModal, setShowAddModal] = useState(false)
  const [confirmCompleteId, setConfirmCompleteId] = useState<string | null>(null)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [addForm, setAddForm] = useState({ operator_name: '', stage: '', operation_name: '' })
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)

  // Tick all running timers every second
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setTimers((prev) => {
        const next = { ...prev }
        Object.keys(timerStates).forEach((id) => {
          const state = timerStates[id]
          if (state.running && !state.pausedAt) {
            next[id] = (next[id] ?? 0) + 1
          }
        })
        return next
      })
    }, 1000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [timerStates])

  // Initialise timers from DB state on mount
  useEffect(() => {
    const states: Record<string, TimerState> = {}
    const ticks: Record<string, number> = {}

    operations.forEach((op) => {
      if (op.started_at && !op.completed_at) {
        const elapsed = Math.floor(
          (Date.now() - new Date(op.started_at).getTime()) / 1000
        ) - op.paused_duration_seconds
        ticks[op.id] = Math.max(0, elapsed)
        states[op.id] = { running: true, pausedAt: null, accumulatedPause: op.paused_duration_seconds }
      }
    })

    setTimerStates(states)
    setTimers(ticks)
  }, [])

  function formatTimer(seconds: number) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0')
    const s = (seconds % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  function getStatus(op: Operation): 'idle' | 'running' | 'paused' | 'complete' {
    if (op.completed_at) return 'complete'
    if (!op.started_at) return 'idle'
    const state = timerStates[op.id]
    if (state?.pausedAt) return 'paused'
    if (state?.running) return 'running'
    return 'idle'
  }

  async function handleStart(op: Operation) {
    const now = new Date().toISOString()
    const { error } = await supabase
      .from('operations')
      .update({ started_at: now })
      .eq('id', op.id)

    if (error) return

    setOperations((prev) => prev.map((o) => o.id === op.id ? { ...o, started_at: now } : o))
    setTimers((prev) => ({ ...prev, [op.id]: 0 }))
    setTimerStates((prev) => ({
      ...prev,
      [op.id]: { running: true, pausedAt: null, accumulatedPause: 0 },
    }))
  }

  async function handlePause(op: Operation) {
    const state = timerStates[op.id]
    if (!state) return

    if (state.pausedAt) {
      // Resume
      const pauseDuration = Math.floor((Date.now() - state.pausedAt) / 1000)
      const newAccumulated = state.accumulatedPause + pauseDuration

      await supabase
        .from('operations')
        .update({ paused_duration_seconds: newAccumulated })
        .eq('id', op.id)

      setTimerStates((prev) => ({
        ...prev,
        [op.id]: { running: true, pausedAt: null, accumulatedPause: newAccumulated },
      }))
    } else {
      // Pause
      setTimerStates((prev) => ({
        ...prev,
        [op.id]: { ...state, pausedAt: Date.now() },
      }))
    }
  }

  async function handleComplete(opId: string) {
    setConfirmCompleteId(null)
    const op = operations.find((o) => o.id === opId)
    if (!op) return

    const state = timerStates[opId]
    let finalPause = state?.accumulatedPause ?? op.paused_duration_seconds

    // If currently paused, add current pause segment
    if (state?.pausedAt) {
      finalPause += Math.floor((Date.now() - state.pausedAt) / 1000)
    }

    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('operations')
      .update({ completed_at: now, paused_duration_seconds: finalPause })
      .eq('id', opId)
      .select('*')
      .single()

    if (error) return

    setOperations((prev) => prev.map((o) => o.id === opId ? data : o))
    setTimerStates((prev) => {
      const next = { ...prev }
      delete next[opId]
      return next
    })
    setTimers((prev) => {
      const next = { ...prev }
      delete next[opId]
      return next
    })
  }

  async function handleSaveNote(opId: string) {
    await supabase
      .from('operations')
      .update({ notes: noteText.trim() || null })
      .eq('id', opId)

    setOperations((prev) =>
      prev.map((o) => o.id === opId ? { ...o, notes: noteText.trim() || null } : o)
    )
    setEditingNoteId(null)
  }

  async function handleAddOperation(e: React.FormEvent) {
    e.preventDefault()
    if (!addForm.operator_name.trim() || !addForm.stage.trim() || !addForm.operation_name.trim()) return
    setAdding(true)
    setAddError(null)

    const { data, error } = await supabase
      .from('operations')
      .insert({
        session_id: session.id,
        operator_name: addForm.operator_name.trim(),
        stage: addForm.stage.trim(),
        operation_name: addForm.operation_name.trim(),
        created_by: userId,
      })
      .select('*')
      .single()

    if (error) {
      setAddError(error.message)
      setAdding(false)
      return
    }

    setOperations((prev) => [...prev, data])
    setShowAddModal(false)
    setAddForm({ operator_name: '', stage: '', operation_name: '' })
    setAdding(false)
  }

  const statusBadge = {
    idle: <span className="text-xs font-medium text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Not started</span>,
    running: (
      <span className="relative inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
        <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
        Running
      </span>
    ),
    paused: <span className="text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">Paused</span>,
    complete: <span className="text-xs font-medium text-[#0079c1] bg-blue-50 px-2 py-0.5 rounded-full">Complete</span>,
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-6">
      {/* Back + header */}
      <div className="mb-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-3 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          All Sessions
        </Link>
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-gray-900 font-mono">{session.chassis_number}</h1>
            </div>
            <p className="text-sm text-gray-500 mt-0.5">
              Started {formatDate(session.created_at)} · {operations.length} operation{operations.length !== 1 ? 's' : ''}
            </p>
            {session.notes && <p className="text-sm text-gray-400 mt-1 italic">{session.notes}</p>}
          </div>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 bg-[#0079c1] hover:bg-[#0068a8] text-white font-semibold px-4 py-2.5 rounded-lg transition-colors text-sm shadow-sm"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add Operation
          </button>
        </div>
      </div>

      {/* Operations list */}
      {operations.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <svg className="mx-auto mb-4 opacity-30" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="13" r="8" /><polyline points="12 9 12 13 14.5 15.5" /><path d="M9 3h6" /><path d="M12 3v2" />
          </svg>
          <p className="font-medium">No operations yet</p>
          <p className="text-sm mt-1">Add the first operation to start timing</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {operations.map((op) => {
            const status = getStatus(op)
            const elapsed = timers[op.id] ?? 0

            return (
              <div
                key={op.id}
                className={`bg-white rounded-xl border shadow-sm p-4 transition-all ${
                  status === 'running'
                    ? 'border-green-200 shadow-green-50'
                    : status === 'paused'
                    ? 'border-amber-200'
                    : status === 'complete'
                    ? 'border-blue-100'
                    : 'border-gray-100'
                }`}
              >
                {/* Top row */}
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {statusBadge[status]}
                      <span className="text-xs text-gray-400 bg-gray-50 px-2 py-0.5 rounded-full border border-gray-100">
                        {op.stage}
                      </span>
                    </div>
                    <h3 className="font-semibold text-gray-900 mt-2 text-base leading-tight">{op.operation_name}</h3>
                    <p className="text-sm text-gray-500 mt-0.5">{op.operator_name}</p>
                  </div>

                  {/* Timer display */}
                  {(status === 'running' || status === 'paused') && (
                    <div className={`text-3xl font-mono font-bold tabular-nums ${
                      status === 'running' ? 'text-green-600' : 'text-amber-500'
                    }`}>
                      {formatTimer(elapsed)}
                    </div>
                  )}
                  {status === 'complete' && op.total_minutes !== null && (
                    <div className="text-right">
                      <div className="text-2xl font-bold text-[#0079c1] tabular-nums">
                        {op.total_minutes.toFixed(1)}
                      </div>
                      <div className="text-xs text-gray-400">min</div>
                    </div>
                  )}
                </div>

                {/* Action buttons */}
                {status === 'idle' && (
                  <button
                    onClick={() => handleStart(op)}
                    className="mt-3 w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 rounded-lg transition-colors text-base tracking-wide"
                  >
                    ▶ START
                  </button>
                )}

                {(status === 'running' || status === 'paused') && (
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => handlePause(op)}
                      className={`flex-1 font-semibold py-2.5 rounded-lg transition-colors text-sm ${
                        status === 'paused'
                          ? 'bg-green-500 hover:bg-green-600 text-white'
                          : 'bg-amber-100 hover:bg-amber-200 text-amber-700'
                      }`}
                    >
                      {status === 'paused' ? '▶ Resume' : '⏸ Pause'}
                    </button>
                    <button
                      onClick={() => setConfirmCompleteId(op.id)}
                      className="flex-1 font-semibold py-2.5 rounded-lg bg-[#0079c1] hover:bg-[#0068a8] text-white transition-colors text-sm"
                    >
                      ✓ Complete
                    </button>
                  </div>
                )}

                {/* Notes */}
                <div className="mt-3 pt-3 border-t border-gray-50">
                  {editingNoteId === op.id ? (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveNote(op.id)
                          if (e.key === 'Escape') setEditingNoteId(null)
                        }}
                        className="flex-1 text-sm px-3 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0079c1]/30 focus:border-[#0079c1]"
                        placeholder="Add a note…"
                      />
                      <button
                        onClick={() => handleSaveNote(op.id)}
                        className="text-xs text-white bg-[#0079c1] hover:bg-[#0068a8] px-3 py-1.5 rounded-lg font-medium"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingNoteId(null)}
                        className="text-xs text-gray-500 bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setEditingNoteId(op.id); setNoteText(op.notes ?? '') }}
                      className="text-sm text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1.5"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                      </svg>
                      {op.notes ? op.notes : 'Add note'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Add Operation Modal */}
      {showAddModal && (
        <Modal title="Add Operation" onClose={() => { setShowAddModal(false); setAddError(null) }}>
          <form onSubmit={handleAddOperation} className="flex flex-col gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Operator Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={addForm.operator_name}
                onChange={(e) => setAddForm((f) => ({ ...f, operator_name: e.target.value }))}
                required
                autoFocus
                className="w-full px-3.5 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#0079c1]/30 focus:border-[#0079c1]"
                placeholder="e.g. John Smith"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Stage / Work Centre <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={addForm.stage}
                onChange={(e) => setAddForm((f) => ({ ...f, stage: e.target.value }))}
                required
                className="w-full px-3.5 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#0079c1]/30 focus:border-[#0079c1]"
                placeholder="e.g. Body Electrical"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Operation Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={addForm.operation_name}
                onChange={(e) => setAddForm((f) => ({ ...f, operation_name: e.target.value }))}
                required
                className="w-full px-3.5 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#0079c1]/30 focus:border-[#0079c1]"
                placeholder="e.g. Wiring harness check"
              />
            </div>
            {addError && (
              <div className="bg-red-50 border border-red-100 text-red-600 text-sm rounded-lg px-3.5 py-2.5">{addError}</div>
            )}
            <button
              type="submit"
              disabled={adding}
              className="w-full mt-1 bg-green-500 hover:bg-green-600 disabled:opacity-60 text-white font-bold py-3 rounded-lg transition-colors text-base tracking-wide"
            >
              {adding ? 'Adding…' : '▶ START'}
            </button>
          </form>
        </Modal>
      )}

      {/* Complete confirm */}
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
