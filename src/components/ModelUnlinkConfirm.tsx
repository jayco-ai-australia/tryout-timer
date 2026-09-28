'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import ConfirmDialog from '@/components/ConfirmDialog'
import { fmtDate, fmtMinutes, plural } from '@/lib/format'
import {
  previewModelUnlink, unlinkOperationsFromModel,
  type ModelUnlinkPreview, type ModelUnlinkResult,
} from '@/lib/modelLinks'

/**
 * ── "This doesn't apply to this model" — the confirmation, once ─────────────────────────────
 *
 * THE dialog for removing applicability from one model, at job level or operation level. It was
 * /model-total's, written inline in that screen; the Labour Matrix cell drawer needs the identical
 * act with the identical safeguards, so it was extracted here rather than copied. Both screens now
 * mount this, and there is one wording, one preview and one write path.
 *
 * ── What it is, and what it is emphatically not ─────────────────────────────────────────────
 * An UNLINK. Nothing here deletes a job, an operation, a recorded time or a note, and nothing here
 * soft-deletes one either. It removes the rows that say "this model does this work" —
 * model_operations for the applies-list, operation_time_models for the runs that counted towards
 * it — and lib/modelLinks owns both removals in that order, for the reason its own module note
 * gives. This component computes nothing and writes nothing itself.
 *
 * ── It never refuses because times exist ───────────────────────────────────────────────────
 * Times ARE the awkward case: a model carrying minutes from work it does not do is exactly what
 * this exists to fix. So instead of blocking, it NAMES every run it will detach — date, operation,
 * minutes — and says per run whether it ends up attached to nothing or still counts for another
 * model. "3 time records" would not let anyone check that the right three are about to move.
 *
 * ── Reversibility, stated asymmetrically because it is asymmetric ───────────────────────────
 * Re-linking the job or operation to the model afterwards is one tick in Setup. Re-attaching an
 * individual run to a model is not offered anywhere in the app. The dialog says both.
 *
 * It owns the preview read (on mount) and the write (on confirm), because every host wants both
 * and a host that only got the markup would have to re-derive when to run them. What it does not
 * own is the result banner: what to say afterwards, and where, belongs to the screen whose numbers
 * changed.
 */
export default function ModelUnlinkConfirm({
  supabase, productId, modelName, jobName, operationName, operationIds, onCancel, onDone,
}: {
  supabase: SupabaseClient
  /** The model losing the work. */
  productId: string
  /** products.model — the name on every screen and in every picker, never product_code. */
  modelName: string
  /** The job being unlinked, or the job the single operation belongs to. Header and message. */
  jobName: string
  /** Set for an operation-level unlink, absent for a job-level one. It changes the wording only:
   * the write is the same function with a shorter id list. */
  operationName?: string
  /**
   * Every operation whose applicability and time links come off. For a job-level unlink this is
   * the UNION of what the model requires and what it has timed — the two can drift, and a host
   * that passed only the required set would leave runs still counting towards the model.
   */
  operationIds: string[]
  onCancel: () => void
  /** The write finished. The host refreshes its own figures and says whatever it says. */
  onDone: (result: ModelUnlinkResult) => void
}) {
  const [preview, setPreview] = useState<ModelUnlinkPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Read on mount, once per opening: the dialog is mounted fresh each time a host opens it, so
  // there is no stale preview to invalidate. Cancelled on unmount so a dismissed dialog can't
  // write state into an unmounted component.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    previewModelUnlink(supabase, productId, operationIds)
      .then((p) => { if (!cancelled) setPreview(p) })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not work out what this would affect')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // operationIds is a fresh array each render in most hosts; the ids themselves are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, productId, operationIds.join(',')])

  async function confirm() {
    setSaving(true)
    setError(null)
    try {
      // Re-reads the preview internally rather than trusting the one on screen — the user may have
      // been looking at this dialog for a while. See lib/modelLinks.
      const result = await unlinkOperationsFromModel(supabase, productId, operationIds)
      onDone(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlink')
    } finally {
      setSaving(false)
    }
  }

  const noun = operationName ? 'operation' : 'job'

  return (
    <ConfirmDialog
      title={operationName ? 'This operation doesn’t apply?' : 'This job doesn’t apply?'}
      message={
        `This removes ${operationName ?? jobName} from ${modelName}. `
        + `The ${noun} stays in Setup and on every other model it applies to.`
      }
      confirmLabel={saving ? 'Unlinking…' : 'Doesn’t apply — unlink'}
      cancelLabel="Cancel"
      danger
      maxWidth={620}
      onConfirm={confirm}
      onCancel={() => { if (!saving) onCancel() }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12, color: 'var(--text-mid)' }}>
        {error && <p style={{ margin: 0, color: 'var(--red)' }}>{error}</p>}

        {loading ? (
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>Working out what this affects…</p>
        ) : preview && preview.times.length > 0 ? (
          <div>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
              {plural(preview.times.length, 'recorded time')} affected
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
              {preview.times.map((t) => (
                <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ color: 'var(--text-muted)' }}>{fmtDate(t.createdAt)}</span>{' '}
                    <strong style={{ color: 'var(--text)' }}>{t.operationName}</strong>{' '}
                    <span style={{ color: 'var(--text-muted)' }}>{fmtMinutes(t.minutes)}m</span>
                  </span>
                  <span style={{ flexShrink: 0, fontWeight: 600, color: t.becomesUnattached ? 'var(--amber)' : 'var(--text-muted)' }}>
                    {t.becomesUnattached
                      ? 'becomes unattached'
                      : `still counts for ${t.otherModels.join(', ')}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : preview ? (
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>No recorded times are affected.</p>
        ) : null}

        {/* Reversibility, stated honestly and asymmetrically — because it IS asymmetric. */}
        <p style={{ margin: 0, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          No job, operation, time record or note is deleted.{' '}
          {preview && preview.unattachedCount > 0 && (
            <>
              <strong>{plural(preview.unattachedCount, 'time')}</strong> will end up attached to no
              model at all — still in the database and still listed in Reports under
              “{`Unattached (no model)`}”.{' '}
            </>
          )}
          Re-linking the {noun} to this model afterwards is easy in Setup.{' '}
          <strong>Re-attaching an individual time record to this model is not a one-click undo</strong>{' '}
          — nothing in the app offers it.
        </p>
      </div>
    </ConfirmDialog>
  )
}
