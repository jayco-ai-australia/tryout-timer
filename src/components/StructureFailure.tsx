import { SectionActionError } from '@/lib/sectionManager'

/** An error from a structure action, and — for one that stopped part-way — exactly which steps
 * had already landed. Shared by every dialog that runs a section move or merge. */
export interface StructureFailure { message: string; completed: string[] | null }

export function toStructureFailure(err: unknown, fallback: string): StructureFailure {
  return {
    message: err instanceof Error ? err.message : fallback,
    completed: err instanceof SectionActionError ? err.completed : null,
  }
}

const BOX: React.CSSProperties = {
  marginTop: 10, padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)',
  border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13, lineHeight: 1.55,
}

export function StructureFailureBox({ failure }: { failure: StructureFailure }) {
  return (
    <div style={BOX}>
      <div>{failure.message}</div>
      {failure.completed && (failure.completed.length === 0 ? (
        <div style={{ marginTop: 6 }}>Nothing had been written when it stopped.</div>
      ) : (
        <>
          <div style={{ marginTop: 6, fontWeight: 600 }}>
            These steps had already completed and have not been undone — check the data before retrying:
          </div>
          <ol style={{ margin: '4px 0 0', paddingLeft: 20, maxHeight: 180, overflowY: 'auto' }}>
            {failure.completed.map((step, i) => <li key={i}>{step}</li>)}
          </ol>
        </>
      ))}
    </div>
  )
}
