'use client'

import { useCallback, useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { addOperationTimeNote, recordOperationTime, type RecordedOperationTime } from './operationTimes'
import { usePersistedState } from './useLocalStorage'

/**
 * The single stopwatch module — every screen that runs a live timer against an operation
 * (/collect's Active Timers, /tryouts' inline per-operation stopwatches and its bottom timer
 * bar) uses the state shape, the pause arithmetic, the localStorage persistence and the save
 * path here, so the two can't drift into slightly different ideas of what "elapsed" means.
 *
 * A timer is deliberately NOT a database row. Nothing is written until it is completed — a
 * running timer lives entirely in localStorage, which is what makes an accidental tablet
 * refresh recoverable (the timers come back mid-run) without leaving half-finished rows behind
 * when somebody simply walks away.
 *
 * Elapsed time is always derived from timestamps (startedAt, and the accumulated pause), never
 * from a counter incremented on a tick: a tab that gets backgrounded, throttled or reloaded
 * stops ticking, and a counter would silently lose exactly that time.
 */

/** The model(s) a run is being timed against — one operation_time can be linked to several. */
export interface TimerModelRef { productId: string; productCode: string; model: string }

export interface ActiveTimer {
  timerId: string
  operationId: string
  operationName: string
  jobName: string
  /** Every product the completed run is linked to via operation_time_models. */
  productIds: string[]
  models: TimerModelRef[]
  /**
   * Who is being timed — nullable, because /tryouts asks for it only at completion (and lets
   * it be left blank), while /collect settles it before the timer ever starts. A null here
   * carries all the way through to recordOperationTime, which resolves it to the shared
   * placeholder operator (operation_times.operator_id is NOT NULL in the database).
   */
  operatorId: string | null
  operatorName: string | null
  /**
   * Notes collected DURING the run, in the order they were written — the note typed when the
   * timer was started, then any added live while it was going. They are held here, on the
   * timer, and nowhere else until the run is completed: operation_time_notes rows can't exist
   * before the operation_times row they hang off, so there is nothing to write to yet.
   *
   * Because they live on the timer they ride along with everything else it owns — they are
   * persisted to localStorage with it (so a mid-run refresh doesn't lose them), they stay
   * attached to the right timer when several run at once (the array is per-timer, never a
   * screen-level list keyed by anything), and they are thrown away with the timer if the run
   * is discarded, which is correct: nothing was recorded, so there is nothing to annotate.
   *
   * Optional so a timer already sitting in localStorage from before this field existed still
   * parses; read it as `timer.notes ?? []`.
   */
  notes?: string[]
  chassisId: string | null
  chassisNumber: string | null
  startedAt: string
  /** Accumulated paused seconds, not counting an in-progress pause. */
  pausedSeconds: number
  isPaused: boolean
  /** Set while isPaused — when the current pause began. */
  pausedAt: string | null
}

/** Everything a caller supplies to start a timer; the clock fields are stamped here. */
export type NewTimerInput = Omit<ActiveTimer, 'timerId' | 'startedAt' | 'pausedSeconds' | 'isPaused' | 'pausedAt'>

export function genId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Total paused seconds INCLUDING an in-progress pause — so a paused timer's display freezes
 * instead of drifting on while nobody is working. */
export function pausedSecondsNow(timer: ActiveTimer, nowMs: number): number {
  if (timer.isPaused && timer.pausedAt) {
    return timer.pausedSeconds + Math.max(0, Math.floor((nowMs - new Date(timer.pausedAt).getTime()) / 1000))
  }
  return timer.pausedSeconds
}

/** Wall-clock since start, less every paused stretch. Never negative — a clock adjustment
 * that moves `now` behind `startedAt` reads as 0 rather than as a nonsense run. */
export function elapsedSecondsNow(timer: ActiveTimer, nowMs: number): number {
  const startMs = new Date(timer.startedAt).getTime()
  return Math.max(0, Math.floor((nowMs - startMs) / 1000) - pausedSecondsNow(timer, nowMs))
}

export function createTimer(input: NewTimerInput, atMs: number = Date.now()): ActiveTimer {
  return {
    ...input,
    notes: input.notes ?? [],
    timerId: genId(),
    startedAt: new Date(atMs).toISOString(),
    pausedSeconds: 0,
    isPaused: false,
    pausedAt: null,
  }
}

/**
 * Pause ↔ resume, as a pure transform over the timer list. Resuming banks the pause that just
 * ended into pausedSeconds; pausing only records when it began, so the in-progress pause is
 * computed live by pausedSecondsNow and can't be lost to a refresh mid-pause.
 */
export function toggleTimerPause(timers: ActiveTimer[], timerId: string, atMs: number = Date.now()): ActiveTimer[] {
  return timers.map((t) => {
    if (t.timerId !== timerId) return t
    if (t.isPaused) {
      const extra = t.pausedAt ? Math.max(0, Math.floor((atMs - new Date(t.pausedAt).getTime()) / 1000)) : 0
      return { ...t, isPaused: false, pausedAt: null, pausedSeconds: t.pausedSeconds + extra }
    }
    return { ...t, isPaused: true, pausedAt: new Date(atMs).toISOString() }
  })
}

/**
 * Back to 00:00, held there: the clock is re-stamped to now, the banked pause time is thrown
 * away, and the timer is left PAUSED rather than running. A restart is what happens when a run
 * has to be done again from the top, and the person restarting it is not, at that instant,
 * ready to start working — auto-running would begin timing them walking back to the van.
 *
 * pausedAt is set to the same instant as startedAt, so the in-progress pause exactly cancels
 * the wall clock and the display sits on 0:00 until Start is pressed (which banks that pause
 * through toggleTimerPause like any other).
 *
 * Everything the run is ABOUT is kept — the operation, the models, the operator, the notes
 * written so far. Only the elapsed time is discarded, which is why the caller confirms first.
 */
export function restartTimer(timers: ActiveTimer[], timerId: string, atMs: number = Date.now()): ActiveTimer[] {
  const at = new Date(atMs).toISOString()
  return timers.map((t) => (
    t.timerId === timerId ? { ...t, startedAt: at, pausedSeconds: 0, isPaused: true, pausedAt: at } : t
  ))
}

export function dropTimer(timers: ActiveTimer[], timerId: string): ActiveTimer[] {
  return timers.filter((t) => t.timerId !== timerId)
}

/** Appends a note to one timer's list, as a pure transform. Blank input is ignored rather than
 * stored — an empty operation_time_note would be rejected at save time anyway. */
export function addTimerNote(timers: ActiveTimer[], timerId: string, note: string): ActiveTimer[] {
  const trimmed = note.trim()
  if (!trimmed) return timers
  return timers.map((t) => (t.timerId === timerId ? { ...t, notes: [...(t.notes ?? []), trimmed] } : t))
}

/** Drops one pending note by index — nothing has been written yet, so a typo has to be
 * fixable before the run is recorded. */
export function removeTimerNote(timers: ActiveTimer[], timerId: string, index: number): ActiveTimer[] {
  return timers.map((t) => (
    t.timerId === timerId ? { ...t, notes: (t.notes ?? []).filter((_, i) => i !== index) } : t
  ))
}

/** The figures a completed run is recorded with — derived from the timer's own timestamps, so
 * the saved total always matches what the display was showing. */
export interface TimerCompletion {
  totalMinutes: number
  pausedDurationSeconds: number
  startedAt: string
  completedAt: string
}

export function completeTimer(timer: ActiveTimer, atMs: number = Date.now()): TimerCompletion {
  return {
    totalMinutes: elapsedSecondsNow(timer, atMs) / 60,
    pausedDurationSeconds: pausedSecondsNow(timer, atMs),
    startedAt: timer.startedAt,
    completedAt: new Date(atMs).toISOString(),
  }
}

/**
 * The one place a finished timer becomes rows: recordOperationTime for the run, then
 * addOperationTimeNote when a note was typed on the confirmation. Never removes the timer
 * itself — the caller does that only once this resolves, so a failed save leaves the timer
 * running rather than throwing the elapsed time away.
 *
 * `operatorId` overrides whatever the timer was started with — /tryouts asks for an operator
 * when the timer STARTS, carries it on the timer, and offers it back pre-filled at Complete
 * where it can still be changed. Passing null, or leaving the timer's own operator null,
 * records the run against the shared placeholder operator.
 *
 * Notes are written after the time exists, in collection order: the run's list (`opts.notes`
 * when the caller has an edited copy, otherwise the timer's own — the starting note, then
 * anything added live during the run) followed by `opts.note`, the one typed on the completion
 * form. Blank entries are dropped, so a run note emptied out on the form is simply not written.
 * Sequentially rather than in parallel, so their created_at ordering matches the order they
 * were written in — the notes thread is read newest-first everywhere, and a concurrent burst
 * would scramble that.
 *
 * A note that fails to save does NOT fail the run: the operation_time is already committed and
 * is the thing that matters, so the failure is logged and the rest are still attempted.
 */
export async function saveTimerRun(
  supabase: SupabaseClient,
  timer: ActiveTimer,
  opts: {
    userId: string
    operatorId?: string | null
    note?: string
    /**
     * Replaces the timer's own notes for this save. /tryouts' completion form lets the run's
     * notes be edited and removed before committing, and those edits must not be written back
     * onto the timer — cancelling has to leave it running with its notes untouched — so the
     * edited list is handed in here instead. Omit to use timer.notes as-is.
     */
    notes?: string[]
    atMs?: number
  }
): Promise<RecordedOperationTime> {
  const { totalMinutes, pausedDurationSeconds, startedAt, completedAt } = completeTimer(timer, opts.atMs ?? Date.now())

  // The models were snapshotted at Start. recordOperationTime re-checks them against the
  // applies-list NOW, so a pair unlinked while the clock ran is refused here rather than banked;
  // the result says which, and the caller reports it.
  const recorded = await recordOperationTime(supabase, {
    operationId: timer.operationId,
    productIds: timer.productIds,
    operatorId: opts.operatorId !== undefined ? opts.operatorId : timer.operatorId,
    collectedBy: opts.userId,
    totalMinutes,
    startedAt,
    completedAt,
    pausedDurationSeconds,
    chassisId: timer.chassisId,
  })

  const notes = [...(opts.notes ?? timer.notes ?? []), opts.note ?? '']
    .map((n) => n.trim())
    .filter(Boolean)

  for (const note of notes) {
    try {
      await addOperationTimeNote(supabase, recorded.created.id, note, opts.userId)
    } catch (err) {
      console.error('[saveTimerRun] the time saved but a note did not:', note, err)
    }
  }

  return recorded
}

/**
 * The 1s heartbeat every live display re-renders off. Disabled when there is nothing running,
 * so a screen with no timers isn't re-rendering once a second for nothing.
 *
 * Seeded lazily rather than from a module-level constant so the first paint after mount is
 * already current, and re-seeded whenever it's switched back on — a tab that was idle with no
 * timers must not start a new one from a stale `now`.
 */
export function useTimerTick(enabled: boolean = true): number {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) return
    setNowMs(Date.now())
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [enabled])

  return nowMs
}

