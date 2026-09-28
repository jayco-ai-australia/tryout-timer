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
    <Modal
      title={title}
      onClose={onCancel}
      maxWidth={maxWidth}
      // Confirm and Cancel go in the modal's PINNED footer rather than at the end of the body.
      // Every confirmation in this app now gets that for free, which matters most for the ones
      // that carry a list: /collect's complete-timer step banks against every model on the line
      // (89 on Caravan) and used to push Save off the bottom of a tablet with no way to scroll
      // to it. The message and children scroll; these two do not move.
      footer={(
        <>
          <button onClick={onCancel} className="btn-ghost">{cancelLabel}</button>
          {danger ? (
            <button onClick={onConfirm} className="btn-danger">{confirmLabel}</button>
          ) : (
            <button onClick={onConfirm} className="btn-primary">{confirmLabel}</button>
          )}
        </>
      )}
    >
      <p style={{ fontSize: 14, color: 'var(--text-mid)', lineHeight: 1.6, margin: children ? '0 0 12px' : 0 }}>
        {message}
      </p>
      {children}
    </Modal>
  )
}
