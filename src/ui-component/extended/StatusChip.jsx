import Chip from '@mui/material/Chip';

/**
 * Centralized status-to-color mapping.
 *
 * Each key maps to { color, label?, variant? }.
 * - `color`   – MUI Chip color prop
 * - `label`   – optional display label override
 * - `variant` – optional Chip variant override (default: "filled")
 */
const STATUS_MAP = {
  // Generic lifecycle
  active: { color: 'success' },
  inactive: { color: 'default' },
  enabled: { color: 'success' },
  disabled: { color: 'default' },

  // Content statuses
  draft: { color: 'warning' },
  published: { color: 'success' },
  archived: { color: 'default', variant: 'outlined' },

  // Advertising campaign statuses
  paused: { color: 'warning' },
  removed: { color: 'error', variant: 'outlined' },
  unknown: { color: 'default', variant: 'outlined' },

  // CTM form submission triage
  received: { color: 'success', variant: 'outlined' },
  review: { color: 'warning', variant: 'outlined' },
  held: { color: 'error', variant: 'outlined' },
  released: { color: 'info', variant: 'outlined' },

  // Progress / outcomes
  pending: { color: 'warning' },
  pending_activation: { color: 'warning', label: 'Pending Activation' },
  in_progress: { color: 'info', label: 'In Progress' },
  completed: { color: 'success' },
  won: { color: 'success' },
  lost: { color: 'error' },

  // Connection state
  connected: { color: 'success', variant: 'outlined' },
  disconnected: { color: 'error', variant: 'outlined' },

  // Delivery / email
  sent: { color: 'info' },
  delivered: { color: 'success' },
	  failed: { color: 'error' },
	  canceled: { color: 'default', label: 'Canceled', variant: 'outlined' },
  bounced: { color: 'error' },
  complained: { color: 'error', label: 'Spam Complaint' },

  // Lead disposition (Contacts board) — distinct colors so the Status column reads at a glance
  qualified: { color: 'success', label: 'Qualified Lead' },
  needs_attention: { color: 'warning', label: 'Priority' },
  unanswered: { color: 'info', label: 'Unanswered' },
  not_a_fit: { color: 'default', label: 'Not a Fit', variant: 'outlined' },
  spam: { color: 'error', label: 'Spam', variant: 'outlined' },
  pending_review: { color: 'default', label: 'Pending Review' },
  // Contact lifecycle badge (layered on top of disposition)
  in_journey: { color: 'info', label: 'In Journey', variant: 'outlined' },
  active_client: { color: 'success', label: 'Active Client', variant: 'outlined' },
  lead: { color: 'default', label: 'New Lead' },

  // Review
  viewed: { color: 'success' },
  responded: { color: 'success' },
  flagged: { color: 'warning' },
  urgent: { color: 'error' },

  // Boolean shorthand
  on: { color: 'success' },
  off: { color: 'default' },
  yes: { color: 'success' },
  no: { color: 'default' },
};

/**
 * Converts a raw status key into a human-readable label.
 * Examples: "in_progress" → "In Progress", "ACTIVE" → "Active"
 */
function humanize(status) {
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * StatusChip — a drop-in Chip for displaying status values with consistent colors.
 *
 * @param {string}  status   – The status key (matched case-insensitively against STATUS_MAP)
 * @param {string}  [label]  – Optional label override; defaults to STATUS_MAP label or humanized status
 * @param {string}  [size]   – "small" | "medium"  (default: "small")
 * @param {string}  [variant] – "filled" | "outlined" (overrides STATUS_MAP default)
 * @param {object}  [sx]     – Additional MUI sx overrides
 * @param {object}  rest     – Any other Chip props forwarded through
 */
export default function StatusChip({ status, label, size = 'small', variant, sx, ...rest }) {
  const key = (status || '').toLowerCase();
  const mapped = STATUS_MAP[key] || {};

  return (
    <Chip
      label={label || mapped.label || humanize(status || '')}
      color={mapped.color || 'default'}
      size={size}
      variant={variant || mapped.variant || 'filled'}
      sx={sx}
      {...rest}
    />
  );
}