export interface Stopwatches {
  timers: ActiveTimer[]
  /** Current time, refreshed every second while any timer exists. */
  nowMs: number
  start: (input: NewTimerInput) => ActiveTimer
  togglePause: (timerId: string) => void
  /** Resets one timer to 0:00 and leaves it paused — see restartTimer. */
  restart: (timerId: string) => void
  /** Drops a timer without recording anything — its pending notes go with it. */
  discard: (timerId: string) => void
  /** Adds a note to a running timer without stopping it. */
  addNote: (timerId: string, note: string) => void
  /** Removes one not-yet-saved note from a timer. */
  removeNote: (timerId: string, index: number) => void
  /** Escape hatch for a caller that needs to rewrite the whole list (e.g. after a save). */
  setTimers: (value: ActiveTimer[] | ((prev: ActiveTimer[]) => ActiveTimer[])) => void
}

/**
 * A screen's set of running timers, persisted under `storageKey` and ticking once a second.
 * Each screen keeps its own key — /collect's timers and /tryouts' are different work — but the
 * behaviour behind them is this one implementation.
 */
export function useStopwatches(storageKey: string): Stopwatches {
  const [timers, setTimers] = usePersistedState<ActiveTimer[]>(storageKey, [])
  const nowMs = useTimerTick(timers.length > 0)

  const start = useCallback((input: NewTimerInput) => {
    const timer = createTimer(input)
    setTimers((prev) => [...prev, timer])
    return timer
  }, [setTimers])

  const togglePause = useCallback((timerId: string) => {
    setTimers((prev) => toggleTimerPause(prev, timerId))
  }, [setTimers])

  const restart = useCallback((timerId: string) => {
    setTimers((prev) => restartTimer(prev, timerId))
  }, [setTimers])

  const discard = useCallback((timerId: string) => {
    setTimers((prev) => dropTimer(prev, timerId))
  }, [setTimers])

  const addNote = useCallback((timerId: string, note: string) => {
    setTimers((prev) => addTimerNote(prev, timerId, note))
  }, [setTimers])

  const removeNote = useCallback((timerId: string, index: number) => {
    setTimers((prev) => removeTimerNote(prev, timerId, index))
  }, [setTimers])

  return { timers, nowMs, start, togglePause, restart, discard, addNote, removeNote, setTimers }
}
