import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import LoadingButton from './LoadingButton';

/**
 * FormDialog — standard dialog shell for form-based workflows.
 *
 * Provides a consistent Dialog with title, scrollable content area,
 * and action buttons (Cancel + Submit).  Children are rendered inside
 * a `<Stack spacing={2}>` wrapper.
 *
 * @param {boolean}      open            – Dialog visibility
 * @param {function}     onClose         – Called when dialog should close
 * @param {function}     [onSubmit]      – Called when submit button is clicked
 * @param {string}       title           – DialogTitle text
 * @param {string}       [maxWidth="sm"] – MUI Dialog maxWidth
 * @param {boolean}      [loading]       – Disables submit + shows spinner
 * @param {string}       [loadingLabel]  – Submit button text while loading
 * @param {string}       [submitLabel="Save"] – Submit button label
 * @param {string}       [cancelLabel="Cancel"] – Cancel button label
 * @param {string}       [submitColor="primary"] – Submit button MUI color
 * @param {boolean}      [submitDisabled] – Extra disable condition for submit
 * @param {boolean}      [dividers]      – Show dividers on DialogContent
 * @param {ReactNode}    [actions]       – Completely replace default DialogActions content
 * @param {ReactElement} [submitIcon]    – startIcon for the submit button
 * @param {number}       [spacing=2]     – Stack spacing for children
 * @param {ReactNode}    children        – Form fields
 */
export default function FormDialog({
  open,
  onClose,
  onSubmit,
  title,
  maxWidth = 'sm',
  loading = false,
  loadingLabel,
  submitLabel = 'Save',
  cancelLabel = 'Cancel',
  submitColor = 'primary',
  submitDisabled = false,
  dividers = false,
  actions,
  submitIcon,
  spacing = 2,
  children,
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth={maxWidth} fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers={dividers}>
        <Stack spacing={spacing} sx={{ mt: 1 }}>
          {children}
        </Stack>
      </DialogContent>
      <DialogActions>
        {actions !== undefined ? (
          actions
        ) : (
          <>
            <Button onClick={onClose}>{cancelLabel}</Button>
            <LoadingButton
              variant="contained"
              color={submitColor}
              onClick={onSubmit}
              loading={loading}
              loadingLabel={loadingLabel}
              disabled={submitDisabled}
              startIcon={submitIcon}
            >
              {submitLabel}
            </LoadingButton>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
