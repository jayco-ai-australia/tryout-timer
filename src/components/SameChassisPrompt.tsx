'use client'

import { useCallback, useRef, useState } from 'react'
import Modal from './Modal'
import { fmtDate, fmtMinutes } from '@/lib/format'
import {
  ChassislessRecordError, SameChassisRecordError,
  type ChassislessModelState, type ExistingChassisRecord, type ModelRecordResolution, type SameChassisResolution,
} from '@/lib/operationTimes'

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
 * WITHOUT A VAN (ChassislessRecordError — /collect): chassis-less records on a model sum the same
 * way, so a re-time added beside the first doubles it. One save banks against many models, so the
 * models are grouped by the records they already hold, a group with none is shown as simply
 * getting this time, and each group with a figure is answered on its own — Correct (the default:
 * adding is the rarer intent and the one that silently inflates) or Add as separate work — with
 * what each does to one of its models' figure, in minutes. See ChassislessPrompt below.
 * Estimates are never asked about: a measured time replaces them without a question (the guard
 * does it), so this only says so, and a save that meets nothing but estimates never opens it.
 *
 * Use it through useSameChassisPrompt rather than rendering it directly: the hook catches either
 * guard's error around any save and calls the save again with the answer, so a screen only wraps
 * its save and renders `prompt`.
 */

