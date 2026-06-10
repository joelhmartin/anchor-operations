/**
 * Phase 7 — single approval dialog used by the Operations chat for every
 * sub-agent's mutating tool. Wraps ConfirmDialog.
 *
 * Cancel button = explicit reject (writes a rejection audit event).
 * Closing via backdrop is treated as "leave pending" — the proposal stays in
 * ops_tool_approvals; the user can come back to it.
 */

import { useState } from 'react';
import { Box, Typography } from '@mui/material';
import ConfirmDialog from 'ui-component/extended/ConfirmDialog';

export default function ApprovalDialog({ open, approval, onApprove, onReject, onDismiss }) {
  const [busy, setBusy] = useState(false);

  if (!approval) return null;

  const argsPretty = (() => {
    try {
      return JSON.stringify(approval.args_json || {}, null, 2);
    } catch {
      return String(approval.args_json || '{}');
    }
  })();

  const handleApprove = async () => {
    setBusy(true);
    try {
      await onApprove(approval.id);
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setBusy(true);
    try {
      await onReject(approval.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onClose={busy ? () => {} : onDismiss}
      onConfirm={handleApprove}
      title={`Approve: ${approval.tool_name}`}
      severity="warning"
      severityMessage="This action will mutate state on the client's site/account. Review the args carefully before approving."
      message={
        <Box>
          <Typography variant="body2" sx={{ mb: 1 }}>
            <strong>Tool:</strong> {approval.tool_name}
          </Typography>
          <Typography variant="body2" sx={{ mb: 0.5 }}>
            <strong>Args:</strong>
          </Typography>
          <Box
            component="pre"
            sx={{
              fontFamily: 'monospace',
              fontSize: 12,
              bgcolor: 'grey.100',
              p: 1.5,
              borderRadius: 1,
              overflow: 'auto',
              maxHeight: 240,
              m: 0
            }}
          >
            {argsPretty}
          </Box>
        </Box>
      }
      secondaryText={
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
          <Typography
            variant="caption"
            sx={{ cursor: busy ? 'default' : 'pointer', color: 'error.main', userSelect: 'none' }}
            onClick={busy ? undefined : handleReject}
          >
            Reject this proposal
          </Typography>
        </Box>
      }
      confirmLabel="Approve & run"
      cancelLabel="Close"
      confirmColor="warning"
      loading={busy}
      loadingLabel="Running…"
    />
  );
}
