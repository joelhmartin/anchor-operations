import { isValidElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

/**
 * EmptyState — consistent placeholder when a list, table, or section has no data.
 *
 * @param {ReactElement|Component} [icon] – MUI icon component (e.g. BarChartIcon) or element (e.g. <BarChartIcon />)
 * @param {string}       title      – Primary message (e.g. "No blog posts yet.")
 * @param {string}       [message]  – Optional secondary/guidance text
 * @param {ReactNode}    [action]   – Optional action button(s) below the text
 * @param {object}       [sx]       – Additional sx overrides on the outer Box
 */
export default function EmptyState({ icon, title, message, action, sx }) {
  const renderIcon = () => {
    if (!icon) return null;
    // Already a rendered JSX element — use as-is
    if (isValidElement(icon)) return icon;
    // Component reference (function or memo/forwardRef object) — render it
    const Icon = icon;
    return <Icon sx={{ fontSize: 48 }} />;
  };

  return (
    <Box sx={{ py: 4, textAlign: 'center', ...sx }}>
      {icon && (
        <Box sx={{ mb: 1, color: 'text.disabled' }}>
          {renderIcon()}
        </Box>
      )}
      <Typography variant="body2" color="text.secondary">
        {title}
      </Typography>
      {message && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
          {message}
        </Typography>
      )}
      {action && <Box sx={{ mt: 2 }}>{action}</Box>}
    </Box>
  );
}
