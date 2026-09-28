'use client'

import { useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import OperatorSelect from './OperatorSelect'
import { elapsedSecondsNow, genId, type ActiveTimer } from '@/lib/stopwatch'
import { fmtClock, fmtMinutes } from '@/lib/format'

/**
 * The shared running-timers UI — the fixed right-hand rail and the two dialogs that bookend a
 * run (Start, and Complete). Every screen that runs stopwatches mounts these rather than
 * building its own: /tryouts, walking one van, and /collect, filling coverage against many
 * models at once.
 *
 * The two screens differ only in what a run is banked against — a chassis on /tryouts, a set of
 * models on /collect — and that difference is a single `contextLabel` string here. Everything
 * else (concurrency, the one-timer-per-operation rule enforced by the caller, pause
 * accumulation, notes gathered mid-run, the searchable line-scoped operator picker asked at
 * Start and confirmed at Complete, the Restart that puts a card back to 0:00) is identical, and
 * lives in one place so the two can't drift apart.
 *
 * All timer state belongs to lib/stopwatch and is owned by the host screen's useStopwatches;
 * nothing here holds a timer. The only state these components own is what a user is part-way
 * through typing.
 */

/** The minimum an operator needs to be for these dialogs — matches what every screen already
 * selects from `operators`. */
export interface TimerOperatorOption { id: string; full_name: string }

const ERR_BOX: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13,
}
const SECTION_LABEL: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'var(--text-muted)', marginBottom: 8, display: 'block',
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// ── The rail ───────────────────────────────────────────────────────────────────────────────
/**
 * Every running or paused stopwatch, always on screen — this is what replaces a "Running now"
 * pane. A pane could only ever show the timers under whatever the drill-down columns happen to
 * be pointing at, and timers deliberately run concurrently across different jobs and sections;
 * the rail is the one place that shows all of them, so any can be paused or completed without
 * navigating back to the operation it belongs to.
 *
 * It is a fixed column down the right-hand quarter of the screen, running from under the nav to
 * the bottom of the viewport and scrolling internally — so it stays put while the panes to its
 * left are scrolled and drilled through. The page reserves the matching width (see
 * .rail-page), constant whether or not anything is running, so starting a timer can't reflow
 * the panes.
 *
 * Cards render in the timers array's own order, which is insertion order — a new timer is
 * appended, so the newest is always the bottom card and nothing above it shifts when one
 * starts. That stability matters: a Complete button that moves under a finger mid-tap is how
 * the wrong run gets saved.
 *
 * Below ~1100px a quarter-width column would leave the panes nothing to live in, so the same
 * markup lays out as a bottom bar instead — entirely in the stylesheet; there is no second
 * component and no second set of behaviour.
 *
 * Timers whose context differs from the screen's current one (a run started on another van, or
 * against a different model set) are listed too and labelled — a timer must not become
 * invisible, and therefore un-completable, because the screen moved on.
 */
export function TimerRail({
  timers, nowMs, currentContextKey, onTogglePause, onRestart, onComplete, onDiscard, onAddNote, onRemoveNote,
}: {
  timers: ActiveTimer[]
  nowMs: number
  /**
   * What "here" is for the host screen — a chassis id on /tryouts, null on /collect where a run
   * isn't tied to anything. A timer whose own key differs shows its label so it can still be
   * told apart. Pass null to label nothing.
   */
  currentContextKey: string | null
  onTogglePause: (timerId: string) => void
  /** Reset one timer to 0:00 and leave it paused — this component confirms before calling. */
  onRestart: (timerId: string) => void
  onComplete: (timer: ActiveTimer) => void
  onDiscard: (timerId: string) => void
  onAddNote: (timerId: string, note: string) => void
  onRemoveNote: (timerId: string, index: number) => void
}) {
  const running = timers.filter((t) => !t.isPaused).length

  if (timers.length === 0) {
    return (
      <aside className="timer-rail timer-rail-empty" aria-label="Running timers">
        <div className="timer-rail-header">Running (0)</div>
        <div className="timer-rail-none">No timers running</div>
      </aside>
    )
  }

  return (
    <aside className="timer-rail" aria-label="Running timers">
      <div className="timer-rail-header">
        Running ({running}){timers.length > running ? ` · ${timers.length - running} paused` : ''}
      </div>
      <div className="timer-rail-body">
        {timers.map((timer) => (
          <TimerRailCard
            key={timer.timerId}
            timer={timer}
            nowMs={nowMs}
            showContext={currentContextKey !== null && timer.chassisId !== currentContextKey}
            onTogglePause={() => onTogglePause(timer.timerId)}
            onRestart={() => onRestart(timer.timerId)}
            onComplete={() => onComplete(timer)}
            onDiscard={() => onDiscard(timer.timerId)}
            onAddNote={(note) => onAddNote(timer.timerId, note)}
            onRemoveNote={(index) => onRemoveNote(timer.timerId, index)}
          />
        ))}
      </div>
    </aside>
  )
}

