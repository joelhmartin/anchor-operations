/**
 * ConfirmDialog — Shared confirmation dialog component.
 *
 * Use this for any action that needs user confirmation before proceeding
 * (delete, archive, revoke, release, etc.). Do NOT use for form dialogs.
 *
 * Props:
 *   open          {boolean}              — Whether the dialog is visible
 *   onClose       {function}             — Called when dialog is dismissed (Cancel or backdrop click)
 *   onConfirm     {function}             — Called when the confirm button is clicked
 *   title         {string}               — Dialog title (e.g. "Delete Client")
 *   message       {string|ReactNode}     — Main message body
 *   secondaryText {string|ReactNode}     — Optional secondary text below main message (body2, text.secondary)
 *   confirmLabel  {string}               — Confirm button text (default: "Confirm")
 *   cancelLabel   {string}               — Cancel button text (default: "Cancel")
 *   confirmColor  {string}               — MUI color for confirm button: "error"|"warning"|"primary" (default: "primary")
 *   loading       {boolean}              — Shows loading text on confirm button and disables both buttons
 *   loadingLabel  {string}               — Text shown while loading (e.g. "Deleting…"). Falls back to confirmLabel if not set.
 *   severity      {string}               — Optional Alert banner: "error"|"warning"|"info"|"success"
 *   severityMessage {string}             — Text for the Alert banner (required if severity is set)
 *
 * Usage:
 *   <ConfirmDialog
 *     open={deleteConfirmOpen}
 *     onClose={() => setDeleteConfirmOpen(false)}
 *     onConfirm={handleDelete}
 *     title="Delete Client"
 *     message={<>Are you sure you want to delete <strong>{name}</strong>?</>}
 *     secondaryText="This action cannot be undone."
 *     confirmLabel="Delete"
 *     confirmColor="error"
 *     loading={deleting}
 *     loadingLabel="Deleting…"
 *   />
 */

import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography, Alert } from '@mui/material';

export default function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  secondaryText,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmColor = 'primary',
  loading = false,
  loadingLabel,
  severity,
  severityMessage,
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {severity && severityMessage && (
          <Alert severity={severity} sx={{ mb: 2 }}>
            {severityMessage}
          </Alert>
        )}
        {typeof message === 'string' ? <Typography>{message}</Typography> : message}
        {secondaryText && (
          typeof secondaryText === 'string' ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {secondaryText}
            </Typography>
          ) : (
            secondaryText
          )
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button variant="contained" color={confirmColor} onClick={onConfirm} disabled={loading}>
          {loading ? (loadingLabel || confirmLabel) : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
