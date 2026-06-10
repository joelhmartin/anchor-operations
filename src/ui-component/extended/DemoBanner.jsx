import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import useAuth from 'hooks/useAuth';

/**
 * DemoBanner — shows a subtle, fixed banner when the current session involves a demo account.
 *
 * Renders when:
 * - The logged-in user is a demo account (user.is_demo)
 * - OR an admin is viewing a demo client (pass clientIsDemo prop)
 *
 * Place this once in the main layout — it handles its own visibility.
 */
export default function DemoBanner({ clientIsDemo = false }) {
  const { user } = useAuth();
  const show = user?.is_demo || clientIsDemo;

  if (!show) return null;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        py: 0.5,
        px: 2,
        bgcolor: 'rgba(33, 150, 243, 0.08)',
        borderBottom: '1px solid',
        borderColor: 'rgba(33, 150, 243, 0.2)'
      }}
    >
      <ScienceOutlinedIcon sx={{ fontSize: 16, color: 'info.main' }} />
      <Typography variant="caption" sx={{ color: 'info.main', fontWeight: 500 }}>
        Demo Account — Sample data for demonstration purposes
      </Typography>
    </Box>
  );
}

/**
 * DemoChip — small inline chip for use in client lists and headers.
 * Shows "Demo" next to a client name when they're a demo account.
 */
export function DemoChip({ isDemo }) {
  if (!isDemo) return null;

  return (
    <Chip
      icon={<ScienceOutlinedIcon sx={{ fontSize: '14px !important' }} />}
      label="Demo"
      size="small"
      variant="outlined"
      color="info"
      sx={{ ml: 1, height: 22, '& .MuiChip-label': { px: 0.75, fontSize: '0.7rem' } }}
    />
  );
}