/**
 * One timer in the rail. Its own component purely so the note draft is per-card state — with a
 * single shared draft, typing a note against one running timer would appear in the box of every
 * other one, which is precisely the mix-up concurrent timers make easy.
 *
 * "Add note" writes to the TIMER, not to the database: there is no operation_time row to hang an
 * operation_time_note off until the run is completed. The notes sit in timer.notes, persist to
 * localStorage with everything else the timer owns, and are written in order once Complete
 * saves the run. Adding one never touches the clock — the whole point is annotating a run while
 * it is still going.
 */
function TimerRailCard({
  timer, nowMs, showContext, onTogglePause, onRestart, onComplete, onDiscard, onAddNote, onRemoveNote,
}: {
  timer: ActiveTimer
  nowMs: number
  showContext: boolean
  onTogglePause: () => void
  onRestart: () => void
  onComplete: () => void
  onDiscard: () => void
  onAddNote: (note: string) => void
  onRemoveNote: (index: number) => void
}) {
  const [noteOpen, setNoteOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmRestart, setConfirmRestart] = useState(false)
  const notes = timer.notes ?? []
  const elapsed = elapsedSecondsNow(timer, nowMs)
  /** A timer sitting paused on 0:00 has never actually run — most often because it was just
   * restarted — so the resume control says what it will really do. */
  const atZero = timer.isPaused && elapsed === 0

  function commit() {
    if (!draft.trim()) return
    onAddNote(draft)
    setDraft('')
    setNoteOpen(false)
  }

  return (
    <div className="timer-rail-card">
      <div className="timer-rail-card-main">
        <div className="timer-rail-op">{timer.operationName}</div>
        <div className="timer-rail-meta">
          {timer.jobName}
          {showContext && timer.chassisNumber && <> · {timer.chassisNumber}</>}
          {timer.models.length > 0 && <> · {plural(timer.models.length, 'model')}</>}
          {timer.operatorName && <> · {timer.operatorName}</>}
        </div>
      </div>

      <span className={'timer-rail-clock ' + (timer.isPaused ? 'timer-display-paused' : 'timer-display-running')}>
        {fmtClock(elapsed)}
      </span>

      <div className="timer-rail-card-actions">
        <button type="button" className="btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={onTogglePause}>
          {timer.isPaused ? (atZero ? 'Start' : 'Resume') : 'Pause'}
        </button>
        <button
          type="button"
          className="btn-primary"
          style={{ padding: '5px 10px', fontSize: 12 }}
          title="Record this run — asks for the operator and a final note first"
          onClick={onComplete}
        >
          Complete
        </button>
        <button
          type="button"
          className="finder-row-action"
          title="Reset this timer to 0:00 — it stays paused until you press Start"
          onClick={() => setConfirmRestart(true)}
        >
          Restart
        </button>
        <button
          type="button"
          className="finder-row-action"
          title="Discard this timer — no time will be recorded"
          onClick={onDiscard}
        >
          Discard
        </button>
      </div>

      {/* Restarting throws the elapsed time away, so it asks first — the same small
        * confirmation Discard gets, since from a walker's point of view both lose the run. */}
      {confirmRestart && (
        <ConfirmDialog
          title="Restart timer"
          message={
            `Reset this timer to 0:00? The ${fmtClock(elapsed)} already on “${timer.operationName}” ` +
            'is discarded and nothing is recorded. It stays paused until you press Start, and ' +
            (notes.length > 0 ? `the ${plural(notes.length, 'note')} on this run ` : 'the operator and everything else on this run ') +
            'is kept.'
          }
          confirmLabel="Reset to 0:00"
          danger
          onConfirm={() => { setConfirmRestart(false); onRestart() }}
          onCancel={() => setConfirmRestart(false)}
        />
      )}

      {/* Notes gathered so far on THIS run — each removable while it's still only in the
          timer, since nothing has been written and a typo would otherwise be permanent. */}
      {notes.length > 0 && (
        <ul className="timer-rail-notes">
          {notes.map((note, index) => (
            <li key={index}>
              <span>{note}</span>
              <button
                type="button"
                className="finder-row-action finder-row-action-danger"
                title="Remove this note"
                onClick={() => onRemoveNote(index)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {noteOpen ? (
        <div className="timer-rail-note-form">
          <textarea
            autoFocus
            className="input"
            rows={2}
            style={{ width: '100%', resize: 'vertical', fontSize: 12 }}
            placeholder="What happened just now?"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // Enter saves, Shift+Enter for a second line — the clock is running, so this wants
            // to be over in one keystroke.
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
              if (e.key === 'Escape') { setNoteOpen(false); setDraft('') }
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-primary" style={{ padding: '4px 10px', fontSize: 12 }} disabled={!draft.trim()} onClick={commit}>
              Add note
            </button>
            <button type="button" className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => { setNoteOpen(false); setDraft('') }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="finder-row-action"
          style={{ alignSelf: 'flex-start' }}
          title="Write a note without stopping the timer"
          onClick={() => setNoteOpen(true)}
        >
          + Add note{notes.length > 0 ? ` (${notes.length})` : ''}
        </button>
      )}
    </div>
  )
}

// ── Start ──────────────────────────────────────────────────────────────────────────────────
export interface StartTimerChoice {
  operatorId: string | null
  operatorName: string | null
  /** The opening note, or '' — the caller seeds timer.notes with it when non-empty. */
  note: string
}

/**
 * Asked before the clock begins, not after: who is being timed is known at the start of a run
 * and forgotten by the end of it, and an opening note is context you only have at the time.
 * Both optional — starting with neither is a perfectly normal run.
 *
 * Writes nothing and starts nothing itself; `onStart` hands the answers back and the host
 * creates the timer, so the operator and note ride on the timer object from the first tick.
 */
export function StartTimerDialog({
  operationName, jobName, contextLabel, operators, onStart, onCancel,
}: {
  operationName: string
  jobName: string
  /** What the run will be banked against — "EF1147", "4 models", etc. */
  contextLabel: string
  /** Already scoped to the production line in play — see lib/operators' operatorsForLine. */
  operators: TimerOperatorOption[]
  onStart: (choice: StartTimerChoice) => void
  onCancel: () => void
}) {
  const [operatorId, setOperatorId] = useState('')
  const [note, setNote] = useState('')

  return (
    <ConfirmDialog
      title="Start timing"
      message={
        `Start the stopwatch on “${operationName}” (${jobName}) for ${contextLabel}. ` +
        'Both fields are optional — the operator comes back pre-filled when you complete the run, and can be changed then.'
      }
      confirmLabel="Start timing"
      cancelLabel="Cancel"
      maxWidth={560}
      onConfirm={() => onStart({
        operatorId: operatorId || null,
        operatorName: operators.find((o) => o.id === operatorId)?.full_name ?? null,
        note,
      })}
      onCancel={onCancel}
    >
      <div className="capture-fields">
        <div>
          <label className="label">Operator — who&apos;s being timed?</label>
          <OperatorSelect
            operators={operators}
            value={operatorId}
            ariaLabel="Operator being timed"
            onChange={setOperatorId}
          />
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
            Optional, and only this production line&apos;s operators. The operation&apos;s own primary
            operator isn&apos;t changed either way.
          </p>
        </div>
        <div>
          <label className="label">Starting note</label>
          <textarea
            className="input" rows={3} style={{ width: '100%', resize: 'vertical' }}
            placeholder="Optional — anything worth noting before the run starts"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
            Saved as the first note on this run. You can add more while the timer runs.
          </p>
        </div>
      </div>
    </ConfirmDialog>
  )
}

// ── Complete ───────────────────────────────────────────────────────────────────────────────
export interface CompleteTimerResult {
  operatorId: string | null
  /** The run's notes as edited on the form, in order. */
  notes: string[]
  /** The final note typed here, or ''. */
  note: string
  /** The instant the clock was stopped — what the form quoted, and what must be saved. */
  atMs: number
}

/**
 * The step both Complete buttons open. Nothing is written when it appears: the host's save runs
 * only from `onSave`, and Cancel leaves the timer running or paused untouched.
 *
 * The clock stops the moment this mounts, not when Save is pressed — the figure shown and the
 * figure recorded come from that one instant, so a dialog left open for a minute can't quietly
 * save a minute more than it said it would.
 *
 * The run's notes are edited here on a working COPY, so cancelling leaves the timer with
 * everything written during the run still on it. None of them exists in the database yet
 * (operation_time_notes rows can't precede the operation_times row they hang off), so editing
 * one is plain state, never a write.
 */
export function CompleteTimerDialog({
  timer, contextLabel, operators, saving, error, blockedReason, children, onSave, onCancel,
}: {
  timer: ActiveTimer
  /** What the run is being banked against — shown for confirmation before saving. */
  contextLabel: string
  /** Already scoped to the production line in play — see lib/operators' operatorsForLine. */
  operators: TimerOperatorOption[]
  saving: boolean
  error: string | null
  /** Set to refuse the save with a reason — /collect uses it for "no models selected". */
  blockedReason?: string | null
  /** Extra host-specific content above the fields (e.g. /collect's model list). */
  children?: React.ReactNode
  onSave: (result: CompleteTimerResult) => void
  onCancel: () => void
}) {
  // Frozen on mount. Deliberately not a prop: the one instant that matters is when Complete was
  // pressed, and that is exactly when this component appears.
  const [atMs] = useState(() => Date.now())
  const [operatorId, setOperatorId] = useState(timer.operatorId ?? '')
  const [note, setNote] = useState('')
  // Each entry carries a generated id so React keeps the right textarea — and the caret in it —
  // with the right note when one above it is removed; an array index would not.
  const [notes, setNotes] = useState<{ id: string; text: string }[]>(
    () => (timer.notes ?? []).map((text) => ({ id: genId(), text }))
  )

  const elapsed = elapsedSecondsNow(timer, atMs)

  return (
    <ConfirmDialog
      title="Complete timer"
      message={
        `Recording ${fmtClock(elapsed)} (${fmtMinutes(elapsed / 60)} minutes) ` +
        `for “${timer.operationName}” against ${contextLabel}. ` +
        'Operator and notes are both optional — leave them as they are to save without either.'
      }
      confirmLabel={saving ? 'Saving…' : 'Save'}
      cancelLabel="Cancel"
      // 720 rather than 560 so /collect's expanded model grid gets three columns out of the
      // 180px track instead of two — 89 models is 30 rows, not 45. The two side-by-side fields
      // below it are unaffected.
      maxWidth={720}
      onConfirm={() => {
        if (saving || blockedReason) return
        onSave({ operatorId: operatorId || null, notes: notes.map((n) => n.text), note, atMs })
      }}
      onCancel={onCancel}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {children}

        {blockedReason && <p style={ERR_BOX}>{blockedReason}</p>}

        {/* Both optional, side by side — the run saves with neither. */}
        <div className="capture-fields">
          <div>
            <label className="label">Operator — who was timed?</label>
            <OperatorSelect
              operators={operators}
              value={operatorId}
              disabled={saving}
              ariaLabel="Operator who was timed"
              onChange={setOperatorId}
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
              Pre-filled from Start, and only this production line&apos;s operators. The operation&apos;s
              own primary operator isn&apos;t changed either way.
            </p>
          </div>
          <div>
            <label className="label">Final note</label>
            <textarea
              className="input" rows={3} style={{ width: '100%', resize: 'vertical' }}
              placeholder="Optional — anything worth remembering about this run"
              value={note}
              disabled={saving}
              onChange={(e) => setNote(e.target.value)}
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
              Optional. Saved after any notes written during the run.
            </p>
          </div>
        </div>

        {/* Everything collected during the run, in the order it will be written — the starting
          * note first, then any added live, with the final note appended after them. Editable
          * and removable right up to Save: none of it exists in the database yet, and this is
          * the last chance to tidy a note typed one-handed with a stopwatch running. */}
        {notes.length > 0 && (
          <div>
            <span style={SECTION_LABEL}>{plural(notes.length, 'note')} from this run</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {notes.map((n, index) => (
                <div key={n.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <textarea
                    className="input"
                    rows={2}
                    style={{ flex: 1, minWidth: 0, resize: 'vertical', fontSize: 12 }}
                    value={n.text}
                    disabled={saving}
                    aria-label={`Note ${index + 1} from this run`}
                    onChange={(e) => setNotes((prev) => prev.map(
                      (x) => (x.id === n.id ? { ...x, text: e.target.value } : x)
                    ))}
                  />
                  <button
                    type="button"
                    className="finder-row-action finder-row-action-danger"
                    style={{ fontSize: 15, lineHeight: 1, padding: '6px 4px' }}
                    disabled={saving}
                    title="Remove this note — it won't be saved with the time"
                    aria-label={`Remove note ${index + 1}`}
                    onClick={() => setNotes((prev) => prev.filter((x) => x.id !== n.id))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
              Edit or remove these before saving. Cancelling leaves the timer running with all of
              them intact.
            </p>
          </div>
        )}

        {error && <p style={ERR_BOX}>{error}</p>}
      </div>
    </ConfirmDialog>
  )
}
