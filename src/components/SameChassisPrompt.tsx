'use client'

import { useCallback, useRef, useState } from 'react'
import Modal from './Modal'
import { fmtDate, fmtMinutes } from '@/lib/format'
import { SameChassisRecordError, type ExistingChassisRecord, type SameChassisResolution } from '@/lib/operationTimes'

/**
 * "There's already a time for this on this van" — the question recordOperationTime's
 * same-chassis guard refuses to answer for itself.
 *
 * Two current records for one operation on one van sum. That is right when they are separate
 * work (merged sub-tasks, two operators in parallel) and doubles the van's figure when the second
 * run is the first one timed again. Only the person saving knows which, so they are asked:
 *
 *   Correct that record    the chosen record's minutes become the new value, in place
 *   Add as separate work   a new record alongside, summed with the others
 *   Cancel                 nothing is written
 *
 * Use it through useSameChassisPrompt rather than rendering it directly: the hook catches the
 * guard's SameChassisRecordError around any save and calls the save again with the answer, so a
 * screen only wraps its save and renders `prompt`.
 */

interface PromptContext {
  operationName: string
  chassisNumber: string | null
  /** The minutes about to be saved — shown so "correct" says what it will change to. */
  minutes: number
}

interface SameChassisPromptProps extends PromptContext {
  existing: ExistingChassisRecord[]
  onChoose: (choice: SameChassisResolution | null) => void
}

export default function SameChassisPrompt({ operationName, chassisNumber, minutes, existing, onChoose }: SameChassisPromptProps) {
  // One record: it is the one to correct. Several: nothing is picked for them — correcting the
  // wrong one of a merged operation's sub-task records is the mistake this exists to prevent.
  const [selectedId, setSelectedId] = useState<string | null>(existing.length === 1 ? existing[0].id : null)
  const van = chassisNumber ?? 'this van'
  const single = existing.length === 1 ? existing[0] : null

  return (
    <Modal
      title="Already timed on this van"
      onClose={() => onChoose(null)}
      maxWidth={520}
      footer={(
        <>
          <button className="btn-ghost" onClick={() => onChoose(null)}>Cancel</button>
          <button className="btn-ghost" onClick={() => onChoose({ action: 'add-separate' })}>Add as separate work</button>
          <button
            className="btn-primary"
            disabled={!selectedId}
            onClick={() => selectedId && onChoose({ action: 'correct', recordId: selectedId })}
          >
            {single ? 'Correct that record' : 'Correct selected record'}
          </button>
        </>
      )}
    >
      <p style={{ fontSize: 14, color: 'var(--text-mid)', lineHeight: 1.6, margin: '0 0 14px' }}>
        {single ? (
          <>
            There’s already a time for <strong style={{ color: 'var(--text)' }}>“{operationName}”</strong> on{' '}
            <strong style={{ color: 'var(--text)' }}>{van}</strong> — {fmtMinutes(single.totalMinutes)} min, recorded
            by {single.operatorName ?? 'no operator recorded'} on {fmtDate(single.createdAt)}.
          </>
        ) : (
          <>
            There are already {existing.length} times for <strong style={{ color: 'var(--text)' }}>“{operationName}”</strong> on{' '}
            <strong style={{ color: 'var(--text)' }}>{van}</strong>. They add up to this van’s figure. Pick the one this
            time corrects, or add it as separate work.
          </>
        )}
      </p>

      <div role="radiogroup" aria-label="Existing records" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {existing.map((r) => {
          const selected = r.id === selectedId
          return (
            <label
              key={r.id}
              style={{
                display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer',
                padding: '10px 12px', minHeight: 44, borderRadius: 8,
                border: `1px solid ${selected ? 'var(--blue)' : 'var(--border)'}`,
                background: selected ? 'var(--blue-light)' : 'var(--surface)',
              }}
            >
              <input
                type="radio"
                name="same-chassis-record"
                checked={selected}
                onChange={() => setSelectedId(r.id)}
                style={{ marginTop: 3, accentColor: 'var(--blue)' }}
              />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 14, color: 'var(--text)' }}>
                  <strong>{fmtMinutes(r.totalMinutes)} min</strong>
                  <span style={{ color: 'var(--text-mid)' }}> · {r.operatorName ?? 'No operator recorded'} · {fmtDate(r.createdAt)}</span>
                </span>
                {r.notes.map((n, i) => (
                  <span key={i} style={{ fontSize: 12, color: 'var(--text-mid)', overflowWrap: 'anywhere' }}>“{n}”</span>
                ))}
              </span>
            </label>
          )
        })}
      </div>

      <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, margin: '14px 0 0' }}>
        New time: <strong style={{ color: 'var(--text)' }}>{fmtMinutes(minutes)} min</strong>.{' '}
        <strong>Correct</strong> changes the {single ? 'record above' : 'selected record'} to this and adds nothing.{' '}
        <strong>Separate work</strong> keeps {single ? 'it' : 'them all'} and adds this alongside — the times are summed.
      </p>
    </Modal>
  )
}

/**
 * Wraps a save so the same-chassis guard becomes a question rather than an error.
 *
 *   const { withSameChassisPrompt, sameChassisPrompt } = useSameChassisPrompt()
 *   const result = await withSameChassisPrompt(
 *     (sameChassis) => recordOperationTime(supabase, { ...input, sameChassis }),
 *     { operationName, chassisNumber, minutes },
 *   )
 *   if (result === null) return   // cancelled — nothing was written
 *   …and render {sameChassisPrompt}.
 *
 * The save is called once without an answer; if the guard refuses, the prompt opens and the save
 * is called again with the choice. If the records changed under the prompt the guard refuses
 * again and the prompt re-opens on the fresh list. Any other error is re-thrown untouched.
 */
export function useSameChassisPrompt() {
  const [pending, setPending] = useState<(PromptContext & { existing: ExistingChassisRecord[] }) | null>(null)
  const resolveRef = useRef<((choice: SameChassisResolution | null) => void) | null>(null)

  const withSameChassisPrompt = useCallback(async <T,>(
    save: (sameChassis: SameChassisResolution | undefined) => Promise<T>,
    context: PromptContext
  ): Promise<T | null> => {
    let answer: SameChassisResolution | undefined
    for (;;) {
      try {
        return await save(answer)
      } catch (err) {
        if (!(err instanceof SameChassisRecordError)) throw err
        const choice = await new Promise<SameChassisResolution | null>((resolve) => {
          resolveRef.current = resolve
          setPending({ ...context, existing: err.existing })
        })
        resolveRef.current = null
        setPending(null)
        if (!choice) return null
        answer = choice
      }
    }
  }, [])

  const sameChassisPrompt = pending ? (
    <SameChassisPrompt
      // Keyed on the list so a re-opened prompt over fresh records starts with a fresh selection.
      key={pending.existing.map((r) => r.id).join(',')}
      {...pending}
      onChoose={(choice) => resolveRef.current?.(choice)}
    />
  ) : null

  return { withSameChassisPrompt, sameChassisPrompt }
}
