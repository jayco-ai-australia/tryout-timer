'use client'

import Modal from './Modal'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** Optional extra content rendered between the message and the buttons — e.g. /collect's
   * optional note field on the complete-timer confirmation. */
  children?: React.ReactNode
  /** Widen the card past the 400px a plain yes/no question needs — for a confirmation that
   * also carries a small form (e.g. /tryouts' operator + notes on completing a timer), where
   * 400px would force two fields into a cramped single column. */
  maxWidth?: number
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  children,
  maxWidth = 400,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal title={title} onClose={onCancel} maxWidth={maxWidth}>
      <p style={{ fontSize: 14, color: 'var(--text-mid)', lineHeight: 1.6, marginBottom: children ? 12 : 20 }}>
        {message}
      </p>
      {children && <div style={{ marginBottom: 20 }}>{children}</div>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} className="btn-ghost">{cancelLabel}</button>
        {danger ? (
          <button onClick={onConfirm} className="btn-danger">{confirmLabel}</button>
        ) : (
          <button onClick={onConfirm} className="btn-primary">{confirmLabel}</button>
        )}
      </div>
    </Modal>
  )
}