interface PromptContext {
  operationName: string
  chassisNumber: string | null
  /** The minutes about to be saved — shown so "correct" says what it will change to. */
  minutes: number
  /** product id → model name, for a chassis-less save's per-model question. The guard only
   * knows ids; a model missing here is shown as "a model". */
  modelNames?: Record<string, string>
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

const MUTED = { fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 } as const
const STRONG = { color: 'var(--text)' } as const

/** Models that already hold exactly the same chassis-less records — they share one answer. */
interface RecordGroup {
  key: string
  models: ChassislessModelState[]
  records: ExistingChassisRecord[]
}

type GroupAnswer = { action: 'correct'; recordId: string | null } | { action: 'add-separate' }

function nameList(names: string[], max = 6): string {
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`
}

interface ChassislessPromptProps {
  operationName: string
  minutes: number
  modelNames: Record<string, string>
  models: ChassislessModelState[]
  onChoose: (choice: SameChassisResolution | null) => void
}

/**
 * The chassis-less question. Models with a figure are grouped by the exact records they hold (a
 * Collect run banked against six models is one record on six models — one group, one answer);
 * models with none are listed as getting this time. Each group defaults to Correct, with its one
 * record picked; a group holding several records (sub-tasks that sum, or a doubling already in the
 * data) defaults to Correct with nothing picked, so Save waits until somebody says which.
 */
function ChassislessPrompt({ operationName, minutes, modelNames, models, onChoose }: ChassislessPromptProps) {
  const name = (id: string) => modelNames[id] ?? 'a model'
  const fresh = models.filter((m) => m.records.length === 0)
  const groups: RecordGroup[] = []
  for (const m of models) {
    if (m.records.length === 0) continue
    const key = m.records.map((r) => r.id).join(',')
    const g = groups.find((x) => x.key === key)
    if (g) g.models.push(m)
    else groups.push({ key, models: [m], records: m.records })
  }

  const [answers, setAnswers] = useState<Record<string, GroupAnswer>>(() => Object.fromEntries(
    groups.map((g) => [g.key, { action: 'correct', recordId: g.records.length === 1 ? g.records[0].id : null }])
  ))
  const set = (key: string, a: GroupAnswer) => setAnswers((prev) => ({ ...prev, [key]: a }))
  const unanswered = groups.filter((g) => { const a = answers[g.key]; return a.action === 'correct' && !a.recordId })

  function save() {
    const byProduct: Record<string, ModelRecordResolution> = {}
    for (const g of groups) {
      const a = answers[g.key]
      for (const m of g.models) {
        byProduct[m.productId] = a.action === 'correct' ? { action: 'correct', recordId: a.recordId as string } : { action: 'add-separate' }
      }
    }
    onChoose({ action: 'per-model', byProduct })
  }

  const withFigure = models.length - fresh.length
  return (
    <Modal
      title={withFigure === 1 ? 'This model already has a time' : `${withFigure} models already have a time`}
      onClose={() => onChoose(null)}
      maxWidth={600}
      footer={(
        <>
          {unanswered.length > 0 && (
            <span style={{ ...MUTED, marginRight: 'auto', alignSelf: 'center' }}>Pick the record to correct, or choose Add.</span>
          )}
          <button className="btn-ghost" onClick={() => onChoose(null)}>Cancel</button>
          <button className="btn-primary" disabled={unanswered.length > 0} onClick={save}>Save time</button>
        </>
      )}
    >
      <p style={{ fontSize: 14, color: 'var(--text-mid)', lineHeight: 1.6, margin: '0 0 14px' }}>
        You’re saving <strong style={STRONG}>{fmtMinutes(minutes)} min</strong> for{' '}
        <strong style={STRONG}>“{operationName}”</strong> against {models.length === 1 ? 'one model' : `${models.length} models`}.{' '}
        {withFigure === models.length ? (models.length === 1 ? 'It already has' : 'They all already have') : `${withFigure} of them already have`}{' '}
        a time for it. Times without a van add up, so if this is the same work timed again, correct the
        existing time — adding it would count the work twice.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {groups.map((g) => {
          const a = answers[g.key]
          const example = g.models[0]
          const names = g.models.map((m) => name(m.productId))
          const correctedTo = a.action === 'correct' && a.recordId ? example.ifCorrected[a.recordId] : null
          const anyEstimate = g.records.some((r) => r.isEstimated)
          return (
            <section key={g.key} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>
                Already timed · {g.models.length === 1 ? names[0] : `${g.models.length} models`}
              </div>
              {g.models.length > 1 && <div style={{ ...MUTED, fontSize: 12, marginBottom: 8, overflowWrap: 'anywhere' }}>{nameList(names)}</div>}

              {g.records.length === 1 ? (
                <RecordLine record={g.records[0]} groupSize={g.models.length} />
              ) : (
                <div role="radiogroup" aria-label="Which record this corrects" style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0' }}>
                  <div style={{ ...MUTED, fontSize: 12 }}>{g.records.length} times here add up to the figure. Which one does this correct?</div>
                  {g.records.map((r) => (
                    <label key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', minHeight: 32 }}>
                      <input
                        type="radio" name={`rec-${g.key}`} checked={a.action === 'correct' && a.recordId === r.id}
                        onChange={() => set(g.key, { action: 'correct', recordId: r.id })}
                        style={{ marginTop: 3, accentColor: 'var(--blue)' }}
                      />
                      <RecordLine record={r} groupSize={g.models.length} />
                    </label>
                  ))}
                </div>
              )}

              <div role="radiogroup" aria-label="What this time is" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                <ChoiceRow
                  name={`choice-${g.key}`}
                  checked={a.action === 'correct'}
                  onSelect={() => set(g.key, { action: 'correct', recordId: a.action === 'correct' ? a.recordId : (g.records.length === 1 ? g.records[0].id : null) })}
                  label={anyEstimate && g.records.length === 1 ? 'Correct it — replaces the estimate' : 'Correct it — same work, timed again'}
                  effect={correctedTo != null
                    ? <>{name(example.productId)} would become <strong style={STRONG}>{fmtMinutes(correctedTo)} min</strong></>
                    : <>pick the record above to see the figure</>}
                />
                <ChoiceRow
                  name={`choice-${g.key}`}
                  checked={a.action === 'add-separate'}
                  onSelect={() => set(g.key, { action: 'add-separate' })}
                  label="Add as separate work — added on top"
                  effect={<>{name(example.productId)} would become <strong style={STRONG}>{fmtMinutes(example.ifAdded)} min</strong></>}
                />
              </div>
              <div style={{ ...MUTED, fontSize: 12, marginTop: 8 }}>
                {name(example.productId)} is {fmtMinutes(example.figureNow)} min now.
                {example.estimatesReplaced.length > 0 && ` Its estimate (${fmtMinutes(example.estimatesReplaced[0].totalMinutes)} min) is replaced by this measured time either way.`}
                {g.models.length > 1 && ' Applies to every model in this group.'}
              </div>
            </section>
          )
        })}

        {fresh.length > 0 && (
          <section style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>
              No measured time yet without a van · {fresh.length === 1 ? name(fresh[0].productId) : `${fresh.length} models`}
            </div>
            {fresh.length > 1 && <div style={{ ...MUTED, fontSize: 12, marginBottom: 6, overflowWrap: 'anywhere' }}>{nameList(fresh.map((m) => name(m.productId)))}</div>}
            <div style={{ ...MUTED }}>
              This time is recorded for {fresh.length === 1 ? 'it' : 'them'} — nothing to decide.{' '}
              {fresh[0].figureNow == null
                ? <>{name(fresh[0].productId)} goes from untimed to <strong style={STRONG}>{fmtMinutes(fresh[0].ifAdded)} min</strong>.</>
                : <>{name(fresh[0].productId)} goes from {fmtMinutes(fresh[0].figureNow)} to <strong style={STRONG}>{fmtMinutes(fresh[0].ifAdded)} min</strong>.</>}
              {(() => {
                const n = fresh.filter((m) => m.estimatesReplaced.length > 0).length
                return n === 0 ? null : <> {n === fresh.length && n === 1 ? 'Its estimate is' : `The estimate on ${n === fresh.length ? 'each' : `${n} of them`} is`} replaced by this measured time.</>
              })()}
            </div>
          </section>
        )}
      </div>
    </Modal>
  )
}

function RecordLine({ record: r, groupSize }: { record: ExistingChassisRecord; groupSize: number }) {
  const elsewhere = r.modelCount - groupSize
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 14, color: 'var(--text)' }}>
        <strong>{fmtMinutes(r.totalMinutes)} min</strong>
        {r.isEstimated && <span className="badge badge-estimated" style={{ marginLeft: 6 }}>estimate</span>}
        <span style={{ color: 'var(--text-mid)' }}> · {r.operatorName ?? 'No operator recorded'} · {fmtDate(r.createdAt)}</span>
      </span>
      {r.notes.map((n, i) => (
        <span key={i} style={{ fontSize: 12, color: 'var(--text-mid)', overflowWrap: 'anywhere' }}>“{n}”</span>
      ))}
      {elsewhere > 0 && (
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Also counts for {elsewhere === 1 ? 'one model' : `${elsewhere} models`} not in this group — correcting leaves {elsewhere === 1 ? 'it' : 'them'} as they are.
        </span>
      )}
    </span>
  )
}

function ChoiceRow({ name, checked, onSelect, label, effect }: {
  name: string; checked: boolean; onSelect: () => void; label: string; effect: React.ReactNode
}) {
  return (
    <label style={{
      display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', padding: '8px 10px', minHeight: 44, borderRadius: 8,
      border: `1px solid ${checked ? 'var(--blue)' : 'var(--border)'}`, background: checked ? 'var(--blue-light)' : 'var(--surface)',
    }}>
      <input type="radio" name={name} checked={checked} onChange={onSelect} style={{ marginTop: 3, accentColor: 'var(--blue)' }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{label}</span>
        <span style={{ fontSize: 13, color: 'var(--text-mid)' }}>{effect}</span>
      </span>
    </label>
  )
}

/**
 * Wraps a save so the same-chassis guard — or the chassis-less one — becomes a question rather
 * than an error. A chassis-less caller passes `modelNames` so the question can name the models.
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
  const [pending, setPending] = useState<
    | (PromptContext & { kind: 'chassis'; existing: ExistingChassisRecord[] })
    | (PromptContext & { kind: 'chassisless'; models: ChassislessModelState[] })
    | null
  >(null)
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
        if (!(err instanceof SameChassisRecordError) && !(err instanceof ChassislessRecordError)) throw err
        const choice = await new Promise<SameChassisResolution | null>((resolve) => {
          resolveRef.current = resolve
          setPending(err instanceof SameChassisRecordError
            ? { ...context, kind: 'chassis', existing: err.existing }
            : { ...context, kind: 'chassisless', models: err.models })
        })
        resolveRef.current = null
        setPending(null)
        if (!choice) return null
        answer = choice
      }
    }
  }, [])

  // Keyed on the records so a re-opened prompt over fresh records starts with a fresh selection.
  const sameChassisPrompt = !pending ? null : pending.kind === 'chassis' ? (
    <SameChassisPrompt
      key={pending.existing.map((r) => r.id).join(',')}
      operationName={pending.operationName}
      chassisNumber={pending.chassisNumber}
      minutes={pending.minutes}
      existing={pending.existing}
      onChoose={(choice) => resolveRef.current?.(choice)}
    />
  ) : (
    <ChassislessPrompt
      key={pending.models.map((m) => `${m.productId}:${m.records.map((r) => r.id).join('+')}`).join(',')}
      operationName={pending.operationName}
      minutes={pending.minutes}
      modelNames={pending.modelNames ?? {}}
      models={pending.models}
      onChoose={(choice) => resolveRef.current?.(choice)}
    />
  )

  return { withSameChassisPrompt, sameChassisPrompt }
}
