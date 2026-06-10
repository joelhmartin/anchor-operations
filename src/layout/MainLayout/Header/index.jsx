// material-ui
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
// project imports
import LogoSection from '../LogoSection';
import ProfileSection from './ProfileSection';
import ThemeModeToggle from 'ui-component/extended/ThemeModeToggle';

import { handlerDrawerOpen, useGetMenuMaster } from 'api/menu';

// assets
import { IconMenu2 } from '@tabler/icons-react';
import useAuth from 'hooks/useAuth';
import { useNavigate } from 'react-router-dom';
import Button from '@mui/material/Button';

// ==============================|| MAIN NAVBAR / HEADER ||============================== //

export default function Header() {
  const theme = useTheme();
  const downMD = useMediaQuery(theme.breakpoints.down('md'));
  const navigate = useNavigate();
  const { user, actingClientId, actingClientName, activeClientAccount, clearActingClient } = useAuth();

  const { menuMaster } = useGetMenuMaster();
  const drawerOpen = menuMaster.isDashboardDrawerOpened;

  const handleBackToHub = () => {
    clearActingClient();
    navigate('/client-hub');
  };

  const accountLabel = actingClientId
    ? actingClientName || 'Client'
    : activeClientAccount?.displayName ||
      (user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email : '');

  return (
    <>
      {/* logo & toggler button */}
      <Box sx={{ width: downMD ? 'auto' : 228, display: 'flex' }}>
        <Box component="span" sx={{ display: { xs: 'none', md: 'block' }, flexGrow: 1 }}>
          <LogoSection />
        </Box>
        <Avatar
          variant="rounded"
          sx={{
            ...theme.typography.commonAvatar,
            ...theme.typography.mediumAvatar,
            overflow: 'hidden',
            transition: 'all .2s ease-in-out',
            color: theme.vars.palette.secondary.dark,
            background: theme.vars.palette.secondary.light,
            '&:hover': {
              color: theme.vars.palette.secondary.light,
              background: theme.vars.palette.secondary.dark
            }
          }}
          onClick={() => handlerDrawerOpen(!drawerOpen)}
        >
          <IconMenu2 stroke={1.5} size="20px" />
        </Avatar>
      </Box>

      {/* header search */}
      {/* Disabled for now (currently no-op). Re-enable when wired to real search behavior. */}
      <Box sx={{ flexGrow: 1 }} />
      <Box sx={{ flexGrow: 1 }} />

      {accountLabel && (
        <Typography
          variant="subtitle1"
          sx={{
            mr: 1.5,
            color: 'text.primary',
            fontWeight: 500,
            maxWidth: 240,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: { xs: 'none', sm: 'block' }
          }}
          title={accountLabel}
        >
          {accountLabel}
        </Typography>
      )}

      {/* theme mode */}
      <ThemeModeToggle />

      {actingClientId && (
        <Button variant="outlined" size="small" sx={{ ml: 1 }} onClick={handleBackToHub}>
          Back to Admin Hub
        </Button>
      )}

      {/* profile */}
      <ProfileSection />
    </>
  );
}
